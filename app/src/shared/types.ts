export type Status = 'run' | 'done' | 'fail' | 'stop';
export interface Task {
    id: string;
    repo: string;
    name: string;
    title: string;
    spec: string | null;
    role: string | null;
    pid: number;
    started: number;
    progress: string;
    report: string;
    raw?: string;
    events?: string;
    model: string | null;
    effort: string | null;
    tier: string | null;
    sandbox?: string;
    agent?: string;
    agentVersion?: string;
    dispatcher?: {
        host: string;
        session: string | null;
    };
    agentPid?: number;
    managed?: boolean;
    status: Status;
    exit?: number | null;
    ended?: number;
    minutes?: number;
    signal?: string;
    imported?: boolean;
    legacy?: boolean;
    profile?: string;
    // 执行者适配器与显示名（Stage02 起写在 start 行；旧记录没有）。
    adapter?: string;
    label?: string;
    commit?: string;
    // 汇报文件是否存在（按文件实际存在判断，不按任务是否结束）。
    hasReport?: boolean;
    // 进程查询失败时，记录里仍是"进行中"的任务标为 unknown：保留最后已知状态，不推断它已结束。
    processState?: 'unknown';
    // 门禁（Stage04，协议第 2 节）：只有用任务说明派发、start 行里有 gate 字段的任务才带；
    // 没有这个字段的旧任务与直接文字任务显示与以前完全一样。
    gate?: boolean;
    base?: string;
    // 收到 gating 事件的时刻（界面在进展里画"执行者结束 · 门禁开始"分隔用）。
    gatingAt?: number;
    gateOk?: boolean;
    gateSummary?: string;
    // 执行者进程自己的退出码（end.agentExit）：门禁只在它为 0 时运行。
    agentExit?: number;
    last: string;
}
// 任务记录目录里的 gate.json（文件协议 12.3）；软件只读展示，不写入。
export interface GateCommand {
    line: string;
    argv?: string[];
    exit: number | null;
    ms?: number;
    timedOut?: boolean;
    output?: string;
    truncated?: boolean;
    error?: string | null;
}
export interface GateFile {
    v?: number;
    attempt?: number;
    at?: number;
    ms?: number;
    ok: boolean;
    base?: string | null;
    head?: string | null;
    commit?: { required: boolean; ok: boolean };
    uncommitted?: string[];
    scope?: { allowed?: string[]; changed?: string[]; outside?: string[] };
    commands?: GateCommand[];
    summary?: string;
}
// detail 通道里的门禁结果：文件不存在为 null，解析失败为 { error }。
export type GateResult = GateFile | { error: string } | null;
export interface Event {
    v: 1;
    seq: number;
    at: number;
    kind: 'say' | 'think' | 'cmd' | 'file' | 'plan' | 'tool' | 'turn' | 'error' | 'text';
    text?: string;
    id?: string;
    phase?: 'start' | 'end';
    command?: string;
    exit?: number | null;
    output?: string;
    truncated?: boolean;
    files?: {
        kind: 'add' | 'update' | 'delete';
        path: string;
    }[];
    items?: {
        text: string;
        done: boolean;
    }[];
    name?: string;
    detail?: string;
    usage?: {
        input: number | null;
        output: number | null;
    };
    offset: number;
    time?: string;
}
export interface Cursor {
    source: string;
    start: number;
    end: number;
}
export interface Page {
    events: Event[];
    cursor: Cursor;
    reset: boolean;
}
export interface ProcessCheck { ok: boolean; error?: string; since?: number; failures: number }
export interface Snapshot {
    tasks: Task[];
    // 最近一次进程查询的结果：失败时带错误、首次失败时刻与连续失败次数；成功后清零。
    processCheck?: ProcessCheck;
    theme: 'dark' | 'light';
    version: string;
    select?: string;
}
// 批量删除的结果：deleted 真正从列表删掉的；failed 跳过（进行中 / 找不到 / 路径校验没过）；
// filesLeft 记录目录没删掉的个数（被占用等）。
export interface DeleteResult {
    deleted: number;
    failed: number;
    filesLeft: number;
}
// console 通道部分操作的返回值，字段照核心 --json 的输出（见 core/lib/agents.mjs、project.mjs、spec-new.mjs）。
export interface AgentRow {
    name: string;
    adapter: string;
    label: string;
    enabled: boolean;
    supported: boolean;
    default: boolean;
    auth: 'login' | 'token';
    model: string | null;
    lastTest: { at: number; ok: boolean; seconds: number; version: string | null; error: string | null } | null;
    secrets: Record<string, 'set' | 'missing'>;
    login: 'in' | 'out' | 'unknown' | null;
    installed?: boolean;
    version?: string | null;
}
export interface AgentsList { ok: true; agents: AgentRow[] }
export interface ProjectRow {
    path: string;
    name: string;
    addedAt: number;
    lastUsed: number;
    exists: boolean;
    git: boolean;
    initialized: boolean;
}
export interface ProjectsList { ok: true; projects: ProjectRow[] }
export interface ProjectShow {
    path: string;
    name: string;
    exists: boolean;
    git: boolean;
    branch: string | null;
    dirty: number | null;
    initialized: boolean;
    // 生效的 git 提交身份（仓库、全局、系统合起来）；非 git 仓库或读不到为 null。
    identity: { name: string | null; email: string | null } | null;
    config: Record<string, unknown> | null;
    configError: string | null;
    lastTask: { name: string; started: number } | null;
}
// ar init 的改动项：只有 --dry-run 才带 content（完整内容）与 preview（要追加的部分）。
export interface ProjectChange {
    path: string;
    action: 'create' | 'update';
    content?: string;
    preview?: string;
}
export interface SpecRow {
    file: string;
    rel: string;
    id: string | null;
    title: string;
    mtime: number;
    dispatched: number;
    // 034：说明解析 / 校验出错时核心给出的原因与警告，界面照实显示。
    error?: string;
    warnings?: string[];
}
export interface SpecsList { ok: true; dir: string; specs: SpecRow[] }
// 任务列表与新建任务页的"今天 / 昨天"分组（纯函数，输入任务开始时刻与"现在"，见 037）：
// "现在"在验收 / 演示模式可以被 AR_DEMO_NOW 固定（preload 经 window.dock.demoNow 暴露），跨午夜截图才不会把"今天"并进"昨天"。
export function dayGroup(started: number, now: number): 'today' | 'yesterday' | 'earlier' {
    const day = new Date(now);
    const today = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const yesterday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1).getTime();
    return started >= today ? 'today' : started >= yesterday ? 'yesterday' : 'earlier';
}
export interface API {
    // 验收 / 演示模式下固定的"现在"（毫秒，AR_DEMO_NOW 经主进程 additionalArguments 传给 preload）：正常启动没有这个值。
    demoNow?: number;
    preferences(action: string, payload?: Record<string, unknown>): Promise<any>;
    console(action: string, payload?: Record<string, unknown>): Promise<any>;
    snapshot(): Promise<Snapshot>;
    detail(id: string): Promise<{
        report: string;
        gate: GateResult;
    }>;
    events(id: string, cursor?: Cursor, before?: boolean): Promise<Page>;
    action(id: string, action: string, value?: string): Promise<void>;
    deleteTasks(ids: string[], files: boolean): Promise<DeleteResult>;
    import(): Promise<void>;
    subscribe(callback: (snapshot: Snapshot) => void): () => void;
    // 关闭询问（012）：渲染层挂好监听后报告一次；返回用户的选择。
    closeReady(): Promise<void>;
    closeChoice(action: 'cancel' | 'tray' | 'quit', remember: boolean): Promise<void>;
    // 关闭询问已经显示在界面上（主进程据此取消"渲染层无响应"的兜底退出计时）。
    closeShown(): Promise<void>;
    onCloseRequest(callback: () => void): () => void;
}
export interface Settings {
    managed: boolean;
    values: Record<string, string | null>;
    // 执行者配置原样交给 Agent 页（编辑 claude-code 执行者需要 env / maxTurns / secrets 等预填值）。
    profiles: Record<string, {
        adapter?: string;
        label?: string;
        enabled?: boolean;
        auth?: 'login' | 'token';
        env?: Record<string, string | undefined>;
        // secrets 是"密钥变量名 → 从哪个环境变量读"的映射（值都是字符串，见 core/lib/config.mjs 的 validateV2）。
        secrets?: Record<string, string>;
        maxTurns?: number | null;
    }>;
    exists: boolean;
    reason: string | null;
    file: string;
    current: Record<string, string | undefined>;
    overrides: Record<string, { name: string; value: string }>;
    // 公共目录（重置时显示完整路径）与上次重置没删完的残留标记。
    home: string;
    leftover: { home: string; at?: number } | null;
    own: { notifications: boolean; theme: 'system' | 'light' | 'dark'; wizardDone: boolean; closeAction: 'ask' | 'tray' | 'quit'; trayHintShown: boolean };
}
export interface Connections {
    availableVersion: string;
    hosts: { host: string; detected: boolean; root: string; installedAt: number; actions: string[]; legacy?: string[]; skills: { skill: string; version: string | null; state: string; checked: boolean }[] }[];
    codex: { installed: boolean; version: string | null; login: string; path: string | null; change?: { old: string; next: string } };
}
declare global {
    interface Window {
        dock: API;
    }
}
