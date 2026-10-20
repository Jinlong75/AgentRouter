// 清除缓存与重置：公共目录（AGENT_ROUTER_HOME）里哪些是缓存、哪些是软件文件，
// 以及"退出后删除整个公共目录"的清理进程。清理进程的代码会被 toString() 后交给
// 内置 Node（ELECTRON_RUN_AS_NODE）执行，所以 cleanupHome / clearCache 只依赖参数与动态导入，
// 不引用模块内的其他函数。
import { existsSync, readdirSync, statSync, rmSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// monitor/ 下由 Chromium 自己写的缓存目录；preferences.json / window.json / tasks.json 等不在此列。
export const cacheDirectoryNames = [
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'DawnCache', 'GrShaderCache', 'ShaderCache', 'Shared Dictionary',
];

// 目录（或文件）的总字节数；读不到的项按 0 算，符号链接只算链接本身。
export function sizeOf(target) {
  let info;
  try { info = statSync(target); } catch { return 0; }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  try {
    for (const entry of readdirSync(target)) total += sizeOf(path.join(target, entry));
  } catch { /* 正在被其他进程改动的子目录按 0 算。 */ }
  return total;
}

// 去掉只读属性：Windows 上 git 之类的工具会把文件写成只读，Chromium 的 Node 运行时
// （清理进程、测试连接）删这种文件会直接 EPERM，普通 Node 则会自己处理。整个目录递归处理，尽力而为。
function makeWritable(target) {
  let info;
  try { info = statSync(target); } catch { return; }
  if (!info.isDirectory()) { try { chmodSync(target, 0o666); } catch { /* 改不了就交给下一次删除尝试。 */ } return; }
  try { chmodSync(target, 0o777); } catch { /* 同上。 */ }
  try { for (const name of readdirSync(target)) makeWritable(path.join(target, name)); } catch { /* 不可读的子树跳过。 */ }
}

// 尽力删除：先整棵删，删不掉时再逐项删（Chromium 可能在目录里重新建文件）。
// 返回目录是否已经不存在；失败原因交给 log，不抛出。
export function removeQuietly(target, log = () => {}) {
  const attempt = value => {
    try { rmSync(value, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); return null; }
    catch (first) {
      // 先去掉只读属性再试一次；还删不掉多半是真的被占用（正在运行的 Chromium 缓存）。
      makeWritable(value);
      try { rmSync(value, { recursive: true, force: true }); return null; }
      catch { return first; }
    }
  };
  const first = attempt(target);
  if (first && existsSync(target)) log(`删除失败：${target}：${first instanceof Error ? first.message : String(first)}`);
  try {
    if (existsSync(target) && statSync(target).isDirectory()) {
      for (const name of readdirSync(target)) {
        const child = path.join(target, name);
        const error = attempt(child);
        if (error && existsSync(child)) log(`删除失败：${child}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch { /* 目录已经不见了或不可读。 */ }
  return !existsSync(target);
}

// 执行者配置里所有密钥的来源变量名（v2 的 profiles.<名>.secrets 的值；v1 agents 没有这一项）。
export function secretNames(config) {
  const names = new Set();
  for (const source of [config?.profiles, config?.agents]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const profile of Object.values(source)) {
      const secrets = profile && typeof profile === 'object' ? profile.secrets : null;
      if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) continue;
      for (const name of Object.values(secrets)) if (typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

// 清理缓存：Chromium 缓存目录、各执行者的会话记录、测试连接留下的临时目录。
// 这段函数会被 toString() 后交给子进程（内置 Node，ELECTRON_RUN_AS_NODE）执行，
// 所以只依赖 options 与动态导入，不引用模块作用域里的其他标识符。
// 边删边累计删掉的字节数；被占用（EPERM / EBUSY / EACCES）的文件立即跳过、计数，
// 不等待、不重试。只读属性只对执行者会话记录与测试临时目录在删除前处理一次，缓存目录不处理。
// skipProfiles 里的执行者（有进行中任务）保留会话记录；skipAllProfiles 用于"有任务没写 profile"时保守跳过全部。
export async function clearCache(options = {}) {
  const fs = options.fs || await import('node:fs');
  const path = options.path || await import('node:path');
  const os = options.os || await import('node:os');
  const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const cacheNames = Array.isArray(options.cacheNames) ? options.cacheNames
    : ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache', 'Shared Dictionary'];
  const home = typeof options.home === 'string' ? options.home : '';
  const data = typeof options.data === 'string' ? options.data : '';
  const tmp = typeof options.tmp === 'string' && options.tmp ? options.tmp : os.tmpdir();
  const skipProfiles = Array.isArray(options.skipProfiles) ? options.skipProfiles : [];
  const skipAllProfiles = options.skipAllProfiles === true;
  let bytes = 0, removed = 0, skipped = 0, sinceReport = 0, lastReport = Date.now();
  // 子进程按 200 个文件或 100 毫秒报一次进度：超时被结束时，主进程按最后一次进度返回。
  const progress = force => {
    if (!force && sinceReport < 200 && Date.now() - lastReport < 100) return;
    sinceReport = 0; lastReport = Date.now();
    report({ bytes, removed, skipped });
  };
  // 去掉只读属性：只对会话记录与测试临时目录整棵处理一次（不在每次删除失败后重试）。
  const makeWritable = target => {
    let info;
    try { info = fs.lstatSync(target); } catch { return; }
    if (info.isDirectory()) {
      if (!(info.mode & 0o200)) { try { fs.chmodSync(target, 0o777); } catch { /* 改不了就交给删除时跳过。 */ } }
      let entries = [];
      try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) if (!entry.isSymbolicLink()) makeWritable(path.join(target, entry.name));
    }
    else if (!(info.mode & 0o200)) { try { fs.chmodSync(target, 0o666); } catch { /* 同上。 */ } }
  };
  const removeFile = file => {
    let size = 0;
    try { size = fs.lstatSync(file).size; } catch { /* 读不到大小时按 0 计。 */ }
    try { fs.unlinkSync(file); bytes += size; removed++; }
    catch (error) { if (!error || error.code !== 'ENOENT') skipped++; }
    sinceReport++;
    progress(false);
  };
  const removeTree = target => {
    let info;
    try { info = fs.lstatSync(target); } catch { return; }
    if (!info.isDirectory()) { removeFile(target); return; }
    let entries = [];
    try { entries = fs.readdirSync(target, { withFileTypes: true }); }
    catch (error) { if (!error || error.code !== 'ENOENT') skipped++; return; }
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) removeTree(child); else removeFile(child);
    }
    try { fs.rmdirSync(target); } catch { /* ENOTEMPTY 是有文件被跳过，ENOENT 是已经没了。 */ }
  };
  const drop = (target, writable) => {
    try { fs.lstatSync(target); } catch { return; }
    if (writable) makeWritable(target);
    removeTree(target);
  };
  for (const name of cacheNames) drop(path.join(data, name), false);
  let profiles = [];
  try { profiles = fs.readdirSync(path.join(home, 'workers'), { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name); }
  catch { /* 还没有执行者目录。 */ }
  if (!skipAllProfiles) {
    for (const profile of profiles) {
      if (skipProfiles.includes(profile)) continue;
      drop(path.join(home, 'workers', profile, 'claude', 'projects'), true);
    }
  }
  // 测试连接用的临时目录；只认固定前缀，其他临时文件不动。
  try {
    for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
      if (entry.name.startsWith('ar-agent-test-')) drop(path.join(tmp, entry.name), true);
    }
  } catch { /* 临时目录不可读时跳过。 */ }
  progress(true);
  return { bytes, removed, skipped, profiles };
}

// 交给子进程执行的清除缓存代码：参数只经 JSON 字符串传入；进度写成一行 JSON，供主进程按超时截断。
export function clearCacheScript(options = {}) {
  const input = JSON.stringify({
    home: typeof options.home === 'string' ? options.home : '',
    data: typeof options.data === 'string' ? options.data : '',
    tmp: typeof options.tmp === 'string' ? options.tmp : undefined,
    skipProfiles: Array.isArray(options.skipProfiles) ? options.skipProfiles : [],
    skipAllProfiles: options.skipAllProfiles === true,
  });
  return `(${clearCache.toString()})(Object.assign(${input}, { onProgress: p => process.stdout.write(JSON.stringify({ type: 'progress', bytes: p.bytes, removed: p.removed, skipped: p.skipped }) + '\\n') })).then(r => process.stdout.write(JSON.stringify({ type: 'done', bytes: r.bytes, removed: r.removed, skipped: r.skipped }) + '\\n')).catch(e => { console.error(e && e.message ? e.message : String(e)); process.exitCode = 2; });`;
}

// 主进程侧：用内置 Node（ELECTRON_RUN_AS_NODE）在子进程里清除缓存，异步等它结束。
// 超过 timeoutMs（默认 30 秒）还没结束时结束子进程，按最后一次进度返回已完成的部分。
// config 里的 spawn / execPath / env / timeoutMs / log 只供单元测试注入。
export function runClearCache(options = {}, config = {}) {
  const childSpawn = config.spawn || spawn;
  const execPath = typeof config.execPath === 'string' ? config.execPath : process.execPath;
  const env = { ...(config.env || process.env), ELECTRON_RUN_AS_NODE: '1' };
  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs >= 0 ? config.timeoutMs : 30000;
  const log = typeof config.log === 'function' ? config.log : () => {};
  return new Promise((resolve, reject) => {
    let child;
    try {
      // 参数数组、shell:false；路径只经 -e 代码里的 JSON 字符串传入。
      child = childSpawn(execPath, ['-e', clearCacheScript(options)], { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    }
    catch (error) { reject(error); return; }
    let result = { bytes: 0, removed: 0, skipped: 0 };
    let buffer = '', stderr = '', settled = false, timer = null, hardStop = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      resolve(result);
    };
    const read = chunk => {
      buffer += String(chunk);
      for (let index; (index = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message && typeof message.bytes === 'number' && typeof message.removed === 'number')
          result = { bytes: message.bytes, removed: message.removed, skipped: Number(message.skipped) || 0 };
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      reject(error);
    });
    child.once('close', code => {
      if (!settled && code && stderr) log(stderr.trim());
      finish();
    });
    timer = setTimeout(() => {
      // 超过时限：结束子进程，按最后一次进度返回；kill 后最多再等 2 秒避免主进程一直挂着。
      try { child.kill('SIGKILL'); } catch { /* 已经结束。 */ }
      hardStop = setTimeout(finish, 2000);
    }, timeoutMs);
  });
}

// 防误删：只接受绝对路径；不能是根目录、用户主目录，也不能是包含用户主目录的上级目录。
export function assertResettableHome(target, { userHome = os.homedir(), platform = process.platform } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw Error('拒绝删除：路径必须是绝对路径');
  const resolved = path.resolve(target);
  const lower = value => platform === 'win32' ? value.toLowerCase() : value;
  if (resolved === path.parse(resolved).root) throw Error('拒绝删除：不能删除根目录');
  const home = path.resolve(userHome);
  if (lower(resolved) === lower(home)) throw Error('拒绝删除：不能删除用户主目录');
  const rel = path.relative(resolved, home);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) throw Error('拒绝删除：不能删除包含用户主目录的路径');
  return resolved;
}

// 重置标记：主进程写进公共目录，清理进程删除前必须读到它且记录的路径完全一致，
// 防止参数被换成别的目录（比如项目文件夹）。
export const resetMarkerName = '.agent-router-reset.json';
export function resetMarkerPath(home) { return path.join(path.resolve(home), resetMarkerName); }
export function writeResetMarker(home) {
  const resolved = path.resolve(home);
  writeFileSync(resetMarkerPath(resolved), `${JSON.stringify({ home: resolved, at: Date.now() }, null, 2)}\n`, 'utf8');
}
export function readResetMarker(home) {
  try {
    const value = JSON.parse(readFileSync(resetMarkerPath(home), 'utf8'));
    return value && typeof value.home === 'string' ? value : null;
  } catch { return null; }
}
export function assertResetMarker(home, options = {}) {
  const resolved = assertResettableHome(home, options);
  const marker = readResetMarker(resolved);
  if (!marker || path.resolve(marker.home) !== resolved) throw Error('拒绝删除：路径不是软件当前使用的公共目录');
  return resolved;
}

// 删不完时留下的标记（系统临时目录）：下次启动在设置页"数据"一节提示。
export function leftoverPath(tmp = os.tmpdir()) { return path.join(tmp, 'agent-router-reset-leftover.json'); }
export function readLeftover(tmp = os.tmpdir()) {
  try {
    const value = JSON.parse(readFileSync(leftoverPath(tmp), 'utf8'));
    return value && typeof value.home === 'string' ? value : null;
  } catch { return null; }
}
export function clearLeftover(tmp = os.tmpdir()) {
  try { rmSync(leftoverPath(tmp), { force: true }); } catch { /* 没有标记或删不掉都不影响启动。 */ }
}

// 清理进程本体：在软件退出后删除公共目录，最多重试 timeoutMs。
// 参数：home（主进程传入的绝对路径）、parentPid（等待它退出）、parentPipe（父进程的 stdin 管道关闭即视为已退出）、
// fs/path/os/sleep 仅供单元测试注入。
// 这段函数会被序列化，逐个 toString 执行；不要引用模块作用域里的其他标识符。
export async function cleanupHome(options = {}) {
  const fs = options.fs || await import('node:fs');
  const path = options.path || await import('node:path');
  const os = options.os || await import('node:os');
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs >= 0 ? options.timeoutMs : 30000;
  const waitMs = Number.isInteger(options.waitMs) && options.waitMs >= 0 ? options.waitMs : 120000;
  const pollMs = Number.isInteger(options.pollMs) && options.pollMs > 0 ? options.pollMs : 200;
  const raw = typeof options.home === 'string' ? options.home : '';
  const target = path.resolve(raw);
  const lower = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const root = path.parse(target).root;
  if (!raw || !path.isAbsolute(raw) || target === root) throw Error('拒绝删除：路径必须是公共目录的绝对路径');
  const userHome = path.resolve(os.homedir());
  if (lower(target) === lower(userHome)) throw Error('拒绝删除：不能删除用户主目录');
  const relative = path.relative(target, userHome);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) throw Error('拒绝删除：不能删除包含用户主目录的路径');
  const markerFile = path.join(target, '.agent-router-reset.json');
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); }
  catch { throw Error('拒绝删除：找不到重置标记'); }
  if (!marker || typeof marker.home !== 'string' || path.resolve(marker.home) !== target) throw Error('拒绝删除：路径不是软件当前使用的公共目录');

  const started = Date.now();
  const alive = pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error && error.code === 'EPERM'; }
  };
  // 只靠 pid 判断父进程是否结束在 Windows 上不可靠：父进程已经退出，但它启动的 Chromium 子进程
  // 还持有进程句柄时，kill(pid, 0) 仍然成功。主进程另外把清理进程的标准输入留成管道，父进程退出时
  // 管道关闭（读到 end），用它作为"真的退出了"的信号；pid 轮询只作为单元测试与异常情况的兜底。
  const pipeClosed = options.parentPipe && process.stdin && !process.stdin.isTTY
    ? new Promise(resolve => {
      process.stdin.once('end', resolve);
      process.stdin.once('close', resolve);
      process.stdin.resume();
    })
    : null;
  const waitDeadline = started + waitMs;
  let exited = !alive(options.parentPid);
  while (!exited && Date.now() < waitDeadline) {
    if (pipeClosed) exited = await Promise.race([pipeClosed.then(() => true), sleep(pollMs).then(() => false)]);
    else { await sleep(pollMs); exited = !alive(options.parentPid); }
  }
  const writeLeftover = extra => {
    try {
      fs.writeFileSync(path.join(os.tmpdir(), 'agent-router-reset-leftover.json'),
        `${JSON.stringify({ home: target, at: Date.now(), ...extra }, null, 2)}\n`, 'utf8');
    } catch { /* 连标记也写不了时只能放弃。 */ }
  };
  if (!exited) { writeLeftover({ reason: 'wait-timeout' }); return { ok: false, home: target, leftover: true }; }
  const exitedAt = Date.now();

  // 逐层删除：Windows 上整棵 rmSync 遇到被占用的文件会立刻停下，后面的文件都不再尝试；
  // 自己从深到浅删，删不掉的跳过，下一轮再试，尽量在 30 秒里把能删的都删掉。
  // 每轮记下真正失败的项（错误码 + 路径），删不完时写进残留标记，方便判断被什么占用。
  let failures = new Map();
  const note = (error, action, file) => {
    if (failures.size >= 50) return;
    const code = error && error.code ? error.code : 'ERROR';
    // 父目录因为还有删不掉的东西而报"非空"、已经删掉的项报"不存在"都是正常过程，不算占用。
    if (code === 'ENOENT' || code === 'ENOTEMPTY') return;
    failures.set(`${code} ${action} ${file}`, true);
  };
  // Windows 上只读文件（git 的对象文件就是）在 Chromium 的 Node 运行时里删不掉，会报 EPERM；
  // 普通 Node 会自己处理。这里去掉只读属性再试一次，失败才计入占用。
  const removeFile = child => {
    try { return fs.rmSync(child, { force: true }); }
    catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EACCES') && typeof fs.chmodSync === 'function') {
        try { fs.chmodSync(child, 0o666); return fs.rmSync(child, { force: true }); }
        catch (again) { note(again, 'rm', child); return undefined; }
      }
      note(error, 'rm', child);
      return undefined;
    }
  };
  const removeDir = child => {
    try { return fs.rmdirSync(child); }
    catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EACCES') && typeof fs.chmodSync === 'function') {
        try { fs.chmodSync(child, 0o777); return fs.rmdirSync(child); }
        catch (again) { note(again, 'rmdir', child); return undefined; }
      }
      note(error, 'rmdir', child);
      return undefined;
    }
  };
  const sweep = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { note(error, 'readdir', dir); return; }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) { sweep(child); removeDir(child); }
      else removeFile(child);
    }
    removeDir(dir);
  };
  const canSweep = typeof fs.readdirSync === 'function' && typeof fs.rmdirSync === 'function';
  let attempts = 0;
  // 整棵删一次做快速路径；不要让 rmSync 自己重试（只读/占用项会拖掉大部分 30 秒预算），后面逐层处理。
  let rmError = null;
  try { fs.rmSync(target, { recursive: true, force: true }); }
  catch (error) { rmError = error && error.code ? error.code : 'ERROR'; }
  for (;;) {
    attempts++;
    if (!fs.existsSync(target)) return { ok: true, home: target };
    failures = new Map();
    if (canSweep) sweep(target);
    if (!fs.existsSync(target)) return { ok: true, home: target };
    if (Date.now() - exitedAt >= timeoutMs) break;
    await sleep(pollMs);
  }
  // 残留：把还在的路径一起记下来，方便用户按提示手动删除；同时记下每轮真正失败的项与错误码。
  const remaining = [];
  let top = [];
  try { top = fs.readdirSync(target); } catch { /* 目录不可读时只写目录本身。 */ }
  try {
    const collect = (dir, depth) => {
      if (remaining.length >= 20 || depth > 6) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        remaining.push(child);
        if (entry.isDirectory() && !entry.isSymbolicLink()) collect(child, depth + 1);
        if (remaining.length >= 20) return;
      }
    };
    collect(target, 0);
  } catch { /* 目录不可读时只写目录本身。 */ }
  writeLeftover({ reason: 'locked', attempts, elapsedMs: Date.now() - exitedAt, rmError, top, blocked: [...failures.keys()].slice(0, 20), remaining });
  return { ok: false, home: target, leftover: true };
}

// 交给子进程执行的代码：只带 home 与父进程 pid（以及"等父进程管道关闭"），不用命令行拼值。
export function cleanupScript(home, parentPid) {
  return `(${cleanupHome.toString()})(${JSON.stringify({ home, parentPid, parentPipe: true })}).then(r => { if (!r || !r.ok) process.exitCode = 1; }).catch(e => { console.error(e && e.message ? e.message : String(e)); process.exitCode = 2; });`;
}
