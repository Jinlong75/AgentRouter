import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXCLUDED_NAMES, HOME_NAMES, MAX_ADDED, OUTSIDE_NOTE, SLOTS_NAME, TEMP_PREFIXES,
  diffRoots, isExcludedHomeName, isUserTempName, listAdded, outsideField, outsideLine, outsideRecord, outsideSummary,
  readOutsideWrites, snapshotRoots, uncheckedLine, userTempLine,
} from '../../core/lib/outside-writes.mjs';

// 全部在系统临时目录里造假的"用户目录"与"公共目录"，不碰真实目录。
function fixture(t) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-outside-079-'));
  const userHome = path.join(base, 'user'), home = path.join(base, 'home');
  mkdirSync(userHome);
  mkdirSync(home);
  t.after(() => {
    assert.ok(path.relative(realpathSync.native(os.tmpdir()), base).startsWith('ar-outside-079-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { base, userHome, home, roots: { userHome, home } };
}
const touch = (dir, name, text = 'x') => writeFileSync(path.join(dir, name), text);

test('排除名单：协议第 1 节的表 + slots，写成导出的常量', () => {
  assert.deepEqual([...HOME_NAMES], ['runs.jsonl', 'config.json', 'projects.json', 'viewer.json', 'managed', 'agent-tests.json', 'backups', 'staging', 'workers', 'monitor']);
  assert.equal(SLOTS_NAME, 'slots');
  assert.deepEqual([...EXCLUDED_NAMES], [...HOME_NAMES, 'slots']);
  assert.deepEqual([...TEMP_PREFIXES], [...HOME_NAMES, '.config-', '.agent-tests-']);
});

test('新文件与新目录算新增，类型正确，用户目录与公共目录分别标 user / home', t => {
  const f = fixture(t);
  touch(f.userHome, 'old.txt');
  const before = snapshotRoots(f.roots);
  touch(f.userHome, 'config.json');
  mkdirSync(path.join(f.userHome, 'stray'));
  touch(f.home, 'notes.txt');
  const diff = diffRoots(before, snapshotRoots(f.roots));
  assert.deepEqual(diff, {
    checked: true,
    added: [{ root: 'user', name: 'config.json', type: 'file' }, { root: 'user', name: 'stray', type: 'dir' }, { root: 'home', name: 'notes.txt', type: 'file' }],
  });
});

test('已有文件改了修改时间不算；没有变化就没有新增', t => {
  const f = fixture(t);
  touch(f.userHome, 'old.txt');
  const before = snapshotRoots(f.roots);
  const later = new Date(Date.now() + 60000);
  utimesSync(path.join(f.userHome, 'old.txt'), later, later);
  touch(f.userHome, 'old.txt', '改了内容');
  assert.deepEqual(diffRoots(before, snapshotRoots(f.roots)), { checked: true, added: [] });
  assert.ok(Number.isFinite(before.user.entries.find(entry => entry.name === 'old.txt').mtimeMs), '快照里有修改时间');
});

test('公共目录排除名单里的每一项都不算（文件和目录两种形式）', t => {
  for (const name of EXCLUDED_NAMES) {
    for (const kind of ['file', 'dir']) {
      const f = fixture(t);
      const before = snapshotRoots(f.roots);
      if (kind === 'file') touch(f.home, name); else mkdirSync(path.join(f.home, name));
      assert.deepEqual(diffRoots(before, snapshotRoots(f.roots)), { checked: true, added: [] }, `${name}（${kind}）`);
    }
  }
});

test('同样的名字出现在用户目录根仍然算（排除名单只对公共目录）', t => {
  const f = fixture(t);
  const before = snapshotRoots(f.roots);
  touch(f.userHome, 'config.json');
  mkdirSync(path.join(f.userHome, 'slots'));
  const diff = diffRoots(before, snapshotRoots(f.roots));
  assert.deepEqual(diff.added.map(item => `${item.root}/${item.name}`), ['user/config.json', 'user/slots']);
});

test('.tmp 临时文件规则：以表里的文件名或 .config-、.agent-tests- 开头且以 .tmp 结尾才不算', t => {
  const f = fixture(t);
  const before = snapshotRoots(f.roots);
  const ignored = ['.config-0a1b2c3d.tmp', '.agent-tests-0a1b2c3d.tmp', ...HOME_NAMES.map(name => `${name}.1234.tmp`), 'config.json.tmp'];
  for (const name of ignored) touch(f.home, name);
  // 不符合的：前缀不对、后缀不对。
  const counted = ['other.tmp', 'config.json.bak', '.secrets-1.tmp', '.config-1.txt', 'tmp'];
  for (const name of counted) touch(f.home, name);
  const diff = diffRoots(before, snapshotRoots(f.roots));
  assert.deepEqual(diff.added.map(item => item.name).sort(), [...counted].sort());
  for (const name of ignored) assert.equal(isExcludedHomeName(name, { caseInsensitive: false }), true, name);
  for (const name of counted) assert.equal(isExcludedHomeName(name, { caseInsensitive: false }), false, name);
});

test('用户目录根的临时文件（以 .tmp 结尾或含 .tmp.）不算新文件，单独列在 userTemp；公共目录根的规则不变', t => {
  const f = fixture(t);
  const before = snapshotRoots(f.roots);
  const temp = ['settings.json.tmp', 'state.tmp.1234', '.profile.tmp.8f3a', 'x.TMP'];
  for (const name of temp) touch(f.userHome, name);
  // 不符合的：只是名字里有 tmp，不是 .tmp 结尾也不含 .tmp.。
  const counted = ['tmp', 'notes.tmpl', 'my.tmpfile'];
  for (const name of counted) touch(f.userHome, name);
  // 公共目录根里同样的名字不套用户目录的规则：不在排除名单里就算。
  touch(f.home, 'state.tmp.1234');
  const diff = diffRoots(before, snapshotRoots(f.roots), { caseInsensitive: true });
  assert.deepEqual(diff.added.map(item => `${item.root}/${item.name}`), ['user/my.tmpfile', 'user/notes.tmpl', 'user/tmp', 'home/state.tmp.1234']);
  assert.deepEqual(diff.userTemp, ['.profile.tmp.8f3a', 'settings.json.tmp', 'state.tmp.1234', 'x.TMP']);
  // 区分大小写时 x.TMP 不是临时文件。
  assert.equal(isUserTempName('x.TMP', { caseInsensitive: false }), false);
  assert.equal(isUserTempName('x.TMP', { caseInsensitive: true }), true);
  // 只有临时文件时：没有新文件，返回值里才有 userTemp；没有临时文件时没有这个字段。
  const only = snapshotRoots(f.roots);
  touch(f.userHome, 'only.json.tmp');
  assert.deepEqual(diffRoots(only, snapshotRoots(f.roots)), { checked: true, added: [], userTemp: ['only.json.tmp'] });
  assert.ok(!('userTemp' in diffRoots(only, only)));
  assert.equal(userTempLine(['a.tmp', 'b.tmp.1']), '用户目录根出现临时文件（已忽略）：a.tmp、b.tmp.1');
  assert.equal(userTempLine(['a', 'b', 'c', 'd', 'e', 'f'].map(name => `${name}.tmp`)), '用户目录根出现临时文件（已忽略）：a.tmp、b.tmp、c.tmp、d.tmp、e.tmp 等');
});

test('名字比较的大小写：不区分大小写时 CONFIG.JSON、.CONFIG-x.TMP 也不算，区分时算', () => {
  assert.equal(isExcludedHomeName('CONFIG.JSON', { caseInsensitive: true }), true);
  assert.equal(isExcludedHomeName('Slots', { caseInsensitive: true }), true);
  assert.equal(isExcludedHomeName('.CONFIG-X.TMP', { caseInsensitive: true }), true);
  assert.equal(isExcludedHomeName('CONFIG.JSON', { caseInsensitive: false }), false);
  assert.equal(isExcludedHomeName('Slots', { caseInsensitive: false }), false);
  assert.equal(isExcludedHomeName('.CONFIG-X.TMP', { caseInsensitive: false }), false);
  // 开始时有 Readme.txt，结束时只是大小写不同的同名：不区分大小写时不算新增。
  const entry = name => ({ name, type: 'file', mtimeMs: 1 });
  const before = { user: { entries: [entry('Readme.txt')] }, home: { entries: [] } };
  const after = { user: { entries: [entry('README.TXT')] }, home: { entries: [] } };
  assert.deepEqual(diffRoots(before, after, { caseInsensitive: true }).added, []);
  assert.deepEqual(diffRoots(before, after, { caseInsensitive: false }).added, [{ root: 'user', name: 'README.TXT', type: 'file' }]);
});

test('目录读不了：这一项返回 { error } 不抛出，diff 是 checked: false 且不记新文件', t => {
  const f = fixture(t);
  const missing = path.join(f.base, 'not-there');
  const snap = snapshotRoots({ userHome: f.userHome, home: missing });
  assert.equal(typeof snap.home.error, 'string');
  assert.ok(snap.home.error);
  assert.ok(Array.isArray(snap.user.entries));
  // 读的是文件而不是目录，同样读不了。
  touch(f.base, 'plain.txt');
  assert.equal(typeof snapshotRoots({ userHome: path.join(f.base, 'plain.txt'), home: f.home }).user.error, 'string');

  const good = snapshotRoots(f.roots);
  touch(f.userHome, 'new.txt');
  const after = snapshotRoots(f.roots);
  for (const [before, later] of [[snap, after], [good, snapshotRoots({ userHome: f.userHome, home: missing })], [snap, snap]]) {
    const diff = diffRoots(before, later);
    assert.equal(diff.checked, false);
    assert.deepEqual(diff.added, []);
    assert.match(diff.error, /公共目录/);
  }
  assert.equal(diffRoots(undefined, undefined).checked, false);
});

test('不跟随符号链接：指向目录的链接只算一个名字，不递归（Windows 上建不了链接时跳过）', t => {
  const f = fixture(t);
  const target = path.join(f.base, 'target');
  mkdirSync(target);
  touch(target, 'inside.txt');
  const before = snapshotRoots(f.roots);
  try {
    // Windows 上建符号链接常要特权，目录联接（junction）不要；它同样被当作链接，不跟随。
    symlinkSync(target, path.join(f.userHome, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`建不了符号链接（${error.code}），跳过这一条`);
    return;
  }
  const diff = diffRoots(before, snapshotRoots(f.roots));
  assert.deepEqual(diff.added, [{ root: 'user', name: 'link', type: 'other' }]);
  // 链接指向的目录里后来多出文件，用户目录根的第一层不变。
  touch(target, 'later.txt');
  const again = diffRoots(snapshotRoots(f.roots), snapshotRoots(f.roots));
  assert.deepEqual(again.added, []);
  assert.ok(existsSync(path.join(target, 'later.txt')), '检查不删除、不移动任何文件');
});

test('只列第一层：子目录里多出的文件不算；added 超过上限时截断', t => {
  const f = fixture(t);
  mkdirSync(path.join(f.userHome, 'sub'));
  const before = snapshotRoots(f.roots);
  touch(path.join(f.userHome, 'sub'), 'deep.txt');
  assert.deepEqual(diffRoots(before, snapshotRoots(f.roots)).added, []);
  for (let index = 0; index < MAX_ADDED + 5; index++) touch(f.userHome, `f${String(index).padStart(3, '0')}.txt`);
  assert.equal(diffRoots(before, snapshotRoots(f.roots)).added.length, MAX_ADDED);
});

test('文字：最多列 5 个，多了加" 等"；进度行、门禁 summary 段落、没能核对的行', () => {
  const item = (root, name) => ({ root, name, type: 'file' });
  assert.equal(listAdded([item('user', 'a'), item('home', 'b')]), 'user/a、home/b');
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => item('user', name));
  assert.equal(listAdded(many), 'user/a、user/b、user/c、user/d、user/e 等');
  assert.equal(listAdded(many.slice(0, 5)), 'user/a、user/b、user/c、user/d、user/e');
  assert.equal(outsideSummary([item('user', 'config.json')]), '工作区外出现新文件：user/config.json');
  assert.equal(outsideLine([item('user', 'config.json'), item('home', 'x')]), '工作区外出现新文件：user/config.json、home/x；不再自动重试，请核对这些文件是谁写的');
  assert.match(OUTSIDE_NOTE, /其他任务或其他程序/);
  assert.equal(uncheckedLine('用户目录前读取失败（EACCES）'), '工作区外写入没能核对：用户目录前读取失败（EACCES）');
});

test('outsideField / outsideRecord / readOutsideWrites', () => {
  const added = [{ root: 'user', name: 'a.txt', type: 'file' }];
  assert.deepEqual(outsideField({ checked: true, added }), { checked: true, added });
  assert.deepEqual(outsideField({ checked: true, added: [] }), { checked: true, added: [] });
  assert.deepEqual(outsideField({ checked: false, added: [], error: '原因' }), { checked: false, error: '原因' });
  // attempt-end 只在有新文件或没能核对时写。
  assert.equal(outsideRecord({ checked: true, added: [] }), null);
  assert.equal(outsideRecord(null), null);
  assert.deepEqual(outsideRecord({ checked: true, added }), { checked: true, added });
  assert.deepEqual(outsideRecord({ checked: false, added: [], error: '原因' }), { checked: false, error: '原因' });

  assert.deepEqual(readOutsideWrites({ checked: true, added }), { checked: true, added });
  assert.deepEqual(readOutsideWrites({ checked: false, error: '原因' }), { checked: false, added: [], error: '原因' });
  for (const bad of [null, 1, 'x', {}, { checked: true }, { checked: true, added: 'x' },
    { checked: true, added: [{ root: 'etc', name: 'a', type: 'file' }] },
    { checked: true, added: [{ root: 'user', name: '', type: 'file' }] },
    { checked: true, added: [{ root: 'user', name: 'a', type: 'socket' }] }]) {
    assert.equal(readOutsideWrites(bad), null, JSON.stringify(bad));
  }
});
