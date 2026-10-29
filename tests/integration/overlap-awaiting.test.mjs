import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// Stage07c 154（D86）：与待验收任务改动范围重叠——提示（overlap-note）、分组（ar overlaps）、批准后自动按新基线重跑门禁（resume.reason === "after-merge"）。
// 真实 git 仓库在系统临时目录里，AGENT_ROUTER_HOME、AR_WORKTREE_ROOT、CLAUDE_CONFIG_DIR 都指向用例自己的临时目录，执行者是 fake。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const rows = home => {
  try { return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
};
async function until(fn, label, timeout = 60000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

const specText = (allowed, expectCommit) => ['---', 'id: 902', 'title: 重叠待验收测试', 'type: code', `expect_commit: ${expectCommit}`, 'max_retries: 0', 'allowed_paths:', ...allowed.map(item => `  - ${item}`), '---', '', '测试说明正文。', ''].join('\n');

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-overlap-awaiting-'));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'wt'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), USERPROFILE: base, HOME: base, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_TEST_LOAD_FILE', 'CLAUDECODE']) delete env[key];
  assert.equal(path.dirname(env.AGENT_ROUTER_HOME), base, '隔离目录在临时目录里');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '重叠测试']);
  git(repo, ['config', 'user.email', 'overlap-awaiting@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), 'one\ntwo\nthree\n');
  write(path.join(repo, 'docs/readme.md'), '说明\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({
    v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true,
  }, null, 2));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  const f = { base, repo, home, env };
  // 假执行者：改这个文件、提交；fail 为真时不提交（门禁报“没有提交任何改动”，任务失败）。
  f.setProfile = ({ file, content, fail = false } = {}) => write(path.join(home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', concurrency: 4,
    profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...(file && !fail ? { writes: [{ path: file, content }], commit: `假执行者：改 ${file}` } : {}) } },
  }));
  f.spec = (name, allowed, expectCommit = false) => {
    const rel = `docs/specs/${name}.md`;
    write(path.join(repo, rel), specText(allowed, expectCommit));
    git(repo, ['add', '--', rel]);
    git(repo, ['commit', '-q', '-m', `任务说明 ${name}`]);
    return rel;
  };
  f.ar = (args, timeout = 120000) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  // 前台派发一个任务，等它到待验收（门禁通过）；返回 { name, id, start }。
  f.task = async (name, allowed, change, { expect = 0, expectCommit = false } = {}) => {
    f.setProfile(change);
    const result = await f.ar(['dispatch', f.spec(name, allowed, expectCommit), '--name', name, '--json']);
    assert.equal(result.code, expect, result.stderr + result.stdout);
    const start = rows(home).find(row => row.event === 'start' && row.name === name);
    return { name, id: start.id, start };
  };
  f.events = id => rows(home).filter(row => row.id === id);
  f.progress = name => { try { return readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8'); } catch { return ''; } };
  f.json = async args => { const r = await f.ar([...args, '--json']); return { code: r.code, json: JSON.parse(r.stdout), stderr: r.stderr }; };
  f.status = async name => (await f.json(['status', name])).json;
  t.after(async () => {
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-overlap-awaiting-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

const resumesOf = (f, id) => f.events(id).filter(row => row.event === 'resume');

test('1 待验收任务不挡新派发，但提示：overlap-note 事件与进度行；不重叠的不提示；ar overlaps 分组与顺序', async t => {
  const f = fixture(t);
  const x = await f.task('甲', ['src/**'], { file: 'src/x.js', content: 'X\n' });
  assert.equal((await f.status('甲')).state, 'awaiting');
  // 乙与待验收的甲重叠（src/a.js 在 src/** 里），不排队，直接开始并到待验收。
  const y = await f.task('乙', ['src/a.js'], { file: 'src/a.js', content: 'one\nTWO-Y\nthree\n' });
  assert.equal((await f.status('乙')).state, 'awaiting');
  const eventsY = f.events(y.id);
  assert.equal(eventsY.some(row => row.event === 'queued'), false, '没有排队');
  const note = eventsY.find(row => row.event === 'overlap-note');
  assert.deepEqual(Object.keys(note).sort(), ['at', 'event', 'id', 'v', 'with']);
  assert.deepEqual(note.with, [{ id: x.id, name: '甲', paths: ['src/**'] }]);
  assert.match(f.progress('乙'), /与待验收的 甲 改动范围重叠（src\/\*\*），甲 合并后可能冲突/);
  assert.ok(eventsY.findIndex(row => row.event === 'overlap-note') < eventsY.findIndex(row => row.event === 'worktree'), '提示在建 worktree 之前');
  // 丙不重叠（docs/**）：没有提示。第一个任务甲（先派发）当然也没有。
  const z = await f.task('丙', ['docs/**'], { file: 'docs/z.md', content: 'Z\n' });
  assert.equal(f.events(z.id).some(row => row.event === 'overlap-note'), false);
  assert.doesNotMatch(f.progress('丙'), /合并后可能冲突/);
  assert.equal(f.events(x.id).some(row => row.event === 'overlap-note'), false);
  // 丁与甲重叠（src/lib/**），与乙不重叠：提示里只有甲；分组是传递的（丁经甲和乙成一组）。
  const w = await f.task('丁', ['src/lib/**'], { file: 'src/lib/w.js', content: 'W\n' });
  assert.deepEqual(f.events(w.id).find(row => row.event === 'overlap-note').with.map(item => item.name), ['甲']);

  const overlaps = await f.json(['overlaps']);
  assert.equal(overlaps.code, 0);
  assert.equal(overlaps.json.ok, true);
  assert.equal(overlaps.json.groups.length, 1);
  const [group] = overlaps.json.groups;
  assert.deepEqual(group.order, [x.id, y.id, w.id], '先派发的先批准');
  assert.deepEqual(group.tasks, [
    { id: x.id, name: '甲', paths: ['src/**'] }, { id: y.id, name: '乙', paths: ['src/a.js'] }, { id: w.id, name: '丁', paths: ['src/lib/**'] },
  ]);
  assert.match(group.why, /^先派发的先批准：甲 → 乙 → 丁/);
  assert.ok(!JSON.stringify(overlaps.json).includes(z.id), '不重叠的丙不在任何组里');
  // 文字输出、--project 参数、不认识的参数。
  const text = await f.ar(['overlaps']);
  assert.match(text.stdout, /重叠的待验收任务：甲、乙、丁/);
  assert.equal((await f.ar(['overlaps', '--project', f.repo])).code, 0);
  assert.equal((await f.ar(['overlaps', '--project'])).code, 2);
  assert.equal((await f.ar(['overlaps', 'x'])).code, 2);
  // 批准（驳回）之后不再算待验收：驳回乙，剩甲、丁仍重叠。
  assert.equal((await f.ar(['reject', '乙', '--reason', '测试', '--json'])).code, 0);
  assert.deepEqual((await f.json(['overlaps'])).json.groups.map(item => item.order), [[x.id, w.id]]);
});

test('2 没有重叠的待验收任务：ar overlaps 的 groups 是空数组（文字也说明）', async t => {
  const f = fixture(t);
  await f.task('甲', ['src/**'], { file: 'src/x.js', content: 'X\n' });
  await f.task('乙', ['docs/**'], { file: 'docs/y.md', content: 'Y\n' });
  const none = await f.json(['overlaps']);
  assert.deepEqual(none.json, { ok: true, groups: [] });
  assert.match((await f.ar(['overlaps'])).stdout, /没有互相重叠的待验收任务/);
});

test('3 批准甲之后，与它重叠的待验收乙自动按新基线重跑门禁（resume.reason === "after-merge"）；不重叠的丙不动；accept 多一行并在 --json 里带 rebased', async t => {
  const f = fixture(t);
  const x = await f.task('甲', ['src/**'], { file: 'src/x.js', content: 'X\n' });
  const y = await f.task('乙', ['src/a.js'], { file: 'src/a.js', content: 'one\nTWO-Y\nthree\n' });
  const z = await f.task('丙', ['docs/**'], { file: 'docs/z.md', content: 'Z\n' });
  const baseY = f.events(y.id).find(row => row.event === 'attempt').base ?? y.start.base;
  const headMain = git(f.repo, ['rev-parse', 'main']);

  const accepted = await f.json(['accept', '甲']);
  assert.equal(accepted.code, 0, accepted.stderr + JSON.stringify(accepted.json));
  assert.deepEqual(Object.keys(accepted.json).sort(), ['cleanup', 'merge', 'mode', 'ok', 'rebased']);
  assert.deepEqual(accepted.json.rebased, [y.id], '只有重叠的乙');
  assert.equal(accepted.json.ok, true);
  const mergeCommit = git(f.repo, ['rev-parse', 'main']);
  assert.notEqual(mergeCommit, headMain);
  assert.equal(accepted.json.merge, mergeCommit);

  // 乙的重跑是脱离进程：等它结束（第二个 end），回到待验收。
  await until(() => f.events(y.id).filter(row => row.event === 'end').length >= 2, '乙重跑门禁结束');
  const events = f.events(y.id);
  const resume = resumesOf(f, y.id).at(-1);
  assert.equal(resume.reason, 'after-merge');
  assert.equal(resume.after, x.id);
  assert.equal(resumesOf(f, y.id).length, 1);
  const names = events.map(row => row.event);
  assert.deepEqual(names.slice(names.lastIndexOf('resume')), ['resume', 'attempt', 'gating', 'gate', 'attempt-end', 'end'], '没有 spawned：不启动执行者');
  const attempt = events.findLast(row => row.event === 'attempt');
  assert.equal(attempt.reason, 'rebase');
  assert.equal(attempt.base, mergeCommit, '基线是合并后的提交');
  assert.equal(events.at(-1).exit, 0);
  assert.equal(events.find(row => row.event === 'start').base, y.start.base, 'start.base 不变');
  assert.notEqual(baseY, mergeCommit);
  assert.match(f.progress('乙'), /甲 已合并，与它的改动范围重叠：按新基线重跑门禁/);
  assert.match(f.progress('乙'), /合并 main（[0-9a-f]{7}）后重跑门禁/);
  assert.equal((await f.status('乙')).state, 'awaiting');
  // 乙的 worktree 里现在有甲合并进来的文件；乙可以接着批准。
  const worktreeY = f.events(y.id).find(row => row.event === 'worktree').dir;
  assert.ok(existsSync(path.join(worktreeY, 'src/x.js')));
  assert.equal(git(worktreeY, ['status', '--porcelain']), '');

  // 丙不重叠：没有任何新事件。
  assert.equal(resumesOf(f, z.id).length, 0);
  assert.equal((await f.status('丙')).state, 'awaiting');

  // 文字输出的 accept 多一行（用丙演示：它不重叠，没有这一行）。
  const plain = await f.ar(['accept', '丙']);
  assert.equal(plain.code, 0);
  assert.doesNotMatch(plain.stdout, /已安排重跑门禁/);
  const second = await f.ar(['accept', '乙']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), 'one\nTWO-Y\nthree\n');
});

test('4 accept 的文字输出多一行"已安排重跑门禁：…"，退出码与其余输出不变', async t => {
  const f = fixture(t);
  await f.task('甲', ['src/**'], { file: 'src/x.js', content: 'X\n' });
  const y = await f.task('乙', ['src/a.js'], { file: 'src/a.js', content: 'one\nTWO-Y\nthree\n' });
  const accepted = await f.ar(['accept', '甲']);
  assert.equal(accepted.code, 0, accepted.stderr);
  const lines = accepted.stdout.trimEnd().split(/\r?\n/);
  assert.match(lines[0], /^已合并：甲（合并提交 [0-9a-f]{7}）$/);
  assert.equal(lines[1], '已安排重跑门禁：乙（与 甲 的改动范围重叠，按合并后的新基线重跑，不启动执行者）');
  assert.equal(lines.length, 2);
  await until(() => f.events(y.id).filter(row => row.event === 'end').length >= 2, '乙重跑门禁结束');
});

test('5 重跑时合并冲突：乙进"冲突"状态（合并撤销、worktree 干净、不派执行者），之后 accept 乙被拒', async t => {
  const f = fixture(t);
  const x = await f.task('甲', ['src/**'], { file: 'src/a.js', content: 'one\nTWO-X\nthree\n' });
  const y = await f.task('乙', ['src/a.js'], { file: 'src/a.js', content: 'one\nTWO-Y\nthree\n' });
  const accepted = await f.json(['accept', '甲']);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.deepEqual(accepted.json.rebased, [y.id]);
  await until(() => f.events(y.id).some(row => row.event === 'conflict'), '乙进入冲突状态');
  const events = f.events(y.id);
  const names = events.map(row => row.event);
  assert.deepEqual(names.slice(names.lastIndexOf('resume')), ['resume', 'end', 'conflict'], '没有 attempt、没有 spawned；conflict 写在 end 之后');
  assert.equal(resumesOf(f, y.id).at(-1).reason, 'after-merge');
  assert.equal(resumesOf(f, y.id).at(-1).after, x.id);
  assert.deepEqual(events.at(-1).files, ['src/a.js']);
  assert.match(f.progress('乙'), /甲 已合并，与它的改动范围重叠：按新基线重跑门禁/);
  assert.match(f.progress('乙'), /1 个文件有冲突（src\/a\.js），已撤销这次合并，任务进入冲突状态；解决冲突用 ar retry 乙 --rebase/);
  assert.equal((await f.status('乙')).state, 'conflict');
  const worktreeY = events.find(row => row.event === 'worktree').dir;
  assert.equal(git(worktreeY, ['status', '--porcelain']), '', '合并已撤销，worktree 干净');
  assert.equal(existsSync(path.resolve(worktreeY, git(worktreeY, ['rev-parse', '--git-path', 'MERGE_HEAD']))), false, '没有合并在进行');
  assert.equal(readFileSync(path.join(worktreeY, 'src/a.js'), 'utf8'), 'one\nTWO-Y\nthree\n', '乙的改动原样');
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), 'one\nTWO-X\nthree\n', '主分支只有甲的改动');
  const refused = await f.json(['accept', '乙']);
  assert.equal(refused.code, 2);
  assert.deepEqual(refused.json, { ok: false, error: '任务不在待验收状态：乙' });
});

test('6 驳回甲：与它重叠的乙不动（不重跑门禁）', async t => {
  const f = fixture(t);
  await f.task('甲', ['src/**'], { file: 'src/x.js', content: 'X\n' });
  const y = await f.task('乙', ['src/a.js'], { file: 'src/a.js', content: 'one\nTWO-Y\nthree\n' });
  const before = f.events(y.id).length;
  const rejected = await f.json(['reject', '甲', '--reason', '不要了']);
  assert.equal(rejected.code, 0, rejected.stderr);
  assert.deepEqual(Object.keys(rejected.json).sort(), ['cleanup', 'keptBranch', 'ok']);
  await delay(2500);
  assert.equal(resumesOf(f, y.id).length, 0, '驳回不触发重跑');
  assert.equal(f.events(y.id).length, before, '乙没有任何新事件');
  assert.equal((await f.status('乙')).state, 'awaiting');
});

test('7 手动重试时同样提示：失败的任务重试，改动范围与待验收任务重叠 → overlap-note 事件与进度行', async t => {
  const f = fixture(t);
  // 甲要求有提交、假执行者不提交：门禁失败（exit 3）。
  const a = await f.task('甲', ['src/**'], { fail: true }, { expect: 3, expectCommit: true });
  assert.equal((await f.status('甲')).state, 'failed');
  const x = await f.task('乙', ['src/a.js'], { file: 'src/a.js', content: 'one\nTWO-X\nthree\n' });
  assert.equal((await f.status('乙')).state, 'awaiting');
  f.setProfile({ file: 'src/b.js', content: 'B\n' });
  const retried = await f.json(['retry', '甲', '--detach']);
  assert.equal(retried.code, 0, retried.stderr + JSON.stringify(retried.json));
  await until(() => f.events(a.id).filter(row => row.event === 'end').length >= 2, '甲重试结束');
  const note = f.events(a.id).find(row => row.event === 'overlap-note');
  assert.deepEqual(note.with, [{ id: x.id, name: '乙', paths: ['src/a.js'] }]);
  assert.equal(f.events(a.id).filter(row => row.event === 'queued').length, 0, '待验收不挡人：重试没有排队');
  assert.match(f.progress('甲'), /与待验收的 乙 改动范围重叠（src\/a\.js），乙 合并后可能冲突/);
  assert.equal(f.events(a.id).filter(row => row.event === 'end')[1].exit, 0);
});
test('8 重跑遇到冲突之后点"解决冲突并重试"：重试的编号不能和自动重跑的 resume 重复（重复的话软件会把请求文件当成已结束而删掉，重试悄悄没有发生）', async t => {
  const f = fixture(t);
  await f.task('甲', ['src/**'], { file: 'src/a.js', content: 'one\nTWO-X\nthree\n' });
  const y = await f.task('乙', ['src/a.js'], { file: 'src/a.js', content: 'one\nTWO-Y\nthree\n' });
  assert.equal((await f.ar(['accept', '甲', '--json'])).code, 0);
  await until(() => f.events(y.id).some(row => row.event === 'conflict'), '乙进入冲突状态');
  assert.deepEqual(resumesOf(f, y.id).map(row => row.n), [2], '自动重跑的 resume 占了编号 2，冲突时没有写 attempt');
  const retried = await f.json(['retry', '乙', '--rebase', '--detach']);
  assert.equal(retried.code, 0, retried.stderr + JSON.stringify(retried.json));
  assert.equal(retried.json.n, 3, '不和已经写过的 resume 重复');
  await until(() => resumesOf(f, y.id).length >= 2, '乙的重试写了 resume');
  assert.deepEqual(resumesOf(f, y.id).map(row => row.n), [2, 3]);
  await until(() => f.events(y.id).findLast(row => row.event === 'end') && f.events(y.id).findLastIndex(row => row.event === 'end') > f.events(y.id).findLastIndex(row => row.event === 'resume'), '乙的重试结束');
  const attempt = f.events(y.id).findLast(row => row.event === 'attempt');
  assert.equal(attempt.n, 3);
  assert.equal(attempt.reason, 'conflict');
});