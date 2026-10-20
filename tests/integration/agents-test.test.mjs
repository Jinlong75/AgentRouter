import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { main } from '../../core/lib/cli.mjs';
import { redactPaths } from '../../core/lib/process.mjs';

// 失败现场用的完整进程快照（一次 PowerShell 查询）：pid、父 PID、创建时间、可执行文件名、命令行（脱敏）。
// 必须异步调用：同步查询会阻塞事件循环、推迟 close 事件，让用时测量本身失真。
function processSnapshotAsync() {
  if (process.platform !== 'win32') return Promise.resolve({ processes: null, reason: '（非 Windows，不查）' });
  // 先固定输出编码为无 BOM 的 UTF-8：否则中文 Windows 上命令行里的中文会变成乱码。
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();name=$_.Name;command=$_.CommandLine} }) | ConvertTo-Json -Compress`;
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error) { resolve({ processes: null, reason: `查询失败（${error.code ?? error.message}）` }); return; }
        try {
          const value = JSON.parse(String(stdout).trim() || '[]');
          resolve({ processes: (Array.isArray(value) ? value : [value]).map(p => ({ ...p, command: p.command ?? '' })) });
        } catch (parseError) { resolve({ processes: null, reason: `结果解析失败（${parseError.message}）` }); }
      });
  });
}
// 沿父 PID 链判断是否通向 rootPid（默认是测试进程本身；它的子进程也在链上）。
function ancestry(proc, byPid, rootPid = globalThis.process.pid) {
  const chain = [];
  for (let current = proc.pid, guard = 0; guard < 64; guard++) {
    chain.push(current);
    if (current === rootPid) return { inside: '是', chain };
    const node = byPid.get(current);
    if (!node) return { inside: '否', chain, broken: current };
    current = node.parent;
  }
  return { inside: '否', chain, broken: '（父链成环或过长）' };
}
// 单个进程的身份：是否在 ar 子进程树内、创建时间是否晚于 killProcessTree 的初次快照（取不到写"未知"）。
function describeProcess(proc, byPid, rootPid, initialAt) {
  const inTree = proc.pid === rootPid || ancestry(proc, byPid, rootPid).inside === '是';
  const newer = initialAt == null || !Number.isFinite(proc.created) ? '未知' : (proc.created > initialAt ? '是' : '否');
  return `pid=${proc.pid} parent=${proc.parent ?? '（未知）'} name=${proc.name ?? '（未知）'} created=${proc.created ?? '（未知）'}`
    + ` 在 ar 子进程树内=${inTree ? '是' : '否'} 晚于初次快照=${newer} 命令行=${redactPaths(proc.command)}`;
}
// 追踪行太多时保留开头与结尾，中间注明省略数。
function limitLines(lines, max) {
  if (lines.length <= max) return lines;
  const head = Math.ceil(max / 2), tail = max - head;
  return [...lines.slice(0, head), `（省略 ${lines.length - max} 行）`, ...lines.slice(-tail)];
}
// 命令行里带着这个临时目录名的进程：完整身份、是否在本测试的进程树内。
function findHolders(name, snapshot) {
  if (!snapshot.processes) return snapshot.reason;
  const byPid = new Map(snapshot.processes.map(p => [p.pid, p]));
  const list = snapshot.processes.filter(p => String(p.command).includes(name));
  if (!list.length) return '没有';
  return list.map(p => {
    const tree = ancestry(p, byPid);
    return `pid=${p.pid} parent=${p.parent} name=${p.name ?? '（未知）'} created=${p.created ?? '（未知）'} 在本测试进程树内=${tree.inside}`
      + `${tree.broken === undefined ? '' : `（父链断在 pid=${tree.broken}）`} 命令行=${redactPaths(p.command)}`;
  }).join('；');
}

// 在子进程里跑 ar，并打开 AR_CORE_TRACE=1：标准输出取 JSON，标准错误留着附进失败现场。
// 子进程开始后 6 / 16 秒仍未 close 时各取一次进程快照（只诊断用，异步、串行，最多 2 次）；
// 快照任务放进 pendingSnapshots，由失败现场按需等待（每次快照自身最多 30 秒）。
function runAr(argv, { env, cwd, started = Date.now(), knownDirs = new Set(), snapshots = [] } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.resolve('core/ar.mjs'), ...argv], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    const times = { spawnedAt: null, exitAt: null, closeAt: null, exitCode: null, signal: null };
    const pendingSnapshots = [];
    const timers = [];
    let stdout = '', stderr = '';
    let closed = false;
    let snapshotChain = Promise.resolve();
    // 触发时立刻记下时刻与新出现的临时目录名，真实的 PowerShell 查询串行排在前一次之后。
    const snapshotNow = () => {
      if (closed) return;
      const dirs = (() => {
        try { return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('ar-agent-test-') && !knownDirs.has(n)); }
        catch { return []; }
      })();
      const entry = { at: Date.now() - started, dirs, processes: null, reason: null };
      snapshots.push(entry);
      snapshotChain = snapshotChain.then(async () => Object.assign(entry, await processSnapshotAsync()));
      pendingSnapshots.push(snapshotChain);
    };
    child.on('spawn', () => {
      times.spawnedAt = Date.now();
      for (const delay of [6000, 16000]) {
        const timer = setTimeout(snapshotNow, delay);
        timer.unref();
        timers.push(timer);
      }
    });
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({
      code: null, stdout, stderr, spawnError: error.message, times, pendingSnapshots, childPid: child.pid ?? null }));
    child.on('exit', (code, signal) => { times.exitAt = Date.now(); times.exitCode = code; times.signal = signal; });
    child.on('close', code => {
      closed = true;
      times.closeAt = Date.now();
      for (const timer of timers) clearTimeout(timer);
      resolve({ code, stdout, stderr, times, pendingSnapshots, childPid: child.pid ?? null });
    });
  });
}

// 只用 fake 适配器，不真实调用任何付费服务；隔离的 AGENT_ROUTER_HOME。
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar agents-test 测试 '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { AGENT_ROUTER_HOME: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const call = async (argv, extra = {}) => {
    const out = [];
    const code = await main(argv, { scriptPath: path.resolve('core/ar.mjs'), env, cwd: home, out: s => out.push(s), ...extra });
    return { code, out, json: argv.includes('--json') ? JSON.parse(out.at(-1)) : null };
  };
  return { home, env, call };
}

test('agents test：成功（exit 0 且有 OK）写 agent-tests.json，list 读出 lastTest', async t => {
  const { home, call } = setup(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'ok', profiles: {
    ok: { adapter: 'fake', label: '假执行者', events: [{ kind: 'say', text: 'OK' }, { kind: 'turn', usage: { input: 10, output: 2 } }], report: 'OK\n' },
  } }));
  const r = await call(['agents', 'test', 'ok', '--json']);
  assert.equal(r.code, 0); assert.equal(r.out.length, 1);
  assert.equal(r.json.ok, true); assert.equal(r.json.exit, 0); assert.equal(r.json.timedOut, false);
  assert.equal(r.json.report, 'OK'); assert.deepEqual(r.json.usage, { input: 10, output: 2 });
  assert.equal(r.json.version, 'fake-agent 1.0'); assert.equal(r.json.model, null);
  assert.equal(typeof r.json.seconds, 'number');
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'agent-tests.json'), 'utf8')).ok;
  assert.equal(saved.ok, true); assert.equal(saved.version, 'fake-agent 1.0'); assert.equal(saved.error, null);
  assert.equal(typeof saved.at, 'number'); assert.equal(typeof saved.seconds, 'number');
  const list = (await call(['agents', 'list', '--json'])).json.agents;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].lastTest, saved, 'list 的 lastTest 来自 agent-tests.json');
  assert.ok(!fs.existsSync(path.join(home, 'runs.jsonl')), '不写入真实任务清单');
});

test('agents test：失败（exit 非 0 且有 error 事件）', async t => {
  const { home, call } = setup(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'bad', profiles: {
    bad: { adapter: 'fake', label: '假执行者', events: [{ kind: 'error', text: '接口返回 401' }], report: '没有完成\n', exit: 3 },
  } }));
  const r = await call(['agents', 'test', 'bad', '--json']);
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false); assert.equal(r.json.exit, 3); assert.equal(r.json.timedOut, false);
  assert.match(r.json.error, /401/);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'agent-tests.json'), 'utf8')).bad;
  assert.equal(saved.ok, false); assert.match(saved.error, /401/);
  assert.ok(!fs.existsSync(path.join(home, 'runs.jsonl')));
});

test('agents test：超时 --timeout 2 结束进程树，临时目录删除', async t => {
  const { home, env } = setup(t);
  // delayMs 足够大：不被 killProcessTree 结束的话，回放要很久才完成。
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'slow', profiles: {
    slow: { adapter: 'fake', label: '慢执行者', events: [{ kind: 'say', text: '开始' }, { kind: 'say', text: 'OK' }], report: 'OK\n', delayMs: 30000 },
  } }));
  const dirs = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('ar-agent-test-'));
  const before = new Set(dirs());
  const started = Date.now();
  // 在子进程里跑并打开 AR_CORE_TRACE=1：失败时附上 agents test 各阶段的记录、进程快照与残留目录诊断（判断不变）。
  const snapshots = [];
  const run = await runAr(['agents', 'test', 'slow', '--timeout', '2', '--json'],
    { env: { ...process.env, ...env, AR_CORE_TRACE: '1' }, cwd: home, started, knownDirs: before, snapshots });
  // 用时仍按 close 事件到达的时刻算；残留目录仍按第一次观察为准（诊断里再等 5 秒看是否消失）。
  const elapsed = (run.times.closeAt ?? Date.now()) - started;
  const leftover = [...new Set(dirs())].filter(n => !before.has(n));
  const r = { code: run.code, json: run.stdout.trim() ? JSON.parse(run.stdout.trim().split('\n').at(-1)) : null };

  // 失败现场：第一次需要时生成一次，后面复用；生成失败也不能盖住原来的断言错误。
  // 快照还在进行时最多再等它 30 秒（快照自身的超时），不另加等待。
  let cached = null;
  const diagnostic = () => (cached ??= buildDiagnostic());
  async function buildDiagnostic() {
    try {
      await Promise.all(run.pendingSnapshots);
      const traceLines = run.stderr.split('\n').filter(line => line.includes('[ar-trace]')
        && /agents test|进程树结束|命令结束|活动资源|进程退出|等待子进程关闭/.test(line));
      const traceAt = label => {
        const line = [...traceLines].reverse().find(text => text.includes(label));
        const match = line?.match(/@(\d+)/);
        return match ? Number(match[1]) : null;
      };
      // killProcessTree 的初次快照时刻（判断"初次快照之后才出现"的进程）；命令结束的墙上时刻（与 close 对齐）。
      const initialAt = traceAt('初次快照');
      const commandEndAt = traceAt('命令结束 ');
      const times = run.times;
      const relative = value => value == null ? '（未知）' : `${value - started}ms`;
      const timing = [
        `ar 子进程：pid=${run.childPid ?? '（无）'} spawn=${relative(times.spawnedAt)} exit=${relative(times.exitAt)} close=${relative(times.closeAt)}`
          + (times.exitAt == null ? '' : `（exit=${times.exitCode} signal=${times.signal ?? '（无）'}）`),
        `追踪里"命令结束"的墙上时刻与 close 的差：${commandEndAt == null || times.closeAt == null ? '（未知）' : `${times.closeAt - commandEndAt}ms`}`,
      ].join('\n');
      // 每次快照列出：ar 子进程及其后代（沿父 PID 链），以及命令行里带着新临时目录名的进程。
      const snapshotText = (entry, label) => {
        if (!entry) return `${label}：没有取（子进程在此之前已 close）`;
        if (!entry.processes) return `${label}（距开始 ${entry.at}ms）：${entry.reason ?? '查询失败'}`;
        const byPid = new Map(entry.processes.map(p => [p.pid, p]));
        const related = entry.processes.filter(p => p.pid === run.childPid || ancestry(p, byPid, run.childPid).inside === '是'
          || entry.dirs.some(name => String(p.command).includes(name)));
        if (!related.length) return `${label}（距开始 ${entry.at}ms，共 ${entry.processes.length} 项）：没有 ar 子进程、其后代或带临时目录名的进程`;
        return [`${label}（距开始 ${entry.at}ms，共 ${entry.processes.length} 项）：`,
          ...related.map(p => `  ${describeProcess(p, byPid, run.childPid, initialAt)}`)].join('\n');
      };
      // close 之后再取一次快照：6 / 16 秒快照里出现过的进程还有哪些活着。
      const survivorText = async () => {
        const seen = new Map();
        for (const entry of snapshots) {
          if (!entry.processes) continue;
          const before = new Map(entry.processes.map(p => [p.pid, p]));
          // 只收当时列进快照的相关进程（ar 子进程及后代、命令行带新临时目录名的进程），不是整台机器。
          for (const proc of entry.processes) {
            if (proc.pid === run.childPid || ancestry(proc, before, run.childPid).inside === '是'
              || entry.dirs.some(name => String(proc.command).includes(name))) seen.set(proc.pid, proc);
          }
        }
        if (!snapshots.length) return 'close 后快照：没有 6 / 16 秒快照';
        if (!seen.size) return 'close 后快照：6 / 16 秒快照里没有进程';
        const after = await processSnapshotAsync();
        if (!after.processes) return `close 后快照：${after.reason}`;
        const byPid = new Map(after.processes.map(p => [p.pid, p]));
        const alive = [...seen.values()].filter(p => {
          const now = byPid.get(p.pid);
          return now && (p.created == null || now.created == null || p.created === now.created);
        });
        return alive.length
          ? ['close 后快照（6 / 16 秒快照里仍存活的进程）：', ...alive.map(p => `  ${describeProcess(p, byPid, run.childPid, initialAt)}`)].join('\n')
          : 'close 后快照：6 / 16 秒快照里的进程都已退出';
      };
      // 原有的残留目录诊断（031）：是谁的、还剩哪些文件、相关进程、5 秒后是否消失。
      let leftoverText = '残留目录（031 诊断）：无';
      if (leftover.length) {
        const owner = n => { try { return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), n, 'home', 'config.json'), 'utf8')).defaultProfile ?? '（无）'; } catch (e) { return `读不到（${e.code ?? e.message}）`; } };
        const contents = n => { try { const all = fs.readdirSync(path.join(os.tmpdir(), n), { recursive: true }).map(String); return `${all.length} 项：${all.slice(0, 15).join(', ') || '（空目录）'}`; } catch (e) { return `读不到（${e.code ?? e.message}）`; } };
        const holdersSnapshot = await processSnapshotAsync();
        const holders = n => findHolders(n, holdersSnapshot);
        const owners = leftover.map(n => `${n}=${owner(n)}（${contents(n)}；相关进程 ${holders(n)}）`).join('、');
        await new Promise(resolve => setTimeout(resolve, 5000));
        leftoverText = `残留目录（031 诊断）：${owners}\n5 秒后仍在：${leftover.filter(n => fs.existsSync(path.join(os.tmpdir(), n))).map(n => `${n}（${contents(n)}；相关进程 ${holders(n)}）`).join('、') || '（都消失了）'}`;
      }
      return [
        '诊断（用例失败现场）：',
        `用例用时（按 close 到达）：${elapsed}ms`,
        timing,
        `相关追踪（${traceLines.length} 行，最多 150 行）：`,
        ...limitLines(traceLines, 150),
        snapshotText(snapshots[0], '6 秒快照'),
        snapshotText(snapshots[1], '16 秒快照'),
        await survivorText(),
        leftoverText,
      ].join('\n');
    } catch (error) {
      return `诊断生成失败：${error.message}`;
    }
  }
  // 每条断言失败时都附上同一份诊断；断言条件与时限不变。
  // node:test 打印的是断言在构造时抓下的 stack，所以 message 与 stack 都要追加。
  const check = async fn => {
    try { fn(); }
    catch (error) {
      const text = await diagnostic();
      error.message = `${error.message}\n\n${text}`;
      if (typeof error.stack === 'string') error.stack = `${error.stack}\n\n${text}`;
      throw error;
    }
  };

  await check(() => assert.equal(r.code, 1));
  await check(() => { assert.equal(r.json?.ok, false); assert.equal(r.json?.timedOut, true); });
  await check(() => assert.match(r.json?.error ?? '', /超过 2 秒没有结束，测试已停止/));
  await check(() => assert.ok(elapsed < 20000, `超时后应立刻结束进程树（实际用时 ${elapsed}ms）${run.spawnError ?? ''}`));
  await check(() => assert.deepEqual(leftover, [], '临时目录已删除'));
  await check(() => assert.ok(!fs.existsSync(path.join(home, 'runs.jsonl'))));
});
