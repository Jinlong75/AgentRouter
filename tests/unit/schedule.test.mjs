import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLoadMonitor, createOverlapWatcher, createTaskLimit, enterGate, estimateConcurrency, exclusiveCommandOf,
  memLowPercentDefault, memLowThreshold, overlapLine, overlappingPatterns, pathsOverlap, patternsOverlap, waitForOverlap,
} from '../../core/lib/schedule.mjs';
import { acquireExclusive, acquireSlot, liveHolders, readExclusive } from '../../core/lib/slots.mjs';

const GB = 1024 ** 3;
const tmp = (t, prefix = 'ar-schedule-') => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readdirSlots = home => (existsSync(path.join(home, 'slots')) ? readdirSync(path.join(home, 'slots')).sort() : []);
// 注入的存活判断：只有 alive 集合里的 pid 存活。
const fakes = (alive = []) => ({ isAlive: pid => alive.includes(pid), createdOf: async () => 1000 });

// ---- pathsOverlap ----

test('pathsOverlap：字面对字面——相同才重叠', () => {
  assert.equal(pathsOverlap(['src/a.js'], ['src/a.js']), true);
  assert.equal(pathsOverlap(['src/a.js'], ['src/b.js']), false);
  assert.equal(pathsOverlap(['src/a.js', 'docs/x.md'], ['README.md', 'docs/x.md']), true);
});

test('pathsOverlap：字面对 glob——用 glob 去匹配字面路径（两个方向都一样）', () => {
  assert.equal(pathsOverlap(['src/a.js'], ['src/**']), true);
  assert.equal(pathsOverlap(['src/**'], ['src/a.js']), true);
  assert.equal(pathsOverlap(['src/a/b.js'], ['src/*.js']), false);
  assert.equal(pathsOverlap(['docs/a.md'], ['src/**']), false);
  assert.equal(pathsOverlap(['README.md'], ['*.md']), true);
  assert.equal(pathsOverlap(['docs/README.md'], ['*.md']), false);
});

test('pathsOverlap：glob 对 glob——比第一个通配符之前的目录前缀（按路径段）', () => {
  assert.equal(pathsOverlap(['src/**'], ['src/a/*.js']), true);
  assert.equal(pathsOverlap(['src/a/*.js'], ['src/**']), true);
  assert.equal(pathsOverlap(['src/**'], ['tests/**']), false);
  // 按路径段比，不按字符：src 与 src2 不是前缀关系。
  assert.equal(pathsOverlap(['src/**'], ['src2/**']), false);
  assert.equal(pathsOverlap(['src/a*/**'], ['src/b*/**']), true, '前缀都是 src，多报是允许的');
  // 多报的情形：前缀相同但文件集其实不相交。
  assert.equal(pathsOverlap(['src/*.js'], ['src/a/*.js']), true);
});

test('pathsOverlap：** 与没有目录前缀的 glob 和谁都重叠', () => {
  assert.equal(pathsOverlap(['**'], ['src/a.js']), true);
  assert.equal(pathsOverlap(['**'], ['docs/**']), true);
  assert.equal(pathsOverlap(['**'], ['**']), true);
  assert.equal(pathsOverlap(['*.md'], ['docs/**']), true, '没有目录前缀，宁可多报');
  assert.equal(pathsOverlap(['**/*.test.mjs'], ['tests/**']), true);
});

test('pathsOverlap：花括号、问号、方括号都按通配符算', () => {
  assert.equal(pathsOverlap(['src/{a,b}.js'], ['src/**']), true);
  assert.equal(pathsOverlap(['src/{a,b}.js'], ['tests/{a,b}.js']), false);
  assert.equal(pathsOverlap(['src/?.js'], ['src/a/*.js']), true);
  assert.equal(pathsOverlap(['lib/[ab].js'], ['src/**']), false);
});

test('pathsOverlap：大小写——Windows 上不区分，其他平台区分（用选项显式指定）', () => {
  assert.equal(patternsOverlap('SRC/**', 'src/a/*.js', { caseInsensitive: true }), true);
  assert.equal(patternsOverlap('SRC/**', 'src/a/*.js', { caseInsensitive: false }), false);
  assert.equal(patternsOverlap('src/A.js', 'src/**', { caseInsensitive: true }), true);
  assert.equal(patternsOverlap('SRC/a.js', 'src/**', { caseInsensitive: false }), false);
  assert.equal(patternsOverlap('SRC/A.JS', 'src/a.js', { caseInsensitive: true }), true);
});

test('overlappingPatterns：返回对方重叠的模式（去重、保持顺序）；空数组表示不重叠', () => {
  assert.deepEqual(overlappingPatterns(['src/a.js'], ['docs/**', 'src/**', 'src/**', 'src/a.js']), ['src/**', 'src/a.js']);
  assert.deepEqual(overlappingPatterns(['src/a.js'], ['docs/**']), []);
  assert.deepEqual(overlappingPatterns('src/a.js', 'src/**'), ['src/**'], '单个字符串也行');
});

test('overlapLine：名字用顿号连起来，模式取前 3 个', () => {
  assert.equal(overlapLine([{ id: '1', name: 'A', paths: ['src/**'] }]), '排队：与 A 的改动范围重叠（src/**），等它结束');
  assert.equal(
    overlapLine([{ id: '1', name: 'A', paths: ['a/**', 'b/**'] }, { id: '2', name: 'B', paths: ['b/**', 'c/**', 'd/**'] }]),
    '排队：与 A、B 的改动范围重叠（a/**、b/**、c/**），等它结束',
  );
});

// ---- estimateConcurrency ----

test('estimateConcurrency：公式 min(max, max(1, 核数/4), max(1, 可用内存GB/1.5)) 与边界', () => {
  assert.equal(estimateConcurrency({ cores: 16, freeMemBytes: 12 * GB, max: 8 }), 4, '例子：16 核、12 GB');
  assert.equal(estimateConcurrency({ cores: 1, freeMemBytes: 64 * GB, max: 8 }), 1, '1 核');
  assert.equal(estimateConcurrency({ cores: 3, freeMemBytes: 64 * GB, max: 8 }), 1, '不足 4 核也至少 1');
  assert.equal(estimateConcurrency({ cores: 64, freeMemBytes: 256 * GB, max: 8 }), 8, '64 核：被 max 压住');
  assert.equal(estimateConcurrency({ cores: 64, freeMemBytes: 256 * GB, max: 3 }), 3, 'max 生效');
  assert.equal(estimateConcurrency({ cores: 64, freeMemBytes: 0.2 * GB, max: 8 }), 1, '内存很小也至少 1');
  assert.equal(estimateConcurrency({ cores: 64, freeMemBytes: 6 * GB, max: 8 }), 4, '内存 6 GB → 4');
  assert.equal(estimateConcurrency({ cores: 64, freeMemBytes: 5.9 * GB, max: 8 }), 3, '向下取整');
  assert.equal(estimateConcurrency({ cores: 64, freeMemBytes: 256 * GB }), 8, 'max 缺省为 8');
  assert.equal(estimateConcurrency({ cores: NaN, freeMemBytes: NaN, max: 8 }), 1, '取不到数按 1');
});

// ---- loadMonitor ----

// 假的 os.cpus()：每次采样前设置这一段时间里的使用率。
function fakeMachine({ cpu = 10, free = 8 * GB, total = 16 * GB } = {}) {
  const state = { time: 0, busy: 0, idle: 0, cpu, free };
  return {
    state,
    options: {
      now: () => state.time,
      cpus: () => [{ times: { user: state.busy, nice: 0, sys: 0, idle: state.idle, irq: 0 } }],
      freemem: () => state.free,
      totalmem: () => total,
    },
    // 过 seconds 秒，这段时间 CPU 使用率为 percent。
    advance(seconds, percent = state.cpu) {
      state.time += seconds * 1000;
      state.busy += seconds * percent;
      state.idle += seconds * (100 - percent);
    },
  };
}

test('loadMonitor：CPU 连续 60 秒超过 85% 才算忙；中间掉下来一次就重新计时', () => {
  const machine = fakeMachine();
  const monitor = createLoadMonitor(machine.options);
  assert.equal(monitor.sample().busy, false, '第一次采样没有时间差');
  for (let i = 0; i < 29; i++) { machine.advance(2, 92); assert.equal(monitor.sample().busy, false, `${(i + 1) * 2} 秒`); }
  machine.advance(2, 40);                       // 58 秒时掉下来一次
  assert.equal(monitor.sample().busy, false);
  for (let i = 0; i < 29; i++) { machine.advance(2, 92); assert.equal(monitor.sample().busy, false, `重新计时 ${(i + 1) * 2} 秒`); }
  machine.advance(2, 92);
  const result = monitor.sample();
  assert.equal(result.busy, true, '重新计时满 60 秒');
  assert.equal(result.cpu, 92);
});

test('loadMonitor：忙之后要 CPU 连续 30 秒低于 85% 才恢复，期间冲高一次就重新计时', () => {
  const machine = fakeMachine();
  const monitor = createLoadMonitor(machine.options);
  monitor.sample();
  for (let i = 0; i < 31; i++) { machine.advance(2, 95); monitor.sample(); }
  assert.equal(monitor.sample().busy, true);
  for (let i = 0; i < 14; i++) { machine.advance(2, 30); assert.equal(monitor.sample().busy, true, `${(i + 1) * 2} 秒`); }
  machine.advance(2, 90);                       // 28 秒时又冲高
  assert.equal(monitor.sample().busy, true);
  for (let i = 0; i < 14; i++) { machine.advance(2, 30); assert.equal(monitor.sample().busy, true, `重新计时 ${(i + 1) * 2} 秒`); }
  machine.advance(2, 30);
  assert.equal(monitor.sample().busy, false, '满 30 秒');
});

// 182（D114）：原断言"低于 max(1.5 GB, 总内存的 10%) 立刻算忙"→ 默认比例改成 5%、可调；原来的 10% 这一组改成"配置 10% 时"保留。
test('loadMonitor：配置 10% 时，可用内存低于 max(1.5 GB, 总内存的 10%) 立刻算忙；内存回来后还要 30 秒才恢复', () => {
  const machine = fakeMachine({ total: 32 * GB });
  const monitor = createLoadMonitor({ ...machine.options, memLowPercent: 10 });
  monitor.sample();
  machine.advance(2, 10);
  machine.state.free = 3.3 * GB;                // 32 GB 的 10% 是 3.2 GB
  assert.equal(monitor.sample().busy, false);
  machine.advance(2, 10);
  machine.state.free = 3.1 * GB;
  const low = monitor.sample();
  assert.equal(low.busy, true);
  assert.equal(low.memLow, true);
  machine.state.free = 8 * GB;
  for (let i = 0; i < 14; i++) { machine.advance(2, 10); assert.equal(monitor.sample().busy, true, `${(i + 1) * 2} 秒`); }
  machine.advance(2, 10);
  assert.equal(monitor.sample().busy, false);
  // 小内存机器：阈值取 1.5 GB。
  const small = fakeMachine({ total: 8 * GB });
  const smallMonitor = createLoadMonitor({ ...small.options, memLowPercent: 10 });
  small.state.free = 1.6 * GB;
  assert.equal(smallMonitor.sample().busy, false);
  small.state.free = 1.4 * GB;
  assert.equal(smallMonitor.sample().busy, true);
});

test('loadMonitor：默认比例是 5%（32 GB 的阈值 1.6 GB），下限 1.5 GB 不变', () => {
  assert.equal(memLowPercentDefault, 5);
  const machine = fakeMachine({ total: 32 * GB });
  const monitor = createLoadMonitor(machine.options);
  monitor.sample();
  machine.advance(2, 10);
  machine.state.free = 2.6 * GB;                // 这台电脑空闲时的典型值：10% 会判忙，5% 不会
  assert.equal(monitor.sample().busy, false);
  machine.advance(2, 10);
  machine.state.free = 1.65 * GB;
  assert.equal(monitor.sample().memLow, false);
  machine.state.free = 1.55 * GB;
  assert.equal(monitor.sample().memLow, true, '低于 1.6 GB');
  // 16 GB 的 5% 是 0.8 GB，低于下限，阈值取 1.5 GB。
  const mid = fakeMachine({ total: 16 * GB });
  const midMonitor = createLoadMonitor(mid.options);
  mid.state.free = 1.55 * GB;
  assert.equal(midMonitor.sample().memLow, false);
  mid.state.free = 1.45 * GB;
  assert.equal(midMonitor.sample().memLow, true);
  // 大内存：64 GB 的 5% 是 3.2 GB。
  const big = fakeMachine({ total: 64 * GB });
  const bigMonitor = createLoadMonitor(big.options);
  big.state.free = 3.3 * GB;
  assert.equal(bigMonitor.sample().memLow, false);
  big.state.free = 3.1 * GB;
  assert.equal(bigMonitor.sample().memLow, true);
});

test('loadMonitor：每次采样可带当前配置的比例，不用重启；不合法的值回到创建时的比例', () => {
  const machine = fakeMachine({ total: 32 * GB, free: 2.6 * GB });
  const monitor = createLoadMonitor(machine.options);
  assert.equal(monitor.sample().memLow, false, '默认 5%');
  assert.equal(monitor.sample({ memLowPercent: 10 }).memLow, true, '改成 10% 立刻生效');
  assert.equal(monitor.sample({ memLowPercent: 3 }).memLow, false);
  for (const bad of [0, 51, 5.5, '10', null, NaN]) assert.equal(monitor.sample({ memLowPercent: bad }).memLow, false, `不合法 ${String(bad)} 按创建时的 5%`);
  const tenByDefault = createLoadMonitor({ ...machine.options, memLowPercent: 10 });
  assert.equal(tenByDefault.sample({ memLowPercent: 0 }).memLow, true, '不合法的值回到创建时的比例');
});

test('memLowThreshold：max(1.5 GB, 总内存 × 比例)；比例不合法按默认 5%', () => {
  assert.equal(memLowThreshold(32 * GB, 5), 1.6 * GB);
  assert.equal(memLowThreshold(32 * GB, 10), 3.2 * GB);
  assert.equal(memLowThreshold(8 * GB, 10), 1.5 * GB, '下限');
  assert.equal(memLowThreshold(8 * GB), 1.5 * GB);
  assert.equal(memLowThreshold(64 * GB), 3.2 * GB, '没给比例按 5%');
  for (const bad of [0, 51, 2.5, 'x', null, NaN]) assert.equal(memLowThreshold(64 * GB, bad), 3.2 * GB, String(bad));
  assert.equal(memLowThreshold(100 * GB, 50), 50 * GB);
});

// ---- 重叠检查（用假清单）----

// 清单里的一个 worktree 任务：start 行 + 派发记录（dispatch.json 里的门禁信息）。
function addTask(home, base, { id, name, started, repo, paths, readOnly = false, pid = process.pid, events = [] }) {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'dispatch.json'), JSON.stringify({ v: 1, gate: { enabled: true, base: 'x', merged: { allowed_paths: paths } }, ...(readOnly ? { readOnly: true } : {}) }));
  const rows = [{ v: 1, event: 'start', id, name, repo, dir, started, pid, worktree: true }, ...events.map(event => ({ v: 1, id, ...event }))];
  writeFileSync(path.join(home, 'runs.jsonl'), rows.map(row => `${JSON.stringify(row)}\n`).join(''), { flag: 'a' });
}
const event = (name, extra = {}) => ({ event: name, ...extra });

test('createOverlapWatcher：先派发、排队 / 运行 / 门禁中、范围重叠的才挡；待验收、冲突、已结束、后派发、只读、别的项目、范围不重叠的不挡', async t => {
  const base = tmp(t), home = path.join(base, 'home'), repo = path.join(base, 'repo');
  mkdirSync(home); mkdirSync(repo);
  const other = path.join(base, 'other');
  const alive = async () => true;
  addTask(home, base, { id: 'run', name: '运行中', started: 1000, repo, paths: ['src/**'], events: [event('attempt')] });
  addTask(home, base, { id: 'wait', name: '待验收', started: 1001, repo, paths: ['src/*.js'], events: [event('end', { exit: 0 })] });
  addTask(home, base, { id: 'queued', name: '排队中', started: 1002, repo, paths: ['src/**'], events: [event('queued')] });
  addTask(home, base, { id: 'done', name: '已合并', started: 1003, repo, paths: ['src/**'], events: [event('end', { exit: 0 }), event('accepted')] });
  addTask(home, base, { id: 'rej', name: '已驳回', started: 1004, repo, paths: ['src/**'], events: [event('end', { exit: 0 }), event('rejected')] });
  addTask(home, base, { id: 'failed', name: '失败', started: 1005, repo, paths: ['src/**'], events: [event('end', { exit: 1 })] });
  addTask(home, base, { id: 'stopped', name: '停止', started: 1006, repo, paths: ['src/**'], events: [event('interrupted')] });
  addTask(home, base, { id: 'ro', name: '调研', started: 1007, repo, paths: ['**'], readOnly: true });
  addTask(home, base, { id: 'elsewhere', name: '别的项目', started: 1008, repo: other, paths: ['**'] });
  addTask(home, base, { id: 'docs', name: '文档', started: 1009, repo, paths: ['docs/**'] });
  addTask(home, base, { id: 'later', name: '后派发', started: 3000, repo, paths: ['src/**'] });
  addTask(home, base, { id: 'noscope', name: '没有记录', started: 1010, repo, paths: ['src/**'] });
  rmSync(path.join(base, '没有记录', 'dispatch.json'));

  const watcher = createOverlapWatcher({ home, root: repo, id: 'me', started: 2000, patterns: ['src/a.js'], alive });
  const blockers = await watcher.check();
  assert.deepEqual(blockers.map(item => item.name).sort(), ['排队中', '没有记录', '运行中'].sort(), '待验收的不挡人');
  assert.deepEqual(blockers.find(item => item.id === 'run').paths, ['src/**']);
  assert.deepEqual(blockers.find(item => item.id === 'noscope').paths, ['**'], '读不到派发记录按 ** 算');

  // 只读的任务和谁都不重叠。
  const reader = createOverlapWatcher({ home, root: repo, id: 'me', started: 2000, patterns: ['**'], readOnly: true, alive });
  assert.deepEqual(await reader.check(), []);
  // 不写 allowed_paths 的任务按 ** 算。
  const all = createOverlapWatcher({ home, root: repo, id: 'me', started: 2000, patterns: undefined, alive });
  assert.equal((await all.check()).length, 4, '连 docs 也挡');

  // 结束后不再挡：运行中的写 end（变成待验收）、排队中的写 interrupted 之后再查。
  appendRows(home, [{ v: 1, id: 'run', event: 'end', exit: 0 }, { v: 1, id: 'queued', event: 'interrupted' }]);
  assert.deepEqual((await watcher.check()).map(item => item.name), ['没有记录']);
  // 合并冲突（改动仍没进主分支）同样不挡人。
  appendRows(home, [{ v: 1, id: 'noscope', event: 'conflict' }]);
  assert.deepEqual(await watcher.check(), []);
});

function appendRows(home, rows) {
  writeFileSync(path.join(home, 'runs.jsonl'), rows.map(row => `${JSON.stringify(row)}\n`).join(''), { flag: 'a' });
}

test('createOverlapWatcher：同时派发（started 相同）按 id 排；进程已经不在又没有结束记录的任务不再挡', async t => {
  const base = tmp(t), home = path.join(base, 'home'), repo = path.join(base, 'repo');
  mkdirSync(home); mkdirSync(repo);
  addTask(home, base, { id: 'a', name: 'A', started: 5000, repo, paths: ['**'] });
  addTask(home, base, { id: 'c', name: 'C', started: 5000, repo, paths: ['**'] });
  const alive = async () => true;
  const b = createOverlapWatcher({ home, root: repo, id: 'b', started: 5000, patterns: ['**'], alive });
  assert.deepEqual((await b.check()).map(item => item.name), ['A'], 'id 比 b 小的才在前面');
  const a = createOverlapWatcher({ home, root: repo, id: 'a', started: 5000, patterns: ['**'], alive });
  assert.deepEqual(await a.check(), [], '最先的不用等任何人，所以不会互相等成死锁');

  const dead = createOverlapWatcher({ home, root: repo, id: 'b', started: 5000, patterns: ['**'], alive: async () => false });
  assert.deepEqual(await dead.check(), [], '进程不在了，按已结束算');
});

// 手动重试（Stage07c 152）：和准备 / 运行 / 门禁中的任务比（不管谁先派发），和排队中的只比先进入排队的；进入排队的时间是最近一次 resume。
test('createOverlapWatcher（重试）：运行中的不管谁先派发都挡；排队中的只挡先进入排队的，两个排队的重试不会互相等', async t => {
  const base = tmp(t), home = path.join(base, 'home'), repo = path.join(base, 'repo');
  mkdirSync(home); mkdirSync(repo);
  const alive = async () => true;
  // 重试 R 的原 start 很早（100），这次重试从 resume 2000 开始；它自己的 resume 行在清单里。
  addTask(home, base, { id: 'r', name: 'R', started: 100, repo, paths: ['src/**'], events: [event('end', { exit: 3 }), event('resume', { at: 2000, pid: process.pid })] });
  addTask(home, base, { id: 'runlate', name: '后派发在运行', started: 5000, repo, paths: ['src/**'], events: [event('attempt')] });
  addTask(home, base, { id: 'gating', name: '门禁中', started: 4000, repo, paths: ['src/**'], events: [event('attempt'), event('gating')] });
  addTask(home, base, { id: 'before', name: '先排队', started: 1500, repo, paths: ['src/**'], events: [event('queued')] });
  addTask(home, base, { id: 'after', name: '后排队', started: 2500, repo, paths: ['src/**'], events: [event('queued')] });
  addTask(home, base, { id: 'oldstart', name: '重试排队原 start 早', started: 50, repo, paths: ['src/**'], events: [event('end', { exit: 1 }), event('resume', { at: 3000, pid: process.pid }), event('queued')] });
  addTask(home, base, { id: 'wait', name: '待验收', started: 1000, repo, paths: ['src/**'], events: [event('end', { exit: 0 })] });
  addTask(home, base, { id: 'docs', name: '文档', started: 1000, repo, paths: ['docs/**'], events: [event('attempt')] });

  const retrying = createOverlapWatcher({ home, root: repo, id: 'r', started: 1999, patterns: ['src/a.js'], retrying: true, alive });
  assert.deepEqual((await retrying.check()).map(item => item.name).sort(), ['先排队', '后派发在运行', '门禁中'].sort(), '后排队的、待验收的、不重叠的都不挡');

  // 同样的清单，新派发（started 2001）的看法：运行中的只挡先派发的；排队的按进入排队的时间比（重试的 R 是 resume 的 2000，比它早）。
  const fresh = createOverlapWatcher({ home, root: repo, id: 'n', started: 2001, patterns: ['src/a.js'], alive });
  assert.deepEqual((await fresh.check()).map(item => item.name).sort(), ['R', '先排队'].sort(), '新派发看不到后派发的运行任务、后排队的、原 start 早但这次重试排队更晚的');
});

test('waitForOverlap：阻挡名单变化时通知一次；都结束后返回 true（等过），没等过返回 false；停止时抛 { stopped }', async t => {
  const base = tmp(t), home = path.join(base, 'home'), repo = path.join(base, 'repo');
  mkdirSync(home); mkdirSync(repo);
  addTask(home, base, { id: 'a', name: 'A', started: 1000, repo, paths: ['src/**'] });
  const alive = async () => true;
  const watcher = createOverlapWatcher({ home, root: repo, id: 'b', started: 2000, patterns: ['src/x.js'], alive });
  const seen = [];
  const pending = waitForOverlap({ watcher, intervalMs: 20, onChange: blockers => seen.push(blockers.map(item => item.name)) });
  await sleep(120);
  assert.deepEqual(seen, [['A']], '多轮重查但名单没变，只通知一次');
  appendRows(home, [{ v: 1, id: 'a', event: 'end', exit: 1 }]);
  assert.equal(await pending, true);

  const fresh = createOverlapWatcher({ home, root: repo, id: 'b', started: 2000, patterns: ['src/x.js'], alive });
  assert.equal(await waitForOverlap({ watcher: fresh, intervalMs: 20 }), false, '没有阻挡，没等过');

  addTask(home, base, { id: 'z', name: 'Z', started: 1500, repo, paths: ['**'] });
  const signal = { stopped: false };
  setTimeout(() => { signal.stopped = true; }, 80);
  const again = createOverlapWatcher({ home, root: repo, id: 'b', started: 2000, patterns: ['src/x.js'], alive });
  await assert.rejects(waitForOverlap({ watcher: again, signal, intervalMs: 20 }), { stopped: true });
});

// ---- 独占命令 ----

test('exclusiveCommandOf：去掉首尾空白后完全相同才算；没有配置、不是数组都是没有', t => {
  const repo = tmp(t);
  mkdirSync(path.join(repo, '.agent-router'));
  const config = value => writeFileSync(path.join(repo, '.agent-router', 'project.json'), JSON.stringify(value));
  assert.equal(exclusiveCommandOf({ root: repo, verify: ['npm run shots'] }), null, '没有项目配置');
  config({ name: 'x' });
  assert.equal(exclusiveCommandOf({ root: repo, verify: ['npm run shots'] }), null, '没有这个键');
  config({ exclusiveCommands: 'npm run shots' });
  assert.equal(exclusiveCommandOf({ root: repo, verify: ['npm run shots'] }), null, '不是数组');
  config({ exclusiveCommands: ['npm run shots', ''] });
  assert.equal(exclusiveCommandOf({ root: repo, verify: ['npm run lint:tree', '  npm run shots \n'] }), 'npm run shots');
  assert.equal(exclusiveCommandOf({ root: repo, verify: ['npm run shotsx'] }), null, '只是字符前缀相同（后面不是空格）不算');
  assert.equal(exclusiveCommandOf({ root: repo, verify: ['npm run shot'] }), null, '比独占命令短也不算');
  assert.equal(exclusiveCommandOf({ root: repo, verify: [] }), null);
  assert.equal(exclusiveCommandOf({ root: repo, verify: undefined }), null);
});

// D71：独占命令按前缀匹配，聚焦的界面检查（npm run shots -- --focus <名>）也要独占。
test('exclusiveCommandOf：等于、或以"独占命令 + 空格"开头都算独占，返回实际要跑的那条命令', t => {
  const repo = tmp(t);
  mkdirSync(path.join(repo, '.agent-router'));
  writeFileSync(path.join(repo, '.agent-router', 'project.json'), JSON.stringify({ exclusiveCommands: ['npm run shots'] }));
  assert.equal(exclusiveCommandOf({ root: repo, verify: ['npm run shots'] }), 'npm run shots', '等于');
  assert.equal(exclusiveCommandOf({ root: repo, verify: ['  npm run shots -- --focus routing '] }), 'npm run shots -- --focus routing', '独占命令 + 空格开头');
  assert.equal(exclusiveCommandOf({ root: repo, verify: ['npm run shots --focus=x'] }), 'npm run shots --focus=x', '原先"只是前缀相同不算"的写法现在算');
  assert.equal(exclusiveCommandOf({ root: repo, verify: ['npm run shotsx', 'npm run shots-all'] }), null, '后面不是空格不算');
});

test('独占标记：建立、重复建立被拒、释放只删自己的；占用者不在了能回收', async t => {
  const home = tmp(t);
  const options = { home, created: 1000, now: () => 5000, ...fakes([100, 200]) };
  assert.equal(await readExclusive(options), null);
  const release = await acquireExclusive({ ...options, id: 'a', name: 'A', command: 'npm run shots', pid: 100 });
  const file = path.join(home, 'slots', 'exclusive.json');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { id: 'a', pid: 100, created: 1000, at: 5000, name: 'A', command: 'npm run shots' });
  assert.equal((await readExclusive(options)).name, 'A');
  assert.equal(await acquireExclusive({ ...options, id: 'b', name: 'B', command: 'x', pid: 200 }), null, '别人的标记还在');
  release(); release();
  assert.equal(existsSync(file), false);

  // 占用者进程不在了：读取时回收，新的占用者能建。
  writeFileSync(path.join(home, 'slots', 'exclusive.json'), JSON.stringify({ id: 'dead', pid: 7, created: 1000, at: 1, name: 'D', command: 'c' }));
  assert.equal(await readExclusive(options), null);
  assert.equal(existsSync(file), false, '孤立的标记被删除');
  writeFileSync(file, JSON.stringify({ id: 'dead', pid: 7, created: 1000, at: 1, name: 'D', command: 'c' }));
  const taken = await acquireExclusive({ ...options, id: 'b', name: 'B', command: 'x', pid: 200 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).id, 'b');
  // 旧的释放函数不能删别人的标记。
  release();
  assert.equal(existsSync(file), true);
  taken();
  // PID 被别的进程复用（创建时间不同）同样回收。
  writeFileSync(file, JSON.stringify({ id: 'reused', pid: 100, created: 1, at: 1, name: 'R', command: 'c' }));
  assert.equal(await readExclusive({ ...options, createdOf: async () => 9999 }), null);
});

test('独占标记：读不了内容的标记刚写时按"还在"，过了 10 秒按孤立回收', async t => {
  const home = tmp(t);
  mkdirSync(path.join(home, 'slots'));
  const file = path.join(home, 'slots', 'exclusive.json');
  writeFileSync(file, '{"id":"半截');
  const options = { home, ...fakes([]) };
  assert.notEqual(await readExclusive(options), null);
  const old = new Date(Date.now() - 60000);
  utimesSync(file, old, old);
  assert.equal(await readExclusive(options), null);
  assert.equal(existsSync(file), false);
});

test('liveHolders：数占用者还在的名额文件，排除自己，孤立的不算', async t => {
  const home = tmp(t);
  const slots = path.join(home, 'slots');
  mkdirSync(slots);
  writeFileSync(path.join(slots, 'gate-1.json'), JSON.stringify({ id: 'me', pid: 100, created: 1000, at: 1 }));
  writeFileSync(path.join(slots, 'gate-2.json'), JSON.stringify({ id: 'other', pid: 200, created: 1000, at: 1 }));
  writeFileSync(path.join(slots, 'gate-3.json'), JSON.stringify({ id: 'dead', pid: 7, created: 1000, at: 1 }));
  writeFileSync(path.join(slots, 'slot-1.json'), JSON.stringify({ id: 'task', pid: 200, created: 1000, at: 1 }));
  assert.equal(await liveHolders({ home, kind: 'gate', excludeId: 'me', ...fakes([100, 200]) }), 1);
  assert.equal(await liveHolders({ home, kind: 'gate', excludeId: 'nobody', ...fakes([100, 200]) }), 2);
  assert.equal(await liveHolders({ home: path.join(home, '不存在'), kind: 'gate', excludeId: 'me' }), 0);
});

test('enterGate：独占门禁拿到名额后建标记；标记存在时别的门禁在 enterGate 里等；释放后一起放行', async t => {
  const home = tmp(t);
  const deps = { home, ...fakes([process.pid]) };
  const acquire = id => () => acquireSlot({ home, kind: 'gate', id, limit: 2, intervalMs: 10, created: 1000, ...fakes([process.pid]) });
  const lines = [];
  const exclusive = await enterGate({ ...deps, id: 'd', name: 'D', command: 'npm run shots', acquire: acquire('d'), progress: text => lines.push(text), intervalMs: 10 });
  assert.equal((await readExclusive({ ...deps })).command, 'npm run shots');
  assert.ok(lines.some(line => line.includes('独占运行：npm run shots')));

  // 普通门禁（上限 2，还有空位）也不开始。
  const normalLines = [];
  let entered = false;
  const normal = enterGate({ ...deps, id: 'e', name: 'E', acquire: acquire('e'), progress: text => normalLines.push(text), intervalMs: 10 }).then(result => { entered = true; return result; });
  await sleep(120);
  assert.equal(entered, false);
  assert.deepEqual(normalLines, ['排队：D 的门禁正在独占运行（npm run shots），等它结束'], '只写一次');
  assert.equal(readdirSlots(home).includes('gate-2.json'), false, '没有占名额');

  exclusive.release();
  const second = await normal;
  assert.equal(existsSync(path.join(home, 'slots', 'exclusive.json')), false);
  second.release();
  assert.deepEqual(readdirSlots(home), []);
});

test('enterGate：独占门禁要等已经在跑的别的门禁结束；停止时放掉名额和标记并抛 { stopped }', async t => {
  const home = tmp(t);
  const deps = { home, ...fakes([process.pid]) };
  const acquire = id => () => acquireSlot({ home, kind: 'gate', id, limit: 2, intervalMs: 10, created: 1000, ...fakes([process.pid]) });
  const running = await acquireSlot({ home, kind: 'gate', id: 'run', limit: 2, intervalMs: 10, created: 1000, ...fakes([process.pid]) });
  const lines = [];
  let entered = false;
  const exclusive = enterGate({ ...deps, id: 'd', name: 'D', command: 'npm run shots', acquire: acquire('d'), progress: text => lines.push(text), intervalMs: 10 }).then(result => { entered = true; return result; });
  await sleep(120);
  assert.equal(entered, false, '别的门禁还在跑');
  assert.equal((await readExclusive(deps)).id, 'd', '标记已经建好，别的门禁不再开始');
  running();
  const result = await exclusive;
  assert.ok(lines.some(line => line.includes('等别的门禁结束')));
  result.release();
  assert.deepEqual(readdirSlots(home), []);

  const holder = await acquireSlot({ home, kind: 'gate', id: 'run2', limit: 2, intervalMs: 10, created: 1000, ...fakes([process.pid]) });
  const signal = { stopped: false };
  setTimeout(() => { signal.stopped = true; }, 80);
  await assert.rejects(enterGate({ ...deps, id: 'd2', name: 'D2', command: 'c', acquire: acquire('d2'), signal, intervalMs: 10 }), { stopped: true });
  assert.deepEqual(readdirSlots(home), ['gate-1.json'], '只剩别人的名额，没有标记');
  holder();
});

test('enterGate：两个独占门禁抢标记，输的放回名额重新等，不会互相等死', async t => {
  const home = tmp(t);
  const deps = { home, ...fakes([process.pid]) };
  const acquire = id => () => acquireSlot({ home, kind: 'gate', id, limit: 3, intervalMs: 10, created: 1000, ...fakes([process.pid]) });
  const first = await enterGate({ ...deps, id: 'a', name: 'A', command: 'npm run shots', acquire: acquire('a'), intervalMs: 10 });
  const secondPromise = enterGate({ ...deps, id: 'b', name: 'B', command: 'npm run shots', acquire: acquire('b'), intervalMs: 10 });
  await sleep(100);
  assert.deepEqual(readdirSlots(home).filter(name => name.startsWith('gate-')), ['gate-1.json'], 'B 没有占着名额等');
  first.release();
  const second = await secondPromise;
  assert.equal((await readExclusive(deps)).id, 'b');
  second.release();
  assert.deepEqual(readdirSlots(home), []);
});

// ---- 任务名额的上限函数 ----

test('createTaskLimit：固定档返回 concurrency；独占门禁在跑返回 0 并写一行进度；自动档忙时返回 0，恢复后按估算值', async t => {
  const home = tmp(t);
  const lines = [];
  let info = { limits: { concurrency: 3 }, mode: 'fixed', estimate: 4, max: 8 };
  const env = {};
  const limit = createTaskLimit({ home, progress: text => lines.push(text), readLimits: () => info, env, ...fakes([100]) });
  assert.equal(await limit(), 3);

  // 独占标记存在 → 0，进度只写一次；标记没了 → 恢复。
  await acquireExclusive({ home, id: 'd', name: 'D', command: 'npm run shots', pid: 100, created: 1000, ...fakes([100]) });
  assert.equal(await limit(), 0);
  assert.equal(await limit(), 0);
  assert.deepEqual(lines, ['排队：D 的门禁正在独占运行（npm run shots），等它结束']);
  rmSync(path.join(home, 'slots', 'exclusive.json'));
  assert.equal(await limit(), 3);

  // 自动档：忙（注入的采样）→ 0，不忙 → 估算值；固定档不看忙闲。
  const loadFile = path.join(home, 'load.json');
  env.AR_TEST_LOAD_FILE = loadFile;
  writeFileSync(loadFile, JSON.stringify({ busy: true, cpu: 92 }));
  info = { limits: { concurrency: 4 }, mode: 'auto', estimate: 4, max: 8 };
  lines.length = 0;
  assert.equal(await limit(), 0);
  assert.equal(await limit(), 0);
  assert.deepEqual(lines, ['排队：机器正忙（CPU 92%），暂停启动新任务']);
  writeFileSync(loadFile, JSON.stringify({ busy: false, cpu: 20 }));
  assert.equal(await limit(), 4);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^排队：机器恢复空闲/);
  info = { limits: { concurrency: 2 }, mode: 'fixed', estimate: 4, max: 8 };
  writeFileSync(loadFile, JSON.stringify({ busy: true, cpu: 99 }));
  assert.equal(await limit(), 2, '固定档不做忙时暂停');
});

test('createTaskLimit：每一轮按 readLimits 给的 memLowPercent 判断内存，配置改了不用重启', async t => {
  const home = tmp(t);
  const machine = fakeMachine({ total: 32 * GB, free: 2.6 * GB });
  const lines = [];
  let info = { limits: { concurrency: 4 }, mode: 'auto', estimate: 4, max: 8 };
  const limit = createTaskLimit({ home, progress: text => lines.push(text), readLimits: () => info, env: {}, monitor: createLoadMonitor(machine.options), ...fakes([100]) });
  assert.equal(await limit(), 4, '没写比例按默认 5%：阈值 1.6 GB，2.6 GB 够用');
  info = { ...info, memLowPercent: 10 };
  assert.equal(await limit(), 0, '改成 10%：阈值 3.2 GB，暂停');
  assert.deepEqual(lines, ['排队：机器正忙（可用内存 2.6 GB），暂停启动新任务']);
  info = { ...info, memLowPercent: 5 };
  for (let i = 0; i < 14; i++) { machine.advance(2, 10); assert.equal(await limit(), 0, `恢复要等 30 秒：${(i + 1) * 2} 秒`); }
  machine.advance(2, 10);
  assert.equal(await limit(), 4, '改回 5% 且满 30 秒后恢复');
});

test('createTaskLimit + acquireSlot：返回 0 时不占名额，恢复后才占', async t => {
  const home = tmp(t);
  let paused = true;
  const pending = acquireSlot({ home, kind: 'task', id: 'x', limit: async () => (paused ? 0 : 1), intervalMs: 10, created: 1000, ...fakes([process.pid]) });
  await sleep(100);
  assert.deepEqual(readdirSlots(home), [], '暂停期间没有名额文件');
  paused = false;
  const release = await pending;
  assert.deepEqual(readdirSlots(home), ['slot-1.json']);
  release();
});