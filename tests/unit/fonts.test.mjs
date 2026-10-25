import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyFontsFromBase } from '../../tools/fonts.mjs';

// 093：fonts.mjs --from-base 的复制逻辑。全部用系统临时目录和桩下载函数，不联网。
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const GOOD = Buffer.from('字体内容 A');
const BAD = Buffer.from('被改过的字体内容');
const file = 'build/fonts/测试 字体.ttf';

function setup(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ar-093-fonts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '主工作区');
  const out = path.join(root, '工作区');
  mkdirSync(base);
  mkdirSync(out);
  const put = (dir, bytes) => {
    mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(dir, file), bytes);
  };
  const calls = [];
  const logs = [];
  // 桩下载：记录调用，把正确内容写到 out 下（和真实的下载一样写当前目录）；fail 给出时抛错。
  const stub = ({ fail } = {}) => async () => {
    calls.push('download');
    if (fail) throw Error(fail);
    put(out, GOOD);
  };
  const run = (options = {}) => copyFontsFromBase({
    base, out, log: line => logs.push(line),
    fonts: [{ name: '测试字体', file, hash: sha(GOOD), download: stub() }], ...options,
  });
  return { root, base, out, put, calls, logs, stub, run };
}
// 目录树快照：相对路径（含目录）与文件字节，用来确认主工作区没被写。
function snapshot(dir) {
  const rows = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      rows.push(`${path.relative(dir, full)}${entry.isDirectory() ? '/' : `:${sha(readFileSync(full))}`}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return rows.sort();
}

test('已有且 SHA-256 正确：跳过，不复制也不下载', async t => {
  const s = setup(t);
  s.put(s.out, GOOD);
  s.put(s.base, GOOD);
  const result = await s.run();
  assert.deepEqual(result, [{ name: '测试字体', action: 'existing' }]);
  assert.deepEqual(s.logs, ['测试字体：已有（SHA-256 一致）']);
  assert.deepEqual(s.calls, []);
});

test('已有但哈希不符、主工作区有正确文件：覆盖为主工作区的文件', async t => {
  const s = setup(t);
  s.put(s.out, BAD);
  s.put(s.base, GOOD);
  const result = await s.run();
  assert.equal(result[0].action, 'copied');
  assert.deepEqual(readFileSync(path.join(s.out, file)), GOOD);
});

test('从主工作区复制：字节一致，输出一行中文且不含主工作区路径', async t => {
  const s = setup(t);
  s.put(s.base, GOOD);
  const result = await s.run();
  assert.deepEqual(result, [{ name: '测试字体', action: 'copied' }]);
  assert.deepEqual(readFileSync(path.join(s.out, file)), GOOD);
  assert.deepEqual(s.logs, ['测试字体：从主工作区复制（SHA-256 一致）']);
  assert.ok(!s.logs.join('\n').includes(s.base));
  assert.deepEqual(s.calls, [], '不联网');
});

test('主工作区文件哈希不符：改为联网下载（桩）', async t => {
  const s = setup(t);
  s.put(s.base, BAD);
  const result = await s.run();
  assert.deepEqual(result, [{ name: '测试字体', action: 'downloaded' }]);
  assert.deepEqual(s.calls, ['download']);
  assert.match(s.logs[0], /^测试字体：联网下载/);
  assert.deepEqual(readFileSync(path.join(s.out, file)), GOOD);
});

test('主工作区没有这个字体：联网下载（桩）', async t => {
  const s = setup(t);
  const result = await s.run();
  assert.deepEqual(result, [{ name: '测试字体', action: 'downloaded' }]);
  assert.deepEqual(s.calls, ['download']);
});

test('没有 AR_BASE_REPO（base 为空）：直接联网下载', async t => {
  const s = setup(t);
  s.put(s.base, GOOD);
  const result = await s.run({ base: '' });
  assert.equal(result[0].action, 'downloaded');
  assert.deepEqual(s.logs, ['测试字体：联网下载']);
});

test('下载失败：抛出带字体名和原因的中文错误，其他字体照常处理', async t => {
  const s = setup(t);
  const other = 'build/fonts/另一个.ttf';
  s.put(s.base, GOOD);
  mkdirSync(path.join(s.base, 'build/fonts'), { recursive: true });
  writeFileSync(path.join(s.base, other), GOOD);
  await assert.rejects(
    s.run({
      fonts: [
        { name: '坏字体', file: 'build/fonts/坏.ttf', hash: sha(GOOD), download: s.stub({ fail: 'HTTP 503' }) },
        { name: '另一个', file: other, hash: sha(GOOD), download: s.stub() },
      ],
    }),
    error => /^坏字体：联网下载失败（HTTP 503）$/.test(error.message),
  );
  assert.deepEqual(readFileSync(path.join(s.out, other)), GOOD, '失败不影响后面的字体');
});

test('主工作区与当前目录相同：已有就跳过，没有就下载，不自己复制给自己', async t => {
  const s = setup(t);
  s.put(s.base, GOOD);
  let result = await s.run({ out: s.base });
  assert.equal(result[0].action, 'existing');
  rmSync(path.join(s.base, file));
  result = await s.run({ out: s.base });
  assert.equal(result[0].action, 'downloaded', '同一个目录里没有文件时直接下载');
  assert.deepEqual(s.calls, ['download']);
});

test('只读主工作区：复制、下载、失败各种情况下都不往里面写任何东西，也不建目录', async t => {
  const s = setup(t);
  // 主工作区只有一个无关文件，没有 build/ 目录。
  writeFileSync(path.join(s.base, 'README.md'), '说明');
  const before = snapshot(s.base);
  await s.run();
  assert.deepEqual(snapshot(s.base), before, '主工作区没有字体时');
  assert.ok(!existsSync(path.join(s.base, 'build')));
  s.put(s.base, GOOD);
  const withFont = snapshot(s.base);
  rmSync(path.join(s.out, file));
  await s.run();
  assert.deepEqual(snapshot(s.base), withFont, '复制之后');
  rmSync(path.join(s.out, file));
  await assert.rejects(s.run({ fonts: [{ name: '测试字体', file: 'build/fonts/没有.ttf', hash: sha(GOOD), download: s.stub({ fail: '断网' }) }] }));
  assert.deepEqual(snapshot(s.base), withFont, '失败之后');
});
