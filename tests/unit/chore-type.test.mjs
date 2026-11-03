import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, validateSpec, mergeSpec } from '../../core/lib/spec.mjs';
import { needsReadOnly } from '../../core/lib/run.mjs';
import { suggestRules } from '../../core/lib/suggest.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('杂务可写、默认不审查且不继承项目门禁', () => {
  const spec = validateSpec(parseSpec('---\nid: 1\ntype: chore\n---\n正文'));
  assert.equal(needsReadOnly(spec), false);
  assert.equal(spec.review, false);
  assert.equal(mergeSpec(spec, { verify: ['test'], allowedPaths: ['src/**'] }).gate, false);
  assert.equal(mergeSpec({ ...spec, verify: ['test'] }).gate, true);
});

test('杂务显式要求审查或 worktree 时按项目配置创建 worktree', t => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-chore-worktree-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home');
  mkdirSync(repo); mkdirSync(home); mkdirSync(path.join(repo, '.agent-router'));
  const git = args => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', '测试']); git(['config', 'user.email', 'test@example.test']);
  writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
  writeFileSync(path.join(repo, '.agent-router', 'project.json'), JSON.stringify({ v: 1, baseBranch: 'main', worktree: true, setup: [], verify: [] }));
  for (const [name, extra] of [['default', ''], ['review', 'review: true\n'], ['worktree', 'worktree: true\n'], ['verify', 'verify:\n  - node -v\n']]) {
    writeFileSync(path.join(repo, `${name}.md`), `---\nid: 1\ntype: chore\n${extra}---\n正文\n`);
  }
  git(['add', '--', '.gitignore', '.agent-router/project.json', 'default.md', 'review.md', 'worktree.md', 'verify.md']);
  git(['commit', '-q', '-m', '初始']);
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake' } } }));
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'worktrees'), AR_NO_WATCH: '1', USERPROFILE: base, HOME: base, APPDATA: base };
  delete env.AR_PROFILE; delete env.AR_DRY_RUN; delete env.AR_TEST_AGENT;
  const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
  for (const [name, expected] of [['default', false], ['review', true], ['worktree', true], ['verify', false]]) {
    const result = spawnSync(process.execPath, [script, 'dispatch', `${name}.md`, '--name', name, '--json'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const dispatch = JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'dispatch.json'), 'utf8'));
    assert.equal(dispatch.worktree === true, expected, name);
  }
});

test('杂务按单价选择已启用且测试通过的执行者', () => {
  const config = { profiles: { a: { adapter: 'fake' }, b: { adapter: 'fake' } }, prices: { a: { input: 3, output: 3, currency: 'CNY' }, b: { input: 1, output: 1, currency: 'CNY' } } };
  const result = suggestRules({ config, tests: { a: { ok: true }, b: { ok: true } } });
  assert.deepEqual(result.rules.find(rule => rule.types.includes('chore')), { types: ['chore'], profile: 'b', why: '按单价最低（输入加输出，CNY）' });
});
