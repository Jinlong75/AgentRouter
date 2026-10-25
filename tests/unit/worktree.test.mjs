import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWorktreeList, runSetup, shortName, worktreeDir, worktreeRoot } from '../../core/lib/worktree.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');

test('worktreeRoot：AR_WORKTREE_ROOT 优先', () => {
  const root = worktreeRoot({ env: { AR_WORKTREE_ROOT: '/tmp/x/wt', LOCALAPPDATA: 'C:\\L' }, platform: 'win32', homedir: '/h' });
  assert.equal(root, '/tmp/x/wt');
});

test('worktreeRoot：Windows 用 LOCALAPPDATA', () => {
  const root = worktreeRoot({ env: { LOCALAPPDATA: 'D:\\data\\AppData\\Local' }, platform: 'win32', homedir: 'D:\\data' });
  assert.equal(root, 'D:\\data\\AppData\\Local\\agent-router\\wt');
});

test('worktreeRoot：Windows 没有 LOCALAPPDATA 时用 homedir 下的 AppData\\Local', () => {
  const root = worktreeRoot({ env: {}, platform: 'win32', homedir: 'D:\\data' });
  assert.equal(root, 'D:\\data\\AppData\\Local\\agent-router\\wt');
});

test('worktreeRoot：其他平台用 ~/.cache/agent-router/wt', () => {
  const root = worktreeRoot({ env: {}, platform: 'linux', homedir: '/opt/h' });
  assert.equal(root, '/opt/h/.cache/agent-router/wt');
});

test('shortName：纯 ASCII 原样保留并加哈希前 6 位', () => {
  assert.equal(shortName('run-1.a_b'), `run-1.a_b-${sha('run-1.a_b').slice(0, 6)}`);
});

test('shortName：中文与空格每段连续字符换成一个 _', () => {
  const name = '任务 一  二ab';
  assert.equal(shortName(name), `_ab-${sha(name).slice(0, 6)}`);
  assert.match(shortName('a 中文 b'), /^a_b-[0-9a-f]{6}$/);
});

test('shortName：超长截到 24 个字符', () => {
  const short = shortName('x'.repeat(60));
  assert.equal(short, `${'x'.repeat(24)}-${sha('x'.repeat(60)).slice(0, 6)}`);
});

test('shortName：只差尾部的两个长名不重名', () => {
  const a = shortName(`${'n'.repeat(30)}-1`);
  const b = shortName(`${'n'.repeat(30)}-2`);
  assert.notEqual(a, b);
  assert.equal(a.slice(0, 24), b.slice(0, 24));
});

test('worktreeDir：Windows 上项目根大小写不同得到同一个目录', () => {
  const env = { AR_WORKTREE_ROOT: 'C:\\wt' };
  const one = worktreeDir({ root: 'C:\\Proj\\App', name: 'r1', env, platform: 'win32' });
  const two = worktreeDir({ root: 'c:\\proj\\app', name: 'r1', env, platform: 'win32' });
  assert.equal(one, two);
  assert.match(one, /^C:\\wt\\[0-9a-f]{6}-r1-[0-9a-f]{6}$/);
});

test('worktreeDir：非 Windows 上大小写不同是不同项目', () => {
  const env = { AR_WORKTREE_ROOT: '/wt' };
  const one = worktreeDir({ root: '/p/App', name: 'r1', env, platform: 'linux' });
  const two = worktreeDir({ root: '/p/app', name: 'r1', env, platform: 'linux' });
  assert.notEqual(one, two);
});

test('parseWorktreeList：解析 porcelain -z，不含主工作区', () => {
  const text = [
    'worktree /repo', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /wt/one two', 'HEAD bbb', 'branch refs/heads/ar/r1', '',
    'worktree /wt/det', 'HEAD ccc', 'detached', 'locked 原因', 'prunable gitdir file points to non-existent location', '',
  ].join('\0') + '\0';
  const list = parseWorktreeList(text);
  assert.equal(list.length, 2);
  assert.equal(list[0].branch, 'ar/r1');
  assert.equal(list[0].head, 'bbb');
  assert.equal(list[0].locked, false);
  assert.equal(list[0].prunable, false);
  assert.match(list[0].dir.replace(/\\/g, '/'), /\/wt\/one two$/);
  assert.equal(list[1].branch, null);
  assert.equal(list[1].locked, true);
  assert.equal(list[1].prunable, true);
});

test('parseWorktreeList：空输出与只有主工作区', () => {
  assert.deepEqual(parseWorktreeList(''), []);
  assert.deepEqual(parseWorktreeList('worktree /repo\0HEAD a\0branch refs/heads/main\0\0'), []);
});

// 093：extraEnv 在 removeEnv 之后合并；不传时命令环境与原来相同。
const dumpEnv = `node -e "console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(AR_|FOO_093)/i.test(k)))))"`;
const envOf = result => JSON.parse(result.results[0].output.trim());

test('runSetup：extraEnv 在去掉 AR_ 变量之后合并，同名的父进程变量被它覆盖，其余 AR_ 变量照旧被去掉', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-093-setup-'));
  try {
    const env = { ...process.env, AR_BASE_REPO: '父进程的值', AR_OTHER: '别的', FOO_093: '保留' };
    const result = await runSetup({ dir, commands: [dumpEnv], env, extraEnv: { AR_BASE_REPO: '/主工作区', AR_WORKTREE: '/worktree' } });
    assert.equal(result.ok, true, result.summary);
    assert.deepEqual(envOf(result), { FOO_093: '保留', AR_BASE_REPO: '/主工作区', AR_WORKTREE: '/worktree' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runSetup：不传 extraEnv 时去掉全部 AR_ 变量，与原来相同', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-093-setup-'));
  try {
    const env = { ...process.env, AR_BASE_REPO: '父进程的值', AR_WORKTREE: '父进程的值', FOO_093: '保留' };
    const result = await runSetup({ dir, commands: [dumpEnv], env });
    assert.equal(result.ok, true, result.summary);
    assert.deepEqual(envOf(result), { FOO_093: '保留' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});