import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { collectSignals, gitCallCountForTest } from '../../core/lib/signals.mjs';

const week = 7 * 86400000;
const start = 1700000000000;
function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-signals-'));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  mkdirSync(root); mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'missing'), GIT_TERMINAL_PROMPT: '0' };
  const git = (args, extra = {}) => execFileSync('git', args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', '测试']); git(['config', 'user.email', 'test@example.test']);
  git(['config', 'commit.gpgsign', 'false']); git(['config', 'core.autocrlf', 'false']);
  const commit = (title, files, at) => {
    for (const [file, content] of Object.entries(files)) writeFileSync(path.join(root, file), content);
    git(['add', '--', '.']);
    const date = new Date(at).toISOString();
    git(['commit', '-q', '--allow-empty', '-m', title], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return git(['rev-parse', 'HEAD']);
  };
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { base, root, home, git, commit };
}
const task = (merge, reverted = []) => ({ id: 'same', merge, acceptedAt: start, reverted });
const collect = (root, tasks, now = start + week) => collectSignals({ root, tasks, now }).tasks;
function fingerprint(dir) {
  const hash = createHash('sha256');
  function walk(current) {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, item.name);
      hash.update(path.relative(dir, full));
      if (item.isDirectory()) walk(full); else hash.update(readFileSync(full));
    }
  }
  walk(dir); return hash.digest('hex');
}

test('修复时间、关键词、路径、合并提交和只读边界', t => {
  const f = fixture(t);
  f.commit('base', { '空 格 中文.txt': '0', 'other': '0' }, start - 2000);
  const merge = f.commit('accepted', { '空 格 中文.txt': '1' }, start - 1000);
  f.commit('fix at start', { '空 格 中文.txt': '2' }, start);
  const first = f.commit('FIX first', { '空 格 中文.txt': '3' }, start + 1000);
  f.commit('prefix fixable', { '空 格 中文.txt': '4' }, start + 2000);
  f.commit('fix other', { other: '1' }, start + 3000);
  f.git(['switch', '-q', '-c', 'side']);
  f.commit('ordinary', { other: '2' }, start + 4000);
  f.git(['switch', '-q', 'main']);
  f.commit('ordinary main', { '空 格 中文.txt': '5' }, start + 5000);
  f.git(['merge', '-q', '--no-ff', 'side', '-m', 'fix merge'], { GIT_AUTHOR_DATE: new Date(start + 6000).toISOString(), GIT_COMMITTER_DATE: new Date(start + 6000).toISOString() });
  const last = f.commit('修复问题', { '空 格 中文.txt': '6' }, start + week);
  f.commit('fix too late', { '空 格 中文.txt': '7' }, start + week + 1000);
  const before = fingerprint(f.base);
  const [value, duplicate] = collect(f.root, [task(merge), task(merge)]);
  assert.deepEqual(value, duplicate);
  assert.equal(value.reverted.state, 'no');
  assert.deepEqual(value.fixes, { state: 'complete', commits: [first, last].sort().map(commit => ({ commit, at: commit === first ? start + 1000 : start + week, files: ['空 格 中文.txt'] })) });
  const pending = collect(f.root, [task(merge)], start + 1500)[0];
  assert.deepEqual(pending.fixes, { state: 'pending', commits: [{ commit: first, at: start + 1000, files: ['空 格 中文.txt'] }] });
  assert.equal(fingerprint(f.base), before);
});

test('真实 revert 与事件去重，事件只接受合并后且在 HEAD 中的提交', t => {
  const f = fixture(t);
  const base = f.commit('base', { a: '0' }, start - 2000);
  const merge = f.commit('accepted', { a: '1' }, start - 1000);
  f.git(['revert', '--no-edit', merge], { GIT_AUTHOR_DATE: new Date(start + 1000).toISOString(), GIT_COMMITTER_DATE: new Date(start + 1000).toISOString() });
  const reverted = f.git(['rev-parse', 'HEAD']);
  const result = collect(f.root, [task(merge, [{ commit: reverted, at: start + 1000 }, { commit: reverted, at: start + 1000 }, { commit: base, at: start }, { commit: 'a'.repeat(40), at: start }])])[0];
  assert.deepEqual(result.reverted, { state: 'yes', commits: [reverted] });
  assert.deepEqual(result.fixes.commits, []);
});

test('非祖先、缺对象、根提交和浅克隆', t => {
  const f = fixture(t);
  const rootCommit = f.commit('root', { a: '0' }, start - 2000);
  f.git(['switch', '-q', '-c', 'side']);
  const side = f.commit('side', { a: '1' }, start - 1000);
  f.git(['switch', '-q', 'main']);
  const head = f.commit('main', { a: '2' }, start - 1000);
  const values = collect(f.root, [task(side), task('a'.repeat(40)), task(rootCommit), task(head)]);
  for (const item of values.slice(0, 2)) assert.deepEqual([item.reverted.state, item.fixes.state], ['unknown', 'unknown']);
  assert.deepEqual([values[2].reverted.state, values[2].fixes.state], ['no', 'unknown']);
  assert.deepEqual([values[3].reverted.state, values[3].fixes.state], ['no', 'complete']);
  const clone = path.join(f.base, 'shallow');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${f.root.replaceAll('\\', '/')}`, clone], { env: { ...process.env, AGENT_ROUTER_HOME: f.home }, windowsHide: true });
  const shallow = collect(clone, [task(head)])[0];
  assert.deepEqual([shallow.reverted.state, shallow.fixes.state], ['unknown', 'unknown']);
});

test('newline paths use NUL delimiters', t => {
  const f = fixture(t);
  const file = '\u4e2d\u6587 \u7a7a\u683c\n\u540d\u5b57';
  const base = f.commit('base', { a: '0' }, start - 2000);
  const objectCommit = (parent, content, title, at) => {
    const env = { ...process.env, AGENT_ROUTER_HOME: f.home, GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() };
    const run = (args, input) => execFileSync('git', args, { cwd: f.root, env, input, encoding: 'utf8', windowsHide: true }).trim();
    const blob = run(['hash-object', '-w', '--stdin'], content);
    const tree = run(['mktree', '-z'], '100644 blob ' + blob + '\t' + file + '\0');
    return run(['commit-tree', tree, '-p', parent, '-m', title]);
  };
  const merge = objectCommit(base, '1', 'accepted', start - 1000);
  const fix = objectCommit(merge, '2', 'fix file', start + 1000);
  f.git(['update-ref', 'HEAD', fix]);
  assert.deepEqual(collect(f.root, [task(merge)])[0].fixes.commits, [{ commit: fix, at: start + 1000, files: [file] }]);
});


test('batch metadata and bounded git calls for 200 ordinary commits', t => {
  const f = fixture(t);
  f.commit('base', { a: '0' }, start - 2000);
  const merge = f.commit('accepted', { a: '1' }, start - 1000);
  for (let i = 0; i < 200; i++) f.commit(`ordinary ${i}`, {}, start + 1000);
  const fix = f.commit('fix target\n\nrecord marker\nEND\nbody', { a: '2' }, start + 2000);
  const before = gitCallCountForTest();
  const result = collect(f.root, [task(merge)])[0];
  const calls = gitCallCountForTest() - before;
  assert.deepEqual(result.reverted, { state: 'no', commits: [] });
  assert.deepEqual(result.fixes, { state: 'complete', commits: [{ commit: fix, at: start + 2000, files: ['a'] }] });
  assert.ok(calls <= 9, `git calls: ${calls}`);
});
