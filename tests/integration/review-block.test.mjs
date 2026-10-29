import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { reviewDecision } from '../../core/lib/review.mjs';
import { fixture, git, readJson } from '../fixtures/review/pipeline-fixture.mjs';

// Stage08 T3：拦截策略（block: high）。有 high 问题且没有被标为"不成立"：自动返工（reason: review，不占 max_retries），
// 返工次数到 maxReworks 后进入待验收并标"需人工处理"。假执行者 + reviewer-seq.mjs 经通用适配器接入的假审查者。

const FIRST_REVIEW = ['start', 'preparing', 'worktree', 'setup', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'reviewing', 'review'];
const SECOND_ROUND = ['attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'reviewing', 'review'];
const REWORK_SENTENCE = '如果你认为某条问题不成立，在汇报里说明理由，不要为了通过审查做无意义的修改。';
// 返工那一次的改动：写一个新文件并提交。
const REWORK_WRITES = { 2: { writes: [{ path: 'src/b.js', content: '返工后的改动\n' }], commit: '返工' } };

test('block: high：第一次有 high → 自动返工（reason review，不占 max_retries，提示里有问题编号与那句话）→ 返工后仍有 high → 待验收且需人工处理', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-high', modes: 'high' }], executor: { attempts: REWORK_WRITES } });
  // max_retries: 0：如果返工占重试次数，第二次尝试根本不会发生。
  const spec = f.spec('docs/specs/101-返工.md', { review: true, reviewBlock: 'high', maxRetries: 0 });
  const result = await f.dispatch(spec, '返工');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.value.exit, 0);

  assert.deepEqual(f.names('返工'), [...FIRST_REVIEW, ...SECOND_ROUND, 'review-needs-human', 'end']);
  const events = f.events('返工');
  const attempts = events.filter(row => row.event === 'attempt');
  assert.deepEqual(attempts.map(row => [row.n, row.reason, row.total]), [[1, 'first', 1], [2, 'review', 2]]);
  const reviews = events.filter(row => row.event === 'review');
  assert.deepEqual(reviews.map(row => [row.attempt, row.verdict, row.high]), [[1, 'concerns', 1], [2, 'concerns', 1]]);
  const needsHuman = events.find(row => row.event === 'review-needs-human');
  assert.deepEqual(Object.keys(needsHuman).sort(), ['at', 'attempt', 'event', 'id', 'v']);
  assert.equal(needsHuman.attempt, 2);
  assert.equal(events.at(-1).exit, 0);
  assert.equal(events.at(-1).attempts, 2);
  assert.ok(!Object.hasOwn(events.at(-1), 'handBack'), '返工用完不算"自动重试都没通过"');

  // 返工那一次的提示：标题、high 与 medium 的编号、固定的一句；low 不列。第一次的提示里没有这一段。
  const prompt = f.prompt('返工', 2);
  assert.match(prompt, /## 上一次审查发现了这些问题/);
  assert.match(prompt, /- R1-1（high）src\/a\.js:1　示例高严重度问题\n {2}传入空值时会抛错。/);
  assert.match(prompt, /- R1-2（medium）src\/a\.js:2　示例中严重度问题/);
  assert.ok(!prompt.includes('R1-3'), 'low 问题不列');
  assert.ok(prompt.trimEnd().endsWith(REWORK_SENTENCE), '固定的一句在末尾');
  assert.ok(prompt.indexOf('R1-1') < prompt.indexOf('R1-2'), 'high 在前');
  assert.ok(!f.prompt('返工', 1).includes('上一次审查发现'));
  assert.match(f.progress('返工'), /审查发现 1 个高严重度问题，自动返工（第 1\/1 次）/);
  assert.match(f.progress('返工'), /=== 第 2 次尝试（执行者：假执行者；原因：审查发现问题，返工）===/);

  // 返工后的审查：顶层与这次尝试的 review.json 标 needsHuman；第一次的不动。
  const top = f.review('返工');
  assert.equal(top.attempt, 2);
  assert.equal(top.needsHuman, true);
  assert.equal(readJson(path.join(f.dir('返工'), 'attempts', '2', 'review.json')).needsHuman, true);
  assert.equal(readJson(path.join(f.dir('返工'), 'attempts', '1', 'review.json')).needsHuman, undefined);
  assert.match(f.progress('返工'), /审查问题未解决，需人工处理/);
  const status = await f.json(['status', '返工']);
  assert.equal(status.value.state, 'awaiting');
  assert.equal(status.value.attempts, 2);
  assert.deepEqual(status.value.review, { verdict: 'concerns', reviewer: 'rev-high', crossed: true, issues: 3, high: 1, needsHuman: true });
  // 两次尝试的提交都在任务分支上。
  const wt = events.find(row => row.event === 'worktree');
  assert.match(git(f.repo, ['log', '--format=%s', `${wt.base}..${wt.branch}`]), /返工[\s\S]*假执行者：改 src\/a\.js/);
});

test('返工后审查通过：不标需人工处理，也没有 review-needs-human 事件', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-seq', modes: 'high,pass' }], executor: { attempts: REWORK_WRITES } });
  const spec = f.spec('docs/specs/102-返工通过.md', { review: true, reviewBlock: 'high' });
  const result = await f.dispatch(spec, '返工通过');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.names('返工通过'), [...FIRST_REVIEW, ...SECOND_ROUND, 'end']);
  const top = f.review('返工通过');
  assert.equal(top.attempt, 2);
  assert.equal(top.verdict, 'pass');
  assert.equal(top.needsHuman, undefined);
  const status = await f.json(['status', '返工通过']);
  assert.deepEqual(status.value.review, { verdict: 'pass', reviewer: 'rev-seq', crossed: true, issues: 0, high: 0, needsHuman: false });
});

test('只有 medium / low 问题不拦截；建议模式（默认）有 high 也不拦截', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-medium', modes: 'medium' }] });
  const spec = f.spec('docs/specs/103-中严重度.md', { review: true, reviewBlock: 'high' });
  assert.equal((await f.dispatch(spec, '中严重度')).code, 0);
  assert.deepEqual(f.names('中严重度'), ['start', 'preparing', 'worktree', 'setup', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'reviewing', 'review', 'end']);
  assert.equal(f.review('中严重度').needsHuman, undefined);

  const high = fixture(t, { reviewers: [{ name: 'rev-high', modes: 'high' }] });
  assert.equal((await high.dispatch(high.spec('docs/specs/104-建议模式.md', { review: true }), '建议模式')).code, 0);
  assert.equal(high.events('建议模式').filter(row => row.event === 'attempt').length, 1);
  assert.equal(high.review('建议模式').needsHuman, undefined);
});

test('策略优先级与 maxReworks：任务说明 review_block > 项目 > 全局；maxReworks 0 不返工，直接标需人工处理', async t => {
  const f = fixture(t, {
    reviewers: [{ name: 'rev-high', modes: 'high' }], executor: { attempts: REWORK_WRITES },
    global: { block: 'none', maxReworks: 3 }, project: { review: { block: 'high', maxReworks: 0 } },
  });
  // 项目配置压过全局：block high、maxReworks 0 → 不返工，一次尝试，需人工处理。
  assert.equal((await f.dispatch(f.spec('docs/specs/105-项目拦截.md', { review: true }), '项目拦截')).code, 0);
  assert.deepEqual(f.names('项目拦截'), [...FIRST_REVIEW, 'review-needs-human', 'end']);
  assert.equal(f.review('项目拦截').needsHuman, true);
  // 任务说明写 review_block: none 压过项目配置：不拦截。
  assert.equal((await f.dispatch(f.spec('docs/specs/106-说明不拦.md', { review: true, reviewBlock: 'none' }), '说明不拦')).code, 0);
  assert.deepEqual(f.names('说明不拦'), [...FIRST_REVIEW, 'end']);
  assert.equal(f.review('说明不拦').needsHuman, undefined);
  // 全局 block high + maxReworks 2，项目没写：说明没写 → 全局生效；返工两次后仍有 high → 需人工处理。
  const g = fixture(t, { reviewers: [{ name: 'rev-high', modes: 'high' }], executor: { attempts: { ...REWORK_WRITES, 3: { writes: [{ path: 'src/c.js', content: '再返工\n' }], commit: '再返工' } } }, global: { block: 'high', maxReworks: 2 } });
  assert.equal((await g.dispatch(g.spec('docs/specs/107-全局拦截.md', { review: true }), '全局拦截')).code, 0);
  assert.deepEqual(g.events('全局拦截').filter(row => row.event === 'attempt').map(row => [row.n, row.reason]), [[1, 'first'], [2, 'review'], [3, 'review']]);
  assert.equal(g.review('全局拦截').attempt, 3);
  assert.equal(g.review('全局拦截').needsHuman, true);
});

test('已被 confirm … invalid 的 high 不算：不再触发返工；还有没被否掉的 high 时仍触发', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-high', modes: 'high' }] });
  assert.equal((await f.dispatch(f.spec('docs/specs/108-确认不成立.md', { review: true }), '确认不成立')).code, 0);
  const before = f.review('确认不成立');
  assert.equal(reviewDecision({ review: before, block: 'high', maxReworks: 1, reworks: 0 }).action, 'rework');
  const confirmed = await f.json(['review', 'confirm', '确认不成立', 'R1-1', 'invalid', '--note', '这条不成立']);
  assert.equal(confirmed.code, 0, confirmed.stderr);
  const after = f.review('确认不成立');
  assert.equal(after.issues[0].confirmation.result, 'invalid');
  assert.equal(reviewDecision({ review: after, block: 'high', maxReworks: 1, reworks: 0 }).action, 'accept');
  // 另一条 high 没被否掉：仍然拦。
  const two = { ...after, issues: [...after.issues, { id: 'R1-9', severity: 'high', file: 'x', line: 1, title: 't', detail: 'd', confirmation: null }] };
  assert.equal(reviewDecision({ review: two, block: 'high', maxReworks: 1, reworks: 0 }).action, 'rework');
});

test('门禁失败仍按原来的重试：审查只在门禁通过后发生，返工不占重试次数，也不走升级链', async t => {
  const f = fixture(t, {
    reviewers: [{ name: 'rev-high', modes: 'high' }],
    executor: { writes: [{ path: 'src/x.js', content: '第一次\n' }], commit: '第一次', attempts: {
      2: { writes: [{ path: 'src/ok.txt', content: 'ok\n' }], commit: '补 ok.txt' },
      3: { writes: [{ path: 'src/more.js', content: '返工\n' }], commit: '返工' },
    } },
  });
  // 第 1 次门禁不过（没有 src/ok.txt）→ 第 2 次（reason gate）门禁通过 → 审查有 high → 返工（第 3 次，reason review）→ 门禁通过 → 仍有 high → 需人工处理。
  const spec = f.spec('docs/specs/109-门禁加审查.md', { review: true, reviewBlock: 'high', maxRetries: 1, verify: ['node scripts/check.mjs'] });
  const result = await f.dispatch(spec, '门禁加审查');
  assert.equal(result.code, 0, result.stderr);
  const events = f.events('门禁加审查');
  assert.deepEqual(events.filter(row => row.event === 'attempt').map(row => [row.n, row.reason, row.total]), [[1, 'first', 2], [2, 'gate', 2], [3, 'review', 3]]);
  assert.deepEqual(events.filter(row => row.event === 'gate').map(row => row.ok), [false, true, true]);
  assert.deepEqual(events.filter(row => row.event === 'reviewing').map(row => row.attempt), [2, 3], '门禁没过的那次不审查');
  assert.ok(events.some(row => row.event === 'review-needs-human'));
  assert.ok(f.prompt('门禁加审查', 2).includes('上一次尝试没有通过验收') && !f.prompt('门禁加审查', 2).includes('上一次审查发现'));
  assert.ok(f.prompt('门禁加审查', 3).includes('上一次审查发现了这些问题') && !f.prompt('门禁加审查', 3).includes('上一次尝试没有通过验收'));
  const afterThird = f.progress('门禁加审查').split('=== 第 3 次尝试')[1];
  assert.ok(afterThird !== undefined, '有第 3 次尝试');
  assert.ok(!/提高推理强度|换强执行者|没有设强执行者/.test(afterThird), '返工那一次不走升级链');
  assert.equal(events.at(-1).exit, 0);
  assert.ok(!Object.hasOwn(events.at(-1), 'handBack'));
  assert.equal(readFileSync(path.join(f.dir('门禁加审查'), 'review.json'), 'utf8').includes('"needsHuman": true'), true);
});
