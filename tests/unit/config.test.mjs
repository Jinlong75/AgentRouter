import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig, slotLimits } from '../../core/lib/config.mjs';

// 注入读取函数模拟不同平台的错误码：公共目录被一个文件占着时，Linux 读 config.json 得到 ENOTDIR，Windows 得到 ENOENT，
// 在 Windows 上没法用真实的文件系统构造 ENOTDIR。
const failWith = code => () => { throw Object.assign(Error(`${code}: 模拟的读取错误`), { code }); };
const home = path.join(tmpdir(), 'ar-config-enotdir', 'home');

test('读配置遇到 ENOTDIR 与 ENOENT 一样按"没有配置"处理，不算读取出错', () => {
  for (const code of ['ENOENT', 'ENOTDIR']) {
    const state = readConfig(home, failWith(code));
    assert.equal(state.exists, false, code);
    assert.equal(state.reason, null, code);
    assert.deepEqual(state.config, {}, code);
    assert.equal(state.file, path.join(home, 'config.json'));
  }
});

test('其他读取错误码（EACCES、EISDIR）仍然是配置无效，原因里带错误码', () => {
  for (const code of ['EACCES', 'EISDIR']) {
    const state = readConfig(home, failWith(code));
    assert.equal(state.exists, true, code);
    assert.equal(state.reason, `读取失败：${code}`, code);
  }
});

test('旧目录的 config.json 读到 ENOTDIR 同样当作没有，不带回迁移内容', () => {
  const reads = [];
  const state = readConfig(home, file => { reads.push(file); throw Object.assign(Error('x'), { code: 'ENOTDIR' }); });
  assert.equal(state.exists, false);
  assert.equal(state.reason, null);
  assert.equal(state.legacy, undefined);
  assert.ok(reads.length >= 1);
});

// 并行调度（140）：concurrency 可以是 1～8 的整数或 "auto"；用 probe 注入核数与可用内存，不依赖本机。
const GB = 1024 ** 3;
const probe = { cores: 16, freeMemBytes: 12 * GB };

test('concurrency: "auto"：limits.concurrency 是估算值，mode / estimate / max 同时给出', () => {
  const result = slotLimits({ concurrency: 'auto' }, probe);
  assert.equal(result.mode, 'auto');
  assert.equal(result.estimate, 4);
  assert.equal(result.max, 8);
  assert.equal(result.limits.concurrency, 4);
  assert.equal(result.sources.concurrency, 'config.json');
  assert.deepEqual(result.warnings, []);
  // concurrencyMax 只在自动档限制估算值。
  const capped = slotLimits({ concurrency: 'auto', concurrencyMax: 3 }, { cores: 64, freeMemBytes: 64 * GB });
  assert.equal(capped.limits.concurrency, 3);
  assert.equal(capped.max, 3);
  assert.equal(capped.maxSource, 'config.json');
  const fixed = slotLimits({ concurrency: 6, concurrencyMax: 2 }, probe);
  assert.equal(fixed.mode, 'fixed');
  assert.equal(fixed.limits.concurrency, 6);
});

test('concurrency 的固定值：1～8 的整数有效，没写默认 2；0、9、"x"、1.5 按默认处理并提示', () => {
  assert.equal(slotLimits({}, probe).limits.concurrency, 2);
  assert.equal(slotLimits({}, probe).mode, 'fixed');
  for (const good of [1, 2, 8]) assert.equal(slotLimits({ concurrency: good }, probe).limits.concurrency, good);
  for (const bad of [0, 9, 'x', 1.5, -1, null, 'AUTO']) {
    const result = slotLimits({ concurrency: bad }, probe);
    assert.equal(result.limits.concurrency, 2, String(bad));
    assert.equal(result.sources.concurrency, '内置默认', String(bad));
    assert.equal(result.mode, 'fixed', String(bad));
    assert.deepEqual(result.warnings, ['配置：concurrency 必须为 1～8 的整数或 "auto"，已按默认值 2 处理'], String(bad));
  }
});

// 182（D114）：memLowPercent 是 1～50 的整数，默认 5；不合法按默认处理并提示。
test('memLowPercent：1～50 的整数，默认 5；其他值按默认并提示', () => {
  const none = slotLimits({}, probe);
  assert.equal(none.memLowPercent, 5);
  assert.equal(none.memLowSource, '内置默认');
  assert.deepEqual(none.warnings, []);
  for (const good of [1, 3, 10, 50]) {
    const result = slotLimits({ concurrency: 'auto', memLowPercent: good }, probe);
    assert.equal(result.memLowPercent, good);
    assert.equal(result.memLowSource, 'config.json');
    assert.deepEqual(result.warnings, []);
  }
  for (const bad of [0, 51, 2.5, '10', null, -5, [10]]) {
    const result = slotLimits({ memLowPercent: bad }, probe);
    assert.equal(result.memLowPercent, 5, String(bad));
    assert.equal(result.memLowSource, '内置默认', String(bad));
    assert.deepEqual(result.warnings, ['配置：memLowPercent 必须为 1～50 的整数，已按默认值 5 处理'], String(bad));
  }
});

test('concurrencyMax：1～8 的整数，默认 8；其他值按默认并提示', () => {
  assert.equal(slotLimits({}, probe).max, 8);
  assert.equal(slotLimits({ concurrencyMax: 5 }, probe).max, 5);
  for (const bad of [0, 9, 'x', 2.5, null]) {
    const result = slotLimits({ concurrency: 'auto', concurrencyMax: bad }, { cores: 64, freeMemBytes: 64 * GB });
    assert.equal(result.max, 8, String(bad));
    assert.equal(result.limits.concurrency, 8, String(bad));
    assert.deepEqual(result.warnings, ['配置：concurrencyMax 必须为 1～8 的整数，已按默认值 8 处理'], String(bad));
  }
});
