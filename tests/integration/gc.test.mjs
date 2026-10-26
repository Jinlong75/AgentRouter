import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';
import { processCreated } from '../../core/lib/process.mjs';

// 086：ar gc（协议 15.10）。每个用例在系统临时目录里建一个名字含中文与空格的真实 git 仓库，
// AR_WORKTREE_ROOT、AGENT_ROUTER_HOME 与用户目录都指向用例自己的临时目录，执行者是 fake；
// 公共目录、worktree 根、执行者会话目录都是测试自己造的，不碰真实安装、配置、进程与 worktree 根。
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
const days = n => n * 24 * 60 * 60 * 1000;
const sortBy = (list, key) => [...list].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));

function specText(title) {
  return ['---', 'id: 900', `title: ${title}`, 'type: code', 'expect_commit: false', 'allowed_paths:', '  - src/**', '---', '', '测试说明正文。', ''].join('\n');
}

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 清理 '));
  const repo = path.join(base, '项目 仓库');
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
  git(repo, ['config', 'user.email', 'gc@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true, maxRetries: 0 }, null, 2));
  commitAll(repo, '初始提交');
  const f = { base, repo, home, wtRoot, userHome, env, since, count: 0 };
  f.setConfig = (extra = {}, profile = {}) => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
      profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...profile } },
      ...extra,
    }));
  };
  f.setConfig();
  f.ar = (args, { timeout = 90000 } = {}) => new Promise((resolve, reject) => {
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
  f.gc = async args => {
    const result = await f.ar(['gc', ...args, '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  // 真实派发一个任务走到待验收；返回 { name, id, start, wt }。
  let dispatched = 0;
  f.task = async name => {
    dispatched += 1;
    const rel = `docs/specs/${String(900 + dispatched)}-${name.replace(/\W+/g, '')}.md`;
    write(path.join(repo, rel), specText(`清理测试 ${name}`));
    commitAll(repo, `任务说明 ${name}`);
    f.setConfig({}, { writes: [{ path: `src/${dispatched}.js`, content: `${name}\n` }], commit: `假执行者：${name}` });
    const result = await f.ar(['dispatch', rel, '--name', name, '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const start = await until(() => rows(home).find(row => row.event === 'start' && row.name === name), `${name} 的 start`);
    const wt = rows(home).find(row => row.id === start.id && row.event === 'worktree');
    return { name, id: start.id, start, wt };
  };
  f.event = (id, event) => appendFileSync(path.join(home, 'runs.jsonl'), `${JSON.stringify({ v: 1, id, at: Date.now(), ...event })}\n`);
  // 手写一个任务（清单里有 start 与 worktree 事件，目录和分支是测试自己用 git 建的），profile 是它用的执行者配置名；不写 end 就是进行中。
  f.fabricate = (name, { profile = 'fake', dir = null, branch = null, events = [] } = {}) => {
    const id = `fab-${name}`;
    const lines = [{ v: 2, event: 'start', id, repo, name, spec: null, title: name, role: null, pid: process.pid, started: Date.now() - 60000, profile, adapter: 'fake', worktree: true, base: 'b'.repeat(40), at: Date.now() },
      ...(dir ? [{ v: 1, event: 'worktree', id, dir, branch, base: 'b'.repeat(40), at: Date.now() }] : []),
      ...events.map(event => ({ v: 1, id, at: Date.now(), ...event }))];
    appendFileSync(path.join(home, 'runs.jsonl'), lines.map(line => `${JSON.stringify(line)}\n`).join(''));
    return id;
  };
  // 用 git 在 worktree 根下直接建一个 worktree（目录名按"哈希前缀-名字"）。
  f.addWorktree = (entry, branch) => {
    const dir = path.join(wtRoot, entry);
    mkdirSync(wtRoot, { recursive: true });
    git(repo, ['worktree', 'add', '-q', '-b', branch, dir, 'main']);
    return dir;
  };
  f.branches = () => git(repo, ['branch', '--list', '--format=%(refname:short)']).split('\n').filter(Boolean);
  t.after(async () => {
    // 只结束本 fixture 清单里记录的派发进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止；手写行不算。
    const real = rows(home).filter(row => !String(row.id).startsWith('fab-'));
    await cleanupProcesses(base, { recorded: recordedStarts(real, script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 清理 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('1 孤立的 worktree：已合并 / 已驳回清理失败留下的、清单里找不到任务的、prunable 记录 → 列出并删除；运行中、待验收、不认识的目录不动；--dry-run 什么都不删', async t => {
  const f = fixture(t);
  // 已合并但清理失败留下的（手写 accepted 事件，squash 所以分支用 -D 删）；已驳回的两种：删分支、--keep-branch 保留分支。
  const merged = await f.task('已合并留下');
  f.event(merged.id, { event: 'accepted', merge: 'c'.repeat(40), mode: 'squash', by: 'cli' });
  f.event(merged.id, { event: 'cleanup', ok: false, error: '模拟清理失败' });
  const rejected = await f.task('已驳回留下');
  f.event(rejected.id, { event: 'rejected', reason: '不要了', keptBranch: false, by: 'cli' });
  const kept = await f.task('驳回保留分支');
  f.event(kept.id, { event: 'rejected', reason: '先留着', keptBranch: true, by: 'cli' });
  // 清单里找不到任务的：用 git 直接建在 worktree 根下，没有任何清单行。
  const unknown = f.addWorktree('a1b2c3-手工', 'ar/手工');
  // gc 对清单里找不到任务的目录有 10 分钟保护期，把修改时间改到 11 分钟前才会被当作孤立的。
  const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(unknown, elevenMinAgo, elevenMinAgo);
  // prunable：建好之后目录被手动删掉，git 里记录还在。
  const gone = f.addWorktree('c0ffee-已删', 'ar/已删');
  rmSync(gone, { recursive: true, force: true });
  assert.match(git(f.repo, ['worktree', 'list', '--porcelain']), /prunable/);
  // 不能动的：待验收的真实任务、运行中的手写任务（没有 end）、根目录里不是我们建的目录与文件。
  const awaiting = await f.task('待验收的');
  const runningDir = f.addWorktree('abc123-运行中', 'ar/运行中');
  f.fabricate('运行中的', { dir: runningDir, branch: 'ar/运行中' });
  const foreign = path.join(f.wtRoot, 'not-ours');
  write(path.join(foreign, 'keep.txt'), '别人的\n');
  write(path.join(f.wtRoot, 'stray.txt'), '散落的文件\n');

  const manifest = readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8');
  const branchesBefore = f.branches();
  const expected = sortBy([
    { dir: merged.wt.dir, reason: 'accepted' },
    { dir: rejected.wt.dir, reason: 'rejected' },
    { dir: kept.wt.dir, reason: 'rejected' },
    { dir: unknown, reason: 'unknown-task' },
    { dir: gone, reason: 'prunable' },
  ], 'dir');

  // --dry-run：只列出，什么都不删。
  const dry = await f.gc(['--dry-run']);
  assert.equal(dry.ok, true);
  assert.deepEqual(sortBy(dry.worktrees, 'dir'), expected);
  assert.deepEqual(dry.slots, []);
  assert.deepEqual(dry.sessions, []);
  assert.deepEqual(dry.errors, []);
  assert.ok(dry.bytes > 0, '估算大小大于 0');
  for (const dir of [merged.wt.dir, rejected.wt.dir, kept.wt.dir, unknown, awaiting.wt.dir, runningDir, foreign]) assert.ok(existsSync(dir), `dry-run 之后还在：${dir}`);
  assert.deepEqual(f.branches(), branchesBefore);
  assert.match(git(f.repo, ['worktree', 'list', '--porcelain']), /prunable/);
  assert.equal(readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8'), manifest, 'dry-run 不写清单');

  // 真删。
  const text = await f.ar(['gc', '--dry-run']);
  assert.equal(text.code, 0, text.stderr + text.stdout);
  assert.ok(text.stdout.includes('--dry-run 只列出'), text.stdout);
  assert.ok(text.stdout.includes(merged.wt.dir), '文字输出里有目录');

  const done = await f.gc([]);
  assert.equal(done.ok, true);
  assert.deepEqual(sortBy(done.worktrees, 'dir'), expected);
  assert.deepEqual(done.errors, []);
  assert.ok(done.bytes > 0);
  for (const dir of [merged.wt.dir, rejected.wt.dir, kept.wt.dir, unknown]) assert.ok(!existsSync(dir), `已删除：${dir}`);
  for (const dir of [awaiting.wt.dir, runningDir, foreign, path.join(f.wtRoot, 'stray.txt')]) assert.ok(existsSync(dir), `不动：${dir}`);
  assert.ok(!/prunable/.test(git(f.repo, ['worktree', 'list', '--porcelain'])), 'prunable 记录已清理');
  // 分支：合并 / 驳回的删掉；--keep-branch 的保留；不知道来历的、待验收的、运行中的都不动。
  const branches = f.branches();
  assert.ok(!branches.includes(merged.wt.branch));
  assert.ok(!branches.includes(rejected.wt.branch));
  assert.ok(branches.includes(kept.wt.branch), '--keep-branch 的分支保留');
  for (const branch of ['ar/手工', awaiting.wt.branch, 'ar/运行中']) assert.ok(branches.includes(branch), `分支保留：${branch}`);
  assert.equal(readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8'), manifest, 'gc 不写清单');

  // 再来一次什么都没有。
  const again = await f.gc([]);
  assert.deepEqual(again.worktrees, []);
  assert.equal(again.bytes, 0);
  const none = await f.ar(['gc']);
  assert.equal(none.code, 0);
  assert.equal(none.stdout.trim(), '没有需要清理的内容');
});

test('2 孤立的名额：占用者已退出（或 PID 被别的进程复用）的删，活着的、读不懂的不动；任务名额和门禁名额一样处理', async t => {
  const f = fixture(t);
  const slots = path.join(f.home, 'slots');
  // 活着的占用者：测试自己启动的一个子进程，名额里的创建时间是它真实的创建时间。
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, shell: false });
  const holderClosed = new Promise(resolve => holder.once('close', resolve));
  t.after(async () => { holder.kill(); await holderClosed; });
  await until(() => holder.pid, '占用进程启动');
  const created = await processCreated(holder.pid);
  assert.ok(Number.isFinite(created), '查得到占用进程的创建时间');
  // 已退出的占用者：一个马上结束的子进程的 PID。
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true, shell: false });
  await new Promise(resolve => dead.once('close', resolve));

  write(path.join(slots, 'slot-1.json'), JSON.stringify({ id: 'a', pid: dead.pid, created: 1, at: 1 }));
  write(path.join(slots, 'gate-1.json'), JSON.stringify({ id: 'b', pid: dead.pid, created: 1, at: 1 }));
  write(path.join(slots, 'slot-2.json'), JSON.stringify({ id: 'c', pid: holder.pid, created: created + 3600000, at: 1 }));
  write(path.join(slots, 'slot-3.json'), JSON.stringify({ id: 'd', pid: holder.pid, created, at: 1 }));
  write(path.join(slots, 'gate-2.json'), '{不是 JSON');
  write(path.join(slots, '别的文件.txt'), '不是名额');

  const dry = await f.gc(['--dry-run']);
  assert.deepEqual(sortBy(dry.slots.map(item => ({ name: path.basename(item.file), id: item.id, pid: item.pid })), 'name'), [
    { name: 'gate-1.json', id: 'b', pid: dead.pid },
    { name: 'slot-1.json', id: 'a', pid: dead.pid },
    { name: 'slot-2.json', id: 'c', pid: holder.pid },
  ]);
  assert.ok(dry.bytes > 0);
  for (const name of ['slot-1.json', 'gate-1.json', 'slot-2.json', 'slot-3.json', 'gate-2.json']) assert.ok(existsSync(path.join(slots, name)), `dry-run 之后还在：${name}`);

  const done = await f.gc([]);
  assert.equal(done.slots.length, 3);
  assert.deepEqual(done.errors, []);
  for (const name of ['slot-1.json', 'gate-1.json', 'slot-2.json']) assert.ok(!existsSync(path.join(slots, name)), `已删除：${name}`);
  for (const name of ['slot-3.json', 'gate-2.json', '别的文件.txt']) assert.ok(existsSync(path.join(slots, name)), `不动：${name}`);
});

test('3 执行者会话记录：超过保留期的删、没超过的不动、正在运行的任务所在的执行者不动；保留期来自 sessionRetentionDays，ar config 显示', async t => {
  const f = fixture(t);
  const projects = name => path.join(f.home, 'workers', name, 'claude', 'projects');
  const touch = (dir, ageDays) => {
    write(path.join(dir, 'session.jsonl'), '会话内容\n');
    const when = new Date(Date.now() - days(ageDays));
    utimesSync(dir, when, when);
  };
  touch(path.join(projects('idle'), 'old-project'), 30);
  touch(path.join(projects('idle'), 'new-project'), 1);
  touch(path.join(projects('idle'), 'edge-project'), 10);
  touch(path.join(projects('busy'), 'old-project'), 30);
  // busy 有一个还在进行的任务（没有 end）；idle 的任务已经结束。
  f.fabricate('进行中的', { profile: 'busy' });
  f.fabricate('已结束的', { profile: 'idle', events: [{ event: 'end', exit: 0, attempts: 1 }] });

  // 默认保留 14 天。
  const config = await f.ar(['config']);
  assert.ok(/^sessionRetentionDays\s+14\s+内置默认$/m.test(config.stdout), config.stdout);
  const dry = await f.gc(['--dry-run']);
  assert.deepEqual(dry.sessions.map(item => ({ worker: item.worker, name: path.basename(item.dir), ageDays: item.ageDays })), [
    { worker: 'idle', name: 'old-project', ageDays: 30 },
  ]);
  assert.ok(dry.bytes > 0);
  assert.ok(existsSync(path.join(projects('idle'), 'old-project')), 'dry-run 不删');

  // 改成 7 天：10 天前的也过期；busy 仍然跳过。
  f.setConfig({ sessionRetentionDays: 7 });
  assert.ok(/^sessionRetentionDays\s+7\s+config\.json$/m.test((await f.ar(['config'])).stdout));
  const done = await f.gc([]);
  assert.deepEqual(done.sessions.map(item => path.basename(item.dir)).sort(), ['edge-project', 'old-project']);
  assert.deepEqual(done.errors, []);
  assert.ok(!existsSync(path.join(projects('idle'), 'old-project')));
  assert.ok(!existsSync(path.join(projects('idle'), 'edge-project')));
  assert.ok(existsSync(path.join(projects('idle'), 'new-project')), '没超过保留期的不动');
  assert.ok(existsSync(path.join(projects('busy'), 'old-project')), '正在运行的任务所在的执行者不动');

  // 非法的保留期按默认处理并提示。
  f.setConfig({ sessionRetentionDays: 0 });
  const bad = await f.ar(['config']);
  assert.ok(/^sessionRetentionDays\s+14\s+内置默认$/m.test(bad.stdout), bad.stdout);
  assert.ok(bad.stdout.includes('sessionRetentionDays 必须为正整数'), bad.stdout);

  // 任务结束后 busy 的会话记录也可以清了。
  f.setConfig({});
  f.event('fab-进行中的', { event: 'end', exit: 0, attempts: 1 });
  assert.equal((await f.gc(['--dry-run'])).sessions.some(item => item.worker === 'busy'), true);
});

test('4 清理失败不中断其他项：被占用的 worktree 记进 errors，其余照删；占用结束后再清理一次', { skip: process.platform !== 'win32' && '占着目录挡住删除只在 Windows 上成立' }, async t => {
  const f = fixture(t);
  // 真实的"合并成功但清理失败"：用一个以 worktree 里的目录为工作目录的子进程占着它，ar accept 删不掉。
  const locked = await f.task('占用的');
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: path.join(locked.wt.dir, 'src'), stdio: 'ignore', windowsHide: true, shell: false });
  const holderClosed = new Promise(resolve => holder.once('close', resolve));
  t.after(async () => { holder.kill(); await holderClosed; });
  await until(() => holder.pid, '占用进程启动');
  const accepted = await f.ar(['accept', '占用的', '--json']);
  assert.equal(accepted.code, 0, accepted.stderr + accepted.stdout);
  assert.equal(JSON.parse(accepted.stdout).cleanup, false, 'accept 清理失败，worktree 留下');
  // 另一个正常的残留，排在它前后都应照删。
  const other = await f.task('其他的');
  f.event(other.id, { event: 'rejected', reason: '不要了', keptBranch: false, by: 'cli' });
  const sessionDir = path.join(f.home, 'workers', 'idle', 'claude', 'projects', 'old-project');
  write(path.join(sessionDir, 'session.jsonl'), '会话\n');
  utimesSync(sessionDir, new Date(Date.now() - days(30)), new Date(Date.now() - days(30)));

  const result = await f.gc([]);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
  assert.equal(result.errors[0].kind, 'worktree');
  assert.equal(result.errors[0].path, locked.wt.dir);
  assert.ok(typeof result.errors[0].error === 'string' && result.errors[0].error !== '');
  assert.ok(!existsSync(other.wt.dir), '其他项照删');
  assert.ok(!existsSync(sessionDir), '会话记录照删');
  assert.ok(existsSync(locked.wt.dir), '被占用的还在');
  const text = await f.ar(['gc']);
  assert.equal(text.code, 0);
  assert.ok(text.stdout.includes('清理失败：'), text.stdout);

  // 占用结束后再清理一次：目录、分支都清掉。
  holder.kill();
  await holderClosed;
  const retry = await f.gc([]);
  assert.deepEqual(retry.errors, []);
  assert.ok(!existsSync(locked.wt.dir));
  assert.ok(!f.branches().includes(locked.wt.branch), '合并过的分支也删掉');
});

test('5 项目文件夹已不存在：待验收、失败的任务留下的 worktree 列出并只删目录；仓库还在的、仓库已删但仍在进行中的不动；清单不变', async t => {
  const f = fixture(t);
  // 手写任务：仓库路径各自独立（删掉就没了），worktree 目录直接建在根下，不依赖 git。
  const goneRepos = [];
  const make = ({ name, entry, repoPath, events = [] }) => {
    const id = `fab-${name}`;
    const dir = path.join(f.wtRoot, entry);
    write(path.join(dir, 'work.txt'), `${name}\n`);
    const lines = [
      { v: 2, event: 'start', id, repo: repoPath, name, spec: null, title: name, role: null, pid: process.pid, started: Date.now() - 60000, profile: 'fake', adapter: 'fake', worktree: true, base: 'b'.repeat(40), at: Date.now() },
      { v: 1, event: 'worktree', id, dir, branch: `ar/${name}`, base: 'b'.repeat(40), at: Date.now() },
      ...events.map(event => ({ v: 1, id, at: Date.now(), ...event })),
    ];
    appendFileSync(path.join(f.home, 'runs.jsonl'), lines.map(line => `${JSON.stringify(line)}\n`).join(''));
    return dir;
  };
  const tempRepo = name => {
    const dir = path.join(f.base, `仓库 ${name}`);
    mkdirSync(dir);
    goneRepos.push(dir);
    return dir;
  };
  const awaiting = make({ name: 'pending', entry: 'aaaaa1-pending', repoPath: tempRepo('a'), events: [{ event: 'end', exit: 0, attempts: 1 }] });
  const failed = make({ name: 'failed', entry: 'aaaaa2-failed', repoPath: tempRepo('b'), events: [{ event: 'end', exit: 1, attempts: 1 }] });
  const stopped = make({ name: 'stopped', entry: 'aaaaa3-stopped', repoPath: tempRepo('c'), events: [{ event: 'interrupted' }] });
  const runningGone = make({ name: 'running', entry: 'aaaaa4-running', repoPath: tempRepo('d') });
  const repoAlive = make({ name: 'alive', entry: 'aaaaa5-alive', repoPath: f.repo, events: [{ event: 'end', exit: 0, attempts: 1 }] });
  const foreign = path.join(f.wtRoot, 'not-ours');
  write(path.join(foreign, 'keep.txt'), '别人的\n');
  write(path.join(f.wtRoot, 'stray.txt'), '散落的文件\n');
  // 删掉仓库目录（running 的那个也删）。
  for (const repo of goneRepos) rmSync(repo, { recursive: true, force: true });

  const manifest = readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8');
  const expected = sortBy([
    { dir: awaiting, reason: 'repo-missing' },
    { dir: failed, reason: 'repo-missing' },
    { dir: stopped, reason: 'repo-missing' },
  ], 'dir');

  const dry = await f.gc(['--dry-run']);
  assert.deepEqual(sortBy(dry.worktrees, 'dir'), expected);
  assert.deepEqual(dry.errors, []);
  for (const dir of [awaiting, failed, stopped, runningGone, repoAlive, foreign]) assert.ok(existsSync(dir), `dry-run 之后还在：${dir}`);

  const text = await f.ar(['gc', '--dry-run']);
  assert.equal(text.code, 0, text.stderr + text.stdout);
  assert.ok(text.stdout.includes('项目文件夹已不存在'), text.stdout);

  const done = await f.gc([]);
  assert.deepEqual(sortBy(done.worktrees, 'dir'), expected);
  assert.deepEqual(done.errors, []);
  for (const dir of [awaiting, failed, stopped]) assert.ok(!existsSync(dir), `已删除：${dir}`);
  for (const dir of [runningGone, repoAlive, foreign, path.join(f.wtRoot, 'stray.txt')]) assert.ok(existsSync(dir), `不动：${dir}`);
  assert.equal(readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8'), manifest, 'gc 不写清单');
});
