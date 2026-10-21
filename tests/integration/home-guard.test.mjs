import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// 047：公共目录保护。子进程跑真实入口，公共目录与"用户目录"都指向系统临时目录下新建的文件夹，
// 不碰真实用户目录与真实磁盘根（见 docs/roles/worker.md 的隔离规则）。
const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const reasonText = '公共目录不能设为用户目录或磁盘根目录';
const commands = [['dispatch', '隔离任务'], ['wait'], ['agents', 'list'], ['projects', 'list']];

function fixture(t) {
  const base = fs.mkdtempSync(join(tmpdir(), 'ar-home-guard-'));
  const fakeUser = join(base, '假用户'), home = join(base, '公共目录');
  fs.mkdirSync(fakeUser); fs.mkdirSync(home);
  // 不继承终端里可能设着的公共目录变量（Windows 上不区分大小写）。
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (lower === 'agent_router_home' || lower === 'codex_dispatch_home') delete env[key];
  }
  // USERPROFILE / HOME / os.homedir() 都指向这个假用户目录；AR_DRY_RUN 保证即使保护失效也不会真派发。
  Object.assign(env, { USERPROFILE: fakeUser, HOME: fakeUser, AR_DRY_RUN: '1' });
  t.after(() => {
    assert.equal(dirname(base), resolve(tmpdir()));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function launch(args, extraEnv = {}) {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: base, env: { ...env, ...extraEnv }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    return new Promise((ok, fail) => {
      child.on('error', fail);
      child.on('close', code => ok({ code, stdout, stderr }));
    });
  }
  return { base, fakeUser, home, launch };
}

test('显式公共目录等于用户目录：四个子命令退出 2，原因打到标准错误，不写任何文件', { timeout: 60000 }, async t => {
  const f = fixture(t);
  for (const args of commands) {
    const result = await f.launch(args, { AGENT_ROUTER_HOME: f.fakeUser });
    assert.equal(result.code, 2, `${args.join(' ')}：${result.stderr}`);
    assert.match(result.stderr, new RegExp(reasonText));
    assert.ok(result.stderr.includes('假用户'), `原因里应带路径：${result.stderr}`);
    assert.equal(result.stdout, '', `${args.join(' ')} 不应有标准输出`);
  }
  // 假用户目录里不能出现 runs.jsonl、config.json、projects.json、managed\ 等任何东西。
  assert.deepEqual(fs.readdirSync(f.fakeUser), []);
});

test('--json 时标准输出只有 JSON，code 为 UNSAFE_HOME', { timeout: 60000 }, async t => {
  const f = fixture(t);
  for (const args of commands) {
    const result = await f.launch([...args, '--json'], { AGENT_ROUTER_HOME: f.fakeUser });
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.stderr, '', `${args.join(' ')} 的 JSON 模式不应写标准错误`);
    const value = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(value).sort(), ['code', 'error', 'ok']);
    assert.equal(value.ok, false);
    assert.equal(value.code, 'UNSAFE_HOME');
    assert.match(value.error, new RegExp(reasonText));
  }
  assert.deepEqual(fs.readdirSync(f.fakeUser), []);
});

test('旧名 CODEX_DISPATCH_HOME 同样被拒绝', { timeout: 60000 }, async t => {
  const f = fixture(t);
  const result = await f.launch(['agents', 'list', '--json'], { CODEX_DISPATCH_HOME: f.fakeUser });
  assert.equal(result.code, 2, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, false);
  assert.equal(value.code, 'UNSAFE_HOME');
  assert.deepEqual(fs.readdirSync(f.fakeUser), []);
});

test('正常的临时公共目录照常工作', { timeout: 60000 }, async t => {
  const f = fixture(t);
  for (const args of [['agents', 'list'], ['projects', 'list']]) {
    const result = await f.launch([...args, '--json'], { AGENT_ROUTER_HOME: f.home });
    assert.equal(result.code, 0, `${args.join(' ')}：${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
  assert.deepEqual(fs.readdirSync(f.fakeUser), []);
});
