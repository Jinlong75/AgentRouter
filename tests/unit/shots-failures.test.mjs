import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preserveFailures } from '../../tools/shots-failures.mjs';

const now = new Date('2026-10-31T12:34:56.789Z');
const archive = 'failures-20261031-123456-789';
async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-failures-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('非空现场整体改名并保留字节', () => withDir(async dir => {
  const source = path.join(dir, 'failures');
  await fs.mkdir(path.join(source, 'nested'), { recursive: true });
  const bytes = Buffer.from([0, 1, 128, 255]);
  await fs.writeFile(path.join(source, 'nested', 'scene.png'), bytes);
  const result = await preserveFailures(dir, { now });
  assert.equal(result, path.join(dir, archive));
  assert.deepEqual(await fs.readFile(path.join(result, 'nested', 'scene.png')), bytes);
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
}));

test('不存在或空目录返回 null 且不产生归档', () => withDir(async dir => {
  assert.equal(await preserveFailures(dir, { now }), null);
  await fs.mkdir(path.join(dir, 'failures'));
  assert.equal(await preserveFailures(dir, { now }), null);
  assert.deepEqual(await fs.readdir(dir), []);
}));

test('同一时间戳冲突时依次追加后缀', () => withDir(async dir => {
  for (const expected of [archive, `${archive}-2`, `${archive}-3`]) {
    await fs.mkdir(path.join(dir, 'failures'));
    await fs.writeFile(path.join(dir, 'failures', 'scene'), expected);
    assert.equal(await preserveFailures(dir, { now }), path.join(dir, expected));
    assert.equal(await fs.readFile(path.join(dir, expected, 'scene'), 'utf8'), expected);
  }
}));

test('只按名字清理超出数量的归档目录，其他条目不动', () => withDir(async dir => {
  for (const name of ['failures-20260101-000000-000', 'failures-20260201-000000-000', 'other']) await fs.mkdir(path.join(dir, name));
  await fs.writeFile(path.join(dir, 'failures-file'), '保留');
  await fs.mkdir(path.join(dir, 'failures'));
  await fs.writeFile(path.join(dir, 'failures', 'scene'), '现场');
  await preserveFailures(dir, { now, keep: 2 });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['failures-20260201-000000-000', archive, 'failures-file', 'other'].sort());
  assert.equal(await fs.readFile(path.join(dir, 'failures-file'), 'utf8'), '保留');
}));

test('改名失败抛出原错误并保留原现场', () => withDir(async dir => {
  const source = path.join(dir, 'failures');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'scene'), '现场');
  const error = Object.assign(new Error('改名失败'), { code: 'EBUSY' });
  const rename = mock.method(fs, 'rename', async () => { throw error; });
  try { await assert.rejects(preserveFailures(dir, { now }), actual => actual === error); }
  finally { rename.mock.restore(); }
  assert.deepEqual(await fs.readdir(dir), ['failures']);
  assert.equal(await fs.readFile(path.join(source, 'scene'), 'utf8'), '现场');
}));
