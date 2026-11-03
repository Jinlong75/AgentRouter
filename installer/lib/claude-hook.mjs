import fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const sessionCommand = /(?:^|[\\/])ar\.mjs" lead brief --hook$/;
const guardCommand = /(?:^|[\\/])bash-guard\.mjs"$/;
const owned = (entry, pattern) => entry?.agentRouter === true || (Array.isArray(entry?.hooks) && entry.hooks.some(h => typeof h.command === 'string' && pattern.test(h.command)));
export function planHook({ claudeDir, coreDir }) {
  const path = join(resolve(claudeDir), 'settings.json');
  let text, settings;
  try { text = fs.readFileSync(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { settings = text === undefined ? {} : JSON.parse(text); } catch { return { path, error: 'Claude Code 设置文件不是合法 JSON，没有注册会话启动钩子' }; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) || (settings.hooks?.SessionStart !== undefined && !Array.isArray(settings.hooks.SessionStart)) || (settings.hooks?.PreToolUse !== undefined && !Array.isArray(settings.hooks.PreToolUse))) return { path, error: 'Claude Code 设置文件的钩子格式无效，没有注册会话启动钩子' };
  const resolvedCore = resolve(coreDir);
  const warning = /[$`"'%\r\n]/.test(join(resolvedCore, 'ar.mjs'))
    ? '钩子路径含 shell 特殊字符，未注册会话启动钩子；可手动在 Claude Code 设置里添加' : undefined;
  return { path, settings, coreDir: resolvedCore, ...(warning ? { warning } : {}) };
}
export function writeSettings(path, text) {
  fs.mkdirSync(dirname(path), { recursive: true });
  let target = path;
  try {
    if (fs.lstatSync(path).isSymbolicLink()) {
      try { target = fs.realpathSync(path); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        target = resolve(dirname(path), fs.readlinkSync(path));
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(dirname(target), `.agent-router-${randomUUID()}.tmp`);
  let mode;
  try { mode = fs.statSync(target).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; mode = 0o600; }
  try { fs.writeFileSync(temp, text, { mode }); if (process.platform !== 'win32') fs.chmodSync(temp, mode); fs.renameSync(temp, target); } finally { fs.rmSync(temp, { force: true }); }
}
function mutate(plan, install) {
  if (plan.error || (install && plan.warning)) return plan;
  const settings = plan.settings;
  const clean = (entries, pattern) => entries.flatMap(entry => {
    if (!owned(entry, pattern)) return [entry];
    if (entry.agentRouter === true) return [];
    const hooks = entry.hooks.filter(h => !(typeof h.command === 'string' && pattern.test(h.command)));
    return hooks.length ? [{ ...entry, hooks }] : [];
  });
  const sessions = settings.hooks?.SessionStart || [], guards = settings.hooks?.PreToolUse || [];
  const sessionOthers = clean(sessions, sessionCommand), guardOthers = clean(guards, guardCommand);
  if (install) {
    sessionOthers.push({ hooks: [{ type: 'command', command: `node "${join(plan.coreDir, 'ar.mjs')}" lead brief --hook` }] });
    guardOthers.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${join(plan.coreDir, 'hooks', 'bash-guard.mjs')}"` }] });
  }
  if (!install && sessionOthers.length === sessions.length && sessionOthers.every((e, i) => e === sessions[i]) && guardOthers.length === guards.length && guardOthers.every((e, i) => e === guards[i])) return plan;
  settings.hooks ||= {};
  settings.hooks.SessionStart = sessionOthers;
  settings.hooks.PreToolUse = guardOthers;
  writeSettings(plan.path, JSON.stringify(settings, null, 2) + '\n');
  return plan;
}
export const applyHook = plan => mutate(plan, true);
export const removeHook = plan => mutate(plan, false);
