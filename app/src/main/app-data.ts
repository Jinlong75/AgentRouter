import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

// 软件自己的数据（Chromium 缓存与会话、偏好、窗口位置、隐藏与导入的任务）一律放在公共目录下的 monitor\，
// 不和核心的协议文件（runs.jsonl、config.json、managed\ 等）混在一起。
// Stage01 把公共目录改名为 agent-router 后，它与 Electron 默认的 userData（%APPDATA%\agent-router，取自 package.json 的 name）
// 重合；Windows 目录名不区分大小写，换成 AgentRouter 也还是同一个目录，所以必须显式指定子目录。
export const appDataDir = (home: string) => path.join(home, 'monitor');

// 软件自己写的三份文件；修复前它们直接写在公共目录根上。
export const appDataFiles = ['preferences.json', 'tasks.json', 'window.json'] as const;

// 迁移：新位置没有、旧位置有时复制过来，返回复制了哪些。只复制不删除——旧文件和留在公共目录里的 Chromium 缓存
// 由用户确认后再清理。复制失败抛出（带路径），由调用方报告。
export function migrateAppData(home: string, data = appDataDir(home)) {
    const copied: string[] = [];
    for (const name of appDataFiles) {
        const from = path.join(home, name), to = path.join(data, name);
        if (!existsSync(from) || existsSync(to)) continue;
        try { mkdirSync(data, { recursive: true }); copyFileSync(from, to); }
        catch (e) { throw Error(`迁移软件数据失败：${from} → ${to}：${e instanceof Error ? e.message : String(e)}`, { cause: e }); }
        copied.push(name);
    }
    return copied;
}
