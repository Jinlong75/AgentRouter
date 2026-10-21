// 公开仓库快照：从指定提交里导出"运行、构建与测试所需"的文件集合。零依赖。
// 用法：node tools/public-snapshot.mjs <目标目录> [--ref <提交>] [--allow-new <项,...>]
//   退出码 0 = 可推送；1 = 失败（内容扫描、文档白名单、参数或环境问题）；3 = 差异里有需要用户批准的新增项（快照已写出）。
// 内容只取该提交里已跟踪的文件，不读工作区；不调用网络、不推送、不创建远端。
// 导出前对将要导出的每个文本文件做四类内容扫描（个人信息 / 本机路径 / 密钥格式 / 内部文档引用），任何命中即失败；
// 与 .agent-router/public-sync.jsonl 最后一条记录的私有提交做差异比较，新目录、新扩展名、新文档需要用户批准。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 允许清单：目录前缀（含 / 结尾）、整名文件、改名导出。每一项至少要匹配一个文件，否则报错（防止清单过期）。
export const ALLOW_DIRS = [
  'app/src/', 'app/design/icons/', 'core/', 'skills/', 'installer/', 'tools/', 'tests/', '.github/',
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
  'core/templates/roles/lead.md',
  'core/templates/roles/reviewer.md',
  'core/templates/roles/worker.md',
  'core/templates/spec.md',
  'skills/agent-router/SKILL.md',
  'skills/lead-workflow/SKILL.md',
  'tests/fixtures/README.md',
  'tests/fixtures/expected-progress.txt',
  'tests/fixtures/fake-agent.txt',
];
// 文档类扩展名（任务说明 C 节）
const DOC_EXTS = ['.md', '.markdown', '.rst', '.adoc', '.txt', '.pdf', '.docx', '.doc', '.odt'];
const isDocFile = file => DOC_EXTS.includes(path.posix.extname(file).toLowerCase());

const usage = '用法：node tools/public-snapshot.mjs <目标目录> [--ref <提交>] [--allow-new <项,...>]';

// 按提交树查询每个路径的 text/eol/binary 属性；-z 下输入输出都是 NUL 分隔的原始路径（不转义）。
function queryAttrs(root, sha, paths) {
  const child = spawnSync('git', ['check-attr', '-z', `--source=${sha}`, 'text', 'eol', 'binary', '--stdin'], {
    cwd: root, input: Buffer.from(`${paths.join('\0')}\0`, 'utf8'), maxBuffer: 1024 * 1024 * 16,
  });
  if (child.status !== 0) {
    throw Error(`读取 .gitattributes 换行规则失败（git 需要支持 check-attr --source，2.42 起提供）：${child.stderr}`);
  }
  // 每条记录是 "<路径>\0<属性>\0<值>\0"，值为 set / unset / unspecified，或属性的取值（如 lf、crlf）。
  const fields = child.stdout.toString('utf8').split('\0');
  const attrs = new Map();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [file, attr, value] = fields.slice(i, i + 3);
    if (!attrs.has(file)) attrs.set(file, {});
    attrs.get(file)[attr] = value;
  }
  return attrs;
}

// 统一转成 CRLF：先把已有的 \r\n 还原成 \n，避免出现 \r\r\n。用 latin1 往返，字节一一对应不丢内容。
const toCrlf = buffer => Buffer.from(buffer.toString('latin1').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'latin1');

// 列出提交里允许清单内的文件（out = 导出路径名）；validate 时附加"清单每项至少匹配一个文件"检查。
function listIncluded(root, sha, validate) {
  // 提交里的已跟踪文件：每条记录是 "<mode> <type> <oid>\t<path>"，以 NUL 结尾。
  const listing = execFileSync('git', ['ls-tree', '-r', '-z', sha], { cwd: root, encoding: 'buffer' }).toString('utf8');
  const entries = listing.split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    return { mode, type, oid, path: line.slice(tab + 1) };
  });
  // 允许清单筛选；改名项把输出路径换成新名字。
  const included = [], excluded = [];
  for (const entry of entries) {
    if (ALLOW_DIRS.some(dir => entry.path.startsWith(dir)) || ALLOW_FILES.includes(entry.path)) included.push({ ...entry, out: entry.path });
    else if (entry.path in ALLOW_RENAMES) included.push({ ...entry, out: ALLOW_RENAMES[entry.path] });
    else excluded.push(entry.path);
  }
  if (validate) {
    // 清单里每一项至少要匹配一个文件。
    const unmatched = [
      ...ALLOW_DIRS.filter(dir => !entries.some(e => e.path.startsWith(dir))),
      ...ALLOW_FILES.filter(name => !entries.some(e => e.path === name)),
      ...Object.keys(ALLOW_RENAMES).filter(name => !entries.some(e => e.path === name)),
    ];
    if (unmatched.length) throw Error(`允许清单里有项在 ${sha} 里匹配不到文件：${unmatched.join('、')}`);
  }
  return { entries, included, excluded };
}

// 一次 cat-file --batch 按对象读出全部内容，保持提交时的原始字节。
function readBlobs(root, included) {
  const child = spawnSync('git', ['cat-file', '--batch'], {
    cwd: root, input: `${included.map(e => e.oid).join('\n')}\n`, maxBuffer: 1024 * 1024 * 512,
  });
  if (child.status !== 0) throw Error(`读取文件内容失败：${child.stderr}`);
  const blobs = [], buffer = child.stdout;
  let offset = 0;
  for (const entry of included) {
    if (entry.mode === '120000') throw Error(`不支持符号链接：${entry.path}`);
    const newline = buffer.indexOf(0x0a, offset);
    const [name, type, sizeText] = buffer.toString('utf8', offset, newline).split(' ');
    if (type !== 'blob' || name !== entry.oid) throw Error(`读取文件内容失败：${entry.path}：${name} ${type}`);
    const size = Number(sizeText);
    blobs.push(buffer.subarray(newline + 1, newline + 1 + size));
    offset = newline + 1 + size + 1; // 内容后还有一个换行
  }
  return blobs;
}

// —— 内容扫描 ————————————————————————————————————————————————
// 私有词表：只从仓库根的 .agent-router/public-scan.json 读，读不到就失败（不静默跳过、不打印词表内容）。
function loadWordlist(root) {
  const rel = '.agent-router/public-scan.json';
  const file = path.join(root, rel);
  if (!existsSync(file)) throw Error(`读取私有词表失败：${rel} 不存在（不跳过扫描）`);
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

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 词表词一律用 *** 遮住后再输出。
const maskWords = (text, list) => {
  let out = text;
  for (const w of list) if (w) out = out.replace(new RegExp(escapeRe(w), 'gi'), '***');
  return out;
};

// 固定串全部拆开拼接：工具自己的源码也在导出集合里，源码中出现连续字面量会让工具扫描时命中自己。
const INTERNAL_REFS = [
  'CHECK' + 'POINT',
  'Master' + 'Plan',
  'Visual' + 'Spec',
  'docs' + '/plan/',
  'docs' + '/design.md',
  'docs' + '/requirements.md',
  'docs' + '/protocol.md',
];
// "任务说明 0NN"这种写法（模式串自身不含"任务说明 + 空格 + 数字"，不会自命中）。
const TASK_SPEC_RE = /任务说明\s*0\d{2}/g;
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

// 本仓库 docs/specs/ 下实际存在的任务说明（文件名去扩展名）：从提交的文件树里取，索引 README 与非编号文件不算。
const collectSpecStems = entries => entries
  .map(e => e.path.match(/^docs\/specs\/(.+)\.[^.]+$/))
  .filter(m => m && /^\d{3}-/.test(m[1]) && !m[1].includes('/'))
  .map(m => m[1]);

// 扫描一个文本文件，返回 { file, line, category, masked } 列表。
function scanText(file, text, words, specStems) {
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

// 上一公开版本：.agent-router/public-sync.jsonl 最后一行的 private；没有文件或没有记录 = 首次导出。
function loadPrevPrivate(root) {
  const rel = '.agent-router/public-sync.jsonl';
  const file = path.join(root, rel);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return null;
  let last;
  try { last = JSON.parse(lines[lines.length - 1]); }
  catch { throw Error(`读取 ${rel} 最后一行失败：不是有效 JSON`); }
  if (typeof last.private !== 'string' || !last.private) throw Error(`读取 ${rel} 最后一行失败：缺少 private 字段`);
  return last.private;
}

// 与上一公开版本的差异：按导出路径比较，blob oid 相同即未修改。
function buildDiff(prevIncluded, included) {
  const prevMap = new Map(prevIncluded.map(e => [e.out, e.oid]));
  const curMap = new Map(included.map(e => [e.out, e.oid]));
  return {
    added: [...curMap.keys()].filter(p => !prevMap.has(p)).sort(),
    removed: [...prevMap.keys()].filter(p => !curMap.has(p)).sort(),
    modified: [...curMap.keys()].filter(p => prevMap.has(p) && prevMap.get(p) !== curMap.get(p)).sort(),
  };
}

// 需要用户批准的新增项：新增目录（只取每个新增文件自顶向下最浅的一个，更深的目录必然也新）、
// 新增文件类型（扩展名在上一版里没出现过，无扩展名不计）、新增的文档类文件。
function approvalItems(added, prevPaths, prevExts) {
  const prevDirs = new Set();
  for (const p of prevPaths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) prevDirs.add(parts.slice(0, i).join('/'));
  }
  const items = [];
  const push = s => { if (!items.includes(s)) items.push(s); };
  for (const p of added) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!prevDirs.has(dir)) { push(`${dir}/`); break; }
    }
  }
  for (const p of added) {
    const ext = path.posix.extname(p);
    if (ext && !prevExts.has(ext)) push(ext);
  }
  for (const p of added) if (isDocFile(p)) push(p);
  return items;
}

export function exportSnapshot(root, target, ref = 'HEAD', allowNew = []) {
  // 目标目录必须不存在或为空，否则报错退出（不覆盖任何东西）。
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw Error(`目标已存在且不是目录：${target}`);
    if (readdirSync(target).length) throw Error(`目标目录非空：${target}`);
  }
  // 来源提交：解析成完整 SHA；引用不存在时直接失败。
  const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  const { entries, included, excluded } = listIncluded(root, sha, true);
  // 私有词表读不到就失败，不能静默跳过扫描。
  const words = loadWordlist(root);
  // 文档白名单（C）：不在 ALLOW_DOC_FILES 里的文档列出来，导出失败。
  const docViolations = included.filter(e => isDocFile(e.path) && !ALLOW_DOC_FILES.includes(e.path)).map(e => e.path);
  const docSet = new Set(docViolations);
  // 换行规则只来自该提交里的 .gitattributes（text/eol/binary），不在工具里写死：
  // 用 git check-attr --source 按提交树查询，嵌套的 .gitattributes 也由 git 自己合并。
  const attrs = queryAttrs(root, sha, included.map(e => e.path));
  const blobs = readBlobs(root, included);
  // 二进制判定与 022 一致：binary 属性、-text，或 text=auto 遇到含 NUL 的内容；二进制跳过文本扫描，仍参与差异清单。
  const binaryFlags = included.map((entry, index) => {
    const rule = attrs.get(entry.path) ?? {};
    return rule.binary === 'set' || rule.text === 'unset'
      || (rule.text === 'auto' && blobs[index].subarray(0, 8000).includes(0));
  });
  const specStems = collectSpecStems(entries);
  const hits = [], seen = new Set();
  for (const [index, entry] of included.entries()) {
    if (binaryFlags[index] || docSet.has(entry.path)) continue;
    for (const hit of scanText(entry.path, blobs[index].toString('utf8'), words, specStems)) {
      const key = `${hit.file}:${hit.line}:${hit.category}:${hit.masked}`;
      if (!seen.has(key)) { seen.add(key); hits.push(hit); }
    }
  }
  // 与上一公开版本比较（同一套导出规则在内存里取它的文件集合）。
  const prevRaw = loadPrevPrivate(root);
  let prevFull = null, diff = null, items = [];
  if (prevRaw) {
    try {
      prevFull = execFileSync('git', ['rev-parse', '--verify', `${prevRaw}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
    } catch {
      throw Error(`上一公开版本的私有提交无法解析：${String(prevRaw).slice(0, 12)}`);
    }
    const prevIncluded = listIncluded(root, prevFull, false).included;
    diff = buildDiff(prevIncluded, included);
    items = approvalItems(
      diff.added,
      prevIncluded.map(e => e.out),
      new Set(prevIncluded.map(e => path.posix.extname(e.out))),
    );
  }
  // --allow-new 必须与本次需要批准的新增项逐项对应（目录项比较时忽略结尾的 /），多一项少一项都报错。
  let allowed = false, mismatch = null;
  const norm = s => (s.endsWith('/') ? s.slice(0, -1) : s);
  if (items.length && allowNew.length) {
    const given = new Set(allowNew.map(norm));
    const wanted = new Set(items.map(norm));
    const missing = items.filter(it => !given.has(norm(it)));
    const extra = allowNew.filter(a => !wanted.has(norm(a)));
    if (missing.length || extra.length) mismatch = { missing, extra };
    else allowed = true;
  } else if (!items.length && allowNew.length) {
    mismatch = { missing: [], extra: allowNew.slice() };
  }
  // —— 输出（最终结论固定在最后一行）——
  const lines = [];
  lines.push(`来源提交：${sha}`);
  lines.push(`上一公开版本：${prevFull ?? '没有（首次导出）'}`);
  lines.push(`导出文件数：${included.length}`);
  lines.push(`排除文件数：${excluded.length}`);
  for (const { key, count } of summarizeExcluded(excluded, included.map(e => e.out))) lines.push(`${key} ${count}`);
  if (docViolations.length) lines.push(`文档白名单外（导出失败）：${docViolations.join('、')}`);
  const counts = { 个人信息: 0, 本机路径: 0, 密钥格式: 0, 内部文档引用: 0 };
  for (const h of hits) counts[h.category]++;
  lines.push(`扫描结果：个人信息 ${counts.个人信息}、本机路径 ${counts.本机路径}、密钥格式 ${counts.密钥格式}、内部文档引用 ${counts.内部文档引用}`);
  for (const h of hits) lines.push(`${h.file}:${h.line} ${h.category} ${h.masked}`);
  if (!prevFull) lines.push('差异清单：没有上一公开版本');
  else {
    lines.push(`差异清单：新增 ${diff.added.length}、删除 ${diff.removed.length}、修改 ${diff.modified.length}`);
    for (const [label, list] of [['新增', diff.added], ['删除', diff.removed], ['修改', diff.modified]]) {
      if (list.length) { lines.push(`${label}：`); for (const p of list) lines.push(`  ${p}`); }
    }
  }
  if (items.length) {
    lines.push(allowed ? '需要用户批准的新增项（已经用户批准放行）：' : '需要用户批准的新增项（尚需用户批准）：');
    for (const it of items) lines.push(`  ${it}`);
  }
  if (mismatch) {
    const parts = [];
    if (mismatch.missing.length) parts.push(`缺少 ${mismatch.missing.join('、')}`);
    if (mismatch.extra.length) parts.push(`多出 ${mismatch.extra.join('、')}`);
    lines.push(`--allow-new 与本次需要批准的新增项不一一对应：${parts.join('；')}`);
  }
  const code = docViolations.length || hits.length || mismatch ? 1 : items.length ? (allowed ? 0 : 3) : 0;
  // 校验与扫描都通过才创建目录并写文件；需要批准时快照仍写出（退出码 3），失败（退出码 1）不写。
  // 换行按 .gitattributes 的规则写出：eol=crlf 转成 CRLF；eol=lf 或未声明 eol 的文本按原字节；二进制逐字节原样。
  if (code !== 1) {
    mkdirSync(target, { recursive: true });
    for (const [index, entry] of included.entries()) {
      const bytes = !binaryFlags[index] && (attrs.get(entry.path) ?? {}).eol === 'crlf' ? toCrlf(blobs[index]) : blobs[index];
      const dest = path.join(target, ...entry.out.split('/'));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
    }
  }
  lines.push(`最终结论：${code === 0 ? '可推送' : code === 3 ? '需要用户批准' : '失败'}`);
  return { code, lines, sha, files: included.map(e => e.out), excluded, prevFull, hits, docViolations, diff, items, allowed };
}

// 排除汇总：顶层没有导出内容的按顶层目录 / 文件分组，顶层有导出内容的细分到下一级，不逐个打印。
export function summarizeExcluded(excluded, exported) {
  const tops = new Set(exported.map(f => f.split('/')[0]));
  const groups = new Map();
  for (const f of excluded) {
    const parts = f.split('/');
    const key = parts.length > 1 && tops.has(parts[0]) ? parts.slice(0, 2).join('/') : parts[0];
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, count]) => ({ key: excluded.some(f => f.startsWith(`${key}/`)) ? `${key}/` : key, count }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let target = null, ref = 'HEAD', allowNew = null;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--ref') { if (!args.length) { console.error(`--ref 缺少取值\n${usage}`); process.exit(1); } ref = args.shift(); }
    else if (arg === '--allow-new') {
      if (!args.length) { console.error(`--allow-new 缺少取值\n${usage}`); process.exit(1); }
      allowNew = args.shift().split(',').map(s => s.trim());
      if (allowNew.some(s => !s)) { console.error(`--allow-new 含空项\n${usage}`); process.exit(1); }
    }
    else if (!target) target = arg;
    else { console.error(`多余的参数：${arg}\n${usage}`); process.exit(1); }
  }
  if (!target) { console.error(usage); process.exit(1); }
  let result;
  try { result = exportSnapshot(process.cwd(), target, ref, allowNew ?? []); }
  catch (error) { console.error(error.message); process.exit(1); }
  for (const line of result.lines) console.log(line);
  process.exitCode = result.code;
}
