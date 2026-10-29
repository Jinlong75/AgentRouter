import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { alive, fixture, script, until } from '../fixtures/review/pipeline-fixture.mjs';

// Stage08 T3：审查接入流水线（门禁通过之后、待验收之前）。建议模式（默认）：不论结论都进入待验收。
// 假执行者 + reviewer-seq.mjs 经通用适配器接入的假审查者；每个用例的目录、配置、worktree 都是自己的临时目录。

// 不启用审查时的事件序列（和 Stage08 之前完全一样）。
const PLAIN = ['start', 'preparing', 'worktree', 'setup', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end'];
const REVIEWED = ['start', 'preparing', 'worktree', 'setup', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'reviewing', 'review', 'end'];

test('建议模式：审查 concerns 也进入待验收；事件 gate → reviewing → review → end；review.json、ar status 与进度', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-high', modes: 'high' }] });
  const spec = f.spec('docs/specs/001-建议模式.md', { review: true });
  const result = await f.dispatch(spec, '建议模式');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.value.exit, 0);
  assert.deepEqual(result.value.gate, { ok: true, summary: '门禁通过' });

  assert.deepEqual(f.names('建议模式'), REVIEWED);
  const events = f.events('建议模式');
  const reviewing = events.find(row => row.event === 'reviewing');
  assert.deepEqual(Object.keys(reviewing).sort(), ['at', 'attempt', 'event', 'id', 'v']);
  assert.equal(reviewing.attempt, 1);
  const review = events.find(row => row.event === 'review');
  assert.deepEqual({ ...review, at: 0 }, { v: 1, event: 'review', id: review.id, attempt: 1, reviewer: 'rev-high', crossed: true, verdict: 'concerns', issues: 3, high: 1, at: 0 });
  assert.equal(events.at(-1).exit, 0, '建议模式不拦截');
  assert.equal(events.filter(row => row.event === 'attempt').length, 1);

  // review.json：任务目录顶层与这次尝试目录各一份。
  const top = f.review('建议模式');
  assert.equal(top.verdict, 'concerns');
  assert.equal(top.reviewer, 'rev-high');
  assert.deepEqual(top.issues.map(item => [item.id, item.severity]), [['R1-1', 'high'], ['R1-2', 'medium'], ['R1-3', 'low']]);
  assert.equal(top.needsHuman, undefined);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.dir('建议模式'), 'attempts', '1', 'review.json'), 'utf8')), top);

  // 进度：交给谁、结论。
  const progress = f.progress('建议模式');
  assert.match(progress, /审查：交给 rev-high/);
  assert.match(progress, /审查：rev-high 的结论是 concerns，3 条问题/);

  // ar status：任务仍是待验收，--json 多 review 摘要；文字输出多一行。
  const status = await f.json(['status', '建议模式']);
  assert.equal(status.value.state, 'awaiting');
  assert.deepEqual(status.value.review, { verdict: 'concerns', reviewer: 'rev-high', crossed: true, issues: 3, high: 1, needsHuman: false });
  const text = await f.ar(['status', '建议模式']);
  assert.match(text.stdout, /^状态：建议模式（awaiting）$/m);
  assert.match(text.stdout, /^审查：concerns（rev-high，3 个问题，其中高 1）$/m);
});

test('不启用审查：事件、进度、ar status 与以前完全一样（没有 review 键，没有 review.json）', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-high', modes: 'high' }] });
  const spec = f.spec('docs/specs/002-不审查.md');
  const result = await f.dispatch(spec, '不审查');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.names('不审查'), PLAIN);
  assert.ok(!/审查：/.test(f.progress('不审查')), '进度里没有审查相关的行');
  assert.ok(!f.exists(f.dir('不审查'), 'review.json'));
  assert.ok(!f.attemptFiles('不审查', 1).some(name => name.startsWith('review')));
  const status = await f.json(['status', '不审查']);
  assert.ok(!Object.hasOwn(status.value, 'review'));
  const text = await f.ar(['status', '不审查']);
  assert.ok(!/^审查：/m.test(text.stdout));
});

test('启用的来源与优先级：任务说明 > 项目配置 > 全局配置', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-high', modes: 'high' }], global: { default: true } });
  // 全局默认开：任务说明没写就审查；任务说明 review: false 明确不审。
  assert.equal((await f.dispatch(f.spec('docs/specs/003-全局开.md'), '全局开')).code, 0);
  assert.deepEqual(f.names('全局开'), REVIEWED);
  assert.equal((await f.dispatch(f.spec('docs/specs/004-说明关.md', { review: false }), '说明关')).code, 0);
  assert.deepEqual(f.names('说明关'), PLAIN);
  // 项目配置 default: false 压过全局的 true；任务说明 review: true 再压过项目配置。
  f.setProject({ review: { default: false } });
  assert.equal((await f.dispatch(f.spec('docs/specs/005-项目关.md'), '项目关')).code, 0);
  assert.deepEqual(f.names('项目关'), PLAIN);
  assert.equal((await f.dispatch(f.spec('docs/specs/006-说明开.md', { review: true }), '说明开')).code, 0);
  assert.deepEqual(f.names('说明开'), REVIEWED);
  // 全局关、项目开。
  f.writeConfig();
  f.setProject({ review: { default: true } });
  assert.equal((await f.dispatch(f.spec('docs/specs/007-项目开.md'), '项目开')).code, 0);
  assert.deepEqual(f.names('项目开'), REVIEWED);
});

test('审查失败（没有结论）不阻断：进入待验收，review.json 的结论是 unknown，进度写原因', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-nocode', modes: 'nocode' }] });
  const spec = f.spec('docs/specs/008-审查失败.md', { review: true, reviewBlock: 'high' });
  const result = await f.dispatch(spec, '审查失败');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.names('审查失败'), REVIEWED);
  assert.equal(f.review('审查失败').verdict, 'unknown');
  assert.match(f.progress('审查失败'), /审查没有完成，不阻断：审查没有完成：rev-nocode 汇报里没有 json 代码块/);
  const status = await f.json(['status', '审查失败']);
  assert.equal(status.value.state, 'awaiting');
  assert.equal(status.value.review.verdict, 'unknown');
  assert.equal(status.value.review.needsHuman, false);

  // 没有可用的审查者（候选为空）也一样：不阻断。
  const empty = fixture(t, { reviewers: [] });
  const emptySpec = empty.spec('docs/specs/009-没有审查者.md', { review: true });
  const emptyResult = await empty.dispatch(emptySpec, '没有审查者');
  assert.equal(emptyResult.code, 0, emptyResult.stderr);
  assert.deepEqual(empty.names('没有审查者'), REVIEWED);
  assert.equal(empty.review('没有审查者').verdict, 'unknown');
  assert.match(empty.progress('没有审查者'), /审查：没有可用的审查者/);
});

test('审查失败换下一个审查者：第一个没有结论、第二个给出结论，只写一条 review 事件', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-nocode', modes: 'nocode' }, { name: 'rev-pass', modes: 'pass' }] });
  const spec = f.spec('docs/specs/010-换人.md', { review: true });
  assert.equal((await f.dispatch(spec, '换人')).code, 0);
  assert.deepEqual(f.names('换人'), REVIEWED);
  const review = f.review('换人');
  assert.equal(review.verdict, 'pass');
  assert.equal(review.reviewer, 'rev-pass');
  assert.deepEqual(review.tries.map(item => [item.reviewer, item.ok]), [['rev-nocode', false], ['rev-pass', true]]);
});

test('只读类型（research）不审查，即使写了 review: true', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-high', modes: 'high' }], executor: { writes: [], commit: null } });
  const spec = f.spec('docs/specs/011-调研.md', { type: 'research', review: true });
  const result = await f.dispatch(spec, '调研');
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!f.names('调研').includes('reviewing'));
  assert.ok(!f.names('调研').includes('review'));
  assert.ok(!f.exists(f.dir('调研'), 'review.json'));
  // 全局开着也一样。
  const global = fixture(t, { reviewers: [{ name: 'rev-high', modes: 'high' }], global: { default: true }, executor: { writes: [], commit: null } });
  assert.equal((await global.dispatch(global.spec('docs/specs/012-调研全局.md', { type: 'research' }), '调研全局')).code, 0);
  assert.ok(!global.names('调研全局').includes('reviewing'));
});

test('不用 worktree 的任务不审查：进度写原因，没有 reviewing / review 事件，任务正常结束', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-high', modes: 'high' }], project: { worktree: false } });
  const spec = f.spec('docs/specs/013-不用worktree.md', { review: true });
  const result = await f.dispatch(spec, '不用worktree');
  assert.equal(result.code, 0, result.stderr);
  const names = f.names('不用worktree');
  assert.ok(!names.includes('reviewing') && !names.includes('review'), names.join(','));
  assert.ok(names.includes('gate') && names.at(-1) === 'end');
  assert.match(f.progress('不用worktree'), /审查：不用 worktree 的任务无法安全恢复，不审查/);
  assert.ok(!f.exists(f.dir('不用worktree'), 'review.json'));
});

test('审查中被停止：ar stop 结束审查者进程并写 interrupted，没有 review / end 事件，状态是 stopped', async t => {
  const g = fixture(t, { reviewers: [{ name: 'rev-hang', modes: 'hang', pidFile: true }] });
  const spec = g.spec('docs/specs/014-审查中停止.md', { review: true });
  const dispatcher = spawn(process.execPath, [script, 'dispatch', spec, '--name', '审查中停止'], { cwd: g.repo, env: g.env, stdio: 'ignore', windowsHide: true, shell: false });
  t.after(() => { try { dispatcher.kill(); } catch { /* 已经退出。 */ } });
  await until(() => g.rows().some(row => row.event === 'reviewing'), '进入审查');
  const pid = await until(() => { try { return Number(readFileSync(g.pidFile, 'utf8')) || 0; } catch { return 0; } }, '审查者启动并写出 pid');
  assert.ok(alive(pid), '审查者在运行');
  const stop = await g.ar(['stop', '审查中停止']);
  assert.equal(stop.code, 0, stop.stdout + stop.stderr);
  await until(() => !alive(pid), '审查者进程已结束');
  const names = g.names('审查中停止');
  assert.ok(names.includes('interrupted'), names.join(','));
  assert.ok(!names.includes('review') && !names.includes('end'), names.join(','));
  const status = await g.json(['status', '审查中停止']);
  assert.equal(status.value.state, 'stopped');
});
