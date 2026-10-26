// 路径小工具。
import { realpathSync } from 'node:fs';

// 把目录转成长路径（只在"交给执行者"的那一刻用，不用于任何存下来或拿来比较的路径）。
// Windows 上 8.3 短路径（含 ABCDEF~1 这样的段）会让部分执行者（如 Qoder 的只读模式）把读取当成需要批准的操作；
// realpathSync.native 返回系统认的真实长路径。失败（目录不存在、没权限）或非 Windows 时原样返回。
export function longPath(dir) {
  if (process.platform !== 'win32' || typeof dir !== 'string' || !dir) return dir;
  try { return realpathSync.native(dir); } catch { return dir; }
}
