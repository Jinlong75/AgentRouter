import { worktreeState, type GateFile, type Task, type WtState } from '../shared/types';
import { gt, wt as w } from '../shared/copy';
import { esc } from '../shared/markdown';
import { icon } from './ui';
import { gateState, trackNode, trackParts } from './gate';

// worktree 任务（Stage06，协议第 15 节）的列表标记、第二行、状态行、五段轨道与进展顶部横幅。
// 只按快照里的 task.wt 与 gate.json 渲染；非 worktree 任务与旧任务不经过这里（worktreeState 返回 null）。
export const wtState = (t: Task): WtState | null => worktreeState(t);
// 待验收与冲突：需要人处理，验收页只列这两种，侧栏徽标与任务页"待验收"筛选也只数它们。
export const needsAccept = (t: Task) => { const s = worktreeState(t); return s === 'awaiting' || s === 'conflict'; };
export const baseBranchOf = (t: Task) => t.wt?.baseBranch ?? 'main';
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
    if (s === 'accepted') return { cls: 'ok', text: w.lineAccepted(clock(wi.accepted?.at ?? 0), by(wi.accepted?.by)) };
    if (s === 'rejected') return { cls: 'stale', text: w.lineRejected(clock(wi.rejected?.at ?? 0), by(wi.rejected?.by)) };
    return null;
}

// 流水线轨道五段：派发 · 执行 · 门禁 · 待验收 · 合并（节点都是按钮，带 aria-label）。
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
    return `<div class="track" role="group" aria-label="流水线">${trackNode(gt.track.dispatch, 'done', icon('check-line'), clockAt, `${clockAt} 派发`, 'params')}${link(true)}${trackNode(gt.track.run, exec[0], exec[1], exec[2], exec[3], 'flow')}${link(gateDone || after)}${trackNode(gt.track.gate, gate[0], gate[1], gate[2], `${gate[3]}，${gate[4]}`, (gateState(t) ?? 'off') === 'off' ? 'params' : 'gate')}${link(after)}${trackNode(w.track.awaiting, awaiting[0], awaiting[1], awaiting[2], awaiting[3], 'flow')}${link(s === 'accepted' || s === 'conflict')}${trackNode(w.track.merge, merge[0], merge[1], merge[2], merge[3], 'flow')}</div>`;
}

// 横幅（结构同任务页已有的横幅）：kind 为 fail / info / brand / ok / stale。
const BANNER_MARK: Record<string, string> = {
    fail: `<span class="mk fail">${icon('close-circle-line')}</span>`, info: `<span class="mk info">${icon('information-line')}</span>`,
    brand: `<span class="mk brand">${icon('error-warning-line')}</span>`, ok: `<span class="mk ok">${icon('checkbox-circle-line')}</span>`,
    stale: `<span class="mk stale">${icon('stop-circle-line')}</span>`,
};
export const bannerHtml = (kind: string, title: string, text: string, button = '', extra = '') =>
    `<div class="banner ${kind}" role="${kind === 'fail' ? 'alert' : 'status'}">${BANNER_MARK[kind]}<div class="rt"><b>${esc(title)}</b><span>${esc(text)}</span>${extra}</div>${button}</div>`;
export const goAcceptButton = (t: Task) => `<button class="btn sm" data-go-accept="${esc(t.id)}">${esc(w.goAccept)}</button>`;

// 进展顶部横幅：排队 / 准备 / 待验收 / 冲突 / 已合并 / 已驳回 / 准备失败；其余状态返回 null（用任务页已有的横幅）。
export function wtBanner(t: Task, limit: number): { html: string; replacesFailure: boolean } | null {
    const s = worktreeState(t), wi = t.wt;
    if (!s || !wi) return null;
    const base = baseBranchOf(t), time = (n: number | undefined) => clock(n ?? 0), by = (key: string | undefined) => byName(key ?? 'cli');
    if (s === 'queued') return { html: bannerHtml('info', w.queuedTitle, w.queuedHelp(limit, wi.ahead ?? 0)), replacesFailure: false };
    // 刚写 preparing、还没有 worktree 事件时没有分支名，正文说正在建 worktree。
    if (s === 'preparing') return { html: bannerHtml('info', w.preparingTitle, wi.branch ? w.preparingHelp(wi.branch, base) : w.preparingNoWorktree), replacesFailure: false };
    if (s === 'awaiting') return { html: bannerHtml('brand', w.awaitingTitle, w.awaitingHelp(base), goAcceptButton(t)), replacesFailure: false };
    if (s === 'conflict') return { html: bannerHtml('fail', w.conflictTitle, w.conflictHelp(base, wi.conflictFiles?.length ?? 0), goAcceptButton(t)), replacesFailure: true };
    if (s === 'accepted') {
        const note = wi.cleanupFailed ? `<span>${esc(w.acceptedCleanup)}</span>` : '';
        return { html: bannerHtml('ok', w.acceptedTitle(base), w.acceptedHelp(sha7(wi.accepted?.merge), time(wi.accepted?.at), by(wi.accepted?.by), wi.accepted?.mode ?? 'no-ff'), '', note), replacesFailure: false };
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
    return wi?.branch ? turnRow(wi.worktreeAt, w.worktreeRow(wi.branch, baseBranchOf(t), sha7(wi.base))) : '';
}
export function wtTailRow(t: Task) {
    const s = worktreeState(t);
    return s === 'awaiting' || s === 'accepted' || s === 'rejected' || s === 'conflict' ? (t.wt?.awaitingAt ? turnRow(t.wt.awaitingAt, w.awaitingRow) : '') : '';
}
