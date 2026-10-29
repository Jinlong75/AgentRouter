import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { identityAlive, pidAlive, processList, sameIdentity, terminateByIdentity } from '../../core/lib/process.mjs';

// 069【核实】：句柄方式（terminateByIdentity）在同一个进程句柄上核对创建时间并结束。
// 只在系统临时目录里起假进程（命令行带唯一的临时目录名），按创建时间核对后才结束，绝不按进程名。
const windowsOnly = process.platform === 'win32' ? false : '需要 Windows 的进程句柄';

async function fixture(t, count) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-terminate-identity-'));
  const marker = path.basename(dir);
  const children = Array.from({ length: count }, () => spawn(process.execPath, ['-e', `setTimeout(() => {}, 60000) /* ${marker} */`], { stdio: 'ignore', windowsHide: true, shell: false }));
  t.after(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  // 等假进程都出现在平台查询里，按命令行里的临时目录名核对后取得创建时间。
  const found = [];
  for (let i = 0; i < 100 && found.length < count; i++) {
    found.length = 0;
    const rows = await processList().catch(() => []);
    for (const child of children) {
      const row = rows.find(p => p.pid === child.pid && String(p.command).includes(marker));
      if (row) found.push({ pid: row.pid, created: row.created });
    }
    if (found.length < count) await delay(100);
  }
  assert.equal(found.length, count, '假进程都出现在平台查询里');
  return { children, found, marker };
}

test('句柄方式：创建时间一致才结束；不一致（PID 被复用的模拟）不动手；已退出的报 gone', { skip: windowsOnly, timeout: 60000 }, async t => {
  const { children, found } = await fixture(t, 3);
  const [a, b, c] = found;
  // a：身份一致 → killed；b：创建时间不符（模拟 PID 已被另一个进程占用）→ reused，进程继续活着；
  // 创建时间只差 1 ms 仍视为同一个（毫秒换算的舍入误差），差 2 ms 不是；c 随后验证容差。
  const results = await terminateByIdentity([a, { pid: b.pid, created: b.created + 5000 }]);
  assert.equal(results.get(a.pid), 'killed');
  assert.equal(results.get(b.pid), 'reused');
  // 结束是异步的：负载高时 300 ms 后进程可能还没从系统里消失（verify 并行跑全量时出现过），等它退出再断言，最多 10 秒。
  for (const deadline = Date.now() + 10000; pidAlive(a.pid) && Date.now() < deadline;) await delay(100);
  assert.equal(pidAlive(a.pid), false, 'a 已被结束');
  assert.equal(pidAlive(b.pid), true, 'b 没被结束（复用者不受影响）');
  const edge = await terminateByIdentity([{ pid: c.pid, created: c.created + 2 }]);
  assert.equal(edge.get(c.pid), 'reused', '差 2 ms 不是同一个进程');
  assert.equal(pidAlive(c.pid), true);
  const close = await terminateByIdentity([{ pid: c.pid, created: c.created + 1 }]);
  assert.equal(close.get(c.pid), 'killed', '差 1 ms 在容差内');
  // 已退出的进程：gone。
  await delay(300);
  // 073：PID 复用是正常现象（全量负载下 600 ms 内 a 的 PID 就可能被别的进程占用），"已退出报 gone"按调用前后的快照精确判定：
  // 快照里 a.pid 属于创建时间不同的进程 → 必须是 reused，且那个进程调用后仍存活；否则必须是 gone。
  const occupant = rows => rows.find(p => p.pid === a.pid && !sameIdentity(p, a)) ?? null;
  // 前后快照都没有占用者、结果却是 reused：调用期间有进程短暂占用了这个 PID 又退出（快照看不到）。
  // 这种情况不改产品行为，也不放宽断言，而是等占用者消失后重新取一轮（最多 15 秒）：短暂占用者很快退出，之后必须是 gone；
  // 持续存在的占用者会被快照看到，走 reused 的分支。
  let beforeRows, afterRows, occupantBefore, occupantAfter, verdict, expected;
  for (const deadline = Date.now() + 15000; ;) {
    beforeRows = await processList();
    const again = await terminateByIdentity([a]);
    afterRows = await processList();
    occupantBefore = occupant(beforeRows);
    occupantAfter = occupant(afterRows);
    verdict = again.get(a.pid);
    // 调用前后占用者都是同一个进程 → reused；前后都没有占用者 → gone；其余是调用期间发生了复用或占用者退出（时序竞争）。
    expected = occupantBefore && occupantAfter && sameIdentity(occupantBefore, occupantAfter) ? 'reused' : !occupantBefore && !occupantAfter ? 'gone' : 'changed';
    t.diagnostic(`a.pid=${a.pid} 调用前占用者=${occupantBefore ? occupantBefore.created : '无'} 调用后占用者=${occupantAfter ? occupantAfter.created : '无'} 结果=${verdict}`);
    if (!(expected === 'gone' && verdict === 'reused') || Date.now() > deadline) break;
    await delay(200);
  }
  if (expected === 'reused') {
    assert.equal(verdict, 'reused', 'a 的 PID 已被创建时间不同的进程占用 → reused');
    assert.ok(identityAlive(afterRows, occupantBefore), '复用者调用后仍存活（快照里同一个身份还在，没被结束）');
  } else if (expected === 'gone') {
    assert.equal(verdict, 'gone', 'a 已退出且 PID 没被占用 → gone');
  } else {
    // 调用期间占用者出现或消失（前后快照至少一次有占用者）：两种答案各自对应一种时序，只允许这两个。
    assert.ok(verdict === 'gone' || verdict === 'reused', `调用期间 PID 占用情况变化，结果只能是 gone 或 reused：${verdict}`);
    if (verdict === 'reused') {
      // reused 必须有依据：前后两次快照至少一次有创建时间与 a 不同的占用者。
      assert.ok(occupantBefore || occupantAfter, 'reused 时前后快照至少一次要有创建时间不同的占用者');
      // 调用后快照里仍有的占用者必须仍存活（没被结束）。
      if (occupantAfter) assert.ok(identityAlive(await processList(), occupantAfter), '调用后快照里的占用者仍存活（没被结束）');
    } else if (occupantAfter) {
      t.diagnostic(`gone 但调用后快照里有占用者 created=${occupantAfter.created}（调用期间才被占用）`);
    }
  }
  assert.ok(children.length === 3);
  // b 留给 t.after 清理（child.kill() 只结束自己启动的子进程）。
});

test('句柄方式：取得的创建时间与平台查询（CIM 毫秒）在同一个进程上相差不超过容差', { skip: windowsOnly, timeout: 60000 }, async t => {
  const { found } = await fixture(t, 4);
  // 4 个进程都能在"创建时间一致"的前提下被结束，说明两种取法的毫秒换算在这几个样本上没有差异。
  const results = await terminateByIdentity(found);
  assert.deepEqual([...results.values()], ['killed', 'killed', 'killed', 'killed']);
});
