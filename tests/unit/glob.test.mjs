import test from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, matchesAny } from '../../core/lib/glob.mjs';

// 大小写一律显式传参，不依赖运行平台。
const ci = { caseInsensitive: true };
const cs = { caseInsensitive: false };
const match = (glob, file, options = cs) => globToRegExp(glob, options).test(file);

test('**/ 匹配零个或多个目录层（a/**/b）', () => {
  assert.ok(match('a/**/b', 'a/b'), '零层');
  assert.ok(match('a/**/b', 'a/x/b'), '一层');
  assert.ok(match('a/**/b', 'a/x/y/b'), '多层');
  assert.ok(!match('a/**/b', 'ab'), '不匹配 ab');
  assert.ok(!match('a/**/b', 'b'), '不匹配 b');
  assert.ok(!match('a/**/b', 'a/bb'), '不匹配 a/bb');
  assert.ok(!match('a/**/b', 'a/x/bb'), '不匹配 a/x/bb');
});

test('**/x 匹配任意层的 x，含根下（**/x）', () => {
  assert.ok(match('**/x', 'x'), '根下的 x');
  assert.ok(match('**/x', 'd/x'), '一层');
  assert.ok(match('**/x', 'd/e/x'), '多层');
  assert.ok(!match('**/x', 'dx'), '不匹配 dx');
  assert.ok(!match('**/x', 'xd'), '不匹配 xd');
  assert.ok(!match('**/x', 'd/x/y'), '不匹配 d/x/y');
});

test('单独的 ** 匹配一切', () => {
  for (const file of ['a', 'a/b', 'a/b/c', '中文/文件.md', 'a b/c.d']) {
    assert.ok(match('**', file), file);
  }
});

test('a/** 匹配 a 下任意层，不匹配 a 自身与 ab/x', () => {
  assert.ok(match('a/**', 'a/x'), 'a/x');
  assert.ok(match('a/**', 'a/x/y'), 'a/x/y');
  assert.ok(!match('a/**', 'a'), '不匹配 a 自身');
  assert.ok(!match('a/**', 'ab/x'), '不匹配 ab/x');
  assert.ok(!match('a/**', 'b/x'), '不匹配 b/x');
});

test('不跟 / 的 ** 匹配任意字符（含 /）', () => {
  assert.ok(match('a/**b', 'a/xb'), '同层尾随');
  assert.ok(match('a/**b', 'a/q/rb'), '跨层尾随');
  assert.ok(!match('a/**b', 'a/q/rr'), '尾字符不符');
  assert.ok(!match('a/**b', 'ab'), '缺 a/ 前缀');
});

test('* 不跨目录层、可匹配空', () => {
  assert.ok(match('src/*.ts', 'src/a.ts'), '同层');
  assert.ok(match('src/*.ts', 'src/.ts'), '空也算');
  assert.ok(!match('src/*.ts', 'src/x/a.ts'), '不跨层');
  assert.ok(!match('src/*.ts', 'src/a.ts.bak'), '整串匹配');
  assert.ok(!match('src/*.ts', 'srcdir/a.ts'), '不匹配 srcdir');
});

test('? 匹配一个非 / 字符', () => {
  assert.ok(match('a?c', 'abc'), '字母');
  assert.ok(match('a?c', 'a.c'), '标点');
  assert.ok(match('a?c', 'a中c'), '中文');
  assert.ok(!match('a?c', 'ac'), '少一个字符');
  assert.ok(!match('a?c', 'abcc'), '多一个字符');
  assert.ok(!match('a?c', 'a/bc'), '不跨 /');
});

test('. 是字面字符，不是通配', () => {
  assert.ok(match('a.js', 'a.js'), 'a.js');
  assert.ok(!match('a.js', 'aXjs'), 'a.js 不匹配 aXjs');
  assert.ok(match('aXjs', 'aXjs'), 'aXjs 只匹配 aXjs');
  assert.ok(!match('aXjs', 'a.js'), 'aXjs 不匹配 a.js');
});

test('字符类与花括号不展开，只按字面', () => {
  assert.ok(match('[ab].js', '[ab].js'), '字面文件名 [ab].js');
  assert.ok(!match('[ab].js', 'a.js'), '不匹配 a.js');
  assert.ok(!match('[ab].js', 'b.js'), '不匹配 b.js');
  assert.ok(match('{a,b}.js', '{a,b}.js'), '字面文件名 {a,b}.js');
  assert.ok(!match('{a,b}.js', 'a.js'), '不展开');
  assert.ok(!match('{a,b}.js', 'b.js'), '不展开');
});

test('正则元字符一律按字面（+ ( ) ^ $ | \\）', () => {
  assert.ok(match('a+b(c).js', 'a+b(c).js'), '字面匹配自身');
  assert.ok(!match('a+b(c).js', 'aXbYcZjs'), '不按正则语义');
  assert.ok(match('x^y$z', 'x^y$z'), '^ $ 字面');
  assert.ok(match('a\\b', 'a\\b'), '\\ 字面匹配自身');
  assert.ok(!match('a\\b', 'ab'), '\\ 不是转义');
  assert.ok(match('a|b', 'a|b'), '| 字面');
  assert.ok(!match('a|b', 'a'), '| 不是或');
});

test('整串匹配，不是包含', () => {
  assert.ok(!match('src', 'src/a.ts'), 'src 不匹配 src/a.ts');
  assert.ok(!match('*.ts', 'src/a.ts'), '*.ts 不匹配 src/a.ts');
  assert.ok(match('src/**', 'src/a.ts'), 'src/** 匹配 src/a.ts');
});

test('大小写：显式两种设置，不依赖运行平台', () => {
  assert.ok(match('src/App.ts', 'src/app.ts', ci), 'ci：glob 大写');
  assert.ok(match('src/app.ts', 'src/App.ts', ci), 'ci：文件大写');
  assert.ok(!match('src/App.ts', 'src/app.ts', cs), 'cs：不匹配');
  assert.ok(match('README.md', 'readme.md', ci), 'ci：README');
  assert.ok(!match('README.md', 'readme.md', cs), 'cs：README');
  assert.ok(matchesAny('src/app.ts', ['src/App.ts'], ci), 'matchesAny 透传 ci');
  assert.ok(!matchesAny('src/app.ts', ['src/App.ts'], cs), 'matchesAny 透传 cs');
});

test('中文与空格文件名', () => {
  assert.ok(match('docs/**/*.md', 'docs/文档.md'), '中文文件名');
  assert.ok(match('docs/**/*.md', 'docs/说明 文档.md'), '中文加空格');
  assert.ok(match('docs/**/*.md', 'docs/a/子目录/文 件.md'), '跨层中文加空格');
  assert.ok(match('*.txt', '说明.txt'), '中文名 *.txt');
  assert.ok(match('我的 文件.txt', '我的 文件.txt'), 'glob 含中文与空格');
  assert.ok(!match('*.txt', '子目录/说明.txt'), '*.txt 不跨层');
});

test('matchesAny：空列表为假，任一命中为真', () => {
  assert.equal(matchesAny('a/b.ts', [], cs), false, '空列表为假');
  assert.ok(matchesAny('a/b.ts', ['nope/**', '**/*.ts'], cs), '第二条命中');
  assert.ok(matchesAny('a/b.ts', ['**/*.ts', 'nope/**'], cs), '第一条命中即返回');
  assert.ok(!matchesAny('a/b.ts', ['nope/**', '**/*.js'], cs), '全不命中为假');
});

test('缓存：同一 glob 与大小写选项复用编译结果，结果不变', () => {
  const first = globToRegExp('src/**', cs);
  assert.equal(globToRegExp('src/**', cs), first, '重复编译返回同一 RegExp 实例');
  assert.notEqual(globToRegExp('src/**', ci), first, '大小写选项不同是不同缓存键');
  // 缓存命中后各文件的结果仍正确。
  assert.ok(matchesAny('src/a.ts', ['src/**'], cs));
  assert.ok(!matchesAny('SRC/a.ts', ['src/**'], cs));
  assert.ok(matchesAny('SRC/a.ts', ['src/**'], ci));
  assert.ok(matchesAny('src/a.ts', ['src/**'], cs), '再次调用结果不变');
  assert.ok(matchesAny('SRC/a.ts', ['src/**'], ci), '再次调用结果不变');
});

test('省略 options 时按平台默认，同大小写路径仍匹配', () => {
  assert.ok(globToRegExp('a/b.ts').test('a/b.ts'));
  assert.ok(matchesAny('中文/文件.md', ['**/*.md']));
});
