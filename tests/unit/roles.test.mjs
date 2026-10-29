import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { familyOf, familiesOf, leadOf, pickReviewer, rolesOf, LEAD_FAMILY } from '../../core/lib/roles.mjs';
import { validateV2 } from '../../core/lib/config.mjs';

test('familyOf：每个前缀归到对应家族，不分大小写；其余是 null', () => {
  const table = {
    'deepseek-v4-flash': 'deepseek', 'DeepSeek-Chat': 'deepseek', 'qwen3-coder': 'qwen', 'glm-5': 'glm', 'kimi-k3': 'kimi',
    'claude-sonnet-5-5': 'claude', 'opus': 'claude', 'Sonnet': 'claude', 'haiku': 'claude', 'fable-5': 'claude',
    'gpt-5': 'gpt', 'o1-mini': 'gpt', 'o3': 'gpt', 'o4-mini': 'gpt', 'codex-mini': 'gpt',
    'mimo-v2': 'mimo', 'MiniMax-M2': 'minimax',
  };
  for (const [model, family] of Object.entries(table)) assert.equal(familyOf(model), family, model);
  for (const model of ['llama-4', 'Auto', '', null, undefined, 5]) assert.equal(familyOf(model), null, String(model));
});

test('familiesOf：指定模型只看这一个；Auto 取声明并集；都没有按适配器 / 接口地址；猜不出是未知', () => {
  assert.deepEqual(familiesOf({ adapter: 'claude-code', model: 'deepseek-v4-flash', modelFamilies: ['qwen'] }), { families: ['deepseek'], unknown: false, source: 'model' });
  assert.deepEqual(familiesOf({ adapter: 'claude-code', model: 'Auto', modelFamilies: ['deepseek', 'Qwen', 'qwen'] }), { families: ['deepseek', 'qwen'], unknown: false, source: 'declared' });
  assert.deepEqual(familiesOf({ adapter: 'generic', modelFamilies: ['glm'] }, { model: 'fast' }), { families: ['glm'], unknown: false, source: 'declared' });
  assert.deepEqual(familiesOf({ adapter: 'claude-code', modelFamilies: ['glm'], model: 'Auto' }, { model: 'kimi-k3' }), { families: ['kimi'], unknown: false, source: 'model' }, '调用方给的模型优先');
  assert.deepEqual(familiesOf({ adapter: 'codex' }), { families: ['gpt'], unknown: false, source: 'adapter' });
  assert.deepEqual(familiesOf({ adapter: 'claude-code' }), { families: ['claude'], unknown: false, source: 'adapter' });
  assert.deepEqual(familiesOf({ adapter: 'claude-code', env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } }), { families: ['deepseek'], unknown: false, source: 'host' });
  assert.deepEqual(familiesOf({ adapter: 'claude-code', env: { ANTHROPIC_BASE_URL: 'https://token-plan.xiaomimimo.com/anthropic' } }), { families: ['mimo'], unknown: false, source: 'host' });
  assert.deepEqual(familiesOf({ adapter: 'claude-code', env: { ANTHROPIC_BASE_URL: 'https://example.test/v1' } }), { families: [], unknown: true, source: 'unknown' });
  assert.deepEqual(familiesOf({ adapter: 'claude-code', model: 'llama-4' }), { families: [], unknown: true, source: 'unknown' }, '指定了认不出的模型就是未知');
  assert.deepEqual(familiesOf({ adapter: 'generic' }), { families: [], unknown: true, source: 'unknown' });
  assert.deepEqual(familiesOf({ adapter: 'claude-code', model: 'Auto', env: { ANTHROPIC_BASE_URL: 'https://example.test' } }), { families: [], unknown: true, source: 'unknown' });
});

test('rolesOf：没写 roles 是执行者与审查者（默认），写了按写的；主导要显式设置', () => {
  assert.deepEqual(rolesOf({}), { executor: true, reviewer: true, lead: false, roles: ['executor', 'reviewer'], source: 'default' });
  assert.deepEqual(rolesOf({ roles: ['reviewer'] }), { executor: false, reviewer: true, lead: false, roles: ['reviewer'], source: 'set' });
  assert.deepEqual(rolesOf({ roles: ['lead', 'executor'] }), { executor: true, reviewer: false, lead: true, roles: ['executor', 'lead'], source: 'set' });
});

test('config 校验：roles / modelFamilies / 三个审查开关不合法给中文原因', () => {
  const make = extra => ({ v: 2, profiles: { a: { adapter: 'fake', ...extra } } });
  validateV2(make({ roles: ['executor'], modelFamilies: ['deepseek'] }));
  validateV2(make({ roles: ['lead'] }));
  validateV2(make({ roles: ['lead', 'executor', 'reviewer'] }));
  validateV2({ ...make({}), routing: { reviewer: { profiles: [], mustDiffer: true, differFamily: false, differFromLead: false } } });
  for (const bad of [[], 'executor', ['boss'], ['executor', 'executor'], ['lead', 'lead']]) assert.throws(() => validateV2(make({ roles: bad })), /profiles\.a\.roles 必须是 executor、reviewer、lead/);
  for (const bad of ['qwen', [''], [5]]) assert.throws(() => validateV2(make({ modelFamilies: bad })), /modelFamilies 必须为非空字符串数组/);
  assert.throws(() => validateV2({ ...make({}), routing: { reviewer: { profiles: [], differFamily: 'no' } } }), /differFamily 必须为布尔值/);
  assert.throws(() => validateV2({ ...make({}), routing: { reviewer: { profiles: [], differFromLead: 'no' } } }), /differFromLead 必须为布尔值/);
});

const cfg = (profiles, reviewer = {}) => ({
  v: 2, profiles: Object.fromEntries(Object.entries(profiles).map(([name, p]) => [name, { adapter: 'claude-code', ...p }])),
  routing: { rules: [], fallback: null, reviewer: { profiles: Object.keys(profiles).filter(n => n !== 'worker'), mustDiffer: true, ...reviewer } },
});

test('pickReviewer：同家族跳过（DeepSeek 执行者遇到 Qoder 用 DeepSeek-Flash）', () => {
  const config = cfg({ worker: { label: 'DeepSeek', model: 'deepseek-v4-flash' }, qoder: { model: 'DeepSeek-Flash', modelFamilies: ['deepseek'] }, glm: { model: 'glm-5' } });
  const r = pickReviewer({ config, executor: 'worker' });
  assert.equal(r.ok, true);
  assert.equal(r.profile, 'glm');
  assert.equal(r.reasons.length, 1);
  assert.equal(r.reasons[0].profile, 'qoder');
  assert.match(r.reasons[0].why, /DeepSeek 执行者与 qoder（DeepSeek-Flash，家族 deepseek）同家族/);
});

test('pickReviewer：Auto 的声明并集含执行者家族时跳过，原因里写声明范围', () => {
  const config = cfg({ worker: { label: 'DeepSeek', model: 'deepseek-v4-flash' }, 'qoder-cn': { model: 'Auto', modelFamilies: ['qwen', 'deepseek'] }, kimi: { model: 'kimi-k3' } });
  const r = pickReviewer({ config, executor: 'worker' });
  assert.equal(r.profile, 'kimi');
  assert.match(r.reasons[0].why, /DeepSeek 执行者与 qoder-cn（Auto，声明范围含 qwen、deepseek）同家族/);
});

test('pickReviewer：候选家族未知跳过并提示补声明；执行者家族未知时全部跳过', () => {
  const config = cfg({ worker: { model: 'deepseek-v4-flash' }, mystery: { model: 'Auto', env: { ANTHROPIC_BASE_URL: 'https://example.test' } }, kimi: { model: 'kimi-k3' } });
  const r = pickReviewer({ config, executor: 'worker' });
  assert.equal(r.profile, 'kimi');
  assert.match(r.reasons[0].why, /家族未知：请在编辑里补"可能用到的模型范围"或手动指定审查者/);
  const unknownExec = pickReviewer({ config: cfg({ worker: { model: 'llama-4' }, kimi: { model: 'kimi-k3' } }), executor: 'worker' });
  assert.equal(unknownExec.ok, false);
  assert.match(unknownExec.reasons[0].why, /执行者的家族未知/);
});

test('pickReviewer：differFromLead 时跳过 claude，关掉后可以选', () => {
  const profiles = { worker: { model: 'deepseek-v4-flash' }, lead: { model: 'claude-sonnet-5-5' }, kimi: { model: 'kimi-k3' } };
  const on = pickReviewer({ config: cfg(profiles), executor: 'worker' });
  assert.equal(on.profile, 'kimi');
  assert.equal(on.reasons[0].why, `与主导同家族（${LEAD_FAMILY}）`);
  const off = pickReviewer({ config: cfg(profiles, { differFromLead: false }), executor: 'worker' });
  assert.equal(off.profile, 'lead');
});

test('leadOf：没设主导按 Claude Code（default）；设了取启用且可担任 lead 的家族并集；家族未知时标出来', () => {
  assert.deepEqual(leadOf(cfg({ worker: {} })), { profiles: [], families: [LEAD_FAMILY], unknown: false, source: 'default' });
  // 可担任 lead 但已停用的不算。
  assert.deepEqual(leadOf(cfg({ worker: {}, off: { roles: ['lead'], model: 'glm-5', enabled: false } })).source, 'default');
  const one = cfg({ worker: {}, boss: { roles: ['lead'], model: 'deepseek-v4-flash' } });
  assert.deepEqual(leadOf(one), { profiles: ['boss'], families: ['deepseek'], unknown: false, source: 'set' });
  const two = cfg({ worker: {}, a: { roles: ['lead'], model: 'claude-sonnet-5-5' }, b: { roles: ['lead'], model: 'glm-5' } });
  assert.deepEqual(leadOf(two), { profiles: ['a', 'b'], families: ['claude', 'glm'], unknown: false, source: 'set' });
  const unknown = cfg({ worker: {}, a: { roles: ['lead'], model: 'claude-sonnet-5-5' }, b: { roles: ['lead'], model: 'llama-4' } });
  assert.deepEqual(leadOf(unknown), { profiles: ['a', 'b'], families: ['claude'], unknown: true, source: 'set' });
});

test('pickReviewer：主导设成 deepseek 家族的 Agent 后跳过 deepseek 家族的审查者，不再跳过 claude 家族的', () => {
  const profiles = {
    worker: { model: 'kimi-k3' }, lead: { roles: ['lead'], model: 'deepseek-v4-flash' },
    ds: { model: 'deepseek-v4-flash' }, claude: { model: 'claude-sonnet-5-5' },
  };
  const config = cfg(profiles, { profiles: ['ds', 'claude'] });
  const r = pickReviewer({ config, executor: 'worker' });
  assert.equal(r.profile, 'claude');
  assert.deepEqual(r.reasons.map(item => item.why), ['与主导同家族（deepseek）']);
  // 同一个执行者，没设主导时按 Claude Code 跳过 claude 家族的审查者。
  const fallback = cfg({ ...profiles, lead: { model: 'deepseek-v4-flash' } }, { profiles: ['claude', 'ds'] });
  const r2 = pickReviewer({ config: fallback, executor: 'worker' });
  assert.equal(r2.profile, 'ds');
  assert.deepEqual(r2.reasons.map(item => item.why), ['与主导同家族（claude）']);
});

test('pickReviewer：两个主导的家族取并集', () => {
  const profiles = {
    worker: { model: 'kimi-k3' },
    l1: { roles: ['lead'], model: 'deepseek-v4-flash' }, l2: { roles: ['lead'], model: 'claude-sonnet-5-5' },
    ds: { model: 'deepseek-v4-flash' }, claude: { model: 'claude-sonnet-5-5' }, glm: { model: 'glm-5' },
  };
  const config = cfg(profiles, { profiles: ['ds', 'claude', 'glm'] });
  const r = pickReviewer({ config, executor: 'worker' });
  assert.equal(r.profile, 'glm');
  assert.deepEqual(r.reasons.map(item => item.why), ['与主导同家族（deepseek）', '与主导同家族（claude）']);
});

test('pickReviewer：主导家族未知时 differFromLead 开着跳过并写原因，关掉后可以选', () => {
  const profiles = { worker: { model: 'kimi-k3' }, boss: { roles: ['lead'], model: 'llama-4' }, claude: { model: 'claude-sonnet-5-5' } };
  const on = pickReviewer({ config: cfg(profiles, { profiles: ['claude'] }), executor: 'worker' });
  assert.equal(on.ok, false);
  assert.match(on.reasons[0].why, /^主导的家族未知/);
  const off = pickReviewer({ config: cfg(profiles, { profiles: ['claude'], differFromLead: false }), executor: 'worker' });
  assert.equal(off.profile, 'claude');
});

test('pickReviewer：mustDiffer 只管执行者本人；differFamily 单独关掉后同家族的不同 Agent 可以选', () => {
  const profiles = { worker: { label: 'W', model: 'deepseek-v4-flash' }, twin: { model: 'deepseek-v4-flash' }, glm: { model: 'glm-5' } };
  const selfOff = pickReviewer({ config: cfg(profiles, { profiles: ['worker', 'twin'], mustDiffer: false }), executor: 'worker' });
  assert.equal(selfOff.profile, 'worker', 'mustDiffer 关掉且 differFamily 随之为 false 时执行者本人可以审');
  const familyOff = pickReviewer({ config: cfg(profiles, { profiles: ['twin', 'glm'], mustDiffer: true, differFamily: false }), executor: 'worker' });
  assert.equal(familyOff.profile, 'twin', 'differFamily 关掉后同家族的不同 Agent 可以选');
  const on = pickReviewer({ config: cfg(profiles, { profiles: ['twin', 'glm'], mustDiffer: true, differFamily: true }), executor: 'worker' });
  assert.equal(on.profile, 'glm');
  assert.deepEqual(on.reasons.map(item => item.why), ['W 执行者与 twin（deepseek-v4-flash，家族 deepseek）同家族（deepseek）']);
});

test('pickReviewer：三个开关都关时执行者本人也能审；旧配置 mustDiffer: false 没有 differFamily 时同家族照旧可选', () => {
  const profiles = { worker: { model: 'deepseek-v4-flash' }, a: { model: 'glm-5' } };
  const allOff = pickReviewer({ config: cfg(profiles, { profiles: ['worker'], mustDiffer: false, differFamily: false, differFromLead: false }), executor: 'worker' });
  assert.equal(allOff.ok, true);
  assert.equal(allOff.profile, 'worker');
  const twinProfiles = { worker: { model: 'deepseek-v4-flash' }, twin: { model: 'deepseek-v4-flash' } };
  const legacy = pickReviewer({ config: cfg(twinProfiles, { profiles: ['twin'], mustDiffer: false }), executor: 'worker' });
  assert.equal(legacy.profile, 'twin', '没有 differFamily 时随 mustDiffer: false，不突然多出家族限制');
  const unknownFamily = pickReviewer({ config: cfg({ worker: { model: 'deepseek-v4-flash' }, mystery: { model: 'Auto', env: { ANTHROPIC_BASE_URL: 'https://example.test' } } }, { profiles: ['mystery'], mustDiffer: false, differFamily: false, differFromLead: false }), executor: 'worker' });
  assert.equal(unknownFamily.profile, 'mystery', '三个都关时不因家族未知跳过');
});

test('pickReviewer：执行者本人、不能当审查者、已停用、不支持只读都跳过；都不合适时 ok:false', () => {
  const config = cfg({ worker: { model: 'deepseek-v4-flash' }, a: { model: 'kimi-k3', roles: ['executor'] }, b: { model: 'glm-5', enabled: false }, c: { adapter: 'generic', model: 'qwen3' } });
  config.routing.reviewer.profiles = ['worker', 'a', 'b', 'c'];
  const r = pickReviewer({ config, executor: 'worker' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons.map(item => [item.profile, item.why]), [
    ['worker', '就是执行者本人'], ['a', '没有设为可担任审查者'], ['b', '已停用'], ['c', '不支持只读'],
  ]);
  assert.equal(pickReviewer({ config: cfg({ worker: {} }, { profiles: [] }), executor: 'worker' }).ok, false);
  assert.equal(pickReviewer({ config, executor: 'nobody' }).ok, false);
});

test('pickReviewer：这次实际用的模型决定执行者家族', () => {
  const config = cfg({ worker: { model: 'Auto', modelFamilies: ['deepseek', 'qwen'] }, kimi: { model: 'kimi-k3' }, q: { model: 'qwen3-coder' } });
  config.routing.reviewer.profiles = ['q', 'kimi'];
  assert.equal(pickReviewer({ config, executor: 'worker' }).profile, 'kimi');
  assert.equal(pickReviewer({ config, executor: 'worker', model: 'deepseek-v4-flash' }).profile, 'q');
});

test('pickReviewer：exclude 里的候选被跳过，原因是"这次审查已经失败过"；全部排除后 ok:false', () => {
  const config = cfg({ worker: { model: 'deepseek-v4-flash' }, glm: { model: 'glm-5' }, kimi: { model: 'kimi-k3' }, q: { model: 'qwen3-coder' } });
  const first = pickReviewer({ config, executor: 'worker' });
  assert.equal(first.profile, 'glm');
  const second = pickReviewer({ config, executor: 'worker', exclude: ['glm'] });
  assert.equal(second.profile, 'kimi');
  assert.deepEqual(second.reasons, [{ profile: 'glm', why: '这次审查已经失败过' }]);
  const third = pickReviewer({ config, executor: 'worker', exclude: ['glm', 'kimi'] });
  assert.equal(third.profile, 'q');
  assert.deepEqual(third.reasons.map(item => item.profile), ['glm', 'kimi']);
  const none = pickReviewer({ config, executor: 'worker', exclude: ['glm', 'kimi', 'q'] });
  assert.equal(none.ok, false);
  assert.deepEqual(none.reasons.map(item => [item.profile, item.why]), [['glm', '这次审查已经失败过'], ['kimi', '这次审查已经失败过'], ['q', '这次审查已经失败过']]);
  assert.equal(pickReviewer({ config, executor: 'worker', exclude: undefined }).profile, 'glm', '不给 exclude 与以前一样');
  assert.equal(pickReviewer({ config, executor: 'worker', exclude: [] }).profile, 'glm');
});

test('pickReviewer：unavailable 回调返回原因的候选被跳过（在不支持只读之后、同家族判断之前）', () => {
  const config = cfg({ worker: { model: 'deepseek-v4-flash' }, glm: { model: 'glm-5' }, kimi: { model: 'kimi-k3' } });
  const r = pickReviewer({ config, executor: 'worker', unavailable: name => (name === 'glm' ? '被限流（额度到 12:00 恢复）' : null) });
  assert.equal(r.profile, 'kimi');
  assert.deepEqual(r.reasons, [{ profile: 'glm', why: '被限流（额度到 12:00 恢复）' }]);
});

test('模型家族模板：文件能读，每项 prefix 与 family 都是非空字符串', () => {
  const table = JSON.parse(readFileSync(new URL('../../core/templates/model-families.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(table) && table.length > 0);
  for (const item of table) {
    assert.ok(typeof item.prefix === 'string' && item.prefix.trim() !== '');
    assert.ok(typeof item.family === 'string' && item.family.trim() !== '');
  }
});
