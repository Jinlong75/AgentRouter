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
export async function killProcessTree(pid, { platform = process.platform, list = processList, executeFile = execute, alive = pidAlive, timeout = 10000, expectedCreated } = {}) {
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
  // "第一次快照之后才出现"按 PID 判断：初次快照里没有、父进程在树里的进程才补杀。
  const initialPids = new Set(snapshot.map(p => p.pid));
  const taskkill = (pids, label) => {
    const args = [...pids.flatMap(p => ['/PID', String(p.pid)]), '/F'];
    return executeFile('taskkill.exe', args, { windowsHide: true, shell: false, timeout: remaining() })
      .then(() => trace(`进程树结束 目标 pid=${pid} ${label} ${pids.length} 个`))
      .catch(error => { failure ??= error; trace(`进程树结束 目标 pid=${pid} ${label} ${pids.length} 个出错：${error.message}`); });
  };
  try {
    if (platform === 'win32') {
      // 先只结束根：派发进程收不到信号，就不会在执行者先退出后补写 end。
      if (alive(pid)) await taskkill([root], '结束根');
      // 根结束不了也要继续结束子孙，最后按时限抛错（对外行为与原来一致）。
      while (alive(pid) && Date.now() < deadline) await delay(Math.min(50, remaining()));
      if (alive(pid)) trace(`进程树结束 目标 pid=${pid} 根在时限内没有退出，继续结束子孙`);
      else trace(`进程树结束 目标 pid=${pid} 根已结束`);
      // 再结束初次快照里的其余子孙；每个 /PID 都不带 /T。
      const descendants = tree.filter(p => p.pid !== pid);
      if (descendants.length) await taskkill(descendants, '结束子孙');
      // 补充轮：根结束前刚派生的进程不在初次快照里，重新取快照后一并结束（最多 2 轮）。
      for (let round = 0; round < 2 && Date.now() < deadline; round++) {
        const current = await list(undefined, platform, remaining());
        const fresh = current.filter(p => !initialPids.has(p.pid) && !seen.has(p.pid)
          && tree.some(t => t.pid === p.parent && p.created >= t.created));
        if (!fresh.length) break;
        for (const p of fresh) { tree.push(p); seen.add(p.pid); }
        await taskkill(fresh, '补充结束');
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
        for (const p of [...tree].reverse()) if (p.pid !== root.pid) kill(p);
      } finally {
        // 权限或查询失败也不能让仍存活的进程永久暂停。
        for (const p of tree) { try { process.kill(p.pid, 'SIGCONT'); } catch { /* 已退出。 */ } }
      }
    }
  } catch (error) { failure = error; trace(`进程树结束 目标 pid=${pid} 终止过程出错：${error.message}`); }
  // 判断与时限不变：全部退出就返回；到时限仍未退出就抛错。survivors 只是同一轮检查的结果，用于记录。
  let survivors = [];
  do {
    if (platform === 'win32') survivors = tree.filter(p => alive(p.pid));
    else {
      const current = await list(undefined, platform, remaining());
      survivors = tree.filter(p => current.some(q => q.pid === p.pid && q.created === p.created));
    }
    if (!survivors.length) { traceNoneAlive(pid, tree); return; }
    if (Date.now() >= deadline) break;
    await delay(Math.min(50, remaining()));
  } while (Date.now() < deadline);
  traceStillAlive(pid, tree, survivors);
  throw Error(failure?.message ?? '等待进程退出超时');
}
