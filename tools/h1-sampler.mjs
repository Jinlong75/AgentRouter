#!/usr/bin/env node
// H1 隔离实验的父进程采样器：用同一套参数数组交替启动 Electron-as-Node 与独立 Node 跑
// tools/h1-child.mjs，记录子进程启动各段的耗时。
// 不导入产品代码，不写用户目录；输出里不出现本机路径。
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = path.join(HERE, 'h1-child.mjs');
const CHILD_TIMEOUT_MS = 60_000;     // 子进程 60 秒没结束：结束进程树并记为超时样本（不丢弃）
const SLOW_MS = 1000;                // "任一段超过 1000 ms"的阈值
const DEFAULT_SAMPLES = 50;          // 安静模式下每种运行时的样本数
const DEFAULT_GAP_MS = 1000;         // 并发度 1：上一个 close 后固定间隔再启动下一个
const DEFAULT_LOAD_INTERVAL_MS = 5000;
const DEFAULT_OUT = 'h1-load.jsonl';
const DEFAULT_STOP_FILE = 'h1-stop';

// 墙上时间（毫秒，浮点）：父进程单调时钟换算到系统时钟，与子进程的 timeOrigin 同一基准。
const wallNow = () => performance.timeOrigin + performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const round = value => value == null ? null : Number(value.toFixed(3));
const fmt = value => value == null ? '—' : value.toFixed(1);

// 两种运行时：同一套参数数组、同样的启动选项，只差可执行文件与 ELECTRON_RUN_AS_NODE。
export function makeRuntimes() {
  const require = createRequire(import.meta.url);
  const electronPath = require('electron');
  if (typeof electronPath !== 'string' || !electronPath) throw new Error('require(\'electron\') 没有返回可执行文件路径');
  return {
    electron: {
      name: 'electron',
      label: 'Electron-as-Node',
      command: electronPath,
      args: [CHILD_SCRIPT],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
    node: {
      name: 'node',
      label: '独立 Node',
      command: process.execPath,
      args: [CHILD_SCRIPT],
      env: {},
    },
  };
}

// ABBA 区组：每轮 4 个样本，次序 E N N E；下一轮起点交换（N E E N），抵消时间漂移。
export function* abbaSequence() {
  const blocks = [
    ['electron', 'node', 'node', 'electron'],
    ['node', 'electron', 'electron', 'node'],
  ];
  for (let round = 0; ; round += 1) yield* blocks[round % 2];
}

// 每种运行时各取 n 个样本的 ABBA 顺序；按区组顺延，某个运行时已够数就跳过它那个位置。
export function abbaOrder(perRuntime) {
  const order = [];
  const counts = { electron: 0, node: 0 };
  for (const name of abbaSequence()) {
    if (counts[name] < perRuntime) {
      order.push(name);
      counts[name] += 1;
    }
    if (order.length === perRuntime * 2) break;
  }
  return order;
}

// 结束整个进程树；参数用数组传，不拼 shell 命令。
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退出 */ }
  }
}

// 跑一个样本：父进程记录 spawn 同步耗时、spawn 事件、各段与 close 的合计。
export async function runSample(runtime, { condition = 'quiet', timeoutMs = CHILD_TIMEOUT_MS } = {}) {
  const spawnWall = wallNow();
  const startedAt = performance.now();
  const relative = () => performance.now() - startedAt;

  return await new Promise(resolve => {
    let child;
    try {
      child = spawn(runtime.command, runtime.args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...runtime.env },
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolve({
        kind: 'sample', condition, runtime: runtime.name,
        spawnSyncMs: 0, spawnEventMs: null, aMs: null, bMs: null, cMs: null, dMs: null,
        totalMs: null, exitCode: null, timedOut: false, error: error.message,
      });
      return;
    }

    const spawnSyncMs = relative();
    // 子进程不读标准输入；立刻关掉这一端，三条管道仍然都建立。
    child.stdin.end();
    let spawnEventMono = null;
    let firstMark = null;
    let firstReceiveMono = null;
    let exitMark = null;
    let exitEventMono = null;
    let timedOut = false;
    let settled = false;
    let spawnError = null;
    let outBuffer = '';
    let errBuffer = '';

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      const sample = {
        kind: 'sample',
        condition,
        runtime: runtime.name,
        spawnSyncMs: round(spawnSyncMs),
        spawnEventMs: round(spawnEventMono == null ? null : spawnEventMono - startedAt),
        aMs: null,
        bMs: null,
        cMs: null,
        dMs: null,
        totalMs: round(relative()),
        exitCode: code,
        timedOut,
        error: spawnError,
      };
      if (firstMark) {
        // A：spawn 调用 → 子进程时间原点；B：时间原点 → 首个标记（子进程自己的单调时钟）。
        sample.aMs = round(firstMark.timeOrigin - spawnWall);
        sample.bMs = round(firstMark.perfNow);
        // C：首个标记写出 → 父进程收到这一行（父进程单调时钟，减去子进程已走过的时长）。
        sample.cMs = round(Math.max(0, (firstReceiveMono - startedAt) - (firstMark.timeOrigin + firstMark.perfNow - spawnWall)));
      }
      if (exitMark && exitEventMono != null) {
        // D：退出标记 → 父进程 exit 事件；退出的 Date.now() 只到毫秒，截断导致的微小负值按 0 记。
        const exitEventWall = spawnWall + (exitEventMono - startedAt);
        sample.dMs = round(Math.max(0, exitEventWall - exitMark.dateNow));
      }
      resolve(sample);
    };

    let forceTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // 结束进程树后万一 close 迟迟不来，也要把样本交出去（仍记为超时）。
      forceTimer = setTimeout(() => finish(null), 15_000);
    }, timeoutMs);

    child.on('spawn', () => { spawnEventMono = performance.now(); });
    child.on('error', error => {
      spawnError = error.message;
      // 启动失败（例如可执行文件不存在）时 close 不一定来；没有 pid 就直接交样本。
      if (!child.pid) setImmediate(() => finish(null));
    });
    child.on('exit', code => { exitEventMono = performance.now(); });
    child.on('close', code => finish(code));

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const at = performance.now();
      outBuffer += chunk;
      let index;
      while ((index = outBuffer.indexOf('\n')) >= 0) {
        const line = outBuffer.slice(0, index);
        outBuffer = outBuffer.slice(index + 1);
        if (firstMark) continue;
        try {
          const value = JSON.parse(line);
          if (value && value.kind === 'first') {
            firstMark = value;
            firstReceiveMono = at;
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      errBuffer += chunk;
      let index;
      while ((index = errBuffer.indexOf('\n')) >= 0) {
        const line = errBuffer.slice(0, index);
        errBuffer = errBuffer.slice(index + 1);
        try {
          const value = JSON.parse(line);
          if (value && value.kind === 'exit') exitMark = value;
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
  });
}

// 最近秩法分位数（p = 90 时取第 ceil(0.9 × n) 个）。
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export const SEGMENTS = ['aMs', 'bMs', 'cMs', 'dMs', 'totalMs'];
export const SEGMENT_LABELS = {
  aMs: 'A 进程创建',
  bMs: 'B 运行时初始化',
  cMs: 'C 输出传输',
  dMs: 'D 退出',
  totalMs: '合计',
};

// 汇总：按条件 × 运行时分组的各段最小 / 中位 / 90 分位 / 最大、超阈值样本数与超时样本数。
// 超时样本不参与分位数（缺段），单独计数；"任一段超过 1000 ms"只看 A～D 四段，合计是各段之和，不重复计。
// "任一段超过阈值"只按 A～D 四段计（合计是各段之和，不重复计；合计的分布看它自己的分位数）。
export function summarizeSamples(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.condition}\u0000${sample.runtime}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }

  const result = [];
  for (const [key, list] of groups) {
    const [condition, runtime] = key.split('\u0000');
    const stats = {};
    for (const segment of SEGMENTS) {
      const values = list
        .filter(sample => !sample.timedOut && typeof sample[segment] === 'number' && Number.isFinite(sample[segment]))
        .map(sample => sample[segment])
        .sort((a, b) => a - b);
      if (!values.length) {
        stats[segment] = null;
        continue;
      }
      const middle = values.length >> 1;
      stats[segment] = {
        min: values[0],
        median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
        p90: percentile(values, 90),
        max: values[values.length - 1],
      };
    }
    const slow = list.filter(sample => !sample.timedOut
      && ['aMs', 'bMs', 'cMs', 'dMs'].some(segment => typeof sample[segment] === 'number' && sample[segment] > SLOW_MS)).length;
    const timeouts = list.filter(sample => sample.timedOut).length;
    result.push({ condition, runtime, count: list.length, timeouts, slow, stats });
  }
  result.sort((a, b) => a.condition.localeCompare(b.condition) || (a.runtime === b.runtime ? 0 : a.runtime === 'electron' ? -1 : 1));
  return result;
}

function sampleLine(sample, index) {
  return `[${sample.condition}] ${sample.runtime} #${index}  spawn同步=${fmt(sample.spawnSyncMs)} spawn事件=${fmt(sample.spawnEventMs)}`
    + ` A=${fmt(sample.aMs)} B=${fmt(sample.bMs)} C=${fmt(sample.cMs)} D=${fmt(sample.dMs)}`
    + ` 合计=${fmt(sample.totalMs)} 退出码=${sample.exitCode ?? '—'}${sample.timedOut ? ' 超时' : ''}${sample.error ? ` 错误=${sample.error}` : ''}`;
}

function printSummary(samples) {
  const groups = summarizeSamples(samples);
  console.log(`\n汇总：共 ${samples.length} 个样本`);
  for (const group of groups) {
    console.log(`\n${group.condition} × ${group.runtime}：样本 ${group.count}，超时 ${group.timeouts}，任一段超过 ${SLOW_MS} ms 的样本 ${group.slow}`);
    for (const segment of SEGMENTS) {
      const stats = group.stats[segment];
      if (!stats) {
        console.log(`  ${SEGMENT_LABELS[segment]}：无有效样本`);
        continue;
      }
      console.log(`  ${SEGMENT_LABELS[segment]}：最小 ${fmt(stats.min)}  中位 ${fmt(stats.median)}  P90 ${fmt(stats.p90)}  最大 ${fmt(stats.max)}`);
    }
  }
}

function electronNodeVersion(electronPath) {
  const result = spawnSync(electronPath, ['-e', 'process.stdout.write(process.versions.node)'], {
    shell: false,
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) return { error: result.error.message };
  if (result.status !== 0) return { error: `退出码 ${result.status}` };
  return { version: String(result.stdout).trim() };
}

function printRunner() {
  const image = [process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join(' ');
  console.log(`运行器：${process.platform} ${process.arch}，处理器 ${os.cpus().length}，系统 ${os.release()}${image ? `，镜像 ${image}` : ''}`);
}

function printVersions(electronPath) {
  const electron = electronNodeVersion(electronPath);
  console.log(`Node 版本（独立 Node）：${process.versions.node}`);
  console.log(`Node 版本（Electron-as-Node）：${electron.version ?? `不可用（${electron.error}）`}`);
  const same = electron.version === process.versions.node;
  if (!same) console.log('!!! 版本不一致：Electron-as-Node 与独立 Node 的 Node 版本不同，结论只在版本一致时有效 !!!');
  return same;
}

function readSamples(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
    .filter(sample => sample.kind === 'sample');
}

// 等固定间隔，期间每 200 ms 看一眼停止文件；看到就提前返回。
async function sleepUntilStop(ms, stopFile) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (existsSync(stopFile)) return true;
    await sleep(Math.min(200, end - performance.now()));
  }
  return existsSync(stopFile);
}

const USAGE = `用法：
  node tools/h1-sampler.mjs --quiet [--samples <N>]
      安静条件：每种运行时各 N 个样本（默认 ${DEFAULT_SAMPLES}），一口气采完并打印汇总。
  node tools/h1-sampler.mjs --load [--interval <ms>] [--out <文件>] [--stop-file <文件>]
      负载条件：后台持续采样（默认每 ${DEFAULT_LOAD_INTERVAL_MS} ms 一个），逐个样本写 JSON 行到输出文件，
      停止文件出现后结束。--out 默认 ${DEFAULT_OUT}，--stop-file 默认 ${DEFAULT_STOP_FILE}。
  node tools/h1-sampler.mjs --summarize <文件>
      读出 --load 写的文件并打印汇总。
`;

function positiveInt(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 需要正整数，收到 ${raw}`);
  return value;
}

function parseArgs(argv) {
  const options = {
    mode: null,
    samples: DEFAULT_SAMPLES,
    interval: DEFAULT_LOAD_INTERVAL_MS,
    out: DEFAULT_OUT,
    stopFile: DEFAULT_STOP_FILE,
    summarize: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} 需要一个值`);
      return argv[i];
    };
    if (arg === '--quiet') options.mode = 'quiet';
    else if (arg === '--load') options.mode = 'load';
    else if (arg === '--summarize') { options.summarize = value(); options.mode = 'summarize'; }
    else if (arg === '--samples') options.samples = positiveInt(value(), arg);
    else if (arg === '--interval') options.interval = positiveInt(value(), arg);
    else if (arg === '--out') options.out = value();
    else if (arg === '--stop-file') options.stopFile = value();
    else if (arg === '--help' || arg === '-h') options.mode = 'help';
    else throw new Error(`未知参数：${arg}`);
  }
  if (!options.mode) throw new Error('需要 --quiet、--load 或 --summarize <文件>');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'help') {
    console.log(USAGE);
    return;
  }
  if (options.mode === 'summarize') {
    printSummary(readSamples(options.summarize));
    return;
  }

  const runtimes = makeRuntimes();
  printRunner();
  printVersions(runtimes.electron.command);

  if (options.mode === 'quiet') {
    console.log(`安静条件：每种运行时 ${options.samples} 个样本，ABBA 区组交替，并发度 1，样本间隔 ${DEFAULT_GAP_MS} ms。`);
    const order = abbaOrder(options.samples);
    const samples = [];
    for (const [index, name] of order.entries()) {
      const sample = await runSample(runtimes[name], { condition: 'quiet' });
      samples.push(sample);
      console.log(sampleLine(sample, index + 1));
      if (index < order.length - 1) await sleep(DEFAULT_GAP_MS);
    }
    printSummary(samples);
    return;
  }

  // 负载条件：并发度仍为 1，按 ABBA 顺序无限采样，直到停止文件出现。
  mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  if (existsSync(options.stopFile)) rmSync(options.stopFile, { force: true });
  writeFileSync(options.out, '');
  console.log(`负载条件：每 ${options.interval} ms 一个样本，ABBA 区组交替，并发度 1，停止文件出现后结束。`);

  const samples = [];
  let index = 0;
  for (const name of abbaSequence()) {
    if (existsSync(options.stopFile)) break;
    const sample = await runSample(runtimes[name], { condition: 'load' });
    samples.push(sample);
    appendFileSync(options.out, JSON.stringify(sample) + '\n');
    index += 1;
    console.log(sampleLine(sample, index));
    if (await sleepUntilStop(options.interval, options.stopFile)) break;
  }
  console.log(`负载条件结束：共 ${samples.length} 个样本，已写入输出文件（用 --summarize 查看汇总）。`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`采样器失败：${error.message}`);
    process.exitCode = 1;
  });
}
