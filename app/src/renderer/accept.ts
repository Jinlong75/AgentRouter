import { c, rv, wt as w } from '../shared/copy';
import type { GateResult, ProjectShow, Task } from '../shared/types';
import { esc, markdown } from '../shared/markdown';
import { executorLabel, executorTag } from '../shared/executor';
import { confirmAction, field, icon, menu, notice, openSheet, toast, type ConfirmOption } from './ui';
import { selectProjectNext } from './projects';
import { gateBadge, gateEnabled, gateFile, gateTab } from './gate';
import { attemptBadge, lastFailure, openRetrySheet } from './attempts';
import { openCommitSheet } from './projects';
import { reviewerLabel, reviewHint, ReviewView, reviewSumItem } from './review';
import { baseBranchOf, bannerHtml, closeBlocked, loadRepoState, needsAccept, overlapLines, listMeta, readdProject, repoBanner, reviewBadge, sha7, waitedSince, writeBlocked, wtMark, wtStateLine, wtTrack } from './wt';
import { captureTrack, restoreTrack } from './track-scroll';

// 验收页（Stage06，协议 15.6～15.9；界面稿 app/design/preview.js 的 acceptRow / diffView / acceptOverview / acceptPage）：
// 左边是待验收与冲突的任务，右边是详情（概览 · 改动 · 门禁 · 审查）与底部操作栏（驳回 · 重试 · 批准并合并 / 解决冲突并重试）。
// 所有写操作都经 window.dock.console 的 tasks:accept / reject / rebase / diff 调用核心，界面不自己改任何文件。
export interface AcceptHost {
    tasks(): Task[];
    // 点轨道上的"派发 / 执行"节点：回到任务页看这个任务的参数 / 进展。
    openTask(id: string, tab: string): void;
    // 交叉审查的"审查"标签（Stage08 158）：验收页与任务详情共用一份。
    reviews: ReviewView;
}
interface DiffFile { path: string; oldPath: string | null; status: string; additions: number; deletions: number; binary: boolean; patch?: string; truncated?: boolean }
interface DiffData { base: string; head: string; files: DiffFile[]; totalBytes: number; truncated: boolean }
type DiffState = { loading: true } | { error: string } | { data: DiffData };
interface Overview { allowed: string[] | null; verify: string[] | null; goal: string | null }
// copy：不在主分支时给"复制命令"；commit：主工作区有未提交的改动（核心错误码 DIRTY_MAIN）时给"去提交"。
type Banner = { title: string; text: string; copy?: string; commit?: boolean };
type TabKey = 'overview' | 'diff' | 'gate' | 'review';
// ar overlaps --json 的一组（Stage07c 154、171）：互相重叠的待验收任务，order 是建议的批准顺序（任务 id），why 是核心给的一句话。
interface OverlapGroup { tasks: { id: string; name: string }[]; order: string[]; why: string }

const clock = (n: number) => new Date(n).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const messageOf = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error);
const okm = `<span class="mk ok">${icon('checkbox-circle-line')}</span>`;
const runm = `<span class="mk run">${icon('loader-4-line')}</span>`;
const warnm = `<span class="mk brand">${icon('error-warning-line')}</span>`;

// 把一个文件的 patch（从第一个 @@ 开始的统一 diff）排成行：@@ 行是小节标题，+ / − 行用成功 / 失败浅底；行号 + 行用新文件的、− 行用旧文件的。
export function patchRows(patch: string): string {
    let oldNo = 0, newNo = 0;
    const row = (cls: string, no: number | string, text: string) => `<div class="dl ${cls}"><span class="no mono">${no}</span><span class="code mono">${esc(text)}</span></div>`;
    const rows: string[] = [];
    for (const line of patch.split('\n')) {
        if (line === '') continue;
        if (line.startsWith('@@')) {
            const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
            if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
            rows.push(`<div class="dl hunk"><span class="no"></span><span class="code">${esc(line)}</span></div>`);
        }
        else if (line.startsWith('\\')) rows.push(`<div class="dl hunk"><span class="no"></span><span class="code">${esc(line)}</span></div>`);
        else if (line[0] === '+') rows.push(row('add', newNo++, line));
        else if (line[0] === '-') rows.push(row('del', oldNo++, line));
        else { rows.push(row('', newNo, line)); oldNo++; newNo++; }
    }
    return rows.join('');
}

export class AcceptView {
    private root?: HTMLElement;
    private selected = '';
    private tab: TabKey = 'overview';
    // 当前选中任务的汇报与门禁（detail 通道）、概览摘要、改动；都按任务 id 缓存，换任务不重读已读到的。
    private detailData = new Map<string, { report: string; gate: GateResult }>();
    private overviews = new Map<string, Overview>();
    private diffs = new Map<string, DiffState>();
    private expanded = new Map<string, Set<number>>();
    private blocked = new Map<string, Banner>();
    // 刚批准 / 驳回、界面先隐藏的任务（快照稍后才会更新）；快照里它不再是待验收 / 冲突后清掉。
    private gone = new Set<string>();
    private busy: { id: string; kind: 'approve' | 'confirm' | 'reject' | 'rebase' } | null = null;
    // 批准确认框打开前要先读一次项目详情（有没有远程、push.afterAccept）：这段时间里再点"批准并合并"不重复弹框。
    private approving = false;
    private toastTimer?: ReturnType<typeof setTimeout>;
    private signature = '';
    private generation = 0;
    // 每个项目里互相重叠的待验收任务组（tasks:overlaps，即 ar overlaps --json）：待验收的任务集合变了才重新问核心；读不到就当没有分组。
    // groupsKey 是最近一次问核心用的待验收集合，loadedKey 是 groups 对应的集合（结果回来之后才更新）。
    private groups = new Map<string, OverlapGroup[]>();
    private groupsKey = '';
    private loadedKey = '';
    // 交叉审查（Stage08 158）："审查"标签、需人工处理横幅、批准确认框里的未确认提示；点"文件:行"切到改动并滚到这一行。
    // ReviewView 由 index.ts 建一份、验收页与任务详情共用（点击监听也只挂一次）。
    private get reviews() { return this.host.reviews; }
    // 从别处（任务详情的"审查"标签）要求打开这个任务的改动并定位：验收页第一次画出详情后执行。
    private pendingJump: { id: string; file: string; line: number | null } | null = null;
    // 最近一次跳转标出的那一行：整页重画后补回标记与位置，直到用户切标签或选了别的任务。
    private hit: { id: string; file: string; line: number | null } | null = null;
    // 审查摘要（概览那一项与需人工处理横幅）上次画出来的样子：非"审查"标签下只在它变了才重画正文。
    private reviewSig = '';
    constructor(private host: AcceptHost) { }

    // ---- 生命周期 ----
    mount(content: HTMLElement, selectId = '') {
        this.root = content;
        this.generation++;
        if (selectId) this.selected = selectId;
        content.innerHTML = `<div class="page-h"><h1>${esc(w.pageTitle)}</h1><span class="lead">${esc(w.pageLead)}</span></div><div class="acc-page"><div class="acc-main"></div></div>`;
        content.onclick = e => void this.click(e);
        this.signature = '';
        // 待验收集合变了而且有可能成组时，先等分组回来（最多 1.5 秒）再画列表，免得列表画出来之后又整体挪位置。
        const list = this.list();
        if (!this.groupsReady(list)) {
            const gen = this.generation;
            void Promise.race([this.loadGroups(list), new Promise(resolve => setTimeout(resolve, 1500))]).then(() => { if (gen === this.generation && this.signature === '') this.render(); });
            return;
        }
        this.render();
    }
    unmount() {
        this.generation++;
        clearTimeout(this.toastTimer);
        if (this.root) this.root.onclick = null;
        this.root = undefined;
    }
    // 外部（通知点开）要求选中某个任务。
    select(id: string) {
        this.selected = id;
        if (this.root) { this.tab = 'overview'; this.render(); }
    }
    tasksChanged() {
        if (!this.root) return;
        const list = this.list();
        void this.loadGroups(list);
        for (const id of [...this.gone]) if (!this.host.tasks().some(t => t.id === id && needsAccept(t))) this.gone.delete(id);
        const t = this.current(list);
        const signature = JSON.stringify([list.map(x => x.id), t && [t.id, t.status, t.wt, t.commit, t.minutes, t.gateOk, t.gateSummary, t.attempts?.length, t.review, t.reviewing]]);
        if (signature === this.signature) return;
        this.render();
    }

    // ---- 数据 ----
    private list() { return this.host.tasks().filter(t => needsAccept(t) && !this.gone.has(t.id)); }
    private current(list = this.list()) { return list.find(t => t.id === this.selected) ?? list[0]; }
    private key(t: Task) { return `${t.id}:${t.wt?.awaitingAt ?? 0}`; }
    // 调研 / 审查类任务（只读运行）或改动为空的任务：没有东西可合并，主按钮是“确认”（Stage07 T6）。改动为空要等 ar diff 读到结果才知道。
    private research(t: Task) {
        if (t.readOnly === true) return true;
        const diff = this.diffs.get(this.key(t));
        return !!diff && 'data' in diff && diff.data.files.length === 0;
    }
    // 项目被移除 / 文件夹不在了：横幅和底栏按钮随之变化（状态变了才会走到这里）。
    private repoChanged = () => {
        const now = this.current();
        if (!now || !this.root) return;
        this.renderBody();
        this.renderActions(now);
    };
    // 审查数据变了（读到了、写了确认、再审中）：当前任务的"审查"标签重画；别的标签只在概览那一项或需人工处理横幅变了时重画正文。
    reviewChanged(id: string) {
        const t = this.current();
        if (!t || t.id !== id || !this.root) return;
        const signature = JSON.stringify([this.reviews.needsHuman(t), t.review, reviewerLabel(t.review?.reviewer ?? null)]);
        if (this.tab !== 'review' && signature === this.reviewSig) return;
        this.renderBody();
    }
    private async load(t: Task) {
        loadRepoState(t, this.repoChanged);
        void this.reviews.ensure(t);
        const gen = this.generation, id = t.id, key = this.key(t);
        if (!this.detailData.has(key)) {
            try {
                const data = await window.dock.detail(id);
                if (gen !== this.generation) return;
                this.detailData.set(key, data);
                const now = this.current();
                if (now?.id === id) { this.renderHead(now); this.renderBody(); }
            } catch { /* 汇报与门禁读不到时概览只显示摘要。 */ }
        }
        if (!this.overviews.has(key)) {
            try {
                const overview = await window.dock.console('tasks:overview', { dir: t.progress.replace(/[\\/][^\\/]*$/, ''), ...(t.spec ? { repo: t.repo, spec: t.spec } : {}) }) as Overview;
                if (gen !== this.generation) return;
                this.overviews.set(key, overview);
                if (this.current()?.id === id) this.renderBody();
            } catch { this.overviews.set(key, { allowed: null, verify: null, goal: null }); }
        }
    }
    private async loadDiff(t: Task) {
        const key = this.key(t);
        const cached = this.diffs.get(key);
        if (cached && !('error' in cached)) return;
        const gen = this.generation;
        // 页面在请求途中重新挂载（generation 变了）时丢弃结果，但要把自己放的"读取中"标记撤掉，
        // 否则之后点"改动"会被这个标记挡住、永远不再请求（129 合并后 UI24 发现的竞态）。只撤自己放的那一个。
        const loading = { loading: true as const };
        this.diffs.set(key, loading);
        const stale = () => { if (gen === this.generation) return false; if (this.diffs.get(key) === loading) this.diffs.delete(key); return true; };
        try {
            const data = await window.dock.console('tasks:diff', { project: t.repo, name: t.name }) as DiffData;
            if (stale()) return;
            this.diffs.set(key, { data });
        }
        catch (error) {
            if (stale()) return;
            const text = messageOf(error);
            this.diffs.set(key, { error: text.includes('不可查') ? w.diffGone : `${w.failed}：${text}` });
        }
        const now = this.current();
        if (now && this.key(now) === key) {
            // 改动读到后，标签数量、调研横幅和底栏主按钮可能随之变化。
            this.renderTabs();
            this.renderBody();
            this.renderActions(now);
        }
    }

    // 互相重叠的待验收任务组：同一项目里有两个以上待验收的任务才问核心；结果回来时待验收集合已变（又发了新的请求）就丢掉。
    // 分组真的变了才重画列表（并保住焦点）。
    private groupsKeyOf(list: Task[]) { return list.map(t => `${t.repo}|${t.id}`).join('\n'); }
    // 分组对这个待验收集合是不是已经知道了（没有哪个项目有两个以上待验收的任务，就不用问）。
    private groupsReady(list: Task[]) {
        return !list.some(t => list.some(x => x !== t && x.repo === t.repo)) || this.groupsKeyOf(list) === this.loadedKey;
    }
    // 问核心：同一个待验收集合只问一次，再调用时返回还在路上的那次（挂载时等它）。
    private pending: Promise<void> = Promise.resolve();
    private loadGroups(list: Task[]): Promise<void> {
        const key = this.groupsKeyOf(list);
        if (key === this.groupsKey) return this.pending;
        this.groupsKey = key;
        this.pending = this.fetchGroups(list, key);
        return this.pending;
    }
    private async fetchGroups(list: Task[], key: string) {
        const gen = this.generation;
        const counts = new Map<string, number>();
        for (const t of list) counts.set(t.repo, (counts.get(t.repo) ?? 0) + 1);
        const next = new Map<string, OverlapGroup[]>();
        await Promise.all([...counts].filter(([, n]) => n > 1).map(async ([repo]) => {
            try {
                const result = await window.dock.console('tasks:overlaps', { project: repo }) as { groups?: OverlapGroup[] };
                const groups = (Array.isArray(result.groups) ? result.groups : []).filter(g => Array.isArray(g?.tasks) && Array.isArray(g.order) && typeof g.why === 'string');
                if (groups.length) next.set(repo, groups);
            }
            catch { /* 读不到就不分组，列表照旧。 */ }
        }));
        // 页面已经卸载 / 重新挂载：这次结果不要，下次再问；待验收集合又变了：另一次请求在路上，由它负责。
        if (gen !== this.generation) { if (this.groupsKey === key) this.groupsKey = ''; return; }
        if (key !== this.groupsKey) return;
        this.loadedKey = key;
        const before = JSON.stringify([...this.groups]);
        this.groups = next;
        if (before === JSON.stringify([...next])) return;
        const focus = this.focusKey();
        this.renderList(this.list());
        this.restoreFocus(focus);
    }
    // 列表里要成组显示的任务：核心给的组里至少有两个现在还在列表里的任务；组里按建议的批准顺序排。
    private overlapGroups(list: Task[]) {
        const byId = new Map(list.map(t => [t.id, t]));
        const found: { group: OverlapGroup; tasks: Task[] }[] = [];
        const used = new Set<string>();
        for (const [repo, groups] of this.groups) {
            for (const group of groups) {
                const tasks = group.order.map(id => byId.get(id)).filter((t): t is Task => !!t && t.repo === repo && !used.has(t.id));
                if (tasks.length < 2) continue;
                tasks.forEach(t => used.add(t.id));
                found.push({ group, tasks });
            }
        }
        return found;
    }

    // ---- 渲染 ----
    private render() {
        const main = this.root?.querySelector<HTMLElement>('.acc-main');
        if (!main) return;
        const focus = this.focusKey();
        // 整页重画会换掉"审查"标签里的说明框：先记下里面的文字与焦点，画完放回去。
        const reviewFocus = this.reviews.capture(this.root);
        const list = this.list(), t = this.current(list);
        if (t) this.selected = t.id;
        if (t && this.tab === 'review' && !t.review) this.tab = 'overview';
        this.signature = JSON.stringify([list.map(x => x.id), t && [t.id, t.status, t.wt, t.commit, t.minutes, t.gateOk, t.gateSummary, t.attempts?.length, t.review, t.reviewing]]);
        if (!t) {
            main.innerHTML = `<div class="empty">${icon('git-pull-request-line')}<b>${esc(w.emptyTitle)}</b><p>${esc(w.emptyHelp)}</p></div>`;
            return;
        }
        if (!main.querySelector('.split')) main.innerHTML = '<div class="split"><div class="edge"><div class="tlist scroll"></div></div><div class="detail acc"></div></div>';
        this.renderList(list);
        void this.loadGroups(list);
        this.renderDetail(t);
        void this.load(t);
        // 改动提前读：改动为空的任务要据此换成“确认”流程；读失败的任务不在每次刷新时重读（切到改动标签才重试）。
        if (this.tab === 'diff' || !this.diffs.has(this.key(t))) void this.loadDiff(t);
        this.restoreFocus(focus);
        this.reviews.restore(this.root, reviewFocus);
        this.applyHit(t, true);
        if (this.pendingJump?.id === t.id) { const jump = this.pendingJump; this.pendingJump = null; void this.jumpTo(t, jump.file, jump.line); }
    }
    private focusKey() {
        const el = document.activeElement;
        if (!(el instanceof HTMLElement) || !this.root?.contains(el)) return '';
        for (const name of ['acc', 'atab', 'accApprove', 'accConfirm', 'accReject', 'accRetry', 'accRebase', 'df', 'accMore']) if (name in el.dataset) return `${name}:${el.dataset[name]}`;
        return '';
    }
    private restoreFocus(key: string) {
        if (!key) return;
        const at = key.indexOf(':'), name = key.slice(0, at), value = key.slice(at + 1);
        const attr = name.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
        const selector = value ? `[data-${attr}="${CSS.escape(value)}"]` : `[data-${attr}]`;
        const el = this.root?.querySelector<HTMLElement>(selector);
        if (el && !(el as HTMLButtonElement).disabled) el.focus({ preventScroll: true });
    }
    private renderList(list: Task[]) {
        const box = this.root?.querySelector<HTMLElement>('.tlist');
        if (!box) return;
        const scroll = box.scrollTop;
        const row = (t: Task) => {
            const s = t.wt, mark = wtMark(t.wt ? (t.wt.phase === 'conflict' ? 'conflict' : 'awaiting') : null)!;
            const sub = s?.phase === 'conflict' ? `<em class="attn">${esc(w.subConflict(s.conflictFiles?.length ?? 0))}</em>` : esc(w.rowWaited(waitedSince(t)));
            return `<button class="trow ${t.id === this.selected ? 'on' : ''}" data-acc="${esc(t.id)}">${mark.html}<span class="tm"><b><span class="ttl">${esc(t.title)}</span></b><span>${listMeta(`<span class="xtag mono" title="${esc(executorLabel(t))}" data-executor="${esc(executorTag(executorLabel(t)))}">${esc(executorTag(executorLabel(t)))}</span>${attemptBadge(t)}${gateBadge(t)}`, reviewBadge(t), `${esc(t.repo.split(/[\\/]/).filter(Boolean).at(-1) ?? '')} · ${sub}`)}</span></span><span class="ts"><span class="mono">${clock(t.started)}</span></span></button>`;
        };
        // 互相重叠的待验收任务放在一组（组上方：标题、建议的批准顺序、核心给的原因），不重叠的照旧排在后面。
        const grouped = this.overlapGroups(list), inGroup = new Set(grouped.flatMap(g => g.tasks.map(t => t.id)));
        const groupHtml = grouped.map(({ group, tasks }) => `<div class="ovgroup" data-ov-group><div class="ovg-h"><b data-ov-title>${esc(w.overlapGroupTitle)}</b><span data-ov-order>${esc(w.overlapOrder(group.tasks.map(x => x.name).join(' → ')))}</span><span class="why" data-ov-why>${esc(group.why)}</span></div>${tasks.map(row).join('')}</div>`).join('');
        box.innerHTML = `<div class="tgroup">${esc(w.listGroup)}<span class="mono">${list.length}</span></div>${groupHtml}${list.filter(t => !inGroup.has(t.id)).map(row).join('')}`;
        box.scrollTop = scroll;
    }
    private tabItems(t: Task): [TabKey | 'review', string][] {
        const diff = this.diffs.get(this.key(t));
        // 只读运行的任务不会有改动（门禁不允许），数量直接是 0。
        const files = t.readOnly === true ? ' <span class="n">0</span>' : diff && 'data' in diff ? ` <span class="n">${diff.data.files.length}</span>` : '';
        return [['overview', w.tabs.overview], ['diff', w.tabs.diff + files], ['gate', w.tabs.gate], ['review', w.tabs.review]];
    }
    private renderDetail(t: Task) {
        const box = this.root?.querySelector<HTMLElement>('.detail.acc');
        if (!box) return;
        // 244：整个详情重画前先记下流水线的横向位置与节点焦点；renderHead() 重画轨道后恢复。
        captureTrack(box, 'accept');
        box.innerHTML = '<div class="dh"></div><div class="track-holder"></div><div class="dtabs"></div><div class="dbody edge"><div class="scroll" tabindex="0"><div class="tab-body"></div></div></div><div class="actbar"></div>';
        this.renderHead(t);
        this.renderTabs();
        this.renderBody();
        this.renderActions(t);
    }
    private renderHead(t: Task) {
        const box = this.root?.querySelector<HTMLElement>('.detail.acc');
        if (!box) return;
        const line = wtStateLine(t)!, mark = wtMark(t.wt?.phase === 'conflict' ? 'conflict' : 'awaiting')!;
        const file = gateFile(this.detailData.get(this.key(t))?.gate ?? null);
        const from = sha7(file?.base ?? t.wt?.base), to = sha7(file?.head ?? '');
        const commit = to ? `<span>${icon('git-commit-line')}<span class="mono">${esc(w.baseToHead(baseBranchOf(t), from, to))}</span></span>` : '';
        box.querySelector('.dh')!.innerHTML = `<div class="dh-1"><h2><span class="ttl">${esc(t.title)}</span></h2><span class="acts"><button class="btn icon quiet" data-acc-more data-tip="${esc(w.moreTip)}" aria-label="${esc(w.moreTip)}" aria-haspopup="menu">${icon('more-2-fill')}</button></span></div><div class="dh-2"><span class="dh-state ${line.cls}">${mark.html}${esc(line.text)}</span><span>${icon('folder-3-line')}${esc(t.repo.split(/[\\/]/).filter(Boolean).at(-1) ?? '')}</span><span>${icon('git-branch-line')}<span class="mono">${esc(t.wt?.branch ?? '')}</span></span>${commit}<span>${icon('robot-2-line')}<em>${c.executor}</em>${esc(executorLabel(t))}</span></div>`;
        const holder = box.querySelector<HTMLElement>('.track-holder')!;
        captureTrack(box, 'accept');
        holder.innerHTML = wtTrack(t, file);
        restoreTrack(box, 'accept', t.id);
    }
    private renderTabs() {
        const t = this.current();
        const bar = this.root?.querySelector<HTMLElement>('.detail.acc .dtabs');
        if (!t || !bar) return;
        const focused = document.activeElement instanceof HTMLElement && bar.contains(document.activeElement) ? document.activeElement.dataset.atab : undefined;
        // "审查"标签：有审查结果的任务可点；没有审查的任务仍是灰的，悬停提示"这个任务没有审查"。
        bar.innerHTML = `<div class="segm sm">${this.tabItems(t).map(([key, label]) => key === 'review' && !t.review
            ? `<button data-atab="review" disabled title="${esc(rv.none)}">${label}</button>`
            : `<button data-atab="${key}" class="${key === this.tab ? 'on' : ''}" aria-pressed="${key === this.tab}">${label}</button>`).join('')}</div>`;
        if (focused) bar.querySelector<HTMLElement>(`[data-atab="${focused}"]`)?.focus({ preventScroll: true });
    }
    private renderBody() {
        const t = this.current(), body = this.root?.querySelector<HTMLElement>('.detail.acc .tab-body');
        if (!t || !body) return;
        const scroller = body.parentElement!, top = scroller.scrollTop;
        const conflict = t.wt?.phase === 'conflict';
        const notice = this.blocked.get(t.id);
        // 顶部横幅：核心拒绝合并（什么都没改）、冲突；点"复制命令"把核心给的 git switch 命令写进剪贴板。
        const blockedButton = notice?.commit ? `<button class="btn sm" data-acc-commit>${icon('git-commit-line')}${esc(w.goCommit)}</button>` : notice?.copy ? `<button class="btn sm" data-acc-copy="${esc(notice.copy)}">${esc(w.copyCommand)}</button>` : '';
        const blocked = notice ? bannerHtml('fail', notice.title, notice.text, blockedButton) : '';
        const conflictBanner = conflict ? bannerHtml('fail', w.conflictTitle, w.conflictPageHelp(baseBranchOf(t), t.wt?.conflictFiles ?? [])) : '';
        if (this.tab === 'review' && !t.review) this.tab = 'overview';
        const content = this.tab === 'diff' ? this.diffView(t) : this.tab === 'gate' ? this.gateView(t) : this.tab === 'review' ? this.reviews.html(t) : this.overviewView(t);
        const researchBanner = !conflict && this.research(t) ? bannerHtml('info', w.researchTitle, w.researchHelp) : '';
        // 拦截模式下返工次数用完仍有高严重度问题（Stage08 158）：各标签顶部都有横幅。
        const needsHuman = this.reviews.needsHumanBanner(t);
        this.reviewSig = JSON.stringify([this.reviews.needsHuman(t), t.review, reviewerLabel(t.review?.reviewer ?? null)]);
        // 与别的待验收任务重叠的提示行（171）。
        // "审查"标签里有说明输入框：整块替换前后保住里面的文字与焦点。
        const focus = this.reviews.capture(body);
        body.innerHTML = repoBanner(t) + blocked + conflictBanner + needsHuman + researchBanner + overlapLines(t, this.host.tasks()) + content;
        this.reviews.restore(body, focus);
        this.applyHit(t, false);
        scroller.scrollTop = top;
    }
    private gateView(t: Task) {
        const data = this.detailData.get(this.key(t));
        if (!data) return `<div class="empty">${runm}<b>${esc(w.diffLoading)}</b></div>`;
        return gateTab(t, gateFile(data.gate), data.gate);
    }
    private overviewView(t: Task) {
        const data = this.detailData.get(this.key(t)), overview = this.overviews.get(this.key(t));
        const report = data?.report ?? '';
        // 目标：任务说明里"目标"的第一段；读不到时取汇报的第一段。
        const goal = overview?.goal ?? (report.split(/\r?\n\r?\n/).map(p => p.replace(/^#+\s.*$/gm, '').trim()).find(Boolean)?.replace(/\s+/g, ' ').slice(0, 300) ?? '');
        const list = (items: string[] | null | undefined, empty: string) => items?.length ? items.map(esc).join(' · ') : esc(empty);
        const spec = `<div class="specbox"><div class="sb-h">${icon('file-list-3-line')}<b>${esc(w.specBox)}</b><span class="mono muted">${esc(t.spec ?? c.direct)}</span><span class="sp"></span>${t.spec ? `<button class="btn sm quiet" data-acc-open="spec">${esc(c.open)}</button>` : ''}</div><p>${esc(goal)}</p><div class="sb-k"><span>${esc(w.specAllowed)}</span><span class="mono">${t.readOnly === true ? esc(w.specReadOnly) : list(overview?.allowed, overview?.allowed === null || !overview ? w.specNone : w.specAll)}</span></div><div class="sb-k"><span>${esc(w.specVerify)}</span><span class="mono">${list(overview?.verify, w.specNone)}</span></div></div>`;
        const file = gateFile(data?.gate ?? null);
        const commit = t.commit ?? sha7(file?.head ?? '');
        const sum = `<div class="sum">${commit ? `<span>${icon('git-commit-line')}<em>${c.commit}</em><span class="mono">${esc(commit)}</span></span>` : ''}<span>${icon('time-line')}<em>${c.elapsed}</em>${t.minutes ?? '—'} ${c.minutes}</span><span>${icon('robot-2-line')}<em>${c.executor}</em>${esc(executorLabel(t))}</span>${reviewSumItem(t)}<span class="sp"></span><button class="btn icon quiet" data-acc-open="report" data-tip="${c.openReport}" aria-label="${c.openReport}">${icon('external-link-line')}</button></div>`;
        const text = !data ? '' : report ? `<div class="md selectable">${markdown(report)}</div>` : `<div class="empty">${icon('file-text-line')}<b>${c.noReport}</b></div>`;
        return spec + sum + text;
    }
    private diffView(t: Task) {
        const state = this.diffs.get(this.key(t));
        if (!state || 'loading' in state) return `<div class="empty">${runm}<b>${esc(w.diffLoading)}</b></div>`;
        if ('error' in state) return `<div class="empty">${icon('file-copy-line')}<b>${esc(state.error)}</b></div>`;
        const { data } = state;
        if (!data.files.length) return `<div class="empty">${icon('file-copy-line')}<b>${esc(w.diffNone)}</b></div>`;
        const add = data.files.reduce((n, f) => n + f.additions, 0), del = data.files.reduce((n, f) => n + f.deletions, 0);
        const head = `<div class="sec-t">${esc(w.diffHead(data.files.length, add, del))} · <span class="mono">${esc(w.baseToHead(baseBranchOf(t), sha7(data.base), sha7(data.head)))}</span><span class="sp"></span><button class="btn sm quiet" data-acc-open="worktree">${icon('folder-open-line')}${esc(w.diffOpen)}</button></div>`;
        const open = this.expandedOf(t, data);
        const note = data.truncated ? `<div class="sec-t" data-diff-all-truncated>${esc(w.diffAllTruncated)}</div>` : '';
        return head + note + data.files.map((f, i) => this.fileView(f, i, open.has(i))).join('');
    }
    // 默认展开前两个文件；之后按用户的折叠 / 展开。
    private expandedOf(t: Task, data: DiffData) {
        const key = this.key(t);
        if (!this.expanded.has(key)) this.expanded.set(key, new Set(data.files.slice(0, 2).map((_, i) => i)));
        return this.expanded.get(key)!;
    }
    private fileView(f: DiffFile, i: number, open: boolean) {
        const tone = f.status === 'A' ? 'ok' : f.status === 'D' ? 'fail' : 'info';
        const renamed = f.oldPath ? `<span class="from">${esc(w.diffRenamed(f.oldPath))}</span>` : '';
        return `<div class="df" data-df-box="${i}"><button class="df-h" data-df="${i}" aria-expanded="${open}">${icon(open ? 'arrow-down-s-line' : 'arrow-right-s-line')}<span class="tag ${tone}">${esc(w.diffStatus[f.status] ?? f.status)}</span><span class="mono p">${esc(f.path)}</span>${renamed}<span class="cnt mono"><b class="a">+${f.additions}</b> <b class="d">−${f.deletions}</b></span></button>${open ? this.fileBody(f) : ''}</div>`;
    }
    private fileBody(f: DiffFile) {
        if (f.binary) return `<div class="df-b selectable"><div class="dnote">${esc(w.diffBinary)}</div></div>`;
        const rows = patchRows(f.patch ?? '');
        const note = f.truncated ? `<div class="dnote" data-diff-truncated>${esc(f.patch ? w.diffTruncated : w.diffAllTruncated)}</div>` : '';
        return `<div class="df-b selectable">${rows}${note}</div>`;
    }
    private renderActions(t: Task) {
        const bar = this.root?.querySelector<HTMLElement>('.detail.acc .actbar');
        if (!bar) return;
        const conflict = t.wt?.phase === 'conflict', base = baseBranchOf(t);
        const busy = this.busy?.id === t.id ? this.busy.kind : null, off = busy ? 'disabled' : '';
        const approve = busy === 'approve' ? `${runm}${esc(w.approving)}` : `${icon('git-merge-line')}${esc(w.approve)}`;
        const resolve = busy === 'rebase' ? `${runm}${esc(w.resolving)}` : `${icon('git-merge-line')}${esc(w.resolve)}`;
        // 调研 / 审查类任务没有改动可合并：主按钮是“确认”（不弹二次确认），驳回与重试照旧。
        const research = !conflict && this.research(t);
        const confirm = busy === 'confirm' ? `${runm}${esc(w.confirming)}` : `${icon('check-line')}${esc(w.confirm)}`;
        // 项目已从列表移除：批准合并、重试、合并主分支后重跑不可用（悬停提示同一句）；文件夹也不在了，驳回和确认同样不可用。
        const tip = ' data-tip="' + esc(c.projectGoneBlocked) + '"';
        const writeOff = off || (writeBlocked(t) ? 'disabled' + tip : ''), closeOff = off || (closeBlocked(t) ? 'disabled' + tip : '');
        const acts = conflict
            ? `<button class="btn" data-acc-reject="${esc(t.id)}" ${closeOff}>${esc(w.reject)}</button><button class="btn primary" data-acc-rebase="${esc(t.id)}" ${writeOff}>${resolve}</button>`
            : research
                ? `<button class="btn" data-acc-reject="${esc(t.id)}" ${closeOff}>${esc(w.reject)}</button><button class="btn" data-acc-retry="${esc(t.id)}" ${writeOff}>${icon('arrow-go-forward-line')}${esc(w.retry)}</button><button class="btn primary" data-acc-confirm="${esc(t.id)}" ${closeOff}>${confirm}</button>`
                : `<button class="btn" data-acc-reject="${esc(t.id)}" ${closeOff}>${esc(w.reject)}</button><button class="btn" data-acc-retry="${esc(t.id)}" ${writeOff}>${icon('arrow-go-forward-line')}${esc(w.retry)}</button><button class="btn primary" data-acc-approve="${esc(t.id)}" ${writeOff}>${approve}</button>`;
        const note = conflict ? w.noteConflict : research ? w.noteConfirm : t.wt?.mergeMode === 'squash' ? w.noteApproveSquash(base) : w.noteApprove(base);
        bar.innerHTML = `<span class="note">${esc(note)}</span>${acts}`;
    }

    // ---- 操作 ----
    private async click(e: MouseEvent) {
        const b = (e.target as Element).closest<HTMLElement>('button');
        if (!b || !this.root?.contains(b)) return;
        const d = b.dataset, t = this.current();
        if (d.acc !== undefined) { this.selected = d.acc; this.tab = 'overview'; this.hit = null; this.render(); return; }
        // 推送失败提示上的"去项目页"：告诉项目页下次进入时选中这个项目，再按侧栏"项目"（与用户点它同一条路径）。
        if (d.accGoProject) {
            selectProjectNext(d.accGoProject);
            document.querySelector<HTMLElement>('[data-page=projects]')?.click();
            return;
        }
        // 提示上的"撤销说明"：不依赖当前选中的任务。批准后与它重叠的任务会回到"门禁中"重跑，这时验收列表可能是空的（current 为空），点击不能被丢掉。
        if (d.accUndo) { void window.dock.action(t?.id ?? d.accTask ?? '', 'copy-text', d.accUndo).catch(notice); return; }
        if (!t) return;
        if (d.atab) {
            if (d.atab === 'review' && !t.review) return;
            this.hit = null;
            this.tab = d.atab as TabKey; this.renderTabs(); this.renderBody();
            if (this.tab === 'diff') void this.loadDiff(t);
            if (this.tab === 'review') void this.reviews.ensure(t);
            return;
        }
        // 轨道节点：门禁、审查节点切到对应标签；派发 / 执行 / 待验收 / 合并回到任务页对应的标签。
        if (b.classList.contains('node') && d.tab) {
            if (d.tab === 'gate') { this.tab = 'gate'; this.renderTabs(); this.renderBody(); }
            else if (d.tab === 'review' && t.review) { this.tab = 'review'; this.renderTabs(); this.renderBody(); void this.reviews.ensure(t); }
            else this.host.openTask(t.id, d.tab);
            return;
        }
        if (d.df !== undefined) { this.toggleFile(t, Number(d.df)); return; }
        if (d.gcmd !== undefined) {
            const open = b.getAttribute('aria-expanded') !== 'true';
            b.setAttribute('aria-expanded', String(open));
            const out = this.root.querySelector<HTMLElement>(`[data-gout="${CSS.escape(d.gcmd)}"]`), note = this.root.querySelector<HTMLElement>(`[data-gnote="${CSS.escape(d.gcmd)}"]`);
            if (out) out.hidden = !open;
            if (note) note.hidden = !open;
            return;
        }
        if (b.hasAttribute('data-acc-more')) {
            menu(b, [{ label: w.openWorktree, run: () => void this.action(t, 'worktree') }, { label: w.copyBranch, disabled: !t.wt?.branch, run: () => void this.action(t, 'copy-text', t.wt?.branch ?? '') }]);
            return;
        }
        if (d.readdProject !== undefined) {
            readdProject(t, this.repoChanged).catch(error => this.blocked.set(t.id, { title: w.failed, text: messageOf(error) })).finally(() => this.renderBody());
            return;
        }
        if (b.hasAttribute('data-acc-commit')) { void this.goCommit(t, b); return; }
        if (d.accOpen) { void this.action(t, d.accOpen); return; }
        if (d.accCopy) { void this.action(t, 'copy-text', d.accCopy); return; }
        if (d.accApprove) void this.approve(t, b);
        else if (d.accConfirm) void this.confirm(t);
        else if (d.accReject) this.rejectSheet(t, b);
        else if (d.accRetry) openRetrySheet({ t, trigger: b, failure: lastFailure(t, t.gateSummary ?? ''), gate: gateEnabled(t) });
        else if (d.accRebase) void this.rebase(t);
    }
    private action(t: Task, name: string, value?: string) {
        return window.dock.action(t.id, name, value).catch(notice);
    }
    // ---- 审查：点"文件:行"跳到改动 ----
    // 任务详情的"审查"标签要求来这里：选中这个任务（mount 已选）、切到改动并定位；详情还没画出来时等第一次 render 再做。
    openDiffAt(id: string, file: string, line: number | null) {
        const t = this.current();
        if (this.root && t?.id === id && this.root.querySelector('.detail.acc')) void this.jumpTo(t, file, line);
        else this.pendingJump = { id, file, line };
    }
    // 切到"改动"标签，等改动读到，展开这个文件，把这一行滚到视口中间并标出来。
    // 改动里没有这一行（审查者指的行不在改动里、文件被截断）时滚到文件开头并提示一句；没有这个文件时停在改动开头并提示。
    private async jumpTo(t: Task, file: string, line: number | null) {
        if (!this.root) return;
        const gen = this.generation, key = this.key(t);
        this.tab = 'diff';
        this.renderTabs();
        this.renderBody();
        void this.loadDiff(t);
        for (let i = 0; i < 400; i++) {
            const state = this.diffs.get(key);
            if (state && !('loading' in state)) break;
            await new Promise(resolve => setTimeout(resolve, 50));
            if (gen !== this.generation || this.current()?.id !== t.id) return;
        }
        const state = this.diffs.get(key);
        if (!this.root || !state || !('data' in state) || this.current()?.id !== t.id) return;
        const norm = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');
        const index = state.data.files.findIndex(f => norm(f.path) === norm(file));
        if (index < 0) { this.hit = null; toast(reviewHint); return; }
        this.expandedOf(t, state.data).add(index);
        this.tab = 'diff';
        this.hit = { id: t.id, file, line };
        this.renderTabs();
        this.renderBody();
        // 之后清单变了（别处写了确认等）整页重画时，render / renderBody 会按 this.hit 把标记与位置补回来。
        if (!this.applyHit(t, true) && line !== null) toast(reviewHint);
    }
    // 把 this.hit 指的那一行标出来（rv-hit）；scroll 为真时滚到视口中间，行不在改动里（审查者指的行超出改动）时滚到文件开头。返回这一行有没有找到。
    private applyHit(t: Task, scroll: boolean): boolean {
        const hit = this.hit, state = this.diffs.get(this.key(t));
        if (!hit || hit.id !== t.id || this.tab !== 'diff' || !this.root || !state || !('data' in state)) return false;
        const norm = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');
        const index = state.data.files.findIndex(f => norm(f.path) === norm(hit.file));
        const box = index < 0 ? null : this.root.querySelector<HTMLElement>(`[data-df-box="${index}"]`);
        if (!box) return false;
        this.root.querySelectorAll('.dl.rv-hit').forEach(el => el.classList.remove('rv-hit'));
        const row = hit.line === null ? undefined : [...box.querySelectorAll<HTMLElement>('.dl:not(.del):not(.hunk)')].find(el => el.querySelector('.no')?.textContent === String(hit.line));
        row?.classList.add('rv-hit');
        if (scroll) (row ?? box.querySelector<HTMLElement>('.df-h') ?? box).scrollIntoView({ block: row ? 'center' : 'start' });
        return !!row;
    }    // 折叠 / 展开一个文件：只改这一个文件的 DOM，滚动位置与焦点都不动。
    private toggleFile(t: Task, index: number) {
        const state = this.diffs.get(this.key(t));
        if (!state || !('data' in state)) return;
        const open = this.expandedOf(t, state.data), file = state.data.files[index];
        const box = this.root?.querySelector<HTMLElement>(`[data-df-box="${index}"]`);
        if (!file || !box) return;
        if (open.has(index)) open.delete(index); else open.add(index);
        const on = open.has(index);
        const header = box.querySelector<HTMLElement>('.df-h')!;
        header.setAttribute('aria-expanded', String(on));
        header.querySelector('i')!.className = `ri ri-${on ? 'arrow-down-s-line' : 'arrow-right-s-line'}`;
        box.querySelector('.df-b')?.remove();
        if (on) header.insertAdjacentHTML('afterend', this.fileBody(file));
    }
    private setBusy(busy: AcceptView['busy']) {
        this.busy = busy;
        const t = this.current();
        if (t) this.renderActions(t);
    }
    // 项目有远程时，批准确认框多一个"合并后推送到 <远程>"的勾选项，默认值取项目配置 push.afterAccept。
    // 读不到项目详情（或没有远程）时没有勾选项，也不传 push（核心按项目配置决定）。
    private async pushChoice(t: Task): Promise<{ remote: string; afterAccept: boolean } | null> {
        try {
            const r = await window.dock.console('projects:show', { path: t.repo }) as { project?: ProjectShow };
            const remote = r.project?.remote;
            if (!remote?.exists) return null;
            const push = (r.project?.config as { push?: { afterAccept?: unknown } } | null | undefined)?.push;
            return { remote: remote.name, afterAccept: push?.afterAccept === true };
        }
        catch { return null; }
    }
    private async approve(t: Task, trigger: HTMLElement) {
        if (this.busy || this.approving) return;
        const base = baseBranchOf(t), mode = t.wt?.mergeMode === 'squash' ? 'squash' : 'no-ff';
        this.approving = true;
        let option: ConfirmOption | undefined, remote = '';
        try {
            const choice = await this.pushChoice(t);
            if (choice) { remote = choice.remote; option = { label: w.approvePush(choice.remote), help: w.approvePushHelp, checked: choice.afterAccept }; }
            // 审查还有高 / 中问题没确认（Stage08 158）：确认框里多一句提示，不拦着批准。
            const unconfirmed = t.review ? (await this.reviews.load(t), this.reviews.unconfirmed(t)) : [];
            const asking = confirmAction(w.approveTitle(t.title, base), w.approveBody(mode, t.wt?.branch ?? ''), w.approve, trigger, false, option);
            if (unconfirmed.length) document.querySelector('.confirm-card #confirm-body')?.insertAdjacentHTML('afterend', `<p class="note" data-rv-approve-note>${esc(rv.approveUnconfirmed(unconfirmed.length, unconfirmed.map(issue => issue.id).join('、')))}</p>`);
            if (!await asking) return;
        }
        finally { this.approving = false; }
        this.blocked.delete(t.id);
        this.setBusy({ id: t.id, kind: 'approve' });
        this.renderBody();
        const from = sha7(gateFile(this.detailData.get(this.key(t))?.gate ?? null)?.head ?? '') || sha7(t.commit);
        try {
            const result = await window.dock.console('tasks:accept', { project: t.repo, name: t.name, ...(option ? { push: option.checked } : {}) }) as { merge?: string; mode?: string; conflict?: boolean; files?: string[]; push?: { ok: boolean; error?: string } };
            if (result.conflict) {
                // 冲突：核心已撤回合并并写 conflict 事件，快照随后把任务变成冲突状态（横幅与主按钮由状态决定）。
            }
            else {
                this.gone.add(t.id);
                // 合并本身已经成功：推送成功 / 失败只影响提示，任务照常离开验收列表。
                this.showToast(t, from, result.merge ?? '', result.mode === 'squash' ? 'squash' : 'no-ff', result.push ? { ...result.push, remote } : undefined);
            }
        }
        catch (error) {
            const text = messageOf(error), command = /git switch [^\s，。、]+/.exec(text)?.[0];
            // 主工作区有未提交的改动：横幅给"去提交"；不在主分支的拒绝照旧，只有"复制命令"。
            const dirtyMain = (error as { code?: unknown } | null)?.code === 'DIRTY_MAIN';
            this.blocked.set(t.id, { title: w.blockedTitle, text: w.blockedHelp(text), ...(dirtyMain ? { commit: true } : command ? { copy: command } : {}) });
        }
        this.busy = null;
        this.render();
    }
    // 横幅的"去提交"：打开项目页同一个提交弹窗；提交成功（或已经没有未提交的文件）后横幅消失，可以再点"批准并合并"。
    private async goCommit(t: Task, trigger: HTMLElement) {
        try {
            await openCommitSheet({ path: t.repo, trigger, onDone: () => { this.blocked.delete(t.id); this.renderBody(); } });
        }
        catch (error) { this.blocked.set(t.id, { title: w.failed, text: messageOf(error) }); this.renderBody(); }
    }
    // 确认（调研 / 审查类任务）：不合并、不改主分支，撤销风险很小，所以不弹二次确认框。
    private async confirm(t: Task) {
        if (this.busy) return;
        this.blocked.delete(t.id);
        this.setBusy({ id: t.id, kind: 'confirm' });
        this.renderBody();
        try {
            const result = await window.dock.console('tasks:accept', { project: t.repo, name: t.name, confirm: true }) as { merge?: string | null; mode?: string; conflict?: boolean };
            // 核心判断分支有新提交时会走合并（任务在界面显示之后又有了提交）：照合并的样子提示。
            if (!result.conflict) {
                this.gone.add(t.id);
                if (result.mode === 'confirm') this.showConfirmedToast(t);
                else this.showToast(t, sha7(t.commit), result.merge ?? '', result.mode === 'squash' ? 'squash' : 'no-ff');
            }
        }
        catch (error) {
            this.blocked.set(t.id, { title: w.blockedTitle, text: w.blockedHelp(messageOf(error)) });
        }
        this.busy = null;
        this.render();
    }
    private showConfirmedToast(t: Task) {
        const host = this.root?.querySelector<HTMLElement>('.acc-page');
        if (!host) return;
        host.querySelector('.toast')?.remove();
        clearTimeout(this.toastTimer);
        host.insertAdjacentHTML('beforeend', `<div class="toast" role="status">${okm}<span>${esc(w.confirmedToast(t.title))}</span></div>`);
        this.toastTimer = setTimeout(() => host.querySelector('.toast')?.remove(), 15000);
    }
    // push：批准时带了推送的结果。成功只换一句提示（撤销说明照旧）；失败换成"已合并，推送失败"，带"去项目页"（合并不受影响）。
    private showToast(t: Task, from: string, merge: string, mode: 'squash' | 'no-ff', push?: { ok: boolean; error?: string; remote: string }) {
        const host = this.root?.querySelector<HTMLElement>('.acc-page');
        if (!host) return;
        host.querySelector('.toast')?.remove();
        clearTimeout(this.toastTimer);
        const undo = w.undoText(sha7(merge), mode), base = baseBranchOf(t);
        const undoButton = `<button class="btn sm quiet" data-acc-undo="${esc(undo)}" data-acc-task="${esc(t.id)}">${esc(w.undoHelp)}</button>`;
        if (push && !push.ok) host.insertAdjacentHTML('beforeend', `<div class="toast long" role="status">${warnm}<span>${esc(w.mergedPushFailed(t.title, base, sha7(merge), push.error ?? ''))}</span><button class="btn sm quiet" data-acc-go-project="${esc(t.repo)}">${esc(w.goProject)}</button></div>`);
        else host.insertAdjacentHTML('beforeend', `<div class="toast" role="status">${okm}<span>${esc(push?.remote ? w.mergedPushed(t.title, base, push.remote) : w.mergedToast(t.title, base, from, sha7(merge)))}</span>${undoButton}</div>`);
        this.toastTimer = setTimeout(() => host.querySelector('.toast')?.remove(), 15000);
    }
    // 驳回弹窗（原因必填、可选保留分支）：验收页的“驳回”和任务页准备失败横幅的“驳回…”共用这一个。
    rejectSheet(t: Task, trigger: HTMLElement) {
        const base = baseBranchOf(t), branch = t.wt?.branch ?? '';
        const keep = `<button class="choice" role="checkbox" aria-checked="false" data-keep-branch><span class="cb"></span><span class="ct">${esc(w.rejectKeep(branch))}<span>${esc(w.rejectKeepHelp)}</span></span></button>`;
        const body = `<div class="form">${field(w.rejectReason, esc(w.rejectReasonHelp), `<textarea class="inp area" data-reject-reason rows="4" aria-label="${esc(w.rejectReason)}" placeholder="${esc(w.rejectPh)}"></textarea>`, true)}${keep}</div>`;
        let busy = false;
        const sheet = openSheet({
            title: w.rejectTitle(t.title), trigger, body, note: esc(w.rejectNote(base)), buttons: [c.cancel, w.rejectButton],
            onClose: () => busy ? false : undefined,
            onButton: async (index, s) => {
                if (index === 0) { if (!busy) s.close(); return; }
                if (busy || primary().disabled) return;
                busy = true;
                s.fail('');
                s.busy(true);
                primary().innerHTML = `${runm}${esc(w.rejecting)}`;
                try {
                    await window.dock.console('tasks:reject', { project: t.repo, name: t.name, reason: reason.value, keepBranch: keepButton.getAttribute('aria-checked') === 'true' });
                    busy = false;
                    s.close();
                    this.gone.add(t.id);
                    this.render();
                }
                catch (error) {
                    busy = false;
                    s.busy(false);
                    primary().textContent = w.rejectButton;
                    sync();
                    s.fail(messageOf(error));
                }
            },
        });
        const reason = sheet.root.querySelector<HTMLTextAreaElement>('[data-reject-reason]')!, keepButton = sheet.root.querySelector<HTMLButtonElement>('[data-keep-branch]')!;
        const buttons = () => [...sheet.root.querySelectorAll<HTMLButtonElement>('.sheet-btns button')];
        const primary = () => buttons()[1];
        // 驳回按钮用危险样式；原因空白时禁用。
        primary().classList.remove('primary');
        primary().classList.add('danger');
        const sync = () => { primary().disabled = busy || !reason.value.trim(); };
        sync();
        reason.addEventListener('input', sync);
        keepButton.addEventListener('click', () => {
            const on = keepButton.getAttribute('aria-checked') !== 'true';
            keepButton.setAttribute('aria-checked', String(on));
            const cb = keepButton.querySelector('.cb')!;
            cb.classList.toggle('on', on);
            cb.innerHTML = on ? icon('check-line') : '';
        });
        reason.focus({ preventScroll: true });
    }
    private async rebase(t: Task) {
        if (this.busy) return;
        this.blocked.delete(t.id);
        this.setBusy({ id: t.id, kind: 'rebase' });
        try { await window.dock.console('tasks:rebase', { project: t.repo, name: t.name }); }
        catch (error) { this.blocked.set(t.id, { title: w.failed, text: messageOf(error) }); }
        this.busy = null;
        this.render();
    }
}
