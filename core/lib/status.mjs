// 任务状态查询（协议 15.11）：ar status <记录名>。只读清单，不等待、不碰进程。零依赖。
import { readNeedsScope } from './needs-scope.mjs';
import { readOutsideWrites } from './outside-writes.mjs';
import { findTerminal, locateStart, reverseRows, worktreeOutcome } from './wait.mjs';

// worktree 任务的十种状态（协议 15.3）与非 worktree 任务的四种状态。
export const worktreeStates = ['queued', 'preparing', 'running', 'gating', 'awaiting', 'conflict', 'accepted', 'rejected', 'failed', 'stopped'];
export const plainStates = ['running', 'done', 'failed', 'stopped'];

// 这个任务的全部清单行，最新的在前。
function taskRows(file, id) {
  const rows = [];
  for (const row of reverseRows(file)) if (row.id === id) rows.push(row);
  return rows;
}

// 最近一条 start / resume 之后的行（最新的在前，不含这条）。
function sinceLastStart(rows) {
  const at = rows.findIndex(row => row.event === 'start' || row.event === 'resume');
  return at < 0 ? rows : rows.slice(0, at);
}

// 还没结束的 worktree 任务（协议 15.3）：看最近一条与进度有关的事件。
// 只有 start、或最后是 queued → queued；准备阶段的事件 → preparing；attempt 之后 running，gating 之后 gating，gate 写完回到 running。
function inProgressState(recent) {
  for (const row of recent) {
    if (row.event === 'gating') return 'gating';
    if (['attempt', 'spawned', 'gate', 'attempt-end'].includes(row.event)) return 'running';
    if (['preparing', 'worktree', 'setup'].includes(row.event)) return 'preparing';
    if (row.event === 'queued') return 'queued';
  }
  return 'queued';
}

// 任务当前状态。不查进程：进程已经不在、清单里又没有结束记录的任务仍按进行中显示；ar wait 会把它当中断（协议 15.11）。
export function taskState(file, start, rows = taskRows(file, start.id)) {
  if (start.worktree === true) {
    return worktreeOutcome(file, start.id) ?? inProgressState(sinceLastStart(rows));
  }
  const terminal = findTerminal(file, start.id);
  if (!terminal) return 'running';
  if (terminal.event === 'interrupted') return 'stopped';
  return (terminal.exit ?? 1) === 0 ? 'done' : 'failed';
}

// ar status 的结果（协议 15.11）。找不到记录时抛出中文原因（退出码 2）。
export function taskStatus({ homes, root, name }) {
  const found = locateStart(homes, root, name);
  if (!found) throw new Error(`状态：在当前仓库找不到记录 ${name}`);
  const { file, start } = found;
  const rows = taskRows(file, start.id);
  const recent = sinceLastStart(rows);
  const state = taskState(file, start, rows);
  const attempts = rows.reduce((max, row) => (row.event === 'attempt' && Number.isSafeInteger(row.n) ? Math.max(max, row.n) : max), 0)
    || rows.find(row => row.event === 'end')?.attempts || 0;
  const gate = rows.find(row => row.event === 'gate');
  const end = recent.find(row => row.event === 'end');
  const outside = readOutsideWrites(recent.find(row => row.event === 'attempt-end')?.outsideWrites);
  const worktree = start.worktree === true ? rows.find(row => row.event === 'worktree') : null;
  const conflict = state === 'conflict' ? rows.find(row => row.event === 'conflict') : null;
  return {
    ok: true, id: start.id, name: start.name, state, attempts,
    gate: gate ? { ok: gate.ok === true, summary: gate.summary ?? null } : null,
    needsScope: end ? readNeedsScope(end.needsScope) : null,
    outsideWrites: outside?.added.length ? { added: outside.added } : null,
    worktree: worktree ? { dir: worktree.dir, branch: worktree.branch, base: worktree.base } : null,
    merge: state === 'accepted' ? rows.find(row => row.event === 'accepted')?.merge ?? null : null,
    conflict: conflict ? { files: Array.isArray(conflict.files) ? conflict.files : [] } : null,
  };
}

// 不加 --json 时给人看的几行。
export function statusLines(status) {
  const lines = [`状态：${status.name}（${status.state}）`, `尝试次数：${status.attempts}`];
  if (status.gate) lines.push(status.gate.ok ? '门禁：通过' : `门禁：未通过（${status.gate.summary ?? '无说明'}）`);
  if (status.worktree) lines.push(`worktree：${status.worktree.dir}（分支 ${status.worktree.branch}）`);
  if (status.merge) lines.push(`合并提交：${status.merge}`);
  if (status.conflict) lines.push(`冲突文件：${status.conflict.files.join('、')}`);
  if (status.needsScope) lines.push(`需要越界：${status.needsScope.map(item => item.path).join('、')}`);
  if (status.outsideWrites) lines.push(`工作区外新文件：${status.outsideWrites.added.map(item => item.name).join('、')}`);
  return lines;
}
