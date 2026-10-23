import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREATED_TOLERANCE_MS, identityAlive, pidAlive, processList, sameIdentity, terminateByIdentity } from '../../core/lib/process.mjs';

// 073：测试清理按身份（PID + 创建时间）逐个结束自己启动的进程，取代"快照后按 PID taskkill /T"。
// 快照到结束之间进程可能已退出、PID 被无关进程复用，按 PID（尤其带 /T）会误伤复用者及其子孙。
// marker：测试临时目录的绝对路径，必须在系统临时目录之下，防止误配成宽匹配。
function assertUnderTemp(marker) {
  if (typeof marker !== 'string' || !marker.trim()) throw Error('cleanupProcesses：marker 不能为空');
  const fold = value => (process.platform === 'win32' ? value.toLowerCase() : value);
  const roots = new Set();
  for (const root of [os.tmpdir(), process.env.TEMP, process.env.TMP]) {
    if (!root) continue;
    roots.add(path.resolve(root));
    try { roots.add(realpathSync.native(root)); } catch { /* 目录不存在就只用原值。 */ }
  }
  const target = fold(path.resolve(marker));
  const inside = [...roots].some(root => target.startsWith(fold(root) + path.sep) && target.length > fold(root).length + 1);
  if (!path.isAbsolute(marker) || !inside) throw Error(`cleanupProcesses：marker 必须是系统临时目录下的绝对路径：${marker}`);
}

// runs.jsonl 的 start 行里还没有 end / interrupted 的派发进程 PID，配合 cleanupProcesses 的 recorded 选项。
export function recordedStarts(rows, script, since) {
  // 重试沿用同一个 id（start → end → resume …），所以看每个 id 的最后一条状态行。
  const last = new Map();
  for (const r of rows) if (['start', 'resume', 'end', 'interrupted'].includes(r.event)) last.set(r.id, r.event);
  const open = rows.filter(r => r.event === 'start' && !['end', 'interrupted'].includes(last.get(r.id)));
  // started：start 行写入时的毫秒时间。派发进程总是先被创建、再写 start，所以真正的派发进程创建时间不晚于 started；
  // PID 被别的进程复用时，复用者一定创建在原进程退出之后（也就晚于 started）。
  return { pids: open.map(r => r.pid), starts: open.map(r => ({ pid: r.pid, started: r.started })), script, since };
}

// 返回 { killed, notes }：killed 是本函数结束的身份，notes 是诊断（不让测试失败）。
// 注入项仅供单元测试：list（快照）、terminate（win32 句柄方式）、kill（POSIX 结束）、platform。
export async function cleanupProcesses(marker, { rounds = 3, list = processList, terminate = terminateByIdentity, kill = process.kill.bind(process), platform = process.platform, diagnostic, recorded } = {}) {
  assertUnderTemp(marker);
  const killed = [], notes = [];
  const note = text => { notes.push(text); try { diagnostic?.(text); } catch { /* 诊断不能影响清理。 */ } };
  const done = new Set();
  // 登记项：PID → started（毫秒）。started 不是有限数的不选；没有 starts 时（只给 pids）也不选，宁可漏掉。
  const recordedStartedAt = new Map();
  for (const s of recorded?.starts ?? []) if (Number.isSafeInteger(s?.pid) && Number.isFinite(s.started)) recordedStartedAt.set(s.pid, s.started);
  const recordedPids = new Set(recordedStartedAt.keys());
  const pick = rows => {
    // 根：命令行含 marker；或登记里记录的 PID，且命令行含 recorded.script（核心入口）、创建时间不早于 recorded.since
    // （这些进程的命令行里没有临时目录，只能这样多重核对身份）。再加上根的子孙：父 PID 相同且创建时间不早于父。
    const chosen = new Map();
    const eligible = p => p.pid !== process.pid && Number.isFinite(p.created) && !done.has(`${p.pid}:${p.created}`);
    for (const p of rows) {
      if (!eligible(p)) continue;
      const byMarker = String(p.command ?? '').includes(marker);
      const byRecord = recordedPids.has(p.pid) && recorded.script && String(p.command ?? '').includes(recorded.script)
        && p.created >= (recorded.since ?? 0) - 2000 && p.created <= recordedStartedAt.get(p.pid) + CREATED_TOLERANCE_MS;
      if (byMarker || byRecord) chosen.set(p.pid, p);
    }
    if (recordedPids.size) {
      for (let grown = true; grown;) {
        grown = false;
        for (const p of rows) {
          const parent = chosen.get(p.parent);
          if (chosen.has(p.pid) || !eligible(p) || !parent || p.created < parent.created) continue;
          chosen.set(p.pid, p);
          grown = true;
        }
      }
    }
    return [...chosen.values()].map(p => ({ pid: p.pid, created: p.created }));
  };
  try {
    for (let round = 0; round < Math.max(1, rounds); round++) {
      const snapshot = await list();
      const targets = pick(snapshot);
      if (!targets.length) return { killed, notes };
      for (const id of targets) done.add(`${id.pid}:${id.created}`);
      if (platform === 'win32') {
        const results = await terminate(targets);
        for (const id of targets) if (results.get(id.pid) === 'killed') killed.push(id);
        for (const id of targets) {
          const result = results.get(id.pid);
          if (result !== 'killed' && result !== 'gone' && result !== 'reused') note(`清理：pid=${id.pid} 结果 ${result}`);
        }
      } else {
        const fresh = await list();
        for (const id of targets) {
          if (!fresh.some(p => sameIdentity(p, id))) continue;
          try { kill(id.pid); killed.push(id); } catch { /* 已退出。 */ }
        }
      }
    }
    const left = pick(await list());
    if (left.length) note(`清理：${rounds} 轮后仍有命令行含 marker 的新进程 ${left.map(p => p.pid).join(',')}`);
  } catch (error) {
    note(`清理失败（不退回按 PID 结束）：${error.message}`);
  }
  return { killed, notes };
}

// 069：停止 / 结束进程树之后，断言"那个进程"已经退出——按身份（PID + 创建时间）认定，不只看 PID：
// Windows 复用 PID 很快（实测停止后几秒内就被新的 conhost.exe 占用），只看 PID 会把复用者误判成"没退出"。

// 停止之前调用：从一次完整进程快照里取这些 PID 的身份。取不到（不在快照里、创建时间不是有限数）直接失败。
export async function captureIdentities(pids, label = '停止前') {
  const rows = await processList();
  return pids.map(pid => {
    const row = rows.find(p => p.pid === pid);
    assert.ok(row && Number.isFinite(row.created), `${label}快照里应有 pid ${pid} 及其创建时间`);
    return { pid, created: row.created };
  });
}

// 停止之后调用：这些身份都不再存活。PID 已不存活就是已退出；PID 仍存活时看进程快照里这个 PID 的创建时间——
// 与停止前相同才算没退出，不同说明 PID 已被另一个进程占用。快照查询失败时抛出（断言失败，不能当通过）。
// 失败信息里带停止前后两次的身份（PID + 创建时间）。
export async function assertIdentitiesGone(identities, label) {
  const describe = ids => ids.map(id => `pid=${id.pid} created=${id.created}`).join('；') || '（无）';
  const listed = identities.filter(id => pidAlive(id.pid));
  let left = [], after = [];
  if (listed.length) {
    const rows = await processList();
    left = listed.filter(id => identityAlive(rows, id));
    after = listed.map(id => rows.find(p => p.pid === id.pid)).filter(Boolean);
  }
  assert.deepEqual(left.map(id => id.pid), [], `${label}：停止前 ${describe(identities)}；停止后快照里仍有 ${describe(left)}（这些 PID 现在是 ${describe(after)}）`);
}
