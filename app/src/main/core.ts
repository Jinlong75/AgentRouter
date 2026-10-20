import { spawn } from 'node:child_process';
import path from 'node:path';
import { appEnvironment } from './app-env.mjs';
import { effects } from './effects';

// timedOut：超过 timeoutMs 被结束（这时输出里一般没有 JSON，json 是兜底的 { ok:false }）。
export interface CoreResult { code: number; json: any; stderr: string; timedOut?: boolean }

// 软件调用核心的唯一入口：用软件自带的 Node（ELECTRON_RUN_AS_NODE=1）运行 core/ar.mjs，不依赖系统 Node。
// 约定：命令带 --json，标准输出最后一行是一个 JSON 对象；Stage03 起界面上的每个写操作都走这里。
export function coreScript() {
    // 开发：app/dist/core；安装后：resources/app/core（main.cjs 与 core 同级）。
    return path.join(__dirname, 'core', 'ar.mjs');
}

export function coreRun(args: string[], opts: { input?: string; timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CoreResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [coreScript(), ...args, '--json'], {
            cwd: opts.cwd, env: { ...(opts.env ?? appEnvironment(process.env)), ELECTRON_RUN_AS_NODE: '1', ...(effects.stub ? { AR_CORE_TRACE: '1' } : {}) }, shell: false, windowsHide: true,
        });
        let out = '', err = '', timedOut = false;
        // 验收时记下每个核心进程的阶段时刻：请求 → 进程真正启动（spawn）→ 第一次输出 → 退出（PR #5 CI 核心调用卡住时区分是启动慢还是运行慢）。
        type Phases = { seq: number; args: string; requested: number; spawned?: number; firstOutput?: number; lastOutput?: number; stdoutEnd?: number; firstStderr?: number; exitEvent?: number; exited?: number; code?: number | null; trace: string[]; traceAt: number[] };
        const phases: Phases | null = effects.stub ? { seq: effects.coreLog.length + 1, args: args.slice(0, 3).join(' '), requested: Date.now(), trace: [], traceAt: [] } : null;
        if (phases) {
            effects.coreLog.push(phases);
            child.once('spawn', () => { phases.spawned = Date.now(); });
            child.stdout.on('data', () => { phases.firstOutput ??= Date.now(); phases.lastOutput = Date.now(); });
            child.stdout.once('end', () => { phases.stdoutEnd = Date.now(); });
            child.stderr.once('data', () => { phases.firstStderr = Date.now(); });
            child.once('exit', () => { phases.exitEvent = Date.now(); });
        }
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs ?? 60000);
        child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
        // 核心的追踪行（[ar-trace] …）单独收集，不算进错误文字；验收时记下主进程收到每一行的时刻（与行里子进程写出的 @墙上时刻对比得到传输延迟）。
        // 按整行切分：一块数据可能在行中间断开，没换行的尾巴留到下一块（结束时补上）。
        let rest = '';
        const line = (text: string) => {
            if (text.startsWith('[ar-trace] ')) { phases?.trace.push(text.slice(11)); phases?.traceAt.push(Date.now()); }
            else if (text) err += text + '\n';
        };
        child.stderr.setEncoding('utf8').on('data', (d: string) => {
            const lines = (rest + d).split(/\r?\n/); rest = lines.pop() ?? '';
            for (const text of lines) line(text);
        });
        child.stderr.once('end', () => { if (rest) line(rest); rest = ''; });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => {
            clearTimeout(timer);
            if (phases) { phases.exited = Date.now(); phases.code = code; }
            try { resolve({ code: code ?? 1, json: JSON.parse(out.trim().split('\n').pop() || '{}'), stderr: err, timedOut }); }
            catch { resolve({ code: code ?? 1, json: { ok: false, error: err.trim() || '核心没有返回结果' }, stderr: err, timedOut }); }
        });
        child.stdin.end(opts.input ?? '', 'utf8');
    });
}
