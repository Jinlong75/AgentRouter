import { existsSync, writeFileSync, mkdirSync, renameSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { waitInterval } from './wait.mjs';
import { taskPaths } from './records.mjs';
import { readJson } from './json.mjs';

function appName(value) {
  return typeof value === 'string' && value.trim() ? Array.from(value.trim()).slice(0, 40).join('') : 'AgentRouter';
}
export function viewerApp(home) {
  try { return appName(readJson(join(home, 'viewer.json'))?.app); }
  catch { return 'AgentRouter'; }
}
export const managedMessage = app => `托管：任务已交给 ${appName(app)}，关掉当前会话也不会中断。`;
export const fallbackMessage = (reason, app) => `托管：${appName(app)} 没有接手（${reason}），改为直接运行`;
export const environmentKeys = ['PATH', 'CODEX_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'ComSpec', 'PATHEXT', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'OPENAI_BASE_URL'];
export function managedEnvironment(env) {
  return Object.fromEntries(environmentKeys.flatMap(key => {
    const actual = Object.keys(env).find(k => k.toLowerCase() === key.toLowerCase());
    return actual && typeof env[actual] === 'string' ? [[key, env[actual]]] : [];
  }));
}
export function acceptsManaged(home, enabled) {
  if (!enabled) return false;
  try {
    const viewer = readJson(join(home, 'viewer.json'));
    if (viewer.acceptsManaged !== true || !Number.isSafeInteger(viewer.pid) || viewer.pid <= 0) return false;
    process.kill(viewer.pid, 0); return true;
  } catch { return false; }
}
export function validRequest(r) {
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  const nullable = x => x === null || typeof x === 'string';
  return object(r) && r.v === 1 && typeof r.id === 'string' && /^[^<>:"/\\|?*\x00-\x1f]+$/.test(r.id) && !/[. ]$/.test(r.id)
    && Number.isFinite(r.at) && ['script','node','repo'].every(k => typeof r[k] === 'string' && isAbsolute(r[k]))
    && typeof r.name === 'string' && !!r.name && !/[<>:"/\\|?*\x00-\x1f]/.test(r.name) && !/[. ]$/.test(r.name)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(r.name)
    && object(r.args) && typeof r.args.task === 'string' && !!r.args.task && typeof r.args.extra === 'string' && nullable(r.args.role) && nullable(r.args.spec)
    && (r.args.gate === undefined || validGate(r.args.gate))
    && object(r.settings) && ['model','effort','tier','path'].every(k => nullable(r.settings[k])) && typeof r.settings.sandbox === 'string'
    && (r.settings.path === null || isAbsolute(r.settings.path))
    && object(r.dispatcher) && ['claude-code','unknown','agentrouter'].includes(r.dispatcher.host) && nullable(r.dispatcher.session)
    && object(r.env) && Object.entries(r.env).every(([key,value]) => environmentKeys.includes(key) && typeof value === 'string' && !value.includes('\0'))
    && ['profile', 'adapter'].every(k => r[k] === undefined || (typeof r[k] === 'string' && !!r[k]))
    && (r.profileConfig === undefined || validProfileConfig(r.profileConfig))
    && (r.worktree === undefined || validWorktree(r.worktree));
}
// worktree 模式（协议 15.2，可选）：派发进程算好的基线；缺省等于非 worktree 模式，旧请求照常有效。
function validWorktree(w) {
  return !!w && typeof w === 'object' && !Array.isArray(w) && typeof w.base === 'string' && /^[0-9a-f]{40,64}$/.test(w.base);
}
// 门禁快照（Stage04，可选）：派发进程已经解析并检查过任务说明，执行者进程不再重读、不重新取 base。
// 缺省等于"没有门禁"，旧请求照常有效；merged 只含门禁用到的字段。
function validGate(gate) {
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  const strings = x => Array.isArray(x) && x.every(item => typeof item === 'string');
  if (!object(gate) || typeof gate.enabled !== 'boolean') return false;
  if (!(gate.base === null || (typeof gate.base === 'string' && /^[0-9a-f]{40,64}$/.test(gate.base)))) return false;
  if (gate.enabled && gate.base === null) return false;
  const merged = gate.merged;
  return object(merged) && strings(merged.allowed_paths) && strings(merged.verify)
    && typeof merged.expect_commit === 'boolean'
    && Number.isInteger(merged.verify_timeout_min) && merged.verify_timeout_min > 0;
}
// 执行者配置快照（Stage02 起）：env 是字符串映射；secrets 只能是"变量名 → 变量名"，不可能夹带密钥值。
function validProfileConfig(p) {
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  const name = x => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x);
  return object(p) && object(p.env) && Object.entries(p.env).every(([k, v]) => name(k) && typeof v === 'string' && !v.includes('\0'))
    && object(p.secrets) && Object.entries(p.secrets).every(([k, v]) => name(k) && name(v))
    && (p.auth === null || ['login', 'token'].includes(p.auth))
    && (p.maxTurns === null || (Number.isInteger(p.maxTurns) && p.maxTurns > 0))
    && (p.label === null || typeof p.label === 'string')
    && (p.adapter === undefined || p.adapter === null || typeof p.adapter === 'string')
    && (p.path === undefined || p.path === null || (typeof p.path === 'string' && isAbsolute(p.path)));
}
export const existingPaths = taskPaths;
// 只处理完整行，保留尾部半行；轮询时不重复读取整个清单。
// afterResume（可选，协议 14.4）：给了正整数 n 时，只认清单里 n 相同的 resume 之后的 end / interrupted；
// 之前（上一次尝试）的终结事件忽略。不传时行为不变。
export function terminalReader(home, id, onStart = () => {}, afterResume = null) {
  let offset = 0, pending = Buffer.alloc(0);
  let armed = afterResume === null;
  // 同一任务的 gate 事件总在 end 之前；读到 end 时把它一并交给等待方（协议 13）。
  let gate = null;
  return () => {
    let fd;
    try {
      const file = join(home, 'runs.jsonl'), size = statSync(file).size;
      if (size < offset) { offset = 0; pending = Buffer.alloc(0); gate = null; armed = afterResume === null; }
      fd = openSync(file, 'r');
      while (offset < size) {
        const chunk = Buffer.alloc(Math.min(65536, size - offset));
        const n = readSync(fd, chunk, 0, chunk.length, offset); if (!n) break; offset += n;
        pending = Buffer.concat([pending, chunk.subarray(0, n)]);
        let end;
        while ((end = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, end).toString('utf8'); pending = pending.subarray(end + 1);
          try {
            const e = JSON.parse(line);
            if ((e.v === 1 || e.v === 2) && e.id === id) {
              if (e.event === 'start') onStart(e);
              if (e.event === 'gate') gate = { ok: e.ok === true, summary: e.summary };
              if (e.event === 'resume' && e.n === afterResume) { armed = true; gate = null; }
              if (armed && ['end','interrupted'].includes(e.event)) return gate ? { ...e, gate } : e;
            }
          } catch { /* 忽略损坏行。 */ }
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    return null;
  };
}
export async function handoff(home, request, announce, { timeout = 5000, startTimeout = 15000, interval = waitInterval } = {}) {
  const dir = join(home, 'managed'), base = join(dir, request.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(base + '.tmp', JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  renameSync(base + '.tmp', base + '.request.json');
  let started = false, accepted = false, startDeadline = Infinity;
  const terminal = terminalReader(home, request.id, () => { started = true; }), deadline = Date.now() + timeout;
  while (true) {
    // 拒绝先于认领判断；认领者完成 reason 原子写入后才回退。
    if (existsSync(base + '.rejected.json')) {
      const rejected = readJson(base + '.rejected.json');
      if (typeof rejected.reason === 'string') return { reason: rejected.reason };
    }
    const ended = terminal();
    if (!accepted && (existsSync(base + '.claimed.json') || existsSync(base + '.running.json') || started || ended)) {
      accepted = true; startDeadline = Date.now() + startTimeout; announce(managedMessage(request.app));
    }
    if (accepted && ended) return { exit: ended.event === 'end' ? ended.exit ?? 1 : 1, ...(ended.gate ? { gate: ended.gate } : {}) };
    if (accepted && !started && Date.now() >= startDeadline) {
      try { renameSync(base + '.claimed.json', base + '.withdrawn.json'); return { reason: '软件没有启动任务' }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; /* 执行者或拒绝者已经接手，继续等待。 */ }
    }
    if (!accepted && Date.now() >= deadline) {
      try { renameSync(base + '.request.json', base + '.withdrawn.json'); return { reason: '超时' }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; /* 认领或拒绝赢得改名竞争，继续等它发布结果。 */ }
    }
    await delay(interval);
  }
}
