import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { appEnvironment } from './app-env.mjs';
import { coreScript } from './core';
import { effects } from './effects';
import { cpuNow, extraReports } from './shots-input';

// ---- 诊断：核心子进程启动的阶段计时（PR #5 CI）----
// 同一条核心命令可用两种运行时启动（Electron-as-Node / node.exe），都打开核心追踪。时刻分三类记：
// 父进程观察（主进程 Date.now）、子进程内部（追踪行的 +ms，子进程自己的 performance 时间原点）、
// 输出传输（追踪行里子进程写出的墙上时刻 @ms → 主进程收到这一行的时刻）。两边墙上时钟是同一台机器的系统时钟。
export type SpawnPhases = {
    runtime: 'electron' | 'node'; requested: number; spawnSyncMs?: number; spawned?: number; firstOut?: number; exitAt?: number; closeAt?: number;
    code?: number | null; timedOut?: boolean; trace: string[]; traceAt: number[]; cpu?: string;
};
export function spawnPhases(runtime: 'electron' | 'node', args: string[], opts: { timeoutMs?: number; onStall?: (p: SpawnPhases) => void; stallMs?: number } = {}): Promise<SpawnPhases> {
    return new Promise(resolve => {
        const exe = runtime === 'electron' ? process.execPath : process.env.AR_TEST_NODE!;
        const env = { ...appEnvironment(process.env), AR_CORE_TRACE: '1', ...(runtime === 'electron' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
        const p: SpawnPhases = { runtime, requested: Date.now(), trace: [], traceAt: [] };
        const t0 = performance.now();
        const child = spawn(exe, [coreScript(), ...args, '--json'], { env, shell: false, windowsHide: true });
        p.spawnSyncMs = Math.round((performance.now() - t0) * 10) / 10;
        const kill = setTimeout(() => { p.timedOut = true; child.kill(); }, opts.timeoutMs ?? 30000);
        const stall = opts.onStall ? setTimeout(() => { if (!p.trace.length) opts.onStall!(p); }, opts.stallMs ?? 1000) : undefined;
        child.once('spawn', () => { p.spawned = Date.now(); });
        child.stdout.once('data', () => { p.firstOut = Date.now(); });
        child.stdout.resume();
        let rest = '';
        child.stderr.setEncoding('utf8').on('data', (d: string) => {
            const lines = (rest + d).split(/\r?\n/); rest = lines.pop() ?? '';
            for (const line of lines) if (line.startsWith('[ar-trace] ')) { p.trace.push(line.slice(11)); p.traceAt.push(Date.now()); }
        });
        const done = () => { clearTimeout(kill); if (stall) clearTimeout(stall); p.closeAt = Date.now(); resolve(p); };
        child.once('exit', code => { p.exitAt = Date.now(); p.code = code; });
        child.once('close', done);
        child.once('error', done);
        child.stdin.end();
    });
}
// 追踪行里的墙上时刻（@ms）与子进程自己的时刻（+ms）；text 为空时取第一行（最早可观测追踪标记）。
export const wall = (p: { trace: string[] }, text?: string) => { const line = text ? p.trace.find(l => l.includes(text)) : p.trace[0]; const at = line?.match(/@(\d+)/)?.[1]; return at ? Number(at) : undefined; };
export const internal = (p: { trace: string[] }, text?: string) => { const line = text ? p.trace.find(l => l.includes(text)) : p.trace[0]; const at = line?.match(/^\+(\d+)ms/)?.[1]; return at ? Number(at) : undefined; };
const stats = (values: number[]) => {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? `最小 ${v[0]} / 中位 ${v[Math.floor((v.length - 1) / 2)]} / 最大 ${v.at(-1)} ms（${v.length} 次）` : '无数据';
};
// 启动：请求 → 主进程收到最早可观测追踪标记；退出：子进程墙上"命令结束" → 主进程 exit 事件。
const startup = (p: SpawnPhases) => p.traceAt.length ? p.traceAt[0] - p.requested : NaN;
const exiting = (p: SpawnPhases) => { const end = wall(p, '命令结束'); return end && p.exitAt ? p.exitAt - end : NaN; };
export function phaseLine(p: SpawnPhases, origin: number) {
    const first = wall(p), self = internal(p);
    const clockStart = first !== undefined && self !== undefined ? first - self : undefined;
    return `${p.runtime} @+${p.requested - origin}ms：父进程观察 spawn 同步 ${p.spawnSyncMs}ms、spawn 事件 +${(p.spawned ?? NaN) - p.requested}ms、收到最早追踪标记 ${p.traceAt.length ? `+${p.traceAt[0] - p.requested}ms` : '未收到'}、exit +${(p.exitAt ?? NaN) - p.requested}ms、close +${(p.closeAt ?? NaN) - p.requested}ms code=${p.code}${p.timedOut ? '（超时被结束）' : ''}`
        + `；子进程内部 时钟起点相对请求 ${clockStart === undefined ? '—' : `+${clockStart - p.requested}ms`}、起点到最早标记 ${self ?? '—'}ms、业务 ${first && wall(p, '命令结束') ? wall(p, '命令结束')! - first : '—'}ms`
        + `；输出传输 最早标记 写出→收到 ${first !== undefined && p.traceAt.length ? p.traceAt[0] - first : '—'}ms、标准输出 写出→收到 ${wall(p, '写出标准输出') && p.firstOut ? p.firstOut - wall(p, '写出标准输出')! : '—'}ms；退出 命令结束→exit ${Number.isFinite(exiting(p)) ? exiting(p) : '—'}ms${p.cpu ? `；卡住时的 CPU：${p.cpu}` : ''}`;
}

// ---- 运行期对照探针（AR_SHOTS_PROBE=1，PR #5 CI）----
// 完整界面验收期间，后台每 5 秒交替用 Electron-as-Node 与 node.exe 启动一次 `ar version`，看主流程的核心进程卡住时
// 两种运行时是否同样受影响。有界：同时最多 1 个探针、最多 240 次、单次 30 秒超时；某次 1 秒内没收到追踪标记时
// 当场做一次 CPU 采样（整个运行最多 3 次、不并发）。探针自己的开销单独记录并打印。
// 默认不开：push / PR 的完整回归不带探针，作为对照；带探针的运行是专项实验，不计作完整界面回归。
const PROBE_INTERVAL = 5000, PROBE_MAX = 240, PROBE_CPU_MAX = 3, SLOW = 1000;
export function startProbe() {
    if (process.env.AR_SHOTS_PROBE !== '1') return async () => {};
    const origin = Date.now(), all: SpawnPhases[] = [];
    let stopped = false, cpuTaken = 0, cpuBusy = false, cpuMs = 0, inFlightMs = 0;
    const onStall = (p: SpawnPhases) => {
        if (cpuBusy || cpuTaken >= PROBE_CPU_MAX) return;
        cpuBusy = true; cpuTaken++; const t = performance.now();
        void cpuNow().then(text => { p.cpu = text; }, e => { p.cpu = `采样失败：${e instanceof Error ? e.message : String(e)}`; }).finally(() => { cpuMs += performance.now() - t; cpuBusy = false; });
    };
    const loop = (async () => {
        for (let i = 0; i < PROBE_MAX && !stopped; i++) {
            const p = await spawnPhases(i % 2 ? 'node' : 'electron', ['version'], { onStall, stallMs: SLOW });
            all.push(p); inFlightMs += (p.closeAt ?? Date.now()) - p.requested;
            if ((startup(p) > SLOW || !p.traceAt.length) && !stopped) console.log(`探针卡顿：${phaseLine(p, origin)}`);
            const wait = Date.now(); while (!stopped && Date.now() - wait < PROBE_INTERVAL) await new Promise(r => setTimeout(r, 200));
        }
    })();
    const recent = (windowMs: number) => {
        const now = Date.now(), rows = all.filter(p => p.requested >= now - windowMs);
        return `最近 ${windowMs / 1000} 秒的运行期探针：${rows.map(p => `${p.runtime} 启动 ${Number.isFinite(startup(p)) ? startup(p) + 'ms' : '未收到最早追踪标记'}`).join('；') || '（没有）'}`;
    };
    extraReports.push(recent);
    return async () => {
        stopped = true; await loop;
        const runMs = Date.now() - origin;
        for (const runtime of ['electron', 'node'] as const) {
            const rows = all.filter(p => p.runtime === runtime);
            console.log(`运行期探针汇总（${runtime}）：启动（请求→收到最早追踪标记）${stats(rows.map(startup))}；子进程内部起点到最早标记 ${stats(rows.map(p => internal(p) ?? NaN))}；退出（命令结束→exit）${stats(rows.map(exiting))}；超过 ${SLOW} ms 或未收到 ${rows.filter(p => !(startup(p) <= SLOW)).length} 次`);
        }
        // 主流程里慢的核心进程（收到最早追踪标记超过 1 秒、或一直没收到）与同一时段的探针对照。
        const slowMain = effects.coreLog.filter(e => e.requested >= origin && (!e.traceAt?.length ? (e.exited ?? Date.now()) - e.requested > SLOW : e.traceAt[0] - e.requested > SLOW));
        for (const e of slowMain) {
            const end = e.exited ?? Date.now();
            const overlap = all.filter(p => p.requested <= end && (p.closeAt ?? Date.now()) >= e.requested);
            console.log(`运行期对照：主流程 #${e.seq} ar ${e.args} @+${e.requested - origin}ms 收到最早追踪标记 ${e.traceAt?.length ? `+${e.traceAt[0] - e.requested}ms` : '未收到'}；同时段探针 ${overlap.map(p => phaseLine(p, origin)).join(' | ') || '（没有重叠的探针）'}`);
        }
        const sync = all.map(p => p.spawnSyncMs ?? 0);
        console.log(`探针开销：${all.length} 次（运行 ${Math.round(runMs / 1000)} 秒），主进程同步 spawn 合计 ${Math.round(sync.reduce((a, b) => a + b, 0))}ms、最大 ${Math.max(0, ...sync)}ms；探针在途合计 ${inFlightMs}ms（占运行 ${(inFlightMs / Math.max(1, runMs) * 100).toFixed(1)}%）；卡顿时 CPU 采样 ${cpuTaken} 次、合计 ${Math.round(cpuMs)}ms`);
    };
}
