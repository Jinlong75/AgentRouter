import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateStartWaiting, waitForTask } from '../../core/lib/wait.mjs';

test('新记录目录的空档等待迟到的 start', async t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-wait-gap-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, '.agent-runs', 'task'), { recursive: true });
  const expected = { start: { id: 'sample' } }, began = performance.now();
  const found = await locateStartWaiting(base, base, 'task', {
    locate: () => performance.now() - began >= 300 ? expected : null,
    pending: () => [],
  });
  assert.equal(found, expected);
  assert.ok(performance.now() - began >= 300);
});

test('不存在的记录立即返回 2', async t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-wait-gap-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const began = performance.now(), logs = [];
  assert.equal(await waitForTask(base, base, 'missing', { log: line => logs.push(line) }), 2);
  assert.ok(performance.now() - began < 1000);
  assert.deepEqual(logs, ['等待：在当前仓库找不到记录 missing']);
});

test('子进程退出且没有 start 时在等待上限返回', async () => {
  const began = performance.now();
  const found = await locateStartWaiting('home', 'repo', 'task', {
    locate: () => null, pending: () => [], recent: () => true, startLimit: 150,
    timeoutDeadline: performance.now() + 2000,
  });
  assert.equal(found, null);
  assert.ok(performance.now() - began >= 150 && performance.now() - began < 1000);
});

test('请求已有 resume 时返回更新后的快照', async () => {
  const old = { file: 'runs.jsonl', start: { id: 'sample', pid: 101 } };
  const resumed = { ...old, start: { ...old.start, pid: 202, resumed: true } };
  let calls = 0;
  const found = await locateStartWaiting('home', 'repo', 'task', {
    locate: () => ++calls === 1 ? old : resumed,
    pending: () => [{ id: 'sample', retry: { n: 2 } }],
    hasResume: () => true,
  });
  assert.equal(found?.start.pid, 202);
});

test('旧进程消失时发现新的存活 resume，继续等待新结果', async t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-wait-gap-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = join(base, 'runs.jsonl'), logs = [], checked = [];
  const append = row => appendFileSync(file, JSON.stringify({ v: 1, ...row }) + '\n');
  append({ event: 'start', id: 'sample', repo: base, name: 'task', pid: 101, started: 1, report: 'report.md' });
  const code = await waitForTask(base, base, 'task', {
    timeout: 2,
    log: line => logs.push(line),
    alive: async start => {
      checked.push(start.pid);
      if (start.pid === 101) {
        append({ event: 'resume', id: 'sample', pid: 202, at: 2, n: 2 });
        return false;
      }
      setTimeout(() => append({ event: 'end', id: 'sample', exit: 0 }), 10);
      return true;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(checked, [101, 202]);
  assert.ok(logs.some(line => line === '等待：task（进行中）'));
  assert.ok(!logs.some(line => line.includes('已结束')));
  assert.ok(!logs.some(line => line.includes('按中断处理')));
  assert.ok(logs.some(line => line.startsWith('exit=0 ')));
});

test('检查新进程期间写入 end 且进程已退出时返回新结果', async t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-wait-gap-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = join(base, 'runs.jsonl'), logs = [], checked = [];
  const append = row => appendFileSync(file, JSON.stringify({ v: 1, ...row }) + '\n');
  append({ event: 'start', id: 'sample', repo: base, name: 'task', pid: 101, started: 1, report: 'report.md' });
  const code = await waitForTask(base, base, 'task', {
    timeout: 2,
    log: line => logs.push(line),
    alive: async start => {
      checked.push(start.pid);
      if (start.pid === 101) append({ event: 'resume', id: 'sample', pid: 202, at: 2, n: 2 });
      else append({ event: 'end', id: 'sample', exit: 0 });
      return false;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(checked, [101, 202]);
  assert.ok(!logs.some(line => line.includes('按中断处理')));
  assert.ok(logs.some(line => line.startsWith('exit=0 ')));
});
