import * as realFs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AR_MARKER } from '../../../core/lib/ar-command.mjs';

const execFileAsync = promisify(execFile);
const conflictMessage = '目标文件已存在且不属于 AgentRouter，未覆盖';
const defaultPathExt = '.COM;.EXE;.BAT;.CMD';
const getPathScript = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable("Path","User")';
const getMachinePathScript = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable("Path","Machine")';
const setPathScript = "[Environment]::SetEnvironmentVariable('Path', $env:AR_NEW_PATH, 'User')";
const broadcastScript = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ARNative { [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result); }'; $result = [UIntPtr]::Zero; if ([ARNative]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) -eq [IntPtr]::Zero) { throw '环境变化广播失败' }`;

async function readUserPath() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', getPathScript], { windowsHide: true, encoding: 'buffer' });
  // PowerShell 对返回的字符串补一个换行，不能删除 PATH 本身的空白。
  return stdout.toString('utf8').replace(/\r?\n$/, '');
}
// 系统 PATH：注册表 HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment 的 Path（.NET 的 Machine 变量）。
async function readMachinePath() {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', getMachinePathScript], { windowsHide: true, encoding: 'buffer' });
  return stdout.toString('utf8').replace(/\r?\n$/, '');
}
async function writeUserPath(value) {
  const options = { windowsHide: true, env: { ...process.env, AR_NEW_PATH: value } };
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', setPathScript], options);
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', broadcastScript], options);
}
function context(localAppData, deps = {}) {
  if (!localAppData) throw new Error('缺少 LOCALAPPDATA');
  const dir = path.join(localAppData, 'AgentRouter', 'bin');
  return { dir, target: path.join(dir, 'ar.cmd'), alias: path.join(dir, 'agr.cmd'), record: path.join(dir, 'path-before.json'), fs: deps.fs ?? realFs, readPath: deps.readUserPath ?? readUserPath, writePath: deps.writeUserPath ?? writeUserPath };
}
function normalize(value) { return value.trim().replace(/[\\/]+$/, '').toLowerCase(); }
function hasPath(value, dir) { return value.split(';').some(item => normalize(item) === normalize(dir)); }
async function readOptional(fs, file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function owned(content) { return content !== null && content.split(/\r?\n/, 1)[0] === AR_MARKER; }
function parseRecord(text) {
  if (text === null) return null;
  try {
    const data = JSON.parse(text);
    return typeof data.before === 'string' && typeof data.added === 'boolean' ? data : null;
  } catch { return null; }
}
async function restoreFile(fs, file, content) {
  if (content === null) await fs.rm(file, { force: true });
  else await fs.writeFile(file, content, 'utf8');
}
async function rollback(error, actions) {
  const failures = [];
  for (const [name, action] of actions) {
    try { await action(); } catch (e) { failures.push(`${name}: ${e.message}`); }
  }
  if (failures.length) throw new Error(`${error.message}；回滚失败，可能有残留：${failures.join('；')}`, { cause: error });
  throw error;
}
function expandVars(value, env) {
  return value.replace(/%([^%]+)%/g, (all, name) => {
    const key = Object.keys(env).find(item => item.toLowerCase() === name.toLowerCase());
    return key === undefined ? all : env[key] ?? '';
  });
}
function pathDirs(value, env) {
  return expandVars(value, env).split(';').map(item => item.trim()).filter(Boolean);
}
async function fileExists(file) {
  try { await realFs.stat(file); return true; } catch { return false; }
}
// 新开终端看到的 ar 是哪一个：系统 PATH 在前、用户 PATH 在后，按 PATHEXT 逐个目录找。
// 第一个找到的不是我们写的 <dir>\ar.cmd 就是被它挡住了；读不到系统 PATH 时返回 null（不知道）。
async function shadowFrom(c, userPath, deps = {}) {
  let machinePath;
  try { machinePath = await (deps.readMachinePath ?? readMachinePath)(); } catch { return { shadowed: null }; }
  const env = deps.env ?? process.env;
  const exts = (env.PATHEXT ?? defaultPathExt).split(';').map(item => item.trim()).filter(Boolean).map(item => (item.startsWith('.') ? item : `.${item}`).toLowerCase());
  const exists = deps.exists ?? fileExists;
  for (const dir of [...pathDirs(machinePath, env), ...pathDirs(userPath, env)]) {
    for (const ext of exts) {
      const file = path.join(dir, `ar${ext}`);
      if (await exists(file)) return normalize(file) === normalize(c.target) ? { shadowed: false } : { shadowed: true, by: file };
    }
  }
  return { shadowed: false };
}
export async function arShadow({ localAppData, deps = {} } = {}) {
  const c = context(localAppData, deps);
  return shadowFrom(c, await c.readPath(), deps);
}
export async function arStatus({ localAppData, appExe, coreEntry, deps } = {}) {
  const c = context(localAppData, deps);
  const [content, aliasContent, userPath] = await Promise.all([readOptional(c.fs, c.target), readOptional(c.fs, c.alias), c.readPath()]);
  const isOwned = owned(content) && owned(aliasContent);
  return { installed: isOwned, path: c.target, inPath: hasPath(userPath, c.dir), owned: isOwned, conflict: (content !== null && !owned(content)) || (aliasContent !== null && !owned(aliasContent)), shadow: isOwned ? await shadowFrom(c, userPath, deps ?? {}) : null };
}
export async function installAr({ localAppData, appExe, coreEntry, deps } = {}) {
  const c = context(localAppData, deps);
  if (!appExe || !coreEntry || /["\r\n]/.test(appExe) || /["\r\n]/.test(coreEntry)) throw new Error('无效的可执行文件或核心路径');
  const [oldFile, oldAlias, oldRecord, before] = await Promise.all([readOptional(c.fs, c.target), readOptional(c.fs, c.alias), readOptional(c.fs, c.record), c.readPath()]);
  // 任一个已存在且不是我们写的就报冲突：两个都不写，不留半套。
  if ((oldFile !== null && !owned(oldFile)) || (oldAlias !== null && !owned(oldAlias))) throw new Error(conflictMessage);
  const existingRecord = parseRecord(oldRecord);
  const inPath = hasPath(before, c.dir);
  const added = !inPath;
  // 已安装且记录丢失时保守保留，不凭空认领原有 PATH 组件。
  const record = added ? { before, added: true, position: 'end' } : (existingRecord ?? { before, added: false });
  const contents = `${AR_MARKER}\r\n@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${appExe}" "${coreEntry}" %*\r\n`;
  let pathAttempted = false;
  try {
    await c.fs.mkdir(c.dir, { recursive: true });
    await c.fs.writeFile(c.record, JSON.stringify(record, null, 2) + '\n', 'utf8');
    await c.fs.writeFile(c.target, contents, 'utf8');
    await c.fs.writeFile(c.alias, contents, 'utf8');
    if (added) {
      pathAttempted = true;
      await c.writePath(before ? `${before};${c.dir}` : c.dir);
    }
  } catch (error) {
    const actions = [];
    if (pathAttempted) actions.push(['PATH', () => c.writePath(before)]);
    actions.push(['ar.cmd', () => restoreFile(c.fs, c.target, oldFile)], ['agr.cmd', () => restoreFile(c.fs, c.alias, oldAlias)], ['path-before.json', () => restoreFile(c.fs, c.record, oldRecord)]);
    await rollback(error, actions);
  }
  return { ok: true, path: c.target, pathChanged: added };
}
export async function uninstallAr({ localAppData, deps } = {}) {
  const c = context(localAppData, deps);
  const [file, aliasFile, recordText, before] = await Promise.all([readOptional(c.fs, c.target), readOptional(c.fs, c.alias), readOptional(c.fs, c.record), c.readPath()]);
  const record = parseRecord(recordText);
  const removed = [];
  const kept = [];
  const components = before.split(';');
  // 只移除一个组件，避免误删安装后用户自行添加的重复项。
  const index = record?.added && record.position === 'end' ? components.findLastIndex(item => normalize(item) === normalize(c.dir)) : -1;
  let pathAttempted = false;
  try {
    if (index >= 0) {
      components.splice(index, 1);
      pathAttempted = true;
      await c.writePath(components.join(';'));
      removed.push(c.dir);
    } else if ((!record || (record.added && record.position !== 'end')) && hasPath(before, c.dir)) kept.push(c.dir);
    if (owned(file)) { await c.fs.rm(c.target); removed.push(c.target); }
    else if (file !== null) kept.push(c.target);
    if (owned(aliasFile)) { await c.fs.rm(c.alias); removed.push(c.alias); }
    else if (aliasFile !== null) kept.push(c.alias);
    if (recordText !== null && record) await c.fs.rm(c.record);
    else if (recordText !== null) kept.push(c.record);
  } catch (error) {
    const actions = [];
    if (pathAttempted) actions.push(['PATH', () => c.writePath(before)]);
    actions.push(['ar.cmd', () => restoreFile(c.fs, c.target, file)], ['agr.cmd', () => restoreFile(c.fs, c.alias, aliasFile)], ['path-before.json', () => restoreFile(c.fs, c.record, recordText)]);
    await rollback(error, actions);
  }
  return { ok: true, removed, kept };
}
