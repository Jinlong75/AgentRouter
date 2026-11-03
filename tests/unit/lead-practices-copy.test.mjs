import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { syncLeadPractices } from '../../tools/sync-lead-practices.mjs';

test('核心副本与技能一致，临时副本改动会被发现', t => {
  assert.deepEqual(syncLeadPractices({ check: true }), []);
  const dir = mkdtempSync(join(tmpdir(), 'ar-practices-copy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(resolve('core/templates/lead-practices'), dir, { recursive: true });
  appendFileSync(join(dir, 'examples.md'), '变化');
  assert.deepEqual(syncLeadPractices({ target: dir, check: true }), ['examples.md']);
});
