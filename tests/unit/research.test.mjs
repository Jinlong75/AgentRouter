import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planResearch } from '../../core/lib/research.mjs';

test('调研计划固定提交、排序去重和分批，只包含快照里的文件', t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-research-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = args => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  run(['init', '-q']); run(['config', 'user.name', 'Test']); run(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(root, 'b.txt'), 'b'); writeFileSync(join(root, 'a.txt'), 'a');
  run(['add', '--', 'a.txt', 'b.txt']); run(['commit', '-qm', 'fixture']);
  const snapshot = run(['rev-parse', 'HEAD']); writeFileSync(join(root, 'untracked.txt'), 'x');
  const result = planResearch({ root, question: ' 问题 ', patterns: ['*.txt', 'a.txt'], batch: 1 });
  assert.equal(result.snapshot, snapshot); assert.equal(result.question, '问题'); assert.equal(result.budgetMin, 30);
  assert.deepEqual(result.batches, [{ index: 1, files: ['a.txt'] }, { index: 2, files: ['b.txt'] }]);
  for (const pattern of ['../*.txt', '/tmp/*', 'C:\\x']) assert.throws(() => planResearch({ root, question: '问题', patterns: [pattern] }));
  assert.throws(() => planResearch({ root, question: ' ', patterns: ['*'] }));
  assert.throws(() => planResearch({ root, question: '问题', patterns: ['none'] }));
  assert.throws(() => planResearch({ root, question: '问题', patterns: ['*'], budgetMin: 0 }));
  // 时限上限 1440 分钟（再大 setTimeout 会溢出成立即触发）。
  assert.equal(planResearch({ root, question: '问题', patterns: ['*'], budgetMin: 1440 }).budgetMin, 1440);
  assert.throws(() => planResearch({ root, question: '问题', patterns: ['*'], budgetMin: 1441 }), /1440/);
});
