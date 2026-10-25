import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsScopeLine, parseNeedsScope, readNeedsScope } from '../../core/lib/needs-scope.mjs';

const doc = (...lines) => lines.join('\n');

test('有节：路径与原因，列表符号与反引号', () => {
  const list = parseNeedsScope(doc('# 汇报', '', '## 需要越界', '- `core/lib/gate.mjs`：要加参数', '* tests/a.test.mjs', '+ docs/x.md: 说明', '1. src/one.js：一', '2) src/two.js：二', ''));
  assert.deepEqual(list, [
    { path: 'core/lib/gate.mjs', reason: '要加参数' },
    { path: 'tests/a.test.mjs', reason: null },
    { path: 'docs/x.md', reason: '说明' },
    { path: 'src/one.js', reason: '一' },
    { path: 'src/two.js', reason: '二' },
  ]);
});

test('无节、空节、只写"无"都是空数组', () => {
  assert.deepEqual(parseNeedsScope('# 汇报\n\n没有越界。\n'), []);
  assert.deepEqual(parseNeedsScope('## 需要越界\n\n## 下一节\n- a.js\n'), []);
  assert.deepEqual(parseNeedsScope('## 需要越界\n无\n'), []);
  assert.deepEqual(parseNeedsScope('## 需要越界\n- 无。\n'), []);
  assert.deepEqual(parseNeedsScope('## 需要越界\n没有\n'), []);
  assert.deepEqual(parseNeedsScope(''), []);
  assert.deepEqual(parseNeedsScope(null), []);
});

// 101 改写：原断言 "### 需要越界" 与 "# 需要越界" 的节数为 0 → 新断言为 1。
// 原因：任务说明 101 要求标题认 1～6 级（094 的执行者写了 "### 10. 需要越界"，核心没认出来而多重试了一次）。
test('标题行恰好是"需要越界"（首尾空白不算），别的写法不算', () => {
  assert.equal(parseNeedsScope('  ## 需要越界  \n- a.js\n').length, 1);
  assert.equal(parseNeedsScope('## 需要越界（补充）\n- a.js\n').length, 0);
  assert.equal(parseNeedsScope('### 需要越界\n- a.js\n').length, 1);
  assert.equal(parseNeedsScope('# 需要越界\n- a.js\n').length, 1);
});

test('标题容忍层级、编号、反引号、加粗与结尾冒号', () => {
  const titles = [
    '## 需要越界', '### 10. 需要越界', '## 10、需要越界：', '## `需要越界`', '### **需要越界**',
    '# 需要越界', '###### 需要越界', '## 10) 需要越界', '## (10) 需要越界', '## （10）需要越界', '## 第 10 节 需要越界', '## 第10节需要越界',
    '## 需要越界:', '## **10. 需要越界：**', '## `10. 需要越界`', '## 10.需要越界', '## 需要越界 ##',
    '## `## 需要越界`', // 090 的写法：反引号里又写了一遍标题
  ];
  for (const title of titles) {
    assert.deepEqual(parseNeedsScope(`${title}\n- a.js：甲\n`), [{ path: 'a.js', reason: '甲' }], title);
  }
});

test('不是这一节的标题：别的文字、不是标题、围栏里的标题', () => {
  for (const title of ['## 需要越界的原因', '## 不需要越界', '## 需要越界（补充）', '## 10. 需要越界说明', '## 第 10 节 已知问题', '##需要越界', '####### 需要越界']) {
    assert.deepEqual(parseNeedsScope(`${title}\n- a.js\n`), [], title);
  }
  // 不带 # 的"需要越界"整行不是标题。
  assert.deepEqual(parseNeedsScope('需要越界\n- a.js\n'), []);
  assert.deepEqual(parseNeedsScope('10. 需要越界\n- a.js\n'), []);
  assert.deepEqual(parseNeedsScope('**需要越界**\n- a.js\n'), []);
  // 围栏代码块里的各种写法都不算。
  assert.deepEqual(parseNeedsScope(doc('```', '### 10. 需要越界', '- a.js', '```')), []);
});

test('这一节遇到层级不深于它的标题结束，更深的标题不结束', () => {
  // ### 开头：遇到 ###、##、# 结束，遇到 #### 不结束。
  assert.deepEqual(parseNeedsScope(doc('### 10. 需要越界', '- a.js', '#### 细节', '- b.js', '##### 更细', '- c.js')).map(item => item.path), ['a.js', 'b.js', 'c.js']);
  assert.deepEqual(parseNeedsScope(doc('### 10. 需要越界', '- a.js', '### 11. 已知问题', '- b.js')).map(item => item.path), ['a.js']);
  assert.deepEqual(parseNeedsScope(doc('### 10. 需要越界', '- a.js', '## 别的章', '- b.js')).map(item => item.path), ['a.js']);
  assert.deepEqual(parseNeedsScope(doc('### 10. 需要越界', '- a.js', '# 另一章', '- b.js')).map(item => item.path), ['a.js']);
  // ## 开头：遇到 ### 不结束。
  assert.deepEqual(parseNeedsScope(doc('## 需要越界', '- a.js', '### 子节', '- b.js', '## 下一节', '- c.js')).map(item => item.path), ['a.js', 'b.js']);
  // 结束后后面又有一节：继续收集；节内更深层级的同名标题不另起一节。
  assert.deepEqual(parseNeedsScope(doc('### 需要越界', '- a.js', '### 其他', '- x.js', '### 需要越界', '- b.js')).map(item => item.path), ['a.js', 'b.js']);
  assert.deepEqual(parseNeedsScope(doc('## 需要越界', '- a.js', '#### 需要越界', '- b.js', '### 子节', '- c.js', '## 结束', '- d.js')).map(item => item.path), ['a.js', 'b.js', 'c.js']);
  // 更深的标题行本身不当作路径。
  assert.deepEqual(parseNeedsScope(doc('### 需要越界', '#### - a.js', '- b.js')).map(item => item.path), ['b.js']);
});

test('代码块里的节标题与节内容不算', () => {
  assert.deepEqual(parseNeedsScope(doc('```markdown', '## 需要越界', '- a.js', '```', '')), []);
  assert.deepEqual(parseNeedsScope(doc('~~~', '## 需要越界', '- a.js', '~~~')), []);
  assert.deepEqual(parseNeedsScope(doc('````', '## 需要越界', '```', '- a.js', '````')), []);
  assert.deepEqual(parseNeedsScope(doc('## 需要越界', '- a.js', '```', '- b.js', '```', '- c.js')).map(item => item.path), ['a.js', 'c.js']);
  // 没有关闭的代码块一直到文末。
  assert.deepEqual(parseNeedsScope(doc('```', '## 需要越界', '- a.js')), []);
});

test('节后面还有别的一级、二级标题：到那里为止', () => {
  const list = parseNeedsScope(doc('## 需要越界', '- a.js：甲', '## 已知问题', '- b.js：乙'));
  assert.deepEqual(list, [{ path: 'a.js', reason: '甲' }]);
  assert.deepEqual(parseNeedsScope(doc('## 需要越界', '- a.js', '# 另一章', '- b.js')).map(item => item.path), ['a.js']);
});

test('三级及更深的标题属于这一节，但不当作路径', () => {
  const list = parseNeedsScope(doc('## 需要越界', '### 测试', '- a.js', '#### 更深', '- b.js'));
  assert.deepEqual(list.map(item => item.path), ['a.js', 'b.js']);
});

test('全角与半角冒号，第一次出现处切开', () => {
  assert.deepEqual(parseNeedsScope('## 需要越界\n- a.js：原因：还有\n- b.js: reason: more\n'), [
    { path: 'a.js', reason: '原因：还有' },
    { path: 'b.js', reason: 'reason: more' },
  ]);
  assert.deepEqual(parseNeedsScope('## 需要越界\n- a.js：\n- b.js:   \n'), [{ path: 'a.js', reason: null }, { path: 'b.js', reason: null }]);
});

test('路径为空的行不算', () => {
  assert.deepEqual(parseNeedsScope('## 需要越界\n- ：只有原因\n- `` ：空\n- ok.js\n'), [{ path: 'ok.js', reason: null }]);
});

test('Windows 盘符路径的冒号不当分隔符', () => {
  assert.deepEqual(parseNeedsScope('## 需要越界\n- C:\\work\\a.js：原因\n- `D:/work/b.js`: 说明\n- E:\\only.js\n'), [
    { path: 'C:\\work\\a.js', reason: '原因' },
    { path: 'D:/work/b.js', reason: '说明' },
    { path: 'E:\\only.js', reason: null },
  ]);
});

test('重复路径保留第一条', () => {
  const list = parseNeedsScope('## 需要越界\n- a.js：一\n- `a.js`：二\n- b.js\n');
  assert.deepEqual(list, [{ path: 'a.js', reason: '一' }, { path: 'b.js', reason: null }]);
});

test('超过 50 条只取前 50 条', () => {
  const lines = ['## 需要越界'];
  for (let i = 0; i < 80; i++) lines.push(`- f${i}.js：${i}`);
  const list = parseNeedsScope(lines.join('\n'));
  assert.equal(list.length, 50);
  assert.equal(list[0].path, 'f0.js');
  assert.equal(list[49].path, 'f49.js');
});

test('CRLF 换行', () => {
  assert.deepEqual(parseNeedsScope('## 需要越界\r\n- a.js：甲\r\n\r\n## 其他\r\n'), [{ path: 'a.js', reason: '甲' }]);
});

test('只认列表项：节末的一句说明不算路径（079 汇报里的原句）', () => {
  const note = '两项都不是我这次功能的缺陷，而是已有测试夹具与协议 12.4 新规则的冲突。';
  const list = parseNeedsScope(doc('## 需要越界', '- tests/integration/dispatch.test.mjs：夹具往用户目录根写文件', '- app/src/main/shots.ts：夹具往公共目录根写文件', '', note, ''));
  assert.deepEqual(list.map(item => item.path), ['tests/integration/dispatch.test.mjs', 'app/src/main/shots.ts']);
  // 只有说明、没有列表项：空节，不算。
  assert.deepEqual(parseNeedsScope(doc('## 需要越界', note, '')), []);
  assert.deepEqual(parseNeedsScope(doc('## 需要越界', '', 'core/lib/gate.mjs：没有列表符号的行也不算', '')), []);
});

test('列表项与说明混排：说明夹在列表项之间、缩进的列表项、列表符号后没有空白的行', () => {
  const list = parseNeedsScope(doc('## 需要越界', '先说明一下情况：下面是清单。', '- a.js：甲', '中间一句说明：不是路径', '1. b.js：乙', '  - c.js', '-d.js', '2) e.js', '最后一句。', ''));
  assert.deepEqual(list, [
    { path: 'a.js', reason: '甲' },
    { path: 'b.js', reason: '乙' },
    { path: 'c.js', reason: null },
    { path: 'e.js', reason: null },
  ]);
});

test('readNeedsScope：不合法就是 null', () => {
  assert.deepEqual(readNeedsScope([{ path: 'a.js', reason: null }, { path: 'b.js', reason: '乙' }]), [{ path: 'a.js', reason: null }, { path: 'b.js', reason: '乙' }]);
  for (const bad of [undefined, null, 'x', {}, [], [{ path: '', reason: null }], [{ path: 'a.js' }], [{ path: 1, reason: null }], [{ path: 'a.js', reason: 3 }], [null],
    Array.from({ length: 51 }, (_, i) => ({ path: `f${i}`, reason: null }))]) {
    assert.equal(readNeedsScope(bad), null, JSON.stringify(bad)?.slice(0, 40));
  }
});

test('needsScopeLine：前 5 个路径用"、"连接', () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ path: `p${i}`, reason: null }));
  assert.equal(needsScopeLine(list), '需要越界：执行者列出 7 个路径（p0、p1、p2、p3、p4），不再自动重试，等主导决定');
});
