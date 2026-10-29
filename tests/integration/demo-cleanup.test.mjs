import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from '../../tools/demo/index.mjs';

function sample() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-demo-cleanup-'));
  mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  mkdirSync(path.join(dir, 'busy'));
  writeFileSync(path.join(dir, 'a', 'b', 'f.txt'), 'x');
  writeFileSync(path.join(dir, 'top.txt'), 'x');
  return dir;
}

test('演示临时目录能删时全部删除', async () => {
  const dir = sample();
  assert.deepEqual(await removeTemp(dir, 2000), { ok: true, residue: [], errors: [] });
  assert.equal(existsSync(dir), false);
});

test('有目录被占用时：总时限内停下，删掉能删的，报残留与错误，之后不在后台继续删除', { skip: process.platform !== 'win32' }, async t => {
  const dir = sample(), busy = path.join(dir, 'busy');
  // Windows 不允许删除别的进程的当前目录：用它模拟"被编辑器等外部程序占用"。
  const holder = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { cwd: busy, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => { if (holder.exitCode === null) holder.kill(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  // 等占用进程真正起来（它在 busy 里启动后才打印"ready"），不用固定等待；最多等 10 秒。
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('占用进程 10 秒内没有就绪（没有输出 ready）')), 10000);
    holder.once('error', err => { clearTimeout(timer); reject(err); });
    holder.once('exit', code => { clearTimeout(timer); reject(new Error(`占用进程提前退出，退出码 ${code}`)); });
    holder.stdout.on('data', chunk => { if (String(chunk).includes('ready')) { clearTimeout(timer); resolve(); } });
  });
  const started = Date.now();
  const result = await removeTemp(dir, 1500);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(elapsed >= 1400 && elapsed < 3000, `总时限约 1.5 秒，实际 ${elapsed}ms`);
  assert.deepEqual(result.residue, [busy]);
  assert.ok(result.errors.some(e => e.includes(busy)), result.errors.join('\n'));
  assert.equal(existsSync(path.join(dir, 'a')), false, '能删的先删掉');
  assert.equal(existsSync(path.join(dir, 'top.txt')), false);
  // 时限到了就停：之后占用解除，目录不会被后台删除。
  holder.kill(); await new Promise(resolve => holder.once('exit', resolve));
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(existsSync(busy), true, '超时后没有后台继续删除');
});
