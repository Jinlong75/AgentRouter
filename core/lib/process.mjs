import { execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { trace } from './trace.mjs';

const execute = promisify(execFile);
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// 诊断输出脱敏：临时目录写成 <TEMP>、用户目录写成 <HOME>；额外给出的路径（如某次测试的临时目录）也按 <TEMP> 处理。
// 只处理路径；环境变量值与密钥本来就不会出现在这些记录里。
export function redactPaths(text, extra = []) {
  let out = String(text ?? '');
  if (!out) return out;
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const swap = (from, to) => {
    if (!from) return;
    // 同一路径可能以反斜杠或正斜杠出现（命令行里两种都见过）。
    for (const variant of new Set([from, from.replace(/\\/g, '/'), from.replace(/\//g, '\\')])) {
      out = out.replace(new RegExp(escape(variant), 'gi'), to);
    }
  };
  // 系统临时目录可能以短路径（TEMP）或长路径（命令行里）出现，两种都按 <TEMP> 处理；用户目录最后替换。
  const temps = [tmpdir(), process.env.TEMP, process.env.TMP, ...(process.platform === 'win32' ? [join(homedir(), 'AppData', 'Local', 'Temp')] : [])];
  for (const value of [...extra, ...temps]) swap(value, '<TEMP>');
  for (const value of [homedir(), process.env.USERPROFILE, process.env.HOME]) swap(value, '<HOME>');
  return out;
}

// 单次平台查询同时取得创建时间、可执行文件名与命令行；可由调用方替换以隔离测试。
export async function processList(pid, platform = process.platform, timeout = 5000) {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) return [];
  const options = { windowsHide: true, shell: false, timeout, maxBuffer: 8 * 1024 * 1024 };
  if (platform === 'win32') {
    const filter = pid === undefined ? '' : ` -Filter 'ProcessId = ${pid}'`;
    const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process${filter} | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();name=$_.Name;command=$_.CommandLine} }) | ConvertTo-Json -Compress`;
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options);
    const value = JSON.parse(stdout.trim() || '[]');
    return (Array.isArray(value) ? value : [value]).map(p => ({ ...p, command: p.command ?? '' }));
  }
  const { stdout } = await execute('ps', [...(pid === undefined ? ['-A'] : ['-p', String(pid)]), '-o', 'pid=,ppid=,stat=,lstart=,args='], { ...options, env: { ...process.env, LC_ALL: 'C' } });
  return stdout.split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/);
    if (!m || m[3].startsWith('Z')) return [];
    const name = basename((m[5].match(/^\S+/) ?? [''])[0]);
    return [{ pid: +m[1], parent: +m[2], created: Date.parse(m[4]), name: name || null, command: m[5] }];
  });
}
// observe 只是把同一次查询的成功/失败与用时交给调用方做诊断；返回值与原来一样（失败仍返回 null）。
export async function processInfo(pid, platform = process.platform, observe) {
  const started = Date.now();
  try {
    const value = (await processList(pid, platform))[0] ?? null;
    observe?.({ ok: true, ms: Date.now() - started });
    return value;
  } catch (error) {
    observe?.({ ok: false, ms: Date.now() - started, error: error.message });
    return null;
  }
}
export async function processCreated(pid, platform = process.platform) {
  const info = await processInfo(pid, platform);
  return Number.isFinite(info?.created) ? info.created : null;
}
export async function taskAlive(start, { alive = pidAlive, created = processCreated } = {}) {
  if (!alive(start.pid)) return false;
  const time = await created(start.pid);
  return alive(start.pid) && (time === null || time <= start.started);
}

// 进程身份 = PID + 创建时间（协议第 9 节）：PID 相同、创建时间不同的是系统复用了这个 PID 的另一个进程。
// 创建时间是平台查询换算出的毫秒；同一个进程两次查询应完全相等，容差 1 ms 只用来吸收毫秒换算的舍入误差
// （实测：CIM 的毫秒与 GetProcessTimes 的毫秒之差为 0）。创建时间不是有限数时一律不算同一个进程。
export const CREATED_TOLERANCE_MS = 1;
export function sameIdentity(a, b) {
  return !!a && !!b && a.pid === b.pid && Number.isFinite(a.created) && Number.isFinite(b.created)
    && Math.abs(a.created - b.created) <= CREATED_TOLERANCE_MS;
}
// 快照 rows 里是否还有 { pid, created } 这个身份的进程。rows 是一次成功查询的结果；
// 查询失败要由调用方在取快照时抛出，不能传空数组冒充"已退出"。
export function identityAlive(rows, { pid, created }) {
  return rows.some(p => sameIdentity(p, { pid, created }));
}

// win32：在同一个进程句柄上核对创建时间并结束（协议第 9 节，069）。一次 PowerShell 调用里，对每个 { pid, created }：
// OpenProcess 打开句柄（持有句柄期间这个 PID 不会被别的进程复用）→ GetProcessTimes 取创建时间，
// 与 created 相差不超过 CREATED_TOLERANCE_MS 才 TerminateProcess，否则不动手。只用 PID 与创建时间两个整数，不按进程名。
// 返回 Map(pid → 'killed' | 'gone'（进程已退出）| 'reused'（PID 已被另一个创建时间的进程占用，没有结束）| 'denied' | 'error:<Win32 错误码>')。
// 整个调用失败（PowerShell 出错、超时、编译被拦）时抛出，由调用方决定退路。
const HANDLE_CSHARP = `using System; using System.Runtime.InteropServices;
public static class ArProc {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}`;
export function handleKillScript(targets) {
  for (const t of targets) {
    if (!Number.isSafeInteger(t?.pid) || t.pid <= 0 || !Number.isSafeInteger(t?.created)) throw Error('无效的目标进程');
  }
  const list = targets.map(t => `@{p=${t.pid};c=${t.created}}`).join(',');
  return `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
${HANDLE_CSHARP}
'@
$out=@(); foreach($t in @(${list})){ $r='gone'; $h=[ArProc]::OpenProcess(0x1001,$false,[uint32]$t.p)
 if($h -eq [IntPtr]::Zero){ $e=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); $r= if($e -eq 87){'gone'}elseif($e -eq 5){'denied'}else{'error:'+$e} }
 else { try { [long]$c=0;[long]$x=0;[long]$k=0;[long]$u=0; [uint32]$code=0
   [void][ArProc]::GetProcessTimes($h,[ref]$c,[ref]$x,[ref]$k,[ref]$u); [void][ArProc]::GetExitCodeProcess($h,[ref]$code)
   $ms=[long][math]::Floor(($c-116444736000000000)/10000)
   if($code -ne 259){$r='gone'} elseif([math]::Abs($ms-[long]$t.c) -gt ${CREATED_TOLERANCE_MS}){$r='reused'} elseif([ArProc]::TerminateProcess($h,1)){$r='killed'} else {$e=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); $r= if($e -eq 5){'denied'}else{'error:'+$e}}
  } finally { [void][ArProc]::CloseHandle($h) } }
 $out+=@{pid=$t.p;result=$r} }
$out | ConvertTo-Json -Compress`;
}
export async function terminateByIdentity(targets, { timeout = 10000, executeFile = execute } = {}) {
  const script = handleKillScript(targets);
  const { stdout } = await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, shell: false, timeout, maxBuffer: 1024 * 1024 });
  const value = JSON.parse(String(stdout).trim() || '[]');
  return new Map((Array.isArray(value) ? value : [value]).map(row => [row.pid, row.result]));
}

// 诊断用的进程身份：只做记录，不参与判断。AR_CORE_TRACE=1 时才真的写出。
const describeProcess = p => `pid=${p.pid} parent=${p.parent ?? '（未知）'} name=${p.name ?? '（未知）'} created=${p.created ?? '（未知）'}`;
const traceNoneAlive = (pid, tree) => {
  for (const p of tree) trace(`进程树结束 目标 pid=${pid} 结束结果 ${describeProcess(p)} 终止结果=已退出 终止后仍存活=否`);
  trace(`进程树结束 目标 pid=${pid} 结束后仍存活的进程：无（初次快照树上 ${tree.length} 个进程都已退出）`);
};
const traceStillAlive = (pid, tree, surviving) => {
  for (const p of tree) {
    const stillThere = surviving.some(q => q.pid === p.pid && q.created === p.created);
    trace(`进程树结束 目标 pid=${pid} 结束结果 ${describeProcess(p)} 终止结果=${stillThere ? '未能结束' : '已退出'} 终止后仍存活=${stillThere ? '是' : '否'}`);
  }
  for (const p of surviving) trace(`进程树结束 目标 pid=${pid} 结束后仍存活的进程 ${describeProcess(p)}`);
};

// 先保留整棵树的身份，再结束并等到全部退出；总时限包括平台查询。
// 子孙与"已退出"一律按身份（PID + 创建时间）认定（协议第 9 节，Stage05 069）：结束每个进程之前先用新快照核对身份还在，
// 身份不在（已退出或 PID 被复用）就不结束；结束后只有身份仍在的才算存活。
// settleMs：结束后先只看 PID 存活这么久，之后 PID 仍存活才付一次快照查询的代价去核对身份。
// terminate（win32）：在同一个进程句柄上核对身份并结束（terminateByIdentity）；没有注入 executeFile 时默认用它，
// 句柄方式整体失败时退回"结束前立刻重新取快照核对 + taskkill"。注入了 executeFile（测试）时直接走 taskkill 路径。
export async function killProcessTree(pid, { platform = process.platform, list = processList, executeFile = execute, alive = pidAlive, timeout = 10000, expectedCreated, settleMs = 500, terminate = executeFile === execute ? terminateByIdentity : null } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw Error('无效的目标进程');
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  const snapshot = await list(undefined, platform, remaining());
  trace(`进程树结束 目标 pid=${pid} 初次快照 ${snapshot.length} 项`);
  const root = snapshot.find(p => p.pid === pid);
  if (!root) {
    // 只查一次存活（原来的判断），结果同时用于记录。
    const targetAlive = alive(pid);
    trace(`进程树结束 目标 pid=${pid} 初次快照里没有目标，目标${targetAlive ? '仍存活（无法核对进程树）' : '已退出'}`);
    if (targetAlive) throw Error('无法核对进程树');
    return;
  }
  if (expectedCreated !== undefined && root.created !== expectedCreated) {
    trace(`进程树结束 目标 pid=${pid} 进程身份已经变化（期望 created=${expectedCreated}，实际 ${describeProcess(root)}）`);
    throw Error('进程身份已经变化');
  }
  const tree = [root], seen = new Set([pid]);
  for (let i = 0; i < tree.length; i++) for (const p of snapshot) {
    if (p.parent === tree[i].pid && !seen.has(p.pid) && p.created >= tree[i].created) { tree.push(p); seen.add(p.pid); }
  }
  trace(`进程树结束 目标 pid=${pid} 初次快照里的进程树 ${tree.length} 项`);
  for (const p of tree) trace(`进程树结束 目标 pid=${pid} 初次快照里的进程树 ${describeProcess(p)}`);
  let failure;
  // "第一次快照之后才出现"按身份判断：初次快照里没有这个身份（PID + 创建时间）的进程才可能是补杀对象。
  const identityKey = p => `${p.pid}:${p.created}`;
  const known = new Set(snapshot.map(identityKey));
  // 取一次新快照；查询失败重试一次（时限内），仍失败就抛出——不能把"查不到"当成"已退出"。
  const takeSnapshot = async () => {
    try { return await list(undefined, platform, remaining()); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      trace(`进程树结束 目标 pid=${pid} 取快照出错（${error.message}），重试一次`);
      return list(undefined, platform, remaining());
    }
  };
  // 结束前核对：只留下身份仍在快照里的进程；其余（已退出或 PID 已被复用）不结束。
  const stillPresent = (items, current, label) => items.filter(p => {
    if (identityAlive(current, p)) return true;
    trace(`进程树结束 目标 pid=${pid} ${label}前核对：${describeProcess(p)} 身份已不在（已退出或 PID 已被复用），不对这个 PID 动手`);
    return false;
  });
  // 补充轮：新出现的进程 p 的父 PID 是树里某个 t 的 PID 且 p 不早于 t 创建时，还要满足其一才算子孙——
  // ① 当前快照里 t 的身份仍在；② 当前快照里已经没有这个 PID；③ 这个 PID 被复用了但 p 在复用之前创建。
  // 父 PID 已被另一个进程占用、且 p 是在复用之后才创建的，不是子孙。
  const isTreeChild = (p, current) => tree.some(t => {
    if (t.pid !== p.parent || !(p.created >= t.created)) return false;
    const now = current.find(q => q.pid === t.pid);
    return !now || sameIdentity(now, t) || p.created < now.created;
  });
  // 结束后仍在的进程：PID 存活且身份仍在快照里的才算（PID 存活但身份不在按已退出处理）。
  // 快照查询失败无法确认，按仍存活处理（保守）。
  const stillThere = async (items, since) => {
    const byPid = items.filter(p => alive(p.pid));
    if (!byPid.length || Date.now() - since < settleMs) return byPid;
    try {
      const current = await list(undefined, platform, remaining());
      return byPid.filter(p => {
        if (identityAlive(current, p)) return true;
        trace(`进程树结束 目标 pid=${pid} ${describeProcess(p)} pidAlive 为真但身份不在（PID 已被复用），按已退出处理`);
        return false;
      });
    } catch (error) {
      trace(`进程树结束 目标 pid=${pid} 无法确认身份（${error.message}），按仍存活处理`);
      return byPid;
    }
  };
  const taskkill = (pids, label) => {
    const args = [...pids.flatMap(p => ['/PID', String(p.pid)]), '/F'];
    return executeFile('taskkill.exe', args, { windowsHide: true, shell: false, timeout: remaining() })
      .then(() => trace(`进程树结束 目标 pid=${pid} ${label} ${pids.length} 个`))
      .catch(error => { failure ??= error; trace(`进程树结束 目标 pid=${pid} ${label} ${pids.length} 个出错：${error.message}`); });
  };
  // 结束一批进程（每个 /PID 都不带 /T）。首选句柄方式：核对创建时间与结束在同一个句柄上完成，不留 PID 被复用的空档；
  // 句柄方式整体失败时退回 taskkill：verify 为真时先用新快照核对身份，身份不在的不动手（剩下的空档是快照返回到 taskkill 启动之间）。
  const killBatch = async (items, label, { verify = true } = {}) => {
    if (terminate) {
      try {
        const results = await terminate(items.map(p => ({ pid: p.pid, created: p.created })), { timeout: remaining() });
        for (const p of items) {
          const result = results.get(p.pid);
          if (result === 'killed') continue;
          if (result === 'gone' || result === 'reused') trace(`进程树结束 目标 pid=${pid} ${label}前核对：${describeProcess(p)} ${result === 'gone' ? '已退出' : 'PID 已被另一个创建时间的进程占用'}，没有结束`);
          else { failure ??= Error(`结束进程 ${p.pid} 失败（${result ?? '没有结果'}）`); trace(`进程树结束 目标 pid=${pid} ${label} ${describeProcess(p)} 出错：${result ?? '没有结果'}`); }
        }
        trace(`进程树结束 目标 pid=${pid} ${label} ${items.length} 个（句柄方式）`);
        return;
      } catch (error) {
        trace(`进程树结束 目标 pid=${pid} ${label}：句柄方式出错（${error.message}），改用 taskkill`);
      }
    }
    if (!verify) return taskkill(items, label);
    const present = stillPresent(items, await takeSnapshot(), label);
    if (present.length) return taskkill(present, label);
    // 子孙常随根一起退出（libuv 把子进程放进随父进程关闭的作业对象），没有进程可结束时也写一行，保持追踪里"结束根 → 根已结束 → 结束子孙"的顺序。
    trace(`进程树结束 目标 pid=${pid} ${label} 0 个（${items.length} 个进程在结束前核对时身份都已不在）`);
  };
  try {
    if (platform === 'win32') {
      // 先只结束根：派发进程收不到信号，就不会在执行者先退出后补写 end。
      // taskkill 退路下根的身份刚由上面的初次快照核对过（expectedCreated），与 taskkill 之间只隔几毫秒，不再多取一次快照。
      if (alive(pid)) await killBatch([root], '结束根', { verify: false });
      // 根结束不了也要继续结束子孙，最后按时限抛错（对外行为与原来一致）。
      // 根是否退出按身份认定：PID 被别的进程复用不算根还活着。
      const waitStart = Date.now();
      let rootStays = [];
      while (Date.now() < deadline) {
        rootStays = await stillThere([root], waitStart);
        if (!rootStays.length) break;
        await delay(Math.min(50, remaining()));
      }
      if (rootStays.length) trace(`进程树结束 目标 pid=${pid} 根在时限内没有退出，继续结束子孙`);
      else trace(`进程树结束 目标 pid=${pid} 根已结束`);
      // 再结束初次快照里的其余子孙；每个 /PID 都不带 /T。结束前用新快照核对身份，初次快照之后已退出、PID 被复用的不结束。
      const descendants = tree.filter(p => p.pid !== pid);
      if (descendants.length) await killBatch(descendants, '结束子孙');
      // 补充轮：根结束前刚派生的进程不在初次快照里，重新取快照后一并结束（最多 2 轮）。
      // 这个快照既用来认出新子孙，也是结束它们之前的身份核对。
      for (let round = 0; round < 2 && Date.now() < deadline; round++) {
        const current = await takeSnapshot();
        const candidates = current.filter(p => !known.has(identityKey(p)) && tree.some(t => t.pid === p.parent));
        const fresh = candidates.filter(p => isTreeChild(p, current));
        for (const p of candidates) {
          if (!fresh.includes(p)) trace(`进程树结束 目标 pid=${pid} 补充轮：${describeProcess(p)} 的父 PID 虽在树里，但父进程的身份已不在或它是在 PID 复用之后创建的，不算子孙，不结束`);
        }
        if (!fresh.length) break;
        for (const p of fresh) { tree.push(p); known.add(identityKey(p)); }
        // 句柄方式在结束时再次核对；taskkill 退路下 fresh 刚从上面的快照里取得，不再多取一次。
        await killBatch(fresh, '补充结束', { verify: false });
      }
    } else {
      // 先逐层暂停并重新扫描，纳入初次快照之后刚派生的子孙。
      try {
        for (let i = 0; i < tree.length; i++) {
          if (Date.now() >= deadline) throw Error('等待进程退出超时');
          const p = tree[i];
          try { process.kill(p.pid, 'SIGSTOP'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
          for (const q of await list(undefined, platform, remaining())) {
            if (q.parent === p.pid && !seen.has(q.pid) && q.created >= p.created) { tree.push(q); seen.add(q.pid); }
          }
        }
        // 同样先结束根，再按叶到根结束其余子孙（派发进程来不及补写 end）。
        const kill = p => {
          try { process.kill(p.pid, 'SIGKILL'); trace(`进程树结束 目标 pid=${pid} SIGKILL ${describeProcess(p)} 结果=已发送`); }
          catch (e) {
            trace(`进程树结束 目标 pid=${pid} SIGKILL ${describeProcess(p)} 结果=${e.code === 'ESRCH' ? '进程已退出' : `失败（${e.message}）`}`);
            if (e.code !== 'ESRCH') failure ??= e;
          }
        };
        kill(root);
        trace(`进程树结束 目标 pid=${pid} 结束根 1 个`);
        // 等根按身份退出（僵尸进程不在快照里，算已退出）；时限内没退出也继续结束子孙，最后按时限抛错。
        let rootStays = true;
        while (rootStays && Date.now() < deadline) {
          try { rootStays = identityAlive(await list(undefined, platform, remaining()), root); }
          catch { /* 查询失败无法确认，按仍存活处理，到时限为止。 */ }
          if (rootStays) await delay(Math.min(50, remaining()));
        }
        if (rootStays) trace(`进程树结束 目标 pid=${pid} 根在时限内没有退出，继续结束子孙`);
        else trace(`进程树结束 目标 pid=${pid} 根已结束`);
        const descendants = [...tree].reverse().filter(p => p.pid !== root.pid);
        for (const p of descendants) kill(p);
        if (descendants.length) trace(`进程树结束 目标 pid=${pid} 结束子孙 ${descendants.length} 个`);
      } finally {
        // 权限或查询失败也不能让仍存活的进程永久暂停。
        for (const p of tree) { try { process.kill(p.pid, 'SIGCONT'); } catch { /* 已退出。 */ } }
      }
    }
  } catch (error) { failure = error; trace(`进程树结束 目标 pid=${pid} 终止过程出错：${error.message}`); }
  // 判断与时限不变：全部退出就返回；到时限仍未退出就抛错。survivors 只是同一轮检查的结果，用于记录。
  // win32 的存活判断按身份：PID 存活且（超过 settleMs 后）快照里仍有同一创建时间的进程才算存活（原 065 B 只对根做，现在对整棵树）。
  // POSIX 分支每轮已经按身份比对。
  let survivors = [];
  const checkStart = Date.now();
  do {
    if (platform === 'win32') survivors = await stillThere(tree, checkStart);
    else {
      const current = await list(undefined, platform, remaining());
      survivors = tree.filter(p => identityAlive(current, p));
    }
    if (!survivors.length) { traceNoneAlive(pid, tree); return; }
    if (Date.now() >= deadline) break;
    await delay(Math.min(50, remaining()));
  } while (Date.now() < deadline);
  traceStillAlive(pid, tree, survivors);
  throw Error(failure?.message ?? '等待进程退出超时');
}
