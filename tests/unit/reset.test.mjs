import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import {
  cacheDirectoryNames, sizeOf, removeQuietly, secretNames, clearCache, clearCacheScript, runClearCache,
  assertResettableHome, writeResetMarker, readResetMarker, assertResetMarker,
  leftoverPath, readLeftover, clearLeftover, cleanupHome, cleanupScript,
} from '../../app/src/main/reset.mjs';

// 所有测试都在系统临时目录里的独立子目录进行，不碰用户真实的公共目录。
function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ar-reset-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(file, text = 'x') { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }

test('秘密变量名：取 v2 profiles 与 v1 agents 的值，去重排序，跳过非法名与非对象', () => {
  assert.deepEqual(secretNames({ profiles: {
    a: { secrets: { K1: 'Z_KEY', K2: 'A_KEY' } },
    b: { secrets: { K3: 'Z_KEY' } },
    c: {},
    d: { secrets: { K4: 'bad name', K5: 123 } },
  } }), ['A_KEY', 'Z_KEY']);
  assert.deepEqual(secretNames({ agents: { old: { secrets: { K: 'OLD_KEY' } } }, profiles: { p: { secrets: { K: 'NEW_KEY' } } } }), ['NEW_KEY', 'OLD_KEY']);
  for (const value of [undefined, null, [], 'x', { profiles: [] }, { profiles: { a: { secrets: [] } } }]) assert.deepEqual(secretNames(value), []);
});

test('清除缓存：只删缓存目录、会话记录与 ar-agent-test-*，保留软件文件与无关目录', async t => {
  const dir = tempDir(t), home = path.join(dir, 'home'), data = path.join(home, 'monitor'), tmp = path.join(dir, 'tmp');
  put(path.join(data, cacheDirectoryNames[0], 'blob'), 'cache');
  put(path.join(data, cacheDirectoryNames[3], 'blob'), 'cache');
  put(path.join(data, 'preferences.json'), '{}');
  put(path.join(data, 'Partitions', 'keep'), 'keep');
  put(path.join(home, 'workers', 'a', 'claude', 'projects', 's.jsonl'), '{}');
  put(path.join(home, 'workers', 'b', 'claude', 'projects', 's.jsonl'), '{}');
  put(path.join(home, 'workers', 'a', 'claude', 'other.json'), '{}');
  put(path.join(tmp, 'ar-agent-test-one', 'probe.txt'), 'probe');
  put(path.join(tmp, 'unrelated.txt'), 'keep');
  const result = await clearCache({ home, data, tmp });
  assert.deepEqual(new Set(result.profiles), new Set(['a', 'b']));
  assert.ok(result.bytes > 0, '应统计删除的字节数');
  assert.equal(result.removed, 5, `应删除两个缓存、两份会话与一个测试临时目录里的 5 个文件：${result.removed}`);
  assert.equal(result.skipped, 0);
  for (const name of [cacheDirectoryNames[0], cacheDirectoryNames[3]]) assert.equal(existsSync(path.join(data, name)), false);
  assert.equal(existsSync(path.join(home, 'workers', 'a', 'claude', 'projects')), false);
  assert.equal(existsSync(path.join(home, 'workers', 'b', 'claude', 'projects')), false);
  assert.equal(existsSync(path.join(tmp, 'ar-agent-test-one')), false);
  assert.ok(existsSync(path.join(data, 'preferences.json')) && existsSync(path.join(data, 'Partitions', 'keep')), '软件文件与无关目录保留');
  assert.ok(existsSync(path.join(home, 'workers', 'a', 'claude', 'other.json')), '执行者目录里的其他文件保留');
  assert.ok(existsSync(path.join(tmp, 'unrelated.txt')), '其他临时文件保留');
});

test('清除缓存：有任务在跑的 profile 保留会话记录；无法确定 profile 时全部保留', async t => {
  const dir = tempDir(t), home = path.join(dir, 'home'), data = path.join(home, 'monitor'), tmp = path.join(dir, 'tmp');
  for (const profile of ['busy', 'idle']) put(path.join(home, 'workers', profile, 'claude', 'projects', 's.jsonl'), '{}');
  await clearCache({ home, data, tmp, skipProfiles: ['busy'] });
  assert.ok(existsSync(path.join(home, 'workers', 'busy', 'claude', 'projects')), '有进行中任务的执行者保留会话');
  assert.equal(existsSync(path.join(home, 'workers', 'idle', 'claude', 'projects')), false);
  put(path.join(home, 'workers', 'idle', 'claude', 'projects', 's.jsonl'), '{}');
  await clearCache({ home, data, tmp, skipProfiles: ['busy'], skipAllProfiles: true });
  assert.ok(existsSync(path.join(home, 'workers', 'busy', 'claude', 'projects')));
  assert.ok(existsSync(path.join(home, 'workers', 'idle', 'claude', 'projects')), '保守模式全部跳过');
});

test('清除缓存：被占用的文件立即跳过并计数，只尝试一次；字节数只算实际删掉的文件', async t => {
  const dir = tempDir(t), home = path.join(dir, 'home'), data = path.join(home, 'monitor'), tmp = path.join(dir, 'tmp');
  put(path.join(data, 'Cache', 'locked.bin'), Buffer.alloc(100, 1));
  put(path.join(data, 'Cache', 'free.bin'), Buffer.alloc(40, 1));
  put(path.join(data, 'preferences.json'), '{}');
  const realFs = await import('node:fs');
  let attempts = 0, chmods = 0;
  const fs = {
    ...realFs,
    unlinkSync(file) {
      if (path.basename(file) === 'locked.bin') {
        attempts++;
        const error = new Error('模拟被占用');
        error.code = 'EPERM';
        throw error;
      }
      return realFs.unlinkSync(file);
    },
    chmodSync(file, mode) { chmods++; return realFs.chmodSync(file, mode); },
  };
  const started = Date.now();
  const result = await clearCache({ home, data, tmp, fs });
  assert.ok(Date.now() - started < 1000, '被占用的文件不能等待或重试');
  assert.equal(attempts, 1, '被占用的文件只尝试删除一次');
  assert.equal(result.skipped, 1);
  assert.equal(result.removed, 1);
  assert.equal(result.bytes, 40, '字节数只算实际删掉的文件');
  assert.ok(existsSync(path.join(data, 'Cache', 'locked.bin')), '被占用的文件保留');
  assert.equal(existsSync(path.join(data, 'Cache', 'free.bin')), false);
  assert.equal(chmods, 0, '缓存目录不逐个改只读属性');
  assert.ok(existsSync(path.join(data, 'preferences.json')), '软件文件保留');
});

test('清除缓存：20000 个小文件的缓存目录与会话记录在 15 秒内删完', async t => {
  const dir = tempDir(t), home = path.join(dir, 'home'), data = path.join(home, 'monitor'), tmp = path.join(dir, 'tmp');
  const cache = path.join(data, 'Cache'), sessions = path.join(home, 'workers', 'demo', 'claude', 'projects');
  mkdirSync(cache, { recursive: true });
  for (let i = 0; i < 12000; i++) writeFileSync(path.join(cache, `c${i}.bin`), 'x');
  mkdirSync(sessions, { recursive: true });
  for (let i = 0; i < 8000; i++) writeFileSync(path.join(sessions, `s${i}.bin`), 'x');
  const started = Date.now();
  const result = await clearCache({ home, data, tmp });
  const elapsed = Date.now() - started;
  console.log(`清除 20000 个文件用时 ${elapsed}ms（删除 ${result.removed} 个，字节 ${result.bytes}，跳过 ${result.skipped}）`);
  assert.equal(result.removed, 20000);
  assert.equal(result.skipped, 0);
  assert.equal(result.bytes, 20000, '每个文件 1 字节，字节数应为实际删除的大小');
  assert.ok(elapsed < 15000, `清除 20000 个文件应在 15 秒内完成，实际 ${elapsed}ms`);
  assert.equal(existsSync(cache), false);
  assert.equal(existsSync(sessions), false);
});

test('runClearCache：超过时限时结束子进程，按最后一次进度返回已完成的部分', async () => {
  const { EventEmitter } = await import('node:events');
  const stdout = new EventEmitter(), stderr = new EventEmitter(), child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  let killed = '';
  child.kill = signal => { killed = signal; setTimeout(() => child.emit('close', null), 5); return true; };
  const spawn = () => {
    setTimeout(() => stdout.emit('data', JSON.stringify({ type: 'progress', bytes: 123, removed: 4, skipped: 2 }) + '\n'), 5);
    return child;
  };
  const result = await runClearCache({ home: 'x', data: 'y' }, { spawn, execPath: 'fake-node', timeoutMs: 30 });
  assert.deepEqual(result, { bytes: 123, removed: 4, skipped: 2 });
  assert.equal(killed, 'SIGKILL', '超时后应结束子进程');
});

test('runClearCache 端到端：内置 Node 子进程删除缓存、会话记录与测试临时目录，软件文件保留', async t => {
  const dir = tempDir(t), home = path.join(dir, 'home'), data = path.join(home, 'monitor'), tmp = path.join(dir, 'tmp');
  put(path.join(data, 'Cache', 'blob'), Buffer.alloc(64, 1));
  put(path.join(data, 'preferences.json'), '{}');
  put(path.join(home, 'workers', 'a', 'claude', 'projects', 's.jsonl'), '{}');
  put(path.join(tmp, 'ar-agent-test-one', 'probe.txt'), Buffer.alloc(8, 1));
  const result = await runClearCache({ home, data, tmp }, { timeoutMs: 20000 });
  assert.deepEqual(result, { bytes: 64 + 2 + 8, removed: 3, skipped: 0 });
  assert.equal(existsSync(path.join(data, 'Cache')), false);
  assert.equal(existsSync(path.join(home, 'workers', 'a', 'claude', 'projects')), false);
  assert.equal(existsSync(path.join(tmp, 'ar-agent-test-one')), false);
  assert.ok(existsSync(path.join(data, 'preferences.json')), '软件文件保留');
});

test('clearCacheScript：参数来自 JSON 字符串，进度与结果写成一行 JSON', () => {
  const home = path.join(tmpdir(), 'ar-reset-clear', 'home'), script = clearCacheScript({ home, data: path.join(home, 'monitor') });
  assert.ok(script.startsWith('(async function clearCache'));
  assert.ok(script.includes(JSON.stringify(home)));
  assert.ok(script.includes("type: 'progress'"));
  assert.ok(script.includes("type: 'done'"));
});

test('sizeOf 统计文件与目录；removeQuietly 删除后返回 true，目录本来不存在也算成功', t => {
  const dir = tempDir(t), file = path.join(dir, 'a.bin'), tree = path.join(dir, 'tree');
  writeFileSync(file, Buffer.alloc(10, 1)); put(path.join(tree, 'x', 'y.bin'), Buffer.alloc(5, 1));
  assert.equal(sizeOf(file), 10);
  assert.equal(sizeOf(tree), 5);
  assert.equal(sizeOf(path.join(dir, 'missing')), 0);
  assert.equal(removeQuietly(tree), true);
  assert.equal(existsSync(tree), false);
  assert.equal(removeQuietly(tree), true);
});

test('防误删：拒绝相对路径、根目录、用户主目录与包含用户主目录的上级目录', t => {
  const dir = tempDir(t), target = path.join(dir, 'home'), userHome = path.join(dir, 'user');
  mkdirSync(target, { recursive: true }); mkdirSync(userHome, { recursive: true });
  assert.equal(assertResettableHome(target, { userHome, platform: 'win32' }), path.resolve(target));
  for (const bad of ['relative', '', null, path.parse(dir).root, userHome, dir]) {
    assert.throws(() => assertResettableHome(bad, { userHome, platform: 'win32' }), /拒绝删除/);
  }
  // Windows 上大小写不同仍视为同一个目录。
  assert.throws(() => assertResettableHome(path.join(dir, 'USER'), { userHome, platform: 'win32' }), /用户主目录/);
});

test('重置标记：写入后能读到同一个绝对路径；标记缺失或指向别的目录都拒绝', t => {
  const dir = tempDir(t), home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  assert.equal(readResetMarker(home), null);
  assert.throws(() => assertResetMarker(home, { userHome: path.join(dir, 'user') }), /不是软件当前使用的公共目录/);
  writeResetMarker(home);
  const marker = readResetMarker(home);
  assert.equal(path.resolve(marker.home), path.resolve(home));
  assert.equal(assertResetMarker(home, { userHome: path.join(dir, 'user') }), path.resolve(home));
  writeFileSync(path.join(home, '.agent-router-reset.json'), JSON.stringify({ home: path.join(dir, 'other') }));
  assert.throws(() => assertResetMarker(home, { userHome: path.join(dir, 'user') }), /不是软件当前使用的公共目录/);
});

test('残留标记：可读可清，缺失时当作没有', t => {
  const tmp = tempDir(t);
  assert.equal(readLeftover(tmp), null);
  writeFileSync(leftoverPath(tmp), JSON.stringify({ home: path.join(tmp, 'h'), at: 1 }));
  assert.equal(readLeftover(tmp).home, path.join(tmp, 'h'));
  clearLeftover(tmp);
  assert.equal(readLeftover(tmp), null);
  assert.equal(existsSync(leftoverPath(tmp)), false);
});

test('cleanupHome：等到父进程结束（这里传 0）后删除带标记的公共目录', async t => {
  const dir = tempDir(t), home = path.join(dir, 'home');
  put(path.join(home, 'monitor', 'Cache', 'x'), 'cache');
  writeResetMarker(home);
  const result = await cleanupHome({ home, parentPid: 0, timeoutMs: 5000, pollMs: 20 });
  assert.deepEqual(result, { ok: true, home: path.resolve(home) });
  assert.equal(existsSync(home), false);
});

test('cleanupHome：没有标记、相对路径、用户主目录都拒绝，目录保持原样', async t => {
  const dir = tempDir(t), home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  await assert.rejects(cleanupHome({ home, parentPid: 0 }), /找不到重置标记/);
  assert.ok(existsSync(home));
  await assert.rejects(cleanupHome({ home: 'relative', parentPid: 0 }), /绝对路径/);
  await assert.rejects(cleanupHome({ home: path.parse(dir).root, parentPid: 0 }), /绝对路径|根目录/);
  await assert.rejects(cleanupHome({ home: homedir(), parentPid: 0 }), /用户主目录/);
});

test('cleanupHome：删不掉时在临时目录写残留标记，返回 leftover', async t => {
  const dir = tempDir(t), home = path.join(dir, 'home'), tmp = path.join(dir, 'tmp');
  mkdirSync(home, { recursive: true });
  writeResetMarker(home);
  const fakeFs = {
    readFileSync: () => readFileSync(path.join(home, '.agent-router-reset.json'), 'utf8'),
    existsSync: () => true,
    rmSync: () => {},
    writeFileSync: (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); },
  };
  const fakeOs = { homedir: () => path.join(dir, 'user'), tmpdir: () => tmp };
  const result = await cleanupHome({ home, parentPid: 0, timeoutMs: 0, pollMs: 1, fs: fakeFs, os: fakeOs, path });
  assert.equal(result.ok, false);
  assert.equal(result.leftover, true);
  assert.equal(path.resolve(result.home), path.resolve(home));
  assert.equal(readLeftover(tmp).home, path.resolve(home));
  assert.equal(existsSync(home), true, '这里只验证回报路径，不真的删除');
});

test('cleanupScript：参数全部来自 JSON 字符串，包含 home 与父进程 pid', () => {
  const home = path.join(tmpdir(), 'ar-reset-script', 'home'), script = cleanupScript(home, 4321);
  assert.ok(script.includes(JSON.stringify(home)));
  assert.ok(script.includes('"parentPid":4321'));
  assert.ok(script.startsWith('(async function cleanupHome'));
  assert.ok(script.includes('.then(r => { if (!r || !r.ok) process.exitCode = 1; })'));
});
