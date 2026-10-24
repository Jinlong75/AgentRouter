import { openSync, fstatSync, readSync, closeSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { printCompletion } from './completion.mjs';
import { taskAlive } from './process.mjs';

export const waitInterval = 50;
// 托管请求文件已在公共目录而清单还没有对应的 start（脱离派发）或 resume（脱离重试）时，
// 最多重查这么久（协议 14.4 与开工前第 8 条）。15 秒后仍没有就按原样处理。
export const startWaitLimit = 15000;
// 清单行版本：v1（旧记录与非 start 行）与 v2（新 start）都接受。
const known = row => row?.v === 1 || row?.v === 2;

// 从尾部逐块读，跨块行保持原始字节，避免截断中文；末尾半行不参与解析。
export function* reverseRows(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    let offset = fstatSync(fd).size, suffix = Buffer.alloc(0), complete = false;
    while (offset > 0) {
      const size = Math.min(65536, offset);
      offset -= size;
      const chunk = Buffer.alloc(size);
      const n = readSync(fd, chunk, 0, size, offset);
      const data = Buffer.concat([chunk.subarray(0, n), suffix]);
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 10) continue;
        if (complete) {
          let row;
          try { row = JSON.parse(data.subarray(i + 1, end).toString('utf8')); } catch { /* 忽略坏行。 */ }
          if (known(row)) yield row;
        }
        complete = true;
        end = i;
      }
      // 尚未遇到换行时是在跳过尾部半行，无需保存它。
      suffix = complete ? data.subarray(0, end) : Buffer.alloc(0);
    }
    if (complete) {
      let row;
      try { row = JSON.parse(suffix.toString('utf8')); } catch { /* 忽略坏行。 */ }
      if (known(row)) yield row;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const repoKey = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
export function findStart(file, root, name) {
  for (const row of reverseRows(file)) {
    if (row.event === 'start' && typeof row.repo === 'string' && repoKey(row.repo) === repoKey(root)
      && (name === undefined || row.name === name)) return row;
  }
  return null;
}

// 最近一条 resume（任务 059，协议 14.4）：手动重试后，状态与进程核对都以最近一条 start / resume 为准。
export function findResume(file, id) {
  for (const row of reverseRows(file)) {
    if (row.id === id && row.event === 'resume') return row;
  }
  return null;
}

export function findTerminal(file, id) {
  let interrupted = null;
  for (const row of reverseRows(file)) {
    if (row.id !== id) continue;
    if (row.event === 'end') return row;
    if (row.event === 'interrupted') interrupted ??= row;
    // 手动重试（协议 14.4）：resume 之后重新算，之前的 end / interrupted 不算。
    if (row.event === 'start' || row.event === 'resume') break;
  }
  return interrupted;
}

// worktree 任务结束之后的状态（协议 15.3）：从尾部往前，先遇到哪个事件就是哪个状态。
// accepted / rejected / conflict 都写在 end 之后；cleanup 不改变状态，直接跳过；resume 之后重新算。
// 返回 awaiting / accepted / rejected / conflict / failed / stopped；任务还没结束返回 null。
export function worktreeOutcome(file, id) {
  for (const row of reverseRows(file)) {
    if (row.id !== id) continue;
    if (row.event === 'accepted') return 'accepted';
    if (row.event === 'rejected') return 'rejected';
    if (row.event === 'conflict') return 'conflict';
    if (row.event === 'end') return (row.exit ?? 1) === 0 ? 'awaiting' : 'failed';
    if (row.event === 'interrupted') return 'stopped';
    if (row.event === 'start' || row.event === 'resume') break;
  }
  return null;
}

// 同一任务最近一条指定事件（不限于最近一次 start / resume 之后，如 worktree 事件只在第一次准备时写）。
export function latestEvent(file, id, event) {
  for (const row of reverseRows(file)) if (row.id === id && row.event === event) return row;
  return null;
}

// 同一任务最近一次门禁结果（gate 事件总在 end 之前，协议第 2 节）；没跑过门禁返回 null。
// resume 之后才算（协议 14.4）：上一次尝试的门禁不该显示成这一次的结果。
export function findGate(file, id) {
  for (const row of reverseRows(file)) {
    if (row.id !== id) continue;
    if (row.event === 'gate') return row;
    if (row.event === 'start' || row.event === 'resume') break;
  }
  return null;
}

// 在新旧公共目录的清单里找记录：v2 写在新目录，v1 旧任务可能还在旧目录；两边都有时取最近开始的。
// 手动重试过（协议 14.4）：返回的 start 换成最近一条 resume 的 pid 与时刻（started = resume.at，
// 进程创建不晚于它），其余字段仍取同一条 start——等待的存活检查、ar stop 的进程核对都用它。
export function locateStart(homes, root, name) {
  let found = null;
  for (const home of new Set([homes].flat())) {
    const file = join(home, 'runs.jsonl'), start = findStart(file, root, name);
    if (start && (!found || start.started > found.start.started)) found = { home, file, start };
  }
  if (!found) return null;
  const resume = findResume(found.file, found.start.id);
  if (!resume) return found;
  return { ...found, start: { ...found.start, pid: resume.pid, started: resume.at, resumed: true, n: resume.n } };
}

// 公共目录 managed/ 里这个项目（给了记录名时还包括记录名）的待处理请求文件
// （.claimed.json 或 .running.json，协议第 7 节第 8 条）。坏文件、无法读取的目录都跳过。
function pendingRequests(homes, root, name) {
  const found = [];
  for (const home of new Set([homes].flat())) {
    let entries = [];
    try { entries = readdirSync(join(home, 'managed')); } catch { continue; }
    for (const entry of entries) {
      if (!/\.(claimed|running)\.json$/.test(entry)) continue;
      try {
        const request = JSON.parse(readFileSync(join(home, 'managed', entry), 'utf8'));
        if (request && typeof request.repo === 'string' && repoKey(request.repo) === repoKey(root)
          && (name === undefined || request.name === name)) found.push(request);
      } catch { /* 忽略损坏的请求文件。 */ }
    }
  }
  return found;
}

// 清单里是否已有对应编号的 resume（脱离重试的空档：请求文件在、执行者还没写 resume）。
function hasResumeN(file, id, n) {
  for (const row of reverseRows(file)) {
    if (row.id === id && row.event === 'resume' && row.n === n) return true;
  }
  return false;
}

// 按托管请求文件等待清单跟上（协议 14.4 与开工前第 8 条）：
// - 清单还找不到 start，但 managed/ 里有这个项目、这个记录名的请求文件 → 每 50 ms 重查，最多 15 秒；
// - 已有 start 而请求文件带 retry、清单还没有对应 n 的 resume（ar retry --detach 的空档）→ 同样重查，
//   以免把上一次的 end / 旧 pid 当成本次的结果。
// 没有请求文件时立刻返回，行为与直接 locateStart 相同。
export async function locateStartWaiting(homes, root, name) {
  const deadline = Date.now() + startWaitLimit;
  let found = locateStart(homes, root, name);
  while (Date.now() < deadline) {
    const requests = pendingRequests(homes, root, name);
    const waiting = !found
      ? requests.length > 0
      : requests.some(request => request.id === found.start.id && request.retry
        && Number.isSafeInteger(request.retry.n) && !hasResumeN(found.file, found.start.id, request.retry.n));
    if (!waiting) return found;
    await delay(waitInterval);
    found = locateStart(homes, root, name);
  }
  return found;
}

// worktree 任务等到结束时的状态（协议 15.3）；onState 收到它。待验收（awaiting）时多打印一行怎么处理（协议 15.11）。
export const awaitingLine = name => `待验收：用 ar accept ${name} 合并，或 ar reject ${name} --reason "…" 驳回`;

export async function waitForTask(homes, root, name, { alive = taskAlive, log = console.log, onGate, onState } = {}) {
  const found = await locateStartWaiting(homes, root, name), file = found?.file, start = found?.start;
  if (!start) {
    // 未指定记录名且仓库无记录时省略记录名（设计 2026-10-13 定稿）。
    log(`等待：在当前仓库找不到记录${name === undefined ? '' : ` ${name}`}`);
    return 2;
  }
  let terminal = findTerminal(file, start.id);
  let running = terminal ? false : await alive(start);
  // 查询进程时任务可能恰好结束，输出和中断判定前再次检查清单。
  terminal ??= findTerminal(file, start.id);
  log(`等待：${start.name}（${terminal || !running ? '已结束' : '进行中'}）`);
  // 门禁结果来自同一任务的 gate 事件，打印在结果行之前（协议 13）。
  const finishWait = async done => {
    const gate = done.event === 'end' ? findGate(file, start.id) : null;
    if (gate) {
      onGate?.({ ok: gate.ok === true, summary: gate.summary });
      log(gate.ok === true ? '门禁通过' : `门禁未通过：${gate.summary}`);
    }
    const code = await printCompletion(done.event === 'end' ? done.exit ?? 1 : 1, start, log);
    // worktree 任务（协议 15.11）：多报状态；待验收的退出码是 0，并提示下一步。非 worktree 任务不变。
    if (start.worktree === true) {
      const state = worktreeOutcome(file, start.id) ?? (done.event === 'end' ? 'failed' : 'stopped');
      onState?.(state);
      if (state === 'awaiting') log(awaitingLine(start.name));
    }
    return code;
  };
  while (true) {
    if (terminal) return finishWait(terminal);
    if (!running) {
      log('等待：任务进程已经不在了，没有结束记录，按中断处理');
      if (start.worktree === true) onState?.('stopped');
      return 1;
    }
    await delay(waitInterval);
    terminal = findTerminal(file, start.id);
    if (!terminal) {
      running = await alive(start);
      terminal = findTerminal(file, start.id);
    }
  }
}
