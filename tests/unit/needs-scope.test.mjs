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

test('标题行恰好是"## 需要越界"（首尾空白不算），别的写法不算', () => {
  assert.equal(parseNeedsScope('  ## 需要越界  \n- a.js\n').length, 1);
  assert.equal(parseNeedsScope('## 需要越界（补充）\n- a.js\n').length, 0);
  assert.equal(parseNeedsScope('### 需要越界\n- a.js\n').length, 0);
  assert.equal(parseNeedsScope('# 需要越界\n- a.js\n').length, 0);
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
