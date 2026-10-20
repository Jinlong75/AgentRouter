import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { main } from '../../core/lib/cli.mjs';
import { redactPaths } from '../../core/lib/process.mjs';

// 失败现场用的完整进程快照（一次 PowerShell 查询）：pid、父 PID、创建时间、可执行文件名、命令行（脱敏）。
function processSnapshot() {
  if (process.platform !== 'win32') return { processes: null, reason: '（非 Windows，不查）' };
  try {
    const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | ForEach-Object { @{pid=$_.ProcessId;parent=$_.ParentProcessId;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds();name=$_.Name;command=$_.CommandLine} }) | ConvertTo-Json -Compress`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }).trim();
    const value = JSON.parse(out || '[]');
    return { processes: (Array.isArray(value) ? value : [value]).map(p => ({ ...p, command: p.command ?? '' })) };
  } catch (error) { return { processes: null, reason: `查询失败（${error.code ?? error.message}）` }; }
}
// 沿父 PID 链判断是否通向测试进程本身（它的子进程也在链上）。
function ancestry(proc, byPid) {
  const chain = [];
  for (let current = proc.pid, guard = 0; guard < 64; guard++) {
    chain.push(current);
    if (current === globalThis.process.pid) return { inside: '是', chain };
    const node = byPid.get(current);
    if (!node) return { inside: '否', chain, broken: current };
    current = node.parent;
  }
  return { inside: '否', chain, broken: '（父链成环或过长）' };
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
function runAr(argv, { env, cwd } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.resolve('core/ar.mjs'), ...argv], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: null, stdout, stderr, spawnError: error.message }));
    child.on('close', code => resolve({ code, stdout, stderr }));
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
  const start = Date.now();
  // 在子进程里跑并打开 AR_CORE_TRACE=1：失败时附上 agents test 各阶段的记录（判断不变，仍看退出码与残留）。
  const run = await runAr(['agents', 'test', 'slow', '--timeout', '2', '--json'], { env: { ...process.env, ...env, AR_CORE_TRACE: '1' }, cwd: home });
  const elapsed = Date.now() - start;
  const r = { code: run.code, json: run.stdout.trim() ? JSON.parse(run.stdout.trim().split('\n').at(-1)) : null };
  assert.equal(r.code, 1);
  assert.equal(r.json?.ok, false); assert.equal(r.json?.timedOut, true);
  assert.match(r.json?.error ?? '', /超过 2 秒没有结束，测试已停止/);
  assert.ok(elapsed < 20000, `超时后应立刻结束进程树（实际用时 ${elapsed}ms）${run.spawnError ?? ''}`);
  const leftover = [...new Set(dirs())].filter(n => !before.has(n));
  let note = '';
  if (leftover.length) {
    // 诊断（PR #5 CI）：残留目录是谁的（config.json 的 defaultProfile；本用例是 slow）、5 秒后是否消失。判断仍以上面第一次观察为准。
    const owner = n => { try { return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), n, 'home', 'config.json'), 'utf8')).defaultProfile ?? '（无）'; } catch (e) { return `读不到（${e.code ?? e.message}）`; } };
    // 还剩哪些文件（相对路径，最多 15 个）：区分"删了一半、被占用的文件留着"和"别的用例刚建的完整目录"。
    const contents = n => { try { const all = fs.readdirSync(path.join(os.tmpdir(), n), { recursive: true }).map(String); return `${all.length} 项：${all.slice(0, 15).join(', ') || '（空目录）'}`; } catch (e) { return `读不到（${e.code ?? e.message}）`; } };
    // 命令行里带着这个目录的进程：完整身份、父 PID、创建时间、可执行文件名、脱敏命令行，以及是否在本测试的进程树内。
    const holders = n => findHolders(n, processSnapshot());
    // B 的阶段记录只在失败时附上，避免正常输出变长。
    const traceLines = run.stderr.split('\n').filter(line => line.includes('[ar-trace]') && (line.includes('agents test') || line.includes('进程树结束')));
    const owners = leftover.map(n => `${n}=${owner(n)}（${contents(n)}；相关进程 ${holders(n)}）`).join('、');
    await new Promise(resolve => setTimeout(resolve, 5000));
    note = `；残留 ${owners}；5 秒后仍在 ${leftover.filter(n => fs.existsSync(path.join(os.tmpdir(), n))).map(n => `${n}（${contents(n)}；相关进程 ${holders(n)}）`).join('、') || '（都消失了）'}`
      + `；agents test 阶段记录（AR_CORE_TRACE=1）：${traceLines.length ? traceLines.slice(0, 60).join(' | ') : '（没有）'}`;
  }
  assert.deepEqual(leftover, [], '临时目录已删除' + note);
  assert.ok(!fs.existsSync(path.join(home, 'runs.jsonl')));
});
