import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { deployDsh, cleanupDsh, checkDsh } from '../../core/lib/deploy-dsh.mjs';
import { importDsh } from '../../core/lib/agents.mjs';
import { main } from '../../core/lib/cli.mjs';

// 423：本机安装包服务，模拟 npm 仓库的 tarball。下载在子进程里用 Node 自带 fetch 发，夹具环境的
// NO_PROXY 放行 127.0.0.1（HTTP_PROXY 仍写着一个不存在的地址，确认不用代理时也不会被代理拦住）。
// /pkg/<版本>.tgz：包体就是版本号；/silent/...：只回头、不发送数据（模拟 60 秒无字节）；/status/<码>/...
// 用 unref 让测试进程能正常退出。
const tarballs = http.createServer((req, res) => {
  const parts = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname).split('/').filter(Boolean);
  if (parts[0] === 'status') { res.writeHead(Number(parts[1]) || 500, { 'content-length': '0' }); res.end(); return; }
  if (parts[0] === 'silent') {
    res.writeHead(200, { 'content-length': '9' });
    res.flushHeaders();
    setTimeout(() => { try { res.destroy(); } catch { /* 已经断开 */ } }, 1500).unref();
    return;
  }
  const body = Buffer.from(parts.at(-1).replace(/\.tgz$/, ''));
  res.writeHead(200, { 'content-length': String(body.length) });
  res.end(body);
});
await new Promise(resolve => tarballs.listen(0, '127.0.0.1', resolve));
tarballs.unref();
const tarballBase = `http://127.0.0.1:${tarballs.address().port}`;

async function* chunks(value) { yield Buffer.from(value); }
// 测试注入的 fetch：与标准 Response 同一形状（ok / status / headers.get / 可异步迭代的 body）。
function fakeResponse(body, { status = 200, length = true } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => String(name).toLowerCase() === 'content-length' && length ? String(Buffer.byteLength(body)) : null },
    body: chunks(body),
  };
}
// 收集 step 事件：id、说明与额外字段（percent / approx / bytes / total / fallback）。
const collect = () => {
  const events = [];
  return { events, step: (step, message, extra) => events.push({ step, message, ...extra }) };
};
const firstSeen = events => [...new Set(events.map(event => event.step))];

function fixture(t, prefix = 'ar-dsh-') {
  const base = mkdtempSync(path.join(os.tmpdir(), prefix));
  // 假 npm 结束父进程后自己才退出：spawnSync 返回时它可能还占着目录，删除要容许短暂的 EPERM。
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const bin = path.join(base, 'bin'); mkdirSync(bin);
  // 子进程的系统临时目录也放进夹具：模拟中途崩溃的测试里 finally 不会执行，下载目录（423 起在系统临时目录）随夹具删掉。
  const tmp = path.join(base, 'tmp'); mkdirSync(tmp);
  const env = { ...process.env, LOCALAPPDATA: base, AGENT_ROUTER_HOME: path.join(base, 'home'), PATH: bin, Path: bin, TMP: tmp, TEMP: tmp, TMPDIR: tmp, HTTP_PROXY: 'http://proxy.invalid', NO_PROXY: '127.0.0.1' };
  const target = path.join(base, 'agent-router', 'tools', 'dsh');
  return { base, bin, env, target };
}

function fakeCli(file, source) {
  const script = `${file}.js`;
  writeFileSync(script, source);
  if (process.platform === 'win32') writeFileSync(`${file}.cmd`, `@echo off\r\n"%dp0%\\${path.basename(script)}" %*\r\n`);
  else { writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o755 }); }
  return process.platform === 'win32' ? `${file}.cmd` : file;
}

// 假 npm：dist-tags 查询、包地址查询、npm pack、npm install 四种调用；最后一条调用记录写在 npm 日志里。
// 标记文件（都放在夹具根目录）：fail 让 dist-tags 查询失败；fail-view 让包地址查询失败；fail-pack 让 npm pack 失败；
// fail-install 让安装失败；slow-install 让安装在 2.5 秒后才结束并先写 500 字节（依赖进度采样用）；
// kill-install 让安装在写入半成品后结束父进程；tarball-url 覆盖包地址（{version} 替换成版本号）。
function fakeNpm({ base, bin, target }) {
  const log = path.join(base, 'npm.json');
  const callsFile = path.join(base, 'npm-calls.json');
  writeFileSync(callsFile, '[]');
  writeFileSync(path.join(base, 'tags'), JSON.stringify({ 'dist-tags': { latest: '0.2.1-rc.2' }, versions: ['0.2.1-rc.2'] }));
  const installed = path.join(target, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  const quote = value => JSON.stringify(value);
  const npmScript = `const fs=require('fs'),path=require('path');
const args=process.argv.slice(2), base=${quote(base)}, target=${quote(target)};
const has=name=>fs.existsSync(path.join(base,name));
const call={args,proxy:process.env.HTTP_PROXY};
fs.writeFileSync(${quote(log)},JSON.stringify(call));
const callsFile=${quote(callsFile)}; const calls=JSON.parse(fs.readFileSync(callsFile,'utf8')); calls.push(call); fs.writeFileSync(callsFile,JSON.stringify(calls));
const version=()=>args[1].split('@').at(-1);
if(args[0]==='view'&&args[2]==='dist-tags'){ if(has('fail')) process.exit(3); console.log(fs.readFileSync(path.join(base,'tags'),'utf8')); process.exit(0); }
if(args[0]==='view'){
  if(has('fail-view')) process.exit(3);
  const template=has('tarball-url')?fs.readFileSync(path.join(base,'tarball-url'),'utf8').trim():${quote(`${tarballBase}/pkg/{version}.tgz`)};
  console.log(JSON.stringify({'dist.tarball':template.replace('{version}',version()),'dist.unpackedSize':1000})); process.exit(0);
}
if(args[0]==='pack'){
  if(has('fail-pack')) process.exit(3);
  const dir=args[args.indexOf('--pack-destination')+1], name='deepseek-ai-dsh-'+version()+'.tgz';
  fs.writeFileSync(path.join(dir,name),version()); console.log(name); process.exit(0);
}
if(args[0]==='install'){
  if(has('fail-install')) process.exit(3);
  const value=fs.readFileSync(args.at(-1),'utf8').trim();
  fs.mkdirSync(path.join(target,'node_modules','.bin'),{recursive:true});
  if(has('slow-install')) fs.writeFileSync(path.join(target,'node_modules','filler'),'x'.repeat(500));
  if(has('kill-install')){ fs.writeFileSync(path.join(target,'partial'),'partial'); process.kill(process.ppid); process.exit(0); }
  if(has('slow-install')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2500);
  ${process.platform === 'win32'
    ? `fs.writeFileSync(${quote(installed)},'@echo off\\r\\n"%dp0%\\\\dsh.js" %*\\r\\n'); fs.writeFileSync(path.join(path.dirname(${quote(installed)}),'dsh.js'),"console.log("+JSON.stringify(value)+")");`
    : `fs.writeFileSync(${quote(installed)},"#!${process.execPath.replaceAll('\\', '/')}\\nconsole.log("+JSON.stringify(value)+")\\n",{mode:0o755});`}
  process.exit(0);
}
process.exit(3);`;
  if (process.platform === 'win32') {
    const entry = path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, npmScript);
    writeFileSync(path.join(bin, 'npm.cmd'), '@ECHO OFF\r\nSET "NPM_CLI_JS=%~dp0node_modules\\npm\\bin\\npm-cli.js"\r\n');
    writeFileSync(path.join(bin, 'node.exe'), readFileSync(process.execPath));
  } else fakeCli(path.join(bin, 'npm'), npmScript);
  return { installed, log, calls: callsFile };
}

test('安装、失败重试、代理、分步进度和已有配置保留', async t => {
  const { base, bin, env, target } = fixture(t);
  const { installed, log } = fakeNpm({ base, bin, target });
  const collected = collect();
  const options = { env, step: collected.step, importAgent: file => importDsh(env.AGENT_ROUTER_HOME, file), test: async () => ({ ok: true }), fetch: async () => fakeResponse('0.2.1-rc.2') };
  writeFileSync(path.join(base, 'fail-install'), '');
  await assert.rejects(deployDsh(options), /安装 DeepSeek Harness 失败/);
  assert.equal(existsSync(target), false);
  rmSync(path.join(base, 'fail-install'));
  collected.events.length = 0;
  const result = await deployDsh(options);
  // 下载进度按 Content-Length 折算：中间事件带 percent / bytes / total，最后一次是 100。
  assert.ok(collected.events.some(e => e.step === 'download' && e.percent < 100 && e.bytes === 10 && e.total === 10), '下载中途要报百分比与大小');
  assert.deepEqual(collected.events.filter(e => e.step === 'download' && e.percent === 100).length, 1);
  assert.ok(!collected.events.some(e => e.step === 'test' && 'percent' in e), '测试连接没有百分比');
  assert.deepEqual(firstSeen(collected.events), ['download', 'deps', 'config', 'test']);
  assert.deepEqual(collected.events.filter(e => e.step === 'config').map(e => e.percent), [0, 50, 100]);
  assert.ok(collected.events.some(e => e.step === 'deps' && e.percent === 100 && !e.approx));
  const marker = JSON.parse(readFileSync(path.join(target, '.agent-router-dsh.json'), 'utf8'));
  assert.equal(marker.version, '0.2.1-rc.2');
  assert.ok(Number.isSafeInteger(marker.bytes) && marker.bytes > 0);
  assert.equal(result.version, '0.2.1-rc.2');
  const npmCall = JSON.parse(readFileSync(log));
  assert.deepEqual(npmCall.args.slice(0, 3), ['install', '--prefix', target]);
  assert.match(npmCall.args[3], /ar-dsh-download-.*\.tgz$/);
  assert.equal(npmCall.proxy, env.HTTP_PROXY);
  const configPath = path.join(env.AGENT_ROUTER_HOME, 'config.json');
  const config = JSON.parse(readFileSync(configPath));
  config.profiles['deepseek-harness'].label = '保留';
  writeFileSync(configPath, JSON.stringify(config));
  collected.events.length = 0;
  const again = await deployDsh(options);
  assert.equal(again.path, installed);
  assert.equal(again.version, result.version);
  assert.deepEqual(firstSeen(collected.events), ['download', 'config', 'test']);
  assert.equal(JSON.parse(readFileSync(configPath)).profiles['deepseek-harness'].label, '保留');
  await assert.rejects(deployDsh({ ...options, test: async () => ({ ok: false, exit: 1, error: 'secret' }) }), /连接测试失败（退出码 1）/);
});

test('PATH 上已有程序时使用实际版本，不安装', async t => {
  const { bin, env } = fixture(t);
  const executable = fakeCli(path.join(bin, 'dsh'), "console.log('dsh 1.2.3')");
  const collected = collect();
  const result = await deployDsh({ env, step: collected.step, importAgent: file => assert.equal(file, executable), test: async () => ({ ok: true }) });
  assert.deepEqual(firstSeen(collected.events), ['download', 'config', 'test']);
  assert.equal(result.version, '1.2.3');
});

test('导入时复制被其他执行者引用的声明，保留共用声明及其他配置', t => {
  const { env } = fixture(t);
  importDsh(env.AGENT_ROUTER_HOME, '/old/dsh');
  const file = path.join(env.AGENT_ROUTER_HOME, 'config.json');
  const config = JSON.parse(readFileSync(file));
  const profile = config.profiles['deepseek-harness'];
  const ref = profile.generic;
  config.profiles.other = { ...structuredClone(profile), label: '其他执行者' };
  config.generics['deepseek-harness-deploy'] = { executable: '/occupied' };
  const original = structuredClone(config);
  writeFileSync(file, JSON.stringify(config));
  importDsh(env.AGENT_ROUTER_HOME, '/new/dsh');
  const updated = JSON.parse(readFileSync(file));
  const newRef = updated.profiles['deepseek-harness'].generic;
  assert.equal(newRef, 'deepseek-harness-deploy-2');
  assert.deepEqual(updated.generics[ref], original.generics[ref]);
  assert.deepEqual(updated.profiles.other, original.profiles.other);
  assert.deepEqual(updated.generics['deepseek-harness-deploy'], original.generics['deepseek-harness-deploy']);
  assert.deepEqual(updated.generics[newRef], { ...original.generics[ref], executable: '/new/dsh' });
  assert.deepEqual(updated.profiles['deepseek-harness'], { ...original.profiles['deepseek-harness'], generic: newRef });
});

test('cleanup 删除半装目录，undeploy 删除安装目录并保留执行者配置', async t => {
  const { env, target } = fixture(t);
  const lines = [];
  const run = args => main(args, { env, scriptPath: path.resolve('core/ar.mjs'), out: line => lines.push(JSON.parse(line)) });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'partial'), 'partial');
  const st = lstatSync(target, { bigint: true });
  writeFileSync(path.join(path.dirname(target), 'dsh.transaction.json'), JSON.stringify({ version: 1, pid: 2147483647, started: Date.now(), backup: 'dsh.backup-1-ab', staging: 'dsh.staging-ab', old: null, created: { dev: String(st.dev), ino: String(st.ino) } }));
  assert.equal(await run(['agents', 'deploy', 'deepseek-harness', '--cleanup', '--json']), 0);
  assert.deepEqual(lines.splice(0), [{ ok: true }]);
  assert.equal(existsSync(target), false);
  importDsh(env.AGENT_ROUTER_HOME, '/installed/dsh');
  const configPath = path.join(env.AGENT_ROUTER_HOME, 'config.json');
  const config = readFileSync(configPath, 'utf8');
  mkdirSync(path.join(target, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(path.join(target, 'node_modules', '.bin', 'dsh'), 'installed');
  assert.equal(await run(['agents', 'undeploy', 'deepseek-harness', '--json']), 0);
  assert.deepEqual(lines, [{ ok: true }]);
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(configPath, 'utf8'), config);
});

test('进程在备份和创建目录后终止时恢复原目录，新安装清理半成品', t => {
  for (const point of ['backup', 'created', 'new']) {
    const { base, bin, env, target } = fixture(t);
    fakeNpm({ base, bin, target });
    // 子进程部署期间 spawnSync 会卡住父进程，本进程里的安装包服务不响应；这几种中断测试走 npm pack 兜底。
    writeFileSync(path.join(base, 'fail-view'), '');
    const marker = Buffer.from('{ "version": "0.1.0" }\n');
    if (point !== 'new') {
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, '.agent-router-dsh.json'), marker);
      writeFileSync(path.join(target, 'old'), 'original');
    }
    const source = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync; fs.renameSync = (...args) => { rename(...args); if ((${JSON.stringify(point)} === 'backup' && String(args[1]).includes('dsh.backup-')) || (${JSON.stringify(point)} !== 'backup' && String(args[0]).includes('dsh.staging-'))) process.exit(90); }; syncBuiltinESMExports();
      const { deployDsh } = await import(${JSON.stringify(pathToFileURL(path.resolve('core/lib/deploy-dsh.mjs')).href)});
      await deployDsh({ env: process.env, step() {}, importAgent() {}, test: async () => ({ok:true}), version: '0.2.1-rc.5' });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 90, child.stderr);
    assert.deepEqual(cleanupDsh({ env }), { ok: true });
    assert.deepEqual(cleanupDsh({ env }), { ok: true });
    if (point === 'new') assert.equal(existsSync(target), false);
    else {
      assert.deepEqual(readFileSync(path.join(target, '.agent-router-dsh.json')), marker);
      assert.equal(readFileSync(path.join(target, 'old'), 'utf8'), 'original');
    }
  }
});

test('无事务保留已有目录，异常事务和活动事务安全拒绝', async t => {
  const { env, target } = fixture(t);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, '.agent-router-dsh.json'), 'original');
  assert.deepEqual(cleanupDsh({ env }), { ok: true });
  const state = path.join(path.dirname(target), 'dsh.transaction.json');
  writeFileSync(state, '{');
  const lines = [];
  assert.equal(await main(['agents', 'deploy', 'deepseek-harness', '--cleanup', '--json'], { env, out: line => lines.push(JSON.parse(line)) }), 2);
  assert.match(lines[0].error, /无法安全清理/);
  assert.equal(readFileSync(path.join(target, '.agent-router-dsh.json'), 'utf8'), 'original');
  const st = lstatSync(target, { bigint: true });
  writeFileSync(state, JSON.stringify({ version: 1, pid: process.pid, started: Date.now(), backup: 'dsh.backup-1-ab', staging: 'dsh.staging-ab', old: { dev: String(st.dev), ino: String(st.ino) }, created: null }));
  assert.throws(() => cleanupDsh({ env }), /无法安全清理/);
  await assert.rejects(deployDsh({ env, step() {}, importAgent() {}, test() {} }), /无法安全清理/);
  assert.equal(readFileSync(path.join(target, '.agent-router-dsh.json'), 'utf8'), 'original');
});

test('npm 运行时终止部署进程后恢复原目录', t => {
  const { base, bin, env, target } = fixture(t);
  fakeNpm({ base, bin, target });
  writeFileSync(path.join(base, 'fail-view'), '');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, '.agent-router-dsh.json'), '{"version":"0.1.0"}');
  writeFileSync(path.join(target, 'old'), 'original');
  // 假 npm 到 install 这一步才写半成品并结束父进程（423：下载在事务之前，不能更早动安装目录）。
  writeFileSync(path.join(base, 'kill-install'), '');
  const source = `const { deployDsh } = await import(${JSON.stringify(pathToFileURL(path.resolve('core/lib/deploy-dsh.mjs')).href)}); await deployDsh({ env: process.env, step() {}, importAgent() {}, test: async () => ({ok:true}), version: '0.2.1-rc.5' });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(child.status, 0);
  assert.equal(existsSync(path.join(target, 'partial')), true);
  assert.deepEqual(cleanupDsh({ env }), { ok: true });
  assert.equal(readFileSync(path.join(target, 'old'), 'utf8'), 'original');
  assert.equal(readFileSync(path.join(target, '.agent-router-dsh.json'), 'utf8'), '{"version":"0.1.0"}');
  assert.equal(existsSync(path.join(target, 'partial')), false);
});

test('暂存目录创建后身份写入前中断，清理已登记的暂存目录', t => {
  const { base, bin, env, target } = fixture(t);
  fakeNpm({ base, bin, target });
  writeFileSync(path.join(base, 'fail-view'), '');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'old'), 'original');
  const source = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const mkdir = fs.mkdirSync; fs.mkdirSync = (...args) => { const result = mkdir(...args); if (String(args[0]).includes('dsh.staging-')) process.exit(90); return result; }; syncBuiltinESMExports();
    const { deployDsh } = await import(${JSON.stringify(pathToFileURL(path.resolve('core/lib/deploy-dsh.mjs')).href)});
    await deployDsh({ env: process.env, step() {}, importAgent() {}, test: async () => ({ok:true}), version: '0.2.1-rc.5' });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 90, child.stderr);
  assert.deepEqual(cleanupDsh({ env }), { ok: true });
  assert.equal(readFileSync(path.join(target, 'old'), 'utf8'), 'original');
  assert.equal(readdirSync(path.dirname(target)).filter(name => name.startsWith('dsh.staging-') || name.startsWith('dsh.transaction')).length, 0);
  assert.deepEqual(cleanupDsh({ env }), { ok: true });
});

test('删除备份途中中断后继续清理，保留已提交的新安装', t => {
  const { base, bin, env, target } = fixture(t);
  fakeNpm({ base, bin, target });
  writeFileSync(path.join(base, 'fail-view'), '');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, '.agent-router-dsh.json'), '{"version":"0.1.0"}');
  writeFileSync(path.join(target, 'old'), 'original');
  const source = `import fs from 'node:fs'; import path from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
    const rm = fs.rmSync; fs.rmSync = (...args) => { if (String(args[0]).includes('dsh.backup-')) { rm(path.join(args[0], 'old')); process.exit(90); } return rm(...args); }; syncBuiltinESMExports();
    const { deployDsh } = await import(${JSON.stringify(pathToFileURL(path.resolve('core/lib/deploy-dsh.mjs')).href)});
    await deployDsh({ env: process.env, step() {}, importAgent() {}, test: async () => ({ok:true}), version: '0.2.1-rc.5' });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 90, child.stderr);
  const marker = readFileSync(path.join(target, '.agent-router-dsh.json'));
  assert.equal(JSON.parse(marker).version, '0.2.1-rc.5');
  assert.deepEqual(cleanupDsh({ env }), { ok: true });
  assert.deepEqual(readFileSync(path.join(target, '.agent-router-dsh.json')), marker);
  assert.equal(readdirSync(path.dirname(target)).filter(name => name.startsWith('dsh.backup-') || name.startsWith('dsh.transaction')).length, 0);
  assert.deepEqual(cleanupDsh({ env }), { ok: true });
});

test('孤立备份不动，多个事务及备份链接安全拒绝', t => {
  const { base, env, target } = fixture(t);
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'old'), 'original');
  const root = path.dirname(target), backup = path.join(root, 'dsh.backup-1-ab');
  mkdirSync(backup); writeFileSync(path.join(backup, 'keep'), 'backup');
  assert.deepEqual(cleanupDsh({ env }), { ok: true });
  assert.equal(readFileSync(path.join(backup, 'keep'), 'utf8'), 'backup');
  const state = path.join(root, 'dsh.transaction.json');
  const st = lstatSync(target, { bigint: true });
  writeFileSync(state, JSON.stringify({ version: 1, pid: 2147483647, started: Date.now(), backup: 'dsh.backup-1-ab', staging: 'dsh.staging-ab', old: { dev: String(st.dev), ino: String(st.ino) }, created: null }));
  writeFileSync(path.join(root, 'dsh.transaction.extra'), '{}');
  assert.throws(() => cleanupDsh({ env }), /无法安全清理/);
  rmSync(path.join(root, 'dsh.transaction.extra'));
  assert.throws(() => cleanupDsh({ env }), /无法安全清理/);
  assert.equal(readFileSync(path.join(target, 'old'), 'utf8'), 'original');
  rmSync(backup, { recursive: true });
  try { symlinkSync(base, backup, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`无法创建链接：${error.code}`); return; }
  assert.throws(() => cleanupDsh({ env }), /无法安全清理/);
  assert.equal(readFileSync(path.join(target, 'old'), 'utf8'), 'original');
});

test('清理幂等并拒绝目录链接', t => {
  const { base, env, target } = fixture(t);
  assert.deepEqual(cleanupDsh({ env }), { ok: true });
  mkdirSync(path.dirname(target), { recursive: true });
  const outside = path.join(base, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'keep'), 'x');
  try { symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`无法创建链接：${error.code}`); return; }
  assert.throws(() => cleanupDsh({ env }), /无法安全清理/);
  assert.ok(existsSync(path.join(outside, 'keep')));
});

test('命令 JSON 输出用法错误及缺少 npm', async t => {
  const { env } = fixture(t);
  const lines = [];
  const run = args => main(args, { env, scriptPath: path.resolve('core/ar.mjs'), out: line => lines.push(JSON.parse(line)) });
  assert.equal(await run(['agents', 'deploy', 'wrong', '--json']), 2);
  assert.equal(lines.pop().ok, false);
  assert.equal(await run(['agents', 'deploy', 'deepseek-harness', '--json']), 1);
  assert.deepEqual(lines.map(v => v.event ?? v.ok), ['step', 'step', false]);
  assert.match(lines.at(-1).error, /没有找到 npm/);
  lines.length = 0;
  assert.equal(await run(['agents', 'undeploy', 'deepseek-harness', '--json']), 0);
  assert.deepEqual(lines, [{ ok: true }]);
});

test('命令入口成功部署时按顺序输出四步 JSON 行', async t => {
  const { base, bin, env, target } = fixture(t);
  const { installed } = fakeNpm({ base, bin, target });
  const lines = [];
  const code = await main(['agents', 'deploy', 'deepseek-harness', '--json'], {
    env, scriptPath: path.resolve('core/ar.mjs'), out: line => lines.push(JSON.parse(line)),
    deployTest: async (home, name) => {
      assert.equal(home, env.AGENT_ROUTER_HOME);
      assert.equal(name, 'deepseek-harness');
      return { ok: true };
    },
  });
  assert.equal(code, 0);
  const steps = lines.slice(0, -1);
  assert.deepEqual(firstSeen(steps), ['download', 'deps', 'config', 'test']);
  assert.ok(steps.every(line => line.event === 'step' && typeof line.message === 'string'));
  // 下载的百分比 / 大小与依赖的大致百分比只在有值时出现；测试连接只有说明。
  assert.ok(steps.some(line => line.step === 'download' && typeof line.percent === 'number' && line.bytes === 10 && line.total === 10));
  assert.ok(steps.some(line => line.step === 'deps' && line.approx === true && typeof line.percent === 'number'));
  assert.ok(steps.filter(line => line.step === 'test').every(line => !('percent' in line) && !('bytes' in line)));
  assert.deepEqual(lines.at(-1), { ok: true, path: installed, version: '0.2.1-rc.2', imported: true, verified: true, unverified: false });
});

test('检查版本只读，覆盖新版本、相同版本和查询失败', async t => {
  const { base, bin, env, target } = fixture(t);
  const { log } = fakeNpm({ base, bin, target });
  const lines = [];
  const run = () => main(['agents', 'deploy', 'deepseek-harness', '--check', '--json'], { env, scriptPath: path.resolve('core/ar.mjs'), out: line => lines.push(JSON.parse(line)) });
  writeFileSync(path.join(base, 'tags'), JSON.stringify({ 'dist-tags': { latest: '0.3.0', next: '0.4.0-rc.1', beta: '0.4.0-beta' }, versions: Array.from({ length: 12 }, (_, i) => `0.1.${i}`) }));
  assert.equal(await run(), 0);
  assert.deepEqual(lines.pop(), { ok: true, verified: '0.2.1-rc.2', tags: { latest: '0.3.0', next: '0.4.0-rc.1', beta: '0.4.0-beta' }, recommended: '0.4.0-rc.1', versions: Array.from({ length: 10 }, (_, i) => `0.1.${11 - i}`), installed: null, path: null, updateAvailable: false });
  assert.deepEqual(JSON.parse(readFileSync(log)).args, ['view', '@deepseek-ai/dsh', 'dist-tags', 'versions', '--json']);
  assert.equal(JSON.parse(readFileSync(log)).proxy, env.HTTP_PROXY);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(env.AGENT_ROUTER_HOME), false);
  writeFileSync(path.join(base, 'tags'), JSON.stringify({ 'dist-tags': { latest: '0.2.1-rc.2' }, versions: ['0.2.1-rc.2'] }));
  assert.equal(await run(), 0);
  assert.equal(lines.pop().updateAvailable, false);
  writeFileSync(path.join(base, 'fail'), '');
  assert.equal(await run(), 0);
  assert.deepEqual(lines.pop(), { ok: true, verified: '0.2.1-rc.2', tags: {}, recommended: '0.2.1-rc.2', versions: [], warning: '查不到最新版本（退出码 3）', installed: null, path: null, updateAvailable: false });
});

test('指定版本安装并警告，非法版本退出 2', async t => {
  const { base, bin, env, target } = fixture(t);
  fakeNpm({ base, bin, target });
  const lines = [];
  const options = { env, scriptPath: path.resolve('core/ar.mjs'), out: line => lines.push(JSON.parse(line)), deployTest: async () => ({ ok: true }) };
  assert.equal(await main(['agents', 'deploy', 'deepseek-harness', '--version', '1.2.3', '--json'], options), 0);
  assert.equal(lines.at(-1).version, '1.2.3');
  assert.equal(lines.at(-1).unverified, true);
  assert.equal(JSON.parse(readFileSync(path.join(target, '.agent-router-dsh.json'), 'utf8')).version, '1.2.3');
  lines.length = 0;
  assert.equal(await main(['agents', 'deploy', 'deepseek-harness', '--version', 'bad/version', '--json'], options), 2);
  assert.deepEqual(lines, [{ ok: false, error: '版本号无效：bad/version' }]);
});

test('默认安装 next，失败保留目录并可改装验证版', async t => {
  const { base, bin, env, target } = fixture(t);
  const { installed } = fakeNpm({ base, bin, target });
  writeFileSync(path.join(base, 'tags'), JSON.stringify({ 'dist-tags': { latest: '0.2.1-rc.2', next: '0.2.1-rc.5' }, versions: ['0.2.1-rc.2', '0.2.1-rc.5'] }));
  const lines = [];
  let pass = false;
  const options = { env, scriptPath: path.resolve('core/ar.mjs'), out: line => lines.push(JSON.parse(line)), deployTest: async () => ({ ok: pass, exit: 7 }) };
  assert.equal(await main(['agents', 'deploy', 'deepseek-harness', '--json'], options), 1);
  assert.deepEqual(lines.at(-1), { ok: false, error: '这个版本（0.2.1-rc.5）和 AgentRouter 不兼容：连接测试失败（退出码 7）', incompatible: true, fallback: '0.2.1-rc.2' });
  assert.ok(existsSync(installed));
  // 新版本测试没通过时不会写标记文件：用检测结果确认装的确实是推荐版（next）。
  assert.equal(checkDsh({ env }).installed, '0.2.1-rc.5');
  lines.length = 0;
  assert.equal(await main(['agents', 'deploy', 'deepseek-harness', '--check', '--json'], options), 0);
  assert.equal(lines.at(-1).updateAvailable, false);
  pass = true;
  assert.equal(await main(['agents', 'deploy', 'deepseek-harness', '--version', '0.2.1-rc.2', '--json'], options), 0);
  assert.equal(lines.at(-1).verified, true);
  assert.equal(readdirSync(path.dirname(target)).filter(name => name.startsWith('dsh.backup-')).length, 0);
});

test('更新成功删除备份，测试失败还原旧版本', async t => {
  const { base, bin, env, target } = fixture(t);
  fakeNpm({ base, bin, target });
  const lines = [];
  let pass = true;
  const options = { env, scriptPath: path.resolve('core/ar.mjs'), out: line => lines.push(JSON.parse(line)), deployTest: async () => ({ ok: pass, exit: 1 }) };
  const run = version => main(['agents', 'deploy', 'deepseek-harness', '--version', version, '--json'], options);
  assert.equal(await run('0.2.1-rc.2'), 0);
  assert.equal(await run('0.2.1-rc.5'), 0);
  assert.equal(lines.at(-1).unverified, true);
  assert.equal(readdirSync(path.dirname(target)).filter(name => name.startsWith('dsh.backup-')).length, 0);
  pass = false;
  assert.equal(await run('0.3.0'), 1);
  assert.deepEqual(lines.at(-1), { ok: false, error: '新版本测试失败（连接测试失败（退出码 1）），已退回 0.2.1-rc.5' });
  assert.equal(readdirSync(path.dirname(target)).filter(name => name.startsWith('dsh.backup-')).length, 0);
  lines.length = 0;
  assert.equal(await main(['agents', 'deploy', 'deepseek-harness', '--check', '--json'], options), 0);
  assert.equal(lines.at(-1).installed, '0.2.1-rc.5');
  assert.equal(lines.at(-1).updateAvailable, true);
});

test('改装 fallback 后同一原因再失败：两个版本都没通过，不再说兼容也不给 fallback', async t => {
  const { base, bin, env, target } = fixture(t);
  const { installed } = fakeNpm({ base, bin, target });
  const lines = [];
  let failing = false;
  const options = { env, scriptPath: path.resolve('core/ar.mjs'), out: line => lines.push(JSON.parse(line)),
    deployTest: async () => failing ? { ok: false, exit: 1, error: '同一项测试失败（版本 0.2.1-rc.2）' } : { ok: true } };
  assert.equal(await main(['agents', 'deploy', 'deepseek-harness', '--version', '0.2.1-rc.5', '--json'], options), 0);
  // 上一次（0.2.1-rc.5）的测试记录：同一项失败，只有版本号不同。
  writeFileSync(path.join(env.AGENT_ROUTER_HOME, 'agent-tests.json'), JSON.stringify({
    'deepseek-harness': { at: Date.now(), ok: false, seconds: 3, version: null, error: '同一项测试失败（版本 0.2.1-rc.5）' },
  }));
  failing = true;
  lines.length = 0;
  assert.equal(await main(['agents', 'deploy', 'deepseek-harness', '--version', '0.2.1-rc.2', '--json'], options), 1);
  const last = lines.at(-1);
  assert.deepEqual(last, { ok: false, error: '两个版本都没通过同一项测试：连接测试失败（退出码 1）；问题不在版本，先按原因处理' });
  assert.ok(!('fallback' in last));
  assert.ok(existsSync(installed), '退回旧版本，安装目录还在');
  assert.equal(JSON.parse(readFileSync(path.join(target, '.agent-router-dsh.json'), 'utf8')).version, '0.2.1-rc.5');
  assert.equal(readdirSync(path.dirname(target)).filter(name => name.startsWith('dsh.backup-')).length, 0);
});

test('查询失败时默认安装验证版', async t => {
  const { base, bin, env } = fixture(t);
  const { log } = fakeNpm({ base, bin, target: path.join(base, 'agent-router', 'tools', 'dsh') });
  rmSync(path.join(base, 'tags'));
  const result = await deployDsh({ env, step: () => {}, importAgent: () => {}, test: async () => ({ ok: true }) });
  assert.equal(result.version, '0.2.1-rc.2');
  assert.equal(result.verified, true);
  assert.equal(JSON.parse(readFileSync(log)).args[0], 'install');
});

test('更新导入失败时恢复旧目录并报告退回', async t => {
  const { base, bin, env, target } = fixture(t);
  fakeNpm({ base, bin, target });
  const options = { env, step: () => {}, importAgent: () => {}, test: async () => ({ ok: true }) };
  await deployDsh({ ...options, version: '0.2.1-rc.2' });
  writeFileSync(path.join(target, 'old-marker'), 'old');
  await assert.rejects(deployDsh({ ...options, version: '0.2.1-rc.5', importAgent: async () => { throw new Error('导入异常'); } }), { message: '导入失败，已退回 0.2.1-rc.2：导入异常' });
  assert.equal(readFileSync(path.join(target, 'old-marker'), 'utf8'), 'old');
  assert.equal(readdirSync(path.dirname(target)).filter(name => name.startsWith('dsh.backup-')).length, 0);
});

test('自管目录版本无法检测时安装失败也恢复原目录', async t => {
  const { base, bin, env, target } = fixture(t);
  fakeNpm({ base, bin, target });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'old-marker'), 'old');
  writeFileSync(path.join(target, '.agent-router-dsh.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(path.join(base, 'fail-install'), '');
  const options = { env, step: () => {}, importAgent: () => {}, test: async () => ({ ok: true }), version: '0.2.1-rc.5' };
  await assert.rejects(deployDsh(options), { message: '安装 DeepSeek Harness 失败：退出码 3，已退回 0.1.0' });
  assert.equal(readFileSync(path.join(target, 'old-marker'), 'utf8'), 'old');
  assert.equal(readdirSync(path.dirname(target)).filter(name => name.startsWith('dsh.backup-')).length, 0);
});

test('自管目录版本未知且使用 PATH 程序时，更新失败恢复目录和执行者配置', async t => {
  const { base, bin, env, target } = fixture(t);
  fakeNpm({ base, bin, target });
  const executable = fakeCli(path.join(bin, 'dsh'), "console.log('dsh 1.2.3')");
  importDsh(env.AGENT_ROUTER_HOME, executable);
  const file = path.join(env.AGENT_ROUTER_HOME, 'config.json');
  const original = JSON.parse(readFileSync(file));
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'old-marker'), 'old');
  writeFileSync(path.join(target, '.agent-router-dsh.json'), JSON.stringify({ version: '0.1.0' }));
  const lines = [];
  const code = await main(['agents', 'deploy', 'deepseek-harness', '--version', '0.2.1-rc.5', '--json'], {
    env, scriptPath: path.resolve('core/ar.mjs'), out: line => lines.push(JSON.parse(line)),
    deployTest: async () => ({ ok: false, exit: 7 }),
  });
  assert.equal(code, 1);
  assert.deepEqual(lines.at(-1), { ok: false, error: '新版本测试失败（连接测试失败（退出码 7）），已退回 0.1.0' });
  assert.equal(readFileSync(path.join(target, 'old-marker'), 'utf8'), 'old');
  const restored = JSON.parse(readFileSync(file));
  assert.deepEqual(restored.profiles['deepseek-harness'], original.profiles['deepseek-harness']);
  assert.deepEqual(restored.generics, original.generics);
  assert.equal(restored.generics[restored.profiles['deepseek-harness'].generic].executable, executable);
  assert.equal(readdirSync(path.dirname(target)).filter(name => name.startsWith('dsh.backup-')).length, 0);
});

test('导入写入后抛异常时恢复执行者配置', async t => {
  const { base, bin, env, target } = fixture(t);
  fakeNpm({ base, bin, target });
  const options = { env, step: () => {}, importAgent: file => importDsh(env.AGENT_ROUTER_HOME, file), test: async () => ({ ok: true }) };
  await deployDsh({ ...options, version: '0.2.1-rc.2' });
  const file = path.join(env.AGENT_ROUTER_HOME, 'config.json');
  const original = JSON.parse(readFileSync(file));
  await assert.rejects(deployDsh({ ...options, version: '0.2.1-rc.5', importAgent: file => {
    importDsh(env.AGENT_ROUTER_HOME, file);
    throw new Error('导入异常');
  } }), /导入失败，已退回 0.2.1-rc.2/);
  const restored = JSON.parse(readFileSync(file));
  assert.deepEqual(restored.profiles['deepseek-harness'], original.profiles['deepseek-harness']);
  assert.deepEqual(restored.generics, original.generics);
});

test('连接测试抛异常时首次安装提示不兼容，更新恢复旧版', async t => {
  const { base, bin, env, target } = fixture(t);
  const { installed } = fakeNpm({ base, bin, target });
  const options = { env, step: () => {}, importAgent: () => {}, test: async () => { throw new Error('测试异常'); } };
  assert.deepEqual(await deployDsh({ ...options, version: '0.2.1-rc.5' }), {
    ok: false, error: '这个版本（0.2.1-rc.5）和 AgentRouter 不兼容：连接测试失败（测试异常）', incompatible: true, fallback: '0.2.1-rc.2',
  });
  assert.ok(existsSync(installed));
  writeFileSync(path.join(target, 'old-marker'), 'old');
  await assert.rejects(deployDsh({ ...options, version: '0.3.0' }), { message: '新版本测试失败（连接测试失败（测试异常）），已退回 0.2.1-rc.5' });
  assert.equal(readFileSync(path.join(target, 'old-marker'), 'utf8'), 'old');
  assert.equal(readdirSync(path.dirname(target)).filter(name => name.startsWith('dsh.backup-')).length, 0);
});

test('残缺目录按首次安装处理，连接失败返回不兼容', async t => {
  const { base, bin, env, target } = fixture(t);
  const { installed } = fakeNpm({ base, bin, target });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'partial'), 'partial');
  const result = await deployDsh({ env, step: () => {}, importAgent: () => {}, test: async () => ({ ok: false, exit: 7 }), version: '0.2.1-rc.5' });
  assert.deepEqual(result, { ok: false, error: '这个版本（0.2.1-rc.5）和 AgentRouter 不兼容：连接测试失败（退出码 7）', incompatible: true, fallback: '0.2.1-rc.2' });
  assert.ok(existsSync(installed));
  assert.equal(existsSync(path.join(target, 'partial')), false);
  assert.equal(readdirSync(path.dirname(target)).filter(name => name.startsWith('dsh.backup-')).length, 0);
});

test('没有 Content-Length 时下载中途只报字节，结束报一次 100', async t => {
  const { base, bin, env } = fixture(t);
  fakeNpm({ base, bin, target: path.join(base, 'agent-router', 'tools', 'dsh') });
  const collected = collect();
  const result = await deployDsh({
    env, step: collected.step, importAgent: () => {}, test: async () => ({ ok: true }),
    fetch: async () => fakeResponse('0.2.1-rc.2', { length: false }),
  });
  assert.equal(result.ok, true);
  const download = collected.events.filter(e => e.step === 'download');
  assert.ok(download.some(e => e.bytes === 10 && !('percent' in e)));
  assert.ok(download.every(e => !('total' in e)));
  // 中途没有百分比（只有开头的 0）；结束时补一次 100，界面靠它把这一行画满。
  assert.deepEqual(download.filter(e => 'percent' in e).map(e => e.percent), [0, 0, 0, 100]);
  assert.equal(download.at(-1).percent, 100);
  assert.equal(download.at(-1).bytes, 10);
});

test('依赖进度按上次安装记下的字节折算，结束后报 100 不带约数', async t => {
  const { base, bin, env, target } = fixture(t);
  fakeNpm({ base, bin, target });
  const options = { env, step: () => {}, importAgent: () => {}, test: async () => ({ ok: true }) };
  await deployDsh({ ...options, version: '0.2.1-rc.2' });
  writeFileSync(path.join(target, '.agent-router-dsh.json'), JSON.stringify({ version: '0.2.1-rc.2', bytes: 1000 }));
  writeFileSync(path.join(base, 'slow-install'), '');
  const collected = collect();
  await deployDsh({ ...options, version: '0.2.1-rc.5', step: collected.step });
  const deps = collected.events.filter(e => e.step === 'deps');
  assert.ok(deps.some(e => e.percent === 50 && e.approx === true && e.bytes === 500), '按记下的 1000 字节折算成 50%');
  const last = deps.at(-1);
  assert.equal(last.percent, 100);
  assert.ok(!('approx' in last));
});

test('下载走核心设置的代理：请求经过本机 HTTP 代理', async t => {
  const { base, bin, env } = fixture(t);
  fakeNpm({ base, bin, target: path.join(base, 'agent-router', 'tools', 'dsh') });
  writeFileSync(path.join(base, 'tarball-url'), 'http://example.invalid/dsh-{version}.tgz');
  const hits = [];
  const tunnels = new Set();
  const proxy = http.createServer();
  // Node 24 的 fetch 对 http 目标也走代理的 CONNECT 隧道：先回 200，再把安装包内容写进隧道。
  proxy.on('connect', (req, socket) => {
    tunnels.add(socket);
    socket.on('close', () => tunnels.delete(socket));
    hits.push(req.url);
    const body = Buffer.from('0.2.1-rc.2');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.end(`HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  // CONNECT 出来的 socket 不归 closeAllConnections 管，收尾时自己断开，否则测试进程等它。
  t.after(() => { for (const socket of tunnels) socket.destroy(); proxy.closeAllConnections?.(); proxy.close(); });
  const proxyEnv = { ...env, HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` };
  delete proxyEnv.NO_PROXY;
  const lines = [];
  const code = await main(['agents', 'deploy', 'deepseek-harness', '--json'], {
    env: proxyEnv, scriptPath: path.resolve('core/ar.mjs'), out: line => lines.push(JSON.parse(line)),
    deployTest: async () => ({ ok: true }),
  });
  assert.equal(code, 0, JSON.stringify(lines.at(-1)));
  // 负载高时 Node 自带的 fetch 可能重连一次，隧道数不固定；要核对的是每次请求都经过代理、目标都是安装包地址。
  assert.ok(hits.length >= 1, '下载请求经过代理');
  assert.deepEqual([...new Set(hits)], ['example.invalid:80']);
});

test('取包失败改用 npm pack；两条路都失败时报告两条原因', async t => {
  // npm view 查不到包地址 → 直接 npm pack。
  {
    const { base, bin, env } = fixture(t);
    const { calls } = fakeNpm({ base, bin, target: path.join(base, 'agent-router', 'tools', 'dsh') });
    writeFileSync(path.join(base, 'fail-view'), '');
    const collected = collect();
    const result = await deployDsh({ env, step: collected.step, importAgent: () => {}, test: async () => ({ ok: true }) });
    assert.equal(result.version, '0.2.1-rc.2');
    const pack = JSON.parse(readFileSync(calls)).find(call => call.args[0] === 'pack');
    assert.ok(pack, '要调用 npm pack');
    assert.ok(pack.args.includes('--pack-destination'));
    const fallback = collected.events.filter(e => e.step === 'download' && e.fallback);
    assert.ok(fallback.length >= 1);
    assert.ok(fallback.every(e => !('percent' in e)));
    assert.ok(collected.events.some(e => e.step === 'download' && e.percent === 100));
  }
  // 401 与下载抛错：都改用 npm pack。
  for (const fetch of [async () => fakeResponse('', { status: 401 }), async () => { throw new Error('socket hang up'); }]) {
    const { base, bin, env } = fixture(t);
    fakeNpm({ base, bin, target: path.join(base, 'agent-router', 'tools', 'dsh') });
    const collected = collect();
    const result = await deployDsh({ env, step: collected.step, importAgent: () => {}, test: async () => ({ ok: true }), fetch });
    assert.equal(result.version, '0.2.1-rc.2');
    assert.ok(collected.events.some(e => e.step === 'download' && e.fallback));
  }
  // 60 秒无字节（测试把等待缩短到 200 毫秒）：改用 npm pack；连 pack 也失败时两条原因都写出来。
  {
    const { base, bin, env } = fixture(t);
    fakeNpm({ base, bin, target: path.join(base, 'agent-router', 'tools', 'dsh') });
    writeFileSync(path.join(base, 'tarball-url'), `${tarballBase}/silent/{version}.tgz`);
    const result = await deployDsh({ env, step: () => {}, importAgent: () => {}, test: async () => ({ ok: true }), idleMs: 200 });
    assert.equal(result.version, '0.2.1-rc.2');
  }
  {
    const { base, bin, env } = fixture(t);
    fakeNpm({ base, bin, target: path.join(base, 'agent-router', 'tools', 'dsh') });
    writeFileSync(path.join(base, 'tarball-url'), `${tarballBase}/silent/{version}.tgz`);
    writeFileSync(path.join(base, 'fail-pack'), '');
    await assert.rejects(deployDsh({ env, step: () => {}, importAgent: () => {}, test: async () => ({ ok: true }), idleMs: 200 }),
      /下载安装包失败：60 秒没有收到数据；改用 npm pack 也失败：退出码 3/);
  }
  {
    const { base, bin, env } = fixture(t);
    fakeNpm({ base, bin, target: path.join(base, 'agent-router', 'tools', 'dsh') });
    writeFileSync(path.join(base, 'fail-view'), '');
    writeFileSync(path.join(base, 'fail-pack'), '');
    await assert.rejects(deployDsh({ env, step: () => {}, importAgent: () => {}, test: async () => ({ ok: true }) }),
      /查不到安装包地址：退出码 3；改用 npm pack 也失败：退出码 3/);
  }
});

test('中文与空格路径下安装成功', async t => {
  const { base, bin, env, target } = fixture(t, 'ar 用户 名-');
  const { installed } = fakeNpm({ base, bin, target });
  const result = await deployDsh({ env, step: () => {}, importAgent: () => {}, test: async () => ({ ok: true }) });
  assert.equal(result.ok, true);
  assert.equal(result.path, installed);
  assert.ok(installed.includes('用户 名'));
  assert.ok(existsSync(path.join(target, '.agent-router-dsh.json')));
  // 目录大小在中文与空格路径下也统计成功（写入失败时只写 version，没有 bytes；423 审查 R3-4）。
  const marker = JSON.parse(readFileSync(path.join(target, '.agent-router-dsh.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(marker.bytes) && marker.bytes > 0, JSON.stringify(marker));
});
