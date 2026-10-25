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

// 083：派发流程接入 worktree（协议 15.1～15.5）。每个用例在系统临时目录里建一个名字含中文与空格的真实 git 仓库，
// AR_WORKTREE_ROOT 与 AGENT_ROUTER_HOME 都指向用例自己的临时目录，执行者是 fake；不碰真实安装、配置、进程与 worktree 根。
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
  try {
    const text = readFileSync(path.join(home, 'runs.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};
const startOf = (home, name) => rows(home).find(row => row.event === 'start' && row.name === name);
const eventsOf = (home, id) => rows(home).filter(row => row.id === id).map(row => row.event);
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

// 任务说明 frontmatter：只写关心的字段；type 是 code 时 expect_commit 默认为 true，所以不关心提交的用例固定写 false。
function specText({ allowed = null, verify = [], maxRetries, expectCommit = false } = {}) {
  const lines = ['---', 'id: 900', 'title: worktree 派发测试', 'type: code', `expect_commit: ${expectCommit}`];
  if (allowed) {
    lines.push('allowed_paths:');
    for (const item of allowed) lines.push(`  - ${item}`);
  }
  if (verify.length) {
    lines.push('verify:');
    for (const line of verify) lines.push(`  - ${line}`);
  }
  if (maxRetries !== undefined) lines.push(`max_retries: ${maxRetries}`);
  lines.push('---', '', '测试说明正文。', '');
  return lines.join('\n');
}

// worktree：true / false 写进项目配置；null 表示配置里不写这个字段。
function fixture(t, { worktree = true, setup = ['node scripts/setup.mjs'], concurrency } = {}) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar worktree 派发 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  const wtRoot = path.join(base, 'wt 根');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: wtRoot, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'worktree 派发测试']);
  git(repo, ['config', 'user.email', 'worktree-dispatch@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  // 准备脚本：只往被忽略的 node_modules 里写东西，并输出一行，供核对 setup.log。
  write(path.join(repo, 'scripts/setup.mjs'), [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "mkdirSync('node_modules', { recursive: true });",
    "writeFileSync('node_modules/.setup-ran', process.cwd());",
    "console.log('准备脚本已运行');",
    '',
  ].join('\n'));
  // 093：把 AR_BASE_REPO、AR_WORKTREE 与当前目录追加写进 node_modules/env-<标签>.jsonl（被忽略，不算未提交）；
  // 带 --fail-first 时第一次运行写完记录后以 1 退出（用 node_modules/.seen 记住来过），第二次起以 0 退出。
  write(path.join(repo, 'scripts/dump-env.mjs'), [
    "import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';",
    "mkdirSync('node_modules', { recursive: true });",
    "const tag = process.argv[2];",
    "const row = { base: process.env.AR_BASE_REPO ?? null, worktree: process.env.AR_WORKTREE ?? null, cwd: process.cwd() };",
    "appendFileSync(`node_modules/env-${tag}.jsonl`, `${JSON.stringify(row)}\\n`);",
    "if (process.argv.includes('--fail-first') && !existsSync('node_modules/.seen')) { writeFileSync('node_modules/.seen', '1'); process.exit(1); }",
    '',
  ].join('\n'));
  // 验收脚本：src/ok.txt 存在才通过（重试用例靠它让第 1 次失败、第 2 次通过）。
  write(path.join(repo, 'scripts/check.mjs'), "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('src/ok.txt') ? 0 : 1);\n");
  const project = { v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup, verify: [], allowedPaths: ['**'], routing: { rules: [] } };
  if (worktree !== null) project.worktree = worktree;
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify(project, null, 2));
  commitAll(repo, '初始提交');
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 };
  const f = { base, repo, home, wtRoot, env, profile, since };
  f.setProfile = value => {
    Object.assign(profile, value);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile },
      ...(concurrency ? { concurrency } : {}),
    }));
  };
  f.setProfile({});
  f.setProject = value => {
    Object.assign(project, value);
    write(path.join(repo, '.agent-router/project.json'), JSON.stringify(project, null, 2));
  };
  // 写任务说明；默认提交在当前分支。
  f.spec = (rel, fields = {}, { commit = true } = {}) => {
    write(path.join(repo, rel), specText(fields));
    if (commit) commitAll(repo, `任务说明 ${path.basename(rel)}`);
    return rel;
  };
  f.ar = (args, { timeout = 90000, env: extra = {} } = {}) => new Promise((resolve, reject) => {
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
  f.progress = name => readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  f.slots = () => { try { return readdirSync(path.join(home, 'slots')).filter(name => /^(slot|gate)-\d+\.json$/.test(name)); } catch { return []; } };
  f.worktreeDirs = () => { try { return readdirSync(wtRoot); } catch { return []; } };
  f.worktreeEvent = id => rows(home).find(row => row.id === id && row.event === 'worktree');
  t.after(async () => {
    // 只结束本 fixture 清单里记录的派发进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar worktree 派发 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('1 正常流程：事件顺序、worktree 与分支、主工作区字节不变、setup.log、--json、名额清空', async t => {
  const f = fixture(t);
  f.setProfile({ writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改 src/a.js' });
  const spec = f.spec('docs/specs/001-正常 流程.md', { allowed: ['src/**'], verify: ['node -e "process.exit(0)"'] });
  // 主工作区里放一个未跟踪文件和一个被忽略的文件，核对时它们也要原样不变。
  write(path.join(f.repo, 'notes/未跟踪.txt'), '未跟踪的内容\n');
  write(path.join(f.repo, 'node_modules/忽略.txt'), '被忽略的内容\n');
  const hashBefore = treeHash(f.repo);
  const mainBefore = git(f.repo, ['rev-parse', 'main']);

  const result = await f.ar(['dispatch', spec, '--name', '正常流程', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.exit, 0);
  assert.deepEqual(value.gate, { ok: true, summary: '门禁通过' });

  const start = startOf(f.home, '正常流程');
  assert.equal(start.worktree, true);
  assert.equal(start.base, mainBefore, 'start.base 是主分支当时的提交');
  assert.equal(start.gate, true);
  const list = rows(f.home).filter(row => row.id === start.id);
  assert.deepEqual(list.map(row => row.event),
    ['start', 'preparing', 'worktree', 'setup', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end']);
  const wt = list.find(row => row.event === 'worktree');
  assert.equal(wt.base, mainBefore);
  assert.ok(existsSync(wt.dir), 'worktree 目录存在');
  assert.equal(path.dirname(wt.dir), f.wtRoot, 'worktree 在 AR_WORKTREE_ROOT 下');
  assert.match(wt.branch, /^ar\/[0-9a-f]{10}$/, '记录名含中文：分支名用记录名哈希');
  assert.equal(list.find(row => row.event === 'setup').ok, true);
  assert.equal(list.at(-1).exit, 0);
  assert.equal(list.find(row => row.event === 'gate').ok, true);

  // 分支上有执行者的提交，内容在 worktree 里；主分支没动。
  assert.match(git(f.repo, ['log', '--format=%s', `${mainBefore}..${wt.branch}`]), /假执行者：改 src\/a\.js/);
  assert.equal(readFileSync(path.join(wt.dir, 'src/a.js'), 'utf8'), '改过\n');
  assert.equal(git(f.repo, ['rev-parse', 'main']), mainBefore);
  // 准备命令在 worktree 里运行：标记文件在 worktree 的 node_modules 里，不在主工作区。
  assert.ok(existsSync(path.join(wt.dir, 'node_modules/.setup-ran')), '准备命令在 worktree 里运行');
  assert.ok(!existsSync(path.join(f.repo, 'node_modules/.setup-ran')));
  const log = readFileSync(path.join(f.repo, '.agent-runs', '正常流程', 'attempts', '0', 'setup.log'), 'utf8');
  assert.match(log, /^\$ node scripts\/setup\.mjs\r?\n准备脚本已运行\r?\n$/);
  // 记录目录仍在主工作区：gate.json 与 attempts 都在那里，不在 worktree 里。
  assert.ok(existsSync(path.join(start.dir, 'gate.json')));
  assert.ok(!existsSync(path.join(wt.dir, '.agent-runs')));
  assert.equal(JSON.parse(readFileSync(path.join(start.dir, 'gate.json'), 'utf8')).base, mainBefore);
  // 主工作区除 .agent-runs 外字节不变。
  assert.equal(treeHash(f.repo), hashBefore, '主工作区字节不变');
  assert.deepEqual(f.slots(), [], '结束后 slots/ 为空');
});

test('2 任务说明没提交到主分支：退出码 2、原文、没有记录目录、没有 worktree、清单没新行', async t => {
  const f = fixture(t);
  // 只提交在别的分支：检出 other，任务说明在工作区里，但 main 里没有。
  git(f.repo, ['checkout', '-q', '-b', 'other']);
  const onOther = f.spec('docs/specs/002-别的分支.md');
  let result = await f.ar(['dispatch', onOther, '--name', '别的分支', '--json']);
  assert.equal(result.code, 2, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: '任务说明还没提交到 main，执行者看不到它' });
  assert.ok(!existsSync(path.join(f.repo, '.agent-runs')), '没有记录目录');
  // 没提交：回到 main，任务说明只在工作区里。
  git(f.repo, ['checkout', '-q', 'main']);
  const untracked = f.spec('docs/specs/003-没提交.md', {}, { commit: false });
  result = await f.ar(['dispatch', untracked, '--name', '没提交']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /任务说明还没提交到 main，执行者看不到它/);
  assert.ok(!existsSync(path.join(f.repo, '.agent-runs')), '没有记录目录');
  assert.deepEqual(rows(f.home), [], '清单没有新行');
  assert.deepEqual(f.worktreeDirs(), [], '没有建 worktree');
  assert.equal(git(f.repo, ['worktree', 'list']).split('\n').length, 1, 'git 里只有主工作区');
});

test('3 主工作区有未提交改动：允许派发，改动原样保留', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/004-脏工作区.md');
  write(path.join(f.repo, 'README.md'), '# 说明（本地未提交的修改）\n');
  write(path.join(f.repo, 'notes/草稿.txt'), '草稿\n');
  const hashBefore = treeHash(f.repo);
  const result = await f.ar(['dispatch', spec, '--name', '脏工作区', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).exit, 0);
  assert.equal(treeHash(f.repo), hashBefore, '未提交的改动原样保留');
  assert.match(git(f.repo, ['status', '--porcelain']), /README\.md/);
  assert.equal(startOf(f.home, '脏工作区').worktree, true);
});

test('4 准备命令失败：setup.ok 为 false、end.exit 1、reason setup、没有 attempt、worktree 保留、名额释放', async t => {
  const f = fixture(t, { setup: ['node -e "process.exit(3)"'] });
  const spec = f.spec('docs/specs/005-准备失败.md');
  const result = await f.ar(['dispatch', spec, '--name', 'setup-fail', '--json']);
  assert.equal(result.code, 1, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, false);
  assert.match(value.error, /准备命令失败：node -e "process\.exit\(3\)"（exit 3）/);
  const start = startOf(f.home, 'setup-fail');
  const list = rows(f.home).filter(row => row.id === start.id);
  assert.deepEqual(list.map(row => row.event), ['start', 'preparing', 'worktree', 'setup', 'end']);
  const setup = list.find(row => row.event === 'setup');
  assert.equal(setup.ok, false);
  assert.match(setup.summary, /^准备命令失败：node -e "process\.exit\(3\)"（exit 3）$/);
  const end = list.at(-1);
  assert.equal(end.exit, 1);
  assert.equal(end.reason, 'setup');
  assert.ok(existsSync(f.worktreeEvent(start.id).dir), 'worktree 保留');
  assert.match(readFileSync(path.join(start.dir, 'attempts', '0', 'setup.log'), 'utf8'), /^\$ node -e "process\.exit\(3\)"/);
  assert.deepEqual(f.slots(), [], '准备失败也释放名额');
});

test('5 任务名额：concurrency 1 的两个 --detach 任务，第二个排队，第一个结束后才 preparing', async t => {
  const f = fixture(t, { concurrency: 1 });
  const release = path.join(f.base, '放行.flag');
  f.setProfile({ releaseFile: release, releaseTimeoutMs: 60000 });
  const first = f.spec('docs/specs/006-第一个.md');
  const second = f.spec('docs/specs/007-第二个.md');

  let result = await f.ar(['dispatch', first, '--name', '第一个', '--detach', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const firstId = JSON.parse(result.stdout).id;
  await until(() => rows(f.home).some(row => row.id === firstId && row.event === 'spawned'), '第一个任务启动执行者');
  result = await f.ar(['dispatch', second, '--name', '第二个', '--detach', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const secondId = JSON.parse(result.stdout).id;
  await until(() => rows(f.home).some(row => row.id === secondId && row.event === 'queued'), '第二个任务排队');
  assert.ok(!eventsOf(f.home, secondId).includes('preparing'), '排队期间没有 preparing');
  assert.match(f.progress('第二个'), /排队：同时最多 1 个任务，等前面的任务结束/);
  assert.equal(f.slots().length, 1, '只有第一个占着名额');

  writeFileSync(release, '放行');
  await until(() => rows(f.home).some(row => row.id === secondId && row.event === 'end'), '第二个任务结束', 60000);
  const all = rows(f.home);
  const firstEnd = all.findIndex(row => row.id === firstId && row.event === 'end');
  const secondPreparing = all.findIndex(row => row.id === secondId && row.event === 'preparing');
  assert.ok(firstEnd >= 0 && secondPreparing > firstEnd, '第一个结束之后第二个才 preparing');
  assert.equal(eventsOf(f.home, secondId).filter(name => name === 'queued').length, 1, 'queued 只写一次');
  assert.equal(all.find(row => row.id === secondId && row.event === 'end').exit, 0);
  assert.equal(all.find(row => row.id === firstId && row.event === 'end').exit, 0);
  assert.equal((f.progress('第二个').match(/排队：/g) ?? []).length, 1, '进度里只写一次');
  assert.deepEqual(f.slots(), [], '全部结束后 slots/ 为空');
});

test('6 排队中 ar stop 第二个：interrupted、没有 preparing、没有 worktree，第一个照常完成，名额文件没有第二个', async t => {
  const f = fixture(t, { concurrency: 1 });
  const release = path.join(f.base, '放行.flag');
  f.setProfile({ releaseFile: release, releaseTimeoutMs: 60000 });
  const first = f.spec('docs/specs/008-第一个.md');
  const second = f.spec('docs/specs/009-第二个.md');

  let result = await f.ar(['dispatch', first, '--name', '第一个', '--detach', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const firstId = JSON.parse(result.stdout).id;
  await until(() => rows(f.home).some(row => row.id === firstId && row.event === 'spawned'), '第一个任务启动执行者');
  result = await f.ar(['dispatch', second, '--name', '第二个', '--detach', '--json']);
  const secondId = JSON.parse(result.stdout).id;
  await until(() => rows(f.home).some(row => row.id === secondId && row.event === 'queued'), '第二个任务排队');

  result = await f.ar(['stop', '第二个']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const secondEvents = eventsOf(f.home, secondId);
  assert.ok(secondEvents.includes('interrupted'));
  assert.ok(!secondEvents.includes('preparing'), '没有 preparing');
  assert.equal(f.worktreeEvent(secondId), undefined, '没有 worktree 事件');
  assert.equal(f.worktreeDirs().length, 1, '只有第一个任务的 worktree');
  for (const name of f.slots()) {
    assert.ok(!readFileSync(path.join(f.home, 'slots', name), 'utf8').includes(secondId), '名额文件里没有第二个任务');
  }

  writeFileSync(release, '放行');
  await until(() => rows(f.home).some(row => row.id === firstId && row.event === 'end'), '第一个任务结束', 60000);
  assert.equal(rows(f.home).find(row => row.id === firstId && row.event === 'end').exit, 0);
  assert.deepEqual(f.slots(), [], '全部结束后 slots/ 为空');
});

test('7a 重试沿用 worktree：自动第 2 次与手动重试都在同一个 worktree，目录没了就拒绝', async t => {
  const f = fixture(t);
  // 第 1 次提交了 src/a.js，验收命令要 src/ok.txt 才通过 → 失败；第 2 次补上 → 通过；手动第 3 次再改一轮。
  f.setProfile({
    writes: [{ path: 'src/a.js', content: '第一次\n' }], commit: '假执行者：第 1 次',
    attempts: {
      2: { writes: [{ path: 'src/ok.txt', content: 'ok\n' }], commit: '假执行者：第 2 次' },
      3: { writes: [{ path: 'src/ok.txt', content: '再改一轮\n' }], commit: '假执行者：第 3 次' },
    },
  });
  const spec = f.spec('docs/specs/010-重试.md', { allowed: ['src/**'], verify: ['node scripts/check.mjs'], maxRetries: 2 });
  const mainBefore = git(f.repo, ['rev-parse', 'main']);
  const hashBefore = treeHash(f.repo);

  let result = await f.ar(['dispatch', spec, '--name', 'retry-wt', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const start = startOf(f.home, 'retry-wt');
  let list = rows(f.home).filter(row => row.id === start.id);
  assert.equal(list.filter(row => row.event === 'worktree').length, 1, '只有一条 worktree 事件');
  assert.deepEqual(list.filter(row => row.event === 'attempt').map(row => row.n), [1, 2]);
  assert.deepEqual(list.filter(row => row.event === 'gate').map(row => row.ok), [false, true]);
  const wt = f.worktreeEvent(start.id);
  assert.match(git(f.repo, ['log', '--format=%s', `${mainBefore}..${wt.branch}`]), /第 2 次[\s\S]*第 1 次/, '两次提交都在这个分支上');

  result = await f.ar(['retry', 'retry-wt', '--note', '再改一轮', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  list = rows(f.home).filter(row => row.id === start.id);
  assert.equal(list.filter(row => row.event === 'worktree').length, 1, '手动重试没有新的 worktree 事件');
  assert.equal(list.filter(row => row.event === 'preparing').length, 1, '手动重试不重新准备');
  assert.equal(list.findLast(row => row.event === 'attempt').reason, 'manual');
  assert.match(git(f.repo, ['log', '--format=%s', `${mainBefore}..${wt.branch}`]), /第 3 次/, '手动重试的提交也在同一个分支上');
  assert.equal(f.worktreeDirs().length, 1, '始终只有一个 worktree');
  assert.equal(git(f.repo, ['rev-parse', 'main']), mainBefore);
  assert.equal(treeHash(f.repo), hashBefore, '主工作区字节不变');
  assert.deepEqual(f.slots(), [], '重试结束后名额释放');

  // 删掉 worktree 目录后再重试 → 退出码 2、协议原文。
  git(f.repo, ['worktree', 'remove', '--force', wt.dir]);
  result = await f.ar(['retry', 'retry-wt', '--note', '再来', '--json']);
  assert.equal(result.code, 2, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: `worktree 已经不在了：${wt.dir}，用 ar redispatch 重新派发` });
});

test('7b 重试重读任务说明：在主分支上放宽 allowed_paths 后 ar retry 通过，主工作区的未提交改动不挡路', async t => {
  const f = fixture(t);
  f.setProfile({ writes: [{ path: 'README.md', content: '# 说明改过\n' }], commit: '假执行者：改 README', attempts: { 2: { writes: [], commit: null } } });
  const spec = f.spec('docs/specs/011-放宽.md', { allowed: ['src/**'], maxRetries: 0 });
  let result = await f.ar(['dispatch', spec, '--name', 'respec-wt', '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  assert.match(JSON.parse(result.stdout).gate.summary, /改动超出范围：README\.md/);
  const start = startOf(f.home, 'respec-wt');

  // 在主分支上提交放宽后的任务说明；主工作区同时留一个未提交改动。
  f.spec('docs/specs/011-放宽.md', { allowed: ['src/**', 'README.md'], maxRetries: 0 });
  write(path.join(f.repo, 'notes/本地草稿.txt'), '未提交\n');
  const hashBefore = treeHash(f.repo);

  result = await f.ar(['retry', 'respec-wt', '--note', '范围已放宽', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).gate, { ok: true, summary: '门禁通过' });
  assert.match(f.progress('respec-wt'), /手动重试：任务说明已改，按新的允许范围与验收命令/);
  const saved = JSON.parse(readFileSync(path.join(start.dir, 'dispatch.json'), 'utf8'));
  assert.deepEqual(saved.gate.merged.allowed_paths, ['src/**', 'README.md']);
  assert.equal(saved.gate.base, start.base, '基线不变');
  assert.equal(treeHash(f.repo), hashBefore, '主工作区的未提交改动原样保留');

  // 任务说明从主分支上消失 → 退出码 2、原文（同派发前检查）。
  git(f.repo, ['rm', '-q', '-r', 'docs/specs']);
  git(f.repo, ['commit', '-q', '-m', '主分支上不再有任务说明']);
  result = await f.ar(['retry', 'respec-wt', '--note', '再来', '--json']);
  assert.equal(result.code, 2, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: '任务说明还没提交到 main，执行者看不到它' });
});

test('8 --no-worktree、worktree: false、没写 worktree：都与 Stage05 相同（没有 15.3 的事件，start 没有 worktree 字段）', async t => {
  const cases = [
    { label: '--no-worktree', options: {}, extra: ['--no-worktree'] },
    { label: 'worktree: false', options: { worktree: false }, extra: [] },
    { label: '没写 worktree', options: { worktree: null }, extra: [] },
  ];
  for (const { label, options, extra } of cases) {
    const f = fixture(t, options);
    f.setProfile({ writes: [{ path: 'out.txt', content: '产出\n' }] });
    const spec = f.spec(`docs/specs/012-${label.replace(/\W/g, '')}.md`);
    const result = await f.ar(['dispatch', spec, '--name', 'plain', ...extra, '--json']);
    assert.equal(result.code, 0, `${label}：${result.stderr}${result.stdout}`);
    const start = startOf(f.home, 'plain');
    assert.ok(!('worktree' in start), `${label}：start 没有 worktree 字段`);
    assert.deepEqual(eventsOf(f.home, start.id), ['start', 'attempt', 'spawned', 'attempt-end', 'end'], label);
    assert.deepEqual(f.worktreeDirs(), [], `${label}：没有建 worktree`);
    assert.equal(readFileSync(path.join(f.repo, 'out.txt'), 'utf8'), '产出\n', `${label}：执行者在主工作区里运行`);
    assert.ok(!existsSync(path.join(f.repo, 'node_modules/.setup-ran')), `${label}：不跑准备命令`);
    assert.deepEqual(f.slots(), [], label);
  }
});

test('9 项目路径含中文与空格、记录名含中文与空格：分支名用哈希、目录用短名，流程照常', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/013-中文 空格.md');
  const result = await f.ar(['dispatch', spec, '--name', '中文 记录名', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const start = startOf(f.home, '中文 记录名');
  const wt = f.worktreeEvent(start.id);
  assert.match(wt.branch, /^ar\/[0-9a-f]{10}$/);
  assert.match(path.basename(wt.dir), /^[0-9a-f]{6}-_-[0-9a-f]{6}$/);
  assert.equal(path.dirname(wt.dir), f.wtRoot);
  assert.ok(existsSync(wt.dir));
  assert.equal(git(wt.dir, ['rev-parse', '--abbrev-ref', 'HEAD']), wt.branch);
  assert.equal(rows(f.home).find(row => row.id === start.id && row.event === 'end').exit, 0);
  assert.deepEqual(f.slots(), []);
});

test('请求文件：--detach 的请求带 worktree.base，是合法托管请求', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/014-请求.md');
  const mainSha = git(f.repo, ['rev-parse', 'main']);
  const result = await f.ar(['dispatch', spec, '--name', '请求任务', '--detach', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const id = JSON.parse(result.stdout).id;
  const managedDir = path.join(f.home, 'managed');
  const find = () => readdirSync(managedDir).find(entry => entry.startsWith(id) && /\.(claimed|running)\.json$/.test(entry));
  const name = await until(find, '请求文件出现');
  const request = JSON.parse(readFileSync(path.join(managedDir, name), 'utf8'));
  assert.deepEqual(request.worktree, { base: mainSha });
  await until(() => rows(f.home).some(row => row.id === id && row.event === 'end'), '任务结束', 60000);
});

// 093：准备命令与验收命令拿到 AR_BASE_REPO、AR_WORKTREE（只在 worktree 模式）。
const envRows = (dir, tag) => {
  try { return readFileSync(path.join(dir, 'node_modules', `env-${tag}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
};

test('10 worktree 模式：准备命令与每次门禁尝试的环境里有 AR_BASE_REPO（项目根）与 AR_WORKTREE（worktree 目录）', async t => {
  const f = fixture(t, { setup: ['node scripts/dump-env.mjs setup'] });
  f.setProfile({
    writes: [{ path: 'src/a.js', content: '第一次\n' }], commit: '假执行者：第 1 次',
    attempts: { 2: { writes: [{ path: 'src/ok.txt', content: 'ok\n' }], commit: '假执行者：第 2 次' } },
  });
  // 派发进程的环境里预先放别的值：准备命令与验收命令拿到的必须是核心设的，不是继承来的。
  f.env.AR_BASE_REPO = '假的主工作区';
  f.env.AR_WORKTREE = '假的 worktree';
  const spec = f.spec('docs/specs/015-环境变量.md', { allowed: ['src/**'], verify: ['node scripts/dump-env.mjs gate', 'node scripts/check.mjs'], maxRetries: 1 });
  const result = await f.ar(['dispatch', spec, '--name', 'env-wt', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const start = startOf(f.home, 'env-wt');
  const wt = f.worktreeEvent(start.id);
  const expected = { base: path.resolve(f.repo), worktree: path.resolve(wt.dir), cwd: wt.dir };
  assert.deepEqual(envRows(wt.dir, 'setup'), [expected], '准备命令');
  assert.deepEqual(envRows(wt.dir, 'gate'), [expected, expected], '两次门禁尝试各拿到一次');
  assert.deepEqual(rows(f.home).filter(row => row.id === start.id && row.event === 'gate').map(row => row.ok), [false, true]);
});

test('11 准备命令失败后手动重试：重跑的准备命令同样拿到两个变量', async t => {
  const f = fixture(t, { setup: ['node scripts/dump-env.mjs setup --fail-first'] });
  const spec = f.spec('docs/specs/016-准备重试.md', { verify: ['node scripts/dump-env.mjs gate'] });
  let result = await f.ar(['dispatch', spec, '--name', 'env-setup-retry', '--json']);
  assert.equal(result.code, 1, result.stderr + result.stdout);
  const start = startOf(f.home, 'env-setup-retry');
  const wt = f.worktreeEvent(start.id);
  const expected = { base: path.resolve(f.repo), worktree: path.resolve(wt.dir), cwd: wt.dir };
  assert.deepEqual(envRows(wt.dir, 'setup'), [expected], '第一次准备（失败）');
  result = await f.ar(['retry', 'env-setup-retry', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(envRows(wt.dir, 'setup'), [expected, expected], '重试重跑的准备命令');
  assert.deepEqual(envRows(wt.dir, 'gate'), [expected], '重试后的门禁');
});

test('12 非 worktree 的门禁任务：派发进程环境里有同名变量也读不到', async t => {
  const f = fixture(t, { worktree: false });
  f.env.AR_BASE_REPO = '随便一个值';
  f.env.AR_WORKTREE = '另一个值';
  const spec = f.spec('docs/specs/017-非worktree.md', { verify: ['node scripts/dump-env.mjs gate'] });
  const result = await f.ar(['dispatch', spec, '--name', 'env-plain', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(envRows(f.repo, 'gate'), [{ base: null, worktree: null, cwd: f.repo }]);
  assert.deepEqual(f.worktreeDirs(), [], '没有建 worktree');
});

test('13 git 低于 2.40（095，AR_TEST_GIT_VERSION）：worktree 派发退出码 2、GIT_TOO_OLD、没有 worktree 与新记录；--no-worktree 照常派发', async t => {
  const f = fixture(t);
  f.env.AR_TEST_GIT_VERSION = 'git version 2.39.1.windows.1';
  const spec = f.spec('docs/specs/018-git太旧.md');
  const result = await f.ar(['dispatch', spec, '--name', 'git-old', '--json']);
  assert.equal(result.code, 2, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    code: 'GIT_TOO_OLD',
    error: 'git 版本太旧：当前 2.39.1，worktree 模式需要 2.40 或更新。到 https://git-scm.com/downloads 下载新版后重试；不想用 worktree 的单个任务可以加 --no-worktree 派发。',
  });
  assert.ok(!existsSync(path.join(f.repo, '.agent-runs')), '没有记录目录');
  assert.deepEqual(rows(f.home).filter(row => row.event === 'start'), [], 'runs.jsonl 没有新的 start');
  assert.deepEqual(f.worktreeDirs(), [], '没有建 worktree');
  assert.equal(git(f.repo, ['worktree', 'list']).split('\n').length, 1, 'git 里只有主工作区');

  // 不加 --json：错误走标准错误，退出码同样是 2。
  const plain = await f.ar(['dispatch', spec, '--name', 'git-old-plain']);
  assert.equal(plain.code, 2);
  assert.match(plain.stderr, /git 版本太旧：当前 2\.39\.1，worktree 模式需要 2\.40 或更新/);

  // --no-worktree 不拦。
  const direct = await f.ar(['dispatch', spec, '--name', 'git-old-direct', '--no-worktree', '--json']);
  assert.equal(direct.code, 0, direct.stderr + direct.stdout);
  const start = startOf(f.home, 'git-old-direct');
  assert.ok(start && start.worktree !== true, '非 worktree 任务');
  assert.deepEqual(f.worktreeDirs(), [], '--no-worktree 也没有 worktree');
});

test('14 git 版本未知（095）：不拦 worktree 派发', async t => {
  const f = fixture(t);
  f.env.AR_TEST_GIT_VERSION = '这不是 git 的输出';
  const spec = f.spec('docs/specs/019-git版本未知.md');
  const result = await f.ar(['dispatch', spec, '--name', 'git-unknown', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(startOf(f.home, 'git-unknown').worktree, true);
});

// 109：ar retry --rebase 也能用在门禁失败 / 已中断的 worktree 任务上（协议 15.8）。
// 主分支上的新提交：补上验收命令要的 src/ok.txt，再改一个允许范围以外的 README.md（用旧基线比较会判越界）。
const mainMoves = f => {
  write(path.join(f.repo, 'src/ok.txt'), 'ok\n');
  write(path.join(f.repo, 'README.md'), '# 说明（主分支改过）\n');
  commitAll(f.repo, '主分支的新提交');
  return git(f.repo, ['rev-parse', 'main']);
};
// 门禁失败的 worktree 任务：执行者改了 src/a.js，但缺 src/ok.txt，验收命令不通过（max_retries 0，退出码 3）。
async function failedTask(f, name, writes = [{ path: 'src/a.js', content: '任务的改动\n' }]) {
  f.setProfile({ writes, commit: '假执行者：改 src/a.js' });
  const spec = f.spec(`docs/specs/${name}.md`, { allowed: ['src/**'], verify: ['node scripts/check.mjs'], maxRetries: 0 });
  const result = await f.ar(['dispatch', spec, '--name', name, '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  const start = startOf(f.home, name);
  return { start, wt: f.worktreeEvent(start.id) };
}

test('15 门禁失败的任务 ar retry --rebase：合并主分支后只看任务自己的改动，不启动执行者，attempt 带新 base，进待验收后能 accept', async t => {
  const f = fixture(t);
  const { start, wt } = await failedTask(f, 'rebase-failed');
  const newBase = mainMoves(f);
  const spawnedBefore = eventsOf(f.home, start.id).filter(name => name === 'spawned').length;
  const mainBefore = treeHash(f.repo);

  const result = await f.ar(['retry', 'rebase-failed', '--rebase', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).gate, { ok: true, summary: '门禁通过' });
  const events = rows(f.home).filter(row => row.id === start.id);
  const names = events.map(row => row.event);
  assert.deepEqual(names.slice(names.lastIndexOf('resume')), ['resume', 'attempt', 'gating', 'gate', 'attempt-end', 'end'], '没有 spawned');
  assert.equal(names.filter(name => name === 'spawned').length, spawnedBefore, '没有启动执行者');
  assert.ok(!names.includes('conflict'), '失败任务的 rebase 不写 conflict 事件');
  const attempt = events.findLast(row => row.event === 'attempt');
  assert.equal(attempt.reason, 'rebase');
  assert.equal(attempt.base, newBase, '新基线写在 attempt 的 base 上');
  assert.equal(events.at(-1).exit, 0);
  assert.equal(events.find(row => row.event === 'start').base, start.base, 'start.base 不变');
  const attemptDir = path.join(start.dir, 'attempts', String(attempt.n));
  assert.ok(!existsSync(path.join(attemptDir, 'prompt.md')) && !existsSync(path.join(attemptDir, 'raw.log')), '没有执行者运行的痕迹');
  const gateJson = JSON.parse(readFileSync(path.join(attemptDir, 'gate.json'), 'utf8'));
  assert.equal(gateJson.base, newBase);
  assert.equal(gateJson.ok, true);
  assert.match(f.progress('rebase-failed'), /合并 main（[0-9a-f]{7}）后重跑门禁/);
  // 用旧基线比较会把主分支合并进来的 README.md 判成这个任务的改动。
  assert.match(git(wt.dir, ['diff', '--name-only', `${start.base}..HEAD`]), /README\.md/);
  assert.equal(git(wt.dir, ['status', '--porcelain']), '');
  assert.equal(treeHash(f.repo), mainBefore, '主工作区没动');
  assert.deepEqual(f.slots(), [], '名额释放');

  const accepted = await f.ar(['accept', 'rebase-failed', '--json']);
  assert.equal(accepted.code, 0, accepted.stderr + accepted.stdout);
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), '任务的改动\n');
  assert.equal(readFileSync(path.join(f.repo, 'README.md'), 'utf8'), '# 说明（主分支改过）\n');
});

test('16 分支已经手动合并过主分支（107 的情况）：--rebase 合并是空操作，照样记新 base 并重跑门禁，不再判越界', async t => {
  const f = fixture(t);
  const { start, wt } = await failedTask(f, 'rebase-manual');
  const newBase = mainMoves(f);
  git(wt.dir, ['merge', '-q', '-m', '手动合并 main', 'main']);
  const headBefore = git(wt.dir, ['rev-parse', 'HEAD']);

  const result = await f.ar(['retry', 'rebase-manual', '--rebase', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).gate, { ok: true, summary: '门禁通过' });
  const events = rows(f.home).filter(row => row.id === start.id);
  const attempt = events.findLast(row => row.event === 'attempt');
  assert.equal(attempt.reason, 'rebase');
  assert.equal(attempt.base, newBase);
  assert.equal(git(wt.dir, ['rev-parse', 'HEAD']), headBefore, '空合并没有产生新提交');
  assert.equal(eventsOf(f.home, start.id).at(-1), 'end');
  assert.equal(events.at(-1).exit, 0);
  assert.equal(JSON.parse(readFileSync(path.join(start.dir, 'dispatch.json'), 'utf8')).gate.base, newBase, 'dispatch.json 的门禁基线换成了新基线');
});

// 冲突的"执行者"：把 src/a.js 写成合并后的内容，git add 并提交（合并进行中不带路径提交），再写汇报。
const resolver = `import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('resolver-test 1.0'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const run = args => spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8', shell: false, windowsHide: true });
  writeFileSync('src/a.js', '合并后\\n');
  const added = run(['add', 'src/a.js']);
  const committed = run(['commit', '-m', '解决冲突']);
  if (added.status !== 0 || committed.status !== 0) { process.stderr.write(added.stderr + committed.stderr); process.exit(1); }
  const report = process.argv[process.argv.indexOf('-o') + 1];
  writeFileSync(report, '已解决冲突\\n');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '已解决冲突' } }));
});
`;

test('17 门禁失败的任务 --rebase 有冲突：交给执行者解决（reason conflict，指令里有冲突文件与补充说明），之后待验收', async t => {
  const f = fixture(t);
  const { start, wt } = await failedTask(f, 'rebase-conflict');
  // 主分支也改了 src/a.js（和任务的改动冲突），同时补上 src/ok.txt。
  write(path.join(f.repo, 'src/a.js'), '主分支的改动\n');
  write(path.join(f.repo, 'src/ok.txt'), 'ok\n');
  commitAll(f.repo, '主分支改 src/a.js');
  const newBase = git(f.repo, ['rev-parse', 'main']);
  const resolverFile = path.join(f.base, 'resolver.mjs');
  writeFileSync(resolverFile, resolver);
  writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
    profiles: { fake: { ...f.profile }, resolver: { adapter: 'codex', label: '冲突解决者', enabled: true } },
  }));

  const result = await f.ar(['retry', 'rebase-conflict', '--rebase', '--profile', 'resolver', '--note', '以主分支为准再合并', '--json'],
    { env: { AR_TEST_AGENT: resolverFile, CODEX_HOME: path.join(f.base, 'codex 家') } });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).gate, { ok: true, summary: '门禁通过' });
  const events = rows(f.home).filter(row => row.id === start.id);
  const attempt = events.findLast(row => row.event === 'attempt');
  assert.equal(attempt.reason, 'conflict');
  assert.equal(attempt.base, newBase);
  assert.ok(eventsOf(f.home, start.id).includes('spawned'));
  const prompt = readFileSync(path.join(start.dir, 'attempts', String(attempt.n), 'prompt.md'), 'utf8');
  assert.match(prompt, /## 需要解决合并冲突/);
  assert.match(prompt, /- src\/a\.js/);
  assert.match(prompt, /以主分支为准再合并/);
  assert.equal(events.at(-1).exit, 0);
  assert.equal(git(wt.dir, ['status', '--porcelain']), '');
  assert.equal(readFileSync(path.join(wt.dir, 'src/a.js'), 'utf8'), '合并后\n');
});

test('18 --rebase 的拒绝：非 worktree 任务、待验收、已合并、已驳回、进行中，各有中文原因，且没写任何事件', async t => {
  const f = fixture(t);
  const refuse = async (name, expected) => {
    const before = rows(f.home).length;
    const result = await f.ar(['retry', name, '--rebase', '--json']);
    assert.equal(result.code, 2, result.stderr + result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: expected });
    assert.equal(rows(f.home).length, before, '被拒绝的 retry 没写任何事件');
  };
  // 非 worktree 任务（执行者没改东西，正常结束）。
  const plain = f.spec('docs/specs/030-非worktree.md');
  let result = await f.ar(['dispatch', plain, '--name', 'plain', '--no-worktree', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  await refuse('plain', '不是 worktree 任务，不能用 --rebase：plain');
  // 待验收。
  const pending = f.spec('docs/specs/031-待验收.md');
  result = await f.ar(['dispatch', pending, '--name', 'pending', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  await refuse('pending', '任务不在冲突状态，不能用 --rebase：pending');
  // 已合并、已驳回。
  result = await f.ar(['accept', 'pending', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  await refuse('pending', '任务已合并，不能用 --rebase：pending');
  const dropped = f.spec('docs/specs/032-已驳回.md');
  result = await f.ar(['dispatch', dropped, '--name', 'dropped', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  result = await f.ar(['reject', 'dropped', '--reason', '不要了', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  await refuse('dropped', '任务已驳回，不能用 --rebase：dropped');
  // 进行中：执行者在等放行文件。
  const release = path.join(f.base, '放行.flag');
  f.setProfile({ releaseFile: release, releaseTimeoutMs: 60000 });
  const running = f.spec('docs/specs/033-进行中.md');
  result = await f.ar(['dispatch', running, '--name', 'running', '--detach', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const runningId = JSON.parse(result.stdout).id;
  await until(() => rows(f.home).some(row => row.id === runningId && row.event === 'spawned'), '进行中的任务启动执行者');
  await refuse('running', '任务还在进行，先停止');
  writeFileSync(release, '放行');
  await until(() => rows(f.home).some(row => row.id === runningId && row.event === 'end'), '进行中的任务结束', 60000);
});

test('19 已中断的任务 --rebase：合并主分支后用新基线重跑门禁，进待验收', async t => {
  const f = fixture(t);
  const release = path.join(f.base, '放行.flag');
  f.setProfile({ releaseFile: release, releaseTimeoutMs: 60000 });
  const spec = f.spec('docs/specs/034-已中断.md', { allowed: ['src/**'], verify: ['node scripts/check.mjs'], maxRetries: 0 });
  let result = await f.ar(['dispatch', spec, '--name', 'rebase-stopped', '--detach', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const id = JSON.parse(result.stdout).id;
  await until(() => rows(f.home).some(row => row.id === id && row.event === 'spawned'), '任务启动执行者');
  result = await f.ar(['stop', 'rebase-stopped']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.ok(eventsOf(f.home, id).includes('interrupted'));
  const newBase = mainMoves(f);

  result = await f.ar(['retry', 'rebase-stopped', '--rebase', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).gate, { ok: true, summary: '门禁通过' });
  const events = rows(f.home).filter(row => row.id === id);
  const attempt = events.findLast(row => row.event === 'attempt');
  assert.equal(attempt.reason, 'rebase');
  assert.equal(attempt.base, newBase);
  assert.equal(events.at(-1).event, 'end');
  assert.equal(events.at(-1).exit, 0);
});