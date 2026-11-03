import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, git, write, until } from '../fixtures/review/pipeline-fixture.mjs';

const worktree = (f, name) => f.events(name).find(row => row.event === 'worktree').dir;
const commit = (dir, file, content) => {
  write(path.join(dir, file), content);
  git(dir, ['add', '--', file]);
  git(dir, ['commit', '-q', '-m', '测试提交', '--', file]);
};
const reviews = (f, name) => f.events(name).filter(row => row.event === 'review').length;

test('门禁失败后补提交，合并基线通过门禁后重新审查', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev', modes: 'ok' }] });
  const spec = f.spec('docs/specs/001.md', { review: true, maxRetries: 0, verify: ['node -e "process.exit(require(\'fs\').readFileSync(\'src/a.js\',\'utf8\').includes(\'fail\') ? 1 : 0)"'] });
  assert.equal((await f.dispatch(spec, '甲')).code, 0);
  const dir = worktree(f, '甲');
  const oldHead = f.review('甲').head;
  commit(dir, 'src/a.js', 'fail\n');
  assert.equal((await f.json(['retry', '甲', '--regate'])).code, 3);
  commit(dir, 'src/a.js', '修复\n');
  commit(f.repo, 'README.md', '基线前进\n');
  const result = await f.json(['retry', '甲', '--rebase']);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal((await f.json(['status', '甲'])).value.state, 'awaiting');
  assert.equal(reviews(f, '甲'), 2);
  assert.notEqual(f.review('甲').head, oldHead);
  assert.equal(f.review('甲').head, git(dir, ['rev-parse', 'HEAD']));
  assert.match(f.progress('甲'), /合并基线后发现上次审查之后的新提交：重新审查/);
});

test('只有基线前进时合并基线不重新审查', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev', modes: 'ok' }], executor: { report: '假汇报\n## 已知问题\n无\n' } });
  const spec = f.spec('docs/specs/002.md', { review: true });
  const other = f.spec('docs/specs/other.md', { review: false });
  assert.equal((await f.dispatch(spec, '乙')).code, 0);
  const before = readFileSync(path.join(f.dir('乙'), 'review.json'), 'utf8');
  f.executor.writes = [{ path: 'README.md', content: '基线前进\n' }];
  f.writeConfig();
  assert.equal((await f.dispatch(other, '基线任务')).code, 0);
  const result = await f.json(['accept', '基线任务']);
  assert.equal(result.code, 0, JSON.stringify(result));
  await until(() => f.events('乙').filter(row => row.event === 'end').length === 2, '自动重跑结束');
  assert.equal((await f.json(['status', '乙'])).value.state, 'awaiting');
  assert.equal(reviews(f, '乙'), 1);
  assert.equal(readFileSync(path.join(f.dir('乙'), 'review.json'), 'utf8'), before);
});

test('从未审查的任务合并基线不开始审查', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev', modes: 'ok' }] });
  const spec = f.spec('docs/specs/003.md', { review: true, maxRetries: 0, verify: ['node scripts/check.mjs'] });
  assert.equal((await f.dispatch(spec, '丙')).code, 3);
  const dir = worktree(f, '丙');
  commit(dir, 'src/ok.txt', '通过\n');
  commit(f.repo, 'README.md', '基线前进\n');
  const result = await f.json(['retry', '丙', '--rebase']);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(reviews(f, '丙'), 0);
  assert.equal(f.exists(f.dir('丙'), 'review.json'), false);
});
