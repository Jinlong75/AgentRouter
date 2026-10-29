import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { updateConfig } from '../../core/lib/config.mjs';

// 192：Windows 上 config.json 的原子替换可能收到 EPERM / EBUSY（占用来源尚未确认）。
// 用 syncBuiltinESMExports 把替换过的 fs.renameSync 同步到 config.mjs 的具名导入（不新增产品接口）；
// 每个用例结束都恢复，node --test 每个文件一个进程，不会污染其他测试文件。
const realRename = fs.renameSync;
const restoreRename = () => { fs.renameSync = realRename; syncBuiltinESMExports(); };
function mockRename(t, handler) {
  const state = { calls: 0 };
  fs.renameSync = (from, to) => { state.calls += 1; return handler(from, to, state.calls); };
  syncBuiltinESMExports();
  t.after(restoreRename);
  return state;
}
// 记录 Atomics.wait 的间隔参数，同时真实等待，墙钟断言仍然有效；用例结束恢复。
const realWait = Atomics.wait;
function mockWait(t) {
  const timeouts = [];
  Atomics.wait = (typedArray, index, value, timeout) => { timeouts.push(timeout); return realWait(typedArray, index, value, timeout); };
  t.after(() => { Atomics.wait = realWait; });
  return timeouts;
}
// rm 失败注入：临时文件删不掉；返回恢复函数，用例结束前显式恢复，t.after 再兜底一次（恢复是幂等的）。
const realRm = fs.rmSync;
function mockRmFailure(t, code) {
  fs.rmSync = () => { throw Object.assign(new Error(`模拟 ${code}`), { code }); };
  syncBuiltinESMExports();
  const restore = () => { fs.rmSync = realRm; syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}
const failWith = code => () => { throw Object.assign(new Error(`模拟 ${code}`), { code }); };
const windowsOnly = { skip: process.platform !== 'win32' ? '重试只在 Windows 上生效' : false };
const expected = managed => ({ v: 2, managed, defaultProfile: null });

function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'ar-config-atomic-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(expected(false), null, 2)}\n`);
  return home;
}
const configFile = home => join(home, 'config.json');
const temps = home => readdirSync(home).filter(name => /^\.config-.+\.tmp$/.test(name));

test('rename 首次就成功：只调用一次，写入预期 JSON，不留下临时文件', t => {
  const home = makeHome(t);
  const renames = mockRename(t, (from, to) => realRename(from, to));
  updateConfig(home, config => { config.managed = true; });
  assert.equal(renames.calls, 1);
  assert.deepEqual(JSON.parse(readFileSync(configFile(home), 'utf8')), expected(true));
  assert.deepEqual(temps(home), []);
});

test('首次 EPERM、之后可成功：短暂等待后重试写入，旧配置被替换，无残留', windowsOnly, t => {
  const home = makeHome(t);
  const waits = mockWait(t);
  const renames = mockRename(t, (from, to, calls) => {
    if (calls === 1) failWith('EPERM')();
    return realRename(from, to);
  });
  const started = Date.now();
  updateConfig(home, config => { config.managed = true; });
  const elapsed = Date.now() - started;
  assert.equal(renames.calls, 2);
  assert.ok(elapsed >= 40, `两次尝试之间应等待约 50ms（实际 ${elapsed}ms）`);
  assert.deepEqual(waits, [50], '重试间隔应精确为 50ms');
  assert.deepEqual(JSON.parse(readFileSync(configFile(home), 'utf8')), expected(true));
  assert.deepEqual(temps(home), []);
});

test('EBUSY 短暂占用同样有界重试', windowsOnly, t => {
  const home = makeHome(t);
  const waits = mockWait(t);
  const renames = mockRename(t, (from, to, calls) => {
    if (calls <= 2) failWith('EBUSY')();
    return realRename(from, to);
  });
  updateConfig(home, config => { config.managed = true; });
  assert.equal(renames.calls, 3);
  assert.deepEqual(waits, [50, 50], '每次重试间隔应精确为 50ms');
  assert.deepEqual(JSON.parse(readFileSync(configFile(home), 'utf8')), expected(true));
  assert.deepEqual(temps(home), []);
});

test('持续 EPERM：最多 5 次调用，抛出原错误，旧字节不变，临时文件清理', windowsOnly, t => {
  const home = makeHome(t);
  const before = readFileSync(configFile(home));
  const waits = mockWait(t);
  const renames = mockRename(t, failWith('EPERM'));
  const started = Date.now();
  assert.throws(() => updateConfig(home, config => { config.managed = true; }), error => error.code === 'EPERM');
  const elapsed = Date.now() - started;
  assert.equal(renames.calls, 5);
  assert.ok(elapsed >= 150 && elapsed < 3000, `额外等待应有界（实际 ${elapsed}ms）`);
  assert.deepEqual(waits, [50, 50, 50, 50], '最多重试 4 次，每次间隔精确为 50ms');
  assert.deepEqual(readFileSync(configFile(home)), before);
  assert.deepEqual(temps(home), []);
});

test('rename 持续失败且临时文件也删不掉：保留原 EPERM，临时文件如实留在原处', t => {
  const home = makeHome(t);
  const before = readFileSync(configFile(home));
  const restore = mockRmFailure(t, 'EACCES');
  mockRename(t, failWith('EPERM'));
  try {
    assert.throws(
      () => updateConfig(home, config => { config.managed = true; }),
      error => error.code === 'EPERM' && error.message === '模拟 EPERM',
      '清理失败不能盖过 rename 的原错误',
    );
  } finally { restore(); }
  assert.deepEqual(readFileSync(configFile(home)), before);
  const left = temps(home);
  assert.equal(left.length, 1, '删不掉的临时文件应如实保留');
  assert.deepEqual(JSON.parse(readFileSync(join(home, left[0]), 'utf8')), expected(true));
});

test('其他错误码（EACCES、ENOENT、EXDEV）不重试，立即抛出，旧文件不变', t => {
  for (const code of ['EACCES', 'ENOENT', 'EXDEV']) {
    const home = makeHome(t);
    const before = readFileSync(configFile(home));
    const renames = mockRename(t, failWith(code));
    assert.throws(() => updateConfig(home, config => { config.managed = true; }), error => error.code === code, code);
    assert.equal(renames.calls, 1, code);
    assert.deepEqual(readFileSync(configFile(home)), before, code);
    assert.deepEqual(temps(home), [], code);
  }
});

// 非 Windows 路径：不能在当前进程里改 process.platform（会影响并行测试），放到子进程里做。
test('非 Windows 路径保持原行为：EPERM 不重试，只调用一次', t => {
  const home = mkdtempSync(join(tmpdir(), 'ar-config-atomic-linux-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const script = `
import fs from 'node:fs';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'linux' });
const home = process.env.AR_CONFIG_ATOMIC_HOME;
writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, defaultProfile: null }) + '\\n');
const { updateConfig } = await import(process.env.AR_CONFIG_ATOMIC_MODULE);
let calls = 0;
const real = fs.renameSync;
fs.renameSync = () => { calls += 1; throw Object.assign(new Error('模拟 EPERM'), { code: 'EPERM' }); };
syncBuiltinESMExports();
let code = null;
try { updateConfig(home, config => { config.managed = true; }); } catch (error) { code = error.code; }
fs.renameSync = real;
syncBuiltinESMExports();
console.log(JSON.stringify({ platform: process.platform, calls, code, left: readdirSync(home), text: readFileSync(join(home, 'config.json'), 'utf8') }));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, AR_CONFIG_ATOMIC_HOME: home, AR_CONFIG_ATOMIC_MODULE: new URL('../../core/lib/config.mjs', import.meta.url).href },
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.platform, 'linux');
  assert.equal(out.calls, 1);
  assert.equal(out.code, 'EPERM');
  assert.deepEqual(out.left, ['config.json']);
  assert.equal(out.text, JSON.stringify({ v: 2, managed: false, defaultProfile: null }) + '\n');
});
