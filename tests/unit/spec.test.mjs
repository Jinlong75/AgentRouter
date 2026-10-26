import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSpec, validateSpec, mergeSpec, SPEC_TYPES, SpecError } from '../../core/lib/spec.mjs';

const FILE = '测试.md';

// 解析 + 校验都成功时返回两者；失败就抛 SpecError。
function read(text, file = FILE) {
  const parsed = parseSpec(text, file);
  return { parsed, spec: validateSpec(parsed, file) };
}

// 断言解析（或校验）失败，并检查行号与消息里的原因。
function fails(text, { line, match, file = FILE, validate = false } = {}) {
  assert.throws(() => {
    const parsed = parseSpec(text, file);
    if (validate) validateSpec(parsed, file);
  }, error => {
    assert.ok(error instanceof SpecError, `应抛 SpecError，实际：${error && error.message}`);
    if (line !== undefined) assert.equal(error.line, line, error.message);
    if (match) assert.match(error.message, match);
    assert.match(error.message, new RegExp(`^${file} 第 \\d+ 行：`), '消息形如“<文件> 第 <n> 行：<原因>”');
    return true;
  });
}

// 协议第 11.1 节的示例（标题里的引号是原样内容，不是引号写法）。
const FULL = `---
id: 012
title: 给登录页加"记住我"
type: code
worker: auto
allowed_paths:
  - src/auth/**
  - tests/auth/**
verify:
  - npm test -- tests/auth
  - npx tsc --noEmit
expect_commit: true
verify_timeout_min: 10
---

## 目标

## 范围 / 不做什么

## 参照

## 验收标准

## 汇报要回答的问题
`;

test('完整示例：meta、body、行号、无警告', () => {
  const { meta, body, lines, warnings } = parseSpec(FULL);
  assert.deepEqual(meta, {
    id: '012',
    title: '给登录页加"记住我"',
    type: 'code',
    worker: 'auto',
    allowed_paths: ['src/auth/**', 'tests/auth/**'],
    verify: ['npm test -- tests/auth', 'npx tsc --noEmit'],
    expect_commit: true,
    verify_timeout_min: '10',
  });
  assert.deepEqual(lines, {
    id: 2, title: 3, type: 4, worker: 5, allowed_paths: 6, verify: 9, expect_commit: 12, verify_timeout_min: 13,
  });
  assert.deepEqual(warnings, []);
  assert.ok(body.startsWith('\n## 目标'), body);
});

test('完整示例：validateSpec 规范化类型与整数', () => {
  const { spec } = read(FULL);
  assert.equal(spec.id, '012', 'id 保留原文（字符串）');
  assert.equal(spec.type, 'code');
  assert.equal(spec.expect_commit, true);
  assert.equal(spec.verify_timeout_min, 10, '整数字段转成 Number');
  assert.equal(spec.timeout_min, undefined, '没写的字段是 undefined');
  assert.deepEqual(spec.allowed_paths, ['src/auth/**', 'tests/auth/**']);
});

test('没有 frontmatter：meta 为空、body 是原文', () => {
  const text = '# 标题\n\n正文\n';
  const parsed = parseSpec(text);
  assert.deepEqual(parsed.meta, {});
  assert.equal(parsed.body, text);
  assert.deepEqual(parsed.lines, {});
  assert.deepEqual(parsed.warnings, []);
  assert.equal(validateSpec(parsed).title, undefined);
});

test('只有一对 ---：空 frontmatter、空正文', () => {
  assert.deepEqual(parseSpec('---\n---\n'), { meta: {}, body: '', lines: {}, warnings: [] });
  assert.deepEqual(parseSpec('---\n---'), { meta: {}, body: '', lines: {}, warnings: [] });
});

test('空列表：key: [] 与 key: 后没有项都读成空数组', () => {
  const { spec } = read('---\nallowed_paths: []\nverify:\n---\n');
  assert.deepEqual(spec.allowed_paths, []);
  assert.deepEqual(spec.verify, []);
});

test('列表项：直接值、双引号、单引号逐个解析', () => {
  const { parsed } = read(`---
allowed_paths:
  - src/a b/**
  - "src/c d/**"
  - 'src/it''s/**'
verify:
  - 'echo "hi"'
---
`);
  assert.deepEqual(parsed.meta.allowed_paths, ['src/a b/**', 'src/c d/**', "src/it's/**"]);
  assert.deepEqual(parsed.meta.verify, ['echo "hi"']);
});

test('双引号：JSON 转义（引号、反斜杠、换行、中文）', () => {
  const text = '---\ntitle: "引号 \\" 反斜杠 \\\\ 换行 \\n 中文"\n---\n';
  const { parsed } = read(text);
  assert.equal(parsed.meta.title, '引号 " 反斜杠 \\ 换行 \n 中文');
});

test('单引号：两个单引号表示一个单引号', () => {
  const { parsed } = read("---\ntitle: 'it''s'\n---\n");
  assert.equal(parsed.meta.title, "it's");
});

test('注释：整行注释、行尾注释；引号里的 # 不是注释', () => {
  const { parsed } = read(`---
# 整行注释
id: 001 # 行尾注释
title: "含 # 井号的标题" # 注释
worker: a#b
---
`);
  assert.equal(parsed.meta.id, '001');
  assert.equal(parsed.meta.title, '含 # 井号的标题');
  assert.equal(parsed.meta.worker, 'a#b', '前面没有空白的 # 是内容');
});

test('id 保留原文；true / false 读成布尔', () => {
  const { spec } = read('---\nid: 031\nexpect_commit: true\nreview: false\n---\n');
  assert.equal(spec.id, '031');
  assert.equal(spec.expect_commit, true);
  assert.equal(spec.review, false);
});

test('\\r\\n 换行也能解析', () => {
  const { parsed, spec } = read('---\r\nid: 001\r\ntitle: 甲\r\n---\r\n\r\n正文\r\n');
  assert.equal(parsed.meta.title, '甲');
  assert.equal(spec.id, '001');
  assert.match(parsed.body, /正文/);
});

test('BOM 忽略（有与没有 frontmatter 都算）', () => {
  assert.equal(parseSpec('\ufeff---\nid: 1\n---\n').meta.id, '1');
  assert.equal(parseSpec('\ufeff# 标题').body, '# 标题');
});

test('不认识的字段只警告，不报错；警告带行号', () => {
  const { parsed, spec } = read('---\nid: 1\ntitle: 甲\nfoo: bar\n---\n');
  assert.deepEqual(parsed.warnings, ['第 4 行：不认识的字段 foo（忽略）']);
  assert.equal(spec.title, '甲', '未知字段不影响已知字段');
});

test('缺少结束的 ---：第 1 行报错', () => {
  fails('---\nid: 1\n', { line: 1, match: /缺少结束/ });
});

test('字段重复：报第二次出现的行号', () => {
  fails('---\nid: 1\nid: 2\n---\n', { line: 3, match: /字段重复/ });
});

test('列表项前面没有字段名', () => {
  fails('---\n  - a\n---\n', { line: 2, match: /列表项前面没有字段名/ });
});

test('内联数组 [a, b] 报错', () => {
  fails('---\nverify: [a, b]\n---\n', { line: 2, match: /内联数组/ });
});

test('内联对象 {} 报错', () => {
  fails('---\nverify: {}\n---\n', { line: 2, match: /内联对象/ });
});

test('多行字符串 | 与 > 报错', () => {
  fails('---\nverify: |\n---\n', { line: 2, match: /多行字符串/ });
  fails('---\nverify: >\n---\n', { line: 2, match: /多行字符串/ });
});

test('冒号后没有空格（key:value）报错', () => {
  fails('---\nid:1\n---\n', { line: 2, match: /冒号后需要一个空格/ });
});

test('大写字段名报错', () => {
  fails('---\nTitle: 甲\n---\n', { line: 2, match: /小写字母与下划线/ });
});

test('引号没有闭合：双引号与单引号', () => {
  fails('---\ntitle: "甲\n---\n', { line: 2, match: /引号没有闭合/ });
  fails("---\ntitle: '甲\n---\n", { line: 2, match: /引号没有闭合/ });
});

test('type 不在允许的取值里', () => {
  fails('---\nid: 1\ntitle: 甲\ntype: banana\n---\n', { line: 4, match: /type 只能是/, validate: true });
});

test('expect_commit 只能是布尔', () => {
  fails('---\nid: 1\nexpect_commit: yes\n---\n', { line: 3, match: /true 或 false/, validate: true });
});

test('timeout_min 必须是正整数（0、-1、1.5）', () => {
  for (const value of ['0', '-1', '1.5']) {
    fails(`---\nid: 1\ntimeout_min: ${value}\n---\n`, { line: 3, match: /timeout_min .*正整数/, validate: true });
  }
});

test('max_retries 必须是非负整数', () => {
  fails('---\nid: 1\nmax_retries: -1\n---\n', { line: 3, match: /max_retries .*非负整数/, validate: true });
});

test('allowed_paths 的写法校验', () => {
  const cases = [
    ['a\\b', /反斜杠/],
    ['/abs/path', /以 \/ 开头/],
    ['src/../secret', /\.\. 段/],
    ['C:/secret', /盘符/],
    ['./src', /\. 或 \.\. 段/],
  ];
  for (const [item, match] of cases) {
    fails(`---\nid: 1\nallowed_paths:\n  - "${item.replace(/\\/g, '\\\\')}"\n---\n`, { line: 3, match, validate: true });
  }
  // 空字符串只能写成引号
  fails('---\nid: 1\nallowed_paths:\n  - ""\n---\n', { line: 3, match: /不能为空/, validate: true });
});

test('verify 的列表项不能为空', () => {
  fails('---\nid: 1\nverify:\n  - ""\n---\n', { line: 3, match: /verify 第 1 条不能为空/, validate: true });
});

test('mergeSpec：没有任务说明时取项目配置与默认值', () => {
  assert.deepEqual(mergeSpec({}, {}), {
    allowed_paths: ['**'], verify: [], expect_commit: false, timeout_min: 60, verify_timeout_min: 10, max_retries: 2, gate: false,
  });
});

test('mergeSpec：空列表回落到项目配置', () => {
  const merged = mergeSpec({ allowed_paths: [], verify: [] }, { allowedPaths: ['src/**'], verify: ['npm test'] });
  assert.deepEqual(merged.allowed_paths, ['src/**']);
  assert.deepEqual(merged.verify, ['npm test']);
  assert.equal(merged.gate, true, '项目验收命令非空也启用门禁');
});

test('mergeSpec：任务说明的非空列表优先，且不与项目配置合并', () => {
  const merged = mergeSpec(
    { allowed_paths: ['lib/**'], verify: ['node --test'] },
    { allowedPaths: ['src/**', 'docs/**'], verify: ['npm test'] },
  );
  assert.deepEqual(merged.allowed_paths, ['lib/**']);
  assert.deepEqual(merged.verify, ['node --test']);
});

test('mergeSpec：expect_commit 只写在任务说明里，按 type 给默认', () => {
  for (const type of ['code', 'test', 'fix', 'refactor']) {
    assert.equal(mergeSpec({ type }).expect_commit, true, type);
  }
  for (const type of ['research', 'docs', 'review', undefined]) {
    assert.equal(mergeSpec({ type }).expect_commit, false, String(type));
  }
});

test('mergeSpec：显式 expect_commit 覆盖按 type 的默认', () => {
  assert.equal(mergeSpec({ type: 'code', expect_commit: false }).expect_commit, false);
  assert.equal(mergeSpec({ type: 'docs', expect_commit: true }).expect_commit, true);
});

test('mergeSpec：超时默认 60 / 10，写了就用', () => {
  assert.equal(mergeSpec({}).timeout_min, 60);
  assert.equal(mergeSpec({}).verify_timeout_min, 10);
  const merged = mergeSpec({ timeout_min: 5, verify_timeout_min: 2 });
  assert.equal(merged.timeout_min, 5);
  assert.equal(merged.verify_timeout_min, 2);
});

test('mergeSpec：verify_timeout_min 任务说明优先，压过项目配置 verifyTimeoutMin', () => {
  assert.equal(mergeSpec({ verify_timeout_min: 5 }, { verifyTimeoutMin: 20 }).verify_timeout_min, 5);
});

test('mergeSpec：任务说明没写时项目配置 verifyTimeoutMin 兜底', () => {
  assert.equal(mergeSpec({}, { verifyTimeoutMin: 20 }).verify_timeout_min, 20);
});

test('mergeSpec：项目配置 verifyTimeoutMin 不是正整数时当没写，取默认 10', () => {
  for (const value of [0, -1, 1.5, '20', null]) {
    assert.equal(mergeSpec({}, { verifyTimeoutMin: value }).verify_timeout_min, 10, `verifyTimeoutMin: ${JSON.stringify(value)}`);
  }
});

test('mergeSpec：任务说明与项目配置都没写 verify_timeout_min → 10', () => {
  assert.equal(mergeSpec({}, {}).verify_timeout_min, 10);
});

test('mergeSpec：gate 的三个条件分别为真', () => {
  assert.equal(mergeSpec({ verify: ['npm test'] }).gate, true, '验收命令非空');
  assert.equal(mergeSpec({ allowed_paths: ['src/**'] }).gate, true, '允许路径不是 ["**"]');
  assert.equal(mergeSpec({ type: 'code' }).gate, true, '默认要求提交');
});

test('mergeSpec：条件全不满足时 gate 为假', () => {
  assert.equal(mergeSpec({ type: 'docs' }, { allowedPaths: ['**'] }).gate, false);
  assert.equal(mergeSpec({ expect_commit: false }).gate, false);
});

test('core/templates/spec.md 能被解析与校验', () => {
  const file = fileURLToPath(new URL('../../core/templates/spec.md', import.meta.url));
  const text = readFileSync(file, 'utf8');
  const { spec } = read(text, 'spec.md');
  assert.equal(spec.type, 'code');
  assert.equal(spec.worker, 'auto');
  assert.ok(spec.allowed_paths.length > 0);
  assert.ok(spec.verify.length > 0);
  assert.match(text, /\n## 受影响的已有测试\n/);
});

test('SPEC_TYPES 是协议里的七种类型', () => {
  assert.deepEqual(SPEC_TYPES, ['code', 'test', 'fix', 'refactor', 'research', 'docs', 'review']);
});
