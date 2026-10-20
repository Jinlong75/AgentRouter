// compat.mjs 的类型声明（软件主进程用 TypeScript 引入）。
type Env = Record<string, string | undefined>;
export declare const homeEnv: string[];
export declare const noWatchEnv: string[];
export declare function pickName(env: Env, ...keys: string[]): string | undefined;
export declare function userDirectory(env?: Env, platform?: string): string;
export declare function homeDirectory(env?: Env, platform?: string): string;
export declare function legacyHomeDirectory(env?: Env, platform?: string): string;
export declare function legacyHomeFor(home: string): string;
export declare function dryRun(env: Env): boolean;
export declare function noWatch(env: Env): boolean;
export declare function testAgent(env: Env): string | undefined;
export declare function testStartTimeout(env: Env): number | null;
export declare const legacyRunsName: string;
export declare function legacyRunsDir(root: string): string;
export declare const testAgentEnv: string[];
export declare const scriptNames: string[];
export declare const installMarkers: string[];
