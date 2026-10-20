import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { migrateV1, readConfig, loadConfig, writeConfig, formatConfig, selectProfile, resolveSettings } from '../../core/lib/config.mjs';

function dirs(t) {
  const base = fs.mkdtempSync(path.join(tmpdir(), '配置 v2 '));
  t.after(() => { assert.equal(path.dirname(base), path.resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true }); });
  // 真实布局：新目录 …/agent-router 与旧目录 …/codex-dispatch 同级。
  const home = path.join(base, 'agent-router'), legacy = path.join(base, 'codex-dispatch');
  return { base, home, legacy };
}
const exe = process.execPath;

test('v1 → v2 迁移逐字段对照：agents.codex → profiles.codex，窗口与托管原样，未知字段保留', () => {
  const v1 = { v: 1, extension: { keep: true }, watchWindow: 'never', managed: true,
    agents: { codex: { model: 'm', effort: 'high', tier: 'flex', sandbox: 'read-only', path: exe, future: 1 }, other: { keep: 2 } } };
  assert.deepEqual(migrateV1(v1), {
    extension: { keep: true }, v: 2, defaultProfile: 'codex',
    profiles: { codex: { adapter: 'codex', label: 'Codex', enabled: true, model: 'm', effort: 'high', tier: 'flex', sandbox: 'read-only', path: exe, future: 1 } },
    generics: {}, routing: { rules: [], fallback: null, reviewer: null }, concurrency: 2, managed: true, watchWindow: 'never',
    agents: { other: { keep: 2 } },
  });
  // 缺省的键不补值，来源仍显示"内置默认"
  const empty = migrateV1({ v: 1 });
  assert.deepEqual(empty.profiles.codex, { adapter: 'codex', label: 'Codex', enabled: true });
  assert.equal(empty.managed, false); assert.equal('watchWindow' in empty, false);
  assert.throws(() => migrateV1({ v: 1, agents: [] }), /agents 必须为对象/);
  assert.throws(() => migrateV1({ v: 1, agents: { codex: 'x' } }), /agents\.codex 必须为对象/);
});

test('旧目录 v1 配置：首次读取时迁移写入新目录，旧文件字节不变，提示一次', t => {
  const d = dirs(t);
  fs.mkdirSync(d.legacy);
  const old = JSON.stringify({ v: 1, agents: { codex: { model: '旧模型' } }, managed: true });
  fs.writeFileSync(path.join(d.legacy, 'config.json'), old);
  const first = loadConfig(d.home, {}, {});
  assert.match(first.warning, /已把旧版 config\.json 迁移到 AgentRouter/);
  assert.equal(first.settings.model, '旧模型'); assert.equal(first.profileName, 'codex'); assert.equal(first.config.managed, true);
  assert.equal(fs.readFileSync(path.join(d.legacy, 'config.json'), 'utf8'), old);
  const written = JSON.parse(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8'));
  assert.equal(written.v, 2); assert.equal(written.profiles.codex.model, '旧模型');
  assert.equal(loadConfig(d.home, {}, {}).warning, null);
});

test('显式指定的公共目录（测试隔离）不查旧目录；新目录里的 v1 文件按 v2 解读但不改写', t => {
  const d = dirs(t), isolated = path.join(d.base, '隔离');
  fs.mkdirSync(d.legacy); fs.writeFileSync(path.join(d.legacy, 'config.json'), JSON.stringify({ v: 1, agents: { codex: { model: '不该读到' } } }));
  assert.equal(readConfig(isolated).legacy, undefined);
  fs.mkdirSync(d.home);
  const v1 = JSON.stringify({ v: 1, agents: { codex: { model: '新目录 v1' } } });
  fs.writeFileSync(path.join(d.home, 'config.json'), v1);
  const state = loadConfig(d.home, {}, {});
  assert.equal(state.warning, '配置：config.json 是旧版本，已按 v2 解读'); assert.equal(state.settings.model, '新目录 v1');
  assert.equal(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8'), v1);
  writeConfig(d.home, { effort: 'low' });
  const after = JSON.parse(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8'));
  assert.equal(after.v, 2); assert.equal(after.profiles.codex.model, '新目录 v1'); assert.equal(after.profiles.codex.effort, 'low');
});

test('profile 选择：--profile > AR_PROFILE > defaultProfile > 唯一启用；停用与不存在报错', () => {
  const config = { v: 2, defaultProfile: 'a', profiles: { a: { adapter: 'fake' }, b: { adapter: 'fake' }, off: { adapter: 'fake', enabled: false } } };
  assert.equal(selectProfile(config, { profile: 'b' }, { AR_PROFILE: 'a' }).profileName, 'b');
  assert.equal(selectProfile(config, {}, { AR_PROFILE: 'b' }).profileName, 'b');
  assert.equal(selectProfile(config, {}, {}).profileName, 'a');
  assert.equal(selectProfile({ v: 2, profiles: { only: { adapter: 'fake' }, off: { adapter: 'fake', enabled: false } } }, {}, {}).profileName, 'only');
  assert.throws(() => selectProfile({ v: 2, profiles: { a: { adapter: 'fake' }, b: { adapter: 'fake' } } }, {}, {}), /^Error: 有多个可用的执行者（a、b），请用 --profile 指定/);
  assert.throws(() => selectProfile({ v: 2 }, {}, {}), /还没有可用的执行者：在软件的 Agent 页导入/);
  assert.throws(() => selectProfile(config, { profile: 'off' }, {}), /^Error: 执行者 off 已停用$/);
  assert.throws(() => selectProfile(config, { profile: 'none' }, {}), /^Error: 找不到执行者：none$/);
});

test('CODEX_* 环境变量只作用于 codex 执行者；v2 字段类型校验', () => {
  const config = { v: 2, profiles: { codex: { adapter: 'codex', model: 'file' }, fake: { adapter: 'fake' } } };
  assert.equal(resolveSettings(config, {}, { CODEX_MODEL: 'env' }, 'codex').settings.model, 'env');
  assert.equal(resolveSettings(config, {}, { CODEX_MODEL: 'env' }, 'fake').settings.model, null);
  for (const [bad, pattern] of [[{ profiles: [] }, /profiles 必须为对象/], [{ profiles: { x: 1 } }, /profiles\.x 必须为对象/], [{ profiles: { x: {} } }, /profiles\.x\.adapter/],
    [{ profiles: { x: { adapter: 'fake', enabled: 'yes' } } }, /enabled 必须为布尔值/], [{ profiles: { x: { adapter: 'fake', secrets: { K: 1 } } } }, /secrets 必须为字符串映射/],
    [{ profiles: { c: { adapter: 'codex', path: 'relative' } } }, /path 必须是绝对路径/], [{ watchWindow: 'bad' }, /watchWindow/]]) {
    assert.throws(() => resolveSettings({ v: 2, ...bad }, {}, {}), pattern);
  }
});

test('ar config 显示当前执行者；没有可用执行者时说明原因', t => {
  const d = dirs(t);
  assert.match(formatConfig(d.home, {}).split('\n')[0], /执行者：codex（Codex）/);
  fs.mkdirSync(d.home); fs.writeFileSync(path.join(d.home, 'config.json'), '{"v":2,"profiles":{}}');
  assert.match(formatConfig(d.home, {}).split('\n')[0], /执行者：无（还没有可用的执行者/);
  assert.throws(() => loadConfig(d.home, {}, {}), /还没有可用的执行者/);
});

test('默认执行者不是 Codex 时：Codex 设置仍写进 codex profile，不改默认执行者；ar config 显示 Codex 的设置并说明', t => {
  const d = dirs(t);
  fs.mkdirSync(d.home);
  const deepseek = { adapter: 'claude-code', label: '示例执行者', enabled: true, env: { ANTHROPIC_MODEL: 'example-model' }, auth: 'token', secrets: { ANTHROPIC_AUTH_TOKEN: 'EXAMPLE_KEY' } };
  fs.writeFileSync(path.join(d.home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'deepseek', profiles: { codex: { adapter: 'codex', label: 'Codex', enabled: true }, deepseek } }));
  writeConfig(d.home, { model: 'codex-model', sandbox: 'read-only' });
  const after = JSON.parse(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8'));
  assert.deepEqual(after.profiles.deepseek, deepseek, '默认执行者（非 Codex）不被写入 Codex 设置');
  assert.equal(after.profiles.codex.model, 'codex-model'); assert.equal(after.profiles.codex.sandbox, 'read-only');
  assert.equal(after.defaultProfile, 'deepseek');
  const lines = formatConfig(d.home, {}).split('\n');
  assert.match(lines[0], /执行者：deepseek（示例执行者）/);
  assert.equal(lines[1], '以下是 Codex 执行者（可选）的设置：');
  assert.match(lines[2], /^model\s+codex-model\s+config\.json$/);
});
