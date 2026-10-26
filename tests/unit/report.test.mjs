import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport, leadUsage, notSpecTask, reportLines, scoreRole, setBlame, stillRunning } from '../../core/lib/report.mjs';
import { configCommand, leadUsageSetting, priceTable, reportWeightDefaults, reportWeights } from '../../core/lib/config.mjs';

// 089：ar report 的单元测试。清单、任务目录、会话记录都是测试自己在临时目录里构造的假数据；
// 需要 git 的用例（任务说明的提交数）用临时目录里的真实仓库。不碰真实公共目录与真实 ~/.claude。
const temp = t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar 报告单元 '));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};
const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const T0 = Date.now() - 3600 * 1000;
const FAKE_BASE = 'a'.repeat(40);

// 构造一个任务：公共目录（runs.jsonl、config.json）、项目目录里的任务记录目录（events.jsonl、attempts/<n>/gate.json、marks.json）。
// attempts 的每一项：{ n, reason, profile, gate（true / false / null）, exit, usage, ms, gateFile, needsScope, outsideWrites }。
function scene(t, {
  name = '任务甲', spec = 'docs/specs/001-甲.md', worktree = false, text = false, profile = 'deepseek', attempts = [], end = { exit: 0 },
  extra = [], events = [], config = null, base = FAKE_BASE, marks = null, session = 'sess-089-aaaa', repo = null,
} = {}) {
  const dir = temp(t);
  const home = path.join(dir, '公共 目录');
  const root = repo ?? path.join(dir, '项目');
  mkdirSync(root, { recursive: true });
  const record = path.join(root, '.agent-runs', name);
  mkdirSync(record, { recursive: true });
  const id = `r-${name}`;
  let tick = 0;
  const rows = [];
  const row = (event, fields = {}) => { tick += 1000; rows.push({ v: 1, event, id, at: T0 + tick, ...fields }); };
  rows.push({
    v: 2, event: 'start', id, repo: root, name, spec: text ? null : spec, title: '假标题', role: null, pid: process.pid, started: T0, dir: record,
    events: path.join(record, 'events.jsonl'), project: path.basename(root), profile, adapter: 'fake',
    ...(text ? {} : { gate: true, base }), ...(worktree ? { worktree: true } : {}), dispatcher: { host: 'claude-code', session },
  });
  if (worktree) { row('preparing'); row('worktree', { dir: path.join(dir, 'wt'), branch: `ar/${name}`, base }); row('setup', { ok: true, ms: 1, summary: '无' }); }
  for (const a of attempts) {
    row('attempt', { n: a.n, total: 3, profile: a.profile ?? profile, reason: a.reason ?? 'first' });
    if (a.gateFile) put(path.join(record, 'attempts', String(a.n), 'gate.json'), JSON.stringify({ v: 1, attempt: a.n, ok: a.gate === true, summary: '门禁摘要', ...a.gateFile }));
    if (typeof a.gate === 'boolean') row('gate', { ok: a.gate, attempt: a.n, summary: a.gateFile?.summary ?? '门禁摘要' });
    row('attempt-end', {
      n: a.n, ok: (a.exit ?? 0) === 0 && a.gate !== false, exit: a.exit ?? 0, gate: a.gate ?? null,
      usage: a.usage ?? { input: null, output: null }, ms: a.ms ?? 1000,
      ...(a.needsScope ? { needsScope: a.needsScope } : {}), ...(a.outsideWrites ? { outsideWrites: a.outsideWrites } : {}),
    });
  }
  if (end) row('end', { exit: end.exit, minutes: 1, attempts: attempts.length, ...(end.exit === 0 ? { agentExit: 0 } : {}) });
  for (const item of extra) row(item.event, item);
  put(path.join(home, 'runs.jsonl'), rows.map(item => `${JSON.stringify(item)}\n`).join(''));
  if (events.length) put(path.join(record, 'events.jsonl'), events.map(item => `${JSON.stringify({ v: 1, ...item })}\n`).join(''));
  if (config) put(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true } }, ...config }));
  if (marks) put(path.join(record, 'marks.json'), JSON.stringify(marks));
  const f = { dir, home, root, record, id, name };
  f.report = (env = {}) => buildReport({ home, root, name, env });
  return f;
}
const item = (role, key) => role.items.find(entry => entry.key === key);
const brief = role => role.items.map(entry => [entry.key, entry.count, entry.points]);

test('scoreRole：按项扣分，超过上限只扣上限（越界 4 个 → −30），最低 0，不超过 cap', () => {
  const weights = reportWeightDefaults.executor;
  const result = scoreRole([{ key: 'outsideFile', count: 4, detail: 'a、b' }, { key: 'attemptGate', count: 1 }], weights);
  assert.deepEqual(result.items, [
    { key: 'outsideFile', count: 4, points: -30, detail: 'a、b' },
    { key: 'attemptGate', count: 1, points: -15, detail: null },
  ]);
  assert.equal(result.score, 55);
  assert.equal(scoreRole([{ key: 'attemptAgent', count: 9 }], weights).score, 0, '最低 0');
  assert.equal(scoreRole([{ key: 'attemptGate', count: 1 }], weights, 40).score, 40, '失败封顶 40');
  assert.equal(scoreRole([{ key: 'attemptGate', count: 1 }], weights, 60).score, 60, '驳回封顶 60');
  assert.equal(scoreRole([{ key: 'attemptGate', count: 3 }], weights, 60).score, 55, '封顶只压低不抬高');
  const none = scoreRole([{ key: 'attemptGate', count: 0 }], weights);
  assert.equal(Object.is(none.items[0].points, 0), true, '没扣分是 0，不是 −0');
  assert.equal(none.score, 100);
});

test('每个 key 的计数与扣分：执行者九项、主导七项（末尾各一项 envBlame），顺序同协议', t => {
  const f = scene(t, {
    attempts: [
      { n: 1, reason: 'first', gate: false, gateFile: { scope: { outside: ['a.js', 'b.js', '.agent-router/project.json'], protected: ['.agent-router/project.json'] }, outsideWrites: { checked: true, added: [{ root: 'home', name: 'x.txt', type: 'file' }] } } },
      { n: 2, reason: 'gate', gate: false, gateFile: { scope: { outside: ['a.js'], protected: [] } } },
      { n: 3, reason: 'agent', exit: 1 },
      { n: 4, reason: 'gate', profile: 'sonnet', gate: true, needsScope: [{ path: 'src/z.js', reason: null }] },
      { n: 5, reason: 'manual', gate: true },
    ],
    events: [
      { kind: 'cmd', phase: 'start', id: 'c1', command: 'ls' }, { kind: 'cmd', phase: 'end', id: 'c1', exit: 0 },
      { kind: 'cmd', phase: 'start', id: 'c2', command: 'bad' }, { kind: 'cmd', phase: 'end', id: 'c2', exit: 1 },
      { kind: 'tool', name: 'search', detail: 'x' }, { kind: 'tool', name: 'search', detail: 'y' },
      { kind: 'error', text: '出错一' }, { kind: 'error', text: '出错二' }, { kind: 'say', text: '说话不算' },
    ],
  });
  const report = f.report();
  assert.deepEqual(report.executor.items.map(entry => entry.key), ['attemptGate', 'attemptAgent', 'outsideFile', 'protectedFile', 'outsideWrites', 'escalated', 'toolError', 'needsScope', 'envBlame']);
  assert.deepEqual(brief(report.executor), [
    ['attemptGate', 2, -30], ['attemptAgent', 1, -20], ['outsideFile', 2, -20], ['protectedFile', 1, -15],
    ['outsideWrites', 1, -20], ['escalated', 1, -10], ['toolError', 3, -3], ['needsScope', 1, 0], ['envBlame', 0, 0],
  ]);
  assert.equal(item(report.executor, 'outsideFile').detail, 'a.js、b.js', '受保护的路径不算超出范围的文件');
  assert.equal(item(report.executor, 'protectedFile').detail, '.agent-router/project.json');
  assert.equal(item(report.executor, 'outsideWrites').detail, 'home/x.txt');
  assert.equal(item(report.executor, 'escalated').detail, 'deepseek → sonnet');
  assert.equal(item(report.executor, 'needsScope').detail, 'src/z.js');
  assert.equal(report.executor.score, 0, '扣分合计超过 100 最低 0');
  assert.equal(report.executor.cap, null);
  assert.deepEqual(report.lead.items.map(entry => entry.key), ['specEdit', 'specBlame', 'manualRetry', 'needsScope', 'rejected', 'conflict', 'envBlame']);
  assert.deepEqual(brief(report.lead), [['specEdit', 0, 0], ['specBlame', 0, 0], ['manualRetry', 1, -10], ['needsScope', 1, -10], ['rejected', 0, 0], ['conflict', 0, 0], ['envBlame', 0, 0]]);
  assert.equal(report.lead.score, 80);
  assert.deepEqual(report.executor.perf.profiles, ['deepseek', 'sonnet']);
  assert.equal(report.executor.perf.toolCalls, 4, 'cmd 开始 2 + tool 2');
  assert.deepEqual(report.attempts.map(a => [a.n, a.reason, a.profile, a.exit, a.gate, a.blame]), [
    [1, 'first', 'deepseek', 0, false, 'worker'], [2, 'gate', 'deepseek', 0, false, 'worker'], [3, 'agent', 'deepseek', 1, null, null],
    [4, 'gate', 'sonnet', 0, true, null], [5, 'manual', 'deepseek', 0, true, null],
  ]);
  assert.equal(report.attempts[0].summary, '门禁摘要');
  assert.equal(report.attempts[2].summary, null, '没跑门禁的尝试没有摘要');
});

test('手动重试、冲突解决、重新基线的尝试不算执行者的重试；主导手动重试最多 −30', t => {
  const f = scene(t, {
    attempts: [
      { n: 1, reason: 'first', gate: false }, { n: 2, reason: 'manual', gate: false }, { n: 3, reason: 'manual', gate: false },
      { n: 4, reason: 'manual', gate: false }, { n: 5, reason: 'manual', gate: false }, { n: 6, reason: 'conflict', gate: true }, { n: 7, reason: 'rebase', gate: true },
    ],
  });
  const report = f.report();
  assert.equal(item(report.executor, 'attemptGate').count, 0);
  assert.equal(item(report.executor, 'attemptAgent').count, 0);
  assert.deepEqual([item(report.lead, 'manualRetry').count, item(report.lead, 'manualRetry').points], [4, -30]);
});

test('封顶：任务最终失败最多 40 分，被驳回最多 60 分；被停止的不封顶', t => {
  const failed = scene(t, { name: '失败的', attempts: [{ n: 1, reason: 'first', gate: false }, { n: 2, reason: 'gate', gate: false }], end: { exit: 3 } }).report();
  assert.equal(failed.state, 'failed');
  assert.equal(failed.executor.cap, 'failed');
  assert.equal(failed.executor.score, 40, '100 − 15 = 85，封顶到 40');
  assert.equal(failed.lead.score, 100, '封顶只管执行者');

  const rejected = scene(t, {
    name: '驳回的', worktree: true, attempts: [{ n: 1, reason: 'first', gate: true }], extra: [{ event: 'rejected', reason: '不要了', keptBranch: false, by: 'cli' }],
  }).report();
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.executor.cap, 'rejected');
  assert.equal(rejected.executor.score, 60);
  assert.deepEqual([item(rejected.lead, 'rejected').count, item(rejected.lead, 'rejected').points], [1, -20]);
  assert.equal(rejected.lead.score, 80);

  const stopped = scene(t, { name: '停止的', attempts: [{ n: 1, reason: 'first', gate: false }], end: null, extra: [{ event: 'interrupted', signal: 'stopped-by-command' }] }).report();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.executor.cap, null);
  assert.equal(stopped.executor.score, 100);
});

test('归因到任务说明：有第 n+1 次时扣分从执行者移到主导；没有第 n+1 次时只算主导', t => {
  const withNext = {
    attempts: [{ n: 1, reason: 'first', gate: false }, { n: 2, reason: 'gate', gate: true }],
    marks: { v: 1, blame: { 1: 'spec' } },
  };
  const plain = scene(t, { name: '无归因', attempts: withNext.attempts }).report();
  assert.equal(plain.executor.score, 85);
  assert.equal(plain.lead.score, 100);
  assert.equal(plain.attempts[0].blame, 'worker');

  const blamed = scene(t, { name: '有下一次', ...withNext }).report();
  assert.equal(item(blamed.executor, 'attemptGate').count, 0);
  assert.equal(blamed.executor.score, 100);
  assert.deepEqual([item(blamed.lead, 'specBlame').count, item(blamed.lead, 'specBlame').points], [1, -15]);
  assert.equal(blamed.lead.score, 85);
  assert.equal(blamed.attempts[0].blame, 'spec');
  assert.equal(blamed.attempts[1].blame, null, '通过的尝试没有归因');

  const last = scene(t, { name: '没有下一次', attempts: [{ n: 1, reason: 'first', gate: false }], end: { exit: 3 }, marks: { v: 1, blame: { 1: 'spec' } } }).report();
  assert.equal(item(last.executor, 'attemptGate').count, 0);
  assert.equal(last.executor.score, 40, '失败封顶仍生效');
  assert.equal(last.lead.score, 85);

  // 标记里指向门禁通过的尝试、或不存在的尝试的编号不算。
  const stale = scene(t, { name: '多余标记', attempts: withNext.attempts, marks: { v: 1, blame: { 2: 'spec', 9: 'spec' } } }).report();
  assert.equal(item(stale.lead, 'specBlame').count, 0);
  assert.equal(stale.lead.score, 100);
  // 标记文件坏了当作没有。
  const bad = scene(t, { name: '坏标记', attempts: withNext.attempts });
  put(path.join(bad.record, 'marks.json'), '{坏的');
  assert.equal(bad.report().executor.score, 85);
});

test('setBlame：只对门禁未通过的尝试；写 marks.json（先临时文件再改名）；worker 删掉这个键', t => {
  const f = scene(t, { attempts: [{ n: 1, reason: 'first', gate: false }, { n: 2, reason: 'gate', gate: false }, { n: 3, reason: 'gate', gate: true }] });
  const marks = () => JSON.parse(readFileSync(path.join(f.record, 'marks.json'), 'utf8'));
  const args = { home: f.home, root: f.root, name: f.name };
  assert.throws(() => setBlame({ ...args, n: 3, blame: 'spec' }), /第 3 次尝试的门禁没有失败/);
  assert.throws(() => setBlame({ ...args, n: 9, blame: 'spec' }), /第 9 次尝试的门禁没有失败/);
  assert.throws(() => setBlame({ ...args, n: 1, blame: 'lead' }), /spec、worker 或 environment/);
  assert.throws(() => setBlame({ ...args, n: 0, blame: 'spec' }), /正整数/);
  assert.equal(existsSync(path.join(f.record, 'marks.json')), false, '被拒绝时什么都不写');

  setBlame({ ...args, n: 1, blame: 'spec' });
  assert.deepEqual(marks(), { v: 1, blame: { 1: 'spec' } });
  setBlame({ ...args, n: 2, blame: 'spec' });
  assert.deepEqual(marks(), { v: 1, blame: { 1: 'spec', 2: 'spec' } });
  setBlame({ ...args, n: 1, blame: 'worker' });
  assert.deepEqual(marks(), { v: 1, blame: { 2: 'spec' } }, 'worker 是默认，写 worker 删掉这个键');
  assert.deepEqual(readdirSync(f.record).filter(entry => entry.includes('.tmp')), [], '没有残留的临时文件');
  assert.equal(f.report().attempts.find(a => a.n === 2).blame, 'spec');
});

test('归因到环境：两边都不扣分，两张卡片的 envBlame 各记次数（分数列恒为 0）', t => {
  const attempts = [{ n: 1, reason: 'first', gate: false }, { n: 2, reason: 'gate', gate: true }];
  const worker = scene(t, { name: '归执行者', attempts }).report();
  const env = scene(t, { name: '归环境', attempts, marks: { v: 1, blame: { 1: 'environment' } } }).report();
  const spec = scene(t, { name: '归说明', attempts, marks: { v: 1, blame: { 1: 'spec' } } }).report();

  assert.deepEqual([worker.executor.score, worker.lead.score], [85, 100]);
  assert.deepEqual([spec.executor.score, spec.lead.score], [100, 85]);
  assert.deepEqual([env.executor.score, env.lead.score], [100, 100], '环境：执行者不扣多一次尝试，主导也不扣');
  assert.deepEqual([item(env.executor, 'attemptGate').count, item(env.executor, 'attemptGate').points], [0, 0]);
  assert.deepEqual([item(env.lead, 'specBlame').count, item(env.lead, 'specBlame').points], [0, 0]);
  for (const role of [env.executor, env.lead]) assert.deepEqual(item(role, 'envBlame'), { key: 'envBlame', count: 1, points: 0, detail: null });
  for (const role of [worker.executor, worker.lead, spec.executor, spec.lead]) assert.equal(item(role, 'envBlame').count, 0);
  assert.equal(env.attempts[0].blame, 'environment');
  assert.equal(spec.attempts[0].blame, 'spec');
  assert.equal(worker.attempts[0].blame, 'worker');
  assert.equal(env.executor.items.at(-1).key, 'envBlame', '执行者一节放在最后（"需要越界"之后）');
  assert.equal(env.lead.items.at(-1).key, 'envBlame', '主导一节放在最后（验收结论之后）');

  // 没有下一次尝试：只是不扣，失败封顶照旧。
  const last = scene(t, { name: '没有下一次', attempts: [{ n: 1, reason: 'first', gate: false }], end: { exit: 3 }, marks: { v: 1, blame: { 1: 'environment' } } }).report();
  assert.deepEqual([last.executor.score, last.lead.score, item(last.lead, 'envBlame').count], [40, 100, 1]);

  // 文字输出：中文名"环境原因"，两节各一行。
  const lines = reportLines(env);
  assert.equal(lines.filter(entry => entry === '  环境原因：1 次（0）').length, 2, lines.join('\n'));
  assert.ok(reportLines(worker).includes('  环境原因：0 次（0）'));
});

test('归因混合：第 1 次 environment、第 2 次 spec；执行者两次的"多一次尝试"都不扣，主导只扣 spec', t => {
  const attempts = [{ n: 1, reason: 'first', gate: false }, { n: 2, reason: 'gate', gate: false }, { n: 3, reason: 'gate', gate: true }];
  const mixed = scene(t, { name: '混合', attempts, marks: { v: 1, blame: { 1: 'environment', 2: 'spec' } } }).report();
  assert.equal(item(mixed.executor, 'attemptGate').count, 0, '第 2、3 次的 reason 都是 gate，前一次都被归因了');
  assert.equal(mixed.executor.score, 100);
  assert.deepEqual([item(mixed.lead, 'specBlame').count, item(mixed.lead, 'specBlame').points], [1, -15]);
  assert.deepEqual([item(mixed.lead, 'envBlame').count, item(mixed.lead, 'envBlame').points], [1, 0]);
  assert.equal(mixed.lead.score, 85);
  assert.deepEqual(mixed.attempts.map(a => a.blame), ['environment', 'spec', null]);

  // 只归因第 1 次到环境：第 2 次门禁失败仍算执行者的，第 3 次（reason: gate）也算一次。
  const half = scene(t, { name: '只一半', attempts, marks: { v: 1, blame: { 1: 'environment' } } }).report();
  assert.equal(item(half.executor, 'attemptGate').count, 1);
  assert.equal(half.executor.score, 85);
  assert.equal(half.lead.score, 100);
});

test('归因时那次尝试的越界、受保护路径、工作区外写入一并不算执行者的，也不转给主导', t => {
  const attempts = [
    { n: 1, reason: 'first', gate: false, gateFile: { scope: { outside: ['a.txt'], protected: ['docs/specs/001-x.md'] }, outsideWrites: { checked: true, added: [{ root: 'home', name: 'x.txt', type: 'file' }] } } },
    { n: 2, reason: 'gate', gate: true },
  ];
  const three = role => ['outsideFile', 'protectedFile', 'outsideWrites'].map(key => item(role, key).count);
  const plain = scene(t, { name: '不归因', attempts }).report();
  assert.deepEqual(three(plain.executor), [1, 1, 1]);

  const spec = scene(t, { name: '归说明', attempts, marks: { v: 1, blame: { 1: 'spec' } } }).report();
  assert.deepEqual(three(spec.executor), [0, 0, 0]);
  assert.equal(spec.executor.score, 100);
  assert.deepEqual([item(spec.lead, 'specBlame').count, item(spec.lead, 'specBlame').points], [1, -15]);
  assert.equal(spec.lead.score, 85);
  assert.deepEqual(spec.lead.items.map(entry => [entry.key, entry.count, entry.points]), plain.lead.items.map(entry => entry.key === 'specBlame' ? [entry.key, 1, -15] : [entry.key, entry.count, entry.points]));

  const env = scene(t, { name: '归环境', attempts, marks: { v: 1, blame: { 1: 'environment' } } }).report();
  assert.deepEqual(three(env.executor), [0, 0, 0]);
  assert.deepEqual([env.executor.score, env.lead.score], [100, 100]);
  for (const role of [env.executor, env.lead]) assert.deepEqual(item(role, 'envBlame'), { key: 'envBlame', count: 1, points: 0, detail: null });
});

test('归因只移走被归因那次的越界：另一次未被归因的尝试里还有同一路径，仍然算', t => {
  const out = (n, reason, file, gate) => ({ n, reason, gate, gateFile: { scope: { outside: [file], protected: [] } } });
  const same = scene(t, { name: '同一路径', attempts: [out(1, 'first', 'a.txt', false), out(2, 'gate', 'a.txt', false), { n: 3, reason: 'gate', gate: true }], marks: { v: 1, blame: { 1: 'spec' } } }).report();
  assert.equal(item(same.executor, 'outsideFile').count, 1);
  assert.equal(item(same.executor, 'outsideFile').detail, 'a.txt');

  const diff = scene(t, { name: '不同路径', attempts: [out(1, 'first', 'a.txt', false), out(2, 'gate', 'b.txt', false), { n: 3, reason: 'gate', gate: true }], marks: { v: 1, blame: { 1: 'spec' } } }).report();
  assert.equal(item(diff.executor, 'outsideFile').count, 1);
  assert.equal(item(diff.executor, 'outsideFile').detail, 'b.txt');
});

test('marks.json 里的未知值当作没有；多余的编号不算；其他合法项照常读', t => {
  const attempts = [{ n: 1, reason: 'first', gate: false }, { n: 2, reason: 'gate', gate: false }, { n: 3, reason: 'gate', gate: true }];
  const f = scene(t, { name: '未知值', attempts, marks: { v: 1, blame: { 1: 'lead', 2: 'environment', 3: 'environment', 9: 'environment' } } }).report();
  assert.deepEqual(f.attempts.map(a => a.blame), ['worker', 'environment', null], '未知值 lead 当作默认 worker；门禁通过与不存在的尝试不算');
  assert.equal(item(f.lead, 'envBlame').count, 1);
  assert.equal(item(f.executor, 'attemptGate').count, 1, '第 2 次被归因到环境，只免掉第 3 次');
  const other = scene(t, { name: '大小写', attempts, marks: { v: 1, blame: { 1: 'Environment', 2: 'ENV', 3: 5 } } }).report();
  assert.deepEqual(other.attempts.map(a => a.blame), ['worker', 'worker', null]);
  assert.equal(item(other.lead, 'envBlame').count, 0);
});

test('setBlame：environment 写入；写一项时保留其他项原有的值；worker 只删自己这一项', t => {
  const f = scene(t, { attempts: [{ n: 1, reason: 'first', gate: false }, { n: 2, reason: 'gate', gate: false }, { n: 3, reason: 'gate', gate: false }] });
  const marks = () => JSON.parse(readFileSync(path.join(f.record, 'marks.json'), 'utf8'));
  const args = { home: f.home, root: f.root, name: f.name };
  setBlame({ ...args, n: 2, blame: 'spec' });
  setBlame({ ...args, n: 1, blame: 'environment' });
  assert.deepEqual(marks(), { v: 1, blame: { 1: 'environment', 2: 'spec' } }, '第 1 次改成 environment 不抹掉第 2 次的 spec');
  assert.deepEqual(Object.keys(marks().blame), ['1', '2'], '按编号排序');
  setBlame({ ...args, n: 3, blame: 'environment' });
  setBlame({ ...args, n: 2, blame: 'environment' });
  assert.deepEqual(marks(), { v: 1, blame: { 1: 'environment', 2: 'environment', 3: 'environment' } }, '同一项可以从 spec 改成 environment');
  setBlame({ ...args, n: 1, blame: 'worker' });
  assert.deepEqual(marks(), { v: 1, blame: { 2: 'environment', 3: 'environment' } });
  setBlame({ ...args, n: 2, blame: 'spec' });
  assert.deepEqual(marks(), { v: 1, blame: { 2: 'spec', 3: 'environment' } });
  assert.deepEqual(readdirSync(f.record).filter(entry => entry.includes('.tmp')), [], '没有残留的临时文件');
  assert.throws(() => setBlame({ ...args, n: 1, blame: 'Environment' }), /spec、worker 或 environment/);
  assert.deepEqual(marks(), { v: 1, blame: { 2: 'spec', 3: 'environment' } }, '被拒绝时不改');
});

test('reportWeights：改一项后生效；形状不对或不是正数的值按默认并给出警告', t => {
  const attempts = [{ n: 1, reason: 'first', gate: false }, { n: 2, reason: 'gate', gate: true }];
  const custom = scene(t, { name: '自定义', attempts, config: { reportWeights: { attemptGate: { points: 5 }, outsideFile: { max: 12 }, specBlame: { points: 40 }, capFailed: 30 } } }).report();
  assert.equal(item(custom.executor, 'attemptGate').points, -5);
  assert.equal(custom.executor.score, 95);
  assert.deepEqual(custom.weights.executor.outsideFile, { points: 10, max: 12 });
  assert.equal(custom.weights.capFailed, 30);
  assert.equal(custom.weights.capRejected, 60);
  assert.equal(custom.weights.lead.specBlame.points, 40);
  assert.equal(custom.warnings, undefined, '合法的配置没有警告');

  const wrong = scene(t, { name: '不合法', attempts, config: { reportWeights: { attemptGate: { points: -3 }, attemptAgent: { points: '9' }, nope: { points: 1 }, capRejected: 0, toolError: 7 } } }).report();
  assert.equal(item(wrong.executor, 'attemptGate').points, -15, '负数按默认');
  assert.equal(wrong.weights.executor.attemptAgent.points, 20);
  assert.equal(wrong.weights.capRejected, 60);
  assert.equal(wrong.warnings.length, 5, wrong.warnings.join('\n'));
  assert.ok(wrong.warnings.some(line => line.includes('reportWeights.nope')));
  assert.ok(reportLines(wrong)[0].startsWith('配置：reportWeights'), '文字输出开头列出警告');

  for (const bad of ['x', [], null, 5]) {
    const value = reportWeights({ reportWeights: bad });
    assert.deepEqual(value.weights, reportWeights({}).weights, JSON.stringify(bad));
    assert.deepEqual(value.warnings, ['配置：reportWeights 必须为对象，已按默认处理']);
  }
  assert.deepEqual(reportWeights({}), { weights: reportWeights({}).weights, custom: 0, source: '内置默认', warnings: [] });
  // 同名的 needsScope 只改主导的那一项。
  const scope = reportWeights({ reportWeights: { needsScope: { points: 3 } } }).weights;
  assert.equal(scope.lead.needsScope.points, 3);
  assert.equal(scope.executor.needsScope.points, 0);
  // 原型上的名字不是已知的扣分项。
  assert.equal(reportWeights({ reportWeights: JSON.parse('{"toString":{"points":1},"__proto__":{"points":1}}') }).warnings.length, 2);
  assert.equal(Object.isFrozen(reportWeightDefaults), true);
  assert.equal(reportWeights({ reportWeights: { attemptGate: { points: 1 } } }).weights.executor.attemptGate.points, 1);
  assert.equal(reportWeightDefaults.executor.attemptGate.points, 15, '改配置不动内置默认');
});

test('估算费用：正常；缺价格、缺 usage、币种不一致都是 null；无关的 rebase 尝试不要求 usage', t => {
  const usage = { input: 1000000, output: 500000 };
  const prices = { deepseek: { input: 2, output: 8, currency: 'CNY' }, sonnet: { input: 3, output: 15, currency: 'CNY' }, dollar: { input: 1, output: 1, currency: 'USD' } };
  const costOf = (name, attempts, config = { prices }) => scene(t, { name, attempts, config }).report().executor.perf;

  const ok = costOf('正常', [{ n: 1, gate: false, usage }, { n: 2, reason: 'gate', profile: 'sonnet', gate: true, usage: { input: 2000000, output: 0 } }]);
  assert.deepEqual(ok.cost, { amount: 2 + 4 + 6, currency: 'CNY' }, '每次尝试按自己的 profile 与 usage 分别算再相加');
  assert.deepEqual(ok.usage, { input: 3000000, output: 500000 });
  assert.equal(ok.ms, 2000);

  assert.equal(costOf('缺价格', [{ n: 1, gate: true, usage, profile: 'unknown' }]).cost, null);
  assert.equal(costOf('一次缺价格', [{ n: 1, gate: false, usage }, { n: 2, reason: 'gate', profile: 'unknown', gate: true, usage }]).cost, null);
  assert.equal(costOf('缺 usage', [{ n: 1, gate: true }]).cost, null);
  assert.equal(costOf('缺 usage 的一半', [{ n: 1, gate: true, usage: { input: 5, output: null } }]).cost, null);
  assert.equal(costOf('币种不一致', [{ n: 1, gate: false, usage }, { n: 2, reason: 'gate', profile: 'dollar', gate: true, usage }]).cost, null);
  assert.equal(costOf('没有 prices', [{ n: 1, gate: true, usage }], {}).cost, null);
  assert.equal(costOf('没有 prices', [{ n: 1, gate: true, usage }], null).usage.input, 1000000);
  const noUsage = costOf('全没有用量', [{ n: 1, gate: true }], null);
  assert.equal(noUsage.usage, null, '全为 null 时 usage 为 null');
  const rebase = costOf('重新基线', [{ n: 1, gate: true, usage }, { n: 2, reason: 'rebase', gate: true }]);
  assert.deepEqual(rebase.cost, { amount: 6, currency: 'CNY' });

  // prices 的校验。
  assert.deepEqual(priceTable({}), { prices: {}, source: '内置默认', warnings: [] });
  const checked = priceTable({ prices: { a: { input: 1, output: 2, currency: 'USD' }, b: { input: -1, output: 2, currency: 'USD' }, c: { input: 1, output: 2, currency: 'EUR' }, d: 5 } });
  assert.deepEqual(Object.keys(checked.prices), ['a']);
  assert.equal(checked.warnings.length, 3);
  assert.deepEqual(priceTable({ prices: [] }).warnings, ['配置：prices 必须为对象，已忽略']);
});

test('非 worktree 任务：验收两项写"不用 worktree，没有验收"；worktree 任务待验收、冲突时写"还没验收"', t => {
  const plain = scene(t, { name: '普通', attempts: [{ n: 1, gate: true }] }).report();
  for (const key of ['rejected', 'conflict']) {
    assert.deepEqual([item(plain.lead, key).count, item(plain.lead, key).points, item(plain.lead, key).detail], [0, 0, '不用 worktree，没有验收']);
  }
  assert.equal(plain.state, 'done');
  assert.equal(plain.lead.perf.awaitMs, null);
  assert.match(reportLines(plain).join('\n'), /^  驳回：不用 worktree，没有验收（0）$/m);

  const awaiting = scene(t, { name: '待验收', worktree: true, attempts: [{ n: 1, gate: true }] }).report();
  assert.equal(awaiting.state, 'awaiting');
  assert.deepEqual([item(awaiting.lead, 'rejected').count, item(awaiting.lead, 'rejected').detail, awaiting.lead.score], [0, '还没验收', 100]);
  assert.equal(item(awaiting.lead, 'conflict').detail, null);

  const conflict = scene(t, { name: '冲突', worktree: true, attempts: [{ n: 1, gate: true }], extra: [{ event: 'conflict', files: ['a.js'] }] }).report();
  assert.equal(conflict.state, 'conflict');
  assert.deepEqual([item(conflict.lead, 'conflict').count, item(conflict.lead, 'conflict').points], [1, -5]);
  assert.equal(item(conflict.lead, 'rejected').detail, '还没验收');
  assert.equal(conflict.lead.score, 95);

  // 合并之后：等待验收的时间 = 进入待验收到 accepted 的时间。
  const accepted = scene(t, { name: '已合并', worktree: true, attempts: [{ n: 1, gate: true }], extra: [{ event: 'accepted', merge: 'b'.repeat(40), mode: 'no-ff', by: 'cli' }] }).report();
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.lead.perf.awaitMs, 1000);
  assert.equal(accepted.lead.perf.ms, 7000, '主导用时是 start 到最后一条 end');
});

test('129 已撤销的合并：评分不变，只在"驳回"项的说明里写"已撤销（提交 xxxxxxx）"；文字输出同样带出', t => {
  const merge = { event: 'accepted', merge: 'b'.repeat(40), mode: 'no-ff', by: 'cli' };
  const plain = scene(t, { name: '合并未撤销', worktree: true, attempts: [{ n: 1, gate: true }], extra: [merge] }).report();
  const reverted = scene(t, { name: '合并已撤销', worktree: true, attempts: [{ n: 1, gate: true }], extra: [merge, { event: 'reverted', commit: 'e'.repeat(40), by: 'human' }] }).report();
  assert.equal(reverted.state, 'accepted');
  assert.equal(item(plain.lead, 'rejected').detail, null, '没撤销时没有说明');
  assert.deepEqual([item(reverted.lead, 'rejected').count, item(reverted.lead, 'rejected').points, item(reverted.lead, 'rejected').detail], [0, 0, '已撤销（提交 eeeeeee）']);
  assert.equal(reverted.lead.score, plain.lead.score);
  assert.equal(reverted.executor.score, plain.executor.score);
  assert.deepEqual(brief(reverted.lead), brief(plain.lead), '撤销不改任何一项的计数与扣分');
  assert.match(reportLines(reverted).join('\n'), /^ {2}驳回：已撤销（提交 eeeeeee）（0）$/m);
  // 只看 accepted 之后的 reverted：之前的不算（不会发生，但读法要确定）。
  const before = scene(t, { name: '撤销在前', worktree: true, attempts: [{ n: 1, gate: true }], extra: [{ event: 'reverted', commit: 'e'.repeat(40), by: 'human' }, merge] }).report();
  assert.equal(item(before.lead, 'rejected').detail, null);
});

test('被拒绝时的原文：找不到记录、进行中、直接文字派发的任务、旧任务', t => {
  const running = scene(t, { name: '进行中', attempts: [{ n: 1, gate: true }], end: null });
  assert.throws(() => running.report(), error => error.message === stillRunning && stillRunning === '任务还在进行，结束后才有评分');
  const queued = scene(t, { name: '准备中', worktree: true, attempts: [], end: null });
  assert.throws(() => queued.report(), new RegExp(stillRunning));

  const typed = scene(t, { name: '文字任务', text: true, attempts: [{ n: 1, gate: null }] });
  assert.throws(() => typed.report(), error => error.message === notSpecTask && notSpecTask === '这个任务不是用任务说明派发的，没有评分');
  const missing = scene(t, { name: '存在的' });
  assert.throws(() => buildReport({ home: missing.home, root: missing.root, name: '不存在的', env: {} }), /在当前仓库找不到记录 不存在的/);
  assert.throws(() => setBlame({ home: typed.home, root: typed.root, name: typed.name, n: 1, blame: 'spec' }), new RegExp(notSpecTask));
  assert.throws(() => setBlame({ home: running.home, root: running.root, name: running.name, n: 1, blame: 'spec' }), new RegExp(stillRunning));

  // Stage04 及更早的任务没有 attempt 事件：按一次尝试看待。
  const old = scene(t, { name: '旧任务', attempts: [], end: { exit: 3 }, extra: [{ event: 'gate', ok: false, attempt: 1, summary: '改动超出范围：README.md' }] });
  const report = old.report();
  assert.deepEqual(report.attempts.map(a => [a.n, a.reason, a.gate, a.exit]), [[1, 'first', false, 3]]);
  assert.equal(report.executor.cap, 'failed');
});

test('主导 token：关闭为 off；打开但找不到会话为 unavailable；有会话时只算时间窗内的消息，输出里没有会话文本', t => {
  const configDir = path.join(temp(t), 'claude 配置');
  const env = { CLAUDE_CONFIG_DIR: configDir };
  const session = 'sess-089-aaaa';
  const mark = '特征文字-绝不能出现在输出里-ZXQ';
  const at = offset => new Date(T0 + offset).toISOString();
  const line = (offset, input, output, id, text = mark) => `${JSON.stringify({ type: 'assistant', timestamp: at(offset), sessionId: session, message: { id, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 999999 } } })}\n`;
  const attempts = [{ n: 1, gate: true }];

  const off = scene(t, { name: '关闭', attempts, config: { leadUsage: false } }).report(env);
  assert.deepEqual([off.lead.perf.usage, off.lead.perf.usageState], [null, 'off']);
  assert.equal(scene(t, { name: '没写', attempts }).report(env).lead.perf.usageState, 'off', '默认关闭');

  const on = scene(t, { name: '打开', attempts, config: { leadUsage: true } });
  const missing = on.report(env);
  assert.deepEqual([missing.lead.perf.usage, missing.lead.perf.usageState], [null, 'unavailable'], '会话目录不存在');
  mkdirSync(path.join(configDir, 'projects', '某项目'), { recursive: true });
  assert.equal(on.report(env).lead.perf.usageState, 'unavailable', '目录在、没有这个会话');

  // 任务窗口：start 之后 0 秒到 end（T0 + 数秒）。窗口前后的消息、重复记录的同一条回复都要处理对。
  put(path.join(configDir, 'projects', '某项目', `${session}.jsonl`), [
    line(-60000, 7000, 7000, 'before'),
    JSON.stringify({ type: 'user', timestamp: at(500), message: { role: 'user', content: mark } }) + '\n',
    line(500, 100, 10, 'm1'), line(500, 100, 40, 'm1'), // 同一条回复分成两行记录：按 ID 去重取最大
    line(1500, 200, 20, 'm2'),
    '不是 JSON 的 "usage" 行\n',
    line(3600 * 1000, 9000, 9000, 'after'),
  ].join(''));
  const ok = on.report(env);
  assert.equal(ok.lead.perf.usageState, 'ok');
  assert.deepEqual(ok.lead.perf.usage, { input: 300, output: 60 });
  const everything = JSON.stringify(ok) + reportLines(ok).join('\n');
  assert.ok(!everything.includes(mark), '输出里没有会话文本');
  assert.ok(!everything.includes('999999'), '缓存 token 不计入');
  assert.match(reportLines(ok).join('\n'), /token 输入 300、输出 60/);

  // leadUsage 本身。
  assert.deepEqual(leadUsage({ env, session, from: T0, to: T0 + 1000 }), { state: 'ok', usage: { input: 100, output: 40 } });
  assert.deepEqual(leadUsage({ env, session: null }), { state: 'unavailable', usage: null });
  assert.deepEqual(leadUsage({ env, session: '../../逃逸' }), { state: 'unavailable', usage: null });
  assert.deepEqual(leadUsage({ env: { CLAUDE_CONFIG_DIR: path.join(configDir, '没有') }, session }), { state: 'unavailable', usage: null });
  assert.deepEqual(leadUsageSetting({}), { enabled: false, source: '内置默认', warnings: [] });
  assert.deepEqual(leadUsageSetting({ leadUsage: true }).enabled, true);
  assert.deepEqual(leadUsageSetting({ leadUsage: 'yes' }).warnings, ['配置：leadUsage 必须为布尔值，已按默认值 false 处理']);
});

// 真实 git 仓库：主导的"派发后又改任务说明"。
const gitIn = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true }).trim();
function gitRepo(t) {
  const root = path.join(temp(t), '仓库');
  mkdirSync(root, { recursive: true });
  gitIn(root, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.name', '报告测试'], ['user.email', 'report-089@example.test'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) gitIn(root, ['config', key, value]);
  return root;
}
const commitAt = (root, file, content, offsetMs, message) => {
  put(path.join(root, file), content);
  gitIn(root, ['add', '--', file]);
  const date = `${Math.floor((T0 + offsetMs) / 1000)} +0000`;
  gitIn(root, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return gitIn(root, ['rev-parse', 'HEAD']);
};

test('specEdit：派发后任务说明的提交数，只算提交时间早于任务结束的；非 worktree 看 HEAD', t => {
  const root = gitRepo(t);
  const spec = 'docs/specs/001-甲.md';
  const base = commitAt(root, spec, '版本一\n', -60000, '任务说明');
  commitAt(root, 'other.txt', '无关\n', 100, '无关的提交');
  commitAt(root, spec, '版本二\n', 2000, '改任务说明一');
  commitAt(root, spec, '版本三\n', 3000, '改任务说明二');
  commitAt(root, spec, '版本四\n', 3600 * 1000 - 60000, '任务结束之后才改');
  const f = scene(t, { name: '改说明', spec, base, repo: root, attempts: [{ n: 1, gate: true }] });
  const report = f.report();
  assert.deepEqual([item(report.lead, 'specEdit').count, item(report.lead, 'specEdit').points], [2, -20]);
  assert.equal(report.lead.score, 80);

  const none = scene(t, { name: '没改', spec: 'docs/specs/002-乙.md', base, repo: root, attempts: [{ n: 1, gate: true }] }).report();
  assert.equal(item(none.lead, 'specEdit').count, 0);

  const noBase = scene(t, { name: '没有基线', spec, base: null, repo: root, attempts: [{ n: 1, gate: true }] }).report();
  assert.equal(item(noBase.lead, 'specEdit').count, 0);
  assert.match(item(noBase.lead, 'specEdit').detail, /没有记录基线/);

  const nogit = scene(t, { name: '读不到', spec, attempts: [{ n: 1, gate: true }] }).report();
  assert.equal(item(nogit.lead, 'specEdit').count, 0, 'git 读不到不报错');
  assert.match(item(nogit.lead, 'specEdit').detail, /没能读取 git 记录/);
});

test('specEdit：worktree 任务待验收时看主分支，已合并时看合并提交的第一父提交', t => {
  const root = gitRepo(t);
  const spec = 'docs/specs/003-丙.md';
  // 改在不同的行上，合并不会冲突。
  const body = (first, middle, last) => [first, '2', '3', '4', middle, '6', '7', '8', last, ''].join('\n');
  const base = commitAt(root, spec, body('1', '5', '9'), -60000, '任务说明');
  put(path.join(root, '.agent-router', 'project.json'), JSON.stringify({ baseBranch: 'main' }));
  // 执行者分支上改了一次任务说明（不在主分支上，不算）；主分支上改了一次。
  gitIn(root, ['switch', '-q', '-c', 'ar/改说明']);
  commitAt(root, spec, body('B', '5', '9'), 1500, '分支上改任务说明');
  commitAt(root, 'src.txt', '代码\n', 1600, '分支上的代码');
  gitIn(root, ['switch', '-q', 'main']);
  commitAt(root, spec, body('1', '5', 'M'), 2000, '主分支改任务说明');

  const awaiting = scene(t, { name: '待验收', spec, base, repo: root, worktree: true, attempts: [{ n: 1, gate: true }] }).report();
  assert.equal(awaiting.state, 'awaiting');
  assert.equal(item(awaiting.lead, 'specEdit').count, 1, '主分支上只有主分支改的那一次');

  // --no-ff 合并之后，主分支又改了一次：合并提交的第一父提交一侧只有合并之前主分支改的那一次。
  const date = `${Math.floor((T0 + 4000) / 1000)} +0000`;
  gitIn(root, ['merge', '-q', '--no-ff', '-m', '合并', 'ar/改说明'], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const merge = gitIn(root, ['rev-parse', 'HEAD']);
  commitAt(root, spec, body('B', 'P', 'M'), 4500, '合并之后');
  const accepted = scene(t, { name: '已合并', spec, base, repo: root, worktree: true, attempts: [{ n: 1, gate: true }], extra: [{ event: 'accepted', merge, mode: 'no-ff', by: 'cli' }] }).report();
  assert.equal(accepted.state, 'accepted');
  assert.equal(item(accepted.lead, 'specEdit').count, 1);
});

test('文字输出：两节，每节一行"<角色> <分数>/100"，每项一行，一行性能；封顶另起一行', t => {
  const report = scene(t, {
    attempts: [{ n: 1, gate: false, ms: 90000, usage: { input: 10, output: 20 }, gateFile: { scope: { outside: ['README.md'], protected: [] } } }], end: { exit: 3 },
    config: { prices: { deepseek: { input: 1, output: 1, currency: 'CNY' } } },
  }).report();
  const lines = reportLines(report);
  assert.equal(lines.filter(entry => /^(执行者|主导) \d+\/100$/.test(entry)).length, 2);
  assert.equal(lines[0], '执行者 40/100');
  assert.ok(lines.includes('  越界文件：1 个：README.md（−10）'), lines.join('\n'));
  assert.ok(lines.includes('  封顶：任务最终失败，分数最高 40'));
  assert.ok(lines.some(entry => entry.startsWith('  性能：用时 1.5 分钟；token 输入 10、输出 20；估算费用 0.00003 CNY；工具调用 0 次；执行者 deepseek')), lines.join('\n'));
  assert.ok(lines.includes('主导 100/100'));
  assert.ok(lines.includes('  手动重试：0 次（0）'));
  assert.ok(lines.some(entry => entry.includes('token 没有读取')));
});

test('ar config 显示 reportWeights、prices、leadUsage，非法值给出警告', t => {
  const home = path.join(temp(t), '公共 目录');
  const env = { AGENT_ROUTER_HOME: home };
  put(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'codex', profiles: { codex: { adapter: 'codex', enabled: true } } }));
  let lines = configCommand([], env).split('\n');
  assert.ok(lines.some(entry => /^reportWeights\s+默认\s+内置默认$/.test(entry)), lines.join('\n'));
  assert.ok(lines.some(entry => /^prices\s+未设置\s+内置默认$/.test(entry)));
  assert.ok(lines.some(entry => /^leadUsage\s+false\s+内置默认$/.test(entry)));

  put(path.join(home, 'config.json'), JSON.stringify({
    v: 2, defaultProfile: 'codex', profiles: { codex: { adapter: 'codex', enabled: true } },
    reportWeights: { attemptGate: { points: 5 }, toolError: { points: 0 } }, prices: { codex: { input: 1, output: 2, currency: 'CNY' } }, leadUsage: true,
  }));
  lines = configCommand([], env).split('\n');
  assert.ok(lines.some(entry => /^reportWeights\s+自定义 1 项\s+config\.json$/.test(entry)), lines.join('\n'));
  assert.ok(lines.some(entry => /^prices\s+1 个执行者\s+config\.json$/.test(entry)));
  assert.ok(lines.some(entry => /^leadUsage\s+true\s+config\.json$/.test(entry)));
  assert.equal(lines.filter(entry => entry.includes('reportWeights.toolError.points 必须为正数')).length, 1);
});
