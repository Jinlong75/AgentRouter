// 本机该用哪个命令运行核心：ar、agr，或 node "<核心>/ar.mjs"。
// msys64 / Git for Windows / binutils 都自带同名的 ar，排在 PATH 前面时会挡住我们的命令。
import { readFile as readFileFs, realpath as realpathFs, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

export const AR_MARKER = 'rem AgentRouter ar 命令';

const defaultPathExt = '.COM;.EXE;.BAT;.CMD';

function pathApi(platform) { return platform === 'win32' ? win32 : posix; }

// PATH 里可能有空项、带引号的目录（Windows 常见 "C:\Program Files\x"），都按普通项处理。
function cleanDir(value) {
  const dir = value.trim();
  return dir.length > 1 && dir.startsWith('"') && dir.endsWith('"') ? dir.slice(1, -1) : dir;
}

function pathDirs(value, platform) {
  return String(value ?? '').split(platform === 'win32' ? ';' : ':').map(cleanDir).filter(Boolean);
}

async function fileExists(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

// 按 PATH 顺序找第一个 name；只读文件，不执行它。Windows 按 PATHEXT 逐个试，POSIX 找同名文件。
export async function whichCommand(name, { env = process.env, platform = process.platform, exists } = {}) {
  const p = pathApi(platform);
  const found = exists ?? fileExists;
  const exts = platform === 'win32'
    ? String(env.PATHEXT ?? defaultPathExt).split(';').map(item => item.trim()).filter(Boolean).map(item => (item.startsWith('.') ? item : `.${item}`).toLowerCase())
    : [''];
  for (const dir of pathDirs(env.PATH, platform)) {
    for (const ext of exts) {
      const file = p.join(dir, `${name}${ext}`);
      if (await found(file)) return file;
    }
  }
  return null;
}

// 这个文件是不是 AgentRouter 装的：首行标记；或者（POSIX 符号链接）指向某个 core/ar.mjs；
// 或者文本里同时含 core/ar.mjs 与 AgentRouter。读不了就当作不是。
export async function isOurs(file, { readFile = readFileFs, realpath = realpathFs } = {}) {
  let content;
  try { content = String(await readFile(file, 'utf8')); } catch { return false; }
  if (content.split(/\r?\n/, 1)[0] === AR_MARKER) return true;
  try {
    if (/(^|[\\/])core[\\/]ar\.mjs$/.test(String(await realpath(file)))) return true;
  } catch {}
  return content.includes('core/ar.mjs') && content.includes('AgentRouter');
}

// 找一个本机可用的核心命令。没有可用命令时给出带引号的 node 调用（路径按平台分隔符）。
export async function coreCommand({ env = process.env, platform = process.platform, coreDir, readFile, realpath, exists } = {}) {
  const deps = { env, platform, readFile, realpath, exists };
  const ar = await whichCommand('ar', deps);
  if (ar && (await isOurs(ar, deps))) return { command: 'ar' };
  const agr = await whichCommand('agr', deps);
  if (agr && (await isOurs(agr, deps))) return { command: 'agr', shadowedBy: ar };
  return { command: `node "${pathApi(platform).join(coreDir, 'ar.mjs')}"`, shadowedBy: ar };
}
