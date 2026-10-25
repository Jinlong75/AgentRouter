import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { makeGeneric } from '../../core/adapters/generic.mjs';

const root = path.join(os.tmpdir(), 'ar-generic-map-root');
const decl = (map, output = {}) => ({ label: 'Map CLI', executable: 'map-cli', args: ['{prompt}'], output: { format: 'jsonl', map, ...output } });
// 用规则造映射函数；每行 JSON 对象（或原文字符串）喂进去，返回统一事件数组。
const mapper = map => {
  const m = makeGeneric(decl(map)).createMapper();
  return line => m(typeof line === 'string' ? line : JSON.stringify(line), { root });
};

test('say / think / error：取 text；对象转成 JSON 字符串，数字转字符串，取不到的丢弃', () => {
  const map = mapper([
    { when: { t: 'say' }, kind: 'say', text: 'a.b' },
    { when: { t: 'think' }, kind: 'think', text: 'x' },
    { when: { t: 'error' }, kind: 'error', text: 'msg' },
  ]);
  assert.deepEqual(map({ t: 'say', a: { b: '你好' } }), [{ kind: 'say', text: '你好' }]);
  assert.deepEqual(map({ t: 'think', x: '想' }), [{ kind: 'think', text: '想' }]);
  assert.deepEqual(map({ t: 'error', msg: 42 }), [{ kind: 'error', text: '42' }]);
  assert.deepEqual(map({ t: 'say', a: { b: { deep: 1 } } }), [{ kind: 'say', text: '{"deep":1}' }], '取值类型不对不抛错');
  assert.deepEqual(map({ t: 'say', a: {} }), [], '取不到文字的丢弃');
});

test('点路径支持数组下标；默认值写法 a|字面量 在取不到时生效', () => {
  const map = mapper([
    { when: { t: 'say' }, kind: 'say', text: 'content.0.text' },
    { when: { t: 'dflt' }, kind: 'say', text: 'msg|（空）' },
    { when: { t: 'turn' }, kind: 'turn', input: 'in|7', outputTokens: 'out|null' },
  ]);
  assert.deepEqual(map({ t: 'say', content: [{ text: '第一段' }] }), [{ kind: 'say', text: '第一段' }]);
  assert.deepEqual(map({ t: 'dflt' }), [{ kind: 'say', text: '（空）' }]);
  assert.deepEqual(map({ t: 'dflt', msg: '有值' }), [{ kind: 'say', text: '有值' }]);
  assert.deepEqual(map({ t: 'turn' }), [{ kind: 'turn', usage: { input: 7, output: null } }], '字面量按数字 / null 解读');
});

test('第一条 when 全部相等的规则生效；when 多个键要全部相等', () => {
  const map = mapper([
    { when: { type: 'm', role: 'user' }, kind: 'think', text: 'c' },
    { when: { type: 'm' }, kind: 'say', text: 'c' },
    { kind: 'error', text: 'c' },
  ]);
  assert.deepEqual(map({ type: 'm', role: 'user', c: 'a' }), [{ kind: 'think', text: 'a' }]);
  assert.deepEqual(map({ type: 'm', role: 'assistant', c: 'b' }), [{ kind: 'say', text: 'b' }]);
  assert.deepEqual(map({ type: 'other', c: 'z' }), [{ kind: 'error', text: 'z' }], '没写 when 的规则匹配所有 JSON 行');
});

test('不认识的 JSON 丢弃；非 JSON 的非空行变成 text；空行忽略', () => {
  const map = mapper([{ when: { type: 'm' }, kind: 'say', text: 'c' }]);
  assert.deepEqual(map({ mystery: true }), []);
  assert.deepEqual(map('[1,2]'), [], '数组 JSON 没有规则命中');
  assert.deepEqual(map('not json at all'), [{ kind: 'text', text: 'not json at all' }]);
  assert.deepEqual(map('   '), []);
  assert.deepEqual(map(''), []);
});

test('cmd：phase 取不到时有 exit 为 end、没有为 start；给了 start / end 就用它', () => {
  const map = mapper([{ when: { t: 'c' }, kind: 'cmd', id: 'id', phase: 'phase', command: 'cmd', exit: 'code', output: 'out' }]);
  assert.deepEqual(map({ t: 'c', id: 'c1', cmd: 'ls' }), [{ kind: 'cmd', id: 'c1', phase: 'start', command: 'ls' }]);
  assert.deepEqual(map({ t: 'c', id: 'c1', cmd: 'ls', code: 0, out: 'a\nb' }), [{ kind: 'cmd', id: 'c1', phase: 'end', command: 'ls', exit: 0, output: 'a\nb', truncated: false }]);
  assert.deepEqual(map({ t: 'c', id: 'c1', cmd: 'ls', code: '3' }), [{ kind: 'cmd', id: 'c1', phase: 'end', command: 'ls', exit: 3, output: '', truncated: false }], '数字字符串按数字');
  assert.equal(map({ t: 'c', id: 'c2', cmd: 'ls', phase: 'start', code: 0 })[0].phase, 'start', '明确写了 start 就是 start');
  assert.equal(map({ t: 'c', id: 'c2', cmd: 'ls', phase: 'end' })[0].phase, 'end');
  assert.equal(map({ t: 'c', id: 'c2', cmd: 'ls', phase: '奇怪的值' })[0].phase, 'start', '不是 start / end 时按有无 exit 推断');
  assert.equal(map({ t: 'c', id: 7, cmd: 'ls' })[0].id, '7', 'id 转成字符串');
});

test('cmd 的 output 按协议截断：最多 200 行、16KB', () => {
  const map = mapper([{ when: { t: 'c' }, kind: 'cmd', id: 'id', command: 'cmd', exit: 'code', output: 'out' }]);
  const many = Array.from({ length: 300 }, (_, i) => `行 ${i}`).join('\n');
  const [lines] = map({ t: 'c', id: 'x', cmd: 'c', code: 0, out: many });
  assert.equal(lines.output.split('\n').length, 200);
  assert.equal(lines.truncated, true);
  const [big] = map({ t: 'c', id: 'x', cmd: 'c', code: 0, out: 'a'.repeat(20000) });
  assert.ok(Buffer.byteLength(big.output) <= 16384);
  assert.equal(big.truncated, true);
});

test('file：路径相对执行目录（/ 分隔），目录外保留绝对路径；fileKind 不认识为 update；没有路径丢弃', () => {
  const map = mapper([{ when: { t: 'f' }, kind: 'file', path: 'p', fileKind: 'op' }]);
  assert.deepEqual(map({ t: 'f', p: path.join(root, 'src', 'a.txt'), op: 'add' }), [{ kind: 'file', files: [{ kind: 'add', path: 'src/a.txt' }] }]);
  assert.deepEqual(map({ t: 'f', p: 'docs/b.md', op: 'delete' }), [{ kind: 'file', files: [{ kind: 'delete', path: 'docs/b.md' }] }]);
  assert.equal(map({ t: 'f', p: 'x.txt' })[0].files[0].kind, 'update', '取不到为 update');
  assert.equal(map({ t: 'f', p: 'x.txt', op: 'renamed' })[0].files[0].kind, 'update');
  const outside = path.resolve(root, '..', 'elsewhere', 'c.txt').replaceAll('\\', '/');
  assert.equal(map({ t: 'f', p: path.resolve(root, '..', 'elsewhere', 'c.txt') })[0].files[0].path, outside, '目录外保留绝对路径');
  assert.deepEqual(map({ t: 'f' }), []);
});

test('plan：items 取数组，每项用 itemText / itemDone；没写 itemText 时整项转字符串', () => {
  const map = mapper([
    { when: { t: 'p' }, kind: 'plan', items: 'todos', itemText: 'title', itemDone: 'done' },
    { when: { t: 'q' }, kind: 'plan', items: 'steps' },
  ]);
  assert.deepEqual(map({ t: 'p', todos: [{ title: '写文件', done: true }, { title: '汇报', done: false }, { title: '没写 done' }] }),
    [{ kind: 'plan', items: [{ text: '写文件', done: true }, { text: '汇报', done: false }, { text: '没写 done', done: false }] }]);
  assert.deepEqual(map({ t: 'q', steps: ['一', '二'] }), [{ kind: 'plan', items: [{ text: '一', done: false }, { text: '二', done: false }] }]);
  assert.deepEqual(map({ t: 'p', todos: '不是数组' }), [{ kind: 'plan', items: [] }]);
});

test('tool：name 与 detail（对象转成一行 JSON）；turn：usage 取不到为 null', () => {
  const map = mapper([
    { when: { t: 'tool' }, kind: 'tool', name: 'n', detail: 'args' },
    { when: { t: 'turn' }, kind: 'turn', input: 'i', outputTokens: 'o' },
  ]);
  assert.deepEqual(map({ t: 'tool', n: 'search', args: { q: 'x', n: 2 } }), [{ kind: 'tool', name: 'search', detail: '{"q":"x","n":2}' }]);
  assert.deepEqual(map({ t: 'tool', n: 'ping' }), [{ kind: 'tool', name: 'ping', detail: '' }]);
  assert.deepEqual(map({ t: 'turn', i: 10, o: 3 }), [{ kind: 'turn', usage: { input: 10, output: 3 } }]);
  assert.deepEqual(map({ t: 'turn', i: '12' }), [{ kind: 'turn', usage: { input: 12, output: null } }]);
  assert.deepEqual(map({ t: 'turn' }), [{ kind: 'turn', usage: { input: null, output: null } }]);
});

test('text 格式：每个非空行一条 text；每次 createMapper 互不影响', () => {
  const adapter = makeGeneric({ label: 'T', executable: 't', args: ['{prompt}'], output: { format: 'text' } });
  const m = adapter.createMapper();
  assert.deepEqual(m('第一行', { root }), [{ kind: 'text', text: '第一行' }]);
  assert.deepEqual(m('  ', { root }), []);
  assert.deepEqual(m('{"json":"也只是文字"}', { root }), [{ kind: 'text', text: '{"json":"也只是文字"}' }]);
  assert.notEqual(adapter.createMapper(), m);
});
