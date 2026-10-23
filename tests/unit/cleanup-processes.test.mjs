import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pidAlive, processList } from '../../core/lib/process.mjs';
import { assertIdentitiesGone, cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 073：测试清理按身份（PID + 创建时间）结束进程。单元测试注入快照与结束函数；真实进程的小测试只在系统临时目录里起假进程。
const marker = path.join(os.tmpdir(), 'ar-cleanup-073-fake');
const proc = (pid, created, command, parent = 1) => ({ pid, parent, created, name: 'node.exe', command });

test('marker 为空、不是绝对路径或不在系统临时目录下 → 抛错，什么都不查', async () => {
  const never = () => { throw Error('不应被调用'); };
  for (const bad of ['', '   ', undefined, 'relative/dir', os.tmpdir(), path.join(path.parse(os.tmpdir()).root, 'not-temp-dir'), path.join(os.tmpdir(), '..', 'escape')]) {
    await assert.rejects(cleanupProcesses(bad, { list: never, terminate: never, kill: never, platform: 'win32' }), /marker/, String(bad));
  }
});

test('win32：命令行不含 marker 的进程不被选中', async () => {
  const seen = [];
  const rows = [proc(10, 1000, `node -e x /* ${marker} */`), proc(11, 1001, 'node other.js'), proc(12, 1002, '')];
  let listed = 0;
  const list = async () => (listed++ === 0 ? rows : []);
  const terminate = async targets => { seen.push(...targets); return new Map(targets.map(t => [t.pid, 'killed'])); };
  const { killed } = await cleanupProcesses(marker, { list, terminate, platform: 'win32' });
  assert.deepEqual(seen, [{ pid: 10, created: 1000 }]);
  assert.deepEqual(killed, [{ pid: 10, created: 1000 }]);
});

test('win32：创建时间不是有限数的进程不结束', async () => {
  const seen = [];
  const list = async () => [proc(10, null, marker), proc(11, 'x', marker), proc(12, NaN, marker)];
  await cleanupProcesses(marker, { list, terminate: async t => { seen.push(...t); return new Map(); }, platform: 'win32' });
  assert.deepEqual(seen, []);
});

test('win32：快照后 PID 被复用（结束函数返回 reused）→ 不算结束、不报错、不调用任何按 PID 的结束', async () => {
  const pidKills = [];
  let listed = 0;
  const list = async () => (listed++ === 0 ? [proc(10, 1000, marker)] : []);
  const result = await cleanupProcesses(marker, { list, terminate: async t => new Map(t.map(x => [x.pid, 'reused'])), kill: pid => pidKills.push(pid), platform: 'win32' });
  assert.deepEqual(result.killed, []);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(pidKills, []);
});

test('win32：第二轮才出现的新子孙也会被结束；同一身份不重复结束', async () => {
  const rounds = [[proc(10, 1000, marker)], [proc(10, 1000, marker), proc(20, 2000, marker, 10)], []];
  let at = 0;
  const calls = [];
  const list = async () => rounds[Math.min(at++, rounds.length - 1)];
  const terminate = async targets => { calls.push(targets.map(t => t.pid)); return new Map(targets.map(t => [t.pid, 'killed'])); };
  const { killed } = await cleanupProcesses(marker, { list, terminate, platform: 'win32', rounds: 3 });
  assert.deepEqual(calls, [[10], [20]]);
  assert.deepEqual(killed.map(k => k.pid), [10, 20]);
});

test('win32：最多 rounds 轮，最后仍有新残留只记诊断，不抛错', async () => {
  let n = 0;
  const list = async () => [proc(100 + n++, 1000 + n, marker)];
  const terminate = async targets => new Map(targets.map(t => [t.pid, 'killed']));
  const lines = [];
  const result = await cleanupProcesses(marker, { list, terminate, platform: 'win32', rounds: 2, diagnostic: line => lines.push(line) });
  assert.equal(result.killed.length, 2);
  assert.ok(result.notes.some(line => line.includes('仍有')) && lines.length === result.notes.length);
});

test('win32：terminateByIdentity 整体失败 → 只记一行诊断，不调用任何按 PID 的结束', async () => {
  const pidKills = [];
  const lines = [];
  const result = await cleanupProcesses(marker, {
    list: async () => [proc(10, 1000, marker)],
    terminate: async () => { throw Error('PowerShell 被拦'); },
    kill: pid => pidKills.push(pid), platform: 'win32', diagnostic: line => lines.push(line),
  });
  assert.deepEqual(pidKills, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /不退回按 PID/);
  assert.deepEqual(result.killed, []);
});

test('POSIX：结束前用同一次快照的创建时间再核对一次身份，一致才结束', async () => {
  let listed = 0;
  // 第 1 次快照选出 10（created 1000）；结束前再取的快照里 10 已是另一个进程（created 9999）→ 不结束；11 身份一致 → 结束。
  const snapshots = [
    [proc(10, 1000, marker), proc(11, 1100, marker)],
    [proc(10, 9999, 'other'), proc(11, 1100, marker)],
    [],
  ];
  const killedPids = [];
  const result = await cleanupProcesses(marker, { list: async () => snapshots[Math.min(listed++, 2)], kill: pid => killedPids.push(pid), platform: 'linux' });
  assert.deepEqual(killedPids, [11]);
  assert.deepEqual(result.killed.map(k => k.pid), [11]);
});

test('recordedStarts：只取最后状态不是 end / interrupted 的 start 行；重试沿用 id 时看最后一条', () => {
  const rows = [
    { event: 'start', id: 'a', pid: 1 }, { event: 'end', id: 'a' },
    { event: 'start', id: 'b', pid: 2, started: 20 }, { event: 'end', id: 'b' }, { event: 'resume', id: 'b' },
    { event: 'start', id: 'c', pid: 3, started: 30 },
  ];
  const got = recordedStarts(rows, 'x', 5);
  assert.deepEqual(got.pids, [2, 3]);
  assert.deepEqual(got.starts, [{ pid: 2, started: 20 }, { pid: 3, started: 30 }]);
});

test('recorded：登记的 PID 要命令行含核心入口、创建时间不早于 since；其子孙（父子创建时间一致）一并结束，复用者不动', async () => {
  const script = path.join(os.tmpdir(), 'ar-recorded-073-core', 'ar.mjs');
  const rows = [
    proc(10, 5000, `node ${script} dispatch`),          // 登记的派发进程：入选
    proc(11, 5100, 'node fake-agent', 10),              // 子孙：入选
    proc(12, 4000, 'node fake-agent', 10),              // 创建时间早于父进程：PID 复用，不选
    proc(20, 5000, 'node unrelated.js'),                // 登记的 PID 但命令行不含入口（被复用）：不选
    proc(21, 5200, 'node unrelated.js', 20),            // 它的子孙也不选
    proc(30, 100, `node ${script} dispatch`),           // 创建时间早于 since：不选
    proc(40, 9000, `node ${script} dispatch`),          // 登记的 PID 已被另一个并行测试的核心进程占用：创建时间晚于 started，不选
    proc(41, 9100, 'node fake-agent', 40),              // 它的子孙也不选
    proc(50, 5000, `node ${script} dispatch`),          // started 不是有限数：不选
  ];
  const seen = [];
  let listed = 0;
  const run = async recorded => {
    seen.length = 0; listed = 0;
    await cleanupProcesses(marker, {
      list: async () => (listed++ === 0 ? rows : []),
      terminate: async t => { seen.push(...t.map(x => x.pid)); return new Map(t.map(x => [x.pid, 'killed'])); },
      platform: 'win32',
      recorded,
    });
    return seen.sort((a, b) => a - b);
  };
  const starts = [{ pid: 10, started: 5300 }, { pid: 20, started: 5300 }, { pid: 30, started: 5300 }, { pid: 40, started: 5300 }, { pid: 50, started: undefined }];
  assert.deepEqual(await run({ starts, script, since: 4900 }), [10, 11]);
  // 只给 pids、没有 started（旧格式）：一个都不选。
  assert.deepEqual(await run({ pids: [10, 20, 30, 40], script, since: 4900 }), []);
});

test('recorded：登记 PID 被创建时间晚于 started 的核心进程占用 → 不选、不结束；创建时间不晚于 started 的才选', async () => {
  const script = path.join(os.tmpdir(), 'ar-recorded-073-core', 'ar.mjs');
  const run = async created => {
    const seen = [];
    let listed = 0;
    await cleanupProcesses(marker, {
      list: async () => (listed++ === 0 ? [proc(60, created, `node ${script} dispatch`)] : []),
      terminate: async t => { seen.push(...t.map(x => x.pid)); return new Map(t.map(x => [x.pid, 'killed'])); },
      platform: 'win32',
      recorded: { starts: [{ pid: 60, started: 7000 }], script, since: 6000 },
    });
    return seen;
  };
  assert.deepEqual(await run(7500), [], '复用者创建在 started 之后');
  assert.deepEqual(await run(7002), [], '超过容差也不选');
  assert.deepEqual(await run(6900), [60]);
  assert.deepEqual(await run(7001), [60], '容差内（毫秒舍入）仍选');
});

// 真实进程：只在系统临时目录里起假进程。
test('真实进程：清理后两个含临时目录的进程身份不在快照里，不含的那个仍存活', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-cleanup-073-'));
  const tag = path.basename(dir);
  const spawnFake = text => spawn(process.execPath, ['-e', `setTimeout(() => {}, 60000) /* ${text} */`], { stdio: 'ignore', windowsHide: true, shell: false });
  const inside = [spawnFake(dir), spawnFake(dir)], outside = spawnFake(`${tag}-other-no-marker`);
  // 命令行里不含完整 dir，只含 tag 的第三个进程：marker 用完整路径，不能把它选进来。
  t.after(() => {
    for (const child of [...inside, outside]) if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const wanted = [...inside, outside].map(c => c.pid);
  let rows = [];
  for (let i = 0; i < 100; i++) {
    rows = await processList().catch(() => []);
    if (wanted.every(pid => rows.some(p => p.pid === pid && String(p.command).includes(tag)))) break;
    await delay(100);
  }
  const identities = inside.map(c => {
    const row = rows.find(p => p.pid === c.pid && String(p.command).includes(dir));
    assert.ok(row && Number.isFinite(row.created), `假进程 ${c.pid} 出现在快照里`);
    return { pid: row.pid, created: row.created };
  });
  const outsideRow = rows.find(p => p.pid === outside.pid);
  assert.ok(outsideRow && !String(outsideRow.command).includes(dir));
  const result = await cleanupProcesses(dir, { diagnostic: line => t.diagnostic(line) });
  assert.equal(result.killed.length, 2, JSON.stringify(result));
  await delay(300);
  await assertIdentitiesGone(identities, '含临时目录的假进程已被清理');
  assert.equal(pidAlive(outside.pid), true, '不含临时目录的假进程仍存活');
  assert.ok((await processList()).some(p => p.pid === outside.pid && p.created === outsideRow.created));
});
