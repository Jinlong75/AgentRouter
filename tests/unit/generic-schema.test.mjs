import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLACEHOLDERS, KINDS, REPORTS, validateGeneric, placeholdersIn, getPath,
} from '../../core/lib/generic-schema.mjs';

const textDecl = (extra = {}) => ({
  label: 'Example CLI',
  executable: 'example-cli',
  args: ['run', '{prompt}'],
  output: { format: 'text' },
  ...extra,
});
const jsonlDecl = (map, extra = {}) => ({
  label: 'Example CLI',
  executable: 'example-cli',
  args: ['--json', '{prompt}'],
  output: { format: 'jsonl', map },
  ...extra,
});
const sayRule = { when: { type: 'message', role: 'assistant' }, kind: 'say', text: 'content' };

// 断言：errors 里有一条 path 完全相等、message 含关键字
function expectError(decl, path, keyword, opts) {
  const r = validateGeneric(decl, opts);
  assert.equal(r.ok, false, '应当校验失败');
  const hit = r.errors.find((e) => e.path === path);
  assert.ok(hit, `没有路径 ${path} 的错误，实际：${JSON.stringify(r.errors)}`);
  assert.ok(hit.message.includes(keyword), `消息 "${hit.message}" 不含 "${keyword}"`);
}
function expectWarning(decl, path, keyword) {
  const r = validateGeneric(decl);
  const hit = r.warnings.find((e) => e.path === path);
  assert.ok(hit, `没有路径 ${path} 的警告，实际：${JSON.stringify(r.warnings)}`);
  assert.ok(hit.message.includes(keyword), `消息 "${hit.message}" 不含 "${keyword}"`);
}

test('常量导出', () => {
  assert.deepEqual(PLACEHOLDERS, ['prompt', 'promptFile', 'worktree', 'report', 'model', 'effort']);
  assert.deepEqual(KINDS, ['say', 'think', 'cmd', 'file', 'plan', 'tool', 'turn', 'error']);
  assert.deepEqual(REPORTS, ['stdout', 'lastSay', 'file']);
});

test('最小合法文本型', () => {
  const r = validateGeneric(textDecl());
  assert.deepEqual(r, { ok: true, errors: [], warnings: [] });
});

test('最小合法 JSONL 型', () => {
  const r = validateGeneric(jsonlDecl([sayRule]));
  assert.deepEqual(r, { ok: true, errors: [], warnings: [] });
});

test('完整合法声明（含全部可选字段）', () => {
  const r = validateGeneric(textDecl({
    detect: ['--version'],
    readOnlyArgs: ['run', '--read-only', '{prompt}'],
    stdin: null,
    env: { EXAMPLE_MODE: 'batch' },
    secrets: { EXAMPLE_API_KEY: 'MY_EXAMPLE_KEY' },
    report: 'file',
    args: ['run', '--out', '{report}', '-C', '{worktree}', '-m', '{model}', '{promptFile}'],
    timeoutMin: 30,
    failureHints: [{ match: 'rate limit', text: '触发限流，稍后再试。' }],
  }));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('只用 stdin 传任务指令是合法的', () => {
  assert.equal(validateGeneric(textDecl({ args: ['run'], stdin: '{prompt}' })).ok, true);
});

for (const field of ['label', 'executable', 'args', 'output']) {
  test(`缺少必填字段 ${field}`, () => {
    const d = textDecl();
    delete d[field];
    expectError(d, `generic.${field}`, field);
  });
}

test('label 全是空白', () => expectError(textDecl({ label: '   ' }), 'generic.label', '非空'));
test('executable 类型错误', () => expectError(textDecl({ executable: 5 }), 'generic.executable', '非空字符串'));
test('args 不是数组', () => expectError(textDecl({ args: 'run {prompt}' }), 'generic.args', '数组'));
test('args 某项不是字符串', () => expectError(textDecl({ args: ['{prompt}', 3] }), 'generic.args[1]', '字符串'));
test('detect 某项不是字符串', () => expectError(textDecl({ detect: ['-v', 1] }), 'generic.detect[1]', '字符串'));
test('stdin 类型错误', () => expectError(textDecl({ stdin: 5 }), 'generic.stdin', '字符串或 null'));
test('output 不是对象', () => expectError(textDecl({ output: 'text' }), 'generic.output', '对象'));
test('缺少 output.format', () => expectError(textDecl({ output: {} }), 'generic.output.format', 'format'));
test('output.format 取值错误', () => expectError(textDecl({ output: { format: 'xml' } }), 'generic.output.format', 'jsonl'));

test('stream-json：合法，不要 map，不写 report 也合法', () => {
  assert.deepEqual(validateGeneric(textDecl({ output: { format: 'stream-json' } })), { ok: true, errors: [], warnings: [] });
});
test('stream-json 写了 map → 报错', () => {
  expectError(textDecl({ output: { format: 'stream-json', map: [sayRule] } }), 'generic.output.map', 'stream-json');
});
test('{effort} 是合法占位符', () => {
  assert.equal(validateGeneric(textDecl({ args: ['--effort', '{effort}', '{prompt}'] })).ok, true);
});

test('jsonl 缺 map', () => {
  expectError(textDecl({ output: { format: 'jsonl' } }), 'generic.output.map', 'map');
});
test('jsonl 的 map 为空', () => {
  expectError(jsonlDecl([]), 'generic.output.map', '不能为空');
});
test('text 写了 map → 警告', () => {
  const d = textDecl({ output: { format: 'text', map: [sayRule] } });
  const r = validateGeneric(d);
  assert.equal(r.ok, true);
  expectWarning(d, 'generic.output.map', '不会被用到');
});

test('规则缺 kind', () => {
  expectError(jsonlDecl([sayRule, { text: 'x' }]), 'generic.output.map[1].kind', 'kind');
});
test('规则 kind 错误', () => {
  expectError(jsonlDecl([{ kind: 'shout', text: 'x' }]), 'generic.output.map[0].kind', '不认识');
});
test('规则不是对象', () => {
  expectError(jsonlDecl(['say']), 'generic.output.map[0]', '对象');
});
test('规则多出不允许的键（say 里写 command）', () => {
  expectError(jsonlDecl([sayRule, { kind: 'say', text: 'a', command: 'b' }]), 'generic.output.map[1].command', '允许的字段');
});
test('规则取值字段不是字符串', () => {
  expectError(jsonlDecl([{ kind: 'say', text: 1 }]), 'generic.output.map[0].text', '字符串');
});
test('when 不是对象', () => {
  expectError(jsonlDecl([{ when: 'x', kind: 'say', text: 'a' }]), 'generic.output.map[0].when', '对象');
});
test('when 值类型不允许', () => {
  expectError(jsonlDecl([{ when: { type: ['a'] }, kind: 'say', text: 'a' }]), 'generic.output.map[0].when.type', '字符串、数字、布尔或 null');
});
test('when 允许字符串、数字、布尔、null', () => {
  const r = validateGeneric(jsonlDecl([{ when: { a: 's', b: 1, c: true, d: null }, kind: 'say', text: 'x' }]));
  assert.equal(r.ok, true, JSON.stringify(r));
});

const missingCases = [
  ['say', {}, 'text'],
  ['think', {}, 'text'],
  ['error', {}, 'text'],
  ['cmd', { phase: 'p' }, 'command'],
  ['file', { fileKind: 'edit' }, 'path'],
  ['plan', { itemText: 'a' }, 'items'],
  ['tool', { detail: 'd' }, 'name'],
  ['turn', { text: 't' }, 'outputTokens'],
];
for (const [kind, extra, kw] of missingCases) {
  test(`kind ${kind} 缺必需字段`, () => {
    expectError(jsonlDecl([{ kind, ...extra }]), 'generic.output.map[0]', kw);
  });
}

test('各 kind 的最小合法规则', () => {
  const r = validateGeneric(jsonlDecl([
    { kind: 'cmd', command: 'item.command', exit: 'item.exit_code|0' },
    { kind: 'cmd', id: 'item.id' },
    { kind: 'file', path: 'item.path', fileKind: 'item.kind|edit' },
    { kind: 'plan', items: 'plan', itemText: 'text', itemDone: 'done' },
    { kind: 'tool', name: 'tool.name', detail: 'tool.args' },
    { kind: 'turn', input: 'usage.in' },
    { kind: 'turn', outputTokens: 'usage.out' },
    { kind: 'think', text: 'thought' },
    { kind: 'error', text: 'message' },
  ]));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('未知占位符：args', () => {
  expectError(textDecl({ args: ['run', '{prompt}', '{foo}'] }), 'generic.args[2]', '{foo}');
});
test('未知占位符：readOnlyArgs', () => {
  expectError(textDecl({ readOnlyArgs: ['{prompt}', '{bar}'] }), 'generic.readOnlyArgs[1]', '{bar}');
});
test('未知占位符：stdin', () => {
  expectError(textDecl({ stdin: '{prompt} {baz}' }), 'generic.stdin', '{baz}');
});
test('未知占位符：detect', () => {
  expectError(textDecl({ detect: ['--version', '{qux}'] }), 'generic.detect[1]', '允许的占位符');
});

test('没有传任务指令的地方', () => {
  expectError(textDecl({ args: ['run', '{model}'] }), 'generic.args', '任务指令');
});
test('readOnlyArgs 存在但没有任务指令', () => {
  expectError(textDecl({ readOnlyArgs: ['run', '--ro'] }), 'generic.readOnlyArgs', '任务指令');
});
test('readOnlyArgs 没有 prompt 但 stdin 有，合法', () => {
  const r = validateGeneric(textDecl({ args: ['run'], readOnlyArgs: ['run', '--ro'], stdin: '{prompt}' }));
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('{report} 出现但 report 不是 file → 警告', () => {
  const d = textDecl({ args: ['run', '{prompt}', '{report}'] });
  assert.equal(validateGeneric(d).ok, true);
  expectWarning(d, 'generic.report', '不会被读取');
});
test('report 是 file 但没有 {report} → 警告', () => {
  const d = textDecl({ report: 'file' });
  assert.equal(validateGeneric(d).ok, true);
  expectWarning(d, 'generic.report', '{report}');
});
test('report 取值错误', () => {
  expectError(textDecl({ report: 'clipboard' }), 'generic.report', 'lastSay');
});

test('env 里放密钥名', () => {
  for (const name of ['EXAMPLE_API_KEY', 'my_token', 'DB_SECRET', 'X_PASSWORD']) {
    expectError(textDecl({ env: { [name]: 'v' } }), `generic.env.${name}`, 'secrets');
  }
});
test('env 变量名不合法', () => {
  expectError(textDecl({ env: { '1BAD': 'v' } }), 'generic.env.1BAD', '不合法');
});
test('env 值不是字符串', () => {
  expectError(textDecl({ env: { MODE: 1 } }), 'generic.env.MODE', '字符串');
});
test('secrets 值以 sk- 开头', () => {
  expectError(textDecl({ secrets: { EXAMPLE_API_KEY: 'sk-abcdef123456' } }), 'generic.secrets.EXAMPLE_API_KEY', '不写密钥本身');
});
test('secrets 值又长又不像变量名', () => {
  expectError(textDecl({ secrets: { EXAMPLE_API_KEY: 'a1b2c3-'.repeat(8) } }), 'generic.secrets.EXAMPLE_API_KEY', '不写密钥本身');
});
test('secrets 值是很长的纯字母数字串', () => {
  expectError(textDecl({ secrets: { EXAMPLE_API_KEY: 'aB3'.repeat(15) } }), 'generic.secrets.EXAMPLE_API_KEY', '不写密钥本身');
});
test('secrets 键不合法', () => {
  expectError(textDecl({ secrets: { 'BAD-NAME': 'GOOD_NAME' } }), 'generic.secrets.BAD-NAME', '不合法');
});

test('failureHints 正则编译失败', () => {
  expectError(textDecl({ failureHints: [{ match: '(', text: '提示' }] }), 'generic.failureHints[0].match', '正则');
});
test('failureHints text 为空', () => {
  expectError(textDecl({ failureHints: [{ match: 'x', text: ' ' }] }), 'generic.failureHints[0].text', '非空');
});
test('failureHints 不是数组', () => {
  expectError(textDecl({ failureHints: {} }), 'generic.failureHints', '数组');
});

test('timeoutMin 不是正整数', () => {
  for (const v of [0, -1, 1.5, '5']) {
    expectError(textDecl({ timeoutMin: v }), 'generic.timeoutMin', '正整数');
  }
});

test('顶层未知字段', () => {
  const d = textDecl();
  d.arg = ['x'];
  expectError(d, 'generic.arg', 'executable');
});
test('decl 不是对象：路径就是前缀本身', () => {
  for (const v of [null, [], 'x', 3]) expectError(v, 'generic', '对象');
  expectError(null, 'profiles.qoder.generic', '对象', { path: 'profiles.qoder.generic' });
});
test('路径前缀生效', () => {
  expectError(textDecl({ args: ['{x}'] }), 'profiles.qoder.generic.args[0]', '{x}', { path: 'profiles.qoder.generic' });
  expectError(jsonlDecl([{ kind: 'zzz' }]), 'profiles.qoder.generic.output.map[0].kind', 'kind', { path: 'profiles.qoder.generic' });
});

test('getPath：点路径', () => {
  const o = { a: { b: { c: 7 } }, s: 'x' };
  assert.equal(getPath(o, 'a.b.c'), 7);
  assert.equal(getPath(o, 's'), 'x');
  assert.deepEqual(getPath(o, 'a.b'), { c: 7 });
});
test('getPath：数组下标', () => {
  const o = { a: { items: [{ text: 'first' }, { text: 'second' }] } };
  assert.equal(getPath(o, 'a.items.0.text'), 'first');
  assert.equal(getPath(o, 'a.items.1.text'), 'second');
  assert.equal(getPath(o, 'a.items.9.text'), undefined);
  assert.equal(getPath(o, 'a.items.text'), undefined);
});
test('getPath：取不到', () => {
  assert.equal(getPath({ a: 1 }, 'b'), undefined);
  assert.equal(getPath({ a: 1 }, 'a.b.c'), undefined);
  assert.equal(getPath({ a: null }, 'a.b'), undefined);
  assert.equal(getPath(null, 'a'), undefined);
});
test('getPath：默认字面量的四种类型', () => {
  const o = { z: 0, f: false };
  assert.equal(getPath({}, 'a|true'), true);
  assert.equal(getPath({}, 'a|false'), false);
  assert.equal(getPath({}, 'a|null'), null);
  assert.equal(getPath({}, 'a|42'), 42);
  assert.equal(getPath({}, 'a|edit'), 'edit');
  // 取得到时不用默认值，哪怕值是 0 / false / null
  assert.equal(getPath(o, 'z|9'), 0);
  assert.equal(getPath(o, 'f|true'), false);
  assert.equal(getPath({ a: null }, 'a|9'), null);
});
test('getPath：spec 不是字符串', () => {
  assert.equal(getPath({ a: 1 }, 5), undefined);
  assert.equal(getPath({ a: 1 }, undefined), undefined);
  assert.equal(getPath({ a: 1 }, null), undefined);
});

test('placeholdersIn：去重与顺序', () => {
  assert.deepEqual(placeholdersIn('--x {prompt} {model} {prompt} {foo}'), ['prompt', 'model', 'foo']);
  assert.deepEqual(placeholdersIn('没有占位符'), []);
  assert.deepEqual(placeholdersIn('{"a": 1}'), []);
  assert.deepEqual(placeholdersIn(5), []);
});
