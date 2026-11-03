import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fixture, git, write, until } from '../fixtures/review/pipeline-fixture.mjs';

const worktree = (f, name) => f.events(name).find(row => row.event === 'worktree').dir;
const commit = (dir, text) => {
  write(path.join(dir, 'src/a.js'), text);
  git(dir, ['add', '--', 'src/a.js']);
  git(dir, ['commit', '-q', '-m', '补充修改', '--', 'src/a.js']);
};

test('补提交后只重跑门禁时审查收到前次执行者汇报', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev', modes: 'ok' }], executor: { report: '执行者汇报正文\n' } });
  const spec = f.spec('docs/specs/013-regate.md', { review: true });
  assert.equal((await f.dispatch(spec, '汇报回溯')).code, 0);
  commit(worktree(f, '汇报回溯'), '补充\n');
  const result = await f.json(['retry', '汇报回溯', '--regate']);
  assert.equal(result.code, 0, JSON.stringify(result));
  const prompt = readFileSync(path.join(f.dir('汇报回溯'), 'attempts', '2', 'review', 'prompt.md'), 'utf8');
  assert.ok(prompt.includes('（本次只重跑门禁，没有启动执行者；以下是第 1 次尝试的执行者汇报）\n执行者汇报正文\n'));
});

test('补提交后重跑门禁和审查，HEAD 不变时只重跑门禁，包括脱离模式', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev', modes: 'ok,high' }] });
  const spec = f.spec('docs/specs/001-regate.md', { review: true, reviewBlock: 'high' });
  assert.equal((await f.dispatch(spec, '任务')).code, 0);
  const dir = worktree(f, '任务');
  const base = f.startOf('任务').base;
  const oldHead = f.review('任务').head;
  commit(dir, '补充\n');
  let result = await f.json(['retry', '任务', '--regate', '--note', '说明']);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal((await f.json(['status', '任务'])).value.state, 'awaiting');
  assert.equal(f.events('任务').filter(row => row.event === 'spawned').length, 1);
  assert.equal(f.events('任务').filter(row => row.event === 'review').length, 2);
  assert.notEqual(f.review('任务').head, oldHead);
  assert.equal(f.review('任务').head, git(dir, ['rev-parse', 'HEAD']));
  assert.equal(f.events('任务').findLast(row => row.event === 'attempt').reason, 'regate');
  assert.equal(f.startOf('任务').base, base);
  result = await f.json(['retry', '任务', '--regate', '--detach']);
  assert.equal(result.code, 0, JSON.stringify(result));
  await until(() => f.events('任务').filter(row => row.event === 'end').length === 3, '脱离重跑结束');
  assert.equal(f.events('任务').filter(row => row.event === 'gate').length, 3);
  assert.equal(f.events('任务').filter(row => row.event === 'review').length, 2);
  assert.equal(f.events('任务').filter(row => row.event === 'spawned').length, 1);
});

test('补提交令门禁失败时不审查、不重试', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev', modes: 'ok' }] });
  const spec = f.spec('docs/specs/002-regate.md', { review: true, maxRetries: 2, verify: ['node -e "process.exit(require(\'fs\').readFileSync(\'src/a.js\',\'utf8\').includes(\'fail\') ? 1 : 0)"'] });
  assert.equal((await f.dispatch(spec, '失败任务')).code, 0);
  commit(worktree(f, '失败任务'), 'fail\n');
  const result = await f.json(['retry', '失败任务', '--regate']);
  assert.equal(result.code, 3, JSON.stringify(result));
  assert.equal((await f.json(['status', '失败任务'])).value.state, 'failed');
  assert.equal(f.events('失败任务').filter(row => row.event === 'attempt').length, 2);
  assert.equal(f.events('失败任务').filter(row => row.event === 'review').length, 1);
});

test('门禁失败后补提交可重跑门禁和审查', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev', modes: 'ok' }], executor: { writes: [{ path: 'src/a.js', content: 'fail\n' }] } });
  const spec = f.spec('docs/specs/004-regate.md', { review: true, maxRetries: 0, verify: ['node -e "process.exit(require(\'fs\').readFileSync(\'src/a.js\',\'utf8\').includes(\'fail\') ? 1 : 0)"'] });
  assert.equal((await f.dispatch(spec, '门禁失败')).code, 3);
  assert.equal((await f.json(['status', '门禁失败'])).value.state, 'failed');
  const dir = worktree(f, '门禁失败');
  const base = f.startOf('门禁失败').base;
  commit(dir, '修复\n');
  const head = git(dir, ['rev-parse', 'HEAD']);
  const result = await f.json(['retry', '门禁失败', '--regate']);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal((await f.json(['status', '门禁失败'])).value.state, 'awaiting');
  const events = f.events('门禁失败');
  assert.equal(events.filter(row => row.event === 'spawned').length, 1);
  assert.equal(events.filter(row => row.event === 'gate').length, 2);
  assert.equal(events.findLast(row => row.event === 'gate').ok, true);
  assert.equal(events.filter(row => row.event === 'review').length, 1);
  assert.equal(events.findLast(row => row.event === 'attempt').n, 2);
  assert.equal(events.findLast(row => row.event === 'attempt').reason, 'regate');
  assert.equal(git(dir, ['rev-parse', 'HEAD']), head);
  assert.equal(f.startOf('门禁失败').base, base);
});

test('执行者异常退出后不能重跑门禁', async t => {
  const f = fixture(t, { executor: { exit: 7 } });
  const spec = f.spec('docs/specs/005-regate.md', { maxRetries: 0 });
  assert.notEqual((await f.dispatch(spec, '异常退出')).code, 0);
  const count = f.rows().length;
  const result = await f.json(['retry', '异常退出', '--regate']);
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.equal(result.value.error, '只有待验收、门禁未通过或门禁阶段被停止的 worktree 任务可以 --regate：异常退出');
  assert.equal(f.rows().length, count);
});

test('执行者以退出码 3 异常退出后不能重跑门禁', async t => {
  const f = fixture(t, { executor: { exit: 3 } });
  const spec = f.spec('docs/specs/006-regate.md', { maxRetries: 0 });
  assert.equal((await f.dispatch(spec, '退出码三')).code, 3);
  const count = f.rows().length;
  const result = await f.json(['retry', '退出码三', '--regate']);
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.equal(result.value.error, '只有待验收、门禁未通过或门禁阶段被停止的 worktree 任务可以 --regate：退出码三');
  assert.equal(f.rows().length, count);
});

test('前次门禁失败但最后一次执行者异常退出后不能重跑门禁', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/007-regate.md', { maxRetries: 0, verify: ['node -e "process.exit(1)"'] });
  assert.equal((await f.dispatch(spec, '前次失败')).code, 3);
  assert.equal(f.events('前次失败').findLast(row => row.event === 'gate').ok, false);
  f.executor.exit = 3;
  f.executor.commit = null;
  f.executor.writes = [];
  f.writeConfig();
  assert.notEqual((await f.json(['retry', '前次失败'])).code, 0);
  const events = f.events('前次失败');
  assert.equal(events.filter(row => row.event === 'attempt').length, 2);
  assert.equal(events.findLast(row => row.event === 'attempt-end').exit, 3);
  assert.equal(events.filter(row => row.event === 'gate').length, 1);
  const count = f.rows().length;
  const result = await f.json(['retry', '前次失败', '--regate']);
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.equal(result.value.error, '只有待验收、门禁未通过或门禁阶段被停止的 worktree 任务可以 --regate：前次失败');
  assert.equal(f.rows().length, count);
});

test('其他状态与互斥选项被拒绝且不写事件', async t => {
  const f = fixture(t, { executor: { report: '假汇报\n## 已知问题\n无\n' } });
  const spec = f.spec('docs/specs/003-regate.md');
  assert.equal((await f.dispatch(spec, '合并')).code, 0);
  const accepted = await f.json(['accept', '合并']);
  assert.equal(accepted.code, 0, JSON.stringify(accepted));
  f.executor.writes = [{ path: 'src/a.js', content: '再次修改\n' }];
  f.writeConfig();
  assert.equal((await f.dispatch(spec, '冲突')).code, 0);
  appendFileSync(path.join(f.home, 'runs.jsonl'), JSON.stringify({ v: 1, event: 'conflict', id: f.startOf('冲突').id, files: ['src/a.js'], at: Date.now() }) + '\n');
  assert.equal((await f.dispatch(spec, '驳回')).code, 0);
  assert.equal((await f.json(['reject', '驳回', '--reason', '测试'])).code, 0);
  assert.equal((await f.json(['dispatch', spec, '--name', '普通', '--no-worktree'])).code, 0);
  for (const [name, pattern] of [['冲突', /只有待验收、门禁未通过或门禁阶段被停止的 worktree 任务可以 --regate/], ['合并', /已合并/], ['驳回', /已驳回/], ['普通', /^只有待验收、门禁未通过或门禁阶段被停止的 worktree 任务可以 --regate：普通$/]]) {
    const count = f.rows().length;
    const result = await f.json(['retry', name, '--regate']);
    assert.equal(result.code, 2, JSON.stringify(result));
    assert.match(result.value.error, pattern);
    assert.equal(f.rows().length, count);
  }
  for (const option of [['--rebase'], ['--profile', 'worker']]) {
    const result = await f.json(['retry', '冲突', '--regate', ...option]);
    assert.equal(result.code, 2, JSON.stringify(result));
    assert.match(result.value.error, /不能与/);
  }
});

test('重跑门禁期间停止，补提交后可再次重跑门禁', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev', modes: 'ok' }] });
  const spec = f.spec('docs/specs/008-regate.md', { review: true, verify: ['node -e "const f=require(\'fs\');if(f.readFileSync(\'src/a.js\',\'utf8\').includes(\'hang\')){f.writeFileSync(\'gate-marker\',\'ready\');setInterval(()=>{},1000)}"'] });
  assert.equal((await f.dispatch(spec, '门禁中停止')).code, 0);
  const dir = worktree(f, '门禁中停止');
  const base = f.startOf('门禁中停止').base;
  commit(dir, 'hang\n');
  assert.equal((await f.json(['retry', '门禁中停止', '--regate', '--detach'])).code, 0);
  await until(() => f.exists(dir, 'gate-marker'), '门禁开始');
  assert.equal((await f.json(['stop', '门禁中停止'])).code, 0);
  rmSync(path.join(dir, 'gate-marker'));
  commit(dir, '修复\n');
  const head = git(dir, ['rev-parse', 'HEAD']);
  const result = await f.json(['retry', '门禁中停止', '--regate']);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal((await f.json(['status', '门禁中停止'])).value.state, 'awaiting');
  const events = f.events('门禁中停止');
  assert.equal(events.filter(row => row.event === 'spawned').length, 1);
  assert.equal(events.findLast(row => row.event === 'gate').ok, true);
  assert.equal(events.findLast(row => row.event === 'attempt').n, 3);
  assert.equal(events.filter(row => row.event === 'review').length, 2);
  assert.equal(git(dir, ['rev-parse', 'HEAD']), head);
  assert.equal(f.startOf('门禁中停止').base, base);
});

test('执行者阶段停止，即使之前有门禁事件也不能重跑门禁', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/009-regate.md');
  assert.equal((await f.dispatch(spec, '执行中停止')).code, 0);
  f.executor.delayMs = 30000;
  f.executor.events = [{ kind: 'say', text: '开始' }, { kind: 'say', text: '结束' }];
  f.writeConfig();
  assert.equal((await f.json(['retry', '执行中停止', '--note', '继续', '--detach'])).code, 0);
  await until(() => f.events('执行中停止').filter(row => row.event === 'spawned').length === 2, '执行者启动');
  assert.equal((await f.json(['stop', '执行中停止'])).code, 0);
  const count = f.rows().length;
  const result = await f.json(['retry', '执行中停止', '--regate']);
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.equal(result.value.error, '只有待验收、门禁未通过或门禁阶段被停止的 worktree 任务可以 --regate：执行中停止');
  assert.equal(f.rows().length, count);
});

test('首次执行者阶段停止且没有门禁事件时拒绝重跑门禁', async t => {
  const f = fixture(t, { executor: { delayMs: 30000, events: [{ kind: 'say', text: '开始' }, { kind: 'say', text: '结束' }] } });
  const spec = f.spec('docs/specs/010-regate.md');
  assert.equal((await f.json(['dispatch', spec, '--name', '首次停止', '--detach'])).code, 0);
  await until(() => f.startOf('首次停止') && f.events('首次停止').some(row => row.event === 'spawned'), '执行者启动');
  assert.equal((await f.json(['stop', '首次停止'])).code, 0);
  assert.equal(f.events('首次停止').some(row => row.event === 'gate'), false);
  const result = await f.json(['retry', '首次停止', '--regate']);
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.equal(result.value.error, '只有待验收、门禁未通过或门禁阶段被停止的 worktree 任务可以 --regate：首次停止');
});

test('正常执行后无冲突重新基线在门禁中停止，仍可重跑门禁', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/011-regate.md', { maxRetries: 0, verify: ['node -e "const f=require(\'fs\'),s=f.readFileSync(\'src/a.js\',\'utf8\');if(s.includes(\'hang\')){f.writeFileSync(\'gate-marker\',\'ready\');setInterval(()=>{},1000)}else if(s.includes(\'改过\'))process.exit(1)"'] });
  assert.equal((await f.dispatch(spec, '基线中停止')).code, 3);
  const dir = worktree(f, '基线中停止');
  commit(dir, 'hang\n');
  assert.equal((await f.json(['retry', '基线中停止', '--rebase', '--detach'])).code, 0);
  await until(() => f.exists(dir, 'gate-marker'), '重新基线的门禁开始');
  assert.equal((await f.json(['stop', '基线中停止'])).code, 0);
  rmSync(path.join(dir, 'gate-marker'));
  commit(dir, '修复\n');
  const result = await f.json(['retry', '基线中停止', '--regate']);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal((await f.json(['status', '基线中停止'])).value.state, 'awaiting');
  const events = f.events('基线中停止');
  assert.equal(events.filter(row => row.event === 'spawned').length, 1);
  assert.equal(events.findLast(row => row.event === 'attempt').reason, 'regate');
});

test('普通重试的执行者正常结束后在门禁中停止，仍可重跑门禁（320 审查 R3-1）', async t => {
  // 执行者不改文件、不提交；门禁命令在 src/a.js 含 hang 时挂住，供停在门禁阶段。
  const f = fixture(t, { executor: { writes: [], commit: null } });
  const spec = f.spec('docs/specs/012-regate.md', { maxRetries: 0, verify: ['node -e "const f=require(\'fs\'),s=f.readFileSync(\'src/a.js\',\'utf8\');if(s.includes(\'hang\')){f.writeFileSync(\'gate-marker\',\'ready\');setInterval(()=>{},1000)}"'] });
  assert.equal((await f.dispatch(spec, '重试门禁中停止')).code, 0);
  assert.ok(f.events('重试门禁中停止').some(row => row.event === 'gate'));
  const dir = worktree(f, '重试门禁中停止');
  commit(dir, 'hang\n');
  assert.equal((await f.json(['retry', '重试门禁中停止', '--note', '再做一次', '--detach'])).code, 0);
  await until(() => f.exists(dir, 'gate-marker'), '重试的门禁开始');
  assert.equal((await f.json(['stop', '重试门禁中停止'])).code, 0);
  rmSync(path.join(dir, 'gate-marker'));
  commit(dir, '修复\n');
  const result = await f.json(['retry', '重试门禁中停止', '--regate']);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal((await f.json(['status', '重试门禁中停止'])).value.state, 'awaiting');
  assert.equal(f.events('重试门禁中停止').filter(row => row.event === 'spawned').length, 2);
});

test('异常退出后无冲突重新基线，重跑门禁的审查中停止仍拒绝重跑', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev', modes: 'hang', pidFile: true }], executor: { exit: 7 } });
  const spec = f.spec('docs/specs/012-regate.md', { review: true, maxRetries: 0 });
  assert.notEqual((await f.dispatch(spec, '异常后审查停止')).code, 0);
  assert.equal((await f.json(['retry', '异常后审查停止', '--rebase'])).code, 0);
  commit(worktree(f, '异常后审查停止'), '补充\n');
  assert.equal((await f.json(['retry', '异常后审查停止', '--regate', '--detach'])).code, 0);
  await until(() => f.exists(f.pidFile), '审查开始');
  assert.equal((await f.json(['stop', '异常后审查停止'])).code, 0);
  const result = await f.json(['retry', '异常后审查停止', '--regate']);
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.equal(result.value.error, '只有待验收、门禁未通过或门禁阶段被停止的 worktree 任务可以 --regate：异常后审查停止');
  assert.equal(f.events('异常后审查停止').filter(row => row.event === 'spawned').length, 1);
});
