// 项目页（Stage03 T6）：左侧项目列表 + 右侧详情。
// 详情里可以打开 Claude Code / 文件夹、编辑配置、移除；不是 git 的文件夹可以一键 git init；
// 未初始化时先预览改动，确认后才写入，写完后可以把这几个文件提交到一个新提交里。
// 数据都经 window.dock.console 交给核心；会写文件的操作期间按钮忙碌，失败在详情顶部显示核心给的原因。
import { ag, c, pj } from '../shared/copy';
import { esc } from '../shared/markdown';
import type { ProjectChange, ProjectRow, ProjectShow, Task } from '../shared/types';
import { icon, menu, confirmAction, openSheet, field, type Sheet } from './ui';

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

// 设置提交身份模态框（项目页与新建任务页共用）：只写本机 git 配置，不涉及 GitHub 登录。
// 保存成功后关闭并调用 onSaved（由调用方刷新详情与横幅）；失败在模态框顶部显示核心给的原因。
export function openIdentitySheet({ path, trigger, identity, onSaved }: {
    path: string;
    trigger: HTMLElement;
    identity?: { name: string | null; email: string | null } | null;
    onSaved?: () => void | Promise<void>;
}) {
    const start = { name: text(identity?.name), email: text(identity?.email) };
    let global = false;
    const hint = (key: 'name' | 'email') => `<span class="fhint fail" data-id-error="${key}" role="alert"></span>`;
    const input = (key: 'name' | 'email', label: string, help: string, value: string) =>
        field(label, help, `<input class="inp" data-id-f="${key}" aria-label="${esc(label)}" value="${esc(value)}" autocomplete="off" spellcheck="false">${hint(key)}`, true);
    const body = `<div class="form">${input('name', pj.identityName, '', start.name)}${input('email', pj.identityEmail, esc(pj.identityEmailHelp), start.email)}${field(pj.identityScope, '', `<div class="segm sm" data-id-seg="scope" role="group" aria-label="${esc(pj.identityScope)}"><button data-id-scope="repo" class="on" aria-pressed="true">${esc(pj.identityScopes.repo)}</button><button data-id-scope="global" aria-pressed="false">${esc(pj.identityScopes.global)}</button></div>`)}</div>`;
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
    const dirty = () => value('name') !== start.name || value('email') !== start.email || global;
    const sheet: Sheet = openSheet({
        title: pj.identityEditTitle, trigger, body, note: pj.identityNote(false), buttons: [c.cancel, pj.identitySave],
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
    return sheet;
}

export class ProjectsView {
    private rows: ProjectRow[] = [];
    private selected = '';
    private show: ProjectShow | null = null;
    private loaded = false;
    private mode: 'view' | 'plan' | 'written' = 'view';
    private plan: ProjectChange[] = [];
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
    // 每次刷新 / 选择自增；晚到的结果只应用到仍然对得上的那一次。
    private seq = 0;
    // initial：打开项目页时要选中的项目（首次引导添加完项目后传入）。列表加载完就按它选中、取它的详情，加载多慢都不会丢。
    constructor(private host: ProjectsHost, initial = '') { this.selected = initial; }

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
            container.querySelector('.page-h')!.innerHTML = head;
            const list = container.querySelector<HTMLElement>('[data-pj-list]')!;
            list.innerHTML = this.rows.map(p => {
                const tag = !p.exists ? `<span class="tag fail">${esc(pj.missing)}</span>`
                    : !p.git ? `<span class="tag">${esc(pj.notGit)}</span>`
                        : !p.initialized ? `<span class="tag brand">${esc(pj.notInit)}</span>`
                            : `<span class="mono">${esc(clock(p.lastUsed))}</span>`;
                return `<button class="trow prow ${this.selected === p.path ? 'on' : ''}" data-pj-row="${esc(p.path)}" aria-pressed="${this.selected === p.path}">${icon('folder-3-line')}<span class="tm"><b>${esc(p.name)}</b><span class="mono">${esc(p.path)}</span></span><span class="ts">${tag}</span></button>`;
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
        const acts = `<span class="acts">${s.git ? `<button class="btn sm" data-pj="claude" ${this.busy ? 'disabled' : ''}>${icon('terminal-box-line')}${esc(pj.openClaude)}</button>` : ''}<button class="btn sm quiet" data-pj="folder" ${this.busy ? 'disabled' : ''}>${icon('folder-open-line')}${esc(pj.openFolder)}</button><button class="btn icon quiet" data-pj="more" data-tip="${esc(c.more)}" aria-label="${esc(c.more)}" aria-haspopup="menu" ${this.busy ? 'disabled' : ''}>${icon('more-2-fill')}</button></span>`;
        // 状态行：路径、分支、改动数，git 仓库再多一项提交身份（过长截断，悬停看全文）。
        const idText = s.git ? (identityText(s) || pj.identityMissing) : '';
        const ident = s.git ? `<span class="ident" data-pj-ident><span>${icon('account-circle-line')}${esc(pj.identityLabel)}</span><span class="mono" title="${esc(idText)}"${identityComplete(s) ? '' : ' data-pj-ident-missing'}>${esc(idText)}</span></span>` : '';
        const state = `<div class="dh-2"><span class="mono">${esc(s.path)}</span>${s.git ? `<span>${icon('git-branch-line')}<span class="mono">${esc(s.branch ?? 'main')}</span></span><span>${icon(s.dirty ? 'edit-line' : 'checkbox-circle-line')}${esc(s.dirty ? pj.dirty(s.dirty) : pj.clean)}</span>${ident}` : ''}</div>`;
        const body = `${this.error ? errorLine(this.error) : ''}${s.configError ? errorLine(s.configError) : ''}${this.body()}`;
        box.innerHTML = `<div class="dh"><div class="dh-1"><h2>${esc(s.name)}</h2>${acts}</div>${state}</div><div class="dbody edge"><div class="scroll" tabindex="0"><div class="pj-body">${body}</div></div></div>`;
    }
    private body(): string {
        const s = this.show!;
        if (!s.exists) return banner('fail', pj.missingTitle, pj.missingHelp);
        if (!s.git) return banner('info', pj.gitTitle, pj.gitHelp, `<button class="btn sm primary" data-pj="git-init" ${this.busy ? 'disabled' : ''}>${esc(pj.gitInit)}</button>`);
        // 没有提交身份时先提示设置；"已写入但提交失败"时由失败横幅承担同样的按钮，不重复显示。
        const needIdentity = !identityComplete(s) && !(this.mode === 'written' && this.identityError);
        const identityBanner = needIdentity ? banner('brand', pj.identityTitle, pj.identityHelp, identityButton('data-pj="identity"', this.busy)) : '';
        if (this.mode === 'plan') return identityBanner + this.planBody();
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
        const recent = this.host.tasks().filter(t => samePath(t.repo, s.path)).sort((a, b) => b.started - a.started).slice(0, 3);
        const recentRows = recent.length
            ? recent.map(t => `<button class="r pj-task" data-pj-task="${esc(t.id)}">${mark(t.status)}<span class="v">${esc(t.title)}</span><span class="sp"></span><span class="mono muted">${esc(clock(t.started))}</span></button>`).join('')
            : `<div class="r"><span class="muted">${esc(pj.noRecent)}</span></div>`;
        return `<div class="sec-t">${esc(pj.config)} <span class="mono muted">${esc(pj.configFile)}</span><span class="sp"></span><button class="btn sm" data-pj="edit" ${this.busy ? 'disabled' : ''}>${icon('edit-line')}${esc(pj.edit)}</button></div><div class="rows">${rows}</div><div class="sec-t">${esc(pj.recent)}</div><div class="rows">${recentRows}</div>`;
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
        return `<div class="sec-t">${esc(pj.planHelp(added, updated))}</div><div class="initlist">${rows}</div><div class="inline-f"><span class="note">${esc(pj.notWritten)}</span><button class="btn" data-pj="plan-cancel">${esc(pj.cancel)}</button><button class="btn primary" data-pj="apply" ${this.busy ? 'disabled' : ''}>${esc(pj.confirmWrite)}</button></div>`;
    }
    private writtenBody(): string {
        const n = this.written.length;
        const rows = this.written.map(w => `<div class="r ${w.action}">${icon(w.action === 'create' ? 'add-line' : 'edit-line')}<span class="v mono">${esc(w.path)}</span></div>`).join('');
        const note = this.committed ? pj.committed(this.committed) : pj.commitNote(n);
        const button = this.committed ? '' : `<button class="btn primary" data-pj="commit" ${this.busy ? 'disabled' : ''}>${icon('git-commit-line')}${esc(pj.commit)}</button>`;
        // 提交失败且原因是缺少提交身份：显示核心的说明和"设置提交身份…"，补好后可以再点提交。
        const failed = this.identityError ? banner('fail', pj.identityTitle, this.identityError, identityButton('data-pj="identity"', this.busy)) : '';
        return `${failed}${banner('ok', pj.written(n), pj.writtenHelp)}<div class="rows">${rows}</div><div class="inline-f"><span class="note mono"${this.committed ? ` data-pj-committed="${esc(this.committed)}"` : ''}>${esc(note)}</span>${button}</div>`;
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
            if (seq === this.seq && this.selected === path) { this.show = r.project; this.error = ''; }
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
            }
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
            if (action === 'add') void this.add();
            else if (action === 'claude') void this.shell('claude');
            else if (action === 'folder') void this.shell('folder');
            else if (action === 'more') this.more(b);
            else if (action === 'edit') this.editConfig(b);
            else if (action === 'git-init') void this.gitInit();
            else if (action === 'init') void this.startPlan();
            else if (action === 'plan-cancel') this.cancelPlan();
            else if (action === 'apply') void this.applyPlan();
            else if (action === 'commit') void this.commit();
            else if (action === 'identity') this.openIdentity(b);
            return;
        }
        if (b.dataset.pjRow !== undefined) { void this.select(b.dataset.pjRow); return; }
        if (b.dataset.pjInit !== undefined) {
            const i = Number(b.dataset.pjInit);
            if (this.expanded.has(i)) this.expanded.delete(i); else this.expanded.add(i);
            this.render();
            return;
        }
        if (b.dataset.pjTask) this.host.openTask(b.dataset.pjTask);
    }

    // 添加项目：先选文件夹（验收时由桩返回队列里的路径），再登记；成功后刷新并选中它。
    private async add() {
        this.busy = true; this.error = ''; this.render();
        try {
            const path = await window.dock.console('projects:choose');
            if (typeof path === 'string' && path) {
                await window.dock.console('projects:add', { path });
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
            { label: pj.menu.edit, run: () => this.editConfig(anchor) },
            { label: pj.menu.remove, run: () => { void this.remove(anchor); } },
        ]);
    }
    private async remove(trigger: HTMLElement) {
        const s = this.show;
        if (!s) return;
        if (!await confirmAction(pj.removeTitle(s.name), pj.removeBody, pj.removeConfirm, trigger, true)) return;
        this.busy = true; this.error = ''; this.render();
        try {
            await window.dock.console('projects:remove', { path: s.path });
            this.selected = ''; this.show = null; this.mode = 'view';
            this.busy = false;
            await this.refresh();
        }
        catch (e) { this.busy = false; this.error = failure(e); this.render(); }
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
            this.expanded.clear();
            this.mode = 'plan';
        }
        catch (e) { this.error = failure(e); }
        finally { this.busy = false; this.render(); }
    }
    private cancelPlan() {
        this.mode = 'view'; this.plan = []; this.expanded.clear(); this.error = '';
        this.render();
    }
    private async applyPlan() {
        const s = this.show;
        if (!s) return;
        this.busy = true; this.error = ''; this.render();
        try {
            const r = await window.dock.console('projects:init-apply', { path: s.path });
            this.written = Array.isArray(r.changes) ? r.changes : [];
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
            const r = await window.dock.console('projects:commit-init', { path: s.path });
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

    // 设置提交身份：保存后刷新详情（横幅与状态行随之更新），"已写入"状态保留，可以再点提交。
    private openIdentity(trigger: HTMLElement) {
        const s = this.show;
        if (!s) return;
        openIdentitySheet({
            path: s.path, trigger, identity: s.identity,
            onSaved: async () => { this.identityError = ''; await this.refresh(); },
        });
    }

    // 编辑配置：只提交改过的键；数组按行拆、去空行与首尾空白。保存失败时模态框保持打开并显示原因。
    private editConfig(trigger: HTMLElement) {
        const s = this.show;
        if (!s) return;
        const projectPath = s.path;
        const cfg = (s.config ?? {}) as Record<string, unknown>;
        const original = { baseBranch: text(cfg.baseBranch), setup: lines(cfg.setup), verify: lines(cfg.verify), allowedPaths: lines(cfg.allowedPaths), specsDir: text(cfg.specsDir) };
        const input = (key: string, value: string) => `<input class="inp mono" data-pj-f="${key}" value="${esc(value)}">`;
        const area = (key: string, value: string[], rows: number) => `<textarea class="inp area mono" data-pj-f="${key}" rows="${rows}">${esc(value.join('\n'))}</textarea>`;
        const body = `<div class="form">${field(pj.fields.baseBranch, pj.fieldHelp.baseBranch, input('baseBranch', original.baseBranch))}${field(pj.fields.setup, pj.fieldHelp.setup, area('setup', original.setup, 2))}${field(pj.fields.verify, pj.fieldHelp.verify, area('verify', original.verify, 2))}${field(pj.fields.allowedPaths, pj.fieldHelp.allowedPaths, area('allowedPaths', original.allowedPaths, 3))}${field(pj.fields.specsDir, pj.fieldHelp.specsDir, input('specsDir', original.specsDir))}</div>`;
        const value = (key: string) => (sheet.root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-pj-f="${key}"]`)?.value ?? '');
        const current = () => ({ baseBranch: value('baseBranch').trim(), setup: splitLines(value('setup')), verify: splitLines(value('verify')), allowedPaths: splitLines(value('allowedPaths')), specsDir: value('specsDir').trim() });
        const dirty = () => {
            const now = current();
            return now.baseBranch !== original.baseBranch || now.specsDir !== original.specsDir || !sameLines(now.setup, original.setup) || !sameLines(now.verify, original.verify) || !sameLines(now.allowedPaths, original.allowedPaths);
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
    }
    private async saveConfig(sheet: Sheet, path: string, current: () => { baseBranch: string; setup: string[]; verify: string[]; allowedPaths: string[]; specsDir: string }, original: { baseBranch: string; setup: string[]; verify: string[]; allowedPaths: string[]; specsDir: string }) {
        const now = current();
        const set: Record<string, unknown> = {};
        if (now.baseBranch !== original.baseBranch) set.baseBranch = now.baseBranch;
        if (now.specsDir !== original.specsDir) set.specsDir = now.specsDir;
        if (!sameLines(now.setup, original.setup)) set.setup = now.setup;
        if (!sameLines(now.verify, original.verify)) set.verify = now.verify;
        if (!sameLines(now.allowedPaths, original.allowedPaths)) set.allowedPaths = now.allowedPaths;
        if (!Object.keys(set).length) { sheet.close(); return; }
        sheet.busy(true);
        try {
            await window.dock.console('projects:config', { path, set });
            // 刷新返回之前，把刚保存的键合进本地详情：这段时间"编辑配置"用上一份数据打开时看到的就是刚保存的值。
            if (this.show && samePath(this.show.path, path)) this.show = { ...this.show, config: { ...(this.show.config ?? {}), ...set } };
            sheet.close();
            await this.refresh();
        }
        catch (e) { sheet.fail(failure(e)); sheet.busy(false); }
    }
}
