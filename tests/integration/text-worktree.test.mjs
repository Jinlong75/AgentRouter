import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';
import { worktreeOutcome } from '../../core/lib/wait.mjs';

// 425：直接写任务文字（没有任务说明）在项目开启 worktree 时也走 worktree 与门禁。
// 每个用例在系统临时目录里建一个真实 git 仓库，AGENT_ROUTER_HOME 与 AR_WORKTREE_ROOT 都指向用例自己的临时目录，
// 执行者是 fake；不碰真实安装、公共目录、进程与 worktree 根。
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

function fixture(t, { worktree = true, verify = [] } = {}) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 文字任务 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  const wtRoot = path.join(base, 'wt 根');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: wtRoot, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '文字任务测试']);
  git(repo, ['config', 'user.email', 'text@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({
    v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify,
    allowedPaths: ['**'], routing: { rules: [] }, worktree,
  }, null, 2));
  commitAll(repo, '初始提交');
  const f = { base, repo, home, wtRoot, env, since, count: 0, runsFile: path.join(home, 'runs.jsonl') };
  f.setProfile = value => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
      profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n## 已知问题\n无\n## 需要越界\n无\n', exit: 0, ...value } },
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
  // 派发一段任务文字（没有任务说明），返回 { name, id, start, result }；expect 非 0 时只返回结果。
  f.text = async (text, profile = {}, { args = [], expect = 0 } = {}) => {
    f.setProfile(profile);
    f.count += 1;
    const name = `文字任务${f.count}`;
    const result = await f.ar(['dispatch', text, '--name', name, '--profile', 'fake', '--detach', '--json', ...args]);
    assert.equal(result.code, expect, result.stderr + result.stdout);
    if (expect !== 0) return { name, result };
    const start = await until(() => rows(home).find(row => row.event === 'start' && row.name === name), `${name} 的 start`);
    return { name, id: start.id, start, result };
  };
  f.events = id => rows(home).filter(row => row.id === id);
  f.branches = () => git(repo, ['branch', '--list', '--format=%(refname:short)']).split('\n').filter(Boolean);
  f.snapshot = () => ({ head: git(repo, ['rev-parse', 'HEAD']), tree: treeHash(repo), status: git(repo, ['status', '--porcelain']) });
  f.ended = async (name, id) => {
    let wake = () => {};
    let watcher;
    try {
      watcher = watch(home, () => wake());
      watcher.on('error', () => { watcher.close(); wake(); });
    } catch { /* 文件监听不可用时仍定期检查事件。 */ }
    try {
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const end = f.events(id).find(row => row.event === 'end');
        if (end) return end;
        await new Promise(resolve => {
          const timer = setTimeout(() => { wake = () => {}; resolve(); }, Math.min(250, Math.max(0, deadline - Date.now())));
          wake = () => { clearTimeout(timer); wake = () => {}; resolve(); };
        });
      }
      const events = f.events(id);
      const progress = events.find(row => row.event === 'start')?.progress;
      let tail = '（无进度文件）';
      if (progress) {
        try { tail = readFileSync(progress, 'utf8').split(/\r?\n/).slice(-30).join('\n'); }
        catch (error) { tail = `（读取失败：${error.message}）`; }
      }
      throw Error(`等待超时：${name} 结束\n任务事件：${JSON.stringify(events)}\n进度末尾：\n${tail}`);
    } finally {
      watcher?.close();
    }
  };
  t.after(async () => {
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 文字任务 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

const change = { writes: [{ path: 'src/text.txt', content: '改过\n' }], commit: '假执行者：改文字' };

test('1 项目开 worktree：直接写任务文字也建 worktree、跑门禁，结束时待验收，accept 合并进主分支', async t => {
  const f = fixture(t, { verify: ['node -e "process.exit(0)"'] });
  const before = f.snapshot();
  const task = await f.text('改 README', change);
  const end = await f.ended(task.name, task.id);

  const worktree = f.events(task.id).find(row => row.event === 'worktree');
  assert.ok(worktree, '没有写 worktree 事件');
  assert.equal(task.start.spec, null, '直接写任务文字的 start 行没有任务说明');
  assert.equal(end.exit, 0);
  assert.equal(f.events(task.id).find(row => row.event === 'gate')?.ok, true, '门禁没有通过');
  // 主工作区在派发、执行期间完全没动。
  assert.deepEqual(f.snapshot(), before, '主工作区被改了');
  assert.equal(worktreeOutcome(f.runsFile, task.id), 'awaiting', '结束时进入待验收');

  const accepted = await f.ar(['accept', task.name, '--no-push', '--json']);
  assert.equal(accepted.code, 0, accepted.stderr + accepted.stdout);
  const value = JSON.parse(accepted.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.mode, 'no-ff');
  assert.equal(readFileSync(path.join(f.repo, 'src/text.txt'), 'utf8'), '改过\n', '合并后主工作区里有执行者的改动');
  assert.equal(git(f.repo, ['log', '-1', '--format=%s']), `[执行] 合并 ${task.name}：改 README`);
  assert.deepEqual(f.branches(), ['main']);
  assert.ok(!existsSync(worktree.dir), 'worktree 目录已删除');
});

test('1b 执行者配置开了代提交、自己没提交：AgentRouter 代提交，门禁通过，任务分支上有这次改动（审查 R7-1）', async t => {
  const f = fixture(t, { verify: ['node -e "process.exit(0)"'] });
  const task = await f.text('改 README 但不提交', { autoCommit: true, writes: change.writes });
  const end = await f.ended(task.name, task.id);
  assert.equal(end.exit, 0);
  assert.equal(f.events(task.id).find(row => row.event === 'gate')?.ok, true, '代提交后门禁应通过');
  const worktree = f.events(task.id).find(row => row.event === 'worktree');
  assert.equal(git(worktree.dir, ['status', '--porcelain']), '', '代提交后工作区干净');
  assert.equal(git(worktree.dir, ['show', 'HEAD:src/text.txt']), '改过', '改动已提交到任务分支');
});

test('2 没有改动也能过门禁：结束时待验收，accept 用确认模式、主分支不变', async t => {
  const f = fixture(t, { verify: ['node -e "process.exit(0)"'] });
  const before = f.snapshot();
  const task = await f.text('只看看 README', {});
  const end = await f.ended(task.name, task.id);
  assert.equal(end.exit, 0);
  assert.equal(f.events(task.id).find(row => row.event === 'gate')?.ok, true, '没改动也应该通过（不要求提交）');
  assert.equal(worktreeOutcome(f.runsFile, task.id), 'awaiting');

  const accepted = await f.ar(['accept', task.name, '--no-push', '--json']);
  assert.equal(accepted.code, 0, accepted.stderr + accepted.stdout);
  const value = JSON.parse(accepted.stdout);
  assert.equal(value.mode, 'confirm');
  assert.equal(value.merge, null);
  assert.deepEqual(f.snapshot(), before, '确认模式不合并，主分支与主工作区都没变');
  assert.deepEqual(f.branches(), ['main']);
});

test('3 项目没开 worktree：直接写任务文字照旧在主工作区里改，不跑门禁', async t => {
  const f = fixture(t, { worktree: false });
  const before = f.snapshot();
  const task = await f.text('直接改', change);
  const end = await f.ended(task.name, task.id);
  assert.equal(end.exit, 0);
  assert.ok(!f.events(task.id).some(row => row.event === 'worktree'), '不该建 worktree');
  assert.ok(!f.events(task.id).some(row => row.event === 'gate'), '不该跑门禁');
  assert.equal(readFileSync(path.join(f.repo, 'src/text.txt'), 'utf8'), '改过\n');
  assert.notEqual(f.snapshot().head, before.head, '执行者直接在主工作区提交');
});

test('4 --no-worktree：项目开了也不走 worktree', async t => {
  const f = fixture(t, { worktree: true });
  const task = await f.text('不走工作区', change, { args: ['--no-worktree'] });
  const end = await f.ended(task.name, task.id);
  assert.equal(end.exit, 0);
  assert.ok(!f.events(task.id).some(row => row.event === 'worktree'), '--no-worktree 不该建 worktree');
  assert.equal(readFileSync(path.join(f.repo, 'src/text.txt'), 'utf8'), '改过\n');
});

test('5 --type research 是只读任务：项目开了 worktree 也不用', async t => {
  const f = fixture(t, { worktree: true });
  const before = f.snapshot();
  const task = await f.text('调研一下', {}, { args: ['--type', 'research'] });
  const end = await f.ended(task.name, task.id);
  assert.equal(end.exit, 0);
  assert.ok(!f.events(task.id).some(row => row.event === 'worktree'), '只读任务不该建 worktree');
  assert.equal(f.events(task.id).find(row => row.event === 'gate')?.ok, true, '只读门禁照旧');
  assert.deepEqual(f.snapshot(), before, '只读任务不改主工作区');
});

test('6 主工作区不在基线上：报 SPEC_BASE（带 current / base），给 --base 后照常派发', async t => {
  const f = fixture(t, { worktree: true });
  git(f.repo, ['switch', '-q', '-c', 'feat']);
  const refused = await f.text('报错一次', {}, { args: [], expect: 2 });
  const value = JSON.parse(refused.result.stdout);
  assert.equal(value.ok, false);
  const error = value.specCheck?.errors?.[0];
  assert.equal(error?.code, 'SPEC_BASE');
  assert.equal(error?.current, 'feat');
  assert.equal(error?.base, 'main');
  assert.match(error?.message, /当前分支是 feat，与项目基线 main 不同；请显式指定 --base feat/);

  const task = await f.text('以 feat 为基线', change, { args: ['--base', 'feat'] });
  assert.equal(task.start.spec, null);
  const worktree = await until(() => f.events(task.id).find(row => row.event === 'worktree'), 'worktree 事件');
  assert.equal(worktree.base, git(f.repo, ['rev-parse', 'feat']));
  const end = await f.ended(task.name, task.id);
  assert.equal(end.exit, 0);
  assert.equal(worktreeOutcome(f.runsFile, task.id), 'awaiting');
});

test('7 项目验收命令失败：门禁不通过，不进入待验收', async t => {
  const f = fixture(t, { verify: ['node -e "process.exit(3)"'] });
  const before = f.snapshot();
  const task = await f.text('一定会失败', change);
  const end = await f.ended(task.name, task.id);
  assert.equal(end.agentExit, 0, '执行者本身正常结束');
  assert.equal(end.exit, 3, '门禁失败的任务以 3 结束');
  const gate = f.events(task.id).find(row => row.event === 'gate');
  assert.equal(gate?.ok, false, '验收命令非 0，门禁应该不通过');
  assert.notEqual(worktreeOutcome(f.runsFile, task.id), 'awaiting');
  assert.equal(worktreeOutcome(f.runsFile, task.id), 'failed');
  assert.deepEqual(f.snapshot(), before, '主工作区没动');
});
