import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validRequest } from '../../core/lib/managed.mjs';
import { resolveBase, specRelative, worktreeEnabled } from '../../core/lib/worktree.mjs';

// 083：worktree 模式的启用判断与请求字段校验（协议 15.1、15.2）。

test('启用判断：用任务说明派发 + 项目配置 worktree 明确为 true + 没有 --no-worktree，三条同时满足', () => {
  const spec = 'docs/specs/001-x.md';
  assert.equal(worktreeEnabled({ spec, projectConfig: { worktree: true } }), true);
  assert.equal(worktreeEnabled({ spec, projectConfig: { worktree: true }, noWorktree: false }), true);
  // 缺一条都不启用。
  assert.equal(worktreeEnabled({ spec: null, projectConfig: { worktree: true } }), false, '直接写任务文字派发的任务不用');
  assert.equal(worktreeEnabled({ spec: '', projectConfig: { worktree: true } }), false);
  assert.equal(worktreeEnabled({ spec, projectConfig: { worktree: true }, noWorktree: true }), false, '--no-worktree');
  assert.equal(worktreeEnabled({ spec, projectConfig: { worktree: false } }), false);
  assert.equal(worktreeEnabled({ spec, projectConfig: {} }), false, '没写 worktree 按 false');
  assert.equal(worktreeEnabled({ spec, projectConfig: null }), false, '没有项目配置');
  assert.equal(worktreeEnabled({ spec }), false);
  assert.equal(worktreeEnabled(), false);
  // 必须明确为布尔 true，其他真值不算。
  for (const value of ['true', 1, 'yes', [], {}]) {
    assert.equal(worktreeEnabled({ spec, projectConfig: { worktree: value } }), false, `worktree: ${JSON.stringify(value)}`);
  }
});

const absolute = name => path.resolve(path.sep, name);
const request = extra => ({
  v: 1, id: 'task-1', at: 1, script: absolute('ar.mjs'), node: absolute('node'), repo: absolute('repo'), name: '记录',
  args: { task: '任务', extra: '', role: null, spec: null },
  settings: { model: null, effort: null, tier: null, sandbox: 'workspace-write', path: null },
  dispatcher: { host: 'unknown', session: null }, env: {},
  ...extra,
});

test('请求字段 worktree.base：缺省有效（旧请求照常），有就必须是完整十六进制 SHA', () => {
  assert.equal(validRequest(request({})), true, '没有 worktree 字段');
  assert.equal(validRequest(request({ worktree: { base: 'a'.repeat(40) } })), true);
  assert.equal(validRequest(request({ worktree: { base: '0123456789abcdef'.repeat(4) } })), true, 'SHA-256 仓库的 64 位');
  for (const worktree of [
    null, 'a'.repeat(40), [], {}, { base: null }, { base: 123 }, { base: '' },
    { base: 'abc123' }, { base: 'a'.repeat(39) }, { base: 'a'.repeat(41) + 'g' }, { base: 'A'.repeat(40) }, { base: `${'a'.repeat(39)} ` },
    { base: 'a'.repeat(65) },
  ]) {
    assert.equal(validRequest(request({ worktree })), false, JSON.stringify(worktree));
  }
});

test('任务说明相对路径：在项目根之内给相对路径（/ 分隔），在项目根之外为 null', () => {
  const root = absolute('proj');
  assert.equal(specRelative(root, 'docs/specs/001-x.md'), 'docs/specs/001-x.md');
  assert.equal(specRelative(root, path.join(root, 'docs', 'specs', '001-x.md')), 'docs/specs/001-x.md');
  assert.equal(specRelative(root, './docs/../docs/a.md'), 'docs/a.md');
  assert.equal(specRelative(root, '../other/a.md'), null);
  assert.equal(specRelative(root, absolute('elsewhere/a.md')), null);
  assert.equal(specRelative(root, '.'), null);
});

test('基线：主分支名为空或以 - 开头时直接拒绝，不去问 git', () => {
  assert.throws(() => resolveBase(process.cwd(), undefined), /项目配置没有写 baseBranch/);
  assert.throws(() => resolveBase(process.cwd(), '  '), /项目配置没有写 baseBranch/);
  assert.throws(() => resolveBase(process.cwd(), '--output=x'), /baseBranch 无效/);
});
