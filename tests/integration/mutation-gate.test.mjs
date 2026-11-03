import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGate } from '../../core/lib/gate.mjs';
import { executeMutation } from '../../core/lib/mutation.mjs';
import { runCommand } from '../../core/lib/command.mjs';
import { fixture as pipelineFixture } from '../fixtures/review/pipeline-fixture.mjs';
import path from 'node:path';
test('反向实验判断失败并恢复字节', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ar-mutation-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, 'a'), 'original\n');
    execFileSync('git', ['add', 'a'], { cwd: root });
    const item = { file: 'a', find: 'original', replace: 'broken', command: 'check', source: 'spec' };
    const run = async () => ({ exit: readFileSync(join(root, 'a'), 'utf8').includes('broken') ? 1 : 0, output: 'failed', ms: 1 });
    assert.equal((await executeMutation(root, item, ['check'], run, 1)).ok, true);
    assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'original\n');
    assert.equal((await executeMutation(root, item, ['check'], async () => ({ exit: 0 }), 1)).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const section = items => `## 反向实验\n\`\`\`json\n${JSON.stringify(items)}\n\`\`\`\n`;
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ar-mutation-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'test']);
  git(root, ['config', 'user.email', 'test@example.test']);
  writeFileSync(join(root, '.gitignore'), '.agent-runs/\n');
  writeFileSync(join(root, 'a'), Buffer.from('original\r\n'));
  git(root, ['add', '.gitignore', 'a']);
  git(root, ['commit', '-qm', 'test']);
  return { root, base: git(root, ['rev-parse', 'HEAD']).trim(), dir: join(root, '.agent-runs', 'test') };
}
const check = `node -e "if(require('fs').readFileSync('a','utf8').includes('broken')){console.error('caught');process.exit(1)}"`;
const item = { file: 'a', find: 'original', replace: 'broken', command: check, expect: 'caught' };
async function gate(f, options = {}) {
  return runGate({ ...f, spec: { allowed_paths: ['**'], verify: [check], mutation_body: section([item]), ...options.spec }, ...options.args });
}
test('真实门禁恢复并记录', async t => {
  const f = fixture(t), before = git(f.root, ['status', '--porcelain']), bytes = readFileSync(join(f.root, 'a'));
  const result = await gate(f);
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.mutations[0].ok, true);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'gate.json'), 'utf8')).mutations, result.mutations);
  assert.deepEqual(readFileSync(join(f.root, 'a')), bytes);
  assert.equal(git(f.root, ['status', '--porcelain']), before);
});
test('反向实验失败情形', async t => {
  const f = fixture(t);
  const pass = 'node -e "process.exit(0)"';
  let result = await gate(f, { spec: { verify: [pass], mutation_body: section([{ ...item, command: pass }]) } });
  assert.equal(result.ok, false); assert.match(result.summary, /反向实验 1 没有让检查失败：/);
  result = await gate(f, { spec: { mutation_body: section([{ ...item, expect: 'absent' }]) } });
  assert.equal(result.ok, false); assert.match(result.summary, /失败输出里没有/);
  const timeout = `node -e "if(require('fs').readFileSync('a','utf8').includes('broken'))setTimeout(()=>{},4000)"`;
  result = await gate(f, { spec: { verify: [timeout], mutation_body: section([{ ...item, command: timeout }]) }, args: { verifyTimeoutMs: 1200 } });
  assert.equal(result.ok, false); assert.match(result.summary, /超时/); assert.equal(result.mutations[0].timedOut, true);
});
test('验收失败数量不足及只读', async t => {
  const f = fixture(t), fail = 'node -e "process.exit(1)"';
  let result = await gate(f, { spec: { verify: [fail] } });
  assert.equal(result.ok, false); assert.equal(Object.hasOwn(result, 'mutations'), false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(f.dir, 'gate.json'), 'utf8')), 'mutations'), false);
  result = await gate(f, { spec: { mutations_required: 2 } });
  assert.match(result.summary, /需要至少 2 个反向实验，说明和汇报里共 1 个/);
  result = await gate(f, { spec: { mutations_required: 2 }, args: { readOnly: true } });
  assert.equal(result.ok, true); assert.equal(Object.hasOwn(result, 'mutations'), false);
});
test('字段校验定位', async t => {
  const f = fixture(t);
  for (const [change, field] of [[{find:'missing'}, 'find'], [{find:'i'}, 'find'], [{command:'other'}, 'command'], [{file:'../a'}, 'file'], [{file:join(f.root,'a')}, 'file']]) {
    const result = await gate(f, { spec: { mutation_body: section([{ ...item, ...change }]) } });
    assert.equal(result.ok, false); assert.match(result.summary, new RegExp(`spec 第 1 项.*${field}`));
  }
});

test('find 重叠出现也算多次', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'a'), 'aaa\n');
  git(f.root, ['commit', '-qam', 'overlap']);
  const result = await gate(f, { spec: { mutation_body: section([{ ...item, find: 'aa' }]) } });
  assert.equal(result.ok, false); assert.match(result.summary, /spec 第 1 项.*find/);
  assert.equal(readFileSync(join(f.root, 'a'), 'utf8'), 'aaa\n');
});

 test('report source index', async t => {
  const f = fixture(t);
  mkdirSync(f.dir, { recursive: true });
  writeFileSync(join(f.dir, 'report.md'), section([{ ...item, file: '../bad' }]), { flag: 'w' });
  const result = await gate(f);
  assert.match(result.summary, /report \u7b2c 1 \u9879.*file/);
});

test('full output matching', async () => {
  const result = await runCommand(`node -e "process.stdout.write('marker'+ 'x'.repeat(300000));process.exit(1)"`, { expect: 'marker' });
  assert.equal(result.expectMatched, true);
  assert.equal(result.truncated, true);
  assert.equal(result.output.includes('marker'), false);
});

test('regate runs report mutation', async t => {
  const command = `node -e "if(require('fs').readFileSync('src/a.js','utf8').includes('broken')){console.error('caught');process.exit(1)}"`;
  const mutation = { file: 'src/a.js', find: '\u6539\u8fc7', replace: 'broken', command, expect: 'caught' };
  const f = pipelineFixture(t, { executor: { report: section([mutation]) } });
  const spec = f.spec('docs/specs/379-regate.md', { verify: [command] });
  const dispatched = await f.dispatch(spec, 'mutation-regate');
  assert.equal(dispatched.code, 0, JSON.stringify(dispatched));
  const dir = f.events('mutation-regate').find(row => row.event === 'worktree').dir;
  const before = readFileSync(path.join(dir, 'src/a.js'));
  const retry = await f.json(['retry', 'mutation-regate', '--regate']);
  assert.equal(retry.code, 0, JSON.stringify(retry));
  const result = JSON.parse(readFileSync(path.join(f.dir('mutation-regate'), 'attempts', '2', 'gate.json'), 'utf8'));
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.mutations[0].ok, true);
  assert.deepEqual(readFileSync(path.join(dir, 'src/a.js')), before);
  assert.match(f.progress('mutation-regate'), /\u53cd\u5411\u5b9e\u9a8c\u547d\u4ee4[\s\S]*caught/);
  assert.equal(Object.hasOwn(result.mutations[0], 'find'), false);
  assert.equal(Object.hasOwn(result.mutations[0], 'replace'), false);
  assert.equal(Object.hasOwn(result.mutations[0], 'output'), false);
});
