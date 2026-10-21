import { test } from 'node:test';
import assert from 'node:assert/strict';
import { killProcessTree } from '../../core/lib/process.mjs';

// 049：结束顺序的确定性测试。list / executeFile / alive 全部注入，不碰真实进程。
// 固定进程表：根 100 → 执行者 200 → 孙进程 300；可选的 late 是"初次快照之后才出现"的进程。
function fixture({ stubbornRoot = false, late = null } = {}) {
  const table = new Map([
    [100, { pid: 100, parent: 1, created: 1000, name: 'node.exe', command: '根' }],
    [200, { pid: 200, parent: 100, created: 2000, name: 'node.exe', command: '执行者' }],
    [300, { pid: 300, parent: 200, created: 3000, name: 'node.exe', command: '孙进程' }],
  ]);
  const live = new Set([100, 200, 300]);
  const calls = [];
  let lists = 0;
  const list = async () => {
    lists += 1;
    // late 只在初次快照之后的查询里出现。
    if (lists > 1 && late) table.set(late.pid, late);
    return [...table.values()];
  };
  const executeFile = async (name, args) => {
    const pids = args.flatMap((arg, index) => arg === '/PID' ? [Number(args[index + 1])] : []);
    // 记录调用发生时的存活情况，用来断言"根先退出、再结束子孙"。
    calls.push({ name, args: [...args], rootAlive: live.has(100), live: [...live] });
    for (const pid of pids) if (!(stubbornRoot && pid === 100)) live.delete(pid);
  };
  const alive = pid => live.has(pid);
  return { list, executeFile, alive, calls, live };
}

test('win32：第一次只结束根且不带 /T，根退出后结束其余子孙，补充轮结束新出现的进程', async () => {
  const f = fixture({ late: { pid: 400, parent: 200, created: 4000, name: 'node.exe', command: '晚出现的孙进程' } });
  await killProcessTree(100, { platform: 'win32', list: f.list, executeFile: f.executeFile, alive: f.alive, timeout: 5000 });

  assert.equal(f.calls[0].name, 'taskkill.exe');
  assert.deepEqual(f.calls[0].args, ['/PID', '100', '/F'], '第一次结束调用只针对根');
  assert.ok(!f.calls.some(call => call.args.includes('/T')), '任何一次结束调用都不带 /T');
  assert.deepEqual(f.calls[0].live, [100, 200, 300], '结束根时子孙还都活着');

  const descendants = f.calls.find(call => call.args.includes('200'));
  assert.ok(descendants, '有结束子孙的调用');
  assert.equal(descendants.rootAlive, false, '针对子孙的调用发生在根退出之后');
  assert.deepEqual(descendants.args, ['/PID', '200', '/PID', '300', '/F']);

  const supplement = f.calls.find(call => call.args.includes('400'));
  assert.ok(supplement, '初次快照之后才出现的子进程在补充轮被结束');
  assert.deepEqual(supplement.args, ['/PID', '400', '/F']);
  assert.deepEqual([...f.live], [], '根、执行者、孙进程和补充结束的进程都不在了');
});

test('win32：根结束不了时按时限抛错，子孙仍被尝试结束', async () => {
  const f = fixture({ stubbornRoot: true });
  await assert.rejects(
    killProcessTree(100, { platform: 'win32', list: f.list, executeFile: f.executeFile, alive: f.alive, timeout: 60 }),
    /等待进程退出超时/,
  );
  assert.deepEqual(f.calls[0].args, ['/PID', '100', '/F'], '第一次仍然只结束根');
  const descendants = f.calls.find(call => call.args.includes('200'));
  assert.ok(descendants, '根结束不了也仍尝试结束子孙');
  assert.deepEqual(descendants.args, ['/PID', '200', '/PID', '300', '/F']);
  assert.equal(f.alive(100), true, '根确实没被结束');
  assert.equal(f.alive(200), false, '子孙已经被结束');
});
