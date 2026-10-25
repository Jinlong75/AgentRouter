// 通用适配器：按 config.json 里的声明（schema 见 core/lib/generic-schema.mjs）接入任意命令行执行者。
// makeGeneric(decl) 返回一个与其他适配器同形的对象；声明已由 validateGeneric 校验过，这里不重复校验。
// 声明的环境变量与密钥在 resolveProfile（adapters/index.mjs）里并入执行者配置，走 env.mjs 的 buildEnv / authOf。
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { launcherFor, findOnPath } from '../lib/launcher.mjs';
import { limitOutput } from '../lib/output.mjs';
import { getPath, placeholdersIn } from '../lib/generic-schema.mjs';
import { createMapper as createStreamMapper, relPath } from './claude-code.mjs';

// 参数总长上限（Windows 命令行上限 32767 字符，留出程序路径与引号的余量）。
const MAX_ARG_CHARS = 28000;
const PLACEHOLDER = /\{(prompt|promptFile|worktree|report|model|effort)\}/g;
const FILE_KINDS = ['add', 'update', 'delete'];

const unset = value => value == null || value === '';
const str = value => value == null ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
const num = value => { const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN; return Number.isFinite(n) ? n : null; };
const truthy = value => !(value == null || value === false || value === 0 || value === '' || value === 'false' || value === '0');

// 模板里含 {model} / {effort} 而值没设置：整项去掉；前面紧挨着 --model、-m 这类选项（以 - 开头、不含 {）一起去掉。
function dropUnset(template, values) {
  const out = [];
  for (const item of template) {
    if (placeholdersIn(item).some(name => (name === 'model' || name === 'effort') && unset(values[name]))) {
      const previous = out.at(-1);
      if (previous !== undefined && previous.startsWith('-') && !previous.includes('{')) out.pop();
      continue;
    }
    out.push(item);
  }
  return out;
}

const fill = (text, values) => text.replace(PLACEHOLDER, (_, name) => str(values[name]));

// .cmd / .bat 经 cmd.exe 运行：每个参数都加双引号；含双引号、百分号、换行的参数无法安全转义，直接拒绝。
// 结果整体再包一层引号交给 cmd /s /c，所以 spawn 要带 windowsVerbatimArguments（不让 Node 再转义一遍）。
function viaCmd(file, args, env, label) {
  for (const arg of args) if (/["%\r\n\0]/.test(arg)) throw new Error(`${label} 是批处理程序，参数里的双引号、百分号、换行无法安全传递：${arg.slice(0, 40)}`);
  const quote = text => `"${text.replace(/(\\+)$/, '$1$1')}"`;
  const line = [file, ...args].map(quote).join(' ');
  return { executable: env.ComSpec || process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

// 找程序：绝对路径直接用，否则在 PATH 里按 PATHEXT 查。返回 { executable, args } 或 { batch: 文件 }（.cmd / .bat 且不是 npm 的包装）。
function resolveLauncher(decl, env) {
  const name = decl.executable;
  const missing = `找不到 ${decl.label} 的程序：${name}。确认它在 PATH 里，或在声明的 executable 里写绝对路径。`;
  let file = name;
  if (!isAbsolute(name)) {
    const exts = process.platform === 'win32' ? String(env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [];
    const hasExt = exts.some(ext => name.toLowerCase().endsWith(ext.toLowerCase()));
    file = findOnPath(hasExt || !exts.length ? [name] : [...exts.map(ext => name + ext), name], env);
    if (!file) throw new Error(missing);
  }
  try {
    return launcherFor(file, { missing, unwrapError: found => { throw Object.assign(new Error('batch'), { batch: found }); } });
  } catch (error) {
    if (error.batch) return { batch: error.batch };
    throw error;
  }
}

function build(launcher, args, env, label) {
  return launcher.batch ? viaCmd(launcher.batch, args, env, label) : { executable: launcher.executable, args: [...launcher.args, ...args] };
}

// 取第一条 when 全部相等的规则；都不符合返回 null。
const matchRule = (rules, event) => rules.find(rule => Object.entries(rule.when ?? {}).every(([key, expected]) => getPath(event, key) === expected)) ?? null;

// 按规则把一行 JSON 转成统一事件（协议 3.1）；取不到关键字段时返回 null。
function toEvent(rule, e, root) {
  const get = spec => spec === undefined ? undefined : getPath(e, spec);
  switch (rule.kind) {
    case 'say': case 'think': case 'error': {
      const text = str(get(rule.text));
      return text ? { kind: rule.kind, text } : null;
    }
    case 'cmd': {
      const exit = num(get(rule.exit));
      const given = get(rule.phase);
      const phase = given === 'start' || given === 'end' ? given : exit != null ? 'end' : 'start';
      const event = { kind: 'cmd', id: str(get(rule.id)), phase, command: str(get(rule.command)) };
      if (phase === 'end') Object.assign(event, { exit }, limitOutput(str(get(rule.output))));
      return event;
    }
    case 'file': {
      const file = str(get(rule.path));
      if (!file) return null;
      const kind = str(get(rule.fileKind)).toLowerCase();
      return { kind: 'file', files: [{ kind: FILE_KINDS.includes(kind) ? kind : 'update', path: relPath(root, file) }] };
    }
    case 'plan': {
      const items = get(rule.items);
      return { kind: 'plan', items: (Array.isArray(items) ? items : []).map(item => ({
        text: rule.itemText !== undefined ? str(getPath(item, rule.itemText)) : str(item),
        done: rule.itemDone !== undefined && truthy(getPath(item, rule.itemDone)),
      })) };
    }
    case 'tool': return { kind: 'tool', name: str(get(rule.name)), detail: str(get(rule.detail)) };
    case 'turn': return { kind: 'turn', usage: { input: num(get(rule.input)), output: num(get(rule.outputTokens)) } };
    default: return null;
  }
}

// 失败的通用适配器：声明不存在或不合法时代替真适配器，command 抛出原因（执行者没能启动，不重试）。
export function brokenGeneric(profile, message) {
  return {
    id: 'generic',
    label: profile?.label ?? 'generic',
    writesReport: false,
    snapshotKeys: ['generic', 'genericDecl', 'genericError'],
    capabilities: { readOnly: false, usage: false, cost: false, reportFile: false },
    detect: () => ({ installed: false, version: null, error: message }),
    loginStatus: () => 'unknown',
    command() { throw new Error(message); },
    createMapper: () => createMapper_({ format: 'text' }),
    finish: () => null,
    modelName: ({ profile: p } = {}) => p?.model ?? null,
  };
}

function createMapper_(output) {
  if (output.format === 'stream-json') return createStreamMapper();
  if (output.format === 'jsonl') {
    const rules = output.map ?? [];
    return (line, { root } = {}) => {
      let e;
      try { e = JSON.parse(line); } catch { return line.trim() ? [{ kind: 'text', text: line }] : []; }
      const rule = matchRule(rules, e);
      if (!rule) return [];
      const event = toEvent(rule, e, root ?? process.cwd());
      return event ? [event] : [];
    };
  }
  return line => line.trim() ? [{ kind: 'text', text: line }] : [];
}

export function makeGeneric(decl, { name = null } = {}) {
  const label = decl.label;
  const format = decl.output?.format ?? 'text';
  const report = decl.report ?? (format === 'text' ? 'stdout' : 'lastSay');
  const pick = (a, b) => unset(a) ? (unset(b) ? null : b) : a;
  return {
    id: 'generic',
    label,
    writesReport: report === 'file',
    // 汇报取标准输出全文时，runner 要保留它（最多 256KB）。
    keepStdout: report === 'stdout',
    // 托管 / 脱离派发的请求带上声明（见 run.mjs 的 profileConfig），执行者进程不再读配置。
    snapshotKeys: ['generic', 'genericDecl', 'genericError'],
    capabilities: { readOnly: Array.isArray(decl.readOnlyArgs), usage: format !== 'text', cost: false, reportFile: report === 'file' },
    declaration: decl,
    declarationName: name,
    detect({ env = process.env } = {}) {
      try {
        const launcher = resolveLauncher(decl, env);
        const args = (decl.detect ?? ['--version']).map(item => fill(item, {}));
        const spec = build(launcher, args, env, label);
        const r = spawnSync(spec.executable, spec.args, { env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000, windowsVerbatimArguments: spec.verbatim === true });
        const first = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
        const installed = !r.error && r.status === 0;
        return { installed, version: installed ? first(r.stdout) ?? first(r.stderr) : null, launcher };
      } catch (error) { return { installed: false, version: null, error: error.message }; }
    },
    // 声明里没有登录检测的概念。
    loginStatus: () => 'unknown',
    command({ root, report: reportPath, prompt, settings = {}, detection, env = process.env, profile = {}, readOnly = false }) {
      let template = decl.args;
      if (readOnly) {
        if (!Array.isArray(decl.readOnlyArgs)) throw new Error(`${label} 不支持只读任务`);
        template = decl.readOnlyArgs;
      }
      const model = pick(settings.model, profile.model), effort = pick(settings.effort, profile.effort);
      const argTemplate = dropUnset(template, { model, effort });
      const stdinTemplate = typeof decl.stdin === 'string' ? decl.stdin : null;
      const used = new Set([...argTemplate, ...(stdinTemplate === null ? [] : [stdinTemplate])].flatMap(item => placeholdersIn(item)));
      const promptInArgs = argTemplate.some(item => placeholdersIn(item).includes('prompt'));
      const launcher = detection?.launcher ?? resolveLauncher(decl, env);
      if (launcher.batch && promptInArgs) {
        throw new Error(`${label} 是批处理程序，任务文字不能通过参数传递，请改用 stdin 或 {promptFile}`);
      }
      const promptFile = used.has('promptFile') ? join(tmpdir(), `ar-prompt-${randomBytes(8).toString('hex')}.txt`) : null;
      const values = { prompt, worktree: root, report: reportPath, model, effort, promptFile };
      const args = argTemplate.map(item => fill(item, values));
      if (promptInArgs && args.reduce((sum, arg) => sum + arg.length + 1, 0) > MAX_ARG_CHARS) {
        throw new Error('任务指令太长，无法通过命令行参数传递，请改用 stdin 或 {promptFile}');
      }
      const spec = build(launcher, args, env, label);
      // 临时文件最后才写：前面任何一步出错都不留下文件。UTF-8 无 BOM，只有创建者可读写。
      if (promptFile) writeFileSync(promptFile, prompt, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return {
        ...spec,
        ...(stdinTemplate === null ? {} : { stdin: fill(stdinTemplate, values) }),
        cleanup: promptFile ? [promptFile] : [],
      };
    },
    createMapper: () => createMapper_(decl.output ?? { format: 'text' }),
    mapLine: (line, ctx) => createMapper_(decl.output ?? { format: 'text' })(line, ctx),
    finish({ lastSay, result, stdoutText } = {}) {
      if (report === 'stdout') return stdoutText ? stdoutText : null;
      if (report === 'lastSay') return (format === 'stream-json' ? result ?? lastSay : lastSay) ?? null;
      return null;
    },
    failureHint(text) {
      const s = String(text ?? '');
      for (const hint of decl.failureHints ?? []) {
        try { if (new RegExp(hint.match, 'i').test(s)) return hint.text; } catch { /* 正则在校验时已检查，这里不会走到。 */ }
      }
      return null;
    },
    modelName({ profile } = {}) { return unset(profile?.model) ? null : profile.model; },
  };
}
