import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig, loadConfig, writeConfig, updateConfig, formatConfig, configInvalid } from '../../core/lib/config.mjs';

function dirs(t) {
  const home = fs.mkdtempSync(path.join(tmpdir(), '配置无效 '));
  t.after(() => { assert.equal(path.dirname(home), path.resolve(tmpdir())); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, file: path.join(home, 'config.json') };
}
// 协议第 4 节的原文（063）；路径在句尾。action：派发族"这次没有派发"，写入类"这次没有改动配置"。
const line = (reason, file, action = '这次没有派发') => `配置：config.json 无法读取（${reason}）。为免改用你没有选的执行者，${action}。请修好这个文件，或者删掉它（删掉后按内置默认）：${file}`;

test('configInvalid 的文案与 code：两种 action 其余文字一致，arCode 为 CONFIG_INVALID', t => {
  const { file } = dirs(t);
  const state = { file, exists: true, reason: '不是有效的 JSON', config: {} };
  assert.equal(configInvalid(state).message, line('不是有效的 JSON', file));
  assert.equal(configInvalid(state, '这次没有改动配置').message, line('不是有效的 JSON', file, '这次没有改动配置'));
  assert.equal(configInvalid(state).arCode, 'CONFIG_INVALID');
  assert.equal(configInvalid({ ...state, reason: 'v 不是 1 或 2' }).message, line('v 不是 1 或 2', file));
  assert.equal(configInvalid({ ...state, reason: '读取失败：EISDIR' }).message, line('读取失败：EISDIR', file));
});

test('配置无效：loadConfig / formatConfig 拒派发，writeConfig / updateConfig 拒写入，坏文件字节与修改时间不变', t => {
  const { home, file } = dirs(t);
  for (const [bad, reason] of [['{', '不是有效的 JSON'], ['{"v":3}', 'v 不是 1 或 2']]) {
    fs.writeFileSync(file, bad);
    const before = fs.statSync(file);
    for (const [run, action] of [
      [() => loadConfig(home, {}, {}), '这次没有派发'],
      [() => formatConfig(home, {}), '这次没有派发'],
      [() => writeConfig(home, { model: 'x' }), '这次没有改动配置'],
      [() => writeConfig(home, {}, { init: true }), '这次没有改动配置'],
      [() => updateConfig(home, () => {}), '这次没有改动配置'],
    ]) {
      assert.throws(run, error => {
        assert.equal(error.arCode, 'CONFIG_INVALID');
        assert.equal(error.message, line(reason, file, action));
        return true;
      });
    }
    assert.equal(fs.readFileSync(file, 'utf8'), bad);
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs, '坏文件的修改时间不变');
  }
});

test('读取出错（config.json 是目录）同样拒绝，原因里带错误码', t => {
  const { home, file } = dirs(t);
  fs.mkdirSync(file);
  const state = readConfig(home);
  assert.match(state.reason, /^读取失败：/);
  assert.throws(() => loadConfig(home, {}, {}), error => error.arCode === 'CONFIG_INVALID' && error.message === line(state.reason, file));
});

test('没有 config.json：行为不变，仍按内置默认（只提示未找到）', t => {
  const { home, file } = dirs(t);
  const loaded = loadConfig(home, {}, {});
  assert.equal(loaded.reason, null);
  assert.equal(loaded.warning, '配置：未找到 config.json，模型、强度、档位跟随 Codex 自己的配置');
  assert.equal(loaded.profileName, 'codex');
  assert.match(formatConfig(home, {}).split('\n')[0], /执行者：codex（Codex）/);
  assert.ok(!fs.existsSync(file), '显示不写入配置文件');
  writeConfig(home, {}, { init: true });
  assert.ok(fs.existsSync(file), 'config init 在没有配置时照旧写入');
});
