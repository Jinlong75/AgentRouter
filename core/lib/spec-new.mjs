// ar spec：列出、读取、新建任务说明（新建任务页背后的核心命令）。
// 全部结果走 cli.mjs 的约定：--json 时输出 { ok:true, … }；失败抛中文错误（由 cli.mjs 转成 { ok:false, error }），
// 或直接返回 { ok:false, error, … }（spec new --commit 提交失败时文件保留）。
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireGitIdentity } from './project.mjs';
import { traced } from './trace.mjs';

const SPEC_TYPES = ['code', 'test', 'fix', 'research', 'docs'];
const MAX_BYTES = 256 * 1024;
const usageSpec = '用法：ar spec list <项目路径> | read <项目路径> <相对路径> | new <项目路径> [--dry-run] [--commit]';

// 从标准输入读完整内容（spec new 的表单 JSON），与 cli.mjs 里读密钥的 readSecretValue 互不影响。
export async function readSpecForm({ input = process.stdin } = {}) {
  input.setEncoding('utf8');
  let value = '';
  for await (const chunk of input) value += chunk;
  return value;
}

export async function specCommand(rest, { home, cwd, json, readForm = readSpecForm }) {
  const [sub, ...args] = rest;
  switch (sub) {
    case 'list': {
      if (args.length !== 1 || !args[0] || args[0].startsWith('--')) throw new Error(usageSpec);
      const root = resolve(cwd, args[0]);
      const dir = specsDirPath(root);
      const specs = listSpecs(root, dir, home);
      const text = specs.length
        ? [`任务说明（${dir}）：`, ...specs.map(s => `  ${s.rel}  ${s.title}${s.dispatched ? `（已派发 ${s.dispatched} 次）` : ''}`)].join('\n')
        : `还没有任务说明：${dir}`;
      return { result: { ok: true, dir, specs }, text };
    }
    case 'read': {
      if (args.length !== 2 || args.some(a => !a || a.startsWith('--'))) throw new Error(usageSpec);
      const root = resolve(cwd, args[0]);
      const rel = args[1];
      const content = readSpec(root, rel);
      return { result: { ok: true, rel, content }, text: content };
    }
    case 'new': {
      const dryRun = args.includes('--dry-run');
      const commit = args.includes('--commit');
      const positional = args.filter(a => !a.startsWith('--'));
      if (positional.length !== 1 || !positional[0]) throw new Error(usageSpec);
      const root = resolve(cwd, positional[0]);
      const form = parseForm(await readForm());
      const created = newSpec(root, form, { dryRun, commit, home });
      const text = created.ok
        ? `${dryRun ? '将创建' : '已创建'}任务说明 ${created.rel}${created.commit ? `（已提交 ${created.commit}）` : ''}`
        : `任务说明已写入但没有提交：${created.error}`;
      return { result: created, text, code: created.ok ? 0 : 1 };
    }
    default: throw new Error(usageSpec);
  }
}

// project.json 的 specsDir（没有时默认 docs/specs）；解析成项目根内的绝对路径。
function specsDirPath(root) {
  root = resolve(root);
  let specsDir = 'docs/specs';
  try {
    const config = JSON.parse(readFileSync(join(root, '.agent-router', 'project.json'), 'utf8'));
    if (typeof config.specsDir === 'string' && config.specsDir) specsDir = config.specsDir;
  } catch { /* 没有 project.json 或解析失败：用默认。 */ }
  const dir = resolve(root, specsDir);
  if (!isInside(root, dir)) throw new Error(`specsDir 必须在项目内：${specsDir}`);
  return dir;
}

const norm = p => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
function isInside(root, target) {
  const r = norm(root), t = norm(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

function listSpecs(root, dir, home) {
  let names = [];
  try { names = readdirSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rows = [];
  for (const file of names) {
    if (!file.endsWith('.md') || file === 'README.md') continue;
    const full = join(dir, file);
    let mtime;
    try { mtime = statSync(full).mtimeMs; } catch { continue; }
    const rel = relative(root, full).split(sep).join('/');
    rows.push({ file, rel, id: /^(\d{3})-/.exec(file)?.[1] ?? null, title: specTitle(full, file), mtime, dispatched: dispatchedCount(home, root, rel) });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

function specTitle(full, file) {
  let text;
  try { text = readFileSync(full, 'utf8'); } catch { return file; }
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end >= 0) {
      const m = /^title:\s*([^\r\n]*)$/m.exec(text.slice(3, end));
      if (m) return parseYamlScalar(m[1]);
    }
  }
  const heading = text.split(/\r?\n/).find(line => line.startsWith('# '));
  return heading ? heading.slice(2).trim() : file;
}

function parseYamlScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s; } }
  return s;
}

function dispatchedCount(home, root, rel) {
  try {
    const text = readFileSync(join(home, 'runs.jsonl'), 'utf8');
    let count = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row?.event === 'start' && typeof row.repo === 'string' && norm(row.repo) === norm(root) && row.spec === rel) count++;
    }
    return count;
  } catch { return 0; }
}

function readSpec(root, rel) {
  root = resolve(root);
  const abs = resolve(root, rel);
  if (!isInside(root, abs)) throw new Error('只能读取项目内的任务说明');
  if (!abs.toLowerCase().endsWith('.md')) throw new Error('只能读取 .md 文件');
  let text;
  try { text = readFileSync(abs, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`找不到文件：${rel}`); throw error; }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('文件超过 256 KB');
  return text;
}

function parseForm(input) {
  let form;
  try { form = JSON.parse(input); } catch { throw new Error('表单不是有效的 JSON'); }
  if (form === null || typeof form !== 'object' || Array.isArray(form)) throw new Error('表单不是有效的 JSON 对象');
  return form;
}

function newSpec(root, form, { dryRun, commit, home }) {
  root = resolve(root);
  const dir = specsDirPath(root);
  const title = typeof form.title === 'string' ? form.title.trim() : '';
  if (!title) throw new Error('请填写标题');
  const goal = typeof form.goal === 'string' ? form.goal.trim() : '';
  if (!goal) throw new Error('请填写目标');
  const type = form.type ?? 'code';
  if (!SPEC_TYPES.includes(type)) throw new Error('类型只能是 code、test、fix、research、docs');
  const fields = {
    title, goal, type,
    allowedPaths: stringArray(form.allowedPaths),
    verify: stringArray(form.verify),
    nonGoals: textField(form.nonGoals),
    refs: textField(form.refs),
    acceptance: textField(form.acceptance),
    questions: textField(form.questions),
    worker: typeof form.worker === 'string' && form.worker.trim() ? form.worker.trim() : 'auto',
  };
  const { id, file, content } = renderSpecFile(dir, fields, dryRun);
  const rel = relative(root, file).split(sep).join('/');
  if (dryRun) return { ok: true, file, rel, id, content };
  if (!commit) return { ok: true, file, rel, id, content };
  const committed = commitSpec(root, rel, id, title);
  return committed.ok ? { ok: true, file, rel, id, content, commit: committed.commit } : { ok: false, error: committed.error, ...(committed.code ? { code: committed.code } : {}), file, rel, id };
}

function stringArray(value) {
  const list = value ?? [];
  if (!Array.isArray(list) || list.some(item => typeof item !== 'string' || !item.trim() || /[\r\n]/.test(item))) {
    throw new Error('数组项必须是非空单行字符串');
  }
  return list;
}
function textField(value) { return typeof value === 'string' ? value : ''; }

// 编号取已有最大三位编号 + 1；独占创建（wx），同名已存在就换下一个编号重试，两个同时运行的 spec new 也不会撞号。
function renderSpecFile(dir, fields, dryRun) {
  let used = [];
  try { used = readdirSync(dir).filter(f => /^(\d{3})-/.test(f)).map(f => Number(f.slice(0, 3))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const max = used.length ? Math.max(...used) : 0;
  const slug = slugOf(fields.title);
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = String(max + 1 + attempt).padStart(3, '0');
    const file = join(dir, `${id}-${slug}.md`);
    const content = renderSpec(id, fields);
    if (dryRun) return { id, file, content };
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
      return { id, file, content };
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('任务说明编号冲突，连续重试 20 次仍失败');
}

function slugOf(title) {
  return title.replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

function renderSpec(id, f) {
  const fm = [
    '---',
    `id: ${id}`,
    `title: ${yamlScalar(f.title)}`,
    `type: ${f.type}`,
    `worker: ${f.worker}`,
    ...listBlock('allowed_paths', f.allowedPaths),
    ...listBlock('verify', f.verify),
    '---',
  ].join('\n');
  const parts = [
    ['目标', f.goal], ['不做什么', f.nonGoals], ['参照', f.refs], ['验收标准', f.acceptance], ['汇报要回答的问题', f.questions],
  ].map(([name, text]) => section(name, text)).filter(Boolean);
  const body = parts.join('\n\n');
  return `${fm}\n\n${body ? `${body}\n` : ''}`;
}

function listBlock(key, items) {
  return items.length ? [`${key}:`, ...items.map(item => `  - ${yamlScalar(item)}`)] : [`${key}: []`];
}

function section(name, text) {
  const value = String(text ?? '').trim();
  return value ? `## ${name}\n\n${value}` : '';
}

// 有 :、#、引号、反斜杠、控制字符、首尾空格或易被 YAML 误解的前缀时，用 JSON 风格双引号转义。
function yamlScalar(value) {
  const s = String(value);
  const needQuote = s === '' || s !== s.trim() || /[:#"'\u0000-\u001f\u007f\\]/.test(s)
    || /^(?:-|\?|:|,|\[|\]|\{|\}|#|&|\*|!|\||>|%|@|`)/.test(s)
    || /^(?:null|true|false|yes|no|on|off|~)$/i.test(s)
    || /^[-+]?(?:\d|\.\d)/.test(s) || /:\s|\s#/.test(s);
  return needQuote ? JSON.stringify(s) : s;
}

const tail = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-6).join('；');
function commitSpec(root, rel, id, title) {
  const git = args => traced(`git ${args.slice(0, 2).join(' ')}`, () => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true }));
  try { requireGitIdentity(root); }
  catch (error) { return { ok: false, error: error.message, code: error.arCode }; }
  const message = `[主导] 任务说明 ${id}：${title}`;
  const add = git(['add', '--', rel]);
  if (add.status !== 0) return { ok: false, error: `git add 失败：${tail(add.stderr)}` };
  const commit = git(['commit', '-m', message, '--', rel]);
  if (commit.status !== 0) return { ok: false, error: `git commit 失败：${tail(commit.stderr)}` };
  return { ok: true, commit: git(['rev-parse', '--short', 'HEAD']).stdout.trim() };
}
