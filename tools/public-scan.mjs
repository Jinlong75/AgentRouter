// 公开内容扫描：public-snapshot（导出时）与 lint-tree R8（提交前）共用。零依赖。
// 包含两部分：哪些路径会导出（允许清单与文档白名单），以及四类内容扫描（个人信息 / 本机路径 / 密钥格式 / 内部文档引用）。
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

// 允许清单：目录前缀（含 / 结尾）、整名文件、改名导出。每一项至少要匹配一个文件，否则报错（防止清单过期）。
export const ALLOW_DIRS = [
  'app/src/', 'app/design/icons/', 'core/', 'skills/agent-router/', 'skills/lead-workflow/',
  'installer/', 'tools/', 'tests/', '.github/',
];
export const ALLOW_FILES = [
  'app/design/tokens.css', 'package.json', 'package-lock.json', 'tsconfig.json',
  'electron-builder.config.cjs', '.gitattributes', '.gitignore', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
];
// 开发仓库自己的 README.md 与 README.public.md 都不按原名导出；公开版 README 以 README.public.md 为源。
export const ALLOW_RENAMES = { 'README.public.md': 'README.md' };
// 文档类白名单：文档扩展名的文件即使在允许目录里，也必须逐个列在这里才导出（按源路径判断）。
// README.public.md 是改名项，按改名前的源路径列入；THIRD_PARTY_NOTICES.md 是当前导出的文档。
export const ALLOW_DOC_FILES = [
  'THIRD_PARTY_NOTICES.md',
  'README.public.md',
  'core/adapters/README.md',
  'core/templates/agents-block.md',
  'core/templates/specs-README.md',
  'core/templates/review-prompt.md',
  'core/templates/roles/lead.md',
  'core/templates/roles/reviewer.md',
  'core/templates/roles/worker.md',
  'core/templates/spec.md',
  'skills/agent-router/SKILL.md',
  'skills/lead-workflow/SKILL.md',
  'tests/fixtures/README.md',
  'tests/fixtures/expected-progress.txt',
  'tests/fixtures/fake-agent.txt',
  'tests/fixtures/limits/README.md',
];
// 文档类扩展名
const DOC_EXTS = ['.md', '.markdown', '.rst', '.adoc', '.txt', '.pdf', '.docx', '.doc', '.odt'];
export const isDocFile = file => DOC_EXTS.includes(path.posix.extname(file).toLowerCase());

// 源路径会不会导出：返回导出路径名，不导出返回 null。
export function exportPathOf(file) {
  if (ALLOW_DIRS.some(dir => file.startsWith(dir)) || ALLOW_FILES.includes(file)) return file;
  if (file in ALLOW_RENAMES) return ALLOW_RENAMES[file];
  return null;
}

// 二进制判定：binary 属性、-text，或 text=auto 遇到含 NUL 的内容。
export const isBinaryByAttrs = (rule, bytes) => rule.binary === 'set' || rule.text === 'unset'
  || (rule.text === 'auto' && bytes.subarray(0, 8000).includes(0));

// —— 内容扫描 ————————————————————————————————————————————————
// 私有词表：从仓库根的 .agent-router/public-scan.json 读，不打印词表内容。
// 默认读不到就失败（不静默跳过）；optional 时文件不存在返回 null，文件存在但损坏仍然失败。
export function loadWordlist(root, { optional = false } = {}) {
  const rel = '.agent-router/public-scan.json';
  const file = path.join(root, rel);
  if (!existsSync(file)) {
    if (optional) return null;
    throw Error(`读取私有词表失败：${rel} 不存在（不跳过扫描）`);
  }
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw Error(`读取私有词表失败：${rel} 不是有效 JSON（不跳过扫描）`); }
  if (!Array.isArray(data?.personal) || !Array.isArray(data?.localPaths)) {
    throw Error(`读取私有词表失败：${rel} 缺少 personal / localPaths 数组（不跳过扫描）`);
  }
  const personal = data.personal.map(String).filter(Boolean);
  const localPaths = data.localPaths.map(String).filter(Boolean);
  return { personal, localPaths, all: [...personal, ...localPaths] };
}

// 没有词表时用的空词表
export const EMPTY_WORDS = { personal: [], localPaths: [], all: [] };

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 词表词一律用 *** 遮住后再输出。
export const maskWords = (text, list) => {
  let out = text;
  for (const w of list) if (w) out = out.replace(new RegExp(escapeRe(w), 'gi'), '***');
  return out;
};

// 固定串全部拆开拼接：工具自己的源码也在导出集合里，源码中出现连续字面量会让工具扫描时命中自己。
export const INTERNAL_REFS = [
  'CHECK' + 'POINT',
  'Master' + 'Plan',
  'Visual' + 'Spec',
  'docs' + '/plan/',
  'docs' + '/design.md',
  'docs' + '/requirements.md',
  'docs' + '/protocol.md',
];
// "任务说明 0NN"这种写法（模式串自身不含"任务说明 + 空格 + 数字"，不会自命中）。
export const TASK_SPEC_RE = /任务说明\s*0\d{2}/g;
// 常见个人邮箱域：按域名标签判断（gmail、qq、163、126、outlook、hotmail、yahoo、foxmail、icloud 等）。
const PERSONAL_EMAIL_LABELS = ['gmail', 'qq', '163', '126', 'outlook', 'hotmail', 'yahoo', 'foxmail', 'icloud'];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// 保留域与 noreply 地址不算个人信息（example.* 等保留域、含 noreply 的地址）。
const isExemptEmail = addr => {
  const at = addr.indexOf('@');
  const local = addr.slice(0, at).toLowerCase(), domain = addr.slice(at + 1).toLowerCase();
  if (local.includes('noreply') || domain.includes('noreply')) return true;
  return /^(.+\.)?example\.(com|org|net|invalid)$/.test(domain) || /\.(test|example|invalid|localhost)$/.test(domain);
};
const isPersonalEmail = addr => addr.slice(addr.indexOf('@') + 1).toLowerCase()
  .split('.').some(label => PERSONAL_EMAIL_LABELS.includes(label));
// 密钥格式：前缀后要 20 位以上才命中（不足 20 位的测试假值不误报，也不给扫描开后门）。
const KEY_RES = [
  /\b(?:sk|tp)-[A-Za-z0-9]{20,}/g,
  /(?:ghp_|gho_)[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /xox[abp]-[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
// 真实用户目录：与 tools/lint-tree.mjs R5 一致的占位（<、%）与例外（Public、Default、runner、runneradmin，大小写不敏感）。
// 每条的捕获组 1 是用户名，输出前遮成 ***；最后一条是 Windows 8.3 短名（XXXXXX~1 出现在 Users 之后）。
const USER_DIR_RES = [
  /[A-Za-z]:[\\/]Users[\\/](?!<|%|public\b|default\b|runner\b|runneradmin\b)([A-Za-z0-9._-]+)/gi,
  /\/Users\/(?!<|%|public\b|default\b|runner\b|runneradmin\b)([A-Za-z0-9._-]+)\//gi,
  /\/home\/(?!<|%|public\b|default\b|runner\b|runneradmin\b)([A-Za-z0-9._-]+)\//gi,
  /Users[\\/]([A-Za-z0-9._-]*~\d+)/gi,
];

// 本仓库 docs/specs/ 下实际存在的任务说明（文件名去扩展名）：从文件树里取，索引 README 与非编号文件不算。
// entries 的每一项带 path 字段。
export const collectSpecStems = entries => entries
  .map(e => e.path.match(/^docs\/specs\/(.+)\.[^.]+$/))
  .filter(m => m && /^\d{3,}-/.test(m[1]) && !m[1].includes('/'))
  .map(m => m[1]);

// 扫描一个文本文件，返回 { file, line, category, masked } 列表。
export function scanText(file, text, words, specStems) {
  // package-lock.json 只做密钥扫描：它的 author / license 等字段是上游依赖包自带的元数据声明，不是本仓库
  // 写入的内容，不算个人信息泄露；密钥格式仍然要扫（防止有人把密钥写进依赖元数据）。
  const cats = file === 'package-lock.json'
    ? ['密钥格式']
    : ['个人信息', '本机路径', '密钥格式', '内部文档引用'];
  const has = c => cats.includes(c);
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const lineNo = i + 1;
    const add = (category, masked) => hits.push({ file, line: lineNo, category, masked: maskWords(masked, words.all) });
    if (has('个人信息')) {
      for (const w of words.personal) if (line.toLowerCase().includes(w.toLowerCase())) add('个人信息', w);
      for (const m of line.matchAll(EMAIL_RE)) {
        if (!isExemptEmail(m[0]) && isPersonalEmail(m[0])) add('个人信息', m[0].replace(/^[^@]+/, '***'));
      }
    }
    if (has('本机路径')) {
      for (const w of words.localPaths) if (line.toLowerCase().includes(w.toLowerCase())) add('本机路径', w);
      for (const re of USER_DIR_RES) for (const m of line.matchAll(re)) add('本机路径', m[1] ? m[0].replace(m[1], '***') : m[0]);
    }
    if (has('密钥格式')) for (const re of KEY_RES) for (const m of line.matchAll(re)) add('密钥格式', '***');
    if (has('内部文档引用')) {
      for (const r of INTERNAL_REFS) if (line.includes(r)) add('内部文档引用', r);
      for (const s of specStems) if (line.includes(s)) add('内部文档引用', s);
      for (const m of line.matchAll(TASK_SPEC_RE)) add('内部文档引用', m[0]);
    }
  }
  return hits;
}

// 工作区扫描（lint-tree R8）：tracked 是 git ls-files 的路径列表，读工作区里的内容。
// 范围 = 会导出、不是白名单外文档、不是二进制的文本文件（二进制按 .gitattributes 判断，不带 --source）。
// 返回 { hits, wordlist: 'full' | 'none', error }；词表文件存在但损坏时 error 有值，不做扫描。
export function scanWorkspace(root, tracked) {
  let words;
  try { words = loadWordlist(root, { optional: true }); }
  catch (error) { return { hits: [], wordlist: 'broken', error: error.message }; }
  const scope = tracked.filter(f => exportPathOf(f) !== null && !(isDocFile(f) && !ALLOW_DOC_FILES.includes(f)));
  const present = scope.filter(f => {
    try { return lstatSync(path.join(root, f)).isFile(); } catch { return false; }
  });
  let attrs = new Map();
  if (present.length) {
    const child = spawnSync('git', ['check-attr', '-z', 'text', 'eol', 'binary', '--stdin'], {
      cwd: root, input: Buffer.from(`${present.join('\0')}\0`, 'utf8'), maxBuffer: 1024 * 1024 * 16,
    });
    if (child.status !== 0) return { hits: [], wordlist: words ? 'full' : 'none', error: `读取 .gitattributes 失败：${child.stderr}` };
    const fields = child.stdout.toString('utf8').split('\0');
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const [file, attr, value] = fields.slice(i, i + 3);
      if (!attrs.has(file)) attrs.set(file, {});
      attrs.get(file)[attr] = value;
    }
  }
  const specStems = collectSpecStems(tracked.map(p => ({ path: p })));
  const hits = [], seen = new Set();
  for (const file of present) {
    const bytes = readFileSync(path.join(root, file));
    if (isBinaryByAttrs(attrs.get(file) ?? {}, bytes)) continue;
    for (const hit of scanText(file, bytes.toString('utf8'), words ?? EMPTY_WORDS, specStems)) {
      const key = `${hit.file}:${hit.line}:${hit.category}:${hit.masked}`;
      if (!seen.has(key)) { seen.add(key); hits.push(hit); }
    }
  }
  return { hits, wordlist: words ? 'full' : 'none', error: null };
}
