// 公开仓库快照：从指定提交里导出"运行、构建与测试所需"的文件集合。零依赖。
// 用法：node tools/public-snapshot.mjs <目标目录> [--ref <提交>]   退出码 0 = 成功，1 = 有问题
// 内容只取该提交里已跟踪的文件，不读工作区；不调用网络、不推送、不创建远端。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
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

const usage = '用法：node tools/public-snapshot.mjs <目标目录> [--ref <提交>]';

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

export function exportSnapshot(root, target, ref = 'HEAD') {
  // 目标目录必须不存在或为空，否则报错退出（不覆盖任何东西）。
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw Error(`目标已存在且不是目录：${target}`);
    if (readdirSync(target).length) throw Error(`目标目录非空：${target}`);
  }
  // 来源提交：解析成完整 SHA；引用不存在时直接失败。
  const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
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
  // 清单里每一项至少要匹配一个文件。
  const unmatched = [
    ...ALLOW_DIRS.filter(dir => !entries.some(e => e.path.startsWith(dir))),
    ...ALLOW_FILES.filter(name => !entries.some(e => e.path === name)),
    ...Object.keys(ALLOW_RENAMES).filter(name => !entries.some(e => e.path === name)),
  ];
  if (unmatched.length) throw Error(`允许清单里有项在 ${sha} 里匹配不到文件：${unmatched.join('、')}`);
  // 换行规则只来自该提交里的 .gitattributes（text/eol/binary），不在工具里写死：
  // 用 git check-attr --source 按提交树查询，嵌套的 .gitattributes 也由 git 自己合并。
  const attrs = queryAttrs(root, sha, included.map(e => e.path));
  // 一次 cat-file --batch 按对象读出全部内容，保持提交时的原始字节。
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
  // 校验都通过了才创建目录并写文件。换行按 .gitattributes 的规则写出，使快照与 git clone 后的工作区逐字节一致：
  // eol=crlf 转成 CRLF；eol=lf 或未声明 eol 的文本按原字节写出（入库时已按 text 规范化为 LF）；
  // 二进制（binary 属性、-text，或 text=auto 遇到含 NUL 的内容）逐字节原样。
  mkdirSync(target, { recursive: true });
  for (const [index, entry] of included.entries()) {
    const rule = attrs.get(entry.path) ?? {};
    const binary = rule.binary === 'set' || rule.text === 'unset'
      || (rule.text === 'auto' && blobs[index].subarray(0, 8000).includes(0));
    const bytes = !binary && rule.eol === 'crlf' ? toCrlf(blobs[index]) : blobs[index];
    const dest = path.join(target, ...entry.out.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }
  return { sha, files: included.map(e => e.out), excluded };
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
  let target = null, ref = 'HEAD';
  while (args.length) {
    const arg = args.shift();
    if (arg === '--ref') { if (!args.length) { console.error(`--ref 缺少取值\n${usage}`); process.exit(1); } ref = args.shift(); }
    else if (!target) target = arg;
    else { console.error(`多余的参数：${arg}\n${usage}`); process.exit(1); }
  }
  if (!target) { console.error(usage); process.exit(1); }
  let result;
  try { result = exportSnapshot(process.cwd(), target, ref); }
  catch (error) { console.error(error.message); process.exit(1); }
  console.log(`来源提交：${result.sha}`);
  console.log(`导出文件数：${result.files.length}`);
  console.log(`排除文件数：${result.excluded.length}`);
  for (const { key, count } of summarizeExcluded(result.excluded, result.files)) console.log(`${key} ${count}`);
}
