// 验收合并与驳回（协议 15.6、15.7）：ar accept / ar reject。零依赖。
// 只写清单事件（accepted / conflict / rejected / cleanup），不碰任务的记录目录；git 一律参数数组、shell: false（git.mjs）。
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { git, uncommittedFiles } from './git.mjs';
import { readJson } from './json.mjs';
import { registryWriter } from './records.mjs';
import { parseSpec, validateSpec } from './spec.mjs';
import { findTerminal, latestEvent, locateStart, reverseRows, worktreeOutcome } from './wait.mjs';
import { branchExists, removeWorktree, unmergedFiles } from './worktree.mjs';

// 项目配置：<项目根>/.agent-router/project.json；不存在、读不了或不是对象都当 {}。
function projectConfig(root) {
  try {
    const value = readJson(join(root, '.agent-router', 'project.json'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// 事件 by 字段（协议 15.6）：命令行 --by human > 环境变量 CLAUDECODE=1 时 lead > 其余 cli。
export function actor({ by = null, env = process.env } = {}) {
  if (by === 'human') return 'human';
  return env.CLAUDECODE === '1' ? 'lead' : 'cli';
}

// 按 ar wait 的规则找任务，必须是 worktree 模式；返回 { file, home, start, worktree }（worktree 为最近一条 worktree 事件，可能没有）。
function locateWorktreeTask(homes, root, name, action) {
  const found = locateStart(homes, root, name);
  if (!found) throw new Error(`${action}：在当前仓库找不到记录 ${name}`);
  if (found.start.worktree !== true) throw new Error(`任务不是 worktree 模式：${found.start.name}`);
  return { ...found, worktree: latestEvent(found.file, found.start.id, 'worktree') };
}

// 任务标题（提交信息用）：任务说明 frontmatter 的 title，取派发时基线提交里的版本；读不到或没写时退回清单 start 里的标题，再退回记录名。
function taskTitle(root, start) {
  try {
    const shown = git(root, ['show', `${start.base}:${start.spec}`]);
    if (shown.status === 0) {
      const title = validateSpec(parseSpec(shown.stdout, start.spec), start.spec).title;
      if (typeof title === 'string' && title.trim() !== '') return title.trim();
    }
  } catch { /* 任务说明读不了就用退回的标题。 */ }
  return start.title || start.name;
}

const gitFailure =(result, what) => result.stderr.trim() || result.stdout.trim() || (result.status === null ? '无法运行 git' : `${what}退出码 ${result.status}`);
const firstFive = files => files.slice(0, 5).join('、');

// 清理 worktree 与分支；失败不抛出，写 cleanup 事件留给 ar gc。返回是否清理干净。
function cleanUp({ root, registry, id, worktree, force, deleteBranch, forceBranch }) {
  try {
    if (worktree) {
      const dir = worktree.dir;
      // worktree 里只有被忽略的文件时不加 --force；有别的就加（协议 15.6）。
      const dirty = force ?? (existsSync(dir) ? uncommittedFiles(dir).length > 0 : false);
      removeWorktree({ root, dir, branch: deleteBranch && branchExists(root, worktree.branch) ? worktree.branch : null, force: dirty, deleteBranch, forceBranch });
    }
    return true;
  } catch (error) {
    registry({ event: 'cleanup', id, ok: false, error: error.message, at: Date.now() });
    return false;
  }
}

// ar accept：检查 → 合并 → accepted 事件 → 清理。任务分支没有新提交时不合并，改为确认（merge 为 null，mode 为 confirm）。
// 返回 { ok: true, merge, mode, cleanup } 或冲突时 { ok: false, conflict: true, files }；检查不通过时抛出中文原因（退出码 2）。
export function accept({ homes, root, name, squash = false, by = null, env = process.env } = {}) {
  const { file, home, start, worktree } = locateWorktreeTask(homes, root, name, '验收');
  const id = start.id;
  const registry = registryWriter(home);
  // 检查 1：待验收（end.exit === 0，之后没有验收事件；冲突解决后的再次待验收也是这个状态）。
  if (worktreeOutcome(file, id) !== 'awaiting') throw new Error(`任务不在待验收状态：${start.name}`);
  // 任务分支相对基线没有新提交（调研 / 审查类任务）：没有东西可合并，改为确认（Stage07 105）。
  if (noNewCommits({ root, file, start, worktree })) return confirm({ root, registry, id, worktree, by, env });
  const config = projectConfig(root);
  const baseBranch = config.baseBranch;
  if (typeof baseBranch !== 'string' || baseBranch.trim() === '') throw new Error('项目配置没有写 baseBranch，不知道该合并到哪个分支');
  // 检查 2：主工作区当前分支是 baseBranch。
  const current = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current.status !== 0) throw new Error(`无法读取主工作区当前分支：${gitFailure(current, 'git rev-parse ')}`);
  const branchNow = current.stdout.trim();
  if (branchNow !== baseBranch) throw new Error(`主工作区当前在 ${branchNow}，合并要在 ${baseBranch} 上进行：先 git switch ${baseBranch}`);
  // 检查 3：主工作区干净（.agent-runs/ 除外）。
  let dirtyMain;
  try { dirtyMain = uncommittedFiles(root); }
  catch (error) { throw new Error(`无法检查主工作区是否干净：${error.message}`); }
  if (dirtyMain.length) throw new Error(`主工作区有未提交的改动，先提交或暂存：${firstFive(dirtyMain)}`);
  // 检查 4：worktree 里没有门禁之后的未提交改动。
  if (!worktree || typeof worktree.dir !== 'string' || !existsSync(worktree.dir)) {
    throw new Error(`worktree 已经不在了：${worktree?.dir ?? '（清单里没有记录）'}`);
  }
  let dirtyWorktree;
  try { dirtyWorktree = uncommittedFiles(worktree.dir); }
  catch (error) { throw new Error(`无法检查 worktree 是否干净：${error.message}`); }
  if (dirtyWorktree.length) throw new Error(`worktree 里有门禁之后的未提交改动，请先检查：${firstFive(dirtyWorktree)}`);
  if (!branchExists(root, worktree.branch)) throw new Error(`分支已经不在了：${worktree.branch}`);

  const mode = squash || config.mergeMode === 'squash' ? 'squash' : 'no-ff';
  const message = `[执行] 合并 ${start.name}：${taskTitle(root, start)}`;
  const merged = git(root, mode === 'squash' ? ['merge', '--squash', worktree.branch] : ['merge', '--no-ff', '-m', message, worktree.branch]);
  let failure = merged.status === 0 ? null : merged;
  if (!failure && mode === 'squash') {
    // 压成一个提交；分支上没有任何新改动时没有可提交的内容，合并结果就是当前 HEAD。
    const staged = git(root, ['diff', '--cached', '--quiet']);
    if (staged.status === 1) {
      const committed = git(root, ['commit', '-m', message]);
      if (committed.status !== 0) failure = committed;
    } else if (staged.status !== 0) failure = staged;
  }
  if (failure) {
    // 冲突或其他失败：撤销这次合并，主分支恢复原样（合并前主工作区是干净的）。
    const files = unmergedFiles(root);
    undoMerge(root, mode);
    if (!files.length) throw new Error(`合并失败：${gitFailure(failure, 'git merge ')}`);
    registry({ event: 'conflict', id, files, at: Date.now() });
    return { ok: false, conflict: true, files };
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  if (head.status !== 0) throw new Error(`合并已完成，但读不到合并提交：${gitFailure(head, 'git rev-parse ')}`);
  const merge = head.stdout.trim();
  registry({ event: 'accepted', id, merge, mode, by: actor({ by, env }), at: Date.now() });
  const cleanup = cleanUp({ root, registry, id, worktree, force: null, deleteBranch: true, forceBranch: mode === 'squash' });
  return { ok: true, merge, mode, cleanup };
}

// 门禁用的基线：重新基线之后（协议 15.8）新基线写在 attempt 事件上，取最近一条带 base 的，没有就是 start.base。
function currentBase(file, start) {
  for (const row of reverseRows(file)) {
    if (row.id !== start.id) continue;
    if (row.event === 'attempt' && typeof row.base === 'string' && row.base) return row.base;
    if (row.event === 'start') break;
  }
  return start.base ?? null;
}

// 任务分支相对基线是否没有新提交。基线、worktree 或分支读不到时返回 false，交给后面的合并流程报原来的错误。
function noNewCommits({ root, file, start, worktree }) {
  const base = currentBase(file, start);
  if (typeof base !== 'string' || base === '' || !worktree || typeof worktree.branch !== 'string' || !branchExists(root, worktree.branch)) return false;
  const counted = git(root, ['rev-list', '--count', `${base}..refs/heads/${worktree.branch}`]);
  return counted.status === 0 && counted.stdout.trim() === '0';
}

// 确认（没有新提交的待验收任务）：不合并，不看主工作区在哪个分支、是否干净；worktree 里有门禁之后的未提交改动时同样拒绝；
// 写 accepted 事件（merge 为 null，mode 为 confirm），删除 worktree 与分支（分支上没有新提交，直接 -D）。
function confirm({ root, registry, id, worktree, by, env }) {
  if (typeof worktree.dir !== 'string' || !existsSync(worktree.dir)) throw new Error(`worktree 已经不在了：${worktree.dir ?? '（清单里没有记录）'}`);
  let dirtyWorktree;
  try { dirtyWorktree = uncommittedFiles(worktree.dir); }
  catch (error) { throw new Error(`无法检查 worktree 是否干净：${error.message}`); }
  if (dirtyWorktree.length) throw new Error(`worktree 里有门禁之后的未提交改动，请先检查：${firstFive(dirtyWorktree)}`);
  registry({ event: 'accepted', id, merge: null, mode: 'confirm', by: actor({ by, env }), at: Date.now() });
  const cleanup = cleanUp({ root, registry, id, worktree, force: null, deleteBranch: true, forceBranch: true });
  return { ok: true, merge: null, mode: 'confirm', cleanup };
}

// 撤销没做完的合并：--no-ff 用 merge --abort，squash 用 reset --merge（并删掉 squash 留下的提交信息草稿）。
function undoMerge(root, mode) {
  if (mode === 'squash') {
    git(root, ['reset', '--merge']);
    const draft = git(root, ['rev-parse', '--git-path', 'SQUASH_MSG']);
    if (draft.status === 0) rmSync(join(root, draft.stdout.trim()), { force: true });
    return;
  }
  if (git(root, ['merge', '--abort']).status !== 0) git(root, ['reset', '--merge']);
}

// ar reject：驳回待验收、冲突或准备失败的任务，删除 worktree（--force）与分支（--keep-branch 时保留分支）。
// reason 必填；返回 { ok: true, keptBranch, cleanup }，不满足条件时抛出中文原因（退出码 2）。
export function reject({ homes, root, name, reason, keepBranch = false, by = null, env = process.env } = {}) {
  if (typeof reason !== 'string' || reason.trim() === '') throw new Error('驳回必须写原因：--reason "…"');
  const { file, home, start, worktree } = locateWorktreeTask(homes, root, name, '驳回');
  const id = start.id;
  const registry = registryWriter(home);
  const outcome = worktreeOutcome(file, id);
  if (outcome === null) throw new Error(`任务还在进行，先停止：${start.name}`);
  const setupFailed = outcome === 'failed' && findTerminal(file, id)?.reason === 'setup';
  if (!['awaiting', 'conflict'].includes(outcome) && !setupFailed) {
    throw new Error(`任务的状态不能驳回：${start.name}（只有待验收、冲突、准备失败的任务可以驳回）`);
  }
  registry({ event: 'rejected', id, reason: reason.trim(), keptBranch: keepBranch === true, by: actor({ by, env }), at: Date.now() });
  const cleanup = cleanUp({ root, registry, id, worktree, force: true, deleteBranch: !keepBranch, forceBranch: true });
  return { ok: true, keptBranch: keepBranch === true, cleanup };
}
