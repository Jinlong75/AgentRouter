// Claude Code 适配器：以非交互模式（-p --output-format stream-json）启动 Claude Code CLI，把它的事件映射为统一事件。
// 不绑定任何模型或服务商：用哪个后端（兼容接口的第三方服务、Claude 官方……）完全由 profile 的 env / secrets 决定（D17、O10）。
// 事件结构以 Claude Code 2.1.302 的真实输出为准（tests/fixtures/claude-code-sample.jsonl）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { launcherFor as resolveFile, findOnPath } from '../lib/launcher.mjs';
import { limitOutput } from '../lib/output.mjs';
import { testAgent } from '../lib/compat.mjs';
import { trace, traced } from '../lib/trace.mjs';

// 追踪里子进程的结束状态：区分正常结束、被超时上限截断（ETIMEDOUT）与启动失败（只在 ar agents list 传入 tracePrefix 时使用）。
const subprocessOutcome = r => r.error
  ? (r.error.code === 'ETIMEDOUT' ? 'timeout' : `error=${r.error.code ?? 'unknown'}`)
  : r.signal ? `signal=${r.signal}` : `status=${r.status}`;

// 本版本在 Windows 上用 PowerShell 工具运行命令，其他版本或平台可能是 Bash：两者都当命令。
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
// 只读：--tools 是可用工具的白名单，新版本新增的工具自动不在其中；dontAsk 让未预先允许的操作直接被拒绝、不等确认。
export const READONLY_TOOLS = 'Read,Grep,Glob,WebSearch,WebFetch';
// 清除主导会话传下来的 Claude Code / Anthropic 变量：按前缀清，新版本新增的会话变量（消息通道令牌等）也不会传给执行者。
export const CLEAR = [/^ANTHROPIC_/i, /^CLAUDE_/i, /^CLAUDECODE$/i];

const missing = '找不到 Claude Code CLI。确认 claude --version 能运行；非标准安装可在 config.json 的执行者配置里写 path（claude.exe 或 claude.cmd 的绝对路径）。';
const launcherFor = file => resolveFile(file, { missing, unwrapError: file => `无法解析 Claude Code 的启动包装：${file}。可在执行者配置的 path 里写 claude.exe 的绝对路径。` });
export function resolveLauncher(env = process.env, platform = process.platform, configuredPath = null) {
  if (configuredPath) return launcherFor(configuredPath);
  // 测试可指定一个 Node 假执行者（回放真实输出样例）；不改变真实安装或 PATH（与 codex 相同）。
  if (testAgent(env)) return { executable: process.execPath, args: [path.resolve(testAgent(env))] };
  const file = findOnPath(platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'], env);
  if (file) return launcherFor(file);
  throw new Error(missing);
}

// 相对项目根、/ 分隔。Claude Code 给的是绝对路径，可能是 8.3 短路径（如 PROGRA~1），与项目根写法不同时按真实路径再比一次。
export function relPath(root, file) {
  const abs = path.resolve(root, String(file ?? ''));
  const inside = r => r && !r.startsWith('..') && !path.isAbsolute(r);
  let r = path.relative(root, abs);
  if (!inside(r)) {
    const real = p => { try { return realpathSync.native(p); } catch { try { return path.join(realpathSync.native(path.dirname(p)), path.basename(p)); } catch { return p; } } };
    const again = path.relative(real(root), real(abs));
    if (inside(again)) r = again;
  }
  return (inside(r) ? r : abs).replaceAll('\\', '/');
}

const resultText = content => Array.isArray(content) ? content.map(x => typeof x?.text === 'string' ? x.text : '').filter(Boolean).join('\n') : String(content ?? '');

// 有状态映射：tool_use（开始）与 tool_result（结果）是两条消息，要靠 id 配对。
export function createMapper() {
  const pending = new Map(); // tool_use id → { name, input, existed }
  const mapper = (line, { root }) => {
    let e;
    try { e = JSON.parse(line); } catch { return line.trim() ? [{ kind: 'text', text: line }] : []; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) return [];
    const out = [];
    if (e.type === 'system' && e.subtype === 'init') out.push({ kind: 'tool', name: 'init', detail: String(e.model ?? '') });
    if (e.type === 'assistant') for (const c of e.message?.content ?? []) {
      if (c?.type === 'text' && c.text) out.push({ kind: 'say', text: String(c.text) });
      else if (c?.type === 'thinking' && c.thinking) out.push({ kind: 'think', text: String(c.thinking) });
      else if (c?.type === 'tool_use') {
        const input = c.input && typeof c.input === 'object' ? c.input : {};
        const target = input.file_path ?? input.notebook_path;
        pending.set(c.id, { name: c.name, input, existed: c.name === 'Write' && target != null ? existsSync(path.resolve(root, String(target))) : null });
        if (SHELL_TOOLS.has(c.name)) out.push({ kind: 'cmd', id: String(c.id), phase: 'start', command: String(input.command ?? '') });
        else if (c.name === 'TodoWrite') out.push({ kind: 'plan', items: (Array.isArray(input.todos) ? input.todos : []).map(t => ({ text: String(t?.content ?? ''), done: t?.status === 'completed' })) });
        // 写文件类等结果回来、确认成功后再记"改动文件"。
        else if (!EDIT_TOOLS.has(c.name) && c.name !== 'Write') out.push({ kind: 'tool', name: String(c.name), detail: describe(c.name, input, root) });
      }
    }
    if (e.type === 'user') for (const c of e.message?.content ?? []) {
      if (c?.type !== 'tool_result') continue;
      const use = pending.get(c.tool_use_id);
      pending.delete(c.tool_use_id);
      if (!use) continue;
      if (SHELL_TOOLS.has(use.name)) out.push({ kind: 'cmd', id: String(c.tool_use_id), phase: 'end', command: String(use.input.command ?? ''), exit: c.is_error ? 1 : 0, ...limitOutput(resultText(c.content)) });
      else if (!c.is_error && (EDIT_TOOLS.has(use.name) || use.name === 'Write')) {
        const target = use.input.file_path ?? use.input.notebook_path;
        if (target == null) continue;
        // Write 的结果自带 create / update；没有时按调用时文件是否存在判断。
        const type = e.tool_use_result?.type;
        const kind = use.name !== 'Write' ? 'update' : type === 'create' ? 'add' : type === 'update' ? 'update' : use.existed ? 'update' : 'add';
        out.push({ kind: 'file', files: [{ kind, path: relPath(root, target) }] });
      }
    }
    if (e.type === 'result') {
      out.push({ kind: 'turn', usage: { input: e.usage?.input_tokens ?? null, output: e.usage?.output_tokens ?? null } });
      if (typeof e.result === 'string' && e.result) mapper.lastResult = e.result;
      if (e.is_error || String(e.subtype ?? '').startsWith('error')) out.push({ kind: 'error', text: String(e.result || explain(e.subtype)) });
    }
    return out;
  };
  mapper.lastResult = null;
  return mapper;
}

// 结果出错又没有说明文字时，按 subtype 给中文说明，括号里保留原值。
const explain = subtype => ({ error_max_turns: '达到最大轮数仍未完成', error_during_execution: '执行过程中出错', error_max_budget_usd: '达到费用上限' }[subtype] ?? 'Claude Code 报告失败') + (subtype ? `（${subtype}）` : '');

// 工具摘要：名称 + 关键参数（文件路径相对项目根）。
function describe(name, input, root) {
  const file = input.file_path ?? input.notebook_path ?? input.path;
  const key = input.pattern ?? input.query ?? input.url ?? input.description ?? input.prompt ?? input.skill ?? input.command;
  const detail = file != null ? relPath(root, file) + (input.pattern ? ` ${input.pattern}` : '') : key != null ? String(key) : '';
  return `${name}${detail ? ` ${detail}` : ''}`.slice(0, 200);
}

// 失败提示：只认通用特征，具体变量名与模型名从 profile 里取，不写死任何服务商。
export function failureHint(text, { profile } = {}) {
  const s = String(text ?? '');
  const secrets = Object.values(profile?.secrets ?? {}).join('、');
  const model = profile?.env?.ANTHROPIC_MODEL;
  if (/\b401\b|authentication|invalid[ _-]?api[ _-]?key|unauthorized/i.test(s)) return secrets ? `密钥无效或未设置：检查用户环境变量 ${secrets}` : 'Claude Code 没有可用的登录或密钥：检查该执行者的认证方式（auth）与 secrets';
  if (/\b402\b|insufficient|balance|quota/i.test(s)) return '账户余额或额度不足';
  if (/\b404\b[\s\S]*model|model[\s\S]*not[ _]found|unknown model|invalid model/i.test(s)) return `模型名不对：检查执行者配置里的 ANTHROPIC_MODEL${model ? `（当前 ${model}）` : ''}`;
  if (/\b429\b|rate[ _-]?limit|too many requests/i.test(s)) return '请求过于频繁，被限流；稍后重试或降低并发';
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(s)) return '连不上模型服务：检查网络、代理或执行者配置里的 ANTHROPIC_BASE_URL';
  if (/找不到 Claude Code CLI|ENOENT/i.test(s)) return missing;
  return null;
}

export const claudeCode = {
  id: 'claude-code',
  label: 'Claude Code',
  writesReport: false,
  // 这些设置项适配器不支持：派发时进度里提示一次后忽略。
  unsupportedSettings: ['tier'],
  capabilities: { readOnly: true, usage: true, cost: false, reportFile: false },
  detect({ env = process.env, settings = {}, tracePrefix } = {}) {
    try {
      const run = () => {
        const launcher = resolveLauncher(env, process.platform, settings.path);
        const r = spawnSync(launcher.executable, [...launcher.args, '--version'], { env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000 });
        return { launcher, r };
      };
      // tracePrefix 只有 ar agents list 会传；其他调用不增加追踪与开销。
      const { launcher, r } = tracePrefix ? traced(`${tracePrefix} detect --version`, run) : run();
      if (tracePrefix) trace(`${tracePrefix} detect --version 子进程 ${subprocessOutcome(r)}`);
      return { installed: !r.error && r.status === 0, version: r.status === 0 ? r.stdout.trim() || null : null, launcher };
    } catch (error) { return { installed: false, version: null, error: error.message }; }
  },
  // 执行者自己的配置目录（读不到用户本人的登录、设置与个人技能）；不自动升级；不发非必要流量。
  isolate({ home, profileName }) {
    return { clear: CLEAR, set: { CLAUDE_CONFIG_DIR: path.join(home, 'workers', profileName, 'claude'), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } };
  },
  command({ prompt, settings = {}, detection, env = process.env, profile = {}, readOnly = false }) {
    const { executable, args: base } = detection?.launcher ?? resolveLauncher(env, process.platform, settings.path ?? profile.path);
    const args = [...base, '-p', '--output-format', 'stream-json', '--verbose'];
    if (readOnly) args.push('--permission-mode', 'dontAsk', '--tools', READONLY_TOOLS, '--allowedTools', READONLY_TOOLS);
    else args.push('--permission-mode', 'bypassPermissions');
    const turns = settings.maxTurns ?? profile.maxTurns;
    if (Number.isInteger(turns) && turns > 0) args.push('--max-turns', String(turns));
    // 值原样传入，不在核心里校验（取值不对时 Claude Code 自己报错）；tier 没有对应参数，由派发层提示后忽略。
    if (settings.model != null) args.push('--model', String(settings.model));
    if (settings.effort != null) args.push('--effort', String(settings.effort));
    // 隔离的配置目录事先建好（首次使用时 Claude Code 在空目录里自行初始化，见【核实】）。
    if (env.CLAUDE_CONFIG_DIR) mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    return { executable, args, stdin: prompt };
  },
  // 显示用的模型名：Claude Code 从 ANTHROPIC_MODEL 读模型（这是 Claude Code 的约定，不是某个服务商的）。
  modelName({ profile } = {}) { return profile?.env?.ANTHROPIC_MODEL ?? null; },
  createMapper,
  mapLine: (line, ctx) => createMapper()(line, ctx),
  finish({ lastSay, result }) { return result ?? lastSay ?? null; },
  failureHint,
};
