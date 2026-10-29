// 并发名额：全局（跨项目、跨进程）的文件名额，任务名额（slot-<k>.json）与门禁名额（gate-<k>.json）共用一套规则，
// 规则见文件协议 15.5。名额文件在 <公共目录>/slots/ 下，内容 { id, pid, created, at }；
// 占用靠独占创建，占用者不存活（或 PID 被别的进程复用）的名额按孤立回收。
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, linkSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CREATED_TOLERANCE_MS, pidAlive, processCreated } from './process.mjs';

const prefixes = { task: 'slot', gate: 'gate' };
const slotsDir = home => join(home, 'slots');

// 现在占着名额的文件数（只数 <前缀>-<k>.json，不含 .stale- 残留）。
export function countSlots({ home, kind }) {
  const pattern = new RegExp(`^${prefixes[kind]}-\\d+\\.json$`);
  try { return readdirSync(slotsDir(home)).filter(name => pattern.test(name)).length; }
  catch { return 0; }
}

// 文件内容合法且占用者已经不在：pid 不存活，或存活但进程创建时间与文件里的不同（PID 复用）。
// 读不了、不是合法 JSON 的（可能正在写）一律不算孤立；创建时间查不到时按"还在"处理。
async function orphaned(text, { isAlive, createdOf }) {
  let info;
  try { info = JSON.parse(text); } catch { return false; }
  if (!info || typeof info !== 'object' || !Number.isSafeInteger(info.pid)) return false;
  if (!(await isAlive(info.pid))) return true;
  if (!Number.isFinite(info.created)) return false;
  const actual = await createdOf(info.pid);
  return Number.isFinite(actual) && Math.abs(actual - info.created) > CREATED_TOLERANCE_MS;
}

// 回收孤立的名额文件：先改名成 .stale-<随机> 再删。读到内容到改名之间文件可能已被别人回收并重新占用，
// 所以改名后核对内容：不是刚才读到的那份就把它放回去（不覆盖已有文件）。
function reclaim(file, text) {
  const stale = `${file}.stale-${randomUUID().slice(0, 8)}`;
  try { renameSync(file, stale); } catch { return; }
  let moved = null;
  try { moved = readFileSync(stale, 'utf8'); } catch { /* 读不了就按已回收处理。 */ }
  if (moved !== null && moved !== text) {
    try { linkSync(stale, file); } catch { /* 名额又被别人占了，不覆盖。 */ }
  }
  rmSync(stale, { force: true });
}

// 取一个名额，返回释放函数 release()（可重复调用，第二次起什么都不做）。
// limit 个名额依次试；全满时第一次调用 onWait({ held })（held 为当前占着的名额数，只调一次），之后每 intervalMs 再试一轮；
// limit 可以是数字，也可以是 () => number（可以是异步的），每轮开始时调用一次：抛错或返回的不是整数时沿用上一轮的值（第一轮就失败按 1），
// 返回 0 表示这一轮暂停（并行调度 140：独占门禁在跑、机器正忙），不试任何名额、也不算上限变化；
// 值变化时调用 onLimit(新值, 旧值)。调小只影响之后的新调用者（只试 1..新上限），已占着的名额不回收。
// signal.stopped 为真时抛出 { stopped: true } 的错误。
export async function acquireSlot({
  home, kind, id, limit, pid = process.pid, created, signal, onWait, onLimit, intervalMs = 2000,
  now = Date.now, isAlive = pidAlive, createdOf = processCreated,
}) {
  const prefix = prefixes[kind];
  if (!prefix) throw new Error(`未知的名额类型：${kind}`);
  const dir = slotsDir(home);
  mkdirSync(dir, { recursive: true });
  const stopped = () => Object.assign(new Error('等名额时被停止'), { stopped: true });
  let content = null;
  const create = file => {
    try { writeFileSync(file, content, { flag: 'wx' }); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  };
  let waited = false;
  let current = null;
  for (;;) {
    if (signal?.stopped) throw stopped();
    let next = limit;
    if (typeof limit === 'function') {
      try { next = await limit(); } catch { next = null; }
    }
    const paused = next === 0 && typeof limit === 'function';
    if (!paused) {
      if (!Number.isSafeInteger(next) || next < 1) next = current ?? 1;
      if (current !== null && next !== current) onLimit?.(next, current);
      current = next;
    }
    for (let k = 1; !paused && k <= current; k++) {
      const file = join(dir, `${prefix}-${k}.json`);
      // 创建时间只在第一次真的要占名额时查一次（平台查询有代价）。
      if (content === null) {
        const own = created === undefined ? await createdOf(pid) : created;
        content = JSON.stringify({ id, pid, created: Number.isFinite(own) ? own : null, at: now() });
      }
      const release = () => {
        try { if (readFileSync(file, 'utf8') === content) rmSync(file, { force: true }); } catch { /* 文件已经不在了。 */ }
      };
      let held = create(file);
      if (!held) {
        let text = null;
        try { text = readFileSync(file, 'utf8'); } catch { /* 读不了：不回收。 */ }
        if (text !== null && await orphaned(text, { isAlive, createdOf })) {
          reclaim(file, text);
          held = create(file);
        }
      }
      if (held) {
        let done = false;
        return () => { if (!done) { done = true; release(); } };
      }
    }
    if (!waited) { waited = true; onWait?.({ held: countSlots({ home, kind }) }); }
    await delay(intervalMs);
  }
}

// ---- 独占标记（并行调度 140）----
// slots/exclusive.json：独占门禁（验收命令在项目配置 exclusiveCommands 里）运行期间存在，内容 { id, pid, created, at, name, command }。
// 回收规则同名额文件：占用者不存活（或 PID 被复用）就回收。标记存在时不开始新任务、不开始别的门禁。
const exclusiveFile = home => join(slotsDir(home), 'exclusive.json');
// 读不了内容的标记（可能正在写）按"还在"处理；超过这么久还读不了说明写到一半进程就没了，按孤立回收。
const UNREADABLE_EXCLUSIVE_MS = 10000;

// 现在的独占标记：{ id, pid, created, at, name, command }；没有或占用者已经不在返回 null（孤立的顺手回收）。
export async function readExclusive({ home, isAlive = pidAlive, createdOf = processCreated }) {
  const file = exclusiveFile(home);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  let info = null;
  try { info = JSON.parse(text); } catch { /* 下面按读不了处理。 */ }
  if (!info || typeof info !== 'object' || !Number.isSafeInteger(info.pid)) {
    try {
      if (Date.now() - statSync(file).mtimeMs > UNREADABLE_EXCLUSIVE_MS) { reclaim(file, text); return null; }
    } catch { return null; }
    return { id: null, name: null, command: null };
  }
  if (await orphaned(text, { isAlive, createdOf })) { reclaim(file, text); return null; }
  return info;
}

// 建标记；别的任务的标记还在（占用者存活）返回 null，成功返回释放函数（可重复调用，只删自己写的那份）。
export async function acquireExclusive({
  home, id, name, command, pid = process.pid, created, now = Date.now, isAlive = pidAlive, createdOf = processCreated,
}) {
  mkdirSync(slotsDir(home), { recursive: true });
  const own = created === undefined ? await createdOf(pid) : created;
  const content = JSON.stringify({ id, pid, created: Number.isFinite(own) ? own : null, at: now(), name, command });
  const file = exclusiveFile(home);
  for (let tries = 0; tries < 2; tries++) {
    try {
      writeFileSync(file, content, { flag: 'wx' });
      let done = false;
      return () => {
        if (done) return;
        done = true;
        try { if (readFileSync(file, 'utf8') === content) rmSync(file, { force: true }); } catch { /* 文件已经不在了。 */ }
      };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (await readExclusive({ home, isAlive, createdOf })) return null;
  }
  return null;
}

// <前缀>-<k>.json 里占用者还在、且不是 excludeId 的个数（独占门禁等别的门禁排空用）；孤立的不算。
export async function liveHolders({ home, kind, excludeId, isAlive = pidAlive, createdOf = processCreated }) {
  const pattern = new RegExp(`^${prefixes[kind]}-\\d+\\.json$`);
  let names;
  try { names = readdirSync(slotsDir(home)).filter(name => pattern.test(name)); } catch { return 0; }
  let count = 0;
  for (const name of names) {
    let text;
    try { text = readFileSync(join(slotsDir(home), name), 'utf8'); } catch { continue; }
    let info = null;
    try { info = JSON.parse(text); } catch { /* 读不了：保守地算还在。 */ }
    if (info?.id === excludeId) continue;
    if (info && await orphaned(text, { isAlive, createdOf })) continue;
    count++;
  }
  return count;
}

// 删除 slots/ 下内容 id 等于它的文件（收尾兜底与 ar gc 用）；读不了或不是合法 JSON 的文件不动。
export function releaseAllFor({ home, id }) {
  let names;
  try { names = readdirSync(slotsDir(home)); } catch { return; }
  for (const name of names) {
    const file = join(slotsDir(home), name);
    try {
      if (JSON.parse(readFileSync(file, 'utf8'))?.id === id) rmSync(file, { force: true });
    } catch { /* 读不了或不是合法 JSON：不动。 */ }
  }
}
