import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { main } from '../../core/lib/cli.mjs';
import { writeResetMarker, cleanupHome, runClearCache } from '../../app/src/main/reset.mjs';

// 全部在系统临时目录里的独立公共目录上执行：不碰注册表、不碰用户真实的 %APPDATA%\agent-router。
const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'ar-reset-gui-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
async function call(argv, env, cwd) {
  const out = [];
  const code = await main(argv, { scriptPath: entry, env, cwd, out: text => out.push(text) });
  return { code, out };
}

test('ar secrets unset：隔离的测试密钥文件里删除变量，输出只有变量名不含值', async t => {
  const home = await fixture(t), file = path.join(home, 'secrets-test.json');
  await writeFile(file, JSON.stringify({ DEEPSEEK_API_KEY: 'sk-fixture-not-real', OTHER_UNUSED_KEY: 'keep' }));
  const env = { AGENT_ROUTER_HOME: home, AR_TEST_SECRETS_FILE: file };
  const result = await call(['secrets', 'unset', 'DEEPSEEK_API_KEY', '--json'], env, home);
  assert.equal(result.code, 0);
  assert.equal(result.out.length, 1);
  assert.deepEqual(JSON.parse(result.out[0]), { ok: true, name: 'DEEPSEEK_API_KEY' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { OTHER_UNUSED_KEY: 'keep' });
  assert.ok(!result.out.join('\n').includes('sk-fixture-not-real'), '输出不能出现密钥值');
  // 不存在的变量也算成功（与 Windows 用户环境变量的行为一致）。
  const again = await call(['secrets', 'unset', 'DEEPSEEK_API_KEY', '--json'], env, home);
  assert.equal(again.code, 0);
  assert.deepEqual(JSON.parse(again.out[0]), { ok: true, name: 'DEEPSEEK_API_KEY' });
  // 用法错误：--json 下返回 ok:false 与退出码 2，不写文件。
  const bad = await call(['secrets', 'unset', '--json'], env, home);
  assert.equal(bad.code, 2);
  assert.equal(JSON.parse(bad.out[0]).ok, false);
  assert.match(JSON.parse(bad.out[0]).error, /用法：ar secrets unset/);
});

test('ar secrets unset：没有隔离文件时（Linux）拒绝，不尝试改本机', { skip: process.platform === 'win32' }, async t => {
  const home = await fixture(t);
  await assert.rejects(call(['secrets', 'unset', 'SOME_KEY'], { AGENT_ROUTER_HOME: home }, home), /只有 Windows/);
});

test('runClearCache 端到端：用内置 Node（ELECTRON_RUN_AS_NODE）在子进程里清除缓存', async t => {
  const home = await fixture(t), data = path.join(home, 'monitor'), tmp = path.join(home, 'tmp');
  await mkdir(path.join(data, 'Cache'), { recursive: true });
  await writeFile(path.join(data, 'Cache', 'blob'), Buffer.alloc(32, 1));
  await writeFile(path.join(data, 'preferences.json'), '{}');
  await mkdir(path.join(home, 'workers', 'demo', 'claude', 'projects'), { recursive: true });
  await writeFile(path.join(home, 'workers', 'demo', 'claude', 'projects', 's.jsonl'), '{}');
  await mkdir(path.join(tmp, 'ar-agent-test-one'), { recursive: true });
  await writeFile(path.join(tmp, 'ar-agent-test-one', 'probe.txt'), 'probe');
  // 与安装版一样用 Electron 程序自己：ELECTRON_RUN_AS_NODE=1 时它按 Node 执行 -e 代码。
  const result = await runClearCache({ home, data, tmp }, { execPath: electron, timeoutMs: 30000 });
  assert.deepEqual(result, { bytes: 32 + 2 + 5, removed: 3, skipped: 0 });
  assert.equal(existsSync(path.join(data, 'Cache')), false);
  assert.equal(existsSync(path.join(home, 'workers', 'demo', 'claude', 'projects')), false);
  assert.equal(existsSync(path.join(tmp, 'ar-agent-test-one')), false);
  assert.equal(await readFile(path.join(data, 'preferences.json'), 'utf8'), '{}', '软件文件保留');
});

test('cleanupHome 端到端：父进程结束后删除带标记的整个公共目录', async t => {
  const home = await fixture(t);
  await mkdir(path.join(home, 'monitor', 'Cache'), { recursive: true });
  await writeFile(path.join(home, 'monitor', 'Cache', 'blob'), Buffer.alloc(1024, 1));
  await writeFile(path.join(home, 'config.json'), '{"v":2,"profiles":{}}\n');
  await writeFile(path.join(home, 'runs.jsonl'), '');
  writeResetMarker(home);
  // 用一个 300ms 后自己退出的子进程当"父进程"，确认清理进程会等它结束再删。
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore', windowsHide: true, shell: false });
  const exited = new Promise((resolve, reject) => { parent.on('error', reject); parent.on('exit', resolve); });
  const started = Date.now();
  const result = await cleanupHome({ home, parentPid: parent.pid, timeoutMs: 10000, pollMs: 20 });
  await exited;
  assert.deepEqual(result, { ok: true, home: path.resolve(home) });
  assert.ok(Date.now() - started >= 200, '应该等父进程退出后再删除');
  assert.equal(existsSync(home), false, '公共目录与其中的文件应全部删除');
});

test('cleanupHome 端到端：没有标记时拒绝删除，目录与文件保持不变', async t => {
  const home = await fixture(t), file = path.join(home, 'config.json');
  await writeFile(file, '{"v":2}\n');
  await assert.rejects(cleanupHome({ home, parentPid: 0, timeoutMs: 1000, pollMs: 20 }), /找不到重置标记/);
  assert.equal(await readFile(file, 'utf8'), '{"v":2}\n');
});
