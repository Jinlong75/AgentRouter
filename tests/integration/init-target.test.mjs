import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseTarget, validateTarget } from '../../core/lib/target.mjs';

const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const targetPath = '.agent-router/target.md';
const usage = '用法：ar init [项目路径] [--dry-run] [--target] | ar init --upgrade [项目路径] [--dry-run] [--target] [--replace-role <角色,…>] [--add-field <键,…>]';

function fixture(t) {
  const base = fs.mkdtempSync(join(tmpdir(), 'ar-target-'));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }); });
  const repo = join(base, 'repo'), home = join(base, 'home');
  fs.mkdirSync(repo);
  const env = { ...process.env, AGENT_ROUTER_HOME: home };
  const run = (program, args) => spawnSync(program, args, { cwd: repo, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 20000 });
  const git = (...args) => { const r = run('git', args); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const ar = (...args) => run(process.execPath, [entry, ...args]);
  const json = (...args) => { const r = ar(...args, '--json'); assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', '测试'); git('config', 'user.email', 'test@example.invalid'); git('config', 'commit.gpgsign', 'false');
  return { repo, home, ar, json, git, target: join(repo, targetPath) };
}

test('默认不生成；init 的目标预览不写入，显式生成的模板可解析', t => {
  const f = fixture(t);
  const plain = f.json('init', '--dry-run');
  assert.ok(!plain.changes.some(c => c.path === targetPath));
  const dry = f.json('init', '--target', '--dry-run');
  const item = dry.changes.find(c => c.path === targetPath);
  assert.equal(item.action, 'create');
  assert.equal(validateTarget(parseTarget(item.content)).valid, true);
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.existsSync(f.home), false);
  f.json('init');
  assert.equal(fs.existsSync(f.target), false);
  const result = f.json('init', '--target');
  assert.deepEqual(result.changes.find(c => c.path === targetPath), { path: targetPath, action: 'create' });
  assert.equal(validateTarget(parseTarget(fs.readFileSync(f.target, 'utf8'))).valid, true);
});

test('已有目标文件原样保留；升级预览不写入并能补建', t => {
  const f = fixture(t);
  f.json('init');
  const dry = f.json('init', '--upgrade', '--target', '--dry-run');
  assert.equal(dry.changes.find(c => c.path === targetPath).action, 'create');
  assert.equal(fs.existsSync(f.target), false);
  f.json('init', '--upgrade', '--target');
  assert.equal(validateTarget(parseTarget(fs.readFileSync(f.target, 'utf8'))).valid, true);
  const original = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
  fs.writeFileSync(f.target, original);
  for (const args of [['init', '--target'], ['init', '--upgrade', '--target'], ['init', '--target', '--dry-run'], ['init', '--upgrade', '--target', '--dry-run']]) {
    const result = f.json(...args);
    assert.ok(!result.changes.some(c => c.path === targetPath));
    assert.deepEqual(fs.readFileSync(f.target), original);
  }
});

test('非法参数与重复 --target 返回既有用法和退出码', t => {
  const f = fixture(t);
  for (const args of [['init', '--target', '--target'], ['init', '--upgrade', '--target', '--target'], ['init', '--invalid'], ['init', 'a', 'b']]) {
    const r = f.ar(...args);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes(usage));
  }
});

test('commit-init 包含显式生成的目标文件', t => {
  const f = fixture(t);
  f.json('init', '--target');
  const result = f.json('projects', 'commit-init', f.repo);
  assert.ok(result.files.includes(targetPath));
  assert.ok(f.git('show', '--format=', '--name-only', 'HEAD').split(/\r?\n/).includes(targetPath));
});
