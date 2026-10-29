import { c, ro, rv } from '../shared/copy';
import { esc } from '../shared/markdown';
import { executorTag } from '../shared/executor';
import type { AgentPreset, AgentRow, ProjectRow, ReviewSettingsView, ReviewStatsRow, RolesView, RouteConfig, RouteProfile, RouteResult, RouteRule, RouteSuggestion, RouteTrial, Settings } from '../shared/types';
import { field, icon, menu, openSheet, toast, trace } from './ui';
import { probeModels } from './agents';

// 路由页（Stage07 O4）：规则 → 兜底 → 试算 → 每日上限 → 审查者候选。
// 所有读写都经 console 通道 route:*（核心的 ar route …），界面不直接碰 config.json。
// 设置类改动即时写入，没有保存按钮：先改本地状态并重画，再按顺序一条一条写；写失败时显示原因，并从核心重新读回真实状态。
const TYPES = Object.keys(ro.types);
// 需要只读的任务类型（与核心 router.mjs 的 READ_ONLY_TYPES 一致）。
const READ_ONLY_TYPES = ['research', 'review'];
const failure = (error: unknown) => String((error as Error)?.message || error);
const call = (action: string, payload?: Record<string, unknown>) => window.dock.console(action, payload);
const mark = (kind: 'ok' | 'fail' | 'brand', name: string) => `<span class="mk ${kind}">${icon(name)}</span>`;
const xtag = (label: string) => `<span class="xtag mono" title="${esc(label)}">${esc(executorTag(label))}</span>`;
const needsReadOnly = (types: string[]) => types.some(type => READ_ONLY_TYPES.includes(type));
const tokenText = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
// 今天已达上限（任务数或 token 任一达到）。
const limited = (p: RouteProfile) => !!(p.limits.maxTasksPerDay && p.usage.tasks >= p.limits.maxTasksPerDay || p.limits.maxTokensPerDay && p.usage.tokens >= p.limits.maxTokensPerDay);
// 今天已用的文字：任务数一定写，token 有用量或有上限时才写。
function usedText(p: RouteProfile) {
    let text = ro.usedTasks(p.usage.tasks, p.limits.maxTasksPerDay);
    if (p.usage.tokens > 0 || p.limits.maxTokensPerDay) text += ro.usedTokens(tokenText(p.usage.tokens), p.limits.maxTokensPerDay ? tokenText(p.limits.maxTokensPerDay) : null);
    return text;
}

// 路由结果的"规则说明"（试算与新建任务页共用）：规则命中写"全局 / 项目规则 N：类型"，其余按 trace 最后一行判断是任务说明指定、手动指定还是兜底。
// 规则的类型名从 trace 的"[a, b] → 执行者"里取（项目规则的内容不在 route config 里）。
export function routeWhy(result: Pick<RouteResult, 'rule' | 'trace'>): string {
    const last = result.trace.at(-1) ?? '';
    if (result.rule) {
        const types = (/\[([^\]]*)\]/.exec(last)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean).map(type => ro.types[type] ?? type).join('、');
        return ro.whyRule(result.rule.scope === 'project' ? ro.scopeProject : ro.scopeGlobal, result.rule.index, types);
    }
    if (last.startsWith('任务说明指定')) return ro.whySpec;
    if (last.startsWith('命令行指定')) return ro.whyExplicit;
    return ro.whyFallback;
}

// ---- 推理强度的选项（Stage07c T6，规则弹窗与新建任务表单共用）----
// 选项来自所选执行者：探针（144）查到所选模型的推理强度就用它，否则用预设的 effortOptions；预设声明 supportsEffort 为 false 的执行者不支持推理强度。
// 找预设的规则与核心 router.mjs 的 presetOf 一致：先按名字加适配器，再按适配器（Codex 再按有无 provider）。
// 预设摘要里没有通用适配器的程序名，所以通用适配器没有同名预设时找不到：按"支持、选项未知"处理。
export interface EffortInfo { supported: boolean; options: string[]; model: string | null }
export async function loadEfforts(known?: AgentRow[]): Promise<Map<string, EffortInfo>> {
    const [presets, agents, settings] = await Promise.all([
        call('agents:presets').then((r: { presets?: AgentPreset[] }) => r.presets ?? []).catch(() => [] as AgentPreset[]),
        known ? Promise.resolve(known) : call('agents:list').then((r: { agents?: AgentRow[] }) => r.agents ?? []).catch(() => [] as AgentRow[]),
        window.dock.preferences('settings').catch(() => null) as Promise<Settings | null>,
    ]);
    const map = new Map<string, EffortInfo>();
    for (const agent of agents) {
        const raw = (settings?.profiles?.[agent.name] ?? {}) as { provider?: unknown };
        const preset = presets.find(x => x.name === agent.name && x.adapter === agent.adapter)
            ?? (agent.adapter === 'generic' ? undefined : presets.find(x => x.adapter === agent.adapter && (agent.adapter !== 'codex' || (x.baseUrlOptions !== undefined) === (raw.provider != null))));
        map.set(agent.name, { supported: preset?.supportsEffort !== false, options: preset?.effortOptions ?? [], model: agent.model ?? null });
    }
    return map;
}
// 探针（Stage07c 144 的会话缓存，没有就查一次）里所选模型的推理强度；没查到或这个模型没给列表返回 null。
// 查过没查到的执行者 5 分钟内不再查（打开规则弹窗、新建任务页不该每次都去连接口）；查到的由 probeModels 的会话缓存直接给。
const probeMissedAt = new Map<string, number>();
export async function probedEfforts(name: string, model: string | null): Promise<string[] | null> {
    if (!model || Date.now() - (probeMissedAt.get(name) ?? 0) < 300000) return null;
    const { result } = await probeModels(name);
    if (!result.ok) { probeMissedAt.set(name, Date.now()); return null; }
    const levels = result.details?.find(d => d.id === model)?.efforts;
    return levels?.length ? levels : null;
}
// TODO(lead): 换执行者后推理强度被重置的提示（151 第 3 项），copy.ts 里还没有，先放占位。
export const effortResetNote = (old: string) => ro.effortReset(old);

// 从别的页面（导入向导、首次引导）跳到路由页并打开"建议规则"弹窗：置位后，下一次路由页加载完成时打开。
let suggestPending = false;
export function goToSuggest() {
    suggestPending = true;
    document.querySelector<HTMLButtonElement>('[data-page="routing"]')?.click();
}

export class RoutingView {
    private container?: HTMLElement;
    // 推理强度的选项：每次进入页面重新读；探针查到的按执行者名记在 probed 里。
    private efforts: Map<string, EffortInfo> | null = null;
    private effortsLoad?: Promise<void>;
    private probed = new Map<string, string[]>();
    private suggesting = false;
    private config: RouteConfig | null = null;
    // 现在的主导（ar roles --json 的 lead，D128）：路由页"与主导的模型家族不同"下面显示一行。
    private lead: RolesView['lead'] | null = null;
    private projects: ProjectRow[] = [];
    private error = '';
    private loading = false;
    private loadSeq = 0;
    private trial: { type: string; project: string; result: RouteTrial | null; open: boolean } = { type: 'code', project: '', result: null, open: false };
    private trialSeq = 0;
    // 写入按顺序一条一条做；pending 是还没做完的条数（最后一条做完才用核心返回的整份视图覆盖本地状态）。
    private queue: Promise<unknown> = Promise.resolve();
    private pending = 0;
    // 审查设置与准确率（Stage08 158，ar review config / stats）：每次进入页面重新读；读不到就不显示这一块。
    private reviewCfg: ReviewSettingsView | null = null;
    private reviewStats: ReviewStatsRow[] | null = null;
    private reviewQueue: Promise<unknown> = Promise.resolve();

    mount(container: HTMLElement) {
        this.container = container;
        this.error = '';
        this.loading = true;
        // 每次进入都重新读取：上次留下的配置和试算结果不能当成这次的显示。
        this.config = null;
        this.lead = null;
        this.reviewCfg = null;
        this.reviewStats = null;
        this.trial.result = null;
        this.efforts = null;
        this.effortsLoad = undefined;
        this.probed.clear();
        container.onclick = e => this.click(e);
        container.onkeydown = e => this.keys(e);
        container.addEventListener('focusout', this.onFocusOut);
        container.oninput = e => this.input(e);
        container.innerHTML = this.page();
        void this.load();
    }

    unmount() {
        const container = this.container;
        this.container = undefined;
        this.loadSeq++;
        this.trialSeq++;
        if (container) { container.onkeydown = null; container.removeEventListener('focusout', this.onFocusOut); container.oninput = null; }
    }

    private onFocusOut = (e: FocusEvent) => this.focusOut(e);

    // ---- 读取 ----
    private async load() {
        const token = ++this.loadSeq;
        try {
            const [config, list, reviewCfg, reviewStats, roles] = await Promise.all([call('route:config'), call('projects:list').catch(() => ({ projects: [] })), call('review:config').catch(() => null), call('review:stats').catch(() => null), call('roles:list').catch(() => null) as Promise<RolesView | null>]);
            if (token !== this.loadSeq || !this.container) return;
            this.config = config as RouteConfig;
            this.lead = roles?.lead ?? null;
            this.reviewCfg = reviewCfg?.review ?? null;
            this.reviewStats = Array.isArray(reviewStats?.reviewers) ? reviewStats.reviewers : null;
            this.projects = Array.isArray(list?.projects) ? list.projects : [];
            if (this.trial.project && !this.projects.some(p => p.path === this.trial.project)) this.trial.project = '';
            this.error = '';
        }
        catch (error) {
            if (token !== this.loadSeq || !this.container) return;
            this.error = failure(error);
        }
        this.loading = false;
        this.render();
        void this.runTrial();
        void this.ensureEfforts();
        // 从导入向导 / 首次引导跳来的：页面读好后直接打开"建议规则"。
        if (suggestPending) {
            suggestPending = false;
            const trigger = this.container?.querySelector<HTMLElement>('[data-ro-suggest]');
            if (trigger && this.config) void this.openSuggest(trigger);
        }
    }

    // 推理强度的选项（执行者列表、预设、配置）读一次，进入页面时开始读，规则弹窗打开时等它读完。
    private ensureEfforts(): Promise<void> {
        return this.effortsLoad ??= loadEfforts().then(map => { this.efforts = map; }, () => { this.efforts = new Map(); });
    }

    // 写入失败后回到核心里的真实状态（整页重画，输入框里没提交的内容也一并复位）。
    private async reload() {
        try {
            const config = await call('route:config') as RouteConfig;
            if (!this.container) return;
            this.config = config;
            this.render();
            void this.runTrial();
        }
        catch (error) {
            if (!this.container) return;
            this.error = failure(error);
            this.paintError();
        }
    }

    // ---- 写入 ----
    // 把一条写入排进队列；返回的 Promise 在这条写完后成功，核心拒绝时带着原因失败。
    private write(action: string, payload: Record<string, unknown>): Promise<void> {
        this.pending++;
        // 追踪（只在验收打开 data-ar-trace 时记录）：入队、开始调用核心、完成 / 失败，带队列里还没做完的条数。
        trace('route-write', { phase: 'queued', action, pending: this.pending });
        const run = this.queue.then(() => { trace('route-write', { phase: 'call', action, pending: this.pending }); return call(action, payload) as Promise<RouteConfig>; });
        this.queue = run.catch(() => undefined);
        return run.then(result => {
            this.pending--;
            trace('route-write', { phase: 'done', action, pending: this.pending });
            if (this.pending === 0 && this.container) this.settle(result);
        }, error => { this.pending--; trace('route-write', { phase: 'error', action, pending: this.pending, error: failure(error) }); throw error; });
    }

    // 即时写入的失败处理：显示核心给的原因，再读回真实状态。
    private fail(error: unknown) {
        this.error = failure(error);
        this.paintError();
        void this.reload();
    }

    // 最后一条写入做完：用核心返回的整份视图覆盖本地状态，重画受影响的部分；每日上限的输入框不动，只更新右边"今天已用"。
    private settle(result: RouteConfig) {
        this.config = result;
        this.error = '';
        this.paintError();
        this.renderSections(['rules', 'fallback', 'reviewers']);
        this.paintHead();
        this.paintUsed();
        void this.runTrial();
    }

    private async runTrial() {
        const seq = ++this.trialSeq;
        const payload: Record<string, unknown> = { type: this.trial.type };
        if (this.trial.project) payload.project = this.trial.project;
        let result: RouteTrial;
        try { result = await call('route:trial', payload) as RouteTrial; }
        catch (error) { result = { failed: true, code: null, error: failure(error), trace: [] }; }
        if (seq !== this.trialSeq || !this.container) return;
        this.trial.result = result;
        this.paintTrial();
    }

    // ---- 画 ----
    private defaultLabel() {
        const cfg = this.config;
        return cfg?.profiles.find(p => p.name === cfg.defaultProfile)?.label ?? cfg?.defaultProfile ?? '—';
    }
    private labelOf(name: string) { return this.config?.profiles.find(p => p.name === name)?.label ?? name; }

    private page() {
        const ready = !this.loading;
        const body = this.config ? ['rules', 'fallback', 'trial', 'limits', 'reviewers'].map(name => `<div class="sect" data-ro-sec="${name}">${this.section(name)}</div>`).join('') : '';
        return `<div class="doc scroll" data-ro-page data-ro-ready="${ready ? '1' : '0'}"><div class="page-h sticky"><h1>${esc(ro.title)}</h1><span class="lead">${esc(ro.lead)}</span><span class="sp"></span><span data-ro-head>${this.headHtml()}</span></div><div class="doc-in"><div class="ro-error" data-ro-error>${this.errorHtml()}</div>${body}</div></div>`;
    }

    private headHtml() {
        return this.config?.rules.length ? `<button class="btn" data-ro-add>${icon('add-line')}${esc(ro.addRule)}</button>` : '';
    }

    private errorHtml() {
        return this.error ? `<div class="banner fail" role="alert"><span class="mk fail">${icon('close-circle-line')}</span><span>${esc(this.error)}</span></div>` : '';
    }

    private section(name: string) {
        switch (name) {
            case 'rules': return this.rulesHtml();
            case 'fallback': return this.fallbackHtml();
            case 'trial': return this.trialHtml();
            case 'limits': return this.limitsHtml();
            default: return this.reviewersHtml();
        }
    }

    private rulesHtml() {
        const cfg = this.config!;
        const head = `<h2>${esc(ro.rulesSec)}</h2><p>${esc(ro.rulesLead)}</p>`;
        const suggest = (cls: string) => `<button class="btn ${cls}" data-ro-suggest>${icon('route-line')}${esc(ro.suggest)}</button>`;
        if (!cfg.rules.length)
            return `${head}<div class="card"><div class="empty short">${icon('route-line')}<b>${esc(ro.emptyTitle)}</b><p>${esc(ro.emptyHelp(this.defaultLabel()))}</p>${suggest('sm')}<button class="btn primary sm" data-ro-add-first>${icon('add-line')}${esc(ro.addFirst)}</button></div></div>${this.projectRulesHtml()}`;
        return `${head}<div class="card ro-list" data-ro-rules>${cfg.rules.map((rule, i) => this.ruleRow(rule, i)).join('')}</div><div class="ro-sug-row">${suggest('sm')}</div>${this.projectRulesHtml()}`;
    }

    private projectRulesHtml() {
        return (this.config?.projectRules ?? []).map(p => `<p class="ro-note muted" data-ro-project-rules>${icon('folder-3-line')}${esc(ro.projectRules(p.project, p.count))}</p>`).join('');
    }

    private ruleRow(rule: RouteRule, i: number) {
        const cfg = this.config!, profile = cfg.profiles.find(p => p.name === rule.profile), label = profile?.label ?? rule.profile, last = cfg.rules.length - 1;
        const states: string[] = [];
        if (!profile) states.push(`<span class="tag fail" data-ro-state="missing">${esc(ro.stateMissing)}</span>`);
        else {
            if (!profile.enabled) states.push(`<span class="tag" data-ro-state="disabled">${esc(ro.stateDisabled)}</span>`);
            if (needsReadOnly(rule.types) && !profile.readOnly) states.push(`<span class="tag" data-ro-state="no-read-only">${esc(ro.stateNoReadOnly)}</span>`);
            if (limited(profile)) states.push(`<span class="tag brand" data-ro-state="limited">${esc(ro.stateLimited)}</span>`);
        }
        const button = (name: string, act: string, text: string, disabled = false) => `<button class="btn icon quiet" aria-label="${esc(text)}" title="${esc(text)}" data-ro-act="${act}" data-ro-i="${i}" ${disabled ? 'disabled' : ''}>${icon(name)}</button>`;
        return `<div class="ro-row" data-ro-rule="${i}"><span class="ro-n mono">${i + 1}</span><span class="ro-types">${rule.types.map(type => `<span class="tag">${esc(ro.types[type] ?? type)}</span>`).join('')}</span><span class="ro-to">${icon('arrow-right-line')}${xtag(label)}<b>${esc(label)}</b>${rule.effort ? `<span class="tag mono" data-ro-effort="${esc(rule.effort)}" title="${esc(ro.ruleEffort)}">${esc(rule.effort)}</span>` : ''}${states.join('')}</span><span class="ro-esc muted">${esc(rule.escalate ? ro.escTo(this.labelOf(rule.escalate)) : ro.noEsc)}</span><span class="ro-act">${button('arrow-up-line', 'up', ro.moveUp(i + 1), i === 0)}${button('arrow-down-line', 'down', ro.moveDown(i + 1), i === last)}${button('edit-line', 'edit', ro.edit(i + 1))}${button('delete-bin-line', 'delete', ro.remove(i + 1))}</span></div>`;
    }

    private fallbackHtml() {
        const cfg = this.config!;
        const text = cfg.fallback ? this.labelOf(cfg.fallback) : ro.fallbackNone;
        const strong = cfg.strongExecutor ? this.labelOf(cfg.strongExecutor) : ro.strongNone;
        // 强执行者（Stage07c T8）：自动重试的最后一次改用它；和兜底一样，选中即写入。
        return `<h2>${esc(ro.fallbackSec)}</h2><div class="set"><div class="set-r"><div class="l">${esc(ro.fallback)}<span>${esc(ro.fallbackHelp(this.defaultLabel()))}</span></div><div class="ctl"><button class="sel" data-ro-fallback aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(`${ro.fallback}：${text}`)}"><span>${esc(text)}</span>${icon('arrow-down-s-line')}</button></div></div><div class="set-r"><div class="l">${esc(ro.strong)}<span>${esc(ro.strongHelp)}</span></div><div class="ctl"><button class="sel" data-ro-strong aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(`${ro.strong}：${strong}`)}"><span>${esc(strong)}</span>${icon('arrow-down-s-line')}</button></div></div></div>`;
    }

    private trialHtml() {
        const project = this.projects.find(p => p.path === this.trial.project);
        return `<h2>${esc(ro.trialSec)}</h2><p>${esc(ro.trialLead)}</p><div class="ro-trial"><div class="ro-trial-q"><span class="muted">${esc(ro.trialType)}</span><button class="sel" data-ro-trial-type aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(`${ro.trialType}：${ro.types[this.trial.type] ?? this.trial.type}`)}"><span>${esc(ro.types[this.trial.type] ?? this.trial.type)}</span>${icon('arrow-down-s-line')}</button><span class="muted">${esc(ro.trialProject)}</span><button class="sel" data-ro-trial-project aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(`${ro.trialProject}：${project?.name ?? ro.trialAny}`)}"><span>${esc(project?.name ?? ro.trialAny)}</span>${icon('arrow-down-s-line')}</button></div><div data-ro-trial-out>${this.trialOut()}</div></div>`;
    }

    // 试算结果（只重画这一块，不动上面的两个下拉）。
    private trialOut() {
        const result = this.trial.result;
        if (!result) return '';
        const trace = `<details class="ro-why" data-ro-why ${this.trial.open ? 'open' : ''}><summary data-ro-why-toggle>${icon('arrow-right-s-line')}${esc(ro.trialWhy)}</summary><ol class="mono" data-ro-trace>${result.trace.map(line => `<li>${esc(line)}</li>`).join('')}</ol></details>`;
        if (result.failed) return `<div class="ro-trial-r" data-ro-trial-result data-ro-failed="1">${mark('fail', 'close-circle-line')}<span><b>${esc(ro.trialFail)}</b><span class="muted">（${esc(result.error)}）</span></span></div>${trace}`;
        const line = esc(ro.trialResult(result.label)).replace(esc(result.label), `<b>${esc(result.label)}</b>`);
        return `<div class="ro-trial-r" data-ro-trial-result data-ro-trial-profile="${esc(result.profile)}">${mark('ok', 'checkbox-circle-line')}<span>${line}<span class="muted">（${esc(routeWhy(result))}）</span></span></div>${trace}`;
    }

    private limitsHtml() {
        const cfg = this.config!;
        const input = (p: RouteProfile, kind: 'tasks' | 'tokens') => {
            const value = kind === 'tasks' ? p.limits.maxTasksPerDay : p.limits.maxTokensPerDay, name = kind === 'tasks' ? ro.limitTasks : ro.limitTokens;
            return `<label class="ro-lim-f"><span>${esc(name)}</span><input class="inp mono" data-ro-limit="${esc(p.name)}" data-ro-kind="${kind}" inputmode="numeric" autocomplete="off" value="${value ?? ''}" placeholder="${esc(ro.limitNone)}" aria-label="${esc(`${p.label} ${name}`)}"></label>`;
        };
        const rows = cfg.profiles.map(p => `<div class="ro-lim-row" data-ro-lim="${esc(p.name)}">${xtag(p.label)}<b>${esc(p.label)}</b>${input(p, 'tasks')}${input(p, 'tokens')}<span class="ro-lim-used ${limited(p) ? 'hit' : ''}" data-ro-used="${esc(p.name)}">${this.usedHtml(p)}</span><span class="fhint fail ro-lim-err" data-ro-limit-error="${esc(p.name)}" role="alert" hidden></span></div>`).join('');
        return `<h2>${esc(ro.limitsSec)}</h2><p>${esc(ro.limitsLead)}</p><div class="card ro-lim-list" data-ro-limits>${rows}</div>`;
    }

    private usedHtml(p: RouteProfile) {
        return limited(p) ? `${mark('brand', 'error-warning-line')}<span>${esc(usedText(p))}</span><span class="tag brand">${esc(ro.stateLimited)}</span>` : esc(usedText(p));
    }

    private reviewersHtml() {
        const cfg = this.config!, listed = cfg.reviewer.profiles;
        const chips = listed.map((name, i) => `<span class="ro-rv-chip" data-ro-chip="${esc(name)}"><span class="mono muted">${i + 1}</span>${xtag(this.labelOf(name))}${esc(this.labelOf(name))}<button class="btn icon quiet sm" aria-label="${esc(ro.reviewRemove(this.labelOf(name)))}" title="${esc(ro.reviewRemove(this.labelOf(name)))}" data-ro-review-remove="${esc(name)}">${icon('close-line')}</button></span>`).join('');
        const candidates = cfg.profiles.filter(p => p.readOnly && !listed.includes(p.name));
        // 三个约束开关都可以关（D128）：mustDiffer（不能是执行者本人）、differFamily（与执行者不同家族）、differFromLead（与主导不同家族）。
        // 核心没写 differFamily 时它等于 mustDiffer；没写 differFromLead 时按开。
        const differ = cfg.reviewer.mustDiffer;
        const family = cfg.reviewer.differFamily ?? cfg.reviewer.mustDiffer;
        const lead = cfg.reviewer.differFromLead !== false;
        const choice = (attr: string, checked: boolean, title: string, help: string) => `<button class="choice" ${attr} role="checkbox" aria-checked="${checked}"><span class="cb ${checked ? 'on' : ''}">${checked ? icon('check-line') : ''}</span><span class="ct">${esc(title)}<span>${esc(help)}</span></span></button>`;
        // "现在的主导"（D128）：设了写显示名与家族，没设（或读不到）写默认的 Claude Code。
        const now = this.leadNow();
        return `<h2>${esc(ro.reviewSec)}</h2><p>${esc(ro.reviewLead)}</p><div class="ro-rv-list">${chips}<button class="btn sm" data-ro-review-add aria-haspopup="listbox" aria-expanded="false" ${candidates.length ? '' : 'disabled'}>${icon('add-line')}${esc(ro.reviewAdd)}</button></div>${choice('data-ro-differ', differ, ro.reviewDiffer, ro.reviewDifferHelp)}${choice('data-ro-differ-family', family, ro.reviewDifferFamily, ro.reviewDifferFamilyHelp)}${choice('data-ro-differ-lead', lead, ro.reviewDifferLead, ro.reviewDifferLeadHelp)}<p class="ro-note muted" data-ro-lead-now>${esc(now)}</p>${this.reviewSettingsHtml()}`;
    }

    // 现在的主导那一行：显示名按配置里的 label 写，家族用核心给的并集；全部未知时写"未知"。
    private leadNow() {
        const lead = this.lead;
        if (!lead || lead.source !== 'set' || !lead.profiles.length) return ro.leadNow(ro.leadDefault, 'claude');
        const names = lead.profiles.map(name => this.labelOf(name)).join('、');
        return ro.leadNow(names, lead.families.length ? lead.families.join('、') : '未知');
    }

    // 审查设置与准确率（界面稿 reviewSettings()）：开关、分段、下拉即时写入 ar review config set；准确率是 ar review stats 各严重度加起来的"已确认 / 成立"。
    private reviewSettingsHtml() {
        const cfg = this.reviewCfg;
        if (!cfg) return '';
        const row = (title: string, help: string, ctl: string) => `<div class="set-r"><div class="l">${esc(title)}<span>${esc(help)}</span></div><div class="ctl">${ctl}</div></div>`;
        const toggle = `<button class="toggle ${cfg.default ? 'on' : ''}" data-ro-rv-default role="switch" aria-checked="${cfg.default}" aria-label="${esc(rv.defaultAll)}"></button>`;
        const segment = `<div class="segm sm" role="group" aria-label="${esc(rv.block)}">${(['none', 'high'] as const).map(value => `<button data-ro-rv-block="${value}" class="${cfg.block === value ? 'on' : ''}" aria-pressed="${cfg.block === value}">${esc(rv.blockModes[value])}</button>`).join('')}</div>`;
        const blocking = cfg.block === 'high';
        const select = `<button class="sel" data-ro-rv-max aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(`${rv.maxReworks}：${cfg.maxReworks}`)}" ${blocking ? '' : 'disabled'}><span>${cfg.maxReworks}</span>${icon('arrow-down-s-line')}</button>`;
        const stats = this.reviewStats ?? [];
        const rows = stats.map(item => {
            const all = Object.values(item.severities).reduce((n, cell) => n + cell.confirmed, 0), ok = Object.values(item.severities).reduce((n, cell) => n + cell.valid, 0);
            const label = this.labelOf(item.reviewer);
            return `<div class="ro-acc-row" data-ro-rv-acc="${esc(item.reviewer)}">${xtag(label)}<b>${esc(label)}</b><span class="mono muted" data-ro-rv-acc-count>${esc(rv.accuracyRow(all, ok))}</span><b class="mono" data-ro-rv-acc-pct>${all ? Math.round(ok / all * 100) : 0}%</b></div>`;
        }).join('');
        const suggest = stats.filter(item => item.suggestBlock).map(item => `<p class="ro-note" data-ro-rv-suggest="${esc(item.reviewer)}">${esc(rv.suggestBlock(this.labelOf(item.reviewer)))}</p>`).join('');
        return `<div class="set ro-rv-set" data-ro-rv-set>${row(rv.defaultAll, rv.defaultAllHelp, toggle)}${row(rv.block, rv.blockHelp, segment)}${row(rv.maxReworks, rv.maxReworksHelp, select)}</div>`
            + `<div class="card ro-acc" data-ro-rv-acc-list><div class="ro-note muted ro-acc-h">${esc(rv.accuracy)}</div>${rows || `<div class="ro-note muted" data-ro-rv-acc-none>${esc(rv.accuracyNone)}</div>`}</div>${suggest}<p class="ro-note muted">${esc(rv.suggestBlockHelp)}</p>`;
    }

    // 审查设置即时写入：先改本地并重画，再按顺序写核心；失败时显示核心给的原因，并从核心读回真实的设置（等于恢复原值）。
    private setReview(change: Partial<ReviewSettingsView>, focus?: string) {
        const cfg = this.reviewCfg;
        if (!cfg) return;
        this.reviewCfg = { ...cfg, ...change };
        this.renderSections(['reviewers'], focus);
        const run = this.reviewQueue.then(() => call('review:config-set', change) as Promise<{ review?: ReviewSettingsView }>);
        this.reviewQueue = run.catch(() => undefined);
        void run.then(result => {
            if (!this.container) return;
            if (result.review) this.reviewCfg = result.review;
            this.error = '';
            this.paintError();
            this.renderSections(['reviewers']);
        }, async error => {
            if (!this.container) return;
            this.error = failure(error);
            this.paintError();
            try { this.reviewCfg = ((await call('review:config')) as { review?: ReviewSettingsView }).review ?? cfg; } catch { this.reviewCfg = cfg; }
            this.renderSections(['reviewers']);
        });
    }

    private render() {
        const container = this.container;
        if (!container?.isConnected) return;
        const scroller = container.querySelector<HTMLElement>('.doc'), top = scroller?.scrollTop ?? 0, focus = this.selectorOf(document.activeElement);
        container.innerHTML = this.page();
        const box = container.querySelector<HTMLElement>('.doc');
        if (box) box.scrollTop = top;
        if (focus) container.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
    }

    // 只重画指定的几节；焦点放回同一个控件（focus 给了就放到它上面，比如规则移动之后跟着那一条走）。
    private renderSections(names: string[], focus?: string) {
        const container = this.container;
        if (!container?.isConnected || !this.config) return;
        const keep = focus ?? this.selectorOf(document.activeElement);
        for (const name of names) {
            const el = container.querySelector<HTMLElement>(`[data-ro-sec="${name}"]`);
            if (el) el.innerHTML = this.section(name);
        }
        if (keep) container.querySelector<HTMLElement>(keep)?.focus({ preventScroll: true });
    }

    private paintHead() {
        const head = this.container?.querySelector<HTMLElement>('[data-ro-head]');
        if (head) head.innerHTML = this.headHtml();
    }

    private paintError() {
        const box = this.container?.querySelector<HTMLElement>('[data-ro-error]');
        if (box) box.innerHTML = this.errorHtml();
    }

    private paintTrial() {
        const out = this.container?.querySelector<HTMLElement>('[data-ro-trial-out]');
        if (out) out.innerHTML = this.trialOut();
    }

    // 每日上限一节：只更新右边"今天已用"，不动输入框（正在输入的内容和焦点都保留）。
    private paintUsed() {
        for (const p of this.config?.profiles ?? []) {
            const el = this.container?.querySelector<HTMLElement>(`[data-ro-used="${CSS.escape(p.name)}"]`);
            if (!el) continue;
            el.innerHTML = this.usedHtml(p);
            el.classList.toggle('hit', limited(p));
        }
    }

    private selectorOf(el: Element | null): string | null {
        if (!(el instanceof HTMLElement) || !this.container?.contains(el)) return null;
        const attrs = [...el.attributes].filter(a => a.name.startsWith('data-ro-'));
        return attrs.length ? `${el.tagName.toLowerCase()}${attrs.map(a => `[${a.name}="${CSS.escape(a.value)}"]`).join('')}` : null;
    }

    // ---- 输入 ----
    private click(e: MouseEvent) {
        const target = e.target as Element;
        const summary = target.closest<HTMLElement>('[data-ro-why-toggle]');
        if (summary && this.container?.contains(summary)) {
            e.preventDefault();
            this.trial.open = !this.trial.open;
            const details = summary.closest('details');
            if (details) details.open = this.trial.open;
            return;
        }
        const button = target.closest<HTMLButtonElement>('button');
        if (!button || button.disabled || !this.container?.contains(button) || !this.config) return;
        const d = button.dataset;
        if (d.roAdd !== undefined || d.roAddFirst !== undefined) { this.openRule(button, null); return; }
        if (d.roAct) { this.act(button, d.roAct, Number(d.roI)); return; }
        if (d.roSuggest !== undefined) { void this.openSuggest(button); return; }
        if (d.roFallback !== undefined) { this.chooseFallback(button); return; }
        if (d.roStrong !== undefined) { this.chooseStrong(button); return; }
        if (d.roTrialType !== undefined) { this.chooseTrialType(button); return; }
        if (d.roTrialProject !== undefined) { this.chooseTrialProject(button); return; }
        if (d.roReviewAdd !== undefined) { this.addReviewer(button); return; }
        if (d.roReviewRemove) { this.removeReviewer(d.roReviewRemove); return; }
        if (d.roRvDefault !== undefined && this.reviewCfg) { this.setReview({ default: !this.reviewCfg.default }, '[data-ro-rv-default]'); return; }
        if (d.roRvBlock && this.reviewCfg) {
            const block = d.roRvBlock === 'high' ? 'high' : 'none';
            if (block !== this.reviewCfg.block) this.setReview({ block }, `button[data-ro-rv-block="${block}"]`);
            return;
        }
        if (d.roRvMax !== undefined && this.reviewCfg) {
            const current = this.reviewCfg.maxReworks;
            menu(button, [0, 1, 2, 3, 4, 5].map(n => ({ label: String(n), run: () => { if (n !== current) this.setReview({ maxReworks: n }, '[data-ro-rv-max]'); } })), true);
            return;
        }
        if (d.roDiffer !== undefined) { this.setReviewer(this.config.reviewer.profiles, !this.config.reviewer.mustDiffer); return; }
        if (d.roDifferFamily !== undefined) {
            const family = this.config.reviewer.differFamily ?? this.config.reviewer.mustDiffer;
            this.setReviewer(this.config.reviewer.profiles, this.config.reviewer.mustDiffer, undefined, { differFamily: !family });
            return;
        }
        if (d.roDifferLead !== undefined) { this.setReviewer(this.config.reviewer.profiles, this.config.reviewer.mustDiffer, undefined, { differFromLead: this.config.reviewer.differFromLead === false }); return; }
    }

    // 规则一行里的四个按钮：上移、下移、编辑、删除。上移 / 下移之后焦点跟着那一条走；删除不用确认（规则可以重新添加）。
    private act(button: HTMLElement, act: string, i: number) {
        const cfg = this.config!, rules = cfg.rules.map(rule => ({ ...rule, types: [...rule.types] }));
        if (!Number.isInteger(i) || i < 0 || i >= rules.length) return;
        if (act === 'edit') { this.openRule(button, i); return; }
        if (act === 'up' || act === 'down') {
            const j = act === 'up' ? i - 1 : i + 1;
            if (j < 0 || j >= rules.length) return;
            [rules[i], rules[j]] = [rules[j], rules[i]];
            this.setRules(rules, `button[data-ro-act="${act === 'up' ? (j > 0 ? 'up' : 'down') : (j < rules.length - 1 ? 'down' : 'up')}"][data-ro-i="${j}"]`);
            return;
        }
        if (act === 'delete') {
            rules.splice(i, 1);
            this.setRules(rules, rules.length ? `button[data-ro-act="delete"][data-ro-i="${Math.min(i, rules.length - 1)}"]` : '[data-ro-add-first]');
        }
    }

    // 即时写入规则：先改本地、重画，再写核心。
    private setRules(rules: RouteRule[], focus?: string) {
        this.config!.rules = rules;
        this.renderSections(['rules'], focus);
        this.paintHead();
        this.write('route:rules', { rules }).catch(error => this.fail(error));
    }

    private chooseFallback(anchor: HTMLElement) {
        const cfg = this.config!;
        const items = [{ label: ro.fallbackNone, run: () => this.setFallback(null) }, ...cfg.profiles.filter(p => p.enabled || p.name === cfg.fallback).map(p => ({ label: p.label, run: () => this.setFallback(p.name) }))];
        menu(anchor, items, true);
    }

    private setFallback(name: string | null) {
        const cfg = this.config!;
        if (cfg.fallback === name) return;
        cfg.fallback = name;
        this.renderSections(['fallback']);
        this.write('route:fallback', { name }).catch(error => this.fail(error));
    }

    private chooseStrong(anchor: HTMLElement) {
        const cfg = this.config!;
        const items = [{ label: ro.strongNone, run: () => this.setStrong(null) }, ...cfg.profiles.filter(p => p.enabled || p.name === cfg.strongExecutor).map(p => ({ label: p.label, run: () => this.setStrong(p.name) }))];
        menu(anchor, items, true);
    }

    private setStrong(name: string | null) {
        const cfg = this.config!;
        if ((cfg.strongExecutor ?? null) === name) return;
        cfg.strongExecutor = name;
        this.renderSections(['fallback'], '[data-ro-strong]');
        this.write('route:strong', { name }).catch(error => this.fail(error));
    }

    // ---- 建议规则（Stage07c T5）----
    // 点"按我的执行者生成建议规则"：读 ar route suggest，弹窗里每条一个勾选项（默认全选）；"采用"把已有规则加上勾选的条目，经 route:rules 写入。
    private async openSuggest(trigger: HTMLElement) {
        if (this.suggesting || !this.config) return;
        this.suggesting = true;
        let result: RouteSuggestion;
        try { result = await call('route:suggest') as RouteSuggestion; }
        catch (error) { this.suggesting = false; if (this.container) { this.error = failure(error); this.paintError(); } return; }
        this.suggesting = false;
        if (!this.container) return;
        const items = (Array.isArray(result.rules) ? result.rules : []).map(rule => ({ types: [...rule.types], profile: rule.profile, why: rule.why, on: true }));
        const skipped = (Array.isArray(result.skipped) ? result.skipped : []).map(item => {
            const who = item.profile ? this.labelOf(item.profile) : (item.types ?? []).map(type => ro.types[type] ?? type).join('、');
            const types = item.profile && item.types?.length ? `（${item.types.map(type => ro.types[type] ?? type).join('、')}）` : '';
            return `${who}${types}：${item.why}`;
        }).join('；');
        const body = document.createElement('div');
        const row = (item: typeof items[number], i: number) => `<button class="choice" data-ro-sug="${i}" role="checkbox" aria-checked="${item.on}"><span class="cb ${item.on ? 'on' : ''}">${item.on ? icon('check-line') : ''}</span><span class="ct"><span class="ro-sug-t"><b>${esc(item.types.map(type => ro.types[type] ?? type).join('、'))}</b> → ${xtag(this.labelOf(item.profile))}${esc(this.labelOf(item.profile))}</span><span>${esc(item.why)}</span></span></button>`;
        body.innerHTML = `<p class="muted">${esc(ro.suggestLead)}</p>${items.length ? `<div class="card ro-sug" data-ro-suggest-list>${items.map(row).join('')}</div>` : `<p data-ro-suggest-none>${esc(ro.suggestNone)}</p>`}${skipped ? `<p class="muted" data-ro-suggest-skipped>${esc(ro.suggestSkipped(skipped))}</p>` : ''}`;
        const sync = () => {
            const n = items.filter(item => item.on).length, adopt = sheet.root.querySelector<HTMLButtonElement>('[data-sheet-btn="1"]');
            if (adopt) { adopt.textContent = ro.suggestAdopt(n); adopt.disabled = n === 0; }
        };
        const sheet = openSheet({
            title: ro.suggestTitle,
            trigger,
            body,
            note: esc(ro.suggestNote),
            buttons: [c.cancel, ro.suggestAdopt(items.length)],
            onButton: async (i, s) => {
                if (i === 0) { s.close(); return; }
                const chosen = items.filter(item => item.on);
                if (!chosen.length || !this.config) return;
                // 已有规则不动，勾选的条目加在最后。
                const rules = [...this.config.rules, ...chosen.map(({ types, profile }): RouteRule => ({ types, profile }))];
                s.busy(true);
                s.fail('');
                try { await this.write('route:rules', { rules }); }
                catch (error) { s.busy(false); sync(); s.fail(failure(error)); return; }
                s.close();
                toast(ro.suggestAdopted(chosen.length));
            },
        });
        sync();
        body.onclick = e => {
            const button = (e.target as Element).closest<HTMLButtonElement>('button[data-ro-sug]');
            if (!button || button.disabled || !body.contains(button)) return;
            const item = items[Number(button.dataset.roSug)];
            if (!item) return;
            item.on = !item.on;
            button.setAttribute('aria-checked', String(item.on));
            const cb = button.querySelector('.cb')!;
            cb.classList.toggle('on', item.on);
            cb.innerHTML = item.on ? icon('check-line') : '';
            sync();
        };
    }

    private chooseTrialType(anchor: HTMLElement) {
        menu(anchor, TYPES.map(type => ({ label: ro.types[type], run: () => { if (this.trial.type === type) return; this.trial.type = type; this.trial.result = null; this.renderSections(['trial']); void this.runTrial(); } })), true);
    }

    private chooseTrialProject(anchor: HTMLElement) {
        const pick = (path: string) => { if (this.trial.project === path) return; this.trial.project = path; this.trial.result = null; this.renderSections(['trial']); void this.runTrial(); };
        menu(anchor, [{ label: ro.trialAny, run: () => pick('') }, ...this.projects.map(p => ({ label: p.name, run: () => pick(p.path) }))], true);
    }

    private addReviewer(anchor: HTMLElement) {
        const cfg = this.config!, listed = cfg.reviewer.profiles;
        const items = cfg.profiles.filter(p => p.readOnly && !listed.includes(p.name)).map(p => ({ label: p.label, run: () => this.setReviewer([...listed, p.name], cfg.reviewer.mustDiffer) }));
        if (items.length) menu(anchor, items, true);
    }

    private removeReviewer(name: string) {
        const cfg = this.config!;
        this.setReviewer(cfg.reviewer.profiles.filter(item => item !== name), cfg.reviewer.mustDiffer, '[data-ro-review-add]');
    }

    // differFamily / differFromLead 只在点对应开关时带上；其余改动不带它们，核心保留已有的值。
    private setReviewer(profiles: string[], mustDiffer: boolean, focus?: string, change: { differFamily?: boolean; differFromLead?: boolean } = {}) {
        const kept = this.config!.reviewer;
        this.config!.reviewer = { profiles: [...profiles], mustDiffer, differFamily: change.differFamily ?? kept.differFamily ?? mustDiffer, differFromLead: change.differFromLead ?? kept.differFromLead ?? true };
        this.renderSections(['reviewers'], focus);
        const payload = { profiles, mustDiffer, ...(change.differFamily !== undefined ? { differFamily: change.differFamily } : {}), ...(change.differFromLead !== undefined ? { differFromLead: change.differFromLead } : {}) };
        this.write('route:reviewer', payload).catch(error => this.fail(error));
    }

    // 每日上限：输入框失去焦点或按回车时写入；非法值提示 ro.limitInvalid，不写配置。
    private keys(e: KeyboardEvent) {
        const input = (e.target as Element).closest<HTMLInputElement>('input[data-ro-limit]');
        if (input && e.key === 'Enter') { e.preventDefault(); this.commitLimit(input); }
    }

    private focusOut(e: FocusEvent) {
        const input = (e.target as Element).closest<HTMLInputElement>('input[data-ro-limit]');
        if (input && this.container?.contains(input)) this.commitLimit(input);
    }

    private input(e: Event) {
        const input = (e.target as Element).closest<HTMLInputElement>('input[data-ro-limit]');
        if (input) this.limitError(input, '');
    }

    private limitError(input: HTMLInputElement, text: string) {
        const el = this.container?.querySelector<HTMLElement>(`[data-ro-limit-error="${CSS.escape(input.dataset.roLimit ?? '')}"]`);
        if (!el) return;
        el.textContent = text;
        el.hidden = !text;
    }

    private commitLimit(input: HTMLInputElement) {
        const cfg = this.config;
        const profile = cfg?.profiles.find(p => p.name === input.dataset.roLimit), kind = input.dataset.roKind === 'tokens' ? 'tokens' : 'tasks';
        if (!cfg || !profile) return;
        const raw = input.value.trim();
        if (raw !== '' && !(/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)))) { this.limitError(input, ro.limitInvalid); return; }
        this.limitError(input, '');
        const value = raw === '' ? null : Number(raw), key = kind === 'tasks' ? 'maxTasksPerDay' : 'maxTokensPerDay';
        input.value = value === null ? '' : String(value);
        if (profile.limits[key] === value) return;
        profile.limits[key] = value;
        this.paintUsed();
        this.renderSections(['rules']);
        this.write('route:limit', { name: profile.name, [kind]: value }).catch(error => this.fail(error));
    }

    // ---- 添加 / 编辑规则 ----
    private openRule(trigger: HTMLElement, index: number | null) {
        const cfg = this.config!, editing = index === null ? null : cfg.rules[index];
        if (index !== null && !editing) return;
        const state = { types: new Set<string>(editing?.types ?? []), profile: editing?.profile ?? '', escalate: editing?.escalate ?? '', effort: editing?.effort ?? '', note: '' };
        const body = document.createElement('div');
        const workers = () => cfg.profiles.filter(p => (p.enabled || p.name === editing?.profile) && (!needsReadOnly([...state.types]) || p.readOnly));
        const escalations = () => cfg.profiles.filter(p => (p.enabled || p.name === editing?.escalate) && p.name !== state.profile);
        // 选中的执行者不再合适（比如刚选了调研）时换成第一个可选的；升级对象不能是它自己。
        const normalize = () => {
            const list = workers();
            if (!list.some(p => p.name === state.profile)) state.profile = (list.find(p => p.name === cfg.defaultProfile) ?? list[0])?.name ?? '';
            if (state.escalate && !escalations().some(p => p.name === state.escalate)) state.escalate = '';
        };
        normalize();
        const sel = (attr: string, text: string, label: string, disabled = false) => `<button class="sel" ${attr} aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}" ${disabled ? 'disabled' : ''}><span>${esc(text)}</span>${icon('arrow-down-s-line')}</button>`;
        const types = `<div class="ro-typepick" role="group" aria-label="${esc(ro.ruleTypes)}">${TYPES.map(type => `<button class="ro-tog ${state.types.has(type) ? 'on' : ''}" data-ro-type="${type}" aria-pressed="${state.types.has(type)}">${esc(ro.types[type])}</button>`).join('')}</div><span class="fhint fail" data-ro-types-hint role="alert" hidden>${esc(ro.ruleTypesRequired)}</span>`;
        // 推理强度（Stage07c T6）：选项来自所选执行者（探针查到的优先，否则预设的 effortOptions）；预设声明不支持推理强度的执行者，这一行隐藏，
        // 已经写了强度的规则换成这种执行者时在原位置显示一句"已忽略"（保存时不再写 effort）。执行者列表还没读完时先只有"不指定"。
        const info = (name: string) => this.efforts?.get(name);
        const optionsOf = (name: string) => this.probed.get(name) ?? info(name)?.options ?? [];
        const unsupported = () => info(state.profile)?.supported === false;
        const effortHtml = () => {
            if (unsupported()) return state.effort ? field(ro.ruleEffort, '', `<span class="muted" data-ro-effort-ignored>${esc(ro.effortUnsupported)}</span>`) : '';
            const note = state.note ? `<span class="fhint" data-ro-effort-note role="status">${esc(state.note)}</span>` : '';
            return field(ro.ruleEffort, esc(ro.ruleEffortHelp), sel('data-ro-sheet-effort', state.effort || ro.ruleEffortNone, ro.ruleEffort, !state.profile) + note);
        };
        body.innerHTML = `<div class="form">${field(ro.ruleTypes, esc(ro.ruleTypesHelp), types, true)}${field(ro.ruleTo, esc(ro.ruleToHelp), sel('data-ro-sheet-profile', this.labelOf(state.profile) || '—', ro.ruleTo, !state.profile), true)}<div data-ro-effort-box>${effortHtml()}</div>${field(ro.ruleEsc, esc(ro.ruleEscHelp), sel('data-ro-sheet-esc', state.escalate ? this.labelOf(state.escalate) : ro.noEsc, ro.ruleEsc))}</div>`;
        const paintEffort = () => { const box = body.querySelector<HTMLElement>('[data-ro-effort-box]'); if (box) box.innerHTML = effortHtml(); };
        // 换了执行者：当前强度不在新执行者的选项里（选项已知时）就换成"不指定"并提示一句；然后查探针，查到了就更新选项。
        const asked = new Set<string>();
        const probeNow = async () => {
            const name = state.profile, model = info(name)?.model ?? null;
            if (!name || !model || asked.has(name) || unsupported()) return;
            asked.add(name);
            const levels = await probedEfforts(name, model).catch(() => null);
            if (!levels || !body.isConnected) return;
            this.probed.set(name, levels);
            if (state.profile === name) paintEffort();
        };
        let shown = state.profile;
        const profileChanged = () => {
            state.note = '';
            const options = optionsOf(state.profile);
            if (state.effort && info(state.profile) && !unsupported() && !options.includes(state.effort)) { state.note = effortResetNote(state.effort); state.effort = ''; }
            paintEffort();
            void probeNow();
        };
        const paintSelects = () => {
            const profile = body.querySelector<HTMLButtonElement>('[data-ro-sheet-profile]'), esc2 = body.querySelector<HTMLElement>('[data-ro-sheet-esc] span');
            if (profile) { profile.disabled = !state.profile; profile.firstElementChild!.textContent = this.labelOf(state.profile) || '—'; }
            if (esc2) esc2.textContent = state.escalate ? this.labelOf(state.escalate) : ro.noEsc;
            if (state.profile !== shown) { shown = state.profile; profileChanged(); }
        };
        const hint = (show: boolean) => { const el = body.querySelector<HTMLElement>('[data-ro-types-hint]'); if (el) el.hidden = !show; };
        const sheet = openSheet({
            title: editing ? ro.ruleSheetEdit(index! + 1) : ro.ruleSheetAdd,
            trigger,
            body,
            note: editing ? '' : esc(ro.ruleNote),
            buttons: [c.cancel, editing ? ro.ruleSave : ro.ruleAdd],
            onButton: async (i, s) => {
                if (i === 0) { s.close(); return; }
                if (!state.types.size) { hint(true); body.querySelector<HTMLElement>('[data-ro-type]')?.focus({ preventScroll: true }); return; }
                if (!state.profile) return;
                // 不支持推理强度的执行者：强度已忽略，不再写进规则。
                const effort = unsupported() ? '' : state.effort;
                const rule: RouteRule = { types: TYPES.filter(type => state.types.has(type)), profile: state.profile, ...(effort ? { effort } : {}), ...(state.escalate ? { escalate: state.escalate } : {}) };
                const rules = index === null ? [...cfg.rules, rule] : cfg.rules.map((item, n) => n === index ? rule : item);
                s.busy(true);
                s.fail('');
                try { await this.write('route:rules', { rules }); }
                catch (error) { s.busy(false); s.fail(failure(error)); return; }
                s.close();
            },
        });
        body.onclick = e => {
            const button = (e.target as Element).closest<HTMLButtonElement>('button');
            if (!button || button.disabled || !body.contains(button)) return;
            const type = button.dataset.roType;
            if (type) {
                if (state.types.has(type)) state.types.delete(type); else state.types.add(type);
                button.classList.toggle('on', state.types.has(type));
                button.setAttribute('aria-pressed', String(state.types.has(type)));
                if (state.types.size) hint(false);
                normalize();
                paintSelects();
                return;
            }
            if (button.dataset.roSheetProfile !== undefined) {
                menu(button, workers().map(p => ({ label: p.label, run: () => { state.profile = p.name; normalize(); paintSelects(); } })), true);
                return;
            }
            if (button.dataset.roSheetEsc !== undefined) {
                menu(button, [{ label: ro.noEsc, run: () => { state.escalate = ''; paintSelects(); } }, ...escalations().map(p => ({ label: p.label, run: () => { state.escalate = p.name; paintSelects(); } }))], true);
                return;
            }
            if (button.dataset.roSheetEffort !== undefined) {
                // 第一项"不指定"；当前值不在选项里（旧规则、选项未知）时也列出来，免得打开就丢。
                const options = optionsOf(state.profile), listed = state.effort && !options.includes(state.effort) ? [state.effort, ...options] : options;
                const pick = (value: string) => () => { state.effort = value; state.note = ''; body.querySelector('[data-ro-sheet-effort] span')!.textContent = value || ro.ruleEffortNone; body.querySelector('[data-ro-effort-note]')?.remove(); };
                menu(button, [{ label: ro.ruleEffortNone, run: pick('') }, ...listed.map(value => ({ label: value, run: pick(value) }))], true);
            }
        };
        // 执行者列表、预设读完后补画推理强度一行（可能不支持），再查当前执行者的探针。
        void this.ensureEfforts().then(() => { if (!body.isConnected) return; paintEffort(); void probeNow(); });
        void sheet;
    }
}
