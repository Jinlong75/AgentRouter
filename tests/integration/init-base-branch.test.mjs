import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 067：ar init 的 baseBranch 取仓库主分支（origin/HEAD → main → master → 当前分支）。
// 只在系统临时目录的临时仓库里跑，AGENT_ROUTER_HOME 隔离，不登记到真实的 projects.json。
const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'ar-init-067-')));
  t.after(() => { assert.equal(dirname(base), resolve(fs.realpathSync.native(tmpdir()))); fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }); });
  const repo = join(base, 'repo'), home = join(base, 'home');
  fs.mkdirSync(repo);
  const env = { ...process.env, AGENT_ROUTER_HOME: home };
  assert.equal(dirname(env.AGENT_ROUTER_HOME), base);
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, shell: false }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'trunk');
  git('config', 'user.name', '测试'); git('config', 'user.email', 'init-067@example.test'); git('config', 'commit.gpgsign', 'false');
  const commit = () => { fs.writeFileSync(join(repo, 'a.txt'), '初始\n'); git('add', 'a.txt'); git('commit', '-q', '-m', '初始'); };
  const ar = (...args) => spawnSync(process.execPath, [entry, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false });
  const dry = () => { const r = ar('init', '--dry-run', '--json'); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const baseBranch = () => JSON.parse(fs.readFileSync(join(repo, '.agent-router', 'project.json'), 'utf8')).baseBranch;
  return { base, repo, home, git, commit, ar, dry, baseBranch };
}

test('有 origin/HEAD 且当前在功能分支：取 origin/HEAD 指向的分支（第 1 步）', t => {
  const f = fixture(t);
  f.commit();
  const origin = join(f.base, 'origin.git');
  assert.equal(spawnSync('git', ['init', '-q', '--bare', origin]).status, 0);
  f.git('remote', 'add', 'origin', origin);
  f.git('push', '-q', 'origin', 'trunk');
  f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  f.git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  f.git('switch', '-q', '-c', 'feature/x');
  const plan = f.dry();
  assert.deepEqual(plan.baseBranch, { name: 'trunk', step: 1, source: '取自 origin/HEAD（第 1 步）' });
  const text = f.ar('init', '--dry-run');
  assert.match(text.stdout, /主分支（baseBranch）：trunk（取自 origin\/HEAD（第 1 步））/);
  assert.equal(plan.changes.find(c => c.path === '.agent-router/project.json').content.includes('"baseBranch": "trunk"'), true);
  assert.equal(f.ar('init').status, 0);
  assert.equal(f.baseBranch(), 'trunk');
});

test('没有 origin、有 main、当前在功能分支：取 main（第 2 步）', t => {
  const f = fixture(t);
  f.git('checkout', '-q', '-b', 'main'); f.commit();
  f.git('switch', '-q', '-c', 'feature/y');
  assert.deepEqual(f.dry().baseBranch, { name: 'main', step: 2, source: '本地有 main 分支（第 2 步）' });
  assert.match(f.ar('init', '--dry-run').stdout, /主分支（baseBranch）：main（本地有 main 分支（第 2 步））/);
  assert.equal(f.ar('init').status, 0);
  assert.equal(f.baseBranch(), 'main');
});

test('只有 master：取 master（第 3 步）', t => {
  const f = fixture(t);
  f.git('checkout', '-q', '-b', 'master'); f.commit();
  f.git('switch', '-q', '-c', 'feature/z');
  assert.deepEqual(f.dry().baseBranch, { name: 'master', step: 3, source: '本地有 master 分支（第 3 步）' });
  assert.equal(f.ar('init').status, 0);
  assert.equal(f.baseBranch(), 'master');
});

test('只有功能分支：取当前分支（第 4 步）', t => {
  const f = fixture(t);
  f.commit();
  f.git('switch', '-q', '-c', 'feature/only');
  f.git('branch', '-q', '-D', 'trunk');
  assert.deepEqual(f.dry().baseBranch, { name: 'feature/only', step: 4, source: '取当前分支（第 4 步）' });
  assert.match(f.ar('init', '--dry-run').stdout, /主分支（baseBranch）：feature\/only（取当前分支（第 4 步））/);
  assert.equal(f.ar('init').status, 0);
  assert.equal(f.baseBranch(), 'feature/only');
});

test('还没有提交（unborn 分支）：没有 main / master 时取当前（未出生）分支名', t => {
  const f = fixture(t);
  const plan = f.dry();
  assert.equal(plan.baseBranch.step, 4);
  assert.equal(plan.baseBranch.name, 'trunk');
  assert.equal(f.ar('init').status, 0);
  assert.equal(f.baseBranch(), 'trunk');
});

test('已有 project.json 不改，dry-run 也不再报主分支', t => {
  const f = fixture(t);
  f.git('checkout', '-q', '-b', 'main'); f.commit();
  const file = join(f.repo, '.agent-router', 'project.json');
  fs.mkdirSync(dirname(file), { recursive: true });
  const original = JSON.stringify({ v: 1, name: '已有', baseBranch: 'release', specsDir: 'docs/specs' });
  fs.writeFileSync(file, original);
  const plan = f.dry();
  assert.ok(!plan.changes.some(c => c.path === '.agent-router/project.json'));
  assert.equal(Object.hasOwn(plan, 'baseBranch'), false);
  assert.equal(f.ar('init').status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
