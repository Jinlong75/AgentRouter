import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../../core/lib/config.mjs';

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
