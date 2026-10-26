import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';
import { worktreeOutcome } from '../../core/lib/wait.mjs';

// 129：ar revert（撤销合并）。每个用例在系统临时目录里建一个名字含中文与空格的真实 git 仓库，用 fake 执行者真实走一遍“派发 → 待验收 → accept”；
// AR_WORKTREE_ROOT、AGENT_ROUTER_HOME、GIT_CONFIG_GLOBAL、HOME / USERPROFILE 都指向用例自己的临时目录，不碰真实安装、配置、进程与 worktree 根。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const rows = home => {
  try {
    return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};
async function until(fn, label, timeout = 30000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

// 主工作区的指纹：除 .git 与 .agent-runs 外所有文件（已跟踪、未跟踪、被忽略的）的相对路径与字节。
function treeHash(root) {
  const hash = createHash('sha256');
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (dir === root && (entry.name === '.git' || entry.name === '.agent-runs')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(`${path.relative(root, full)}\0`).update(readFileSync(full)).update('\0');
    }
  };
  walk(root);
  return hash.digest('hex');
}

function specText({ title, allowed = ['src/**'], verify = [] }) {
  const lines = ['---', 'id: 900', `title: ${title}`, 'type: code', 'expect_commit: false', 'allowed_paths:', ...allowed.map(item => `  - ${item}`)];
  if (verify.length) lines.push('verify:', ...verify.map(line => `  - ${line}`));
  lines.push('---', '', '测试说明正文。', '');
  return lines.join('\n');
}

function fixture(t, { project = {} } = {}) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 撤销 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  const wtRoot = path.join(base, 'wt 根');
  const user = path.join(base, '用户目录');
  const gitconfig = path.join(base, '空 gitconfig');
  for (const dir of [repo, home, user]) mkdirSync(dir);
  writeFileSync(gitconfig, '');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: wtRoot, AR_NO_WATCH: '1', GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', HOME: user, USERPROFILE: user };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE']) delete env[key];
  const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const commitAll = message => {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', message]);
  };
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '撤销测试']);
  git(repo, ['config', 'user.email', 'revert@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true, ...project }, null, 2));
  commitAll('初始提交');
  const f = { base, repo, home, wtRoot, env, since, count: 0, git: args => git(repo, args), commitAll, write: (rel, text) => write(path.join(repo, rel), text) };
  f.setProfile = value => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
      profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...value } },
    }));
  };
  f.setProfile({});
  f.ar = (args, { env: extra = {}, timeout = 90000 } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  // 派发一个任务（真实走完，进入待验收）：返回 { name, title, id, start, wt }。
  f.task = async (name, profile = {}, { args = [], expect = 0 } = {}) => {
    f.setProfile(profile);
    f.count += 1;
    const title = `撤销测试 ${name}`;
    const rel = `docs/specs/${String(900 + f.count)}-${name.replace(/\W+/g, '')}.md`;
    write(path.join(repo, rel), specText({ title }));
    commitAll(`任务说明 ${name}`);
    const result = await f.ar(['dispatch', rel, '--name', name, ...args, '--json']);
    assert.equal(result.code, expect, result.stderr + result.stdout);
    const start = await until(() => rows(home).find(row => row.event === 'start' && row.name === name), `${name} 的 start`);
    const wt = rows(home).find(row => row.id === start.id && row.event === 'worktree');
    return { name, title, id: start.id, start, wt };
  };
  // 派发并合并：返回任务与 accept 的结果。
  f.merged = async (name, { squash = false, profile = change } = {}) => {
    const task = await f.task(name, profile);
    const accepted = await f.ar(['accept', name, ...(squash ? ['--squash'] : []), '--json']);
    assert.equal(accepted.code, 0, accepted.stderr + accepted.stdout);
    return { ...task, merge: JSON.parse(accepted.stdout).merge };
  };
  f.revert = (name, ...extra) => f.ar(['revert', name, '--by', 'human', '--json', ...extra]);
  f.events = id => rows(home).filter(row => row.id === id);
  f.log = () => git(repo, ['log', '--format=%H']).split('\n').filter(Boolean);
  // 主工作区的现状：HEAD、索引、字节指纹、git status。
  f.snapshot = () => ({ head: git(repo, ['rev-parse', 'HEAD']), index: git(repo, ['ls-files', '-s']), tree: treeHash(repo), status: git(repo, ['status', '--porcelain']), revertHead: existsSync(path.join(repo, '.git', 'REVERT_HEAD')) });
  t.after(async () => {
    // 只结束本 fixture 清单里记录的派发进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 撤销 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

const change = { writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改 src/a.js' };
const fileA = f => readFileSync(path.join(f.repo, 'src/a.js'), 'utf8');

for (const squash of [false, true]) {
  test(`1 ${squash ? 'squash' : 'no-ff'} 合并后撤销：文件回到合并前、只多一个 Revert 提交、reverted 事件字段齐、状态仍是 accepted、不推送`, async t => {
    const f = fixture(t);
    const task = await f.merged('正常撤销', { squash });
    assert.equal(fileA(f), '改过\n');
    const logBefore = f.log();

    const result = await f.revert('正常撤销');
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const value = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(value), ['ok', 'commit']);
    assert.equal(value.ok, true);
    const head = f.git(['rev-parse', 'HEAD']);
    assert.equal(value.commit, head.slice(0, 7), 'commit 是反向提交的短 SHA');

    assert.equal(fileA(f), '初始\n', '文件回到合并前');
    assert.equal(f.git(['status', '--porcelain']), '');
    assert.deepEqual(f.log().slice(1), logBefore, 'git log 只多一个提交，历史没有被改写');
    const subject = f.git(['log', '-1', '--format=%s']);
    assert.equal(subject, `Revert "[执行] 合并 正常撤销：${task.title}"`, '提交信息是 git 默认的 Revert "…"');
    assert.equal(f.git(['log', '-1', '--format=%P']).split(' ').length, 1, '反向提交是普通提交');
    assert.equal(f.git(['rev-parse', 'HEAD~1']), task.merge, '反向提交紧接在合并提交后面');

    const events = f.events(task.id);
    const reverted = events.find(row => row.event === 'reverted');
    assert.deepEqual(Object.keys(reverted).sort(), ['at', 'by', 'commit', 'event', 'id', 'v']);
    assert.equal(reverted.v, 1);
    assert.equal(reverted.commit, head, 'commit 是完整 SHA');
    assert.equal(reverted.by, 'human');
    assert.ok(Number.isFinite(reverted.at));
    assert.equal(events.at(-1).event, 'reverted');
    assert.equal(events.filter(row => row.event === 'accepted').length, 1);

    // 状态仍是 accepted；status 多一个 reverted。
    const status = await f.ar(['status', '正常撤销', '--json']);
    const state = JSON.parse(status.stdout);
    assert.equal(state.state, 'accepted');
    assert.equal(state.merge, task.merge);
    assert.deepEqual(state.reverted, { commit: head, at: reverted.at, by: 'human' });
    const text = await f.ar(['status', '正常撤销']);
    assert.match(text.stdout, new RegExp(`^已撤销：提交 ${head.slice(0, 7)}（\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}）$`, 'm'));

    // 撤销过的不能再撤销。
    const again = await f.revert('正常撤销');
    assert.equal(again.code, 2);
    assert.match(JSON.parse(again.stdout).error, /^已经撤销过：正常撤销/);
    assert.equal(f.git(['rev-parse', 'HEAD']), head);
  });
}

test('2 撤销后不自动推送：项目配了远程且开了 push.afterAccept，撤销只在本地追加提交，裸仓库没有新提交、清单没有 push 事件', async t => {
  // 128（推送核心）已合入：合并时 push.afterAccept 会自动推送并写 push 事件；这里只断言撤销没有再推、没有再写。
  const f = fixture(t, { project: { push: { remote: 'origin', afterAccept: true, allowLead: false } } });
  const bare = path.join(f.base, '远程.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: f.env });
  f.git(['remote', 'add', 'origin', bare]);
  f.git(['push', '-q', 'origin', 'main']);
  const task = await f.merged('不推送');
  const remoteMain = () => execFileSync('git', ['rev-parse', 'main'], { cwd: bare, env: f.env, encoding: 'utf8' }).trim();
  // 合并结果先推上去（模拟合并后推送已经成功）；撤销之后裸仓库不应该再变。
  f.git(['push', '-q', 'origin', 'main']);
  const before = remoteMain();
  assert.equal(before, task.merge);
  const pushEventsBefore = f.events(task.id).filter(row => row.event === 'push').length;
  const result = await f.revert('不推送');
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(remoteMain(), before, '撤销后裸仓库没有新提交');
  assert.notEqual(f.git(['rev-parse', 'HEAD']), before, '本地多了反向提交');
  assert.equal(f.events(task.id).filter(row => row.event === 'push').length, pushEventsBefore, '撤销没有新写 push 事件');
});

for (const squash of [false, true]) {
  test(`3 ${squash ? 'squash' : 'no-ff'} 合并后同一处又被改过：撤销冲突，退出码 4、返回冲突文件，主分支字节级不变，没有 reverted 事件`, async t => {
    const f = fixture(t);
    const task = await f.merged('冲突撤销', { squash });
    f.write('src/a.js', '合并之后又改了\n');
    f.commitAll('合并之后又改 src/a.js');
    const before = f.snapshot();
    const eventsBefore = f.events(task.id).length;

    const result = await f.revert('冲突撤销');
    assert.equal(result.code, 4, result.stderr + result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, conflict: true, files: ['src/a.js'] });
    assert.deepEqual(f.snapshot(), before, 'HEAD、索引、工作区、git status 都和撤销前完全一样');
    assert.equal(before.revertHead, false);
    assert.equal(fileA(f), '合并之后又改了\n');
    assert.equal(f.events(task.id).length, eventsBefore, '没有写任何事件');
    assert.ok(!f.events(task.id).some(row => row.event === 'reverted'));
    assert.equal((JSON.parse((await f.ar(['status', '冲突撤销', '--json'])).stdout)).reverted, undefined);

    // 不加 --json 的文字：冲突文件与“主分支没有变化”。
    const text = await f.ar(['revert', '冲突撤销']);
    assert.equal(text.code, 4);
    assert.match(text.stdout, /撤销冲突：src\/a\.js/);
    assert.deepEqual(f.snapshot(), before);
  });
}

test('4 拒绝的情况：每种都退出码 2、中文原因、什么都不改', async t => {
  const f = fixture(t);
  const refused = async (name, matcher, label, code) => {
    const before = f.snapshot();
    const count = rows(f.home).length;
    const result = await f.revert(name);
    assert.equal(result.code, 2, `${label}：${result.stderr}${result.stdout}`);
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, false);
    assert.match(value.error, matcher, label);
    if (code) assert.equal(value.code, code, label);
    assert.deepEqual(f.snapshot(), before, `${label}：主工作区什么都没改`);
    assert.equal(rows(f.home).length, count, `${label}：没有写任何事件`);
    return value;
  };

  await refused('不存在的任务', /找不到记录 不存在的任务/, '找不到任务');

  // 待验收：还没合并。
  await f.task('待验收的', change);
  await refused('待验收的', /^任务还没有合并，不能撤销：待验收的$/, '未合并（待验收）');

  // 已驳回。
  await f.task('驳回的', change);
  assert.equal((await f.ar(['reject', '驳回的', '--reason', '不要了', '--json'])).code, 0);
  await refused('驳回的', /^任务还没有合并，不能撤销：驳回的$/, '已驳回');

  // 确认：没有新提交的任务，accept 是确认，merge 为 null。
  await f.task('只读的', {});
  const confirmed = await f.ar(['accept', '只读的', '--json']);
  assert.equal(JSON.parse(confirmed.stdout).mode, 'confirm', confirmed.stdout);
  await refused('只读的', /^这是一次确认，没有合并提交，不能撤销：只读的$/, '确认');

  // 不是 worktree 任务。
  await f.task('不用工作树的', change, { args: ['--no-worktree'] });
  await refused('不用工作树的', /^任务不是 worktree 模式/, '不是 worktree 任务');

  // 合并过的任务：不在主分支、主工作区不干净、缺身份、合并提交不在历史里，条件解除后可以撤销。
  const task = await f.merged('合并过的', { profile: { writes: [{ path: 'src/b.js', content: 'b\n' }], commit: '假执行者：b' } });
  f.git(['switch', '-q', '-c', 'other']);
  await refused('合并过的', /^主工作区当前在 other，撤销要在 main 上进行：先 git switch main$/, '不在主分支');
  f.git(['switch', '-q', 'main']);

  f.write('README.md', '# 说明（改过）\n');
  f.write('notes/草稿.txt', '草稿\n');
  const dirty = await refused('合并过的', /^主工作区有未提交的改动，先提交或暂存：/, '主工作区不干净', 'DIRTY_MAIN');
  assert.ok(dirty.error.includes('README.md') && dirty.error.includes('notes/草稿.txt'), dirty.error);
  assert.deepEqual([...dirty.files].sort(), ['README.md', 'notes/草稿.txt']);
  f.git(['checkout', '-q', '--', 'README.md']);
  rmSync(path.join(f.repo, 'notes'), { recursive: true, force: true });

  f.git(['config', '--unset', 'user.name']);
  f.git(['config', '--unset', 'user.email']);
  await refused('合并过的', /提交身份/, '缺提交身份', 'NEED_GIT_IDENTITY');
  f.git(['config', 'user.name', '撤销测试']);
  f.git(['config', 'user.email', 'revert@example.test']);

  // 合并提交不在主分支历史里（主分支被回退到合并前）。
  const head = f.git(['rev-parse', 'HEAD']);
  f.git(['reset', '-q', '--hard', `${task.merge}~1`]);
  await refused('合并过的', new RegExp(`^合并提交 ${task.merge.slice(0, 7)} 已经不在 main 的历史里，不能撤销$`), '合并提交不在历史里');
  f.git(['reset', '-q', '--hard', head]);

  // 全部解除后同一个任务可以撤销。
  const ok = await f.revert('合并过的');
  assert.equal(ok.code, 0, ok.stderr + ok.stdout);
  assert.equal(existsSync(path.join(f.repo, 'src/b.js')), false);
});

test('5 ar status / ar report：已撤销的那一行与 JSON；评分不因撤销改变，只在“驳回”项的说明里注明', async t => {
  const f = fixture(t);
  const task = await f.merged('报告任务');
  const report = async () => {
    const result = await f.ar(['report', '报告任务', '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  const before = await report();
  const rejectedBefore = before.lead.items.find(item => item.key === 'rejected');
  assert.deepEqual([rejectedBefore.count, rejectedBefore.detail], [0, null]);
  assert.equal((await f.ar(['status', '报告任务', '--json']).then(r => JSON.parse(r.stdout))).reverted, undefined, '没撤销时 status 没有 reverted');

  const result = await f.revert('报告任务');
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const commit = f.git(['rev-parse', 'HEAD']);
  const after = await report();
  const rejectedAfter = after.lead.items.find(item => item.key === 'rejected');
  assert.deepEqual([rejectedAfter.count, rejectedAfter.points, rejectedAfter.detail], [0, 0, `已撤销（提交 ${commit.slice(0, 7)}）`]);
  assert.equal(after.lead.score, before.lead.score, '主导评分不变');
  assert.equal(after.executor.score, before.executor.score, '执行者评分不变');
  assert.equal(after.state, 'accepted');
  const strip = value => value.items.map(item => (item.key === 'rejected' ? { ...item, detail: null } : item));
  assert.deepEqual(strip(after.lead), strip(before.lead), '其他项都不变');

  const text = await f.ar(['report', '报告任务']);
  assert.match(text.stdout, new RegExp(`驳回：已撤销（提交 ${commit.slice(0, 7)}）`));
  assert.ok(f.events(task.id).some(row => row.event === 'reverted'));
});

test('6 已撤销的任务残留的 worktree 仍按 accepted 清理：worktreeOutcome 不受 reverted 影响，ar gc 当作“任务已合并”', async t => {
  const f = fixture(t);
  const task = await f.task('残留的', change);
  // 手写 accepted 与 reverted（相当于合并、撤销之后清理失败留下 worktree）。
  const line = event => `${JSON.stringify({ v: 1, id: task.id, at: Date.now(), ...event })}\n`;
  appendFileSync(path.join(f.home, 'runs.jsonl'), line({ event: 'accepted', merge: 'c'.repeat(40), mode: 'squash', by: 'cli' }) + line({ event: 'reverted', commit: 'd'.repeat(40), by: 'human' }));
  assert.equal(worktreeOutcome(path.join(f.home, 'runs.jsonl'), task.id), 'accepted');
  assert.ok(existsSync(task.wt.dir));

  const dry = await f.ar(['gc', '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.stderr + dry.stdout);
  assert.deepEqual(JSON.parse(dry.stdout).worktrees, [{ dir: task.wt.dir, reason: 'accepted' }]);
  const cleaned = await f.ar(['gc', '--json']);
  assert.equal(cleaned.code, 0, cleaned.stderr + cleaned.stdout);
  assert.ok(!existsSync(task.wt.dir), 'worktree 已清理');
  assert.ok(!f.git(['branch', '--list', '--format=%(refname:short)']).split('\n').includes(task.wt.branch), '分支已删除');
});
