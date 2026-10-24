// worktree 的位置、命名、创建、准备命令、移除与列出（协议 15.2、15.4）。零依赖。
// 只做模块本身：不写清单事件、不占并发名额、不接入派发流程。
// 约定：git 一律参数数组、shell: false（见 git.mjs）。
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './command.mjs';
import { removeEnv } from './gate.mjs';
import { git } from './git.mjs';

const sha256 = text => createHash('sha256').update(String(text)).digest('hex');

// 运行 git，失败抛出带步骤名的中文原因。
function run(cwd, args, step) {
  const result = git(cwd, args);
  if (result.status !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || (result.status === null ? '无法运行 git' : `退出码 ${result.status}`);
    throw new Error(`${step}失败：${reason}`);
  }
  return result.stdout;
}

// 启用判断（协议 15.1）：用任务说明派发、项目配置 worktree 明确为 true、没有 --no-worktree，三条同时满足。
export function worktreeEnabled({ spec, projectConfig, noWorktree = false } = {}) {
  return !!spec && noWorktree !== true && projectConfig?.worktree === true;
}

// 基线（协议 15.2）：主分支当前指向的提交 SHA，不是主工作区检出的分支。取不到抛出中文原因。
export function resolveBase(root, baseBranch) {
  if (typeof baseBranch !== 'string' || baseBranch.trim() === '') {
    throw new Error('项目配置没有写 baseBranch，worktree 模式需要知道主分支');
  }
  if (baseBranch.startsWith('-')) throw new Error(`baseBranch 无效：${baseBranch}`);
  const result = git(root, ['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`]);
  const sha = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`找不到主分支 ${baseBranch} 的提交：worktree 模式需要从它建分支`);
  }
  return sha;
}

// 任务说明相对项目根的路径（`/` 分隔）；在项目根之外时返回 null。
export function specRelative(root, specPath) {
  const rel = path.relative(path.resolve(root), path.resolve(root, specPath)).replaceAll('\\', '/');
  return rel && !rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel) ? rel : null;
}

// 任务说明必须已经提交在 revision（SHA 或分支名）里，执行者的 worktree 才看得到（协议 15.2）。
// 不在时抛出"任务说明还没提交到 <主分支>，执行者看不到它"；返回相对项目根的路径。
export function requireSpecAt(root, revision, baseBranch, specPath) {
  const rel = specRelative(root, specPath);
  if (!rel || git(root, ['cat-file', '-e', `${revision}:${rel}`]).status !== 0) {
    throw new Error(`任务说明还没提交到 ${baseBranch}，执行者看不到它`);
  }
  return rel;
}

// 根目录：AR_WORKTREE_ROOT > Windows %LOCALAPPDATA%\agent-router\wt > 其他 ~/.cache/agent-router/wt。只返回路径，不创建。
export function worktreeRoot({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (env.AR_WORKTREE_ROOT) return env.AR_WORKTREE_ROOT;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local');
    return path.win32.join(base, 'agent-router', 'wt');
  }
  return path.posix.join(homedir.replace(/\\/g, '/'), '.cache', 'agent-router', 'wt');
}

// 短名：非 [A-Za-z0-9._-] 的每一段连续字符换成一个 _，截到 24 个字符，再加 - 和记录名哈希前 6 位。
export function shortName(name) {
  const text = String(name);
  const safe = text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 24);
  return `${safe}-${sha256(text).slice(0, 6)}`;
}

// <根目录>/<项目根哈希前 6 位>-<短名>。Windows 上项目根先 resolve 再转小写算哈希。
export function worktreeDir({ root, name, env = process.env, platform = process.platform } = {}) {
  const resolved = path.resolve(root);
  const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
  const base = worktreeRoot({ env, platform });
  const join = platform === 'win32' ? path.win32.join : path.join;
  return join(base, `${sha256(key).slice(0, 6)}-${shortName(name)}`);
}

// 分支名：ar/<记录名>；不合法（check-ref-format 不通过，或含空格、非 ASCII 字符）时用 ar/<记录名哈希前 10 位>。
export function branchFor(name, { root } = {}) {
  const text = String(name);
  const candidate = `ar/${text}`;
  const plain = /^[\x21-\x7e]+$/.test(text);
  if (plain && git(root, ['check-ref-format', '--branch', candidate]).status === 0) return candidate;
  return `ar/${sha256(text).slice(0, 10)}`;
}

// 建 worktree 与分支，返回 { dir, branch }。已存在的目录与分支不覆盖、不删除。
export function createWorktree({ root, name, base, env = process.env, platform = process.platform } = {}) {
  const dir = worktreeDir({ root, name, env, platform });
  const branch = branchFor(name, { root });
  if (existsSync(dir)) throw new Error(`worktree 目录已存在：${dir}（运行 ar gc 清理）`);
  if (git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) {
    throw new Error(`分支已存在：${branch}`);
  }
  mkdirSync(path.dirname(dir), { recursive: true });
  run(root, ['worktree', 'add', '-b', branch, dir, base], '新建 worktree 目录');
  try {
    run(dir, ['config', 'core.longpaths', 'true'], '设置 core.longpaths 配置');
  } catch (error) {
    // 只撤这次建的；撤销本身出错不覆盖原始错误。
    git(root, ['worktree', 'remove', '--force', dir]);
    git(root, ['worktree', 'prune']);
    git(root, ['branch', '-D', branch]);
    throw error;
  }
  return { dir, branch };
}

// 在 worktree 里逐条运行准备命令，一条失败就停；输出追加写 logFile。
export async function runSetup({
  dir, commands = [], env = process.env, dropEnv = [], logFile, timeoutMs = 20 * 60000, onSpawn,
} = {}) {
  const list = Array.isArray(commands) ? commands : [];
  if (!list.length) return { ok: true, ms: 0, summary: '没有准备命令', results: [] };
  const started = Date.now();
  const commandEnv = removeEnv(env, dropEnv);
  const results = [];
  let summary = '准备命令完成';
  let ok = true;
  if (logFile) mkdirSync(path.dirname(logFile), { recursive: true });
  for (const line of list) {
    const result = await runCommand(line, { cwd: dir, env: commandEnv, timeoutMs, onSpawn });
    results.push(result);
    if (logFile) {
      const tail = result.output && !result.output.endsWith('\n') ? '\n' : '';
      const note = result.error ? `${result.error}\n` : '';
      appendFileSync(logFile, `$ ${line}\n${result.output}${tail}${note}`, 'utf8');
    }
    if (result.timedOut) summary = `准备命令失败：${line}（超时）`;
    else if (result.error) summary = `准备命令失败：${line}（${result.error}）`;
    else if (result.exit !== 0) summary = `准备命令失败：${line}（exit ${result.exit}）`;
    else continue;
    ok = false;
    break;
  }
  return { ok, ms: Date.now() - started, summary, results };
}

// 移除 worktree 与分支，只动这个 dir 与 branch。每步失败抛出带步骤名的原因，已完成的步骤不回滚。
export function removeWorktree({ root, dir, branch, force = false, deleteBranch = true, forceBranch = false } = {}) {
  if (dir && existsSync(dir)) {
    run(root, ['worktree', 'remove', ...(force ? ['--force'] : []), dir], '移除 worktree 目录');
  }
  run(root, ['worktree', 'prune'], '清理 worktree 记录');
  if (deleteBranch && branch) {
    run(root, ['branch', forceBranch ? '-D' : '-d', branch], '删除分支');
  }
}

// 本地分支是否存在。
export function branchExists(root, branch) {
  return !!branch && git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
}

// 合并冲突里还没解决的文件（相对仓库根，/ 分隔）。
export function unmergedFiles(dir) {
  const result = git(dir, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return result.status === 0 ? result.stdout.split('\0').filter(Boolean) : [];
}

// 把 revision 合并进 dir 这个工作区当前的分支（协议 15.8）：用普通合并，不用 rebase（保留执行者的提交）。
// 返回 { conflicts: [] }（没有冲突，已提交或本来就是最新）、{ conflicts: [文件…] }（有冲突，合并停在冲突状态等人解决）
// 或 { error }（其他失败，已尽量撤销这次合并）。
export function mergeInto({ dir, revision, message }) {
  const result = git(dir, ['merge', '-m', message, revision]);
  if (result.status === 0) return { conflicts: [] };
  const conflicts = unmergedFiles(dir);
  if (conflicts.length) return { conflicts };
  git(dir, ['merge', '--abort']);
  return { error: result.stderr.trim() || result.stdout.trim() || (result.status === null ? '无法运行 git' : `退出码 ${result.status}`) };
}

// 解析 git worktree list --porcelain -z 的输出；不含主工作区（第一条）。
export function parseWorktreeList(text) {
  const entries = [];
  let current = null;
  for (const field of String(text ?? '').split('\0')) {
    if (field === '') { if (current) entries.push(current); current = null; continue; }
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (current) entries.push(current);
      current = { dir: path.resolve(value), branch: null, head: null, locked: false, prunable: false };
    } else if (!current) continue;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  if (current) entries.push(current);
  return entries.slice(1);
}

export function listWorktrees({ root } = {}) {
  return parseWorktreeList(run(root, ['worktree', 'list', '--porcelain', '-z'], '列出 worktree 清单'));
}
