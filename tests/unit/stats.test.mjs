import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildStats, summarizeScoreItems } from '../../core/lib/stats.mjs';

test('统计按清单隔离同编号，保留边界并排除未完成与旧记录', (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-'));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const homes = [path.join(root, 'a'), path.join(root, 'b')];
  const repo = path.join(root, 'project');
  for (const dir of [...homes, repo]) mkdirSync(dir);
  writeFileSync(path.join(repo, 'spec.md'), '---\ntype: code\n---\n');
  const now = 1000000000, start = now - 7 * 86400000;
  const rows = [
    { event: 'start', v: 2, id: 'same', repo, dir: path.join(repo, 'record'), started: start, profile: 'p', spec: 'spec.md', worktree: true },
    { event: 'attempt', v: 1, id: 'same', n: 1, profile: 'p', at: start },
    { event: 'attempt-end', v: 1, id: 'same', n: 1, gate: true, usage: { input: 0, output: 0 }, at: start + 1 },
    { event: 'end', v: 1, id: 'same', exit: 0, at: start + 2 },
    { event: 'accepted', v: 1, id: 'same', merge: 'a'.repeat(40), at: now + 1 },
    { event: 'review-confirm', v: 1, id: 'same', issue: '1', severity: 'high', result: 'valid', reviewer: 'r' },
  ];
  writeFileSync(path.join(homes[0], 'runs.jsonl'), rows.map(JSON.stringify).join('\n') + '\n坏行\n');
  writeFileSync(path.join(homes[1], 'runs.jsonl'), [rows[0], { ...rows[0], id: 'old', v: 1 }].map(JSON.stringify).join('\n') + '\n');
  const result = buildStats({ home: homes, range: '7d', now });
  assert.deepEqual(result.totals, { tasks: 2, finished: 1 });
  assert.equal(result.legacyTasks, 1);
  const s = result.strata[0];
  assert.equal(s.sampleSize, 1);
  assert.equal(s.insufficient, true);
  assert.equal(s.executor.firstPass.value, 1);
  assert.equal(s.executor.tokensPerMerged.input, 0);
  assert.equal(s.executor.costPerMerged, null);
  assert.equal(s.executor.validHighIssues, 1);
  assert.equal(s.lead.dispatchToMergeMedianMs, now + 1 - start);
  assert.equal(buildStats({ home: homes, range: '7d', now, project: path.join(root, 'other') }).totals.tasks, 0);
});

test('五个样本、归因、换配置、混合币种和最新确认', (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-metrics-'));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), repo = path.join(root, 'repo');
  mkdirSync(home); mkdirSync(repo);
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, prices: { p: { input: 1, output: 2, currency: 'USD' }, q: { input: 3, output: 4, currency: 'CNY' } } }));
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const id = `t${i}`, dir = path.join(root, id);
    mkdirSync(path.join(dir, 'attempts', '1'), { recursive: true });
    writeFileSync(path.join(dir, 'marks.json'), JSON.stringify({ v: 1, blame: { 1: 'spec' } }));
    writeFileSync(path.join(dir, 'attempts', '1', 'gate.json'), JSON.stringify({ scope: { outside: i ? [] : ['x'], protected: [] } }));
    rows.push(
      { event: 'start', v: 2, id, repo, dir, started: 100 + i, profile: 'p', effort: 'high', worktree: true },
      { event: 'attempt', v: 1, id, n: 1, profile: 'p', at: 200 + i },
      { event: 'attempt-end', v: 1, id, n: 1, gate: false, usage: { input: 1000000, output: 0 } },
      { event: 'attempt', v: 1, id, n: 2, profile: 'q', at: 300 + i },
      { event: 'attempt-end', v: 1, id, n: 2, gate: true, usage: { input: 0, output: 1000000 } },
      { event: 'review', v: 1, id, verdict: 'unknown', reviewer: 'r' },
      { event: 'review-confirm', v: 1, id, issue: '1', result: 'invalid', severity: 'high', reviewer: 'r' },
      { event: 'review-confirm', v: 1, id, issue: '1', result: 'valid', severity: 'high', reviewer: 'r' },
      { event: 'end', v: 1, id, exit: 0, at: 400 + i },
      { event: 'accepted', v: 1, id, merge: 'a'.repeat(40), at: 500 + i },
    );
  }
  writeFileSync(path.join(home, 'runs.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  const result = buildStats({ home, now: 1000 });
  const s = result.strata[0];
  assert.equal(s.sampleSize, 5);
  assert.equal(s.insufficient, false);
  assert.equal(s.executor.firstPass.value, 0);
  assert.equal(s.executor.firstPass.wilson95.low, 0);
  assert.equal(s.executor.avgAttempts, 2);
  assert.deepEqual(s.executor.gateFailures, { worker: 0, spec: 5, unknown: 0 });
  assert.equal(s.executor.outsideRate.value, 0.2);
  assert.equal(s.executor.escalationRate.value, 1);
  assert.equal(s.executor.medianMs, 200);
  assert.deepEqual(s.executor.costPerMerged, { USD: 1, CNY: 4 });
  assert.equal(s.executor.validHighIssues, 5);
  assert.equal(s.reviewer.accuracy.value, 1);
  assert.equal(s.reviewer.failedReviewRate.value, 1);
  assert.equal(s.reviewer.validIssuesPerReview, 1);
  assert.equal(s.lead.specGateFailureRate.value, 1);
  assert.equal(s.lead.supplementCount, null);
  assert.equal(s.lead.dispatchToMergeMedianMs, 400);
  assert.deepEqual(result.leadGroups[0].lead, s.lead);
});

test('scores, duplicate names, UTC weeks and interventions', (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-scores-'));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), repo = path.join(root, 'repo');
  mkdirSync(home); mkdirSync(repo);
  writeFileSync(path.join(repo, 'spec.md'), '---\ntype: code\n---\n');
  const rows = [], startAt = Date.UTC(2020, 11, 31, 23);
  for (let i = 0; i < 7; i++) {
    const id = `s${i}`, name = i >= 5 ? 'duplicate' : id, dir = path.join(root, id);
    mkdirSync(dir);
    rows.push({ event: 'start', v: 2, id, name, repo, dir, spec: 'spec.md', gate: true, started: startAt + i * 86400000, profile: 'fake', effort: 'high', worktree: true },
      { event: 'attempt', id, n: 1, reason: 'first', profile: 'fake' },
      { event: 'attempt-end', id, n: 1, gate: true, usage: { input: 10, output: 5 } },
      { event: 'end', id, exit: 0, at: startAt + i * 86400000 + 1 },
      { event: 'accepted', id, merge: 'abc', at: startAt + i * 86400000 + 3600000 });
    if (i === 0) rows.push({ event: 'attempt', id, n: 2, reason: 'manual' }, { event: 'rejected', id }, { event: 'rejected', id }, { event: 'review-needs-human', id });
  }
  writeFileSync(path.join(home, 'runs.jsonl'), rows.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
  const result = buildStats({ home, now: startAt + 10 * 86400000 });
  assert.equal(result.scores.skipped, 2);
  assert.deepEqual(result.scores.groups.map(g => [g.role, g.sampleSize, g.insufficient]), [['executor', 5, false], ['lead', 5, false]]);
  assert.equal(result.scores.daily.length, 10);
  assert.equal(result.scores.groups.find(g => g.role === 'lead').items.find(i => i.key === 'manualRetry').mean, 0.2);
  assert.deepEqual(result.overall.weeks, [{ week: '2020-W53', merged: 3 }, { week: '2021-W01', merged: 4 }]);
  assert.deepEqual(result.overall.humanInterventions, { manualRetry: 1, rejected: 2, needsHuman: 1, total: 4 });
  assert.equal(result.overall.medianEndToEndMs, 3600000);
  assert.equal(result.overall.cost, null);
  assert.equal(result.overall.leadExecutorTokenRatio, null);
});

test('unknown first gate and attempt outside writes', (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-first-'));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), repo = path.join(root, 'repo');
  mkdirSync(home); mkdirSync(repo);
  const rows = [];
  for (let i = 0; i < 4; i++) {
    const id = `t${i}`;
    rows.push({ event: 'start', v: 2, id, repo, dir: root, started: 100 + i, profile: 'fake', worktree: true },
      { event: 'attempt', id, n: 1 },
      ...(i === 0 ? [{ event: 'attempt-end', id, n: 1, gate: null, outsideWrites: { checked: true, added: [{ root: 'home', name: 'x', type: 'file' }] } }] : []),
      { event: 'end', id, exit: 0 }, { event: 'accepted', id, merge: 'abc', at: 200 });
  }
  writeFileSync(path.join(home, 'runs.jsonl'), rows.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
  const result = buildStats({ home, now: 1000 });
  assert.equal(result.strata[0].insufficient, true);
  assert.equal(result.strata[0].executor.firstPass, null);
  assert.equal(result.strata[0].executor.outsideRate.value, 1);
  assert.equal(result.scores.skipped, 4);
});


test('range endpoints and project paths', (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-range-')), home = path.join(root, 'home');
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const repos = [path.join(root, 'a', 'same'), path.join(root, 'b', 'same')];
  mkdirSync(home); for (const repo of repos) mkdirSync(repo, { recursive: true });
  const now = 40 * 86400000, day = 86400000, rows = [];
  for (const [i, started] of [now - 30 * day - 1, now - 30 * day, now - 7 * day - 1, now - 7 * day, now, now + 1].entries())
    rows.push({ event: 'start', v: 2, id: String(i), repo: repos[i % 2], started });
  writeFileSync(path.join(home, 'runs.jsonl'), rows.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
  assert.equal(buildStats({ home, now, range: '7d' }).totals.tasks, 2);
  const result = buildStats({ home, now, range: '30d' });
  assert.equal(result.totals.tasks, 4);
  assert.equal(result.projects.length, 2);
  assert.equal(buildStats({ home, now, range: '30d', project: repos[0] }).totals.tasks, 2);
});

test('overall cost and acceptance without merge', (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-cost-')), home = path.join(root, 'home'), repo = path.join(root, 'repo'), dir = path.join(root, 'record');
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(home); mkdirSync(repo); mkdirSync(path.join(dir, 'attempts', '1'), { recursive: true });
  const config = { v: 2, prices: { p: { input: 1, output: 2, currency: 'USD' }, r: { input: 3, output: 4, currency: 'CNY' } } };
  const rows = [{ event: 'start', v: 2, id: 'x', name: 'x', repo, dir, started: 100, profile: 'p', worktree: true },
    { event: 'attempt', id: 'x', n: 1, profile: 'p' }, { event: 'attempt-end', id: 'x', n: 1, gate: true, usage: { input: 1000000, output: 0 } },
    { event: 'review', id: 'x', attempt: 1, reviewer: 'r' }, { event: 'end', id: 'x', exit: 0 }, { event: 'accepted', id: 'x', at: 300 }];
  const save = () => writeFileSync(path.join(home, 'runs.jsonl'), rows.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
  const reviewFile = path.join(dir, 'attempts', '1', 'review.json');
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(config)); save();
  writeFileSync(reviewFile, JSON.stringify({ tries: [{ reviewer: 'r', ok: true }], usage: { input: 0, output: 1000000 } }));
  let result = buildStats({ home, now: 1000 });
  assert.deepEqual(result.overall.cost, { USD: 1, CNY: 4 });
  assert.deepEqual(result.daily[0].cost, { USD: 1, CNY: 4 });
  assert.equal(result.overall.medianEndToEndMs, 200); assert.deepEqual(result.overall.weeks, []);
  rows[5].merge = 'abc';
  rows[2].usage.output = null; save();
  result = buildStats({ home, now: 1000 });
  assert.equal(result.overall.cost, null);
  assert.equal(result.strata[0].executor.tokensPerMerged.output, null);
  assert.equal(result.strata[0].executor.costPerMerged, null);
  rows[2].usage.output = 0; save(); delete config.prices.r; writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  result = buildStats({ home, now: 1000 });
  assert.equal(result.overall.cost, null);
  delete config.prices.p; writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  assert.equal(buildStats({ home, now: 1000 }).strata[0].executor.costPerMerged, null);
  config.prices.p = { input: 1, output: 2, currency: 'USD' };
  config.prices.r = { input: 3, output: 4, currency: 'CNY' }; writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  writeFileSync(reviewFile, JSON.stringify({ tries: [{ reviewer: 'r' }, { reviewer: 'p' }], usage: { input: 1, output: 1 } }));
  assert.equal(buildStats({ home, now: 1000 }).overall.cost, null);
});

test('review attribution distinguishes unknown from zero', (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-review-')), home = path.join(root, 'home');
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(home);
  const rows = [{ event: 'start', v: 2, id: 'x', repo: root, dir: root, started: 1, worktree: true },
    { event: 'review', id: 'x', verdict: 'pass' }, { event: 'review-confirm', id: 'x', issue: 'a', result: 'valid', reviewer: null },
    { event: 'end', id: 'x', exit: 0 }, { event: 'accepted', id: 'x', at: 2 }];
  const save = () => writeFileSync(path.join(home, 'runs.jsonl'), rows.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n'); save();
  let reviewer = buildStats({ home, now: 10 }).strata[0].reviewer;
  assert.equal(reviewer.accuracy.value, null); assert.equal(reviewer.validIssuesPerReview, 0);
  rows.push({ event: 'review-confirm', id: 'x', issue: 'b', result: 'invalid', reviewer: 'r' }); save();
  reviewer = buildStats({ home, now: 10 }).strata[0].reviewer;
  assert.equal(reviewer.accuracy.value, 0); assert.equal(reviewer.validIssuesPerReview, 0);
});


test('score sample boundary and lead token ratio', (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-ratio-')), home = path.join(root, 'home'), repo = path.join(root, 'repo'), configDir = path.join(root, 'claude');
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(home); mkdirSync(repo); mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, leadUsage: true }));
  writeFileSync(path.join(repo, 'spec.md'), '---\ntype: code\n---\n');
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const id = `t${i}`, dir = path.join(root, id); mkdirSync(dir);
    rows.push({ event: 'start', v: 2, id, name: id, repo, dir, spec: 'spec.md', gate: true, started: 1000, profile: 'p', dispatcher: { session: id }, worktree: true },
      { event: 'attempt', id, n: 1, profile: 'p' }, { event: 'attempt-end', id, n: 1, gate: true, usage: { input: 10, output: 10 } },
      { event: 'end', id, exit: 0, at: 3000 }, { event: 'accepted', id, at: 4000 });
    writeFileSync(path.join(configDir, 'projects', 'p', `${id}.jsonl`), JSON.stringify({ timestamp: new Date(2000).toISOString(), message: { id: 'm', usage: { input_tokens: 20, output_tokens: 10 } } }) + '\n');
  }
  const save = values => writeFileSync(path.join(home, 'runs.jsonl'), values.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
  const env = { CLAUDE_CONFIG_DIR: configDir };
  save(rows.slice(0, 20)); let result = buildStats({ home, now: 5000, env });
  assert.equal(result.scores.groups.find(g => g.role === 'executor').sampleSize, 4);
  assert.equal(result.scores.groups.find(g => g.role === 'executor').insufficient, true);
  assert.equal(result.overall.leadExecutorTokenRatio, 1.5);
  save(rows); result = buildStats({ home, now: 5000, env });
  assert.equal(result.scores.groups.find(g => g.role === 'executor').insufficient, false);
  rows[2].usage = { input: 0, output: 0 }; for (let i = 1; i < 5; i++) rows[i * 5 + 2].usage = { input: 0, output: 0 };
  save(rows); assert.equal(buildStats({ home, now: 5000, env }).overall.leadExecutorTokenRatio, null);
  assert.equal(buildStats({ home, now: 5000, env: { CLAUDE_CONFIG_DIR: path.join(root, 'missing') } }).overall.leadExecutorTokenRatio, null);
});

for (const state of ['awaiting', 'conflict']) {
  test(`scores exclude ${state} tasks`, (testContext) => {
    const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-pending-'));
    testContext.after(() => rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home'), repo = path.join(root, 'repo'), dir = path.join(root, 'record');
    mkdirSync(home); mkdirSync(repo); mkdirSync(dir);
    writeFileSync(path.join(repo, 'spec.md'), '---\ntype: code\n---\n');
    const rows = [
      { event: 'start', v: 2, id: 'x', name: 'x', repo, dir, spec: 'spec.md', started: 100, profile: 'fake', worktree: true },
      { event: 'attempt', id: 'x', n: 1, profile: 'fake' },
      { event: 'attempt-end', id: 'x', n: 1, gate: true },
      { event: 'end', id: 'x', exit: 0, at: 200 },
      ...(state === 'conflict' ? [{ event: 'conflict', id: 'x' }] : []),
    ];
    writeFileSync(path.join(home, 'runs.jsonl'), rows.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
    const result = buildStats({ home, now: 1000 });
    assert.equal(result.totals.tasks, 1);
    assert.equal(result.totals.finished, 0);
    assert.deepEqual(result.scores, { groups: [], daily: [], skipped: 1 });
  });
}

test('missing score items do not contribute to count or mean', () => {
  const reports = [
    { items: [{ key: 'partial', count: 2 }, { key: 'common', count: 0 }] },
    { items: [{ key: 'common', count: 1 }] },
    { items: [{ key: 'partial', count: 4 }, { key: 'common', count: 2 }] },
  ];
  assert.deepEqual(summarizeScoreItems(reports), [
    { key: 'common', count: 3, mean: 1 },
    { key: 'partial', count: 2, mean: 3 },
  ]);
});

test('daily 与主导分组按所选任务、实际验收日和启动记录归集', (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-daily-'));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), repos = [path.join(root, 'a'), path.join(root, 'b')];
  mkdirSync(home); repos.forEach(repo => mkdirSync(repo));
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, prices: { p: { input: 1, output: 0, currency: 'USD' }, r: { input: 2, output: 0, currency: 'CNY' } } }));
  const t = new Date(2024, 0, 2, 12).getTime(), day = 86400000, now = t + 3 * day;
  const rows = [];
  for (const [i, repo, started, profile] of [[0, repos[0], t, 'p'], [1, repos[0], t + day, 'r'], [2, repos[1], t, 'missing'], [3, repos[0], t - 8 * day, 'p']]) {
    rows.push({ event: 'start', v: 2, id: String(i), repo, dir: root, started, profile, worktree: true },
      { event: 'attempt', id: String(i), n: 1, profile },
      { event: 'attempt-end', id: String(i), n: 1, gate: true, usage: { input: 1000000, output: 0 } },
      { event: 'end', id: String(i), exit: 0 },
      { event: 'accepted', id: String(i), merge: 'abc', at: t + 2 * day },
      { event: 'accepted', id: String(i), merge: 'abc', at: t + 2 * day + 1 });
  }
  rows.push({ event: 'accepted', id: '1', at: now + day });
  writeFileSync(path.join(home, 'runs.jsonl'), rows.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
  const launch = (at, project, label, model) => ({ v: 1, event: 'lead-launch', at, project, label, model });
  writeFileSync(path.join(home, 'leads.jsonl'), ['坏行', launch(t - 1, repos[0], '甲', null), launch(t - 1, repos[0], '甲', null), launch(t + 1, repos[0], '乙', 'm'), launch(t + 2 * day, repos[1], '迟到', 'x'), launch(t - 1, path.join(root, 'other'), '别的', 'x')].map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n'));
  const date = n => { const d = new Date(n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const result = buildStats({ home, now, range: '7d', project: repos[0] });
  assert.deepEqual(result.daily, [
    { date: date(t), tasks: 1, accepted: 0, cost: { USD: 1 } },
    { date: date(t + day), tasks: 1, accepted: 0, cost: { CNY: 2 } },
    { date: date(t + 2 * day), tasks: 0, accepted: 2, cost: {} },
  ]);
  assert.deepEqual(result.overall.cost, { USD: 1, CNY: 2 });
  assert.deepEqual(result.leadGroups.map(g => [g.label, g.model, g.sampleSize]), [['乙', 'm', 1], ['甲', null, 1]]);
  assert.equal(result.leadGroups[0].lead.specGateFailureRate.value, null);
  assert.equal(result.leadGroups[1].lead.dispatchToMergeMedianMs, 2 * day + 1);
  const all = buildStats({ home, now, range: '7d' });
  assert.equal(all.daily[0].cost, null);
  assert.deepEqual(all.leadGroups.find(g => g.label === null).model, null);
  assert.deepEqual(buildStats({ home, now, project: path.join(root, 'none') }).daily, []);
});

test('scores 按角色、配置、类型、强度和本地日期分别计算均值', (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-dimensions-'));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), repo = path.join(root, 'repo'); mkdirSync(home); mkdirSync(repo);
  for (const type of ['code', 'docs']) writeFileSync(path.join(repo, `${type}.md`), `---\ntype: ${type}\n---\n`);
  const t = new Date(2024, 2, 2, 12).getTime(), rows = [];
  const dimensions = [['p', 'code', 'high', 0], ['p', 'code', 'high', 0], ['q', 'code', 'high', 0], ['p', 'docs', 'high', 0], ['p', 'code', 'low', 1]];
  for (const [i, [profile, type, effort, offset]] of dimensions.entries()) {
    const id = `t${i}`, dir = path.join(root, id); mkdirSync(dir);
    rows.push({ event: 'start', v: 2, id, name: id, repo, dir, spec: `${type}.md`, started: t + offset * 86400000, profile, effort, gate: true, worktree: true },
      { event: 'attempt', id, n: 1, profile }, { event: 'attempt-end', id, n: 1, gate: true },
      { event: 'end', id, exit: 0 }, { event: 'accepted', id, at: t + offset * 86400000 + 1 });
  }
  const save = values => writeFileSync(path.join(home, 'runs.jsonl'), values.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
  save(rows);
  const result = buildStats({ home, now: t + 3 * 86400000 });
  const group = result.scores.groups.find(g => g.role === 'executor' && g.profile === 'p' && g.type === 'code' && g.effort === 'high');
  assert.equal(group.sampleSize, 2);
  assert.equal(result.scores.groups.filter(g => g.role === 'executor').length, 4);
  const individualScores = [];
  for (const id of ['t0', 't1']) {
    save(rows.filter(row => row.id === id));
    individualScores.push(buildStats({ home, now: t + 3 * 86400000 }).scores.groups.find(g => g.role === 'executor').score);
  }
  assert.equal(group.score, (individualScores[0] + individualScores[1]) / 2);
  const local = new Date(t), date = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  const daily = result.scores.daily.find(g => g.role === 'executor' && g.profile === 'p' && g.type === 'code' && g.effort === 'high');
  assert.equal(daily.date, date); assert.equal(daily.sampleSize, 2); assert.equal(daily.score, group.score);
});

test('scores 对不同维度和跨日本地日期逐组计算不同分数的均值', (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-score-groups-'));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), repo = path.join(root, 'repo');
  mkdirSync(home); mkdirSync(repo);
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, reportWeights: { outsideFile: { max: 100 }, manualRetry: { max: 100 } } }));
  for (const type of ['code', 'docs']) writeFileSync(path.join(repo, `${type}.md`), `---\ntype: ${type}\n---\n`);
  const dates = [new Date(2024, 2, 2, 12), new Date(2024, 2, 3, 12)];
  const dimensions = [['p', 'code', 'high', 0], ['p', 'code', 'high', 0], ['q', 'code', 'high', 1], ['p', 'docs', 'low', 1], ['p', 'code', 'high', 1]];
  const rows = [];
  for (const [i, [profile, type, effort, day]] of dimensions.entries()) {
    const id = `score${i}`, dir = path.join(root, id), started = dates[day].getTime();
    const attemptDir = path.join(dir, 'attempts', '1');
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(path.join(attemptDir, 'gate.json'), JSON.stringify({ scope: { outside: Array.from({ length: i }, (_, n) => `outside${n}`), protected: [] } }));
    rows.push({ event: 'start', v: 2, id, name: id, repo, dir, spec: `${type}.md`, started, profile, effort, gate: true, worktree: true },
      { event: 'attempt', id, n: 1, reason: 'first', profile }, { event: 'attempt-end', id, n: 1, gate: true });
    for (let n = 2; n <= i + 1; n++) rows.push({ event: 'attempt', id, n, reason: 'manual', profile }, { event: 'attempt-end', id, n, gate: true });
    rows.push({ event: 'end', id, exit: 0, at: started + 1 }, { event: 'accepted', id, at: started + 2 });
  }
  writeFileSync(path.join(home, 'runs.jsonl'), rows.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
  const result = buildStats({ home, now: new Date(2024, 2, 4, 12).getTime(), env: { AGENT_ROUTER_HOME: home } });
  const fields = ({ role, profile, type, effort, sampleSize, score }) => ({ role, profile, type, effort, sampleSize, score });
  const expectedGroups = role => [
    { role, profile: 'p', type: 'code', effort: 'high', sampleSize: 3, score: 250 / 3 },
    { role, profile: 'p', type: 'docs', effort: 'low', sampleSize: 1, score: 70 },
    { role, profile: 'q', type: 'code', effort: 'high', sampleSize: 1, score: 80 },
  ];
  assert.equal(result.scores.skipped, 0);
  assert.deepEqual(result.scores.groups.map(fields), [...expectedGroups('executor'), ...expectedGroups('lead')]);
  const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const expectedDaily = role => [
    { role, profile: 'p', type: 'code', effort: 'high', date: localDate(dates[0]), sampleSize: 2, score: 95 },
    { role, profile: 'p', type: 'code', effort: 'high', date: localDate(dates[1]), sampleSize: 1, score: 60 },
    { role, profile: 'p', type: 'docs', effort: 'low', date: localDate(dates[1]), sampleSize: 1, score: 70 },
    { role, profile: 'q', type: 'code', effort: 'high', date: localDate(dates[1]), sampleSize: 1, score: 80 },
  ];
  assert.deepEqual(result.scores.daily.map(({ date, ...group }) => ({ ...fields(group), date })), [...expectedDaily('executor'), ...expectedDaily('lead')]);
});

test('旧公共目录不存在或存在时都不算额外来源：extraSources 与 skippedSources 只含 statsSources 里的目录（427 审查 R2-1）', (testContext) => {
  const base = mkdtempSync(path.join(tmpdir(), 'ar-stats-legacy-'));
  testContext.after(() => rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'agent-router'), legacy = path.join(base, 'codex-dispatch');
  mkdirSync(home);
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, profiles: {} }));
  const missing = buildStats({ home: [home, legacy], env: {} });
  assert.deepEqual(missing.extraSources, []);
  assert.deepEqual(missing.skippedSources, []);
  mkdirSync(legacy);
  writeFileSync(path.join(legacy, 'runs.jsonl'), '');
  const present = buildStats({ home: [home, legacy], env: {} });
  assert.deepEqual(present.extraSources, []);
  assert.deepEqual(present.skippedSources, []);
});
