import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../../core/lib/retry-prompt.mjs';

// 有失败时附上的"要求"段（逐字核对）。
const REQUIREMENTS = [
  '要求：',
  '1. 在当前工作区已有改动的基础上修复，不要推倒重来。',
  '2. 修复后重新运行上面的验收命令，确认通过再提交。',
  '3. 如果某条失败与你这次的改动无关（例如原本就不稳定的检查），不要为了它去修改无关的文件，在汇报里写明。',
  '4. 汇报里说明这次改了什么、上一次为什么没有通过。',
];

// 造 gate.json 对象（协议 12.3）；没给的字段按"这一项没问题"处理。
const makeGate = (overrides = {}) => ({
  v: 1, attempt: 1, at: 1000, ms: 5, ok: false,
  base: '1111111', head: '2222222',
  commit: { required: false, ok: true },
  uncommitted: [],
  scope: { allowed: ['**'], changed: [], outside: [], protected: [], deleted: [] },
  commands: [],
  summary: '门禁未通过',
  ...overrides,
});

// 造验收命令结果（协议 12.3）。
const makeCommand = (overrides = {}) => ({
  line: 'npm test', argv: ['npm', 'test'], exit: 0, ms: 1,
  timedOut: false, output: '', truncated: false, error: null, ...overrides,
});

// 取出"输出末尾："之后的围栏与围栏里的内容（本测试里的输出段不含与围栏同长的单独一行）。
function commandFence(out) {
  const marker = '输出末尾：\n';
  const at = out.indexOf(marker);
  assert.notEqual(at, -1, '应有"输出末尾："段');
  const rows = out.slice(at + marker.length).split('\n');
  const open = rows[0];
  assert.match(open, /^`{3,}$/, '围栏应是至少 3 个反引号');
  const close = rows.indexOf(open, 1);
  assert.notEqual(close, -1, '应有结束围栏');
  return { fence: open, content: rows.slice(1, close).join('\n') };
}

test('第 1 次、没有 note：原样返回 base', () => {
  assert.equal(buildPrompt('原始指令全文', { n: 1, total: 3, failure: null, note: null }), '原始指令全文');
  assert.equal(buildPrompt('原始指令全文', { n: 1, total: 3, failure: null, note: '' }), '原始指令全文');
  // 没有第二个参数时同样原样返回。
  assert.equal(buildPrompt('原始指令全文'), '原始指令全文');
});

test('门禁失败：摘要、越界与受保护、未提交、没提交、删除的文件、失败命令逐字比较', () => {
  const gate = makeGate({
    commit: { required: true, ok: false },
    uncommitted: ['src/a.js'],
    scope: {
      allowed: ['core/**'],
      changed: ['core/lib/x.mjs', 'README.md', 'docs/specs/057.md'],
      outside: ['README.md', 'docs/specs/057.md'],
      protected: ['docs/specs/057.md'],
      deleted: ['tests/unit/old.test.mjs'],
    },
    commands: [
      makeCommand({ line: 'npm test', exit: 1, output: 'FAIL line 1\nFAIL line 2' }),
      makeCommand({ line: 'npm run slow', argv: ['npm', 'run', 'slow'], exit: null, timedOut: true, output: 'still running' }),
      makeCommand({ line: 'npm run lint:tree', exit: 0, output: '目录检查通过' }),
    ],
    summary: '没有提交任何改动；有未提交的文件；改动超出范围：README.md、docs/specs/057.md；验收命令失败：npm test（exit 1）；验收命令失败：npm run slow（超时）',
  });
  const out = buildPrompt('任务：实现重试段落。', { n: 2, total: 3, failure: { kind: 'gate', gate }, note: null });
  const expected = [
    '任务：实现重试段落。',
    '',
    '## 上一次尝试没有通过验收（第 1 次，共允许 3 次）',
    '',
    '失败原因：没有提交任何改动；有未提交的文件；改动超出范围：README.md、docs/specs/057.md；验收命令失败：npm test（exit 1）；验收命令失败：npm run slow（超时）',
    '',
    '以下文件不在允许修改的范围内，请用 git 把它们恢复到任务开始时的版本，不要删除或绕过检查：',
    '- README.md',
    '',
    '以下文件是受保护的路径（任务说明、项目配置），不允许修改，请用 git 把它们恢复到任务开始时的版本：',
    '- docs/specs/057.md',
    '',
    '以下文件改了但没有提交：需要就提交，不需要就恢复：',
    '- src/a.js',
    '',
    '上一次没有提交任何改动：完成后必须提交。',
    '',
    '上一次删除了以下文件：如果不是任务要求删除的（例如为了让检查通过而删掉测试），请恢复它们：',
    '- tests/unit/old.test.mjs',
    '',
    '验收命令 `npm test` 失败（exit 1），输出末尾：',
    '```',
    'FAIL line 1',
    'FAIL line 2',
    '```',
    '',
    '验收命令 `npm run slow` 超时，输出末尾：',
    '```',
    'still running',
    '```',
    '',
    ...REQUIREMENTS,
  ].join('\n');
  assert.equal(out, expected);
  // 通过的命令整段不出现。
  assert.ok(!out.includes('npm run lint:tree'));
  assert.ok(!out.includes('目录检查通过'));
});

test('旧式 gate 没有 protected / deleted 字段：不报错，对应段不出现', () => {
  const gate = {
    commit: { required: false, ok: true },
    uncommitted: [],
    scope: { allowed: ['**'], changed: ['old.md'], outside: ['old.md'] },
    commands: [makeCommand({ output: 'fine' })],
    summary: '改动超出范围：old.md',
  };
  const out = buildPrompt('指令', { n: 2, total: 2, failure: { kind: 'gate', gate }, note: null });
  const expected = [
    '指令',
    '',
    '## 上一次尝试没有通过验收（第 1 次，共允许 2 次）',
    '',
    '失败原因：改动超出范围：old.md',
    '',
    '以下文件不在允许修改的范围内，请用 git 把它们恢复到任务开始时的版本，不要删除或绕过检查：',
    '- old.md',
    '',
    ...REQUIREMENTS,
  ].join('\n');
  assert.equal(out, expected);
  assert.ok(!out.includes('受保护的路径'));
  assert.ok(!out.includes('上一次删除了以下文件'));
});

test('执行者失败：只取最后 3 条出错信息；都为空时没有代码块', () => {
  const out = buildPrompt('指令', {
    n: 2, total: 3, note: null,
    failure: { kind: 'agent', exit: 2, errors: ['错误事件 1', '错误事件 2', '错误事件 3', '错误事件 4'], stderrTail: 'stderr 尾部' },
  });
  const expected = [
    '指令',
    '',
    '## 上一次尝试没有通过验收（第 1 次，共允许 3 次）',
    '',
    '失败原因：执行者异常退出（exit 2）。',
    '',
    '出错信息末尾：',
    '```',
    '错误事件 2',
    '错误事件 3',
    '错误事件 4',
    'stderr 尾部',
    '```',
    '',
    ...REQUIREMENTS,
  ].join('\n');
  assert.equal(out, expected);
  assert.ok(!out.includes('错误事件 1'));

  // errors 与 stderrTail 都为空：没有"出错信息末尾"一行和代码块。
  const empty = buildPrompt('指令', { n: 3, total: 3, failure: { kind: 'agent', exit: 1, errors: [], stderrTail: '' }, note: null });
  const expectedEmpty = [
    '指令',
    '',
    '## 上一次尝试没有通过验收（第 2 次，共允许 3 次）',
    '',
    '失败原因：执行者异常退出（exit 1）。',
    '',
    ...REQUIREMENTS,
  ].join('\n');
  assert.equal(empty, expectedEmpty);
  assert.ok(!empty.includes('出错信息末尾'));
  // errors / stderrTail 缺省时同样不写。
  const missing = buildPrompt('指令', { n: 2, total: 2, failure: { kind: 'agent', exit: 3 }, note: null });
  assert.ok(!missing.includes('出错信息末尾'));
});

test('截断：3000 行输出只剩末尾 80 行', () => {
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
  const gate = makeGate({ summary: '验收命令失败：big（exit 1）', commands: [makeCommand({ line: 'big', exit: 1, output: big })] });
  const out = buildPrompt('指令', { n: 2, total: 2, failure: { kind: 'gate', gate }, note: null });
  const { fence, content } = commandFence(out);
  assert.equal(fence, '```');
  const rows = content.split('\n');
  assert.equal(rows.length, 80);
  assert.equal(rows[0], 'line 2921');
  assert.equal(rows[79], 'line 3000');
  assert.ok(!content.includes('line 2920'));
});

test('截断：80 行但超过 8 KB 时从开头去整行', () => {
  // 每行 4 + 196 = 200 字节，80 行共 16079 字节；保留 40 行（8039 字节），再多一行就超 8 KB。
  const rows80 = Array.from({ length: 80 }, (_, i) => `L${String(i + 1).padStart(2, '0')}:` + 'b'.repeat(196));
  const gate = makeGate({ summary: '验收命令失败：big（exit 1）', commands: [makeCommand({ line: 'big', exit: 1, output: rows80.join('\n') })] });
  const out = buildPrompt('指令', { n: 2, total: 2, failure: { kind: 'gate', gate }, note: null });
  const { content } = commandFence(out);
  const kept = content.split('\n');
  assert.equal(kept.length, 40);
  assert.ok(kept[0].startsWith('L41:'));
  assert.ok(kept[39].startsWith('L80:'));
  assert.ok(!content.includes('L40:'));
  assert.ok(Buffer.byteLength(content) <= 8192);
});

test('截断：含中文的多字节边界不出乱码', () => {
  const chinese = '汉'.repeat(4000); // 单行 12000 字节，超过 8 KB
  const gate = makeGate({ summary: '验收命令失败：cn（exit 1）', commands: [makeCommand({ line: 'cn', exit: 1, output: chinese })] });
  const out = buildPrompt('指令', { n: 2, total: 2, failure: { kind: 'gate', gate }, note: null });
  const { content } = commandFence(out);
  assert.ok(/^[汉]+$/.test(content), '内容应全是完整的"汉"字');
  assert.ok(!content.includes('�'), '不能切出替换字符');
  assert.ok(Buffer.byteLength(content) <= 8192);
  // 边界只丢一个字符以内（最多 3 字节）。
  assert.ok(Buffer.byteLength(content) > 8192 - 3);
  assert.ok(chinese.endsWith(content));
});

test('截断：单行超长保留末尾 8 KB', () => {
  const longLine = 'A'.repeat(20000);
  const gate = makeGate({ summary: '验收命令失败：long（exit 1）', commands: [makeCommand({ line: 'long', exit: 1, output: longLine })] });
  const out = buildPrompt('指令', { n: 2, total: 2, failure: { kind: 'gate', gate }, note: null });
  const { fence, content } = commandFence(out);
  assert.equal(fence, '```');
  assert.equal(content, 'A'.repeat(8192));
});

test('围栏：内容里 ``` 用 4 个、```` 用 5 个、没有反引号用 3 个', () => {
  const cases = [
    { output: '开头\n```\n结尾', fence: '````' },
    { output: 'x ```` y', fence: '`````' },
    { output: 'plain output', fence: '```' },
  ];
  for (const { output, fence } of cases) {
    const gate = makeGate({ summary: '验收命令失败：c（exit 1）', commands: [makeCommand({ line: 'c', exit: 1, output })] });
    const out = buildPrompt('指令', { n: 2, total: 2, failure: { kind: 'gate', gate }, note: null });
    const expected = [
      '指令',
      '',
      '## 上一次尝试没有通过验收（第 1 次，共允许 2 次）',
      '',
      '失败原因：验收命令失败：c（exit 1）',
      '',
      '验收命令 `c` 失败（exit 1），输出末尾：',
      fence, ...output.split('\n'), fence,
      '',
      ...REQUIREMENTS,
    ].join('\n');
    assert.equal(out, expected);
  }
});

test('手动重试 total 为 null：标题只有"第 n-1 次"', () => {
  const gate = makeGate({
    summary: '验收命令失败：npm test（exit 1）',
    commands: [makeCommand({ exit: 1, output: 'boom' })],
  });
  const out = buildPrompt('指令', { n: 3, total: null, failure: { kind: 'gate', gate }, note: null });
  const expected = [
    '指令',
    '',
    '## 上一次尝试没有通过验收（第 2 次）',
    '',
    '失败原因：验收命令失败：npm test（exit 1）',
    '',
    '验收命令 `npm test` 失败（exit 1），输出末尾：',
    '```',
    'boom',
    '```',
    '',
    ...REQUIREMENTS,
  ].join('\n');
  assert.equal(out, expected);
});

test('手动重试：没有失败只有 note 时只追加"主导补充说明"', () => {
  const out = buildPrompt('指令', { n: 1, total: null, failure: null, note: '函数名改为 add' });
  assert.equal(out, ['指令', '', '## 主导补充说明', '', '函数名改为 add'].join('\n'));
});

test('失败 + note：失败信息在前，补充说明最后', () => {
  const gate = makeGate({
    summary: '验收命令失败：npm test（exit 1）',
    commands: [makeCommand({ exit: 1, output: 'boom' })],
  });
  const out = buildPrompt('指令', { n: 2, total: 3, failure: { kind: 'gate', gate }, note: '补充：这次注意换行' });
  const expected = [
    '指令',
    '',
    '## 上一次尝试没有通过验收（第 1 次，共允许 3 次）',
    '',
    '失败原因：验收命令失败：npm test（exit 1）',
    '',
    '验收命令 `npm test` 失败（exit 1），输出末尾：',
    '```',
    'boom',
    '```',
    '',
    ...REQUIREMENTS,
    '',
    '## 主导补充说明',
    '',
    '补充：这次注意换行',
  ].join('\n');
  assert.equal(out, expected);
});

test('换行统一：\\r\\n 输入按行处理，输出里没有 \\r', () => {
  const gate = makeGate({
    summary: '验收命令失败：crlf（exit 1）',
    commands: [makeCommand({ line: 'crlf', exit: 1, output: '第一行\r\n第二行\r\n第三行' })],
  });
  const out = buildPrompt('指令', { n: 2, total: 2, failure: { kind: 'gate', gate }, note: null });
  const expected = [
    '指令',
    '',
    '## 上一次尝试没有通过验收（第 1 次，共允许 2 次）',
    '',
    '失败原因：验收命令失败：crlf（exit 1）',
    '',
    '验收命令 `crlf` 失败（exit 1），输出末尾：',
    '```',
    '第一行',
    '第二行',
    '第三行',
    '```',
    '',
    ...REQUIREMENTS,
  ].join('\n');
  assert.equal(out, expected);
  assert.ok(!out.includes('\r'));

  // 执行者失败的 stderrTail 同样统一成 \n。
  const agent = buildPrompt('指令', {
    n: 2, total: 2, note: null,
    failure: { kind: 'agent', exit: 1, errors: [], stderrTail: 'a\r\nb' },
  });
  assert.ok(!agent.includes('\r'));
  assert.ok(agent.includes('出错信息末尾：\n```\na\nb\n```'));
});

test('启动失败的命令写"没能运行（原因）"，输出为空时写"没有输出"', () => {
  const gate = makeGate({
    summary: '验收命令失败：missing（找不到命令：missing）',
    commands: [makeCommand({ line: 'missing', exit: null, error: '找不到命令：missing', output: '' })],
  });
  const out = buildPrompt('指令', { n: 2, total: 2, failure: { kind: 'gate', gate }, note: null });
  const expected = [
    '指令',
    '',
    '## 上一次尝试没有通过验收（第 1 次，共允许 2 次）',
    '',
    '失败原因：验收命令失败：missing（找不到命令：missing）',
    '',
    '验收命令 `missing` 没能运行（找不到命令：missing），没有输出。',
    '',
    ...REQUIREMENTS,
  ].join('\n');
  assert.equal(out, expected);
});
