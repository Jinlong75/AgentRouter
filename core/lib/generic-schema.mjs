// 通用适配器（generic）声明 schema v1 的校验器。零依赖。
// 调用方：generic 适配器、ar agents validate / import、软件的"自定义 CLI"表单。

export const PLACEHOLDERS = ['prompt', 'promptFile', 'worktree', 'report', 'model', 'effort'];
export const KINDS = ['say', 'think', 'cmd', 'file', 'plan', 'tool', 'turn', 'error'];
export const REPORTS = ['stdout', 'lastSay', 'file'];

const TOP_FIELDS = [
  'label', 'executable', 'detect', 'args', 'readOnlyArgs', 'readOnlyEnv', 'stdin', 'env', 'secrets',
  'output', 'report', 'timeoutMin', 'failureHints',
];
// stream-json：Claude Code 风格的流式 JSON（Claude Code、Qoder 等兼容），由适配器内置映射，不需要 output.map。
const FORMATS = ['text', 'jsonl', 'stream-json'];
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_SUFFIX = /_(KEY|TOKEN|SECRET|PASSWORD)$/i;

// 每种 kind 允许的取值字段
const KIND_KEYS = {
  say: ['text'],
  think: ['text'],
  error: ['text'],
  cmd: ['text', 'id', 'phase', 'command', 'exit', 'output'],
  file: ['text', 'path', 'fileKind'],
  plan: ['text', 'items', 'itemText', 'itemDone'],
  tool: ['text', 'name', 'detail'],
  turn: ['text', 'input', 'outputTokens'],
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';

/** 字符串里出现的 {xxx}（含不认识的），按出现顺序去重。 */
export function placeholdersIn(text) {
  if (!isStr(text)) return [];
  const out = [];
  for (const m of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function literal(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (s.trim() !== '' && Number.isFinite(Number(s))) return Number(s);
  return s;
}

/** 映射规则的取值语法：点路径（支持数组下标）；`a|字面量` 在取不到时用字面量。 */
export function getPath(obj, spec) {
  if (!isStr(spec)) return undefined;
  const bar = spec.indexOf('|');
  const pathPart = bar >= 0 ? spec.slice(0, bar) : spec;
  let cur = obj;
  for (const seg of pathPart.split('.')) {
    if (cur === null || cur === undefined) { cur = undefined; break; }
    if (Array.isArray(cur)) {
      cur = /^\d+$/.test(seg) ? cur[Number(seg)] : undefined;
    } else if (typeof cur === 'object') {
      cur = Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : undefined;
    } else {
      cur = undefined;
    }
  }
  if (cur === undefined && bar >= 0) return literal(spec.slice(bar + 1));
  return cur;
}

export function validateGeneric(decl, { path = 'generic' } = {}) {
  const errors = [];
  const warnings = [];
  const err = (p, message) => errors.push({ path: p, message });
  const warn = (p, message) => warnings.push({ path: p, message });

  if (!isObj(decl)) {
    err(path, '通用适配器声明必须是一个 JSON 对象。');
    return { ok: false, errors, warnings };
  }

  for (const k of Object.keys(decl)) {
    if (!TOP_FIELDS.includes(k)) {
      err(`${path}.${k}`, `不认识的字段 "${k}"（可能拼错了）。允许的字段：${TOP_FIELDS.join('、')}。`);
    }
  }

  // label / executable
  if (decl.label === undefined) err(`${path}.label`, '缺少必填字段 label（显示名称）。');
  else if (!isStr(decl.label) || decl.label.trim() === '') err(`${path}.label`, 'label 必须是非空字符串。');
  if (decl.executable === undefined) err(`${path}.executable`, '缺少必填字段 executable（程序名或绝对路径）。');
  else if (!isStr(decl.executable) || decl.executable.trim() === '') err(`${path}.executable`, 'executable 必须是非空字符串。');

  // 字符串数组；返回是否有效
  const strArray = (key, required) => {
    const v = decl[key];
    if (v === undefined) {
      if (required) err(`${path}.${key}`, `缺少必填字段 ${key}（字符串数组，可以为空数组）。`);
      return false;
    }
    if (!Array.isArray(v)) { err(`${path}.${key}`, `${key} 必须是字符串数组。`); return false; }
    let ok = true;
    v.forEach((item, i) => {
      if (!isStr(item)) { err(`${path}.${key}[${i}]`, `${key}[${i}] 必须是字符串。`); ok = false; }
    });
    return ok;
  };
  const argsOk = strArray('args', true);
  const roPresent = decl.readOnlyArgs !== undefined;
  const roOk = strArray('readOnlyArgs', false);
  const detectOk = strArray('detect', false);

  if (decl.stdin !== undefined && decl.stdin !== null && !isStr(decl.stdin)) {
    err(`${path}.stdin`, 'stdin 必须是字符串或 null。');
  }
  const stdinStr = isStr(decl.stdin) ? decl.stdin : null;

  // 占位符
  const allowedText = PLACEHOLDERS.map((p) => `{${p}}`).join('、');
  const checkTemplate = (p, text) => {
    for (const name of placeholdersIn(text)) {
      if (!PLACEHOLDERS.includes(name)) {
        err(p, `未知占位符 {${name}}。允许的占位符：${allowedText}。`);
      }
    }
  };
  const templates = []; // 所有有效模板文本
  const scan = (key, ok) => {
    if (!ok || !Array.isArray(decl[key])) return;
    decl[key].forEach((item, i) => { checkTemplate(`${path}.${key}[${i}]`, item); templates.push(item); });
  };
  scan('args', argsOk);
  scan('readOnlyArgs', roOk);
  scan('detect', detectOk);
  if (stdinStr !== null) { checkTemplate(`${path}.stdin`, stdinStr); templates.push(stdinStr); }

  // 任务指令必须有去处
  const hasPrompt = (list) => list.some((t) => {
    const ph = placeholdersIn(t);
    return ph.includes('prompt') || ph.includes('promptFile');
  });
  const stdinList = stdinStr !== null ? [stdinStr] : [];
  if (argsOk && !hasPrompt([...decl.args, ...stdinList])) {
    err(`${path}.args`, 'args 和 stdin 里都没有 {prompt} 或 {promptFile}，任务指令没有传给执行者的地方。');
  }
  if (roPresent && roOk && !hasPrompt([...decl.readOnlyArgs, ...stdinList])) {
    err(`${path}.readOnlyArgs`, 'readOnlyArgs 和 stdin 里都没有 {prompt} 或 {promptFile}，只读任务的任务指令没有传给执行者的地方。');
  }

  // env / secrets
  // env 与 readOnlyEnv（只读任务额外设置的变量）同一套规则
  for (const field of ['env', 'readOnlyEnv']) {
    if (decl[field] === undefined) continue;
    if (!isObj(decl[field])) err(`${path}.${field}`, `${field} 必须是对象（变量名 → 字符串值）。`);
    else {
      for (const [k, v] of Object.entries(decl[field])) {
        if (!VAR_NAME.test(k)) err(`${path}.${field}.${k}`, `环境变量名 "${k}" 不合法，只能用字母、数字、下划线，且不能以数字开头。`);
        else if (SECRET_SUFFIX.test(k)) err(`${path}.${field}.${k}`, `"${k}" 看起来是密钥，请放进 secrets（${field} 里只存非机密的值）。`);
        if (!isStr(v)) err(`${path}.${field}.${k}`, `${field}.${k} 的值必须是字符串。`);
      }
    }
  }
  if (decl.secrets !== undefined) {
    if (!isObj(decl.secrets)) err(`${path}.secrets`, 'secrets 必须是对象（执行者看到的变量名 → 宿主环境变量名）。');
    else {
      for (const [k, v] of Object.entries(decl.secrets)) {
        if (!VAR_NAME.test(k)) err(`${path}.secrets.${k}`, `环境变量名 "${k}" 不合法，只能用字母、数字、下划线，且不能以数字开头。`);
        if (!isStr(v)) err(`${path}.secrets.${k}`, `secrets.${k} 的值必须是环境变量名（字符串）。`);
        else if (!VAR_NAME.test(v)) err(`${path}.secrets.${k}`, `secrets.${k} 的值不是合法的环境变量名。这里只写环境变量名，不写密钥本身。`);
        else if (/^sk-/.test(v) || (v.length > 40 && !/^[A-Z][A-Z0-9_]*$/.test(v))) {
          err(`${path}.secrets.${k}`, `secrets.${k} 的值像真实密钥。这里只写环境变量名，不写密钥本身。`);
        }
      }
    }
  }

  // output
  let format = null;
  if (decl.output === undefined) err(`${path}.output`, '缺少必填字段 output。');
  else if (!isObj(decl.output)) err(`${path}.output`, 'output 必须是对象。');
  else {
    const out = decl.output;
    if (out.format === undefined) err(`${path}.output.format`, '缺少必填字段 output.format（"text"、"jsonl" 或 "stream-json"）。');
    else if (!FORMATS.includes(out.format)) err(`${path}.output.format`, `output.format 必须是 "text"、"jsonl" 或 "stream-json"，现在是 ${JSON.stringify(out.format)}。`);
    else format = out.format;

    if (format === 'jsonl') {
      if (out.map === undefined) err(`${path}.output.map`, 'format 为 jsonl 时必须写 output.map（映射规则数组）。');
      else if (!Array.isArray(out.map)) err(`${path}.output.map`, 'output.map 必须是规则数组。');
      else if (out.map.length === 0) err(`${path}.output.map`, 'format 为 jsonl 时 output.map 不能为空，至少写一条规则。');
    } else if (format === 'text' && out.map !== undefined) {
      warn(`${path}.output.map`, 'format 为 text 时 output.map 不会被用到，可以删掉。');
    } else if (format === 'stream-json' && out.map !== undefined) {
      err(`${path}.output.map`, 'format 为 stream-json 时事件由内置映射处理，不能写 output.map。');
    }
    if (Array.isArray(out.map)) {
      out.map.forEach((rule, i) => validateRule(rule, `${path}.output.map[${i}]`, err));
    }
  }

  // report
  if (decl.report !== undefined) {
    if (!REPORTS.includes(decl.report)) err(`${path}.report`, `report 必须是 ${REPORTS.map((r) => `"${r}"`).join('、')} 之一，现在是 ${JSON.stringify(decl.report)}。`);
  }
  const usesReport = templates.some((t) => placeholdersIn(t).includes('report'));
  if (usesReport && decl.report !== 'file' ) {
    warn(`${path}.report`, '模板里用了 {report}，但 report 不是 "file"，执行者写的汇报文件不会被读取。');
  }
  if (decl.report === 'file' && !usesReport && argsOk) {
    warn(`${path}.report`, 'report 为 "file"，但所有模板里都没有 {report}，执行者不知道把汇报写到哪里。');
  }

  // timeoutMin
  if (decl.timeoutMin !== undefined && !(Number.isInteger(decl.timeoutMin) && decl.timeoutMin > 0)) {
    err(`${path}.timeoutMin`, 'timeoutMin 必须是正整数（分钟）。');
  }

  // failureHints
  if (decl.failureHints !== undefined) {
    if (!Array.isArray(decl.failureHints)) err(`${path}.failureHints`, 'failureHints 必须是 [{ match, text }] 数组。');
    else {
      decl.failureHints.forEach((h, i) => {
        const p = `${path}.failureHints[${i}]`;
        if (!isObj(h)) { err(p, 'failureHints 的每一项必须是 { match, text } 对象。'); return; }
        if (!isStr(h.match) || h.match === '') err(`${p}.match`, 'match 必须是非空字符串（正则表达式）。');
        else {
          try { new RegExp(h.match, 'i'); } catch (e) { err(`${p}.match`, `match 不是合法的正则表达式：${e.message}`); }
        }
        if (!isStr(h.text) || h.text.trim() === '') err(`${p}.text`, 'text 必须是非空字符串。');
        // kind（可选）：limit = 限流 / 额度用完，unavailable = 服务不可用 / 网络；命中时派发流程自动换执行者。
        if (h.kind !== undefined && h.kind !== 'limit' && h.kind !== 'unavailable') err(`${p}.kind`, `kind 只能是 "limit"（限流 / 额度用完）或 "unavailable"（服务不可用 / 网络），现在是 ${JSON.stringify(h.kind)}。`);
      });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateRule(rule, p, err) {
  if (!isObj(rule)) { err(p, '映射规则必须是对象。'); return; }

  if (rule.when !== undefined) {
    if (!isObj(rule.when)) err(`${p}.when`, 'when 必须是对象（点路径 → 字符串、数字、布尔或 null）。');
    else {
      for (const [k, v] of Object.entries(rule.when)) {
        if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
          err(`${p}.when.${k}`, `when.${k} 的值只能是字符串、数字、布尔或 null。`);
        }
      }
    }
  }

  if (rule.kind === undefined) { err(`${p}.kind`, `缺少必填字段 kind，可选：${KINDS.join('、')}。`); return; }
  if (!KINDS.includes(rule.kind)) { err(`${p}.kind`, `kind "${rule.kind}" 不认识，可选：${KINDS.join('、')}。`); return; }

  const allowed = KIND_KEYS[rule.kind];
  for (const k of Object.keys(rule)) {
    if (k === 'when' || k === 'kind') continue;
    if (!allowed.includes(k)) {
      err(`${p}.${k}`, `kind 为 ${rule.kind} 的规则不允许字段 "${k}"。允许的字段：when、kind、${allowed.join('、')}。`);
    } else if (!isStr(rule[k])) {
      err(`${p}.${k}`, `${k} 必须是字符串（取值语法，如 "item.text"）。`);
    }
  }

  const has = (k) => rule[k] !== undefined;
  const need = (ok, msg) => { if (!ok) err(p, `kind 为 ${rule.kind} 的规则${msg}`); };
  switch (rule.kind) {
    case 'say': case 'think': case 'error': need(has('text'), '必须有 text。'); break;
    case 'cmd': need(has('command') || has('id'), '必须有 command 或 id。'); break;
    case 'file': need(has('path'), '必须有 path。'); break;
    case 'plan': need(has('items'), '必须有 items。'); break;
    case 'tool': need(has('name'), '必须有 name。'); break;
    case 'turn': need(has('input') || has('outputTokens'), '至少要有 input 或 outputTokens 之一。'); break;
  }
}
