import { c, cx, p } from '../shared/copy';
import type { Task, Snapshot, Event as TaskEvent } from '../shared/types';
import { esc, markdown } from '../shared/markdown';
import { icon, menu, confirmStop, tooltips, notice, openSheet, toast, trace } from './ui';
import { executorAdapter, executorLabel, executorTag, isCodexTask } from '../shared/executor';
import { installScrollMaterial } from './floatingThumb';
import { Timeline } from './timeline';
import { PreferencesView } from './preferences';
import { ProjectsView } from './projects';
import { NewTaskView } from './newtask';
import brandSVG from '../../design/icons/mark.svg';
const root = document.querySelector<HTMLElement>('#app')!;
const brand = brandSVG.replace('<svg ', '<svg aria-hidden="true" ');
const marks = { run: ['run', 'loader-4-line'], done: ['ok', 'checkbox-circle-line'], fail: ['fail', 'close-circle-line'], stop: ['stale', 'stop-circle-line'] };
const mark = (s: Task['status']) => `<span class="mk ${marks[s][0]}">${icon(marks[s][1])}</span>`;
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
const taskTitle = (t: Task) => `<span class="ttl">${esc(t.title)}</span>${attemptTag(t)}`;
let state: Snapshot = { tasks: [], theme: 'dark', version: '0.1.0' }, page = 'tasks', filter = 'all', repo = '', selected = '', tab = 'flow', think = false, timeline: Timeline | undefined, report = '', generation = 0, loading = false, queued = false, detailSignature = '';
// 再派一次：正在派发的任务、失败原因（只显示在触发它的那个任务详情上）。
let redispatchFor = '', redispatchBusy = false, redispatchError = '', redispatchErrorFor = '';
// 017：批量选择与删除。checked 只存 id；筛选后不可见的勾选保留，计数照实。
let selecting = false;
const checked = new Set<string>();
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
const current = () => state.tasks.find(t => t.id === selected);
const headerKey = (t: Task) => JSON.stringify([t.id, t.title, t.status, t.role, t.started, t.ended, t.minutes, t.exit, t.signal, t.commit, t.dispatcher?.host,t.managed,preferences.settings?.managed, attemptOf(t)]);
const action = (name: string, value?: string) => { trace('action-send', { task: selected, name }); return window.dock.action(selected, name, value).then(() => trace('action-done', { name }), error => { trace('action-error', { name, error: String((error as Error)?.message ?? error) }); notice(error); }); };
function shell() { root.innerHTML = `<div class="tb-l">${brand}<span class="wordmark">${c.app}</span></div><div class="tb-r"></div><nav class="nav"></nav><section class="content"></section>`; nav(); pageView(); }
// 侧栏只在内容变化时重建：异步刷新晚到时不替换按钮，避免吞掉正在进行的点击；重建后焦点放回同一个导航按钮。
let navHtml = '';
function nav() {
    const runningTasks = state.tasks.filter(t => t.status === 'run'), running = runningTasks.length, box = root.querySelector('.nav')!;
    // 状态行第一行按执行者显示名统计正在运行的任务；没有任务时保留原来的说明。
    const groups = new Map<string, number>();
    for (const t of runningTasks) {
        const label = executorLabel(t);
        groups.set(label, (groups.get(label) ?? 0) + 1);
    }
    const load = runningTasks.length
        ? `<div title="${esc(c.loadHelp)}"><span class="dot run"></span><span class="mono">${esc(c.load([...groups]))}</span></div>`
        : `<div><span class="dot ok"></span>${c.running(0)}</div>`;
    const item = (key: string, i: string, label: string) => `<button ${preferences.wizard ? 'disabled' : ''} data-page="${key}" ${page === key ? 'aria-current="page"' : ''}>${icon(i)}${label}${key === 'tasks' && running ? `<span class="count">${running}</span>` : ''}</button>`;
    const html = item('tasks', 'stack-line', c.tasks) + item('newtask', 'add-circle-line', c.newTask) + `<div class="nav-group">${esc(c.configGroup)}</div>` + item('projects', 'folder-3-line', c.projectsNav) + item('connect', 'plug-line', c.connect) + '<span class="sp"></span>' + item('settings', 'settings-3-line', c.settings) + item('about', 'information-line', c.about) + `<div class="nav-foot">${load}<button data-managed-settings ${preferences.wizard?'disabled':''}>${icon('shield-check-line')}${preferences.settings?.managed?c.managedOn:c.managedOff}</button></div>`;
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
    if (preferences.wizard || (page !== 'tasks' && page !== 'projects' && page !== 'newtask')) {
        preferences.mount(content as HTMLElement, page, state.version);
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
    content.innerHTML = '<div class="page-h"></div><div class="banner-holder" data-process-banner></div><div class="split"><div class="edge"><div class="tlist scroll"></div></div><div class="detail"></div></div>';
    processBanner();
    list();
    detail();
}
// 017：列表重建前后按 data-* 找回同一个控件。
function focusedKey(): string {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !root.contains(el))
        return '';
    for (const name of ['task', 'multi', 'filter']) { const value = el.dataset[name]; if (value) return `${name}:${value}`; }
    if (el.hasAttribute('data-project')) return 'project:';
    if (el.hasAttribute('data-import')) return 'import:';
    return '';
}
function restoreFocus(key: string) {
    if (!key) return;
    const at = key.indexOf(':'), kind = key.slice(0, at), value = key.slice(at + 1);
    const el = kind === 'project' ? root.querySelector<HTMLElement>('[data-project]')
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
    const count = (key: string) => state.tasks.filter(t => (!repo || t.repo === repo) && (key === 'all' || key === 'run' && t.status === 'run' || key === 'issues' && ['fail', 'stop'].includes(t.status))).length;
    const tasks = state.tasks.filter(t => (!repo || repo === t.repo) && (filter === 'all' || filter === 'run' && t.status === 'run' || filter === 'issues' && ['fail', 'stop'].includes(t.status)));
    // "全选已结束的"只作用于当前筛选下可见的已结束任务；全选后按钮变成"取消全选"。
    const ended = tasks.filter(t => t.status !== 'run'), allChecked = ended.length > 0 && ended.every(t => checked.has(t.id));
    const filters = `<div class="segm">${[['all', c.all], ['run', c.status.run], ['issues', c.issues]].map(([key, label]) => `<button data-filter="${key}" class="${filter === key ? 'on' : ''}">${label} <span class="n">${count(key)}</span></button>`).join('')}</div>`;
    const projectSel = `<button class="sel" data-project aria-haspopup="listbox" aria-expanded="false"><span class="ph">${esc(repo ? repo.split(/[\\/]/).at(-1) : c.projects)}</span>${icon('arrow-down-s-line')}</button>`;
    root.querySelector('.page-h')!.innerHTML = selecting
        ? `<h1>${c.multiCount(checked.size)}</h1>${filters}${projectSel}<span class="sp"></span><button class="btn" data-multi="all">${allChecked ? c.multiNone : c.multiAll}</button><button class="btn danger" data-multi="delete" ${checked.size && processOk() ? '' : 'disabled'}>${esc(c.multiDelete)}</button><button class="btn" data-multi="done">${esc(c.multiDone)}</button>`
        : `<h1>${c.tasks}</h1>${filters}${projectSel}<button class="btn" data-multi="select">${esc(c.multiSelect)}</button><span class="sp"></span><button class="btn icon quiet" data-import data-tip="${c.import}" aria-label="${c.import}">${icon('folder-add-line')}</button><button class="btn primary" data-page="newtask">${icon('add-line')}${esc(c.newTask)}</button>`;
    if (selected && !tasks.some(t => t.id === selected)) {
        selected = '';
        detailSignature = '';
        detail();
    }
    const groups = new Map<string, Task[]>();
    const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
    for (const t of [...tasks].sort((a, b) => Number(b.status === 'run') - Number(a.status === 'run') || b.started - a.started)) {
        const day = t.status === 'run' ? c.status.run : t.started >= today ? c.today : t.started >= yesterday ? c.yesterday : new Date(t.started).toLocaleDateString('zh-CN');
        groups.set(day, [...(groups.get(day) ?? []), t]);
    }
    const box = root.querySelector<HTMLElement>('.tlist')!, scroll = box.scrollTop;
    box.innerHTML = tasks.length ? [...groups].map(([day, rows]) => `<div class="tgroup">${day}<span class="mono">${day === c.status.run ? rows.length : new Date(rows[0].started).toLocaleDateString('en-CA', { month: '2-digit', day: '2-digit' })}</span></div>${rows.map(t => { const tail = t.imported ? c.imported : t.processState === 'unknown' ? c.processUnknownTag : t.status === 'run' ? t.last : t.status === 'fail' ? `exit=${t.exit}` : t.status === 'stop' ? (t.signal === 'stopped-by-app' ? c.stoppedShort : t.signal === 'stopped-by-command' ? c.stoppedByCommandShort : c.closed) : t.commit ?? (t.sandbox === 'read-only' ? c.readonly : ''); const on = checked.has(t.id); const lead = selecting ? `<span class="cb ${on ? 'on' : ''}" aria-hidden="true">${on ? icon('check-line') : ''}</span>` : mark(t.status); const multi = selecting ? ` role="checkbox" aria-checked="${on}"${t.status === 'run' ? ` disabled aria-disabled="true" data-tip="${esc(c.multiRunning)}"` : ''}` : ''; return `<button class="trow ${selecting ? 'multi ' : ''}is-${t.status === 'run' ? 'running' : t.status} ${selected === t.id ? 'on' : ''}" data-task="${esc(t.id)}"${multi}>${lead}<span class="tm"><b>${taskTitle(t)}</b><span class="${t.status === 'run' ? 'live' : ''}"><span class="xtag mono" title="${esc(executorLabel(t))}" data-executor="${esc(executorTag(executorLabel(t)))}">${esc(executorTag(executorLabel(t)))}</span>${esc(project(t))}${tail ? ' · ' + esc(tail) : ''}</span></span><span class="ts"><span class="mono" ${t.status === 'run' ? `data-elapsed="${esc(t.id)}"` : ''}>${t.status === 'run' ? elapsed(t) : clock(t.started)}</span></span></button>`; }).join('')}`).join('') : `<div class="empty">${icon('stack-line')}<b>${c.empty}</b><p>${c.emptyHelp}</p></div>`;
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
    const t = current();
    if (!t) {
        box.innerHTML = `<div class="empty">${icon('file-list-3-line')}<b>${state.tasks.length ? c.select : c.emptyDetail}</b><p>${c.detailHelp}</p></div>`;
        return;
    }
    box.innerHTML = '<div class="dh"></div><div class="dtabs"></div><div class="banner-holder"></div><div class="dbody edge"><div class="scroll" tabindex="0"><div class="tab-body"></div></div><button class="plan-compact plan-h" data-plan-top hidden></button><button class="btn sm follow" data-latest hidden></button></div>';
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
    const redispatch = finished ? `<button class="btn sm" data-redispatch data-tip="${esc(c.redispatchHelp)}" aria-label="${esc(c.redispatch)}" ${busy ? 'disabled' : ''}>${busy ? `<span class="mk run">${icon('loader-4-line')}</span>${esc(c.redispatching)}` : `${icon('refresh-line')}${esc(c.redispatch)}`}</button>` : '';
    root.querySelector('.dh')!.innerHTML = `<div class="dh-1"><h2>${taskTitle(t)}</h2>${t.managed?`<span class="tag">${c.managed}</span>`:''}${t.legacy?`<span class="tag" data-legacy>${c.legacy}</span>`:''}<span class="acts">${redispatch}${t.status === 'run' ? `<button class="btn sm danger" data-stop ${processOk() ? '' : `disabled data-tip="${esc(c.processUnknownBlocked)}"`}>${icon('stop-circle-line')}${c.stop}</button>` : ''}<button class="btn icon quiet" data-more data-tip="${c.more}" aria-label="${c.more}" aria-haspopup="menu">${icon('more-2-fill')}</button></span></div><div class="dh-2"><span class="dh-state ${marks[t.status][0]}">${mark(t.status)}${c.status[t.status]}${t.status === 'run' ? ` · <span data-elapsed="${esc(t.id)}">${elapsed(t)}</span>` : t.status === 'done' ? ` · ${c.elapsed} ${t.minutes ?? '—'} ${c.minutes}` : t.status === 'fail' ? ` · exit=${t.exit}` : ''}</span><span>${icon('folder-3-line')}${esc(project(t))}</span><span data-dispatcher-line>${icon('user-line')}<em>${c.dispatcher}</em>${esc(host(t))}</span><span data-executor-line>${icon('robot-2-line')}<em>${c.executor}</em>${esc(executorLabel(t))}</span><span>${icon('time-line')}${clock(t.started)} ${c.started}</span>${t.commit ? `<span>${icon('git-commit-line')}<span class="mono">${t.commit}</span></span>` : ''}</div>`;
    // 再派一次失败用页面横幅显示原因。
    const failed = redispatchError && redispatchErrorFor === t.id ? `<div class="banner fail" role="alert">${mark('fail')}<div class="rt"><b>${esc(c.redispatchFailed)}</b><span>${esc(redispatchError)}</span></div></div>` : '';
    trace('header', { task: t.id, banner: !!failed, busy, errorFor: redispatchErrorFor });
    // 只找详情里的横幅区：任务页顶部还有一个进程状态横幅区（W4），不能写到那里。
    root.querySelector('.detail .banner-holder')!.innerHTML = failed + (['fail', 'stop'].includes(t.status) ? `<div class="banner ${t.status === 'fail' ? 'fail' : 'stale'}">${mark(t.status)}<div class="rt"><b>${esc(t.status === 'fail' ? c.failedTitle(executorLabel(t), t.exit) : t.signal === 'stopped-by-app' ? c.stopped : t.signal === 'stopped-by-command' ? c.stoppedByCommand : c.interruptedTitle)}</b><span>${t.status === 'fail' ? c.failedHelp : ['stopped-by-app','stopped-by-command'].includes(t.signal ?? '') ? c.stoppedHelp : c.interruptedHelp}</span></div>${t.status==='stop'&&!['stopped-by-app','stopped-by-command'].includes(t.signal ?? '')&&!preferences.settings?.managed?`<button class="btn sm" data-managed-settings>${c.goSettings}</button>`:''}</div>` : '');
    tabs();
}
function tabs() {
    const files = changedFiles().size, bar = root.querySelector<HTMLElement>('.dtabs')!;
    if (!bar.children.length)
        bar.innerHTML = `<div class="segm sm">${[['flow', c.flow], ['report', c.report], ['files', c.files], ['params', c.params]].map(([key, label]) => `<button data-tab="${key}">${label}</button>`).join('')}</div><span class="sp"></span><span class="hint">${c.think}<button class="toggle" data-think role="switch" aria-label="${c.think}"></button></span>`;
    for (const button of bar.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
        button.classList.toggle('on', button.dataset.tab === tab);
        button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
    }
    const fileButton = bar.querySelector<HTMLElement>('[data-tab=files]')!, label = c.files + (files ? ` <span class="n">${files}</span>` : '');
    if (fileButton.innerHTML !== label)
        fileButton.innerHTML = label;
    bar.querySelector<HTMLElement>('.hint')!.hidden = tab !== 'flow';
    const toggle = bar.querySelector<HTMLElement>('[data-think]')!;
    toggle.classList.toggle('on', think);
    toggle.setAttribute('aria-checked', String(think));
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
        body.innerHTML = '<div class="plan-slot"></div><button class="btn sm quiet" data-earlier hidden></button><div class="events-host"></div><div class="live-foot"></div>';
        timeline = new Timeline(body.querySelector('.events-host')!, viewport);
        timeline.events = events;
        timeline.cursor = cursor;
        timeline.follow = follow;
        timeline.think = think;
        renderFlow();
    }
    else if (tab === 'report')
        body.innerHTML = report ? `<div class="sum">${t.commit ? `<span>${icon('git-commit-line')}<em>${c.commit}</em><span class="mono">${t.commit}</span></span>` : ''}<span>${icon('time-line')}<em>${c.elapsed}</em>${t.minutes ?? '—'} ${c.minutes}</span><span class="sp"></span><button class="btn icon quiet" data-open="report" data-tip="${c.openReport}" aria-label="${c.openReport}">${icon('external-link-line')}</button></div><div class="md selectable">${markdown(report)}</div>` : `<div class="empty">${icon('file-text-line')}<b>${t.status === 'run' ? c.reportLater : c.noReport}</b>${t.status === 'run' ? '' : `<p>${t.status === 'done' ? c.noReportDone(executorLabel(t)) : c.noReportHelp(executorLabel(t))}</p>`}</div>`;
    else if (tab === 'files') {
        const files = [...changedFiles().values()];
        body.innerHTML = files.length ? `<div class="sec-t">${c.filesHelp}${t.status === 'run' ? c.filesLive : ''}</div><div class="rows">${files.map(f => `<div class="r ${f.kind}">${icon(f.kind === 'add' ? 'add-line' : f.kind === 'delete' ? 'delete-bin-line' : 'edit-line')}<span class="muted">${c.kinds[f.kind]}</span><span class="v mono">${esc(f.path)}</span><button class="btn sm quiet" data-file="${esc(f.path)}">${c.open}</button></div>`).join('')}</div>` : `<div class="empty">${icon('file-copy-line')}<b>${c.noFiles}</b></div>`;
    }
    else {
        const row = (key: string, value: unknown, open?: string) => `<div class="r"><span class="k">${key}</span><span class="v mono">${esc(value)}</span>${open ? `<button class="btn sm quiet" data-open="${open}">${c.open}</button>` : ''}</div>`;
        body.innerHTML = `<div class="rows">${[[c.record, t.name], [c.spec, t.spec ?? c.direct, t.spec ? 'spec' : undefined], [c.role, t.role ?? c.noRole], [c.dispatcher, host(t)], [c.executor, `${executorLabel(t)}（${[...new Set([t.profile, executorAdapter(t)].filter(Boolean))].join(' · ')}）`], [c.agent, t.agentVersion ?? (isCodexTask(t) ? 'Codex CLI' : '—')], [c.model, t.model ?? (isCodexTask(t) ? c.followCodex : '—')], ...(isCodexTask(t) ? [[c.effort, t.effort ?? c.followCodex], [c.tier, t.tier ?? c.followCodex]] : []), [c.managed, t.managed?c.yes:c.no], ...(isCodexTask(t) ? [[c.sandbox, t.sandbox ?? '—']] : []), [c.repo, t.repo, 'repo']].map(([k, v, o]) => row(k!, v, o)).join('')}</div><div class="sec-t">${c.records}</div><div class="rows">${[[c.progress, 'progress'], [c.events, 'events'], [c.raw, 'raw']].map(([label, key]) => row(label, t[key as 'progress'] ?? '—', t[key as 'progress'] ? key : undefined)).join('')}</div>`;
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
        report = data.report;
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
        if (tab === 'flow' && changed)
            renderFlow();
        else if (tab !== 'flow' && (oldReport !== report || changed)) {
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
    else if (d.multi === 'select') {
        selecting = true;
        checked.clear();
        list();
        root.querySelector<HTMLElement>('[data-multi=all]')?.focus({ preventScroll: true });
    }
    else if (d.multi === 'done')
        exitSelect();
    else if (d.multi === 'all') {
        const visible = state.tasks.filter(t => (!repo || repo === t.repo) && (filter === 'all' || filter === 'run' && t.status === 'run' || filter === 'issues' && ['fail', 'stop'].includes(t.status)));
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
    else if (d.tab) {
        tab = d.tab;
        renderTab();
        root.querySelector<HTMLElement>('.dbody > .scroll')!.scrollTop = 0;
        void refreshDetail();
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
function accept(s: Snapshot) { const old = JSON.stringify(state.tasks), oldCheck = JSON.stringify(state.processCheck ?? null); state = s; document.documentElement.dataset.theme = s.theme; if (oldCheck !== JSON.stringify(s.processCheck ?? null)) { processBanner(); if (page === 'tasks' && current()) header(); } if (!root.children.length) {
    shell();
    return;
} if (s.select) {
    selected = s.select;
    filter = 'all';
    repo = '';
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
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !selecting || (e.target instanceof Element && e.target.closest('.ov, .confirm-overlay, .ctx')))
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
