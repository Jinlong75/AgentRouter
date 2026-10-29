import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFF_LIMIT, REPORT_LIMIT, parseReview, reviewPrompt } from '../../core/lib/review.mjs';

const block = value => `\`\`\`json\n${typeof value === 'string' ? value : JSON.stringify(value)}\n\`\`\``;
const good = { verdict: 'concerns', summary: '功能完成', reviewed: ['src/a.js'], issues: [{ severity: 'high', file: 'src/a.js', line: 3, title: '边界', detail: '没处理空输入' }] };

test('parseReview：正常结论，字段齐全，问题带编号和空确认', () => {
  const r = parseReview(`先分析一大段。\n\n${block(good)}\n`, { attempt: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'concerns');
  assert.equal(r.summary, '功能完成');
  assert.deepEqual(r.reviewed, ['src/a.js']);
  assert.deepEqual(r.issues, [{ id: 'R2-1', severity: 'high', file: 'src/a.js', line: 3, title: '边界', detail: '没处理空输入', confirmation: null }]);
  assert.deepEqual(r.warnings, []);
});

test('parseReview：多个代码块取最后一个；CRLF 换行也能解析', () => {
  const first = block({ verdict: 'fail', summary: '旧', reviewed: ['x'], issues: [] });
  const r = parseReview(`${first}\n又想了想\n${block(good)}`);
  assert.equal(r.verdict, 'concerns');
  assert.equal(r.summary, '功能完成');
  const crlf = parseReview(`分析\r\n\`\`\`json\r\n${JSON.stringify(good)}\r\n\`\`\`\r\n`);
  assert.equal(crlf.ok, true);
  assert.equal(crlf.verdict, 'concerns');
});

test('parseReview：非法 severity 按 medium 处理并记 warning；编号按保留下来的顺序 R2-1、R2-2', () => {
  const r = parseReview(block({ ...good, issues: [
    { severity: 'catastrophic', file: 'a', title: 't1' },
    { severity: 'low', file: 'b', title: 't2' },
    'not an object',
    { file: 'c', title: 't3' },
  ] }), { attempt: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues.map(i => [i.id, i.severity]), [['R2-1', 'medium'], ['R2-2', 'low'], ['R2-3', 'medium']]);
  assert.equal(r.warnings.length, 3);
  assert.match(r.warnings[0], /第 1 条问题的 severity 非法/);
  assert.match(r.warnings[1], /第 3 条问题不是对象/);
  assert.match(r.warnings[2], /第 4 条问题的 severity 非法/);
});

test('parseReview：file 的反斜杠换成斜杠；line 只认整数；字段截断', () => {
  const r = parseReview(block({
    verdict: 'concerns', summary: 's'.repeat(400), reviewed: ['src\\a.js', '', 5],
    issues: [
      { severity: 'low', file: 'src\\deep\\a.js', line: 3.5, title: 't'.repeat(300), detail: 'd'.repeat(3000) },
      { severity: 'low', file: 'b.js', line: '7', title: 'x', detail: 'y' },
      { severity: 'low', title: 'no file', line: 12 },
    ],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.summary.length, 300);
  assert.deepEqual(r.reviewed, ['src/a.js']);
  assert.equal(r.issues[0].file, 'src/deep/a.js');
  assert.equal(r.issues[0].line, null, '小数不是整数');
  assert.equal(r.issues[0].title.length, 200);
  assert.equal(r.issues[0].detail.length, 2000);
  assert.equal(r.issues[1].line, null, '字符串行号不算');
  assert.equal(r.issues[2].file, '');
  assert.equal(r.issues[2].line, 12);
});

test('parseReview：问题最多 50 条，超出的丢掉并记 warning', () => {
  const issues = Array.from({ length: 60 }, (_, i) => ({ severity: 'low', file: 'a', title: `t${i}` }));
  const r = parseReview(block({ ...good, issues }));
  assert.equal(r.issues.length, 50);
  assert.equal(r.issues.at(-1).id, 'R1-50');
  assert.ok(r.warnings.some(w => /超过 50 条/.test(w)));
});

test('parseReview：issues 不是数组按空处理并记 warning（verdict 合法就不算失败）', () => {
  const r = parseReview(block({ verdict: 'concerns', summary: 's', reviewed: ['a'], issues: 'none' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  assert.match(r.warnings[0], /issues 不是数组/);
});

test('完成判定：verdict 非法 → 这次审查失败', () => {
  for (const verdict of ['ok', 'PASS', '', null, 1, undefined]) {
    const r = parseReview(block({ ...good, verdict }));
    assert.equal(r.ok, false, String(verdict));
    assert.match(r.why, /verdict 非法/);
  }
});

test('完成判定：没有代码块 / 坏 JSON / JSON 不是对象 → 失败，why 各不相同', () => {
  assert.match(parseReview('整体不错，没有问题。').why, /没有 json 代码块/);
  assert.match(parseReview('```\n{"verdict":"pass"}\n```').why, /没有 json 代码块/, '没写 json 标记的代码块不算');
  assert.match(parseReview(block('{"verdict": "pass", ')).why, /无法解析/);
  assert.match(parseReview(block('[1, 2]')).why, /不是对象/);
  assert.match(parseReview(block('"pass"')).why, /不是对象/);
});

test('完成判定：pass 且没有问题、reviewed 为空 → 失败；有 reviewed 或有问题就通过', () => {
  const empty = parseReview(block({ verdict: 'pass', summary: '没有发现问题', reviewed: [], issues: [] }));
  assert.equal(empty.ok, false);
  assert.match(empty.why, /reviewed 为空/);
  assert.equal(parseReview(block({ verdict: 'pass', summary: 's', issues: [] })).ok, false, '没有 reviewed 字段同样算空');
  assert.equal(parseReview(block({ verdict: 'pass', summary: 's', reviewed: ['a.js'], issues: [] })).ok, true);
  assert.equal(parseReview(block({ verdict: 'fail', summary: 's', reviewed: [], issues: [{ severity: 'high', title: 't' }] })).ok, true);
});

test('完成判定：正文只有"被阻塞 / 无法读取 / blocked / cannot read"而没有结论 → 失败', () => {
  for (const body of ['被阻塞：沙箱不让读文件', '我无法读取这些文件，所以没法审查。', 'The review is blocked by the sandbox.', 'I cannot read the repository.', '']) {
    const r = parseReview(body);
    assert.equal(r.ok, false, body);
    if (body) assert.match(r.why, /被阻塞或无法读取/, body);
    else assert.match(r.why, /空的/);
  }
});

test('reviewPrompt：六个占位符替换，别的花括号原样保留，替换内容里的占位符不再展开', () => {
  const prompt = reviewPrompt({
    specText: '任务说明正文 {{diff}} 不展开', report: '汇报正文', diff: 'diff --git a/x b/x\n+新增', base: 'aaa111', head: 'bbb222',
    gate: { ok: true, summary: '门禁通过', commands: [{ line: 'npm test', exit: 0 }, { line: 'npm run lint', exit: 1 }, { line: 'slow', timedOut: true }] },
  });
  assert.ok(prompt.includes('任务说明正文 {{diff}} 不展开'));
  assert.ok(prompt.includes('汇报正文'));
  assert.ok(prompt.includes('## 改动（git diff aaa111..bbb222）'));
  assert.ok(prompt.includes('diff --git a/x b/x\n+新增'));
  assert.ok(prompt.includes('门禁通过：门禁通过'));
  assert.ok(prompt.includes('- npm test → 通过') && prompt.includes('- npm run lint → exit 1') && prompt.includes('- slow → 超时'));
  assert.ok(prompt.includes('{"verdict": "pass | concerns | fail",'), '模板里 JSON 示例的花括号原样保留');
  assert.ok(!/\{\{(report|gate|base|head)\}\}/.test(prompt));
});

test('reviewPrompt：汇报超过 8KB 截断；差异超过 60KB 换成文件清单', () => {
  const longReport = '汇'.repeat(REPORT_LIMIT);
  const prompt = reviewPrompt({ specText: 's', report: longReport, diff: 'x'.repeat(DIFF_LIMIT + 1), files: [{ path: 'src/a.js', added: 10, deleted: 2 }, { path: 'img.png', added: '?', deleted: '?' }], base: 'a', head: 'b' });
  assert.ok(prompt.includes('已截断'));
  assert.ok(!prompt.includes(longReport));
  assert.ok(prompt.includes('改动太大') && prompt.includes('只列文件清单'));
  assert.ok(prompt.includes('- src/a.js（+10 −2）') && prompt.includes('- img.png（+? −?）'));
  assert.ok(prompt.includes('请自己阅读这些文件'));
  assert.ok(!prompt.includes('x'.repeat(100)), '原差异不再放进指令');
  const small = reviewPrompt({ specText: 's', report: 'r', diff: 'x'.repeat(DIFF_LIMIT), base: 'a', head: 'b' });
  assert.ok(small.includes('x'.repeat(DIFF_LIMIT)), '正好 60KB 不算超出');
});

test('reviewPrompt：没有差异、没有门禁信息也能组装', () => {
  const prompt = reviewPrompt({ specText: 's', report: 'r', diff: '', gate: null, base: 'a', head: 'a' });
  assert.ok(prompt.includes('（没有改动）'));
  assert.ok(prompt.includes('（没有运行门禁）'));
});

test('parseReview：JSON 里的非法反斜杠转义（正则、Windows 路径）按字面反斜杠处理并记 warning', () => {
  const r = parseReview(block(String.raw`{"verdict":"concerns","summary":"s","reviewed":["src/a.js"],"issues":[{"severity":"low","file":"src/a.js","title":"t","detail":"正则 /^[\w.-]+$/ 与 \d，路径 src\main.mjs"}]}`));
  assert.equal(r.ok, true);
  assert.equal(r.issues[0].detail, String.raw`正则 /^[\w.-]+$/ 与 \d，路径 src\main.mjs`);
  assert.deepEqual(r.warnings, ['结论 json 里有非法的反斜杠转义，已按字面反斜杠处理']);
});

test('parseReview：合法转义（\\n、\\"、\\\\、\\u4e2d）不受修正影响，和非法转义混用时各按各的', () => {
  const r = parseReview(block(String.raw`{"verdict":"concerns","summary":"s","reviewed":["a"],"issues":[{"severity":"low","file":"a","title":"t","detail":"行1\n行2 \"引号\" 反斜杠\\ 中中 正则\w"}]}`));
  assert.equal(r.ok, true);
  assert.equal(r.issues[0].detail, '行1\n行2 "引号" 反斜杠\\ 中中 正则\\w');
  // 全是合法转义时不产生 warning
  const clean = parseReview(block(String.raw`{"verdict":"concerns","summary":"a\nb","reviewed":["a"],"issues":[]}`));
  assert.equal(clean.summary, 'a\nb');
  assert.deepEqual(clean.warnings, []);
});

test('parseReview：修正后仍是坏 JSON 照旧失败，why 是第一次的错误', () => {
  const bad = String.raw`{"verdict":"concerns","summary":"正则 \w","reviewed":["a"],"issues":[]`;
  let original;
  try { JSON.parse(bad); } catch (error) { original = error.message; }
  const r = parseReview(block(bad));
  assert.equal(r.ok, false);
  assert.equal(r.why, `结论的 json 无法解析：${original}`);
});
