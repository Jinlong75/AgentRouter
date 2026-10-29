import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishTempRoot, findLeftoverProcesses, runVerify, scanTempLeftovers } from '../../tools/verify-tests.mjs';
import { pidAlive } from '../../core/lib/process.mjs';

// 186（D121）：verify 的专用临时目录与遗留检查。全部用测试自己的临时目录，样例测试文件写在里面。

const removeDir = dir => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

test('scanTempLeftovers：按测试文件列出子目录里还剩的东西，空子目录不算，目录外的东西单列', t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-leftover-scan-'));
  t.after(() => removeDir(root));
  mkdirSync(join(root, 'clean.test.mjs'));
  mkdirSync(join(root, 'dirty.test.mjs', 'ar-foo-1'), { recursive: true });
  writeFileSync(join(root, 'dirty.test.mjs', 'x.txt'), 'x');
  mkdirSync(join(root, 'stray-dir'));
  const found = scanTempLeftovers(root);
  const dirty = found.find(item => item.file === 'dirty.test.mjs');
  assert.deepEqual([...dirty.entries].sort(), ['ar-foo-1', 'x.txt']);
  assert.ok(!found.some(item => item.file === 'clean.test.mjs'), '空的子目录不算遗留');
  assert.deepEqual(found.find(item => item.file === null).entries, ['stray-dir']);
  assert.deepEqual(scanTempLeftovers(join(root, '不存在')), []);
});

test('findLeftoverProcesses：只认命令行里带专用目录路径的进程，并指出它在哪个测试文件的子目录', async () => {
  const root = join(tmpdir(), 'ar-leftover-fake-root');
  const rows = [
    { pid: 11, parent: 1, name: 'node.exe', command: `node ${join(root, 'a.test.mjs', 'x', 'ar.mjs')} --run-request r.json` },
    { pid: 12, parent: 1, name: 'node.exe', command: 'node 别的任务的进程.mjs' },
    { pid: process.pid, parent: 1, name: 'node.exe', command: `node ${root}\\self` },
  ];
  const found = await findLeftoverProcesses(root, async () => rows);
  assert.deepEqual(found, [{ pid: 11, name: 'node.exe', file: 'a.test.mjs' }]);
  assert.equal(await findLeftoverProcesses(root, async () => { throw new Error('查询失败'); }), null);
});

test('finishTempRoot：有遗留时返回 false 并打印清单、结束遗留进程，专用目录最后整个删掉；干净时返回 true', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-leftover-finish-'));
  t.after(() => removeDir(root));
  mkdirSync(join(root, 'dirty.test.mjs', 'ar-left'), { recursive: true });
  const printed = [], killed = [];
  const list = async () => [{ pid: 4321, parent: 1, name: 'node.exe', command: `node ${join(root, 'dirty.test.mjs', 'ar.mjs')}` }];
  const ok = await finishTempRoot(root, { print: line => printed.push(line), printError: line => printed.push(line), list, kill: pid => killed.push(pid) });
  assert.equal(ok, false);
  const text = printed.join('\n');
  assert.match(text, /dirty\.test\.mjs：1 项：ar-left/);
  assert.match(text, /dirty\.test\.mjs：pid 4321 node\.exe/);
  assert.deepEqual(killed, [4321]);
  assert.ok(!existsSync(root), '专用目录整个删掉');

  const clean = mkdtempSync(join(tmpdir(), 'ar-leftover-finish-'));
  t.after(() => removeDir(clean));
  mkdirSync(join(clean, 'ok.test.mjs'));
  const lines = [];
  assert.equal(await finishTempRoot(clean, { print: line => lines.push(line), printError: line => lines.push(line), list: async () => [] }), true);
  assert.match(lines.join('\n'), /没有留下/);
  assert.ok(!existsSync(clean));
});

// 嵌套跑一遍 runVerify：样例测试文件按要求留下 / 不留东西，看退出码与输出。
async function nested(t, sampleBody, extraEnv = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ar-leftover-run-'));
  t.after(() => removeDir(base));
  const sample = join(base, 'sample.test.mjs');
  writeFileSync(sample, `import { test } from 'node:test'; import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os'; import { spawn } from 'node:child_process';\n${sampleBody}\n`, 'utf8');
  const env = { ...process.env, AR_VERIFY_LOG_DIR: join(base, '日志'), ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const printed = [];
  const code = await runVerify({ argv: [sample], env, write: () => {}, print: line => printed.push(line), printError: line => printed.push(line) });
  return { code, text: printed.join('\n'), base };
}

test('runVerify：测试用完自己的临时目录就通过；样例里的 tmpdir() 已经是专用目录', async t => {
  const { code, text } = await nested(t, "test('清理', () => { const dir = mkdtempSync(join(tmpdir(), 'ar-sample-')); rmSync(dir, { recursive: true, force: true }); });");
  assert.equal(code, 0, text);
  assert.match(text, /verify 遗留检查：测试没有留下临时目录和进程/);
});

test('runVerify：测试留下临时目录就让 verify 失败，并写出是哪个测试文件留下的哪个目录', async t => {
  const { code, text } = await nested(t, "test('不清理', () => { mkdtempSync(join(tmpdir(), 'ar-sample-left-')); });");
  assert.equal(code, 1, text);
  assert.match(text, /verify 遗留检查：测试结束后临时目录里还剩 1 项/);
  assert.match(text, /sample\.test\.mjs：1 项：ar-sample-left-/);
});

test('runVerify：测试留下还在运行的进程就让 verify 失败、列出并结束它', async t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-leftover-pid-'));
  t.after(() => removeDir(base));
  const pidFile = join(base, 'pid.txt');
  const { code, text } = await nested(t, `test('留进程', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', tmpdir()], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  writeFileSync(process.env.AR_LEFTOVER_PID_FILE, String(child.pid));
});`, { AR_LEFTOVER_PID_FILE: pidFile });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(pid); } catch { /* 已经结束了。 */ } });
  assert.equal(code, 1, text);
  assert.match(text, /还有 1 个进程在运行/);
  assert.match(text, new RegExp(`sample\\.test\\.mjs：pid ${pid} `));
  for (let i = 0; i < 50 && pidAlive(pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(pidAlive(pid), false, '遗留进程被结束');
});
