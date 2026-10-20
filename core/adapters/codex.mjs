import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { testAgent } from '../lib/compat.mjs';
import { launcherFor as resolveFile, findOnPath } from '../lib/launcher.mjs';
import { limitOutput } from '../lib/output.mjs';
import { trace, traced } from '../lib/trace.mjs';

// 追踪里子进程的结束状态：区分正常结束、被超时上限截断（ETIMEDOUT）与启动失败（只在 ar agents list 传入 tracePrefix 时使用）。
const subprocessOutcome = r => r.error
  ? (r.error.code === 'ETIMEDOUT' ? 'timeout' : `error=${r.error.code ?? 'unknown'}`)
  : r.signal ? `signal=${r.signal}` : `status=${r.status}`;

const missing = '找不到 Codex CLI。确认 codex --version 能运行；非标准安装可在 config.json 的 profiles.codex.path 写 Codex 的绝对路径（或运行 ar config path=<路径>）。';
const launcherFor = file => resolveFile(file, { missing,
  unwrapError: file => `无法解析 Codex 的启动包装：${file}。可在 config.json 的 profiles.codex.path 写 codex.exe 或 Codex 的 Node 入口（codex.js）的绝对路径。` });
export function resolveLauncher(env = process.env, platform = process.platform, configuredPath = null) {
  if (configuredPath) return launcherFor(configuredPath);
  // 测试可指定一个 Node 假 agent；不改变真实安装或 PATH。
  if (testAgent(env)) return { executable: process.execPath, args: [resolve(testAgent(env))] };
  const file = findOnPath(platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'], env);
  if (file) return launcherFor(file);
  throw new Error(missing);
}

export function shortCommand(s) {
  const m = s.match(/^(?:"[^"]*powershell(?:\.exe)?"|(?:\S*[\\/])?powershell(?:\.exe)?)\s+(?:-\w+\s+)*-Command\s+(['"])([\s\S]*)\1$/i);
  return m ? m[2].replace(m[1] === "'" ? /''/g : /`"/g, m[1]) : s;
}

// \u622A\u65AD\u51FD\u6570\u79FB\u5230\u516C\u5171\u7684 output.mjs\uFF0C\u8FD9\u91CC\u7EE7\u7EED\u5BFC\u51FA\uFF0C\u65E7\u7684\u5F15\u7528\u4E0D\u53D8\u3002
export { limitOutput };

// 接口错误时 Codex 把服务端返回的整段 JSON 放进 message（真实样例 codex-real-error.jsonl）：取出里面的状态码与说明。
export function readableError(text) {
  try {
    const v = JSON.parse(text);
    if (typeof v?.error?.message === 'string') return `${Number.isInteger(v.status) ? `${v.status} ` : ''}${v.error.message}`;
  } catch { /* 不是 JSON，原样返回。 */ }
  return text;
}

export function mapLine(line, { root }) {
  let e;
  try { e = JSON.parse(line); } catch { return line.trim() ? [{ kind: 'text', text: line }] : []; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [];
  if (e.type === 'turn.completed') return [{ kind: 'turn', usage: { input: e.usage?.input_tokens ?? null, output: e.usage?.output_tokens ?? null } }];
  if (e.type === 'turn.failed' || e.type === 'error') return [{ kind: 'error', text: readableError(String(e.error?.message ?? e.message ?? JSON.stringify(e))) }];
  const i = e.item;
  if (!i || !['item.started', 'item.updated', 'item.completed'].includes(e.type)) return [];
  const done = e.type === 'item.completed';
  switch (i.type) {
    case 'agent_message': return done ? [{ kind: 'say', text: String(i.text ?? '') }] : [];
    case 'reasoning': return done && i.text ? [{ kind: 'think', text: String(i.text) }] : [];
    case 'command_execution': {
      const event = { kind: 'cmd', id: String(i.id ?? ''), phase: done ? 'end' : 'start', command: shortCommand(String(i.command ?? '')) };
      if (done) Object.assign(event, { exit: typeof i.exit_code === 'number' ? i.exit_code : null }, limitOutput(String(i.aggregated_output ?? i.output ?? '')));
      return [event];
    }
    case 'file_change': return done ? [{ kind: 'file', files: (Array.isArray(i.changes) ? i.changes : [])
      .filter(f => typeof f?.path === 'string').map(f => ({ kind: ['add', 'update', 'delete'].includes(f.kind) ? f.kind : 'update', path: relative(root, resolve(root, f.path)).replaceAll('\\', '/') })) }] : [];
    case 'todo_list': return [{ kind: 'plan', items: (Array.isArray(i.items) ? i.items : []).map(t => ({ text: String(t?.text ?? ''), done: t?.completed === true })) }];
    case 'web_search': return done ? [] : [{ kind: 'tool', name: 'web_search', detail: String(i.query ?? '') }];
    case 'mcp_tool_call': return done ? [] : [{ kind: 'tool', name: 'mcp_tool_call', detail: `${i.server ?? ''} ${i.tool ?? ''}` }];
    case 'error': return /unrecognized configuration/.test(i.message ?? '') ? [] : [{ kind: 'error', text: String(i.message ?? '') }];
    default: return [];
  }
}

export const codex = {
  id: 'codex',
  label: 'Codex',
  writesReport: true,
  // 执行者环境是白名单（../lib/env.mjs）；Codex 还要读自己的配置目录与自定义接口地址（都不是密钥）。
  isolate: () => ({ keep: ['CODEX_HOME', 'OPENAI_BASE_URL'] }),
  detect({ env = process.env, settings = {}, tracePrefix } = {}) {
    try {
      const run = () => {
        const launcher = resolveLauncher(env, process.platform, settings.path);
        const result = spawnSync(launcher.executable, [...launcher.args, '--version'], { env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 });
        return { launcher, r: result };
      };
      // tracePrefix 只有 ar agents list 会传；其他调用不增加追踪与开销。
      const { launcher, r } = tracePrefix ? traced(`${tracePrefix} detect --version`, run) : run();
      if (tracePrefix) trace(`${tracePrefix} detect --version 子进程 ${subprocessOutcome(r)}`);
      return { installed: !r.error && r.status === 0, version: r.status === 0 ? r.stdout.trim() || null : null, launcher };
    } catch (error) { return { installed: false, version: null, error: error.message }; }
  },
  command({ root, report, prompt, settings, detection, env = process.env }) {
    const launcher = detection?.launcher ?? resolveLauncher(env, process.platform, settings.path);
    const args = [...launcher.args, 'exec', '--json', '-C', root];
    if (settings.model != null) args.push('-m', settings.model);
    if (settings.effort != null) args.push('-c', `model_reasoning_effort=${JSON.stringify(settings.effort)}`);
    if (settings.tier != null) args.push('-c', `service_tier=${JSON.stringify(settings.tier)}`);
    if (settings.sandbox != null) args.push('-s', settings.sandbox);
    args.push('-o', report, '-');
    return { executable: launcher.executable, args, stdin: prompt };
  },
  mapLine,
  // 订阅登录（auth: login）的状态：codex login status 的输出（与软件 Agent 页同一判断）。
  loginStatus({ env = process.env, detection, tracePrefix } = {}) {
    if (!detection?.launcher) return 'unknown';
    const run = () => spawnSync(detection.launcher.executable, [...detection.launcher.args, 'login', 'status'], { env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    // tracePrefix 只有 ar agents list 会传；其他调用不增加追踪与开销。
    const r = tracePrefix ? traced(`${tracePrefix} login status`, run) : run();
    if (tracePrefix) trace(`${tracePrefix} login status 子进程 ${subprocessOutcome(r)}`);
    if (r.error || r.signal) return 'unknown';
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (r.status === 0 && /^Logged in\b/im.test(text)) return 'in';
    if (r.status === 1 && /^Not logged in\b/im.test(text)) return 'out';
    return 'unknown';
  },
  failureHint(stderr) {
    if (/Not inside a trusted directory/i.test(stderr)) return '当前目录不是 git 仓库，Codex 拒绝运行。在项目目录里先运行 git init，或换到已有的 git 仓库再派发。';
    return null;
  },
};
