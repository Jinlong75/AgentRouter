import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markdown, inline, esc, commitFrom } from '../../app/src/shared/markdown.ts';
import { reportRich, ev1, ev5, ev6 } from '../../tools/demo/data.mjs';

// 行内：代码、链接、强调、词内星号不下划线
test('行内语法：代码、链接、粗体、斜体、删除线', () => {
  assert.equal(inline('`a`'), '<code>a</code>');
  assert.equal(inline('**粗**'), '<strong>粗</strong>');
  assert.equal(inline('*斜*'), '<em>斜</em>');
  assert.equal(inline('~~删~~'), '<del>删</del>');
  assert.equal(inline('**粗** *斜* ~~删~~'), '<strong>粗</strong> <em>斜</em> <del>删</del>');
  assert.equal(inline('[文字](https://example.org/)'), '<a href="https://example.org/">文字</a>');
  assert.equal(inline('看 `[a]**b**` 这段'), '看 <code>[a]**b**</code> 这段');
  assert.equal(inline('**粗**和*斜*的组合'), '<strong>粗</strong>和<em>斜</em>的组合');
});

test('行内语法：词内星号与下划线不误判', () => {
  assert.equal(inline('a*b*c'), 'a*b*c');
  assert.equal(inline('snake_case'), 'snake_case');
  assert.equal(inline('_斜_'), '_斜_');
  assert.equal(inline('a**b**c'), 'a**b**c');
  assert.equal(inline('**'), '**');
  assert.equal(inline('* *'), '* *');
  assert.equal(inline('字**粗**字'), '字<strong>粗</strong>字');
});

test('行内语法：非法链接原样转义，HTML 只当文字', () => {
  assert.equal(inline('[bad](javascript:alert)'), '[bad](javascript:alert)');
  assert.equal(inline('[bad](ftp://example.org/)'), '[bad](ftp://example.org/)');
  assert.equal(inline('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(esc('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
});

// 块级：标题分级、段落
test('标题分级：#/## 用 h2，### 用 h3，#### 及以下用 h4', () => {
  assert.equal(markdown('# 标题'), '<h2>标题</h2>');
  assert.equal(markdown('## 二级'), '<h2>二级</h2>');
  assert.equal(markdown('### 三级'), '<h3>三级</h3>');
  assert.equal(markdown('#### 四级'), '<h4>四级</h4>');
  assert.equal(markdown('##### 五级'), '<h4>五级</h4>');
  assert.equal(markdown('## **粗**标题'), '<h2><strong>粗</strong>标题</h2>');
});

test('段落：连续行合成一段，行间用 br，空行分段', () => {
  assert.equal(markdown('a\nb'), '<p>a<br>b</p>');
  assert.equal(markdown('a\n\nb'), '<p>a</p><p>b</p>');
  assert.equal(markdown(''), '');
  assert.equal(markdown('\n\n'), '');
});

// 块级：表格
test('GFM 表格：表头 + 分隔行 + 数据行，对齐写入 class（界面 CSP 拦内联 style）', () => {
  assert.equal(
    markdown('| 甲 | 乙 |\n|:---|---:|\n| 1 | 2 |'),
    '<div class="md-table"><table><thead><tr><th>甲</th><th class="al-r">乙</th></tr></thead><tbody><tr><td>1</td><td class="al-r">2</td></tr></tbody></table></div>');
  assert.equal(
    markdown('| 中 |\n|:---:|\n| x |'),
    '<div class="md-table"><table><thead><tr><th class="al-c">中</th></tr></thead><tbody><tr><td class="al-c">x</td></tr></tbody></table></div>');
});

test('GFM 表格：单元格行内语法、\\| 是字面竖线、行数不足补空格', () => {
  assert.equal(
    markdown('| **粗** | 代码 |\n|---|---|\n| `a\\|b` | [t](https://example.org/) |'),
    '<div class="md-table"><table><thead><tr><th><strong>粗</strong></th><th>代码</th></tr></thead><tbody><tr><td><code>a|b</code></td><td><a href="https://example.org/">t</a></td></tr></tbody></table></div>');
  assert.equal(
    markdown('| 甲 | 乙 |\n|---|---|\n| 1 |'),
    '<div class="md-table"><table><thead><tr><th>甲</th><th>乙</th></tr></thead><tbody><tr><td>1</td><td></td></tr></tbody></table></div>');
});

test('没有分隔行的竖线行按普通段落处理，表格分隔行不当分隔线', () => {
  assert.equal(markdown('| a | b |\n| c | d |'), '<p>| a | b |<br>| c | d |</p>');
  assert.equal(markdown('a | b'), '<p>a | b</p>');
  assert.ok(markdown('| 甲 |\n|---|\n| 1 |').includes('<table>'));
  assert.ok(!markdown('| 甲 |\n|---|\n| 1 |').includes('<hr>'));
});

// 块级：引用、分隔线
test('引用：多行合并，可含列表与行内语法', () => {
  assert.equal(markdown('> 引用\n> 第二'), '<blockquote><p>引用<br>第二</p></blockquote>');
  assert.equal(markdown('> - a\n> - b'), '<blockquote><ul><li>a</li><li>b</li></ul></blockquote>');
  assert.equal(markdown('> **粗**引用'), '<blockquote><p><strong>粗</strong>引用</p></blockquote>');
});

test('分隔线：单独一行的 --- / *** / ___', () => {
  assert.equal(markdown('---'), '<hr>');
  assert.equal(markdown('***'), '<hr>');
  assert.equal(markdown('___'), '<hr>');
  assert.equal(markdown('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
  assert.equal(markdown('a\n---'), '<p>a</p><hr>');
});

// 块级：列表
test('嵌套列表：缩进 2 空格或 1 Tab 为一级', () => {
  assert.equal(markdown('- a\n  - b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  assert.equal(markdown('- a\n\t- b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  assert.equal(markdown('1. a\n   1. b\n2. c'), '<ol><li>a<ol><li>b</li></ol></li><li>c</li></ol>');
  assert.equal(markdown('- a\n  1. b'), '<ul><li>a<ol><li>b</li></ol></li></ul>');
});

test('有序列表保留起始编号，同层换标记断开成相邻列表', () => {
  assert.equal(markdown('3. x\n4. y'), '<ol start="3"><li>x</li><li>y</li></ol>');
  assert.equal(markdown('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
});

test('任务列表显示为不可点的勾选标记，不用 input', () => {
  assert.equal(
    markdown('- [ ] p\n- [x] q'),
    '<ul><li class="task"><span class="md-check">☐</span> p</li><li class="task"><span class="md-check on">☑</span> q</li></ul>');
  const html = markdown('- [ ] p');
  assert.ok(!html.includes('<input'));
  assert.equal(markdown('- [x]done'), '<ul><li>[x]done</li></ul>');
});

// 块级：代码块
test('围栏代码块：带语言标记不显示语言名，内容逐字转义', () => {
  assert.equal(markdown('```js\nconst a = 1;\n```'), '<pre class="out scroll">const a = 1;</pre>');
  assert.equal(markdown('```\n<b>x</b>\n```'), '<pre class="out scroll">&lt;b&gt;x&lt;/b&gt;</pre>');
  assert.equal(markdown('`a` 与\n\n```\nx\n```'), '<p><code>a</code> 与</p><pre class="out scroll">x</pre>');
});

// 高亮段落
test('TODO / 推断清单高亮段落按原规则对各级标题生效', () => {
  assert.equal(markdown('## TODO(lead) 1 条\n- 待定'), '<section class="hl brand"><h2>TODO(lead) 1 条</h2><ul><li>待定</li></ul></section>');
  assert.equal(markdown('# 推断清单\n1. 一项'), '<section class="hl brand"><h2>推断清单</h2><ol><li>一项</li></ol></section>');
  assert.equal(markdown('#### 1. TODO(design) 1 条\n\n正文'), '<section class="hl brand"><h4>1. TODO(design) 1 条</h4><p>正文</p></section>');
  assert.equal((markdown('## TODO(lead) 1 条\n- 待定\n## 已知问题\n无').match(/class="hl brand"/g) ?? []).length, 1);
  // 018 改写：原检查是「## TODO(lead)\n## 推断清单」两节都空也各包一层高亮（2 个 hl brand）；
  // 新规则下空节不高亮，这里给两节各一条列表项，仍然检查"相邻两节各自包一层高亮"。
  assert.equal((markdown('## TODO(lead)\n- 一条\n## 推断清单\n- 另一条').match(/class="hl brand"/g) ?? []).length, 2);
  assert.ok(!markdown('## TODO(lead)\n- 待定').includes('</section><section'));
  assert.equal(markdown('## 待办\n- TODO(lead) 里的普通文字'), '<h2>待办</h2><ul><li>TODO(lead) 里的普通文字</li></ul>');
});

// 018：内容为空或只是"无 / None / N/A"时照常排版但不高亮
test('TODO / 推断清单一节没有实际内容时不高亮', () => {
  for (const body of ['无。', '无', 'None', 'N/A', 'none.', 'n/a。', '  无。  ', '', '\n\n', ' \t ']) {
    assert.ok(!markdown(`## TODO(lead)\n${body}`).includes('hl brand'), `TODO(lead) 内容 ${JSON.stringify(body)} 不该高亮`);
    assert.ok(!markdown(`## 推断清单\n${body}`).includes('hl brand'), `推断清单 内容 ${JSON.stringify(body)} 不该高亮`);
    assert.ok(!markdown(`#### 1. TODO(design)\n${body}`).includes('hl brand'), `TODO(design) 内容 ${JSON.stringify(body)} 不该高亮`);
    assert.ok(markdown(`## TODO(lead)\n${body}`).includes('<h2>TODO(lead)</h2>'), '不高亮时照常排版');
  }
  // 有一条列表项时照旧高亮。
  assert.ok(markdown('## TODO(lead)\n- 一条').includes('hl brand'));
  assert.ok(markdown('## 推断清单\n1. 一项').includes('hl brand'));
  // 两节一节"无"一节有内容时各自正确：只有有内容的一节高亮（高亮节包住自己的标题，按标题前有没有节标签判断）。
  const both = markdown('## TODO(lead)\n无。\n## 推断清单\n1. 有内容');
  assert.equal((both.match(/class="hl brand"/g) ?? []).length, 1);
  assert.ok(both.includes('<h2>TODO(lead)</h2>') && !both.includes('<section class="hl brand"><h2>TODO(lead)'), '内容为"无"的 TODO(lead) 不高亮');
  assert.ok(both.includes('<section class="hl brand"><h2>推断清单</h2>'), '有内容的推断清单高亮');
  const flipped = markdown('## TODO(lead)\n- 有内容\n## 推断清单\n无');
  assert.equal((flipped.match(/class="hl brand"/g) ?? []).length, 1);
  assert.ok(flipped.includes('<section class="hl brand"><h2>TODO(lead)</h2>'), '有内容的 TODO(lead) 高亮');
  assert.ok(flipped.includes('<h2>推断清单</h2>') && !flipped.includes('<section class="hl brand"><h2>推断清单'), '内容为"无"的推断清单不高亮');
  // 正文到下一个同级或更高级标题为止：同级 / 更高级标题终止这一节，更低级标题的内容属于这一节。
  assert.ok(!markdown('# TODO(lead)\n无。\n# 小节\n- 正文').includes('hl brand'), '同级标题终止这一节');
  assert.ok(!markdown('## TODO(lead)\n无。\n# 更高级\n- 正文').includes('hl brand'), '更高级标题终止这一节');
  assert.ok(markdown('## TODO(lead)\n无。\n### 小节\n- 正文').includes('hl brand'), '更低级标题的内容属于这一节，要高亮');
});

// 安全
test('HTML 注入全部被转义或丢弃，只允许 http(s) 链接', () => {
  for (const evil of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<b onclick=x>bold</b>']) {
    const html = markdown(evil);
    assert.ok(!html.includes('<script>'), evil);
    assert.ok(!html.includes('<img'), evil);
    assert.ok(!html.includes('<b '), evil);
  }
  assert.ok(markdown('<b onclick=x>bold</b>').includes('&lt;b onclick=x&gt;bold&lt;/b&gt;'));
  const html = markdown('[bad](javascript:alert)\n[ok](https://example.org/)');
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('href="https://example.org/"'));
  assert.ok(!markdown('| <b>x</b> |\n|---|').includes('<b>'));
  assert.ok(!markdown('> <script>x</script>').includes('<script>'));
  assert.ok(!markdown('```\n<script>x</script>\n```').includes('<script>'));
  assert.equal(markdown('```html\n<img src=x onerror=alert(1)>\n```'), '<pre class="out scroll">&lt;img src=x onerror=alert(1)&gt;</pre>');
});

test('提交号解析沿用原规则', () => {
  assert.equal(commitFrom('`123456` `4f2a9c1` `b81e0d2`'), '4f2a9c1');
  assert.equal(commitFrom('`1234567890123`'), undefined);
});

test('综合排版：汇报样例', () => {
  const report = [
    '# 完成了什么',
    '',
    '**加粗** 的结论，参考 [文档](https://example.org/)。',
    '',
    '## 验证',
    '',
    '| 命令 | 结果 |',
    '|:---|:---:|',
    '| `npm test` | 46/46 |',
    '',
    '- 第一层',
    '  - 第二层',
    '  - [x] 已完成',
    '  - [ ] 待办',
    '',
    '> 引用里带 *斜体*',
    '',
    '---',
    '',
    '```ts',
    'const a = 1;',
    '```',
  ].join('\n');
  const html = markdown(report);
  assert.ok(html.startsWith('<h2>完成了什么</h2><p><strong>加粗</strong> 的结论，参考 <a href="https://example.org/">文档</a>。</p>'));
  assert.ok(html.includes('<div class="md-table"><table><thead><tr><th>命令</th><th class="al-c">结果</th></tr></thead><tbody><tr><td><code>npm test</code></td><td class="al-c">46/46</td></tr></tbody></table></div>'));
  assert.ok(html.includes('<ul><li>第一层<ul><li>第二层</li><li class="task"><span class="md-check on">☑</span> 已完成</li><li class="task"><span class="md-check">☐</span> 待办</li></ul></li></ul>'));
  assert.ok(html.includes('<blockquote><p>引用里带 <em>斜体</em></p></blockquote>'));
  assert.ok(html.includes('<hr>'));
  assert.ok(html.includes('<pre class="out scroll">const a = 1;</pre>'));
  assert.ok(!html.includes('**'));
  assert.ok(!html.includes('|---'));
});

test('任务说明开头的 YAML 头显示成代码块，正文照常排版；不在开头的 --- 仍是分隔线', () => {
  assert.equal(markdown('---\nid: 002\ntitle: <b>x</b>\n---\n\n## 目标\n\n做完'),
    '<pre class="out scroll md-front">id: 002\ntitle: &lt;b&gt;x&lt;/b&gt;</pre><h2>目标</h2><p>做完</p>');
  assert.ok(!markdown('---\n只有开头，没有结束').includes('md-front'));
  assert.ok(markdown('段落\n\n---\n\n下一段').includes('<hr>'));
});

// 015：粗体里含行内代码或链接时正常配对（占位符先遮住代码与链接，再对整行配对）。
test('行内语法：粗体里含行内代码或链接时正常配对', () => {
  assert.equal(inline('**3. 两个进程同时 `spec new` 不撞号靠什么保证**'),
    '<strong>3. 两个进程同时 <code>spec new</code> 不撞号靠什么保证</strong>');
  assert.equal(inline('**移除旧 UI09 的 `x` 断言**'),
    '<strong>移除旧 UI09 的 <code>x</code> 断言</strong>');
  assert.equal(inline('**`a` 和 `b`**'),
    '<strong><code>a</code> 和 <code>b</code></strong>');
  assert.equal(inline('`x` **粗** `y`'),
    '<code>x</code> <strong>粗</strong> <code>y</code>');
  // 代码里的星号不参与配对：外层 ** 仍然成对。
  assert.equal(inline('**a `**` b**'), '<strong>a <code>**</code> b</strong>');
  assert.equal(inline('**见 [文档](https://example.com)**'),
    '<strong>见 <a href="https://example.com">文档</a></strong>');
});

// 015：演示数据里的汇报与"说话"渲染后，可见文字里不再有字面的 **（代码块与行内代码里的除外）。
test('演示数据：汇报与说话渲染后的正文里没有字面的 **', () => {
  // 生成器把 <code>…</code> 转成行内代码再写进事件，这里同样转换后再渲染。
  const asSay = text => String(text).replace(/<code>(.*?)<\/code>/g, '`$1`');
  const sources = [['汇报 reportRich', reportRich]];
  for (const [label, events] of [['ev1', ev1], ['ev5', ev5], ['ev6', ev6]])
    for (const e of events)
      if (e[1] === 'say') sources.push([`${label} 说话`, asSay(e[2])]);
  // 生成器（tools/demo/index.mjs）里写死的汇报与"说话"文本：扫源码里的字符串字面量，
  // 含 ** 的逐条渲染检查；唯一豁免是项目配置的 allowedPaths 通配符 '**'，它不是文本。
  const generator = readFileSync(new URL('../../tools/demo/index.mjs', import.meta.url), 'utf8');
  for (const m of generator.matchAll(/(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    const lit = m[2];
    if (!lit.includes('**') || lit === '**') continue;
    sources.push([`index.mjs 字面量 ${m[0].slice(0, 40)}`, lit]);
  }
  for (const [label, text] of sources) {
    // 可见文字 = 渲染结果去掉代码块、行内代码的内容，再剥标签。
    const visible = markdown(text)
      .replace(/<pre[\s\S]*?<\/pre>/g, '')
      .replace(/<code>[\s\S]*?<\/code>/g, '')
      .replace(/<[^>]+>/g, '');
    assert.ok(!visible.includes('**'), `${label} 渲染后仍有 **：${visible}`);
  }
});
