import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { abbaOrder, abbaSequence, percentile, runSample, summarizeSamples } from '../../tools/h1-sampler.mjs';

const childScript = fileURLToPath(new URL('../../tools/h1-child.mjs', import.meta.url));

const make = (condition, runtime, aMs, bMs, cMs, dMs, extra = {}) => ({
  kind: 'sample',
  condition,
  runtime,
  spawnSyncMs: 0,
  spawnEventMs: 0,
  aMs, bMs, cMs, dMs,
  totalMs: [aMs, bMs, cMs, dMs].every(value => typeof value === 'number') ? aMs + bMs + cMs + dMs : null,
  exitCode: 0,
  timedOut: false,
  error: null,
  ...extra,
});

test('分位数用最近秩法，空集合返回 null', () => {
  assert.equal(percentile([], 90), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([4, 1, 3, 2], 50), 2);
  assert.equal(percentile([5], 95), 5);
});

test('ABBA 顺序：区组内 E N N E，下一区组起点交换，两种运行时数量相同', () => {
  assert.deepEqual(abbaOrder(2), ['electron', 'node', 'node', 'electron']);
  // 每种 3 个：第二区组取 N E 两个位置后两种运行时都够数，后面的位置跳过。
  assert.deepEqual(abbaOrder(3), ['electron', 'node', 'node', 'electron', 'node', 'electron']);

  const order = abbaOrder(6);
  assert.equal(order.length, 12);
  assert.equal(order.filter(name => name === 'electron').length, 6);
  assert.equal(order.filter(name => name === 'node').length, 6);
  assert.deepEqual(order.slice(0, 4), ['electron', 'node', 'node', 'electron']);
  assert.deepEqual(order.slice(4, 8), ['node', 'electron', 'electron', 'node']);
  assert.deepEqual(order.slice(8, 12), ['electron', 'node', 'node', 'electron']);

  const firstBlocks = [];
  for (const name of abbaSequence()) {
    firstBlocks.push(name);
    if (firstBlocks.length === 8) break;
  }
  assert.deepEqual(firstBlocks, ['electron', 'node', 'node', 'electron', 'node', 'electron', 'electron', 'node']);
});

test('汇总：按条件 × 运行时分组的极值、中位、P90、超阈值与超时计数', () => {
  const samples = [
    // 安静 × Electron：4 个正常样本 + 1 个 C 段超阈值 + 1 个超时（不参与分位数，单独计数）。
    make('quiet', 'electron', 10, 5, 1, 1),
    make('quiet', 'electron', 20, 5, 1, 1),
    make('quiet', 'electron', 30, 5, 1, 1),
    make('quiet', 'electron', 40, 5, 1, 1),
    make('quiet', 'electron', 50, 5, 1500, 1),
    make('quiet', 'electron', null, null, null, null, { timedOut: true, exitCode: null, totalMs: 4000 }),
    // 安静 × Node：一个样本同时有 A、B 两段超阈值，只算一个样本。
    make('quiet', 'node', 7, 2, 1, 1),
    make('quiet', 'node', 7, 2, 1, 1),
    make('quiet', 'node', 7, 2, 1, 1),
    make('quiet', 'node', 1500, 1500, 1, 1),
    // 负载 × Electron：与安静条件分开汇总。
    make('load', 'electron', 100, 1, 1, 1),
    make('load', 'electron', 200, 1, 1, 1),
  ];

  const groups = summarizeSamples(samples);
  assert.equal(groups.length, 3, '条件 × 运行时共三组，条件不混算');
  const find = (condition, runtime) => groups.find(group => group.condition === condition && group.runtime === runtime);

  const quietElectron = find('quiet', 'electron');
  assert.equal(quietElectron.count, 6);
  assert.equal(quietElectron.timeouts, 1);
  assert.equal(quietElectron.slow, 1);
  assert.deepEqual(quietElectron.stats.aMs, { min: 10, median: 30, p90: 50, max: 50 });
  assert.deepEqual(quietElectron.stats.dMs, { min: 1, median: 1, p90: 1, max: 1 });
  // 合计：17、27、37、47、1556；中位取中间两个的平均，P90 取第 5 个。
  assert.deepEqual(quietElectron.stats.totalMs, { min: 17, median: 37, p90: 1556, max: 1556 });

  const quietNode = find('quiet', 'node');
  assert.equal(quietNode.count, 4);
  assert.equal(quietNode.timeouts, 0);
  assert.equal(quietNode.slow, 1, '同一个样本里多段超阈值只计一次');
  assert.deepEqual(quietNode.stats.aMs, { min: 7, median: 7, p90: 1500, max: 1500 });

  const loadElectron = find('load', 'electron');
  assert.equal(loadElectron.count, 2);
  assert.deepEqual(loadElectron.stats.aMs, { min: 100, median: 150, p90: 200, max: 200 });
  assert.equal(loadElectron.slow, 0);
});

test('用当前 Node 实跑 3 个样本：各段字段齐全、非负、退出码 0', async () => {
  // 单元测试只跑独立 Node，不启动 Electron。
  const runtime = { name: 'node', command: process.execPath, args: [childScript], env: {} };
  for (let i = 0; i < 3; i += 1) {
    const sample = await runSample(runtime, { condition: 'quiet' });
    assert.equal(sample.timedOut, false);
    assert.equal(sample.exitCode, 0);
    for (const key of ['spawnSyncMs', 'spawnEventMs', 'aMs', 'bMs', 'cMs', 'dMs', 'totalMs']) {
      assert.equal(typeof sample[key], 'number', `${key} 应为数字`);
      assert.ok(Number.isFinite(sample[key]), `${key} 应为有限数`);
      assert.ok(sample[key] >= 0, `${key} = ${sample[key]} 为负`);
    }
  }
});
