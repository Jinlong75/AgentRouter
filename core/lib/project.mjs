// 跨项目复用：ar init 在任意 git 仓库生成项目配置与约定文件；projects.json 记录已添加的项目。
// 原则：已有文件不覆盖，只追加或替换带标记的 AgentRouter 段落；再次运行是幂等的。
import { traced, tracedAsync } from './trace.mjs';
import { mapLimit } from './limit.mjs';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseJson, readJson } from './json.mjs';
import { gitVersion, gitTooOldMessage, requireModernGit } from './git.mjs';

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
    initialized: exists && read(root, '.agent-router/project.json') !== null,
    config, configError,
    lastTask: lastTask(home, root) };
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
function commitInit(root) {
  root = resolve(root);
  if (!gitTop(root)) throw new Error(`这个文件夹不是 git 仓库：${root}`);
  const files = INIT_FILES.filter(rel => {
    const status = git(root, ['status', '--porcelain', '--', rel]);
    return status.status === 0 && status.stdout.trim() !== '';
  });
  if (!files.length) throw new Error('没有需要提交的初始化文件');
  requireGitIdentity(root);
  const add = git(root, ['add', '--', ...files]);
  if (add.status !== 0) throw new Error(`git add 失败：${tail(add.stderr)}`);
  const commit = git(root, ['commit', '-m', '[主导] 接入 AgentRouter', '--', ...files]);
  if (commit.status !== 0) throw new Error(`git commit 失败：${tail(commit.stderr)}`);
  const hash = git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();
  return { commit: hash, files };
}

const actionText = { create: '新建', update: '更新' };
// preview：新建文件为完整内容；更新文件为相对现有内容新增的部分（新内容以现有内容开头时取剩下的并去掉首尾空行）。
function previewOf(root, change) {
  if (change.action === 'create') return change.content;
  const existing = (read(root, change.path) ?? '').replaceAll('\r\n', '\n').trimEnd();
  return change.content.startsWith(existing) ? change.content.slice(existing.length).trim() : change.content;
}
export function initCommand(rest, { home, cwd, json }) {
  const dryRun = rest.includes('--dry-run'), positional = rest.filter(a => a !== '--dry-run');
  if (positional.length > 1 || positional.some(a => a.startsWith('--'))) throw new Error('用法：ar init [项目路径] [--dry-run]');
  const root = resolve(cwd, positional[0] ?? '.');
  requireModernGit('init');
  gitRoot(root);
  const base = detectBaseBranch(root);
  const plan = planInit(root, undefined, base);
  const changes = dryRun ? plan.map(({ path, action }) => ({ path, action })) : applyInit(root, plan, home);
  // 主分支只有这次要新建 project.json 时才有意义（已有的不改）；--dry-run 的计划里写出取到的值和来源。
  const baseInfo = dryRun && plan.some(p => p.path === '.agent-router/project.json') ? { name: base.name, step: base.step, source: base.source } : null;
  if (json) {
    // 只有 --dry-run 才带 content / preview 与 baseBranch；不加 --dry-run 的输出不变。
    const jsonChanges = dryRun ? plan.map(({ path, action, content }) => ({ path, action, content, preview: previewOf(root, { path, action, content }) })) : changes;
    return { ok: true, root, dryRun, changes: jsonChanges, registered: !dryRun, ...(baseInfo ? { baseBranch: baseInfo } : {}) };
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

const usageProjects = '用法：ar projects list [--registry-only] | add <路径> [--allow-non-git] | remove <路径> | clear | show [路径] | config <路径> [键=值 …] | git-init <路径> | commit-init <路径> | git-identity <路径> --name <用户名> --email <邮箱> [--global]';
// projects list --json 逐项目 git 核对的并发上限：最多同时 4 个 git 子进程，项目更少时只开项目数个。
const PROJECT_STATUS_CONCURRENCY = 4;
const projectListText = projects => projects.length ? ['已添加的项目：', ...projects.map(p => `  ${p.name}  ${p.path}`)].join('\n') : '还没有添加项目：在项目里运行 ar init，或 ar projects add <路径>';
const withGitNote = text => { const note = gitTooOldMessage('worktree'); return note ? `${text}\n${note}` : text; };
function projectShowText(p) {
  const lines = [`项目：${p.name}`, `  路径：${p.path}`, `  目录存在：${p.exists ? '是' : '否'}`, `  git 仓库：${p.git ? '是（分支 ' + p.branch + '）' : '否'}`];
  if (p.git) lines.push(`  未提交改动：${p.dirty} 项（不含 .agent-runs/）`);
  lines.push(`  已初始化：${p.initialized ? '是' : '否'}`);
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
export async function projectsCommand(rest, { home, cwd, json }) {
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
      const r = commitInit(onePath());
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
