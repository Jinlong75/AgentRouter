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
    // 当前派发进程的核对时刻（065）：start 时等于 started（不写出这个字段，读取时按 pidSince ?? started），
    // resume 时等于 resume.at；停止与存活核对用它，开始时间 / 按天分组 / 时长仍用 started。
    pidSince?: number;
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
    // 路由说明（start.route，Stage07 111）：路由器选这个执行者的那一句，例如"全局规则 2：[research] → qoder-cn"；没经过路由的任务没有。
    route?: string;
    // 派发时记的模型、推理强度各自的来源（start / dispatch.json 的 settingSources，154）：值是核心写的中文原文（命令行、环境变量 X、任务说明、路由规则、config.json、内置默认、升级链、已忽略）；旧记录没有。
    settingSources?: { model: string | null; effort: string | null };
    commit?: string;
    // 汇报文件是否存在（按文件实际存在判断，不按任务是否结束）。
    hasReport?: boolean;
    // 进程查询失败时，记录里仍是"进行中"的任务标为 unknown：保留最后已知状态，不推断它已结束。
    processState?: 'unknown';
    // 门禁（Stage04，协议第 2 节）：只有用任务说明派发、start 行里有 gate 字段的任务才带；
    // 没有这个字段的旧任务与直接文字任务显示与以前完全一样。
    gate?: boolean;
    base?: string;
    // 只读运行（调研 / 审查类任务，start.readOnly）；可写任务没有这个字段。
    readOnly?: true;
    // 收到 gating 事件的时刻（界面在进展里画"执行者结束 · 门禁开始"分隔用）。
    gatingAt?: number;
    gateOk?: boolean;
    gateSummary?: string;
    // 执行者进程自己的退出码（end.agentExit）：门禁只在它为 0 时运行。
    agentExit?: number;
    // 尝试列表（Stage05，协议 14.2 / 14.3）：attempt / attempt-end 事件累积；
    // 旧记录（Stage04 及更早）没有这些事件，也就没有这两个字段。
    attempts?: TaskAttempt[];
    // 当前尝试 = 最后一个 attempt（界面显示"尝试 n/N"、重试历史用）。
    attempt?: TaskAttempt;
    // 执行者在最后一次尝试的汇报里列出的需要越界的路径（end.needsScope，协议 14.5）；没有或不合法时没有这个字段。
    needsScope?: NeedsScopeItem[];
    // 最后一次尝试的 attempt-end.outsideWrites（协议 12.4）：有新文件或没能核对时才有；不合法就当没有。
    outsideWrites?: OutsideWrites;
    // worktree 模式（Stage06，协议 15.3）：start 有 worktree: true 的任务才带这两个字段，非 worktree 与旧任务的对象保持原样。
    worktree?: true;
    wt?: WtInfo;
    // 交叉审查（Stage08，协议第 18 节）：reviewing 是审查进行中（reviewing 事件，review 事件到达后清掉）；review 是最近一次有结论的 review 事件的摘要。
    // 没有审查的任务两个字段都没有，任务对象与以前一致。
    reviewing?: { attempt: number; at: number };
    review?: TaskReview;
    last: string;
}
// review 事件的摘要（verdict 为 pass / concerns / fail / unknown / invalid）；needsHuman 来自 review-needs-human，confirmedAt 是最近一条 review-confirm 的时刻。
export interface TaskReview {
    attempt: number;
    run?: number;
    reviewer: string | null;
    crossed: boolean;
    verdict: string;
    issues: number;
    high: number;
    at: number;
    needsHuman?: boolean;
    confirmedAt?: number;
}
// ar review show --json 的 review（顶层 review.json，协议 18.3）：只读展示。
export interface ReviewIssue {
    id: string;
    severity: 'high' | 'medium' | 'low';
    file?: string | null;
    line?: number | null;
    title: string;
    detail?: string;
    confirmation?: { result: 'valid' | 'invalid'; by: string; note: string | null; at: number } | null;
}
export interface ReviewFile {
    attempt?: number;
    run?: number;
    reviewer: string | null;
    crossed: boolean;
    verdict: string;
    summary?: string;
    reviewed?: string[];
    issues: ReviewIssue[];
    ms?: number;
    needsHuman?: boolean;
    at?: number;
}
// ar review stats --json：每个审查者 × 严重度的已确认条数与成立条数；suggestBlock 表示高严重度问题的准确率够高。
export interface ReviewStatsRow {
    reviewer: string;
    severities: Record<'high' | 'medium' | 'low', { confirmed: number; valid: number; accuracy: number | null }>;
    suggestBlock?: boolean;
}
export interface ReviewSettingsView { default: boolean; block: 'none' | 'high'; maxReworks: number }
// 清单里 worktree 任务最后一次影响状态的事件所处的阶段；十种状态由 worktreeState 在它之上再按 status / 门禁事件推出。
export type WtPhase = 'queued' | 'preparing' | 'live' | 'awaiting' | 'accepted' | 'rejected' | 'conflict' | 'failed';
export type WtState = 'queued' | 'preparing' | 'running' | 'gating' | 'awaiting' | 'accepted' | 'rejected' | 'conflict' | 'failed' | 'stopped';
export interface WtInfo {
    phase: WtPhase;
    // 进入排队的时刻（queued 事件的 at；只有 start 时取开始时刻）与进入待验收的时刻（end.exit === 0 的 at）。
    queuedAt?: number;
    awaitingAt?: number;
    // 最近一条 worktree 事件。
    worktreeAt?: number;
    branch?: string;
    dir?: string;
    base?: string;
    // 最近一条 setup 事件；setupFailed 为 end.reason === 'setup'。
    setup?: { ok: boolean; summary?: string };
    setupFailed?: boolean;
    // mode 为 confirm 时是没有改动的确认（调研 / 审查类任务）：merge 为 null，没有合并提交。
    accepted?: { merge: string | null; mode: 'no-ff' | 'squash' | 'confirm'; by: string; at: number };
    // 撤销合并（Stage07b 129）：accepted 之后的 reverted 事件；commit 是反向提交的完整 SHA。
    reverted?: { commit: string; at: number; by: string };
    rejected?: { reason: string; keptBranch: boolean; by: string; at: number };
    // 最近一条 conflict 事件的冲突文件。
    conflictFiles?: string[];
    // accepted / rejected 之后有 ok: false 的 cleanup。
    cleanupFailed?: boolean;
    // 比它先排队、现在仍在排队的任务数（Registry 每次刷新重算；不在排队时没有）。
    ahead?: number;
    // 最近一条 queued 事件带的排队原因（并行调度 140）：overlap 带阻挡任务（名字与前 3 个重叠模式），exclusive 带独占门禁的任务名与命令，busy 带 CPU 百分比；没有 reason 的 queued 事件把它清掉。
    // busy 在可用内存不够时 memLow 为真并带 freeGb（可用内存，GB，一位小数），横幅写内存而不是 CPU（171）。
    queuedWhy?: { reason: 'overlap' | 'exclusive' | 'busy'; name?: string; paths?: string[]; command?: string; cpu?: number; memLow?: boolean; freeGb?: number };
    // 新派发 / 手动重试时与待验收任务改动范围重叠的提示（overlap-note 事件，171）：对方任务的 id 与名字；一个任务可以有多条，之后的事件不清它（界面按对方现在是不是还在待验收决定显示）。
    overlapNotes?: { id: string; name: string }[];
    // 被批准合并后自动按新基线重跑门禁（resume.reason === 'after-merge'，171）：刚合并的任务的 id；下一次不是 after-merge 的 resume 把它清掉。
    rebaseAfter?: string;
    // 这次派发用 --base 指定的基线分支（start 事件的 baseBranch，136）；没指定就没有。和下面 baseBranch（项目主分支）不是一回事。
    startBase?: string;
    // 项目配置里的主分支与合并方式（Registry 读 .agent-router/project.json；读不到为空）。
    baseBranch?: string;
    mergeMode?: 'no-ff' | 'squash';
}
// worktree 任务的十种状态（协议 15.3）；非 worktree 任务返回 null，仍按 status 四态。
// 进程已经不在（status 为 stop，含 interrupted 与派发进程消失）一律是 stopped；其余按最近一条状态事件的阶段：
// 进行中的阶段按门禁事件分 running / gating，end 之后的阶段原样返回（awaiting / accepted / rejected / conflict / failed）。
export function worktreeState(t: Task): WtState | null {
    const w = t.wt;
    if (!t.worktree || !w)
        return null;
    if (t.status === 'stop')
        return 'stopped';
    if (w.phase === 'live')
        return t.gatingAt !== undefined && t.gateOk === undefined && (!t.attempt || t.gatingAt >= t.attempt.at) ? 'gating' : 'running';
    return w.phase;
}
export interface NeedsScopeItem {
    path: string;
    reason: string | null;
}
// 工作区外写入（协议 12.4）：root 为 user（用户目录根）或 home（公共目录根）；只有名字，没有完整路径。
export interface OutsideAdded {
    root: 'user' | 'home';
    name: string;
    type: 'file' | 'dir' | 'other';
}
// checked 为 false 表示没能核对（error 为原因），此时 added 为空。
export interface OutsideWrites {
    checked: boolean;
    added: OutsideAdded[];
    error?: string;
}
// 一次尝试：attempt 行先记开始信息（n、total、profile、reason、at），
// attempt-end 补上结果（ok、exit、gate、usage、ms）；手动重试 total 为 null（协议 14.3）。
export interface TaskAttempt {
    n: number;
    total: number | null;
    profile: string | null;
    reason: string;
    at: number;
    ok?: boolean;
    exit?: number | null;
    gate?: boolean | null;
    usage?: { input: number | null; output: number | null };
    ms?: number;
    needsScope?: NeedsScopeItem[];
    outsideWrites?: OutsideWrites;
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
    // protected / deleted 是 Stage05 加的（协议 12.3）：Stage04 写的 gate.json 没有这两个字段，按可选读取。
    scope?: { allowed?: string[]; changed?: string[]; outside?: string[]; protected?: string[]; deleted?: string[] };
    commands?: GateCommand[];
    // Stage06 加的（协议 12.4）：Stage05 及更早写的 gate.json 没有，按可选读取。
    outsideWrites?: { checked?: boolean; added?: OutsideAdded[]; error?: string };
    summary?: string;
}
// detail 通道里的门禁结果：文件不存在为 null，解析失败为 { error }。
export type GateResult = GateFile | { error: string } | null;
// console 通道 tasks:attempt-files 的返回：某一次尝试的汇报与门禁（attempts/<n>/report.md、gate.json）。
// exists 为 false 表示这个任务没有 attempts/<n>/ 目录（旧任务），界面改读顶层文件。
export interface AttemptFiles {
    exists: boolean;
    report: string;
    gate: GateResult;
}
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
    // 事件所属的尝试（协议 14.2 第 4 条）；主进程解析时保留，界面优先用它；
    // 没有时按事件时刻与各次尝试的开始时刻归属。
    attempt?: number;
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
    // 与 select 一起给出时，选中任务后切到验收页（待验收通知点开用）。
    selectPage?: 'accept';
    // 同时运行任务数上限（config.json 的 concurrency，没写为 2），排队中的说明用。
    concurrency?: number;
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
// agents:presets 的一项（核心 ar agents presets --json）：除了名字、说明，还有给下拉用的可选值。
export interface AgentPreset {
    name: string; title: string; description: string; recommended: boolean; adapter: string; label: string; auth: 'login' | 'token';
    env?: Record<string, string>; secrets?: Record<string, string>;
    model?: string | null; effort?: string | null; provider?: { baseUrl?: string | null; wireApi?: string };
    modelOptions?: string[]; effortOptions?: string[]; baseUrlOptions?: string[]; listModels?: string[]; types?: string[];
    // 预设声明这个执行者不支持推理强度时为 false（Stage07c 154，D87）；核心总会给，旧数据没有时按支持。
    supportsEffort?: boolean;
    // 导入向导把同一 card.id 的预设合成一张卡片，第 2 步用 variant 的分段按钮选具体预设（只给界面用）。
    card?: { id: string; title: string; description: string }; variant?: { label: string; option: string; help: string };
}
// agents:models（payload 带 probe: true，带 name 查已导入的执行者，带 preset 是导入之前查）的返回，字段照核心 ar agents models <名> | --preset <预设> --probe --json（Stage07c 142、169）：
// 查到时 ok 为 true，source 是 api / program，details 是 [{ id, name?, efforts?, defaultEffort? }]；
// 没查到时 ok 为 false，source 是 preset，models 是预设的可选值，reason 是中文原因。
export interface ProbeDetail { id: string; name?: string; efforts?: string[]; defaultEffort?: string }
export interface ProbeResult { ok: boolean; source: 'api' | 'program' | 'preset'; models: string[]; details?: ProbeDetail[]; reason?: string }
// roles:list 的返回（核心 ar roles --json，Stage07c 145）：families 是可选的家族名（模板 + familyRules）；
// profiles 只有启用的执行者：roles 是可担任的角色，modelFamilies 是用户声明的范围，families 是核心判断出的家族（familiesUnknown 为 true 时看不出）。
export interface RolesProfile {
    name: string; label: string; roles: ('executor' | 'reviewer' | 'lead')[]; rolesSource: 'default' | 'set';
    model: string | null; modelFamilies: string[]; families: string[]; familiesUnknown: boolean; familiesSource: string;
}
// lead 是 D128（190）加的：设为主导的 Agent、它们家族的并集；一个都没设时 profiles 为空、families 是 claude、source 为 default。
export interface RolesView {
    families: string[]; profiles: RolesProfile[]; reviewerOrder: string[]; mustDiffer: boolean; differFamily: boolean; differFromLead: boolean;
    lead: { profiles: string[]; families: string[]; source: 'default' | 'set' }; leadFamily: string;
}
// 自定义 CLI 预览（agents:test-decl）：原始输出每行带映射出的统一事件。
export interface PreviewLine { stream: 'stdout' | 'stderr'; text: string; events: { kind: string; [key: string]: unknown }[] }
export interface PreviewResult {
    ok: boolean; valid?: boolean; exit: number | null; timedOut: boolean; seconds: number; report: string | null;
    output: PreviewLine[]; unmatched: number[]; truncated?: boolean; error?: string; errors?: DeclProblem[];
}
export interface DeclProblem { path: string; message: string }
// 路由页（Stage07 T8）：console 通道 route:config / route:rules / route:fallback / route:reviewer / route:limit 的返回，字段照核心 ar route config --json。
export interface RouteRule { types: string[]; profile: string; escalate?: string | null; effort?: string | null }
// route:suggest 的返回（核心 ar route suggest --json，Stage07c 149）：rules 是建议的规则（每条带一句 why），skipped 是没有列出的执行者 / 类型与原因，write 是核心给的采用命令（界面不用）。
export interface RouteSuggestion {
    rules: { types: string[]; profile: string; why: string }[];
    skipped: { profile?: string; types?: string[]; why: string }[];
    write?: string;
}
export interface RouteProfile {
    name: string;
    label: string;
    enabled: boolean;
    readOnly: boolean;
    limits: { maxTasksPerDay: number | null; maxTokensPerDay: number | null };
    usage: { tasks: number; tokens: number };
    // 现在被限流（额度用完）才有：until 是恢复时间（毫秒时间戳）；evidence 是限流原文片段（核心 ar route config 给，D104；没有就没有这个字段）。
    limited?: { kind: 'limit' | 'unavailable'; until: number; since: number; evidence?: string | null };
}
export interface RouteConfig {
    rules: RouteRule[];
    fallback: string | null;
    strongExecutor?: string | null;
    reviewer: { profiles: string[]; mustDiffer: boolean; differFamily?: boolean; differFromLead?: boolean };
    defaultProfile: string | null;
    profiles: RouteProfile[];
    projectRules: { project: string; path: string; count: number }[];
}
// route:trial 的返回：成功是路由器的结果，没有可用的执行者时 failed 为 true（带原因和 trace）。
export interface RouteResult {
    profile: string;
    label: string;
    escalate: string | null;
    rule: { scope: 'project' | 'global'; index: number } | null;
    needsReadOnly: boolean;
    trace: string[];
}
export type RouteTrial = (RouteResult & { failed?: undefined }) | { failed: true; code: string | null; error: string; trace: string[] };
// spec:check-paths 的返回（ar spec check-paths --json）：允许路径会匹配到的现有文件。
export interface PathCheck {
    total: number;
    files: string[];
    truncated: boolean;
    patterns: { pattern: string; count: number }[];
    all: boolean;
    fileCount: number;
}
export interface ProjectRow {
    path: string;
    name: string;
    addedAt: number;
    lastUsed: number;
    exists: boolean;
    git: boolean;
    initialized: boolean;
}
// 彻底清理已删除的项目：projects:purge-plan（ar projects purge --dry-run，另带 worktree 总大小 bytes）与 projects:purge 的结果。
export interface ProjectPurgePlan { ok: true; listed: boolean; tasks: string[]; worktrees: { dir: string; reason: string }[]; slots: string[]; bytes: number }
export interface ProjectPurgeResult { ok: true; removed: boolean; worktrees: number; slots: number; bytes: number; errors?: { kind: string; path: string; error: string }[] }
// 核心报告的 git 版本（projects list / show 的顶层 git 字段）：ok 为 false 表示低于 2.40，null 表示未知。
export interface GitVersionInfo { version: string | null; ok: boolean | null }
export interface ProjectsList { ok: true; projects: ProjectRow[]; git?: GitVersionInfo }export interface ProjectShow {
    path: string;
    name: string;
    exists: boolean;
    git: boolean;
    branch: string | null;
    dirty: number | null;
    initialized: boolean;
    // 生效的 git 提交身份（仓库、全局、系统合起来）；非 git 仓库或读不到为 null。
    identity: { name: string | null; email: string | null } | null;
    // 本机是否已有全局 user.name 和 user.email（git config --global）；决定提交身份弹窗默认写全局还是只写这个项目。
    globalIdentity?: boolean;
    config: Record<string, unknown> | null;
    configError: string | null;
    lastTask: { name: string; started: number } | null;
    // 远程状态（核心只读本地已有的远程跟踪分支，不联网）；非 git 仓库为 null。
    remote?: ProjectRemote | null;
}
// 主分支与远程的关系（Stage07b 128）：projects show 的 remote 与 ar push --dry-run 的结果同形（后者多 branch、lastPush）。
export type RemoteState = 'same' | 'ahead' | 'behind' | 'diverged' | 'noUpstream';
export interface ProjectRemote {
    name: string;
    // ar push --dry-run 的结果里远程名叫 remote（projects show 里叫 name）。
    remote?: string;
    exists: boolean;
    // 已去掉用户名与密码的地址。
    url?: string;
    ahead?: number | null;
    behind?: number | null;
    state?: RemoteState | null;
    branch?: string;
    // 最近一次成功推送的时间（毫秒时间戳）；只有 ar push --dry-run 才带。
    lastPush?: number | null;
    // 地址里带了用户名 / 令牌，核心拒绝推送与拉取。
    credentialInUrl?: boolean;
}
// ar init 的改动项：只有 --dry-run 才带 content（完整内容）与 preview（要追加的部分）。
export interface ProjectChange {
    path: string;
    action: 'create' | 'update';
    content?: string;
    preview?: string;
}
// ar init --upgrade --dry-run 额外的两类计划项：角色文档与最新模板的差异（按行，只含有变化的段落和上下文）、项目配置缺少的顶层键。
export interface RoleDiffLine { op: '+' | '-' | ' '; text: string }
export interface UpgradeRoleDiff { path: string; action: 'roleDiff'; added: number; removed: number; diff: RoleDiffLine[]; truncated: boolean }
export interface UpgradeConfigField { path: string; action: 'configField'; key: string; value: unknown }
export type UpgradeItem = (ProjectChange & { action: 'create' | 'update' }) | UpgradeRoleDiff | UpgradeConfigField;
// ar projects changes 的一项：主工作区里未提交的文件（重命名带旧路径 from）。
export interface ProjectFileChange {
    path: string;
    kind: 'add' | 'update' | 'delete' | 'rename';
    from?: string;
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
// console 通道 tasks:report / tasks:blame 的返回，字段照核心 ar report --json（协议 16.1）；分数全由核心算，界面只显示。
export interface ReportItem {
    key: string;
    count: number;
    points: number;
    detail: string | null;
}
export interface ReportUsage {
    input: number | null;
    output: number | null;
}
// 门禁失败的归因：执行者（默认）、任务说明、环境（偶发失败，两边都不扣分）。
export type ReportBlame = 'worker' | 'spec' | 'environment';
export interface ReportAttempt {
    n: number;
    reason: string | null;
    profile: string | null;
    exit: number | null;
    gate: boolean | null;
    summary: string | null;
    blame: ReportBlame | null;
}
export interface Report {
    ok: true;
    id: string;
    name: string;
    state: string;
    executor: {
        score: number;
        cap: 'failed' | 'rejected' | null;
        items: ReportItem[];
        perf: { ms: number; usage: ReportUsage | null; cost: { amount: number; currency: string } | null; toolCalls: number; profiles: string[] };
    };
    lead: {
        score: number;
        items: ReportItem[];
        perf: { ms: number | null; awaitMs: number | null; usage: ReportUsage | null; usageState: 'off' | 'ok' | 'unavailable' };
    };
    // 有审查的任务才有这一组（Stage08 T6b）：问题数与严重度、成立 / 已确认、用时、token 只列出，不进分数。
    reviewer?: {
        score: number;
        items: ReportItem[];
        perf: { issues: { total: number; high: number; medium: number; low: number }; confirmed: number; valid: number; ms: number; usage: ReportUsage | null };
        profile: string;
        crossed: boolean;
    };
    attempts: ReportAttempt[];
    warnings?: string[];
}
// 任务页排序（记在软件偏好里，下次打开沿用）与项目页排序。
export type TaskSort = 'time' | 'state' | 'project';
export type ProjectSort = 'recent' | 'name' | 'added';
// ar gc --dry-run 经 gc:check 交给界面的结果（每项多一个 size，字节）。
export interface GcItems {
    worktrees: { dir: string; reason: string; size: number }[];
    slots: { file: string; id: string; pid: number; size: number }[];
    sessions: { worker: string; dir: string; ageDays: number; size: number }[];
    bytes: number;
}
// ar gc 真正删除后的结果：bytes 是成功清理的大小，errors 是删除失败的项。
export interface GcRun {
    worktrees: unknown[];
    slots: unknown[];
    sessions: unknown[];
    bytes: number;
    errors: { kind: string; path: string; error: string }[];
}
export interface Settings {
    managed: boolean;
    // 是否统计主导的 token 与用时（config.json 的 leadUsage，只认 true）。
    leadUsage: boolean;
    // 网络代理（config.json 的 proxy，没写按 off）：模式与已保存的手动地址；mode 为 system 时 system 是这一刻读到的系统代理
    //（url 为 null 表示没有；reason 取 found / disabled / pac / unreadable / unsupported），其余模式为 null。
    proxy: { mode: 'off' | 'system' | 'manual'; url: string; system: { url: string | null; reason: string } | null };
    // 同时运行的任务数上限与会话保留天数（config.json 的 concurrency / sessionRetentionDays，没写按默认 2 / 14；手写的越界值原样给出）。
    // concurrency 也可以是 "auto"（并行调度 140）；concurrencyMax 是自动档的上限（1～8，没写为 8）。
    // parallel 是核心给的估算信息：估算值、核数、可用内存（GB，一位小数的文字）；自动档才有 cpu（CPU 使用率）与 busy（机器正忙、暂停启动新任务），固定档两者为空。
    concurrency: number | 'auto';
    concurrencyMax: number;
    // 自动档"内存不够时暂停"的比例（config.json 的 memLowPercent，1～50 的整数，没写或不合法为 5；182）。
    memLowPercent: number;
    // busyReason / busyFreeGb：机器正忙的原因（memory = 可用内存不够，此时 busyFreeGb 是忙时的可用内存 GB，一位小数；cpu）；不忙时为 null。
    // memLowGb：按当前比例算出的"内存不够"阈值（GB，一位小数；核心的 memLowThreshold）。
    parallel: { estimate: number; cores: number; freeGb: string; cpu: number | null; busy: boolean; busyReason: 'cpu' | 'memory' | null; busyFreeGb: string | null; memLowGb: string };
    retentionDays: number;
    values: Record<string, string | null>;
    // 每个 Codex 适配器的执行者（含改过名的，如 codex-pro）各自的 model / effort / tier / sandbox / path（Codex 编辑预填用）；设置页"Codex"那一节仍用 values。
    codexProfiles: Record<string, Record<'model' | 'effort' | 'tier' | 'sandbox' | 'path', string | null>>;
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
        // generic / OpenAI 兼容接口（codex + provider）的模型写在 model；推理强度 effort；升级目标 escalate 是另一个执行者的名字。
        model?: string | null;
        effort?: string | null;
        escalate?: string | null;
        roles?: string[];
        modelFamilies?: string[];
        provider?: { baseUrl?: string | null; wireApi?: string };
        generic?: unknown;
    }>;
    exists: boolean;
    reason: string | null;
    file: string;
    current: Record<string, string | undefined>;
    overrides: Record<string, { name: string; value: string }>;
    // 公共目录（重置时显示完整路径）与上次重置没删完的残留标记。
    home: string;
    leftover: { home: string; at?: number } | null;
    own: { notifications: boolean; theme: 'system' | 'light' | 'dark'; wizardDone: boolean; closeAction: 'ask' | 'tray' | 'quit'; trayHintShown: boolean; taskSort?: TaskSort };
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
