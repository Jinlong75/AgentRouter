// process.mjs 的类型声明（软件主进程用 TypeScript 引入；与 compat.d.mts、spec.d.mts 同一做法）。
// 只列出软件主进程用到的导出，行为以 process.mjs 为准。
export interface ProcessRow {
    pid: number;
    parent: number;
    created: number;
    name: string | null;
    command: string;
}
export declare function pidAlive(pid: number): boolean;
export declare function processList(pid?: number, platform?: string, timeout?: number): Promise<ProcessRow[]>;
export declare function killProcessTree(pid: number, options?: {
    platform?: string;
    timeout?: number;
    expectedCreated?: number;
}): Promise<void>;
