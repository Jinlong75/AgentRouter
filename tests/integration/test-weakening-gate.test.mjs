import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runGate } from '../../core/lib/gate.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = (root, file, data) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), data); };
function fixture(t, files, config) {
  const root = mkdtempSync(join(tmpdir(), 'ar-weakening-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  for (const [file, data] of Object.entries(files)) write(root, file, data);
  if (config !== undefined) write(root, '.agent-router/project.json', JSON.stringify(config));
  git(root, 'add', '--all'); git(root, 'commit', '-qm', 'base');
  return { root, base: git(root, 'rev-parse', 'HEAD'), dir: join(root, '.agent-runs/run') };
}
function commit(root) { git(root, 'add', '--all'); git(root, 'commit', '-qm', 'change'); }
async function gate(f, report) {
  if (report !== undefined) write(f.root, '.agent-runs/run/report.md', report);
  const result = await runGate({ ...f, spec: { allowed_paths: ['**'] } });
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'gate.json'), 'utf8')), result);
  return result;
}

test('删除和净减逐文件要求本次报告包含完整路径', async t => {
  const f = fixture(t, { 'tests/a.test.js': 'assert(true);\nassert(false);\n', 'tests/b.test.js': 'check(true);\n' });
  write(f.root, 'tests/a.test.js', 'assert(true);\n');
  rmSync(join(f.root, 'tests/b.test.js')); commit(f.root);
  for (const report of ['', '## 断言改写\n无\n', '## 断言改写\ntests/a.test.js\n', '## 断言改写\nx/tests/a.test.js tests/b.test.js\n']) {
    const result = await gate(f, report);
    assert.equal(result.ok, false);
    assert.match(result.summary, /测试检查可能被削弱：.*；请在汇报的断言改写一节逐个说明/);
    assert.equal(result.testWeakening.length, 2);
  }
  const result = await gate(f, '## 断言改写\ntests/a.test.js 和 tests/b.test.js：说明。\n');
  assert.equal(result.ok, true); assert.equal(result.summary, '门禁通过');
  assert.deepEqual(result.testWeakening.map(x => x.reported), [true, true]);
  assert.deepEqual(result.testWeakening.map(x => x.changes), [['断言行数 2→1'], ['删除测试文件']]);
});

test('等量断言、超时增减、非测试文件和新增文件', async t => {
  const f = fixture(t, { 'tests/a.js': 'assert(true);\nconst options = { "timeout": 10 };\n', 'src/a.js': 'assert(true);\n' });
  write(f.root, 'tests/a.js', 'expect(true);\nconst options = { "timeout": 20 };\n');
  write(f.root, 'src/a.js', ''); write(f.root, 'tests/new.js', 'assert(true);\n'); commit(f.root);
  let result = await gate(f);
  assert.equal(result.ok, false); assert.deepEqual(result.testWeakening[0].changes, ['超时增大 timeout 10→20']);
  assert.equal(result.testWeakening.length, 1); assert.match(result.summary, /tests\/a.js/);
  write(f.root, 'tests/a.js', 'expect(true);\nconst timeout = 5;\n'); commit(f.root);
  result = await gate(f);
  assert.equal(result.ok, true); assert.equal(result.summary, '门禁通过'); assert.deepEqual(result.testWeakening, []);
});

test('超时数字分隔符和行内调用参数按数值比较', async t => {
  for (const [before, after, expected] of [
    ['timeout(1000);', 'timeout(2_000);', '超时增大 timeout 1000→2000'],
    ['timeout(1_000);', 'timeout(2_000);', '超时增大 timeout 1000→2000'],
    ['setTimeout(fn, 1_000);', 'setTimeout(fn, 2_000);', '超时增大 timeout 1000→2000'],
    ['setTimeout(fn, 2_000);', 'setTimeout(fn, 1000);', null],
  ]) {
    const f = fixture(t, { 'tests/timing.js': `${before}\n` });
    write(f.root, 'tests/timing.js', `${after}\n`); commit(f.root);
    const result = await gate(f);
    assert.equal(result.ok, expected === null);
    if (expected) {
      assert.deepEqual(result.testWeakening[0].changes, [expected]);
      assert.match(result.summary, /测试检查可能被削弱：tests\/timing\.js/);
    } else {
      assert.deepEqual(result.testWeakening, []);
      assert.equal(result.summary, '门禁通过');
    }
  }
});

test('重命名按旧新内容和新路径检查，自定义模式取基线配置', async t => {
  const f = fixture(t, { 'custom/old.txt': 'verifyOne();\nverifyTwo();\nkeep\nkeep2\nkeep3\n' }, { testPaths: ['custom/**'], testAssertionPatterns: ['verify'] });
  renameSync(join(f.root, 'custom/old.txt'), join(f.root, 'custom/new.txt'));
  write(f.root, 'custom/new.txt', 'verifyOne();\nkeep\nkeep2\nkeep3\n'); commit(f.root);
  const result = await gate(f);
  assert.equal(result.ok, false); assert.match(result.summary, /custom\/new.txt/);
  assert.deepEqual(result.testWeakening, [{ file: 'custom/new.txt', changes: ['断言行数 2→1'], reported: false }]);
});

test('错误配置、二进制和 Git 读失败不放行；只读任务跳过检查', async t => {
  const f = fixture(t, { 'tests/a.js': 'assert(true);\n' }, { testAssertionPatterns: ['('] });
  write(f.root, 'tests/a.js', 'changed\n'); commit(f.root);
  let result = await gate(f); assert.equal(result.ok, false); assert.match(result.summary, /testAssertionPatterns.*正则无效/);
  result = await runGate({ ...f, readOnly: true, spec: {} }); assert.deepEqual(result.testWeakening, []);
  const b = fixture(t, { 'tests/b.js': Buffer.from([0, 1]) });
  write(b.root, 'tests/b.js', Buffer.from([0, 2])); commit(b.root);
  result = await gate(b); assert.equal(result.ok, false); assert.match(result.summary, /二进制/);
  result = await runGate({ ...b, base: '0'.repeat(40), spec: {} });
  assert.equal(result.ok, false); assert.match(result.summary, /无法读取 git 状态/);
});
