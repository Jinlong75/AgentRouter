import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMutations } from '../../core/lib/mutation.mjs';
test('合并去重并检查字段', () => {
  const text = '## 反向实验\n```json\n[{"file":"a","find":"x","replace":"y","command":"test"}]\n```';
  assert.equal(parseMutations(text, text).length, 1);
  assert.throws(() => parseMutations('## 反向实验\n```json\n[\n```', ''), /JSON/);
  assert.throws(() => parseMutations('## 反向实验\n```json\n[{}]\n```', ''), /file/);
});

const section = items => `## 反向实验\n\`\`\`json\n${JSON.stringify(items)}\n\`\`\`\n`;
test('合并去重与错误定位', () => {
  const item = { file: 'a', find: 'x', replace: 'y', command: 'test' };
  assert.equal(parseMutations(section([item]), section([{ ...item, expect: 'test' }])).length, 1);
  for (const source of ['spec', 'report']) {
    const args = source === 'spec' ? [section([item, { ...item, command: '' }]), ''] : ['', section([item, { ...item, command: '' }])];
    assert.throws(() => parseMutations(...args), new RegExp(`${source} 第 2 项 command`));
  }
});

 test('source index across blocks', () => {
  const item = { file: 'a', find: 'x', replace: 'y', command: 'test' };
  const blocks = section([item]).trimEnd() + `\n\`\`\`json\n${JSON.stringify([{ ...item, command: '' }])}\n\`\`\`\n`;
  assert.throws(() => parseMutations(blocks, ''), /spec \u7b2c 2 \u9879 command/);
  const result = parseMutations(section([item]), section([{ ...item, file: 'b' }]));
  assert.equal(result[1].sourceIndex, 1);
});
