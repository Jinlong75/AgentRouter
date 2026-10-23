// 门禁需要的几个 git 调用（文件协议 12.1）。零依赖。
// 约定：参数数组、shell: false、windowsHide: true；输出按 UTF-8 解码，-z 下路径原样（不转义）。
// 只导出 git、headSha、uncommittedFiles、changedFiles、deletedFiles、baseProjectConfig 与 -z 解析函数（解析函数供单元测试）。
import { spawnSync } from 'node:child_process';
import { parseJson } from './json.mjs';

// 一次 diff / status 的输出可能很大（未跟踪文件多、重命名多），留足余量。
const MAX_BUFFER = 64 * 1024 * 1024;

// 运行 git：返回 { status, stdout, stderr }，都是字符串。git 不存在或启动失败时 status 为 null、stderr 为原因。
export function git(root, args) {
  const options = { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, shell: false, windowsHide: true };
  try {
    const child = spawnSync('git', args, options);
    if (child.error) return { status: null, stdout: '', stderr: child.error.message };
    return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
  } catch (error) {
    return { status: null, stdout: '', stderr: error.message };
  }
}

const FAILURE_REASON = (result, what) => result.stderr.trim() || `${what}退出码 ${result.status}`;

// HEAD 的完整 SHA；仓库没有提交时返回 null。git 不可用或不是仓库时抛出原因，由调用方记成门禁失败。
export function headSha(root) {
  // 先确认在仓库里：这样"rev-parse --verify HEAD 失败"才能稳定解释为"还没有提交"（不依赖本地化后的报错文本）。
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status === null) throw new Error(`git 无法运行：${inside.stderr || '未知原因'}`);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    throw new Error(`不是 git 仓库：${FAILURE_REASON(inside, 'git rev-parse ')}`);
  }
  const result = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (result.status === null) throw new Error(`git 无法运行：${result.stderr || '未知原因'}`);
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`git 返回的 HEAD 不是完整 SHA：${sha}`);
  return sha;
}

// 解析 `git status --porcelain -z --untracked-files=all`（协议 12.1 第 2 步）。
// 每条记录是 "<XY> <路径>"；重命名 / 复制项在 -z 下先给新路径、再跟一条旧路径，两个都列出。
// 门禁不把 .agent-runs/ 里的文件算作未提交。
export function parseStatusPorcelainZ(text) {
  const fields = String(text ?? '').split('\0');
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (file) files.push(file);
    if (/[RC]/.test(status)) {
      const old = fields[++i];
      if (old) files.push(old);
    }
  }
  return files.filter(file => !file.startsWith('.agent-runs/'));
}

// 未提交的路径（含未跟踪文件），已排除 .agent-runs/。git 不可用时抛出原因。
export function uncommittedFiles(root) {
  const result = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (result.status !== 0) throw new Error(FAILURE_REASON(result, 'git status '));
  return parseStatusPorcelainZ(result.stdout);
}

// 解析 `git diff --name-status -z -M`（协议 12.1 第 4 步），返回带状态的条目：{ status, paths }。
// 每条记录先是一个状态（A/M/D/R100/C075…），换行写成 NUL；重命名 / 复制项在 -z 下按旧路径、新路径的顺序给出两条。
export function parseNameStatusEntriesZ(text) {
  const fields = String(text ?? '').split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (!status) continue;
    if (/^[RC]/.test(status)) {
      const paths = [fields[++i], fields[++i]].filter(Boolean);
      if (paths.length) entries.push({ status, paths });
    } else {
      const file = fields[++i];
      if (file) entries.push({ status, paths: [file] });
    }
  }
  return entries;
}

// 条目里状态为 D 的路径（协议 12.1：重命名不算删除，它的新旧路径已在改动列表里）。
export function deletedFromEntries(entries) {
  return entries.filter(entry => entry.status === 'D').flatMap(entry => entry.paths);
}

// 解析 `git diff --name-status -z -M`：改动的路径，去重并保持出现顺序。
export function parseNameStatusZ(text) {
  const files = [];
  for (const { paths } of parseNameStatusEntriesZ(text)) {
    for (const file of paths) if (!files.includes(file)) files.push(file);
  }
  return files;
}

// base..head 之间改动的路径（重命名 / 复制的新旧两个路径都列出）。base === head 时不调用 git。
export function changedFiles(root, base, head) {
  if (base === head) return [];
  const result = git(root, ['diff', '--name-status', '-z', '-M', `${base}..${head}`]);
  if (result.status !== 0) throw new Error(FAILURE_REASON(result, 'git diff '));
  return parseNameStatusZ(result.stdout);
}

// base..head 里删除的文件（状态 D；重命名不算删除，协议 12.1 第 4 步）。base === head 时不调用 git。
export function deletedFiles(root, base, head) {
  if (base === head) return [];
  const result = git(root, ['diff', '--name-status', '-z', '-M', `${base}..${head}`]);
  if (result.status !== 0) throw new Error(FAILURE_REASON(result, 'git diff '));
  return deletedFromEntries(parseNameStatusEntriesZ(result.stdout));
}

// 基线提交里的 .agent-router/project.json（门禁受保护路径读它，协议 12.1 第 4 步）。
// 文件不存在、git 出错、不是合法 JSON 或不是对象时都返回 null（当作没有），不抛错。
export function baseProjectConfig(root, base) {
  if (!base) return null;
  const result = git(root, ['show', `${base}:.agent-router/project.json`]);
  if (result.status !== 0) return null;
  try {
    // 基线里的 project.json 也可能带 BOM（056 起与工作区里的读法一致）。
    const parsed = parseJson(result.stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
