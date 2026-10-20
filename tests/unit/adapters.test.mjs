import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapters, adapterFor } from '../../core/adapters/index.mjs';
import { codex } from '../../core/adapters/codex.mjs';
import { claudeCode } from '../../core/adapters/claude-code.mjs';
import { fake, mapLine } from '../../core/adapters/fake.mjs';
import { findOnPath } from '../../core/lib/launcher.mjs';
import { profileConfig } from '../../core/lib/run.mjs';

test('注册表：按 profile.adapter 取适配器，未知类型报错并列出可用项', () => {
  assert.deepEqual(Object.keys(adapters), ['codex', 'claude-code', 'fake']);
  assert.equal(adapterFor({ adapter: 'codex' }), codex);
  assert.equal(adapterFor({ adapter: 'claude-code' }), claudeCode);
  assert.equal(adapterFor({ adapter: 'fake' }), fake);
  assert.throws(() => adapterFor({ adapter: 'qoder' }), /^Error: 不支持的执行者类型：qoder（可用：codex、claude-code、fake）$/);
  assert.throws(() => adapterFor(undefined), /不支持的执行者类型/);
  for (const adapter of Object.values(adapters)) {
    for (const key of ['id', 'label', 'detect', 'command', 'mapLine']) assert.ok(adapter[key] !== undefined, `${adapter.id}.${key}`);
    assert.equal(typeof adapter.writesReport, 'boolean');
  }
});

test('fake：默认与自定义回放说明、参数数组启动、无效说明报错', () => {
  assert.deepEqual(fake.detect({}), { installed: true, version: 'fake-agent 1.0' });
  assert.equal(fake.detect({ profile: { version: 'fake 9' } }).version, 'fake 9');
  assert.equal(fake.detect({ profile: { exit: 'x' } }).installed, false);
  const command = fake.command({ report: 'C:\\汇报.md', prompt: '任务', profile: { events: [{ kind: 'say', text: '你好' }], exit: 4, other: 'ignored' } });
  assert.equal(command.executable, process.execPath); assert.equal(command.args[0], '-e'); assert.equal(command.stdin, '任务');
  assert.deepEqual(JSON.parse(command.args[2]), { events: [{ kind: 'say', text: '你好' }], report: 'OK\n', exit: 4, delayMs: 0 });
  assert.equal(command.args[3], 'C:\\汇报.md');
  assert.throws(() => fake.command({ report: 'x', prompt: '', profile: { events: 'x' } }), /fake 执行者/);
});

test('fake：只接受已知种类的统一事件，非 JSON 行记为文本', () => {
  assert.deepEqual(mapLine('{"kind":"say","text":"好"}'), [{ kind: 'say', text: '好' }]);
  assert.deepEqual(mapLine('{"kind":"unknown"}'), []);
  assert.deepEqual(mapLine('[1]'), []);
  assert.deepEqual(mapLine('普通输出'), [{ kind: 'text', text: '普通输出' }]);
  assert.deepEqual(mapLine('  '), []);
});

test('launcher：PATH 里找不到时返回 null', () => {
  assert.equal(findOnPath(['不存在的程序.exe'], { PATH: '' }), null);
});

// 024：fake 的放行文件（只用于测试与演示）。真实启动子进程，按"看到事件输出、进程仍在运行、汇报出现"判断，不靠计时猜测。
function runFake(profile, report) {
  const command = fake.command({ report, prompt: '任务', profile });
  const child = spawn(command.executable, command.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => stdout += d);
  child.stderr.on('data', d => stderr += d);
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code })); });
  child.stdin.end(command.stdin);
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ar-fake-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function until(fn, label, timeoutMs = 10000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error(`等待超时：${label}`);
}

test('fake：不设置 releaseFile 时行为不变（写完汇报立即按 exit 结束，回放说明不多字段）', async t => {
  const dir = tempDir(t), report = join(dir, 'report.md');
  const { closed, stdout } = runFake({ events: [{ kind: 'say', text: '你好' }], report: '完成\n', exit: 5 }, report);
  const { code } = await closed;
  assert.equal(code, 5);
  assert.equal(readFileSync(report, 'utf8'), '完成\n');
  assert.match(stdout(), /"kind":"say"/);
  // 没有放行文件时参数与原来一致：逐字节不带 releaseFile / releaseTimeoutMs。
  const command = fake.command({ report, prompt: '', profile: {} });
  assert.deepEqual(JSON.parse(command.args[2]), { events: [{ kind: 'say', text: '假执行者已完成。' }], report: 'OK\n', exit: 0, delayMs: 0 });
});

test('fake：设置 releaseFile 后，文件出现前不写汇报且仍在运行，出现后写汇报并按 exit 结束', async t => {
  const dir = tempDir(t), report = join(dir, 'report.md'), release = join(dir, 'release');
  const { child, closed, stdout } = runFake({ events: [{ kind: 'say', text: '等放行' }], report: '放行完成\n', exit: 3, releaseFile: release, releaseTimeoutMs: 60000 }, report);
  // 事件已经输出，说明回放完成、进程进入等放行；此时不能有汇报。
  await until(() => stdout().includes('等放行'), '回放事件输出');
  assert.equal(child.exitCode, null, '放行前进程应仍在运行');
  assert.equal(existsSync(report), false, '放行前不应写汇报');
  writeFileSync(release, '1');
  const { code } = await closed;
  assert.equal(code, 3, '出现放行文件后按 exit 结束');
  assert.equal(readFileSync(report, 'utf8'), '放行完成\n');
});

test('fake：等待放行超时以非 0 退出且不写汇报', async t => {
  const dir = tempDir(t), report = join(dir, 'report.md');
  const { closed, stderr } = runFake({ report: '不该出现的汇报\n', releaseFile: join(dir, 'never'), releaseTimeoutMs: 150 }, report);
  const { code } = await closed;
  assert.notEqual(code, 0, '超时必须以非 0 退出');
  assert.equal(existsSync(report), false, '超时不应写汇报');
  assert.match(stderr(), /放行/);
});

test('fake：releaseFile / releaseTimeoutMs 非法值报中文错误；放行字段随执行者快照带给执行者进程', () => {
  assert.throws(() => fake.command({ report: 'x', prompt: '', profile: { releaseFile: 42 } }), /releaseFile 无效/);
  assert.throws(() => fake.command({ report: 'x', prompt: '', profile: { releaseFile: '  ' } }), /releaseFile 无效/);
  assert.throws(() => fake.command({ report: 'x', prompt: '', profile: { releaseFile: 'C:\\r', releaseTimeoutMs: 0 } }), /releaseTimeoutMs 无效/);
  assert.throws(() => fake.command({ report: 'x', prompt: '', profile: { releaseFile: 'C:\\r', releaseTimeoutMs: 1.5 } }), /releaseTimeoutMs 无效/);
  assert.equal(fake.detect({ profile: { releaseFile: 42 } }).installed, false);
  assert.deepEqual(fake.snapshotKeys, ['events', 'report', 'exit', 'delayMs', 'version', 'releaseFile', 'releaseTimeoutMs']);
  assert.deepEqual(profileConfig({ adapter: 'fake', events: [], releaseFile: 'C:\\r\\release', releaseTimeoutMs: 1000, price: { inputPer1M: 1 } }, fake),
    { env: {}, secrets: {}, auth: null, maxTurns: null, label: null, adapter: 'fake', path: null, events: [], releaseFile: 'C:\\r\\release', releaseTimeoutMs: 1000 });
});
