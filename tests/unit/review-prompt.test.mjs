import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewPrompt } from '../../core/lib/review.mjs';

test('不成立的问题可选加入审查指令，空列表保持原文', () => {
  const args = { specText: '任务', report: '汇报', diff: '差异', gate: '门禁', base: 'a', head: 'b' };
  const template = readFileSync(new URL('../../core/templates/review-prompt.md', import.meta.url), 'utf8');
  const expected = template.replace('{{dismissed}}', '').replace('{{spec}}', '任务').replace('{{report}}', '汇报').replace('{{diff}}', '差异').replace('{{gate}}', '门禁').replace('{{base}}', 'a').replace('{{head}}', 'b');
  assert.equal(reviewPrompt(args), expected);
  assert.equal(reviewPrompt({ ...args, dismissed: [] }), expected);
  const prompt = reviewPrompt({ ...args, dismissed: [{ id: 'R1-1', severity: 'high', file: 'src/a.js', line: 12, title: '问题', note: '理由原文', by: 'lead' }, { id: 'R1-2', severity: 'low', file: 'a.js', line: null, title: '另一问题', note: '', by: 'human' }] });
  assert.ok(prompt.includes('## 主导已判为不成立的问题（上一轮）'));
  assert.ok(prompt.includes('- R1-1 high src/a.js:12  问题\n  主导理由：理由原文'));
  assert.ok(prompt.includes('主导理由：（未写理由）'));
  const long = reviewPrompt({ ...args, dismissed: [{ id: 'R1-1', severity: 'high', file: 'a', line: 1, title: '问题', note: '理'.repeat(10000) }] });
  assert.ok(long.includes('（问题列表超过 8 KB，已截断）'));
  assert.ok(!long.includes('�'));
});
