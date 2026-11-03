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
      profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n## 已知问题\n无\n', exit: 0, ...value } },
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

test('按实际树匹配规则，保留顺序和文字，包含重命名及删除', async t => {
  const rules = [
    { paths: ['src/**'], text: '  原文提示  ' },
    { paths: ['src/old*'], text: '旧路径' },
    { paths: ['src/deleted*'], text: '删除' },
    { paths: ['none/**'], text: '不匹配' },
  ];
  for (const squash of [false, true]) {
    const f = fixture(t, { project: { acceptHints: rules } });
    write(path.join(f.repo, 'src/old name.txt'), '重命名内容\n');
    write(path.join(f.repo, 'src/deleted.txt'), '删除内容\n');
    commitAll(f.repo, '准备文件');
    const task = await f.task('路径', {});
    git(task.wt.dir, ['mv', 'src/old name.txt', 'src/new name.txt']);
    git(task.wt.dir, ['rm', 'src/deleted.txt']);
    write(path.join(task.wt.dir, 'src/z.txt'), '新增\n');
    commitAll(task.wt.dir, '更改路径');
    const regate = await f.ar(['retry', task.name, '--regate', '--json']);
    assert.equal(regate.code, 0, regate.stdout + regate.stderr);
    const result = await f.ar(['accept', task.name, ...(squash ? ['--squash'] : []), '--json']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).acceptHints, [
      { text: '  原文提示  ', file: 'src/deleted.txt' },
      { text: '旧路径', file: 'src/old name.txt' },
      { text: '删除', file: 'src/deleted.txt' },
    ]);
  }
});

test('文字提示追加在既有输出之后，首行不变；无配置和确认返回空数组', async t => {
  const f = fixture(t, { project: { acceptHints: [{ paths: ['src/**'], text: '文字原文' }] } });
  const task = await f.task('文字', { writes: [{ path: 'src/b.js', content: 'b' }], commit: '修改' });
  const result = await f.ar(['accept', task.name]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.match(lines[0], /^已合并：文字（合并提交 [0-9a-f]{7}）$/);
  assert.equal(lines.at(-1), '提示：文字原文（匹配 src/b.js）');
  const confirm = await f.task('确认', {});
  const confirmed = await f.ar(['accept', confirm.name, '--json']);
  assert.equal(confirmed.code, 0);
  assert.deepEqual(JSON.parse(confirmed.stdout).acceptHints, []);
  const f2 = fixture(t);
  const plain = await f2.task('默认', { writes: [{ path: 'src/b.js', content: 'b' }], commit: '修改' });
  const noConfig = await f2.ar(['accept', plain.name, '--json']);
  assert.equal(noConfig.code, 0);
  assert.deepEqual(JSON.parse(noConfig.stdout).acceptHints, []);
});

test('无效配置在合并或确认及清理前拒绝', async t => {
  const f = fixture(t);
  const task = await f.task('无效', { writes: [{ path: 'src/b.js', content: 'b' }], commit: '修改' });
  const configPath = path.join(f.repo, '.agent-router/project.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const invalid = [null, {}, [null], [[]], [{}], [{ paths: [], text: 'x' }], [{ paths: [' '], text: 'x' }], [{ paths: [1], text: 'x' }], [{ paths: ['x'], text: '' }], [{ paths: ['x'], text: 1 }]];
  for (const value of invalid) {
    writeFileSync(configPath, JSON.stringify({ ...config, acceptHints: value }));
    commitAll(f.repo, '无效配置');
    const head = git(f.repo, ['rev-parse', 'HEAD']);
    const events = f.events(task.id);
    const result = await f.ar(['accept', task.name, '--json']);
    assert.equal(result.code, 2);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: '项目配置无效：acceptHints' });
    assert.equal(git(f.repo, ['rev-parse', 'HEAD']), head);
    assert.deepEqual(f.events(task.id), events);
    assert.ok(existsSync(task.wt.dir));
  }
  const f2 = fixture(t, { project: { acceptHints: null } });
  const confirm = await f2.task('无效确认', {});
  const head = git(f2.repo, ['rev-parse', 'HEAD']);
  const events = f2.events(confirm.id);
  const result = await f2.ar(['accept', confirm.name, '--json']);
  assert.equal(result.code, 2);
  assert.equal(git(f2.repo, ['rev-parse', 'HEAD']), head);
  assert.deepEqual(f2.events(confirm.id), events);
  assert.ok(existsSync(confirm.wt.dir));
});

test('冲突不输出提示', async t => {
  const f = fixture(t, { project: { acceptHints: [{ paths: ['src/**'], text: '不应出现' }] } });
  const task = await f.task('冲突', { writes: [{ path: 'src/a.js', content: '任务\n' }], commit: '任务修改' });
  write(path.join(f.repo, 'src/a.js'), '主分支\n');
  commitAll(f.repo, '主分支修改');
  const result = await f.ar(['accept', task.name, '--json']);
  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.stdout).conflict, true);
  assert.ok(!result.stdout.includes('不应出现'));
});

