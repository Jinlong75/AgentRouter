// 验收命令的拆分、解析与安全运行（协议 12.2）。零依赖。
// 约定：参数一律用数组传，shell: false；只有解析不了的 Windows .cmd/.bat 才经 cmd.exe /d /s /c 运行，
// 且参数里出现 cmd 特殊字符时拒绝运行（不在批处理里做引号/转义猜测）。
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { killProcessTree } from './process.mjs';

export class CommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandError';
  }
}

const isFile = file => {
  try { return statSync(file).isFile(); } catch { return false; }
};

// Windows 文件系统不区分大小写；在其他平台上用 platform: 'win32' 模拟时，按目录扫一遍同名文件。
const lookupFile = (file, platform) => {
  if (isFile(file)) return file;
  if (platform !== 'win32') return null;
  const dir = dirname(file), lower = basename(file).toLowerCase();
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  const hit = entries.find(entry => entry.toLowerCase() === lower);
  return hit ? join(dir, hit) : null;
};

// 包装文本里的相对路径是 Windows 写法；统一成 / 再交给宿主平台的 path 解析（Windows 也接受 /）。
const toHost = file => String(file).replace(/\\/g, '/');

const pathSeparator = platform => platform === 'win32' ? ';' : ':';
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];
const pathextOf = (env, platform) => {
  if (platform !== 'win32') return [];
  const raw = env.PATHEXT ? String(env.PATHEXT) : DEFAULT_PATHEXT.join(';');
  return raw.split(';').map(ext => ext.trim()).filter(Boolean);
};

// 按空白拆分，支持 "…" 与 '…'；引号本身去掉，相邻段拼成同一个参数。不做变量展开、通配、转义。
export function splitArgs(line) {
  const text = String(line ?? '');
  const args = [];
  let current = '', started = false, quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { args.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) throw new CommandError(`引号没有闭合：${text}`);
  if (started) args.push(current);
  return args;
}

// 找到命令对应的绝对路径：含路径分隔符按 cwd 解析，否则按 PATH 顺序（Windows 再按 PATHEXT 顺序）查找。
export function resolveExecutable(name, { cwd = process.cwd(), env = process.env, platform = process.platform } = {}) {
  const value = String(name ?? '');
  const pathext = pathextOf(env, platform);
  const find = file => lookupFile(file, platform);
  // Windows 上：没有扩展名的命令只能按 PATHEXT 补扩展名（无扩展名的文件本身不可执行）；
  // 自带扩展名时按原名找。其他平台只按原名找。
  const byName = name => platform === 'win32' && !extname(basename(name)) ? pathext.map(ext => name + ext) : [name];
  if (/[\\/]/.test(value)) {
    const target = resolve(cwd, toHost(value));
    for (const candidate of byName(target)) {
      const hit = find(candidate);
      if (hit) return hit;
    }
    throw new CommandError(`找不到命令：${value}`);
  }
  const dirs = String(env.PATH ?? env.Path ?? '')
    .split(pathSeparator(platform))
    .map(dir => dir.replace(/^"|"$/g, ''))
    .filter(Boolean);
  const candidates = byName(value);
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const hit = find(resolve(dir, toHost(candidate)));
      if (hit) return hit;
    }
  }
  throw new CommandError(`找不到命令：${value}`);
}

// 运行 JS 入口的 Node：包装同目录的 node.exe 优先，其次 PATH 里的 node；不用 process.execPath（软件里是 Electron）。
function nodeFor(wrapper, dir, env, platform) {
  const local = lookupFile(join(dir, 'node.exe'), platform);
  if (local) return local;
  try { return resolveExecutable('node', { cwd: dir, env, platform }); }
  catch { throw new CommandError(`找不到 node，无法运行 ${wrapper}`); }
}

// 只读包装文本，不执行、不求值批处理；识别两种 npm 系包装。解析不了返回 null。
// Node 自带的 npm.cmd / npx.cmd：SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"。
// npm 为全局包生成的包装："%dp0%\…\x.js" %*（入口是 .exe 时直接运行它）。
function parseWrapper(file, rest, env, platform) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const dir = dirname(file);
  const builtin = text.match(/SET\s+"?(?:NPM|NPX)_CLI_JS=%~dp0([^"\r\n]+)"?/i);
  if (builtin) {
    // "全局前缀下另有一份 npm" 的分支不跟随：只取包装同目录下的入口。%~dp0 自带末尾的反斜杠。
    const entry = lookupFile(resolve(dir, toHost(builtin[1].replace(/^[\\/]+/, '').trim())), platform);
    if (!entry) return null;
    return { executable: nodeFor(file, dir, env, platform), args: [entry, ...rest] };
  }
  const bundled = text.match(/"%dp0%[\\/]([^"\r\n]+\.(?:js|mjs|cjs|exe))"\s+%\*/i);
  if (bundled) {
    const entry = lookupFile(resolve(dir, toHost(bundled[1].trim())), platform);
    if (!entry) return null;
    if (/\.exe$/i.test(entry)) return { executable: entry, args: rest };
    return { executable: nodeFor(file, dir, env, platform), args: [entry, ...rest] };
  }
  return null;
}

const CMD_SPECIAL = /["%^&|<>!\r\n]/;

// 参数数组 → 启动计划。不合规抛 CommandError。
// 可选 line 是错误消息里的"原命令"：runCommand 传拆分前的整行，直接调用时可省，退回 argv.join(' ')。
export function planCommand(argv, { cwd = process.cwd(), env = process.env, platform = process.platform, line } = {}) {
  const list = Array.isArray(argv) ? argv.map(item => String(item)) : [];
  const name = list[0];
  if (!name) throw new CommandError(`找不到命令：${name ?? ''}`);
  const file = resolveExecutable(name, { cwd, env, platform });
  const rest = list.slice(1);
  const windows = platform === 'win32';
  if (!windows || !/\.(cmd|bat)$/i.test(file)) return { executable: file, args: rest, verbatim: false };
  const wrapper = parseWrapper(file, rest, env, platform);
  if (wrapper) return { ...wrapper, verbatim: false };
  const special = rest.find(item => CMD_SPECIAL.test(item));
  if (special !== undefined) throw new CommandError(`参数含 cmd 特殊字符，拒绝运行：${line ?? list.join(' ')}`);
  // 解析不了的批处理只能交给 cmd.exe；含空白的项加双引号，参数数组仍是一整个 /c 命令串。
  const commandLine = [file, ...rest].map(item => /\s/.test(item) ? `"${item}"` : item).join(' ');
  return { executable: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${commandLine}"`], verbatim: true };
}

const MAX_LINES = 200;
const MAX_BYTES = 16 * 1024;
const OUTPUT_CAP = 256 * 1024;
const utf8Width = codePoint => codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

// 保留最后 200 行且不超过 16 KB（UTF-8 字节），不切断多字节字符。
// 按字节截断后只保留整行：切点不在行首时丢掉被切开的那一行；全文没有换行的超长单行没有整行可留，按字节保留末尾。
export function limitOutput(text) {
  const source = String(text ?? '');
  let output = source, truncated = false;
  const lines = source.split('\n');
  if (lines.length > MAX_LINES) { output = lines.slice(-MAX_LINES).join('\n'); truncated = true; }
  if (Buffer.byteLength(output) > MAX_BYTES) {
    truncated = true;
    let index = output.length, bytes = 0;
    while (index > 0) {
      // 从末尾按码点累加；遇到代理对时整对保留，避免切出半个字符。
      const low = output.charCodeAt(index - 1);
      const paired = low >= 0xdc00 && low <= 0xdfff && index >= 2
        && output.charCodeAt(index - 2) >= 0xd800 && output.charCodeAt(index - 2) <= 0xdbff;
      const width = paired ? 2 : 1;
      const size = utf8Width(output.codePointAt(index - width));
      if (bytes + size > MAX_BYTES) break;
      bytes += size;
      index -= width;
    }
    let tail = output.slice(index);
    // 切点前一个字符不是换行，说明首行只留了后半截：整行丢掉，从下一行开头算起。
    if (index > 0 && output[index - 1] !== '\n' && output.includes('\n')) {
      const nextBreak = output.indexOf('\n', index);
      tail = nextBreak === -1 ? '' : output.slice(nextBreak + 1);
    }
    output = tail;
  }
  return { output, truncated };
}

// 运行一行验收命令：永不抛错，失败原因放在 error 里。
// onSpawn(pid) 可选：启动成功后回调子进程 pid，结束时回调 null（T6 停止信号用）；不传时行为与返回值不变。
export async function runCommand(line, { cwd = process.cwd(), env = process.env, timeoutMs, onSpawn } = {}) {
  const started = Date.now();
  const text = String(line ?? '');
  let argv = [];
  let plan;
  try {
    argv = splitArgs(text);
    plan = planCommand(argv, { cwd, env, line: text });
  } catch (error) {
    return { line: text, argv, pid: null, exit: null, ms: Date.now() - started, timedOut: false, output: '', truncated: false, error: error.message };
  }
  return new Promise(done => {
    const chunks = [];
    let total = 0, settled = false, timedOut = false, timeoutError = null, timer = null, grace = null;
    let childPid = null; // 启动成功时才有 pid；门禁写不写 gate.json 由 T5 决定。
    // 内存里只留最后 256 KB；裁掉半个多字节字符时跳过 UTF-8 续字节。
    const collect = chunk => {
      chunks.push(chunk);
      total += chunk.length;
      while (total > OUTPUT_CAP && chunks.length) {
        const first = chunks[0], excess = total - OUTPUT_CAP;
        if (first.length <= excess) { chunks.shift(); total -= first.length; continue; }
        let cut = excess;
        while (cut < first.length && (first[cut] & 0xc0) === 0x80) cut++;
        chunks[0] = first.subarray(cut);
        total -= cut;
      }
    };
    const finish = (exit, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      // 先告诉调用方这条命令已经结束，避免停止信号去结束一个已经退出（可能复用）的 pid。
      try { onSpawn?.(null); } catch { /* 回调不能影响命令结算。 */ }
      const { output, truncated } = limitOutput(Buffer.concat(chunks, total).toString('utf8'));
      done({ line: text, argv, pid: childPid, exit, ms: Date.now() - started, timedOut, output, truncated, error: error ?? null });
    };
    let child;
    try {
      child = spawn(plan.executable, plan.args, {
        cwd, env, shell: false, windowsHide: true,
        windowsVerbatimArguments: plan.verbatim,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(null, `启动失败：${error.message}`);
      return;
    }
    // 启动失败（如找不到可执行文件）时 spawn 也会给一个没有 pid 的对象，这种算没启动。
    childPid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
    if (childPid) { try { onSpawn?.(childPid); } catch { /* 回调不能影响命令运行。 */ } }
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', error => finish(null, `启动失败：${error.message}`));
    child.on('close', code => finish(timedOut ? null : code, timeoutError));
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(async () => {
        timedOut = true;
        timeoutError = `超过 ${timeoutMs / 1000} 秒没有结束，已结束进程树`;
        try { await killProcessTree(child.pid); }
        catch (error) { timeoutError += `：${error.message}`; }
        if (settled) return;
        // 仍等 close 结算；最多再等 15 秒，到时强制结算并注明进程树没能结束。
        grace = setTimeout(() => finish(null, `${timeoutError}；进程树没能结束`), 15000);
      }, timeoutMs);
    }
  });
}
