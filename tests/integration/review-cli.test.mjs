import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { registryWriter } from '../../core/lib/records.mjs';
import { fixture, readJson } from '../fixtures/review/pipeline-fixture.mjs';

// Stage08 T4：ar review 的子命令——再审、confirm、show、stats、config / config set。
// 假执行者 + reviewer-seq.mjs 经通用适配器接入的假审查者；配置、清单、worktree 都在每个用例自己的临时目录里。

const reviewers = [{ name: 'rev-high', modes: 'high' }, { name: 'rev-pass', modes: 'pass' }];
const attemptDir = (f, name, n = 1) => path.join(f.dir(name), 'attempts', String(n));

// 派发一个启用了审查的任务，等它进入待验收。
async function reviewedTask(t, name, options = {}) {
  const f = fixture(t, { reviewers, ...options });
  const result = await f.dispatch(f.spec(`docs/specs/201-${name}.md`, { review: true }), name);
  assert.equal(result.code, 0, result.stderr);
  return f;
}

test('ar review 再审：review-2.json、顶层换成最新的、review 事件带 run、任务状态不变；--profile 指定审查者', async t => {
  const f = await reviewedTask(t, '再审');
  const first = f.review('再审');
  assert.equal(first.run, undefined);
  const namesBefore = f.names('再审');

  const second = await f.json(['review', '再审']);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.value.ok, true);
  assert.deepEqual([second.value.name, second.value.attempt, second.value.run], ['再审', 1, 2]);
  assert.equal(second.value.review.reviewer, 'rev-high');
  assert.equal(second.value.review.run, 2);
  assert.deepEqual(second.value.review.issues.map(item => item.id), ['R1.2-1', 'R1.2-2', 'R1.2-3'], '再审的问题编号不和第一次重复');
  // 文件：这次尝试目录里 review.json 不动、多一个 review-2.json 和 review-2/；顶层换成最新的。
  assert.deepEqual(readJson(path.join(attemptDir(f, '再审'), 'review.json')), first);
  assert.deepEqual(readJson(path.join(attemptDir(f, '再审'), 'review-2.json')), second.value.review);
  assert.deepEqual(f.review('再审'), second.value.review);
  assert.ok(f.exists(attemptDir(f, '再审'), 'review', 'report.md') && f.exists(attemptDir(f, '再审'), 'review-2', 'report.md'));
  // 清单：多一条 review 事件（run 2），没有状态事件；任务仍是待验收。
  const added = f.names('再审').slice(namesBefore.length);
  assert.deepEqual(added, ['review']);
  const event = f.events('再审').at(-1);
  assert.deepEqual([event.attempt, event.run, event.reviewer, event.verdict], [1, 2, 'rev-high', 'concerns']);
  assert.equal((await f.json(['status', '再审'])).value.state, 'awaiting');

  // --profile：指定审查者（同任务说明的 reviewer）；第 3 次。
  const third = await f.json(['review', '再审', '--profile', 'rev-pass']);
  assert.equal(third.code, 0, third.stderr);
  assert.deepEqual([third.value.run, third.value.review.reviewer, third.value.review.verdict], [3, 'rev-pass', 'pass']);
  assert.ok(f.exists(attemptDir(f, '再审'), 'review-3.json'));
  assert.equal(f.review('再审').verdict, 'pass');
  const text = await f.ar(['review', '再审', '--profile', 'rev-pass']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^审查：pass（rev-pass，0 个问题，其中高 0）$/m);
});

test('再审没有给出结论：退出码 1，原来的顶层 review.json（含确认）原样保留', async t => {
  const f = await reviewedTask(t, '再审失败');
  const confirm = await f.json(['review', 'confirm', '再审失败', 'R1-1', 'valid']);
  assert.equal(confirm.code, 0, confirm.stderr);
  const before = readFileSync(path.join(f.dir('再审失败'), 'review.json'), 'utf8');
  const result = await f.json(['review', '再审失败', '--profile', 'rev-不存在']);
  assert.equal(result.code, 1);
  assert.equal(result.value.ok, false);
  assert.match(result.value.error, /没有可用的审查者/);
  assert.equal(readFileSync(path.join(f.dir('再审失败'), 'review.json'), 'utf8'), before);
  assert.equal(f.review('再审失败').issues[0].confirmation.result, 'valid');
});

test('再审没有给出结论：文字输出里"审查没有完成："只出现一次', async t => {
  const f = await reviewedTask(t, '再审前缀');
  const result = await f.ar(['review', '再审前缀', '--profile', 'rev-不存在']);
  assert.equal(result.code, 1);
  const text = result.stdout + result.stderr;
  assert.match(text, /审查没有完成：/);
  assert.equal(text.split('审查没有完成：').length - 1, 1, text);
});

test('ar review 只对待验收的 worktree 任务：别的状态、不存在的记录、没用 worktree 的任务都拒绝（退出码 2，说明原因）', async t => {
  const f = fixture(t, { reviewers });
  // 门禁没过的任务（failed）。
  const failed = f.spec('docs/specs/202-失败任务.md', { review: true, verify: ['node scripts/check.mjs'], maxRetries: 0 });
  const dispatched = await f.dispatch(failed, '失败任务');
  assert.notEqual(dispatched.code, 0);
  const json = await f.json(['review', '失败任务']);
  assert.equal(json.code, 2);
  assert.equal(json.value.ok, false);
  assert.match(json.value.error, /只能审查待验收的任务（失败任务 现在是 failed）/);
  const text = await f.ar(['review', '失败任务']);
  assert.equal(text.code, 2);
  assert.match(text.stderr, /只能审查待验收的任务/);
  assert.ok(!f.exists(f.dir('失败任务'), 'review.json'), '拒绝时不审查、不写文件');

  const missing = await f.json(['review', '没有这个记录']);
  assert.equal(missing.code, 2);
  assert.match(missing.value.error, /找不到记录 没有这个记录/);

  const bare = await f.ar(['review']);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /用法：ar review <记录名>/);

  const plain = fixture(t, { reviewers, project: { worktree: false } });
  assert.equal((await plain.dispatch(plain.spec('docs/specs/203-不用worktree.md'), '不用worktree')).code, 0);
  const refused = await plain.json(['review', '不用worktree']);
  assert.equal(refused.code, 2);
  assert.match(refused.value.error, /只能审查待验收的 worktree 任务/);
});

test('ar review confirm：写 confirmation 与 review-confirm 事件；同一问题以最后一次为准；编号不存在报错；--by 默认值', async t => {
  const f = await reviewedTask(t, '确认');
  const first = await f.json(['review', 'confirm', '确认', 'R1-1', 'valid', '--note', '确实有这个问题', '--by', 'lead']);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.value, { ok: true, name: '确认', issue: 'R1-1', severity: 'high', result: 'valid', by: 'lead', note: '确实有这个问题' });
  const issue = f.review('确认').issues.find(item => item.id === 'R1-1');
  assert.deepEqual({ ...issue.confirmation, at: 0 }, { result: 'valid', by: 'lead', note: '确实有这个问题', at: 0 });
  assert.ok(Number.isFinite(issue.confirmation.at));
  assert.equal(f.review('确认').issues.find(item => item.id === 'R1-2').confirmation, null, '别的问题不动');
  const event = f.events('确认').filter(row => row.event === 'review-confirm').at(-1);
  assert.deepEqual({ ...event, at: 0 }, { v: 1, event: 'review-confirm', id: event.id, issue: 'R1-1', severity: 'high', result: 'valid', by: 'lead', reviewer: 'rev-high', at: 0 });
  assert.equal((await f.json(['status', '确认'])).value.state, 'awaiting', '不改任务状态');

  // 同一问题再确认：以最后一次为准；不写 --by 时环境里没有 CLAUDECODE 是 human，有（=1）是 lead。
  const second = await f.json(['review', 'confirm', '确认', 'R1-1', 'invalid']);
  assert.equal(second.value.by, 'human');
  assert.equal(second.value.note, null);
  assert.equal(f.review('确认').issues[0].confirmation.result, 'invalid');
  const inClaude = await f.json(['review', 'confirm', '确认', 'R1-2', 'valid'], { env: { CLAUDECODE: '1' } });
  assert.equal(inClaude.value.by, 'lead');
  assert.equal(f.events('确认').filter(row => row.event === 'review-confirm').length, 3, '每次确认一条事件');

  // 出错：编号不存在、结果不是 valid / invalid、--by 不合法、没有审查结果。退出码 2，review.json 不变。
  const before = readFileSync(path.join(f.dir('确认'), 'review.json'), 'utf8');
  const unknown = await f.json(['review', 'confirm', '确认', 'R9-9', 'valid']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.value.error, /没有问题 R9-9（现有：R1-1、R1-2、R1-3）/);
  assert.equal((await f.json(['review', 'confirm', '确认', 'R1-1', 'maybe'])).code, 2);
  assert.equal((await f.json(['review', 'confirm', '确认', 'R1-1', 'valid', '--by', 'cli'])).code, 2);
  assert.equal((await f.json(['review', 'confirm', '确认', 'R1-1'])).code, 2);
  assert.equal(readFileSync(path.join(f.dir('确认'), 'review.json'), 'utf8'), before);
  assert.equal(f.events('确认').filter(row => row.event === 'review-confirm').length, 3, '出错不写事件');

  const plain = fixture(t, { reviewers });
  assert.equal((await plain.dispatch(plain.spec('docs/specs/204-没审查.md'), '没审查')).code, 0);
  const none = await plain.json(['review', 'confirm', '没审查', 'R1-1', 'valid']);
  assert.equal(none.code, 2);
  assert.match(none.value.error, /还没有审查结果/);

  // stats 里这个任务的 R1-1 取最后一次（invalid），R1-2 是 valid（medium）。
  const stats = await f.json(['review', 'stats']);
  const item = stats.value.reviewers.find(entry => entry.reviewer === 'rev-high');
  assert.deepEqual(item.severities.high, { confirmed: 1, valid: 0, accuracy: 0 });
  assert.deepEqual(item.severities.medium, { confirmed: 1, valid: 1, accuracy: 1 });
});

test('ar review show：JSON 是顶层 review.json；文字按严重度列问题并带确认状态；没有审查结果报错', async t => {
  const f = await reviewedTask(t, '查看');
  await f.json(['review', 'confirm', '查看', 'R1-3', 'invalid', '--by', 'human']);
  await f.json(['review', 'confirm', '查看', 'R1-1', 'valid', '--by', 'lead']);
  const json = await f.json(['review', 'show', '查看']);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(json.value.review, f.review('查看'));
  assert.equal(json.value.name, '查看');
  const text = await f.ar(['review', 'show', '查看']);
  assert.equal(text.code, 0, text.stderr);
  const lines = text.stdout.trim().split(/\r?\n/);
  assert.equal(lines[0], '审查：concerns（rev-high，3 个问题，其中高 1）');
  assert.equal(lines[1], '摘要：有一个必须处理的问题');
  assert.deepEqual(lines.filter(line => /^R1-/.test(line)), [
    'R1-1　高　src/a.js:1　示例高严重度问题　[已确认成立（lead）]',
    'R1-2　中　src/a.js:2　示例中严重度问题',
    'R1-3　低　README.md　示例低严重度问题　[已确认不成立（human）]',
  ]);
  assert.ok(lines.includes('  传入空值时会抛错。'));

  const plain = fixture(t, { reviewers });
  assert.equal((await plain.dispatch(plain.spec('docs/specs/205-没审查.md'), '没审查')).code, 0);
  const none = await plain.json(['review', 'show', '没审查']);
  assert.equal(none.code, 2);
  assert.match(none.value.error, /还没有审查结果/);
});

test('ar review stats：每个审查者 × 严重度的准确率（每任务每问题取最后一次）；高严重度已确认 ≥ 20 条且准确率 ≥ 80% 时 suggestBlock', async t => {
  const f = fixture(t);
  const record = registryWriter(f.home);
  let tick = 1;
  const confirm = (reviewer, id, issue, severity, result) => record({ event: 'review-confirm', id, issue, severity, result, by: 'human', reviewer, at: tick++ });
  // rev-a：20 条 high，18 条成立（0 号先标 invalid 再标 valid、19 号先标 valid 再标 invalid，都以最后一次为准）；4 条 medium 成立 3 条。
  confirm('rev-a', 'task-0', 'R1-1', 'high', 'invalid');
  for (let i = 0; i < 20; i++) confirm('rev-a', `task-${i}`, 'R1-1', 'high', i < 18 ? 'valid' : 'invalid');
  confirm('rev-a', 'task-19', 'R1-1', 'high', 'valid');
  confirm('rev-a', 'task-19', 'R1-1', 'high', 'invalid');
  for (let i = 0; i < 4; i++) confirm('rev-a', `task-${i}`, 'R1-2', 'medium', i < 3 ? 'valid' : 'invalid');
  // rev-b：20 条 high 成立 15 条（75%，不提示）；rev-c：19 条全成立（不到 20 条，不提示）；rev-d：20 条成立 16 条（正好 80%，提示）。
  for (let i = 0; i < 20; i++) confirm('rev-b', `b-${i}`, 'R1-1', 'high', i < 15 ? 'valid' : 'invalid');
  for (let i = 0; i < 19; i++) confirm('rev-c', `c-${i}`, 'R1-1', 'high', 'valid');
  for (let i = 0; i < 20; i++) confirm('rev-d', `d-${i}`, 'R1-1', 'high', i < 16 ? 'valid' : 'invalid');
  // 不认识的严重度与缺字段的事件忽略。
  record({ event: 'review-confirm', id: 'x', issue: 'R1-1', severity: 'catastrophic', result: 'valid', reviewer: 'rev-a', at: tick++ });
  record({ event: 'review-confirm', id: 'x', issue: 'R1-1', severity: 'high', result: 'maybe', reviewer: 'rev-a', at: tick++ });

  const stats = await f.json(['review', 'stats']);
  assert.equal(stats.code, 0, stats.stderr);
  const byName = Object.fromEntries(stats.value.reviewers.map(item => [item.reviewer, item]));
  assert.deepEqual(stats.value.reviewers.map(item => item.reviewer), ['rev-a', 'rev-b', 'rev-c', 'rev-d']);
  assert.deepEqual(byName['rev-a'].severities, {
    high: { confirmed: 20, valid: 18, accuracy: 0.9 }, medium: { confirmed: 4, valid: 3, accuracy: 0.75 }, low: { confirmed: 0, valid: 0, accuracy: null },
  });
  assert.equal(byName['rev-a'].suggestBlock, true);
  assert.deepEqual(byName['rev-b'].severities.high, { confirmed: 20, valid: 15, accuracy: 0.75 });
  assert.ok(!Object.hasOwn(byName['rev-b'], 'suggestBlock'));
  assert.deepEqual(byName['rev-c'].severities.high, { confirmed: 19, valid: 19, accuracy: 1 });
  assert.ok(!Object.hasOwn(byName['rev-c'], 'suggestBlock'), '不到 20 条不提示');
  assert.equal(byName['rev-d'].suggestBlock, true, '正好 80% 提示');
  const text = await f.ar(['review', 'stats']);
  assert.match(text.stdout, /^rev-a：高 已确认 20、成立 18、准确率 90%；中 已确认 4、成立 3、准确率 75%；低 已确认 0、成立 0、准确率 —$/m);
  assert.equal((text.stdout.match(/可以考虑把拦截模式打开/g) ?? []).length, 2, 'rev-a 与 rev-d 各一行提示');

  const empty = fixture(t);
  const none = await empty.json(['review', 'stats']);
  assert.deepEqual(none.value, { ok: true, reviewers: [] });
  assert.match((await empty.ar(['review', 'stats'])).stdout, /还没有确认过的审查问题/);
});

test('ar review config / config set：读写全局 config.json 的 review；校验失败退出码 2 且文件一个字节不改', async t => {
  const f = fixture(t, { reviewers });
  const file = path.join(f.home, 'config.json');
  const original = readFileSync(file, 'utf8');
  const read = await f.json(['review', 'config']);
  assert.deepEqual(read.value, { ok: true, review: { default: false, block: 'none', maxReworks: 1 } });
  assert.equal(readFileSync(file, 'utf8'), original, '只读不写');
  assert.match((await f.ar(['review', 'config'])).stdout, /default {5}false[\s\S]*block {7}none[\s\S]*maxReworks {2}1/);

  // 写入：只改给出的键，别的键（default 之外的 review 键、整份配置的其余部分）原样保留。
  const one = await f.json(['review', 'config', 'set', 'default=true']);
  assert.equal(one.code, 0, one.stderr);
  assert.deepEqual(one.value, { ok: true, review: { default: true, block: 'none', maxReworks: 1 } });
  assert.deepEqual(readJson(file).review, { default: true });
  const many = await f.json(['review', 'config', 'set', 'block=high', 'maxReworks=3']);
  assert.deepEqual(many.value.review, { default: true, block: 'high', maxReworks: 3 });
  assert.deepEqual(readJson(file).review, { default: true, block: 'high', maxReworks: 3 });
  const { review: _written, ...rest } = readJson(file);
  const { review: _none, ...originalRest } = JSON.parse(original);
  assert.deepEqual(rest, originalRest, '配置的其余部分不变');
  const zero = await f.json(['review', 'config', 'set', 'maxReworks=0', 'default=false']);
  assert.deepEqual(zero.value.review, { default: false, block: 'high', maxReworks: 0 });
  assert.match((await f.ar(['review', 'config', 'set', 'block=none'])).stdout, /^已更新审查设置$/m);

  // 失败：退出码 2、文件不改、没有留下临时文件。
  const before = readFileSync(file, 'utf8');
  for (const bad of [['maxReworks=6'], ['maxReworks=-1'], ['maxReworks=1.5'], ['maxReworks='], ['block=all'], ['default=yes'], ['unknown=1'], ['block'], ['default=true', 'default=false'], ['block=high', 'maxReworks=9'], []]) {
    const result = await f.json(['review', 'config', 'set', ...bad]);
    assert.equal(result.code, 2, `${bad.join(' ')}：${result.stderr}`);
    assert.equal(result.value.ok, false);
    assert.equal(readFileSync(file, 'utf8'), before, `${bad.join(' ')} 不该改文件`);
  }
  assert.ok(!readdirSync(f.home).some(name => name.endsWith('.tmp')), '没有留下临时文件');
  assert.equal((await f.json(['review', 'config', 'nonsense'])).code, 2);
});

test('项目配置的 review：ar projects config 写入与校验（default / block / maxReworks），失败不改 project.json，留空删除', async t => {
  const f = fixture(t, { reviewers });
  const file = path.join(f.repo, '.agent-router', 'project.json');
  const original = readJson(file);
  const set = await f.json(['projects', 'config', f.repo, 'review={"default":true,"block":"high","maxReworks":2}']);
  assert.equal(set.code, 0, set.stderr);
  assert.deepEqual(readJson(file).review, { default: true, block: 'high', maxReworks: 2 });
  const written = readFileSync(file, 'utf8');
  for (const bad of ['review={"block":"all"}', 'review={"default":"yes"}', 'review={"maxReworks":6}', 'review={"maxReworks":1.5}', 'review={"foo":1}', 'review=[1]', 'review=null', 'review=不是JSON']) {
    const result = await f.json(['projects', 'config', f.repo, bad]);
    assert.equal(result.code, 2, `${bad}：${result.stderr}`);
    assert.equal(readFileSync(file, 'utf8'), written, `${bad} 不该改文件`);
  }
  assert.equal((await f.json(['projects', 'config', f.repo, 'review='])).code, 0);
  assert.ok(!Object.hasOwn(readJson(file), 'review'));
  assert.deepEqual(readJson(file), original, '删掉后回到原样');
  assert.equal((await f.json(['projects', 'config', f.repo, 'review={}'])).code, 0);
  assert.ok(!Object.hasOwn(readJson(file), 'review'), '空对象等于没设');
});
