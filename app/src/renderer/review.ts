import { c, rv, wt as w } from '../shared/copy';
import { esc } from '../shared/markdown';
import { worktreeState, type AgentRow, type ReviewFile, type ReviewIssue, type RolesView, type RouteConfig, type Task } from '../shared/types';
import { field, icon, menu, openSheet } from './ui';
import { bannerHtml } from './wt';

// "审查"标签（Stage08 158，界面稿 app/design/preview.js 的 reviewTab()）：验收页与任务详情共用。
// 结论横幅 → 问题卡片（按严重度：高、中、低）→ 看过的文件与"再审一次…"。数据只来自核心：
// 摘要来自清单里的 review 事件（Task.review），标签内容读 ar review show（review:show），成立 / 不成立写 ar review confirm（review:confirm），再审是 ar review（review:rerun）。
// 界面不自己改任何文件；点"成立 / 不成立"成功后才显示确认结果，失败时提示核心给的原因、显示不变。
export const reviewHint = rv.jumpNoLine;

const messageOf = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error);
const call = (action: string, payload?: Record<string, unknown>) => window.dock.console(action, payload);
const runm = `<span class="mk run">${icon('loader-4-line')}</span>`;
const SEVERITY: Record<string, [string, number]> = { high: ['fail', 0], medium: ['info', 1], low: ['', 2] };

// 配置名 → 显示名（agents:list，读一次就记住）；读不到时显示配置名。
const labels = new Map<string, string>();
export const reviewerLabel = (name: string | null) => (name ? labels.get(name) ?? name : '');
// 每次读审查结果都重读一遍执行者名：Agent 页里改了名字或换了配置之后，审查者标签不能停在第一次读到的旧值上。
function loadLabels(): Promise<void> {
    return (call('agents:list') as Promise<{ agents?: AgentRow[] }>).then(result => { labels.clear(); for (const agent of result.agents ?? []) labels.set(agent.name, agent.label); }, () => { });
}

const verdictText = (t: Task) => {
    const r = t.review;
    if (!r) return '';
    return r.verdict === 'pass' ? rv.nodePass : r.verdict === 'concerns' ? rv.nodeIssues(r.issues) : r.verdict === 'fail' ? rv.nodeFail : rv.nodeUnknown;
};
// 验收页概览摘要的"审查"一项（界面稿 acceptOverview 的 rvItem）：没有审查返回空串。
export function reviewSumItem(t: Task): string {
    const r = t.review;
    if (!r) return '';
    return `<span data-rv-sum>${icon('shield-check-line')}<em>${esc(rv.overviewRow)}</em>${esc(verdictText(t))}${r.reviewer ? ` · ${esc(reviewerLabel(r.reviewer))}` : ''}${r.crossed ? '' : esc(rv.notCrossed)}</span>`;
}

const durText = (ms: number) => ms >= 60000 ? `${(ms / 60000).toFixed(1)} ${c.minutes}` : `${Math.max(1, Math.round(ms / 1000))} 秒`;
const issueOrder = (issues: ReviewIssue[]) => issues.map((issue, index) => ({ issue, index })).sort((a, b) => (SEVERITY[a.issue.severity]?.[1] ?? 3) - (SEVERITY[b.issue.severity]?.[1] ?? 3) || a.index - b.index).map(x => x.issue);

export interface ReviewHost {
    tasks(): Task[];
    // 点"文件:行"：宿主切到"改动"标签并滚到这一行。
    jump(t: Task, file: string, line: number | null): void;
    // 这个任务的审查数据或操作状态变了：宿主重画"审查标签"（有概览摘要的页面也一并重画）。
    changed(id: string): void;
}
interface Slot {
    key: string;
    loading: boolean;
    review: ReviewFile | null;
    error: string;
    // 正在写确认的问题；失败原因按问题编号记。
    busy: Set<string>;
    fail: Map<string, string>;
    rerun: boolean;
    rerunError: string;
    // 说明输入框里还没提交的文字（按问题编号）：重画时放回去。
    drafts: Map<string, string>;
    // 244：上一次说明提交还没回来时又失焦/回车引出的最新说明，串行排在这一条后面（按问题编号，不同问题互不影响）。
    pending: Map<string, { result: 'valid' | 'invalid'; note: string }>;
}
export interface ReviewSnapshot { key: string; start: number | null; end: number | null }

export class ReviewView {
    private slots = new Map<string, Slot>();
    // 宿主重画（capture 之后马上换掉 innerHTML）时，被换掉的说明框会触发 focusout：这不是用户离开了说明框，不能当成“失去焦点时提交”。
    // capture 记下时刻，这之后很短的时间里忽略 focusout。
    private muteFocusOutUntil = 0;
    // 244：回车结束时主动 blur 会引出一次 focusout；这次提交由 keydown 发起，focusout 不再重复写。
    private enterBlurInput: HTMLInputElement | null = null;
    private enterBlurUntil = 0;
    constructor(private host: ReviewHost) { }

    private slot(id: string): Slot {
        let slot = this.slots.get(id);
        if (!slot) { slot = { key: '', loading: false, review: null, error: '', busy: new Set(), fail: new Map(), rerun: false, rerunError: '', drafts: new Map(), pending: new Map() }; this.slots.set(id, slot); }
        return slot;
    }
    private find(id: string) { return this.host.tasks().find(t => t.id === id); }
    // 清单里的 review 事件变了（再审、别处写了确认、需人工处理）就重新读 review.json。
    private keyOf(t: Task) { const r = t.review; return r ? `${r.at}:${r.confirmedAt ?? 0}:${r.verdict}:${r.needsHuman ? 1 : 0}` : ''; }
    review(t: Task) { return this.slots.get(t.id)?.review ?? null; }

    // ---- 读 ----
    // 需要时读 review.json；读完（数据真的变了）通知宿主重画。返回的 Promise 在这一次读完后完成。
    ensure(t: Task): Promise<void> {
        if (!t.review) return Promise.resolve();
        const slot = this.slot(t.id), key = this.keyOf(t);
        if (slot.key === key) return Promise.resolve();
        if (slot.loading) return Promise.resolve();
        slot.loading = true;
        slot.key = key;
        void loadLabels().then(() => { if (slot.review) this.host.changed(t.id); });
        return (call('review:show', { project: t.repo, name: t.name }) as Promise<{ review?: ReviewFile }>).then(result => {
            const before = JSON.stringify([slot.review, slot.error]);
            slot.review = result.review ?? null;
            slot.error = '';
            return before !== JSON.stringify([slot.review, slot.error]);
        }, error => {
            const before = JSON.stringify([slot.review, slot.error]);
            slot.error = messageOf(error);
            slot.review = null;
            // 读失败：下一次刷新再试。
            slot.key = '';
            return before !== JSON.stringify([slot.review, slot.error]);
        }).then(changed => {
            slot.loading = false;
            const now = this.find(t.id);
            // 读的时候清单里又有了新的 review 事件：再读一次。
            if (now && slot.key !== this.keyOf(now) && now.review && slot.error === '') { void this.ensure(now); }
            if (changed) this.host.changed(t.id);
        });
    }
    // 批准确认框要先知道有哪些问题没确认：数据没读到就等一次。
    async load(t: Task): Promise<ReviewFile | null> {
        await this.ensure(t);
        for (let i = 0; i < 100 && this.slots.get(t.id)?.loading; i++) await new Promise(resolve => setTimeout(resolve, 50));
        return this.review(t);
    }

    // ---- 派生 ----
    // 没确认的高 / 中问题（批准确认框的提示用）。
    unconfirmed(t: Task): ReviewIssue[] {
        return (this.review(t)?.issues ?? []).filter(issue => (issue.severity === 'high' || issue.severity === 'medium') && !issue.confirmation);
    }
    // 需人工处理横幅：拦截模式下返工次数用完仍有高严重度问题。返回还没被标成"不成立"的高问题编号；没有横幅返回 null。
    needsHuman(t: Task): string[] | null {
        const review = this.review(t);
        if (!review || !(review.needsHuman === true || t.review?.needsHuman === true)) return null;
        const ids = review.issues.filter(issue => issue.severity === 'high' && issue.confirmation?.result !== 'invalid').map(issue => issue.id);
        return ids.length ? ids : null;
    }
    // 需人工处理的顶部横幅（验收页各标签都显示）。
    needsHumanBanner(t: Task): string {
        const ids = this.needsHuman(t);
        return ids ? bannerHtml('fail', rv.needsHuman, rv.needsHumanHelp(ids.join('、'))).replace('class="banner fail"', 'class="banner fail" data-rv-needs-human') : '';
    }

    // ---- 画 ----
    html(t: Task): string {
        const slot = this.slot(t.id), review = slot.review;
        if (!t.review && !review) return `<div class="empty">${icon('shield-check-line')}<b>${esc(rv.none)}</b><p>${esc(rv.noneHelp)}</p></div>`;
        if (!review) return slot.error ? `<div class="empty" data-rv-error>${icon('shield-check-line')}<b>${esc(slot.error)}</b></div>` : `<div class="empty">${runm}<b>${esc(w.diffLoading)}</b></div>`;
        const tone = review.verdict === 'pass' ? 'ok' : review.verdict === 'fail' ? 'fail' : 'info';
        const title = review.verdict === 'concerns' ? rv.verdict.concerns : rv.verdict[review.verdict] ?? review.verdict;
        const by = review.reviewer ? rv.by(reviewerLabel(review.reviewer), review.crossed === true, durText(review.ms ?? 0)) : '';
        const head = bannerHtml(tone, title, `${by}${review.summary ?? ''}`).replace('class="banner ', 'data-rv-head class="banner ');
        const rerunFail = slot.rerunError ? bannerHtml('fail', rv.again, slot.rerunError).replace('class="banner fail"', 'class="banner fail" data-rv-rerun-error') : '';
        const rows = issueOrder(review.issues).map(issue => this.issueCard(t, slot, issue)).join('');
        // 244：看过的文件独立成一区（标题 + 完整路径列表），不再和再审按钮挤在同一行；路径按原文本换行，不截断。
        const seen = review.reviewed ?? [];
        const rerunnable = worktreeState(t) === 'awaiting';
        const again = rerunnable ? `<button class="btn sm" data-rv-f="again" data-rv-again data-rv-task="${esc(t.id)}" ${slot.rerun ? 'disabled' : ''}>${slot.rerun ? `${runm}${esc(rv.rerunning)}` : `${icon('refresh-line')}${esc(rv.again)}`}</button>` : '';
        const reviewed = `<div class="rv-reviewed" data-rv-reviewed><div class="rv-reviewed-head"><span>${esc(rv.reviewed)}</span>${again}</div>${seen.length ? `<ul class="rv-reviewed-files" data-rv-reviewed-files>${seen.map(file => `<li><span class="mono" data-rv-reviewed-file>${esc(file)}</span></li>`).join('')}</ul>` : ''}</div>`;
        return `${head}${rerunFail}<div class="rv-list-issues" data-rv-issues>${rows}</div>${reviewed}`;
    }
    private issueCard(t: Task, slot: Slot, issue: ReviewIssue): string {
        const [tone] = SEVERITY[issue.severity] ?? ['', 3];
        const conf = issue.confirmation, id = esc(issue.id), task = esc(t.id);
        const tag = conf ? `<span class="tag ${conf.result === 'valid' ? 'ok' : ''}" data-rv-conf="${conf.result}">${esc(conf.result === 'valid' ? rv.valid : rv.invalid)}</span>` : '';
        const busy = slot.busy.has(issue.id);
        const button = (result: 'valid' | 'invalid', text: string) => `<button data-rv-f="${result}:${id}" data-rv-confirm="${result}" data-rv-issue="${id}" data-rv-task="${task}" class="${conf?.result === result ? 'on' : ''}" aria-pressed="${conf?.result === result}" ${busy ? 'aria-busy="true"' : ''}>${esc(text)}</button>`;
        const where = issue.file ? `${issue.file}${Number.isInteger(issue.line) ? `:${issue.line}` : ''}` : '';
        const jump = issue.file ? `<button class="btn sm quiet mono" data-rv-f="jump:${id}" data-rv-jump data-rv-task="${task}" data-rv-file="${esc(issue.file)}" data-rv-line="${Number.isInteger(issue.line) ? issue.line : ''}" title="${esc(rv.jump)}" aria-label="${esc(`${rv.jump}：${where}`)}">${esc(where)}</button>` : '';
        const note = slot.drafts.get(issue.id) ?? conf?.note ?? '';
        // 当次渲染时的已保存说明（不是最新异步数据，也不是显示用的草稿）：capture 据此判断用户是否改过输入框。
        const base = conf?.note ?? '';
        const fail = slot.fail.get(issue.id);
        return `<div class="rv-issue" data-rv-card="${id}" data-severity="${esc(issue.severity)}"><div class="rv-h"><span class="mono muted">${id}</span><span class="tag ${tone}">${esc(rv.severity[issue.severity] ?? issue.severity)}</span><b>${esc(issue.title)}</b>${tag}<span class="sp"></span><span class="segm sm" role="group">${button('valid', rv.valid)}${button('invalid', rv.invalid)}</span></div>`
            + `<div class="rv-b">${jump}<p>${esc(issue.detail ?? '')}</p></div>`
            + `<div class="rv-n"><input class="inp" data-rv-f="note:${id}" data-rv-note="${id}" data-rv-task="${task}" data-rv-base="${esc(base)}" autocomplete="off" placeholder="${esc(rv.note)}" aria-label="${esc(`${issue.id} ${rv.note}`)}" value="${esc(note)}"></div>`
            + `${fail ? `<div class="fhint fail" data-rv-fail="${id}" role="alert">${esc(fail)}</div>` : ''}</div>`;
    }

    // ---- 重画时保住焦点与已输入的内容 ----
    // 宿主在替换 innerHTML 之前调 capture（把说明框里的字记成草稿、记下焦点在哪个控件），替换之后调 restore。
    capture(root: ParentNode | undefined): ReviewSnapshot | null {
        if (!root) return null;
        this.muteFocusOutUntil = Date.now() + 300;
        for (const input of root.querySelectorAll<HTMLInputElement>('input[data-rv-note]')) {
            // 和渲染这个输入框时的说明基线比，不和刷新后的最新数据比：否则远端更新会被旧 DOM 误判成空草稿。
            const slot = this.slot(input.dataset.rvTask ?? ''), id = input.dataset.rvNote ?? '';
            const base = input.dataset.rvBase ?? '';
            if (input.value !== base) slot.drafts.set(id, input.value); else slot.drafts.delete(id);
        }
        const el = document.activeElement;
        if (!(el instanceof HTMLElement) || !el.dataset.rvF || !(root as Node).contains(el)) return null;
        const text = el instanceof HTMLInputElement;
        return { key: el.dataset.rvF, start: text ? el.selectionStart : null, end: text ? el.selectionEnd : null };
    }
    restore(root: ParentNode | undefined, snapshot: ReviewSnapshot | null) {
        if (!root || !snapshot) return;
        const el = root.querySelector<HTMLElement>(`[data-rv-f="${CSS.escape(snapshot.key)}"]`);
        if (!el || (el as HTMLButtonElement).disabled) return;
        el.focus({ preventScroll: true });
        if (el instanceof HTMLInputElement && snapshot.start !== null) el.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
    }

    // ---- 输入 ----
    // 在宿主的内容容器上挂监听（点击、回车、失去焦点）；只处理带 data-rv-* 的控件。返回取消函数。
    attach(el: HTMLElement): () => void {
        const click = (e: MouseEvent) => this.click(e);
        const keydown = (e: KeyboardEvent) => this.keydown(e);
        const focusout = (e: FocusEvent) => this.focusOut(e);
        el.addEventListener('click', click);
        el.addEventListener('keydown', keydown);
        el.addEventListener('focusout', focusout);
        return () => { el.removeEventListener('click', click); el.removeEventListener('keydown', keydown); el.removeEventListener('focusout', focusout); };
    }
    private click(e: MouseEvent) {
        const b = (e.target as Element).closest<HTMLButtonElement>('button[data-rv-task]');
        if (!b || b.disabled) return;
        const t = this.find(b.dataset.rvTask ?? '');
        if (!t) return;
        const d = b.dataset;
        if (d.rvConfirm && d.rvIssue) void this.confirm(t, d.rvIssue, d.rvConfirm === 'valid' ? 'valid' : 'invalid');
        else if (d.rvJump !== undefined && d.rvFile) this.host.jump(t, d.rvFile, d.rvLine ? Number(d.rvLine) : null);
        else if (d.rvAgain !== undefined) void this.again(t, b);
    }
    private keydown(e: KeyboardEvent) {
        const input = (e.target as Element).closest<HTMLInputElement>('input[data-rv-note]');
        if (!input || e.key !== 'Enter') return;
        // 输入法组合态（isComposing / 旧式 229）里的 Enter 是给输入法的，不提交、不夺焦点。
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        // 回车结束编辑：先 blur（用户要求不再聚焦），再按原来的确认结果写一次说明；未确认的问题不自动制造确认。
        this.enterBlurInput = input;
        this.enterBlurUntil = Date.now() + 300;
        input.blur();
        this.commitNote(input);
    }
    private focusOut(e: FocusEvent) {
        const input = (e.target as Element).closest<HTMLInputElement>('input[data-rv-note]');
        if (!input || !input.isConnected) return;
        // 回车引起的 blur 已经由 keydown 提交过：这次 focusout 只消费标记，不再写一次。
        if (this.enterBlurInput === input && Date.now() <= this.enterBlurUntil) { this.enterBlurInput = null; return; }
        if (Date.now() >= this.muteFocusOutUntil) this.commitNote(input);
    }
    // 已经有确认结果的问题：说明改了，回车或失去焦点时按原来的结果再写一次；还没有结果的，说明随下一次点"成立 / 不成立"一起写。
    private commitNote(input: HTMLInputElement) {
        const t = this.find(input.dataset.rvTask ?? ''), id = input.dataset.rvNote ?? '';
        if (!t) return;
        const slot = this.slot(t.id), issue = slot.review?.issues.find(item => item.id === id);
        // 验收页会先生成HTML再capture；结束编辑前须把最新内容存为草稿，首轮重画才不会闪回旧值。
        // 保存中回改旧基线也是新意图；未确认的问题同样保留草稿，但不制造确认。
        if (slot.busy.has(id) || input.value !== (input.dataset.rvBase ?? '')) slot.drafts.set(id, input.value);
        else slot.drafts.delete(id);
        if (!issue?.confirmation) return;
        // 在途写入可能把旧基线改掉；此时回改旧值也是新的保存意图，交给 pending 覆盖先前排队值。
        if (!slot.busy.has(id) && input.value.trim() === (issue.confirmation.note ?? '').trim()) return;
        void this.confirm(t, id, issue.confirmation.result, input.value);
    }

    // ---- 成立 / 不成立 ----
    private async confirm(t: Task, id: string, result: 'valid' | 'invalid', noteText?: string) {
        const slot = this.slot(t.id);
        // 244：同一问题的上一条说明还没回来时，失焦/回车引出的新说明排队，等前一条回来再串行写；
        // 按钮点击（不带 noteText）仍按原来的行为忽略。不同问题各排各的，不全局串行。
        if (slot.busy.has(id)) {
            if (noteText !== undefined) slot.pending.set(id, { result, note: noteText });
            return;
        }
        const input = document.querySelector<HTMLInputElement>(`input[data-rv-note="${CSS.escape(id)}"][data-rv-task="${CSS.escape(t.id)}"]`);
        const rawNote = noteText ?? input?.value ?? slot.drafts.get(id) ?? '';
        const note = rawNote.trim();
        // 排队请求也从这里重新进入；每次提交都须在首次重画前保存这次的原始文字。
        slot.drafts.set(id, rawNote);
        slot.busy.add(id);
        slot.fail.delete(id);
        this.host.changed(t.id);
        try {
            const done = await call('review:confirm', { project: t.repo, name: t.name, issue: id, result, ...(note ? { note } : {}) }) as { by?: string; note?: string | null };
            const issue = slot.review?.issues.find(item => item.id === id);
            if (issue) issue.confirmation = { result, by: done.by ?? 'human', note: done.note ?? (note || null), at: Date.now() };
            // 回来的结果只删掉和这次写入相同的草稿；期间又输入的新文字（B）要留着，不能被 A 覆盖。
            const draft = slot.drafts.get(id);
            if (draft === undefined || draft.trim() === note) slot.drafts.delete(id);
        }
        catch (error) { slot.fail.set(id, messageOf(error)); }
        slot.busy.delete(id);
        this.host.changed(t.id);
        // 排队的后一次失焦：和已保存的说明相同就不重复写，否则按当时的确认结果再写一次。
        const next = slot.pending.get(id);
        if (next) {
            slot.pending.delete(id);
            const saved = slot.review?.issues.find(item => item.id === id)?.confirmation;
            if (next.note.trim() !== (saved?.note ?? '').trim()) void this.confirm(t, id, next.result, next.note);
        }
    }

    // ---- 再审一次 ----
    // 弹窗选审查者：第一项"按规则自动选"，其余是可担任审查者、支持只读的执行者（roles:list 与 route:config 交叉）；确定后关闭弹窗，在标签里禁用按钮直到完成。
    private async again(t: Task, trigger: HTMLElement) {
        const slot = this.slot(t.id);
        if (slot.rerun) return;
        let choices: { name: string; label: string }[] = [];
        try {
            const [roles, route] = await Promise.all([call('roles:list') as Promise<RolesView>, call('route:config') as Promise<RouteConfig>]);
            const readOnly = new Set(route.profiles.filter(p => p.enabled && p.readOnly).map(p => p.name));
            choices = roles.profiles.filter(p => p.roles.includes('reviewer') && readOnly.has(p.name)).map(p => ({ name: p.name, label: p.label }));
        }
        catch (error) { slot.rerunError = messageOf(error); this.host.changed(t.id); return; }
        let picked = '';
        const labelOf = () => picked ? choices.find(item => item.name === picked)?.label ?? picked : rv.rerunAuto;
        const body = document.createElement('div');
        const paint = () => {
            body.innerHTML = `<p class="muted">${esc(rv.againHelp)}</p><div class="form">${field(rv.rerunReviewer, '', `<button class="sel" data-rv-pick aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(`${rv.rerunReviewer}：${labelOf()}`)}"><span>${esc(labelOf())}</span>${icon('arrow-down-s-line')}</button>`)}</div>${choices.length ? '' : `<p class="muted" data-rv-no-reviewer>${esc(rv.rerunNone)}</p>`}`;
            body.querySelector<HTMLElement>('[data-rv-pick]')!.onclick = e => {
                const anchor = e.currentTarget as HTMLElement;
                menu(anchor, [{ label: rv.rerunAuto, run: () => { picked = ''; paint(); body.querySelector<HTMLElement>('[data-rv-pick]')?.focus({ preventScroll: true }); } }, ...choices.map(item => ({ label: item.label, run: () => { picked = item.name; paint(); body.querySelector<HTMLElement>('[data-rv-pick]')?.focus({ preventScroll: true }); } }))], true);
            };
        };
        paint();
        openSheet({
            title: rv.againTitle, trigger, body, buttons: [c.cancel, rv.againTitle],
            onButton: (index, sheet) => {
                if (index === 0) { sheet.close(); return; }
                sheet.close();
                void this.rerun(t, picked);
            },
        });
    }
    private async rerun(t: Task, profile: string) {
        const slot = this.slot(t.id);
        slot.rerun = true;
        slot.rerunError = '';
        this.host.changed(t.id);
        try { await call('review:rerun', { project: t.repo, name: t.name, ...(profile ? { profile } : {}) }); }
        catch (error) { slot.rerunError = messageOf(error); }
        slot.rerun = false;
        // 完成后重新读顶层 review.json（没有结论时核心把原来的放回，读到的仍是原来的）。
        slot.key = '';
        const now = this.find(t.id) ?? t;
        await this.ensure(now);
        this.host.changed(t.id);
    }
}
