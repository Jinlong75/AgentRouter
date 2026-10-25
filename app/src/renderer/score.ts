import { c, sc } from '../shared/copy';
import type { AgentRow, Report, ReportAttempt, ReportBlame, ReportItem, ReportUsage, Task } from '../shared/types';
import { esc } from '../shared/markdown';
import { executorLabel } from '../shared/executor';
import { icon } from './ui';
import { bannerHtml } from './wt';

// 任务详情"评分"标签（链路报告第一版）：执行者与主导各一张卡片，下面是门禁失败归因和"综合分怎么算"。
// 分数、每项扣分、封顶、性能全部来自核心 ar report --json（tasks:report / tasks:blame），界面只排版，不自己算分。

// 用任务说明派发（start 带 gate 字段）且已经结束的任务（含待验收、冲突）才有评分标签；进行中的没有。
export const scoreVisible = (t: Task) => typeof t.gate === 'boolean' && t.status !== 'run';

const band = (n: number) => n >= 80 ? 'ok' : n >= 60 ? 'mid' : 'bad';
const message = (error: unknown) => String((error as Error)?.message ?? error);
// token 用 k 写法，一位小数；没有的那一项写 —。
const kilo = (n: number | null) => n === null ? '—' : `${(n / 1000).toFixed(1)}k`;
const usageText = (usage: ReportUsage) => sc.tokens(kilo(usage.input), kilo(usage.output));
const minutes = (ms: number) => `${(ms / 60000).toFixed(1)} ${c.minutes}`;
const money = (cost: { amount: number; currency: string }) => `${cost.currency === 'CNY' ? '¥' : cost.currency === 'USD' ? '$' : `${cost.currency} `}${cost.amount.toFixed(2)}`;
// 综合分怎么算：说明里提到的两处文件名与键名用等宽字，文字内容不变。
const howHtml = () => esc(sc.howText).replace(/config\.json|reportWeights/g, m => `<span class="mono">${m}</span>`);

interface State {
    sig: string;
    phase: 'loading' | 'ok' | 'error';
    report?: Report;
    error?: string;
    blameError?: string;
    busy?: boolean;
    stale?: boolean;
}
export interface ScoreHost {
    // 一张报告读完（或读失败）了，标签还开着就重画。
    changed(id: string): void;
    // 主导一节卡片头里的名字（派活方）。
    leadName(t: Task): string;
}

export class ScoreView {
    private states = new Map<string, State>();
    private labels = new Map<string, string>();
    private labelsLoaded = false;
    constructor(private host: ScoreHost) { }

    // 打开评分标签、换任务时调用：下次显示重新读一次（设置里的开关、价格等配置可能变了）；读到之前先显示上一次的结果。
    invalidate() { for (const state of this.states.values()) state.stale = true; }
    // 任务的结束状态变了（例如批准合并）就重新读；同一状态下反复重画不重复调用核心。
    private signature(t: Task) { return JSON.stringify([t.id, t.status, t.ended, t.exit, t.attempts?.length, t.wt]); }
    // 标签内容；还没读到时先给"正在计算…"并启动读取。
    html(t: Task): string {
        const sig = this.signature(t);
        let state = this.states.get(t.id);
        if (!state || state.sig !== sig || state.stale) {
            state = { sig, phase: state?.report ? 'ok' : 'loading', report: state?.report };
            this.states.set(t.id, state);
            void this.load(t, state);
        }
        if (state.phase === 'loading')
            return `<div class="empty" data-sc-loading><b>${esc(sc.loading)}</b></div>`;
        if (state.phase === 'error' || !state.report)
            return `<div class="empty" data-sc-unavailable>${icon('bar-chart-2-line')}<b>${esc(sc.unavailable)}</b><p>${esc(state.error ?? '')}</p></div>`;
        return this.body(t, state);
    }
    private async load(t: Task, state: State) {
        try {
            state.report = await window.dock.console('tasks:report', { project: t.repo, name: t.name }) as Report;
            state.phase = 'ok';
            state.error = undefined;
        }
        catch (error) {
            state.phase = 'error';
            state.error = message(error);
            state.report = undefined;
        }
        if (!this.labelsLoaded) {
            this.labelsLoaded = true;
            try {
                const result = await window.dock.console('agents:list');
                this.labels = new Map(((result?.agents ?? []) as AgentRow[]).map(a => [a.name, a.label]));
            }
            catch { /* 读不到执行者列表就显示配置名 */ }
        }
        if (this.states.get(t.id) === state)
            this.host.changed(t.id);
    }

    // 进度条的宽度等于分数：页面的内容安全策略不允许标记里写 style 属性，所以重画后用 CSSOM 设置。
    fit(root: HTMLElement) {
        for (const bar of root.querySelectorAll<HTMLElement>('[data-width]'))
            bar.style.width = `${bar.dataset.width}%`;
    }
    private profileName(t: Task, name: string) { return name === t.profile ? executorLabel(t) : this.labels.get(name) || name; }
    private body(t: Task, state: State) {
        const report = state.report!;
        const fails = report.attempts.filter(a => a.gate === false);
        const blame = fails.length
            ? `<div class="sec-t">${esc(sc.blameSec)}<span class="sp"></span><span class="muted">${esc(sc.blameHelp)}</span></div><div data-sc-error>${this.errorHtml(state)}</div>${fails.map(a => this.failRow(a)).join('')}`
            : '';
        return `<div class="cards2 sc-cards" data-sc-cards>${this.cards(t, report)}</div>${blame}<details class="sc-how" data-sc-how><summary>${icon('question-line')}${esc(sc.how)}</summary><p>${howHtml()}</p></details>`;
    }
    private cards(t: Task, report: Report) {
        const exec = report.executor, lead = report.lead;
        const first = report.attempts[0]?.profile ?? null;
        // "第 n 次升级"：自动重试里第一次换了执行者的那一次（核心的 detail 只写配置名）。
        const escalated = report.attempts.find(a => (a.reason === 'gate' || a.reason === 'agent') && a.profile !== first)?.n ?? 0;
        const token = (usage: ReportUsage | null, none: string) => usage ? usageText(usage) : none;
        const execPerf: [string, string, string][] = [
            ['time-line', sc.perfTime, minutes(exec.perf.ms)],
            ['cpu-line', sc.perfToken, token(exec.perf.usage, sc.noTokens)],
            ['wallet-3-line', sc.perfCost, exec.perf.cost ? money(exec.perf.cost) : sc.noPrice],
            ['tools-line', sc.perfTools, sc.toolCalls(exec.perf.toolCalls)],
        ];
        const leadPerf: [string, string, string][] = [
            ['time-line', sc.perfLeadTime, lead.perf.ms === null ? '—' : minutes(lead.perf.ms)],
            ...(lead.perf.awaitMs === null ? [] : [['hourglass-line', sc.perfAwait, minutes(lead.perf.awaitMs)] as [string, string, string]]),
            ['cpu-line', sc.perfToken, lead.perf.usage ? usageText(lead.perf.usage) : lead.perf.usageState === 'off' ? sc.leadUsageOff : sc.leadUsageUnavailable],
        ];
        const cap = exec.cap ? `<div class="sc-cap" data-sc-cap>${esc(exec.cap === 'failed' ? sc.capFailed : sc.capRejected)}</div>` : '';
        const who = exec.perf.profiles.map(name => this.profileName(t, name)).join(' → ');
        return this.card('executor', sc.executor, 'robot-2-line', who, exec.score, exec.items.map(i => this.row(i, 'executor', escalated)).join('') + cap, execPerf)
            + this.card('lead', sc.lead, 'user-line', this.host.leadName(t), lead.score, lead.items.map(i => this.row(i, 'lead', escalated)).join(''), leadPerf);
    }
    private card(role: string, title: string, iconName: string, who: string, score: number, rows: string, perf: [string, string, string][]) {
        const tone = band(score);
        return `<div class="card sc" data-sc-card="${role}"><div class="card-h">${icon(iconName)}<b>${esc(title)}</b><span class="muted">${esc(who)}</span><span class="aside"><span class="sc-n ${tone}" role="img" aria-label="${esc(sc.scoreLabel(score))}" data-sc-score>${score}</span><span>${esc(sc.outOf)}</span></span></div>`
            + `<div class="sc-bar"><span class="${tone}" data-width="${score}"></span></div><div class="card-b">${rows}</div>`
            + `<div class="sc-perf">${perf.map(([i, k, v]) => `<span>${icon(i)}<em>${esc(k)}</em>${esc(v)}</span>`).join('')}</div></div>`;
    }
    // 一项扣分：名称、明细、扣分；没扣分的行用次级色。
    private row(item: ReportItem, role: 'executor' | 'lead', escalated: number) {
        const name = role === 'lead' && item.key === 'needsScope' ? sc.leadNeedsScope : sc.items[item.key] ?? item.key;
        const detail = this.detail(item, role, escalated);
        const points = item.points ? `−${Math.abs(item.points)}` : '0';
        return `<div class="sc-r ${item.points ? '' : 'zero'}" data-sc-item="${role}:${esc(item.key)}"><span class="k">${esc(name)}</span><span class="v ${detail.includes('/') ? 'mono' : ''}" title="${esc(detail)}">${esc(detail)}</span><span class="p mono">${points}</span></div>`;
    }
    private detail(item: ReportItem, role: 'executor' | 'lead', escalated: number) {
        const { key, count } = item;
        if (key === 'rejected' || key === 'conflict') {
            // 不用 worktree 的任务没有验收，还没验收的任务不扣分（核心把原因写在 detail 里）。
            if (item.detail === sc.noAcceptance) return sc.noAcceptance;
            if (item.detail === sc.notYet) return sc.notYet;
            return count ? sc.yes : sc.none;
        }
        if (key === 'escalated') return count ? sc.escalatedAt(escalated) : sc.none;
        if (key === 'envBlame') return count ? sc.count(count) + sc.envFree : sc.none;
        if (key === 'needsScope')
            return role === 'executor' ? (count ? item.detail ?? sc.count(count) : sc.none) + sc.needsScopeFree : count ? sc.yes : sc.none;
        if (key === 'outsideFile' || key === 'protectedFile' || key === 'outsideWrites' || key === 'toolError')
            return count ? item.detail ?? (key === 'outsideWrites' ? sc.yes : sc.files(count)) : sc.none;
        // 其余按次数；任务说明次数统计不了时（没有基线、读不到 git 记录）核心把原因写在 detail 里，原样显示。
        return !count && item.detail ? item.detail : sc.count(count);
    }

    // 门禁失败归因：每次门禁未通过一行，分段控件是 radiogroup（方向键切换）。
    private failRow(a: ReportAttempt) {
        const radio = (who: ReportBlame, label: string) => {
            const on = (a.blame ?? 'worker') === who;
            return `<button class="${on ? 'on' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-blame-n="${a.n}" data-blame-who="${who}">${esc(label)}</button>`;
        };
        return `<div class="sc-f" data-sc-fail="${a.n}"><span class="mono">${esc(sc.blameRow(a.n))}</span><span class="why" title="${esc(sc.blameWhy(a.summary ?? '—'))}">${esc(sc.blameWhy(a.summary ?? '—'))}</span><div class="segm sm" role="radiogroup" aria-label="${esc(sc.blameLabel(a.n))}">${radio('worker', sc.blameWorker)}${radio('spec', sc.blameSpec)}${radio('environment', sc.blameEnv)}</div></div>`;
    }
    private errorHtml(state: State) { return state.blameError ? bannerHtml('fail', sc.blameFailed, state.blameError) : ''; }

    // 切换归因：调用核心后只重画两张卡片和各行的选中状态，焦点和滚动位置都不动。
    async blame(t: Task, n: number, who: ReportBlame, root: HTMLElement) {
        const state = this.states.get(t.id);
        if (!state?.report || state.busy || state.report.attempts.find(a => a.n === n)?.blame === who)
            return;
        state.busy = true;
        state.blameError = undefined;
        try {
            state.report = await window.dock.console('tasks:blame', { project: t.repo, name: t.name, n, who }) as Report;
        }
        catch (error) {
            state.blameError = message(error);
        }
        state.busy = false;
        this.paint(t, state, root);
    }
    private paint(t: Task, state: State, root: HTMLElement) {
        const report = state.report;
        if (!report || this.states.get(t.id) !== state)
            return;
        const cards = root.querySelector<HTMLElement>('[data-sc-cards]');
        if (cards) {
            cards.innerHTML = this.cards(t, report);
            this.fit(cards);
        }
        const error = root.querySelector<HTMLElement>('[data-sc-error]');
        if (error)
            error.innerHTML = this.errorHtml(state);
        for (const a of report.attempts) {
            for (const button of root.querySelectorAll<HTMLElement>(`[data-sc-fail="${a.n}"] [data-blame-who]`)) {
                const on = button.dataset.blameWho === (a.blame ?? 'worker');
                button.classList.toggle('on', on);
                button.setAttribute('aria-checked', String(on));
                button.tabIndex = on ? 0 : -1;
            }
        }
    }

    // 方向键在三个选项之间移动并选中（radiogroup 的通常行为）；返回是否处理了这次按键。
    key(e: KeyboardEvent, t: Task, root: HTMLElement) {
        const button = (e.target as Element | null)?.closest<HTMLElement>('[data-blame-n]');
        if (!button || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key))
            return false;
        e.preventDefault();
        const group = button.closest('[role=radiogroup]')!, buttons = [...group.querySelectorAll<HTMLElement>('[data-blame-who]')];
        const next = buttons[(buttons.indexOf(button) + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length];
        next.focus({ preventScroll: true });
        void this.blame(t, Number(next.dataset.blameN), next.dataset.blameWho as ReportBlame, root);
        return true;
    }
}
