import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interactiveLaunch as claude } from '../../core/adapters/claude-code.mjs';
import { interactiveLaunch as codex } from '../../core/adapters/codex.mjs';
import { interactiveLaunch as generic } from '../../core/adapters/generic.mjs';
import { validateGeneric } from '../../core/lib/generic-schema.mjs';
import { validateV2 } from '../../core/lib/config.mjs';

test('交互启动参数保留为数组，通用模板支持子串', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-lead-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'fake.js'); writeFileSync(script, '');
  const env = { AR_TEST_AGENT: 'fake-agent.js' };
  assert.deepEqual(claude({}, { model: 'm x', effort: 'high', env }).args.slice(-4), ['--model', 'm x', '--effort', 'high']);
  // 改写（主导，295 实测）：原期望 model_reasoning_effort="high" → model_reasoning_effort=high（主导启动的单词强度不加引号，经 cmd.exe 打开时不会被安全检查拒绝；codex 的 -c 解析不了 TOML 就当原文）。
  assert.deepEqual(codex({}, { model: 'm x', effort: 'high', env }).args.slice(-4), ['-m', 'm x', '-c', 'model_reasoning_effort=high']);
  const profile = { generic: { executable: script, interactive: { args: ['start'], model: ['--model={model}'] } } };
  assert.deepEqual(generic(profile, { model: 'a b' }), { executable: process.execPath, args: [script, 'start', '--model=a b'], capabilities: { model: true, effort: false } });
  assert.equal(generic({ generic: {} }), null);
});

test('配置与声明校验主导字段', () => {
  for (const value of ['', ' ', null, 1]) assert.throws(() => validateV2({ v: 2, lead: value }), /config.json 的 lead 必须为执行者名/);
  assert.doesNotThrow(() => validateV2({ v: 2, lead: 'missing' }));
  const base = { label: '测试', executable: 'fake', args: [] };
  for (const value of [[], ['x'], ['{model}', '{model}'], [1]]) {
    const checked = validateGeneric({ ...base, interactive: { model: value } });
    assert.ok(checked.errors.some(e => e.message === 'interactive.model 必须是字符串数组，且恰好一项含 {model}'));
  }
});

test('三个适配器解析 npm 的 cmd 包装为 Node 入口', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-lead-wrapper-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'agent.js'), wrapper = join(dir, 'agent.cmd');
  writeFileSync(script, '');
  writeFileSync(wrapper, '@"%dp0%\\agent.js" %*\r\n');
  const decl = { label: '测试', executable: wrapper, interactive: { args: [] } };
  for (const result of [claude({ path: wrapper }), codex({ path: wrapper }), generic({ generic: decl })]) {
    assert.equal(result.executable, process.execPath);
    assert.equal(result.args[0], script);
  }
});

test('通用适配器的普通批处理包装保留执行者启动参数', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-lead-batch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wrapper = join(dir, 'agent.cmd'); writeFileSync(wrapper, '@exit /b 0\r\n');
  const result = generic({ generic: { label: '测试', executable: wrapper, interactive: { args: ['hello world'] } } }, { env: { ComSpec: 'cmd.exe' } });
  assert.equal(result.executable, 'cmd.exe');
  assert.equal(result.verbatim, true);
  assert.deepEqual(result.args, ['/d', '/s', '/c', `""${wrapper}" "hello world""`]);
});
