import { c, ro } from '../shared/copy';
import { esc } from '../shared/markdown';
import { executorTag } from '../shared/executor';
import type { ProjectRow, RouteConfig, RouteProfile, RouteResult, RouteRule, RouteTrial } from '../shared/types';
import { field, icon, menu, openSheet } from './ui';

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

export class RoutingView {
    private container?: HTMLElement;
    private config: RouteConfig | null = null;
    private projects: ProjectRow[] = [];
    private error = '';
    private loading = false;
    private loadSeq = 0;
    private trial: { type: string; project: string; result: RouteTrial | null; open: boolean } = { type: 'code', project: '', result: null, open: false };
    private trialSeq = 0;
    // 写入按顺序一条一条做；pending 是还没做完的条数（最后一条做完才用核心返回的整份视图覆盖本地状态）。
    private queue: Promise<unknown> = Promise.resolve();
    private pending = 0;

    mount(container: HTMLElement) {
        this.container = container;
        this.error = '';
        this.loading = true;
        // 每次进入都重新读取：上次留下的配置和试算结果不能当成这次的显示。
        this.config = null;
        this.trial.result = null;
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
            const [config, list] = await Promise.all([call('route:config'), call('projects:list').catch(() => ({ projects: [] }))]);
            if (token !== this.loadSeq || !this.container) return;
            this.config = config as RouteConfig;
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
        const run = this.queue.then(() => call(action, payload) as Promise<RouteConfig>);
        this.queue = run.catch(() => undefined);
        return run.then(result => {
            this.pending--;
            if (this.pending === 0 && this.container) this.settle(result);
        }, error => { this.pending--; throw error; });
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
        if (!cfg.rules.length)
            return `${head}<div class="card"><div class="empty short">${icon('route-line')}<b>${esc(ro.emptyTitle)}</b><p>${esc(ro.emptyHelp(this.defaultLabel()))}</p><button class="btn primary sm" data-ro-add-first>${icon('add-line')}${esc(ro.addFirst)}</button></div></div>${this.projectRulesHtml()}`;
        return `${head}<div class="card ro-list" data-ro-rules>${cfg.rules.map((rule, i) => this.ruleRow(rule, i)).join('')}</div>${this.projectRulesHtml()}`;
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
        return `<div class="ro-row" data-ro-rule="${i}"><span class="ro-n mono">${i + 1}</span><span class="ro-types">${rule.types.map(type => `<span class="tag">${esc(ro.types[type] ?? type)}</span>`).join('')}</span><span class="ro-to">${icon('arrow-right-line')}${xtag(label)}<b>${esc(label)}</b>${states.join('')}</span><span class="ro-esc muted">${esc(rule.escalate ? ro.escTo(this.labelOf(rule.escalate)) : ro.noEsc)}</span><span class="ro-act">${button('arrow-up-line', 'up', ro.moveUp(i + 1), i === 0)}${button('arrow-down-line', 'down', ro.moveDown(i + 1), i === last)}${button('edit-line', 'edit', ro.edit(i + 1))}${button('delete-bin-line', 'delete', ro.remove(i + 1))}</span></div>`;
    }

    private fallbackHtml() {
        const cfg = this.config!;
        const text = cfg.fallback ? this.labelOf(cfg.fallback) : ro.fallbackNone;
        return `<h2>${esc(ro.fallbackSec)}</h2><div class="set"><div class="set-r"><div class="l">${esc(ro.fallback)}<span>${esc(ro.fallbackHelp(this.defaultLabel()))}</span></div><div class="ctl"><button class="sel" data-ro-fallback aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(`${ro.fallback}：${text}`)}"><span>${esc(text)}</span>${icon('arrow-down-s-line')}</button></div></div></div>`;
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
        const on = cfg.reviewer.mustDiffer;
        return `<h2>${esc(ro.reviewSec)}</h2><p>${esc(ro.reviewLead)}</p><div class="ro-rv-list">${chips}<button class="btn sm" data-ro-review-add aria-haspopup="listbox" aria-expanded="false" ${candidates.length ? '' : 'disabled'}>${icon('add-line')}${esc(ro.reviewAdd)}</button></div><button class="choice" data-ro-differ role="checkbox" aria-checked="${on}"><span class="cb ${on ? 'on' : ''}">${on ? icon('check-line') : ''}</span><span class="ct">${esc(ro.reviewDiffer)}<span>${esc(ro.reviewDifferHelp)}</span></span></button>`;
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
        if (d.roFallback !== undefined) { this.chooseFallback(button); return; }
        if (d.roTrialType !== undefined) { this.chooseTrialType(button); return; }
        if (d.roTrialProject !== undefined) { this.chooseTrialProject(button); return; }
        if (d.roReviewAdd !== undefined) { this.addReviewer(button); return; }
        if (d.roReviewRemove) { this.removeReviewer(d.roReviewRemove); return; }
        if (d.roDiffer !== undefined) { this.setReviewer(this.config.reviewer.profiles, !this.config.reviewer.mustDiffer); return; }
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

    private setReviewer(profiles: string[], mustDiffer: boolean, focus?: string) {
        this.config!.reviewer = { profiles: [...profiles], mustDiffer };
        this.renderSections(['reviewers'], focus);
        this.write('route:reviewer', { profiles, mustDiffer }).catch(error => this.fail(error));
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
        const state = { types: new Set<string>(editing?.types ?? []), profile: editing?.profile ?? '', escalate: editing?.escalate ?? '' };
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
        body.innerHTML = `<div class="form">${field(ro.ruleTypes, esc(ro.ruleTypesHelp), types, true)}${field(ro.ruleTo, esc(ro.ruleToHelp), sel('data-ro-sheet-profile', this.labelOf(state.profile) || '—', ro.ruleTo, !state.profile), true)}${field(ro.ruleEsc, esc(ro.ruleEscHelp), sel('data-ro-sheet-esc', state.escalate ? this.labelOf(state.escalate) : ro.noEsc, ro.ruleEsc))}</div>`;
        const paintSelects = () => {
            const profile = body.querySelector<HTMLButtonElement>('[data-ro-sheet-profile]'), esc2 = body.querySelector<HTMLElement>('[data-ro-sheet-esc] span');
            if (profile) { profile.disabled = !state.profile; profile.firstElementChild!.textContent = this.labelOf(state.profile) || '—'; }
            if (esc2) esc2.textContent = state.escalate ? this.labelOf(state.escalate) : ro.noEsc;
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
                const rule: RouteRule = { types: TYPES.filter(type => state.types.has(type)), profile: state.profile, ...(state.escalate ? { escalate: state.escalate } : {}) };
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
            }
        };
        void sheet;
    }
}
