import type * as fs from 'node:fs/promises';
export interface ArInstallDeps {
  readUserPath?: () => Promise<string>;
  writeUserPath?: (value: string) => Promise<void>;
  // 系统 PATH（注册表里的机器变量）；读失败时抛错，arShadow 当作"不知道"处理。
  readMachinePath?: () => Promise<string>;
  // 判断某个 PATH 目录里有没有这个文件（界面检查注入；默认看真实文件系统）。
  exists?: (file: string) => Promise<boolean>;
  // %VAR% 展开与 PATHEXT 用的环境变量（默认 process.env）。
  env?: NodeJS.ProcessEnv;
  fs?: typeof fs;
}
export interface ArInstallOptions {
  localAppData: string;
  appExe: string;
  coreEntry: string;
  deps?: ArInstallDeps;
}
export interface ArShadowResult {
  shadowed: boolean | null;
  by?: string;
}
export function arShadow(options: { localAppData: string; deps?: ArInstallDeps }): Promise<ArShadowResult>;
export function arStatus(options: ArInstallOptions): Promise<{ installed: boolean; path: string; inPath: boolean; owned: boolean; conflict: boolean; shadow: ArShadowResult | null }>;
export function installAr(options: ArInstallOptions): Promise<{ ok: true; path: string; pathChanged: boolean }>;
export function uninstallAr(options: { localAppData: string; deps?: ArInstallDeps }): Promise<{ ok: true; removed: string[]; kept: string[] }>;
