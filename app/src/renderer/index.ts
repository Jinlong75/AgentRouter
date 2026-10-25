import { c, cx, gt, p, ro, rt, s6, sc, wt as wtc } from '../shared/copy';
import { dayGroup } from '../shared/types';
import type { Task, Snapshot, Event as TaskEvent, GateResult, AttemptFiles, AgentRow, TaskSort } from '../shared/types';
import { esc, markdown } from '../shared/markdown';
import { icon, menu, confirmStop, tooltips, notice, openSheet, toast, trace } from './ui';
import { SearchField, closeSortMenu, foundRow, hit, matches, openSortMenu, paintHeader, sortButton } from './search';
import { executorAdapter, executorLabel, executorTag, isCodexTask } from '../shared/executor';
import { installScrollMaterial } from './floatingThumb';
import { Timeline } from './timeline';
import { PreferencesView } from './preferences';
import { ProjectsView } from './projects';
import { NewTaskView } from './newtask';
import { RoutingView } from './routing';
import { gateBadge, gateEnabled, gateFile, gateState, gateTab, gateTrack, trackNode } from './gate';
import { AcceptView } from './accept';
import { ScoreView, scoreVisible } from './score';
import { bannerHtml, loadRepoState, needsAccept, readdProject, repoBanner, routeHeadRow, writeBlocked, wtBanner as wtBannerBase, wtHeadRow, wtMark, wtState, wtStateLine as wtStateLineBase, wtSub as wtSubBase, wtTailRow, wtTrack as wtTrackBase } from './wt';
import { attemptBadge, attemptBar, attemptList, attemptPick, attemptPickItems, historyTab, lastFailure, multiAttempts, openRetrySheet, separators, attemptLabel, type Labels } from './attempts';
import brandSVG from '../../design/icons/mark.svg';
const root = document.querySelector<HTMLElement>('#app')!;
const brand = brandSVG.replace('<svg ', '<svg aria-hidden="true" ');
const marks = { run: ['run', 'loader-4-line'], done: ['ok', 'checkbox-circle-line'], fail: ['fail', 'close-circle-line'], stop: ['stale', 'stop-circle-line'] };
const mark = (s: Task['status']) => `<span class="mk ${marks[s][0]}">${icon(marks[s][1])}</span>`;
// worktree 任务的状态标记（排队、准备、待验收、冲突、已合并、已驳回各一个图标）；其余状态与非 worktree 任务沿用四态标记。
const taskMark = (t: Task) => confirmedTask(t) ? `<span class="mk ok" title="${esc(wtc.subConfirmed)}">${icon('check-line')}</span>` : wtMark(wtState(t))?.html ?? mark(t.status);
// 已确认的任务（调研 / 审查类任务，accepted.mode === 'confirm'，没有合并提交）：列表第二行、状态行、横幅与轨道的合并节点改用“已确认”的文案，其余照“已合并”的写法（wt.ts）。
const confirmedTask = (t: Task) => wtState(t) === 'accepted' && t.wt?.accepted?.mode === 'confirm';
const confirmedBy = (t: Task) => wtc.by[t.wt?.accepted?.by ?? 'cli'] ?? t.wt?.accepted?.by ?? 'cli';
const wtSub = (t: Task) => confirmedTask(t) ? esc(wtc.subConfirmed) : wtSubBase(t);
const wtStateLine = (t: Task, now = Date.now()) => confirmedTask(t) ? { cls: 'ok', text: wtc.lineConfirmed(clock(t.wt?.accepted?.at ?? 0), confirmedBy(t)) } : wtStateLineBase(t, now);
const wtBanner = (t: Task, limit: number) => confirmedTask(t)
    ? { html: bannerHtml('ok', wtc.confirmedTitle, wtc.confirmedHelp(clock(t.wt?.accepted?.at ?? 0), confirmedBy(t)), '', t.wt?.cleanupFailed ? `<span>${esc(wtc.acceptedCleanup)}</span>` : ''), replacesFailure: false }
    : wtBannerBase(t, limit);
// 轨道最后一个节点（合并）换成“确认”：其余四个节点沿用 wt.ts 的。
const wtTrack = (t: Task, file: ReturnType<typeof gateFile>) => {
    const html = wtTrackBase(t, file), at = html.lastIndexOf('<button class="node');
    return confirmedTask(t) && at >= 0 ? `${html.slice(0, at)}${trackNode(wtc.track.merge, 'done', icon('check-line'), wtc.subConfirmed, wtc.nodeConfirmed(confirmedBy(t)), 'flow')}</div>` : html;
};
// 执行者没写显示名时，侧栏按适配器（程序）名显示。
const adapterNames: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code' };
const project = (t: Task) => t.repo.split(/[\\/]/).filter(Boolean).at(-1)!;
const host = (t: Task) => t.dispatcher?.host === 'claude-code' ? 'Claude Code' : t.dispatcher?.host === 'agentrouter' ? c.appHost : c.unknownHost;
const clock = (n: number) => new Date(n).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const elapsed = (t: Task) => { const seconds = Math.max(0, Math.floor((Date.now() - t.started) / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
// 再派一次区分（只在渲染层按快照计算，不改核心与协议）：记录名 <基础名>-<N>（N≥2）
// 且同仓库存在记录名正好是 <基础名> 的任务，就是这份任务的第 N 次派发；原任务不显示标签。
function attemptOf(t: Task): number | null {
    const match = t.name.match(/^(.+)-(\d+)$/);
    if (!match || Number(match[2]) < 2)
        return null;
    return state.tasks.some(x => x.repo === t.repo && x.name === match[1]) ? Number(match[2]) : null;
}
const attemptTag = (t: Task) => { const n = attemptOf(t); return n ? `<span class="tag" title="${esc(c.attemptTip(t.name))}">${esc(c.attempt(n))}</span>` : ''; };
const taskTitle = (t: Task, query = '') => `<span class="ttl">${hit(t.title, query)}</span>${attemptTag(t)}`;
// 验收页要选中的任务（侧栏进入时为空，取列表第一项；任务页的“去验收”与通知点开时给出）。
let acceptSelected = '';
let state: Snapshot = { tasks: [], theme: 'dark', version: '0.1.0' }, page = 'tasks', filter = 'all', repo = '', selected = '', tab = 'flow', think = false, timeline: Timeline | undefined, report = '', generation = 0, loading = false, queued = false, detailSignature = '';
// 当前任务的门禁结果（detail 通道读 gate.json）：null 是文件不存在，{ error } 是读不出来，原样展示。
let gateResult: GateResult = null;
// 多次尝试（Stage05）：进展标签的尝试切换（'all' 或第几次）、汇报 / 门禁标签的尝试下拉（null = 最新）、
// 当前任务各次尝试用到的执行者显示名（配置名 → 显示名）、下拉选中那一次的汇报与门禁、重试历史用的各次门禁。
let flowAtt: 'all' | number = 'all', pickAtt: number | null = null, attTask = '', attLabels: Labels = new Map(), attLabelsLoaded = false;
let attFiles: (AttemptFiles & { key: string }) | null = null;
let histGates = new Map<number, GateResult>();
// 已结束的尝试汇报与门禁不会再变，读一次就记住（按 任务 id + 序号）。
const attCache = new Map<string, AttemptFiles>();
// 再派一次：正在派发的任务、失败原因（只显示在触发它的那个任务详情上）。
let redispatchFor = '', redispatchBusy = false, redispatchError = '', redispatchErrorFor = '';
// 017：批量选择与删除。checked 只存 id；筛选后不可见的勾选保留，计数照实。
let selecting = false;
const checked = new Set<string>();
// 搜索与排序：搜索框在标题栏，元素只建一次；排序记在软件偏好里（settings.own.taskSort，默认按时间）。
const taskSearch = new SearchField(s6.taskSearch, () => { if (page === 'tasks' && !preferences.wizard) list(); });
const taskSort = (): TaskSort => preferences.settings?.own.taskSort ?? 'time';
const taskMatches = (t: Task, query: string) => matches(query, t.name, t.title, project(t));
const preferences = new PreferencesView(() => { nav(); pageView(); }, () => { nav(); if(page==='tasks'&&!preferences.wizard) header(); }, path => openProjectFromWizard(path), () => state.tasks.filter(t => t.status === 'run').length);
// 首次引导完成后切到项目页并选中刚添加的项目：项目页异步刷新，等它的行出现后再点（与用户点击同一条路径）。
// 首次引导完成后切到项目页并选中刚添加的项目：把目标路径直接交给项目页（显式状态），由它在列表加载后选中。
// 原来在 5 秒内轮询 DOM 找行再点，项目页加载慢时会放弃，停在第一个项目（PR #5 CI 实测列表与详情合计约 6.4 秒）。
let pendingProject = '';
function openProjectFromWizard(path: string) {
    page = 'projects';
    pendingProject = path;
    nav();
    pageView();
}
// 项目页：点"最近任务"时切回任务页并选中它。
function showTask(id: string) {
    selected = id;
    filter = 'all';
    repo = '';
    taskSearch.set('');
    page = 'tasks';
    tab = current()?.status === 'done' ? 'report' : 'flow';
    nav();
    pageView();
}
// 项目页每次进入都新建视图：不复用上一次的列表和详情（否则后台刷新完成前会显示过期的项目），
// 也让首次引导添加项目后再次进入项目页时，用户与验收看到的是最新的 projects.json。
const projectsHost = { tasks: () => state.tasks, openTask: showTask };
let projectsView = new ProjectsView(projectsHost);
const newTaskView = new NewTaskView({ tasks: () => state.tasks, openTask: showTask });
// 路由页：每次进入都重新读取路由配置（Stage07 O4）。
const routingView = new RoutingView();
// 验收页：点轨道上的派发 / 执行 / 待验收 / 合并节点回到任务页对应的标签。
const acceptView = new AcceptView({ tasks: () => state.tasks, openTask: (id, tabName) => { showTask(id); switchTab(tabName); } });
const current = () => state.tasks.find(t => t.id === selected);
// 评分标签：报告读完后，标签还开着就重画。
const scoreView = new ScoreView({ changed: id => { if (page === 'tasks' && tab === 'score' && selected === id && !preferences.wizard) renderTab(); }, leadName: host });
// 多次尝试：汇报、门禁标签当前看的是哪一次（下拉没选过就是最新一次）；它的汇报与门禁来自 attempts/<n>/，
// 还没读到（key 对不上）返回 null；任务没有 attempts/ 目录（旧任务）时照旧读顶层文件。
const attKey = (t: Task, n: number) => `${t.id}#${n}`;
function pickedAttempt(t: Task) { const list = attemptList(t); return list.length < 2 ? null : list.find(a => a.n === pickAtt) ?? list.at(-1)!; }
function attView(t: Task, att: { n: number }): { report: string; gate: GateResult } | null {
    if (!attFiles || attFiles.key !== attKey(t, att.n))
        return null;
    return attFiles.exists ? { report: attFiles.report, gate: attFiles.gate } : { report, gate: gateResult };
}
const headerKey = (t: Task) => JSON.stringify([t.id, t.title, t.status, t.role, t.started, t.ended, t.minutes, t.exit, t.signal, t.commit, t.dispatcher?.host,t.managed,preferences.settings?.managed, attemptOf(t), t.gate, t.base, t.gatingAt, t.gateOk, t.gateSummary, t.agentExit, t.attempts, t.needsScope, t.outsideWrites, t.wt, state.concurrency]);
const action = (name: string, value?: string) => { trace('action-send', { task: selected, name }); return window.dock.action(selected, name, value).then(() => trace('action-done', { name }), error => { trace('action-error', { name, error: String((error as Error)?.message ?? error) }); notice(error); }); };
function shell() { root.innerHTML = `<div class="tb-l">${brand}<span class="wordmark">${c.app}</span></div><div class="tb-r"></div><nav class="nav"></nav><section class="content"></section>`; nav(); pageView(); }
// 侧栏只在内容变化时重建：异步刷新晚到时不替换按钮，避免吞掉正在进行的点击；重建后焦点放回同一个导航按钮。
let navHtml = '';
function nav() {
    const runningTasks = state.tasks.filter(t => t.status === 'run'), running = runningTasks.length, box = root.querySelector('.nav')!;
    // 侧栏底部：每个启用的执行者一行“显示名  运行数/上限”。运行数是正在运行（运行、门禁、准备）的任务，排队中的不算；
    // 上限暂用全局的同时运行上限（config.json 的 concurrency）。没有启用的执行者时只剩下面的托管一行。
    const limit = state.concurrency ?? 2, active = runningTasks.filter(t => wtState(t) !== 'queued');
    const load = Object.entries(preferences.settings?.profiles ?? {}).filter(([, profile]) => profile.enabled !== false).map(([name, profile]) => {
        const label = profile.label || adapterNames[profile.adapter ?? ''] || profile.adapter || name;
        const n = active.filter(t => { const who = t.attempt?.profile ?? t.profile; return who ? who === name : executorLabel(t) === label; }).length;
        return `<div class="load-l" title="${esc(s6.loadTip(label, n, limit))}"><span class="mono">${esc(label)}</span><span class="mono">${esc(s6.loadRow(n, limit))}</span></div>`;
    }).join('');
    // 侧栏“验收”：徽标是待验收与冲突的数量（品牌色底），悬停说明有几个任务等你处理。
    const waiting = state.tasks.filter(needsAccept).length;
    const item = (key: string, i: string, label: string) => `<button ${preferences.wizard ? 'disabled' : ''} data-page="${key}" ${page === key ? 'aria-current="page"' : ''}${key === 'accept' && waiting ? ` data-tip="${esc(wtc.navTip(waiting))}"` : ''}>${icon(i)}${label}${key === 'tasks' && running ? `<span class="count">${running}</span>` : key === 'accept' && waiting ? `<span class="count brand">${waiting}</span>` : ''}</button>`;
    const html = item('tasks', 'stack-line', c.tasks) + item('newtask', 'add-circle-line', c.newTask) + item('accept', 'git-pull-request-line', wtc.nav) + `<div class="nav-group">${esc(c.configGroup)}</div>` + item('projects', 'folder-3-line', c.projectsNav) + item('connect', 'plug-line', c.connect) + item('routing', 'route-line', ro.nav) + '<span class="sp"></span>' + item('settings', 'settings-3-line', c.settings) + item('about', 'information-line', c.about) + `<div class="nav-foot">${load}<button class="mg" data-managed-settings ${preferences.wizard?'disabled':''}><span class="dot ${preferences.settings?.managed ? 'ok' : ''}"></span>${preferences.settings?.managed?c.managedOn:c.managedOff}</button></div>`;
    if (box.innerHTML && html === navHtml) return;
    navHtml = html;
    const focused = document.activeElement instanceof HTMLElement && box.contains(document.activeElement) ? document.activeElement.getAttribute('data-page') ?? (document.activeElement.hasAttribute('data-managed-settings') ? 'managed' : null) : null;
    box.innerHTML = html;
    if (focused) (box.querySelector(focused === 'managed' ? '[data-managed-settings]' : `[data-page="${focused}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
}
function pageView() {
    const content = root.querySelector<HTMLElement>('.content')!;
    // 017：离开任务页时退出选择模式。
    if (page !== 'tasks' && selecting) { selecting = false; checked.clear(); }
    generation++;
    timeline = undefined;
    loading = false;
    content.onclick = null;
    preferences.unmount();
    projectsView.unmount();
    newTaskView.unmount();
    routingView.unmount();
    acceptView.unmount();
    if (preferences.wizard || (page !== 'tasks' && page !== 'projects' && page !== 'newtask' && page !== 'accept' && page !== 'routing')) {
        preferences.mount(content as HTMLElement, page, state.version);
        return;
    }
    if (page === 'accept') {
        acceptView.mount(content as HTMLElement, acceptSelected);
        acceptSelected = '';
        return;
    }
    if (page === 'projects') {
        projectsView = new ProjectsView(projectsHost, pendingProject);
        pendingProject = '';
        projectsView.mount(content as HTMLElement);
        return;
    }
    if (page === 'newtask') {
        newTaskView.mount(content as HTMLElement);
        return;
    }
    if (page === 'routing') {
        routingView.mount(content as HTMLElement);
        return;
    }
    content.innerHTML = '<div class="page-h tasks-h"></div><div class="banner-holder" data-process-banner></div><div class="split"><div class="edge"><div class="tlist scroll"></div></div><div class="detail"></div></div>';
    processBanner();
    list();
    detail();
}
// 任务页分段筛选：全部 / 进行中 / 待验收（含合并冲突）/ 失败或中断。
const inFilter = (t: Task, key: string) => key === 'all' || key === 'run' && t.status === 'run' || key === 'await' && needsAccept(t) || key === 'issues' && ['fail', 'stop'].includes(t.status);
// 项目下拉、分段筛选和搜索关键字同时生效后的任务。
const visibleTasks = () => state.tasks.filter(t => (!repo || repo === t.repo) && inFilter(t, filter) && taskMatches(t, taskSearch.query));
interface TaskGroup { title: string; meta: string; rows: Task[] }
// 列表分组与排序。按时间：进行中 → 待验收（待验收与冲突）→ 按天；按状态：待验收与冲突 → 进行中 → 失败或中断 → 其余按天；
// 按项目：同一项目放在一起，项目按名称排。组内都按开始时间倒序。
function taskGroups(tasks: Task[], sort: TaskSort, dayName: (started: number) => string): TaskGroup[] {
    const byStart = (a: Task, b: Task) => b.started - a.started;
    const date = (rows: Task[]) => new Date(rows[0].started).toLocaleDateString('en-CA', { month: '2-digit', day: '2-digit' });
    const groups: TaskGroup[] = [];
    if (sort === 'project') {
        for (const name of [...new Set(tasks.map(project))].sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
            const rows = tasks.filter(t => project(t) === name).sort(byStart);
            groups.push({ title: name, meta: String(rows.length), rows });
        }
        return groups;
    }
    const kind = (t: Task) => t.status === 'run' ? 'run' : needsAccept(t) ? 'await' : sort === 'state' && (t.status === 'fail' || t.status === 'stop') ? 'issues' : 'day';
    const titles: Record<string, string> = { run: c.status.run, await: wtc.group, issues: c.issues };
    for (const k of sort === 'state' ? ['await', 'run', 'issues', 'day'] : ['run', 'await', 'day']) {
        const rows = tasks.filter(t => kind(t) === k).sort(byStart);
        if (k !== 'day') {
            if (rows.length) groups.push({ title: titles[k], meta: String(rows.length), rows });
            continue;
        }
        const days = new Map<string, Task[]>();
        for (const t of rows) days.set(dayName(t.started), [...(days.get(dayName(t.started)) ?? []), t]);
        for (const [title, list] of days) groups.push({ title, meta: date(list), rows: list });
    }
    return groups;
}
// 017：列表重建前后按 data-* 找回同一个控件。
function focusedKey(): string {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !root.contains(el))
        return '';
    for (const name of ['task', 'multi', 'filter']) { const value = el.dataset[name]; if (value) return `${name}:${value}`; }
    if (el.hasAttribute('data-project')) return 'project:';
    if (el.hasAttribute('data-sort')) return 'sort:';
    if (el.hasAttribute('data-import')) return 'import:';
    return '';
}
function restoreFocus(key: string) {
    if (!key) return;
    const at = key.indexOf(':'), kind = key.slice(0, at), value = key.slice(at + 1);
    const el = kind === 'project' ? root.querySelector<HTMLElement>('[data-project]')
        : kind === 'sort' ? root.querySelector<HTMLElement>('[data-sort]')
        : kind === 'import' ? root.querySelector<HTMLElement>('[data-import]')
        : root.querySelector<HTMLElement>(`[data-${kind}="${CSS.escape(value)}"]`);
    el?.focus({ preventScroll: true });
}
// 017：退出选择模式，回到普通列表；焦点放回"选择"按钮。
function exitSelect(focus = true) {
    selecting = false;
    checked.clear();
    list();
    if (focus) root.querySelector<HTMLElement>('[data-multi=select]')?.focus({ preventScroll: true });
}
// 017：删除确认框。渲染层只把 id 与"是否删记录文件"交给主进程，路径全由主进程导出。
function openDelete(trigger: HTMLElement) {
    const ids = [...checked].filter(id => state.tasks.some(t => t.id === id));
    if (!ids.length) return;
    const choice = `<button class="choice" role="checkbox" aria-checked="false" data-delete-files><span class="cb"></span><span class="ct">${esc(c.deleteFiles)}<span>${esc(c.deleteFilesHelp)}</span></span></button>`;
    const sheet = openSheet({ title: c.deleteTitle(ids.length), trigger, body: `<p class="sheet-lead">${esc(c.deleteBody)}</p>${choice}`, buttons: [c.cancel, c.deleteConfirm],
        onButton: (index, s) => {
            if (index === 0) { s.close(); return; }
            const files = sheet.root.querySelector<HTMLElement>('[data-delete-files]')?.getAttribute('aria-checked') === 'true';
            s.busy(true);
            s.fail('');
            void window.dock.deleteTasks(ids, files).then(result => {
                s.busy(false);
                s.close();
                if (!result.deleted) { notice(new Error(c.changed)); return; }
                selecting = false;
                checked.clear();
                list();
                root.querySelector<HTMLElement>('[data-multi=select]')?.focus({ preventScroll: true });
                toast(result.filesLeft ? `${c.deleted(result.deleted)}；${c.deleteLeft(result.filesLeft)}` : c.deleted(result.deleted));
            }).catch(error => { s.busy(false); s.fail(String((error as Error)?.message || error)); });
        } });
    // 底栏最后一个按钮默认是主按钮：删除换成危险样式；默认焦点在取消。
    const buttons = sheet.root.querySelectorAll<HTMLButtonElement>('.sheet-btns button');
    buttons[1]?.classList.remove('primary');
    buttons[1]?.classList.add('danger');
    buttons[0]?.focus({ preventScroll: true });
    const files = sheet.root.querySelector<HTMLButtonElement>('[data-delete-files]');
    files?.addEventListener('click', () => {
        const on = files.getAttribute('aria-checked') !== 'true';
        files.setAttribute('aria-checked', String(on));
        const cb = files.querySelector('.cb')!;
        cb.classList.toggle('on', on);
        cb.innerHTML = on ? icon('check-line') : '';
    });
}
function list() {
    if (page !== 'tasks' || preferences.wizard)
        return;
    // 017：重建会丢焦点，先记下焦点控件，重建后放回同一个（键盘连续操作与后台刷新都不打断）。
    const focus = focusedKey();
    // 已经不在快照里的勾选去掉（例如在别处被隐藏）。
    for (const id of [...checked])
        if (!state.tasks.some(t => t.id === id))
            checked.delete(id);
    // 筛选上的数量只看项目下拉，不受搜索影响；列表是项目、分段筛选和搜索同时生效的结果。
    const count = (key: string) => state.tasks.filter(t => (!repo || t.repo === repo) && inFilter(t, key)).length;
    const query = taskSearch.query, sort = taskSort(), tasks = visibleTasks();
    // "全选已结束的"只作用于当前筛选下可见的已结束任务；全选后按钮变成"取消全选"。
    const ended = tasks.filter(t => t.status !== 'run'), allChecked = ended.length > 0 && ended.every(t => checked.has(t.id));
    // “待验收”含合并冲突；有数量时文字用品牌色（需要人处理）。
    // 悬停提示写“名称 数量 个”：最窄窗口不显示数量时，数量在提示里；“失败”按钮的名称写全称（失败或中断）。
    const filters = `<div class="segm">${[['all', c.all, c.all], ['run', c.status.run, c.status.run], ['await', wtc.filter, wtc.filter], ['issues', c.status.fail, s6.failTip]].map(([key, label, tip]) => `<button data-filter="${key}" class="${filter === key ? 'on' : ''}${key === 'await' && count(key) ? ' attn' : ''}" title="${esc(s6.filterTip(tip, count(key)))}">${label} <span class="n">${count(key)}</span></button>`).join('')}</div>`;
    const projectSel = `<button class="sel proj" data-project aria-haspopup="listbox" aria-expanded="false"><span class="ph">${esc(repo ? repo.split(/[\\/]/).at(-1) : c.projects)}</span>${icon('arrow-down-s-line')}</button>`;
    // 标题栏：左（标题与筛选）、搜索框 + 项目下拉 + 排序（同一个 .ph-tools）、右（选择、导入、新建任务）；搜索框元素不重建（见 paintHeader）。
    // 窗口宽 ≥ 1280 排成一行，更窄时搜索、项目、排序占第二行；选择模式下第二行照常。
    const header = root.querySelector<HTMLElement>('.page-h')!;
    header.classList.toggle('selecting', selecting);
    paintHeader(header, taskSearch, `<h1>${selecting ? c.multiCount(checked.size) : c.tasks}</h1>${filters}`, selecting
        ? `<span class="sp"></span><button class="btn" data-multi="all">${allChecked ? c.multiNone : c.multiAll}</button><button class="btn danger" data-multi="delete" ${checked.size && processOk() ? '' : 'disabled'}>${esc(c.multiDelete)}</button><button class="btn" data-multi="done">${esc(c.multiDone)}</button>`
        : `<span class="sp"></span><button class="btn" data-multi="select">${esc(c.multiSelect)}</button><button class="btn icon quiet" data-import data-tip="${c.import}" aria-label="${c.import}">${icon('folder-add-line')}</button><button class="btn primary" data-page="newtask">${icon('add-line')}${esc(c.newTask)}</button>`,
        projectSel + sortButton('data-sort', s6.taskSorts[sort][0]));
    if (selected && !tasks.some(t => t.id === selected)) {
        selected = '';
        detailSignature = '';
        detail();
    }
    // "今天 / 昨天"按纯函数分组（037 第 2 项）：验收 / 演示模式下 preload 送来固定的"现在"（AR_DEMO_NOW），
    // 跨午夜截图时与演示数据同一口径；正常运行没有这个值，用当前时间，行为不变。
    const now = window.dock.demoNow ?? Date.now();
    const dayName = (started: number) => { const g = dayGroup(started, now); return g === 'today' ? c.today : g === 'yesterday' ? c.yesterday : new Date(started).toLocaleDateString('zh-CN'); };
    const groups = taskGroups(tasks, sort, dayName);
    const box = root.querySelector<HTMLElement>('.tlist')!, scroll = box.scrollTop;
    // 有搜索关键字时列表顶部先写结果数量（或“没有任务包含…”）和“清除”。
    const found = query ? foundRow(tasks.length ? s6.taskFound(tasks.length, query) : s6.taskNone(query), 'data-found-clear') : '';
    box.innerHTML = found + (tasks.length ? groups.map(({ title, meta, rows }) => `<div class="tgroup">${esc(title)}<span class="mono">${esc(meta)}</span></div>${rows.map(t => { const gateFail = t.status === 'fail' && gateState(t) === 'fail'; const tail = t.imported ? c.imported : t.processState === 'unknown' ? c.processUnknownTag : t.status === 'run' ? t.last : gateFail ? '' : t.status === 'fail' ? `exit=${t.exit}` : t.status === 'stop' ? (t.signal === 'stopped-by-app' ? c.stoppedShort : t.signal === 'stopped-by-command' ? c.stoppedByCommandShort : c.closed) : t.commit ?? (t.sandbox === 'read-only' ? c.readonly : ''); const on = checked.has(t.id); const lead = selecting ? `<span class="cb ${on ? 'on' : ''}" aria-hidden="true">${on ? icon('check-line') : ''}</span>` : taskMark(t); const multi = selecting ? ` role="checkbox" aria-checked="${on}"${t.status === 'run' ? ` disabled aria-disabled="true" data-tip="${esc(c.multiRunning)}"` : ''}` : ''; return `<button class="trow ${selecting ? 'multi ' : ''}is-${t.status === 'run' ? 'running' : t.status} ${selected === t.id ? 'on' : ''}" data-task="${esc(t.id)}"${multi}>${lead}<span class="tm"><b>${taskTitle(t, query)}</b><span class="${t.status === 'run' && wtState(t) !== 'queued' ? 'live' : ''}"><span class="xtag mono" title="${esc(executorLabel(t))}" data-executor="${esc(executorTag(executorLabel(t)))}">${esc(executorTag(executorLabel(t)))}</span>${attemptBadge(t)}${gateBadge(t)}${hit(project(t), query)}${wtSub(t) !== null ? ' · ' + wtSub(t) : tail ? ' · ' + esc(tail) : ''}</span></span><span class="ts"><span class="mono" ${t.status === 'run' ? `data-elapsed="${esc(t.id)}"` : ''}>${t.status === 'run' ? elapsed(t) : clock(t.started)}</span></span></button>`; }).join('')}`).join('') : query ? '' : `<div class="empty">${icon('stack-line')}<b>${c.empty}</b><p>${c.emptyHelp}</p></div>`);
    box.scrollTop = scroll;
    restoreFocus(focus);
}
function detail() {
    const box = root.querySelector<HTMLElement>('.detail');
    if (!box)
        return;
    generation++;
    timeline = undefined;
    loading = false;
    report = '';
    gateResult = null;
    scoreView.invalidate();
    const t = current();
    if (!t) {
        box.innerHTML = `<div class="empty">${icon('file-list-3-line')}<b>${state.tasks.length ? c.select : c.emptyDetail}</b><p>${c.detailHelp}</p></div>`;
        return;
    }
    // 切到没有门禁的任务时，"门禁"标签不存在，回到进展；"重试"标签只在有 2 次及以上尝试时存在。
    if (tab === 'gate' && !gateEnabled(t))
        tab = 'flow';
    if (tab === 'retry' && !multiAttempts(t))
        tab = 'flow';
    if (tab === 'score' && !scoreVisible(t))
        tab = 'flow';
    // 换了任务：尝试切换、下拉和执行者显示名都重新开始（同一任务反复重建详情时保留）。
    if (attTask !== selected) {
        attTask = selected;
        flowAtt = 'all';
        pickAtt = null;
        attFiles = null;
        histGates = new Map();
        attLabels = new Map();
        attLabelsLoaded = false;
    }
    box.innerHTML = '<div class="dh"></div><div class="track-holder"></div><div class="dtabs"></div><div class="banner-holder"></div><div class="dbody edge"><div class="scroll" tabindex="0"><div class="tab-body"></div></div><button class="plan-compact plan-h" data-plan-top hidden></button><button class="btn sm follow" data-latest hidden></button></div>';
    header();
    const viewport = box.querySelector<HTMLElement>('.dbody > .scroll')!;
    viewport.addEventListener('scroll', () => { if (!timeline || tab !== 'flow')
        return; const near = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 32; if (!near)
        timeline.follow = false;
    else if (timeline.events.length)
        timeline.follow = true; timeline.render(); followButton(); }, { passive: true });
    renderTab();
    void refreshDetail();
}
// 再派一次：核心按记录目录里的 dispatch.json 用同样参数脱离软件派发。成功后照任务 007 的做法
// 最多等 5 秒，等新任务的 start 行进了看板再选中它；失败把原因显示在详情页横幅上。
async function redispatchTask(t: Task) {
    trace('redispatch-click', { task: t.id, busy: redispatchBusy, busyFor: redispatchFor });
    if (redispatchBusy) {
        trace('redispatch-ignored-busy', { task: t.id, busyFor: redispatchFor });
        return;
    }
    redispatchBusy = true;
    redispatchFor = t.id;
    redispatchError = '';
    redispatchErrorFor = '';
    header();
    let id = '';
    try {
        trace('redispatch-send', { task: t.id });
        const result = await window.dock.console('tasks:redispatch', { project: t.repo, name: t.name });
        trace('redispatch-result', { task: t.id, id: result?.id ?? null });
        id = typeof result?.id === 'string' ? result.id : '';
        if (!id)
            throw new Error(cx.noResult);
    }
    catch (error) {
        redispatchError = String((error as Error)?.message || error);
        redispatchErrorFor = t.id;
        redispatchBusy = false;
        redispatchFor = '';
        const willRender = page === 'tasks' && !preferences.wizard && !!current();
        trace('redispatch-error', { task: t.id, error: redispatchError, willRender, page, selected });
        if (willRender)
            header();
        return;
    }
    // 成功派发后保持"正在派发…"直到新任务真的进了看板，按钮不会闪一下就恢复。
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (state.tasks.some(x => x.id === id)) {
            redispatchBusy = false;
            redispatchFor = '';
            showTask(id);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    redispatchBusy = false;
    redispatchFor = '';
    if (page === 'tasks' && !preferences.wizard && current())
        header();
}
function header() {
    const t = current();
    if (!t)
        return;
    detailSignature = headerKey(t);
    const busy = redispatchBusy && redispatchFor === t.id;
    const finished = ['done', 'fail', 'stop'].includes(t.status);
    // worktree 任务：待验收与冲突在标题行多一个“去验收”主按钮，没有“重试”（验收页有“重试…”；冲突要用“解决冲突并重试”）；已合并、已驳回没有“重试”，只有“再派一次”。
    // 待验收与冲突的“再派一次”照旧保留（界面稿里没有；已有的“再派一次”检查用的任务经项目配置 worktree: true 进了待验收，要求它仍然可用）。
    const wst = wtState(t), pending = wst === 'awaiting' || wst === 'conflict', noRetry = pending || wst === 'accepted' || wst === 'rejected';
    const gate = gateState(t), gateFail = t.status === 'fail' && gate === 'fail';
    const goAccept = pending ? `<button class="btn sm primary" data-go-accept="${esc(t.id)}">${icon('git-pull-request-line')}${esc(wtc.goAccept)}</button>` : '';
    // 项目已从列表移除（或文件夹没了）：要写项目的“再派一次”“重试”禁用，悬停提示同一句（驳回、确认、删除不受影响）。
    loadRepoState(t, () => { if (current()?.id === t.id) header(); });
    const blocked = writeBlocked(t);
    const redispatch = finished ? `<button class="btn sm" data-redispatch data-tip="${esc(blocked ? c.projectGoneBlocked : c.redispatchHelp)}" aria-label="${esc(c.redispatch)}" ${busy || blocked ? 'disabled' : ''}>${busy ? `<span class="mk run">${icon('loader-4-line')}</span>${esc(c.redispatching)}` : `${icon('refresh-line')}${esc(c.redispatch)}`}</button>` : '';
    // 重试（Stage05）：结束的任务（完成、失败、中断）在"再派一次"前多一个次按钮，在同一工作区新开一次尝试。
    const retry = finished && !noRetry ? `<button class="btn sm" data-retry title="${esc(blocked ? c.projectGoneBlocked : rt.buttonTip)}" aria-label="${esc(rt.button)}" ${blocked ? 'disabled' : ''}>${icon('arrow-go-forward-line')}${esc(rt.button)}</button>` : '';
    // 失败且门禁没过时，状态行第二段说明是门禁没过（不再是笼统的 exit=3）。
    const stateTail = t.status === 'run' ? ` · <span data-elapsed="${esc(t.id)}">${elapsed(t)}</span>` : t.status === 'done' ? ` · ${c.elapsed} ${t.minutes ?? '—'} ${c.minutes}` : t.status === 'fail' ? gateFail ? ` · ${esc(gt.badge.fail)}` : ` · exit=${t.exit}` : '';
    const stateLine = wtStateLine(t);
    root.querySelector('.dh')!.innerHTML = `<div class="dh-1"><h2>${taskTitle(t)}</h2>${t.managed?`<span class="tag">${c.managed}</span>`:''}${t.legacy?`<span class="tag" data-legacy>${c.legacy}</span>`:''}<span class="acts">${goAccept}${retry}${redispatch}${t.status === 'run' ? `<button class="btn sm danger" data-stop ${processOk() ? '' : `disabled data-tip="${esc(c.processUnknownBlocked)}"`}>${icon('stop-circle-line')}${c.stop}</button>` : ''}<button class="btn icon quiet" data-more data-tip="${c.more}" aria-label="${c.more}" aria-haspopup="menu">${icon('more-2-fill')}</button></span></div><div class="dh-2">${stateLine ? `<span class="dh-state ${stateLine.cls}">${taskMark(t)}${esc(stateLine.text)}</span>` : `<span class="dh-state ${marks[t.status][0]}">${mark(t.status)}${c.status[t.status]}${stateTail}</span>`}<span>${icon('folder-3-line')}${esc(project(t))}</span><span data-dispatcher-line>${icon('user-line')}<em>${c.dispatcher}</em>${esc(host(t))}</span><span data-executor-line>${icon('robot-2-line')}<em>${c.executor}</em>${esc(executorLabel(t))}</span><span>${icon('time-line')}${clock(t.started)} ${c.started}</span>${t.commit ? `<span>${icon('git-commit-line')}<span class="mono">${t.commit}</span></span>` : ''}</div>`;
    // 流水线轨道（B3）：只给带 gate 字段的任务画；放在标题区下面、标签栏上面。
    const track = root.querySelector<HTMLElement>('.track-holder');
    if (track) track.innerHTML = t.worktree ? wtTrack(t, gateFile(gateResult)) : gateTrack(t, gateFile(gateResult));
    // 再派失败、门禁、执行者失败 / 中断的横幅都在 banners() 里；门禁标签里有自己的横幅，不再重复。
    const gateBanner = tab !== 'gate' && (gateFail || (t.status === 'run' && gate === 'running'));
    trace('header', { task: t.id, banner: !!(redispatchError && redispatchErrorFor === t.id || gateBanner), busy, errorFor: redispatchErrorFor });
    // 正在看"评分"时任务又开始运行（再派一次 / 重试）：评分标签没了，回到进展。
    if (tab === 'score' && !scoreVisible(t)) {
        tab = 'flow';
        renderTab();
    }
    banners(t);
    tabs();
}
// 详情顶部的横幅：门禁横幅只在进展等其它标签显示；"门禁"标签里已有自己的横幅（界面稿 gateTab()），
// 两条叠在一起会重复提示，"查看门禁"按钮也没有意义。
function banners(t: Task) {
    const holder = root.querySelector<HTMLElement>('.detail .banner-holder');
    if (!holder)
        return;
    const gate = gateState(t), gateFail = t.status === 'fail' && gate === 'fail';
    // 再派一次失败用页面横幅显示原因。
    const failed = redispatchError && redispatchErrorFor === t.id ? `<div class="banner fail" role="alert">${mark('fail')}<div class="rt"><b>${esc(c.redispatchFailed)}</b><span>${esc(redispatchError)}</span></div></div>` : '';
    // 门禁未过：横幅用核心写的 summary，主按钮是"查看门禁"；门禁进行中：提示横幅。
    const gateBanner = tab === 'gate' ? ''
        : gateFail
            ? `<div class="banner fail" role="alert">${mark('fail')}<div class="rt"><b>${esc(gt.failTitle)}</b><span>${esc(t.gateSummary ?? gateFile(gateResult)?.summary ?? '')}</span></div><button class="btn sm" data-tab="gate">${esc(gt.viewGate)}</button></div>`
            : t.status === 'run' && gate === 'running'
                ? `<div class="banner info" role="status">${mark('run')}<div class="rt"><b>${esc(gt.runningTitle)}</b><span>${esc(gt.runningHelp(gateFile(gateResult)?.commands?.length ?? 0))}</span></div><button class="btn sm" data-tab="gate">${esc(gt.viewGate)}</button></div>`
                : '';
    // 执行者列出了需要越界的路径：横幅结构同失败横幅，放在门禁横幅上面，路径逐行列在说明下面（原因用次要文字色）。
    const scope = t.needsScope?.length
        ? `<div class="banner fail" role="alert" data-needs-scope>${mark('fail')}<div class="rt"><b>${esc(rt.needsScopeTitle)}</b><span>${esc(rt.needsScopeHelp(t.needsScope.length))}</span><ul class="scope-paths">${t.needsScope.map(item => `<li><span class="mono" data-scope-path>${esc(item.path)}</span>${item.reason ? `<span class="scope-reason" data-scope-reason>${esc(item.reason)}</span>` : ''}</li>`).join('')}</ul></div></div>`
        : '';
    // 只找详情里的横幅区：任务页顶部还有一个进程状态横幅区（W4），不能写到那里。
    // 工作区外出现了新文件（协议 12.4）：同一结构，放在最上面（顺序：工作区外写入 → 需要越界 → 门禁）；
    // 每行是目录名称（次要文字色）加等宽的名字。
    const outside = t.outsideWrites?.added.length
        ? `<div class="banner fail" role="alert" data-outside-writes>${mark('fail')}<div class="rt"><b>${esc(rt.outsideTitle)}</b><span>${esc(rt.outsideHelp)}</span><ul class="scope-paths">${t.outsideWrites.added.map(item => `<li><span data-outside-root>${esc(rt.outsideRoot[item.root] ?? item.root)}</span><span class="mono" data-outside-name>${esc(item.name)}</span></li>`).join('')}</ul></div></div>`
        : '';
    // worktree 任务：排队 / 准备 / 待验收 / 冲突 / 已合并 / 已驳回 / 准备失败的横幅放在详情顶部（门禁标签里已有自己的横幅，不显示）；冲突与准备失败的横幅取代通用的失败横幅。
    const wtb = tab !== 'gate' ? wtBanner(t, state.concurrency ?? 2) : null;
    holder.innerHTML = repoBanner(t) + failed + (wtb?.html ?? '') + outside + scope + gateBanner +((['fail', 'stop'].includes(t.status) && !gateFail && !wtb?.replacesFailure) ?`<div class="banner ${t.status === 'fail' ? 'fail' : 'stale'}">${mark(t.status)}<div class="rt"><b>${esc(t.status === 'fail' ? c.failedTitle(executorLabel(t), t.exit) : t.signal === 'stopped-by-app' ? c.stopped : t.signal === 'stopped-by-command' ? c.stoppedByCommand : c.interruptedTitle)}</b><span>${t.status === 'fail' ? c.failedHelp : ['stopped-by-app','stopped-by-command'].includes(t.signal ?? '') ? c.stoppedHelp : c.interruptedHelp}</span></div>${t.status==='stop'&&!['stopped-by-app','stopped-by-command'].includes(t.signal ?? '')&&!preferences.settings?.managed?`<button class="btn sm" data-managed-settings>${c.goSettings}</button>`:''}</div>` : '');
}
function tabs() {
    const files = changedFiles().size, bar = root.querySelector<HTMLElement>('.dtabs')!, t = current();
    // "门禁"插在"汇报"后面、"重试"在"改动"后面；其它标签顺序与选中逻辑不变。
    // 门禁只有启用了门禁的任务才有，"重试"只在有 2 次及以上尝试时出现；标签集合变了才重建（尝试增加时出现"重试"）。
    const items: [string, string][] = [['flow', c.flow], ['report', c.report], ...(t && gateEnabled(t) ? [['gate', gt.tab] as [string, string]] : []), ['files', c.files], ...(t && multiAttempts(t) ? [['retry', rt.tab] as [string, string]] : []), ...(t && scoreVisible(t) ? [['score', sc.tab] as [string, string]] : []), ['params', c.params]];
    const signature = items.map(([key]) => key).join();
    if (!bar.children.length || bar.dataset.tabs !== signature) {
        const focused = document.activeElement instanceof HTMLElement && bar.contains(document.activeElement) ? document.activeElement.dataset.tab : undefined;
        bar.dataset.tabs = signature;
        bar.innerHTML = `<div class="segm sm">${items.map(([key, label]) => `<button data-tab="${key}">${label}</button>`).join('')}</div><span class="sp"></span><span class="hint">${c.think}<button class="toggle" data-think role="switch" aria-label="${c.think}"></button></span>`;
        if (focused)
            bar.querySelector<HTMLElement>(`[data-tab="${focused}"]`)?.focus({ preventScroll: true });
    }
    for (const button of bar.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
        button.classList.toggle('on', button.dataset.tab === tab);
        button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
    }
    const fileButton = bar.querySelector<HTMLElement>('[data-tab=files]')!, label = c.files + (files ? ` <span class="n">${files}</span>` : '');
    if (fileButton.innerHTML !== label)
        fileButton.innerHTML = label;
    // "重试"标签右边的数字是尝试次数。
    const retryButton = bar.querySelector<HTMLElement>('[data-tab=retry]');
    if (retryButton && t) {
        const retryLabel = `${rt.tab} <span class="n">${attemptList(t).length}</span>`;
        if (retryButton.innerHTML !== retryLabel)
            retryButton.innerHTML = retryLabel;
    }
    bar.querySelector<HTMLElement>('.hint')!.hidden = tab !== 'flow';
    const toggle = bar.querySelector<HTMLElement>('[data-think]')!;
    toggle.classList.toggle('on', think);
    toggle.setAttribute('aria-checked', String(think));
}
// 切标签：同步顶部门禁横幅（门禁标签里不显示，其它标签显示），重画标签内容并回到顶部。
function switchTab(name: string) {
    tab = name;
    if (name === 'score')
        scoreView.invalidate();
    if (current())
        banners(current()!);
    renderTab();
    root.querySelector<HTMLElement>('.dbody > .scroll')!.scrollTop = 0;
    void refreshDetail();
}
function changedFiles() { const files = new Map<string, NonNullable<TaskEvent['files']>[number]>(); for (const e of timeline?.events ?? [])
    for (const f of e.files ?? [])
        files.set(f.path, f); return files; }
function renderTab() {
    const t = current(), body = root.querySelector<HTMLElement>('.tab-body');
    if (!t || !body)
        return;
    const viewport = body.parentElement!;
    if (tab === 'flow') {
        const events = timeline?.events ?? [], cursor = timeline?.cursor, follow = timeline?.follow ?? t.status === 'run';
        body.innerHTML = '<div class="wt-slot"></div><div class="att-slot"></div><div class="plan-slot"></div><button class="btn sm quiet" data-earlier hidden></button><div class="events-host"></div><div class="live-foot"></div>';
        timeline = new Timeline(body.querySelector('.events-host')!, viewport);
        timeline.events = events;
        timeline.cursor = cursor;
        timeline.follow = follow;
        timeline.think = think;
        renderFlow();
    }
    else if (tab === 'report') {
        // 有多次尝试时顶部是尝试下拉，汇报读选中那一次的 attempts/<n>/report.md（还没读到时只显示下拉）。
        const att = pickedAttempt(t), pick = att ? attemptPick(t, att.n, attLabels) : '';
        const view = att ? attView(t, att) : { report, gate: gateResult };
        const text = view ? view.report : null;
        const latest = !att || att === attemptList(t).at(-1);
        const commit = att ? (latest ? t.commit : gateFile(view?.gate ?? null)?.head?.slice(0, 7)) : t.commit;
        const minutes = att ? (att.ms !== undefined ? (att.ms / 60000).toFixed(1) : '—') : t.minutes ?? '—';
        const who = att ? `<span>${icon('robot-2-line')}<em>${c.executor}</em>${esc(attemptLabel(t, att, attLabels))}</span>` : '';
        body.innerHTML = pick + (text === null ? '' : text ? `<div class="sum">${commit ? `<span>${icon('git-commit-line')}<em>${c.commit}</em><span class="mono">${esc(commit)}</span></span>` : ''}<span>${icon('time-line')}<em>${c.elapsed}</em>${minutes} ${c.minutes}</span>${who}<span class="sp"></span><button class="btn icon quiet" data-open="report" data-tip="${c.openReport}" aria-label="${c.openReport}">${icon('external-link-line')}</button></div><div class="md selectable">${markdown(text)}</div>` : `<div class="empty">${icon('file-text-line')}<b>${t.status === 'run' && latest ? c.reportLater : c.noReport}</b>${t.status === 'run' && latest ? '' : `<p>${t.status === 'done' ? c.noReportDone(executorLabel(t)) : c.noReportHelp(executorLabel(t))}</p>`}</div>`);
    }
    else if (tab === 'gate') {
        const att = pickedAttempt(t);
        if (att) {
            const view = attView(t, att);
            body.innerHTML = attemptPick(t, att.n, attLabels) + (view ? gateTab(t, gateFile(view.gate), view.gate, { latest: att === attemptList(t).at(-1), exit: att.exit }) : '');
        }
        else
            body.innerHTML = gateTab(t, gateFile(gateResult), gateResult);
    }
    else if (tab === 'retry')
        body.innerHTML = historyTab(t, attLabels, histGates);
    else if (tab === 'score') {
        body.innerHTML = scoreView.html(t);
        scoreView.fit(body);
    }
    else if (tab === 'files') {
        const files = [...changedFiles().values()];
        body.innerHTML = files.length ? `<div class="sec-t">${c.filesHelp}${t.status === 'run' ? c.filesLive : ''}</div><div class="rows">${files.map(f => `<div class="r ${f.kind}">${icon(f.kind === 'add' ? 'add-line' : f.kind === 'delete' ? 'delete-bin-line' : 'edit-line')}<span class="muted">${c.kinds[f.kind]}</span><span class="v mono">${esc(f.path)}</span><button class="btn sm quiet" data-file="${esc(f.path)}">${c.open}</button></div>`).join('')}</div>` : `<div class="empty">${icon('file-copy-line')}<b>${c.noFiles}</b></div>`;
    }
    else {
        const row = (key: string, value: unknown, open?: string) => `<div class="r"><span class="k">${key}</span><span class="v mono">${esc(value)}</span>${open ? `<button class="btn sm quiet" data-open="${open}">${c.open}</button>` : ''}</div>`;
        body.innerHTML = `<div class="rows">${[[c.record, t.name], [c.spec, t.spec ?? c.direct, t.spec ? 'spec' : undefined], [c.role, t.role ?? c.noRole], [c.dispatcher, host(t)], [c.executor, `${executorLabel(t)}（${[...new Set([t.profile, executorAdapter(t)].filter(Boolean))].join(' · ')}）`], ...(t.route ? [[c.route, t.route]] : []), [c.agent, t.agentVersion ?? (isCodexTask(t) ? 'Codex CLI' : '—')], [c.model, t.model ?? (isCodexTask(t) ? c.followCodex : '—')], [c.effort, t.effort ?? (isCodexTask(t) ? c.followCodex : c.effortDefault)], ...(isCodexTask(t) ? [[c.tier, t.tier ?? c.followCodex]] : []), [c.managed, t.managed?c.yes:c.no], ...(isCodexTask(t) ? [[c.sandbox, t.sandbox ?? '—']] : []), [c.repo, t.repo, 'repo']].map(([k, v, o]) => row(k!, v, o)).join('')}</div><div class="sec-t">${c.records}</div><div class="rows">${[[c.progress, 'progress'], [c.events, 'events'], [c.raw, 'raw']].map(([label, key]) => row(label, t[key as 'progress'] ?? '—', t[key as 'progress'] ? key : undefined)).join('')}</div>`;
    }
    if (tab !== 'flow') {
        const compact = root.querySelector<HTMLButtonElement>('[data-plan-top]')!;
        compact.hidden = true;
        compact.innerHTML = '';
    }
    tabs();
    followButton();
}
function renderFlow() {
    if (!timeline || tab !== 'flow')
        return;
    const plan = [...timeline.events].reverse().find(e => e.kind === 'plan'), slot = root.querySelector('.plan-slot')!;
    const items = plan?.items ?? [];
    const html = items.length ? `<div class="plan"><div class="plan-h"><b>${c.plan}</b><span class="mono">${items.filter(p => p.done).length}/${items.length}</span><progress max="${items.length}" value="${items.filter(p => p.done).length}"></progress></div><ul>${items.map((p, i) => `<li class="${p.done ? 'done' : i === items.findIndex(x => !x.done) ? 'now' : ''}">${icon(p.done ? 'checkbox-circle-fill' : i === items.findIndex(x => !x.done) ? 'arrow-right-circle-line' : 'checkbox-blank-circle-line')}<span>${esc(p.text)}</span></li>`).join('')}</ul></div>` : '';
    if (slot.innerHTML !== html)
        slot.innerHTML = html;
    const compact = root.querySelector<HTMLButtonElement>('[data-plan-top]')!;
    const now = items.find(p => !p.done);
    const summary = items.length ? `<b>${c.plan}</b><span class="mono">${items.filter(p => p.done).length}/${items.length}</span><progress max="${items.length}" value="${items.filter(p => p.done).length}"></progress>${now ? `<span class="plan-now">${c.planNow}：${esc(now.text)}</span>` : ''}` : '';
    if (compact.innerHTML !== summary)
        compact.innerHTML = summary;
    if (!items.length)
        compact.hidden = true;
    timeline.think = think;
    // 多次尝试：顶部切换条 + 按尝试分组的分隔行；选了不存在的那一次（尝试列表变了）回到"全部"。
    const t = current();
    const attempts = t ? attemptList(t) : [];
    if (typeof flowAtt === 'number' && !attempts.some(a => a.n === flowAtt))
        flowAtt = 'all';
    timeline.attempts = t && attempts.length >= 2 ? separators(t, attLabels) : [];
    timeline.attemptFilter = flowAtt;
    const attSlot = root.querySelector<HTMLElement>('.att-slot');
    if (attSlot) {
        const bar = t && attempts.length >= 2 ? attemptBar(t) : '';
        // 选中态是代码套上去的，所以按生成的 markup 比较（存在 dataset 里），没变就不重建，焦点不丢。
        if (attSlot.dataset.markup !== bar) {
            attSlot.dataset.markup = bar;
            attSlot.innerHTML = bar;
        }
        for (const button of attSlot.querySelectorAll<HTMLButtonElement>('[data-att]')) {
            const on = button.dataset.att === String(flowAtt);
            button.classList.toggle('on', on);
            button.setAttribute('aria-pressed', String(on));
        }
    }
    // 门禁开始时在进展末尾插一行分隔（B6）：时刻取 gating 事件，执行者这时已经以 0 退出。只在看"全部"或最新一次时显示（门禁属于最新一次尝试）。
    const showFooter = flowAtt === 'all' || flowAtt === attempts.at(-1)?.n || attempts.length < 2;
    timeline.footer = (showFooter && t?.gatingAt ?`<div class="tl k-turn gate-sep"><span class="t mono">${clock(t.gatingAt)}</span><div class="c">执行者结束（exit=${t.agentExit ?? 0}）· 门禁开始</div></div>` : '') + (t?.worktree ? wtTailRow(t) : '');
    // worktree 任务：进展开头一行“建好 worktree · 分支 · 基线”。
    const wtSlot = root.querySelector<HTMLElement>('.wt-slot');
    if (wtSlot) { const head = (t ? routeHeadRow(t) : '') + (t?.worktree ? wtHeadRow(t) : ''); if (wtSlot.innerHTML !== head) wtSlot.innerHTML = head; }
    timeline.render();
    const earlier = root.querySelector<HTMLButtonElement>('[data-earlier]')!;
    earlier.hidden = !timeline.cursor?.start;
    earlier.textContent = c.earlier;
    root.querySelector('.live-foot')!.innerHTML = current()?.status === 'run' && timeline.follow ? `<span class="dot run"></span>${c.follow}` : '';
    followButton();
}
function followButton() { const b = root.querySelector<HTMLButtonElement>('[data-latest]'); if (b) {
    b.hidden = tab !== 'flow' || !timeline || timeline.follow || current()?.status !== 'run';
    b.textContent = c.latest;
} }
// 多次尝试（Stage05）：任务有 2 次及以上尝试时，读各次尝试用到的执行者显示名（一次），
// 以及汇报 / 门禁标签选中那一次的 attempts/<n>/ 文件（或重试标签要的各次门禁）。已结束的尝试读一次就缓存。返回界面要不要重画。
async function refreshAttempts(t: Task | undefined, gen: number, id: string): Promise<boolean> {
    if (!t || attemptList(t).length < 2)
        return false;
    const list = attemptList(t), dir = t.progress.replace(/[\\/][^\\/]*$/, '');
    const stale = () => gen !== generation || id !== selected;
    let changed = false;
    const read = async (n: number) => {
        const key = attKey(t, n), cached = attCache.get(key);
        if (cached)
            return cached;
        // 读不出来（目录不是 .agent-runs 下的记录目录等）按没有 attempts/ 处理，界面改读顶层文件，不反复弹错误。
        const files = await (window.dock.console('tasks:attempt-files', { dir, n }) as Promise<AttemptFiles>).catch((): AttemptFiles => ({ exists: false, report: '', gate: null }));
        if (list.find(a => a.n === n)?.ok !== undefined)
            attCache.set(key, files);
        return files;
    };
    if (!attLabelsLoaded) {
        attLabelsLoaded = true;
        try {
            const result = await window.dock.console('agents:list');
            if (stale())
                return false;
            attLabels = new Map(((result?.agents ?? []) as AgentRow[]).map(a => [a.name, a.label]));
            changed = true;
        }
        catch { /* 读不到执行者列表就显示配置名 */ }
    }
    if (tab === 'report' || tab === 'gate') {
        const att = pickedAttempt(t)!, files = await read(att.n);
        if (stale() || pickedAttempt(t)?.n !== att.n)
            return changed;
        const next = { ...files, key: attKey(t, att.n) };
        if (JSON.stringify(next) !== JSON.stringify(attFiles)) {
            attFiles = next;
            changed = true;
        }
    }
    else if (tab === 'retry') {
        const next = new Map<number, GateResult>();
        for (const a of list)
            next.set(a.n, (await read(a.n)).gate);
        if (stale())
            return changed;
        if (JSON.stringify([...next]) !== JSON.stringify([...histGates])) {
            histGates = next;
            changed = true;
        }
    }
    return changed;
}
async function refreshDetail(before = false) {
    if (preferences.wizard || page !== 'tasks' || !current())
        return;
    if (loading) {
        queued = true;
        return;
    }
    loading = true;
    const gen = generation, id = selected, oldReport = report;
    try {
        const [data, eventPage] = await Promise.all([window.dock.detail(id), window.dock.events(id, timeline?.cursor, before)]);
        if (gen !== generation || id !== selected)
            return;
        const oldGate = JSON.stringify(gateResult);
        report = data.report;
        gateResult = data.gate;
        const gateChanged = oldGate !== JSON.stringify(gateResult);
        // 未打开进展标签时同样保留事件模型，改动页因此得到完整汇总。
        if (!timeline) {
            const detached = document.createElement('div');
            timeline = new Timeline(detached, detached);
            timeline.follow = current()?.status === 'run';
        }
        let changed = eventPage.reset || eventPage.events.length > 0;
        timeline.merge(eventPage, before);
        // 每轮补一页历史，保证较早的计划和文件改动也会汇总；仍优先读取新增进展。
        if (!before && timeline.cursor!.start > 0) {
            const older = await window.dock.events(id, timeline.cursor, true);
            if (gen !== generation || id !== selected)
                return;
            timeline.merge(older, true);
            changed ||= older.reset || older.events.length > 0;
        }
        // 多次尝试：读各次尝试的执行者显示名、选中那一次的汇报与门禁（或重试历史要的各次门禁）。
        const attChanged = await refreshAttempts(current(), gen, id);
        if (gen !== generation || id !== selected)
            return;
        // gate.json 变化时重画标题区（轨道与门禁横幅）和正在看的门禁标签，保留滚动位置。
        if (gateChanged)
            header();
        if (tab === 'flow' && (changed || gateChanged || attChanged))
            renderFlow();
        else if (tab !== 'flow' && (oldReport !== report || changed || gateChanged || attChanged)) {
            const viewport = root.querySelector<HTMLElement>('.dbody > .scroll')!, top = viewport.scrollTop;
            renderTab();
            viewport.scrollTop = top;
        }
        if (changed)
            tabs();
    }
    catch (e) {
        notice(e);
    }
    finally {
        if (gen === generation) {
            loading = false;
            if (queued) {
                queued = false;
                void refreshDetail();
            }
        }
    }
}
root.addEventListener('click', async (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button,a');
    if (!b)
        return;
    const d = b.dataset;
    // 验收页的点击由 AcceptView 自己处理（它挂在内容区上）；侧栏等内容区以外的按钮照旧走这里。
    if (page === 'accept' && !preferences.wizard && b.closest('.content')) return;
    if (b.tagName === 'A') {
        e.preventDefault();
        void action('link', b.getAttribute('href')!);
        return;
    }
    if (b.hasAttribute('data-managed-settings') && !preferences.wizard) { page='settings'; nav(); pageView(); preferences.focusManaged(); }
    else if (d.page && !preferences.wizard) {
        page = d.page;
        nav();
        pageView();
    }
    // 任务页的“去验收”：切到验收页并选中这个任务。
    else if (d.goAccept) {
        acceptSelected = d.goAccept;
        page = 'accept';
        nav();
        pageView();
    }
    else if (d.multi === 'select') {
        selecting = true;
        checked.clear();
        list();
        root.querySelector<HTMLElement>('[data-multi=all]')?.focus({ preventScroll: true });
    }
    else if (d.multi === 'done')
        exitSelect();
    else if (d.multi === 'all') {
        const visible = visibleTasks();
        const ended = visible.filter(t => t.status !== 'run'), all = ended.length > 0 && ended.every(t => checked.has(t.id));
        for (const t of ended)
            if (all) checked.delete(t.id); else checked.add(t.id);
        list();
    }
    else if (d.multi === 'delete')
        openDelete(b);
    else if (d.filter) {
        filter = d.filter;
        list();
    }
    // 列表顶部的“清除”：清空搜索，焦点回到搜索框。
    else if (b.hasAttribute('data-found-clear')) {
        taskSearch.set('');
        taskSearch.focus();
    }
    else if (b.hasAttribute('data-sort')) {
        if (closeSortMenu()) return;
        const current = taskSort();
        openSortMenu(b, '[data-sort]', (['time', 'state', 'project'] as const).map(key => [key, s6.taskSorts[key][0], s6.taskSorts[key][1]] as [string, string, string]), current, key => {
            const next = key as TaskSort;
            if (next === current) return;
            // 先在本地生效（列表立刻重排），再写进软件偏好；写盘失败只提示，不回退当前排序。
            if (preferences.settings) preferences.settings.own.taskSort = next;
            list();
            void window.dock.preferences('own', { key: 'taskSort', value: next }).catch(notice);
        }, matchMedia('(max-width: 1279px)').matches);
    }
    else if (b.hasAttribute('data-project'))
        menu(b, [{ label: c.projects, run: () => { repo = ''; list(); } }, ...[...new Set(state.tasks.map(t => t.repo))].map(value => ({ label: value.split(/[\\/]/).at(-1)!, run: () => { repo = value; list(); } }))], true);
    else if (b.hasAttribute('data-import'))
        void window.dock.import().catch(notice);
    else if (d.task) {
        // 选择模式下点行只切换勾选，不切换详情。
        if (selecting) {
            if (checked.has(d.task)) checked.delete(d.task); else checked.add(d.task);
            list();
            return;
        }
        selected = d.task;
        tab = current()?.status === 'done' ? 'report' : 'flow';
        list();
        detail();
    }
    else if (d.tab)
        switchTab(d.tab);
    // 多次尝试：重试历史的一行 → 切到进展并选中那一次；进展顶部的切换条；汇报、门禁顶部的下拉；标题行的"重试"。
    else if (d.attRow) {
        flowAtt = Number(d.attRow);
        switchTab('flow');
    }
    else if (d.attPick !== undefined) {
        const t = current();
        if (t)
            menu(b, attemptPickItems(t, attLabels, n => {
                pickAtt = n;
                const hit = attCache.get(attKey(t, n));
                attFiles = hit ? { ...hit, key: attKey(t, n) } : null;
                renderTab();
                root.querySelector<HTMLElement>('[data-att-pick]')?.focus({ preventScroll: true });
                void refreshDetail();
            }), true);
    }
    else if (d.att !== undefined) {
        flowAtt = d.att === 'all' ? 'all' : Number(d.att);
        if (timeline)
            timeline.follow = false;
        renderFlow();
        root.querySelector<HTMLElement>('.dbody > .scroll')!.scrollTop = 0;
    }
    else if (b.hasAttribute('data-retry')) {
        const t = current();
        if (t)
            openRetrySheet({ t, trigger: b, failure: lastFailure(t, t.gateSummary ?? gateFile(gateResult)?.summary ?? ''), gate: gateEnabled(t) });
    }
    else if (b.hasAttribute('data-think')) {
        think = !think;
        timeline?.invalidate();
        renderFlow();
        tabs();
    }
    else if (b.hasAttribute('data-plan-top')) {
        if (timeline)
            timeline.follow = false;
        root.querySelector<HTMLElement>('.dbody > .scroll')!.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
    else if (b.hasAttribute('data-latest')) {
        if (timeline) {
            timeline.follow = true;
            timeline.invalidate();
            renderFlow();
        }
    }
    else if (b.hasAttribute('data-earlier')) {
        if (timeline)
            timeline.follow = false;
        void refreshDetail(true);
    }
    else if (b.hasAttribute('data-redispatch')) {
        const t = current();
        if (t)
            void redispatchTask(t);
    }
    else if (b.hasAttribute('data-stop')) {
        const t = current();
        if (t && await confirmStop(t.title, executorLabel(t), b))
            void window.dock.action(t.id, 'stop').catch(notice);
    }
    else if (b.hasAttribute('data-more')) {
        const t = current()!;
        menu(b, [{ label: c.openRepo, run: () => void action('repo') }, ...(t.spec ? [{ label: c.openSpec, run: () => void action('spec') }] : []), { label: t.hasReport ? c.openReport : c.reportPending, disabled: !t.hasReport, run: () => void action('report') }, { label: c.openProgress, run: () => void action('progress') }, { label: c.copyName, run: () => void action('copy') }, { label: c.hide, separator: true, disabled: t.status === 'run' || !processOk(), run: () => void action('hide') }]);
    }
    // 门禁标签里的验收命令：只切换展开状态，不重建 DOM，焦点和滚动都不动。
    else if (d.gcmd !== undefined) {
        const open = b.getAttribute('aria-expanded') !== 'true';
        b.setAttribute('aria-expanded', String(open));
        const out = root.querySelector<HTMLElement>(`[data-gout="${CSS.escape(d.gcmd)}"]`), note = root.querySelector<HTMLElement>(`[data-gnote="${CSS.escape(d.gcmd)}"]`);
        if (out) out.hidden = !open;
        if (note) note.hidden = !open;
    }
    // 项目已移除横幅的“重新添加项目”：走项目页同一条 projects:add，成功后横幅消失、按钮恢复。
    else if (d.readdProject !== undefined) {
        const t = state.tasks.find(x => x.id === d.readdProject);
        if (t)
            void readdProject(t, () => { if (current()?.id === t.id) header(); }).catch(notice);
    }
    // 准备失败横幅的“驳回…”：和验收页同一个驳回弹窗。
    else if (d.setupReject) {
        const t = state.tasks.find(x => x.id === d.setupReject);
        if (t)
            acceptView.rejectSheet(t, b);
    }
    else if (d.blameN) {
        const t = current(), body = root.querySelector<HTMLElement>('.tab-body');
        if (t && body)
            void scoreView.blame(t, Number(d.blameN), d.blameWho === 'spec' || d.blameWho === 'environment' ? d.blameWho : 'worker', body);
    }
    else if (d.open)
        void action(d.open);
    else if (d.file)
        void action('file', d.file);
});
// 进程查询失败时任务页顶部的横幅（W4）；查询恢复后自动消失。
const processOk = () => state.processCheck?.ok !== false;
function processBanner() {
    const holder = root.querySelector<HTMLElement>('[data-process-banner]');
    if (!holder) return;
    const pc = state.processCheck;
    const html = pc && !pc.ok ? `<div class="banner stale" role="status">${mark('stop')}<div class="rt"><b>${esc(c.processUnknownTitle)}</b><span>${esc(c.processUnknownHelp(pc.failures, pc.error ?? ''))}</span></div></div>` : '';
    if (holder.innerHTML !== html) holder.innerHTML = html;
}
function accept(s: Snapshot) { const old = JSON.stringify(state.tasks), oldCheck = JSON.stringify(state.processCheck ?? null), oldLimit = state.concurrency; state = s;
    // 设置里改了“同时运行的任务”：侧栏底部的上限跟着变。
    if (oldLimit !== s.concurrency && root.children.length) nav(); document.documentElement.dataset.theme = s.theme; if (oldCheck !== JSON.stringify(s.processCheck ?? null)) { processBanner(); if (page === 'tasks' && current()) header(); } if (!root.children.length) {
    shell();
    return;
} if (s.select && s.selectPage === 'accept') {
    // 待验收 / 冲突通知点开：切到验收页并选中这个任务。
    acceptSelected = s.select;
    page = 'accept';
    nav();
    pageView();
    return;
} if (s.select) {
    selected = s.select;
    filter = 'all';
    repo = '';
    taskSearch.set('');
    page = 'tasks';
    tab = current()?.status === 'done' ? 'report' : 'flow';
    nav();
    pageView();
    return;
} if (old !== JSON.stringify(s.tasks)) {
    nav();
    list();
    if (page === 'projects') {
        projectsView.tasksChanged();
    }
    else if (page === 'accept' && !preferences.wizard) {
        acceptView.tasksChanged();
    }
    else if (page === 'tasks' && !preferences.wizard) {
        if (!current()) {
            detail();
        }
        else if (detailSignature !== headerKey(current()!))
            header();
    }
} void refreshDetail(); }
// ---- 关闭询问（012）：主进程在点 × 且偏好为"每次询问"时发 close-request ----
let closeOverlay: HTMLElement | null = null;
function openCloseDialog() {
    if (closeOverlay) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement('div');
    overlay.className = 'ov close-ov';
    overlay.innerHTML = `<section class="sheet close-sheet" role="dialog" aria-modal="true" aria-labelledby="close-title" aria-describedby="close-body"><div class="sheet-h"><b id="close-title">${esc(p.closeTitle)}</b></div><div class="sheet-b scroll"><p class="sheet-lead" id="close-body">${esc(p.closeBody)}</p><button class="choice close-remember" role="checkbox" aria-checked="false" data-close-remember><span class="cb"></span><span class="ct">${esc(p.closeRemember)}</span></button></div><div class="sheet-f"><span class="note"></span><span class="sheet-btns"><button class="btn" data-close-action="cancel">${esc(c.cancel)}</button><button class="btn" data-close-action="quit">${esc(p.closeQuit)}</button><button class="btn primary" data-close-action="tray">${esc(p.closeTray)}</button></span></div></section>`;
    // 背景不可操作（与 openSheet / confirmAction 相同），关闭后恢复原来的 inert 状态。
    const background = [...document.body.children].filter((e): e is HTMLElement => e instanceof HTMLElement).map(e => ({ e, inert: e.inert }));
    background.forEach(({ e }) => e.inert = true);
    document.body.append(overlay);
    closeOverlay = overlay;
    // 告诉主进程询问已显示：之后等用户回答，不会因为超过 5 秒没回答而自动退出。
    void window.dock.closeShown().catch(() => { /* 主进程已经开始退出时忽略 */ });
    const remember = overlay.querySelector<HTMLButtonElement>('[data-close-remember]')!;
    const checked = () => remember.getAttribute('aria-checked') === 'true';
    remember.onclick = () => {
        const on = !checked();
        remember.setAttribute('aria-checked', String(on));
        remember.classList.toggle('on', on);
        remember.querySelector('.cb')!.classList.toggle('on', on);
    };
    const close = () => {
        background.forEach(({ e, inert }) => e.inert = inert);
        overlay.remove();
        closeOverlay = null;
        previous?.focus({ preventScroll: true });
    };
    const answer = (action: 'cancel' | 'tray' | 'quit') => {
        if (!closeOverlay) return;
        close();
        void window.dock.closeChoice(action, checked()).catch(() => { /* 主进程已经开始退出时不再提示 */ });
    };
    for (const button of overlay.querySelectorAll<HTMLButtonElement>('[data-close-action]'))
        button.onclick = () => answer(button.dataset.closeAction as 'cancel' | 'tray' | 'quit');
    requestAnimationFrame(() => overlay.classList.add('motion-open'));
    // 默认焦点在"最小化到托盘"（主按钮）。
    overlay.querySelector<HTMLButtonElement>('[data-close-action=tray]')!.focus({ preventScroll: true });
}
// 关闭询问在最上层：有它时截住 Tab / Esc，不让下面的模态框或页面先处理（本监听在页面加载时就注册，早于其他模态框）。
document.addEventListener('keydown', e => {
    if (!closeOverlay) return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
        e.preventDefault();
        closeOverlay.querySelector<HTMLButtonElement>('[data-close-action=cancel]')?.click();
    }
    else if (e.key === 'Tab') {
        e.preventDefault();
        const buttons = [...closeOverlay.querySelectorAll<HTMLElement>('button:not(:disabled)')];
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLElement);
        buttons[(index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    }
}, true);
// 017：Esc 退出选择模式。模态框、确认框、菜单、关闭询问打开时让给它们（它们可能已把事件目标移除，按 target 判断）。
// 评分标签：门禁失败归因的分段控件用方向键切换。
document.addEventListener('keydown', e => {
    const t = current(), body = root.querySelector<HTMLElement>('.tab-body');
    if (page === 'tasks' && tab === 'score' && t && body && body.contains(e.target as Node))
        scoreView.key(e, t, body);
});
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !selecting || (e.target instanceof Element && e.target.closest('.ov, .confirm-overlay, .ctx, .sort-pop')))
        return;
    e.preventDefault();
    exitSelect();
});
window.dock.onCloseRequest(openCloseDialog);
void window.dock.closeReady().catch(() => {});
installScrollMaterial(document.body);
tooltips();
void preferences.init().then(() => { window.dock.subscribe(accept); return window.dock.snapshot(); }).then(accept).catch(notice);
setInterval(() => { for (const el of root.querySelectorAll<HTMLElement>('[data-elapsed]')) {
    const t = state.tasks.find(t => t.id === el.dataset.elapsed);
    if (t)
        el.textContent = elapsed(t);
} void refreshDetail(); }, 1000);
