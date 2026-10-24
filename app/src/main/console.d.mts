// console.mjs 的类型声明（与 app-env.d.mts 同法）：TS 里 `import { createConsole } from './console.mjs'` 解析到这里。
export interface CoreResult {
  code: number;
  json: any;
  stderr: string;
}
export interface ConsoleMessages {
  invalid: string;
  noResult: string;
  unknownProject: string;
  failed: (reason: string) => string;
  timeout: (seconds: number) => string;
}
export interface ConsoleOptions {
  coreRun: (args: string[], opts?: { input?: string; timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<CoreResult>;
  chooseFolder: () => Promise<string | null>;
  messages: ConsoleMessages;
  testTimeout?: number;
  openFolder?: (dir: string) => Promise<void>;
  launch?: (executable: string, args: string[], options: { cwd: string }) => Promise<void>;
  findWt?: () => Promise<string | null>;
  // tasks:attempt-files 只读看板任务的记录目录：dir 是否是某个已读到的任务的记录目录（Registry.knownRunDir）。
  knownRunDir?: (dir: string) => boolean | Promise<boolean>;
}
export function specGoal(text: string): string | null;
export function sizeOf(target: unknown): Promise<number>;
export function claudeLaunch(options: { dir: string; name?: string; wt?: string | null }): { executable: string; args: string[] };
export function createConsole(options: ConsoleOptions): { call(action: string, payload?: Record<string, unknown>): Promise<any> };
