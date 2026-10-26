import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// Stage07b T4m（133）：ar projects purge——项目文件夹已被删掉时，只清 AgentRouter 自己的记录。
// 每个用例在系统临时目录里建真实 git 仓库，AR_WORKTREE_ROOT、AGENT_ROUTER_HOME 与用户目录都指向用例自己的临时目录，执行者是 fake。
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
  try { return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
};
async function until(fn, label, timeout = 60000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}
const sortBy = (list, key) => [...list].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
const specText = title => ['---', 'id: 900', `title: ${title}`, 'type: code', 'expect_commit: false', 'allowed_paths:', '  - src/**', '---', '', '测试说明正文。', ''].join('\n');

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 彻底清理 '));
  const repo = path.join(base, '待删 项目');
  const home = path.join(base, '隔离 公共目录');
  const wtRoot = path.join(base, 'wt 根');
  const userHome = path.join(base, '隔离 用户目录');
  mkdirSync(repo);
  mkdirSync(home);
  mkdirSync(userHome);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: wtRoot, AR_NO_WATCH: '1', USERPROFILE: userHome, HOME: userHome };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '清理测试']);
  git(repo, ['config', 'user.email', 'purge@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true, maxRetries: 0 }, null, 2));
  commitAll(repo, '初始提交');
  const f = { base, repo, home, wtRoot, env };
  f.setConfig = (profile = {}) => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
      profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...profile } },
    }));
  };
  f.setConfig();
  f.ar = (args, { timeout = 90000 } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  f.json = async args => {
    const result = await f.ar([...args, '--json']);
    return { code: result.code, body: JSON.parse(result.stdout) };
  };
  // 在 repo 里真实派发一个任务走到结束（writes 写到哪里决定门禁过不过：写到 allowed_paths 以外门禁失败）。
  let dispatched = 0;
  f.task = async (name, writePath) => {
    dispatched += 1;
    const rel = `docs/specs/${String(900 + dispatched)}-${name}.md`;
    write(path.join(repo, rel), specText(`彻底清理测试 ${name}`));
    commitAll(repo, `任务说明 ${name}`);
    f.setConfig({ writes: [{ path: writePath, content: `${name}\n` }], commit: `假执行者：${name}` });
    const dispatch = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, 'dispatch', rel, '--name', name, '--json'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => stdout += chunk);
      child.stderr.on('data', chunk => stderr += chunk);
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    // 门禁失败时派发的退出码是 3。
    assert.equal(dispatch.code, writePath.startsWith('src/') ? 0 : 3, dispatch.stderr + dispatch.stdout);
    const start = await until(() => rows(home).find(row => row.event === 'start' && row.name === name), `${name} 的 start`);
    await until(() => rows(home).find(row => row.id === start.id && row.event === 'end'), `${name} 的 end`);
    const wt = rows(home).find(row => row.id === start.id && row.event === 'worktree');
    assert.ok(wt && existsSync(wt.dir), `${name} 的 worktree 在`);
    return { id: start.id, dir: wt.dir };
  };
  f.register = async dir => {
    const result = await f.json(['projects', 'add', dir]);
    assert.equal(result.code, 0, JSON.stringify(result.body));
  };
  f.projects = async () => (await f.json(['projects', 'list', '--registry-only'])).body.projects.map(p => p.path);
  // 手写一个任务（清单里有 start 与 worktree 事件），worktree 目录由调用方准备。
  f.fabricate = ({ name, repoPath, dir, events = [{ event: 'end', exit: 0, attempts: 1 }] }) => {
    const id = `fab-${name}`;
    const lines = [
      { v: 2, event: 'start', id, repo: repoPath, name, spec: null, title: name, role: null, pid: process.pid, started: Date.now() - 60000, profile: 'fake', adapter: 'fake', worktree: true, base: 'b'.repeat(40), at: Date.now() },
      { v: 1, event: 'worktree', id, dir, branch: `ar/${name}`, base: 'b'.repeat(40), at: Date.now() },
      ...events.map(event => ({ v: 1, id, at: Date.now(), ...event })),
    ];
    appendFileSync(path.join(home, 'runs.jsonl'), lines.map(line => `${JSON.stringify(line)}\n`).join(''));
    return id;
  };
  t.after(async () => {
    const real = rows(home).filter(row => !String(row.id).startsWith('fab-'));
    await cleanupProcesses(base, { recorded: recordedStarts(real, script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 彻底清理 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

// 派发两个任务（一个待验收、一个门禁失败），再放一个别的项目的 worktree、不符合命名的目录与散落文件，最后删掉仓库目录。
async function scenario(t) {
  const f = fixture(t);
  await f.register(f.repo);
  const pending = await f.task('pending', 'src/p.js');
  const failed = await f.task('failed', 'other/x.js');
  // 别的项目（仓库还在）的 worktree：不能被动。
  const otherRepo = path.join(f.base, '别的 项目');
  mkdirSync(otherRepo);
  const otherDir = path.join(f.wtRoot, 'bbbbb1-other');
  write(path.join(otherDir, 'work.txt'), '别的项目\n');
  f.fabricate({ name: 'other', repoPath: otherRepo, dir: otherDir });
  const foreign = path.join(f.wtRoot, 'not-ours');
  write(path.join(foreign, 'keep.txt'), '别人的\n');
  const stray = path.join(f.wtRoot, 'stray.txt');
  write(stray, '散落的文件\n');
  // 删掉仓库目录（连同 .agent-runs 记录目录）。
  rmSync(f.repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  assert.ok(!existsSync(f.repo));
  return { f, pending, failed, otherDir, foreign, stray, manifest: readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8') };
}

test('1 --dry-run 列出 2 个任务、2 个 worktree，什么都没改', async t => {
  const { f, pending, failed, otherDir, foreign, stray, manifest } = await scenario(t);
  const { code, body } = await f.json(['projects', 'purge', f.repo, '--dry-run']);
  assert.equal(code, 0, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.listed, true);
  assert.deepEqual([...body.tasks].sort(), [pending.id, failed.id].sort());
  assert.deepEqual(sortBy(body.worktrees, 'dir'), sortBy([{ dir: pending.dir, reason: 'repo-missing' }, { dir: failed.dir, reason: 'repo-missing' }], 'dir'));
  assert.deepEqual(body.slots, []);
  assert.deepEqual(await f.projects(), [f.repo]);
  for (const target of [pending.dir, failed.dir, otherDir, foreign, stray]) assert.ok(existsSync(target), `dry-run 之后还在：${target}`);
  assert.equal(readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8'), manifest);
});

test('2 --worktrees：项目从列表移除、两个 worktree 没了；别的项目的、不符合命名的目录、散落文件还在；runs.jsonl 一个字节没变', async t => {
  const { f, pending, failed, otherDir, foreign, stray, manifest } = await scenario(t);
  const { code, body } = await f.json(['projects', 'purge', f.repo, '--worktrees']);
  assert.equal(code, 0, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.removed, true);
  assert.equal(body.worktrees, 2);
  assert.equal(body.slots, 0);
  assert.ok(body.bytes > 0);
  assert.deepEqual(await f.projects(), []);
  for (const target of [pending.dir, failed.dir]) assert.ok(!existsSync(target), `已删除：${target}`);
  for (const target of [otherDir, foreign, stray]) assert.ok(existsSync(target), `不动：${target}`);
  assert.equal(readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8'), manifest, 'purge 不写清单');
});

test('3 不带 --worktrees：只从列表移除，worktree 还在', async t => {
  const { f, pending, failed, manifest } = await scenario(t);
  const { code, body } = await f.json(['projects', 'purge', f.repo]);
  assert.equal(code, 0, JSON.stringify(body));
  assert.equal(body.removed, true);
  assert.equal(body.worktrees, 0);
  assert.deepEqual(await f.projects(), []);
  for (const target of [pending.dir, failed.dir]) assert.ok(existsSync(target), `还在：${target}`);
  assert.equal(readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8'), manifest);
});

test('4 文件夹还在的项目：拒绝，退出码 2，什么都没改', async t => {
  const f = fixture(t);
  await f.register(f.repo);
  const task = await f.task('pending', 'src/p.js');
  const manifest = readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8');
  for (const flags of [['--dry-run'], ['--worktrees'], []]) {
    const { code, body } = await f.json(['projects', 'purge', f.repo, ...flags]);
    assert.equal(code, 2);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('项目文件夹还在'), body.error);
  }
  assert.deepEqual(await f.projects(), [f.repo]);
  assert.ok(existsSync(task.dir));
  assert.equal(readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8'), manifest);
});

test('5 列表里没有、清单里也没有的路径：拒绝', async t => {
  const f = fixture(t);
  await f.register(f.repo);
  const stranger = path.join(f.base, '没登记过的 项目');
  for (const flags of [['--dry-run'], ['--worktrees']]) {
    const { code, body } = await f.json(['projects', 'purge', stranger, ...flags]);
    assert.equal(code, 2);
    assert.equal(body.ok, false);
    assert.ok(body.error.includes('没有登记这个项目'), body.error);
  }
  assert.deepEqual(await f.projects(), [f.repo]);
});

test('6 已经从列表移除、清单里还有任务的路径可以清理：listed 为 false，只清 worktree', async t => {
  const { f, pending, failed } = await scenario(t);
  const removed = await f.json(['projects', 'remove', f.repo]);
  assert.equal(removed.code, 0);
  const dry = await f.json(['projects', 'purge', f.repo, '--dry-run']);
  assert.equal(dry.code, 0, JSON.stringify(dry.body));
  assert.equal(dry.body.listed, false);
  assert.equal(dry.body.worktrees.length, 2);
  const done = await f.json(['projects', 'purge', f.repo, '--worktrees']);
  assert.equal(done.code, 0, JSON.stringify(done.body));
  assert.equal(done.body.removed, false);
  assert.equal(done.body.worktrees, 2);
  for (const target of [pending.dir, failed.dir]) assert.ok(!existsSync(target));
});

test('7 名额：占用者已不在的名额按任务清掉，别的任务的名额、占用者还活着的名额不动', async t => {
  const { f, pending } = await scenario(t);
  const slots = path.join(f.home, 'slots');
  mkdirSync(slots, { recursive: true });
  const mine = path.join(slots, 'slot-1.json');
  const others = path.join(slots, 'slot-2.json');
  const alive = path.join(slots, 'gate-1.json');
  const dead = 2147483000;
  writeFileSync(mine, JSON.stringify({ id: pending.id, pid: dead, created: 1, at: Date.now() }));
  writeFileSync(others, JSON.stringify({ id: 'fab-other', pid: dead, created: 1, at: Date.now() }));
  writeFileSync(alive, JSON.stringify({ id: pending.id, pid: process.pid, created: null, at: Date.now() }));
  const dry = await f.json(['projects', 'purge', f.repo, '--dry-run']);
  assert.deepEqual(dry.body.slots, [mine]);
  assert.ok(existsSync(mine));
  const done = await f.json(['projects', 'purge', f.repo, '--worktrees']);
  assert.equal(done.body.slots, 1);
  assert.ok(!existsSync(mine));
  assert.ok(existsSync(others));
  assert.ok(existsSync(alive));
});

test('8 安全：根目录下指向外部目录的目录联接不会被跟随，外部文件还在', async t => {
  const f = fixture(t);
  const gone = path.join(f.base, '早已删除 项目');
  const outside = mkdtempSync(path.join(os.tmpdir(), 'ar 外部 '));
  t.after(() => { try { rmSync(path.join(f.wtRoot, 'ccccc1-link'), { recursive: false, force: true }); } catch { /* 联接已经没有了。 */ } rmSync(outside, { recursive: true, force: true }); });
  write(path.join(outside, 'precious.txt'), '外部文件\n');
  mkdirSync(f.wtRoot, { recursive: true });
  const link = path.join(f.wtRoot, 'ccccc1-link');
  symlinkSync(outside, link, 'junction');
  // 联接的名字符合命名，清单里的主人任务也指向它，仓库已经不在。
  f.fabricate({ name: 'linked', repoPath: gone, dir: link });
  const real = path.join(f.wtRoot, 'ccccc2-real');
  write(path.join(real, 'work.txt'), '真的 worktree\n');
  f.fabricate({ name: 'real', repoPath: gone, dir: real });
  const dry = await f.json(['projects', 'purge', gone, '--dry-run']);
  assert.equal(dry.code, 0, JSON.stringify(dry.body));
  assert.deepEqual(dry.body.worktrees, [{ dir: real, reason: 'repo-missing' }], '联接不在清理范围内');
  const done = await f.json(['projects', 'purge', gone, '--worktrees']);
  assert.equal(done.code, 0, JSON.stringify(done.body));
  assert.equal(done.body.worktrees, 1);
  assert.ok(!existsSync(real));
  assert.equal(readFileSync(path.join(outside, 'precious.txt'), 'utf8'), '外部文件\n');
});
