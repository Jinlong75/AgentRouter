import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptReportFile } from '../../core/lib/gate.mjs';

test('汇报按尝试类型回溯，执行者有指令时不回溯', t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-report-fallback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const attempts = join(root, 'attempts');
  for (const n of [1, 2, 3, 4]) mkdirSync(join(attempts, String(n)), { recursive: true });
  const report = n => join(attempts, String(n), 'report.md');
  writeFileSync(report(1), '一次');
  writeFileSync(report(2), '二次');
  writeFileSync(report(3), '三次');
  assert.equal(attemptReportFile(join(attempts, '3')), report(3));
  rmSync(report(3));
  assert.equal(attemptReportFile(join(attempts, '3')), report(2));
  rmSync(report(1));
  rmSync(report(2));
  assert.equal(attemptReportFile(join(attempts, '3')), join(root, 'report.md'));
  writeFileSync(report(2), '二次');
  writeFileSync(join(attempts, '4', 'prompt.md'), '指令');
  assert.equal(attemptReportFile(join(attempts, '4')), report(4));
});
