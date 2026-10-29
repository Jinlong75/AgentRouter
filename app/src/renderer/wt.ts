import { worktreeState, type GateFile, type Task, type WtState } from '../shared/types';
import { c, gt, rv, wt as w } from '../shared/copy';
import { esc } from '../shared/markdown';
import { confirmAction, icon, toast } from './ui';
import { gateState, trackNode, trackParts } from './gate';

// worktree 任务（Stage06，协议第 15 节）的列表标记、第二行、状态行、五段轨道与进展顶部横幅。
// 只按快照里的 task.wt 与 gate.json 渲染；非 worktree 任务与旧任务不经过这里（worktreeState 返回 null）。
export const wtState = (t: Task): WtState | null => worktreeState(t);
// 待验收与冲突：需要人处理，验收页只列这两种，侧栏徽标与任务页"待验收"筛选也只数它们。
export const needsAccept = (t: Task) => { const s = worktreeState(t); return s === 'awaiting' || s === 'conflict'; };
// 这个任务批准后合并到哪个分支：派发时用 --base 指定的基线分支（136）优先，没指定的用项目配置的主分支。
export const baseBranchOf = (t: Task) => t.wt?.startBase ?? t.wt?.baseBranch ?? 'main';
export const sha7 = (value: string | null | undefined) => (value ?? '').slice(0, 7);
const clock = (n: number) => new Date(n).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const byName = (by: string) => w.by[by] ?? by;
const mmss = (ms: number) => { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
// 等待时长（已等 …）：不到 1 分钟 / N 分钟 / N.N 小时。
export function waitedText(ms: number) {
    const minutes = Math.max(0, ms) / 60000;
    return minutes < 1 ? '不到 1 分钟' : minutes < 60 ? `${Math.floor(minutes)} 分钟` : `${(minutes / 60).toFixed(1)} 小时`;
}
// 进入待验收后等了多久：待验收与冲突都从进入待验收的时刻算（没有这个时刻时从开始算）。
export const waitedSince = (t: Task, now = Date.now()) => waitedText(now - (t.wt?.awaitingAt ?? t.ended ?? t.started));

// 列表标记：每种状态一个图标；待验收与冲突用品牌色。运行中 / 门禁中 / 失败 / 中断沿用四态的标记。
const MARKS: Partial<Record<WtState, [string, string]>> = {
    queued: ['stale', 'time-line'], preparing: ['run', 'loader-4-line'], awaiting: ['brand', 'git-pull-request-line'], conflict: ['brand', 'error-warning-line'],
    accepted: ['ok', 'git-merge-line'], rejected: ['stale', 'close-circle-line'],
};
export function wtMark(state: WtState | null) {
    const m = state ? MARKS[state] : undefined;
    return m ? { cls: m[0], html: `<span class="mk ${m[0]}" title="${esc(w.state[state!] ?? '')}">${icon(m[1])}</span>` } : null;
}

// 列表第二行项目名之后的内容（html）：排队 / 待验收 / 冲突 / 已合并 / 已驳回；其余状态返回 null，由调用方按四态处理。
export function wtSub(t: Task): string | null {
    const s = worktreeState(t), wi = t.wt;
    if (!wi) return null;
    if (s === 'queued') return esc(w.subQueued(wi.ahead ?? 0));
    if (s === 'awaiting') return `<em class="attn">${esc(w.subAwaiting)}</em>`;
    if (s === 'conflict') return `<em class="attn">${esc(w.subConflict(wi.conflictFiles?.length ?? 0))}</em>`;
    if (s === 'accepted') return `${esc(w.subAccepted('\u0000')).replace('\u0000', `<span class="mono">${esc(sha7(wi.accepted?.merge))}</span>`)}`;
    if (s === 'rejected') return esc(w.subRejected);
    return null;
}

// 详情状态行：样式类 + 文字（html 的标记由调用方按状态补）。
export function wtStateLine(t: Task, now = Date.now()): { cls: string; text: string } | null {
    const s = worktreeState(t), wi = t.wt;
    if (!wi) return null;
    const by = (key: string | undefined) => byName(key ?? 'cli');
    if (s === 'queued') return { cls: 'stale', text: w.lineQueued(mmss(now - (wi.queuedAt ?? t.started))) };
    if (s === 'preparing') return { cls: 'run', text: w.linePreparing };
    if (s === 'awaiting') return { cls: 'brand', text: w.lineAwaiting(waitedSince(t, now)) };
    if (s === 'conflict') return { cls: 'brand', text: w.lineConflict(wi.conflictFiles?.length ?? 0) };
    if (s === 'accepted') {
        const reverted = revertedOf(t);
        return { cls: 'ok', text: reverted ? w.revertedState(sha7(reverted.commit), clock(reverted.at)) : w.lineAccepted(clock(wi.accepted?.at ?? 0), by(wi.accepted?.by)) };
    }
    if (s === 'rejected') return { cls: 'stale', text: w.lineRejected(clock(wi.rejected?.at ?? 0), by(wi.rejected?.by)) };
    return null;
}

// ---- 交叉审查（Stage08 158，界面稿 reviewBadge() / wtTrack() 里的"审查"节点）----
// 没有审查（没有 review 事件、也不在审查中）的任务以下几个函数都返回空，轨道与列表和以前完全一样。
// 审查进行中：reviewing 事件之后、review 事件之前，而且任务还没结束。
export const reviewingNow = (t: Task) => !!t.reviewing && t.status === 'run';
// 轨道上的"审查"节点：门禁与待验收之间；点它到"审查"标签。
export function reviewNode(t: Task): string {
    const r = t.review;
    // 审查进行中还没有结果：没有"审查"标签可去，点节点回到进展。
    if (reviewingNow(t)) return trackNode(rv.node, 'running', '', rv.nodeRunning, rv.nodeRunning, 'flow');
    if (!r) return '';
    const who = r.reviewer ? `（${r.reviewer}）` : '';
    const parts = r.verdict === 'pass' ? ['done', icon('check-line'), rv.nodePass, `${rv.verdict.pass}${who}`]
        : r.verdict === 'concerns' ? ['attn', '<span class="pip"></span>', rv.nodeIssues(r.issues), `${rv.badgeIssues(r.issues)}${who}`]
            : r.verdict === 'fail' ? ['failed', icon('close-line'), rv.nodeFail, `${rv.verdict.fail}${who}`]
                : ['skip', '', rv.nodeUnknown, rv.nodeHelpUnknown];
    return trackNode(rv.node, parts[0], parts[1], parts[2], parts[3], 'review');
}
// 列表第二行的审查徽标（跟在门禁徽标后面）：进行中 / 通过 / N 个问题 / 不通过 / 没审成。
// 188（D125）：不折行。宽时图标 + 文字，窄时（style.css 的容器查询）只剩图标，有问题数时再加数字（data-n）；
// 悬停提示与 aria-label 两种情况下都是全文（有问题数时 rv.badgeIssuesFull）。
export function reviewBadge(t: Task): string {
    const r = t.review;
    const badge = (cls: string, glyph: string, text: string, full = text, n: number | null = null) =>
        `<span class="gbadge rvb ${cls}" data-review-badge${n === null ? '' : ` data-n="${n}"`} role="img" title="${esc(full)}" aria-label="${esc(full)}">${icon(glyph)}<span class="rvb-t">${esc(text)}</span></span>`;
    if (reviewingNow(t)) return badge('running', 'loader-4-line', rv.nodeRunning);
    if (!r) return '';
    return r.verdict === 'pass' ? badge('ok', 'shield-check-line', rv.badge.pass)
        : r.verdict === 'concerns' ? badge('', 'error-warning-line', rv.badgeIssues(r.issues), rv.badgeIssuesFull(r.issues), r.issues)
            : r.verdict === 'fail' ? badge('fail', 'shield-cross-line', rv.badge.fail)
                : badge('', 'question-line', rv.badge.unknown);
}
// 列表第二行的内容：徽标在前（执行者标签、尝试、门禁、审查），项目名与状态在后。有审查徽标时徽标成一组、不收缩，
// 项目名与状态占剩下的宽度、在那里用省略号截断（style.css 的 .bds / .rest）：省略号不再和徽标抢位置，审查徽标不会被挤掉（158 已知问题，188）。
// 没有审查徽标的行保持原来的写法。
export const listMeta = (badges: string, review: string, rest: string) => review ? `<span class="bds">${badges}${review}</span><span class="rest">${rest}</span>` : badges + rest;
// 详情页"审查"标签：有审查结果的任务才有（没有审查的任务标签栏与以前一样）。
export const hasReviewTab = (t: Task) => !!t.review;

// 流水线轨道五段：派发 · 执行 · 门禁 · 待验收 · 合并（节点都是按钮，带 aria-label）；有审查的任务在门禁与待验收之间多一个"审查"节点。
export function wtTrack(t: Task, file: GateFile | null) {
    const s = worktreeState(t), wi = t.wt;
    if (!s || !wi) return '';
    const base = baseBranchOf(t), parts = trackParts(t, file, gateState(t) ?? 'off');
    const early = s === 'queued' || s === 'preparing';
    const exec = s === 'queued' ? ['todo', '', w.trackQueued, w.nodeQueued(wi.ahead ?? 0)]
        : s === 'preparing' ? ['running', '', w.trackPreparing, w.nodePreparing]
            : parts.exec;
    const gate = early ? ['todo', '', gt.trackGateWait, '执行者结束后运行', '等待'] : parts.gate;
    const acceptedBy = byName(wi.accepted?.by ?? 'cli'), mergeSha = sha7(wi.accepted?.merge);
    const awaiting: string[] = s === 'awaiting' ? ['attn', '<span class="pip"></span>', w.trackWaitYou, w.nodeAwaiting]
        : s === 'conflict' ? ['done', icon('check-line'), w.trackApproved, w.nodeApprovedConflict]
            : s === 'accepted' ? ['done', icon('check-line'), acceptedBy, w.nodeApprovedBy(acceptedBy)]
                : s === 'rejected' ? ['stopped', icon('close-line'), w.trackRejected, w.nodeRejected(wi.rejected?.reason ?? '')]
                    : ['todo', '', '', w.nodeAwaitPending];
    const merge: string[] = s === 'conflict' ? ['attn', '<span class="pip"></span>', w.trackConflict, w.nodeConflict(wi.conflictFiles ?? [])]
        : s === 'accepted' ? ['done', icon('git-merge-line'), mergeSha, w.nodeMerged(base, mergeSha)]
            : s === 'rejected' ? ['skip', '', w.trackNoMerge, w.nodeNoMerge]
                : ['todo', '', base, w.nodeMergePending(base)];
    const after = s === 'awaiting' || s === 'conflict' || s === 'accepted' || s === 'rejected';
    const link = (on: boolean) => `<span class="link ${on ? 'done' : ''}"></span>`;
    const gateDone = !early && (gateState(t) === 'ok' || gateState(t) === 'fail' || gateState(t) === 'running');
    const clockAt = clock(t.started);
    const review = reviewNode(t), reviewPart = review ? `${link(after || reviewingNow(t))}${review}` : '';
    return `<div class="track" role="group" aria-label="流水线">${trackNode(gt.track.dispatch, 'done', icon('check-line'), clockAt, `${clockAt} 派发`, 'params')}${link(true)}${trackNode(gt.track.run, exec[0], exec[1], exec[2], exec[3], 'flow')}${link(gateDone || after)}${trackNode(gt.track.gate, gate[0], gate[1], gate[2], `${gate[3]}，${gate[4]}`, (gateState(t) ?? 'off') === 'off' ? 'params' : 'gate')}${reviewPart}${link(after)}${trackNode(w.track.awaiting, awaiting[0], awaiting[1], awaiting[2], awaiting[3], 'flow')}${link(s === 'accepted' || s === 'conflict')}${trackNode(w.track.merge, merge[0], merge[1], merge[2], merge[3], 'flow')}</div>`;
}

// 横幅（结构同任务页已有的横幅）：kind 为 fail / info / brand / ok / stale。
const BANNER_MARK: Record<string, string> = {
    fail: `<span class="mk fail">${icon('close-circle-line')}</span>`, info: `<span class="mk info">${icon('information-line')}</span>`,
    brand: `<span class="mk brand">${icon('error-warning-line')}</span>`, ok: `<span class="mk ok">${icon('checkbox-circle-line')}</span>`,
    stale: `<span class="mk stale">${icon('stop-circle-line')}</span>`,
};
export const bannerHtml = (kind: string, title: string, text: string, button = '', extra = '') =>
    `<div class="banner ${kind}" role="${kind === 'fail' ? 'alert' : 'status'}">${BANNER_MARK[kind]}<div class="rt"><b>${esc(title)}</b><span>${esc(text)}</span>${extra}</div>${button}</div>`;
// 参数标签里模型、推理强度的来源（Stage07c 154、171，D81）：核心写的中文来源 → copy.ts 的 sourceLabels 键；命令行与环境变量都算单次派发。
// 不认识的来源返回 null（不写）。
export function sourceKey(source: string | null | undefined): string | null {
    if (!source) return null;
    if (source === '命令行' || source.startsWith('环境变量')) return 'cli';
    const keys: Record<string, string> = { '任务说明': 'spec', '路由规则': 'rule', 'config.json': 'profile', '内置默认': 'builtin', '升级链': 'escalate', '已忽略': 'ignored' };
    return keys[source] ?? null;
}
// 值后面的"（来自…）"；旧任务（没有 settingSources）、来源不认识都返回空串。
export function sourceNote(t: Task, which: 'model' | 'effort'): string {
    const key = sourceKey(t.settingSources?.[which]);
    return key && c.sourceLabels[key] ? c.fromSource(c.sourceLabels[key]) : '';
}
// 与待验收任务重叠的提示（Stage07c 154、171，D86）：每行一个 tag info。
// overlap-note 里的对方现在还是待验收 / 冲突时才写（合并或驳回之后提示作废）；被批准合并后自动重跑门禁的任务（resume.reason === after-merge），
// 重跑期间写 rebaseAfterMerge(刚合并的任务名)，重跑结束回到待验收后不再写（那句话说的是"正在重跑"）。tasks 是快照里的全部任务，用来查对方现在的状态与名字。
export function overlapLines(t: Task, tasks: Task[]): string {
    const wi = t.wt;
    if (!wi) return '';
    const waiting = new Set(tasks.filter(x => x.id !== t.id && needsAccept(x)).map(x => x.id));
    const texts = (wi.overlapNotes ?? []).filter(note => waiting.has(note.id)).map(note => c.overlapAwaiting(note.name));
    const merged = wi.rebaseAfter && t.status === 'run' ? tasks.find(x => x.id === wi.rebaseAfter) : undefined;
    if (merged) texts.push(c.rebaseAfterMerge(merged.name));
    return texts.map(text => `<div class="ovnote" data-overlap-note><span class="tag info" title="${esc(text)}">${esc(text)}</span></div>`).join('');
}
export const goAcceptButton = (t: Task) => `<button class="btn sm" data-go-accept="${esc(t.id)}">${esc(w.goAccept)}</button>`;

// 任务的项目现在的样子（Stage07 116）：ok = 还在项目列表里；gone = 已从项目列表移除（文件夹还在）；missing = 文件夹也没了。
// 由主进程的 tasks:repo-state 读出（只读），按仓库路径缓存；没读到之前按 ok，不提前锁按钮。
// 只有 worktree 任务关心它：驳回 / 确认不要求项目已登记，批准合并、重试、再派一次、合并主分支后重跑要。
export type RepoState = 'ok' | 'gone' | 'missing';
const repoStates = new Map<string, { state: RepoState; at: number; loading: boolean }>();
const repoKey = (repo: string) => repo.replace(/\\/g, '/').toLowerCase();
export const repoState = (t: Task): RepoState => (t.worktree ? repoStates.get(repoKey(t.repo))?.state : undefined) ?? 'ok';
// 项目页添加 / 移除项目后调用：缓存作废，下一次显示任务时重新读。
export const forgetRepoStates = () => repoStates.clear();
// 读一次这个任务的项目状态；状态变了才调用 changed（界面据此重画横幅与按钮）。同一仓库 3 秒内不重复读（force 除外）。
export function loadRepoState(t: Task, changed: () => void, force = false) {
    if (!t.worktree) return;
    const key = repoKey(t.repo), old = repoStates.get(key);
    if (old && !force && (old.loading || Date.now() - old.at < 3000)) return;
    repoStates.set(key, { state: old?.state ?? 'ok', at: Date.now(), loading: true });
    window.dock.console('tasks:repo-state', { project: t.repo, name: t.name }).then((r: { registered?: boolean; exists?: boolean }) => {
        const state: RepoState = r.exists === false ? 'missing' : r.registered === false ? 'gone' : 'ok';
        repoStates.set(key, { state, at: Date.now(), loading: false });
        if (state !== (old?.state ?? 'ok')) changed();
    }, () => { repoStates.set(key, { state: old?.state ?? 'ok', at: Date.now(), loading: false }); });
}
// 项目已移除 / 文件夹已不在的横幅（详情和验收页顶部）；已合并 / 已驳回的任务不需要，返回空。
export function repoBanner(t: Task): string {
    const s = repoState(t);
    const ws = worktreeState(t);
    if (s === 'ok' || ws === 'accepted' || ws === 'rejected') return '';
    return bannerHtml('brand', c.projectGoneTitle, s === 'missing' ? c.projectGoneMissing(t.repo) : c.projectGoneHelp(t.repo),
        s === 'gone' ? `<button class="btn sm" data-readd-project="${esc(t.id)}">${esc(c.projectGoneReAdd)}</button>` : '');
}
// 重新添加项目：走项目页同一条 projects:add；成功后马上重读（状态从 gone 变回 ok 时调用 changed）。
export async function readdProject(t: Task, changed: () => void) {
    await window.dock.console('projects:add', { path: t.repo });
    loadRepoState(t, changed, true);
}
// 项目已移除时要写项目的操作（批准合并、重试、再派一次、合并主分支后重跑）不可用；
// 文件夹不在时，驳回和确认也不可用（核心要在仓库里删 worktree 和分支）。
export const writeBlocked = (t: Task) => repoState(t) !== 'ok';
export const closeBlocked = (t: Task) => repoState(t) === 'missing';

// 撤销合并（Stage07b 129，D36）：已合并横幅上的“撤销这次合并…”。核心只追加一个反向提交（ar revert），界面不自己改任何文件。
// 进行中、冲突、失败只存在这个界面里（核心冲突时不写事件）；成功后核心写 reverted 事件，快照里的 wt.reverted 是最终来源，done 只是快照到来之前的过渡。
type RevertUi = { kind: 'busy' } | { kind: 'conflict'; files: string[] } | { kind: 'failed'; reason: string } | { kind: 'done'; commit: string; at: number };
const reverts = new Map<string, RevertUi>();
let revertShownFor = '';
// 这个任务的撤销界面状态；换到别的任务显示后，上一个任务的冲突 / 失败提示作废（回来时重新给出“撤销这次合并…”）。
function revertUi(t: Task): RevertUi | undefined {
    if (revertShownFor !== t.id) {
        const old = reverts.get(revertShownFor);
        if (old && (old.kind === 'conflict' || old.kind === 'failed')) reverts.delete(revertShownFor);
        revertShownFor = t.id;
    }
    return reverts.get(t.id);
}
// 已撤销的记录：先看快照，快照还没到时用刚收到的结果。
export function revertedOf(t: Task): { commit: string; at: number; by: string } | null {
    if (t.wt?.reverted) return t.wt.reverted;
    const ui = reverts.get(t.id);
    return ui?.kind === 'done' && t.wt?.phase === 'accepted' ? { commit: ui.commit, at: ui.at, by: 'human' } : null;
}
// 有合并提交（不是确认）、还没撤销的已合并任务才能撤销。
const revertable = (t: Task) => worktreeState(t) === 'accepted' && !!t.wt?.accepted?.merge && t.wt.accepted.mode !== 'confirm' && !revertedOf(t);
// 冲突时给用户在终端里处理的命令：no-ff 合并要 -m 1，squash 合并不要。
export const revertCommand = (t: Task) => w.undoText(t.wt?.accepted?.merge ?? '', t.wt?.accepted?.mode ?? 'no-ff');
const revertButton = (t: Task, busy: boolean) => {
    const blocked = writeBlocked(t);
    return `<button class="btn sm" data-revert-open="${esc(t.id)}" ${busy || blocked ? 'disabled' : ''}${blocked && !busy ? ` data-tip="${esc(c.projectGoneBlocked)}"` : ''}>${busy ? `<span class="mk run">${icon('loader-4-line')}</span>${esc(w.reverting)}` : esc(w.revertOpen)}</button>`;
};
// 点“撤销这次合并…”：确认框（默认焦点在“取消”）→ ar revert。changed 在状态变化时重画横幅与状态行。
export async function revertTask(t: Task, trigger: HTMLElement, changed: () => void) {
    if (reverts.get(t.id)?.kind === 'busy' || writeBlocked(t) || !revertable(t)) return;
    if (!await confirmAction(w.revertTitle(t.title), w.revertBody(baseBranchOf(t)), w.revertConfirm, trigger, true)) return;
    reverts.set(t.id, { kind: 'busy' });
    changed();
    try {
        const result = await window.dock.console('tasks:revert', { project: t.repo, name: t.name }) as { commit?: string; conflict?: boolean; files?: string[] };
        if (result.conflict) reverts.set(t.id, { kind: 'conflict', files: result.files ?? [] });
        else {
            reverts.set(t.id, { kind: 'done', commit: result.commit ?? '', at: Date.now() });
            toast(w.revertedToast(t.title, sha7(result.commit)));
        }
    }
    catch (error) {
        reverts.set(t.id, { kind: 'failed', reason: String((error as { message?: unknown } | null)?.message ?? error) });
    }
    changed();
}

// 进展顶部横幅：排队 / 准备 / 待验收 / 冲突 / 已合并 / 已驳回 / 准备失败；其余状态返回 null（用任务页已有的横幅）。
export function wtBanner(t: Task, limit: number): { html: string; replacesFailure: boolean } | null {
    // 每个任务的横幅都先过一遍：换到别的任务时，上一个任务的撤销冲突 / 失败提示在这里作废。
    const ui = revertUi(t);
    const s = worktreeState(t), wi = t.wt;
    if (!s || !wi) return null;
    const base = baseBranchOf(t), time = (n: number | undefined) => clock(n ?? 0), by = (key: string | undefined) => byName(key ?? 'cli');
    if (s === 'queued') {
        const why = wi.queuedWhy;
        // 按最近一条 queued 事件的原因换正文，后面都接“现在停止不会留下任何东西”；没有原因照旧是等名额的说明。
        const body = why?.reason === 'overlap' ? `${w.queuedOverlap(why.name ?? '', (why.paths ?? []).slice(0, 3).join('、'))}${w.queuedStopSafe}`
            : why?.reason === 'exclusive' ? `${w.queuedExclusive(why.name ?? '', why.command ?? '')}${w.queuedStopSafe}`
                // 机器忙：可用内存不够（memLow）写内存，其余写 CPU。
                : why?.reason === 'busy' ? `${why.memLow && why.freeGb !== undefined ? w.queuedBusyMem(why.freeGb.toFixed(1)) : w.queuedBusy(why.cpu ?? 0)}${w.queuedStopSafe}` : w.queuedHelp(limit, wi.ahead ?? 0);
        return { html: bannerHtml('info', w.queuedTitle, body), replacesFailure: false };
    }
    // 刚写 preparing、还没有 worktree 事件时没有分支名，正文说正在建 worktree。
    if (s === 'preparing') return { html: bannerHtml('info', w.preparingTitle, wi.branch ? w.preparingHelp(wi.branch, base) : w.preparingNoWorktree), replacesFailure: false };
    if (s === 'awaiting') return { html: bannerHtml('brand', w.awaitingTitle, w.awaitingHelp(base), goAcceptButton(t)), replacesFailure: false };
    if (s === 'conflict') return { html: bannerHtml('fail', w.conflictTitle, w.conflictHelp(base, wi.conflictFiles?.length ?? 0), goAcceptButton(t)), replacesFailure: true };
    if (s === 'accepted') {
        const note = wi.cleanupFailed ? `<span>${esc(w.acceptedCleanup)}</span>` : '';
        const reverted = revertedOf(t);
        if (reverted) return { html: bannerHtml('stale', w.revertedTitle, w.revertedHelp(sha7(wi.accepted?.merge), sha7(reverted.commit), time(reverted.at), by(reverted.by)), '', note), replacesFailure: false };
        if (ui?.kind === 'conflict') return { html: bannerHtml('fail', w.revertConflictTitle, w.revertConflictHelp(base, ui.files), `<button class="btn sm" data-revert-copy="${esc(t.id)}">${esc(w.copyCommand)}</button>`), replacesFailure: false };
        // 主工作区不干净等被拒绝的情况：原因是核心的中文原文；横幅上保留“撤销这次合并…”，处理好之后可以直接再试。
        // TODO(lead): 125（不用命令行的提交）合入后，核心错误码为 DIRTY_MAIN 时这里要加 wt.goCommit（“去提交”）按钮，打开同一个提交弹窗；现在还没有这个弹窗，先不放。
        if (ui?.kind === 'failed') return { html: bannerHtml('fail', w.revertFailedTitle, w.revertFailedHelp(ui.reason), revertButton(t, false)), replacesFailure: false };
        return { html: bannerHtml('ok', w.acceptedTitle(base), w.acceptedHelp(sha7(wi.accepted?.merge), time(wi.accepted?.at), by(wi.accepted?.by), wi.accepted?.mode ?? 'no-ff'), revertable(t) ? revertButton(t, ui?.kind === 'busy') : '', note), replacesFailure: false };
    }
    if (s === 'rejected') {
        const note = wi.cleanupFailed ? `<span>${esc(w.acceptedCleanup)}</span>` : '';
        return { html: bannerHtml('stale', w.rejectedTitle, w.rejectedHelp(wi.rejected?.reason ?? '', time(wi.rejected?.at), by(wi.rejected?.by), wi.rejected?.keptBranch ? wi.branch ?? null : null), '', note), replacesFailure: false };
    }
    // 准备失败：横幅右侧的“驳回…”打开验收页同一个驳回弹窗（验收页列表不收录准备失败的任务）。
    if (s === 'failed' && wi.setupFailed) return { html: bannerHtml('fail', w.setupFailTitle, w.setupFailHelp, `<button class="btn sm" data-setup-reject="${esc(t.id)}">${esc(w.setupFailReject)}</button>`), replacesFailure: true };
    return null;
}

// 进展里的两行分隔：worktree 建好、进入待验收（时间线样式，k-turn）。
const turnRow = (at: number | undefined, text: string) => `<div class="tl k-turn"><span class="t mono">${at ? clock(at) : ''}</span><div class="c">${esc(text)}</div></div>`;
export function wtHeadRow(t: Task) {
    const wi = t.wt;
    // 这次派发用 --base 指定了基线分支（136）才多一行；没指定的任务和以前完全一样。
    const base = wi?.startBase ? turnRow(t.started, w.baseBranchRow(wi.startBase)) : '';
    return base + (wi?.branch ? turnRow(wi.worktreeAt, w.worktreeRow(wi.branch, baseBranchOf(t), sha7(wi.base))) : '');
}
// 路由结果一行（样式同 worktreeRow），时间取任务开始时间；没有路由结果返回空。
export const routeHeadRow = (t: Task) => t.route ? turnRow(t.started, w.routeRow(t.route)) : '';
export function wtTailRow(t: Task) {
    const s = worktreeState(t);
    return s === 'awaiting' || s === 'accepted' || s === 'rejected' || s === 'conflict' ? (t.wt?.awaitingAt ? turnRow(t.wt.awaitingAt, w.awaitingRow) : '') : '';
}
