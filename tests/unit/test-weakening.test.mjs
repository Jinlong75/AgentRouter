import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTestWeakening } from '../../core/lib/gate.mjs';

test('配置必须是非空字符串数组且断言模式必须是有效正则', () => {
  for (const config of [{ testPaths: [] }, { testPaths: null }, { testPaths: [' '] },
    { testAssertionPatterns: [] }, { testAssertionPatterns: [1] }, { testAssertionPatterns: ['('] }]) {
    assert.throws(() => checkTestWeakening('.', 'same', 'same', config), /testPaths|testAssertionPatterns/);
  }
  assert.deepEqual(checkTestWeakening('.', 'same', 'same', {}), []);
});
