import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../../core/lib/limit.mjs';

// 手动决议的 Promise：任务的开始与结束完全由测试控制，不靠计时猜测。
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('mapLimit：8 个任务、上限 4，开始恰好 4 个在途；释放 1 个再开 1 个；任何时刻 ≤ 4；结果按输入顺序', async () => {
  const items = Array.from({ length: 8 }, (_, i) => i);
  const gates = items.map(() => deferred());
  const started = [];
  let inFlight = 0, maxInFlight = 0;
  const run = mapLimit(items, 4, i => {
    started.push(i); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    return gates[i].promise.finally(() => { inFlight--; });
  });
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3], '开始时恰好 4 个在途');
  assert.equal(inFlight, 4);

  gates[0].resolve('结果 0');
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4], '释放 1 个后恰好再开 1 个');
  assert.equal(inFlight, 4);

  for (let i = 1; i < 8; i++) gates[i].resolve(`结果 ${i}`);
  assert.deepEqual(await run, items.map(i => `结果 ${i}`), '结果按输入顺序，不是完成顺序');
  assert.equal(maxInFlight, 4, '任何时刻在途数不超过上限');
});

test('mapLimit：任务 reject 时不再启动新任务，等在途任务结束后抛出最先出现的错误', async () => {
  const items = [0, 1, 2, 3, 4, 5];
  const gates = items.map(() => deferred());
  const started = [];
  const run = mapLimit(items, 2, i => { started.push(i); return gates[i].promise; });
  run.catch(() => {});
  await tick();
  assert.deepEqual(started, [0, 1]);

  const boom = new Error('第 0 个失败');
  gates[0].reject(boom);
  await tick();
  assert.deepEqual(started, [0, 1], '失败后不再启动新任务；第 1 个仍在途');
  gates[1].resolve('结果 1');
  await assert.rejects(run, error => error === boom, '抛出最先出现的错误');
  assert.deepEqual(started, [0, 1], '剩余任务从未开始');
});

test('mapLimit：空数组不调用任务；上限大于数量时全部同时开始', async () => {
  let calls = 0;
  assert.deepEqual(await mapLimit([], 4, () => { calls++; }), []);
  assert.equal(calls, 0);

  const gates = [deferred(), deferred(), deferred()];
  const started = [];
  const run = mapLimit(['甲', '乙', '丙'], 4, (item, i) => { started.push(item); return gates[i].promise; });
  await tick();
  assert.deepEqual(started, ['甲', '乙', '丙'], '只开项目数个 worker');
  gates.forEach((gate, i) => gate.resolve(i));
  assert.deepEqual(await run, [0, 1, 2]);
});

test('mapLimit：并发上限必须是正整数', async () => {
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(mapLimit([1], limit, () => 1), RangeError, String(limit));
  }
});
