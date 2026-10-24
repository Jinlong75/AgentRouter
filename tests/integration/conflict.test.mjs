import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 085：合并冲突与 ar retry --rebase（协议 15.6 冲突、15.8）。真实 git 仓库，AR_WORKTREE_ROOT 与 AGENT_ROUTER_HOME 在用例自己的临时目录；
// 任务用 fake 执行者；解决冲突的"执行者"是测试自己写的一个 Node 脚本（经 AR_TEST_AGENT 指定），因为 fake 的提交方式不能在合并进行中提交。
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

// 主工作区的指纹：除 .git 与 .agent-runs 外所有文件的相对路径与字节。
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

// 冲突的"执行者"：读完指令后把 src/a.js 写成合并双方意图的版本，git add 并提交（不带路径，合并进行中才能提交），再写汇报。
const resolver = `import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('resolver-test 1.0'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const run = args => spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8', shell: false, windowsHide: true });
  const state = run(['rev-parse', '--git-path', 'MERGE_HEAD']);
  const mergeHead = readFileSync(state.stdout.trim(), 'utf8').trim();
  writeFileSync('src/a.js', 'one\\nTWO-X TWO-Y\\nthree\\n');
  const added = run(['add', 'src/a.js']);
  const committed = run(['commit', '-m', '解决冲突：合并双方的改动']);
  if (added.status !== 0 || committed.status !== 0) { process.stderr.write(added.stderr + committed.stderr); process.exit(1); }
  const report = process.argv[process.argv.indexOf('-o') + 1];
  writeFileSync(report, '已解决冲突，合并了 ' + mergeHead.slice(0, 7) + '\\n');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '已解决冲突' } }));
});
`;

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 冲突 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  mkdirSync(repo);
  mkdirSync(home);
  const resolverFile = path.join(base, 'resolver.mjs');
  writeFileSync(resolverFile, resolver);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'wt 根'), AR_NO_WATCH: '1', CODEX_HOME: path.join(base, 'codex 家') };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '冲突测试']);
  git(repo, ['config', 'user.email', 'conflict@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), 'one\ntwo\nthree\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true }, null, 2));
  commitAll(repo, '初始提交');
  const f = { base, repo, home, env, since, count: 0, resolverFile };
  f.setProfile = value => write(path.join(home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
    profiles: {
      fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...value },
      resolver: { adapter: 'codex', label: '冲突解决者', enabled: true },
    },
  }));
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
  f.task = async (name, profile = {}) => {
    f.setProfile(profile);
    f.count += 1;
    const rel = `docs/specs/${920 + f.count}-conflict.md`;
    write(path.join(repo, rel), ['---', 'id: 920', 'title: 冲突测试', 'type: code', 'expect_commit: false', 'allowed_paths:', '  - src/**', 'verify:', '  - node -e "process.exit(0)"', '---', '', '正文。', ''].join('\n'));
    commitAll(repo, `任务说明 ${name}`);
    const result = await f.ar(['dispatch', rel, '--name', name, '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const start = rows(home).find(row => row.event === 'start' && row.name === name);
    const wt = rows(home).find(row => row.id === start.id && row.event === 'worktree');
    return { name, start, wt, id: start.id };
  };
  f.events = id => rows(home).filter(row => row.id === id);
  // 两个任务改同一行；先 accept 第一个，第二个留在待验收。
  f.conflictPair = async suffix => {
    const x = await f.task(`冲突X${suffix}`, { writes: [{ path: 'src/a.js', content: 'one\nTWO-X\nthree\n' }], commit: 'X 改第二行' });
    const y = await f.task(`冲突Y${suffix}`, { writes: [{ path: 'src/a.js', content: 'one\nTWO-Y\nthree\n' }], commit: 'Y 改第二行' });
    const accepted = await f.ar(['accept', x.name, '--json']);
    assert.equal(accepted.code, 0, accepted.stderr + accepted.stdout);
    return { x, y };
  };
  // 主分支的指纹：HEAD、文件字节、暂存区、git status，以及没有合并进行中的痕迹。
  f.mainState = () => ({
    head: git(repo, ['rev-parse', 'HEAD']), tree: treeHash(repo), index: git(repo, ['ls-files', '-s']), status: git(repo, ['status', '--porcelain']),
    mergeHead: existsSync(path.join(repo, '.git', 'MERGE_HEAD')), squashMsg: existsSync(path.join(repo, '.git', 'SQUASH_MSG')),
  });
  t.after(async () => {
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 冲突 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('1 冲突：accept 退出码 4、conflict 事件、主分支字节不变；不带 --rebase 的 retry 被拒；--rebase 派执行者解决 → 门禁 → 待验收 → accept 成功', async t => {
  const f = fixture(t);
  const { x, y } = await f.conflictPair('一');
  const mainBefore = f.mainState();
  assert.equal(mainBefore.status, '');

  // --no-ff 冲突：merge --abort 后主分支恢复原样。
  let result = await f.ar(['accept', y.name, '--json']);
  assert.equal(result.code, 4, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, conflict: true, files: ['src/a.js'] });
  assert.deepEqual(f.mainState(), mainBefore, 'merge --abort 后主分支字节不变');
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), 'one\nTWO-X\nthree\n', '没有冲突标记留在主工作区');

  const conflicts = f.events(y.id).filter(row => row.event === 'conflict');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(Object.keys(conflicts[0]).sort(), ['at', 'event', 'files', 'id', 'v']);
  assert.deepEqual(conflicts[0].files, ['src/a.js']);
  assert.equal(conflicts[0].v, 1);
  assert.ok(!f.events(y.id).some(row => row.event === 'accepted'));
  assert.ok(existsSync(y.wt.dir), '冲突后 worktree 保留');
  // 冲突状态下不能再 accept（不在待验收）。
  result = await f.ar(['accept', y.name, '--json']);
  assert.equal(result.code, 2);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: `任务不在待验收状态：${y.name}` });

  // 不带 --rebase 的 retry 被拒绝并提示。
  for (const args of [[], ['--note', '直接再试']]) {
    result = await f.ar(['retry', y.name, ...args, '--json']);
    assert.equal(result.code, 2, result.stdout);
    const error = JSON.parse(result.stdout).error;
    assert.match(error, /合并冲突/);
    assert.ok(error.includes('--rebase'), error);
  }
  assert.ok(!f.events(y.id).some(row => row.event === 'resume'), '被拒绝的 retry 没写任何事件');

  // --rebase：在原 worktree 里合并主分支 → 有冲突 → 派执行者（冲突解决者）一次 → 门禁 → 待验收。
  const newBase = git(f.repo, ['rev-parse', 'main']);
  result = await f.ar(['retry', y.name, '--rebase', '--profile', 'resolver', '--json'], { env: { AR_TEST_AGENT: f.resolverFile } });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.deepEqual(value.gate, { ok: true, summary: '门禁通过' });
  const events = f.events(y.id);
  const names = events.map(row => row.event);
  const resume = names.lastIndexOf('resume');
  assert.deepEqual(names.slice(resume), ['resume', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end']);
  const attempt = events.findLast(row => row.event === 'attempt');
  assert.equal(attempt.reason, 'conflict');
  assert.equal(attempt.base, newBase, '新基线写在这次 attempt 的 base 上');
  assert.equal(attempt.profile, 'resolver');
  assert.equal(events.find(row => row.event === 'start').base, y.start.base, 'start.base 不变');
  assert.equal(events.at(-1).exit, 0);
  const gateJson = JSON.parse(readFileSync(path.join(y.start.dir, 'attempts', String(attempt.n), 'gate.json'), 'utf8'));
  assert.equal(gateJson.base, newBase, '门禁的基线是合并进来的主分支提交');
  assert.equal(gateJson.ok, true);
  // 指令里有冲突文件清单和要求。
  const prompt = readFileSync(path.join(y.start.dir, 'attempts', String(attempt.n), 'prompt.md'), 'utf8');
  assert.match(prompt, /## 需要解决合并冲突/);
  assert.match(prompt, /- src\/a\.js/);
  assert.match(prompt, /保留双方的意图/);
  assert.match(prompt, /验收命令/);
  assert.equal(git(y.wt.dir, ['status', '--porcelain']), '', '执行者提交了合并，worktree 干净');
  assert.equal(git(y.wt.dir, ['rev-list', '--parents', '-1', 'HEAD']).split(' ').length, 3, '最后一个提交是合并提交');
  assert.deepEqual(f.mainState(), mainBefore, '整个过程主分支没动');

  // 待验收 → accept 成功。
  result = await f.ar(['accept', y.name, '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), 'one\nTWO-X TWO-Y\nthree\n');
  assert.ok(!existsSync(y.wt.dir));
  assert.equal(f.events(y.id).at(-1).event, 'accepted');
  assert.ok(x.id);
});

test('1b --squash 冲突：退出码 4、reset --merge 后主分支字节不变、没有 SQUASH_MSG 残留；不带 --json 时标准输出写明冲突文件', async t => {
  const f = fixture(t);
  const { y } = await f.conflictPair('一乙');
  const mainBefore = f.mainState();
  const result = await f.ar(['accept', y.name, '--squash']);
  assert.equal(result.code, 4, result.stderr + result.stdout);
  assert.match(result.stdout, /合并冲突：src\/a\.js/);
  assert.match(result.stdout, new RegExp(`ar retry ${y.name} --rebase`));
  assert.deepEqual(f.mainState(), mainBefore, 'squash 冲突后主分支字节不变');
  assert.equal(f.mainState().squashMsg, false);
  const conflict = f.events(y.id).findLast(row => row.event === 'conflict');
  assert.deepEqual(conflict.files, ['src/a.js']);
  assert.ok(!f.events(y.id).some(row => row.event === 'accepted'));
});

test('2 --rebase 没有冲突：不启动执行者，只跑门禁（reason rebase），之后待验收并能 accept；--detach 同样', async t => {
  const f = fixture(t);
  const { y } = await f.conflictPair('二');
  let result = await f.ar(['accept', y.name, '--json']);
  assert.equal(result.code, 4);
  // 主分支上来了一个不冲突的新提交：改动和 Y 的完全一样（两边同样的改动合并起来没有冲突），再加一个无关文件。
  write(path.join(f.repo, 'src/a.js'), 'one\nTWO-Y\nthree\n');
  write(path.join(f.repo, 'src/other.js'), '无关的新文件\n');
  commitAll(f.repo, '主分支的新提交');
  const newBase = git(f.repo, ['rev-parse', 'main']);
  const mainBefore = f.mainState();
  const spawnedBefore = f.events(y.id).filter(row => row.event === 'spawned').length;

  const endsBefore = f.events(y.id).filter(row => row.event === 'end').length;
  result = await f.ar(['retry', y.name, '--rebase', '--detach', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  await until(() => f.events(y.id).filter(row => row.event === 'end').length > endsBefore, '重新基线后的 end');
  const events = f.events(y.id);
  const names = events.map(row => row.event);
  assert.deepEqual(names.slice(names.lastIndexOf('resume')), ['resume', 'attempt', 'gating', 'gate', 'attempt-end', 'end'], '没有 spawned');
  assert.equal(events.filter(row => row.event === 'spawned').length, spawnedBefore);
  const attempt = events.findLast(row => row.event === 'attempt');
  assert.equal(attempt.reason, 'rebase');
  assert.equal(attempt.base, newBase);
  assert.equal(events.findLast(row => row.event === 'gate').ok, true);
  const end = events.at(-1);
  assert.equal(end.exit, 0);
  const attemptDir = path.join(y.start.dir, 'attempts', String(attempt.n));
  assert.ok(!existsSync(path.join(attemptDir, 'prompt.md')) && !existsSync(path.join(attemptDir, 'raw.log')), '没有执行者运行的痕迹');
  assert.equal(JSON.parse(readFileSync(path.join(attemptDir, 'gate.json'), 'utf8')).base, newBase);
  assert.match(readFileSync(path.join(y.start.dir, 'progress.log'), 'utf8'), /合并 main（[0-9a-f]{7}）：没有冲突，只重跑门禁/);
  // 合并提交在 worktree 分支上，worktree 干净；dispatch.json 的门禁基线换成了新基线。
  assert.equal(git(y.wt.dir, ['status', '--porcelain']), '');
  assert.equal(git(y.wt.dir, ['rev-list', '--parents', '-1', 'HEAD']).split(' ').length, 3);
  assert.equal(JSON.parse(readFileSync(path.join(y.start.dir, 'dispatch.json'), 'utf8')).gate.base, newBase);
  assert.deepEqual(f.mainState(), mainBefore, '主分支没动');

  result = await f.ar(['accept', y.name, '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), 'one\nTWO-Y\nthree\n');
  assert.ok(existsSync(path.join(f.repo, 'src/other.js')));

  // ar diff 在重新基线之后用新基线（只看任务自己的改动，不含合并进来的主分支提交）。
  result = await f.ar(['diff', y.name, '--json']);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).files.some(item => item.path === 'src/other.js'), false);
});

test('3b --rebase 合并本身没能进行（worktree 里有会被覆盖的未提交改动）：任务以失败结束，仍是冲突状态，清掉改动后可以再 --rebase', async t => {
  const f = fixture(t);
  const { y } = await f.conflictPair('四');
  let result = await f.ar(['accept', y.name, '--json']);
  assert.equal(result.code, 4);
  // 主分支上改了 README；Y 的 worktree 里 README 有未提交的改动，合并会覆盖它，git 拒绝合并（不是冲突）。
  write(path.join(f.repo, 'README.md'), '# 说明（主分支改过）\n');
  commitAll(f.repo, '主分支改 README');
  write(path.join(y.wt.dir, 'README.md'), '# 说明（worktree 里没提交的改动）\n');

  result = await f.ar(['retry', y.name, '--rebase', '--json']);
  assert.equal(result.code, 1, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.match(JSON.parse(result.stdout).error, /合并 main 失败/);
  let names = f.events(y.id).map(row => row.event);
  assert.deepEqual(names.slice(names.lastIndexOf('resume')), ['resume', 'end', 'conflict'], '没有 attempt；conflict 事件写在 end 之后');
  assert.equal(f.events(y.id).findLast(row => row.event === 'end').exit, 1);
  assert.deepEqual(f.events(y.id).at(-1).files, ['src/a.js'], '沿用上一次冲突的文件清单');
  assert.ok(!existsSync(git(y.wt.dir, ['rev-parse', '--git-path', 'MERGE_HEAD'])), '没有半截合并留在 worktree');
  assert.equal(git(y.wt.dir, ['status', '--porcelain']), 'M README.md', '用户的改动原样保留');

  // 状态仍是冲突：不能 accept，不带 --rebase 的 retry 被拒。
  result = await f.ar(['retry', y.name, '--json']);
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stdout).error, /--rebase/);

  git(y.wt.dir, ['checkout', '-q', '--', 'README.md']);
  result = await f.ar(['retry', y.name, '--rebase', '--profile', 'resolver', '--json'], { env: { AR_TEST_AGENT: f.resolverFile } });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  result = await f.ar(['accept', y.name, '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(readFileSync(path.join(f.repo, 'README.md'), 'utf8'), '# 说明（主分支改过）\n');
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), 'one\nTWO-X TWO-Y\nthree\n');
});

test('3 --rebase 只用于冲突的任务；冲突的任务可以驳回：删除 worktree 与分支，主分支不受影响', async t => {
  const f = fixture(t);
  const { x, y } = await f.conflictPair('三');
  // 待验收的任务（未合并）用 --rebase 被拒绝。
  const pending = await f.task('待验收的', { writes: [{ path: 'src/b.js', content: 'b\n' }], commit: '加 b' });
  let result = await f.ar(['retry', pending.name, '--rebase', '--json']);
  assert.equal(result.code, 2);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: `任务不在冲突状态，不能用 --rebase：${pending.name}` });
  // 已合并的任务同样不是冲突状态。
  result = await f.ar(['retry', x.name, '--rebase', '--json']);
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stdout).error, /不能用 --rebase/);

  result = await f.ar(['accept', y.name, '--json']);
  assert.equal(result.code, 4);
  const mainBefore = f.mainState();
  result = await f.ar(['reject', y.name, '--reason', '两个方案冲突，放弃这个', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, keptBranch: false, cleanup: true });
  const events = f.events(y.id);
  assert.deepEqual(events.slice(-2).map(row => row.event), ['conflict', 'rejected']);
  assert.ok(!existsSync(y.wt.dir));
  assert.equal(git(f.repo, ['branch', '--list', y.wt.branch]), '');
  assert.deepEqual(f.mainState(), mainBefore);
  // 驳回之后不能再 --rebase。
  result = await f.ar(['retry', y.name, '--rebase', '--json']);
  assert.equal(result.code, 2);
});
