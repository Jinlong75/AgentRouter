// 撤销合并（Stage07b 129）：ar revert。零依赖。
// 对已合并的 worktree 任务在主分支上 git revert 合并提交：只追加一个反向提交，不改历史、不删提交、不推送。
// 只写清单事件 reverted；git 一律参数数组、shell: false（git.mjs）。
import { join } from 'node:path';
import { actor } from './accept.mjs';
import { git, uncommittedFiles } from './git.mjs';
import { readJson } from './json.mjs';
import { requireGitIdentity } from './project.mjs';
import { registryWriter } from './records.mjs';
import { locateStart, reverseRows, worktreeOutcome } from './wait.mjs';
import { unmergedFiles } from './worktree.mjs';

const fullSha = /^[0-9a-f]{40,64}$/;
const firstFive = files => files.slice(0, 5).join('、');
const gitFailure = (result, what) => result.stderr.trim() || result.stdout.trim() || (result.status === null ? '无法运行 git' : `${what}退出码 ${result.status}`);

// 项目配置的 baseBranch；读不到、不是对象、没写都返回 null。
function baseBranchOf(root) {
  try {
    const value = readJson(join(root, '.agent-router', 'project.json'));
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.baseBranch === 'string' && value.baseBranch.trim() !== '' ? value.baseBranch : null;
  } catch { return null; }
}

// 这个任务最近一次 accepted 之后有没有 reverted（从尾部往前，先遇到哪个就是哪个）。返回最新的 accepted 与 reverted（没有为 null）。
function mergeRecord(file, id) {
  let reverted = null;
  for (const row of reverseRows(file)) {
    if (row.id !== id) continue;
    if (row.event === 'reverted') reverted ??= row;
    if (row.event === 'accepted') return { accepted: row, reverted };
    if (row.event === 'start') break;
  }
  return { accepted: null, reverted: null };
}

// 撤销没做完的反向提交：先 --abort；不行再 reset --merge。主分支回到撤销前（撤销前主工作区是干净的）。
function abortRevert(root) {
  if (git(root, ['revert', '--abort']).status !== 0) git(root, ['reset', '--merge']);
}

// ar revert：检查 → git revert → reverted 事件。
// 返回 { ok: true, commit }（commit 是反向提交的完整 SHA）或冲突时 { ok: false, conflict: true, files }；检查不通过时抛出中文原因（退出码 2）。
export function revertMerge({ homes, root, name, by = null, env = process.env } = {}) {
  const found = locateStart(homes, root, name);
  if (!found) throw new Error(`撤销：在当前仓库找不到记录 ${name}`);
  const { file, home, start } = found;
  const id = start.id;
  if (start.worktree !== true) throw new Error(`任务不是 worktree 模式，没有合并可撤销：${start.name}`);
  if (worktreeOutcome(file, id) !== 'accepted') throw new Error(`任务还没有合并，不能撤销：${start.name}`);
  const { accepted, reverted } = mergeRecord(file, id);
  if (!accepted || typeof accepted.merge !== 'string' || !fullSha.test(accepted.merge)) throw new Error(`这是一次确认，没有合并提交，不能撤销：${start.name}`);
  if (reverted) throw new Error(`已经撤销过：${start.name}（反向提交 ${String(reverted.commit).slice(0, 7)}）`);

  const baseBranch = baseBranchOf(root);
  if (!baseBranch) throw new Error('项目配置没有写 baseBranch，不知道该在哪个分支上撤销');
  // 检查 1：主工作区当前分支是 baseBranch。
  const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current.status !== 0) throw new Error(`无法读取主工作区当前分支：${gitFailure(current, 'git rev-parse ')}`);
  const branchNow = current.stdout.trim();
  if (branchNow !== baseBranch) throw new Error(`主工作区当前在 ${branchNow}，撤销要在 ${baseBranch} 上进行：先 git switch ${baseBranch}`);
  // 检查 2：主工作区干净（.agent-runs/ 除外）。不干净时带 DIRTY_MAIN 与前几个文件（与 ar accept 的约定一致）。
  let dirtyMain;
  try { dirtyMain = uncommittedFiles(root); }
  catch (error) { throw new Error(`无法检查主工作区是否干净：${error.message}`); }
  if (dirtyMain.length) throw Object.assign(new Error(`主工作区有未提交的改动，先提交或暂存：${firstFive(dirtyMain)}`), { arCode: 'DIRTY_MAIN', files: dirtyMain.slice(0, 5) });
  // 检查 3：有提交身份（反向提交要署名）。
  requireGitIdentity(root);
  // 检查 4：合并提交还在 baseBranch 的历史里（当前 HEAD 就是 baseBranch）。
  const reachable = git(root, ['merge-base', '--is-ancestor', accepted.merge, 'HEAD']);
  if (reachable.status === 1) throw new Error(`合并提交 ${accepted.merge.slice(0, 7)} 已经不在 ${baseBranch} 的历史里，不能撤销`);
  if (reachable.status !== 0) throw new Error(`无法确认合并提交是否还在 ${baseBranch} 的历史里：${gitFailure(reachable, 'git merge-base ')}`);

  // 合并提交有两个父提交（--no-ff）要选主线 -m 1；压成一个提交（squash）只有一个父提交。
  const parents = git(root, ['rev-list', '--parents', '-n', '1', accepted.merge]);
  if (parents.status !== 0) throw new Error(`无法读取合并提交：${gitFailure(parents, 'git rev-list ')}`);
  const isMerge = parents.stdout.trim().split(/\s+/).length > 2;
  const result = git(root, ['revert', ...(isMerge ? ['-m', '1'] : []), accepted.merge, '--no-edit']);
  if (result.status !== 0) {
    // 冲突或其他失败：放弃这次撤销，主分支（HEAD、索引、工作区）恢复原样。
    const files = unmergedFiles(root);
    abortRevert(root);
    if (!files.length) throw new Error(`撤销失败：${gitFailure(result, 'git revert ')}`);
    return { ok: false, conflict: true, files };
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  if (head.status !== 0) throw new Error(`撤销已完成，但读不到反向提交：${gitFailure(head, 'git rev-parse ')}`);
  const commit = head.stdout.trim();
  registryWriter(home)({ event: 'reverted', id, commit, by: actor({ by, env }), at: Date.now() });
  return { ok: true, commit };
}
