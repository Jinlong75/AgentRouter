import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireSlot, countSlots, releaseAllFor } from '../../core/lib/slots.mjs';
import { slotDefaults, slotLimits, configCommand } from '../../core/lib/config.mjs';

// 临时目录里的公共目录；存活判断与创建时间都注入，不依赖真实进程。
function setup(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ar-slots-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
const slotFile = (home, name) => path.join(home, 'slots', name);
const names = home => readdirSync(path.join(home, 'slots')).sort();
// 注入的存活判断：只有 alive 集合里的 pid 存活；创建时间由 created 表给出（缺省 1000）。
const fakes = ({ alive = [], created = {} } = {}) => ({
  isAlive: pid => alive.includes(pid),
  createdOf: async pid => created[pid] ?? 1000,
});
const base = { pid: 100, created: 1000, intervalMs: 10, now: () => 5000 };

test('拿到、释放、重复释放：文件内容是 { id, pid, created, at }，第二次释放不动别人的文件', async t => {
  const home = setup(t);
  const release = await acquireSlot({ home, kind: 'task', id: 'a', limit: 1, ...base, ...fakes({ alive: [100] }) });
  assert.deepEqual(names(home), ['slot-1.json']);
  assert.deepEqual(JSON.parse(readFileSync(slotFile(home, 'slot-1.json'), 'utf8')), { id: 'a', pid: 100, created: 1000, at: 5000 });
  release();
  assert.deepEqual(names(home), []);
  // 名额被别的持有者占了以后，旧的释放函数再调用不能删掉它。
  const other = await acquireSlot({ home, kind: 'task', id: 'b', limit: 1, ...base, pid: 101, ...fakes({ alive: [100, 101] }) });
  release();
  assert.deepEqual(names(home), ['slot-1.json']);
  other();
  other();
  assert.deepEqual(names(home), []);
});

test('上限内各拿一个：limit 2 占 slot-1、slot-2，且不调用 onWait', async t => {
  const home = setup(t);
  let waits = 0;
  const options = { home, kind: 'task', limit: 2, ...base, onWait: () => { waits++; }, ...fakes({ alive: [100] }) };
  const first = await acquireSlot({ ...options, id: 'a' });
  const second = await acquireSlot({ ...options, id: 'b' });
  assert.deepEqual(names(home), ['slot-1.json', 'slot-2.json']);
  assert.equal(waits, 0);
  assert.equal(countSlots({ home, kind: 'task' }), 2);
  first(); second();
});

test('满了以后：onWait 只调一次（带当前占用数），释放后拿到', async t => {
  const home = setup(t);
  const options = { home, kind: 'task', limit: 1, ...base, ...fakes({ alive: [100] }) };
  const first = await acquireSlot({ ...options, id: 'a' });
  const waits = [];
  let got = false;
  const pending = acquireSlot({ ...options, id: 'b', onWait: info => waits.push(info) }).then(release => { got = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 120));   // 多轮重试
  assert.equal(got, false);
  assert.deepEqual(waits, [{ held: 1 }]);
  first();
  const release = await pending;
  assert.equal(JSON.parse(readFileSync(slotFile(home, 'slot-1.json'), 'utf8')).id, 'b');
  assert.equal(waits.length, 1);
  release();
});

test('孤立回收：pid 不存活的名额被回收，.stale- 残留不留下', async t => {
  const home = setup(t);
  mkdirSync(path.join(home, 'slots'));
  writeFileSync(slotFile(home, 'slot-1.json'), JSON.stringify({ id: 'dead', pid: 7, created: 1000, at: 1 }));
  const release = await acquireSlot({ home, kind: 'task', id: 'b', limit: 1, ...base, ...fakes({ alive: [100] }) });
  assert.deepEqual(names(home), ['slot-1.json']);
  assert.equal(JSON.parse(readFileSync(slotFile(home, 'slot-1.json'), 'utf8')).id, 'b');
  release();
});

test('孤立回收：PID 复用（存活但创建时间不同）被回收；创建时间相同的不回收', async t => {
  const home = setup(t);
  mkdirSync(path.join(home, 'slots'));
  writeFileSync(slotFile(home, 'slot-1.json'), JSON.stringify({ id: 'reused', pid: 7, created: 1000, at: 1 }));
  const release = await acquireSlot({ home, kind: 'task', id: 'b', limit: 1, ...base, ...fakes({ alive: [100, 7], created: { 7: 9000 } }) });
  assert.equal(JSON.parse(readFileSync(slotFile(home, 'slot-1.json'), 'utf8')).id, 'b');
  release();

  // 同一个进程（创建时间一致）仍存活：不回收，排队等待。
  writeFileSync(slotFile(home, 'slot-1.json'), JSON.stringify({ id: 'live', pid: 7, created: 1000, at: 1 }));
  const controller = { stopped: false };
  setTimeout(() => { controller.stopped = true; }, 80);
  await assert.rejects(acquireSlot({ home, kind: 'task', id: 'c', limit: 1, ...base, signal: controller, ...fakes({ alive: [100, 7], created: { 7: 1000 } }) }), { stopped: true });
  assert.equal(JSON.parse(readFileSync(slotFile(home, 'slot-1.json'), 'utf8')).id, 'live');
});

test('读不了的文件不回收：空文件、不是 JSON、没有 pid 都当作可能正在写', async t => {
  const home = setup(t);
  mkdirSync(path.join(home, 'slots'));
  for (const text of ['', '{"id":"半截', '{"id":"x"}', '[]']) {
    writeFileSync(slotFile(home, 'slot-1.json'), text);
    const controller = { stopped: false };
    setTimeout(() => { controller.stopped = true; }, 60);
    await assert.rejects(acquireSlot({ home, kind: 'task', id: 'b', limit: 1, ...base, signal: controller, ...fakes({ alive: [] }) }), { stopped: true }, text);
    assert.equal(readFileSync(slotFile(home, 'slot-1.json'), 'utf8'), text, '文件原样还在');
    assert.deepEqual(names(home), ['slot-1.json']);
  }
});

test('signal.stopped 为真：等待中抛出 { stopped: true } 的错误，没有占用任何名额', async t => {
  const home = setup(t);
  const options = { home, kind: 'gate', limit: 1, ...base, ...fakes({ alive: [100] }) };
  const holder = await acquireSlot({ ...options, id: 'a' });
  const controller = { stopped: false };
  let waits = 0;
  const pending = acquireSlot({ ...options, id: 'b', signal: controller, onWait: () => { waits++; } });
  setTimeout(() => { controller.stopped = true; }, 60);
  const error = await pending.catch(e => e);
  assert.equal(error.stopped, true);
  assert.equal(waits, 1);
  assert.deepEqual(names(home), ['gate-1.json'], '只剩持有者自己的');
  holder();
  // 已经 stopped 时连第一轮都不试。
  await assert.rejects(acquireSlot({ ...options, id: 'c', signal: { stopped: true } }), { stopped: true });
  assert.deepEqual(names(home), []);
});

test('kind 两种文件名互不干扰：task 占满不影响 gate，计数分开', async t => {
  const home = setup(t);
  const options = { home, limit: 1, ...base, ...fakes({ alive: [100] }) };
  const task = await acquireSlot({ ...options, kind: 'task', id: 'a' });
  const gate = await acquireSlot({ ...options, kind: 'gate', id: 'a' });
  assert.deepEqual(names(home), ['gate-1.json', 'slot-1.json']);
  assert.equal(countSlots({ home, kind: 'task' }), 1);
  assert.equal(countSlots({ home, kind: 'gate' }), 1);
  task();
  assert.deepEqual(names(home), ['gate-1.json']);
  gate();
  assert.deepEqual(names(home), []);
  await assert.rejects(acquireSlot({ ...options, kind: 'other', id: 'a' }), /未知的名额类型/);
});

test('releaseAllFor：只删内容 id 等于它的文件，别人的与读不了的不动', async t => {
  const home = setup(t);
  const options = { home, kind: 'task', limit: 3, ...base, ...fakes({ alive: [100] }) };
  await acquireSlot({ ...options, id: 'mine' });
  await acquireSlot({ ...options, id: 'theirs' });
  await acquireSlot({ ...options, id: 'mine', kind: 'gate' });
  writeFileSync(slotFile(home, 'slot-3.json'), '半截');
  releaseAllFor({ home, id: 'mine' });
  assert.deepEqual(names(home), ['slot-2.json', 'slot-3.json']);
  releaseAllFor({ home: path.join(home, '不存在'), id: 'mine' });   // 目录不在也不出错
});

test('默认创建时间：不传 created 时用 createdOf 查到的值（查不到记 null）', async t => {
  const home = setup(t);
  const release = await acquireSlot({ home, kind: 'task', id: 'a', limit: 1, pid: 100, intervalMs: 10, isAlive: () => true, createdOf: async () => 4242 });
  assert.equal(JSON.parse(readFileSync(slotFile(home, 'slot-1.json'), 'utf8')).created, 4242);
  release();
  const second = await acquireSlot({ home, kind: 'task', id: 'a', limit: 1, pid: 100, intervalMs: 10, isAlive: () => true, createdOf: async () => null });
  assert.equal(JSON.parse(readFileSync(slotFile(home, 'slot-1.json'), 'utf8')).created, null);
  second();
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('limit 是函数：每轮重读，第一轮 1、之后 2，第 2 个调用者下一轮拿到名额，onLimit(2, 1) 只调一次', async t => {
  const home = setup(t);
  const options = { home, kind: 'task', ...base, ...fakes({ alive: [100] }) };
  const first = await acquireSlot({ ...options, id: 'a', limit: 1 });
  let value = 1, calls = 0;
  const changes = [];
  let got = false;
  const pending = acquireSlot({ ...options, id: 'b', limit: () => { calls++; return value; }, onLimit: (now, old) => changes.push([now, old]) })
    .then(release => { got = true; return release; });
  await sleep(100);
  assert.equal(got, false);
  assert.ok(calls >= 3, '每轮都调用');
  assert.deepEqual(changes, []);
  value = 2;
  const release = await pending;
  assert.deepEqual(changes, [[2, 1]]);
  assert.equal(JSON.parse(readFileSync(slotFile(home, 'slot-2.json'), 'utf8')).id, 'b');
  release(); first();
});

test('limit 函数抛错 / 返回 0 / 返回 "x"：沿用上一轮的值，不抛出也不放行；第一轮就失败按 1', async t => {
  const home = setup(t);
  const options = { home, kind: 'task', ...base, ...fakes({ alive: [100] }) };
  const first = await acquireSlot({ ...options, id: 'a', limit: 1 });
  for (const bad of [() => { throw new Error('半个文件'); }, () => 0, () => 'x', () => 1.5, () => undefined]) {
    const controller = { stopped: false };
    setTimeout(() => { controller.stopped = true; }, 80);
    const changes = [];
    await assert.rejects(acquireSlot({ ...options, id: 'b', limit: bad, signal: controller, onLimit: (...a) => changes.push(a) }), { stopped: true });
    assert.deepEqual(changes, [], '第一轮失败按 1，不算变化');
    assert.deepEqual(names(home), ['slot-1.json'], '没有多占');
  }
  // 中途失败：先返回 2（拿到 slot-2 之前被占满），之后坏值沿用 2，不退回 1 也不报变化。
  const second = await acquireSlot({ ...options, id: 'c', limit: 2 });
  let step = 0;
  const changes = [];
  const controller = { stopped: false };
  setTimeout(() => { controller.stopped = true; }, 100);
  await assert.rejects(acquireSlot({ ...options, id: 'd', signal: controller, onLimit: (...a) => changes.push(a),
    limit: () => { step++; if (step === 1) return 2; throw new Error('读不了'); } }), { stopped: true });
  assert.deepEqual(changes, []);
  first(); second();
});

test('调小上限（2 → 1）：编号 2 已被占着的名额不被回收；新调用者要等占用数低于 1', async t => {
  const home = setup(t);
  const options = { home, kind: 'task', ...base, ...fakes({ alive: [100] }) };
  const one = await acquireSlot({ ...options, id: 'a', limit: 2 });
  const two = await acquireSlot({ ...options, id: 'b', limit: 2 });
  assert.deepEqual(names(home), ['slot-1.json', 'slot-2.json']);
  const changes = [];
  let got = false;
  const pending = acquireSlot({ ...options, id: 'c', limit: () => 1, onLimit: (...a) => changes.push(a) }).then(release => { got = true; return release; });
  await sleep(100);
  assert.equal(got, false);
  assert.deepEqual(names(home), ['slot-1.json', 'slot-2.json'], 'slot-2 仍是 b 的');
  assert.equal(JSON.parse(readFileSync(slotFile(home, 'slot-2.json'), 'utf8')).id, 'b');
  // 上限改为 1 之后，释放编号 2 的名额也不放行新调用者（它只试 slot-1）；释放 slot-1 才放行。
  two();
  await sleep(100);
  assert.equal(got, false, '占用数还是 1，不低于新上限');
  one();
  const release = await pending;
  assert.deepEqual(names(home), ['slot-1.json']);
  assert.deepEqual(changes, []);
  release();
});

test('配置：默认值、合法值、非法值按默认处理并给出提示', () => {
  assert.deepEqual(slotDefaults, { concurrency: 2, gateConcurrency: 1 });
  const none = slotLimits({});
  assert.deepEqual(none.limits, { concurrency: 2, gateConcurrency: 1 });
  assert.deepEqual(none.sources, { concurrency: '内置默认', gateConcurrency: '内置默认' });
  assert.deepEqual(none.warnings, []);
  const ok = slotLimits({ concurrency: 4, gateConcurrency: 2 });
  assert.deepEqual(ok.limits, { concurrency: 4, gateConcurrency: 2 });
  assert.deepEqual(ok.sources, { concurrency: 'config.json', gateConcurrency: 'config.json' });
  for (const bad of [0, -1, 1.5, '3', null, NaN, Infinity, true, []]) {
    const value = slotLimits({ concurrency: bad, gateConcurrency: bad });
    assert.deepEqual(value.limits, { concurrency: 2, gateConcurrency: 1 }, String(bad));
    assert.equal(value.warnings.length, 2, String(bad));
  }
  assert.deepEqual(slotLimits({ gateConcurrency: 0 }).warnings, ['配置：gateConcurrency 必须为正整数，已按默认值 1 处理']);
  assert.deepEqual(slotLimits(undefined).limits, { concurrency: 2, gateConcurrency: 1 });
});

test('ar config 输出显示两个上限与来源；非法值显示默认并提示一次', t => {
  const home = setup(t);
  const env = { AGENT_ROUTER_HOME: home };
  const plain = configCommand([], env).split('\n');
  // 来源列与上面的设置表对齐在第 35 列。
  assert.ok(plain.some(line => /^concurrency {5}2 {18}内置默认$/.test(line)), plain.join('\n'));
  assert.ok(plain.some(line => /^gateConcurrency 1 {18}内置默认$/.test(line)), plain.join('\n'));
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'codex', profiles: { codex: { adapter: 'codex', enabled: true } }, concurrency: 3, gateConcurrency: 0 }));
  const lines = configCommand([], env).split('\n');
  assert.ok(lines.some(line => /^concurrency\s+3\s+config\.json$/.test(line)), lines.join('\n'));
  assert.ok(lines.some(line => /^gateConcurrency\s+1\s+内置默认$/.test(line)), lines.join('\n'));
  assert.equal(lines.filter(line => line.includes('gateConcurrency 必须为正整数')).length, 1);
  assert.equal(existsSync(path.join(home, 'slots')), false, '只读显示不建名额目录');
});
