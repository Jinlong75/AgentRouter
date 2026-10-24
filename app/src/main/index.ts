import { app, BrowserWindow, ipcMain, nativeTheme, dialog, screen, session, Tray, Menu, nativeImage } from 'electron';
import { effects } from './effects';
import { quitEvent, quitStep, quitWatchdog } from './quit-trace';
import { appEnvironment } from './app-env.mjs';
import { appDataDir, migrateAppData } from './app-data';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { Registry, reportText } from './registry';
import { windowsPlatform } from './platform';
import { readEvents, validCursor } from './events';
import { worktreeState, type Task, type Snapshot, type GateResult } from '../shared/types';
import { c, cx, p, wt } from '../shared/copy';
import { coreRun } from './core';
import { createConsole } from './console.mjs';
import { runClearCache, secretNames, writeResetMarker, cleanupScript } from './reset.mjs';
import { homeDirectory, legacyHomeDirectory, homeEnv, unsafeHome } from '../../../core/lib/compat.mjs';
import { parseJson } from '../../../core/lib/json.mjs';
import { mkdtempSync } from 'node:fs';
// 软件内部用的环境（演示的隔离覆盖只合并在这里，process.env 保持用户原样，见 app-env.mjs）。
const env = appEnvironment(process.env);
// 公共目录与核心一致：%APPDATA%\agent-router（AGENT_ROUTER_HOME 覆盖）；旧任务另从 codex-dispatch 目录读取。
const home = homeDirectory(env), legacyHome = legacyHomeDirectory(env);
// 公共目录保护（052 / 协议第 1 节"软件主进程同样保护"）：与核心同一个 unsafeHome，用合并后的内部环境判断。
// 必须在任何写操作之前判断（userData、单实例锁、迁移、窗口、托盘、Worker 都在下面）。
const unsafeReason = unsafeHome(home, { env });
if (unsafeReason) {
    // Electron 默认数据目录是 %APPDATA%\agent-router（用户真实的公共目录），先指到临时目录下的一次性目录。
    app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'agent-router-unsafe-home-')));
    console.error(unsafeReason);
    // 界面验收模式只打印，不弹框（弹框会挡住自动检查）。
    if (!process.env.AR_SHOTS) dialog.showErrorBox(p.homeUnsafeTitle, unsafeReason);
    app.exit(2);
    // 兜底：确保 app.exit 之后不再执行下面的取锁、迁移与创建窗口，退出码保持 2。
    process.exit(2);
}
const isolated = homeEnv.some(key => env[key]);
// 软件自己的数据一律放在公共目录下的 monitor\（隔离时在临时 home 里），见 app-data.ts。
app.setPath('userData', appDataDir(home));
const data = app.getPath('userData');
// 单实例：锁按 userData 区分（Electron 的锁文件就在 userData 里），所以隔离公共目录里的验收 / 演示
// 与用户正在用的软件互不影响；同一个公共目录第二次启动时只把已有窗口显示出来。
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
// 修复前软件文件写在公共目录根上：首次启动复制到新位置（只复制不删除）。失败只报告，不阻止启动。
try { const copied = migrateAppData(home, data); if (copied.length) console.log(`已把软件数据迁移到 ${data}：${copied.join('、')}`); }
catch (e) { console.error(e instanceof Error ? e.message : String(e)); }
// AR_DISABLE_GPU=1 关闭硬件加速：针对当前观察到的 NVIDIA 驱动路径删除目录行为的临时规避措施，后续重新评估。
// 演示（npm run demo）默认设为 1；安装版默认不设，保留为诊断开关。
if (process.env.AR_SHOTS || process.env.AR_DISABLE_GPU === '1')
    app.disableHardwareAcceleration();
let win: BrowserWindow, registry: Registry, quitting = false;
let prefsWorker: Worker;
let managedWorker: Worker;
function closeManaged() {
    if (!managedWorker || managedWorker.threadId === -1) return Promise.resolve();
    // 等当前认领完成再退出线程，不能在改名与启动执行者之间强制终止。
    return new Promise<void>(resolve => { managedWorker.once('exit', () => resolve()); managedWorker.postMessage('close'); });
}
let notifications = true;
let windowSave: Promise<void> = Promise.resolve();
// 关闭询问、托盘与重置（012）的跨模块状态。
type OwnSettings = { notifications: boolean; theme: 'system' | 'light' | 'dark'; wizardDone: boolean; closeAction: 'ask' | 'tray' | 'quit'; trayHintShown: boolean };
let own: OwnSettings = { notifications: true, theme: 'system', wizardDone: false, closeAction: 'ask', trayHintShown: false };
let preferencesCall: ((action: string, payload?: Record<string, unknown>) => Promise<any>) | null = null;
const iconPath = path.join(__dirname, 'icons', process.platform === 'win32' ? 'app.ico' : 'app-256.png');
let tray: Tray | null = null;
let pendingShow = false;
let closeDialog = false, closeQueued = false, closeReady = false, closeAccepted = false, resetting = false;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

// 托盘菜单与单击：窗口可能还没创建完（第二次启动来得早），记下来等窗口就绪。
function showWindow() {
    if (!win || win.isDestroyed()) { pendingShow = true; return; }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
}
function runningCount() { return registry?.tasks.filter(t => t.status === 'run').length ?? 0; }
function updateTray() {
    const tip = p.trayTip(runningCount());
    // 验收模式不创建真实图标，只记一份状态供检查（关闭 / 托盘 UI 检查用）。
    if (effects.stub) {
        if (!effects.tray) effects.tray = { tip, items: [p.trayOpen, p.trayQuit], opened: 0, destroyed: false,
            open: () => { effects.tray!.opened++; showWindow(); }, quit: () => app.quit() };
        effects.tray.tip = tip;
        return;
    }
    if (!tray) {
        tray = new Tray(nativeImage.createFromPath(iconPath));
        tray.setToolTip(tip);
        tray.on('click', () => showWindow());
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: p.trayOpen, click: () => showWindow() },
            { type: 'separator' },
            { label: p.trayQuit, click: () => app.quit() },
        ]));
        return;
    }
    tray.setToolTip(tip);
}
function destroyTray() {
    if (effects.tray) effects.tray.destroyed = true;
    tray?.destroy();
    tray = null;
}
async function persistOwn(key: keyof OwnSettings, value: unknown) {
    if (!preferencesCall) return;
    try {
        const result = await preferencesCall('own', { key, value });
        own = { ...own, ...result.own };
        notifications = own.notifications;
    }
    catch (e) { errors(e); }
}
function hideToTray() {
    if (!win || win.isDestroyed()) return;
    win.hide();
    // 第一次最小化时提示一次；通知开关关着就不提示，也不记为已提示（以后打开通知还能看到）。
    if (notifications && !own.trayHintShown) {
        effects.notify(c.app, p.trayFirst, () => showWindow());
        void persistOwn('trayHintShown', true);
    }
}
// 页面 5 秒内没有回应（例如卡死）就按退出处理，保证点 × 永远有效。
function askClose() {
    if (closeDialog) return;
    closeDialog = true;
    const send = () => { if (win && !win.isDestroyed()) win.webContents.send('close-request'); };
    if (closeReady) send(); else closeQueued = true;
    // 5 秒兜底只针对"渲染层没能显示询问"（卡死或还没加载好）：询问一旦显示（close-shown），就等用户回答，不再计时。
    closeTimer = setTimeout(() => {
        if (!closeDialog) return;
        closeDialog = false; closeQueued = false; closeTimer = null;
        quitting = true; app.quit();
    }, 5000);
}
function answerClose(action: unknown, remember: unknown) {
    if (!closeDialog) throw Error('没有待回答的关闭询问');
    if (!['cancel', 'tray', 'quit'].includes(action as string)) throw Error('Invalid close action');
    if (typeof remember !== 'boolean') throw Error('Invalid close answer');
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    closeDialog = false; closeQueued = false;
    if (action === 'cancel') return { ok: true };
    if (remember) void persistOwn('closeAction', action);
    if (action === 'tray') hideToTray();
    else {
        // 与点 × 选"退出"相同的正常关闭流程；这一次不再触发询问。
        closeAccepted = true;
        win.close();
    }
    return { ok: true };
}
app.on('second-instance', () => showWindow());
const reportCache = new Map<string, {
    stamp: string;
    text: string;
}>();
async function cachedReport(file: string) {
    const info = await stat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT')
        throw e; return null; });
    if (!info) {
        reportCache.delete(file);
        return '';
    }
    const stamp = `${info.ino}:${info.mtimeMs}:${info.size}`, cached = reportCache.get(file);
    if (cached?.stamp === stamp)
        return cached.text;
    const text = await reportText(file);
    reportCache.set(file, { stamp, text });
    return text;
}
const platform = windowsPlatform(file => effects.open(file));
// 门禁结果（gate.json）：与汇报一样按文件时间戳缓存；不存在为 null，解析失败给出 { error }（界面显示空状态）。
const gateCache = new Map<string, { stamp: string; value: GateResult }>();
async function cachedGate(dir: string): Promise<GateResult> {
    const file = path.join(dir, 'gate.json');
    const info = await stat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT')
        throw e; return null; });
    if (!info) {
        gateCache.delete(file);
        return null;
    }
    const stamp = `${info.ino}:${info.mtimeMs}:${info.size}`, cached = gateCache.get(file);
    if (cached?.stamp === stamp)
        return cached.value;
    let value: GateResult;
    try {
        const parsed = parseJson(await readFile(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw Error('内容不是对象');
        value = parsed as GateResult;
    }
    catch (e) {
        value = { error: e instanceof Error ? e.message : String(e) };
    }
    gateCache.set(file, { stamp, value });
    return value;
}
const snapshot = (select?: string, selectPage?: 'accept'): Snapshot => ({ tasks: registry?.tasks ?? [], processCheck: registry?.processCheck, theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', version: app.getVersion(), select, ...(selectPage ? { selectPage } : {}), concurrency: registry?.concurrency });
const publish = (select?: string, selectPage?: 'accept') => { updateTray(); if (win && !win.isDestroyed())
    win.webContents.send('snapshot', snapshot(select, selectPage)); };
const errors = (e: unknown) => console.error(e instanceof Error ? e.message : String(e));
// 点通知：显示窗口；待验收与冲突通知还要切到验收页并选中任务。
const openFromNotice = (id: string, page?: 'accept') => { win.show(); if (win.isMinimized())
    win.restore(); win.focus(); publish(id, page); };
function finished(t: Task) {
    if (!notifications)
        return;
    const project = path.basename(t.repo), state = worktreeState(t);
    // worktree 任务：门禁通过进入待验收，通知"待验收"取代"已完成"；进入冲突另有通知（conflicted），这里不重复发。
    if (state === 'awaiting') {
        effects.notify(wt.notifyTitle(t.title), wt.notifyBody(project), () => openFromNotice(t.id, 'accept'));
        return;
    }
    if (state === 'conflict')
        return;
    const body = t.status === 'done' ? `${project} · ${c.elapsed} ${t.minutes ?? Math.round(((t.ended ?? Date.now()) - t.started) / 60000)} ${c.minutes}` : t.status === 'fail' ? `${project} · exit=${t.exit}` : project;
    effects.notify(`${c.status[t.status]}：${t.title}`, body, () => openFromNotice(t.id));
}
// 合并冲突（ar accept 退出码 4）：与"任务结束时通知"同一个开关。
function conflicted(t: Task) {
    if (!notifications)
        return;
    effects.notify(wt.notifyConflict(t.title), path.basename(t.repo), () => openFromNotice(t.id, 'accept'));
}
// 清除缓存（014）：Chromium 自己的缓存交给 session（异步，不阻塞窗口）；其他缓存目录、会话记录
// 与测试临时目录由内置 Node 子进程删除，主进程只 await 结果。有进行中任务的执行者保留它的会话记录；
// 任务没写 profile 时保守跳过全部。
async function clearCacheNow() {
    const running = registry.tasks.filter(t => t.status === 'run');
    const skipProfiles = [...new Set(running.map(t => t.profile).filter((v): v is string => typeof v === 'string' && !!v))];
    const skipAllProfiles = running.length > 0 && skipProfiles.length < running.length;
    const chromium = session.defaultSession;
    for (const [label, clear] of [
        ['界面缓存', () => chromium.clearCache()],
        ['代码缓存', () => chromium.clearCodeCaches({})],
        ['着色器与 CacheStorage', () => chromium.clearStorageData({ storages: ['shadercache', 'cachestorage'] })],
    ] as const) {
        try { await clear(); }
        catch (e) { console.warn(`${label}清理失败：${e instanceof Error ? e.message : String(e)}`); }
    }
    // 隔离验收时 TEMP 指向临时公共目录，测试临时文件也只在隔离目录里清理。
    const tmp = env.TEMP || env.TMP || os.tmpdir();
    return runClearCache({ home, data, tmp, skipProfiles, skipAllProfiles }, { env, log: message => console.warn(message) });
}
// 重置（012）：只删公共目录、用户勾选的环境变量与技能；项目文件夹永远不碰。
// 删除动作交给退出后启动的清理进程（见 reset.mjs 的 cleanupHome），本进程退出前先写好标记。
async function resetNow(payload: unknown) {
    if (resetting) throw Error('正在重置');
    const running = runningCount();
    if (running) throw Error(p.resetRunning(running));
    const options = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as { secrets?: unknown; skills?: unknown } : {};
    if (typeof options.secrets !== 'boolean' || typeof options.skills !== 'boolean') throw Error('Invalid reset');
    resetting = true;
    try {
        if (!preferencesCall) throw Error('软件还在启动中，稍后再试');
        const settings = await preferencesCall('settings');
        const names = secretNames({ profiles: settings.profiles });
        const removedSecrets: string[] = [];
        if (options.secrets) {
            for (const name of names) {
                const result = await coreRun(['secrets', 'unset', name], { env, timeoutMs: 20000 });
                if (result.code !== 0 || result.json?.ok === false) throw Error(result.json?.error ?? `删除环境变量 ${name} 失败`);
                removedSecrets.push(name);
            }
        }
        let skillsRemoved = 0;
        if (options.skills) {
            const install = await import(pathToFileURL(path.join(__dirname, 'installer', 'lib', 'install.mjs')).href);
            const result = await install.uninstall({ env });
            skillsRemoved = result?.changed?.length ?? 0;
        }
        // 隔离验收用：记录密钥文件里还剩哪些名字（值从不读取、不落盘）。
        let remainingSecrets: string[] | null = null;
        if (env.AR_TEST_SECRETS_FILE) {
            try { remainingSecrets = Object.keys(parseJson(await readFile(env.AR_TEST_SECRETS_FILE, 'utf8'))); }
            catch { remainingSecrets = []; }
        }
        // 托管线程先正常退出，再让清理进程等本进程结束后删目录。
        await closeManaged();
        writeResetMarker(home);
        const evidence = { home, secretNames: names, removedSecrets, remainingSecrets, skillsRemoved, secretsRequested: options.secrets, skillsRequested: options.skills };
        // 验收证据：工具在 Electron 退出后读取，断言"勾选的都做了"。
        if (process.env.AR_SHOTS && isolated)
            await writeFile(path.join(process.env.AR_SHOTS, 'reset-evidence.json'), JSON.stringify(evidence, null, 2)).catch(errors);
        spawnCleanup();
        destroyTray();
        quitting = true;
        // 等 IPC 的回复发出去再退出（渲染层已经显示"正在重置…"）。
        setImmediate(() => app.quit());
        return evidence;
    }
    catch (e) { resetting = false; throw e; }
}
function spawnCleanup() {
    // 参数数组、shell:false；删除路径只经 -e 代码里的 JSON 字符串传入，不进命令行参数表之外的地方。
    // 标准输入留成管道：本进程退出时管道关闭，清理进程据此确定"软件真的退出了"（只靠 pid 在 Windows 上不可靠）。
    const child = spawn(process.execPath, ['-e', cleanupScript(home, process.pid)], {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: ['pipe', 'ignore', 'ignore'], shell: false, windowsHide: true,
    });
    child.on('error', errors);
    child.stdin?.on('error', () => { /* 父进程退出时管道断开是预期情况。 */ });
    // 管道是本进程与清理进程之间唯一的活连接；unref 让它不拖住主进程退出（Node 类型里看不到 Socket 的 unref）。
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    child.unref();
}
app.whenReady().then(async () => {
    // 没抢到单实例锁的进程直接结束（窗口与线程都不创建）。
    if (!primary) return;
    await mkdir(data, { recursive: true });
    prefsWorker = new Worker(path.join(__dirname, 'preferences.mjs'), { workerData: { root: __dirname, data }, env });
    let requestId = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    prefsWorker.on('message', ({ id, value, error }) => { const p = pending.get(id); pending.delete(id); if (error) p?.reject(Error(error)); else p?.resolve(value); });
    prefsWorker.on('error', error => { for (const p of pending.values()) p.reject(error); pending.clear(); });
    const preferences = (action: string, payload?: Record<string, unknown>) => new Promise<any>((resolve, reject) => { const id = ++requestId; pending.set(id, { resolve, reject }); prefsWorker.postMessage({ id, action, payload }); });
    preferencesCall = preferences;
    const initial = await preferences('settings');
    own = { ...own, ...initial.own };
    notifications = initial.own.notifications;
    nativeTheme.themeSource = initial.own.theme;
    const tokens = await readFile(path.join(__dirname, 'tokens.css'), 'utf8');
    const token = (key: string) => tokens.match(new RegExp(`\\[data-theme="${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}"\\]\\s*\\{([^}]+)`))![1].match(new RegExp(`--${key}:\\s*([^;]+)`))![1].trim();
    let bounds: {
        width: number;
        height: number;
        x?: number;
        y?: number;
    } = { width: 1160, height: 720 };
    try {
        const saved = parseJson(await readFile(path.join(data, 'window.json'), 'utf8'));
        if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
            bounds = { width: Math.max(960, saved.width), height: Math.max(600, saved.height) };
            if (Number.isFinite(saved.x) && Number.isFinite(saved.y) && screen.getAllDisplays().some(d => saved.x < d.workArea.x + d.workArea.width && saved.x + saved.width > d.workArea.x && saved.y < d.workArea.y + d.workArea.height && saved.y + 44 > d.workArea.y)) {
                bounds.x = saved.x;
                bounds.y = saved.y;
            }
        }
    }
    catch { }
    const shotMode=!!(process.env.AR_SHOTS&&isolated);
    effects.stub = shotMode;
    // 验收模式且外部指定了 AR_DEMO_NOW（毫秒）时把它经 additionalArguments 交给 preload（只读，见 037 第 2 项），
    // 让"今天 / 昨天"分组与演示数据用同一个"现在"（跨午夜截图不失败）；正常启动不带这个参数，行为不变。
    const demoNowValue = shotMode ? Number(process.env.AR_DEMO_NOW) : NaN;
    const demoNow = Number.isFinite(demoNowValue) && demoNowValue > 0 ? Math.floor(demoNowValue) : null;
    win = new BrowserWindow({ ...bounds, minWidth: 960, minHeight: 600, show: false, icon: iconPath, title: c.app, autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: { color: token('bg'), symbolColor: token('text-2'), height: 44 }, backgroundColor: token('bg'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling:!shotMode, ...(demoNow ? { additionalArguments: [`--ar-demo-now=${demoNow}`] } : {}) } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    updateTray();
    // 第二次启动在窗口创建之前到达时，等窗口一建好就显示并聚焦（正常启动随后也会 show）。
    if (pendingShow) { pendingShow = false; showWindow(); }
    // 验收时把"核对进程"（每次起一个 PowerShell 查 Win32_Process）也记进调用日志，定位删除、隐藏、停止时的等待点。
    // 验收时任何经 Registry 发出的结束进程树调用都打一行（PR #5 CI：退出后实测要知道有没有走到终止路径）。
    const registryPlatform = effects.stub ? { ...platform, killTree: (pid: number) => { console.error(`[终止调用] killTree(${pid}) @${Date.now()}`); return platform.killTree(pid); }, processes: (pids: number[]) => effects.trace('platform', `processes(${pids.length})`, async () => { if (effects.processFail) throw Error(effects.processFail); return platform.processes(pids); }) } : platform;
    registry = new Registry(home, data, registryPlatform, () => publish(), finished, errors, legacyHome, conflicted);
    if (effects.stub) registry.onPhase = label => { effects.registryLog.push({ at: Date.now(), label }); };
    managedWorker = new Worker(path.join(__dirname, 'managed.mjs'), { workerData: { root: __dirname }, env });
    await new Promise<void>((resolve, reject) => { managedWorker.once('message', () => resolve()); managedWorker.once('error', reject); });
    managedWorker.on('error', errors);
    await registry.start();
    // IPC 只接受来自本窗口主 frame 的有限操作，路径全部从已读取的任务导出。
    const handle = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(name, (e, ...args) => { if (e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame)
        throw Error('Invalid sender'); return fn(...args); });
    // operation：用户操作（菜单、停止等）时传入，找不到任务就记一行日志；详情与事件的轮询不记，避免刷屏。
    const task = (id: unknown, operation?: string) => { if (typeof id !== 'string')
        throw Error('Invalid task'); const t = registry.tasks.find(x => x.id === id); if (!t) {
        if (operation) console.warn(`任务状态已经变了：${operation} ${id}：任务已不在列表里`);
        throw Error(c.changed);
    } return t; };
    handle('preferences', async (action, payload) => {
      const operation = async () => {
        if (typeof action !== 'string' || !['settings','detect','save','own','finish','ack','ackLeftover','install','choosePath','openConfig','clearCache','clearTasks','reset'].includes(action)) throw Error('Invalid preference action');
        if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) throw Error('Invalid payload');
        if (action === 'openConfig') { await mkdir(home, { recursive: true }); const error = await effects.open(home); if (error) throw Error(error); return; }
        if (action === 'clearCache') return clearCacheNow();
        // 清空任务列表（018）：registry 一次把已结束任务的键加入 hidden，返回实际移除数。
        if (action === 'clearTasks') return registry.hideFinished();
        if (action === 'reset') return resetNow(payload);
        if (action === 'choosePath') {
            const selected = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Codex', extensions: ['exe','cmd','js'] }] });
            if (selected.canceled) return null;
            action = 'save'; payload = { key: 'path', value: selected.filePaths[0] };
        }
        // 主题先生效再写偏好文件：写盘慢时（CI、机械硬盘）界面不等它（PR #5 CI 发现的延迟）。
        if (action === 'own' && payload?.key === 'theme' && ['system', 'light', 'dark'].includes(payload.value)) nativeTheme.themeSource = payload.value;
        const result = await preferences(action, payload);
        if (result?.own) {
            own = { ...own, ...result.own };
            notifications = result.own.notifications;
        }
        if (action === 'own' && payload?.key === 'theme') nativeTheme.themeSource = result.own.theme;
        // 改了“同时运行的任务”：后台马上重读一次（上限变了 Registry 会推送快照），侧栏底部的上限随即变化；不等下一轮定时刷新，也不拖慢这次保存的回复。
        if (action === 'save' && payload?.key === 'concurrency') void registry.refresh().catch(errors);
        return result;
      };
      // 验收时偏好通道也记入调用日志（PR #5 CI：编辑执行者要先等 preferences('settings')，原来看不到它是否卡住）。
      try {
        const value = await effects.trace('preferences', String(action), operation);
        // 一次性：只延迟下一次该调用（用后即删），之后的同名调用照常返回。
        const lag = effects.stub ? effects.preferencesDelayAfter[String(action)] : 0;
        if (lag) { delete effects.preferencesDelayAfter[String(action)]; await new Promise(resolve => setTimeout(resolve, lag)); }
        return { ok: true, value };
      }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    // console 通道：界面上的每个写操作都经这里翻译成一条核心命令（见 console.mjs）。
    // testTimeout 平时是 180 秒；只有验收模式（AR_SHOTS 且隔离环境）下 AR_SHOTS_AGENT_TIMEOUT 为正整数时用其值，方便测"超时"不必等 3 分钟。
    const consoleService = createConsole({
      coreRun, messages: cx,
      knownRunDir: dir => registry.knownRunDir(dir),
      openFolder: async dir => { const error = await effects.open(dir); if (error) throw Error(error); },
      launch: (executable, args, { cwd }) => effects.launch(executable, args, cwd),
      // Windows Terminal：用户目录下的应用执行别名（不存在时退回 cmd.exe）。
      findWt: async () => { const wt = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe'); try { await stat(wt); return wt; } catch { return null; } },
      testTimeout: (() => { if (!shotMode) return 180; const v = Number(process.env.AR_SHOTS_AGENT_TIMEOUT); return Number.isInteger(v) && v > 0 ? v : 180; })(),
      chooseFolder: () => effects.chooseFolder(async () => { const selected = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); if (selected.canceled || !selected.filePaths[0]) return null; return selected.filePaths[0]; }),
    });
    handle('console', async (action, payload) => {
      try {
        return { ok: true, value: await effects.trace('console', String(action), async () => {
          const delay = effects.stub ? effects.consoleDelay[String(action)] : 0;
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          return consoleService.call(action, payload);
        }) };
      }
      catch (error) {
        // 核心错误码随失败结果一起交给渲染层（如 NEED_GIT_IDENTITY），界面据此显示对应的指引。
        const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined;
        return { ok: false, error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) };
      }
    });
    handle('snapshot', () => snapshot());
    // 关闭询问：渲染层挂好监听后报告一次；还没报告时的请求先排队。
    handle('close-ready', () => { closeReady = true; if (closeQueued && closeDialog) { closeQueued = false; win.webContents.send('close-request'); } });
    handle('close-choice', (action, remember) => answerClose(action, remember));
    // 关闭询问已显示：取消兜底计时（之前询问显示后 5 秒内没回答，软件会自己退出）。
    handle('close-shown', () => { if (closeDialog && closeTimer) { clearTimeout(closeTimer); closeTimer = null; } });
    // 记录目录从已读取的 progress 路径导出（v2 记录是 <仓库>/.agent-runs/<记录名>/progress.log）；
    // gate.json 与事件、汇报都在同一个目录里。
    handle('detail', async (id) => { const t = task(id); return { report: await cachedReport(t.report), gate: await cachedGate(path.dirname(t.progress)) }; });
    const allowedFiles = new Map<string, Set<string>>();
    handle('events', async (id, cursor, before) => { if (!validCursor(cursor) || before !== undefined && typeof before !== 'boolean')
        throw Error('Invalid cursor'); const t = task(id), page = await readEvents(t, cursor, before); const files = allowedFiles.get(id) ?? new Set<string>(); for (const e of page.events)
        for (const f of e.files ?? [])
            files.add(f.path); allowedFiles.set(id, files); return page; });
    handle('import', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); if (!result.canceled && result.filePaths[0])
        await registry.import(result.filePaths[0]); });
    // 017：批量删除。渲染层只传任务 id 与是否删记录目录，路径全部由 Registry 从任务导出。
    handle('delete-tasks', async (ids, files) => { if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000 || ids.some(id => typeof id !== 'string') || typeof files !== 'boolean')
        throw Error('Invalid delete'); return effects.trace('delete', 'delete-tasks', () => registry.deleteTasks([...new Set(ids as string[])], files)); });
    handle('action', (id, action, value) => effects.trace('action', String(action), async () => {
        const t = task(id, String(action));
        if (action === 'stop')
            return registry.stop(t.id);
        if (action === 'hide')
            return registry.hide(t.id);
        if (action === 'copy') {
            effects.copy(t.name);
            return;
        }
        // 验收页的"撤销说明""复制命令""复制分支名"：把界面算好的一行文字写进剪贴板（走与复制记录名同一个桩 / 通道）。
        if (action === 'copy-text') {
            if (typeof value !== 'string' || !value || value.length > 2000 || /[\r\n]/.test(value))
                throw Error('Invalid text');
            effects.copy(value);
            return;
        }
        if (action === 'link') {
            if (typeof value !== 'string' || !/^https?:\/\//i.test(value))
                throw Error('Invalid link');
            await effects.openExternal(value);
            return;
        }
        let file: string | undefined;
        if (['repo', 'report', 'progress', 'raw', 'events'].includes(action))
            file = t[action as 'repo'];
        if (action === 'spec' && t.spec)
            file = path.resolve(t.repo, t.spec);
        // worktree 任务的"在 worktree 打开"：最近一条 worktree 事件里的目录。
        if (action === 'worktree' && t.wt?.dir)
            file = t.wt.dir;
        if (action === 'file' && typeof value === 'string' && allowedFiles.get(id)?.has(value))
            file = path.resolve(t.repo, value);
        if (!file || !path.isAbsolute(file))
            throw Error('Invalid path');
        // 菜单显示之后文件状态可能变了：打开前再查一次。不存在时给具体原因，不让用户"重试"。
        try { await stat(file); }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw Error(action === 'report' ? c.reportMissing : c.fileMissing);
            throw e;
        }
        // 文件存在但打开失败：保留系统返回的原始错误并带上路径，方便查日志。
        try { await platform.open(file); }
        catch (e) { throw Error(`打开失败：${file}：${e instanceof Error ? e.message : String(e)}`, { cause: e }); }
    }));
    nativeTheme.on('updated', () => { win.setTitleBarOverlay({ color: token('bg'), symbolColor: token('text-2'), height: 44 }); win.setBackgroundColor(token('bg')); publish(); });
    // 点 × 或 win.close()：正在退出时照常关闭；否则按偏好询问 / 最小化到托盘 / 直接退出。
    win.on('close', (e) => {
        quitEvent(`窗口 close（quitting=${quitting}，closeAction=${own.closeAction}）`);
        if (closeAccepted || quitting) {
            closeAccepted = false;
            if (!quitting) windowSave = writeFile(path.join(data, 'window.json'), JSON.stringify(win.getNormalBounds())).catch(errors);
            return;
        }
        const action = own.closeAction;
        if (action === 'tray') {
            e.preventDefault();
            windowSave = writeFile(path.join(data, 'window.json'), JSON.stringify(win.getNormalBounds())).catch(errors);
            hideToTray();
            return;
        }
        if (action === 'quit') {
            windowSave = writeFile(path.join(data, 'window.json'), JSON.stringify(win.getNormalBounds())).catch(errors);
            return;
        }
        e.preventDefault();
        askClose();
    });
    win.on('closed', () => quitEvent('窗口 closed'));
    await win.loadFile(path.join(__dirname, 'index.html'));
    if (process.env.AR_SHOTS && isolated) {
        if (process.env.AR_SHOTS_RESET) {
            // 第二次启动只做一件事：在界面上完成一次真实重置。删除准备完成后主进程自己退出，
            // 不在这里再调 app.quit，免得抢在重置写证据之前。
            const { captureReset } = await import('./shots');
            await captureReset(win, registry, process.env.AR_SHOTS);
            return;
        }
        if (process.env.AR_PACKAGED_VERIFY) {
            const { capturePackaged } = await import('./shots-packaged');
            await capturePackaged(win, process.env.AR_SHOTS);
        } else {
            const { capture } = await import('./shots');
            await capture(win, registry, process.env.AR_SHOTS);
        }
        destroyTray();
        app.quit();
    }
    else win.show();
}).catch(async (e) => { errors(e); await registry?.close(); app.exit(1); });
app.on('window-all-closed', () => { quitEvent('window-all-closed'); app.quit(); });
app.on('before-quit', e => {
    quitEvent(`before-quit（quitting=${quitting}，${quitting ? '放行' : '先阻止，等清理完成后再次 quit'}）`);
    if(quitting)return;
    e.preventDefault();quitting=true;
    quitWatchdog();
    if(win&&!win.isDestroyed())windowSave=writeFile(path.join(data,'window.json'),JSON.stringify(win.getNormalBounds())).catch(errors);
    void Promise.all([quitStep('看板 registry.close', registry?.close()),quitStep('保存窗口位置', windowSave),quitStep('偏好线程 terminate', prefsWorker?.terminate()),quitStep('托管线程退出', closeManaged())]).finally(()=>{ quitEvent('清理结束，再次调用 app.quit'); app.quit(); });
});
app.on('will-quit', () => quitEvent('will-quit'));
app.on('quit', (_e, code) => quitEvent(`quit（exitCode=${code}）`));
