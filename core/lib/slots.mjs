// 并发名额：全局（跨项目、跨进程）的文件名额，任务名额（slot-<k>.json）与门禁名额（gate-<k>.json）共用一套规则，
// 规则见文件协议 15.5。名额文件在 <公共目录>/slots/ 下，内容 { id, pid, created, at }；
// 占用靠独占创建，占用者不存活（或 PID 被别的进程复用）的名额按孤立回收。
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, linkSync, writeFileSync } from 'node:fs';
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
// signal.stopped 为真时抛出 { stopped: true } 的错误。
export async function acquireSlot({
  home, kind, id, limit, pid = process.pid, created, signal, onWait, intervalMs = 2000,
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
  for (;;) {
    if (signal?.stopped) throw stopped();
    for (let k = 1; k <= limit; k++) {
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
