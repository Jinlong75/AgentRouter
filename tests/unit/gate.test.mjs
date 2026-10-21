import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeGate } from '../../core/lib/gate.mjs';
import { parseNameStatusZ, parseStatusPorcelainZ } from '../../core/lib/git.mjs';

// 构造 summarizeGate 的输入；没给的字段按"这一项没问题"处理。
const parts = ({ commit, uncommitted = [], outside = [], commands = [] } = {}) => ({
  commit: commit ?? { required: true, ok: true },
  uncommitted,
  scope: { allowed: ['src/**'], changed: [], outside },
  commands,
});
const command = (overrides = {}) => ({ line: 'npm test', exit: 0, timedOut: false, error: null, ...overrides });

test('summarizeGate：全部通过给出"门禁通过"', () => {
  assert.equal(summarizeGate(parts({ commands: [command()] })), '门禁通过');
  // 没有验收命令、不要求提交、没有改动也是通过。
  assert.equal(summarizeGate(parts({ commit: { required: false, ok: true } })), '门禁通过');
});

test('summarizeGate：只缺提交', () => {
  const text = summarizeGate(parts({ commit: { required: true, ok: false } }));
  assert.equal(text, '没有提交任何改动');
});

test('summarizeGate：只有未提交的文件', () => {
  assert.equal(summarizeGate(parts({ uncommitted: ['src/a.js'] })), '有未提交的文件');
});

test('summarizeGate：只有越界', () => {
  assert.equal(summarizeGate(parts({ outside: ['README.md'] })), '改动超出范围：README.md');
});

test('summarizeGate：只命令失败（exit）', () => {
  const text = summarizeGate(parts({ commands: [command({ exit: 1 })] }));
  assert.equal(text, '验收命令失败：npm test（exit 1）');
});

test('summarizeGate：超时写"（超时）"，启动失败写原因', () => {
  assert.equal(
    summarizeGate(parts({ commands: [command({ line: 'slow', exit: null, timedOut: true, error: '超过 1.5 秒没有结束，已结束进程树' })] })),
    '验收命令失败：slow（超时）',
  );
  assert.equal(
    summarizeGate(parts({ commands: [command({ line: 'missing', exit: null, error: '找不到命令：missing' })] })),
    '验收命令失败：missing（找不到命令：missing）',
  );
});

test('summarizeGate：多项失败按协议顺序，多条失败命令各占一段', () => {
  const text = summarizeGate(parts({
    commit: { required: true, ok: false },
    uncommitted: ['src/a.js'],
    outside: ['README.md', 'docs/x.md'],
    commands: [command({ line: 'npm test', exit: 2 }), command({ line: 'slow', exit: null, timedOut: true })],
  }));
  assert.equal(text, '没有提交任何改动；有未提交的文件；改动超出范围：README.md、docs/x.md；验收命令失败：npm test（exit 2）；验收命令失败：slow（超时）');
});

test('summarizeGate：文件超过 5 个只列前 5 个并加"等"', () => {
  const outside = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.equal(summarizeGate(parts({ outside })), '改动超出范围：a、b、c、d、e 等');
  // 正好 5 个不加"等"。
  assert.equal(summarizeGate(parts({ outside: outside.slice(0, 5) })), '改动超出范围：a、b、c、d、e');
});

test('summarizeGate：不要求提交时 commit.ok 为假不算失败', () => {
  assert.equal(summarizeGate(parts({ commit: { required: false, ok: false } })), '门禁通过');
});

test('parseStatusPorcelainZ：普通项、未跟踪项；重命名的新旧路径都列出', () => {
  // -z 下每条是 "<XY> <路径>"，重命名后面紧跟旧路径。
  const text = ' M src/中文 文件.js\0?? notes/a b.txt\0R  lib/a.js\0src/a.js\0C  copy/b.js\0src/b.js\0';
  assert.deepEqual(parseStatusPorcelainZ(text), [
    'src/中文 文件.js', 'notes/a b.txt', 'lib/a.js', 'src/a.js', 'copy/b.js', 'src/b.js',
  ]);
});

test('parseStatusPorcelainZ：排除 .agent-runs/ 下的文件（含重命名的旧路径）', () => {
  const text = '?? .agent-runs/x/progress.log\0?? .agent-runs/gate.json\0 M src/a.js\0'
    + 'R  src/b.js\0.agent-runs/y/old.log\0';
  assert.deepEqual(parseStatusPorcelainZ(text), ['src/a.js', 'src/b.js']);
});

test('parseNameStatusZ：重命名 / 复制按旧路径、新路径的顺序；去重保持出现顺序', () => {
  const text = 'M\0src/a.js\0A\0README.md\0R100\0src/旧 名.js\0lib/新 名.js\0C075\0src/c.js\0lib/c.js\0'
    + 'M\0src/a.js\0';
  assert.deepEqual(parseNameStatusZ(text), [
    'src/a.js', 'README.md', 'src/旧 名.js', 'lib/新 名.js', 'src/c.js', 'lib/c.js',
  ]);
});

test('parseNameStatusZ：空输入返回空数组', () => {
  assert.deepEqual(parseNameStatusZ(''), []);
  assert.deepEqual(parseStatusPorcelainZ(''), []);
});
