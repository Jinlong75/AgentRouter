import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// 多个真实进程抢同一组任务名额：任意时刻最多 limit 个持有者；持有者被杀后它的名额被回收。
// 子进程只由本测试启动，也只结束它们自己；公共目录是系统临时目录里的隔离目录。
const slotsUrl = pathToFileURL(fileURLToPath(new URL('../../core/lib/slots.mjs', import.meta.url))).href;

// 子进程：抢名额（limit 2），拿到后写一行 acq，等放行文件出现后写 rel 再释放。
// rel 写在释放之前，日志里的先后顺序因此不会比真实占用更宽松。
const childSource = `import { appendFileSync, existsSync } from 'node:fs';
const [slotsUrl, home, log, hold, id] = process.argv.slice(1);
const { acquireSlot } = await import(slotsUrl);
const note = text => appendFileSync(log, text + '\\n');
const release = await acquireSlot({ home, kind: 'task', id, limit: 2, intervalMs: 100, onWait: () => note('wait ' + id) });
note('acq ' + id);
while (!existsSync(hold)) await new Promise(resolve => setTimeout(resolve, 25));
note('rel ' + id);
release();
`;

async function until(fn, label, timeout = 60000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

test('三个进程抢两个任务名额：任意时刻最多 2 个持有；杀掉一个持有者后名额被回收', async t => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-slots-it-'));
  const home = path.join(base, 'home');
  const log = path.join(base, 'slots.log');
  const hold = path.join(base, 'release.flag');
  writeFileSync(log, '');
  const children = new Map();
  t.after(() => {
    // 只结束本测试自己启动的子进程。
    for (const child of children.values()) if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const has = text => lines().includes(text);
  const slotNames = () => (existsSync(path.join(home, 'slots')) ? readdirSync(path.join(home, 'slots')).sort() : []);
  const start = id => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, slotsUrl, home, log, hold, id], { stdio: 'ignore', windowsHide: true, shell: false });
    children.set(id, child);
    child.on('error', () => {});
    return child;
  };

  start('c1');
  start('c2');
  await until(() => has('acq c1') && has('acq c2'), 'c1、c2 各拿到一个名额');
  assert.deepEqual(slotNames(), ['slot-1.json', 'slot-2.json']);
  start('c3');
  await until(() => has('wait c3'), 'c3 开始排队');
  await delay(500);   // 排队的进程多试几轮，仍然拿不到
  assert.equal(has('acq c3'), false, '名额满了，c3 拿不到');

  // 杀掉 c1（本测试自己启动的子进程）：它的名额文件留在原处，c3 按孤立回收后拿到。
  const killed = children.get('c1');
  const exited = new Promise(resolve => killed.once('exit', resolve));
  killed.kill();
  await exited;
  await until(() => has('acq c3'), 'c3 回收 c1 的名额后拿到');
  const owners = slotNames().map(name => JSON.parse(readFileSync(path.join(home, 'slots', name), 'utf8')).id).sort();
  assert.deepEqual(owners, ['c2', 'c3'], '名额现在由 c2、c3 持有，没有 c1 的残留');
  assert.equal(slotNames().length, 2, '没有 .stale- 残留');

  writeFileSync(hold, 'go');
  await until(() => has('rel c2') && has('rel c3'), 'c2、c3 释放');
  await Promise.all(['c2', 'c3'].map(id => until(() => children.get(id).exitCode !== null, `${id} 退出`)));
  await until(() => slotNames().length === 0, '名额文件全部删除');

  // 按日志顺序重放：任意时刻持有者不超过 2。c1 被杀时来不及写 rel，c3 拿到名额时它早已不在，重放时先把它去掉。
  const holders = new Set();
  let peak = 0;
  for (const line of lines()) {
    const [kind, id] = line.split(' ');
    if (kind === 'acq') {
      if (id === 'c3') holders.delete('c1');
      holders.add(id);
      peak = Math.max(peak, holders.size);
    } else if (kind === 'rel') holders.delete(id);
  }
  assert.ok(peak <= 2, `最多同时 ${peak} 个持有者`);
  assert.equal(lines().filter(line => line.startsWith('acq ')).length, 3);
});
