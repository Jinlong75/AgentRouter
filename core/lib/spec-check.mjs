import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { git } from './git.mjs';
import { parseSpec, validateSpec, mergeSpec } from './spec.mjs';

// 两个 glob 的交集是否非空；状态机沿用 glob.mjs 的 *, **, **/ 和 ? 语义。
function tokens(glob) {
  const out = [];
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { out.push('dirsStart', 'dirsBody'); i += 2; }
      else { out.push('any'); i++; }
    } else if (glob[i] === '*') out.push('star');
    else if (glob[i] === '?') out.push('char');
    else out.push({ literal: glob[i] });
  }
  return out;
}
function intersects(a, b) {
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  const x = tokens(a), y = tokens(b), seen = new Set(), queue = [[0, 0]];
  const eps = (t, i) => t[i] === 'dirsStart' ? [i + 2] : ['star', 'any'].includes(t[i]) ? [i + 1] : [];
  const moves = (t, i) => {
    const v = t[i];
    if (!v) return [];
    if (v === 'star') return [[i, 'non']];
    if (v === 'any') return [[i, 'all']];
    // dirs 可消耗任意前缀，但只有在斜线之后才能进入下一状态。
    if (v === 'dirsStart') return [[i + 1, 'all'], [i, '/']];
    if (v === 'dirsBody') return [[i, 'all'], [i - 1, '/']];
    if (v === 'char') return [[i + 1, 'non']];
    return [[i + 1, v.literal]];
  };
  const compatible = (u, v) => u === 'all' || v === 'all' || u === v || (u === 'non' && v !== '/') || (v === 'non' && u !== '/');
  while (queue.length) {
    const [i, j] = queue.pop(), key = `${i},${j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (i === x.length && j === y.length) return true;
    for (const n of eps(x, i)) queue.push([n, j]);
    for (const n of eps(y, j)) queue.push([i, n]);
    for (const [ni, c] of moves(x, i)) for (const [nj, d] of moves(y, j)) if (compatible(c, d)) queue.push([ni, nj]);
  }
  return false;
}

function commentLines(text, file) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/), errors = [];
  if (lines[0] !== '---') return errors;
  for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    const match = /^(?:[a-z_]+:|  -)\s*(.*)$/.exec(lines[i]);
    if (!match || !match[1] || match[1].startsWith('#')) continue;
    const value = match[1]; let quote = null, closed = false;
    for (let j = 0; j < value.length; j++) {
      const c = value[j];
      if (quote === '"') { if (c === '\\') j++; else if (c === '"') { quote = null; closed = true; } continue; }
      if (quote === "'") { if (c === "'" && value[j + 1] === "'") j++; else if (c === "'") { quote = null; closed = true; } continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '#' && j > 0 && /\s/.test(value[j - 1])) {
        if (!(closed && /^\s*$/.test(value.slice(0, j).replace(/^\s*(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*')/, '')))) errors.push({ code: 'SPEC_COMMENT', message: `${file} 第 ${i + 1} 行：值含未引用的 #，可能被截断，请加引号`, file, line: i + 1 });
        break;
      }
    }
  }
  return errors;
}

export function checkSpec({ root, specPath, project = {}, revision = null, baseOverride = null }) {
  const configErrors = [];
  for (const [key, valid] of [['fullExclusiveTimeoutMin', v => Number.isSafeInteger(v) && v > 0], ['specSplitWarning', v => typeof v === 'boolean']]) {
    if (Object.hasOwn(project, key) && !valid(project[key])) configErrors.push({ code: 'SPEC_CONFIG', message: `项目配置无效：${key}`, file: null, line: null });
  }
  const rel = relative(root, resolve(root, specPath)).split(sep).join('/');
  const read = name => {
    if (!revision) return readFileSync(resolve(root, name), 'utf8');
    const result = git(root, ['show', `${revision}:${name}`]);
    if (result.status !== 0) throw new Error(`读不到任务说明 ${name}：${result.stderr.trim()}`);
    return result.stdout;
  };
  const text = read(rel), errors = commentLines(text, specPath), warnings = [];
  function dependencies(source, file) {
    const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines[0] !== '---') return [];
    const end = lines.indexOf('---', 1);
    if (end < 0) throw new Error(`${file}：frontmatter 缺少结束的 ---`);
    let active = false;
    const filtered = lines.slice(0, end + 1).map((line, i) => {
      if (i === 0 || i === end) return line;
      if (/^depends:/.test(line)) { active = true; return line; }
      if (active && (/^  -/.test(line) || /^\s*(?:#.*)?$/.test(line))) return line;
      active = false; return '';
    }).join('\n');
    return validateSpec(parseSpec(filtered, file), file).depends ?? [];
  }
  let directDeps;
  try { directDeps = dependencies(text, specPath); }
  catch (error) { errors.push({ code: 'SPEC_DEPENDS', message: error.message, file: error.file ?? specPath, line: error.line ?? null }); return { ok: false, errors: [...errors, ...configErrors], warnings }; }
  let parsed, spec;
  try { parsed = parseSpec(text, specPath); spec = validateSpec(parsed, specPath); }
  catch (error) { if (errors.length || configErrors.length) return { ok: false, errors: [...errors, ...configErrors], warnings }; throw error; }
  warnings.push(...parsed.warnings.map(message => ({ code: 'SPEC_WARNING', message })));
  const merged = mergeSpec(spec, project);
  let names = [];
  if (revision) {
    const listing = git(root, ['ls-tree', '-z', '--name-only', revision, 'docs/specs/']);
    if (listing.status === 0) names = listing.stdout.split('\0').map(name => basename(name));
  } else { try { names = readdirSync(join(root, 'docs/specs')); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  const files = new Map();
  for (const name of names.sort()) { const m = /^(\d{3,}[a-z]?)-.*\.md$/.exec(name); if (m && !files.has(m[1])) files.set(m[1], `docs/specs/${name}`); }
  for (const id of directDeps) if (!files.has(id)) errors.push({ code: 'SPEC_DEPENDS', message: `任务说明依赖不存在：${id}`, file: null, line: null });
  const start = /^(\d{3,}[a-z]?)-/.exec(basename(rel))?.[1];
  const visiting = new Set(), visited = new Set(), stack = [];
  function visit(id) {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id) || !files.has(id)) return null;
    visiting.add(id); stack.push(id);
    let deps = [];
    try { deps = id === start ? directDeps : dependencies(read(files.get(id)), files.get(id)); }
    catch (error) { errors.push({ code: 'SPEC_DEPENDS', message: error.message, file: error.file ?? files.get(id), line: error.line ?? null }); }
    for (const dep of deps) { const cycle = visit(dep); if (cycle) return cycle; }
    stack.pop(); visiting.delete(id); visited.add(id); return null;
  }
  const cycle = start && visit(start);
  if (cycle) errors.push({ code: 'SPEC_DEPENDS_CYCLE', message: `任务说明依赖成环：${cycle.join(' → ')}`, file: null, line: null });
  if (revision) {
    const branch = git(root, ['branch', '--show-current']);
    const current = branch.status === 0 ? branch.stdout.trim() : '';
    if (!current) errors.push({ code: 'SPEC_BASE', message: '当前处于游离 HEAD；请指定有效本地分支', file: null, line: null });
    else if (!baseOverride && project.baseBranch && current !== project.baseBranch) errors.push({ code: 'SPEC_BASE', message: `当前分支是 ${current}，与项目基线 ${project.baseBranch} 不同；请显式指定 --base ${current}`, file: null, line: null, current, base: project.baseBranch });
  }
  const threshold = project.fullExclusiveTimeoutMin ?? 60;
  if ((project.exclusiveCommands ?? []).some(cmd => merged.verify.includes(cmd)) && merged.verify_timeout_min < threshold) errors.push({ code: 'SPEC_EXCLUSIVE_TIMEOUT', message: `全量独占验收时限不足：${merged.verify_timeout_min} 分钟，至少 ${threshold} 分钟`, file: null, line: null });
  if (project.specSplitWarning !== false && merged.allowed_paths.some(p => intersects(p, 'core/**')) && merged.allowed_paths.some(p => intersects(p, 'app/src/main/shots*.ts'))) warnings.push({ code: 'SPEC_SPLIT', message: '建议拆成核心与界面两份' });
  errors.push(...configErrors);
  return { ok: errors.length === 0, errors, warnings };
}

export function requireSpecCheck(result) {
  if (!result.ok) throw Object.assign(new Error(result.errors[0].message), { arCode: result.errors[0].code, specCheck: result });
  return result;
}
