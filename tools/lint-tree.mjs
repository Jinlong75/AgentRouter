// 目录整洁检查：仓库里只允许"有用途、编码正确、不泄露隐私"的文件。零依赖。
// 用法：node tools/lint-tree.mjs   退出码 0 = 通过，1 = 有问题
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { scanWorkspace } from './public-scan.mjs';

const root = process.cwd();
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const problems = [];
const report = (rule, file, detail = '') => problems.push({ rule, file, detail });
const read = f => readFileSync(path.join(root, f));

// R1 禁止跟踪的文件
const forbidden = [
  /(^|\/)node_modules\//, /(^|\/)\.agent-runs\//, /(^|\/)\.codex-runs\//,
  /(^|\/)(dist|out|release|build\/fonts|build\/icons)\//, /(^|\/)\.tmp\//,
  /\.log$/, /\.(bak|orig|tmp|swp)$/, /~$/, /(^|\/)\.env$/,
];
for (const f of tracked) if (forbidden.some(r => r.test(f))) report('R1 禁止跟踪', f);

// R2 编码与换行
const isText = f => /\.(m?js|cjs|m?ts|json|jsonl|md|css|html|svg|ya?ml|txt|cmd|bat|ps1|gitignore|gitattributes)$/i.test(f) || !path.extname(f);
const isCrlfFile = f => /\.(cmd|bat|ps1)$/i.test(f);
const texts = tracked.filter(f => isText(f) && existsSync(path.join(root, f)));
for (const f of texts) {
  const b = read(f);
  if (b.includes(0)) continue; // 无扩展名的二进制文件
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) report('R2 BOM', f);
  const s = b.toString('utf8');
  const hasCrlf = s.includes('\r\n'), hasBareLf = /(^|[^\r])\n/.test(s);
  if (isCrlfFile(f) ? hasBareLf : hasCrlf) report('R2 换行', f, isCrlfFile(f) ? '应为 CRLF' : '应为 LF');
}

// R3 孤立源文件：文件名（不含扩展名）至少在另一个已跟踪文本文件里出现一次
// 入口白名单以 tools/build.mjs 的 entryPoints 和 package.json 的脚本为准。
const entries = new Set([
  'app/src/main/index.ts', 'app/src/preload/index.ts', 'app/src/renderer/index.ts',
  'core/ar.mjs', 'installer/install.mjs', 'electron-builder.config.cjs',
]);
const sources = tracked.filter(f => /\.(m?js|cjs|ts)$/.test(f) && !/\.d\.ts$/.test(f));
const corpus = new Map(texts.map(f => [f, read(f).toString('utf8')]));
for (const f of sources) {
  if (entries.has(f) || /^tests\/.*\.test\.mjs$/.test(f)) continue;
  const stem = path.basename(f).replace(/\.(m?js|cjs|ts)$/, '');
  const used = [...corpus].some(([g, s]) => g !== f && new RegExp(`[\\\\/'"\`\\s]${stem}(\\.(m?js|cjs|ts))?['"\`\\s)]`).test(s));
  if (!used) report('R3 孤立源文件', f, '没有任何文件引用它');
}

// R4 Markdown 相对链接（代码块和行内代码里的示例不算链接）
const prose = s => s.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
for (const f of texts.filter(f => f.endsWith('.md'))) {
  for (const m of prose(corpus.get(f)).matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target)) continue;          // http:、mailto: 等
    const abs = path.resolve(root, path.dirname(f), decodeURI(target));
    if (!existsSync(abs)) report('R4 失效链接', f, target);
  }
}

// R5 隐私：真实用户目录（占位写法 <用户名> / %USERPROFILE% / $env:USERPROFILE 不算）
const privatePath = /([A-Za-z]:\\\\?Users\\\\?(?!<|%|Public\b|Default\b|runneradmin\b)[A-Za-z0-9._-]+)|(\/Users\/(?!<)[a-z0-9._-]+\/)|(\/home\/(?!<|runner\b)[a-z0-9._-]+\/)/;
for (const [f, s] of corpus) {
  const line = s.split('\n').findIndex(l => privatePath.test(l));
  if (line >= 0) report('R5 隐私路径', f, `第 ${line + 1} 行`);
}

// R6 禁用词（已删除功能的残留）；开发仓库里的方案与交接文档可以提及。
// 不再出现 DispatchDock 的回环标记配色（克莱因蓝）与旧字体别名。
const banned = [/devin/i, /docs\/internal\.md/, /现有的查看器/, /export-public/, /DispatchDock MiSans/, /#002FA7/i, /#6684FF/i];
// 内部文件的放行规则放在私有配置（不导出），由开发仓库自己维护；公开快照里没有这个文件，放行项为空
// （这些内部文件本来也不在快照里，检查结果不变）。格式：
// { "bannedAllowed": { "prefixes": ["目录/"], "files": ["文件"] },
//   "renamedAllowed": { "prefixes": ["目录/"], "files": ["文件"] } }
// 每一项按"完整文件名相等"或"路径前缀"匹配，不支持通配。
const internalAllowed = (() => {
  const file = path.join(root, '.agent-router/lint-internal.json');
  if (!existsSync(file)) return {};
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const normalize = rule => ({
    prefixes: Array.isArray(rule?.prefixes) ? rule.prefixes.map(String) : [],
    files: Array.isArray(rule?.files) ? rule.files.map(String) : [],
  });
  return { bannedAllowed: normalize(data?.bannedAllowed), renamedAllowed: normalize(data?.renamedAllowed) };
})();
const allowedIn = (rule, f) => !!rule && (rule.files.includes(f) || rule.prefixes.some(prefix => f.startsWith(prefix)));
const bannedAllowed = f => allowedIn(internalAllowed.bannedAllowed, f) || f === 'tools/lint-tree.mjs';
for (const [f, s] of corpus) {
  if (bannedAllowed(f)) continue;
  for (const r of banned) if (r.test(s)) report('R6 禁用词', f, String(r));
}
// Stage01 改名后的旧名称：只允许出现在兼容层、测试（兼容用例）、.gitignore，以及开发仓库内部文档（由私有配置放行）。
const renamed = [/codex-task/, /CODEX_DISPATCH_HOME/, /\.codex-runs/];
const renamedAllowed = f => bannedAllowed(f) || /^core\/lib\/compat\.(mjs|d\.mts)$/.test(f) || allowedIn(internalAllowed.renamedAllowed, f) || /^tests\//.test(f) || f === '.gitignore';
for (const [f, s] of corpus) {
  if (renamedAllowed(f)) continue;
  for (const r of renamed) if (r.test(s)) report('R6 旧名称', f, String(r));
}

// R7 颜色只来自令牌：渲染层样式文件里不得出现十六进制颜色字面量（令牌文件 app/design/tokens.css 除外）。
const hexColor = /#[0-9a-f]{3,8}\b/i;
for (const f of texts.filter(f => /^app\/src\/renderer\/.*\.css$/.test(f))) {
  const lines = corpus.get(f).split('\n'), at = lines.findIndex(l => hexColor.test(l.replace(/\/\*.*?\*\//g, '')));
  if (at >= 0) report('R7 令牌外颜色', f, `第 ${at + 1} 行：${lines[at].match(hexColor)[0]}`);
}

// R8 公开内容：会导出到公开仓库的已跟踪文本文件，做与 public:snapshot 相同的四类内容扫描（读工作区内容）。
// 没有私有词表（公开仓库里就没有）时只做不依赖词表的扫描，不算问题；词表文件损坏算问题。命中里的词表词已遮成 ***。
const scan = scanWorkspace(root, tracked);
if (scan.error) report('R8 公开内容', '.agent-router/public-scan.json', scan.error);
else if (scan.wordlist === 'none') console.log('R8：没有私有词表，个人词与本机路径词表的扫描跳过');
for (const h of scan.hits) report('R8 公开内容', h.file, `第 ${h.line} 行：${h.category} ${h.masked}`);

if (problems.length === 0) { console.log(`目录检查通过：${tracked.length} 个已跟踪文件`); process.exit(0); }
for (const p of problems) console.log(`${p.rule}  ${p.file}${p.detail ? '  ' + p.detail : ''}`);
console.log(`\n共 ${problems.length} 个问题`);
process.exit(1);
