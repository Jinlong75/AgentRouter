export const cacheDirectoryNames: string[];

export function sizeOf(target: string): number;
export function removeQuietly(target: string, log?: (message: string) => void): boolean;

export function secretNames(config: unknown): string[];

export type ClearCacheResult = { bytes: number; removed: number; skipped: number };
export type ClearCacheOptions = {
    home: string;
    data: string;
    tmp?: string;
    skipProfiles?: string[];
    skipAllProfiles?: boolean;
    // 仅测试注入：fs / path / os 与进度回调；序列化到子进程时只用上面几项。
    fs?: unknown;
    path?: unknown;
    os?: unknown;
    cacheNames?: string[];
    onProgress?: (value: ClearCacheResult) => void;
};
// 014：异步实现，在子进程里执行（ELECTRON_RUN_AS_NODE）；removed / skipped 是文件个数。
export function clearCache(options?: ClearCacheOptions): Promise<ClearCacheResult & { profiles: string[] }>;
export function clearCacheScript(options?: ClearCacheOptions): string;
export function runClearCache(options?: ClearCacheOptions, config?: {
    spawn?: (command: string, args: string[], options: unknown) => any;
    execPath?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    log?: (message: string) => void;
}): Promise<ClearCacheResult>;

export function assertResettableHome(target: string, options?: { userHome?: string; platform?: NodeJS.Platform }): string;

export const resetMarkerName: '.agent-router-reset.json';
export function resetMarkerPath(home: string): string;
export function writeResetMarker(home: string): void;
export function readResetMarker(home: string): { home: string; at?: number } | null;
export function assertResetMarker(home: string, options?: { userHome?: string; platform?: NodeJS.Platform }): string;

export function leftoverPath(tmp?: string): string;
export function readLeftover(tmp?: string): { home: string; at?: number } | null;
export function clearLeftover(tmp?: string): void;

export type CleanupOptions = {
    home?: string;
    parentPid?: number;
    // parentPipe：父进程的标准输入管道关闭即视为已退出（Windows 上只看 pid 不可靠）。
    parentPipe?: boolean;
    // waitMs：等父进程退出的最长时间，默认 120 秒；timeoutMs：退出后尝试删除的最长时间，默认 30 秒。
    waitMs?: number;
    timeoutMs?: number;
    pollMs?: number;
    fs?: unknown;
    path?: unknown;
    os?: unknown;
    sleep?: (ms: number) => Promise<unknown>;
};
export function cleanupHome(options?: CleanupOptions): Promise<{ ok: boolean; home: string; leftover?: boolean }>;
export function cleanupScript(home: string, parentPid: number): string;
