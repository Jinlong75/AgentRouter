import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../core/lib/process.mjs';

// 069：进程树按身份（PID + 创建时间）结束与核对。list / executeFile / alive 全部注入，不碰真实进程。
// 进程表：根 100 → 执行者 200 → 孙进程 300（created 递增）。
const proc = (pid, parent, created, name = 'node.exe') => ({ pid, parent, created, name, command: `进程${pid}` });
const ROOT = proc(100, 1, 1000), WORKER = proc(200, 100, 2000), GRAND = proc(300, 200, 3000);
const initial = () => [ROOT, WORKER, GRAND];
const pidsOf = args => args.flatMap((arg, index) => arg === '/PID' ? [Number(args[index + 1])] : []);
const options = (extra = {}) => ({ platform: 'win32', timeout: 3000, settleMs: 0, ...extra });

test('身份比较：同 PID、创建时间相差不超过 1 ms 才是同一个进程；创建时间不是有限数不算', () => {
  assert.equal(P.sameIdentity(proc(1, 0, 1000), proc(1, 0, 1000)), true);
  assert.equal(P.sameIdentity(proc(1, 0, 1000), proc(1, 0, 1001)), true, '毫秒换算的舍入误差');
  assert.equal(P.sameIdentity(proc(1, 0, 1000), proc(1, 0, 1002)), false, '相差 2 ms 是另一个进程');
  assert.equal(P.sameIdentity(proc(1, 0, 1000), proc(2, 0, 1000)), false, 'PID 不同');
  assert.equal(P.sameIdentity(proc(1, 0, NaN), proc(1, 0, NaN)), false);
  assert.equal(P.sameIdentity(proc(1, 0, undefined), proc(1, 0, undefined)), false);
  assert.equal(P.sameIdentity(null, proc(1, 0, 1)), false);
  assert.equal(P.identityAlive([proc(1, 0, 5), proc(2, 0, 9000)], { pid: 2, created: 9000 }), true);
  assert.equal(P.identityAlive([proc(2, 0, 9001000)], { pid: 2, created: 9000 }), false, '同 PID、创建时间不同：PID 被复用');
  assert.equal(P.identityAlive([], { pid: 2, created: 9000 }), false);
});

// ① 子孙在 taskkill 前退出、PID 被无关进程复用：不对复用者调用结束，结果"已停止"，不抛错。
test('win32：子孙在结束前已退出、PID 被无关进程复用 → 不结束复用者，不抛错', async () => {
  const reused = proc(300, 1, 9000, 'conhost.exe');
  const live = new Set([100, 200, 300]); // 300 现在是复用者，一直存活
  const calls = [];
  let lists = 0;
  const list = async () => (++lists === 1 ? initial() : [WORKER, reused]);
  const executeFile = async (name, args) => {
    calls.push({ name, pids: pidsOf(args) });
    for (const pid of pidsOf(args)) live.delete(pid);
  };
  await P.killProcessTree(100, options({ list, executeFile, alive: pid => live.has(pid) }));
  const killed = calls.flatMap(call => call.pids);
  assert.ok(!killed.includes(300), `不应对复用者 300 调用结束：${JSON.stringify(calls)}`);
  assert.deepEqual(calls.map(call => call.pids), [[100], [200]]);
  assert.equal(live.has(300), true, '复用者没被碰');
});

// ② 补充轮：父 PID 被复用之后才创建的进程不是子孙；复用之前创建的真实子孙照样结束。
test('win32：补充轮——父 PID 被复用后创建的进程不结束，复用之前创建的真实子孙照样结束', async () => {
  const reused = proc(300, 1, 9000);            // 300 被复用（原来的 300 在 3000 创建）
  const before = proc(700, 300, 3500);          // 在复用之前创建、父进程 300 已退出：真实子孙
  const after = proc(600, 300, 9500);           // 在复用之后创建、父 PID 是复用者：不是子孙
  const live = new Set([100, 200, 300, 600, 700]);
  const calls = [];
  let lists = 0;
  const list = async () => (++lists === 1 ? initial() : [WORKER, reused, before, after]);
  const executeFile = async (name, args) => {
    calls.push(pidsOf(args));
    for (const pid of pidsOf(args)) if (pid !== 300 && pid !== 600) live.delete(pid);
  };
  await P.killProcessTree(100, options({ list, executeFile, alive: pid => live.has(pid) }));
  assert.deepEqual(calls, [[100], [200], [700]], '根、执行者、复用之前创建的 700；不碰 300（复用者）与 600');
  assert.equal(live.has(600), true);
  assert.equal(live.has(300), true);
});

test('win32：补充轮——父进程身份仍在时新子进程照常结束；父 PID 已经没有这个进程时也结束', async () => {
  const underWorker = proc(400, 200, 4000);     // 父进程 200 身份仍在
  const orphan = proc(500, 300, 3600);          // 父 PID 300 已不在快照里
  const live = new Set([100, 200, 400, 500]); // 300 在初次快照之后已经退出
  const calls = [];
  let lists = 0;
  const list = async () => (++lists === 1 ? initial() : [WORKER, underWorker, orphan]);
  const executeFile = async (name, args) => {
    calls.push(pidsOf(args));
    for (const pid of pidsOf(args)) live.delete(pid);
  };
  await P.killProcessTree(100, options({ list, executeFile, alive: pid => live.has(pid) }));
  assert.deepEqual(calls, [[100], [200], [400, 500]], '300 在快照里已不在，不再对它调用结束；400、500 在补充轮结束');
});

// ③ 结束后：pidAlive 为真但身份不在 → 不算存活；身份仍在 → 照常"没能停下"。
test('win32：结束后 pidAlive 为真但身份不在（根的 PID 被复用）→ 按已退出处理，不等满时限', async () => {
  const reusedRoot = proc(100, 1, 8000, 'conhost.exe');
  const live = new Set([100, 200, 300]);
  let lists = 0;
  const list = async () => (++lists === 1 ? initial() : [reusedRoot]);
  const executeFile = async (name, args) => { for (const pid of pidsOf(args)) if (pid !== 100) live.delete(pid); }; // 100 现在是复用者，不会被"结束"
  const started = Date.now();
  await P.killProcessTree(100, options({ timeout: 5000, list, executeFile, alive: pid => live.has(pid) }));
  assert.ok(Date.now() - started < 2500, `根的 PID 被复用不应等满时限（用时 ${Date.now() - started}ms）`);
});

test('win32：结束后 pidAlive 为真且身份仍在 → 仍按"没能停下"（超时）抛错', async () => {
  const live = new Set([100, 200, 300]);
  const list = async () => initial();
  const executeFile = async (name, args) => { for (const pid of pidsOf(args)) if (pid !== 300) live.delete(pid); }; // 300 结束不了
  await assert.rejects(
    P.killProcessTree(100, options({ timeout: 300, list, executeFile, alive: pid => live.has(pid) })),
    /等待进程退出超时/,
  );
  assert.equal(live.has(300), true);
});

test('win32：taskkill 对已退出的子孙报"没有找到进程"，按身份核对后已不在 → 不算失败', async () => {
  const live = new Set([100, 200, 300]);
  const list = async () => initial(); // 快照取到时 300 还在，随后退出
  const executeFile = async (name, args) => {
    const pids = pidsOf(args);
    for (const pid of pids) live.delete(pid);
    if (pids.includes(300)) throw Error('错误：没有找到进程 "300"。');
  };
  await P.killProcessTree(100, options({ list, executeFile, alive: pid => live.has(pid) }));
});

// 句柄方式（terminate）：核对与结束在同一个进程句柄上，结果由注入的 terminate 给出。
test('win32 句柄方式：reused / gone 的进程没被结束也不算失败；killed 的照常；不再额外取快照核对', async () => {
  const live = new Set([100, 200, 300]);
  const calls = [];
  let lists = 0;
  const list = async () => (++lists === 1 ? initial() : []);
  const terminate = async targets => {
    calls.push(targets.map(t => `${t.pid}:${t.created}`));
    const results = new Map();
    for (const t of targets) {
      if (t.pid === 200) results.set(200, 'reused');   // PID 被复用：没有结束，复用者继续活着
      else if (t.pid === 300) { results.set(300, 'gone'); live.delete(300); }
      else { results.set(t.pid, 'killed'); live.delete(t.pid); }
    }
    return results;
  };
  // 200 是复用者：pidAlive 为真，但身份不在快照里（list 之后返回空）。
  await P.killProcessTree(100, options({ list, terminate, alive: pid => live.has(pid) }));
  assert.deepEqual(calls, [['100:1000'], ['200:2000', '300:3000']], '根先结束，再一次结束其余子孙；带上各自的创建时间');
  assert.equal(live.has(200), true, '复用者没被碰');
});

test('win32 句柄方式：结束失败（denied）→ 抛出该进程仍存活时的错误；整个调用失败 → 退回 taskkill 并先核对身份', async () => {
  // 句柄方式对 300 返回 denied，300 又确实结束不了 → 超时抛错，错误信息里带原因。
  const live = new Set([100, 200, 300]);
  const terminate = async targets => new Map(targets.map(t => {
    if (t.pid === 300) return [300, 'denied'];
    live.delete(t.pid);
    return [t.pid, 'killed'];
  }));
  await assert.rejects(
    P.killProcessTree(100, options({ timeout: 300, list: async () => initial(), terminate, alive: pid => live.has(pid) })),
    /结束进程 300 失败（denied）/,
  );
  // 句柄方式整个调用失败（例如 PowerShell 编译被拦）：退回 taskkill，先用新快照核对身份——复用者 300 不被结束。
  const live2 = new Set([100, 200, 300]);
  const calls = [];
  let lists = 0;
  const reused = proc(300, 1, 9000);
  const list = async () => (++lists === 1 ? initial() : [WORKER, reused]);
  const executeFile = async (name, args) => { calls.push(pidsOf(args)); for (const pid of pidsOf(args)) live2.delete(pid); };
  const terminate2 = async () => { throw Error('PowerShell 编译被拦'); };
  await P.killProcessTree(100, options({ list, executeFile, terminate: terminate2, alive: pid => live2.has(pid) }));
  assert.deepEqual(calls, [[100], [200]], '退回 taskkill 后同样不对复用者 300 动手');
});

test('handleKillScript：只接受整数 PID 与创建时间，其他内容不会进入脚本', () => {
  assert.match(P.handleKillScript([{ pid: 12, created: 1792660000000 }]), /@\{p=12;c=1792660000000\}/);
  for (const bad of [{ pid: '1; calc', created: 1 }, { pid: 1, created: '2); calc' }, { pid: 0, created: 1 }, { pid: 1.5, created: 1 }, { pid: 1, created: NaN }, null]) {
    assert.throws(() => P.handleKillScript([bad]), /无效的目标进程/);
  }
});

// ④ 身份查询失败：不能当成已退出。
test('win32：结束后的身份查询失败 → 不当成已退出（仍存活的进程让结果失败）', async () => {
  const live = new Set([100, 200, 300]);
  const calls = [];
  let lists = 0;
  const list = async () => {
    if (++lists === 1) return initial();
    throw Error('PowerShell 查询失败');
  };
  const executeFile = async (name, args) => {
    calls.push(pidsOf(args));
    for (const pid of pidsOf(args)) live.delete(pid);
  };
  await assert.rejects(
    P.killProcessTree(100, options({ timeout: 400, list, executeFile, alive: pid => live.has(pid) })),
    /PowerShell 查询失败/,
  );
  assert.deepEqual(calls, [[100]], '无法核对身份就不对 PID 动手：只结束了根');
  assert.equal(live.has(200) && live.has(300), true, '无法确认的进程按仍存活处理');
});

test('win32：根在结束后身份无法确认（查询失败）→ 按仍存活处理，直到时限抛错', async () => {
  const live = new Set([100]);
  let lists = 0;
  const list = async () => {
    if (++lists === 1) return [ROOT];
    throw Error('查询超时');
  };
  const executeFile = async () => {}; // 根结束不了
  await assert.rejects(
    P.killProcessTree(100, options({ timeout: 300, list, executeFile, alive: pid => live.has(pid) })),
    /等待进程退出超时|查询超时/,
  );
});
