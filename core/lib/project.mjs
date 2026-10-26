// 跨项目复用：ar init 在任意 git 仓库生成项目配置与约定文件；projects.json 记录已添加的项目。
// 原则：已有文件不覆盖，只追加或替换带标记的 AgentRouter 段落；再次运行是幂等的。
import { traced, tracedAsync } from './trace.mjs';
import { mapLimit } from './limit.mjs';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseJson, readJson } from './json.mjs';
import { git as bigGit, gitVersion, gitTooOldMessage, requireModernGit } from './git.mjs';
import { remoteNameValid, remoteSummary } from './push.mjs';
import { projectLeftovers } from './gc.mjs';

export const BEGIN = '<!-- agent-router:begin -->', END = '<!-- agent-router:end -->';
const templateDir = fileURLToPath(new URL('../templates/', import.meta.url));
const git = (root, args) => traced(`git ${args.slice(0, 2).join(' ')}`, () => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true }));
const gitGlobal = args => traced(`git ${args.slice(0, 2).join(' ')}`, () => spawnSync('git', args, { encoding: 'utf8', shell: false, windowsHide: true }));
// 异步版本：命令、参数、追踪标签与 git() 相同；启动失败和退出码非 0 一样按失败处理（status 非 0）。
const gitAsync = (root, args) => tracedAsync(`git ${args.slice(0, 2).join(' ')}`, () => new Promise(resolve => {
  execFile('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true }, (error, stdout) => {
    resolve({ status: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: stdout ?? '' });
  });
}));
const same = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

export function loadTemplates(dir = templateDir) {
  const read = name => readFileSync(join(dir, name), 'utf8').replaceAll('\r\n', '\n');
  return {
    project: (name, baseBranch) => read('project.json').replace('"{name}"', JSON.stringify(name)).replace('"{baseBranch}"', JSON.stringify(baseBranch)),
    agentsBlock: read('agents-block.md').trimEnd(),
    specsReadme: read('specs-README.md'),
    role: role => read(`roles/${role}.md`),
  };
}

// 必须是 git 仓库的根目录；返回当前分支名（空仓库也有，如 main / master）。
export function gitRoot(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new Error(`这个文件夹不是 git 仓库：${root}。先运行 git init，或在软件里点"初始化为 git 仓库"`);
  // 比较真实路径：git 给出长路径，Windows 临时目录可能是 8.3 短路径。
  const real = file => { try { return realpathSync.native(file); } catch { return resolve(file); } };
  if (!same(real(top.stdout.trim()), real(root))) throw new Error(`请在仓库根目录运行：${resolve(top.stdout.trim())}`);
  const branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
  return { branch: branch.status === 0 ? branch.stdout.trim() : 'main' };
}

// 是否为 git 仓库根目录：是则返回顶层路径，否则 null（只读展示用，不抛错）。
function gitTop(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return null;
  const real = file => { try { return realpathSync.native(file); } catch { return resolve(file); } };
  try { return same(real(top.stdout.trim()), real(root)) ? top.stdout.trim() : null; } catch { return null; }
}
// 与 gitTop 相同的判断，只换成异步 git：供 projects list --json 并发核对用。
async function gitTopAsync(root) {
  const top = await gitAsync(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return null;
  const real = file => { try { return realpathSync.native(file); } catch { return resolve(file); } };
  try { return same(real(top.stdout.trim()), real(root)) ? top.stdout.trim() : null; } catch { return null; }
}
function gitBranch(root) {
  const branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
  return branch.status === 0 ? branch.stdout.trim() : 'main';
}
// 未提交改动行数，.agent-runs/ 不算。
function dirtyCount(root) {
  const status = git(root, ['status', '--porcelain']);
  if (status.status !== 0) return null;
  return status.stdout.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !l.includes('.agent-runs/')).length;
}

// 生效的 git 提交身份：git config 自己合并仓库、全局、系统的值；读不到为 null。
function gitConfigValue(root, key) {
  const value = git(root, ['config', '--get', key]);
  if (value.status !== 0) return null;
  return value.stdout.trim() || null;
}
export function gitIdentity(root) {
  return { name: gitConfigValue(root, 'user.name'), email: gitConfigValue(root, 'user.email') };
}
// 本机是否已有全局提交身份（git config --global 的 user.name 和 user.email 都有值）。
function hasGlobalIdentity() {
  const value = key => { const r = gitGlobal(['config', '--global', '--get', key]); return r.status === 0 && r.stdout.trim() !== ''; };
  return value('user.name') && value('user.email');
}
export const NEED_IDENTITY = '还没有设置 git 提交身份（用户名和邮箱）：在项目页点"设置提交身份"，或在终端运行 git config user.name "你的名字" 和 git config user.email "你的邮箱"';
// 提交前的检查：任一读不到就抛出带 arCode 的错误，调用方不执行 git add / git commit。
export function requireGitIdentity(root) {
  const identity = gitIdentity(root);
  if (identity.name && identity.email) return identity;
  const error = new Error(NEED_IDENTITY);
  error.arCode = 'NEED_GIT_IDENTITY';
  throw error;
}

const read = (root, rel) => { try { return readFileSync(join(root, rel), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 仓库的主分支（协议第 6 节 baseBranch，067）：依次取 ① origin/HEAD 指向的分支；② 本地 main；③ 本地 master；
// ④ 当前分支（还没有分支名时 main）。返回 { name, step, source }，step 是取自第几步，source 是给人看的来源说明。
export function detectBaseBranch(root, current = gitBranch(root)) {
  const origin = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const remote = origin.status === 0 ? origin.stdout.trim().replace(/^origin\//, '') : '';
  if (remote) return { name: remote, step: 1, source: '取自 origin/HEAD（第 1 步）' };
  for (const [step, name] of [[2, 'main'], [3, 'master']]) {
    if (git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).status === 0) return { name, step, source: `本地有 ${name} 分支（第 ${step} 步）` };
  }
  const named = git(root, ['symbolic-ref', '--short', 'HEAD']).status === 0;
  return { name: current, step: 4, source: named ? '取当前分支（第 4 步）' : '还没有分支名，用 main（第 4 步）' };
}

export function planInit(root, templates = loadTemplates(), base = null) {
  root = resolve(root);
  gitRoot(root);
  const { name: branch } = base ?? detectBaseBranch(root);
  const plan = [];
  const create = (rel, content) => { if (read(root, rel) === null) plan.push({ path: rel, action: 'create', content }); };
  create('.agent-router/project.json', templates.project(basename(root), branch));
  const agents = read(root, 'AGENTS.md'), block = `${BEGIN}\n${templates.agentsBlock}\n${END}`;
  if (agents === null) plan.push({ path: 'AGENTS.md', action: 'create', content: `# ${basename(root)}\n\n${block}\n` });
  else plan.push({ path: 'AGENTS.md', action: 'update', content: agents.includes(BEGIN) && agents.includes(END)
    ? agents.replace(new RegExp(`${escape(BEGIN)}[\\s\\S]*?${escape(END)}`), () => block)
    : `${agents.trimEnd()}\n\n${block}\n` });
  const claude = read(root, 'CLAUDE.md');
  if (claude === null) plan.push({ path: 'CLAUDE.md', action: 'create', content: '@AGENTS.md\n' });
  else if (!/@AGENTS\.md/.test(claude)) plan.push({ path: 'CLAUDE.md', action: 'update', content: `${claude.trimEnd()}\n\n@AGENTS.md\n` });
  for (const role of ['lead', 'worker', 'reviewer']) create(`docs/roles/${role}.md`, templates.role(role));
  create('docs/specs/README.md', templates.specsReadme);
  const ignore = read(root, '.gitignore');
  if (!/^\/?\.agent-runs\/?\s*$/m.test(ignore ?? '')) plan.push({ path: '.gitignore', action: ignore === null ? 'create' : 'update', content: `${(ignore ?? '').trimEnd()}\n.agent-runs/\n`.trimStart() });
  // 去掉内容没有变化的项：重复运行时计划为空。
  return plan.filter(p => p.action === 'create' || p.content !== read(root, p.path));
}

function writeAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}

export function applyInit(root, plan, home) {
  root = resolve(root);
  for (const p of plan) writeAtomic(join(root, p.path), p.content);
  registerProject(home, root);
  return plan.map(({ path, action }) => ({ path, action }));
}

// projects.json：{ v:1, projects:[{ path, name, addedAt, lastUsed }] }
const projectsFile = home => join(home, 'projects.json');
export function readProjects(home) {
  try {
    const value = readJson(projectsFile(home));
    if (value?.v === 1 && Array.isArray(value.projects)) return value.projects.filter(p => typeof p?.path === 'string');
    throw new Error('projects.json 格式无效');
  } catch (error) { if (error.code === 'ENOENT') return []; throw new Error(`projects.json 无法读取（${error.message}）`); }
}
const saveProjects = (home, projects) => writeAtomic(projectsFile(home), `${JSON.stringify({ v: 1, projects }, null, 2)}\n`);

export function registerProject(home, root, now = Date.now()) {
  root = resolve(root);
  const projects = readProjects(home), existing = projects.find(p => same(p.path, root));
  if (existing) existing.lastUsed = now;
  else projects.push({ path: root, name: basename(root), addedAt: now, lastUsed: now });
  saveProjects(home, projects);
  return projects;
}
export function addProject(home, root) { gitRoot(resolve(root)); return registerProject(home, root); }
// --allow-non-git：只要求文件夹存在，照样登记。
export function addProjectNonGit(home, root) {
  root = resolve(root);
  if (!existsSync(root)) throw new Error(`文件夹不存在：${root}`);
  return registerProject(home, root);
}
export function removeProject(home, root) {
  const projects = readProjects(home), rest = projects.filter(p => !same(p.path, root));
  if (rest.length === projects.length) throw new Error(`没有登记这个项目：${resolve(root)}`);
  saveProjects(home, rest);
  return rest;
}
// 清空项目登记表（018）：照 remove 的写法，只改登记表，不碰任何项目文件夹与其中文件。
export function clearProjects(home) {
  const projects = readProjects(home);
  saveProjects(home, []);
  return { removed: projects.length };
}

// list --json 的每项状态：只用文件系统判断与一次 git rev-parse；目录不存在时不跑 git。
async function projectStatus(p) {
  const root = resolve(p.path);
  const exists = existsSync(root);
  const isGit = exists ? await gitTopAsync(root) !== null : false;
  return { ...p, exists, git: isGit, initialized: exists && read(root, '.agent-router/project.json') !== null };
}
function readProjectConfig(root) {
  const raw = read(root, '.agent-router/project.json');
  if (raw === null) return { config: null, configError: null };
  try { return { config: parseJson(raw), configError: null }; }
  catch (error) { return { config: null, configError: `project.json 无法解析：${error.message}` }; }
}
// 公共目录 runs.jsonl 里这个仓库最近一条 start 的 { name, started }。
function lastTask(home, root) {
  try {
    const text = readFileSync(join(home, 'runs.jsonl'), 'utf8');
    let found = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event?.event === 'start' && typeof event.repo === 'string' && same(resolve(event.repo), resolve(root))) found = { name: event.name, started: event.started };
    }
    return found;
  } catch { return null; }
}
function projectShow(home, root) {
  root = resolve(root);
  const project = readProjects(home).find(p => same(p.path, root));
  if (!project) throw new Error(`没有登记这个项目：${root}`);
  const exists = existsSync(root);
  const isGit = exists ? gitTop(root) !== null : false;
  const { config, configError } = exists ? readProjectConfig(root) : { config: null, configError: null };
  return { path: project.path, name: project.name, exists, git: isGit,
    branch: isGit ? gitBranch(root) : null,
    dirty: isGit ? dirtyCount(root) : null,
    identity: isGit ? gitIdentity(root) : null,
    globalIdentity: hasGlobalIdentity(),
    initialized: exists && read(root, '.agent-router/project.json') !== null,
    config, configError,
    lastTask: lastTask(home, root),
    // 远程状态（Stage07b 128）：只读本地已有的远程跟踪分支，不联网；地址已去掉用户名密码。
    remote: isGit ? remoteSummary(root) : null };
}

// 写或删 push 对象里的一个键；push 不是对象（手改坏了）时当作空对象；删光后去掉 push。
function setPushKey(config, name, value) {
  const push = config.push && typeof config.push === 'object' && !Array.isArray(config.push) ? config.push : {};
  if (value === undefined) delete push[name]; else push[name] = value;
  if (Object.keys(push).length) config.push = push; else delete config.push;
}

// projects config 可改的键与校验。非法值抛中文错误，调用方在写文件前就会停下。
function applyProjectSetting(config, root, key, value) {
  switch (key) {
    case 'baseBranch': {
      if (typeof value !== 'string' || !value) throw new Error('baseBranch 不能为空');
      const check = git(root, ['check-ref-format', '--branch', value]);
      if (check.status !== 0) throw new Error(`baseBranch 无效：${value}`);
      config.baseBranch = value;
      return;
    }
    case 'setup': case 'verify': case 'allowedPaths': {
      let list;
      try { list = JSON.parse(value); } catch { throw new Error(`${key} 必须是 JSON 字符串数组`); }
      if (!Array.isArray(list) || list.some(item => typeof item !== 'string' || !item || item.includes('\n'))) throw new Error(`${key} 必须是 JSON 字符串数组，每项非空且不含换行`);
      if (key === 'allowedPaths' && !list.length) throw new Error('allowedPaths 不能为空数组');
      config[key] = list;
      return;
    }
    case 'specsDir': {
      if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\n') || value.includes('\r') || value.split('/').includes('..') || /^[A-Za-z]:/.test(value) || value.startsWith('/')) {
        throw new Error('specsDir 必须是相对路径：不能是绝对路径、不能含 .. 段、用 / 分隔');
      }
      config.specsDir = value;
      return;
    }
    // 推送设置（Stage07b 128）：写进 push 对象；值为空表示删掉这个键，三个键都删掉后删掉 push 对象。
    case 'push.remote': {
      if (value !== '' && !remoteNameValid(root, value)) throw new Error(`push.remote 必须是有效的远程名（不能以 - 开头）：${value}`);
      setPushKey(config, 'remote', value === '' ? undefined : value);
      return;
    }
    case 'push.afterAccept': case 'push.allowLead': {
      if (value !== '' && value !== 'true' && value !== 'false') throw new Error(`${key} 只能是 true 或 false（留空表示删掉）：${value}`);
      setPushKey(config, key.slice(5), value === '' ? undefined : value === 'true');
      return;
    }
    // 高级项（Stage07b 126）：值为空表示删掉这个键，回到读取处的默认值。
    case 'maxRetries': case 'verifyTimeoutMin': {
      if (value === '') { delete config[key]; return; }
      const [min, max] = key === 'maxRetries' ? [0, 5] : [1, 240];
      if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${key} 必须是 ${min}～${max} 的整数（留空表示删掉）：${value}`);
      config[key] = Number(value);
      return;
    }
    case 'mergeMode': {
      if (value === '') { delete config.mergeMode; return; }
      if (value !== 'no-ff' && value !== 'squash') throw new Error(`mergeMode 只能是 no-ff 或 squash（留空表示删掉）：${value}`);
      config.mergeMode = value;
      return;
    }
    case 'worktree': {
      if (value === '') { delete config.worktree; return; }
      if (value !== 'true' && value !== 'false') throw new Error(`worktree 只能是 true 或 false（留空表示删掉）：${value}`);
      config.worktree = value === 'true';
      return;
    }
    default: throw new Error(`不能改这个键：${key}`);
  }
}
function projectConfig(root, assignments) {
  root = resolve(root);
  const raw = read(root, '.agent-router/project.json');
  if (raw === null) throw new Error('项目还没有初始化：先运行 ar init');
  let config;
  try { config = parseJson(raw); } catch (error) { throw new Error(`project.json 无法解析：${error.message}`); }
  if (!assignments.length) return { config };
  const next = structuredClone(config);
  for (const a of assignments) {
    const eq = a.indexOf('=');
    if (eq <= 0) throw new Error(`用法：键=值（${a}）`);
    applyProjectSetting(next, root, a.slice(0, eq), a.slice(eq + 1));
  }
  writeAtomic(join(root, '.agent-router/project.json'), `${JSON.stringify(next, null, 2)}\n`);
  return { config: next };
}

// commit-init 只提交 ar init 管理的这几个路径，绝不 git add -A / git add .。
const INIT_FILES = ['.agent-router/project.json', 'AGENTS.md', 'CLAUDE.md', 'docs/roles/lead.md', 'docs/roles/worker.md', 'docs/roles/reviewer.md', 'docs/specs/README.md', '.gitignore'];
const tail = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-6).join('；');
const AGENT_RUNS_PREFIX = '.agent-runs/';

// 解析 `git status --porcelain=v1 -z -uall`：-z 下路径不转义（中文、空格原样），记录以 NUL 分隔；
// 重命名 / 复制项先给新路径、再跟一条旧路径。返回 { path, xy, kind, from? }，已排除 .agent-runs/。
// kind：add（未跟踪、新增、复制）/ update / delete / rename（from 是旧路径）。
export function parseChanges(text) {
  const fields = String(text ?? '').split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2), path = entry.slice(3);
    const from = /[RC]/.test(xy) ? (fields[++i] || null) : null;
    if (!path || path.startsWith(AGENT_RUNS_PREFIX)) continue;
    let kind = 'update';
    if (xy.includes('R')) kind = 'rename';
    else if (xy.includes('D')) kind = 'delete';
    else if (xy === '??' || xy.includes('A') || xy.includes('C')) kind = 'add';
    entries.push({ path, xy, kind, ...(kind === 'rename' && from ? { from } : {}) });
  }
  return entries;
}
function listChanges(root) {
  const status = bigGit(root, ['status', '--porcelain=v1', '-z', '-uall']);
  if (status.status !== 0) throw new Error(`git status 失败：${tail(status.stderr)}`);
  return parseChanges(status.stdout);
}
// 项目还没有任何提交（HEAD 不存在）。
const hasNoCommits = root => git(root, ['rev-parse', '--verify', 'HEAD']).status !== 0;

// ar projects changes：主工作区里未提交的文件（已跟踪和未跟踪的都列，遵守 .gitignore，不含 .agent-runs/）。
function projectChanges(root) {
  root = resolve(root);
  if (!gitTop(root)) throw new Error(`这个文件夹不是 git 仓库：${root}`);
  return listChanges(root).map(({ path, kind, from }) => ({ path, kind, ...(from ? { from } : {}) }));
}

// 校验并规范提交的文件路径：相对项目根、用 / 分隔；项目外和 .agent-runs/ 下的拒绝。
function normalizeCommitPath(root, file) {
  if (typeof file !== 'string' || !file.trim() || file.includes('\0')) throw new Error('文件路径必须是非空字符串');
  const abs = resolve(root, file), rel = relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`路径在项目外：${file}`);
  const normal = rel.split(sep).join('/');
  if (normal === '.agent-runs' || normal.startsWith(AGENT_RUNS_PREFIX)) throw new Error(`不能提交任务记录目录 .agent-runs/ 下的文件：${file}`);
  return normal;
}

// ar projects commit：只提交列出的具体文件，绝不 git add -A / git add .；用 `git commit -- <路径>` 保证不带走事先暂存的其他文件。
function projectCommit(root, form) {
  root = resolve(root);
  if (!gitTop(root)) throw new Error(`这个文件夹不是 git 仓库：${root}`);
  const message = typeof form?.message === 'string' ? form.message.trim() : '';
  if (!message) throw new Error('提交说明不能为空');
  if (!Array.isArray(form?.files) || !form.files.length) throw new Error('没有选中要提交的文件');
  const files = [...new Set(form.files.map(file => normalizeCommitPath(root, file)))];
  const known = new Map(listChanges(root).map(entry => [entry.path, entry]));
  const missing = files.filter(file => !known.has(file));
  if (missing.length) throw new Error(`这些文件没有未提交的改动：${missing.join('、')}`);
  requireGitIdentity(root);
  // 暂存区里已经有的改动（如 git rm 或已暂存的重命名）不需要再 add；重命名的旧路径要和新路径一起提交。
  const toAdd = files.filter(file => known.get(file).xy[1] !== ' ');
  const paths = [...new Set(files.flatMap(file => [file, ...(known.get(file).from ? [known.get(file).from] : [])]))];
  if (toAdd.length) {
    const add = git(root, ['add', '--', ...toAdd]);
    if (add.status !== 0) throw new Error(`git add 失败：${tail(add.stderr)}`);
  }
  const commit = git(root, ['commit', '-m', message, '--', ...paths]);
  if (commit.status !== 0) throw new Error(`git commit 失败：${tail(commit.stderr)}`);
  return { commit: git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim(), files };
}

// 初始化前预览用：项目还没有任何提交时，除 ar init 管理的文件以外、已在工作区里的文件（未跟踪或已暂存，遵守 .gitignore，不含 .agent-runs/）。
function existingFilesOf(root) {
  return listChanges(root).map(entry => entry.path).filter(path => !INIT_FILES.includes(path));
}

function commitInit(root, withExisting = false) {
  root = resolve(root);
  if (!gitTop(root)) throw new Error(`这个文件夹不是 git 仓库：${root}`);
  const files = INIT_FILES.filter(rel => {
    const status = git(root, ['status', '--porcelain', '--', rel]);
    return status.status === 0 && status.stdout.trim() !== '';
  });
  if (!files.length) throw new Error('没有需要提交的初始化文件');
  requireGitIdentity(root);
  // 只有项目还没有任何提交时才带上已有文件；已有提交时参数被忽略。
  const together = withExisting && hasNoCommits(root);
  const all = together ? [...files, ...existingFilesOf(root)] : files;
  const add = git(root, ['add', '--', ...all]);
  if (add.status !== 0) throw new Error(`git add 失败：${tail(add.stderr)}`);
  const commit = git(root, ['commit', '-m', '[主导] 接入 AgentRouter', '--', ...all]);
  if (commit.status !== 0) throw new Error(`git commit 失败：${tail(commit.stderr)}`);
  const hash = git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();
  return { commit: hash, files: all, withExisting: together };
}

// ---- ar init --upgrade：更新协作约定（130）----
const ROLES = ['lead', 'worker', 'reviewer'];
const BACKUP_DIR = '.agent-router/backup', BACKUP_IGNORE = '.agent-router/backup/';
const DIFF_CONTEXT = 2, DIFF_MAX_LINES = 200, LCS_MAX_CELLS = 4_000_000;
const splitLines = text => { const lines = text.replaceAll('\r\n', '\n').split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };

// 按行差异（零依赖）：先去掉相同的头尾，中间用 LCS 动态规划；中间部分太大（行数乘积超过 LCS_MAX_CELLS）时不算 LCS，整段当作先删后加。
// 返回 [{ op: '+'|'-'|' ', text }]（完整序列）。
export function lineDiff(oldText, newText) {
  const a = splitLines(oldText), b = splitLines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailLen = 0;
  while (tailLen < a.length - head && tailLen < b.length - head && a[a.length - 1 - tailLen] === b[b.length - 1 - tailLen]) tailLen++;
  const am = a.slice(head, a.length - tailLen), bm = b.slice(head, b.length - tailLen);
  const ops = a.slice(0, head).map(text => ({ op: ' ', text }));
  if ((am.length + 1) * (bm.length + 1) > LCS_MAX_CELLS) {
    for (const text of am) ops.push({ op: '-', text });
    for (const text of bm) ops.push({ op: '+', text });
  } else {
    const w = bm.length + 1, table = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) for (let j = bm.length - 1; j >= 0; j--) {
      table[i * w + j] = am[i] === bm[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
    let i = 0, j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) { ops.push({ op: ' ', text: am[i] }); i++; j++; }
      else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) ops.push({ op: '-', text: am[i++] });
      else ops.push({ op: '+', text: bm[j++] });
    }
    while (i < am.length) ops.push({ op: '-', text: am[i++] });
    while (j < bm.length) ops.push({ op: '+', text: bm[j++] });
  }
  for (const text of a.slice(a.length - tailLen)) ops.push({ op: ' ', text });
  return ops;
}
// 只保留有变化的段落和前后各 DIFF_CONTEXT 行上下文，最多 DIFF_MAX_LINES 行（超出截断并标 truncated）。
export function diffSummary(oldText, newText) {
  const ops = lineDiff(oldText, newText);
  const added = ops.filter(o => o.op === '+').length, removed = ops.filter(o => o.op === '-').length;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.op !== ' ') for (let k = Math.max(0, i - DIFF_CONTEXT); k <= Math.min(ops.length - 1, i + DIFF_CONTEXT); k++) keep[k] = true; });
  const diff = ops.filter((_, i) => keep[i]);
  const truncated = diff.length > DIFF_MAX_LINES;
  return { added, removed, diff: truncated ? diff.slice(0, DIFF_MAX_LINES) : diff, truncated };
}

// 升级计划：普通 init 计划 + 角色文档差异 + 配置缺少的顶层键。项目必须已初始化。
function planUpgrade(root, base) {
  if (read(root, '.agent-router/project.json') === null) throw new Error('这个项目还没有初始化：先运行 ar init，再用 ar init --upgrade 更新协作约定');
  const templates = loadTemplates();
  const plan = planInit(root, templates, base);
  const roleDiffs = [];
  for (const role of ROLES) {
    const rel = `docs/roles/${role}.md`, current = read(root, rel);
    if (current === null) continue;
    const template = templates.role(role);
    if (current.replaceAll('\r\n', '\n') === template) continue;
    roleDiffs.push({ path: rel, role, content: template, ...diffSummary(current, template) });
  }
  let existing;
  try { existing = parseJson(read(root, '.agent-router/project.json')); } catch (error) { throw new Error(`.agent-router/project.json 无法读取：${error.message}`); }
  const defaults = JSON.parse(templates.project(basename(root), base.name));
  const configFields = Object.keys(defaults).filter(key => !Object.hasOwn(existing, key)).map(key => ({ key, value: defaults[key] }));
  return { plan, roleDiffs, configFields };
}
// 给 project.json 追加顶层键：其余内容一个字节不变，新键接在最后一个键后面。
function appendConfigFields(text, fields) {
  const close = text.lastIndexOf('}');
  const before = text.slice(0, close).trimEnd(), hasKeys = !before.endsWith('{');
  const body = fields.map(({ key, value }) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n');
  const next = `${before}${hasKeys ? ',' : ''}\n${body}\n${text.slice(close)}`;
  JSON.parse(next);
  return next;
}
const backupStamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const listArg = (value, what) => { if (value === undefined) return []; const list = String(value).split(',').map(s => s.trim()).filter(Boolean); if (!list.length) throw new Error(`${what} 需要至少一个名字，用逗号分隔`); return list; };

function upgradeCommand(root, { home, json, dryRun, replaceRoles, addFields }) {
  const base = detectBaseBranch(root);
  const { plan, roleDiffs, configFields } = planUpgrade(root, base);
  if (dryRun) {
    const items = [
      ...plan.map(({ path, action, content }) => ({ path, action, content, preview: previewOf(root, { path, action, content }) })),
      ...roleDiffs.map(({ path, added, removed, diff, truncated }) => ({ path, action: 'roleDiff', added, removed, diff, truncated })),
      ...configFields.map(({ key, value }) => ({ path: '.agent-router/project.json', action: 'configField', key, value })),
    ];
    if (json) return { ok: true, root, dryRun: true, changes: items, registered: false };
    const lines = items.length ? [`将要改动（${root}）：`] : [`没有需要改动的文件：${root}`];
    for (const c of items) {
      if (c.action === 'roleDiff') lines.push(`  角色文档和最新模板不同  ${c.path}（+${c.added} −${c.removed} 行；用 --replace-role ${c.path.split('/').at(-1).replace('.md', '')} 备份后替换）`);
      else if (c.action === 'configField') lines.push(`  配置缺少的新字段  ${c.key} = ${JSON.stringify(c.value)}（用 --add-field ${c.key} 写入）`);
      else lines.push(`  ${actionText[c.action]}  ${c.path}`);
    }
    return lines.join('\n');
  }
  for (const role of replaceRoles) if (!ROLES.includes(role)) throw new Error(`--replace-role 只能是 ${ROLES.join('、')}：${role}`);
  for (const key of addFields) if (!configFields.some(f => f.key === key)) throw new Error(`--add-field 只能是配置里缺少的字段（${configFields.map(f => f.key).join('、') || '没有'}）：${key}`);
  const replacing = roleDiffs.filter(d => replaceRoles.includes(d.role));
  // 先备份：任何一个备份失败，已建的备份也删掉，什么都不写。
  const stamp = backupStamp(), backups = [];
  try {
    for (const d of replacing) {
      const rel = `${BACKUP_DIR}/${d.role}.md-${stamp}`;
      mkdirSync(join(root, BACKUP_DIR), { recursive: true });
      writeFileSync(join(root, rel), readFileSync(join(root, d.path)), { flag: 'wx' });
      backups.push(rel);
    }
  } catch (error) {
    for (const rel of backups) rmSync(join(root, rel), { force: true });
    throw new Error(`备份角色文档失败，没有替换任何文件：${error.message}`);
  }
  const writes = plan.map(p => ({ ...p }));
  const put = (path, action, content) => { const i = writes.findIndex(w => w.path === path); if (i >= 0) writes[i] = { path, action: writes[i].action, content }; else writes.push({ path, action, content }); };
  for (const d of replacing) put(d.path, 'update', d.content);
  if (addFields.length) put('.agent-router/project.json', 'update', appendConfigFields(read(root, '.agent-router/project.json'), configFields.filter(f => addFields.includes(f.key))));
  if (backups.length) {
    const pending = writes.find(w => w.path === '.gitignore'), ignore = pending?.content ?? read(root, '.gitignore');
    if (!(ignore ?? '').split(/\r?\n/).some(line => line.trim() === BACKUP_IGNORE)) put('.gitignore', ignore === null ? 'create' : 'update', `${(ignore ?? '').trimEnd()}\n${BACKUP_IGNORE}\n`.trimStart());
  }
  const changes = applyInit(root, writes, home);
  if (json) return { ok: true, root, dryRun: false, changes, backups, registered: true };
  const lines = changes.length ? [`已改动（${root}）：`, ...changes.map(c => `  ${actionText[c.action]}  ${c.path}`)] : [`没有需要改动的文件：${root}`];
  for (const rel of backups) lines.push(`  已备份  ${rel}`);
  lines.push(`已登记项目：${root}`);
  return lines.join('\n');
}

const actionText = { create: '新建', update: '更新' };
// preview：新建文件为完整内容；更新文件为相对现有内容新增的部分（新内容以现有内容开头时取剩下的并去掉首尾空行）。
function previewOf(root, change) {
  if (change.action === 'create') return change.content;
  const existing = (read(root, change.path) ?? '').replaceAll('\r\n', '\n').trimEnd();
  return change.content.startsWith(existing) ? change.content.slice(existing.length).trim() : change.content;
}
export function initCommand(rest, { home, cwd, json }) {
  const usage = '用法：ar init [项目路径] [--dry-run] | ar init --upgrade [项目路径] [--dry-run] [--replace-role <角色,…>] [--add-field <键,…>]';
  const flags = { replaceRole: undefined, addField: undefined };
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--replace-role' || rest[i] === '--add-field') {
      if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) throw new Error(usage);
      flags[rest[i] === '--replace-role' ? 'replaceRole' : 'addField'] = rest[++i];
    } else args.push(rest[i]);
  }
  const dryRun = args.includes('--dry-run'), upgrade = args.includes('--upgrade');
  const positional = args.filter(a => a !== '--dry-run' && a !== '--upgrade');
  if (positional.length > 1 || positional.some(a => a.startsWith('--')) || (!upgrade && (flags.replaceRole !== undefined || flags.addField !== undefined))) throw new Error(usage);
  const root = resolve(cwd, positional[0] ?? '.');
  requireModernGit('init');
  gitRoot(root);
  if (upgrade) return upgradeCommand(root, { home, json, dryRun, replaceRoles: listArg(flags.replaceRole, '--replace-role'), addFields: listArg(flags.addField, '--add-field') });
  const base = detectBaseBranch(root);
  const plan = planInit(root, undefined, base);
  const changes = dryRun ? plan.map(({ path, action }) => ({ path, action })) : applyInit(root, plan, home);
  // 主分支只有这次要新建 project.json 时才有意义（已有的不改）；--dry-run 的计划里写出取到的值和来源。
  const baseInfo = dryRun && plan.some(p => p.path === '.agent-router/project.json') ? { name: base.name, step: base.step, source: base.source } : null;
  if (json) {
    // 只有 --dry-run 才带 content / preview 与 baseBranch；不加 --dry-run 的输出不变。
    const jsonChanges = dryRun ? plan.map(({ path, action, content }) => ({ path, action, content, preview: previewOf(root, { path, action, content }) })) : changes;
    // 项目还没有任何提交时，--dry-run 多带 existingFiles：初始化之后可以和 init 文件放进同一个提交的已有文件。
    const existingFiles = dryRun && hasNoCommits(root) ? existingFilesOf(root) : null;
    return { ok: true, root, dryRun, changes: jsonChanges, registered: !dryRun, ...(baseInfo ? { baseBranch: baseInfo } : {}), ...(existingFiles ? { existingFiles } : {}) };
  }
  const lines = [];
  if (!changes.length) lines.push(`没有需要改动的文件：${root}`);
  else {
    lines.push(`${dryRun ? '将要改动' : '已改动'}（${root}）：`);
    for (const c of changes) lines.push(`  ${actionText[c.action]}  ${c.path}`);
  }
  if (baseInfo) lines.push(`主分支（baseBranch）：${baseInfo.name}（${baseInfo.source}）`);
  if (!dryRun) {
    lines.push(`已登记项目：${root}`);
    if (changes.length) {
      const files = changes.map(c => JSON.stringify(c.path)).join(' ');
      lines.push('不会自动提交。确认后可以运行：', `  git add -- ${files}`, `  git commit -m "[主导] 接入 AgentRouter" -- ${files}`);
    }
  }
  return lines.join('\n');
}

const usageProjects = '用法：ar projects list [--registry-only] | add <路径> [--allow-non-git] | remove <路径> | purge <路径> [--dry-run] [--worktrees] | clear | show [路径] | config <路径> [键=值 …] | git-init <路径> | commit-init <路径> [--with-existing] | changes <路径> | commit <路径> [--message <说明> --files <路径…>]（不带参数时从标准输入读 JSON { "message", "files" }） | git-identity <路径> --name <用户名> --email <邮箱> [--global]';
// projects list --json 逐项目 git 核对的并发上限：最多同时 4 个 git 子进程，项目更少时只开项目数个。
const PROJECT_STATUS_CONCURRENCY = 4;
const projectListText = projects => projects.length ? ['已添加的项目：', ...projects.map(p => `  ${p.name}  ${p.path}`)].join('\n') : '还没有添加项目：在项目里运行 ar init，或 ar projects add <路径>';
const withGitNote = text => { const note = gitTooOldMessage('worktree'); return note ? `${text}\n${note}` : text; };
function projectShowText(p) {
  const lines = [`项目：${p.name}`, `  路径：${p.path}`, `  目录存在：${p.exists ? '是' : '否'}`, `  git 仓库：${p.git ? '是（分支 ' + p.branch + '）' : '否'}`];
  if (p.git) lines.push(`  未提交改动：${p.dirty} 项（不含 .agent-runs/）`);
  lines.push(`  已初始化：${p.initialized ? '是' : '否'}`);
  if (p.remote?.exists) {
    const relation = { same: '和远程一样', ahead: `领先 ${p.remote.ahead} 个提交`, behind: `落后 ${p.remote.behind} 个提交`, diverged: `领先 ${p.remote.ahead}、落后 ${p.remote.behind} 个提交（分叉）`, noUpstream: '远程还没有这个分支' }[p.remote.state];
    lines.push(`  远程：${p.remote.name}（${p.remote.url}）${relation ? `，${relation}` : ''}${p.remote.credentialInUrl ? '，地址里带了凭据，不能推送' : ''}`);
  } else if (p.remote) lines.push('  远程：没有');
  if (p.lastTask) lines.push(`  最近任务：${p.lastTask.name}（${new Date(p.lastTask.started).toLocaleString('zh-CN')}）`);
  return lines.join('\n');
}
// 提交身份的输入校验：用户名非空、单行、≤100 字符；邮箱含 @、没有空白与换行、≤200 字符。
function checkIdentityInput(name, email) {
  const user = typeof name === 'string' ? name.trim() : '';
  if (!user || user.length > 100 || /[\r\n]/.test(user)) throw new Error('用户名不能为空，必须是单行，且不超过 100 个字符');
  const mail = typeof email === 'string' ? email.trim() : '';
  if (!mail || mail.length > 200 || !mail.includes('@') || /\s/.test(mail)) throw new Error('邮箱格式不对：要包含 @，不能有空白，且不超过 200 个字符');
  return { name: user, email: mail };
}
// ar projects commit 的表单：--message / --files 任一出现就按命令行读（--files 吃掉后面所有不以 -- 开头的参数），否则读标准输入的 JSON。
async function readCommitForm(args, readForm) {
  const positional = [];
  let message, files = null, onCommandLine = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--message') {
      if (i + 1 >= args.length) throw new Error(usageProjects);
      message = args[++i]; onCommandLine = true;
    } else if (arg === '--files') {
      files = [];
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) files.push(args[++i]);
      onCommandLine = true;
    } else if (arg.startsWith('--')) throw new Error(usageProjects);
    else positional.push(arg);
  }
  if (positional.length !== 1 || !positional[0]) throw new Error(usageProjects);
  if (onCommandLine) return { target: positional[0], form: { message: message ?? '', files: files ?? [] } };
  let form;
  try { form = JSON.parse(await readForm()); } catch (error) { throw new Error(`标准输入不是有效的 JSON：${error.message}`); }
  if (!form || typeof form !== 'object' || Array.isArray(form)) throw new Error('提交表单必须是 JSON 对象 { "message", "files" }');
  return { target: positional[0], form };
}
export async function projectsCommand(rest, { home, homes = [home], env = process.env, cwd, json, readForm }) {
  const [action, ...args] = rest;
  const onePath = () => { if (args.length !== 1 || !args[0] || args[0].startsWith('--')) throw new Error(usageProjects); return resolve(cwd, args[0]); };
  switch (action) {
    case 'list': {
      // --registry-only：只读登记表（路径、名称），不对每个项目跑 git、不查目录，供"是否已登记"一类的核对用。
      const registryOnly = args.includes('--registry-only');
      if (args.some(a => a !== '--registry-only')) throw new Error(usageProjects);
      const projects = readProjects(home);
      if (registryOnly) return json ? { ok: true, projects } : projectListText(projects);
      const rows = json ? await mapLimit(projects, PROJECT_STATUS_CONCURRENCY, projectStatus) : projects;
      // git 版本全局算一次，放在顶层（不在每个项目里重复）；低于 2.40 时文字输出多一句提示。
      if (json) return { ok: true, projects: rows, git: gitVersion() };
      return withGitNote(projectListText(rows));
    }
    case 'add': {
      const allowNonGit = args.includes('--allow-non-git');
      const positional = args.filter(a => a !== '--allow-non-git');
      if (positional.length !== 1 || positional[0].startsWith('--')) throw new Error(usageProjects);
      const root = resolve(cwd, positional[0]);
      const projects = allowNonGit ? addProjectNonGit(home, root) : addProject(home, root);
      if (json) return { ok: true, projects };
      return projectListText(projects);
    }
    case 'remove': {
      const projects = removeProject(home, onePath());
      if (json) return { ok: true, projects };
      return projectListText(projects);
    }
    // 彻底清理已删除的项目（D44）：只在文件夹已不存在时可用，只清 AgentRouter 自己的记录；不改 runs.jsonl，不删任何用户文件。
    case 'purge': {
      const flags = ['--dry-run', '--worktrees'];
      const positional = args.filter(a => !flags.includes(a));
      if (positional.length !== 1 || !positional[0] || positional[0].startsWith('--')) throw new Error(usageProjects);
      const dryRun = args.includes('--dry-run'), withWorktrees = args.includes('--worktrees');
      const root = resolve(cwd, positional[0]);
      if (existsSync(root)) throw new Error('项目文件夹还在：只能从列表移除，AgentRouter 不删除项目文件');
      const listed = readProjects(home).some(p => same(p.path, root));
      const found = await projectLeftovers({ homes, env, repo: root, withDelete: !dryRun && withWorktrees });
      if (!listed && !found.tasks.length) throw new Error(`没有登记这个项目，任务清单里也没有它的任务：${root}`);
      if (dryRun) {
        const result = { ok: true, listed, tasks: found.tasks, worktrees: found.worktrees, slots: found.slots };
        return json ? result : `可以清理：项目列表 ${listed ? '1' : '0'} 项、任务 ${found.tasks.length} 个、worktree ${found.worktrees.length} 个、名额 ${found.slots.length} 个（--dry-run 只列出，没有删除）`;
      }
      if (listed) removeProject(home, root);
      const result = { ok: true, removed: listed, worktrees: found.removed.worktrees, slots: found.removed.slots, bytes: found.bytes, ...(found.errors.length ? { errors: found.errors } : {}) };
      return json ? result : `已彻底清理：${root}（worktree ${result.worktrees} 个、名额 ${result.slots} 个）`;
    }
    case 'clear': {
      if (args.length) throw new Error(usageProjects);
      const { removed } = clearProjects(home);
      if (json) return { ok: true, removed };
      return `已取消登记 ${removed} 个项目`;
    }
    case 'show': {
      if (args.length > 1 || args.some(a => a.startsWith('--'))) throw new Error(usageProjects);
      const root = resolve(cwd, args[0] ?? '.');
      const project = projectShow(home, root);
      if (json) return { ok: true, project, git: gitVersion() };
      return withGitNote(projectShowText(project));
    }
    case 'config': {
      const [target, ...assignments] = args;
      if (!target || target.startsWith('--')) throw new Error(usageProjects);
      const r = projectConfig(resolve(cwd, target), assignments);
      if (json) return { ok: true, config: r.config };
      return JSON.stringify(r.config, null, 2);
    }
    case 'git-init': {
      const root = onePath();
      if (!existsSync(root)) throw new Error(`文件夹不存在：${root}`);
      if (git(root, ['rev-parse', '--show-toplevel']).status === 0) throw new Error('已经是 git 仓库');
      const init = git(root, ['init', '-b', 'main']);
      if (init.status !== 0) throw new Error(`git init 失败：${tail(init.stderr)}`);
      if (json) return { ok: true, branch: 'main' };
      return '已初始化 git 仓库（分支 main）';
    }
    case 'commit-init': {
      const withExisting = args.includes('--with-existing');
      const positional = args.filter(a => a !== '--with-existing');
      if (positional.length !== 1 || !positional[0] || positional[0].startsWith('--')) throw new Error(usageProjects);
      const r = commitInit(resolve(cwd, positional[0]), withExisting);
      if (json) return { ok: true, commit: r.commit, files: r.files, ...(withExisting ? { withExisting: r.withExisting } : {}) };
      return `已提交 ${r.commit}：${r.files.join('、')}`;
    }
    case 'changes': {
      const files = projectChanges(onePath());
      if (json) return { ok: true, files };
      return files.length ? files.map(f => `  ${f.kind}  ${f.path}`).join('\n') : '没有未提交的改动';
    }
    case 'commit': {
      const { target, form } = await readCommitForm(args, readForm);
      const r = projectCommit(resolve(cwd, target), form);
      if (json) return { ok: true, commit: r.commit, files: r.files };
      return `已提交 ${r.commit}：${r.files.join('、')}`;
    }
    case 'git-identity': {
      const positional = [];
      let name, email, global = false;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--name' || arg === '--email') {
          if (i + 1 >= args.length) throw new Error(usageProjects);
          if (arg === '--name') name = args[++i]; else email = args[++i];
        }
        else if (arg === '--global') global = true;
        else if (arg.startsWith('--')) throw new Error(usageProjects);
        else positional.push(arg);
      }
      if (positional.length !== 1 || !positional[0] || name === undefined || email === undefined) throw new Error(usageProjects);
      const root = resolve(cwd, positional[0]);
      if (!readProjects(home).some(p => same(p.path, root))) throw new Error(`没有登记这个项目：${root}`);
      if (!gitTop(root)) throw new Error(`这个文件夹不是 git 仓库：${root}`);
      const identity = checkIdentityInput(name, email);
      const set = (key, value) => {
        const r = global ? gitGlobal(['config', '--global', key, value]) : git(root, ['config', key, value]);
        if (r.status !== 0) throw new Error(`git config 失败：${tail(r.stderr)}`);
      };
      set('user.name', identity.name);
      set('user.email', identity.email);
      const scope = global ? 'global' : 'repo';
      if (json) return { ok: true, identity, scope };
      return `已设置提交身份（${global ? '全局' : '这个项目'}）：${identity.name} <${identity.email}>`;
    }
    default: throw new Error(usageProjects);
  }
}
