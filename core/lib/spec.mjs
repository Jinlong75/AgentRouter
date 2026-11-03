// 任务说明 v1 的解析、校验与合并（文件协议第 11 节）。零依赖。
// 只导出 parseSpec、validateSpec、mergeSpec、SPEC_TYPES、SpecError。
export const SPEC_TYPES = ['code', 'test', 'fix', 'refactor', 'research', 'docs', 'review', 'chore'];

// 默认要求提交的类型（协议第 11.3 节）。
const COMMIT_TYPES = new Set(['code', 'test', 'fix', 'refactor']);
const KNOWN_FIELDS = new Set([
  'id', 'title', 'type', 'worker', 'allowed_paths', 'verify', 'expect_commit',
  'timeout_min', 'verify_timeout_min', 'max_retries', 'review', 'read_only',
  'effort', 'model', 'reviewer', 'review_block', 'depends', 'report_sections', 'mutations_required',
]);
const FIELD_NAME = /^[a-z_]+$/;

// 解析或校验不合规时抛出；line 是原文件里的行号（1 起），message 形如 "<文件> 第 <n> 行：<原因>"。
export class SpecError extends Error {
  constructor(file, line, reason) {
    super(`${file} 第 ${line} 行：${reason}`);
    this.name = 'SpecError';
    this.file = file;
    this.line = line;
    this.reason = reason;
  }
}

const show = value => (typeof value === 'string' ? value : JSON.stringify(value));

// 去掉引号外的行尾注释（空白后的 #）。引号没闭合时原样返回，交给值解析报错。
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (line[i + 1] === "'") i++;
        else quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

// 解析 frontmatter 与正文。没有 frontmatter 时 meta 为空、body 是原文（BOM 已去掉）。
export function parseSpec(text, file = '任务说明') {
  const source = typeof text === 'string' ? text : String(text ?? '');
  const clean = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const lines = clean.split(/\r?\n/);
  if (lines[0] !== '---') return { meta: {}, body: clean, lines: {}, warnings: [] };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end < 0) throw new SpecError(file, 1, 'frontmatter 缺少结束的 ---');

  const meta = {}, fieldLines = {}, warnings = [];
  // 用 defineProperty 写字段：字段名允许 __proto__ 这类名字，普通赋值会改掉原型。
  const setField = (key, value) => Object.defineProperty(meta, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
  let listKey = null;
  for (let i = 1; i < end; i++) {
    const lineNo = i + 1;
    const line = stripComment(lines[i]).replace(/[ \t]+$/, '');
    if (line.trim() === '') continue;

    const item = /^ {2}- (.*)$/.exec(line);
    if (item) {
      if (!listKey) throw new SpecError(file, lineNo, '列表项前面没有字段名');
      meta[listKey].push(parseValue(item[1], file, lineNo, { list: true }));
      continue;
    }
    if (/^ {2}-$/.test(line)) throw new SpecError(file, lineNo, '列表项为空（应写成"  - 项"）');

    const field = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (!field) throw new SpecError(file, lineNo, unrecognizedReason(line));
    const [, key, rawValue] = field;
    if (Object.hasOwn(meta, key)) throw new SpecError(file, lineNo, `字段重复：${key}`);
    fieldLines[key] = lineNo;
    if (!KNOWN_FIELDS.has(key)) warnings.push(`第 ${lineNo} 行：不认识的字段 ${key}（忽略）`);

    // 冒号后为空：空列表（后面可以跟若干 "  - 项"）。
    if (rawValue === undefined) {
      setField(key, []);
      listKey = key;
      continue;
    }
    const value = rawValue.trim();
    if (value === '[]') { setField(key, []); listKey = null; continue; }
    if (key === 'depends' && value.startsWith('[')) {
      try { setField(key, JSON.parse(value)); } catch { throw new SpecError(file, lineNo, 'depends 必须是任务编号的字符串数组'); }
      listKey = null; continue;
    }
    if (value.startsWith('[')) throw new SpecError(file, lineNo, '不支持内联数组（只有 [] 可以内联）');
    if (value.startsWith('{')) throw new SpecError(file, lineNo, '不支持内联对象');
    if (value.startsWith('|') || value.startsWith('>')) throw new SpecError(file, lineNo, '不支持多行字符串（| 或 >）');
    setField(key, parseValue(value, file, lineNo, { list: false }));
    listKey = null;
  }

  return { meta, body: lines.slice(end + 1).join('\n'), lines: fieldLines, warnings };
}

function unrecognizedReason(line) {
  const named = /^([^:]+):/.exec(line);
  if (named) {
    if (!FIELD_NAME.test(named[1])) return `无法识别的写法：字段名只能包含小写字母与下划线（${named[1]}）`;
    return '无法识别的写法：冒号后需要一个空格';
  }
  if (/^\s*- /.test(line)) return '无法识别的写法：列表项前面没有字段名';
  return `无法识别的写法：${line.trim()}`;
}

// 解析一个值：双引号按 JSON 字符串转义，单引号里 '' 表示一个单引号，true / false 是布尔，其余原样作字符串。
// 列表项一律按字符串处理（协议里列表就是字符串列表）。
function parseValue(raw, file, line, { list = false } = {}) {
  const value = raw.trim();
  if (value === '') throw new SpecError(file, line, '值不能为空');

  if (value[0] === '"') {
    let close = -1;
    for (let i = 1; i < value.length; i++) {
      if (value[i] === '\\') i++;
      else if (value[i] === '"') { close = i; break; }
    }
    if (close < 0) throw new SpecError(file, line, '引号没有闭合（双引号）');
    const rest = value.slice(close + 1).trim();
    if (rest) throw new SpecError(file, line, `引号后面还有内容：${rest}`);
    try { return JSON.parse(value.slice(0, close + 1)); }
    catch { throw new SpecError(file, line, '双引号字符串的转义无效（只支持 JSON 字符串转义）'); }
  }

  if (value[0] === "'") {
    let out = '', i = 1, closed = false;
    while (i < value.length) {
      const ch = value[i];
      if (ch === "'") {
        if (value[i + 1] === "'") { out += "'"; i += 2; continue; }
        closed = true; i += 1; break;
      }
      out += ch; i += 1;
    }
    if (!closed) throw new SpecError(file, line, '引号没有闭合（单引号）');
    const rest = value.slice(i).trim();
    if (rest) throw new SpecError(file, line, `引号后面还有内容：${rest}`);
    return out;
  }

  if (list) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

// 按协议第 11.2 节校验类型与取值；没写的字段为 undefined，整数字段转成 Number。
export function validateSpec(parsed, file = '任务说明') {
  const meta = parsed && typeof parsed === 'object' && parsed.meta ? parsed.meta : {};
  const parsedLines = parsed && typeof parsed === 'object' ? parsed.lines : null;
  const lineOf = key => {
    const n = parsedLines?.[key];
    return Number.isInteger(n) && n > 0 ? n : 1;
  };
  const has = key => Object.hasOwn(meta, key);
  const fail = (key, reason) => { throw new SpecError(file, lineOf(key), `${key} ${reason}`); };

  const asString = key => {
    const value = meta[key];
    if (typeof value !== 'string') fail(key, `必须是字符串（当前：${show(value)}）`);
    return value;
  };
  const asBoolean = key => {
    const value = meta[key];
    if (value !== true && value !== false) fail(key, `必须是 true 或 false（当前：${show(value)}）`);
    return value;
  };
  const asList = key => {
    const value = meta[key];
    if (!Array.isArray(value)) fail(key, `必须是字符串列表（当前：${show(value)}）`);
    for (const item of value) if (typeof item !== 'string') fail(key, '每项必须是字符串');
    return value.slice();
  };
  const asInteger = (key, min) => {
    const value = meta[key];
    let number;
    if (typeof value === 'number') number = value;
    else if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) number = Number(value);
    else fail(key, `必须是${min === 1 ? '正' : '非负'}整数（当前：${show(value)}）`);
    if (!Number.isSafeInteger(number) || number < min) fail(key, `必须是${min === 1 ? '正' : '非负'}整数（当前：${show(value)}）`);
    return number;
  };

  const spec = {
    id: undefined, title: undefined, type: undefined, worker: undefined,
    allowed_paths: undefined, verify: undefined, expect_commit: undefined,
    timeout_min: undefined, verify_timeout_min: undefined, max_retries: undefined, review: undefined, read_only: undefined,
    effort: undefined, model: undefined, reviewer: undefined, review_block: undefined,
  };
  if (has('id')) spec.id = asString('id');
  if (has('title')) spec.title = asString('title');
  if (has('type')) {
    const value = meta.type;
    if (typeof value !== 'string' || !SPEC_TYPES.includes(value)) {
      fail('type', `只能是 ${SPEC_TYPES.join('、')}（当前：${show(value)}）`);
    }
    spec.type = value;
  }
  if (has('worker')) spec.worker = asString('worker');
  if (has('depends')) {
    if (!Array.isArray(meta.depends) || !meta.depends.length || meta.depends.some(item => typeof item !== 'string' || !item.trim())) fail('depends', '必须是任务编号的字符串数组');
    spec.depends = meta.depends.slice();
  }
  if (has('report_sections')) {
    if (!Array.isArray(meta.report_sections) || meta.report_sections.some(x => typeof x !== 'string' || !x.trim())) fail('report_sections', '必须是非空字符串数组');
    spec.report_sections = meta.report_sections.slice();
  }
  if (has('allowed_paths')) {
    spec.allowed_paths = asList('allowed_paths');
    spec.allowed_paths.forEach((item, index) => checkAllowedPath(item, index, fail));
  }
  if (has('verify')) {
    spec.verify = asList('verify');
    spec.verify.forEach((item, index) => {
      if (item.trim() === '') fail('verify', `第 ${index + 1} 条不能为空`);
    });
  }
  if (has('expect_commit')) spec.expect_commit = asBoolean('expect_commit');
  if (has('timeout_min')) spec.timeout_min = asInteger('timeout_min', 1);
  if (has('verify_timeout_min')) spec.verify_timeout_min = asInteger('verify_timeout_min', 1);
  if (has('mutations_required')) spec.mutations_required = asInteger('mutations_required', 0);
  if (has('max_retries')) spec.max_retries = asInteger('max_retries', 0);
  if (has('review')) spec.review = asBoolean('review');
  if (has('read_only')) spec.read_only = asBoolean('read_only');
  // effort / model（Stage07c T6）：可选，非空字符串；取值是否被执行者支持由派发时检查，这里只管类型。
  for (const key of ['effort', 'model']) {
    if (!has(key)) continue;
    spec[key] = asString(key);
    if (spec[key].trim() === '') fail(key, '不能为空');
    spec[key] = spec[key].trim();
  }
  // reviewer（审查者执行者配置名，非空字符串）与 review_block（none | high，Stage08 T3）：这里只管类型，reviewer 是否存在、可用由审查时检查。
  if (has('reviewer')) {
    spec.reviewer = asString('reviewer').trim();
    if (spec.reviewer === '') fail('reviewer', '不能为空');
  }
  if (has('review_block')) {
    const value = meta.review_block;
    if (value !== 'none' && value !== 'high') fail('review_block', `只能是 none 或 high（当前：${show(value)}）`);
    spec.review_block = value;
  }
  if (spec.type === 'chore' && spec.review === undefined) spec.review = false;
  return spec;
}

// 允许路径的写法校验（协议第 11.5 节）：相对、/ 分隔、无 \、不以 / 或盘符开头、无 . 或 .. 段、非空。
export function checkAllowedPath(item, index, fail) {
  const n = index + 1;
  if (item.trim() === '') fail('allowed_paths', `第 ${n} 项不能为空`);
  if (item.includes('\\')) fail('allowed_paths', `第 ${n} 项不能包含反斜杠（路径用 / 分隔）`);
  if (item.startsWith('/')) fail('allowed_paths', `第 ${n} 项必须是相对路径（不能以 / 开头）`);
  // 盘符只认 X:\、X:/ 和整项正好是 X:（协议第 11 节"写法校验"）；
  // a:b 这类 X:相对路径按普通路径模式处理。
  if (/^[A-Za-z]:(?:[\\/]|$)/.test(item)) fail('allowed_paths', `第 ${n} 项不能带盘符`);
  if (item.split('/').some(segment => segment === '.' || segment === '..')) {
    fail('allowed_paths', `第 ${n} 项不能包含 . 或 .. 段`);
  }
}

// 按协议第 11.3 节合并：任务说明 > 项目配置 > 内置默认；allowed_paths 不与项目配置合并。
// max_retries 的合并见 14.1（只对用任务说明派发的任务有意义）。
// gate 为真表示派发后要跑门禁（协议第 11.4 节的三个条件任一条成立）。
export function mergeSpec(spec = {}, project = {}) {
  const source = spec ?? {};
  const config = source.type === 'chore' ? { ...(project ?? {}), verify: [], allowedPaths: ['**'] } : (project ?? {});
  const nonEmpty = value => Array.isArray(value) && value.length > 0;

  const allowed_paths = nonEmpty(source.allowed_paths)
    ? source.allowed_paths.slice()
    : nonEmpty(config.allowedPaths) ? config.allowedPaths.slice() : ['**'];
  const verify = nonEmpty(source.verify)
    ? source.verify.slice()
    : nonEmpty(config.verify) ? config.verify.slice() : [];
  const expect_commit = typeof source.expect_commit === 'boolean'
    ? source.expect_commit
    : COMMIT_TYPES.has(source.type);
  const timeout_min = source.timeout_min ?? 60;
  // verify_timeout_min：任务说明写了就用；否则取项目配置 verifyTimeoutMin（必须是正整数，
  // 不是——0、负数、小数、字符串、null——就当作没写），再落到内置默认 10（协议 11.3）。
  const projectVerifyTimeout = Number.isSafeInteger(config.verifyTimeoutMin) && config.verifyTimeoutMin > 0
    ? config.verifyTimeoutMin : undefined;
  const verify_timeout_min = source.verify_timeout_min ?? projectVerifyTimeout ?? 10;
  // max_retries：任务说明写了就用；否则取项目配置 maxRetries（必须是非负整数，
  // 不是——负数、小数、字符串、null——就当作没写），再落到内置默认 2（协议 14.1）。
  const projectMaxRetries = Number.isSafeInteger(config.maxRetries) && config.maxRetries >= 0
    ? config.maxRetries : undefined;
  const max_retries = source.max_retries ?? projectMaxRetries ?? 2;
  const gate = verify.length > 0
    || !(allowed_paths.length === 1 && allowed_paths[0] === '**')
    || expect_commit === true;

  return { allowed_paths, verify, expect_commit, timeout_min, verify_timeout_min, max_retries, gate };
}

// 项目必填规则只接受非空字符串数组，缺省时不启用。
export function validateRequiredConfig(project = {}) {
  for (const name of ['specRequired', 'reportRequired']) {
    if (!Object.hasOwn(project, name)) continue;
    const rule = project[name];
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).some(k => !(name === 'specRequired' ? ['fields', 'sections', 'types'] : ['sections', 'types']).includes(k))) throw new Error(`项目配置无效：${name}`);
    for (const value of Object.values(rule)) if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x.trim())) throw new Error(`项目配置无效：${name}`);
  }
}
export function sectionHasContent(lines) {
  return !/^(?:|(?:无|没有)[。]?)$/.test(lines.join('').replace(/\s/g, ''));
}
export function missingContentSections(text, sections = []) {
  const bodies = new Map(sections.map(name => [name, []]));
  let active = null, fence = null;
  for (const line of String(text).split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; if (active) active.push(line); continue; }
    if (fence) { if (active) active.push(line); continue; }
    const heading = line.match(/^#{1,2}\s+(.+?)\s*$/);
    if (heading) { active = /^##\s/.test(line) && bodies.has(heading[1]) ? [] : null; if (active) bodies.get(heading[1]).push(active); }
    else if (active) active.push(line);
  }
  return sections.filter(name => !bodies.get(name).some(sectionHasContent));
}
export function missingSections(text, sections = []) {
  const headings = String(text).split(/\r?\n/).filter(line => /^\s*#{1,6}\s+/.test(line));
  return sections.filter(section => !headings.some(line => line.includes(section)));
}
export function requiredApplies(rule, type) { return !!rule && (!rule.types || rule.types.includes(type)); }
export function missingSpecRequired(parsed, rule) {
  if (!requiredApplies(rule, parsed.meta.type)) return { fields: [], sections: [] };
  return { fields: (rule.fields ?? []).filter(key => { const v = parsed.meta[key]; return v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length); }), sections: missingSections(parsed.body, rule.sections) };
}
