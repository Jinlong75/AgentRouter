import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deletedFromEntries, parseNameStatusEntriesZ } from '../../core/lib/git.mjs';

// 056：带状态的 name-status 解析（协议 12.1 第 4 步：受保护路径与删除的文件）。

test('parseNameStatusEntriesZ：D、R100、M 混合；重命名给旧、新两个路径', () => {
  const text = 'M\0src/a.js\0D\0docs/specs/旧.md\0R100\0src/旧 名.js\0lib/新 名.js\0A\0README.md\0';
  assert.deepEqual(parseNameStatusEntriesZ(text), [
    { status: 'M', paths: ['src/a.js'] },
    { status: 'D', paths: ['docs/specs/旧.md'] },
    { status: 'R100', paths: ['src/旧 名.js', 'lib/新 名.js'] },
    { status: 'A', paths: ['README.md'] },
  ]);
});

test('parseNameStatusEntriesZ：复制项同样给旧、新两个路径；状态保留原始写法（含相似度）', () => {
  const text = 'C075\0src/c.js\0lib/c.js\0';
  assert.deepEqual(parseNameStatusEntriesZ(text), [{ status: 'C075', paths: ['src/c.js', 'lib/c.js'] }]);
});

test('deletedFromEntries：只取状态 D 的路径，重命名不算删除', () => {
  const entries = parseNameStatusEntriesZ('M\0src/a.js\0D\0tests/old.test.js\0R100\0tests/a.test.js\0tests/b.test.js\0D\0docs/旧.md\0');
  assert.deepEqual(deletedFromEntries(entries), ['tests/old.test.js', 'docs/旧.md']);
});

test('parseNameStatusEntriesZ：空输入返回空数组', () => {
  assert.deepEqual(parseNameStatusEntriesZ(''), []);
  assert.deepEqual(deletedFromEntries(parseNameStatusEntriesZ('')), []);
});
