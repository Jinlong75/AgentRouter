import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gc, gcLines, sizeOf } from '../../core/lib/gc.mjs';
import { sessionRetention, sessionRetentionDefault } from '../../core/lib/config.mjs';

// 086：ar gc 的单元测试。公共目录、worktree 根、会话目录都在测试自己的临时目录里；占用者的存活与创建时间、删除动作都由测试注入。
const temp = t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar 清理单元 '));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { dir, home: path.join(dir, '公共 目录'), env: { AR_WORKTREE_ROOT: path.join(dir, 'wt 根') } };
};
const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const DAY = 24 * 60 * 60 * 1000;
const age = (target, ageDays, now) => {
  const when = new Date(now - ageDays * DAY);
  utimesSync(target, when, when);
};

test('sessionRetention：默认 14 天；正整数用配置值；其余按默认并提示', () => {
  assert.equal(sessionRetentionDefault, 14);
  assert.deepEqual(sessionRetention({}), { days: 14, source: '内置默认', warnings: [] });
  assert.deepEqual(sessionRetention(undefined), { days: 14, source: '内置默认', warnings: [] });
  assert.deepEqual(sessionRetention({ sessionRetentionDays: 30 }), { days: 30, source: 'config.json', warnings: [] });
  for (const bad of [0, -1, 1.5, '7', null, NaN, Infinity, true, []]) {
    const value = sessionRetention({ sessionRetentionDays: bad });
    assert.equal(value.days, 14, String(bad));
    assert.equal(value.source, '内置默认');
    assert.deepEqual(value.warnings, ['配置：sessionRetentionDays 必须为正整数，已按默认值 14 处理'], String(bad));
  }
});

test('sizeOf：逐个文件累加；不跟随链接', t => {
  const { dir } = temp(t);
  put(path.join(dir, 'a', 'x.bin'), Buffer.alloc(100));
  put(path.join(dir, 'a', 'b', 'y.bin'), Buffer.alloc(250));
  assert.equal(sizeOf(path.join(dir, 'a')), 350);
  assert.equal(sizeOf(path.join(dir, '不存在')), 0);
  put(path.join(dir, 'big', 'z.bin'), Buffer.alloc(100000));
  try { symlinkSync(path.join(dir, 'big'), path.join(dir, 'a', 'link'), 'junction'); }
  catch { return; /* 建不了链接的环境（没有权限）跳过链接部分。 */ }
  assert.ok(sizeOf(path.join(dir, 'a')) < 10000, '链接指向的内容不计入');
  // 删目录时只删链接本身，链接指向的内容还在。
  rmSync(path.join(dir, 'a'), { recursive: true });
  assert.ok(existsSync(path.join(dir, 'big', 'z.bin')));
});

test('删除失败的项记进 errors，其余照删；bytes 只计删掉的；--dry-run 不调用删除', async t => {
  const { home, env } = temp(t);
  const now = Date.now();
  const projects = name => path.join(home, 'workers', name, 'claude', 'projects');
  const sessions = [['甲', 'old'], ['乙', 'locked'], ['丙', 'old']];
  for (const [worker, name] of sessions) {
    put(path.join(projects(worker), name, 'session.jsonl'), Buffer.alloc(1000));
    age(path.join(projects(worker), name), 30, now);
  }
  put(path.join(projects('甲'), 'fresh', 'session.jsonl'), Buffer.alloc(1000));
  age(path.join(projects('甲'), 'fresh'), 2, now);

  const removed = [];
  const removeDirectory = target => {
    if (target.includes('locked')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    removed.push(target);
    rmSync(target, { recursive: true, force: true });
  };

  const dry = await gc({ homes: [home], env, dryRun: true, now, removeDirectory });
  assert.deepEqual(removed, [], 'dry-run 不调用删除');
  assert.deepEqual(dry.errors, []);
  assert.equal(dry.sessions.length, 3);
  assert.equal(dry.bytes, 3000, '三个会话目录各 1000 字节');
  assert.ok(dry.sessions.every(item => item.ageDays === 30));
  assert.ok(existsSync(path.join(projects('乙'), 'locked')));

  const real = await gc({ homes: [home], env, now, removeDirectory });
  assert.equal(real.ok, true);
  assert.equal(real.sessions.length, 3, '失败的项也在列表里');
  assert.equal(real.errors.length, 1);
  assert.deepEqual({ kind: real.errors[0].kind, path: real.errors[0].path }, { kind: 'session', path: path.join(projects('乙'), 'locked') });
  assert.match(real.errors[0].error, /EBUSY/);
  assert.equal(real.bytes, 2000, '只计删掉的两个');
  assert.equal(removed.length, 2);
  assert.ok(!existsSync(path.join(projects('甲'), 'old')));
  assert.ok(!existsSync(path.join(projects('丙'), 'old')));
  assert.ok(existsSync(path.join(projects('乙'), 'locked')));
  assert.ok(existsSync(path.join(projects('甲'), 'fresh')));
  const lines = gcLines(real);
  assert.ok(lines.some(line => line.startsWith('清理失败：') && line.includes('EBUSY')), lines.join('\n'));
});

test('孤立名额的判定：占用者不存活、或存活但创建时间不同才算；读不懂的、活着的不动；.stale- 残留同样处理', async t => {
  const { home, env } = temp(t);
  const slots = path.join(home, 'slots');
  put(path.join(slots, 'slot-1.json'), JSON.stringify({ id: 'a', pid: 101, created: 1000, at: 1 }));          // 已退出
  put(path.join(slots, 'slot-2.json'), JSON.stringify({ id: 'b', pid: 102, created: 1000, at: 1 }));          // 活着，创建时间一致
  put(path.join(slots, 'slot-3.json'), JSON.stringify({ id: 'c', pid: 102, created: 5000, at: 1 }));          // 活着，创建时间不同：PID 复用
  put(path.join(slots, 'gate-1.json'), JSON.stringify({ id: 'd', pid: 102, created: null, at: 1 }));          // 创建时间未知：按还在处理
  put(path.join(slots, 'gate-2.json'), JSON.stringify({ id: 'e', pid: 'x', created: 1, at: 1 }));            // pid 不合法：不动
  put(path.join(slots, 'slot-4.json'), '');                                                                   // 正在写：不动
  put(path.join(slots, 'slot-1.json.stale-ab12cd34'), JSON.stringify({ id: 'f', pid: 101, created: 1, at: 1 }));
  put(path.join(slots, 'slot-9.json.stale-zz'), JSON.stringify({ id: 'g', pid: 101, created: 1, at: 1 })); // 后缀不合规：不碰
  const isAlive = pid => pid === 102;
  const createdOf = async () => 1000;

  const dry = await gc({ homes: [home], env, dryRun: true, isAlive, createdOf });
  assert.deepEqual(dry.slots.map(item => path.basename(item.file)).sort(), ['slot-1.json', 'slot-1.json.stale-ab12cd34', 'slot-3.json']);
  assert.equal(existsSync(path.join(slots, 'slot-1.json')), true);

  const real = await gc({ homes: [home], env, isAlive, createdOf });
  assert.deepEqual(real.errors, []);
  for (const name of ['slot-1.json', 'slot-1.json.stale-ab12cd34', 'slot-3.json']) assert.equal(existsSync(path.join(slots, name)), false, name);
  for (const name of ['slot-2.json', 'gate-1.json', 'gate-2.json', 'slot-4.json', 'slot-9.json.stale-zz']) assert.equal(existsSync(path.join(slots, name)), true, name);
});

test('清单里找不到任务的 worktree 目录有 10 分钟保护期：刚建的不列出，修改时间在 11 分钟前才列出', async t => {
  const { home, env } = temp(t);
  const dir = path.join(env.AR_WORKTREE_ROOT, 'abcdef-手工');
  put(path.join(dir, 'x.txt'), 'x');
  const now = Date.now();
  const listed = async () => (await gc({ homes: [home], env, dryRun: true, now })).worktrees;
  const touch = minutes => utimesSync(dir, new Date(now - minutes * 60000), new Date(now - minutes * 60000));

  assert.deepEqual(await listed(), [], '刚建的目录不列出');
  touch(9);
  assert.deepEqual(await listed(), [], '9 分钟前的也不列出');
  touch(11);
  assert.deepEqual(await listed(), [{ dir, reason: 'unknown-task' }], '11 分钟前的列出');
  assert.ok(existsSync(dir), 'dry-run 不删');
});

test('配置无效时拒绝清理，什么都不删', async t => {
  const { home, env } = temp(t);
  put(path.join(home, 'config.json'), '{不是 JSON');
  put(path.join(home, 'slots', 'slot-1.json'), JSON.stringify({ id: 'a', pid: 101, created: 1, at: 1 }));
  await assert.rejects(() => gc({ homes: [home], env, isAlive: () => false }), /config\.json 无法读取.*这次没有清理/);
  assert.equal(existsSync(path.join(home, 'slots', 'slot-1.json')), true);
});

test('gcLines：没有可清理的内容；dry-run 与实际清理的标题不同', () => {
  assert.deepEqual(gcLines({ worktrees: [], slots: [], sessions: [], bytes: 0, errors: [] }), ['没有需要清理的内容']);
  const result = { worktrees: [{ dir: '/w/abcdef-x', reason: 'accepted' }], slots: [], sessions: [], bytes: 2 * 1048576, errors: [] };
  assert.equal(gcLines(result, { dryRun: true })[0], '可以清理（--dry-run 只列出，没有删除）：');
  assert.equal(gcLines(result)[0], '已清理：');
  assert.ok(gcLines(result, { dryRun: true }).at(-1).startsWith('预计可释放约 2.0 MB'));
});
