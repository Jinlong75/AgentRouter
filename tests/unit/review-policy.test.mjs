import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateReviewSetting, validateV2 } from '../../core/lib/config.mjs';
import { blockingIssues, markNeedsHuman, reviewApplies, reviewDecision, reviewSettings } from '../../core/lib/review.mjs';
import { buildPrompt } from '../../core/lib/retry-prompt.mjs';
import { reviewBrief, reviewLine } from '../../core/lib/status.mjs';

// Stage08 T3：审查策略与返工判断的纯函数（启用、拦截、maxReworks、优先级、已标"不成立"的 high 不算）、返工提示段落、配置校验。

const issue = (id, severity, extra = {}) => ({ id, severity, file: 'src/a.js', line: 1, title: `问题 ${id}`, detail: `说明 ${id}`, confirmation: null, ...extra });
const review = (issues, verdict = 'concerns') => ({ verdict, issues });
const confirmed = result => ({ result, by: 'human', note: null, at: 1 });

test('reviewSettings：启用 = 任务说明 review > 项目 review.default > 全局 review.default > 关', () => {
  assert.equal(reviewSettings().enabled, false);
  assert.equal(reviewSettings({ spec: {}, project: {}, global: {} }).enabled, false);
  assert.equal(reviewSettings({ global: { review: { default: true } } }).enabled, true);
  assert.equal(reviewSettings({ project: { review: { default: true } }, global: { review: { default: false } } }).enabled, true);
  assert.equal(reviewSettings({ project: { review: { default: false } }, global: { review: { default: true } } }).enabled, false);
  assert.equal(reviewSettings({ spec: { review: true }, project: { review: { default: false } }, global: { review: { default: false } } }).enabled, true);
  assert.equal(reviewSettings({ spec: { review: false }, project: { review: { default: true } }, global: { review: { default: true } } }).enabled, false, '任务说明明确写 false 就不审');
  assert.equal(reviewSettings({ spec: { review: undefined }, global: { review: { default: true } } }).enabled, true, '没写不算');
});

test('reviewSettings：block = 任务说明 review_block > 项目 > 全局 > none；maxReworks = 项目 > 全局 > 1', () => {
  assert.deepEqual(reviewSettings(), { enabled: false, block: 'none', maxReworks: 1 });
  assert.equal(reviewSettings({ global: { review: { block: 'high' } } }).block, 'high');
  assert.equal(reviewSettings({ project: { review: { block: 'none' } }, global: { review: { block: 'high' } } }).block, 'none');
  assert.equal(reviewSettings({ spec: { review_block: 'high' }, project: { review: { block: 'none' } } }).block, 'high');
  assert.equal(reviewSettings({ spec: { review_block: 'none' }, project: { review: { block: 'high' } }, global: { review: { block: 'high' } } }).block, 'none');
  assert.equal(reviewSettings({ global: { review: { maxReworks: 3 } } }).maxReworks, 3);
  assert.equal(reviewSettings({ project: { review: { maxReworks: 0 } }, global: { review: { maxReworks: 3 } } }).maxReworks, 0, '0 是有效值，不当作没写');
  assert.equal(reviewSettings({ project: { review: { maxReworks: 2 } } }).maxReworks, 2);
});

test('reviewSettings：类型不对的值当没写（读的时候不抛错），往下一层取', () => {
  const bad = { review: { default: 'yes', block: 'all', maxReworks: 9 } };
  assert.deepEqual(reviewSettings({ spec: { review: 'true', review_block: 'x' }, project: bad, global: { review: { default: true, block: 'high', maxReworks: 4 } } }), { enabled: true, block: 'high', maxReworks: 4 });
  assert.deepEqual(reviewSettings({ project: { review: 5 }, global: { review: [] } }), { enabled: false, block: 'none', maxReworks: 1 });
  assert.deepEqual(reviewSettings({ project: null, global: null }), { enabled: false, block: 'none', maxReworks: 1 });
  assert.equal(reviewSettings({ project: { review: { maxReworks: 1.5 } }, global: { review: { maxReworks: -1 } } }).maxReworks, 1);
});

test('reviewApplies：research / review 类型与只读运行不审查', () => {
  assert.equal(reviewApplies({ spec: { type: 'code' } }), true);
  assert.equal(reviewApplies({ spec: { type: 'docs' } }), true);
  assert.equal(reviewApplies({ spec: null }), true, '直接写任务文字派发的任务没有任务说明');
  assert.equal(reviewApplies({ spec: { type: 'research' } }), false);
  assert.equal(reviewApplies({ spec: { type: 'review' } }), false);
  assert.equal(reviewApplies({ spec: { type: 'code' }, readOnly: true }), false, 'read_only: true');
  assert.equal(reviewApplies(), true);
});

test('blockingIssues：只有 high，且没被标为"不成立"（valid 与没确认的都算）', () => {
  const list = [issue('R1-1', 'high'), issue('R1-2', 'high', { confirmation: confirmed('invalid') }), issue('R1-3', 'high', { confirmation: confirmed('valid') }),
    issue('R1-4', 'medium'), issue('R1-5', 'low')];
  assert.deepEqual(blockingIssues(review(list)).map(item => item.id), ['R1-1', 'R1-3']);
  assert.deepEqual(blockingIssues(null), []);
  assert.deepEqual(blockingIssues({ issues: 'x' }), []);
  assert.deepEqual(blockingIssues(review([null, 5, {}])), []);
});

test('reviewDecision：none 永远 accept；high 有拦截问题时按 reworks < maxReworks 决定返工还是需人工处理', () => {
  const withHigh = review([issue('R1-1', 'high'), issue('R1-2', 'medium')]);
  // 建议模式：不论结论。
  assert.equal(reviewDecision({ review: withHigh, block: 'none', maxReworks: 1, reworks: 0 }).action, 'accept');
  assert.equal(reviewDecision({ review: withHigh }).action, 'accept', '默认 block 是 none');
  // 拦截模式：第一次返工，用完就需人工处理。
  const first = reviewDecision({ review: withHigh, block: 'high', maxReworks: 1, reworks: 0 });
  assert.equal(first.action, 'rework');
  assert.deepEqual(first.blocking.map(item => item.id), ['R1-1']);
  assert.equal(reviewDecision({ review: withHigh, block: 'high', maxReworks: 1, reworks: 1 }).action, 'needs-human');
  assert.equal(reviewDecision({ review: withHigh, block: 'high', maxReworks: 3, reworks: 2 }).action, 'rework');
  assert.equal(reviewDecision({ review: withHigh, block: 'high', maxReworks: 3, reworks: 3 }).action, 'needs-human');
  assert.equal(reviewDecision({ review: withHigh, block: 'high', maxReworks: 0, reworks: 0 }).action, 'needs-human', 'maxReworks 0：不返工');
  assert.equal(reviewDecision({ review: withHigh, block: 'high' }).action, 'rework', 'maxReworks 默认 1');
});

test('reviewDecision：没有 high、high 全被标"不成立"、审查没有结论 → accept', () => {
  const policy = { block: 'high', maxReworks: 1, reworks: 0 };
  assert.equal(reviewDecision({ review: review([issue('R1-1', 'medium'), issue('R1-2', 'low')]), ...policy }).action, 'accept');
  assert.equal(reviewDecision({ review: review([]), ...policy }).action, 'accept');
  assert.equal(reviewDecision({ review: review([issue('R1-1', 'high', { confirmation: confirmed('invalid') })]), ...policy }).action, 'accept', '已标不成立的 high 不触发');
  assert.equal(reviewDecision({ review: review([issue('R1-1', 'high', { confirmation: confirmed('invalid') }), issue('R1-2', 'high')]), ...policy }).action, 'rework', '还有没被否掉的 high');
  assert.equal(reviewDecision({ review: review([issue('R1-1', 'high', { confirmation: confirmed('valid') })]), ...policy }).action, 'rework', '确认成立的 high 照常触发');
  for (const verdict of ['unknown', 'invalid', 'skipped']) {
    assert.equal(reviewDecision({ review: review([issue('R1-1', 'high')], verdict), ...policy }).action, 'accept', `${verdict} 不阻断`);
  }
  assert.equal(reviewDecision({ review: review([issue('R1-1', 'high')], 'fail'), ...policy }).action, 'rework', 'fail 也是有结论');
  assert.equal(reviewDecision({ review: null, ...policy }).action, 'accept');
});

test('buildPrompt 的审查返工段落：标题、未被否掉的 high 与 medium（high 在前，最多 10 条）、编号与文件:行、固定的一句', () => {
  const issues = [
    issue('R1-1', 'medium'), issue('R1-2', 'low'), issue('R1-3', 'high', { file: 'src/b.js', line: null, detail: '第一行\n第二行' }),
    issue('R1-4', 'high', { confirmation: confirmed('invalid') }), issue('R1-5', 'high', { confirmation: confirmed('valid') }),
  ];
  const text = buildPrompt('原始指令', { n: 2, total: 3, failure: { kind: 'review', issues }, note: null });
  assert.ok(text.startsWith('原始指令\n\n## 上一次审查发现了这些问题\n\n'));
  assert.ok(!text.includes('没有通过验收'), '不是门禁失败的段落');
  const listed = text.split('\n').filter(line => line.startsWith('- '));
  assert.deepEqual(listed, [
    '- R1-3（high）src/b.js　问题 R1-3',
    '- R1-5（high）src/a.js:1　问题 R1-5',
    '- R1-1（medium）src/a.js:1　问题 R1-1',
  ]);
  assert.ok(text.includes('- R1-3（high）src/b.js　问题 R1-3\n  第一行\n  第二行\n'), '多行说明缩进');
  assert.ok(!text.includes('R1-2') && !text.includes('R1-4'), 'low 与已标不成立的不列');
  assert.ok(text.endsWith('\n\n如果你认为某条问题不成立，在汇报里说明理由，不要为了通过审查做无意义的修改。'));
  // 最多 10 条，high 排在 medium 前面。
  const many = [...Array.from({ length: 8 }, (_, i) => issue(`M${i}`, 'medium')), ...Array.from({ length: 6 }, (_, i) => issue(`H${i}`, 'high'))];
  const listedMany = buildPrompt('p', { n: 2, total: 3, failure: { kind: 'review', issues: many } }).split('\n').filter(line => line.startsWith('- '));
  assert.equal(listedMany.length, 10);
  assert.deepEqual(listedMany.slice(0, 6).map(line => line.slice(2, 4)), ['H0', 'H1', 'H2', 'H3', 'H4', 'H5']);
  // 补充说明照常跟在后面；没有问题可列时仍有标题和那一句（不会抛错）。
  assert.match(buildPrompt('p', { n: 2, total: 3, failure: { kind: 'review', issues }, note: '注意边界' }), /## 主导补充说明\n\n注意边界$/);
  assert.match(buildPrompt('p', { n: 2, total: 3, failure: { kind: 'review', issues: [] } }), /## 上一次审查发现了这些问题/);
  // 门禁失败、执行者失败的段落不受影响。
  assert.match(buildPrompt('p', { n: 2, total: 3, failure: { kind: 'agent', exit: 1, errors: [], stderrTail: '' } }), /## 上一次尝试没有通过验收/);
});

test('markNeedsHuman：顶层与这次尝试目录里的 review 文件都标 needsHuman（只改同一次审查）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ar-review-policy-'));
  try {
    const result = { v: 1, attempt: 2, at: 1000, verdict: 'concerns', issues: [] };
    mkdirSync(path.join(dir, 'attempts', '2'), { recursive: true });
    const write = (file, value) => writeFileSync(path.join(dir, ...file), `${JSON.stringify(value)}\n`);
    write(['review.json'], result);
    write(['attempts', '2', 'review.json'], result);
    const marked = markNeedsHuman({ dir }, result);
    assert.equal(marked.needsHuman, true);
    assert.equal(result.needsHuman, undefined, '不改传入的对象');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'review.json'), 'utf8')).needsHuman, true);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'attempts', '2', 'review.json'), 'utf8')).needsHuman, true);
    // 顶层已经被更新的一次审查（at 不同）替换：不动它。
    const newer = { ...result, at: 2000 };
    write(['review.json'], newer);
    markNeedsHuman({ dir }, result);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'review.json'), 'utf8')).needsHuman, undefined);
    // 再审的文件名：review-<run>.json。
    write(['attempts', '2', 'review-3.json'], { ...result, run: 3 });
    markNeedsHuman({ dir }, { ...result, run: 3 });
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'attempts', '2', 'review-3.json'), 'utf8')).needsHuman, true);
    // 文件不在：不抛错。
    assert.doesNotThrow(() => markNeedsHuman({ dir: path.join(dir, '不存在') }, result));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('reviewBrief / reviewLine：ar status 用的摘要与文字行', () => {
  const brief = reviewBrief({ verdict: 'concerns', reviewer: 'rev', crossed: true, needsHuman: true, issues: [issue('R1-1', 'high'), issue('R1-2', 'high'), issue('R1-3', 'low')] });
  assert.deepEqual(brief, { verdict: 'concerns', reviewer: 'rev', crossed: true, issues: 3, high: 2, needsHuman: true });
  assert.equal(reviewLine(brief), '审查：concerns（rev，3 个问题，其中高 2）');
  assert.deepEqual(reviewBrief({ verdict: 'unknown', reviewer: null }), { verdict: 'unknown', reviewer: null, crossed: false, issues: 0, high: 0, needsHuman: false });
  assert.equal(reviewLine(reviewBrief({ verdict: 'unknown' })), '审查：unknown（无，0 个问题，其中高 0）');
  assert.equal(reviewBrief(null), null);
  assert.equal(reviewBrief({ issues: [] }), null);
  assert.equal(reviewBrief([]), null);
});

test('配置校验：review 只允许 default（布尔）、block（none | high）、maxReworks（0～5 的整数）', () => {
  for (const good of [undefined, null, {}, { default: true }, { block: 'none' }, { block: 'high', maxReworks: 0 }, { default: false, block: 'high', maxReworks: 5 }]) {
    assert.doesNotThrow(() => validateReviewSetting(good), JSON.stringify(good));
    assert.doesNotThrow(() => validateV2({ v: 2, review: good }), JSON.stringify(good));
  }
  const bad = [
    [[], /必须为对象/], ['x', /必须为对象/], [{ default: 'true' }, /default 必须为布尔值/], [{ default: 1 }, /default 必须为布尔值/],
    [{ block: 'all' }, /block 必须为 none 或 high/], [{ block: true }, /block 必须为 none 或 high/], [{ block: 'HIGH' }, /block 必须为 none 或 high/],
    [{ maxReworks: 6 }, /maxReworks 必须是 0～5 的整数/], [{ maxReworks: -1 }, /maxReworks 必须是 0～5 的整数/], [{ maxReworks: 1.5 }, /maxReworks/], [{ maxReworks: '2' }, /maxReworks/],
    [{ foo: 1 }, /不认识的键：foo/],
  ];
  for (const [value, match] of bad) {
    assert.throws(() => validateReviewSetting(value), match, JSON.stringify(value));
    assert.throws(() => validateV2({ v: 2, review: value }), match, `全局配置：${JSON.stringify(value)}`);
  }
  assert.throws(() => validateReviewSetting({ block: 'x' }, '项目配置的 review'), /^Error: 项目配置的 review\.block 必须为 none 或 high$/);
});
