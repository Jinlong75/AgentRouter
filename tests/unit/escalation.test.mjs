import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effortStep, nextEffort, strongStatus } from '../../core/lib/router.mjs';
import { validateV2 } from '../../core/lib/config.mjs';
import { buildPrompt } from '../../core/lib/retry-prompt.mjs';

// Stage07c T8（147）：默认升级链里的纯函数——下一档推理强度、强执行者状态、配置校验、重试指令里的说明。
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

test('nextEffort：中间档升一档', () => {
  assert.equal(nextEffort(LEVELS, 'low'), 'medium');
  assert.equal(nextEffort(LEVELS, 'high'), 'xhigh');
  assert.equal(nextEffort(LEVELS, 'xhigh'), 'max');
  assert.equal(nextEffort(LEVELS, ' high '), 'xhigh', '首尾空格不影响');
});

test('nextEffort：最高档返回 null', () => {
  assert.equal(nextEffort(LEVELS, 'max'), null);
  assert.equal(nextEffort(['only'], 'only'), null);
});

test('nextEffort：当前值不在列表里，或为空、"默认"、auto，返回 null', () => {
  assert.equal(nextEffort(LEVELS, 'ultra'), null);
  for (const empty of [null, undefined, '', '   ', '默认', 'auto', 'AUTO', 'default']) assert.equal(nextEffort(LEVELS, empty), null, String(empty));
  // auto 在列表里也不算明确的强度（qoder 的档位列表以 auto 开头）。
  assert.equal(nextEffort(['auto', 'none', 'low', 'high'], 'auto'), null);
  assert.equal(nextEffort(['auto', 'none', 'low', 'high'], 'none'), 'low');
  // 档位不知道（预设没有 effortOptions）。
  assert.equal(nextEffort(null, 'high'), null);
  assert.equal(nextEffort([], 'high'), null);
  assert.equal(nextEffort(LEVELS, 42), null);
});

test('effortStep：跳过时给出一句中文原因，进度里写', () => {
  assert.deepEqual(effortStep(LEVELS, 'high'), { next: 'xhigh' });
  assert.match(effortStep(LEVELS, 'max').skip, /已是最高档（max）/);
  assert.match(effortStep(LEVELS, null).skip, /没有明确的推理强度/);
  assert.match(effortStep(LEVELS, 'auto').skip, /没有明确的推理强度/);
  assert.match(effortStep(null, 'high').skip, /不知道这个执行者支持哪些推理强度/);
  assert.match(effortStep(LEVELS, 'ultra').skip, /不在这个执行者支持的档位里/);
});

test('strongStatus：没设 / 不存在 / 已停用 / 可用', () => {
  const profiles = { a: { adapter: 'fake' }, off: { adapter: 'fake', enabled: false } };
  assert.deepEqual(strongStatus({ profiles }), { name: null });
  assert.deepEqual(strongStatus({ profiles, routing: { strongExecutor: null } }), { name: null });
  assert.deepEqual(strongStatus({ profiles, routing: { strongExecutor: 'a' } }), { name: 'a' });
  assert.deepEqual(strongStatus({ profiles, routing: { strongExecutor: 'ghost' } }), { name: 'ghost', why: '不存在' });
  assert.deepEqual(strongStatus({ profiles, routing: { strongExecutor: 'off' } }), { name: 'off', why: '已停用' });
});

test('config 校验：routing.strongExecutor 是执行者名或 null；指向已不存在的执行者配置仍然有效（派发时按没有处理）', () => {
  const make = routing => ({ v: 2, profiles: { a: { adapter: 'fake' } }, routing });
  validateV2(make({ strongExecutor: 'a' }));
  validateV2(make({ strongExecutor: null }));
  validateV2(make({}));
  validateV2(make({ strongExecutor: 'ghost' }));
  for (const bad of [5, true, '', '  ', ['a'], {}]) {
    assert.throws(() => validateV2(make({ strongExecutor: bad })), /routing\.strongExecutor 必须为执行者名/, JSON.stringify(bad));
  }
});

test('buildPrompt：escalation 补一句在标题下面；没有失败或不给时与以前相同', () => {
  const failure = { kind: 'agent', exit: 1, errors: [], stderrTail: '' };
  const plain = buildPrompt('原始指令', { n: 2, total: 3, failure, note: null });
  const raised = buildPrompt('原始指令', { n: 2, total: 3, failure, note: null, escalation: '这一次已把推理强度从 high 提高到 xhigh。' });
  assert.equal(buildPrompt('原始指令', { n: 2, total: 3, failure, note: null, escalation: null }), plain, '不给时逐字相同');
  const lines = raised.split('\n');
  const heading = lines.findIndex(line => line.startsWith('## 上一次尝试没有通过验收'));
  assert.ok(heading > 0);
  assert.ok(lines.slice(heading + 1, heading + 4).includes('这一次已把推理强度从 high 提高到 xhigh。'));
  assert.equal(raised.replace('这一次已把推理强度从 high 提高到 xhigh。\n\n', ''), plain, '只多了这一句');
  // 没有失败时（第 1 次）不写。
  assert.equal(buildPrompt('原始指令', { n: 1, total: 3, failure: null, note: null, escalation: '不该出现' }), '原始指令');
});
