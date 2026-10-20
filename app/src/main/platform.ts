import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scriptNames } from '../../../core/lib/compat.mjs';
export interface ProcessInfo {
    pid: number;
    name: string;
    command: string;
    created: number;
}
export interface Platform {
    processes(pids: number[]): Promise<ProcessInfo[]>;
    killTree(pid: number): Promise<void>;
    open(file: string): Promise<void>;
}
const run = promisify(execFile);
// 派发进程：node.exe，或用内置 Node 运行核心的软件本身（AgentRouter.exe；开发时为 electron.exe）。
export const runtimeNames = ['node.exe', 'agentrouter.exe', 'electron.exe'];
// 命令行里的派发入口：ar.mjs，或旧版入口（compat.scriptNames）。
const entryPattern = new RegExp(`(?:^|[\\\\/\\s"])(?:${scriptNames.map(s => s.replace(/[.]/g, '\\.')).join('|')})(?:["\\s]|$)`, 'i');
export function dispatchMatches(p: ProcessInfo | undefined, started: number) { return !!p && runtimeNames.includes(p.name.toLowerCase()) && entryPattern.test(p.command) && p.created <= started && started - p.created < 60000; }
export function windowsPlatform(openFile: (file: string) => Promise<string>): Platform {
    return {
        async processes(pids) {
            if (!pids.length)
                return [];
            if (pids.some(p => !Number.isSafeInteger(p) || p <= 0))
                throw Error('Invalid PID');
            const filter = pids.map(p => `ProcessId = ${p}`).join(' OR ');
            const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { @{pid=$_.ProcessId;name=$_.Name;command=$_.CommandLine;created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()} }) | ConvertTo-Json -Compress`;
            // 失败时带上退出码、是否超时被结束、信号、用时与 stderr，便于判断是 PowerShell / WMI 出错还是被超时结束（PR #5 CI 出现过只有"Command failed"的情况）。
            const started = Date.now();
            const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 })
                .catch((error: NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string; code?: number | string }) => {
                    throw Error(`核对进程失败（PowerShell 退出码 ${error.code ?? '无'}，${error.killed ? '超时被结束' : '未被结束'}，信号 ${error.signal ?? '无'}，用时 ${Date.now() - started} ms）：${String(error.stderr ?? '').trim().slice(0, 400) || '（stderr 为空）'}`, { cause: error });
                });
            const value = JSON.parse(stdout.trim() || '[]');
            return (Array.isArray(value) ? value : [value]).map(p => ({ ...p, command: p.command ?? '' }));
        },
        async killTree(pid) { if (!Number.isSafeInteger(pid) || pid <= 0)
            throw Error('Invalid PID'); await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }); },
        async open(file) { const error = await openFile(file); if (error)
            throw Error(error); },
    };
}
