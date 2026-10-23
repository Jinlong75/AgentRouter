import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { validRequest } from '../../core/lib/managed.mjs';
import { processList, redactPaths } from '../../core/lib/process.mjs';
import { captureIdentities, assertIdentitiesGone, cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const rows = home => { try { const s = fs.readFileSync(path.join(home, 'runs.jsonl'), 'utf8'); return s.trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
async function until(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = fn(); if (result) return result; await delay(25); }
  throw Error('隔离测试等待超时');
}

// 失败现场：用一次完整进程快照记录每个进程的完整身份（命令行脱敏，不写环境变量值与密钥）。
async function identities(pids, label) {
  let snapshot = [];
  let failure = null;
  try { snapshot = await processList(); } catch (error) { failure = error.code ?? error.message; }
  const byPid = new Map(snapshot.map(p => [p.pid, p]));
  const lines = pids.map(pid => {
    const p = byPid.get(pid);
    return `pid=${pid} 父 PID=${p?.parent ?? '（未知）'} 可执行文件=${p?.name ?? '（未知）'} 创建时间=${p?.created ?? '（未知）'}`
      + ` 命令行=${redactPaths(p?.command ?? '') || '（空）'} 在快照中=${p ? '是' : '否'} pidAlive=${alive(pid)}`;
  });
  return `${label}：${lines.join('；')}${failure ? `；进程快照查询失败（${failure}）` : ''}`;
}

function fixture(t, { delayMs = 4000, exit = 0, secret = false } = {}) {
  const since = Date.now();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-detach-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo');
  for (const dir of [home, repo]) fs.mkdirSync(dir);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'say', text: '正在做' }, { kind: 'say', text: '做完了' }], report: '假汇报\n', exit, delayMs };
  if (secret) { profile.secrets = { OPENAI_API_KEY: 'FAKE_SECRET_SOURCE' }; env.FAKE_SECRET_SOURCE = '假密钥值-不可出现在请求文件'; }
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile } }));
  const children = new Set();
  function dispatch(name, extra = []) {
    const child = spawn(process.execPath, [script, 'dispatch', '隔离任务', '--name', name, '--detach', '--json', ...extra], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
    return child;
  }
  function command(args) {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
    return child;
  }
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null && alive(child.pid)) child.kill();
    // 只清理本 fixture 记录的执行者进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-detach-'));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { base, home, repo, env, dispatch, command };
}

test('--detach：调用者先返回，执行者在调用者退出后完成，pid 与调用者不同', async t => {
  const f = fixture(t, { delayMs: 2000 });
  const caller = f.dispatch('detach-test');
  const before = Date.now();
  const result = await caller.done;
  const elapsed = Date.now() - before;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(elapsed < 2500, `调用者应在任务结束前返回（用时 ${elapsed}ms）`);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true); assert.equal(value.exit, 0); assert.equal(value.detached, true);
  assert.ok(value.id); assert.equal(value.name, 'detach-test');
  assert.match(value.lines.join('\n'), /^记录名：detach-test/);
  assert.equal(rows(f.home).filter(r => r.event === 'end').length, 0, '调用者返回时任务还没结束');
  const start = await until(() => rows(f.home).find(r => r.event === 'start'));
  assert.equal(start.id, value.id, '返回的 id 与清单 start 行一致');
  assert.notEqual(start.pid, caller.pid, '执行者进程不是调用者进程');
  assert.ok(alive(start.pid), '执行者在调用者退出后仍存活');
  const end = await until(() => rows(f.home).find(r => r.event === 'end'), 15000);
  assert.equal(end.exit, 0);
  assert.equal(fs.readFileSync(start.report, 'utf8'), '假汇报\n');
});

test('--detach：请求文件不含密钥值，仍是合法托管请求', async t => {
  const f = fixture(t, { delayMs: 2000, secret: true });
  const caller = f.dispatch('detach-secret');
  const result = await caller.done;
  assert.equal(result.code, 0, result.stderr);
  const id = JSON.parse(result.stdout).id;
  const managedDir = path.join(f.home, 'managed');
  await until(() => fs.readdirSync(managedDir).some(n => n === `${id}.claimed.json` || n === `${id}.running.json`));
  const read = suffix => { const p = path.join(managedDir, `${id}${suffix}`); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
  const text = `${read('.claimed.json')}${read('.running.json')}`;
  assert.ok(text.length > 0, '读到至少一份请求文件');
  assert.ok(!text.includes('假密钥值-不可出现在请求文件'), '请求文件不含密钥值');
  const request = JSON.parse(read('.running.json') || read('.claimed.json'));
  assert.equal(validRequest(request), true, '脱离请求是合法托管请求');
  assert.equal(request.app, 'AgentRouter');
  assert.equal(request.profileConfig.secrets.OPENAI_API_KEY, 'FAKE_SECRET_SOURCE', '请求里只有密钥来源变量名');
  assert.ok(!Object.hasOwn(request.env, 'FAKE_SECRET_SOURCE') && !Object.hasOwn(request.env, 'OPENAI_API_KEY'), '请求环境不含密钥来源或密钥本身');
});

// 015：软件派发（--host agentrouter）的脱离请求仍是合法托管请求，派活方记 agentrouter。
test('--detach --host agentrouter：请求合法，start.dispatcher 记 agentrouter', async t => {
  const f = fixture(t, { delayMs: 2000 });
  const caller = f.dispatch('detach-agentrouter', ['--host', 'agentrouter']);
  const result = await caller.done;
  assert.equal(result.code, 0, result.stderr);
  const id = JSON.parse(result.stdout).id;
  const managedDir = path.join(f.home, 'managed');
  await until(() => fs.readdirSync(managedDir).some(n => n === `${id}.claimed.json` || n === `${id}.running.json`));
  const read = suffix => { const p = path.join(managedDir, `${id}${suffix}`); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
  const request = JSON.parse(read('.running.json') || read('.claimed.json'));
  assert.equal(validRequest(request), true, 'agentrouter 脱离请求是合法托管请求');
  assert.deepEqual(request.dispatcher, { host: 'agentrouter', session: null });
  const start = await until(() => rows(f.home).find(r => r.event === 'start'));
  assert.deepEqual(start.dispatcher, { host: 'agentrouter', session: null });
});

// 060 开工前第 8 条（协议 14.4）：--detach 后立刻 ar wait——托管请求文件在而清单还没有 start 时，
// 每 50 ms 重查最多 15 秒，而不是立刻报"找不到记录"（退出码 2）。
test('--detach 后立刻 ar wait（不等）连续 5 次：都等到结果而不是退出码 2', async t => {
  const f = fixture(t, { delayMs: 2000 });
  for (let i = 1; i <= 5; i++) {
    const name = `detach-wait-${i}`;
    const caller = f.dispatch(name);
    assert.equal((await caller.done).code, 0, `第 ${i} 次脱离派发失败`);
    // 派发一返回就等待：清单里可能还没有 start，只有 managed/ 里的请求文件。
    const waited = await f.command(['wait', name, '--json']).done;
    assert.equal(waited.code, 0, `第 ${i} 次 ar wait 应等到结果：${waited.stderr}${waited.stdout}`);
    const value = JSON.parse(waited.stdout);
    assert.equal(value.ok, true, `第 ${i} 次 ar wait 的 JSON`);
    assert.equal(value.exit, 0, `第 ${i} 次 ar wait 的结果`);
    assert.ok(value.lines.some(line => line.startsWith('等待：') || line.startsWith('exit=')),
      `第 ${i} 次 ar wait 有等待或结果行：${value.lines.join('；')}`);
  }
});

test('managed/ 里没有请求文件：ar wait 找不到记录仍立刻返回 2', async t => {
  const f = fixture(t, { delayMs: 2000 });
  const before = Date.now();
  const waited = await f.command(['wait', '根本没有这条', '--json']).done;
  const elapsed = Date.now() - before;
  assert.equal(waited.code, 2, waited.stderr + waited.stdout);
  assert.equal(JSON.parse(waited.stdout).ok, false);
  assert.ok(elapsed < 5000, `没有请求文件时应立刻退出 2，用时 ${elapsed}ms（不应等满 15 秒）`);
});

test('--detach 的任务能被 ar stop 结束，进程树随之退出', async t => {
  const f = fixture(t, { delayMs: 60000 });
  const caller = f.dispatch('detach-stop');
  assert.equal((await caller.done).code, 0);
  const start = await until(() => rows(f.home).find(r => r.event === 'start'));
  const spawned = await until(() => rows(f.home).find(r => r.event === 'spawned'));
  // 失败时残留的派发进程与假 agent 由 fixture 的 cleanupProcesses 按身份结束（agent 是派发进程的子孙），这里不再按 PID 结束。
  assert.ok(alive(start.pid) && alive(spawned.agentPid), '停止前执行者与假 agent 都在运行');
  // 失败现场：停止前 / 停止后各记一次完整身份，连同 ar stop 的输出与核对明细（标准错误）一起给出。
  const before = await identities([start.pid, spawned.agentPid], '停止前');
  const stopped = await captureIdentities([start.pid, spawned.agentPid]);
  const stop = await f.command(['stop', 'detach-stop']).done;
  const after = await identities([start.pid, spawned.agentPid], '停止后');
  t.diagnostic([before, after, `ar stop 退出码：${stop.code}`, `ar stop 标准输出：${stop.stdout.trim() || '（空）'}`,
    `ar stop 标准错误：${stop.stderr.trim() || '（空）'}`].join('\n'));
  assert.equal(stop.code, 0, stop.stderr + stop.stdout);
  assert.match(stop.stdout, /停止：detach-stop 已停止，工作区里没提交的改动还在/);
  // 069：按身份（PID + 创建时间）认定"已退出"——停止后派发进程的 PID 可能已被新的 conhost.exe 占用，只看 PID 会误判。
  const [startIdentity, agentIdentity] = stopped;
  await assertIdentitiesGone([startIdentity], '执行者进程已退出');
  await assertIdentitiesGone([agentIdentity], '假 agent 进程已退出');
  assert.deepEqual(rows(f.home).map(r => r.event), ['start', 'attempt', 'spawned', 'interrupted']);
  assert.equal(rows(f.home).at(-1).signal, 'stopped-by-command');
});
