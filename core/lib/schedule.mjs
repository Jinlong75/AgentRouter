// 并行调度的判断（Stage07c 140）：改动范围重叠时排队、独占命令、并发"自动"档。
// 纯函数为主（pathsOverlap、estimateConcurrency、createLoadMonitor），方便单元测试；
// pipeline.mjs / slots.mjs 只负责调用。零依赖。
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { matchesAny } from './glob.mjs';
import { readJson } from './json.mjs';
import { pidAlive, processCreated, taskAlive } from './process.mjs';
import { acquireExclusive, liveHolders, readExclusive } from './slots.mjs';
import { reverseRows } from './wait.mjs';

const GIB = 1024 ** 3;
const stoppedError = () => Object.assign(new Error('等待时被停止'), { stopped: true });

// ---- 一、改动范围重叠 ----

const WILDCARD = /[*?[{]/;
const isLiteral = pattern => !WILDCARD.test(pattern);

// glob 第一个通配符之前、到最后一个 / 为止的目录前缀，按路径段拆开；没有目录前缀（如 *.md、**）为空数组。
function dirSegments(pattern, caseInsensitive) {
  const at = pattern.search(WILDCARD);
  const head = at < 0 ? pattern : pattern.slice(0, at);
  const cut = head.lastIndexOf('/');
  const segments = (cut < 0 ? '' : head.slice(0, cut)).split('/').filter(Boolean);
  return caseInsensitive ? segments.map(segment => segment.toLowerCase()) : segments;
}

// 两个模式是否重叠。宁可多报，不能漏报：
// 字面路径（没有 * ? [ {）用另一边的 glob 去匹配；两边都是 glob 时比目录前缀（按路径段），一个是另一个的前缀就算重叠。
// 多报的情形：前缀相同但实际文件集不相交（src/*.js 与 src/a/*.js、*.md 与 docs/**），前缀为空（**、*.md）的和谁都重叠。
export function patternsOverlap(a, b, { caseInsensitive = process.platform === 'win32' } = {}) {
  const options = { caseInsensitive };
  if (isLiteral(a)) return matchesAny(a, [b], options);
  if (isLiteral(b)) return matchesAny(b, [a], options);
  const left = dirSegments(a, caseInsensitive), right = dirSegments(b, caseInsensitive);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return false;
  return true;
}

// theirs 里与 mine 任一项重叠的模式（去重，保持 theirs 的顺序）。
export function overlappingPatterns(mine, theirs, options) {
  const found = [];
  for (const pattern of [theirs].flat()) {
    if (!found.includes(pattern) && [mine].flat().some(own => patternsOverlap(own, pattern, options))) found.push(pattern);
  }
  return found;
}

// 两组模式（门禁用的 allowed_paths）是否重叠。
export function pathsOverlap(a, b, options) {
  return overlappingPatterns(a, b, options).length > 0;
}

const repoKey = value => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));

// 项目配置（.agent-router/project.json）；读不了或不是对象时为 {}。
export function readProject(root) {
  try {
    const value = readJson(join(root, '.agent-router', 'project.json'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// 一趟反向读清单，得出每个任务的状态（规则同 wait.mjs 的 worktreeOutcome）：
// active（排队 / 准备 / 运行 / 门禁中）、awaiting（待验收）、conflict（合并冲突）、ended。
// only 给了就只看这些 id，且它们都读到 start 时提前停下。
// 最近一次 start / resume 之后出现这些事件，说明任务已经过了排队阶段（占到名额开始准备 / 运行 / 门禁）。
const RUNNING_EVENTS = new Set(['preparing', 'worktree', 'setup', 'attempt', 'gating', 'gate', 'attempt-end']);

function scanTasks(file, only = null) {
  const tasks = new Map();
  let open = only ? only.size : Infinity;
  for (const row of reverseRows(file)) {
    if (typeof row.id !== 'string' || (only && !only.has(row.id))) continue;
    let task = tasks.get(row.id);
    if (!task) { task = { id: row.id, state: null, start: null, resume: null, running: false }; tasks.set(row.id, task); }
    if (task.start) continue;
    if (task.state === null) {
      if (row.event === 'accepted' || row.event === 'rejected' || row.event === 'interrupted') task.state = 'ended';
      else if (row.event === 'conflict') task.state = 'conflict';
      else if (row.event === 'end') task.state = (row.exit ?? 1) === 0 ? 'awaiting' : 'ended';
      else if (row.event === 'start' || row.event === 'resume') task.state = 'active';
      else if (RUNNING_EVENTS.has(row.event)) task.running = true;
    }
    if (row.event === 'resume' && !task.resume) task.resume = row;
    if (row.event === 'start') { task.start = row; open--; if (open <= 0) break; }
  }
  return tasks;
}

// 任务说明合并后的 allowed_paths 与是否只读：读派发记录（dispatch.json）里的门禁信息；读不了按 ['**']（和谁都重叠）。
export function taskScope(dir) {
  try {
    const record = readJson(join(dir, 'dispatch.json'));
    const list = record?.gate?.merged?.allowed_paths;
    return {
      readOnly: record?.readOnly === true || record?.gate?.readOnly === true,
      patterns: Array.isArray(list) && list.length && list.every(item => typeof item === 'string') ? list : ['**'],
      gate: record?.gate?.enabled === true,
    };
  } catch { return { readOnly: false, patterns: ['**'], gate: false }; }
}

// 先排队 / 先派发的在前：时间更早，相同时按 id 排。
const earlier = (atA, idA, atB, idB) => atA < atB || (atA === atB && idA < idB);

// 任务进入"排队阶段"的时间：最近一次 start / resume 的时间（手动重试的 resume 在原 start 之后）。
const enteredAt = task => task.resume?.at ?? task.start.started;

// 排队阶段的重叠检查：check() 返回现在还在阻挡的任务 [{ id, name, paths }]，空数组表示可以去占名额。
// 候选 = 同一项目里还没结束的 worktree 任务（只含排队 / 准备 / 运行 / 门禁中；待验收、冲突不挡人，D86），第一次查时读一遍清单，之后每轮只重读候选。
// 新派发（retrying 为假）：只和先派发的比（start 的时间更早）；已经过了排队阶段的以 start 为准，还在排队的以最近一次 start / resume 为准。
// 手动重试（retrying 为真，Stage07c 152）：和已经在准备、运行、门禁中的任务比（不管谁先派发），和还在排队的只比先进入排队的
// （按最近一次 resume 的时间；后进入的不挡先进入的，两个都在排队的重试不会互相等）。
// 任务进程已经不在而清单里没有结束记录的，按已结束算（否则它会永远挡着）。只读任务不改文件，和谁都不重叠。
export function createOverlapWatcher({ home, root, id, started, patterns, readOnly = false, retrying = false, alive = taskAlive, pidCheck = pidAlive }) {
  const file = join(home, 'runs.jsonl');
  const mine = Array.isArray(patterns) && patterns.length ? patterns : ['**'];
  let candidates = null;   // id → { start, resume, scope, verified }
  let mineAt = started;    // 自己进入排队阶段的时间：手动重试以清单里自己的 resume 为准，保证别人看到的和自己用的一致
  const mustWaitFor = task => {
    if (task.running) return retrying || earlier(task.start.started, task.id, started, id);
    return earlier(enteredAt(task), task.id, mineAt, id);
  };
  return {
    async check() {
      if (readOnly) return [];
      const tasks = scanTasks(file, candidates ? new Set(candidates.keys()) : null);
      if (!candidates && retrying) {
        const own = tasks.get(id);
        if (own?.start) mineAt = enteredAt(own);
      }
      const next = new Map();
      for (const [taskId, task] of tasks) {
        const { start } = task;
        if (!start || taskId === id || task.state !== 'active') continue;
        if (candidates ? !candidates.has(taskId) : !(start.worktree === true && typeof start.repo === 'string' && repoKey(start.repo) === repoKey(root) && mustWaitFor(task))) continue;
        const old = candidates?.get(taskId);
        const scope = old?.scope ?? taskScope(start.dir ?? '');
        if (scope.readOnly) continue;
        const pid = task.resume?.pid ?? start.pid, since = task.resume?.at ?? start.started;
        const living = old?.verified ? pidCheck(pid) : await alive({ pid, started: since });
        if (!living) continue;
        next.set(taskId, { start, scope, verified: true });
      }
      candidates = next;
      const blockers = [];
      for (const [taskId, { start, scope }] of next) {
        const paths = overlappingPatterns(mine, scope.patterns);
        if (paths.length) blockers.push({ id: taskId, name: start.name, paths: paths.slice(0, 3) });
      }
      return blockers;
    },
  };
}

// ---- 一之二、与待验收任务的重叠（Stage07c 154，D86）----

// 同项目里待验收的 worktree 任务：[{ id, name, start, scope: { readOnly, patterns, gate } }]（scope 读派发记录，读不了按 ['**']、门禁未知算没启用）。
// 待验收不挡后派发的任务（140），这里只用来提示、分组和合并后重跑门禁。
export function awaitingTasks({ home, root }) {
  const found = [];
  for (const [id, task] of scanTasks(join(home, 'runs.jsonl'))) {
    const { start } = task;
    if (task.state !== 'awaiting' || !start || start.worktree !== true || typeof start.repo !== 'string' || repoKey(start.repo) !== repoKey(root)) continue;
    found.push({ id, name: start.name, start, scope: taskScope(start.dir ?? '') });
  }
  return found;
}

// 新派发 / 手动重试的任务（改动范围 patterns）与待验收任务重叠的清单：[{ id, name, paths }]，paths 是对方范围里重叠的模式（最多 3 个）。
// 只读的待验收任务没有改动，不算。
export function awaitingOverlaps({ home, root, id, patterns }) {
  const mine = Array.isArray(patterns) && patterns.length ? patterns : ['**'];
  const notes = [];
  for (const task of awaitingTasks({ home, root })) {
    if (task.id === id || task.scope.readOnly) continue;
    const paths = overlappingPatterns(mine, task.scope.patterns);
    if (paths.length) notes.push({ id: task.id, name: task.name, paths: paths.slice(0, 3) });
  }
  return notes;
}

// 进度里一行（每个待验收的重叠任务一行）。
export function overlapNoteLine(note) {
  return `与待验收的 ${note.name} 改动范围重叠（${note.paths.join('、')}），${note.name} 合并后可能冲突`;
}

// ar overlaps：同项目里互相重叠的待验收任务组（重叠关系传递合并成组），每组按派发时间从早到晚给出建议的批准顺序。
// 返回 [{ tasks: [{ id, name, paths }], order: [id…], why }]，tasks 与 order 同序（先派发的在前）；没有重叠组返回 []。
export function overlapGroups({ homes, root }) {
  const tasks = [];
  const seen = new Set();
  for (const home of [homes].flat()) {
    for (const task of awaitingTasks({ home, root })) {
      if (task.scope.readOnly || seen.has(task.id)) continue;
      seen.add(task.id);
      tasks.push(task);
    }
  }
  // 并查集：两两重叠就并到同一组。
  const parent = tasks.map((_, index) => index);
  const find = index => { while (parent[index] !== index) index = parent[index] = parent[parent[index]]; return index; };
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      if (pathsOverlap(tasks[i].scope.patterns, tasks[j].scope.patterns)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  tasks.forEach((task, index) => { const key = find(index); groups.set(key, [...(groups.get(key) ?? []), task]); });
  const startedOf = task => (Number.isFinite(task.start.started) ? task.start.started : 0);
  const byStart = (a, b) => startedOf(a) - startedOf(b) || (a.id < b.id ? -1 : 1);
  return [...groups.values()].filter(group => group.length > 1).map(group => group.sort(byStart)).sort((a, b) => byStart(a[0], b[0])).map(sorted => ({
    tasks: sorted.map(task => ({ id: task.id, name: task.name, paths: task.scope.patterns })),
    order: sorted.map(task => task.id),
    why: `先派发的先批准：${sorted.map(task => task.name).join(' → ')}；后派发的任务会在前一个合并后自动按新基线重跑门禁`,
  }));
}

// 等重叠的先派发任务都结束。blockers 变化时 onChange(blockers) 一次；signal.stopped 为真时抛 { stopped: true }。
// 返回是否真的等过。
export async function waitForOverlap({ watcher, signal, onChange, intervalMs = 2000 }) {
  let waited = false, last = null;
  for (;;) {
    if (signal?.stopped) throw stoppedError();
    const blockers = await watcher.check();
    if (!blockers.length) return waited;
    waited = true;
    const key = blockers.map(item => `${item.id}:${item.paths.join(',')}`).join('|');
    if (key !== last) { last = key; onChange?.(blockers); }
    await delay(intervalMs);
  }
}

// 进度里一行：排队：与 <名字> 的改动范围重叠（<模式>），等它结束。
export function overlapLine(blockers) {
  const names = blockers.map(item => item.name).join('、');
  const paths = [...new Set(blockers.flatMap(item => item.paths))].slice(0, 3).join('、');
  return `排队：与 ${names} 的改动范围重叠（${paths}），等它结束`;
}

// ---- 二、独占命令 ----

// 门禁的验收命令里属于项目配置 exclusiveCommands 的第一条；没有返回 null。
// 去掉首尾空白后，等于某条独占命令，或以"独占命令 + 空格"开头就算（D71）：npm run shots 覆盖 npm run shots -- --focus x，不覆盖 npm run shotsx。
export function exclusiveCommandOf({ root, verify }) {
  const list = readProject(root).exclusiveCommands;
  if (!Array.isArray(list)) return null;
  const exclusive = list.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean);
  return (verify ?? []).filter(item => typeof item === 'string').map(item => item.trim()).find(item => exclusive.some(command => item === command || item.startsWith(`${command} `))) ?? null;
}

export const exclusiveText = held => `排队：${held.name ?? '另一个任务'} 的门禁正在独占运行（${held.command ?? ''}），等它结束`;

// 等别人的独占标记消失（自己的不算）；标记变化时 progress 写一行。
async function waitExclusiveClear({ deps, id, signal, progress, intervalMs }) {
  let last = null;
  for (;;) {
    if (signal?.stopped) throw stoppedError();
    const held = await readExclusive(deps);
    if (!held || held.id === id) return;
    const text = exclusiveText(held);
    if (text !== last) { last = text; progress?.(text); }
    await delay(intervalMs);
  }
}

// 进门禁：先等别人的独占门禁结束，再占门禁名额（acquire() 返回释放函数）；独占门禁（command 非空）拿到名额后再建标记，
// 并等已经在跑的别的门禁结束。返回 { release }，release 一次放掉标记和名额。
// 刚拿到名额时别人的标记已经出现：放回名额重新等。两个独占门禁抢标记：输的放回名额重新等，不会互相等死。
export async function enterGate({ home, id, name, command = null, acquire, signal, progress, intervalMs = 2000, isAlive = pidAlive, createdOf = processCreated }) {
  const deps = { home, isAlive, createdOf };
  for (;;) {
    await waitExclusiveClear({ deps, id, signal, progress, intervalMs });
    const releaseSlot = await acquire();
    const other = await readExclusive(deps);
    if (other && other.id !== id) { releaseSlot(); continue; }
    if (!command) return { release: releaseSlot };
    const releaseMarker = await acquireExclusive({ ...deps, id, name, command });
    if (!releaseMarker) { releaseSlot(); continue; }
    const release = () => { releaseMarker(); releaseSlot(); };
    try {
      let announced = false;
      while ((await liveHolders({ ...deps, kind: 'gate', excludeId: id })) > 0) {
        if (signal?.stopped) throw stoppedError();
        if (!announced) { announced = true; progress?.(`门禁独占运行：${command}，等别的门禁结束`); }
        await delay(intervalMs);
      }
    } catch (error) { release(); throw error; }
    progress?.(`门禁独占运行：${command}，别的任务和门禁等它结束`);
    return { release };
  }
}

// ---- 三、并发"自动"档 ----

export const concurrencyCap = 8;

// 起始值：min(max, max(1, floor(核数 / 4)), max(1, floor(可用内存 GB / 1.5)))。
export function estimateConcurrency({ cores, freeMemBytes, max = concurrencyCap } = {}) {
  const byCores = Math.max(1, Math.floor((Number.isFinite(cores) ? cores : 1) / 4));
  const byMemory = Math.max(1, Math.floor((Number.isFinite(freeMemBytes) ? freeMemBytes : 0) / GIB / 1.5));
  return Math.min(max, byCores, byMemory);
}

export const machineCores = () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);

// os.cpus() 的累计时间：{ idle, total }。
function cpuTimes(cpus) {
  let idle = 0, total = 0;
  for (const cpu of cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

// "内存不够"的阈值（D100 / D114，182）：max(1.5 GB, 总内存 × percent%)。percent 是 config.json 的 memLowPercent（1～50 的整数，默认 5）。
// 监视器、ar config 的瞬时判断、软件设置页都用这一个函数，不各写一份比例。
export const memLowPercentDefault = 5;
export const memLowPercentMax = 50;
export const validMemLowPercent = value => Number.isSafeInteger(value) && value >= 1 && value <= memLowPercentMax;
export const memLowThreshold = (totalBytes, percent = memLowPercentDefault) => Math.max(1.5 * GIB, totalBytes * (validMemLowPercent(percent) ? percent : memLowPercentDefault) / 100);

// 机器忙闲监视：sample() 每次返回 { busy, cpu, memLow, freeMemBytes }。
// 忙 = CPU 使用率连续 busyAfterMs（60 秒）超过 85%，或可用内存低于 memLowThreshold（内存是立刻判）。
// 恢复 = CPU 连续 recoverAfterMs（30 秒）低于 85% 且内存回到阈值以上。cpus / freemem / totalmem / now 可注入。
// 比例：sample({ memLowPercent }) 每次采样可以带当前配置的比例（配置改了不用重启），没带就用创建时的 memLowPercent（默认 5）。
// 第一次采样没有时间差，CPU 记为 null（不算高）。
export function createLoadMonitor({
  cpus = os.cpus, freemem = os.freemem, totalmem = os.totalmem, now = Date.now,
  cpuHigh = 85, busyAfterMs = 60000, recoverAfterMs = 30000, memLowPercent: defaultPercent = memLowPercentDefault,
} = {}) {
  let previous = null, lastAt = null, cpu = null, busy = false, highSince = null, calmSince = null;
  return {
    sample({ memLowPercent } = {}) {
      const at = now();
      const times = cpuTimes(cpus);
      if (previous && times.total > previous.total) {
        const total = times.total - previous.total, idle = times.idle - previous.idle;
        cpu = Math.round(Math.min(100, Math.max(0, (1 - idle / total) * 100)));
      }
      previous = times;
      const free = freemem();
      const memLow = free < memLowThreshold(totalmem(), validMemLowPercent(memLowPercent) ? memLowPercent : defaultPercent);
      const high = cpu !== null && cpu > cpuHigh;
      // 这一段使用率量的是上一次采样到现在，所以持续时间从上一次采样算起。
      const from = lastAt ?? at;
      lastAt = at;
      if (!busy) {
        if (high) highSince ??= from; else highSince = null;
        if (memLow || (highSince !== null && at - highSince >= busyAfterMs)) { busy = true; calmSince = null; }
      } else {
        if (memLow || high) calmSince = null; else calmSince ??= from;
        if (calmSince !== null && at - calmSince >= recoverAfterMs) { busy = false; highSince = null; calmSince = null; }
      }
      return { busy, cpu, memLow, freeMemBytes: free };
    },
  };
}

// 测试专用：AR_TEST_LOAD_FILE 指向 JSON（{ "busy": true, "cpu": 92 }）时，每次采样读它代替真实采样，不等 60 秒；
// 可用内存不够的情形写 { "busy": true, "memLow": true, "freeGb": 1.2 }。
function sampleLoad(monitor, env, memLowPercent) {
  const file = env?.AR_TEST_LOAD_FILE;
  if (file) {
    try {
      const injected = JSON.parse(readFileSync(file, 'utf8'));
      return { busy: injected.busy === true, cpu: Number.isFinite(injected.cpu) ? injected.cpu : null, memLow: injected.memLow === true, freeMemBytes: Number.isFinite(injected.freeGb) ? injected.freeGb * GIB : os.freemem() };
    } catch { /* 读不了就按真实采样。 */ }
  }
  return monitor.sample({ memLowPercent });
}

export const busyLine = sample => `排队：机器正忙（${sample.memLow ? `可用内存 ${(sample.freeMemBytes / GIB).toFixed(1)} GB` : `CPU ${sample.cpu ?? '?'}%`}），暂停启动新任务`;

// 任务名额的上限函数（给 acquireSlot 的 limit）：每轮读一次配置（readLimits 抛错由 acquireSlot 沿用上一轮的值）。
// 返回 0 表示这一轮暂停：别人的独占门禁在跑，或自动档下机器正忙。已经在跑的任务不受影响。
// 自动档的估算值缓存 estimateTtlMs，免得可用内存的小波动让"并发上限改为"满屏刷。
// registry + id 都给了时，进入"独占"或"机器正忙"暂停的同时（和进度行同一时机，原因变化才写一次）写一条带原因的 queued 事件
// （Stage07c 148，141 的排队横幅按它选正文）：独占 { reason: 'exclusive', blockers: [{ id, name }], command }，机器正忙 { reason: 'busy', cpu, memLow, freeGb }。
export function createTaskLimit({
  home, readLimits, progress, env = process.env, monitor = createLoadMonitor(), now = Date.now,
  estimateTtlMs = 30000, isAlive = pidAlive, createdOf = processCreated, registry = null, id = null,
}) {
  let notice = null, wasBusy = false, estimate = null;
  const say = (text, event = null) => {
    if (text === notice) return;
    notice = text;
    progress?.(text);
    if (event && registry && id) registry({ event: 'queued', id, ...event, at: Date.now() });
  };
  const taskLimit = async () => {
    const info = readLimits();
    let limit = info.limits.concurrency;
    if (info.mode === 'auto') {
      if (!estimate || now() - estimate.at > estimateTtlMs) estimate = { at: now(), value: info.estimate };
      limit = Math.min(estimate.value, info.max);
    }
    const held = await readExclusive({ home, isAlive, createdOf });
    if (held) {
      say(exclusiveText(held), { reason: 'exclusive', blockers: [{ id: held.id ?? null, name: held.name ?? null }], command: held.command ?? null });
      return 0;
    }
    const busy = info.mode === 'auto' ? sampleLoad(monitor, env, info.memLowPercent) : { busy: false };
    if (busy.busy) {
      wasBusy = true;
      // 可用内存不够时 memLow 为真（横幅写内存，不写 CPU），freeGb 是可用内存（GB，一位小数）。
      say(busyLine(busy), { reason: 'busy', cpu: Number.isFinite(busy.cpu) ? busy.cpu : null, memLow: busy.memLow === true, freeGb: Number((busy.freeMemBytes / GIB).toFixed(1)) });
      return 0;
    }
    if (wasBusy) { wasBusy = false; progress?.('排队：机器恢复空闲，按估算值继续启动任务'); }
    notice = null;
    return limit;
  };
  // 这一轮是不是因为独占 / 机器正忙而暂停（pipeline 据此不再补一条没有原因的 queued 事件）。
  taskLimit.paused = () => notice !== null;
  return taskLimit;
}

// ar config 里"现在是不是在暂停"：同步采 150 毫秒的 CPU，加上可用内存，按瞬时值判断（持续时长要等排队中的任务才知道）。
export function currentLoad({ sleepMs = 150, memLowPercent } = {}) {
  const first = cpuTimes(os.cpus);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
  const second = cpuTimes(os.cpus);
  const total = second.total - first.total;
  const cpu = total > 0 ? Math.round(Math.min(100, Math.max(0, (1 - (second.idle - first.idle) / total) * 100))) : null;
  const free = os.freemem();
  return { cpu, freeMemBytes: free, memLow: free < memLowThreshold(os.totalmem(), memLowPercent) };
}
