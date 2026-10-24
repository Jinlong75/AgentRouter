// 清理（协议 15.10）：ar gc [--dry-run]。零依赖。
// 三类可清理项：孤立的 worktree、孤立的并发名额、超过保留期的执行者会话记录。
// 正在运行或待验收的任务的 worktree、正在运行的任务所在执行者的会话记录一律不动。
// 逐项删除，某一项失败记进 errors，不中断其他项；git 一律参数数组、shell: false（git.mjs）。
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { configInvalid, readConfig, sessionRetention } from './config.mjs';
import { git } from './git.mjs';
import { CREATED_TOLERANCE_MS, pidAlive, processCreated } from './process.mjs';
import { reverseRows, worktreeOutcome } from './wait.mjs';
import { branchExists, listWorktrees, worktreeRoot } from './worktree.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
// 清单里找不到主人的 worktree 目录，修改时间在这么久以内的不动。
const UNKNOWN_TASK_GRACE_MS = 10 * 60 * 1000;
// worktree 目录名：<项目根哈希前 6 位>-<短名>（协议 15.2）；根目录里不符合的条目不是我们建的，不碰。
const WORKTREE_ENTRY = /^[0-9a-f]{6}-./;
const SLOT_FILE = /^(?:slot|gate)-\d+\.json(?:\.stale-[0-9a-f]+)?$/;

const pathKey = value => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
const realPath = value => { try { return realpathSync.native(value); } catch { return null; } };
// dir 是 rootDir 的直接子项时返回按 rootDir 拼出的路径，否则 null。比较的是真实路径，所以 Windows 的短路径名与长路径名视为同一个目录。
function childOfRoot(rootDir, dir) {
  const parent = realPath(path.dirname(dir)), root = realPath(rootDir);
  return parent && root && pathKey(parent) === pathKey(root) ? path.join(rootDir, path.basename(dir)) : null;
}

// 目录或文件的估算大小：逐个文件 lstat 累加，不跟随链接；读不了的忽略。
export function sizeOf(target) {
  let total = 0;
  const walk = current => {
    let stat;
    try { stat = lstatSync(current); } catch { return; }
    if (!stat.isDirectory()) { total += stat.size; return; }
    let names;
    try { names = readdirSync(current); } catch { return; }
    for (const name of names) walk(path.join(current, name));
  };
  walk(target);
  return total;
}

// 两份清单（新旧公共目录）里的全部任务：id → { file, start, rows（按时间顺序）}。
function readTasks(homes) {
  const tasks = new Map();
  for (const home of new Set([homes].flat())) {
    const file = path.join(home, 'runs.jsonl');
    const rows = [...reverseRows(file)].reverse();
    for (const row of rows) {
      if (typeof row.id !== 'string') continue;
      let task = tasks.get(row.id);
      if (!task) { task = { file, start: null, rows: [] }; tasks.set(row.id, task); }
      if (row.event === 'start') task.start = row;
      task.rows.push(row);
    }
  }
  return tasks;
}

// 还在进行：最近一条 start / resume 之后没有 end 也没有 interrupted（协议 14.4）。不查进程，保守地把没有结束记录的都当成进行中。
function running(task) {
  for (let i = task.rows.length - 1; i >= 0; i--) {
    const event = task.rows[i].event;
    if (event === 'end' || event === 'interrupted') return false;
    if (event === 'start' || event === 'resume') return true;
  }
  return true;
}

// 这个任务用过的执行者配置名：start.profile 与各次 attempt 的 profile（升级会换）。
function profilesOf(task) {
  const names = new Set();
  if (typeof task.start?.profile === 'string') names.add(task.start.profile);
  for (const row of task.rows) if (row.event === 'attempt' && typeof row.profile === 'string') names.add(row.profile);
  return names;
}

// 孤立的 worktree（协议 15.10）：根目录下的条目，任务已 accepted / rejected，或清单里找不到对应任务。
function findWorktrees({ tasks, rootDir, now }) {
  const byDir = new Map();
  for (const [id, task] of tasks) {
    for (const row of task.rows) if (row.event === 'worktree' && typeof row.dir === 'string') byDir.set(pathKey(row.dir), { id, task, worktree: row });
  }
  let entries = [];
  try { entries = readdirSync(rootDir, { withFileTypes: true }); } catch { /* 根目录还不存在：没有 worktree。 */ }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORKTREE_ENTRY.test(entry.name)) continue;
    const dir = path.join(rootDir, entry.name);
    const owner = byDir.get(pathKey(dir));
    if (!owner) {
      // 保护期：建好 worktree 到写入 worktree 事件之间有一个很短的窗口，刚改过的目录不算孤立。
      let modified = null;
      try { modified = lstatSync(dir).mtimeMs; } catch { /* 读不到修改时间就按孤立处理。 */ }
      if (modified !== null && now - modified < UNKNOWN_TASK_GRACE_MS) continue;
      // 清单里没有它的主人：从 worktree 自己的 .git 找回所属仓库（找不到就只删目录）；不知道分支的来历，分支不动。
      const common = git(dir, ['rev-parse', '--git-common-dir']);
      const repo = common.status === 0 && common.stdout.trim() ? path.resolve(dir, common.stdout.trim()) : null;
      found.push({ dir, reason: 'unknown-task', repo, branch: null, deleteBranch: false, forceBranch: false });
      continue;
    }
    const outcome = worktreeOutcome(owner.task.file, owner.id);
    if (outcome !== 'accepted' && outcome !== 'rejected') continue;
    const event = owner.task.rows.findLast(row => row.event === outcome);
    // 合并后分支：--no-ff 用 -d，squash 用 -D；驳回时用户要求保留分支就不删（协议 15.6、15.7）。
    const deleteBranch = outcome === 'accepted' || event?.keptBranch !== true;
    const forceBranch = outcome === 'rejected' || event?.mode === 'squash';
    found.push({ dir, reason: outcome, repo: owner.task.start?.repo ?? null, branch: owner.worktree.branch ?? null, deleteBranch, forceBranch });
  }
  return found;
}

// git 里 prunable 的记录（目录已经不在了）：只看清单里出现过的项目；只收根目录下建的（或 ar/ 分支的），
// 不碰用户自己建的 worktree；对应任务还在进行或待验收的不动。
function findPrunable({ tasks, rootDir, skip }) {
  const repos = new Set();
  const owners = new Map();
  for (const [id, task] of tasks) {
    if (task.start?.worktree !== true || typeof task.start.repo !== 'string') continue;
    repos.add(task.start.repo);
    for (const row of task.rows) if (row.event === 'worktree' && typeof row.dir === 'string') owners.set(pathKey(row.dir), { id, task });
  }
  const found = [];
  for (const repo of repos) {
    if (!existsSync(repo)) continue;
    let list;
    try { list = listWorktrees({ root: repo }); } catch { continue; }
    for (const entry of list) {
      if (!entry.prunable) continue;
      // git 报的路径可能和根目录写法不同（Windows 的短路径名与长路径名）：按根目录拼出规范的写法。
      const own = childOfRoot(rootDir, entry.dir);
      if (!own && !entry.branch?.startsWith('ar/')) continue;
      const dir = own ?? entry.dir;
      if (skip.has(pathKey(dir))) continue;
      const owner = owners.get(pathKey(dir));
      if (owner) {
        const outcome = worktreeOutcome(owner.task.file, owner.id);
        if (outcome === null || outcome === 'awaiting') continue;
      }
      found.push({ dir, reason: 'prunable', repo });
    }
  }
  return found;
}

// 孤立的名额（协议 15.5 的回收规则）：内容是合法 JSON 且占用者不存活，或存活但进程创建时间不同（PID 复用）。
async function findSlots({ home, isAlive, createdOf }) {
  const dir = path.join(home, 'slots');
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const found = [];
  for (const name of names.filter(item => SLOT_FILE.test(item))) {
    const file = path.join(dir, name);
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    let info;
    try { info = JSON.parse(text); } catch { continue; }
    if (!info || typeof info !== 'object' || !Number.isSafeInteger(info.pid)) continue;
    let orphan = !(await isAlive(info.pid));
    if (!orphan && Number.isFinite(info.created)) {
      const actual = await createdOf(info.pid);
      orphan = Number.isFinite(actual) && Math.abs(actual - info.created) > CREATED_TOLERANCE_MS;
    }
    if (orphan) found.push({ file, id: typeof info.id === 'string' ? info.id : null, pid: info.pid, text });
  }
  return found;
}

// 执行者会话记录（协议 15.10）：<home>/workers/<名>/claude/projects/ 下修改时间超过保留期的子目录；正在运行的任务所在的执行者跳过。
function findSessions({ home, days, now, busy }) {
  const workersDir = path.join(home, 'workers');
  let workers = [];
  try { workers = readdirSync(workersDir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const worker of workers) {
    if (!worker.isDirectory() || busy.has(worker.name)) continue;
    const projectsDir = path.join(workersDir, worker.name, 'claude', 'projects');
    let entries = [];
    try { entries = readdirSync(projectsDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(projectsDir, entry.name);
      let stat;
      try { stat = lstatSync(dir); } catch { continue; }
      const age = now - stat.mtimeMs;
      if (age > days * DAY_MS) found.push({ worker: worker.name, dir, ageDays: Math.floor(age / DAY_MS) });
    }
  }
  return found;
}

// 删一个 worktree：先让 git 删（--force，目录里有改动也删），目录还在就直接删；再清 git 记录与分支。
function removeWorktreeItem(item, { removeDirectory }) {
  const repoOk = item.repo && existsSync(item.repo);
  if (repoOk) git(item.repo, ['worktree', 'remove', '--force', item.dir]);
  if (existsSync(item.dir)) removeDirectory(item.dir);
  if (!repoOk) return;
  git(item.repo, ['worktree', 'prune']);
  if (item.deleteBranch && item.branch && branchExists(item.repo, item.branch)) {
    const result = git(item.repo, ['branch', item.forceBranch ? '-D' : '-d', item.branch]);
    if (result.status !== 0) throw new Error(`worktree 已删除，但删除分支 ${item.branch} 失败：${result.stderr.trim() || `退出码 ${result.status}`}`);
  }
}

const removeDirectoryDefault = dir => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

// 找出可清理项，dryRun 为假时逐项删除。返回 { ok, worktrees, slots, sessions, bytes, errors }：
// worktrees: [{ dir, reason }]（reason：accepted / rejected / unknown-task / prunable）、slots: [{ file, id, pid }]、
// sessions: [{ worker, dir, ageDays }]、bytes（成功清理的，dry-run 时为全部可释放的估算大小）、errors: [{ kind, path, error }]。
export async function gc({
  homes, env = process.env, dryRun = false, now = Date.now(),
  isAlive = pidAlive, createdOf = processCreated, removeDirectory = removeDirectoryDefault,
} = {}) {
  const home = homes[0];
  const state = readConfig(home);
  if (state.reason) throw configInvalid(state, '这次没有清理');
  const { days } = sessionRetention(state.config);
  const rootDir = worktreeRoot({ env });
  const tasks = readTasks(homes);

  const dirs = findWorktrees({ tasks, rootDir, now });
  const prunable = findPrunable({ tasks, rootDir, skip: new Set(dirs.map(item => pathKey(item.dir))) });
  const slots = await findSlots({ home, isAlive, createdOf });
  const busy = new Set();
  for (const task of tasks.values()) if (running(task)) for (const name of profilesOf(task)) busy.add(name);
  const sessions = findSessions({ home, days, now, busy });

  const errors = [];
  let bytes = 0;
  const attempt = (kind, target, size, action) => {
    if (!dryRun) {
      try { action(); } catch (error) { errors.push({ kind, path: target, error: error.message }); return; }
    }
    bytes += size;
  };

  for (const item of dirs) attempt('worktree', item.dir, sizeOf(item.dir), () => removeWorktreeItem(item, { removeDirectory }));
  // prunable 的记录：同一个项目只 prune 一次，成功与否对它名下的每一项都一样。
  const pruned = new Map();
  for (const item of prunable) {
    attempt('worktree', item.dir, 0, () => {
      if (!pruned.has(item.repo)) {
        const result = git(item.repo, ['worktree', 'prune']);
        pruned.set(item.repo, result.status === 0 ? null : result.stderr.trim() || `退出码 ${result.status}`);
      }
      if (pruned.get(item.repo)) throw new Error(`清理 worktree 记录失败：${pruned.get(item.repo)}`);
    });
  }
  for (const item of slots) {
    attempt('slot', item.file, sizeOf(item.file), () => {
      // 删之前再读一遍：内容变了说明名额已经被别人重新占用，不动。
      let current = null;
      try { current = readFileSync(item.file, 'utf8'); } catch { return; }
      if (current === item.text) rmSync(item.file, { force: true });
    });
  }
  for (const item of sessions) attempt('session', item.dir, sizeOf(item.dir), () => removeDirectory(item.dir));

  return {
    ok: true,
    worktrees: [...dirs, ...prunable].map(item => ({ dir: item.dir, reason: item.reason })),
    slots: slots.map(item => ({ file: item.file, id: item.id, pid: item.pid })),
    sessions,
    bytes,
    errors,
  };
}

const reasonText = {
  accepted: '任务已合并，清理失败留下的',
  rejected: '任务已驳回，清理失败留下的',
  'unknown-task': '任务清单里找不到对应任务',
  prunable: 'git 记录还在，目录已经不在了',
};

const sizeText = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

// 不加 --json 时给人看的文字。
export function gcLines(result, { dryRun = false } = {}) {
  const total = result.worktrees.length + result.slots.length + result.sessions.length;
  if (!total) return ['没有需要清理的内容'];
  const lines = [dryRun ? '可以清理（--dry-run 只列出，没有删除）：' : '已清理：'];
  if (result.worktrees.length) {
    lines.push(`  孤立的 worktree（${result.worktrees.length} 个）：`);
    for (const item of result.worktrees) lines.push(`    ${item.dir}　${reasonText[item.reason] ?? item.reason}`);
  }
  if (result.slots.length) {
    lines.push(`  孤立的并发名额（${result.slots.length} 个）：`);
    for (const item of result.slots) lines.push(`    ${item.file}`);
  }
  if (result.sessions.length) {
    lines.push(`  过期的执行者会话记录（${result.sessions.length} 个）：`);
    for (const item of result.sessions) lines.push(`    ${item.worker}　${item.dir}　${item.ageDays} 天没有改动`);
  }
  lines.push(`${dryRun ? '预计可释放' : '共释放'}约 ${sizeText(result.bytes)}`);
  for (const error of result.errors) lines.push(`清理失败：${error.path}（${error.error}）`);
  return lines;
}
