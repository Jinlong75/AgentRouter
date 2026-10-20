import { shell, clipboard, Notification } from 'electron';
import { spawn } from 'node:child_process';

// 有外部副作用的系统调用：打开文件/文件夹/链接、写剪贴板、系统通知。
// 正常运行时直接调用系统；界面验收（npm run shots）时换成只记录参数的桩：
// 证明按钮真的触发了调用，又不在用户桌面上打开资源管理器、改写剪贴板或弹出通知（与 UI18 同一做法）。
export interface Notice { title: string; body: string; click: () => void }
// 验收桩里的托盘：不创建真实图标（不在用户任务栏里多一个图标），只记录状态供检查。
export interface StubTray {
    tip: string;
    items: string[];
    open: () => void;
    quit: () => void;
    opened: number;
    destroyed: boolean;
}
export const effects = {
    stub: false,
    opened: [] as string[],
    // 每次"打开""复制"调用的序号、时刻与参数：检查据此只看本次点击之后产生的新调用（PR #5 CI：只看最后一条会读到旧记录）。
    openLog: [] as { seq: number; at: number; path: string }[],
    copyLog: [] as { seq: number; at: number; text: string }[],
    // 验收时记录渲染层发来的每次核心调用（console）与任务操作（action）：序号、开始 / 结束时刻、成败与错误文字（不记参数）。
    // 用来回答"所需的核心调用完成了没有、报错还是没返回""点击有没有到达主进程"（PR #5 CI）。
    ipcLog: [] as { seq: number; channel: string; name: string; start: number; end?: number; ok?: boolean; error?: string }[],
    coreLog: [] as { seq: number; args: string; requested: number; spawned?: number; firstOutput?: number; lastOutput?: number; stdoutEnd?: number; firstStderr?: number; exitEvent?: number; exited?: number; code?: number | null; trace: string[]; traceAt: number[] }[],
    // Registry 的阶段（串行队列入队 / 出队 / 结束、refresh 用时、删除记录目录）：只在验收时由主进程接上。
    registryLog: [] as { at: number; label: string }[],
    // 验收用：给某些核心调用人为加延迟（毫秒），模拟慢机器上的慢加载；只在 stub 时生效。
    consoleDelay: {} as Record<string, number>,
    // 验收用（确定性专项验证）：下一次该偏好调用算出结果后再延迟返回（一次性，用后即删），模拟"结果在途时别的操作已经完成、返回的是旧状态"；只在 stub 时生效。
    preferencesDelayAfter: {} as Record<string, number>,
    // 验收用（UI21 / W4）：非空时主进程的进程查询直接按这段文字失败，模拟 PowerShell 查询失败；只在 stub 时生效。
    processFail: '',
    async trace<T>(channel: string, name: string, run: () => Promise<T>): Promise<T> {
        if (!this.stub) return run();
        const entry: { seq: number; channel: string; name: string; start: number; end?: number; ok?: boolean; error?: string } = { seq: this.ipcLog.length + 1, channel, name, start: Date.now() };
        this.ipcLog.push(entry);
        try { const value = await run(); entry.ok = true; return value; }
        catch (error) { entry.ok = false; entry.error = error instanceof Error ? error.message : String(error); throw error; }
        finally { entry.end = Date.now(); }
    },
    links: [] as string[],
    copied: [] as string[],
    notices: [] as Notice[],
    // 选择文件夹：验收时不弹对话框，返回检查预先放进 folders 的路径（用完返回 null，相当于取消），并记录调用次数。
    folders: [] as string[],
    folderRequests: 0,
    // 启动外部程序（在项目里打开 Claude Code）：验收时只记录参数。
    launched: [] as { executable: string; args: string[]; cwd: string }[],
    // 托盘（012）：验收时由主进程填入状态；打开动作会计数，便于检查"单击托盘恢复窗口"。
    tray: null as StubTray | null,
    async open(file: string) {
        if (this.stub) { this.opened.push(file); this.openLog.push({ seq: this.openLog.length + 1, at: Date.now(), path: file }); return ''; }
        return shell.openPath(file);
    },
    async openExternal(url: string) {
        if (this.stub) { this.links.push(url); return; }
        await shell.openExternal(url);
    },
    async chooseFolder(show: () => Promise<string | null>) {
        if (this.stub) { this.folderRequests++; return this.folders.shift() ?? null; }
        return show();
    },
    async launch(executable: string, args: string[], cwd: string) {
        if (this.stub) { this.launched.push({ executable, args, cwd }); return; }
        await new Promise<void>((resolve, reject) => {
            const child = spawn(executable, args, { cwd, detached: true, stdio: 'ignore', shell: false, windowsHide: false });
            child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
        });
    },
    copy(text: string) {
        if (this.stub) { this.copied.push(text); this.copyLog.push({ seq: this.copyLog.length + 1, at: Date.now(), text }); return; }
        clipboard.writeText(text);
    },
    notify(title: string, body: string, click: () => void) {
        if (this.stub) { this.notices.push({ title, body, click }); return; }
        if (!Notification.isSupported()) return;
        const n = new Notification({ title, body });
        n.on('click', click);
        n.show();
    },
};
