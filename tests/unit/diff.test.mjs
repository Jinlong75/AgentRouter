import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILE_LIMIT, TOTAL_LIMIT, cutUtf8, hunksOf, parseNumstatZ } from '../../core/lib/diff.mjs';

// 085：ar diff 的解析与截断（协议 15.9）。纯函数，不碰 git。

test('上限常量：单文件 200 KB、整体 2 MB', () => {
  assert.equal(FILE_LIMIT, 200 * 1024);
  assert.equal(TOTAL_LIMIT, 2 * 1024 * 1024);
});

test('parseNumstatZ：增删改、重命名、二进制、含空格与中文的路径', () => {
  const text = [
    '12\t3\tsrc/a.js',
    '5\t0\t目录 里/新文件.txt',
    '0\t7\tsrc/gone.js',
    '-\t-\tassets/图标.png',
    // 重命名：增删后面是空路径，随后依次是旧路径、新路径。
    '2\t1\t', 'src/old name.js', 'src/new name.js',
    '',
  ].join('\0');
  assert.deepEqual(parseNumstatZ(text), [
    { path: 'src/a.js', oldPath: null, additions: 12, deletions: 3, binary: false },
    { path: '目录 里/新文件.txt', oldPath: null, additions: 5, deletions: 0, binary: false },
    { path: 'src/gone.js', oldPath: null, additions: 0, deletions: 7, binary: false },
    { path: 'assets/图标.png', oldPath: null, additions: 0, deletions: 0, binary: true },
    { path: 'src/new name.js', oldPath: 'src/old name.js', additions: 2, deletions: 1, binary: false },
  ]);
});

test('parseNumstatZ：空输出与垃圾输入得到空列表', () => {
  assert.deepEqual(parseNumstatZ(''), []);
  assert.deepEqual(parseNumstatZ(undefined), []);
  assert.deepEqual(parseNumstatZ('不是 numstat\0'), []);
});

test('parseNumstatZ：路径里带制表符也按第三个制表符之后整体当路径', () => {
  assert.deepEqual(parseNumstatZ('1\t1\ta\tb.txt\0'), [{ path: 'a\tb.txt', oldPath: null, additions: 1, deletions: 1, binary: false }]);
});

test('hunksOf：去掉文件头，从第一个 @@ 开始；纯重命名没有 @@ 时为空串', () => {
  const output = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
  assert.equal(hunksOf(output), '@@ -1 +1 @@\n-a\n+b\n');
  assert.equal(hunksOf('@@ -0,0 +1 @@\n+x\n'), '@@ -0,0 +1 @@\n+x\n');
  assert.equal(hunksOf('diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n'), '');
  assert.equal(hunksOf(''), '');
  assert.equal(hunksOf(undefined), '');
});

test('cutUtf8：按字节截断，落点对齐字符边界，不切出半个字符', () => {
  assert.equal(cutUtf8('abc', 10), 'abc');
  assert.equal(cutUtf8('abcdef', 3), 'abc');
  assert.equal(cutUtf8('中文字', 9), '中文字');
  assert.equal(cutUtf8('中文字', 7), '中文');   // 第 7 个字节是第三个字的中间
  assert.equal(cutUtf8('中文字', 6), '中文');
  assert.equal(cutUtf8('中文字', 2), '');
  assert.equal(cutUtf8('a中', 2), 'a');
  assert.equal(cutUtf8('abc', 0), '');
  for (let limit = 0; limit <= 12; limit++) {
    const cut = cutUtf8('a中b文😀c', limit);
    assert.ok(Buffer.byteLength(cut) <= limit, `limit ${limit}`);
    assert.ok(!cut.includes('�'), `limit ${limit} 不含替换字符`);
  }
});
