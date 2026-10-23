import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlan, executePlan } from '../../installer/lib/install.mjs';
import { createManaged } from '../../app/src/main/managed.mjs';
import { handoff, terminalReader, managedEnvironment, validRequest, viewerApp, managedMessage } from '../../core/lib/managed.mjs';
import { registryWriter } from '../../core/lib/records.mjs';
import { captureIdentities, assertIdentitiesGone, cleanupProcesses } from '../fixtures/identity.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = home => { try { const s = fs.readFileSync(path.join(home, 'runs.jsonl'), 'utf8'); return s.slice(0, s.lastIndexOf('\n')).split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
// label 与 home 只用于诊断（PR #5 CI）：超时时写明等的是什么、此刻记录里有哪些事件；上限与判断不变。
async function until(fn, timeout = 10000, label = '', home = '') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = fn(); if (result) return result; await delay(25); }
  throw Error(`隔离测试等待超时${label ? `：${label}` : ''}${home ? `；此刻记录事件 ${rows(home).map(r => r.event + (r.exit !== undefined ? ' exit=' + r.exit : '')).join('、') || '（没有）'}` : ''}`);
}
// 023（PR #5 CI）：只给"托管拒绝 node"这一处等待者结束加有界上限，超时只用于失败与诊断，绝不算通过。
// 上限 10 000 ms 的依据：该测试要求等待者在托管服务启动后 4 000 ms 内结束，假 agent 只运行 150 ms；
// 10 秒与本文件 until() 的默认上限一致，是完成预算的 2.5 倍，正常会通过的情况不会因此变成失败，
// 结束慢但能结束的情况仍由原来的 4 秒断言如实报告。
const WAIT_LIMIT_MS = 10000;
// 027：其余 21 处等待的上限都从测试本身的约束推出；没有显式时间预算的沿用上面的 10 000 ms。
const FIVE_SECOND_WAIT_LIMIT_MS = 22500; // "五秒超时"测试自带"9 000 ms 内结束"的断言：9 000 × 2.5。
const STOP_WAIT_LIMIT_MS = 25000; // 停止 / 信号测试：killProcessTree 自带总预算 10 000 ms（core/lib/process.mjs），取其 2.5 倍。
// 进程身份查询与结束进程树各自的上限：诊断不能自己卡住，清理也不无限等。
const IDENTITY_QUERY_LIMIT_MS = 30000;
const TREE_KILL_LIMIT_MS = 10000;

// 有界等待 child.done。到期立刻判超时（不等诊断耗时），超时只抛出带 waitTimeout 的错误，由调用方失败并清理。
async function doneWithin(child, ms, label) {
  const started = Date.now();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const waited = Date.now() - started;
      reject(Object.assign(new Error(`等待者 ${ms} ms 内没有结束：${label}（已等待 ${waited} ms）`), { waitTimeout: true, waited }));
    }, ms);
  });
  child.done.catch(() => {}); // 超时后不再等它；避免它随后拒绝时成为未处理的拒绝。
  try { return await Promise.race([child.done, expired]); } finally { clearTimeout(timer); }
}

function tailLines(text, count = 20) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-count).join('\n') || '（空）';
}

// 请求/回执的摘要里不打印任何密钥类字段（按字段名判断；本测试也不应有）。
const secretKey = /key|token|secret|password|credential/i;
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretKey.test(k) ? '（已隐去）' : redactSecrets(v)]));
  return value;
}
function summarizeFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { return `读取失败：${error.code || error.message}`; }
  try { text = JSON.stringify(redactSecrets(JSON.parse(text))); } catch { /* 不是 JSON，保留原文。 */ }
  return text.length > 600 ? `${text.slice(0, 600)}…（共 ${text.length} 字符）` : text;
}

// Windows 上一次查询全部相关进程；查询自身最多 30 秒。非 Windows 只报告是否存活。
async function processIdentities(pids) {
  const unique = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  if (!unique.length) return '  （记录里没有进程号）';
  const status = pid => `pid ${pid}：${alive(pid) ? '存活' : '不在'}`;
  if (process.platform !== 'win32') return unique.map(pid => `  ${status(pid)}`).join('\n');
  const filter = unique.map(pid => `ProcessId=${pid}`).join(' or ');
  const command = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,Name,@{n='CreationDate';e={if ($_.CreationDate) { $_.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') }}},CommandLine | ConvertTo-Json -Compress`;
  let parsed;
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: IDENTITY_QUERY_LIMIT_MS, maxBuffer: 4 * 1024 * 1024 });
    parsed = stdout.trim() ? JSON.parse(stdout) : [];
  } catch (error) {
    const reason = error.killed && error.signal ? `超过 ${IDENTITY_QUERY_LIMIT_MS} ms 上限` : (error.code || error.message);
    return unique.map(pid => `  ${status(pid)}；Windows 身份查询失败：${reason}`).join('\n');
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const clean = value => String(value ?? '（无）').split(os.tmpdir()).join('<TEMP>');
  const byPid = new Map(items.map(item => [item.ProcessId, item]));
  return unique.map(pid => {
    const item = byPid.get(pid);
    if (!item) return `  ${status(pid)}；Windows 查询没有返回这个进程`;
    return `  ${status(pid)}；进程名=${clean(item.Name)}；创建时间=${clean(item.CreationDate)}；命令行=${clean(item.CommandLine)}`;
  }).join('\n');
}

// 诊断：等待条件、公共记录、相关子进程输出、进度文件尾部、托管目录文件摘要、相关进程身份。全部经 t.diagnostic 输出。
// 027：推广 023 的诊断，支持一次等待多个子进程（如 Promise.all）；只有一个"等待者"时输出与 023 完全一致。
async function diagnoseWait(t, f, { condition, children, waited, limit }) {
  const records = rows(f.home);
  t.diagnostic(`等待条件：${condition}；已等待 ${waited} ms，上限 ${limit} ms`);
  t.diagnostic(`公共目录记录 ${path.join(f.home, 'runs.jsonl')}：${records.length ? `共 ${records.length} 条` : '（没有记录）'}`);
  for (const [index, record] of records.entries())
    t.diagnostic(`  ${index + 1}. event=${record.event} id=${record.id ?? '（无）'} pid=${record.pid ?? '（无）'} agentPid=${record.agentPid ?? '（无）'} exit=${record.exit ?? '（无）'}`);
  for (const [child, name] of children) {
    const captured = child.captured();
    t.diagnostic(`${name} stdout 尾部（最后 20 行）：\n${tailLines(captured.stdout)}`);
    t.diagnostic(`${name} stderr 尾部（最后 20 行）：\n${tailLines(captured.stderr)}`);
  }
  const progressFiles = [...new Set(records.map(record => record.progress).filter(file => typeof file === 'string'))];
  if (!progressFiles.length) t.diagnostic('进度文件：记录里没有 progress 字段');
  for (const file of progressFiles) {
    try { t.diagnostic(`进度文件 ${file} 尾部（最后 20 行）：\n${tailLines(fs.readFileSync(file, 'utf8'))}`); }
    catch (error) { t.diagnostic(`进度文件 ${file} 读取失败：${error.code || error.message}`); }
  }
  const dir = path.join(f.home, 'managed');
  let names = null;
  try { names = fs.readdirSync(dir).sort(); } catch (error) { t.diagnostic(`托管目录 ${dir} 读取失败：${error.code || error.message}`); }
  if (names) {
    t.diagnostic(`托管目录 ${dir}：${names.length ? `共 ${names.length} 个文件` : '（空）'}`);
    for (const name of names) t.diagnostic(`  ${name}：${summarizeFile(path.join(dir, name))}`);
  }
  const childNames = children.map(([, name]) => name).join('、');
  t.diagnostic(`相关进程身份（${childNames}、记录里的 pid / agentPid）：\n${await processIdentities([...children.map(([child]) => child.pid), ...records.flatMap(record => [record.pid, record.agentPid])])}`);
}

// 023 的"托管拒绝 node"那一处沿用原签名与原诊断输出。
async function diagnoseWaiter(t, f, kind, child, waited) {
  await diagnoseWait(t, f, {
    condition: `托管拒绝 ${kind} 这一轮的等待者结束（派发进程 pid=${child.pid}）`,
    children: [[child, '等待者']],
    waited,
    limit: WAIT_LIMIT_MS,
  });
}

// 有界清理：结束等待者的整棵进程树，总共最多等 TREE_KILL_LIMIT_MS 确认退出；仍未退出如实返回，不无限等。
// 073：清理改为按身份（PID + 创建时间）逐个结束命令行带本测试临时目录 base 的进程（等待者、执行者、假 agent 的路径都在 base 下），
// 不再按 PID 对整棵树 taskkill /T；PID 被复用时不会误伤无关进程。
async function endTree(pid, base) {
  if (!alive(pid)) return '已退出（无需清理）';
  const deadline = Date.now() + TREE_KILL_LIMIT_MS;
  await cleanupProcesses(base);
  while (Date.now() < deadline) { if (!alive(pid)) return '整棵进程树已退出'; await delay(100); }
  return alive(pid) ? `仍未退出（pid ${pid} 及其子进程可能还在）` : '整棵进程树已退出';
}
// 027：一次等待涉及多个子进程时共用一个清理总预算：结束所有仍存活的整棵进程树，到期如实报告谁还在。
async function endTrees(pids, base) {
  const targets = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0 && alive(pid)))];
  if (!targets.length) return '对应进程都已退出（无需清理）';
  const deadline = Date.now() + TREE_KILL_LIMIT_MS;
  await cleanupProcesses(base);
  while (Date.now() < deadline) {
    if (targets.every(pid => !alive(pid))) return '整棵进程树已退出';
    await delay(100);
  }
  const left = targets.filter(alive);
  return left.length ? `仍未退出（pid ${left.join('、')} 及其子进程可能还在）` : '整棵进程树已退出';
}
// 027：其余所有等待都用这里。entries 是 [[child, 名称], ...]：单个等待返回该 child.done 的结果，多个按原顺序返回结果数组。
// 到期先输出与 023 相同类别的现场，再让测试失败（超时绝不算通过），然后在 finally 里有界清理仍未退出的进程树。
async function boundedWait(t, f, condition, entries, ms) {
  try {
    const results = await Promise.all(entries.map(([child, name]) => doneWithin(child, ms, `${condition}（${name} pid=${child.pid}）`)));
    return results.length === 1 ? results[0] : results;
  } catch (error) {
    if (!error.waitTimeout) throw error;
    await diagnoseWait(t, f, { condition, children: entries, waited: error.waited, limit: ms });
    try { assert.fail(error.message); }
    finally {
      const pending = entries.filter(([child]) => child.exitCode === null && child.signalCode === null && alive(child.pid));
      const detail = pending.length
        ? `${pending.map(([child, name]) => `${name}（pid ${child.pid}）`).join('、')} 整棵进程树：${await endTrees(pending.map(([child]) => child.pid), f.base)}`
        : '对应进程都已退出（无需清理）';
      t.diagnostic(`有界清理：${detail}`);
    }
  }
}
async function fixture(t, { exit = 0, duration = 150, stderr = '', tree = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatchdock-managed-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo'), host = path.join(base, 'host');
  for (const dir of [home, repo, host]) fs.mkdirSync(dir);
  const env = { ...process.env, CODEX_DISPATCH_HOME: home, USERPROFILE: base, HOME: base, APPDATA: path.join(base, 'appdata'),
    CLAUDE_CONFIG_DIR: host, CODEX_HOME: path.join(base, 'codex'), XDG_CONFIG_HOME: path.join(base, 'xdg'), CODEX_NO_WATCH: '1' };
  for (const key of ['CODEX_DRY_RUN','CODEX_MODEL','CODEX_EFFORT','CODEX_TIER','CODEX_SANDBOX','CODEX_DISPATCH_TEST_AGENT','NODE_OPTIONS','ELECTRON_RUN_AS_NODE']) delete env[key];
  // 本用例只设旧名，终端里设着新名时新名优先（协议 1），必须删掉；复制出来的是普通对象，Windows 上按不区分大小写删。
  for (const key of Object.keys(env)) if (process.platform === 'win32' ? key.toLowerCase() === 'agent_router_home' : key === 'AGENT_ROUTER_HOME') delete env[key];
  const agent = path.join(base, 'fake-agent.cjs');
  if (tree) fs.writeFileSync(path.join(base, 'descendant.cjs'), `require('node:fs').writeFileSync(require('node:path').join(__dirname,'descendant.json'),JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
  fs.writeFileSync(path.join(base, 'agent.json'), JSON.stringify({ exit, duration, stderr }));
  fs.writeFileSync(agent, `const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('codex-cli fake-managed');process.exit(0);}
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{
const settings=JSON.parse(fs.readFileSync(path.join(__dirname,'agent.json'),'utf8'));
${tree ? "require('node:child_process').spawn(process.execPath,[path.join(__dirname,'descendant.cjs')],{stdio:'ignore',windowsHide:true,shell:false});" : ''}
fs.writeFileSync(path.join(__dirname,'echo.json'),JSON.stringify({pid:process.pid,args:process.argv.slice(2),prompt,home:process.env.CODEX_HOME,key:process.env.OPENAI_API_KEY}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'隔离任务正在执行'}}));
setTimeout(()=>{fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'隔离汇报');if(settings.stderr)process.stderr.write(settings.stderr+'\\n');process.exitCode=settings.exit;},settings.duration);
});`);
  const configFile = path.join(home, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ v: 1, managed: true, watchWindow: 'never', agents: { codex: { path: agent } } }));
  fs.writeFileSync(path.join(home, 'viewer.json'), JSON.stringify({ pid: process.pid, acceptsManaged: true, suppressWatchWindow: true }));
  executePlan(createPlan({ env, host: 'claude-code', skill: 'agent-router' }), { env });
  const script = path.join(host, 'skills/agent-router/core/ar.mjs');
  const children = new Set(), services = [];
  function launch(file = script, args = ['隔离任务', '--name', 'managed-test'], overrides = {}) {
    const child = spawn(process.execPath, [file, ...args], { cwd: repo, env: { ...env, ...overrides }, stdio: ['ignore','pipe','pipe','ipc'], windowsHide: true, shell: false });
    children.add(child);
    let stdout = '', stderr = '';
    child.captured = () => ({ stdout, stderr }); // 供超时诊断读取已收到的输出（close 之前的实时值）。
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
    return child;
  }
  async function service() { const errors = [], warnings = []; const s = await createManaged(root, env, e => errors.push(e), w => warnings.push(w)); s.start(); services.push(s); return { s, errors, warnings }; }
  t.after(async () => {
    services.forEach(s => s.close());
    for (const child of children) if (child.exitCode === null && child.signalCode === null && alive(child.pid)) child.kill();
    // 只清理命令行带本 fixture 临时目录的进程（执行者、假 agent、子孙），按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('dispatchdock-managed-'));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { base, home, repo, env, script, agent, configFile, launch, service };
}

test('托管完整流程：退出码、唯一清单、执行者 PID、预计算配置、进度和清理', async t => {
  const f = await fixture(t, { exit: 7, stderr: 'Not inside a trusted directory' }); const { errors } = await f.service();
  const waiter = f.launch(f.script, ['隔离任务','补充说明','--name','managed-test','--model','explicit-model'], { CODEX_EFFORT: 'high' });
  // 027：上限 10 000 ms——该测试没有显式时间预算，沿用本文件 until() 的默认上限。
  const result = await boundedWait(t, f, '托管完整流程：等待者结束', [[waiter, '等待者']], WAIT_LIMIT_MS);
  assert.equal(result.code, 7, result.stderr);
  assert.match(result.stdout, /^记录名：managed-test\r?\n进度：/);
  assert.match(result.stdout, /托管：任务已交给 AgentRouter/);
  // 托管时出错原因也要回到等待者的输出里。
  assert.match(result.stdout, /出错：Not inside a trusted directory\r?\n出错：当前目录不是 git 仓库[^\n]*\r?\nexit=7 /);
  const records = rows(f.home); assert.deepEqual(records.map(r => r.event), ['start','attempt','spawned','attempt-end','end']);
  const [start, , spawned, , end] = records;
  assert.equal(start.managed, true); assert.notEqual(start.pid, waiter.pid); assert.equal(end.exit, 7);
  assert.equal(start.model, 'explicit-model'); assert.equal(start.effort, 'high');
  const echo = json(path.join(f.base, 'echo.json')); assert.equal(spawned.agentPid, echo.pid); assert.equal(echo.prompt, '任务：\n隔离任务\n补充说明'); assert.equal(echo.home, f.env.CODEX_HOME);
  const progress = fs.readFileSync(start.progress, 'utf8'); assert.equal((progress.match(/托管：任务已交给/g) || []).length, 1); assert.match(progress.trimEnd(), /=== Codex 结束：exit=7.*===$/);
  await until(() => fs.readdirSync(path.join(f.home, 'managed')).length === 0); assert.deepEqual(errors, []);
});

for (const kind of ['outside','modified','node']) test(`托管拒绝 ${kind}：等待者立即回退且只运行一次`, async t => {
  const f = await fixture(t);
  let script = f.script;
  if (kind === 'outside') script = path.join(root, 'core/ar.mjs');
  if (kind === 'modified') fs.appendFileSync(path.join(path.dirname(script), 'lib/progress.mjs'), '\n// 隔离测试修改\n');
  const waiter = f.launch(script);
  await until(() => fs.existsSync(path.join(f.home, 'managed')) && fs.readdirSync(path.join(f.home, 'managed')).some(s => s.endsWith('.request.json')));
  if (kind === 'node') {
    const requestFile = path.join(f.home, 'managed', fs.readdirSync(path.join(f.home, 'managed')).find(s => s.endsWith('.request.json')));
    fs.writeFileSync(requestFile, JSON.stringify({ ...json(requestFile), node: path.join(f.base, 'missing/node.exe') }));
  }
  const before = Date.now(); await f.service();
  // 023：等待者结束有界（10 秒）。到期先输出完整诊断，再断言失败，失败展开时做有界清理；其余断言与顺序不变。
  let result;
  try {
    result = await doneWithin(waiter, WAIT_LIMIT_MS, `托管拒绝 ${kind}：等待者结束`);
  } catch (error) {
    if (!error.waitTimeout) throw error;
    await diagnoseWaiter(t, f, kind, waiter, error.waited);
    try { assert.fail(error.message); }
    finally { t.diagnostic(`有界清理：等待者 ${waiter.pid} 整棵进程树 ${await endTree(waiter.pid, f.base)}`); }
  }
  assert.equal(result.code, 0, result.stderr); assert.ok(Date.now() - before < 4000);
  assert.match(result.stdout, kind === 'node' ? /没有接手（node 路径无效）/ : /没有接手（派发脚本不是由 AgentRouter 安装的，或者被改过）/);
  const all = rows(f.home); assert.deepEqual(all.map(r => r.event), ['start','attempt','spawned','attempt-end','end']); assert.equal(all[0].managed, undefined); assert.equal(all[0].pid, waiter.pid);
  assert.match(fs.readFileSync(all[0].progress, 'utf8'), /改为直接运行/);
});

test('五秒超时：收回请求并直接运行', async t => {
  const f = await fixture(t), before = Date.now(), waiter = f.launch();
  // 027：上限 22 500 ms——该测试自带"9 000 ms 内结束"的断言，取该预算的 2.5 倍。
  const result = await boundedWait(t, f, '五秒超时：等待者收回请求后直接运行并结束', [[waiter, '等待者']], FIVE_SECOND_WAIT_LIMIT_MS);
  assert.equal(result.code, 0, result.stderr); assert.ok(Date.now() - before >= 5000); assert.ok(Date.now() - before < 9000);
  assert.match(result.stdout, /没有接手（超时）/); assert.equal(rows(f.home)[0].pid, waiter.pid);
  assert.ok(fs.readdirSync(path.join(f.home, 'managed')).some(s => s.endsWith('.withdrawn.json')));
  await f.service(); await until(() => !fs.readdirSync(path.join(f.home, 'managed')).length);
});

test('认领后执行者启动失败写 rejected，等待者立即回退且只运行一份', async t => {
  const f = await fixture(t), waiter = f.launch();
  const requestFile = await until(() => {
    const dir = path.join(f.home, 'managed');
    if (!fs.existsSync(dir)) return null;
    const name = fs.readdirSync(dir).find(s => s.endsWith('.request.json')); return name && path.join(dir, name);
  });
  const invalidNode = path.join(f.base, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.writeFileSync(invalidNode, '本文件不是可执行程序');
  fs.writeFileSync(requestFile, JSON.stringify({ ...json(requestFile), node: invalidNode }));
  const before = Date.now();
  await f.service();
  const rejected = requestFile.replace('.request.json', '.rejected.json');
  assert.match(json(rejected).reason, /启动 Codex 失败/);
  // 027：上限 10 000 ms——该测试自带"4 000 ms 内结束"的断言，4 000 × 2.5 = 10 000 ms，与默认上限一致。
  const result = await boundedWait(t, f, '认领后执行者启动失败：等待者回退并结束', [[waiter, '等待者']], WAIT_LIMIT_MS);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /没有接手（启动 Codex 失败/);
  assert.ok(Date.now() - before < 4000);
  assert.deepEqual(rows(f.home).map(r => r.event), ['start','attempt','spawned','attempt-end','end']); assert.equal(rows(f.home)[0].pid, waiter.pid);
  assert.equal(rows(f.home)[0].managed, undefined);
});

async function requestFrom(f) {
  return until(() => {
    const dir = path.join(f.home, 'managed');
    if (!fs.existsSync(dir)) return null;
    const name = fs.readdirSync(dir).find(s => s.endsWith('.request.json'));
    return name && path.join(dir, name);
  });
}

for (const [label, app, expected] of [
  ['默认名字', 'AgentRouter', 'AgentRouter'],
  ['其他名字', '  示例监控器  ', '示例监控器'],
  ['空', ' \t ', 'AgentRouter'],
  ['缺失', undefined, 'AgentRouter'],
  ['超长', '监控🚀'.repeat(20), '监控🚀'.repeat(13) + '监'],
  ['非法类型', 123, 'AgentRouter'],
]) for (const accepted of [true, false]) test(`托管软件名 ${label}：${accepted ? '接手成功' : '拒绝回退'}且输出与进度一致`, async t => {
  const f = await fixture(t), viewer = path.join(f.home, 'viewer.json');
  fs.writeFileSync(viewer, JSON.stringify({ ...json(viewer), app }));
  const waiter = f.launch(), file = await requestFrom(f);
  const request = json(file);
  assert.equal(request.app, expected);
  assert.equal(validRequest(request), true);
  // 请求发出后更换软件名，两端仍使用请求中的快照。
  fs.writeFileSync(viewer, JSON.stringify({ ...json(viewer), app: '后来启动的监控器' }));
  if (accepted) await f.service();
  else {
    fs.writeFileSync(file, JSON.stringify({ ...request, reason: '隔离测试拒绝' }));
    fs.renameSync(file, file.replace('.request.json', '.rejected.json'));
  }
  // 027：上限 10 000 ms——该测试没有显式时间预算，沿用本文件 until() 的默认上限。
  const result = await boundedWait(t, f, `托管软件名 ${label}：等待者结束`, [[waiter, '等待者']], WAIT_LIMIT_MS);
  assert.equal(result.code, 0, result.stderr);
  const message = accepted
    ? `托管：任务已交给 ${expected}，关掉当前会话也不会中断。`
    : `托管：${expected} 没有接手（隔离测试拒绝），改为直接运行`;
  assert.deepEqual(result.stdout.split(/\r?\n/).filter(line => line.startsWith('托管：')), [message]);
  const start = rows(f.home)[0];
  assert.equal(start.managed, accepted ? true : undefined);
  const progress = fs.readFileSync(start.progress, 'utf8').split(/\r?\n/).filter(line => line.includes('托管：'));
  assert.equal(progress.length, 1);
  assert.equal(progress[0].replace(/^\[[^\]]+\] /, ''), message);
});

test('旧请求没有 app：执行者使用默认名字，不读取当前 viewer 名字', async t => {
  const f = await fixture(t), waiter = f.launch(), file = await requestFrom(f);
  const request = json(file); delete request.app;
  fs.writeFileSync(file, JSON.stringify(request));
  fs.writeFileSync(path.join(f.home, 'viewer.json'), JSON.stringify({ pid: process.pid, acceptsManaged: true, app: '另一个监控器' }));
  await f.service();
  // 027：上限 10 000 ms——该测试没有显式时间预算，沿用本文件 until() 的默认上限。
  const result = await boundedWait(t, f, '旧请求没有 app：等待者结束', [[waiter, '等待者']], WAIT_LIMIT_MS);
  assert.equal(result.code, 0, result.stderr);
  const message = managedMessage();
  assert.ok(result.stdout.includes(message));
  assert.ok(fs.readFileSync(rows(f.home)[0].progress, 'utf8').includes(message));
});

test('viewer 无法读取或内容无效时软件名回退', async t => {
  const f = await fixture(t), viewer = path.join(f.home, 'viewer.json');
  fs.unlinkSync(viewer);
  assert.equal(viewerApp(f.home), 'AgentRouter');
  for (const content of ['{', 'null', '[]', '{"app":false}']) {
    fs.writeFileSync(viewer, content);
    assert.equal(viewerApp(f.home), 'AgentRouter');
  }
});

test('请求不写密钥；执行者环境是白名单：软件环境里的密钥不传给执行者，请求覆盖普通环境', async t => {
  const f = await fixture(t);
  f.env.OPENAI_API_KEY = 'fake-monitor-key';
  const waiter = f.launch(f.script, ['隔离任务'], { OPENAI_API_KEY: 'fake-waiter-key', CODEX_HOME: path.join(f.base, 'request-codex') });
  const file = await requestFrom(f), text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /OPENAI_API_KEY|fake-monitor-key|fake-waiter-key/);
  assert.equal(validRequest({ ...json(file), env: { ...json(file).env, OPENAI_API_KEY: 'fake' } }), false);
  await f.service();
  // 027：上限 10 000 ms——该测试没有显式时间预算，沿用本文件 until() 的默认上限。
  assert.equal((await boundedWait(t, f, '请求不写密钥：等待者结束', [[waiter, '等待者']], WAIT_LIMIT_MS)).code, 0);
  const echo = json(path.join(f.base, 'echo.json'));
  assert.equal(echo.key, undefined, '没有在 profile 里声明的密钥不传'); assert.equal(echo.home, path.join(f.base, 'request-codex'));
});

test('托管：profile 声明的 secrets 由托管执行者从软件环境解析后注入，不用派发方环境里的值', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.configFile, JSON.stringify({ v: 2, managed: true, watchWindow: 'never', defaultProfile: 'codex', profiles: { codex: { adapter: 'codex', path: f.agent, secrets: { OPENAI_API_KEY: 'TEST_CODEX_KEY_SOURCE' } } } }));
  f.env.TEST_CODEX_KEY_SOURCE = 'fake-monitor-key';
  const waiter = f.launch(f.script, ['隔离任务'], { TEST_CODEX_KEY_SOURCE: 'fake-waiter-key' });
  const file = await requestFrom(f);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /fake-monitor-key|fake-waiter-key/);
  await f.service();
  // 027：上限 10 000 ms——该测试没有显式时间预算，沿用本文件 until() 的默认上限。
  assert.equal((await boundedWait(t, f, 'profile secrets：等待者结束', [[waiter, '等待者']], WAIT_LIMIT_MS)).code, 0);
  assert.equal(json(path.join(f.base, 'echo.json')).key, 'fake-monitor-key');
});

test('认领后未启动：超时收回直接运行，迟到执行者不写任何记录', async t => {
  const f = await fixture(t), waiter = f.launch(f.script, ['隔离任务'], { CODEX_DISPATCH_TEST_START_TIMEOUT_MS: '150' });
  const file = await requestFrom(f), claimed = file.replace('.request.json', '.claimed.json');
  fs.renameSync(file, claimed);
  const before = Date.now();
  // 027：上限 10 000 ms——测试只有 150 ms 的启动兜底期限（150 × 2.5 = 375 ms 小于默认上限），取 until() 的默认上限。
  const result = await boundedWait(t, f, '认领后未启动：等待者超时收回并结束', [[waiter, '等待者']], WAIT_LIMIT_MS);
  assert.equal(result.code, 0, result.stderr); assert.ok(Date.now() - before >= 150);
  assert.match(result.stdout, /没有接手（软件没有启动任务）/);
  assert.ok(fs.existsSync(claimed.replace('.claimed.json', '.withdrawn.json')));
  const records = fs.readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8');
  const runs = path.join(f.repo, '.agent-runs');
  const files = fs.readdirSync(runs, { recursive: true }).filter(name => fs.statSync(path.join(runs, name)).isFile()).map(name => [name, fs.readFileSync(path.join(runs, name), 'utf8')]);
  const lateChild = f.launch(f.script, ['--run-request', claimed]);
  // 027：上限 10 000 ms——该测试没有显式时间预算，沿用本文件 until() 的默认上限。
  const late = await boundedWait(t, f, '迟到的执行者结束', [[lateChild, '迟到执行者']], WAIT_LIMIT_MS);
  assert.equal(late.code, 0); assert.equal(late.stdout, ''); assert.equal(late.stderr, '');
  assert.equal(fs.readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8'), records);
  for (const [name, value] of files) assert.equal(fs.readFileSync(path.join(runs, name), 'utf8'), value);
  assert.deepEqual(rows(f.home).map(r => r.event), ['start','attempt','spawned','attempt-end','end']);
});

for (const executorFirst of [true, false]) test(`执行者与收回竞争：执行者先取得运行权=${executorFirst}`, async t => {
  const f = await fixture(t, { duration: 300 });
  const waiter = f.launch(f.script, ['隔离任务'], { CODEX_DISPATCH_TEST_START_TIMEOUT_MS: executorFirst ? '1500' : '100' });
  const file = await requestFrom(f), claimed = file.replace('.request.json', '.claimed.json');
  fs.renameSync(file, claimed);
  if (!executorFirst) await until(() => fs.existsSync(claimed.replace('.claimed.json', '.withdrawn.json')));
  const executor = f.launch(f.script, ['--run-request', claimed]);
  // 027：上限 10 000 ms——该测试没有显式时间预算（假 agent 只运行 300 ms），沿用 until() 的默认上限；超时信息会写明是哪一个没结束。
  const [a, b] = await boundedWait(t, f, '执行者与收回竞争：等待者与执行者都结束', [[waiter, '等待者'], [executor, '执行者']], WAIT_LIMIT_MS);
  assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
  assert.deepEqual(rows(f.home).map(r => r.event), ['start','attempt','spawned','attempt-end','end']);
  assert.equal(rows(f.home)[0].pid, executorFirst ? executor.pid : waiter.pid);
  assert.equal(fs.existsSync(claimed.replace('.claimed.json', '.running.json')), executorFirst);
});

test('认领后收到拒绝立即回退，不等启动兜底期限', async t => {
  const f = await fixture(t), waiter = f.launch();
  const file = await requestFrom(f), claimed = file.replace('.request.json', '.claimed.json');
  fs.renameSync(file, claimed); await delay(150);
  const rejected = claimed.replace('.claimed.json', '.rejected.json');
  fs.renameSync(claimed, rejected);
  fs.writeFileSync(rejected + '.tmp', JSON.stringify({ ...json(rejected), reason: '隔离测试拒绝' }));
  fs.renameSync(rejected + '.tmp', rejected);
  const before = Date.now();
  // 027：上限 10 000 ms——该测试自带"4 000 ms 内结束"的断言，4 000 × 2.5 = 10 000 ms，与默认上限一致。
  const result = await boundedWait(t, f, '认领后收到拒绝：等待者立即回退并结束', [[waiter, '等待者']], WAIT_LIMIT_MS);
  assert.equal(result.code, 0); assert.ok(Date.now() - before < 4000);
  assert.match(result.stdout, /任务已交给 AgentRouter/); assert.match(result.stdout, /没有接手（隔离测试拒绝）/);
  assert.equal(rows(f.home).filter(r => r.event === 'start').length, 1);
});

test('收回与执行者改名并发发生，始终只运行一份', async t => {
  const f = await fixture(t);
  const gate = path.join(f.base, 'executor-gate.mjs');
  fs.writeFileSync(gate, `import {run} from ${JSON.stringify(new URL('../../core/lib/run.mjs', import.meta.url).href)};
import {codex} from ${JSON.stringify(new URL('../../core/adapters/codex.mjs', import.meta.url).href)};
process.send('ready');process.once('message',async file=>{process.disconnect();process.exitCode=await run({adapter:codex,scriptPath:${JSON.stringify(f.script)},args:['--run-request',file]});});`);
  for (let i = 0; i < 3; i++) {
    const executor = f.launch(gate, []);
    await new Promise(resolve => executor.once('message', resolve));
    const waiter = f.launch(f.script, ['隔离任务','--name',`concurrent-${i}`], { CODEX_DISPATCH_TEST_START_TIMEOUT_MS: '100' });
    const file = await requestFrom(f), request = json(file), claimed = file.replace('.request.json', '.claimed.json');
    fs.renameSync(file, claimed);
    await delay(100); executor.send(claimed);
    // 027：上限 10 000 ms——该测试没有显式时间预算（启动兜底 100 ms、假 agent 150 ms），沿用 until() 的默认上限；超时信息会写明是哪一个没结束。
    const [a, b] = await boundedWait(t, f, `收回与改名并发第 ${i + 1} 轮：等待者与执行者都结束`, [[waiter, '等待者'], [executor, '执行者']], WAIT_LIMIT_MS);
    assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
    const records = rows(f.home).filter(r => r.id === request.id);
    assert.deepEqual(records.map(r => r.event), ['start','attempt','spawned','attempt-end','end']);
    assert.ok([executor.pid,waiter.pid].includes(records[0].pid));
  }
});

test('执行者使用请求快照：认领前更改默认配置，不影响本次参数与指定 agent', async t => {
  const f = await fixture(t), waiter = f.launch(f.script, ['隔离任务','--model','snapshot-model']);
  await until(() => fs.existsSync(path.join(f.home, 'managed')) && fs.readdirSync(path.join(f.home, 'managed')).some(s => s.endsWith('.request.json')));
  fs.writeFileSync(f.configFile, JSON.stringify({v:1,managed:false,agents:{codex:{path:path.join(f.base,'missing-agent.exe'),model:'changed-model',sandbox:'read-only'}}}));
  await f.service();
  // 027：上限 10 000 ms——该测试没有显式时间预算，沿用本文件 until() 的默认上限。
  assert.equal((await boundedWait(t, f, '执行者使用请求快照：等待者结束', [[waiter, '等待者']], WAIT_LIMIT_MS)).code,0);
  const start = rows(f.home)[0]; assert.equal(start.model,'snapshot-model'); assert.equal(start.sandbox,'workspace-write'); assert.equal(start.managed,true);
});

test('角色文件消失时拒绝请求，不产生托管执行记录', async t => {
  const f = await fixture(t), role = path.join(f.repo, 'role.md'); fs.writeFileSync(role, '# 角色：测试角色');
  const waiter = f.launch(f.script, ['隔离任务','--role','role.md']);
  await until(() => fs.existsSync(path.join(f.home, 'managed')) && fs.readdirSync(path.join(f.home, 'managed')).some(s => s.endsWith('.request.json')));
  fs.unlinkSync(role); await f.service();
  // 027：上限 10 000 ms——该测试没有显式时间预算，沿用本文件 until() 的默认上限。
  const result = await boundedWait(t, f, '角色文件消失：等待者结束', [[waiter, '等待者']], WAIT_LIMIT_MS);
  assert.equal(result.code,0); assert.match(result.stdout,/没有接手（请求文件无效）/);
  assert.equal(rows(f.home)[0].managed,undefined);
});

test('认领和收回竞争：两种获胜顺序都只有一个执行所有者', async t => {
  const f = await fixture(t);
  for (const claimFirst of [true, false]) {
    const id = 'race-' + claimFirst, name = id, dir = path.join(f.home, 'managed'); fs.mkdirSync(dir, { recursive: true });
    const r = { v:1,id,at:Date.now(),script:f.script,node:process.execPath,repo:f.repo,name,args:{task:'隔离任务',extra:'',role:null,spec:null},settings:{model:null,effort:null,tier:null,sandbox:'workspace-write',path:f.agent},dispatcher:{host:'unknown',session:null},env:managedEnvironment(f.env) };
    let owners = 0;
    const pending = handoff(f.home, r, () => {}, { timeout: claimFirst ? 100 : 0, interval: 5 });
    const claim = () => { try { fs.renameSync(path.join(dir,id+'.request.json'),path.join(dir,id+'.claimed.json')); owners++; registryWriter(f.home)({event:'end',id,exit:0,at:Date.now(),minutes:0}); } catch(e) { assert.equal(e.code,'ENOENT'); } };
    claim(); const outcome = await pending; if ('reason' in outcome) owners++;
    assert.equal(owners,1); assert.equal('exit' in outcome,claimFirst);
  }
});

for (const mode of ['off','dead','legacy','dry']) test(`不满足托管条件 ${mode}：没有请求或托管输出`, async t => {
  const f = await fixture(t);
  if (mode === 'off') fs.writeFileSync(f.configFile, JSON.stringify({ ...json(f.configFile), managed:false }));
  if (mode === 'dead') fs.writeFileSync(path.join(f.home,'viewer.json'),JSON.stringify({pid:2147483647,acceptsManaged:true}));
  if (mode === 'legacy') fs.writeFileSync(path.join(f.home,'viewer.json'),JSON.stringify({pid:process.pid}));
  const direct = f.launch(f.script, ['隔离任务'], mode === 'dry' ? {CODEX_DRY_RUN:'1'} : {});
  // 027：上限 10 000 ms——该测试没有显式时间预算，沿用本文件 until() 的默认上限。
  const result = await boundedWait(t, f, `不满足托管条件 ${mode}：派发进程结束`, [[direct, '派发进程']], WAIT_LIMIT_MS);
  assert.equal(result.code,0,result.stderr); assert.doesNotMatch(result.stdout,/托管：/); assert.equal(fs.existsSync(path.join(f.home,'managed')),false);
  assert.equal(rows(f.home).length,mode==='dry'?0:5);
});

test('请求校验、环境白名单、完整行读取和启动清理', async t => {
  const f=await fixture(t),dir=path.join(f.home,'managed');fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'old.tmp'),'old');fs.utimesSync(path.join(dir,'old.tmp'),new Date(0),new Date(0));
  fs.writeFileSync(path.join(dir,'bad.request.json'),'{}');
  await f.service();
  assert.equal(fs.existsSync(path.join(dir,'old.tmp')),false);assert.equal(json(path.join(dir,'bad.rejected.json')).reason,'请求文件无效');
  assert.equal(validRequest({v:1}),false);
  assert.deepEqual(managedEnvironment({Path:'fake',NODE_OPTIONS:'injected',ELECTRON_RUN_AS_NODE:'1',UNRELATED:'no'}),{PATH:'fake'});
  const file=path.join(f.home,'runs.jsonl'),read=terminalReader(f.home,'half');
  fs.writeFileSync(file,'{"v":1,"event":"end","id":"half","exit":0}');assert.equal(read(),null);fs.appendFileSync(file,'\n');assert.equal(read().exit,0);
});

// 016：派活方取值只多 agentrouter 一个，结构不变——agentrouter 请求合法，其他未知取值仍然无效。
test('请求校验的派活方取值：claude-code / unknown / agentrouter 合法，其他无效', () => {
  const base = {
    v: 1, id: 'host-check', at: Date.now(), script: path.resolve('core/ar.mjs'), node: process.execPath,
    repo: path.resolve('.'), name: '隔离任务',
    args: { task: '隔离任务', extra: '', role: null, spec: null },
    settings: { model: null, effort: null, tier: null, sandbox: 'workspace-write', path: null },
    dispatcher: { host: 'unknown', session: null }, env: managedEnvironment({ PATH: 'fake' }),
  };
  for (const host of ['claude-code', 'unknown', 'agentrouter'])
    assert.equal(validRequest({ ...base, dispatcher: { host, session: null } }), true, host);
  // claude-code 时会话可以是字符串，其余取值会话为 null。
  assert.equal(validRequest({ ...base, dispatcher: { host: 'claude-code', session: 'fake-session' } }), true);
  for (const host of ['other', 'AgentRouter', '', null, undefined])
    assert.equal(validRequest({ ...base, dispatcher: { host, session: null } }), false, String(host));
});

test('Windows 实测：终止假派活方整棵进程树，执行者和假 agent 继续到 end', { skip:process.platform!=='win32' }, async t => {
  const f=await fixture(t,{duration:2500});await f.service();
  const hostFile=path.join(f.base,'fake-host.mjs');
  fs.writeFileSync(hostFile,`import {spawn} from 'node:child_process';const child=spawn(process.execPath,[${JSON.stringify(f.script)},'隔离任务'],{stdio:'inherit',windowsHide:true,shell:false});child.on('close',code=>process.exit(code));`);
  const host=f.launch(hostFile,[]);
  const started=await until(()=>rows(f.home).find(r=>r.event==='spawned'),10000,'执行者启动假 agent（spawned）',f.home);
  await until(()=>fs.existsSync(path.join(f.base,'echo.json')),10000,'假 agent 写出 echo.json',f.home);
  const executor=rows(f.home)[0];
  await execute('taskkill.exe',['/PID',String(host.pid),'/T','/F'],{windowsHide:true});
  assert.equal(alive(host.pid),false);assert.equal(alive(executor.pid),true);assert.equal(alive(started.agentPid),true);
  const end=await until(()=>rows(f.home).find(r=>r.event==='end'),10000,`结束派活方后任务写出 end（执行者 ${executor.pid} ${alive(executor.pid)?'存活':'不在'}，假 agent ${started.agentPid} ${alive(started.agentPid)?'存活':'不在'}）`,f.home);assert.equal(end.exit,0);
  t.diagnostic('taskkill.exe /PID <本测试假派活方 PID> /T /F：派活方与等待者退出；执行者、假 agent 存活；唯一 end.exit=0。');
});

test('Windows 实测：关闭软件认领进程，托管任务仍正常完成', { skip:process.platform!=='win32' }, async t => {
  const f=await fixture(t,{duration:1800}),monitorFile=path.join(f.base,'fake-monitor.mjs');
  fs.writeFileSync(monitorFile,`import {createManaged} from ${JSON.stringify(new URL('../../app/src/main/managed.mjs',import.meta.url).href)};import fs from 'node:fs';const service=await createManaged(${JSON.stringify(root)});service.start();fs.writeFileSync(${JSON.stringify(path.join(f.home,'viewer.json'))},JSON.stringify({pid:process.pid,acceptsManaged:true,suppressWatchWindow:true}));process.send('ready');process.on('message',()=>{service.close();fs.unlinkSync(${JSON.stringify(path.join(f.home,'viewer.json'))});process.disconnect();});`);
  const monitor=f.launch(monitorFile,[]);await new Promise(resolve=>monitor.once('message',resolve));
  const waiter=f.launch();await until(()=>fs.existsSync(path.join(f.base,'echo.json')));
  const [executor, , agent]=rows(f.home);monitor.send('close');
  // 027：上限 10 000 ms——该测试没有显式时间预算，沿用 until() 的默认上限；从发出 close 之后计时。
  assert.equal((await boundedWait(t, f, '关闭软件认领进程后监控进程结束', [[monitor, '监控进程']], WAIT_LIMIT_MS)).code,0);
  assert.equal(alive(executor.pid),true);assert.equal(alive(agent.agentPid),true);
  // 027：上限 10 000 ms——该测试没有显式时间预算（假 agent 运行 1 800 ms），沿用默认上限。
  assert.equal((await boundedWait(t, f, '关闭软件后等待者完成', [[waiter, '等待者']], WAIT_LIMIT_MS)).code,0);assert.equal(rows(f.home).at(-1).exit,0);
  t.diagnostic('向独立假监控进程发送 close，关闭认领服务并正常退出：执行者与假 agent 存活，等待者 exit=0，唯一 end.exit=0。');
});

for (const managed of [false, true]) test(`停止命令结束多层假进程，托管=${managed}`, async t => {
  const f = await fixture(t, { duration: 60000, tree: true });
  if (managed) await f.service();
  else fs.writeFileSync(f.configFile, JSON.stringify({ ...json(f.configFile), managed: false }));
  const name = '停止 中文 任务';
  const waiter = f.launch(f.script, ['隔离任务', '--name', name]);
  await until(() => fs.existsSync(path.join(f.base, 'descendant.json')));
  const [start, , spawned] = rows(f.home), descendant = json(path.join(f.base, 'descendant.json')).pid;
  // 失败时残留的假 agent 与子孙（命令行都带本 fixture 的临时目录）由 fixture 的 cleanupProcesses 按身份结束，这里不再按 PID 结束。
  const identities = await captureIdentities([start.pid, spawned.agentPid, descendant]);
  // 027：上限 25 000 ms——假 agent 故意运行 60 000 ms、要等停止命令结束它；stopTask 内部的 killProcessTree 有 10 000 ms 总预算
  // （core/lib/process.mjs），取该停止预期的 2.5 倍，从发出停止命令之后计时。
  const stop = f.launch(f.script, ['--stop', name]);
  const result = await boundedWait(t, f, '停止命令结束多层假进程：停止命令结束', [[stop, '停止命令']], STOP_WAIT_LIMIT_MS);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), `停止：${name} 已停止，工作区里没提交的改动还在`);
  // 069：按身份（停止前记下的 PID + 创建时间）认定"已退出"，PID 被复用不再误判。
  for (const identity of identities) await assertIdentitiesGone([identity], `假进程 ${identity.pid} 已退出`);
  // 027：上限 25 000 ms——停止命令已返回，等待者要随被杀掉的假 agent 结束；同上的停止预期 10 000 ms × 2.5，从停止命令返回后计时。
  const finished = await boundedWait(t, f, '停止命令结束多层假进程：停止后等待者结束', [[waiter, '等待者']], STOP_WAIT_LIMIT_MS);
  if (managed) assert.equal(finished.code, 1);
  assert.deepEqual(rows(f.home).map(r => r.event), ['start','attempt','spawned','interrupted']);
  assert.equal(rows(f.home).at(-1).signal, 'stopped-by-command');
  // 027：上限 25 000 ms——同一条停止预期（10 000 ms × 2.5），从第二次发出停止命令之后计时。
  const againStop = f.launch(f.script, ['--stop', name]);
  const again = await boundedWait(t, f, '停止命令结束多层假进程：第二次停止命令结束', [[againStop, '停止命令（第二次）']], STOP_WAIT_LIMIT_MS);
  assert.equal(again.code, 0); assert.equal(again.stdout.trim(), `停止：${name}（已经结束）`);
});

for (const signal of ['SIGINT','SIGTERM','SIGBREAK','SIGHUP']) test(`信号 ${signal} 结束假 agent 及子孙进程`, async t => {
  const f = await fixture(t, { duration: 60000, tree: true });
  fs.writeFileSync(f.configFile, JSON.stringify({ ...json(f.configFile), managed: false }));
  // Windows 不支持从另一进程投递这些 POSIX 信号，用 IPC 在派发进程内触发同一处理器。
  const wrapper = path.join(f.base, 'signal-entry.mjs');
  fs.writeFileSync(wrapper, `process.on('message',s=>process.emit(s));await import(${JSON.stringify(pathToFileURL(f.script).href)});`);
  const child = f.launch(wrapper, ['隔离任务']);
  await until(() => fs.existsSync(path.join(f.base, 'descendant.json')));
  const spawned = rows(f.home).find(r => r.event === 'spawned'), descendant = json(path.join(f.base, 'descendant.json')).pid;
  // 失败时残留的假 agent 与子孙（命令行都带本 fixture 的临时目录）由 fixture 的 cleanupProcesses 按身份结束，这里不再按 PID 结束。
  const identities = await captureIdentities([spawned.agentPid, descendant]);
  child.send(signal);
  // 027：上限 25 000 ms——假 agent 故意运行 60 000 ms、要等信号结束它；run.mjs 的信号处理器用 killProcessTree 的 10 000 ms 总预算，
  // 取该停止预期的 2.5 倍，从发出信号之后计时。
  assert.equal((await boundedWait(t, f, `信号 ${signal}：派发进程结束`, [[child, '派发进程']], STOP_WAIT_LIMIT_MS)).code, 1);
  // 069：按身份（信号前记下的 PID + 创建时间）认定"已退出"。
  await assertIdentitiesGone(identities, `信号 ${signal}：假 agent 与子孙进程已退出`);
  assert.deepEqual(rows(f.home).map(r => r.event), ['start','attempt','spawned','interrupted']);
  assert.equal(rows(f.home).at(-1).signal, signal);
});

// 托管目录的三种情况：初始化失败、运行中目录消失、退出后清理。
test('初始化失败：托管目录建不出来时 start 直接抛出带路径的原因，不进入轮询', async t => {
  const f = await fixture(t), errors = [];
  fs.writeFileSync(path.join(f.home, 'managed'), '不是目录');
  const s = await createManaged(root, f.env, e => errors.push(e));
  assert.throws(() => s.start(), e => /托管请求目录初始化失败/.test(e.message) && e.message.includes(path.join(f.home, 'managed')));
  s.close();
  await delay(450);
  assert.deepEqual(errors, []);
});
test('运行中托管目录被删除：只警告一次（已自动恢复，不算错误），重建 managed 并继续接收请求', async t => {
  const f = await fixture(t), dir = path.join(f.home, 'managed');
  const { errors, warnings } = await f.service();
  fs.rmSync(dir, { recursive: true, force: true });
  await until(() => warnings.length > 0 && fs.existsSync(dir));
  await delay(600);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /^警告：托管请求目录在运行中被删除.*已(重新创建|被派活方重建)，继续监听/);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(dir, 'bad.request.json'), '{}');
  await until(() => fs.existsSync(path.join(dir, 'bad.rejected.json')));
  assert.equal(json(path.join(dir, 'bad.rejected.json')).reason, '请求文件无效');
  assert.equal(warnings.length, 1);
});
test('运行中公共目录整个消失：报告一次、不重建整条路径；公共目录回来后恢复', async t => {
  const f = await fixture(t), dir = path.join(f.home, 'managed');
  const { errors, warnings } = await f.service();
  fs.rmSync(f.home, { recursive: true, force: true });
  await until(() => errors.length > 0);
  await delay(600);
  assert.equal(fs.existsSync(f.home), false, '不能自动重建公共目录');
  assert.equal(errors.length, 1, errors.map(e => e.message).join('\n'));
  assert.match(errors[0].message, /公共目录都不存在，暂停接收托管请求/);
  fs.mkdirSync(f.home);
  await until(() => fs.existsSync(dir) && warnings.length === 1);
  assert.match(warnings[0], /^警告：托管请求目录在运行中被删除.*已重新创建，继续监听/);
  assert.equal(errors.length, 1);
  fs.writeFileSync(path.join(dir, 'bad.request.json'), '{}');
  await until(() => fs.existsSync(path.join(dir, 'bad.rejected.json')));
});
test('退出后清理：close 之后删除目录不报告、不重建', async t => {
  const f = await fixture(t), dir = path.join(f.home, 'managed');
  const { s, errors, warnings } = await f.service();
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
  await delay(600);
  s.scan();
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
test('其他错误不吞掉：托管目录被换成文件时报告原因，同一错误不重复刷屏', async t => {
  const f = await fixture(t), dir = path.join(f.home, 'managed');
  const { errors } = await f.service();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, '不是目录');
  await until(() => errors.some(e => e.code && e.code !== 'ENOENT'));
  await delay(600);
  const other = errors.filter(e => e.code && e.code !== 'ENOENT');
  assert.equal(other.length, 1, errors.map(e => `${e.code} ${e.message}`).join('\n'));
  assert.equal(fs.statSync(dir).isFile(), true, '不能删掉别人放的文件');
});
