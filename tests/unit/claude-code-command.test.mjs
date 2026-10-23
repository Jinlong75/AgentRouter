import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCode, READONLY_TOOLS } from '../../core/adapters/claude-code.mjs';

// 假的启动器：不查找、不启动任何真实的 Claude Code。
const detection = { launcher: { executable: 'claude-fake', args: [] } };
const command = (settings, readOnly = false) => claudeCode.command({ prompt: 'x', settings, detection, env: {}, readOnly });

const WRITE_BASE = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];
const READ_BASE = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--tools', READONLY_TOOLS, '--allowedTools', READONLY_TOOLS];

test('claude-code command：model / effort 依次拼成 --model / --effort', () => {
  const { args } = command({ model: 'm-x', effort: 'high' });
  assert.deepEqual(args, [...WRITE_BASE, '--model', 'm-x', '--effort', 'high']);
});

test('claude-code command：只给 model 或只给 effort 时只拼对应的参数', () => {
  assert.deepEqual(command({ model: 'm-x' }).args, [...WRITE_BASE, '--model', 'm-x']);
  assert.deepEqual(command({ effort: 'max' }).args, [...WRITE_BASE, '--effort', 'max']);
});

test('claude-code command：model / effort 为 null 或没有时参数与改动前完全相同', () => {
  assert.deepEqual(command({ model: null, effort: null, tier: null }).args, WRITE_BASE);
  assert.deepEqual(command({}).args, WRITE_BASE);
  assert.deepEqual(command({ model: null, effort: null }, true).args, READ_BASE);
  assert.deepEqual(command({ model: null, effort: null, maxTurns: 5 }).args, [...WRITE_BASE, '--max-turns', '5']);
});

test('claude-code command：只读模式同样带上 --model / --effort', () => {
  assert.deepEqual(command({ model: 'm-x', effort: 'low' }, true).args, [...READ_BASE, '--model', 'm-x', '--effort', 'low']);
});

test('claude-code command：tier 不传入任何参数', () => {
  assert.deepEqual(command({ tier: 'flex' }).args, WRITE_BASE);
  const { args } = command({ model: 'm-x', effort: 'high', tier: 'flex' });
  assert.deepEqual(args, [...WRITE_BASE, '--model', 'm-x', '--effort', 'high']);
  assert.ok(!args.includes('flex') && !args.includes('--tier'));
});
