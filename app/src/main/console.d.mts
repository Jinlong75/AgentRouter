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
  // 任务的项目已从项目列表移除时，要写项目的任务操作（合并、重试、再派一次、合并主分支后重跑）的提示（Stage07 116）。
  projectGoneBlocked: string;
  failed: (reason: string) => string;
  timeout: (seconds: number) => string;
}
export interface ConsoleOptions {
  coreRun: (args: string[], opts?: { input?: string; timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<CoreResult>;
  chooseFolder: () => Promise<string | null>;
  // 文件对话框（导入 / 导出声明、浏览程序）：不传时用 Electron 的 dialog（见 fileDialogs）。
  chooseFile?: (options: Record<string, unknown>) => Promise<string | null>;
  saveFile?: (options: Record<string, unknown>) => Promise<string | null>;
  messages: ConsoleMessages;
  testTimeout?: number;
  openFolder?: (dir: string) => Promise<void>;
  launch?: (executable: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) => Promise<void>;
  findWt?: () => Promise<string | null>;
  // tasks:attempt-files 只读看板任务的记录目录：dir 是否是某个已读到的任务的记录目录（Registry.knownRunDir）。
  knownRunDir?: (dir: string) => boolean | Promise<boolean>;
  // 驳回、确认、读改动、tasks:repo-state：看板上是否有这个仓库的这条任务（Registry.knownTask；不看项目登记表）。
  knownTask?: (repo: string, name: string) => boolean | Promise<boolean>;
}
// 默认文件对话框的桩：界面验收（AR_SHOTS）打开 stub 后不弹窗，改取预先放进 open / save 的路径（用完返回 null，相当于取消）。
export const fileDialogs: { stub: boolean; open: string[]; save: string[]; openRequests: Record<string, unknown>[]; saveRequests: Record<string, unknown>[] };
export function specGoal(text: string): string | null;
export function sizeOf(target: unknown): Promise<number>;
export function claudeLaunch(options: { dir: string; name?: string; wt?: string | null }): { executable: string; args: string[] };
export function createConsole(options: ConsoleOptions): { call(action: string, payload?: Record<string, unknown>): Promise<any> };
