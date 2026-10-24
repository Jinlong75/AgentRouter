import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  branchFor, createWorktree, listWorktrees, removeWorktree, runSetup, worktreeDir,
} from '../../core/lib/worktree.mjs';

// 每个用例在系统临时目录里建真实 git 仓库；AR_WORKTREE_ROOT 指向另一个临时目录，不碰真实根目录。
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const tempDir = (t, prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};
const fixture = (t, prefix = 'ar 工作树 测试 ') => {
  const root = tempDir(t, prefix);
  const wtRoot = tempDir(t, 'ar-wt-root-');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', '工作树测试']);
  git(root, ['config', 'user.email', 'wt@example.test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']);
  write(path.join(root, 'a.txt'), '初始\n');
  write(path.join(root, '.gitignore'), 'node_modules/\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', '初始提交']);
  return { root, base: git(root, ['rev-parse', 'HEAD']), env: { ...process.env, AR_WORKTREE_ROOT: wtRoot }, wtRoot };
};
const NAMES = ['task-001', '任务 001 中文 name'];

for (const name of NAMES) {
  test(`创建（记录名 ${name}）：目录与分支存在、longpaths 为 true、被列出、主工作区不变`, t => {
    const { root, base, env } = fixture(t);
    const before = readFileSync(path.join(root, 'a.txt'));
    const { dir, branch } = createWorktree({ root, name, base, env });
    assert.ok(existsSync(path.join(dir, 'a.txt')));
    assert.equal(git(dir, ['config', 'core.longpaths']), 'true');
    assert.equal(git(root, ['branch', '--list', branch]).replace(/^[*+]?\s*/, ''), branch);
    const listed = listWorktrees({ root });
    assert.equal(listed.length, 1);
    assert.equal(realpathSync.native(listed[0].dir), realpathSync.native(dir));
    assert.equal(listed[0].branch, branch);
    assert.equal(listed[0].head, base);
    assert.equal(listed[0].locked, false);
    assert.deepEqual(readFileSync(path.join(root, 'a.txt')), before);
    assert.equal(git(root, ['status', '--porcelain']), '');
  });
}

test('目录已存在：抛错且不改动现有目录与分支', t => {
  const { root, base, env } = fixture(t);
  const dir = worktreeDir({ root, name: 'r1', env });
  write(path.join(dir, 'keep.txt'), '保留\n');
  assert.throws(() => createWorktree({ root, name: 'r1', base, env }), /worktree 目录已存在：.*（运行 ar gc 清理）/);
  assert.equal(readFileSync(path.join(dir, 'keep.txt'), 'utf8'), '保留\n');
  assert.equal(git(root, ['branch', '--list', 'ar/r1']), '');
});

test('分支已存在：抛错且不改动现有分支', t => {
  const { root, base, env } = fixture(t);
  git(root, ['branch', 'ar/r2', base]);
  assert.throws(() => createWorktree({ root, name: 'r2', base, env }), /分支已存在：ar\/r2/);
  assert.equal(git(root, ['rev-parse', 'ar/r2']), base);
  assert.equal(existsSync(worktreeDir({ root, name: 'r2', env })), false);
});

test('记录名不合法作分支名时用哈希分支', t => {
  const { root, base, env } = fixture(t);
  assert.equal(branchFor('ok-name', { root }), 'ar/ok-name');
  for (const bad of ['a b', '中文', 'x..y', 'x~1', 'end.lock']) {
    assert.match(branchFor(bad, { root }), /^ar\/[0-9a-f]{10}$/, bad);
  }
  const { branch } = createWorktree({ root, name: '任务 1', base, env });
  assert.match(branch, /^ar\/[0-9a-f]{10}$/);
});

test('runSetup：成功写日志；第二条失败时第三条不跑', async t => {
  const { root, env } = fixture(t);
  const logFile = path.join(root, '..', `ar-setup-${process.pid}-${Date.now()}`, 'logs', 'setup.log');
  t.after(() => rmSync(path.dirname(path.dirname(logFile)), { recursive: true, force: true }));
  const ok = await runSetup({
    dir: root, env, logFile,
    commands: ['node -e "console.log(\'第一条\')"', 'node -e "console.log(\'第二条\')"'],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.summary, '准备命令完成');
  assert.equal(ok.results.length, 2);
  const log = readFileSync(logFile, 'utf8');
  assert.match(log, /\$ node -e "console\.log\('第一条'\)"\r?\n第一条/);
  assert.match(log, /\$ node -e "console\.log\('第二条'\)"\r?\n第二条/);

  const failLog = path.join(path.dirname(logFile), 'fail.log');
  const bad = await runSetup({
    dir: root, env, logFile: failLog,
    commands: ['node -e "0"', 'node -e "process.exit(3)"', 'node -e "console.log(\'不该出现\')"'],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.results.length, 2);
  assert.equal(bad.summary, '准备命令失败：node -e "process.exit(3)"（exit 3）');
  assert.doesNotMatch(readFileSync(failLog, 'utf8'), /不该出现/);
});

test('runSetup：没有命令、启动失败、超时', async t => {
  const { root, env } = fixture(t);
  assert.deepEqual(await runSetup({ dir: root, env, commands: [] }), { ok: true, ms: 0, summary: '没有准备命令', results: [] });
  const missing = await runSetup({ dir: root, env, commands: ['ar-no-such-command-xyz'] });
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /^准备命令失败：ar-no-such-command-xyz（.+）$/);
  const slow = await runSetup({ dir: root, env, timeoutMs: 600, commands: ['node -e "setTimeout(()=>{},60000)"'] });
  assert.equal(slow.ok, false);
  assert.equal(slow.summary, '准备命令失败：node -e "setTimeout(()=>{},60000)"（超时）');
  assert.equal(slow.results[0].timedOut, true);
});

test('runSetup：环境里没有 AGENT_ROUTER_HOME 与 AR_ 开头的变量，也没有 dropEnv 里的密钥变量', async t => {
  const { root, env } = fixture(t);
  const logFile = path.join(root, '..', `ar-env-${process.pid}-${Date.now()}.log`);
  t.after(() => rmSync(logFile, { force: true }));
  const probe = 'node -e "console.log(Object.keys(process.env).filter(k=>/^(AR_|AGENT_ROUTER_HOME|SECRET_KEY_X)/i.test(k)).join(\',\')+\'|\'+(process.env.KEEP_ME||\'\'))"';
  const result = await runSetup({
    dir: root, logFile, commands: [probe], dropEnv: ['SECRET_KEY_X'],
    env: { ...env, AGENT_ROUTER_HOME: path.join(root, 'home'), AR_FOO: '1', SECRET_KEY_X: 'v', KEEP_ME: 'yes' },
  });
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.results[0].output.trim(), '|yes');
});

test('removeWorktree：只有被忽略的文件时不加 force 也删得掉', t => {
  const { root, base, env } = fixture(t);
  const { dir, branch } = createWorktree({ root, name: 'ign', base, env });
  write(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x\n');
  removeWorktree({ root, dir, branch });
  assert.equal(existsSync(dir), false);
  assert.equal(git(root, ['branch', '--list', branch]), '');
  assert.deepEqual(listWorktrees({ root }), []);
});

test('removeWorktree：有未跟踪文件时不加 force 抛错，加了能删', t => {
  const { root, base, env } = fixture(t);
  const { dir, branch } = createWorktree({ root, name: '未跟踪 文件', base, env });
  write(path.join(dir, 'new.txt'), '新\n');
  assert.throws(() => removeWorktree({ root, dir, branch }), /移除 worktree 目录失败：/);
  assert.ok(existsSync(path.join(dir, 'new.txt')));
  assert.equal(listWorktrees({ root }).length, 1);
  removeWorktree({ root, dir, branch, force: true });
  assert.equal(existsSync(dir), false);
  assert.equal(git(root, ['branch', '--list', branch]), '');
});

test('removeWorktree：deleteBranch 与 forceBranch 的组合', t => {
  const { root, base, env } = fixture(t);
  // 不删分支：分支保留。
  const one = createWorktree({ root, name: 'keep', base, env });
  removeWorktree({ root, dir: one.dir, branch: one.branch, deleteBranch: false });
  assert.equal(existsSync(one.dir), false);
  assert.notEqual(git(root, ['branch', '--list', one.branch]), '');
  // 分支上有没合并的提交：-d 失败（目录已删，不回滚），forceBranch 才能删。
  const two = createWorktree({ root, name: 'unmerged', base, env });
  write(path.join(two.dir, 'b.txt'), '改\n');
  git(two.dir, ['add', 'b.txt']);
  git(two.dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'wip']);
  assert.throws(() => removeWorktree({ root, dir: two.dir, branch: two.branch }), /删除分支失败：/);
  assert.equal(existsSync(two.dir), false);
  assert.notEqual(git(root, ['branch', '--list', two.branch]), '');
  removeWorktree({ root, dir: two.dir, branch: two.branch, forceBranch: true });
  assert.equal(git(root, ['branch', '--list', two.branch]), '');
});
