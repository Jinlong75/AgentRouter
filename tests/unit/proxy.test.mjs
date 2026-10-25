import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseProxyServer, validateProxyUrl, readSystemProxy, resolveProxy, applyProxyEnv, proxyRecord, proxyText } from '../../core/lib/proxy.mjs';
import { buildEnv, ensureSandboxHome, sandboxHome, withProxy } from '../../core/lib/env.mjs';
import { validateV2 } from '../../core/lib/config.mjs';

// 099：网络代理的纯函数。读注册表一律用注入的 run，不碰真实注册表，也不改任何系统设置或用户环境变量。

test('parseProxyServer：host:port 补 http://', () => {
  assert.equal(parseProxyServer('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseProxyServer('  proxy.example.test:8080 '), 'http://proxy.example.test:8080');
  assert.equal(parseProxyServer('[::1]:7890'), 'http://[::1]:7890');
});

test('parseProxyServer：按协议分写取 https，没有取 http，再没有取 socks（socks5://）', () => {
  assert.equal(parseProxyServer('http=h1:1;https=h2:2;socks=h3:3'), 'http://h2:2');
  assert.equal(parseProxyServer('http=h1:1;ftp=h4:4'), 'http://h1:1');
  assert.equal(parseProxyServer('socks=h3:3'), 'socks5://h3:3');
  assert.equal(parseProxyServer('ftp=h4:4;socks=h3:3'), 'socks5://h3:3');
  assert.equal(parseProxyServer('HTTPS=h2:2'), 'http://h2:2');
});

test('parseProxyServer：空串、乱码、认不出的写法返回 null', () => {
  for (const text of ['', '   ', 'abc', '=', 'http=', 'ftp=h:1', 'host:0', 'host:99999', 'a b:80', 'http://user:pw@h:1', null, undefined, 5]) {
    assert.equal(parseProxyServer(text), null, String(text));
  }
});

test('validateProxyUrl：三种协议、IPv4、域名、带方括号的 IPv6', () => {
  for (const url of ['http://127.0.0.1:7890', 'https://proxy.example.test:443', 'socks5://127.0.0.1:1080', 'http://[::1]:7890', 'http://localhost:1', 'http://h:65535']) {
    assert.deepEqual(validateProxyUrl(url), { ok: true, url, code: null, error: null }, url);
  }
});

test('validateProxyUrl：去掉首尾空白与末尾的 /，协议转小写', () => {
  assert.equal(validateProxyUrl(' http://127.0.0.1:7890/ ').url, 'http://127.0.0.1:7890');
  assert.equal(validateProxyUrl('http://127.0.0.1:7890///').url, 'http://127.0.0.1:7890');
  assert.equal(validateProxyUrl('HTTP://127.0.0.1:7890').url, 'http://127.0.0.1:7890');
});

test('validateProxyUrl：缺端口、端口越界、不支持的协议、带路径、没有协议都是 PROXY_FORMAT', () => {
  for (const url of ['http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:abc', 'ftp://127.0.0.1:21', 'socks4://127.0.0.1:1080',
    'http://127.0.0.1:7890/path', 'http://127.0.0.1:7890?x=1', '127.0.0.1:7890', 'http://:7890', 'http://[::1:7890', 'http://a b:1']) {
    const r = validateProxyUrl(url);
    assert.equal(r.ok, false, url);
    assert.equal(r.code, 'PROXY_FORMAT', url);
    assert.equal(r.url, null);
    assert.match(r.error, /代理地址格式不对/);
  }
});

test('validateProxyUrl：带用户名、用户名和密码都是 PROXY_CREDENTIALS（先于格式判断），不回显凭据', () => {
  for (const url of ['http://user@127.0.0.1:7890', 'http://user:pass@127.0.0.1:7890', 'socks5://u:p@h:1', 'http://:pass@127.0.0.1:7890', 'http://user:pass@bad']) {
    const r = validateProxyUrl(url);
    assert.equal(r.code, 'PROXY_CREDENTIALS', url);
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes('pass'), '错误文字不含凭据');
  }
});

test('validateProxyUrl：空值是 PROXY_EMPTY', () => {
  for (const url of ['', '   ', '/', null, undefined, 7]) assert.equal(validateProxyUrl(url).code, url === '/' ? 'PROXY_FORMAT' : 'PROXY_EMPTY', String(url));
});

// reg query 输出的样子（值之间是四个空格）。
const reg = (...lines) => ({ status: 0, stdout: ['', 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', ...lines.map(line => `    ${line}`), ''].join('\r\n') });

test('readSystemProxy：开启（host:port 与分协议写法）', () => {
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => reg('ProxyEnable    REG_DWORD    0x1', 'ProxyServer    REG_SZ    127.0.0.1:7890') }), { url: 'http://127.0.0.1:7890', reason: 'found' });
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => reg('ProxyEnable    REG_DWORD    0x1', 'ProxyServer    REG_SZ    http=h1:1;https=h2:2;socks=h3:3') }), { url: 'http://h2:2', reason: 'found' });
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => reg('ProxyEnable    REG_DWORD    0x1', 'ProxyServer    REG_SZ    socks=h3:3') }), { url: 'socks5://h3:3', reason: 'found' });
});

test('readSystemProxy：未开启（ProxyEnable 为 0 或没有）→ disabled，哪怕留着 ProxyServer', () => {
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => reg('ProxyEnable    REG_DWORD    0x0', 'ProxyServer    REG_SZ    127.0.0.1:7890') }), { url: null, reason: 'disabled' });
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => reg('ProxyServer    REG_SZ    127.0.0.1:7890') }), { url: null, reason: 'disabled' });
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => reg('SomethingElse    REG_DWORD    0x1') }), { url: null, reason: 'disabled' });
});

test('readSystemProxy：只配了 PAC → pac；开启但认不出写法 → unreadable', () => {
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => reg('ProxyEnable    REG_DWORD    0x0', 'AutoConfigURL    REG_SZ    http://127.0.0.1:7777/proxy.pac') }), { url: null, reason: 'pac' });
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => reg('AutoConfigURL    REG_SZ    http://127.0.0.1:7777/proxy.pac') }), { url: null, reason: 'pac' });
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => reg('ProxyEnable    REG_DWORD    0x1', 'ProxyServer    REG_SZ    乱七八糟') }), { url: null, reason: 'unreadable' });
});

test('readSystemProxy：命令失败、抛错、输出不是字符串 → unreadable；非 Windows → unsupported 且不运行命令', () => {
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => ({ status: 1, stdout: '', stderr: '错误' }) }), { url: null, reason: 'unreadable' });
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => { throw new Error('boom'); } }), { url: null, reason: 'unreadable' });
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => ({ status: 0, stdout: null }) }), { url: null, reason: 'unreadable' });
  assert.deepEqual(readSystemProxy({ platform: 'win32', run: () => null }), { url: null, reason: 'unreadable' });
  for (const platform of ['linux', 'darwin']) assert.deepEqual(readSystemProxy({ platform, run: () => assert.fail('不应运行') }), { url: null, reason: 'unsupported' });
});

test('readSystemProxy：测试钩子 AR_TEST_PROXY_REG 代替 reg.exe 的输出（隔离测试不读真实注册表）', { skip: process.platform !== 'win32' }, () => {
  const env = { AR_TEST_PROXY_REG: reg('ProxyEnable    REG_DWORD    0x1', 'ProxyServer    REG_SZ    10.0.0.9:3128').stdout };
  assert.deepEqual(readSystemProxy({ env }), { url: 'http://10.0.0.9:3128', reason: 'found' });
});

test('resolveProxy：没写 proxy 或 off → 不动', () => {
  for (const config of [undefined, {}, { proxy: { mode: 'off' } }, { proxy: { mode: 'off', url: 'http://127.0.0.1:7890' } }, { proxy: { mode: '乱写' } }]) {
    assert.deepEqual(resolveProxy(config, { readSystem: () => assert.fail('off 不读系统代理') }), { mode: 'off', url: null, source: null, reason: 'off', env: {} });
  }
});

test('resolveProxy：manual 用 url（规范化），不合法时没有地址', () => {
  const r = resolveProxy({ proxy: { mode: 'manual', url: 'http://127.0.0.1:7890/' } }, { readSystem: () => assert.fail('manual 不读系统代理') });
  assert.deepEqual(r, { mode: 'manual', url: 'http://127.0.0.1:7890', source: 'manual', reason: 'manual', env: { HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1' } });
  assert.deepEqual(resolveProxy({ proxy: { mode: 'manual', url: 'http://u:p@h:1' } }), { mode: 'manual', url: null, source: null, reason: 'invalid', env: {} });
  assert.deepEqual(resolveProxy({ proxy: { mode: 'manual' } }), { mode: 'manual', url: null, source: null, reason: 'invalid', env: {} });
});

test('resolveProxy：system 每次调用都读一次；读到用它，读不到/未开启/PAC 没有地址', () => {
  let calls = 0;
  const found = resolveProxy({ proxy: { mode: 'system' } }, { readSystem: () => { calls++; return { url: 'socks5://127.0.0.1:1080', reason: 'found' }; } });
  assert.deepEqual(found, { mode: 'system', url: 'socks5://127.0.0.1:1080', source: 'system', reason: 'found', env: { HTTP_PROXY: 'socks5://127.0.0.1:1080', HTTPS_PROXY: 'socks5://127.0.0.1:1080', NO_PROXY: 'localhost,127.0.0.1,::1' } });
  resolveProxy({ proxy: { mode: 'system' } }, { readSystem: () => { calls++; return { url: null, reason: 'disabled' }; } });
  assert.equal(calls, 2);
  for (const reason of ['disabled', 'pac', 'unreadable', 'unsupported']) {
    assert.deepEqual(resolveProxy({ proxy: { mode: 'system' } }, { readSystem: () => ({ url: null, reason }) }), { mode: 'system', url: null, source: null, reason, env: {} });
  }
});

test('proxyRecord / proxyText：只有模式与是否生效，不含地址', () => {
  assert.deepEqual(proxyRecord(resolveProxy({ proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' } })), { mode: 'manual', applied: true });
  assert.deepEqual(proxyRecord(resolveProxy({ proxy: { mode: 'system' } }, { readSystem: () => ({ url: null, reason: 'disabled' }) })), { mode: 'system', applied: false });
  assert.deepEqual(proxyRecord(resolveProxy({})), { mode: 'off', applied: false });
  assert.match(proxyText(resolveProxy({ proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' } })), /manual http:\/\/127\.0\.0\.1:7890/);
  assert.match(proxyText(resolveProxy({ proxy: { mode: 'system' } }, { readSystem: () => ({ url: 'http://127.0.0.1:7890', reason: 'found' }) })), /system 当前读到 http:\/\/127\.0\.0\.1:7890/);
  assert.match(proxyText(resolveProxy({ proxy: { mode: 'system' } }, { readSystem: () => ({ url: null, reason: 'disabled' }) })), /系统代理未开启/);
});

const manual = resolveProxy({ proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' } });

test('applyProxyEnv：覆盖继承来的值，不改传入的对象，设默认 NO_PROXY', () => {
  const base = { PATH: 'p', HTTP_PROXY: 'http://old:1', HTTPS_PROXY: 'http://old:1' };
  const out = applyProxyEnv(base, manual);
  assert.deepEqual(out, { PATH: 'p', HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1' });
  assert.deepEqual(base, { PATH: 'p', HTTP_PROXY: 'http://old:1', HTTPS_PROXY: 'http://old:1' }, '传入的对象不变');
  assert.notEqual(out, base);
});

test('applyProxyEnv：去掉小写（及混合大小写）的同名变量，免得出现两份', () => {
  const out = applyProxyEnv({ https_proxy: 'http://old:1', Http_Proxy: 'http://old:2', ALL_PROXY: 'socks5://keep:1', PATH: 'p' }, manual);
  assert.deepEqual(Object.keys(out).filter(k => /proxy/i.test(k)).sort(), ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']);
  assert.equal(out.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(out.ALL_PROXY, 'socks5://keep:1', '别的变量不动');
});

test('applyProxyEnv：已有 NO_PROXY（任何大小写）不改；空的 NO_PROXY 当作没设', () => {
  assert.equal(applyProxyEnv({ NO_PROXY: '.corp.test' }, manual).NO_PROXY, '.corp.test');
  const lower = applyProxyEnv({ no_proxy: '.corp.test' }, manual);
  assert.equal(lower.no_proxy, '.corp.test');
  assert.ok(!('NO_PROXY' in lower), '不再多一份大写的');
  const empty = applyProxyEnv({ no_proxy: '' }, manual);
  assert.deepEqual(Object.keys(empty).filter(k => /^no_proxy$/i.test(k)), ['NO_PROXY']);
  assert.equal(empty.NO_PROXY, 'localhost,127.0.0.1,::1');
});

test('applyProxyEnv：没得到地址时原样返回（同一个对象）', () => {
  const base = { PATH: 'p', https_proxy: 'http://old:1' };
  assert.equal(applyProxyEnv(base, resolveProxy({})), base);
  assert.equal(applyProxyEnv(base, resolveProxy({ proxy: { mode: 'system' } }, { readSystem: () => ({ url: null, reason: 'disabled' }) })), base);
  assert.equal(applyProxyEnv(base, undefined), base);
});

test('validateV2：proxy 的 mode 必须是三种之一；manual 的 url 必须合法；任何模式下都不允许带凭据', () => {
  assert.doesNotThrow(() => validateV2({ v: 2 }));
  assert.doesNotThrow(() => validateV2({ v: 2, proxy: { mode: 'off' } }));
  assert.doesNotThrow(() => validateV2({ v: 2, proxy: { mode: 'system' } }));
  assert.doesNotThrow(() => validateV2({ v: 2, proxy: { mode: 'manual', url: 'socks5://127.0.0.1:1080' } }));
  assert.doesNotThrow(() => validateV2({ v: 2, proxy: { mode: 'off', url: 'http://127.0.0.1:7890' } }), '切到不使用时留着的地址没问题');
  assert.throws(() => validateV2({ v: 2, proxy: 'on' }), /proxy 必须为对象/);
  assert.throws(() => validateV2({ v: 2, proxy: { mode: 'auto' } }), /proxy\.mode 必须为 off、system、manual 之一/);
  assert.throws(() => validateV2({ v: 2, proxy: {} }), /proxy\.mode/);
  assert.throws(() => validateV2({ v: 2, proxy: { mode: 'manual' } }), /proxy\.url 代理地址不能为空/);
  assert.throws(() => validateV2({ v: 2, proxy: { mode: 'manual', url: 'http://127.0.0.1' } }), /proxy\.url 代理地址格式不对/);
  assert.throws(() => validateV2({ v: 2, proxy: { mode: 'manual', url: 'http://u:p@127.0.0.1:7890' } }), /proxy\.url 代理地址里不能带用户名和密码/);
  assert.throws(() => validateV2({ v: 2, proxy: { mode: 'system', url: 'http://u:p@127.0.0.1:7890' } }), /proxy\.url 代理地址里不能带用户名和密码/);
  assert.throws(() => validateV2({ v: 2, proxy: { mode: 'off', url: 5 } }), /proxy\.url 必须为字符串/);
});

test('withProxy：按全局 config.json 的 proxy 给基础环境加变量；off、没有配置、配置读不了都原样返回', t => {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'ar-proxy-099-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { PATH: 'p', https_proxy: 'http://old:1' };
  const noSystem = () => assert.fail('不应读系统代理');
  assert.equal(withProxy(env, home, { readSystem: noSystem }).base, env, '没有 config.json');
  const write = value => fs.writeFileSync(path.join(home, 'config.json'), typeof value === 'string' ? value : JSON.stringify({ v: 2, ...value }));
  write({ proxy: { mode: 'off' } });
  assert.equal(withProxy(env, home, { readSystem: noSystem }).base, env, 'off');
  write('{ 坏的');
  assert.equal(withProxy(env, home, { readSystem: noSystem }).base, env, '配置读不了');
  write({ proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' } });
  const manualResult = withProxy(env, home, { readSystem: noSystem });
  assert.equal(manualResult.base.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.ok(!('https_proxy' in manualResult.base));
  write({ proxy: { mode: 'system' } });
  const system = withProxy(env, home, { readSystem: () => ({ url: 'http://127.0.0.1:1', reason: 'found' }) });
  assert.equal(system.proxy.source, 'system');
  assert.equal(system.base.HTTP_PROXY, 'http://127.0.0.1:1');
  assert.equal(withProxy(env, home, { readSystem: () => ({ url: null, reason: 'pac' }) }).base, env, 'system 读不到地址 → 不动');
});

test('buildEnv：先加代理变量再过白名单——代理变量传给执行者；off 时与不用代理逐字相同；profile.env 明确写的值优先', () => {
  const base = { PATH: 'p', USERPROFILE: 'C:\\real', GITHUB_TOKEN: 'ghp-test-x', https_proxy: 'http://old:1' };
  const off = buildEnv({ base: applyProxyEnv(base, resolveProxy({})), adapter: {}, profile: {} });
  assert.deepEqual(off, buildEnv({ base, adapter: {}, profile: {} }));
  assert.deepEqual(off, { PATH: 'p', USERPROFILE: 'C:\\real', https_proxy: 'http://old:1' });
  const on = buildEnv({ base: applyProxyEnv(base, manual), adapter: {}, profile: {} });
  assert.deepEqual(on, { PATH: 'p', USERPROFILE: 'C:\\real', HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1' });
  const explicit = buildEnv({ base: applyProxyEnv(base, manual), adapter: {}, profile: { env: { HTTPS_PROXY: 'http://explicit:3' } } });
  assert.equal(explicit.HTTPS_PROXY, 'http://explicit:3');
});

// PowerShell 模块分析缓存（Stage07 097 实测）：Windows 上换沙箱用户目录时，把缓存位置指到沙箱里。
const cacheIn = dir => path.join(dir, 'AppData', 'Local', 'Microsoft', 'Windows', 'PowerShell', 'ModuleAnalysisCache');

test('buildEnv（Windows）：PSModuleAnalysisCachePath 指向沙箱；调用方已经设了就沿用；profile.env 设了也不覆盖', { skip: process.platform !== 'win32' }, () => {
  const home = path.join(tmpdir(), 'ar-home-099');
  const sandbox = sandboxHome(home, 'mimo');
  const build = (base, profile = {}) => buildEnv({ base, profile, adapter: {}, home, profileName: 'mimo' });
  assert.equal(build({ PATH: 'p', USERPROFILE: 'C:\\real' }).PSModuleAnalysisCachePath, cacheIn(sandbox));
  assert.equal(build({ PATH: 'p', psmoduleanalysiscachepath: 'D:\\mine\\cache' }).psmoduleanalysiscachepath, 'D:\\mine\\cache');
  assert.ok(!('PSModuleAnalysisCachePath' in build({ PATH: 'p', psmoduleanalysiscachepath: 'D:\\mine\\cache' })), '调用方设了就不再多加一份');
  assert.equal(build({ PATH: 'p' }, { env: { PSModuleAnalysisCachePath: 'E:\\profile\\cache' } }).PSModuleAnalysisCachePath, 'E:\\profile\\cache');
  // 没传 home / profileName（不换沙箱）时不设。
  assert.ok(!('PSModuleAnalysisCachePath' in buildEnv({ base: { PATH: 'p' }, adapter: {} })));
});

test('ensureSandboxHome（Windows）：缓存目录的上级一并建好；公共目录建不了、改用一次性目录时缓存位置跟着换', { skip: process.platform !== 'win32' }, t => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'ar-ps-099-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = path.join(base, 'home');
  const env = buildEnv({ base: { PATH: 'p', USERPROFILE: 'C:\\real' }, adapter: {}, home, profileName: 'mimo' });
  const used = ensureSandboxHome(env, { home, profileName: 'mimo' });
  assert.equal(env.PSModuleAnalysisCachePath, cacheIn(used));
  assert.ok(fs.existsSync(path.dirname(env.PSModuleAnalysisCachePath)), '缓存文件所在目录已存在');
  // 公共目录被一个文件占着，建不出沙箱：改用系统临时目录里的一次性目录。
  const blocked = path.join(base, 'blocked');
  fs.writeFileSync(blocked, 'x');
  const env2 = buildEnv({ base: { PATH: 'p', USERPROFILE: 'C:\\real' }, adapter: {}, home: blocked, profileName: 'mimo' });
  const fallback = ensureSandboxHome(env2, { home: blocked, profileName: 'mimo' });
  t.after(() => fs.rmSync(fallback, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.notEqual(fallback, sandboxHome(blocked, 'mimo'));
  assert.equal(env2.PSModuleAnalysisCachePath, cacheIn(fallback), '缓存位置跟着一次性目录');
  // 调用方自己设的不跟着换。
  const env3 = buildEnv({ base: { PATH: 'p', PSModuleAnalysisCachePath: 'D:\\mine\\cache' }, adapter: {}, home: blocked, profileName: 'mimo' });
  const fallback3 = ensureSandboxHome(env3, { home: blocked, profileName: 'mimo' });
  t.after(() => fs.rmSync(fallback3, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.equal(env3.PSModuleAnalysisCachePath, 'D:\\mine\\cache');
});

test('buildEnv（非 Windows）不设 PSModuleAnalysisCachePath', { skip: process.platform === 'win32' }, () => {
  const env = buildEnv({ base: { PATH: 'p', USERPROFILE: '/real' }, adapter: {}, home: path.join(tmpdir(), 'ar-home-099'), profileName: 'mimo' });
  assert.ok(!('PSModuleAnalysisCachePath' in env));
});
