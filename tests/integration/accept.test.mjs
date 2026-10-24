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
import { worktreeOutcome } from '../../core/lib/wait.mjs';

// 085：ar accept / ar reject（协议 15.6、15.7）。每个用例在系统临时目录里建一个名字含中文与空格的真实 git 仓库，
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

function fixture(t, { setup = [], project = {} } = {}) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 验收 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  const wtRoot = path.join(base, 'wt 根');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: wtRoot, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '验收测试']);
  git(repo, ['config', 'user.email', 'accept@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  // 准备脚本：只往被忽略的 node_modules 里写东西。
  write(path.join(repo, 'scripts/setup.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('node_modules', { recursive: true });\nwriteFileSync('node_modules/.setup-ran', 'x');\n");
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup, verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true, ...project }, null, 2));
  commitAll(repo, '初始提交');
  const f = { base, repo, home, wtRoot, env, since, count: 0 };
  f.setProfile = value => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
      profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...value } },
    }));
  };
  f.setProfile({});
  f.ar = (args, { env: extra = {}, timeout = 90000 } = {}) => new Promise((resolve, reject) => {
    const childEnv = { ...env, ...extra };
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  // 派发一个任务：profile 是这次的假执行者设置；提交任务说明后派发，返回 { name, title, id, start, wt, result }。
  f.task = async (name, profile = {}, { verify = [], detach = false, expect = 0 } = {}) => {
    f.setProfile(profile);
    f.count += 1;
    const title = `验收测试 ${name}`;
    const rel = `docs/specs/${String(900 + f.count)}-${name.replace(/\W+/g, '')}.md`;
    write(path.join(repo, rel), specText({ title, verify }));
    commitAll(repo, `任务说明 ${name}`);
    const result = await f.ar(['dispatch', rel, '--name', name, ...(detach ? ['--detach'] : []), '--json']);
    assert.equal(result.code, expect, result.stderr + result.stdout);
    const start = await until(() => rows(home).find(row => row.event === 'start' && row.name === name), `${name} 的 start`);
    const wt = rows(home).find(row => row.id === start.id && row.event === 'worktree');
    return { name, title, id: start.id, start, wt, result };
  };
  f.events = id => rows(home).filter(row => row.id === id);
  f.branches = () => git(repo, ['branch', '--list', '--format=%(refname:short)']).split('\n').filter(Boolean);
  // 主工作区的现状：HEAD、字节指纹、git status。
  f.snapshot = () => ({ head: git(repo, ['rev-parse', 'HEAD']), tree: treeHash(repo), status: git(repo, ['status', '--porcelain']) });
  t.after(async () => {
    // 只结束本 fixture 清单里记录的派发进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 验收 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('0 worktreeOutcome：accepted / rejected / conflict 之后的状态，cleanup 不改变状态，resume 之后重新算（协议 15.3）', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar 状态读取 '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'runs.jsonl');
  const outcome = events => {
    writeFileSync(file, `${events.map(event => JSON.stringify({ v: 1, id: 'a', ...event })).join('\n')}\n`);
    return worktreeOutcome(file, 'a');
  };
  const start = { event: 'start', v: 2 };
  assert.equal(outcome([start]), null, '还没结束');
  assert.equal(outcome([start, { event: 'end', exit: 0 }]), 'awaiting');
  assert.equal(outcome([start, { event: 'end', exit: 3 }]), 'failed');
  assert.equal(outcome([start, { event: 'interrupted' }]), 'stopped');
  assert.equal(outcome([start, { event: 'end', exit: 0 }, { event: 'accepted' }]), 'accepted');
  assert.equal(outcome([start, { event: 'end', exit: 0 }, { event: 'accepted' }, { event: 'cleanup', ok: false }]), 'accepted', 'cleanup 不改变状态');
  assert.equal(outcome([start, { event: 'end', exit: 0 }, { event: 'rejected' }, { event: 'cleanup', ok: false }]), 'rejected');
  assert.equal(outcome([start, { event: 'end', exit: 0 }, { event: 'conflict' }]), 'conflict');
  assert.equal(outcome([start, { event: 'end', exit: 0 }, { event: 'conflict' }, { event: 'resume' }]), null, 'resume 之后重新算');
  assert.equal(outcome([start, { event: 'end', exit: 0 }, { event: 'conflict' }, { event: 'resume' }, { event: 'end', exit: 0 }]), 'awaiting', '冲突解决后再次待验收');
  assert.equal(outcome([start, { event: 'end', exit: 1, reason: 'setup' }, { event: 'rejected' }]), 'rejected');
  assert.equal(worktreeOutcome(file, '别的任务'), null);
});

const change = { writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改 src/a.js' };

test('1 默认 --no-ff：一个合并提交、提交信息原文、worktree 与分支已删除、accepted 字段齐、被忽略的文件不挡路', async t => {
  const f = fixture(t, { setup: ['node scripts/setup.mjs'] });
  const task = await f.task('正常合并', change, { verify: ['node -e "process.exit(0)"'] });
  assert.ok(existsSync(path.join(task.wt.dir, 'node_modules/.setup-ran')), '准备命令在 worktree 里留下了被忽略的文件');
  const before = f.snapshot();
  const taskTip = git(f.repo, ['rev-parse', task.wt.branch]);

  const result = await f.ar(['accept', '正常合并', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value), ['ok', 'merge', 'mode', 'cleanup']);
  assert.equal(value.ok, true);
  assert.equal(value.mode, 'no-ff');
  assert.equal(value.cleanup, true);
  assert.equal(value.merge, git(f.repo, ['rev-parse', 'HEAD']), 'merge 是合并提交的 SHA');
  assert.deepEqual(git(f.repo, ['log', '-1', '--format=%P']).split(' '), [before.head, taskTip], '合并提交的两个父提交：主分支原来的 HEAD 与任务分支');
  assert.equal(git(f.repo, ['log', '-1', '--format=%s']), `[执行] 合并 正常合并：${task.title}`);
  assert.equal(git(f.repo, ['log', '-1', '--format=%an']), '验收测试', '作者是主工作区当前的 git 身份');
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), '改过\n');
  assert.equal(git(f.repo, ['status', '--porcelain']), '');
  assert.ok(!existsSync(task.wt.dir), 'worktree 目录已删除');
  assert.deepEqual(f.branches(), ['main'], '任务分支已删除');
  assert.equal(git(f.repo, ['worktree', 'list']).split('\n').length, 1);

  const events = f.events(task.id);
  const accepted = events.find(row => row.event === 'accepted');
  assert.deepEqual(Object.keys(accepted).sort(), ['at', 'by', 'event', 'id', 'merge', 'mode', 'v']);
  assert.equal(accepted.v, 1);
  assert.equal(accepted.merge, value.merge);
  assert.equal(accepted.mode, 'no-ff');
  assert.equal(accepted.by, 'cli');
  assert.ok(Number.isFinite(accepted.at));
  assert.ok(!events.some(row => row.event === 'cleanup'), '清理成功不写 cleanup 事件');
  assert.equal(events.at(-1).event, 'accepted');

  // 再 accept 一次：已经不在待验收状态。
  const again = await f.ar(['accept', '正常合并', '--json']);
  assert.equal(again.code, 2);
  assert.deepEqual(JSON.parse(again.stdout), { ok: false, error: '任务不在待验收状态：正常合并' });
});

test('2 --squash 与项目配置 mergeMode: squash：一个普通提交、同一句提交信息、分支用 -D 删除', async t => {
  const f = fixture(t);
  const first = await f.task('压缩合并', { ...change, commit: '假执行者：第一个提交' });
  const result = await f.ar(['accept', '压缩合并', '--squash', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.mode, 'squash');
  assert.equal(value.cleanup, true);
  assert.equal(value.merge, git(f.repo, ['rev-parse', 'HEAD']));
  assert.equal(git(f.repo, ['log', '-1', '--format=%P']).split(' ').length, 1, 'squash 提交只有一个父提交');
  assert.equal(git(f.repo, ['log', '-1', '--format=%s']), `[执行] 合并 压缩合并：${first.title}`);
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), '改过\n');
  assert.equal(git(f.repo, ['status', '--porcelain']), '');
  assert.deepEqual(f.branches(), ['main'], 'squash 后分支没有被合并过，用 -D 也删掉了');
  assert.ok(!existsSync(first.wt.dir));
  assert.equal(f.events(first.id).find(row => row.event === 'accepted').mode, 'squash');

  // 项目配置 mergeMode: squash 时不带 --squash 也压缩。
  writeFileSync(path.join(f.repo, '.agent-router/project.json'), JSON.stringify({ ...JSON.parse(readFileSync(path.join(f.repo, '.agent-router/project.json'), 'utf8')), mergeMode: 'squash' }, null, 2));
  commitAll(f.repo, '改合并方式');
  const second = await f.task('配置压缩', { writes: [{ path: 'src/b.js', content: 'b\n' }], commit: '假执行者：b' });
  const configured = await f.ar(['accept', '配置压缩', '--json']);
  assert.equal(configured.code, 0, configured.stderr + configured.stdout);
  assert.equal(JSON.parse(configured.stdout).mode, 'squash');
  assert.equal(git(f.repo, ['log', '-1', '--format=%P']).split(' ').length, 1);
  assert.equal(f.events(second.id).find(row => row.event === 'accepted').mode, 'squash');
});

test('3 四项检查各自拒绝：原文、退出码 2、什么都不改', async t => {
  const f = fixture(t);
  const task = await f.task('检查任务', change);
  const wtRows = () => f.events(task.id).length;
  const expectRefused = async (message, label) => {
    const before = f.snapshot();
    const rowsBefore = wtRows();
    const result = await f.ar(['accept', '检查任务', '--json']);
    assert.equal(result.code, 2, `${label}：${result.stderr}${result.stdout}`);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: message }, label);
    assert.deepEqual(f.snapshot(), before, `${label}：主工作区什么都没改`);
    assert.equal(wtRows(), rowsBefore, `${label}：没有写任何事件`);
    assert.ok(existsSync(task.wt.dir), `${label}：worktree 还在`);
    assert.ok(f.branches().includes(task.wt.branch), `${label}：分支还在`);
  };

  // 检查 2：主工作区不在 baseBranch 上。
  git(f.repo, ['switch', '-q', '-c', 'other']);
  await expectRefused('主工作区当前在 other，合并要在 main 上进行：先 git switch main', '不在主分支');
  git(f.repo, ['switch', '-q', 'main']);

  // 检查 3：主工作区有未提交的改动（已修改的、未跟踪的都算）。
  write(path.join(f.repo, 'README.md'), '# 说明（改过）\n');
  write(path.join(f.repo, 'notes/草稿.txt'), '草稿\n');
  const dirty = await f.ar(['accept', '检查任务', '--json']);
  assert.equal(dirty.code, 2);
  const message = JSON.parse(dirty.stdout).error;
  assert.match(message, /^主工作区有未提交的改动，先提交或暂存：/);
  assert.ok(message.includes('README.md') && message.includes('notes/草稿.txt'), message);
  git(f.repo, ['checkout', '-q', '--', 'README.md']);
  rmSync(path.join(f.repo, 'notes'), { recursive: true, force: true });

  // 检查 4：worktree 里有门禁之后的未提交改动。
  write(path.join(task.wt.dir, 'src/a.js'), '门禁之后又改了\n');
  write(path.join(task.wt.dir, 'src/new.js'), '新文件\n');
  const late = await f.ar(['accept', '检查任务', '--json']);
  assert.equal(late.code, 2);
  const lateMessage = JSON.parse(late.stdout).error;
  assert.match(lateMessage, /^worktree 里有门禁之后的未提交改动，请先检查：/);
  assert.ok(lateMessage.includes('src/a.js') && lateMessage.includes('src/new.js'), lateMessage);
  assert.equal(f.snapshot().head, git(f.repo, ['rev-parse', 'main']));
  git(task.wt.dir, ['checkout', '-q', '--', 'src/a.js']);
  rmSync(path.join(task.wt.dir, 'src/new.js'));

  // 检查 1：失败的任务、不存在的记录、没有 worktree 的任务都不是待验收。
  const failed = await f.task('失败任务', { exit: 1 }, { expect: 1 });
  const refused = await f.ar(['accept', failed.name, '--json']);
  assert.equal(refused.code, 2);
  assert.deepEqual(JSON.parse(refused.stdout), { ok: false, error: '任务不在待验收状态：失败任务' });
  const missing = await f.ar(['accept', '不存在的任务', '--json']);
  assert.equal(missing.code, 2);
  assert.match(JSON.parse(missing.stdout).error, /找不到记录 不存在的任务/);

  // 条件都满足后同一个任务可以正常合并。
  const ok = await f.ar(['accept', '检查任务', '--json']);
  assert.equal(ok.code, 0, ok.stderr + ok.stdout);
});

test('4 清理失败不影响合并：cleanup 事件、--json 的 cleanup 为 false', { skip: process.platform !== 'win32' && '占着目录挡住删除只在 Windows 上成立' }, async t => {
  const f = fixture(t);
  const task = await f.task('清理失败', change);
  // 用一个以 worktree 里的目录为工作目录的子进程占着它：Windows 上这个目录删不掉（Node 打开的文件句柄允许删除，挡不住）。
  // 只结束测试自己启动的这个子进程。
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: path.join(task.wt.dir, 'src'), stdio: 'ignore', windowsHide: true, shell: false });
  const holderClosed = new Promise(resolve => holder.once('close', resolve));
  t.after(async () => { holder.kill(); await holderClosed; });
  await until(() => holder.pid, '占用进程启动');

  const result = await f.ar(['accept', '清理失败', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.cleanup, false);
  assert.equal(value.merge, git(f.repo, ['rev-parse', 'HEAD']), '合并照常成功');
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), '改过\n');
  const events = f.events(task.id);
  assert.deepEqual(events.slice(-2).map(row => row.event), ['accepted', 'cleanup']);
  const cleanup = events.at(-1);
  assert.equal(cleanup.v, 1);
  assert.equal(cleanup.ok, false);
  assert.ok(typeof cleanup.error === 'string' && cleanup.error !== '', '带失败原因');
  assert.ok(Number.isFinite(cleanup.at));
  assert.equal(events.find(row => row.event === 'accepted').merge, value.merge);

  // 占用结束后手动清掉残留（ar gc 的活），让临时目录能整体删除。
  holder.kill();
  await holderClosed;
  rmSync(task.wt.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  git(f.repo, ['worktree', 'prune']);
});

test('5 by：--by human、CLAUDECODE=1 时 lead、其余 cli；--by 只接受 human', async t => {
  const f = fixture(t);
  const cases = [
    { name: '来源人', args: ['--by', 'human'], env: {}, by: 'human' },
    { name: '来源主导', args: [], env: { CLAUDECODE: '1' }, by: 'lead' },
    { name: '来源命令行', args: [], env: {}, by: 'cli' },
  ];
  for (const [index, item] of cases.entries()) {
    const task = await f.task(item.name, { writes: [{ path: `src/f${index}.js`, content: `${index}\n` }], commit: `假执行者：${index}` });
    const result = await f.ar(['accept', item.name, ...item.args, '--json'], { env: item.env });
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(f.events(task.id).find(row => row.event === 'accepted').by, item.by, item.name);
  }
  // --by 的值只能是 human；--by 和 CLAUDECODE 同时给时 human 优先。
  const task = await f.task('来源非法', { writes: [{ path: 'src/g.js', content: 'g\n' }], commit: '假执行者：g' });
  const before = f.snapshot();
  const bad = await f.ar(['accept', '来源非法', '--by', 'robot', '--json']);
  assert.equal(bad.code, 2);
  assert.match(JSON.parse(bad.stdout).error, /--by 只接受 human/);
  assert.deepEqual(f.snapshot(), before);
  assert.ok(!f.events(task.id).some(row => row.event === 'accepted'));
  const both = await f.ar(['accept', '来源非法', '--by', 'human', '--json'], { env: { CLAUDECODE: '1' } });
  assert.equal(both.code, 0, both.stderr + both.stdout);
  assert.equal(f.events(task.id).find(row => row.event === 'accepted').by, 'human');
});

test('6 reject：原因必填；删除 worktree 与分支；主分支不受影响；不带 --reason 与进行中、已合并的任务都拒绝', async t => {
  const f = fixture(t);
  const task = await f.task('驳回任务', change);
  const before = f.snapshot();

  for (const args of [[], ['--reason', '   '], ['--reason', '']]) {
    const result = await f.ar(['reject', '驳回任务', ...args, '--json']);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: '驳回必须写原因：--reason "…"' });
  }
  assert.ok(existsSync(task.wt.dir), '没写原因时什么都没删');
  assert.ok(!f.events(task.id).some(row => row.event === 'rejected'));

  const result = await f.ar(['reject', '驳回任务', '--reason', '方案不对，重做', '--by', 'human', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, keptBranch: false, cleanup: true });
  const rejected = f.events(task.id).find(row => row.event === 'rejected');
  assert.deepEqual(Object.keys(rejected).sort(), ['at', 'by', 'event', 'id', 'keptBranch', 'reason', 'v']);
  assert.equal(rejected.reason, '方案不对，重做');
  assert.equal(rejected.keptBranch, false);
  assert.equal(rejected.by, 'human');
  assert.equal(rejected.v, 1);
  assert.ok(!existsSync(task.wt.dir));
  assert.deepEqual(f.branches(), ['main']);
  assert.deepEqual(f.snapshot(), before, '主分支与主工作区不受影响');

  // 驳回之后不能再验收或再驳回。
  const accepted = await f.ar(['accept', '驳回任务', '--json']);
  assert.equal(accepted.code, 2);
  assert.deepEqual(JSON.parse(accepted.stdout), { ok: false, error: '任务不在待验收状态：驳回任务' });
  const twice = await f.ar(['reject', '驳回任务', '--reason', '再来', '--json']);
  assert.equal(twice.code, 2);
  assert.match(JSON.parse(twice.stdout).error, /^任务的状态不能驳回：驳回任务/);
});

test('7 reject --keep-branch：保留分支，worktree 照常删除', async t => {
  const f = fixture(t);
  const task = await f.task('保留分支', change);
  const tip = git(f.repo, ['rev-parse', task.wt.branch]);
  const result = await f.ar(['reject', '保留分支', '--reason', '先留着看看', '--keep-branch', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, keptBranch: true, cleanup: true });
  assert.equal(f.events(task.id).find(row => row.event === 'rejected').keptBranch, true);
  assert.ok(!existsSync(task.wt.dir));
  assert.deepEqual(f.branches().sort(), ['main', task.wt.branch].sort());
  assert.equal(git(f.repo, ['rev-parse', task.wt.branch]), tip, '分支原样保留');
});

test('8 reject：准备失败的任务也能驳回（worktree 保留着，驳回时清理）；进行中的任务拒绝', async t => {
  const f = fixture(t, { setup: ['node -e "process.exit(3)"'] });
  const failed = await f.task('准备失败', {}, { expect: 1 });
  assert.equal(f.events(failed.id).at(-1).reason, 'setup');
  assert.ok(existsSync(failed.wt.dir), '准备失败时 worktree 保留');
  const result = await f.ar(['reject', '准备失败', '--reason', '环境问题', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.ok(!existsSync(failed.wt.dir), '驳回清理了 worktree');
  assert.deepEqual(f.branches(), ['main']);
  assert.equal(f.events(failed.id).at(-1).event, 'rejected');

  // 进行中：执行者等放行文件，期间 reject 被拒绝，什么都不删。
  const f2 = fixture(t);
  const release = path.join(f2.base, '放行.flag');
  const running = await f2.task('进行中', { releaseFile: release, releaseTimeoutMs: 60000 }, { detach: true });
  await until(() => f2.events(running.id).some(row => row.event === 'spawned'), '执行者启动');
  const wt = await until(() => f2.events(running.id).find(row => row.event === 'worktree'), 'worktree 事件');
  const busy = await f2.ar(['reject', '进行中', '--reason', '太早', '--json']);
  assert.equal(busy.code, 2);
  assert.deepEqual(JSON.parse(busy.stdout), { ok: false, error: '任务还在进行，先停止：进行中' });
  assert.ok(existsSync(wt.dir));
  writeFileSync(release, '放行');
  await until(() => f2.events(running.id).some(row => row.event === 'end'), '任务结束', 60000);
});
