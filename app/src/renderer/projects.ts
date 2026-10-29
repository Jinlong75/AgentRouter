// 项目页（Stage03 T6）：左侧项目列表 + 右侧详情。
// 详情里可以打开 Claude Code / 文件夹、编辑配置、移除；不是 git 的文件夹可以一键 git init；
// 未初始化时先预览改动，确认后才写入，写完后可以把这几个文件提交到一个新提交里。
// 数据都经 window.dock.console 交给核心；会写文件的操作期间按钮忙碌，失败在详情顶部显示核心给的原因。
import { ag, c, pj, s6 } from '../shared/copy';
import { esc } from '../shared/markdown';
import type { GitVersionInfo, ProjectChange, ProjectFileChange, ProjectPurgePlan, ProjectRemote, ProjectRow, ProjectShow, ProjectSort, Task, UpgradeConfigField, UpgradeItem, UpgradeRoleDiff } from '../shared/types';
import { icon, menu, confirmAction, openSheet, field, toast, type Sheet } from './ui';
import { forgetRepoStates, wtState } from './wt';
import { SearchField, closeSortMenu, foundRow, hit, matches, openSortMenu, paintHeader, sortButton } from './search';

export interface ProjectsHost {
    // 看板里已有的任务，用来按仓库路径筛"最近任务"。
    tasks(): Task[];
    // 点最近任务：切到任务页并选中它（由 index.ts 负责）。
    openTask(id: string): void;
}

const marks = { run: ['run', 'loader-4-line'], done: ['ok', 'checkbox-circle-line'], fail: ['fail', 'close-circle-line'], stop: ['stale', 'stop-circle-line'] } as const;
const mark = (s: Task['status']) => `<span class="mk ${marks[s][0]}">${icon(marks[s][1])}</span>`;
const bmark = (kind: 'fail' | 'ok' | 'info' | 'brand') => `<span class="mk ${kind}">${icon(kind === 'fail' ? 'close-circle-line' : kind === 'ok' ? 'checkbox-circle-line' : 'information-line')}</span>`;
const errorLine = (text: string) => text ? `<div class="banner fail" role="alert">${bmark('fail')}<span>${esc(text)}</span></div>` : '';
const banner = (kind: 'fail' | 'ok' | 'info' | 'brand', title: string, text: string, button = '') => `<div class="banner ${kind}" role="${kind === 'fail' ? 'alert' : 'status'}">${bmark(kind)}<div class="rt"><b>${esc(title)}</b><span>${esc(text)}</span></div>${button}</div>`;
const failure = (e: unknown) => String((e as Error)?.message || e);
// 核心错误码（console 通道失败时随错误带出）：用来区分"没有提交身份"等需要专门指引的情况。
const errorCode = (e: unknown) => (e as Error & { code?: unknown })?.code;
const identityComplete = (s: ProjectShow | null) => !!(s?.git && s.identity?.name && s.identity?.email);
const identityText = (s: ProjectShow) => s.identity?.name && s.identity?.email ? `${s.identity.name} <${s.identity.email}>` : '';
const identityButton = (attr: string, disabled = false) => `<button class="btn sm" ${attr} ${disabled ? 'disabled' : ''}>${esc(pj.identitySet)}</button>`;
const clock = (n: number) => new Date(n).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
// 看板任务与项目记录里的路径可能一个用 / 一个用 \，Windows 不区分大小写。
const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
const text = (v: unknown) => typeof v === 'string' ? v : '';
const lines = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : text(v).trim() ? [text(v)] : [];
const splitLines = (v: string) => v.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const warnMark = `<span class="mk brand">${icon('error-warning-line')}</span>`;
const shortSha = (v: unknown) => typeof v === 'string' ? v.slice(0, 7) : '';

// 从别的页面（验收页推送失败提示上的"去项目页"）跳到项目页并选中某个项目：下一个项目页视图创建时取走（取一次就清掉）。
let pendingSelect = '';
export function selectProjectNext(path: string) { pendingSelect = path; }

// 编辑配置里的表单值（只提交改过的键）。
interface ConfigForm { baseBranch: string; setup: string[]; verify: string[]; allowedPaths: string[]; specsDir: string; pushRemote: string; pushAfterAccept: boolean; pushAllowLead: boolean; maxRetries: string; mergeMode: string; verifyTimeoutMin: string; worktree: boolean }
const ADV_KEYS = ['maxRetries', 'mergeMode', 'verifyTimeoutMin', 'worktree'] as const;
// 远程一节的操作：刷新（联网读取）、推送、拉取；失败时记下核心的 code 与中文原因。
type RemoteOp = 'refresh' | 'push' | 'pull';
interface RemoteFailure { op: RemoteOp; code: string; text: string }

// 设置提交身份模态框（项目页与新建任务页共用）：只写本机 git 配置，不涉及 GitHub 登录。
// 保存成功后关闭并调用 onSaved（由调用方刷新详情与横幅）；失败在模态框顶部显示核心给的原因。
export function openIdentitySheet({ path, trigger, identity, globalIdentity, onSaved, onClosed }: {
    path: string;
    trigger: HTMLElement;
    identity?: { name: string | null; email: string | null } | null;
    // 本机是否已有全局身份：明确为 false 时默认"本机所有项目（全局）"并加一句说明；其他情况默认"只用于这个项目"。
    globalIdentity?: boolean;
    onSaved?: () => void | Promise<void>;
    // 弹窗关闭之后（保存、取消、Esc 都算）调用一次；提交弹窗用它回到提交流程。
    onClosed?: () => void;
}) {
    const start = { name: text(identity?.name), email: text(identity?.email) };
    const startGlobal = globalIdentity === false;
    let global = startGlobal;
    const hint = (key: 'name' | 'email') => `<span class="fhint fail" data-id-error="${key}" role="alert"></span>`;
    const input = (key: 'name' | 'email', label: string, help: string, value: string) =>
        field(label, help, `<input class="inp" data-id-f="${key}" aria-label="${esc(label)}" value="${esc(value)}" autocomplete="off" spellcheck="false">${hint(key)}`, true);
    const scopeButton = (scope: 'repo' | 'global') => `<button data-id-scope="${scope}" class="${(scope === 'global') === startGlobal ? 'on' : ''}" aria-pressed="${(scope === 'global') === startGlobal}">${esc(pj.identityScopes[scope])}</button>`;
    const lead = startGlobal ? `<p class="sheet-lead" data-id-lead>${esc(pj.identityGlobalLead)}</p>` : '';
    const body = `<div class="form">${lead}${input('name', pj.identityName, '', start.name)}${input('email', pj.identityEmail, esc(pj.identityEmailHelp), start.email)}${field(pj.identityScope, '', `<div class="segm sm" data-id-seg="scope" role="group" aria-label="${esc(pj.identityScope)}">${scopeButton('repo')}${scopeButton('global')}</div>`)}</div>`;
    const value = (key: 'name' | 'email') => sheet.root.querySelector<HTMLInputElement>(`[data-id-f="${key}"]`)?.value.trim() ?? '';
    const setError = (key: 'name' | 'email', message: string) => {
        const el = sheet.root.querySelector<HTMLElement>(`[data-id-error="${key}"]`);
        if (el) el.textContent = message;
    };
    const setScope = (next: boolean) => {
        global = next;
        for (const b of sheet.root.querySelectorAll<HTMLButtonElement>('[data-id-scope]')) {
            const on = (b.dataset.idScope === 'global') === global;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
        }
        const note = sheet.root.querySelector<HTMLElement>('.sheet-f > .note');
        if (note) note.textContent = pj.identityNote(global);
    };
    const dirty = () => value('name') !== start.name || value('email') !== start.email || global !== startGlobal;
    const sheet: Sheet = openSheet({
        title: pj.identityEditTitle, trigger, body, note: pj.identityNote(startGlobal), buttons: [c.cancel, pj.identitySave],
        onButton: (index, s) => {
            if (index === 0) { s.close(); return; }
            const name = value('name'), email = value('email');
            // 与核心相同的校验；不合格时在对应字段下提示，不调用核心。
            const nameError = !name || name.length > 100 || /[\r\n]/.test(name) ? pj.identityNameRequired : '';
            const emailError = !email || email.length > 200 || !email.includes('@') || /\s/.test(email) ? pj.identityEmailInvalid : '';
            setError('name', nameError); setError('email', emailError);
            if (nameError) { s.root.querySelector<HTMLElement>('[data-id-f="name"]')?.focus(); return; }
            if (emailError) { s.root.querySelector<HTMLElement>('[data-id-f="email"]')?.focus(); return; }
            s.busy(true);
            void (async () => {
                try {
                    await window.dock.console('projects:git-identity', { path, name, email, global });
                    s.close();
                    await onSaved?.();
                }
                catch (e) { s.fail(failure(e)); s.busy(false); }
            })();
        },
        onClose: async () => {
            if (!dirty()) return;
            // 有改动时 Esc / 关闭先确认放弃（照编辑配置的做法）。
            const closeBtn = sheet.root.querySelector<HTMLElement>('.sheet-h .btn');
            return await confirmAction(ag.discardTitle, ag.discardBody, ag.discard, closeBtn ?? trigger, true) ? undefined : false;
        },
    });
    for (const b of sheet.root.querySelectorAll<HTMLButtonElement>('[data-id-scope]'))
        b.onclick = () => setScope(b.dataset.idScope === 'global');
    for (const el of sheet.root.querySelectorAll<HTMLInputElement>('[data-id-f]'))
        el.addEventListener('input', () => setError(el.dataset.idF as 'name' | 'email', ''));
    requestAnimationFrame(() => sheet.root.querySelector<HTMLInputElement>('[data-id-f="name"]')?.focus({ preventScroll: true }));
    if (onClosed) {
        // Sheet 没有"关闭之后"的回调：弹窗节点从页面上消失时调用一次。
        const watcher = new MutationObserver(() => {
            if (sheet.root.isConnected) return;
            watcher.disconnect();
            onClosed();
        });
        watcher.observe(document.body, { childList: true, subtree: true });
    }
    return sheet;
}

// 提交弹窗（项目页的"提交…"与验收页的"去提交"共用）：列出主工作区里未提交的文件，默认全选；
// 提交走 projects:commit（核心只 git add 勾选的具体文件）。缺提交身份时先关掉自己、打开提交身份弹窗，
// 弹窗关闭后带着已填的说明和勾选重新打开（draft）。读不到文件列表时抛出，由调用方显示原因。
export async function openCommitSheet(options: {
    path: string;
    trigger: HTMLElement;
    // 提交成功、或打开时已经没有未提交的文件之后调用（调用方刷新自己的状态）。
    onDone?: () => void | Promise<void>;
    draft?: { message: string; picked: Set<string> };
}): Promise<void> {
    const { path, trigger, onDone, draft } = options;
    const [listed, shown] = await Promise.all([window.dock.console('projects:changes', { path }), window.dock.console('projects:show', { path })]);
    const files: ProjectFileChange[] = Array.isArray(listed.files) ? listed.files : [];
    if (!files.length) { toast(pj.commitNothing); await onDone?.(); return; }
    const project = shown.project as ProjectShow;
    const picked = new Set(draft ? files.filter(f => draft.picked.has(f.path)).map(f => f.path) : files.map(f => f.path));
    const tone: Record<string, string> = { add: 'ok', update: 'info', delete: 'fail', rename: 'info' };
    const checkbox = (on: boolean | 'mixed') => `<span class="cb ${on ? 'on' : ''}">${on === 'mixed' ? icon('subtract-line') : on ? icon('check-line') : ''}</span>`;
    const row = (f: ProjectFileChange, i: number) => `<button class="fp-r" role="checkbox" aria-checked="${picked.has(f.path)}" data-cm-file="${i}">${checkbox(picked.has(f.path))}<span class="mono">${esc(f.path)}</span><span class="tag ${tone[f.kind] ?? 'info'}">${esc(pj.commitKinds[f.kind] ?? f.kind)}</span></button>`;
    const all = () => picked.size === files.length ? true : picked.size ? 'mixed' : false;
    const header = `<button class="fp-h" role="checkbox" aria-checked="${all()}" aria-label="${esc(pj.commitAll)}" data-cm-all>${checkbox(all())}<span data-cm-count>${esc(pj.commitPicked(picked.size, files.length))}</span></button>`;
    const body = `<div class="form"><div class="filepick" data-cm-list>${header}${files.map(row).join('')}</div>${field(pj.commitMessage, esc(pj.commitMessageHelp), `<input class="inp" data-cm-message aria-label="${esc(pj.commitMessage)}" placeholder="${esc(pj.commitMessagePh)}" value="${esc(draft?.message ?? '')}" autocomplete="off" spellcheck="false"><span class="fhint fail" data-cm-error role="alert"></span>`, true)}</div>`;
    const idNote = project.identity?.name && project.identity?.email ? pj.commitIdentity(project.identity.name, project.identity.email, project.globalIdentity === true) : '';
    let sheet: Sheet;
    const input = () => sheet.root.querySelector<HTMLInputElement>('[data-cm-message]')!;
    const primary = () => sheet.root.querySelector<HTMLButtonElement>('.sheet-btns button:last-of-type')!;
    // 勾选变化后只更新受影响的部分，不重画整个弹窗（说明输入框的内容与焦点不丢）。
    const sync = () => {
        const state = all();
        const head = sheet.root.querySelector<HTMLElement>('[data-cm-all]')!;
        head.setAttribute('aria-checked', String(state));
        head.querySelector('.cb')!.outerHTML = checkbox(state);
        sheet.root.querySelector('[data-cm-count]')!.textContent = pj.commitPicked(picked.size, files.length);
        sheet.root.querySelectorAll<HTMLElement>('[data-cm-file]').forEach(el => {
            const on = picked.has(files[Number(el.dataset.cmFile)].path);
            el.setAttribute('aria-checked', String(on));
            el.querySelector('.cb')!.outerHTML = checkbox(on);
        });
        primary().innerHTML = `${icon('git-commit-line')}${esc(pj.commitDo(picked.size))}`;
        primary().disabled = picked.size === 0;
        const note = sheet.root.querySelector<HTMLElement>('.sheet-f > .note');
        if (note) note.textContent = picked.size ? idNote : pj.commitNonePicked;
    };
    const failHint = (message: string) => { sheet.root.querySelector<HTMLElement>('[data-cm-error]')!.textContent = message; };
    const submit = async (s: Sheet) => {
        const message = input().value.trim();
        if (!picked.size) return;
        if (!message) { failHint(pj.commitMessageRequired); input().focus(); return; }
        const chosen = files.map(f => f.path).filter(p => picked.has(p));
        s.fail('');
        s.busy(true);
        try {
            const r = await window.dock.console('projects:commit', { path, message, files: chosen });
            s.close();
            toast(pj.commitDone(String(r.commit ?? ''), chosen.length));
            await onDone?.();
        }
        catch (e) {
            s.busy(false);
            sync();
            if (errorCode(e) === 'NEED_GIT_IDENTITY') {
                // 先补身份，再回到这个弹窗（已填的说明和勾选带回去）。
                const keep = { message: input().value, picked: new Set(picked) };
                s.close();
                openIdentitySheet({
                    path, trigger, identity: project.identity, globalIdentity: project.globalIdentity,
                    onClosed: () => { void openCommitSheet({ path, trigger, onDone, draft: keep }).catch(error => toast(pj.commitFailed + '：' + failure(error))); },
                });
                return;
            }
            s.fail(failure(e));
        }
    };
    sheet = openSheet({
        title: pj.commitTitle(files.length), trigger, body, note: esc(idNote), buttons: [c.cancel, pj.commitDo(picked.size)],
        onButton: (index, s) => { if (index === 0) { s.close(); return; } return submit(s); },
    });
    sheet.root.querySelector<HTMLElement>('[data-cm-list]')!.addEventListener('click', e => {
        const b = (e.target as Element).closest<HTMLElement>('button');
        if (!b) return;
        if (b.dataset.cmAll !== undefined) {
            if (picked.size === files.length) picked.clear(); else files.forEach(f => picked.add(f.path));
        }
        else if (b.dataset.cmFile !== undefined) {
            const p = files[Number(b.dataset.cmFile)].path;
            if (picked.has(p)) picked.delete(p); else picked.add(p);
        }
        else return;
        sync();
    });
    input().addEventListener('input', () => failHint(''));
    input().addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (!primary().disabled) primary().click(); } });
    sync();
    // 焦点：说明还没写时放在说明输入框（文件默认全选，直接写说明就能提交）。
    input().focus({ preventScroll: true });
}

export class ProjectsView {
    private rows: ProjectRow[] = [];
    private selected = '';
    private show: ProjectShow | null = null;
    // 核心报告的 git 版本（全局一份）；ok 为 false 时在已初始化项目的详情顶部显示"版本太旧"横幅。
    private git: GitVersionInfo | null = null;
    private loaded = false;
    private mode: 'view' | 'plan' | 'upgrade' | 'written' = 'view';
    private plan: ProjectChange[] = [];
    // 更新协作约定的预览：核心 --upgrade --dry-run 的计划项、软件版本；角色默认保留（replace 里才替换），配置新字段默认不勾（fields 里才写）。
    private upgrade: { items: UpgradeItem[]; version: string; replace: Set<string>; fields: Set<string>; open: Set<string> } = { items: [], version: '', replace: new Set(), fields: new Set(), open: new Set() };
    // 上一次写入是"更新协作约定"时记下备份个数（用来换"已写入"的标题）；普通初始化为 null。
    private writtenBackups: number | null = null;
    // 项目还没有任何提交时，初始化预览带回的已有文件；withExisting 是"一起放进第一个提交"的勾选（默认勾上）。
    private existing: string[] = [];
    private withExisting = true;
    private written: { path: string; action: string }[] = [];
    private expanded = new Set<number>();
    private busy = false;
    private refreshing = false;
    private again = false;
    private error = '';
    // 提交失败是因为没有 git 提交身份时，记下核心的说明，在"已写入"区显示带设置按钮的横幅。
    private identityError = '';
    private committed = '';
    private commitTimer: ReturnType<typeof setTimeout> | undefined;
    private container?: HTMLElement;
    // 搜索（项目名、路径）与排序；搜索框元素只建一次，标题栏重画时原样放回。
    private search = new SearchField(s6.projectSearch, () => this.render());
    private sort: ProjectSort = 'recent';
    // 每次刷新 / 选择自增；晚到的结果只应用到仍然对得上的那一次。
    private seq = 0;
    // 远程一节（Stage07b 132）：进行中的操作、最近一次失败、成功提示；最后推送时间只有 ar push --dry-run 才给，按项目路径记下。
    private remoteBusy: RemoteOp | '' = '';
    private remoteFail: RemoteFailure | null = null;
    private remoteNote = '';
    private remotePath = '';
    private lastPush = new Map<string, number | null>();
    // initial：打开项目页时要选中的项目（首次引导添加完项目后传入）。列表加载完就按它选中、取它的详情，加载多慢都不会丢。
    // 没传时取 selectProjectNext 留下的（验收页"去项目页"）。
    constructor(private host: ProjectsHost, initial = '') {
        this.selected = initial || pendingSelect;
        pendingSelect = '';
    }

    mount(container: HTMLElement) {
        this.container = container;
        container.onclick = e => {
            // 项目页自己处理点击，不让任务页根节点的 data-* 逻辑误判项目行。
            e.stopPropagation();
            void this.click(e).catch(error => { this.error = failure(error); this.render(); });
        };
        this.render();
        void this.refresh();
    }
    unmount() {
        this.container = undefined;
        this.seq++;
        if (this.commitTimer) clearTimeout(this.commitTimer);
        this.commitTimer = undefined;
        this.committed = '';
    }
    // 看板任务变了：最近任务区跟着重画（不重新拉项目列表）。
    tasksChanged() { this.render(); }

    // 搜索与排序后的项目：搜索项目名与路径（不区分大小写）；“最近使用”按项目最近一次派发的开始时间，没派过任务的排最后、按添加时间。
    private shown(): ProjectRow[] {
        const rows = this.rows.filter(p => matches(this.search.query, p.name, p.path));
        const tasks = this.host.tasks();
        const lastStart = (p: ProjectRow) => tasks.reduce((latest, t) => samePath(t.repo, p.path) ? Math.max(latest, t.started) : latest, 0);
        if (this.sort === 'name') return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
        if (this.sort === 'added') return rows.sort((a, b) => b.addedAt - a.addedAt);
        const starts = new Map(rows.map(p => [p.path, lastStart(p)]));
        return rows.sort((a, b) => (starts.get(b.path)! - starts.get(a.path)!) || b.addedAt - a.addedAt);
    }
    private frame() {
        if (!this.container) return;
        this.container.innerHTML = '<div class="page-h"></div><div class="split"><div class="edge"><div class="tlist scroll" data-pj-list></div></div><div class="detail pd" data-pj-detail></div></div>';
    }
    private render() {
        const container = this.container;
        if (!container?.isConnected) return;
        // 重建会丢焦点：记下焦点按钮的身份，重建后放回同一个。
        const focused = document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement : null;
        let identity = '';
        if (focused) for (const key of ['data-pj', 'data-pj-row', 'data-pj-init', 'data-pj-task']) {
            const value = focused.getAttribute(key);
            if (value !== null) { identity = `[${key}="${CSS.escape(value)}"]`; break; }
        }
        const listTop = container.querySelector<HTMLElement>('[data-pj-list]')?.scrollTop ?? 0;
        const detailTop = container.querySelector<HTMLElement>('[data-pj-detail] .scroll')?.scrollTop ?? 0;
        const head = `<h1>${esc(pj.title)}</h1><span class="lead">${esc(pj.lead)}</span><span class="sp"></span>${this.rows.length ? `<button class="btn" data-pj="add" ${this.busy ? 'disabled' : ''}>${icon('folder-add-line')}${esc(pj.add)}</button>` : ''}`;

        if (this.loaded && !this.rows.length) {
            // 空状态：页面只有标题行和一个主按钮。
            container.innerHTML = `<div class="page-h">${head}</div><div class="empty tall">${icon('folder-3-line')}<b>${esc(pj.empty)}</b><p>${esc(pj.emptyHelp)}</p><button class="btn primary sm" data-pj="add" ${this.busy ? 'disabled' : ''}>${icon('folder-add-line')}${esc(pj.addFirst)}</button></div>`;
        }
        else {
            if (!container.querySelector('[data-pj-list]')) this.frame();
            // 有项目时标题栏是：标题、搜索框、排序、添加（没有项目时只有标题、说明和添加，见上面的 head）。
            paintHeader(container.querySelector<HTMLElement>('.page-h')!, this.search, `<h1>${esc(pj.title)}</h1>`,
                `${sortButton('data-pj="sort"', s6.projectSorts[this.sort][0])}<span class="sp"></span><button class="btn" data-pj="add" ${this.busy ? 'disabled' : ''}>${icon('folder-add-line')}${esc(pj.add)}</button>`);
            const list = container.querySelector<HTMLElement>('[data-pj-list]')!;
            const query = this.search.query, shown = this.shown();
            const found = query ? foundRow(shown.length ? s6.projectFound(shown.length, query) : s6.projectNone(query), 'data-pj="search-clear"') : '';
            list.innerHTML = found + shown.map(p => {
                const tag = !p.exists ? `<span class="tag fail">${esc(pj.goneTag)}</span>`
                    : !p.git ? `<span class="tag">${esc(pj.notGit)}</span>`
                        : !p.initialized ? `<span class="tag brand">${esc(pj.notInit)}</span>`
                            : `<span class="mono">${esc(clock(p.lastUsed))}</span>`;
                return `<button class="trow prow ${this.selected === p.path ? 'on' : ''}" data-pj-row="${esc(p.path)}" aria-pressed="${this.selected === p.path}">${icon('folder-3-line')}<span class="tm"><b>${hit(p.name, query)}</b><span class="mono">${hit(p.path, query)}</span></span><span class="ts">${tag}</span></button>`;
            }).join('');
            this.detail();
            list.scrollTop = listTop;
            const scroll = container.querySelector<HTMLElement>('[data-pj-detail] .scroll');
            if (scroll) scroll.scrollTop = detailTop;
        }
        if (identity) container.querySelector<HTMLElement>(identity)?.focus({ preventScroll: true });
    }
    private detail() {
        const box = this.container?.querySelector<HTMLElement>('[data-pj-detail]');
        if (!box) return;
        const s = this.show;
        if (!this.selected || !s) {
            box.innerHTML = `<div class="empty">${icon('folder-3-line')}<b>${esc(pj.select)}</b></div>`;
            return;
        }
        // 文件夹已不存在：没有可打开的东西，只留 ⋯（从列表移除）。
        const more = `<button class="btn icon quiet" data-pj="more" data-tip="${esc(c.more)}" aria-label="${esc(c.more)}" aria-haspopup="menu" ${this.busy ? 'disabled' : ''}>${icon('more-2-fill')}</button>`;
        const acts = !s.exists ? `<span class="acts">${more}</span>` : `<span class="acts">${s.git ? `<button class="btn sm" data-pj="claude" ${this.busy ? 'disabled' : ''}>${icon('terminal-box-line')}${esc(pj.openClaude)}</button>` : ''}<button class="btn sm quiet" data-pj="folder" ${this.busy ? 'disabled' : ''}>${icon('folder-open-line')}${esc(pj.openFolder)}</button><button class="btn icon quiet" data-pj="more" data-tip="${esc(c.more)}" aria-label="${esc(c.more)}" aria-haspopup="menu" ${this.busy ? 'disabled' : ''}>${icon('more-2-fill')}</button></span>`;
        // 状态行：路径、分支、改动数，git 仓库再多一项提交身份（过长截断，悬停看全文）。
        const idText = s.git ? (identityText(s) || pj.identityMissing) : '';
        const ident = s.git ? `<span class="ident" data-pj-ident><span>${icon('account-circle-line')}${esc(pj.identityLabel)}</span><span class="mono" title="${esc(idText)}"${identityComplete(s) ? '' : ' data-pj-ident-missing'}>${esc(idText)}</span></span>` : '';
        const state = `<div class="dh-2"><span class="mono">${esc(s.path)}</span>${s.git ? `<span>${icon('git-branch-line')}<span class="mono">${esc(s.branch ?? 'main')}</span></span><span>${icon(s.dirty ? 'edit-line' : 'checkbox-circle-line')}${esc(s.dirty ? pj.dirty(s.dirty) : pj.clean)}${s.dirty ? `<button class="btn sm" data-pj="commit-files" ${this.busy ? 'disabled' : ''}>${icon('git-commit-line')}${esc(pj.commitOpen)}</button>` : ''}</span>${ident}` : ''}</div>`;
        const body = `${this.error ? errorLine(this.error) : ''}${s.configError ? errorLine(s.configError) : ''}${this.body()}`;
        box.innerHTML = `<div class="dh"><div class="dh-1"><h2>${esc(s.name)}</h2>${acts}</div>${state}</div><div class="dbody edge"><div class="scroll" tabindex="0"><div class="pj-body">${body}</div></div></div>`;
    }
    private body(): string {
        const s = this.show!;
        if (!s.exists) return banner('fail', pj.goneTitle, pj.goneHelp(s.path, this.repoTasks(s.path).length), `<button class="btn sm" data-pj="purge" ${this.busy ? 'disabled' : ''}>${esc(pj.purgeOpen)}</button>`) + this.recentSection(s);
        if (!s.git) return banner('info', pj.gitTitle, pj.gitHelp, `<button class="btn sm primary" data-pj="git-init" ${this.busy ? 'disabled' : ''}>${esc(pj.gitInit)}</button>`);
        // 没有提交身份时先提示设置；"已写入但提交失败"时由失败横幅承担同样的按钮，不重复显示。
        const needIdentity = !identityComplete(s) && !(this.mode === 'written' && this.identityError);
        const identityBanner = needIdentity ? banner('brand', pj.identityTitle, pj.identityHelp, identityButton('data-pj="identity"', this.busy)) : '';
        if (this.mode === 'plan') return identityBanner + this.planBody();
        if (this.mode === 'upgrade') return identityBanner + this.upgradeBody();
        if (this.mode === 'written') return identityBanner + this.writtenBody();
        if (!s.initialized) return identityBanner + banner('brand', pj.initTitle, pj.initHelp, `<button class="btn sm primary" data-pj="init" ${this.busy ? 'disabled' : ''}>${esc(pj.init)}</button>`);
        return identityBanner + this.initializedBody();
    }
    private initializedBody(): string {
        const s = this.show!, cfg = (s.config ?? {}) as Record<string, unknown>;
        const cell = (v: unknown) => {
            const items = lines(v);
            return items.length ? items.map(x => `<span class="mono">${esc(x)}</span>`).join('<span class="muted"> · </span>') : `<span class="muted">${esc(pj.unset)}</span>`;
        };
        const keys = ['baseBranch', 'setup', 'verify', 'allowedPaths', 'specsDir'] as const;
        const rows = keys.map(k => `<div class="r"><span class="k">${esc(pj.fields[k])}</span><span class="v">${cell(cfg[k])}</span></div>`).join('');
        // git 低于 2.40：只是提示，不禁用任何按钮（不用 worktree 的任务不受影响）。
        const oldGit = this.git?.ok === false ? banner('brand', pj.gitOldTitle(this.git.version ?? ''), pj.gitOldHelp) : '';
        return `${oldGit}${this.remoteSection(s)}<div class="sec-t">${esc(pj.config)} <span class="mono muted">${esc(pj.configFile)}</span><span class="sp"></span><button class="btn sm quiet" data-pj="upgrade" ${this.busy ? 'disabled' : ''}>${icon('refresh-line')}${esc(pj.upgradeOpen)}</button><button class="btn sm" data-pj="edit" ${this.busy ? 'disabled' : ''}>${icon('edit-line')}${esc(pj.edit)}</button></div><div class="rows">${rows}</div>${this.recentSection(s)}`;
    }
    private repoTasks(path: string) { return this.host.tasks().filter(t => samePath(t.repo, path)); }
    private recentSection(s: ProjectShow): string {
        const recent = this.repoTasks(s.path).sort((a, b) => b.started - a.started).slice(0, 3);
        const recentRows = recent.length
            ? recent.map(t => `<button class="r pj-task" data-pj-task="${esc(t.id)}">${mark(t.status)}<span class="v">${esc(t.title)}</span><span class="sp"></span><span class="mono muted">${esc(clock(t.started))}</span></button>`).join('')
            : `<div class="r"><span class="muted">${esc(pj.noRecent)}</span></div>`;
        return `<div class="sec-t">${esc(pj.recent)}</div><div class="rows">${recentRows}</div>`;
    }
    // 远程一节（项目配置之上）：先用 projects show 里已有的 remote 画（不联网），"刷新"才联网读取。只推主分支、普通推送；落后时只快进拉取；分叉时不给按钮。
    private remoteSection(s: ProjectShow): string {
        const r = s.remote;
        if (!r) return '';
        if (!r.exists) return `<div class="sec-t">${esc(pj.remoteSec)}</div><div class="rows remote" data-pj-remote="none"><div class="r">${bmark('info')}<span class="v">${esc(pj.remoteNone)}</span></div></div>`;
        const cfg = (s.config ?? {}) as Record<string, unknown>;
        const branch = text(cfg.baseBranch) || s.branch || 'main', remote = r.name;
        // 进行中的操作、失败和成功提示都属于 remotePath 这个项目；切到别的项目时不显示。
        const mine = samePath(this.remotePath, s.path);
        const busy = mine ? this.remoteBusy : '', failed = mine ? this.remoteFail : null, off = busy ? 'disabled' : '';
        const refresh = `<button class="btn sm quiet" data-pj="remote-refresh" ${off}>${busy === 'refresh' ? `<span class="mk run">${icon('loader-4-line')}</span>${esc(pj.remoteRefreshing)}` : `${icon('refresh-line')}${esc(pj.remoteRefresh)}`}</button>`;
        const last = this.lastPush.get(s.path);
        const since = last ? ` · ${pj.remoteLastPush(clock(last))}` : '';
        const pushLabel = busy === 'push' ? `<span class="mk run">${icon('loader-4-line')}</span>${esc(pj.pushing)}` : failed?.op === 'push' ? `${icon('refresh-line')}${esc(pj.pushRetry)}` : `${icon('upload-2-line')}${esc(pj.pushTo(remote))}`;
        const pushButton = `<button class="btn sm primary" data-pj="remote-push" ${off}>${pushLabel}</button>`;
        const pullButton = `<button class="btn sm" data-pj="remote-pull" ${off}>${busy === 'pull' ? `<span class="mk run">${icon('loader-4-line')}</span>${esc(pj.pulling)}` : `${icon('download-2-line')}${esc(pj.pull)}`}</button>`;
        const ahead = r.ahead ?? 0, behind = r.behind ?? 0;
        // 状态行：图标、说明、（右边）按钮。
        const [mark, line, button] =
            r.state === 'same' ? [bmark('ok'), pj.remoteSame(branch, remote) + since, ''] as const
                : r.state === 'ahead' ? [warnMark, pj.remoteAhead(branch, remote, ahead) + since, pushButton] as const
                    : r.state === 'noUpstream' ? [warnMark, pj.remoteNoUpstream(branch, remote), pushButton] as const
                        : r.state === 'behind' ? [bmark('info'), pj.remoteBehind(branch, remote, behind), pullButton] as const
                            : r.state === 'diverged' ? [bmark('fail'), pj.remoteDiverged(ahead, behind), ''] as const
                                : [bmark('info'), pj.remoteNotFetched, ''] as const;
        const rows = `<div class="rows remote" data-pj-remote="${esc(r.state ?? 'unknown')}"><div class="r"><span class="k mono">${esc(remote)}</span><span class="v"><span class="mono">${esc(r.url ?? '')}</span></span></div><div class="r">${mark}<span class="v">${esc(line)}</span><span class="sp"></span>${button}</div></div>`;
        return `<div class="sec-t">${esc(pj.remoteSec)}<span class="sp"></span>${refresh}</div>${rows}${r.state === 'diverged' ? this.divergedHow(s.path) : ''}${this.remoteNoticeHtml(failed, mine ? this.remoteNote : '', branch, remote)}`;
    }
    // 分叉时的做法（155 B8）：两条命令各带说明和"复制命令"，复制的是带项目路径的完整命令（在哪个目录里粘贴都行）。软件仍不替用户合并。
    private divergedHow(path: string): string {
        const row = (cmd: string, help: string) => {
            const full = `git -C "${path}" ${cmd.replace(/^git /, '')}`;
            return `<div class="r" data-pj-diverged-cmd><span class="v mono">${esc(cmd)}</span><span class="v muted">${esc(help)}</span><button class="btn sm" data-pj="remote-copy" data-pj-copy="${esc(full)}">${esc(pj.pushCopyCommand)}</button></div>`;
        };
        return `<div class="dv-how" data-pj-diverged><div class="r"><span class="v">${esc(pj.remoteDivergedHow)}</span></div>${row(pj.remoteDivergedRebase, pj.remoteDivergedRebaseHelp)}${row(pj.remoteDivergedMerge, pj.remoteDivergedMergeHelp)}</div>`;
    }
    // 成功提示与失败横幅（在远程一节下面）。
    private remoteNoticeHtml(f: RemoteFailure | null, note: string, branch: string, remote: string): string {
        if (f) {
            const noCredential = f.code === 'NO_CREDENTIAL';
            // 刷新失败没有专门的标题：用普通的失败行。
            if (f.op === 'refresh') return errorLine(noCredential ? pj.pushNoCredential : f.text);
            // GitHub 的邮箱隐私拒绝（GH007，155 W2）：console 通道把被拒的邮箱放在 text 里；右边按钮打开"设置 git 提交身份"。不改已有提交。
            if (f.op === 'push' && f.code === 'EMAIL_PRIVACY') return banner('fail', pj.pushFailedTitle, (f.text ? pj.pushEmailPrivacy(f.text) : pj.pushEmailPrivacyNoEmail), `<button class="btn sm" data-pj="identity" ${this.busy ? 'disabled' : ''}>${esc(pj.pushEmailPrivacyAction)}</button>`);
            const copy = noCredential ? `<button class="btn sm" data-pj="remote-copy" data-pj-copy="${esc(`git push ${remote} ${branch}`)}">${esc(pj.pushCopyCommand)}</button>` : '';
            return banner('fail', f.op === 'push' ? pj.pushFailedTitle : pj.pullFailedTitle, noCredential ? pj.pushNoCredential : pj.pushFailedHelp(f.text.replace(/[。.]+$/, '')), copy);
        }
        return note ? `<div class="banner ok" role="status" data-pj-remote-note>${bmark('ok')}<span>${esc(note)}</span></div>` : '';
    }
    private planBody(): string {
        if (!this.plan.length) return `<div class="sec-t">${esc(pj.planNone)}</div><div class="inline-f"><button class="btn" data-pj="plan-cancel">${esc(pj.cancel)}</button></div>`;
        const added = this.plan.filter(p => p.action === 'create').length, updated = this.plan.length - added;
        const rows = this.plan.map((p, i) => {
            const can = typeof p.preview === 'string' && p.preview.trim() !== '';
            const open = can && this.expanded.has(i);
            const label = `<span class="tag ${p.action === 'create' ? 'ok' : 'info'}">${esc(p.action === 'create' ? pj.kindAdd : pj.kindUpdate)}</span><code>${esc(p.path)}</code>`;
            const head = can
                ? `<button class="cmd" data-pj-init="${i}" aria-expanded="${open}">${icon('arrow-right-s-line')}${label}</button>`
                : `<div class="cmd"><span class="ri-sp"></span>${label}</div>`;
            return `<div class="prow-file">${head}${open ? `<pre class="out selectable" data-pj-preview="${i}">${esc(p.preview!)}</pre>` : ''}</div>`;
        }).join('');
        // 项目还没有任何提交：多一项"把已有的文件一起放进第一个提交"，默认勾上。
        const names = this.existing.slice(0, 3).join('、') + (this.existing.length > 3 ? '…' : '');
        const together = this.existing.length
            ? `<button class="choice" role="checkbox" aria-checked="${this.withExisting}" data-pj-existing><span class="cb ${this.withExisting ? 'on' : ''}">${this.withExisting ? icon('check-line') : ''}</span><span class="ct">${esc(pj.initWithExisting(this.existing.length, names))}<span>${esc(pj.initWithExistingHelp)}</span></span></button>`
            : '';
        return `<div class="sec-t">${esc(pj.planHelp(added, updated))}</div>${together}<div class="initlist">${rows}</div><div class="inline-f"><span class="note">${esc(pj.notWritten)}</span><button class="btn" data-pj="plan-cancel">${esc(pj.cancel)}</button><button class="btn primary" data-pj="apply" ${this.busy ? 'disabled' : ''}>${esc(pj.confirmWrite)}</button></div>`;
    }
    // 更新协作约定预览：要补上或更新的文件、角色文档（默认保留）、配置新字段（默认不勾）。
    private upgradeBody(): string {
        const u = this.upgrade;
        const files = u.items.filter((i): i is ProjectChange => i.action === 'create' || i.action === 'update');
        const roles = u.items.filter((i): i is UpgradeRoleDiff => i.action === 'roleDiff');
        const fields = u.items.filter((i): i is UpgradeConfigField => i.action === 'configField');
        if (!u.items.length) return `<div class="sec-t">${esc(pj.planNone)}</div><div class="inline-f"><button class="btn" data-pj="plan-cancel">${esc(pj.cancel)}</button></div>`;
        const roleOf = (path: string) => path.split('/').pop()!.replace(/\.md$/, '');
        const fileRows = files.map((p, i) => {
            const can = typeof p.preview === 'string' && p.preview.trim() !== '';
            const open = can && this.expanded.has(i);
            const label = `<span class="tag ${p.action === 'create' ? 'ok' : 'info'}">${esc(p.action === 'create' ? pj.kindAdd : pj.kindUpdate)}</span><code>${esc(p.path)}</code>`;
            const head = can
                ? `<button class="cmd" data-pj-init="${i}" aria-expanded="${open}">${icon('arrow-right-s-line')}${label}</button>`
                : `<div class="cmd"><span class="ri-sp"></span>${label}</div>`;
            return `<div class="prow-file">${head}${open ? `<pre class="out selectable" data-pj-preview="${i}">${esc(p.preview!)}</pre>` : ''}</div>`;
        }).join('');
        const roleRows = roles.map(r => {
            const role = roleOf(r.path), open = u.open.has(role), replace = u.replace.has(role);
            const diff = open ? `<div class="out selectable rolediff" data-pj-diff="${esc(role)}">${r.diff.map(l => `<div class="dl ${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}"><span class="no mono">${l.op === ' ' ? '' : l.op === '-' ? '−' : '+'}</span><span class="code mono">${esc(l.text)}</span></div>`).join('')}</div>` : '';
            return `<div class="prow-file"><div class="rolehead"><button class="cmd" data-pj-role-open="${esc(role)}" aria-expanded="${open}">${icon('arrow-right-s-line')}<span class="tag brand">${esc(pj.roleDiffTag)}</span><code>${esc(r.path)}</code><span class="muted">${esc(pj.roleLines(r.added, r.removed))}</span></button><span class="segm sm" role="radiogroup" aria-label="${esc(r.path)}"><button role="radio" aria-checked="${replace}" class="${replace ? 'on' : ''}" data-pj-role-set="${esc(role)}" data-pj-v="replace">${esc(pj.roleReplace)}</button><button role="radio" aria-checked="${!replace}" class="${replace ? '' : 'on'}" data-pj-role-set="${esc(role)}" data-pj-v="keep">${esc(pj.roleKeep)}</button></span></div>${diff}</div>`;
        }).join('');
        const fieldRows = fields.map(f => {
            const on = u.fields.has(f.key);
            return `<button class="choice" role="checkbox" aria-checked="${on}" data-pj-field="${esc(f.key)}"><span class="cb ${on ? 'on' : ''}">${on ? icon('check-line') : ''}</span><span class="ct"><span class="mono">${esc(`${JSON.stringify(f.key)}: ${JSON.stringify(f.value)}`)}</span><span>${esc(pj.upgradeFieldHelp[f.key] ?? '')}</span></span></button>`;
        }).join('');
        // 会写入的文件数：补上或更新的文件、要替换的角色文档、勾了字段时的 project.json、有备份时的 .gitignore（去重）。
        const replaced = roles.filter(r => u.replace.has(roleOf(r.path)));
        const paths = new Set([...files.map(f => f.path), ...replaced.map(r => r.path)]);
        if (u.fields.size) paths.add('.agent-router/project.json');
        if (replaced.length) paths.add('.gitignore');
        return `<div class="sec-t">${esc(pj.upgradeTitle(u.version))}</div>`
            + (files.length ? `<div class="sec-t">${esc(pj.upgradeFilesSec)}</div><div class="initlist">${fileRows}</div>` : '')
            + (roles.length ? `<div class="sec-t">${esc(pj.upgradeRolesSec)}</div><div class="initlist">${roleRows}</div>` : '')
            + (fields.length ? `<div class="sec-t">${esc(pj.upgradeFieldsSec)}</div>${fieldRows}` : '')
            + `<div class="inline-f"><span class="note">${esc(pj.upgradeNote(paths.size, replaced.length))}</span><button class="btn" data-pj="plan-cancel">${esc(pj.cancel)}</button><button class="btn primary" data-pj="upgrade-apply" ${this.busy ? 'disabled' : ''}>${esc(pj.confirmWrite)}</button></div>`;
    }
    private writtenBody(): string {
        const n = this.written.length;
        const rows = this.written.map(w => `<div class="r ${w.action}">${icon(w.action === 'create' ? 'add-line' : 'edit-line')}<span class="v mono">${esc(w.path)}</span></div>`).join('');
        const note = this.committed ? pj.committed(this.committed) : pj.commitNote(n);
        const button = this.committed ? '' : `<button class="btn primary" data-pj="commit" ${this.busy ? 'disabled' : ''}>${icon('git-commit-line')}${esc(pj.commit)}</button>`;
        // 提交失败且原因是缺少提交身份：显示核心的说明和"设置提交身份…"，补好后可以再点提交。
        const failed = this.identityError ? banner('fail', pj.identityTitle, this.identityError, identityButton('data-pj="identity"', this.busy)) : '';
        return `${failed}${banner('ok', this.writtenBackups === null ? pj.written(n) : pj.upgradeDone(n, this.writtenBackups), pj.writtenHelp)}<div class="rows">${rows}</div><div class="inline-f"><span class="note mono"${this.committed ? ` data-pj-committed="${esc(this.committed)}"` : ''}>${esc(note)}</span>${button}</div>`;
    }

    // 选中项目后单独取详情；列表刷新与详情读取分开，切换行不用重新拉整张列表。
    private async select(path: string) {
        if (this.selected === path) return;
        this.selected = path;
        this.show = null;
        this.mode = 'view';
        this.plan = [];
        this.written = [];
        this.expanded.clear();
        this.error = '';
        this.identityError = '';
        this.committed = '';
        if (this.commitTimer) clearTimeout(this.commitTimer);
        this.commitTimer = undefined;
        const seq = ++this.seq;
        this.render();
        await this.loadShow(path, seq);
    }
    private async loadShow(path: string, seq: number) {
        try {
            const r = await window.dock.console('projects:show', { path });
            if (seq === this.seq && this.selected === path) { this.show = r.project; this.git = r.git ?? null; this.error = ''; if (r.project?.remote?.exists) void this.loadLastPush(r.project.path); }
        }
        catch (e) { if (seq === this.seq && this.selected === path) this.error = failure(e); }
        finally { if (seq === this.seq) this.render(); }
    }
    private async refresh() {
        if (!this.container) return;
        if (this.refreshing) { this.again = true; return; }
        this.refreshing = true;
        const seq = ++this.seq;
        try {
            const list = await window.dock.console('projects:list');
            if (seq !== this.seq) return;
            this.rows = Array.isArray(list.projects) ? list.projects : [];
            // 先按原样匹配，再不区分大小写匹配（Windows 路径）；都没有才退回第一个项目。
            if (!this.rows.some(p => p.path === this.selected)) this.selected = this.rows.find(p => this.selected && p.path.toLowerCase() === this.selected.toLowerCase())?.path ?? this.rows[0]?.path ?? '';
            // 刷新时如果选中的仍是同一个项目，保留上一份详情，等新的 projects:show 返回再替换：
            // 这段时间里"编辑配置"、更多菜单、初始化、提交等依赖详情的入口照常用上一份数据执行，不会被静默丢掉。
            // 只有选中的项目变了（或它已不在列表里）才清空。
            if (!this.show || !this.selected || !samePath(this.show.path, this.selected)) this.show = null;
            if (this.selected) {
                const r = await window.dock.console('projects:show', { path: this.selected });
                if (seq !== this.seq) return;
                this.show = r.project;
                this.git = r.git ?? null;
                if (r.project?.remote?.exists) void this.loadLastPush(r.project.path);
            }
            else this.git = list.git ?? null;
            this.error = '';
        }
        catch (e) { if (seq === this.seq) this.error = failure(e); }
        finally {
            this.refreshing = false;
            if (seq === this.seq) { this.loaded = true; this.render(); }
            if (this.again) { this.again = false; void this.refresh(); }
        }
    }

    private async click(e: MouseEvent) {
        const b = (e.target as Element).closest<HTMLButtonElement>('button');
        if (!b || b.disabled || this.busy) return;
        const action = b.dataset.pj;
        if (action) {
            if (action === 'sort') this.pickSort(b);
            else if (action === 'search-clear') { this.search.set(''); this.search.focus(); }
            else if (action === 'add') void this.add();
            else if (action === 'claude') void this.shell('claude');
            else if (action === 'folder') void this.shell('folder');
            else if (action === 'more') this.more(b);
            else if (action === 'edit') this.editConfig(b);
            else if (action === 'purge') void this.purge(b);
            else if (action === 'git-init') void this.gitInit();
            else if (action === 'init') void this.startPlan();
            else if (action === 'plan-cancel') this.cancelPlan();
            else if (action === 'upgrade') void this.startUpgrade();
            else if (action === 'upgrade-apply') void this.applyUpgrade();
            else if (action === 'apply') void this.applyPlan();
            else if (action === 'commit') void this.commit();
            else if (action === 'commit-files') void this.openCommit(b);
            else if (action === 'identity') this.openIdentity(b);
            else if (action === 'remote-refresh') void this.remoteOp('refresh');
            else if (action === 'remote-push') void this.remoteOp('push');
            else if (action === 'remote-pull') void this.remoteOp('pull');
            else if (action === 'remote-copy') void this.copyText(b.dataset.pjCopy ?? '');
            return;
        }
        if (b.dataset.pjExisting !== undefined) { this.withExisting = !this.withExisting; this.render(); return; }
        if (b.dataset.pjRow !== undefined) { void this.select(b.dataset.pjRow); return; }
        if (b.dataset.pjInit !== undefined) {
            const i = Number(b.dataset.pjInit);
            if (this.expanded.has(i)) this.expanded.delete(i); else this.expanded.add(i);
            this.render();
            return;
        }
        const u = this.upgrade;
        if (b.dataset.pjRoleOpen) {
            const role = b.dataset.pjRoleOpen;
            if (u.open.has(role)) u.open.delete(role); else u.open.add(role);
            this.render();
            return;
        }
        if (b.dataset.pjRoleSet) {
            if (b.dataset.pjV === 'replace') u.replace.add(b.dataset.pjRoleSet); else u.replace.delete(b.dataset.pjRoleSet);
            this.render();
            return;
        }
        if (b.dataset.pjField) {
            const key = b.dataset.pjField;
            if (u.fields.has(key)) u.fields.delete(key); else u.fields.add(key);
            this.render();
            return;
        }
        if (b.dataset.pjTask) this.host.openTask(b.dataset.pjTask);
    }

    private pickSort(anchor: HTMLElement) {
        if (closeSortMenu()) return;
        openSortMenu(anchor, '[data-pj=sort]', (['recent', 'name', 'added'] as const).map(key => [key, s6.projectSorts[key][0], s6.projectSorts[key][1]] as [string, string, string]), this.sort, key => {
            this.sort = key as ProjectSort;
            this.render();
        });
    }
    // 添加项目：先选文件夹（验收时由桩返回队列里的路径），再登记；成功后刷新并选中它。
    private async add() {
        this.busy = true; this.error = ''; this.render();
        try {
            const path = await window.dock.console('projects:choose');
            if (typeof path === 'string' && path) {
                await window.dock.console('projects:add', { path });
                forgetRepoStates();
                this.selected = path;
            }
            this.busy = false;
            await this.refresh();
        }
        catch (e) { this.busy = false; this.error = failure(e); this.render(); }
    }
    private async shell(which: 'claude' | 'folder') {
        const s = this.show;
        if (!s) return;
        this.busy = true; this.error = ''; this.render();
        try { await window.dock.console(which === 'claude' ? 'shell:open-claude' : 'shell:open-folder', { path: s.path }); }
        catch (e) { this.error = failure(e); }
        finally { this.busy = false; this.render(); }
    }
    private more(anchor: HTMLElement) {
        menu(anchor, [
            ...(this.show?.exists === false ? [] : [{ label: pj.menu.edit, run: () => this.editConfig(anchor) }]),
            { label: pj.menu.remove, run: () => { void this.remove(anchor); } },
        ]);
    }
    private async remove(trigger: HTMLElement) {
        const s = this.show;
        if (!s) return;
        // 还有没处理完的任务（待验收、合并冲突、进行中）时在说明下面列出名字（最多 5 个）：只提醒，仍然允许移除。
        const pending = this.host.tasks().filter(t => samePath(t.repo, s.path) && (t.status === 'run' || wtState(t) === 'awaiting' || wtState(t) === 'conflict'));
        const names = pending.slice(0, 5).map(t => `· ${t.title}`);
        const more = pending.length > 5 ? [pj.removePendingMore(pending.length)] : [];
        const body = pending.length ? [pj.removeBody, '', pj.removePending(pending.length), ...names, ...more, '', pj.removePendingHelp].join('\n') : pj.removeBody;
        if (!await confirmAction(pj.removeTitle(s.name), body, pj.removeConfirm, trigger, true)) return;
        this.busy = true; this.error = ''; this.render();
        try {
            await window.dock.console('projects:remove', { path: s.path });
            forgetRepoStates();
            this.selected = ''; this.show = null; this.mode = 'view';
            this.busy = false;
            await this.refresh();
        }
        catch (e) { this.busy = false; this.error = failure(e); this.render(); }
    }
    // 彻底清理已删除的项目：先问核心有哪些残留（不改任何东西），再弹确认框；确认后清核心的记录，再把它的已结束任务从任务列表隐藏。
    private async purge(trigger: HTMLElement) {
        const s = this.show;
        if (!s || s.exists) return;
        const { path, name } = s;
        this.busy = true; this.error = ''; this.render();
        let plan: ProjectPurgePlan;
        try { plan = await window.dock.console('projects:purge-plan', { path }) as ProjectPurgePlan; }
        catch (e) { this.busy = false; this.error = failure(e); this.render(); return; }
        this.busy = false; this.render();
        const finished = this.repoTasks(path).filter(t => t.status !== 'run');
        const leftovers = plan.worktrees.length + plan.slots.length;
        const sizeText = (bytes: number) => { const kb = bytes / 1024; return kb < 1024 ? `${kb.toFixed(1)} KB` : kb < 1024 * 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${(kb / 1024 / 1024).toFixed(1)} GB`; };
        // 勾选项和编辑配置里的是同一种控件；"从项目列表移除"必选，不能取消（aria-readonly）。
        const choice = (key: string, label: string, help: string, locked = false) => `<button class="choice" role="checkbox" aria-checked="true" ${locked ? 'aria-readonly="true"' : ''} data-pj-purge="${key}"><span class="cb on">${icon('check-line')}</span><span class="ct">${esc(label)}${help ? `<span>${esc(help)}</span>` : ''}</span></button>`;
        const body = `<p class="sheet-lead">${esc(pj.purgeLead)}</p><div class="form">${choice('list', pj.purgeList, '', true)}${choice('tasks', pj.purgeTasks(finished.length), pj.purgeTasksHelp)}${choice('worktrees', pj.purgeWorktrees(leftovers, sizeText(plan.bytes)), pj.purgeWorktreesHelp)}</div>`;
        const on = (sheet: Sheet, key: string) => sheet.root.querySelector(`[data-pj-purge="${key}"]`)?.getAttribute('aria-checked') === 'true';
        const sheet: Sheet = openSheet({
            title: pj.purgeTitle(name), trigger, body, note: pj.purgeNote, buttons: [c.cancel, pj.purgeConfirm],
            onButton: (index, sh) => {
                if (index === 0) { sh.close(); return; }
                const tasks = on(sh, 'tasks'), worktrees = on(sh, 'worktrees');
                sh.busy(true);
                sh.fail('');
                void (async () => {
                    try {
                        await window.dock.console('projects:purge', { path, worktrees });
                        // 任务列表的隐藏走主进程现有的 delete-tasks（只隐藏，不删文件：记录目录随文件夹一起已经不在了）。
                        if (tasks && finished.length) await window.dock.deleteTasks(finished.map(t => t.id), false).catch(() => undefined);
                        forgetRepoStates();
                        sh.close();
                        this.selected = ''; this.show = null; this.mode = 'view';
                        toast(pj.purged(name));
                        await this.refresh();
                    }
                    catch (e) { sh.fail(failure(e)); sh.busy(false); }
                })();
            },
        });
        // 底栏最后一个按钮默认是主按钮：彻底清理换成危险样式；默认焦点在取消。
        const buttons = sheet.root.querySelectorAll<HTMLButtonElement>('.sheet-btns button');
        buttons[1]?.classList.remove('primary');
        buttons[1]?.classList.add('danger');
        buttons[0]?.focus({ preventScroll: true });
        for (const box of sheet.root.querySelectorAll<HTMLButtonElement>('[data-pj-purge]')) box.addEventListener('click', () => {
            if (box.getAttribute('aria-readonly') === 'true') return;
            const next = box.getAttribute('aria-checked') !== 'true';
            box.setAttribute('aria-checked', String(next));
            const cb = box.querySelector('.cb')!;
            cb.classList.toggle('on', next);
            cb.innerHTML = next ? icon('check-line') : '';
        });
    }
    private async gitInit() {
        const s = this.show;
        if (!s) return;
        this.busy = true; this.error = ''; this.render();
        try {
            await window.dock.console('projects:git-init', { path: s.path });
            this.mode = 'view';
            this.busy = false;
            await this.refresh();
        }
        catch (e) { this.busy = false; this.error = failure(e); this.render(); }
    }
    private async startPlan() {
        const s = this.show;
        if (!s) return;
        this.busy = true; this.error = ''; this.render();
        try {
            const r = await window.dock.console('projects:init-plan', { path: s.path });
            this.plan = Array.isArray(r.changes) ? r.changes : [];
            this.existing = Array.isArray(r.existingFiles) ? r.existingFiles.filter((f: unknown): f is string => typeof f === 'string') : [];
            this.withExisting = true;
            this.expanded.clear();
            this.mode = 'plan';
        }
        catch (e) { this.error = failure(e); }
        finally { this.busy = false; this.render(); }
    }
    private cancelPlan() {
        this.mode = 'view'; this.plan = []; this.existing = []; this.expanded.clear(); this.error = '';
        this.upgrade = { items: [], version: '', replace: new Set(), fields: new Set(), open: new Set() };
        this.render();
    }
    private async startUpgrade() {
        const s = this.show;
        if (!s) return;
        this.busy = true; this.error = ''; this.render();
        try {
            const [r, snap] = await Promise.all([window.dock.console('projects:upgrade-plan', { path: s.path }), window.dock.snapshot()]);
            this.upgrade = { items: Array.isArray(r.changes) ? r.changes : [], version: String(snap?.version ?? ''), replace: new Set(), fields: new Set(), open: new Set() };
            this.expanded.clear();
            this.mode = 'upgrade';
        }
        catch (e) { this.error = failure(e); }
        finally { this.busy = false; this.render(); }
    }
    private async applyUpgrade() {
        const s = this.show;
        if (!s) return;
        this.busy = true; this.error = ''; this.render();
        try {
            const r = await window.dock.console('projects:upgrade-apply', { path: s.path, replaceRoles: [...this.upgrade.replace], addFields: [...this.upgrade.fields] });
            this.written = Array.isArray(r.changes) ? r.changes : [];
            this.writtenBackups = Array.isArray(r.backups) ? r.backups.length : 0;
            this.mode = 'written';
            this.busy = false;
            await this.refresh();
        }
        catch (e) { this.busy = false; this.error = failure(e); this.render(); }
    }
    private async applyPlan() {
        const s = this.show;
        if (!s) return;
        this.busy = true; this.error = ''; this.render();
        try {
            const r = await window.dock.console('projects:init-apply', { path: s.path });
            this.written = Array.isArray(r.changes) ? r.changes : [];
            this.writtenBackups = null;
            this.mode = 'written';
            this.busy = false;
            await this.refresh();
        }
        catch (e) { this.busy = false; this.error = failure(e); this.render(); }
    }
    private async commit() {
        const s = this.show;
        if (!s) return;
        this.busy = true; this.error = ''; this.identityError = ''; this.render();
        try {
            const r = await window.dock.console('projects:commit-init', { path: s.path, ...(this.existing.length ? { withExisting: this.withExisting } : {}) });
            this.committed = String(r.commit ?? '');
        }
        catch (e) {
            // 没有提交身份时用核心的说明与设置按钮，不显示 git 的原始英文报错。
            if (errorCode(e) === 'NEED_GIT_IDENTITY') this.identityError = failure(e);
            else this.error = failure(e);
        }
        finally { this.busy = false; this.render(); }
        if (this.committed) {
            if (this.commitTimer) clearTimeout(this.commitTimer);
            this.commitTimer = setTimeout(() => {
                this.commitTimer = undefined;
                this.committed = '';
                this.mode = 'view';
                this.written = [];
                void this.refresh();
            }, 2000);
        }
    }

    // 把 ar push --dry-run 的结果合进当前详情的 remote（刷新、推送、拉取之后领先 / 落后马上显示，不用再读一次 projects show），并记下最后推送时间。
    private applyRemote(path: string, r: ProjectRemote) {
        this.lastPush.set(path, typeof r.lastPush === 'number' ? r.lastPush : null);
        if (this.show && samePath(this.show.path, path) && this.show.remote?.exists) {
            const { url, ahead, behind, state } = r;
            this.show = { ...this.show, remote: { ...this.show.remote, name: r.remote ?? this.show.remote.name, url, ahead, behind, state } };
        }
    }
    // 打开详情后在后台问一次最后推送时间：--no-fetch 不联网，只读本地已有的远程跟踪分支与 push.jsonl。读不到就没有这一项。
    private async loadLastPush(path: string) {
        if (this.lastPush.has(path)) return;
        this.lastPush.set(path, null);
        try {
            const r = await window.dock.console('projects:remote', { path, fetch: false }) as ProjectRemote;
            // 结果晚到时只在有变化时才重画：没有推送记录、状态也和详情里一样就不动界面（截图与点击都不会被一次多余的重画打断）。
            const before = JSON.stringify([this.lastPush.get(path), this.show?.remote]);
            this.applyRemote(path, r);
            if (JSON.stringify([this.lastPush.get(path), this.show?.remote]) !== before) this.render();
        }
        catch { /* 读不到就不显示最后推送时间。 */ }
    }
    // 刷新（联网读取）、推送、拉取。进行中按钮禁用并换文字；成功换成一行提示并刷新状态；失败在这一节下面显示横幅（核心的 code 决定正文）。
    private async remoteOp(op: RemoteOp) {
        const s = this.show;
        if (!s || this.remoteBusy) return;
        const path = s.path, remote = s.remote?.name ?? '', behindBefore = s.remote?.behind ?? 0;
        this.remoteBusy = op; this.remotePath = path; this.remoteFail = null; this.remoteNote = '';
        this.render();
        try {
            if (op === 'refresh') this.applyRemote(path, await window.dock.console('projects:remote', { path }) as ProjectRemote);
            else if (op === 'push') {
                const r = await window.dock.console('projects:push', { path }) as { pushed?: boolean; from?: string | null; to?: string };
                this.remoteNote = r.pushed === false ? pj.pushNothing(remote) : pj.pushed(remote, r.from ? `${shortSha(r.from)}..${shortSha(r.to)}` : shortSha(r.to));
            }
            else {
                const r = await window.dock.console('projects:pull', { path }) as { pulled?: boolean };
                this.remoteNote = r.pulled === false ? pj.pullNothing : pj.pulled(behindBefore);
            }
        }
        catch (e) { this.remoteFail = { op, code: String(errorCode(e) ?? ''), text: failure(e) }; }
        // 推送 / 拉取之后（成败都一样：失败时也可能刚取到了远程的新提交）重读本地状态，不联网。
        if (op !== 'refresh') {
            try { this.applyRemote(path, await window.dock.console('projects:remote', { path, fetch: false }) as ProjectRemote); }
            catch { /* 读不到就保留原来的状态。 */ }
        }
        this.remoteBusy = '';
        this.render();
    }
    // 复制文字：项目页没有自己的剪贴板通道，借用任意一个任务的 copy-text（和验收页同一条路，验收时是桩）；一个任务都没有时用浏览器的剪贴板。
    // TODO(lead): 想要项目页自己的复制通道需要改 app/src/main/index.ts（不在 132 的允许清单里）。
    private async copyText(value: string) {
        if (!value) return;
        try {
            const id = this.host.tasks()[0]?.id;
            if (id) await window.dock.action(id, 'copy-text', value);
            else await navigator.clipboard.writeText(value);
        }
        catch (e) { this.error = failure(e); this.render(); }
    }

    // 设置提交身份：保存后刷新详情（横幅与状态行随之更新），"已写入"状态保留，可以再点提交。
    private openIdentity(trigger: HTMLElement) {
        const s = this.show;
        if (!s) return;
        openIdentitySheet({
            path: s.path, trigger, identity: s.identity, globalIdentity: s.globalIdentity,
            onSaved: async () => { this.identityError = ''; await this.refresh(); },
        });
    }
    // 状态行的"提交…"：打开提交弹窗；提交成功后刷新详情（未提交数、状态行随之更新）。
    private async openCommit(trigger: HTMLElement) {
        const s = this.show;
        if (!s) return;
        this.busy = true; this.error = ''; this.render();
        try { await openCommitSheet({ path: s.path, trigger, onDone: () => this.refresh() }); }
        catch (e) { this.error = failure(e); }
        finally { this.busy = false; this.render(); }
    }

    // 编辑配置：只提交改过的键；数组按行拆、去空行与首尾空白。保存失败时模态框保持打开并显示原因。
    private editConfig(trigger: HTMLElement) {
        const s = this.show;
        if (!s) return;
        const projectPath = s.path;
        const cfg = (s.config ?? {}) as Record<string, unknown>;
        const push = (cfg.push && typeof cfg.push === 'object' && !Array.isArray(cfg.push) ? cfg.push : {}) as Record<string, unknown>;
        const original: ConfigForm = { baseBranch: text(cfg.baseBranch), setup: lines(cfg.setup), verify: lines(cfg.verify), allowedPaths: lines(cfg.allowedPaths), specsDir: text(cfg.specsDir), pushRemote: text(push.remote), pushAfterAccept: push.afterAccept === true, pushAllowLead: push.allowLead === true,
            maxRetries: typeof cfg.maxRetries === 'number' ? String(cfg.maxRetries) : '', mergeMode: cfg.mergeMode === 'squash' ? 'squash' : 'no-ff',
            verifyTimeoutMin: typeof cfg.verifyTimeoutMin === 'number' ? String(cfg.verifyTimeoutMin) : '', worktree: cfg.worktree !== false };
        const input =(key: string, value: string, placeholder = '') => `<input class="inp mono" data-pj-f="${key}" value="${esc(value)}"${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}>`;
        const area = (key: string, value: string[], rows: number) => `<textarea class="inp area mono" data-pj-f="${key}" rows="${rows}">${esc(value.join('\n'))}</textarea>`;
        // 勾选项：和驳回弹窗的"保留分支"同一种控件（role=checkbox 的 .choice）。
        const choice = (key: string, on: boolean, label: string, help: string) => `<button class="choice" role="checkbox" aria-checked="${on}" data-pj-c="${key}"><span class="cb ${on ? 'on' : ''}">${on ? icon('check-line') : ''}</span><span class="ct">${esc(label)}<span>${esc(help)}</span></span></button>`;
        // 推送三项：远程名用输入框（核心的 projects show 只给配置的那一个远程，没有 git remote 的列表，做不了下拉），留空 = 默认 origin。
        const pushFields = `<div class="sec-t">${esc(pj.pushSec)}</div>${field(pj.pushRemote, esc(pj.pushRemoteHelp), input('push.remote', original.pushRemote, 'origin'))}${field('', '', choice('afterAccept', original.pushAfterAccept, pj.pushAfterAccept, pj.pushAfterAcceptHelp))}${field('', '', choice('allowLead', original.pushAllowLead, pj.pushAllowLead, pj.pushAllowLeadHelp))}`;
        // 高级四项：默认折叠；项目配置里已有其中任何一个键时默认展开。mergeMode / worktree 没写时界面显示默认（no-ff / 开），不算改动。
        const numInput = (key: string, v: string, def: string) => `<input class="inp mono" type="number" data-pj-f="${key}" value="${esc(v)}" placeholder="${esc(pj.advDefault(def))}"><span class="fhint fail" data-pj-err="${key}" role="alert"></span>`;
        // TODO(lead): 核心模板的 project.json 默认就带 "worktree": true，按"有键就展开"新项目永远是展开的；这里只在值偏离默认时展开（重试 / 超时有值、squash、worktree 关）。
        const advOpen = original.maxRetries !== '' || original.verifyTimeoutMin !== '' || original.mergeMode !== 'no-ff' || original.worktree === false;
        const advHelp = (key: string) => esc(pj.advHelp[key]);
        const mergeSeg = `<div class="segm" role="group" aria-label="${esc(pj.advFields.mergeMode)}">${Object.keys(pj.mergeModes).map(m => `<button type="button" data-pj-merge="${m}" class="${original.mergeMode === m ? 'on' : ''}" aria-pressed="${original.mergeMode === m}">${esc(pj.mergeModes[m])}</button>`).join('')}</div><span class="fhint fail" data-pj-err="mergeMode" role="alert"></span>`;
        const wtToggle = `<button type="button" class="toggle ${original.worktree ? 'on' : ''}" data-pj-wt role="switch" aria-checked="${original.worktree}" aria-label="${esc(pj.advFields.worktree)}"></button><span class="fhint fail" data-pj-err="worktree" role="alert"></span>`;
        const advanced = `<button type="button" class="fold" data-pj-fold aria-expanded="${advOpen}"><span data-pj-fold-i>${icon(advOpen ? 'arrow-down-s-line' : 'arrow-right-s-line')}</span>${esc(pj.advanced)}</button><div data-pj-adv${advOpen ? '' : ' hidden'}>${field(pj.advFields.maxRetries, advHelp('maxRetries'), numInput('maxRetries', original.maxRetries, '2'))}${field(pj.advFields.mergeMode, advHelp('mergeMode'), mergeSeg)}${field(pj.advFields.verifyTimeoutMin, advHelp('verifyTimeoutMin'), numInput('verifyTimeoutMin', original.verifyTimeoutMin, '10'))}${field(pj.advFields.worktree, advHelp('worktree'), wtToggle)}</div>`;
        const body = `<div class="form">${field(pj.fields.baseBranch, pj.fieldHelp.baseBranch, input('baseBranch', original.baseBranch))}${field(pj.fields.setup, pj.fieldHelp.setup, area('setup', original.setup, 2))}${field(pj.fields.verify, pj.fieldHelp.verify, area('verify', original.verify, 2))}${field(pj.fields.allowedPaths, pj.fieldHelp.allowedPaths, area('allowedPaths', original.allowedPaths, 3))}${field(pj.fields.specsDir, pj.fieldHelp.specsDir, input('specsDir', original.specsDir))}${pushFields}${advanced}</div>`;
        const value =(key: string) => (sheet.root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-pj-f="${key}"]`)?.value ?? '');
        const checked = (key: string) => sheet.root.querySelector(`[data-pj-c="${key}"]`)?.getAttribute('aria-checked') === 'true';
        const current = (): ConfigForm => ({ baseBranch: value('baseBranch').trim(), setup: splitLines(value('setup')), verify: splitLines(value('verify')), allowedPaths: splitLines(value('allowedPaths')), specsDir: value('specsDir').trim(), pushRemote: value('push.remote').trim(), pushAfterAccept: checked('afterAccept'), pushAllowLead: checked('allowLead'),
            maxRetries: value('maxRetries').trim(), mergeMode: sheet.root.querySelector('[data-pj-merge].on')?.getAttribute('data-pj-merge') ?? original.mergeMode,
            verifyTimeoutMin: value('verifyTimeoutMin').trim(), worktree: sheet.root.querySelector('[data-pj-wt]')?.getAttribute('aria-checked') === 'true' });
        const dirty = () => {
            const now = current();
            return now.baseBranch !== original.baseBranch || now.specsDir !== original.specsDir || !sameLines(now.setup, original.setup) || !sameLines(now.verify, original.verify) || !sameLines(now.allowedPaths, original.allowedPaths)
                || now.pushRemote !== original.pushRemote || now.pushAfterAccept !== original.pushAfterAccept || now.pushAllowLead !== original.pushAllowLead
                || ADV_KEYS.some(k => now[k] !== original[k]);
        };
        const sheet: Sheet = openSheet({
            title: pj.editTitle, trigger, body, note: pj.editNote, buttons: [c.cancel, pj.save], wide: true,
            onButton: (index, s) => {
                if (index === 0) { s.close(); return; }
                void this.saveConfig(s, projectPath, current, original);
            },
            onClose: async () => {
                if (!dirty()) return;
                const closeBtn = sheet.root.querySelector<HTMLElement>('.sheet-h .btn');
                return await confirmAction(ag.discardTitle, ag.discardBody, ag.discard, closeBtn ?? trigger, true) ? undefined : false;
            },
        });
        for (const box of sheet.root.querySelectorAll<HTMLButtonElement>('[data-pj-c]')) box.addEventListener('click', () => {
            const on = box.getAttribute('aria-checked') !== 'true';
            box.setAttribute('aria-checked', String(on));
            const cb = box.querySelector('.cb')!;
            cb.classList.toggle('on', on);
            cb.innerHTML = on ? icon('check-line') : '';
        });
        const fold = sheet.root.querySelector<HTMLButtonElement>('[data-pj-fold]')!;
        fold.addEventListener('click', () => {
            const open = fold.getAttribute('aria-expanded') !== 'true';
            fold.setAttribute('aria-expanded', String(open));
            fold.querySelector('[data-pj-fold-i]')!.innerHTML = icon(open ? 'arrow-down-s-line' : 'arrow-right-s-line');
            sheet.root.querySelector<HTMLElement>('[data-pj-adv]')!.hidden = !open;
        });
        for (const b of sheet.root.querySelectorAll<HTMLButtonElement>('[data-pj-merge]')) b.addEventListener('click', () => {
            for (const o of sheet.root.querySelectorAll<HTMLButtonElement>('[data-pj-merge]')) { o.classList.toggle('on', o === b); o.setAttribute('aria-pressed', String(o === b)); }
        });
        const wt = sheet.root.querySelector<HTMLButtonElement>('[data-pj-wt]')!;
        wt.addEventListener('click', () => {
            const on = wt.getAttribute('aria-checked') !== 'true';
            wt.setAttribute('aria-checked', String(on));
            wt.classList.toggle('on', on);
        });
    }
    private async saveConfig(sheet: Sheet, path: string, current: () => ConfigForm, original: ConfigForm) {
        const now = current();
        const set: Record<string, unknown> = {};
        if (now.baseBranch !== original.baseBranch) set.baseBranch = now.baseBranch;
        if (now.specsDir !== original.specsDir) set.specsDir = now.specsDir;
        if (!sameLines(now.setup, original.setup)) set.setup = now.setup;
        if (!sameLines(now.verify, original.verify)) set.verify = now.verify;
        if (!sameLines(now.allowedPaths, original.allowedPaths)) set.allowedPaths = now.allowedPaths;
        // 推送三项：空 / 取消勾选 = null，核心删掉这个键，回到默认（origin / 不推送 / 不允许）。
        if (now.pushRemote !== original.pushRemote) set['push.remote'] = now.pushRemote || null;
        if (now.pushAfterAccept !== original.pushAfterAccept) set['push.afterAccept'] = now.pushAfterAccept || null;
        if (now.pushAllowLead !== original.pushAllowLead) set['push.allowLead'] = now.pushAllowLead || null;
        // 高级四项：没动过的不出现；数字清空 = null（核心删掉这个键，回到默认）。
        if (now.maxRetries !== original.maxRetries) set.maxRetries = now.maxRetries === '' ? null : Number(now.maxRetries);
        if (now.mergeMode !== original.mergeMode) set.mergeMode = now.mergeMode;
        if (now.verifyTimeoutMin !== original.verifyTimeoutMin) set.verifyTimeoutMin = now.verifyTimeoutMin === '' ? null : Number(now.verifyTimeoutMin);
        if (now.worktree !== original.worktree) set.worktree = now.worktree;
        if (!Object.keys(set).length) { sheet.close(); return; }
        sheet.busy(true);
        for (const el of sheet.root.querySelectorAll('[data-pj-err]')) el.textContent = '';
        try {
            await window.dock.console('projects:config', { path, set });
            // 刷新返回之前，把刚保存的键合进本地详情：这段时间"编辑配置"用上一份数据打开时看到的就是刚保存的值。
            if (this.show && samePath(this.show.path, path)) {
                const config = { ...(this.show.config ?? {}) } as Record<string, unknown>;
                for (const [key, v] of Object.entries(set)) {
                    if (!key.startsWith('push.')) { if (v === null) delete config[key]; else config[key] = v; continue; }
                    const pushed = { ...((config.push && typeof config.push === 'object' ? config.push : {}) as Record<string, unknown>) };
                    if (v === null) delete pushed[key.slice(5)]; else pushed[key.slice(5)] = v;
                    if (Object.keys(pushed).length) config.push = pushed; else delete config.push;
                }
                this.show = { ...this.show, config };
            }
            sheet.close();
            await this.refresh();
        }
        catch (e) {
            // 核心的原因以键名开头：高级四项的原因显示在对应字段下面（并展开"高级"），其余仍在模态框顶部。
            const reason = failure(e);
            const key = ADV_KEYS.find(k => reason.startsWith(`${k} `));
            const hint = key ? sheet.root.querySelector<HTMLElement>(`[data-pj-err="${key}"]`) : null;
            if (hint) {
                sheet.fail('');
                hint.textContent = reason;
                const fold = sheet.root.querySelector<HTMLButtonElement>('[data-pj-fold]');
                if (fold?.getAttribute('aria-expanded') !== 'true') fold?.click();
            } else sheet.fail(reason);
            sheet.busy(false);
        }
    }
}
