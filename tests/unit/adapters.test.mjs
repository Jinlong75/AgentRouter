import test from 'node:test';
import assert from 'node:assert/strict';
import { adapters, adapterFor } from '../../core/adapters/index.mjs';
import { codex } from '../../core/adapters/codex.mjs';
import { claudeCode } from '../../core/adapters/claude-code.mjs';
import { fake, mapLine } from '../../core/adapters/fake.mjs';
import { findOnPath } from '../../core/lib/launcher.mjs';

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
