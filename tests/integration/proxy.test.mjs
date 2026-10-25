import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 099：网络代理的集成测试。走真实的 ar 入口 + 一个运行时写进临时目录的假执行者（经 AR_TEST_AGENT 冒充 Claude Code），
// 假执行者把自己看到的环境写进证据文件。公共目录、仓库、用户目录全在系统临时目录里；system 模式用 AR_TEST_PROXY_REG 代替注册表，
// 不读真实注册表，也不改任何系统代理或用户环境变量。
const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const A = 'http://127.0.0.1:7890', B = 'socks5://127.0.0.1:1080';

// 假执行者：记下完整环境；第一次运行时（AR_TEST_PROXY_NEXT 有值）把全局配置里的 proxy 换成另一个；
// AR_TEST_PROXY_DONE=1 时从第二次运行起写入完成标记并提交，让门禁通过。
const FAKE = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  const env = process.env, log = env.AR_TEST_PROXY_LOG;
  const before = existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
  appendFileSync(log, JSON.stringify({ env: { ...env } }) + '\\n');
  if (env.AR_TEST_PROXY_NEXT && before === 0) {
    const config = JSON.parse(readFileSync(env.AR_TEST_PROXY_CONFIG, 'utf8'));
    config.proxy = JSON.parse(env.AR_TEST_PROXY_NEXT);
    writeFileSync(env.AR_TEST_PROXY_CONFIG, JSON.stringify(config));
  }
  if (env.AR_TEST_PROXY_DONE === '1' && before >= 1) {
    mkdirSync('src', { recursive: true });
    writeFileSync('src/done.txt', '任务完成\\n');
    execFileSync('git', ['add', 'src/done.txt']);
    execFileSync('git', ['commit', '-q', '-m', '假执行者：写入完成标记']);
  }
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }));
});
`;
const DONE_CHECK = `node -e "const fs=require('fs');let s='';try{s=fs.readFileSync('src/done.txt','utf8')}catch(e){};if(!s.includes('完成')){console.log('src/done.txt 还没有 完成 标记，门禁不予通过');process.exit(1)}"`;

function fixture(t, { proxy } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'ar-proxy-099-')));
  t.after(() => { assert.equal(path.dirname(base), path.resolve(fs.realpathSync.native(tmpdir()))); fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const repo = path.join(base, 'repo'), home = path.join(base, 'home'), user = path.join(base, 'user');
  for (const dir of [repo, home, user]) fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', '代理测试'); git('config', 'user.email', 'proxy-099@example.test'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.js'), '初始\n');
  git('add', '.gitignore', 'src/a.js'); git('commit', '-q', '-m', '初始提交');
  const agent = path.join(base, 'fake-proxy-agent.mjs'), log = path.join(base, 'agent-env.jsonl'), configFile = path.join(home, 'config.json');
  fs.writeFileSync(agent, FAKE);
  const writeConfig = (extra = {}) => fs.writeFileSync(configFile, JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'cc',
    profiles: { cc: { adapter: 'claude-code', label: '假 Claude', enabled: true, auth: 'login' } }, ...extra }));
  writeConfig(proxy ? { proxy } : {});
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_|AGENT_ROUTER_HOME$|GIT_CONFIG|.*_proxy$)/i.test(key)) delete env[key];
  Object.assign(env, { AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', USERPROFILE: user, HOME: user, APPDATA: path.join(user, 'AppData', 'Roaming'),
    AR_TEST_AGENT: agent, AR_TEST_PROXY_LOG: log, AR_TEST_PROXY_CONFIG: configFile });
  const ar = (args, extra = {}) => spawnSync(process.execPath, [entry, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000, windowsHide: true, shell: false });
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).env) : []);
  const record = name => path.join(repo, '.agent-runs', name);
  const dispatchJson = name => JSON.parse(fs.readFileSync(path.join(record(name), 'dispatch.json'), 'utf8'));
  // 提交一份任务说明（启用门禁时派发前要求说明已提交）。
  const spec = (rel, maxRetries) => {
    fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), ['---', 'id: 990', 'title: 代理测试', 'type: code', 'allowed_paths:', '  - src/**', 'verify:', `  - ${DONE_CHECK}`, `max_retries: ${maxRetries}`, '---', '', '代理测试正文。', ''].join('\n'));
    git('add', rel); git('commit', '-q', '-m', `任务说明 ${rel}`);
    return rel;
  };
  const proxyVars = env => Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:http_proxy|https_proxy|no_proxy|all_proxy)$/i.test(key)));
  return { base, repo, home, env, ar, runs, record, dispatchJson, spec, writeConfig, configFile, proxyVars };
}
// reg query 输出（system 模式的测试输入）。
const regOutput = (enable, server) => ['', 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', `    ProxyEnable    REG_DWORD    ${enable}`, ...(server ? [`    ProxyServer    REG_SZ    ${server}`] : []), ''].join('\r\n');

test('manual：执行者环境有 HTTP_PROXY / HTTPS_PROXY / NO_PROXY，覆盖继承来的值', t => {
  const f = fixture(t, { proxy: { mode: 'manual', url: `${A}/` } });
  const result = f.ar(['dispatch', '代理手动', '--name', 'manual'], { HTTPS_PROXY: 'http://inherited.invalid:1' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const [seen, ...others] = f.runs();
  assert.equal(others.length, 0);
  assert.deepEqual(f.proxyVars(seen), { HTTP_PROXY: A, HTTPS_PROXY: A, NO_PROXY: 'localhost,127.0.0.1,::1' }, '地址规范化（去掉末尾 /），继承来的值被覆盖');
});

test('manual：调用方已设的 NO_PROXY 不改', t => {
  const f = fixture(t, { proxy: { mode: 'manual', url: A } });
  const result = f.ar(['dispatch', '代理保留', '--name', 'keep'], { NO_PROXY: '.corp.test' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(f.proxyVars(f.runs()[0]), { HTTP_PROXY: A, HTTPS_PROXY: A, NO_PROXY: '.corp.test' });
});

test('off：执行者环境与没写 proxy 时逐字相同（不设置也不清除继承来的代理变量）', t => {
  const inherited = { HTTPS_PROXY: 'http://inherited.invalid:1', HTTP_PROXY: 'http://inherited.invalid:2', NO_PROXY: '.inherited.test' };
  const none = fixture(t);
  assert.equal(none.ar(['dispatch', '没写代理', '--name', 'none'], inherited).status, 0);
  const off = fixture(t, { proxy: { mode: 'off', url: A } });
  assert.equal(off.ar(['dispatch', '没写代理', '--name', 'none'], inherited).status, 0);
  const [a] = none.runs(), [b] = off.runs();
  // 两次运行的临时目录名不同：比较前换成同一个占位符；只报告不同的变量名，不把整个环境打进失败信息。
  const normalize = (env, base) => Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value).replaceAll(path.basename(base), '<id>')]));
  const left = normalize(a, none.base), right = normalize(b, off.base);
  assert.deepEqual(Object.keys(right).sort(), Object.keys(left).sort(), 'off 与不写 proxy 的执行者环境变量名相同');
  assert.deepEqual(Object.keys(left).filter(key => left[key] !== right[key]), [], 'off 与不写 proxy 的执行者环境逐字相同');  assert.deepEqual(none.proxyVars(a), inherited, '继承来的代理变量原样传给执行者');
});

test('dispatch.json 只记 proxy: { mode, applied }，不记地址；off 时没有这个字段', t => {
  const f = fixture(t, { proxy: { mode: 'manual', url: A } });
  assert.equal(f.ar(['dispatch', '记模式', '--name', 'rec-manual']).status, 0);
  const text = fs.readFileSync(path.join(f.record('rec-manual'), 'dispatch.json'), 'utf8');
  assert.deepEqual(f.dispatchJson('rec-manual').proxy, { mode: 'manual', applied: true });
  assert.ok(!text.includes('127.0.0.1') && !text.includes('7890'), 'dispatch.json 里没有地址');
  f.writeConfig({ proxy: { mode: 'off' } });
  assert.equal(f.ar(['dispatch', '不用代理', '--name', 'rec-off']).status, 0);
  assert.equal(Object.hasOwn(f.dispatchJson('rec-off'), 'proxy'), false);
  fs.rmSync(f.configFile);
  assert.equal(f.ar(['dispatch', '没有配置', '--name', 'rec-none']).status, 0);
  assert.equal(Object.hasOwn(f.dispatchJson('rec-none'), 'proxy'), false);
});

test('system：读到地址就注入，applied 为 true；系统代理未开启 / 只有 PAC 时不动、applied 为 false', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t, { proxy: { mode: 'system' } });
  assert.equal(f.ar(['dispatch', '系统代理', '--name', 'sys-found'], { AR_TEST_PROXY_REG: regOutput('0x1', 'http=h1:1;https=10.0.0.9:3128') }).status, 0);
  assert.deepEqual(f.proxyVars(f.runs()[0]), { HTTP_PROXY: 'http://10.0.0.9:3128', HTTPS_PROXY: 'http://10.0.0.9:3128', NO_PROXY: 'localhost,127.0.0.1,::1' });
  assert.deepEqual(f.dispatchJson('sys-found').proxy, { mode: 'system', applied: true });
  assert.equal(f.ar(['dispatch', '系统代理没开', '--name', 'sys-off'], { AR_TEST_PROXY_REG: regOutput('0x0', '10.0.0.9:3128'), HTTPS_PROXY: 'http://inherited.invalid:1' }).status, 0);
  assert.deepEqual(f.proxyVars(f.runs()[1]), { HTTPS_PROXY: 'http://inherited.invalid:1' }, '没读到地址：不动继承来的变量');
  assert.deepEqual(f.dispatchJson('sys-off').proxy, { mode: 'system', applied: false });
  assert.equal(f.ar(['dispatch', '只有 PAC', '--name', 'sys-pac'], { AR_TEST_PROXY_REG: ['    AutoConfigURL    REG_SZ    http://127.0.0.1:7777/p.pac'].join('\r\n') }).status, 0);
  assert.deepEqual(f.proxyVars(f.runs()[2]), {});
  assert.deepEqual(f.dispatchJson('sys-pac').proxy, { mode: 'system', applied: false });
});

test('自动重试：第 2 次尝试也有代理变量，并且重新读了配置（第 1 次运行时把地址换成了另一个）', { timeout: 180000 }, t => {
  const f = fixture(t, { proxy: { mode: 'manual', url: A } });
  const rel = f.spec('docs/specs/990-代理重试.md', 1);
  const result = f.ar(['dispatch', rel, '--name', 'auto-retry'], { AR_TEST_PROXY_DONE: '1', AR_TEST_PROXY_NEXT: JSON.stringify({ mode: 'manual', url: B }) });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const seen = f.runs();
  assert.equal(seen.length, 2, '执行者运行了两次（第 1 次门禁未通过）');
  assert.deepEqual(f.proxyVars(seen[0]), { HTTP_PROXY: A, HTTPS_PROXY: A, NO_PROXY: 'localhost,127.0.0.1,::1' });
  assert.deepEqual(f.proxyVars(seen[1]), { HTTP_PROXY: B, HTTPS_PROXY: B, NO_PROXY: 'localhost,127.0.0.1,::1' }, '第 2 次尝试重新读了配置');
});

test('自动重试：中途改成 off，第 2 次尝试不再带代理变量（环境重建，不是沿用第 1 次的）', { timeout: 180000 }, t => {
  const f = fixture(t, { proxy: { mode: 'manual', url: A } });
  const rel = f.spec('docs/specs/990-代理关闭.md', 1);
  const result = f.ar(['dispatch', rel, '--name', 'auto-off'], { AR_TEST_PROXY_DONE: '1', AR_TEST_PROXY_NEXT: JSON.stringify({ mode: 'off' }) });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const seen = f.runs();
  assert.equal(seen.length, 2);
  assert.equal(f.proxyVars(seen[0]).HTTPS_PROXY, A);
  assert.deepEqual(f.proxyVars(seen[1]), {});
});

test('手动重试（ar retry）：这一次重新读代理', { timeout: 180000 }, t => {
  const f = fixture(t, { proxy: { mode: 'manual', url: A } });
  const rel = f.spec('docs/specs/990-代理手动重试.md', 0);
  const first = f.ar(['dispatch', rel, '--name', 'manual-retry']);
  assert.equal(first.status, 3, '第 1 次门禁未通过：' + first.stderr + first.stdout);
  f.writeConfig({ proxy: { mode: 'manual', url: B } });
  const retried = f.ar(['retry', 'manual-retry'], { AR_TEST_PROXY_DONE: '1' });
  assert.equal(retried.status, 0, retried.stderr + retried.stdout);
  const seen = f.runs();
  assert.equal(seen.length, 2);
  assert.equal(f.proxyVars(seen[0]).HTTPS_PROXY, A);
  assert.equal(f.proxyVars(seen[1]).HTTPS_PROXY, B);
});

test('--detach（脱离派发，执行者进程按请求运行）：执行者进程启动前自己读配置，也带代理变量', { timeout: 120000 }, async t => {
  const f = fixture(t, { proxy: { mode: 'manual', url: A } });
  const result = f.ar(['dispatch', '脱离代理', '--name', 'detached', '--detach', '--json']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const ended = () => { try { return fs.readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8').split('\n').some(line => line.includes('"event":"end"')); } catch { return false; } };
  for (const deadline = Date.now() + 60000; !ended() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(ended(), '脱离的执行者进程已结束');
  assert.deepEqual(f.proxyVars(f.runs()[0]), { HTTP_PROXY: A, HTTPS_PROXY: A, NO_PROXY: 'localhost,127.0.0.1,::1' });
  assert.deepEqual(f.dispatchJson('detached').proxy, { mode: 'manual', applied: true });
});

test('ar agents test：测试连接的执行者也带代理变量（临时公共目录里读不到全局配置，由命令入口加进环境）', { timeout: 180000 }, t => {
  const f = fixture(t, { proxy: { mode: 'manual', url: A } });
  const result = f.ar(['agents', 'test', 'cc', '--json']);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, true, result.stderr + result.stdout);
  assert.deepEqual(f.proxyVars(f.runs()[0]), { HTTP_PROXY: A, HTTPS_PROXY: A, NO_PROXY: 'localhost,127.0.0.1,::1' });
  // off 时测试连接的环境不加也不清。
  f.writeConfig({ proxy: { mode: 'off' } });
  const off = JSON.parse(f.ar(['agents', 'test', 'cc', '--json'], { HTTPS_PROXY: 'http://inherited.invalid:1' }).stdout);
  assert.equal(off.ok, true);
  assert.deepEqual(f.proxyVars(f.runs()[1]), { HTTPS_PROXY: 'http://inherited.invalid:1' });
});

test('ar proxy resolve --json：manual、off、没有配置', t => {
  const f = fixture(t, { proxy: { mode: 'manual', url: `${A}/` } });
  const manual = JSON.parse(f.ar(['proxy', 'resolve', '--json']).stdout);
  assert.deepEqual(manual, { ok: true, mode: 'manual', url: A, source: 'manual', reason: 'manual', env: { HTTP_PROXY: A, HTTPS_PROXY: A, NO_PROXY: 'localhost,127.0.0.1,::1' } });
  assert.match(f.ar(['proxy', 'resolve']).stdout, /^proxy {2}manual http:\/\/127\.0\.0\.1:7890$/m);
  f.writeConfig({ proxy: { mode: 'off' } });
  assert.deepEqual(JSON.parse(f.ar(['proxy', 'resolve', '--json']).stdout), { ok: true, mode: 'off', url: null, source: null, reason: 'off', env: {} });
  fs.rmSync(f.configFile);
  assert.deepEqual(JSON.parse(f.ar(['proxy', 'resolve', '--json']).stdout), { ok: true, mode: 'off', url: null, source: null, reason: 'off', env: {} });
  const bad = f.ar(['proxy', 'bogus', '--json']);
  assert.notEqual(bad.status, 0);
  assert.equal(JSON.parse(bad.stdout).ok, false);
});

test('ar proxy resolve --json：system 读一次系统代理（读到 / 未开启 / 读不到）', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t, { proxy: { mode: 'system' } });
  const resolve = reg => JSON.parse(f.ar(['proxy', 'resolve', '--json'], { AR_TEST_PROXY_REG: reg }).stdout);
  assert.deepEqual(resolve(regOutput('0x1', '127.0.0.1:7890')), { ok: true, mode: 'system', url: A, source: 'system', reason: 'found', env: { HTTP_PROXY: A, HTTPS_PROXY: A, NO_PROXY: 'localhost,127.0.0.1,::1' } });
  assert.deepEqual(resolve(regOutput('0x0', '127.0.0.1:7890')), { ok: true, mode: 'system', url: null, source: null, reason: 'disabled', env: {} });
  assert.deepEqual(resolve('    AutoConfigURL    REG_SZ    http://127.0.0.1:7777/p.pac'), { ok: true, mode: 'system', url: null, source: null, reason: 'pac', env: {} });
  assert.match(f.ar(['proxy', 'resolve'], { AR_TEST_PROXY_REG: regOutput('0x1', '127.0.0.1:7890') }).stdout, /^proxy {2}system 当前读到 http:\/\/127\.0\.0\.1:7890（Windows 系统代理）$/m);
});

test('ar config：多一行 proxy（模式、地址）', t => {
  const f = fixture(t);
  assert.match(f.ar(['config']).stdout, /^proxy {11}off/m);
  f.writeConfig({ proxy: { mode: 'manual', url: A } });
  assert.match(f.ar(['config']).stdout, /^proxy {11}manual http:\/\/127\.0\.0\.1:7890$/m);
});

test('manual 地址带凭据：配置无效，派发被拒绝（不启动执行者），ar proxy resolve 也报错', t => {
  const f = fixture(t, { proxy: { mode: 'manual', url: 'http://user:pass@127.0.0.1:7890' } });
  const result = f.ar(['dispatch', '带凭据', '--name', 'creds']);
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(result.stderr + result.stdout, /proxy\.url 代理地址里不能带用户名和密码/);
  assert.ok(!(result.stderr + result.stdout).includes('pass'), '输出里没有凭据');
  assert.equal(f.runs().length, 0, '没有启动执行者');
  const resolved = f.ar(['proxy', 'resolve', '--json']);
  assert.notEqual(resolved.status, 0);
  assert.match(JSON.parse(resolved.stdout).error, /不能带用户名和密码/);
  // mode 写错也是配置无效。
  f.writeConfig({ proxy: { mode: 'auto' } });
  const wrongMode = f.ar(['dispatch', '写错模式', '--name', 'wrong-mode']);
  assert.equal(wrongMode.status, 2);
  assert.match(wrongMode.stderr + wrongMode.stdout, /proxy\.mode 必须为 off、system、manual 之一/);
});
