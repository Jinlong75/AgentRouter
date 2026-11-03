// ar-command.mjs 的类型声明（软件主进程用 TypeScript 引入；与 json.d.mts、process.d.mts 同一做法）。
// 只列出对外导出，行为以 ar-command.mjs 为准。
export declare const AR_MARKER: string;
export interface ArCommandDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  // 读文件内容（isOurs 看首行与正文）。
  readFile?: (file: string, encoding: string) => Promise<string>;
  // 判断 PATH 目录里有没有这个文件（whichCommand 用）。
  exists?: (file: string) => Promise<boolean>;
  // 解析符号链接目标（isOurs 判断是不是指向 core/ar.mjs）。
  realpath?: (file: string) => Promise<string>;
}
export interface CoreCommandResult {
  command: string;
  shadowedBy?: string | null;
}
export declare function whichCommand(name: string, deps?: ArCommandDeps): Promise<string | null>;
export declare function isOurs(file: string, deps?: Pick<ArCommandDeps, 'readFile' | 'realpath'>): Promise<boolean>;
export declare function coreCommand(deps: ArCommandDeps & { coreDir: string }): Promise<CoreCommandResult>;
