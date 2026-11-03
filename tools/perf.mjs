import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { awaitingTasks } from '../core/lib/schedule.mjs';
import { runGate } from '../core/lib/gate.mjs';
import { runCommand } from '../core/lib/command.mjs';
import { homeEnv } from '../core/lib/compat.mjs';
import { killProcessTree } from '../core/lib/process.mjs';

const entry = fileURLToPath(new URL('../core/ar.mjs', import.meta.url));
const limitsFile = fileURLToPath(new URL('./perf-limits.json', import.meta.url));
const emptyCommand = 'node -e "process.exit(0)"';
const dispatchTimeoutMs = 30000;

export function filterGitEnvironment(source) {
  const blocked = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES']);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.has(key.toUpperCase())));
}

export async function waitForDispatch(closed, pid, { timeoutMs = dispatchTimeoutMs, kill = killProcessTree } = {}) {
  let timer;
  try {
    const timedOut = await Promise.race([
      closed.then(() => false),
      new Promise(resolve => { timer = setTimeout(() => resolve(true), timeoutMs); }),
    ]);
    if (timedOut) {
      if (Number.isSafeInteger(pid) && pid > 0) await kill(pid);
      throw Error('派发等待超时');
    }
  } finally { clearTimeout(timer); }
}

// 清单与统一事件使用协议字段，所有内容均为合成数据。
export function generateFixture(count, eventCount, repo) {
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(eventCount) || eventCount < 0 || typeof repo !== 'string' || !path.isAbsolute(repo)) throw Error('数据规模无效');
  const tasks = [], events = [];
  for (let i = 0; i < count; i++) {
    const id = `fixture-${i}`, name = `task-${i}`, dir = path.join(repo, '.agent-runs', name);
    const start = { v: 2, event: 'start', id, repo, name, spec: null, title: name, role: null, pid: 0, started: i + 1, dir, project: 'fixture', profile: 'fake', adapter: 'fake', agent: 'fake', agentVersion: 'fake-agent 1.0', model: null, effort: null, tier: null, sandbox: null, dispatcher: { host: 'unknown', session: null }, worktree: true };
    for (const [key, file] of Object.entries({ progress: 'progress.log', report: 'report.md', raw: 'raw.log', events: 'events.jsonl' })) start[key] = path.join(dir, file);
    tasks.push({ start, end: { v: 1, event: 'end', id, exit: 0, at: i + 2, minutes: 0 } });
    events.push([]);
  }
  for (let i = 0; i < eventCount; i++) {
    const group = events[i % count];
    group.push({ v: 1, seq: group.length + 1, at: i + 1, kind: 'say', text: '匿名进度', attempt: 1 });
  }
  return { tasks, events };
}

export function median(samples) {
  if (!Array.isArray(samples) || !samples.length || samples.some(n => !Number.isFinite(n))) throw Error('样本无效');
  const sorted = [...samples].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(name, samples, limit = null) {
  if (typeof name !== 'string' || !name || (limit !== null && (!Number.isFinite(limit) || limit < 0))) throw Error('指标或上限无效');
  const value = median(samples);
  return { name, unit: 'ms', samples: [...samples], median: value, limit, ok: limit === null || value <= limit };
}

function run(executable, args, options) {
  const result = spawnSync(executable, args, { ...options, encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000 });
  if (result.error || result.status !== 0) throw Error('子进程执行失败');
  return result.stdout;
}

async function firstProgress(repo, env, index) {
  const name = `measure-${index}`, file = path.join(repo, '.agent-runs', name, 'events.jsonl');
  const started = performance.now();
  const child = spawn(process.execPath, [entry, 'dispatch', '性能测试', '--name', name, '--profile', 'fake', '--json'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  let stdout = '', code = null, spawnError = null;
  child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value; });
  child.stderr.resume();
  const closed = new Promise(resolve => { child.on('error', error => { spawnError = error; }); child.on('close', value => { code = value; resolve(); }); });
  let elapsed = null;
  try {
    while (elapsed === null && !spawnError && performance.now() - started < dispatchTimeoutMs) {
      if (existsSync(file)) {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        if (lines.some(line => { try { return JSON.parse(line).text === '基准进度'; } catch { return false; } })) elapsed = performance.now() - started;
      }
      if (elapsed === null && code !== null) break;
      if (elapsed === null) await delay(5);
    }
  } finally {
    // 只在超时时结束自己启动的派发进程树。
    await waitForDispatch(closed, child.pid, { timeoutMs: Math.max(1, dispatchTimeoutMs - (performance.now() - started)) });
  }
  if (elapsed === null || spawnError || code !== 0 || JSON.parse(stdout).exit !== 0) throw Error('派发或首条进度读取失败');
  return elapsed;
}

async function benchmark(calibrate) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-perf-'));
  let stage = '准备隔离环境';
  try {
    const repo = path.join(base, 'repo'), home = path.join(base, 'home');
    mkdirSync(repo); mkdirSync(home);
    const env = { ...filterGitEnvironment(process.env), AR_NO_WATCH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig') };
    for (const key of homeEnv) delete env[key];
    env[homeEnv[0]] = home;
    for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_PROFILE']) delete env[key];
    const opts = { cwd: repo, env };
    const git = args => run('git', args, opts);
    git(['init', '-q']); git(['config', 'user.name', 'Perf Fixture']); git(['config', 'user.email', 'perf@example.test']); git(['config', 'commit.gpgsign', 'false']);
    writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
    git(['add', '--', '.gitignore']); git(['commit', '-q', '-m', 'fixture', '--', '.gitignore']);
    const baseSha = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true, events: [{ kind: 'say', text: '基准进度' }], report: 'OK\n', exit: 0 } } }));
    const agents = JSON.parse(run(process.execPath, [entry, 'agents', 'list', '--json'], opts));
    assert.equal(agents.ok, true); assert.equal(agents.agents.length, 1);
    assert.equal(agents.agents[0].name, 'fake'); assert.equal(agents.agents[0].adapter, 'fake'); assert.equal(agents.agents[0].default, true);
    writeFileSync(path.join(home, 'projects.json'), JSON.stringify({ v: 1, projects: [{ path: repo, name: 'fixture', addedAt: 1, lastUsed: 1 }] }));
    const fixture = generateFixture(1000, 50000, repo);
    assert.equal(fixture.tasks.length, 1000); assert.equal(fixture.events.reduce((n, list) => n + list.length, 0), 50000);
    writeFileSync(path.join(home, 'runs.jsonl'), fixture.tasks.flatMap(({ start, end }) => [JSON.stringify(start), JSON.stringify(end)]).join('\n') + '\n');
    for (let i = 0; i < fixture.tasks.length; i++) {
      const start = fixture.tasks[i].start; mkdirSync(start.dir, { recursive: true });
      writeFileSync(start.events, fixture.events[i].map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    const rows = readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row => row.event === 'start').length, 1000);
    assert.equal(new Set(rows.filter(row => row.event === 'start').map(row => row.id)).size, 1000);
    assert.equal(fixture.tasks.reduce((n, task) => n + readFileSync(task.start.events, 'utf8').trim().split('\n').filter(Boolean).length, 0), 50000);
    const samples = { status: [], projects_list: [], manifest_read: [], dispatch_first_progress: [], gate_overhead: [] };
    for (let i = 0; i < 3; i++) {
      stage = '状态查询';
      let started = performance.now();
      const status = JSON.parse(run(process.execPath, [entry, 'status', 'task-0', '--json'], opts));
      samples.status.push(performance.now() - started); assert.equal(status.id, 'fixture-0'); assert.equal(status.state, 'awaiting');
      stage = '项目列表'; started = performance.now();
      const projects = JSON.parse(run(process.execPath, [entry, 'projects', 'list', '--json'], opts));
      samples.projects_list.push(performance.now() - started); assert.equal(projects.projects.length, 1); assert.equal(projects.projects[0].git, true);
      stage = '清单读取'; started = performance.now();
      const tasks = awaitingTasks({ home, root: repo });
      samples.manifest_read.push(performance.now() - started); assert.equal(tasks.length, 1000);
      stage = '派发首条进度'; samples.dispatch_first_progress.push(await firstProgress(repo, env, i));
      stage = '门禁与空验收命令'; started = performance.now();
      const gate = await runGate({ root: repo, base: baseSha, spec: { verify: [emptyCommand] }, env, dir: path.join(base, 'gate'), now: () => performance.now() });
      const gateMs = performance.now() - started;
      assert.equal(gate.ok, true); assert.equal(gate.commands.length, 1); assert.equal(gate.commands[0].exit, 0);
      started = performance.now();
      const command = await runCommand(emptyCommand, { cwd: repo, env });
      const commandMs = performance.now() - started;
      assert.equal(command.exit, 0); assert.equal(command.error, null); assert.equal(command.timedOut, false);
      samples.gate_overhead.push(gateMs - commandMs);
    }
    stage = '读取和汇总上限';
    const limits = calibrate ? {} : JSON.parse(readFileSync(limitsFile, 'utf8'));
    if (!calibrate && (limits.version !== 1 || !limits.limits || typeof limits.limits !== 'object' || Array.isArray(limits.limits))) throw Error('上限文件无效');
    const metrics = Object.entries(samples).map(([name, values]) => {
      const limit = calibrate ? null : (limits.limits[name] ?? null);
      if (!calibrate && limit === null) process.stderr.write(`性能上限未设：${name}\n`);
      const metric = summarize(name, values, limit);
      if (!metric.ok) process.stderr.write(`性能超限：${name} ${metric.median} ms > ${metric.limit} ms\n`);
      return metric;
    });
    return { version: 1, fixture: { tasks: fixture.tasks.length, events: fixture.events.reduce((n, list) => n + list.length, 0) }, metrics, ok: metrics.every(metric => metric.ok) };
  } catch { throw Error(stage); }
  finally { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

async function main(args) {
  if (args.length && !(args.length === 1 && args[0] === '--calibrate')) { process.stderr.write('性能基准失败：参数错误\n'); return 2; }
  try {
    const result = await benchmark(args.length === 1);
    console.log(JSON.stringify(result));
    console.log(`性能基准：${result.ok ? '通过' : '超限'}`);
    return result.ok ? 0 : 1;
  } catch (error) { process.stderr.write(`性能基准失败：${['准备隔离环境', '状态查询', '项目列表', '清单读取', '派发首条进度', '门禁与空验收命令', '读取和汇总上限'].includes(error.message) ? error.message : '清理临时目录'}\n`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
