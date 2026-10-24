import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 085：ar diff --json（协议 15.9）。真实 git 仓库，AR_WORKTREE_ROOT 与 AGENT_ROUTER_HOME 在用例自己的临时目录，执行者是 fake。
// fake 只会写文件并提交；删除、重命名、二进制这些改动由测试直接在任务的 worktree 里用 git 做出来（等于执行者做了这些事）。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = (file, content) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const rows = home => {
  try { return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
};
async function until(fn, label, timeout = 30000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}
const lines = (count, width = 99) => Array.from({ length: count }, (_, index) => `${String(index).padStart(5, '0')} ${'x'.repeat(width - 6)}\n`).join('');

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 改动 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'wt 根'), AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '改动测试']);
  git(repo, ['config', 'user.email', 'diff@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), 'one\ntwo\nthree\n');
  write(path.join(repo, 'src/gone.txt'), '要被删除的文件\n第二行\n');
  write(path.join(repo, 'src/old name.txt'), lines(20));
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true }, null, 2));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  const f = { base, repo, home, env, count: 0 };
  f.setProfile = value => write(path.join(home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
    profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...value } },
  }));
  f.ar = (args, { cwd = repo } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, 90000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  // 派发一个任务，执行者改 src/a.js 并提交；返回 { name, start, wt }。
  f.task = async (name, profile = {}) => {
    f.setProfile({ writes: [{ path: 'src/a.js', content: 'one\nTWO\nthree\nfour\n' }], commit: '假执行者：改 a.js', ...profile });
    f.count += 1;
    const rel = `docs/specs/${910 + f.count}-diff.md`;
    write(path.join(repo, rel), ['---', 'id: 910', 'title: 改动测试', 'type: code', 'expect_commit: false', 'allowed_paths:', '  - "**"', '---', '', '正文。', ''].join('\n'));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `任务说明 ${name}`]);
    const result = await f.ar(['dispatch', rel, '--name', name, '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const start = rows(home).find(row => row.event === 'start' && row.name === name);
    const wt = rows(home).find(row => row.id === start.id && row.event === 'worktree');
    return { name, start, wt };
  };
  // 在任务的 worktree 里再提交一次（执行者做的额外改动）。
  f.commitIn = (task, message) => {
    git(task.wt.dir, ['add', '-A']);
    git(task.wt.dir, ['commit', '-q', '-m', message]);
  };
  f.diff = async name => {
    const result = await f.ar(['diff', name, '--json']);
    return { code: result.code, value: JSON.parse(result.stdout), stderr: result.stderr };
  };
  t.after(async () => {
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 改动 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

const byPath = (files, name) => files.find(item => item.path === name);

test('1 形状：增、删、改、重命名（oldPath）、二进制；字段、patch 从 @@ 开始、totalBytes 是 patch 字节数之和', async t => {
  const f = fixture(t);
  const task = await f.task('改动形状');
  write(path.join(task.wt.dir, 'src/新文件 一.txt'), '第一行\n第二行\n');
  rmSync(path.join(task.wt.dir, 'src/gone.txt'));
  rmSync(path.join(task.wt.dir, 'src/old name.txt'));
  write(path.join(task.wt.dir, 'src/重命名 后.txt'), lines(20).replace('00003', 'CHANGED'));
  writeFileSync(path.join(task.wt.dir, 'src/pic.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0, 255, 254, 0, 0]));
  f.commitIn(task, '执行者的额外改动');
  const head = git(f.repo, ['rev-parse', task.wt.branch]);

  const { code, value } = await f.diff('改动形状');
  assert.equal(code, 0);
  assert.equal(value.ok, true);
  assert.equal(value.base, task.start.base);
  assert.equal(value.head, head);
  assert.equal(value.truncated, false);
  assert.equal(value.files.length, 5);

  const modified = byPath(value.files, 'src/a.js');
  assert.deepEqual(Object.keys(modified), ['path', 'oldPath', 'status', 'additions', 'deletions', 'binary', 'patch', 'truncated']);
  assert.deepEqual({ ...modified, patch: undefined }, { path: 'src/a.js', oldPath: null, status: 'M', additions: 2, deletions: 1, binary: false, patch: undefined, truncated: false });
  assert.ok(modified.patch.startsWith('@@'), '没有文件头');
  assert.ok(modified.patch.includes('-two\n+TWO\n') && modified.patch.includes('+four'), modified.patch);

  const added = byPath(value.files, 'src/新文件 一.txt');
  assert.deepEqual([added.status, added.oldPath, added.additions, added.deletions, added.binary], ['A', null, 2, 0, false]);
  assert.ok(added.patch.startsWith('@@ -0,0 +1,2 @@\n+第一行\n+第二行'), added.patch);

  const deleted = byPath(value.files, 'src/gone.txt');
  assert.deepEqual([deleted.status, deleted.oldPath, deleted.additions, deleted.deletions], ['D', null, 0, 2]);
  assert.ok(deleted.patch.startsWith('@@ -1,2 +0,0 @@\n-要被删除的文件'), deleted.patch);

  const renamed = byPath(value.files, 'src/重命名 后.txt');
  assert.deepEqual([renamed.status, renamed.oldPath, renamed.additions, renamed.deletions], ['R', 'src/old name.txt', 1, 1]);
  assert.ok(renamed.patch.startsWith('@@') && renamed.patch.includes('+CHANGED '), renamed.patch);
  assert.equal(byPath(value.files, 'src/old name.txt'), undefined, '重命名只有一条，旧路径不单独列');

  const binary = byPath(value.files, 'src/pic.bin');
  assert.deepEqual(Object.keys(binary), ['path', 'oldPath', 'status', 'additions', 'deletions', 'binary', 'truncated']);
  assert.deepEqual([binary.status, binary.binary, binary.truncated], ['A', true, false]);
  assert.ok(!('patch' in binary), '二进制文件没有 patch');

  const bytes = value.files.reduce((sum, item) => sum + Buffer.byteLength(item.patch ?? ''), 0);
  assert.equal(value.totalBytes, bytes);
  assert.ok(bytes > 0);
});

test('2 单文件超 200 KB 截断：这个文件 truncated 为 true、patch 不超过 200 KB，其他文件和整体不受影响', async t => {
  const f = fixture(t);
  const task = await f.task('单文件截断');
  write(path.join(task.wt.dir, 'src/big.txt'), lines(3000)); // 约 300 KB
  write(path.join(task.wt.dir, 'src/small.txt'), '小文件\n');
  f.commitIn(task, '大文件');
  const { code, value } = await f.diff('单文件截断');
  assert.equal(code, 0);
  const big = byPath(value.files, 'src/big.txt');
  assert.equal(big.additions, 3000);
  assert.equal(big.truncated, true);
  assert.ok(Buffer.byteLength(big.patch) <= 200 * 1024 && Buffer.byteLength(big.patch) > 190 * 1024, `patch ${Buffer.byteLength(big.patch)} 字节`);
  assert.ok(big.patch.startsWith('@@ -0,0 +1,3000 @@'));
  assert.equal(byPath(value.files, 'src/small.txt').truncated, false);
  assert.equal(byPath(value.files, 'src/a.js').truncated, false);
  assert.equal(value.truncated, false, '整体没超 2 MB');
  assert.equal(value.totalBytes, value.files.reduce((sum, item) => sum + Buffer.byteLength(item.patch ?? ''), 0));
});

test('3 整体超 2 MB 截断：后面的文件 patch 被截短或为空，truncated 为 true，总字节不超过 2 MB，文件仍然都列出', async t => {
  const f = fixture(t);
  const task = await f.task('整体截断');
  for (let index = 0; index < 12; index++) write(path.join(task.wt.dir, `src/big${String(index).padStart(2, '0')}.txt`), lines(2500));
  f.commitIn(task, '十二个大文件');
  const { code, value } = await f.diff('整体截断');
  assert.equal(code, 0);
  assert.equal(value.files.length, 13, '12 个大文件加 src/a.js');
  assert.equal(value.truncated, true);
  assert.ok(value.totalBytes <= 2 * 1024 * 1024 && value.totalBytes > 2 * 1024 * 1024 - 1024, `totalBytes ${value.totalBytes}`);
  assert.equal(value.totalBytes, value.files.reduce((sum, item) => sum + Buffer.byteLength(item.patch ?? ''), 0));
  const bigs = value.files.filter(item => item.path.startsWith('src/big'));
  assert.ok(bigs.every(item => item.truncated === true && item.additions === 2500), '每个大文件都超过 200 KB，都截断');
  assert.ok(bigs.some(item => item.patch === ''), '最后几个文件已经没有额度，patch 为空');
  assert.ok(bigs.every(item => Buffer.byteLength(item.patch) <= 200 * 1024));
});

test('4 合并之后 worktree 与分支都删了仍然能算：--no-ff 与 --squash 都给出同样的文件和 patch', async t => {
  const f = fixture(t);
  const merged = await f.task('合并后查看');
  write(path.join(merged.wt.dir, 'src/new.txt'), '新增\n');
  f.commitIn(merged, '多一个文件');
  const before = await f.diff('合并后查看');
  assert.equal(before.code, 0);
  assert.equal((await f.ar(['accept', '合并后查看', '--json'])).code, 0);
  assert.ok(!existsSync(merged.wt.dir));
  assert.equal(git(f.repo, ['branch', '--list', merged.wt.branch]), '', '分支已经删了');
  const after = await f.diff('合并后查看');
  assert.equal(after.code, 0, after.stderr);
  assert.equal(after.value.base, before.value.base);
  assert.equal(after.value.head, before.value.head, '合并提交的第二个父提交就是分支末端');
  assert.deepEqual(after.value.files, before.value.files);

  // 第一个任务已经把 a.js 改成了 TWO / four，第二个任务在它的基础上再加一行。
  const squashed = await f.task('压缩后查看', { writes: [{ path: 'src/a.js', content: 'one\nTWO\nthree\nfour\nfive\n' }] });
  const beforeSquash = await f.diff('压缩后查看');
  assert.equal((await f.ar(['accept', '压缩后查看', '--squash', '--json'])).code, 0);
  const afterSquash = await f.diff('压缩后查看');
  assert.equal(afterSquash.code, 0, afterSquash.stderr);
  assert.equal(afterSquash.value.head, git(f.repo, ['rev-parse', 'HEAD']), 'squash：合并提交本身');
  assert.equal(afterSquash.value.base, git(f.repo, ['rev-parse', 'HEAD^']), 'squash：它的第一个父提交');
  assert.equal(afterSquash.value.files.length, 1);
  assert.equal(afterSquash.value.files[0].path, 'src/a.js');
  assert.equal(afterSquash.value.files[0].patch, beforeSquash.value.files[0].patch);
  assert.ok(squashed.start.base);
});

test('5 驳回之后：分支保留时照样能看，分支也删了返回原文和退出码 2；不是 worktree 任务与找不到记录同样退出码 2', async t => {
  const f = fixture(t);
  const kept = await f.task('保留分支驳回');
  assert.equal((await f.ar(['reject', '保留分支驳回', '--reason', '先留着', '--keep-branch', '--json'])).code, 0);
  assert.ok(!existsSync(kept.wt.dir));
  const keptDiff = await f.diff('保留分支驳回');
  assert.equal(keptDiff.code, 0, keptDiff.stderr);
  assert.equal(keptDiff.value.files[0].path, 'src/a.js');

  const gone = await f.task('删除分支驳回');
  assert.equal((await f.ar(['reject', '删除分支驳回', '--reason', '不要了', '--json'])).code, 0);
  const goneDiff = await f.diff('删除分支驳回');
  assert.equal(goneDiff.code, 2);
  assert.deepEqual(goneDiff.value, { ok: false, error: '改动已不可查：worktree 与分支都已删除' });
  assert.ok(gone.start.id);

  const missing = await f.diff('没有这个任务');
  assert.equal(missing.code, 2);
  assert.equal(missing.value.ok, false);
  assert.match(missing.value.error, /找不到记录 没有这个任务/);

  // 不是 worktree 模式的任务：项目配置关掉 worktree 后派发。
  const config = JSON.parse(readFileSync(path.join(f.repo, '.agent-router/project.json'), 'utf8'));
  write(path.join(f.repo, '.agent-router/project.json'), JSON.stringify({ ...config, worktree: false }, null, 2));
  git(f.repo, ['add', '-A']);
  git(f.repo, ['commit', '-q', '-m', '关掉 worktree']);
  await f.task('普通任务');
  const plain = await f.diff('普通任务');
  assert.equal(plain.code, 2);
  assert.match(plain.value.error, /任务不是 worktree 模式：普通任务/);
});

test('6 不带 --json：每个文件一行摘要', async t => {
  const f = fixture(t);
  await f.task('文字输出');
  const result = await f.ar(['diff', '文字输出']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^M\tsrc\/a\.js\t\+2 -1$/m);
  assert.match(result.stdout, /共 1 个文件/);
});
