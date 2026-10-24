// 任务改动（协议 15.9）：ar diff <记录名> --json。零依赖。
// 范围 base..分支；解析 git diff --numstat -z 与 --name-status -z -M，再逐文件取 patch。
import { git, parseNameStatusEntriesZ } from './git.mjs';
import { latestEvent, locateStart, reverseRows } from './wait.mjs';
import { branchExists } from './worktree.mjs';

// 每个文件的 patch 最多 200 KB，整体最多 2 MB（协议 15.9）。
export const FILE_LIMIT = 200 * 1024;
export const TOTAL_LIMIT = 2 * 1024 * 1024;
export const GONE = '改动已不可查：worktree 与分支都已删除';

// 解析 git diff --numstat -z -M：普通项 "<增>\t<删>\t<路径>\0"；重命名项 "<增>\t<删>\t\0<旧路径>\0<新路径>\0"；
// 二进制文件的增删写成 "-"。返回 [{ path, oldPath, additions, deletions, binary }]。
export function parseNumstatZ(text) {
  const fields = String(text ?? '').split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(field);
    if (!match) continue;
    const binary = match[1] === '-' || match[2] === '-';
    const counts = { additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary };
    if (match[3] === '') {
      const oldPath = fields[++i], path = fields[++i];
      if (oldPath && path) entries.push({ path, oldPath, ...counts });
    } else entries.push({ path: match[3], oldPath: null, ...counts });
  }
  return entries;
}

// 去掉 git 的文件头（diff --git、index、---、+++ 等），从第一个 @@ 开始；没有 @@（纯重命名、只改权限）时为空串。
export function hunksOf(output) {
  const text = String(output ?? '');
  const start = text.startsWith('@@') ? 0 : text.indexOf('\n@@');
  return start < 0 ? '' : text.slice(start === 0 ? 0 : start + 1);
}

// 按 UTF-8 字节数截断，落点对齐到字符边界（不切出半个字符）。
export function cutUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  // 落点在多字节字符中间（下一个字节是续字节 10xxxxxx）时向前退到字符开头。
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

// 状态首字母：A / M / D / R；其他（类型变化等）按 M。
const statusLetter = status => (['A', 'D', 'R'].includes(status[0]) ? status[0] : 'M');

// 算出 patch 范围：{ base, head }；算不出返回 null。
// 分支还在：门禁用的基线 .. 分支；已合并且分支删了：--no-ff 取合并提交的第二个父提交，squash 取合并提交本身（对它的第一个父提交）。
function rangeFor({ root, file, start, branch }) {
  let base = start.base ?? null;
  for (const row of reverseRows(file)) {
    if (row.id !== start.id) continue;
    // 重新基线后（协议 15.8）新基线写在 attempt 事件上，取最近一条带 base 的。
    if (row.event === 'attempt' && typeof row.base === 'string' && row.base) { base = row.base; break; }
    if (row.event === 'start') break;
  }
  if (branchExists(root, branch)) {
    const head = git(root, ['rev-parse', `refs/heads/${branch}`]).stdout.trim();
    return base && head ? { base, head } : null;
  }
  const accepted = latestEvent(file, start.id, 'accepted');
  if (!accepted?.merge) return null;
  if (accepted.mode === 'squash') {
    const parent = git(root, ['rev-parse', '--verify', '--quiet', `${accepted.merge}^1`]);
    return parent.status === 0 ? { base: parent.stdout.trim(), head: accepted.merge } : null;
  }
  const second = git(root, ['rev-parse', '--verify', '--quiet', `${accepted.merge}^2`]);
  return second.status === 0 && base ? { base, head: second.stdout.trim() } : null;
}

// ar diff：返回 { ok: true, base, head, files, totalBytes, truncated }；不是 worktree 任务或找不到记录时抛出，
// worktree 与分支都删了算不出时返回 { ok: false, error }。
// limits 只给测试用（单文件与整体上限）。
export function diffTask({ homes, root, name, limits = {} } = {}) {
  const fileLimit = limits.file ?? FILE_LIMIT, totalLimit = limits.total ?? TOTAL_LIMIT;
  const found = locateStart(homes, root, name);
  if (!found) throw new Error(`改动：在当前仓库找不到记录 ${name}`);
  const { file, start } = found;
  if (start.worktree !== true) throw new Error(`任务不是 worktree 模式：${start.name}`);
  const worktree = latestEvent(file, start.id, 'worktree');
  if (!worktree) return { ok: false, error: GONE };
  const range = rangeFor({ root, file, start, branch: worktree.branch });
  if (!range) return { ok: false, error: GONE };
  const { base, head } = range;
  const numstat = git(root, ['diff', '--numstat', '-z', '-M', '--no-ext-diff', base, head]);
  const names = git(root, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', base, head]);
  if (numstat.status !== 0 || names.status !== 0) {
    throw new Error(`读取改动失败：${(numstat.status !== 0 ? numstat : names).stderr.trim() || '无法运行 git'}`);
  }
  const statuses = new Map();
  for (const { status, paths } of parseNameStatusEntriesZ(names.stdout)) statuses.set(paths.at(-1), statusLetter(status));
  const files = [];
  let totalBytes = 0, truncated = false;
  for (const item of parseNumstatZ(numstat.stdout)) {
    const entry = { path: item.path, oldPath: item.oldPath, status: statuses.get(item.path) ?? (item.oldPath ? 'R' : 'M'),
      additions: item.additions, deletions: item.deletions, binary: item.binary };
    if (!item.binary) {
      // 先看整体上限还剩多少：用完了就不再取这个文件的内容。
      const remaining = totalLimit - totalBytes;
      let patch = '', cut = false;
      if (remaining <= 0) cut = true;
      else {
        const paths = (item.oldPath ? [item.oldPath, item.path] : [item.path]).map(p => `:(literal)${p}`);
        const shown = git(root, ['diff', '-M', '--no-color', '--no-ext-diff', '--no-textconv', base, head, '--', ...paths]);
        if (shown.status !== 0) cut = true;
        else {
          patch = hunksOf(shown.stdout);
          if (Buffer.byteLength(patch) > fileLimit) { patch = cutUtf8(patch, fileLimit); cut = true; }
          if (Buffer.byteLength(patch) > remaining) { patch = cutUtf8(patch, remaining); cut = true; truncated = true; }
        }
      }
      if (cut && remaining <= 0) truncated = true;
      entry.patch = patch;
      entry.truncated = cut;
      totalBytes += Buffer.byteLength(patch);
    } else entry.truncated = false;
    files.push(entry);
  }
  return { ok: true, base, head, files, totalBytes, truncated };
}
