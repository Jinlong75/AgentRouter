import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// Stage07c 136：ar dispatch --base <分支>。真实 git 仓库（有 main 与 stage/x 两个分支，worktree: true，主工作区停在 stage/x），
// AR_WORKTREE_ROOT 与 AGENT_ROUTER_HOME 都在用例自己的临时目录，执行者是 fake；远程是本机裸仓库。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const commitAll = (root, message) => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
};
const readRows = home => {
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

function fixture(t, { project = {} } = {}) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 基线分支 '));
  const remote = path.join(base, 'remote.git');
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'wt 根'), AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE']) delete env[key];
  git(base, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '基线分支测试']);
  git(repo, ['config', 'user.email', 'dispatch-base@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), 'one\ntwo\nthree\n');
  const projectConfig = { v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true, ...project };
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify(projectConfig, null, 2));
  commitAll(repo, '初始提交');
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', 'origin', 'main']);
  // stage/x 比 main 多一个提交；主工作区停在 stage/x。
  git(repo, ['switch', '-q', '-c', 'stage/x']);
  write(path.join(repo, 'stage.txt'), '阶段分支的文件\n');
  commitAll(repo, '阶段分支的提交');
  const f = { base, remote, repo, home, env, since, count: 0 };
  f.setProfile = value => write(path.join(home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
    profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...value } },
  }));
  f.setProfile({});
  f.ar = (args, { env: extra = {} } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, 120000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  f.rows = () => readRows(home);
  f.events = id => f.rows().filter(row => row.id === id);
  f.start = name => f.rows().find(row => row.event === 'start' && row.name === name);
  f.dispatchJson = name => JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'dispatch.json'), 'utf8'));
  f.progress = name => readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  f.projectBytes = () => readFileSync(path.join(repo, '.agent-router/project.json'));
  // 在当前分支写并提交任务说明，返回相对路径。
  f.spec = (name, { allowed = 'src/**' } = {}) => {
    f.count += 1;
    const rel = `docs/specs/${930 + f.count}-${name}.md`;
    write(path.join(repo, rel), ['---', `id: ${930 + f.count}`, `title: 基线分支 ${name}`, 'type: code', 'expect_commit: false', 'allowed_paths:', `  - ${allowed}`, '---', '', '测试说明正文。', ''].join('\n'));
    commitAll(repo, `任务说明 ${name}`);
    return rel;
  };
  // 派发一个会改 src/a.js 并提交的假任务（默认 --base stage/x），返回 { name, id, start, wt }。
  f.task = async (name, { content = `改过 ${name}\n`, args = ['--base', 'stage/x'], file = 'src/a.js' } = {}) => {
    f.setProfile({ writes: [{ path: file, content }], commit: `假执行者：${name}` });
    const rel = f.spec(name);
    const result = await f.ar(['dispatch', rel, '--name', name, ...args, '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const start = f.start(name);
    return { name, rel, id: start.id, start, wt: f.rows().find(row => row.id === start.id && row.event === 'worktree') };
  };
  t.after(async () => {
    await cleanupProcesses(base, { recorded: recordedStarts(f.rows(), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 基线分支 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('1 --base stage/x：worktree 从 stage/x 开出；project.json 一个字节不变；dispatch.json 与 start 有 baseBranch（不在 options 里）；ar status 多一行', async t => {
  const f = fixture(t);
  const stageHead = git(f.repo, ['rev-parse', 'stage/x']);
  const mainHead = git(f.repo, ['rev-parse', 'main']);
  const projectBefore = f.projectBytes();
  f.setProfile({ writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改' });
  const rel = f.spec('基本');
  const stageAfterSpec = git(f.repo, ['rev-parse', 'stage/x']);

  const result = await f.ar(['dispatch', rel, '--name', '基本', '--base', 'stage/x', '--sandbox', 'workspace-write', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).exit, 0);
  const start = f.start('基本');
  assert.equal(start.base, stageAfterSpec, 'start.base 是 stage/x 当时的提交');
  assert.notEqual(start.base, mainHead);
  assert.notEqual(stageAfterSpec, stageHead);
  assert.equal(start.baseBranch, 'stage/x');
  const wt = f.rows().find(row => row.id === start.id && row.event === 'worktree');
  assert.equal(wt.base, stageAfterSpec);
  assert.equal(readFileSync(path.join(wt.dir, 'stage.txt'), 'utf8'), '阶段分支的文件\n', 'worktree 里有 stage/x 的文件');
  assert.equal(git(f.repo, ['merge-base', '--is-ancestor', 'main', wt.branch]), '');
  const saved = f.dispatchJson('基本');
  assert.equal(saved.baseBranch, 'stage/x');
  assert.ok(!('baseBranch' in (saved.options ?? {})), 'baseBranch 不放进 options');
  assert.deepEqual(Object.keys(saved.options), ['sandbox']);
  assert.ok(f.projectBytes().equals(projectBefore), 'project.json 逐字节相同');

  const status = await f.ar(['status', '基本']);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /^基线分支：stage\/x（这次派发指定）$/m);
  const statusJson = JSON.parse((await f.ar(['status', '基本', '--json'])).stdout);
  assert.equal(statusJson.baseBranch, 'stage/x');
  assert.equal(statusJson.state, 'awaiting');
});

test('2 ar accept：主工作区在 stage/x 时合并进 stage/x，main 不动；在 main 时拒绝并提示 git switch stage/x', async t => {
  const f = fixture(t);
  const task = await f.task('验收');
  const mainHead = git(f.repo, ['rev-parse', 'main']);
  const stageHead = git(f.repo, ['rev-parse', 'stage/x']);

  git(f.repo, ['switch', '-q', 'main']);
  let result = await f.ar(['accept', task.name, '--json']);
  assert.equal(result.code, 2, result.stderr + result.stdout);
  assert.match(JSON.parse(result.stdout).error, /合并要在 stage\/x 上进行：先 git switch stage\/x/);
  assert.equal(git(f.repo, ['rev-parse', 'main']), mainHead);
  assert.equal(git(f.repo, ['rev-parse', 'stage/x']), stageHead);

  git(f.repo, ['switch', '-q', 'stage/x']);
  result = await f.ar(['accept', task.name, '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(git(f.repo, ['rev-parse', 'stage/x']), value.merge, 'stage/x 指向合并提交');
  assert.equal(git(f.repo, ['rev-parse', `${value.merge}^1`]), stageHead);
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), '改过 验收\n');
  assert.equal(git(f.repo, ['rev-parse', 'main']), mainHead, 'main 没动');
});

test('3 ar retry --rebase：合并的是 stage/x 的新提交，不是 main', async t => {
  const f = fixture(t);
  const x = await f.task('冲突X', { content: 'one\nTWO-X\nthree\n' });
  const y = await f.task('冲突Y', { content: 'one\nTWO-Y\nthree\n' });
  let result = await f.ar(['accept', x.name, '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  // 批准 X 后 Y 自动按新基线重跑门禁，有冲突：Y 已在冲突状态（不再等批准 Y 才得到退出码 4）。
  await until(() => f.events(y.id).some(row => row.event === 'conflict'), 'Y 的自动重跑冲突');
  result = await f.ar(['status', y.name, '--json']);
  assert.equal(JSON.parse(result.stdout).state, 'conflict', result.stderr + result.stdout);

  // main 上来了一个提交（不该被合并进来）；stage/x 上来了一个不冲突的新提交：改动和 Y 的一样，再加一个无关文件。
  git(f.repo, ['switch', '-q', 'main']);
  write(path.join(f.repo, 'main-only.txt'), 'main 上的文件\n');
  commitAll(f.repo, 'main 的新提交');
  git(f.repo, ['switch', '-q', 'stage/x']);
  write(path.join(f.repo, 'src/a.js'), 'one\nTWO-Y\nthree\n');
  write(path.join(f.repo, 'src/other.js'), '无关的新文件\n');
  commitAll(f.repo, 'stage/x 的新提交');
  const newBase = git(f.repo, ['rev-parse', 'stage/x']);
  const stageBefore = newBase;

  const endsBefore = f.events(y.id).filter(row => row.event === 'end').length;
  result = await f.ar(['retry', y.name, '--rebase', '--detach', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  await until(() => f.events(y.id).filter(row => row.event === 'end').length > endsBefore, '重新基线后的 end');
  const attempt = f.events(y.id).findLast(row => row.event === 'attempt');
  assert.equal(attempt.reason, 'rebase');
  assert.equal(attempt.base, newBase, '门禁基线是 stage/x 的新提交');
  assert.equal(f.events(y.id).findLast(row => row.event === 'gate').ok, true);
  assert.match(f.progress(y.name), new RegExp(`合并 stage/x（${newBase.slice(0, 7)}）：没有冲突，只重跑门禁`));
  assert.ok(existsSync(path.join(y.wt.dir, 'src/other.js')), 'stage/x 的新文件合并进来了');
  assert.ok(!existsSync(path.join(y.wt.dir, 'main-only.txt')), 'main 的文件没有合并进来');
  assert.equal(f.dispatchJson(y.name).gate.base, newBase);
  assert.equal(f.dispatchJson(y.name).baseBranch, 'stage/x');

  result = await f.ar(['accept', y.name, '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(git(f.repo, ['rev-parse', `${JSON.parse(result.stdout).merge}^1`]), stageBefore);
  assert.ok(!existsSync(path.join(f.repo, 'main-only.txt')));
});

test('4 ar revert：在 stage/x 上撤销；在 main 上拒绝', async t => {
  const f = fixture(t);
  const task = await f.task('撤销');
  let result = await f.ar(['accept', task.name, '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const merged = git(f.repo, ['rev-parse', 'stage/x']);
  const mainHead = git(f.repo, ['rev-parse', 'main']);

  git(f.repo, ['switch', '-q', 'main']);
  result = await f.ar(['revert', task.name, '--json']);
  assert.equal(result.code, 2, result.stderr + result.stdout);
  assert.match(JSON.parse(result.stdout).error, /撤销要在 stage\/x 上进行：先 git switch stage\/x/);

  git(f.repo, ['switch', '-q', 'stage/x']);
  result = await f.ar(['revert', task.name, '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const commit = git(f.repo, ['rev-parse', 'stage/x']);
  assert.ok(commit.startsWith(JSON.parse(result.stdout).commit), 'stage/x 指向反向提交');
  assert.equal(git(f.repo, ['rev-parse', `${commit}^`]), merged);
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), 'one\ntwo\nthree\n', '改动被撤销');
  assert.equal(git(f.repo, ['rev-parse', 'main']), mainHead, 'main 没动');
});

test('5 push.afterAccept: true 且配了远程：基线不是项目主分支时不推送，结果与进度里写原因；显式 --push 同样不推送，合并照常完成', async t => {
  const f = fixture(t, { project: { push: { afterAccept: true } } });
  const remoteMain = git(f.remote, ['rev-parse', 'refs/heads/main']);
  const a = await f.task('推送甲');
  let result = await f.ar(['accept', a.name, '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  let value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.deepEqual(value.push, { skipped: true, reason: '这次派发的基线是 stage/x，不是项目主分支 main，不自动推送' });
  assert.equal(git(f.repo, ['rev-parse', 'stage/x']), value.merge, '合并已完成');
  assert.equal(git(f.remote, ['rev-parse', 'refs/heads/main']), remoteMain, '远程 main 没有新提交');
  assert.equal(git(f.remote, ['branch', '--list']).replace(/[*\s]/g, ''), 'main', '远程没有 stage/x');
  assert.match(f.progress(a.name), /批准后没有推送：这次派发的基线是 stage\/x，不是项目主分支 main，不自动推送/);
  assert.ok(!f.events(a.id).some(row => row.event === 'push'), '没有 push 事件');

  // 人看的输出。
  const b = await f.task('推送乙', { content: '乙\n' });
  result = await f.ar(['accept', b.name, '--push']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /已合并，没有推送：这次派发的基线是 stage\/x，不是项目主分支 main，不自动推送/);
  assert.equal(git(f.remote, ['rev-parse', 'refs/heads/main']), remoteMain);

  // --no-push 不推送，也不写跳过说明。
  const c = await f.task('推送丙', { content: '丙\n' });
  result = await f.ar(['accept', c.name, '--no-push', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.ok(!('push' in JSON.parse(result.stdout)));
  assert.ok(!f.progress(c.name).includes('批准后没有推送'));
});

test('6 拒绝的情况：分支不存在、分支名无效、缺值、--no-worktree、直接写任务文字、任务说明不在 stage/x 里；退出码 2、中文说明、不留记录', async t => {
  const f = fixture(t);
  f.setProfile({});
  const rel = f.spec('拒绝');
  // 只提交在 main 的任务说明：先在 main 上提交，回到 stage/x 后把文件放回工作区（没提交到 stage/x）。
  git(f.repo, ['switch', '-q', 'main']);
  const mainOnly = f.spec('只在main');
  const mainOnlyText = readFileSync(path.join(f.repo, mainOnly), 'utf8');
  git(f.repo, ['switch', '-q', 'stage/x']);
  write(path.join(f.repo, mainOnly), mainOnlyText);
  const cases = [
    [[rel, '--base', 'nope'], /找不到主分支 nope 的提交/],
    [[rel, '--base', 'bad..name'], /--base 的分支名无效：bad\.\.name/],
    [[rel, '--base'], /--base 后面要写分支名/],
    [[rel, '--base', '--detach'], /--base 后面要写分支名/],
    [[rel, '--base', 'stage/x', '--no-worktree'], /--base 只用于 worktree 模式的任务（用任务说明派发、项目开启 worktree）/],
    [['说一句话', '--base', 'stage/x'], /--base 只用于 worktree 模式的任务（用任务说明派发、项目开启 worktree）/],
    [[mainOnly, '--base', 'stage/x'], /任务说明还没提交到 stage\/x/],
  ];
  for (const [args, pattern] of cases) {
    const result = await f.ar(['dispatch', ...args, '--json']);
    assert.equal(result.code, 2, `${args.join(' ')}：${result.stderr}${result.stdout}`);
    assert.match(JSON.parse(result.stdout).error, pattern, args.join(' '));
  }
  // 项目配置不开 worktree 时同样拒绝。
  const project = JSON.parse(readFileSync(path.join(f.repo, '.agent-router/project.json'), 'utf8'));
  project.worktree = false;
  write(path.join(f.repo, '.agent-router/project.json'), JSON.stringify(project, null, 2));
  git(f.repo, ['add', '--', '.agent-router/project.json']);
  git(f.repo, ['commit', '-q', '-m', '关闭 worktree']);
  const off = await f.ar(['dispatch', rel, '--base', 'stage/x', '--json']);
  assert.equal(off.code, 2);
  assert.match(JSON.parse(off.stdout).error, /--base 只用于 worktree 模式的任务/);
  assert.equal(f.rows().filter(row => row.event === 'start').length, 0, '一个任务都没有开始');
});

test('7 --detach 同样生效；ar redispatch 沿用 --base', async t => {
  const f = fixture(t);
  f.setProfile({ writes: [{ path: 'src/a.js', content: '脱离\n' }], commit: '假执行者：脱离' });
  const rel = f.spec('脱离');
  const stageHead = git(f.repo, ['rev-parse', 'stage/x']);
  const projectBefore = f.projectBytes();

  let result = await f.ar(['dispatch', rel, '--name', '脱离', '--base', 'stage/x', '--detach', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const id = JSON.parse(result.stdout).id;
  await until(() => f.events(id).some(row => row.event === 'end'), '脱离任务的 end');
  const start = f.start('脱离');
  assert.equal(start.baseBranch, 'stage/x');
  assert.equal(start.base, stageHead);
  assert.equal(f.dispatchJson('脱离').baseBranch, 'stage/x');
  assert.equal(f.events(id).findLast(row => row.event === 'end').exit, 0);
  assert.equal(readFileSync(path.join(f.rows().find(row => row.id === id && row.event === 'worktree').dir, 'stage.txt'), 'utf8'), '阶段分支的文件\n');

  result = await f.ar(['redispatch', '脱离', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const again = JSON.parse(result.stdout).name;
  assert.notEqual(again, '脱离');
  assert.equal(f.start(again).baseBranch, 'stage/x');
  assert.equal(f.start(again).base, stageHead);
  assert.equal(f.dispatchJson(again).baseBranch, 'stage/x');
  assert.ok(f.projectBytes().equals(projectBefore));
});

test('8 不带 --base 的对照：dispatch.json 与 start 没有 baseBranch，ar status 没有"基线分支"，行为照旧', async t => {
  const f = fixture(t);
  // 普通任务的任务说明提交在 main 上。
  git(f.repo, ['switch', '-q', 'main']);
  const task = await f.task('对照', { args: [] });
  assert.ok(!('baseBranch' in f.dispatchJson('对照')));
  assert.ok(!('baseBranch' in task.start));
  assert.equal(task.start.base, git(f.repo, ['rev-parse', 'main']));
  assert.ok(!existsSync(path.join(task.wt.dir, 'stage.txt')), '从 main 开出，没有 stage/x 的文件');
  const status = await f.ar(['status', '对照']);
  assert.equal(status.code, 0, status.stderr);
  assert.doesNotMatch(status.stdout, /^基线分支：/m);
  assert.ok(!('baseBranch' in JSON.parse((await f.ar(['status', '对照', '--json'])).stdout)));

  // main 上批准，合并进 main。
  const result = await f.ar(['accept', '对照', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(git(f.repo, ['rev-parse', 'main']), JSON.parse(result.stdout).merge);
});
