import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatProgress, failureReason } from '../../core/lib/progress.mjs';

test('工具事件：有 name 且 detail 不以 name 开头时写"工具：name detail"', () => {
  assert.deepEqual(formatProgress({ kind: 'tool', name: 'search', detail: '{"q":"x"}' }), ['工具：search {"q":"x"}']);
});

test('工具事件：detail 以 name 开头时照旧只写 detail', () => {
  assert.deepEqual(formatProgress({ kind: 'tool', name: 'Read', detail: 'Read a.txt' }), ['工具：Read a.txt']);
});

test('工具事件：Codex 的 mcp_tool_call 是类别名，只写 detail', () => {
  assert.deepEqual(formatProgress({ kind: 'tool', name: 'mcp_tool_call', detail: 'example inspect' }), ['工具：example inspect']);
});

test('工具事件：detail 为空时写"工具：name"', () => {
  assert.deepEqual(formatProgress({ kind: 'tool', name: 'x', detail: '' }), ['工具：x']);
  assert.deepEqual(formatProgress({ kind: 'tool', name: 'x' }), ['工具：x']);
});

test('工具事件：web_search 与 init 的写法不变', () => {
  assert.deepEqual(formatProgress({ kind: 'tool', name: 'web_search', detail: 'node test' }), ['搜索：node test']);
  assert.deepEqual(formatProgress({ kind: 'tool', name: 'init', detail: 'demo-model' }), ['模型：demo-model']);
});

test('失败原因：Node 找不到模块的多行输出，取 Error: Cannot find module 那一行', () => {
  const stderr = [
    'node:internal/modules/cjs/loader:1386',
    '  throw err;',
    '  ^',
    '',
    "Error: Cannot find module '/tmp/no-such-cli.mjs'",
    'Require stack:',
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1383:15)',
    '    at node:internal/main/run_main_module:36:49 {',
    "  code: 'MODULE_NOT_FOUND',",
    '  requireStack: []',
    '}',
    '',
    'Node.js v24.0.0',
  ].join('\n');
  assert.equal(failureReason(stderr), "Error: Cannot find module '/tmp/no-such-cli.mjs'");
});

test('失败原因：没有像错误的行时取最后 5 行；只有一行普通文字时原样返回；空输入返回 null', () => {
  assert.equal(failureReason('boom'), 'boom');
  assert.equal(failureReason('1\n2\n3\n4\n5\n6\n7'), '3\n4\n5\n6\n7');
  assert.equal(failureReason('正常日志\n登录失败：令牌过期'), '登录失败：令牌过期');
  assert.equal(failureReason(''), null);
  assert.equal(failureReason(null), null);
});
