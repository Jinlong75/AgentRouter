// Agent 页"执行者"区：列出配置里的执行者，可以测试连接、编辑、设为默认、停用 / 启用、删除。
// 数据来自 console 通道的 agents:list（detect: true）；Codex 的编辑由 preferences.ts 复用设置控件，
// 其余执行者（claude-code）用通用模态框表单，保存走 agents:update。
import { ag, gx, p, c, ro } from '../shared/copy';
import { esc } from '../shared/markdown';
import type { AgentPreset, AgentRow, ProbeDetail, ProbeResult, RolesProfile, RolesView, RouteConfig, RouteProfile, Settings } from '../shared/types';
import { executorTag } from '../shared/executor';
import { icon, menu, confirmAction, openSheet, field, toast, type Sheet } from './ui';
import { bindChoices, choiceHtml, openCustomForm, type Choice, type ChoiceSpec, type Opt } from './agent-custom';
import { goToSuggest } from './routing';

const mark = (state: string) => `<span class="mk ${state}">${icon(({ ok: 'checkbox-circle-line', fail: 'close-circle-line', info: 'information-line', run: 'loader-4-line' } as Record<string, string>)[state])}</span>`;
const banner = (text: string) => text ? `<div class="banner fail" role="alert">${mark('fail')}<span>${esc(text)}</span></div>` : '';

// ---------- 模型与推理强度的探针（Stage07c T2 界面、T3）----------
// 下拉的选项来自 ar agents models <名> --probe（console 通道 agents:models，payload 带 probe: true；导入向导第 2 步导入之前带 preset，D102）：
// 查到时用 details 里的模型与各模型支持的推理强度；查不到时用预设的可选值，并在下拉下面写原因；右边"刷新列表"重新查。
// 结果在这次会话里按执行者名缓存（不写盘）：只缓存查到的，没查到的下次打开再查（原因可能已经变了，例如刚设置了密钥）。
export interface Probed { result: ProbeResult; at: string }
const probeCache = new Map<string, Probed>(), probeInflight = new Map<string, Promise<Probed>>();
const clockText = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// 恢复时间：当天写 HH:MM，别的日子带上月日（与核心 ar route config 的写法一致）。
const untilText = (ms: number) => {
    const date = new Date(ms), time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
};
export function probeModels(name: string, force = false): Promise<Probed> {
    const hit = force ? undefined : probeCache.get(name);
    if (hit) return Promise.resolve(hit);
    const running = probeInflight.get(name);
    if (running) return running;
    const job = (async (): Promise<Probed> => {
        let probed: Probed;
        // 通道出错（配置读不了、核心没返回）也按"没查到"处理，原因照实写。
        try { probed = { result: await window.dock.console('agents:models', { name, probe: true }) as ProbeResult, at: clockText() }; }
        catch (e) { probed = { result: { ok: false, source: 'preset', models: [], reason: String((e as Error).message || e) }, at: clockText() }; }
        if (probed.result.ok) probeCache.set(name, probed); else probeCache.delete(name);
        return probed;
    })().finally(() => { probeInflight.delete(name); });
    probeInflight.set(name, job);
    return job;
}
// 改了接口地址、密钥变量或保存了编辑之后，旧结果不再可信。
export const forgetProbe = (name: string) => { probeCache.delete(name); };

// 导入之前查（D102，导入向导第 2 步）：core 的 ar agents models --preset … --probe，经 agents:models（payload 带 preset 与 probe: true）。
// 每次都真查（不缓存）：同一张表单里接口地址、密钥变量一变就是另一个问题。
export interface PresetQuery { preset: string; baseUrl?: string; secretVar?: string; auth?: 'login' | 'token'; model?: string }
export const queryPresetModels = async (query: PresetQuery): Promise<Probed> => {
    try { return { result: await window.dock.console('agents:models', { ...query, probe: true }) as ProbeResult, at: clockText() }; }
    catch (e) { return { result: { ok: false, source: 'preset', models: [], reason: String((e as Error).message || e) }, at: clockText() }; }
};

// 一个表单里模型 / 推理强度下拉共用的探针状态。给了 skip（不查询的原因）时不发查询，说明里写 skip。
// 两种对象：name（已导入的执行者，ar agents models <名> --probe）或 preset（导入之前，ar agents models --preset … --probe，
// 由 preset() 给出这一刻的预设与参数；key 是问题的指纹，指纹变了旧结果作废，要用户点"刷新列表"重查）。
export interface PresetSource { query: () => PresetQuery; key: () => string }
export class ProbeBox {
    loading = false;
    probed: Probed | null = null;
    // 旧结果因问题变了而作废（只在导入之前的查询里出现）。
    stale = false;
    private asked: string | null = null;
    private seq = 0;
    constructor(public readonly name: string | null, private changed: () => void, public skip = '', private source?: PresetSource) {}
    get queryable() { return (!!this.name || !!this.source) && !this.skip; }
    load(force = false) {
        if (!this.queryable) return;
        const seq = ++this.seq;
        this.loading = true; this.stale = false;
        let job: Promise<Probed>;
        if (this.source) { this.asked = this.source.key(); job = queryPresetModels(this.source.query()); }
        else job = probeModels(this.name!, force);
        void job.then(p => { if (seq === this.seq) this.probed = p; }).finally(() => { if (seq === this.seq) this.loading = false; this.changed(); });
    }
    // 重画前对一下指纹：问题变了就丢掉旧结果（包括还在路上的），等用户点"刷新列表"。
    sync() {
        if (!this.source || this.asked === null || this.asked === this.source.key()) return;
        this.seq++; this.asked = null; this.probed = null; this.loading = false; this.stale = true;
    }
    private get details(): ProbeDetail[] { return this.probed?.result.ok ? this.probed.result.details ?? [] : []; }
    // 模型下拉的选项：查到时用探针的（附显示名），否则用预设的可选值。
    modelOpts(fallback: string[]): Opt[] { return this.details.length ? this.details.map(d => ({ value: d.id, ...(d.name ? { desc: d.name } : {}) })) : fallback.map(value => ({ value })); }
    // 所选模型支持的推理强度；探针没给就是 undefined（用预设的 effortOptions）。
    efforts(model: string): { levels: string[]; def: string | null } | undefined {
        const d = this.details.find(x => x.id === model);
        return d?.efforts?.length ? { levels: d.efforts, def: d.defaultEffort ?? null } : undefined;
    }
    // 模型下拉下面的说明（灰字）：查到时写来源与时间，查不到写原因；还没有结果时返回空串。
    note(): string {
        const r = this.probed?.result;
        if (r?.ok && r.source !== 'preset') return ag.probeFrom(r.source, this.probed!.at);
        if (r) return ag.probeFallback(r.reason ?? '');
        if (this.skip) return ag.probeFallback(this.skip);
        return this.stale ? ag.probeStale : '';
    }
    // "刷新列表"按钮：查询中禁用并显示"正在查询…"；没有可查询的对象时整个不显示。
    button(): string {
        if (!this.name && !this.source) return '';
        return `<button type="button" class="btn sm" data-probe-refresh ${this.loading || this.skip ? 'disabled' : ''}>${this.loading ? mark('run') : icon('refresh-line')}${esc(this.loading ? ag.refreshingList : ag.refreshList)}</button>`;
    }
}
// 重画模态框正文：焦点放回同一个控件（输入框还原光标位置），保存失败的横幅也带回来。focus 给了就用它，没给就取当前焦点所在控件的身份。
export function redrawSheet(sheet: Sheet, html: string, focus?: string) {
    const active = document.activeElement instanceof HTMLElement && sheet.root.contains(document.activeElement) ? document.activeElement : null;
    const keep = focus ?? (active ? ['data-e', 'data-sel', 'data-probe-refresh', 'data-e-seg', 'data-value', 'data-loc', 'data-role', 'data-family', 'data-family-open'].filter(k => active.hasAttribute(k)).map(k => `[${k}="${CSS.escape(active.getAttribute(k)!)}"]`).join('') : '');
    const caret = active instanceof HTMLInputElement && keep ? [active.selectionStart, active.selectionEnd] as const : null;
    const failed = sheet.root.querySelector('.sheet-fail')?.textContent ?? '';
    sheet.setBody(html);
    if (failed) sheet.fail(failed);
    const target = keep ? sheet.root.querySelector<HTMLElement>(keep) : null;
    target?.focus({ preventScroll: true });
    if (caret && target instanceof HTMLInputElement && caret[0] !== null) target.setSelectionRange(caret[0], caret[1]);
}// 模型下拉与"刷新列表"并排（界面稿 editClaude / editSheet）：下拉在左，按钮在右。
export const modelControl = (select: string, box: ProbeBox) => box.button() ? `<div class="statusline">${select}${box.button()}</div>` : select;

// ---------- 可担任与可能用到的模型范围（Stage07c T4，D85；D128 加"主导"）----------
// Claude 类、通用适配器、Codex 三种编辑共用：三个切换按钮"主导 / 执行者 / 审查者"（至少保留一个，都取消时"保存"禁用并说明）；
// "可能用到的模型范围"显示核心自动识别的结果，"修改…"展开家族多选（选项是 ar roles 给的家族列表，界面不自己判断家族）。
// 数据来自 roles:list（ar roles --json），保存走 roles:set（ar roles set）；只写改过的那一项。
// 没写 roles 时核心默认是执行者与审查者两项（不默认当主导，D128），所以没有配置档案时也按这两项显示。
const ROLE_ORDER = ['lead', 'executor', 'reviewer'];
const DEFAULT_ROLES = ['executor', 'reviewer'];
export interface RolesData { families: string[]; profile?: RolesProfile }
// 读不到（核心没返回）时按"两个角色都可担任、没有家族可选"处理，编辑仍可用。
export const loadRoles = (name: string): Promise<RolesData> => window.dock.console('roles:list')
    .then((view: RolesView) => ({ families: view.families ?? [], profile: view.profiles.find(item => item.name === name) }))
    .catch(() => ({ families: [] }));
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(item => b.includes(item));
export class RolesBox {
    private roles: string[];
    private families: string[];
    private opened = false;
    private base: { roles: string[]; families: string[] };
    constructor(private data: RolesData) {
        this.roles = ROLE_ORDER.filter(role => data.profile ? data.profile.roles.includes(role as 'executor') : DEFAULT_ROLES.includes(role));
        this.families = [...(data.profile?.modelFamilies ?? [])];
        this.base = { roles: [...this.roles], families: [...this.families] };
    }
    get valid() { return this.roles.length > 0; }
    // 改过的项（没改的不写）：roles 为角色名数组，modelFamilies 为空数组表示清除（回到自动识别）。
    payload(): { roles?: string[]; modelFamilies?: string[] } {
        return { ...(sameSet(this.roles, this.base.roles) ? {} : { roles: [...this.roles] }), ...(sameSet(this.families, this.base.families) ? {} : { modelFamilies: [...this.families] }) };
    }
    get dirty() { return Object.keys(this.payload()).length > 0; }
    // 保存成功后，现在的值就是新的起点。
    commit() { this.base = { roles: [...this.roles], families: [...this.families] }; }
    // 两个表单行（"可担任""可能用到的模型范围"）。
    html(): string {
        const toggles = ROLE_ORDER.map(role => { const on = this.roles.includes(role); return `<button type="button" class="ro-tog${on ? ' on' : ''}" data-role="${role}" aria-pressed="${on}">${esc(ag.roleNames[role] ?? role)}</button>`; }).join('');
        const help = this.valid ? esc(ag.canDoHelp) : `<span class="fhint fail" data-roles-hint role="alert">${esc(ag.canDoNeedOne)}</span>`;
        // 自动识别的结果按核心给的依据写（走查 U5）：model 模型名 / host 接口地址 / adapter 适配器默认 / declared 声明。
        const auto = this.data.profile && !this.data.profile.modelFamilies.length && !this.data.profile.familiesUnknown && this.data.profile.families.length ? ag.modelRangeAutoBy(this.data.profile.families.join('、'), this.data.profile.familiesSource) : ag.familyUnknown;
        const shown = this.families.length ? this.families.join('、') : auto;
        const picks = this.opened ? `<div class="ro-typepick fam-pick" role="group" aria-label="${esc(ag.modelRange)}">${this.data.families.map(family => { const on = this.families.includes(family); return `<button type="button" class="ro-tog${on ? ' on' : ''}" data-family="${esc(family)}" aria-pressed="${on}">${esc(family)}</button>`; }).join('')}</div>` : '';
        return field(ag.canDo, help, `<div class="ro-typepick" role="group" aria-label="${esc(ag.canDo)}">${toggles}</div>`)
            + field(ag.modelRange, esc(ag.modelRangeHelp), `<div class="fam-box"><div class="statusline"><span class="mono muted" data-model-range>${esc(shown)}</span><button type="button" class="btn sm" data-family-open aria-expanded="${this.opened}" ${this.data.families.length ? '' : 'disabled'}>${esc(ag.modelRangeChange)}</button></div>${picks}</div>`);
    }
    // 点击：处理三类按钮，返回重画后要放回焦点的选择器；不是这里的按钮返回 null。
    handle(target: Element): string | null {
        const b = target.closest<HTMLButtonElement>('[data-role], [data-family], [data-family-open]');
        if (!b || b.disabled) return null;
        const toggle = (list: string[], value: string) => list.includes(value) ? list.filter(item => item !== value) : [...list, value];
        if (b.dataset.role) { this.roles = ROLE_ORDER.filter(role => toggle(this.roles, b.dataset.role!).includes(role)); return `[data-role="${b.dataset.role}"]`; }
        if (b.dataset.family) { this.families = this.data.families.filter(family => toggle(this.families, b.dataset.family!).includes(family)); return `[data-family="${CSS.escape(b.dataset.family)}"]`; }
        this.opened = !this.opened;
        return '[data-family-open]';
    }
    // 三个角色都取消时"保存"禁用（重画、保存失败后各调一次，busy(false) 会把按钮全部恢复）。
    syncSave(sheet: Sheet) { const save = sheet.root.querySelector<HTMLButtonElement>('[data-sheet-btn="1"]'); if (save) save.disabled = !this.valid; }
}

// preferences.ts 提供的回调：Codex 的编辑在设置视图里复用设置的数据，版本变更提示与"知道了"也由它掌管。
export interface AgentsHost {
    // name：Codex 执行者的名字；label：显示名；others：可选的升级目标（其他已启用的执行者）。
    openCodexEdit(trigger: HTMLElement, name: string, label: string, others: { name: string; label: string }[]): void;
    codexChange(): { old: string; next: string } | undefined;
    ack(): void;
    // 刷新执行者列表时顺带读到的最新设置：侧栏底部列出启用的执行者，这里变了（启用、停用、导入、删除）它要跟着变。
    settingsLoaded?(settings: Settings): void;
}

export class AgentsView {
    private agents: AgentRow[] = [];
    private profiles: Settings['profiles'] = {};
    // 每个启用的执行者可担任的角色与模型家族（roles:list），以及现在被限流的执行者（route:config 的 limited）；界面只显示，不自己判断。
    private roles = new Map<string, RolesProfile>();
    private limits = new Map<string, NonNullable<RouteProfile['limited']>>();
    private container?: HTMLElement;
    private refreshing = false;
    private again = false;
    private testing: string | null = null;
    private busy = false;
    private error = '';
    private testResult: { name: string; result: { ok: boolean; seconds?: number; version?: string | null; reason?: string } } | null = null;
    constructor(private host: AgentsHost) {}
    // 设置视图每次重建页面都会给一个新的占位元素；点击在这里处理，不冒泡到设置视图。
    mount(container: HTMLElement) {
        this.container = container;
        container.onclick = e => { e.stopPropagation(); void this.click(e).catch(error => { this.error = String((error as Error).message || error); this.render(); }); };
        this.render();
    }
    // 读取进行中又被要求刷新（例如"重新检测"之后）：排一次后续读取，不能丢掉，否则界面停在旧数据上。
    async refresh(keepResult = false) {
        if (this.refreshing) { this.again = true; return; }
        this.refreshing = true;
        if (!keepResult) this.testResult = null;
        try {
            // 角色 / 家族和限流只是行里的附加信息：读不到时不挡着列表（沿用上次读到的）。
            const [list, settings, roles, route] = await Promise.all([
                window.dock.console('agents:list', { detect: true }),
                window.dock.preferences('settings'),
                window.dock.console('roles:list').catch(() => null) as Promise<RolesView | null>,
                window.dock.console('route:config').catch(() => null) as Promise<RouteConfig | null>,
            ]);
            this.agents = list.agents;
            this.profiles = settings.profiles;
            if (roles && Array.isArray(roles.profiles)) this.roles = new Map(roles.profiles.map(item => [item.name, item]));
            if (route && Array.isArray(route.profiles)) this.limits = new Map(route.profiles.flatMap(item => item.limited ? [[item.name, item.limited] as const] : []));
            this.host.settingsLoaded?.(settings);
            this.error = '';
        }
        catch (e) { this.error = String((e as Error).message || e); }
        finally { this.refreshing = false; this.render(); if (this.again) { this.again = false; void this.refresh(true); } }
    }
    private hint(state: string, text: string, extra = '') { return `<div class="hint">${mark(state)}<span>${esc(text)}</span>${extra}</div>`; }
    private render() {
        if (!this.container?.isConnected) return;
        // 读取失败时只显示原因横幅：不显示"还没有导入执行者"的空状态（063：配置读不了≠没有执行者，空状态会误导）。
        const card = this.agents.length
            ? `<div class="card xlist">${this.agents.map(a => this.row(a)).join('')}</div>`
            : (this.refreshing || this.error ? '' : `<div class="card"><div class="empty short">${icon('robot-2-line')}<b>${esc(ag.empty)}</b><p>${esc(ag.emptyHelp)}</p><button class="btn primary sm" data-import-agent>${icon('add-line')}${esc(ag.importFirst)}</button></div></div>`);
        // 重建会丢掉焦点：记下焦点所在按钮的身份，重建后放回同一个（模态框关闭后焦点回到触发按钮也靠它）。
        const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
        const identity = focused ? ['data-test', 'data-more-agent', 'data-agent-ack', 'data-limited-clear'].filter(k => focused.hasAttribute(k)).map(k => `[${k}="${CSS.escape(focused.getAttribute(k)!)}"]`).join('') : '';
        this.container.innerHTML = `<div class="sect">${banner(this.error)}<h2>${esc(p.workers)}</h2><p>${esc(p.workerHelp)}</p>${card}</div>`;
        if (identity) this.container.querySelector<HTMLElement>(identity)?.focus({ preventScroll: true });
    }
    private tags(a: AgentRow) {
        const items = [a.default ? `<span class="tag brand">${esc(ag.isDefault)}</span>` : '', !a.enabled ? `<span class="tag">${esc(ag.disabled)}</span>` : '', this.limitedTag(a)];
        return items.filter(Boolean).join('');
    }
    // 被限流（额度用完）：info 标签写恢复时间，悬停是限流原文；旁边的次按钮"已恢复"清掉标记（Stage07c T7，D83）。
    private limitedTag(a: AgentRow) {
        const limited = this.limits.get(a.name);
        if (!limited) return '';
        const text = Number.isFinite(limited.until) ? ag.limitedUntil(untilText(limited.until)) : ag.limitedLater;
        const title = limited.evidence ? ` title="${esc(ag.limitedEvidence(limited.evidence))}"` : '';
        return `<span class="tag info" data-limited="${esc(a.name)}"${title}>${icon('time-line')}${esc(text)}</span><button class="btn sm quiet" data-limited-clear="${esc(a.name)}" title="${esc(ag.limitedClearHelp)}" ${this.busy ? 'disabled' : ''}>${esc(ag.limitedClear)}</button>`;
    }
    // 第二行末尾："可担任 执行者 · 审查者"与"家族 xx"（读不到就不写；停用的执行者核心不列）。
    private roleBits(a: AgentRow) {
        const info = this.roles.get(a.name);
        if (!info) return [];
        const family = info.familiesUnknown || !info.families.length ? ag.familyUnknown : ag.familyRow(info.families.join('、'));
        return [`<span data-roles>${esc(ag.canDoRow(info.roles.map(role => ag.roleNames[role] ?? role).join(' · ')))}</span>`, `<span class="muted" data-family-row>${esc(family)}</span>`];
    }
    private authText(a: AgentRow) {
        // 只有知道怎么登录的适配器才显示认证状态（codex：ChatGPT 登录；claude-code：订阅或密钥）。
        if (a.auth !== 'token' && !['codex', 'claude-code'].includes(a.adapter)) return '';
        if (a.auth === 'token') {
            const entry = Object.entries(a.secrets)[0];
            return `${esc(ag.key)} <span class="ok-t">${esc(entry?.[1] === 'set' ? ag.keySet : ag.keyMissing)}</span>`;
        }
        const label = a.adapter === 'codex' ? ag.chatgptLogin : ag.claudeLogin;
        return `${esc(label)} <span class="ok-t">${esc(p.loginStates[a.login ?? 'unknown'] ?? p.loginStates.unknown)}</span>`;
    }
    private meta(a: AgentRow) {
        // 没有模型时只有 Codex 写"跟随 Codex"，其他适配器不写模型这一项。
        const model = a.model ? `<span class="mono">${esc(a.model)}</span>` : a.adapter === 'codex' ? `<span>${esc(ag.followCodex)}</span>` : '';
        const parts = [`<span class="mono">${esc(a.adapter)}</span>`, model, this.authText(a)].filter(Boolean);
        if (a.installed === false) parts.push(`<span>${esc(p.codexMissing)}</span>`);
        else if (a.version) parts.push(`<span class="mono">${esc(a.version)}</span>`);
        parts.push(...this.roleBits(a));
        return parts.join('<span class="dotsep">·</span>');
    }
    private resultLine(a: AgentRow) {
        const live = this.testResult?.name === a.name ? this.testResult.result : null;
        if (live) {
            if (live.ok) return `<div class="xresult">${mark('ok')}<span>${esc(ag.testOk(`${live.seconds ?? '—'}`, live.version ?? '—'))}</span></div>`;
            return `<div class="xresult fail">${mark('fail')}<span><b>${esc(ag.testFail)}</b>${esc(live.reason ? `：${live.reason}` : '')}</span></div>`;
        }
        if (a.lastTest) {
            const when = new Date(a.lastTest.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            const text = a.lastTest.ok ? ag.testOk(`${a.lastTest.seconds}`, a.lastTest.version ?? '—') : `${ag.testFail}${a.lastTest.error ? `：${a.lastTest.error}` : ''}`;
            return `<div class="xresult${a.lastTest.ok ? '' : ' fail'}">${mark(a.lastTest.ok ? 'ok' : 'fail')}<span>${esc(ag.lastTest(when, text))}</span></div>`;
        }
        return '';
    }
    private row(a: AgentRow) {
        const change = a.adapter === 'codex' ? this.host.codexChange() : undefined;
        const notInstalled = a.installed === false;
        const test = this.testing === a.name
            ? `<button class="btn sm" data-test="${esc(a.name)}" disabled>${mark('run')}${esc(ag.testing)}</button>`
            : `<button class="btn sm" data-test="${esc(a.name)}" ${this.busy ? 'disabled' : ''}>${icon('pulse-line')}${esc(ag.test)}</button>`;
        const more = `<button class="btn icon quiet" data-more-agent="${esc(a.name)}" aria-label="${esc(ag.moreLabel(a.label))}" title="${esc(ag.moreLabel(a.label))}" aria-haspopup="menu" ${this.busy ? 'disabled' : ''}>${icon('more-2-fill')}</button>`;
        return `<div class="xrow${notInstalled ? ' is-fail' : ''}" data-agent="${esc(a.name)}"><span class="xtag mono" title="${esc(a.label)}">${esc(executorTag(a.label))}</span><div class="xm"><div class="x1"><b>${esc(a.label)}</b>${this.tags(a)}</div><div class="x2">${this.meta(a)}</div>${this.resultLine(a)}${notInstalled ? this.hint('fail', p.codexHelp) : ''}${change ? this.hint('info', p.versionChange(change.old, change.next), `<button class="btn sm quiet" data-agent-ack ${this.busy ? 'disabled' : ''}>${esc(p.ack)}</button>`) : ''}</div><div class="xa">${test}${more}</div></div>`;
    }
    private agent(name: string) { return this.agents.find(a => a.name === name); }
    // 导入向导：标题行"导入 Agent"与空状态"导入第一个 Agent"都打开它；结束后刷新列表。
    openImport(trigger: HTMLElement) { openImportWizard(trigger, this.agents.map(a => a.name), () => { void this.refresh(); }); }
    private async click(e: MouseEvent) {
        const b = (e.target as Element).closest<HTMLButtonElement>('button');
        if (!b || b.disabled || this.busy) return;
        if (b.hasAttribute('data-agent-ack')) { this.host.ack(); return; }
        if (b.hasAttribute('data-import-agent')) { this.openImport(b); return; }
        if (b.dataset.limitedClear) { await this.clearLimit(b.dataset.limitedClear); return; }
        const name = b.dataset.test ?? b.dataset.moreAgent;
        if (!name) return;
        const a = this.agent(name);
        if (!a) return;
        if (b.hasAttribute('data-test')) return this.test(a);
        if (b.hasAttribute('data-more-agent')) this.more(b, a);
    }
    private more(anchor: HTMLElement, a: AgentRow) {
        menu(anchor, [
            { label: ag.menu.edit, disabled: !['codex', 'claude-code', 'generic'].includes(a.adapter), run: () => this.edit(a, anchor) },
            { label: ag.menu.setDefault, disabled: a.default || !a.enabled, run: () => { void this.act('default', a.name); } },
            { label: a.enabled ? ag.menu.disable : ag.menu.enable, run: () => { void this.act(a.enabled ? 'disable' : 'enable', a.name); } },
            { label: ag.menu.export, run: () => { void this.export(a); } },
            { label: ag.menu.remove, run: () => { void this.remove(a, anchor); } },
        ]);
    }
    // 导出声明：主进程弹保存对话框，核心写文件；取消什么都不做。
    private async export(a: AgentRow) {
        this.error = '';
        try {
            const r = await window.dock.console('agents:export', { name: a.name });
            if (!r.cancelled) toast(gx.exportDone(r.file));
        }
        catch (e) { this.error = String((e as Error).message || e); this.render(); }
    }
    private edit(a: AgentRow, trigger: HTMLElement) {
        if (a.adapter === 'codex') { this.host.openCodexEdit(trigger, a.name, a.label, this.agents.filter(x => x.name !== a.name && x.enabled).map(x => ({ name: x.name, label: x.label }))); return; }
        if (a.adapter === 'claude-code' || a.adapter === 'generic') { void this.openEdit(a, trigger); }
    }
    private async act(action: 'default' | 'enable' | 'disable' | 'remove', name: string) {
        this.busy = true; this.error = ''; this.render();
        try { await window.dock.console(`agents:${action}`, { name }); }
        catch (e) { this.error = String((e as Error).message || e); }
        finally { this.busy = false; await this.refresh(); }
    }
    // "已恢复"：清掉限流标记（ar route limits clear），成功后标签消失；失败时标签保留，横幅写原因。
    private async clearLimit(name: string) {
        this.busy = true; this.error = ''; this.render();
        let failed = '';
        try { await window.dock.console('route:limits-clear', { name }); }
        catch (e) { failed = ag.limitedClearFail(String((e as Error).message || e)); }
        finally { this.busy = false; await this.refresh(true); }
        if (failed) { this.error = failed; this.render(); }
        this.container?.querySelector<HTMLElement>(`[data-limited-clear="${CSS.escape(name)}"], [data-test="${CSS.escape(name)}"]`)?.focus({ preventScroll: true });
    }
    private async remove(a: AgentRow, trigger: HTMLElement) {
        if (!await confirmAction(ag.removeTitle(a.label), ag.removeBody, ag.removeConfirm, trigger, true)) return;
        await this.act('remove', a.name);
    }
    private async test(a: AgentRow) {
        this.testing = a.name; this.testResult = null; this.render();
        let result: { ok: boolean; seconds?: number; version?: string | null; reason?: string };
        try {
            const r = await window.dock.console('agents:test', { name: a.name });
            result = { ok: true, seconds: r.seconds, version: r.version };
        }
        catch (e) { result = { ok: false, reason: String((e as Error).message || e) }; }
        this.testing = null; this.testResult = { name: a.name, result };
        await this.refresh(true);
    }
    // 预设列表（取下拉的可选值）：第一次用到时读一次，读失败就当没有可选值。
    private presetList?: Promise<AgentPreset[]>;
    private presets(): Promise<AgentPreset[]> {
        return this.presetList ??= window.dock.console('agents:presets').then((r: { presets: AgentPreset[] }) => r.presets).catch(() => { this.presetList = undefined; return [] as AgentPreset[]; });
    }
    // "编辑"：Claude 类和通用适配器（自定义 CLI、Qoder）共用。模型、推理强度是"下拉 + 自定义"，升级到是下拉；
    // 模型名只取名字相同的预设（不借别的服务商的模型名），推理强度的可选值 Claude 类再按适配器取。
    // 模型下拉的选项来自探针（打开时查一次，"刷新列表"重新查）：查到时用探针的模型，推理强度跟着所选模型变；查不到时用预设的可选值并写原因。
    private async openEdit(a: AgentRow, trigger: HTMLElement) {
        const generic = a.adapter === 'generic';
        const list = await this.presets();
        const exact = list.find(x => x.name === a.name && x.adapter === a.adapter);
        const effortOptions = exact?.effortOptions ?? list.find(x => x.adapter === a.adapter)?.effortOptions ?? [];
        const presetModels = exact?.modelOptions ?? [];
        // 预设声明不支持推理强度（D87）：找预设的规则与路由页一致（通用适配器没有同名预设就按支持）。
        const effortOn = (exact ?? (generic ? undefined : list.find(x => x.adapter === a.adapter)))?.supportsEffort !== false;
        // 保存后马上再打开时，列表的刷新可能还没读完：预填值直接读最新的配置（读不到再用上次刷新的）。
        // 可担任 / 模型家族与配置一起读（互不依赖）。
        const [fresh, rolesData] = await Promise.all([window.dock.preferences('settings').catch(() => null) as Promise<Settings | null>, loadRoles(a.name)]);
        const profile = (fresh?.profiles ?? this.profiles)[a.name] ?? {};
        const env = profile.env ?? {};
        const initial = { label: a.label, model: (generic ? profile.model : env.ANTHROPIC_MODEL) ?? '', baseUrl: env.ANTHROPIC_BASE_URL ?? '', secretVar: Object.values(profile.secrets ?? {})[0] ?? '', maxTurns: profile.maxTurns == null ? '' : String(profile.maxTurns), effort: profile.effort ?? '', escalate: profile.escalate ?? '' };
        const E = { ...initial };
        const custom: Record<string, boolean | undefined> = {};
        const rolesBox = new RolesBox(rolesData);
        const others = this.agents.filter(x => x.name !== a.name && x.enabled);
        let refocusRefresh = false;
        const box = new ProbeBox(a.name, () => { if (!sheet.root.isConnected) return; read(); redraw(refocusRefresh ? '[data-probe-refresh]' : undefined); refocusRefresh = false; });
        box.load();
        const spec = (key: string): ChoiceSpec | undefined => {
            if (key === 'model') return { key, attr: 'data-e', opts: box.modelOpts(presetModels), label: ag.model };
            if (key === 'effort') return { key, attr: 'data-e', lead: [{ value: '', label: gx.effortDefault, desc: gx.effortDefaultDesc }], opts: (box.efforts(E.model)?.levels ?? effortOptions).map(value => ({ value })), label: gx.effort };
            if (key === 'escalate') {
                const opts: Opt[] = others.map(x => ({ value: x.name, label: x.label }));
                if (E.escalate && !opts.some(x => x.value === E.escalate)) opts.push({ value: E.escalate });
                return { key, attr: 'data-e', fixed: true, mono: false, lead: [{ value: '', label: gx.escalateNone }], opts, label: gx.escalate };
            }
        };
        // 当前值不在选项里时照"手写的值原样显示"处理（显示成输入框，值不改）：探针换了列表、换了模型都一样。
        const state = (key: string): Choice => {
            const value = E[key as 'model'], opts = (spec(key)?.opts ?? []).map(o => o.value);
            return { value, custom: custom[key] ?? (value !== '' && opts.length > 0 && !opts.includes(value)) };
        };
        const input = (key: string, value: string, mono: boolean) => `<input class="inp${mono ? ' mono' : ''}" data-e="${key}" value="${esc(value)}">`;
        // 通用适配器的预设有 listModels：第一次查询还没回来时不让选（那时给的是预设的值，查到的会不一样）。
        const model = () => box.loading && !box.probed && generic && !!exact?.listModels
            ? `<span class="selw"><button type="button" class="sel" disabled aria-label="${esc(ag.model)}"><span>${esc(gx.modelLoading)}</span>${icon('arrow-down-s-line')}</button></span>${box.button()}`
            : modelControl(choiceHtml(spec('model')!, state('model')), box);
        const cli = generic ? a.label : a.adapter;
        const effort = () => box.efforts(E.model);
        const body = () => `<div class="form">${generic ? `<p class="sheet-lead">${esc(gx.genericEditNote)}</p>` : ''}${field(ag.label, ag.labelHelp, input('label', E.label, false), true)}`
            + field(ag.model, `<span data-probe-note>${esc(box.note() || (presetModels.length ? gx.modelHelpPreset : ''))}</span>`, model())
            + (generic ? '' : field(ag.baseUrl, '', input('baseUrl', E.baseUrl, true)))
            + (effortOn ? field(gx.effort, esc(effort() ? ag.effortSupported(effort()!.levels.join(' / '), effort()!.def) : gx.effortHelp(cli)), choiceHtml(spec('effort')!, state('effort')))
                : initial.effort ? field(gx.effort, '', `<span class="muted" data-effort-ignored>${esc(ro.effortUnsupported)}</span>`) : '')
            + (generic ? '' : field(ag.secretName, ag.secretNameHelp, input('secretVar', E.secretVar, true)))
            + rolesBox.html()
            + field(gx.escalate, esc(gx.escalateHelp), choiceHtml(spec('escalate')!, state('escalate')))
            + (generic ? '' : field(ag.maxTurns, ag.maxTurnsHelp, input('maxTurns', E.maxTurns, true))) + '</div>';
        const read = () => {
            for (const key of ['label', 'model', 'effort', 'baseUrl', 'secretVar', 'maxTurns'] as const) {
                const el = sheet.root.querySelector<HTMLInputElement>(`[data-e="${key}"]`);
                if (el) E[key] = el.value.trim();
            }
        };
        const redraw = (focus?: string) => { if (sheet.root.isConnected) { redrawSheet(sheet, body(), focus); rolesBox.syncSave(sheet); } };
        const changed = () => { read(); return rolesBox.dirty || (Object.keys(initial) as (keyof typeof initial)[]).some(key => E[key] !== initial[key]); };
        const sheet: Sheet = openSheet({
            title: ag.editTitle(a.label), trigger, body: body(), note: ag.editNote(a.name), buttons: [c.cancel, ag.save], wide: true,
            onButton: (index, s) => { if (index === 0) { s.close(); return; } void this.saveEdit(s, a, generic, () => { read(); return E; }, initial, rolesBox); },
            onClose: () => {
                if (!changed()) return;
                const closeBtn = sheet.root.querySelector<HTMLElement>('.sheet-h .btn');
                return confirmAction(ag.discardTitle, ag.discardBody, ag.discard, closeBtn ?? trigger, true).then(ok => ok ? undefined : false);
            },
        });
        bindChoices(sheet.root, {
            spec, state,
            set: (key, st) => { read(); E[key as 'model'] = st.value; custom[key] = st.custom || undefined; },
            redraw: focus => redraw(focus),
        });
        // "刷新列表"：重新查一次；查询中按钮禁用并显示"正在查询…"，查完把焦点放回按钮。
        sheet.root.addEventListener('click', e => {
            const b = (e.target as Element).closest<HTMLButtonElement>('[data-probe-refresh]');
            if (!b || b.disabled) return;
            e.stopPropagation(); read(); refocusRefresh = true; box.load(true); redraw();
        });
        // 可担任、模型范围：只改本地状态并重画，点"保存"才写入。
        sheet.root.addEventListener('click', e => {
            const focus = rolesBox.handle(e.target as Element);
            if (focus === null) return;
            e.stopPropagation(); read(); redraw(focus);
        });
        rolesBox.syncSave(sheet);
        return sheet;
    }
    private async saveEdit(sheet: Sheet, a: AgentRow, generic: boolean, current: () => Record<string, string>, initial: Record<string, string>, rolesBox: RolesBox) {
        const E = current();
        if (!E.label) { sheet.fail(ag.labelRequired); return; }
        const payload: Record<string, unknown> = { name: a.name, label: E.label };
        if (generic) { if (E.model !== initial.model) payload.model = E.model; }
        else {
            if (E.model) payload.model = E.model;
            if (E.baseUrl) payload.baseUrl = E.baseUrl;
            if (E.secretVar) payload.secretVar = E.secretVar;
            // 最大轮数：留空按不限制（null → 核心的 -）；其余交给核心校验（0、非数字等会拒绝，文件不变）。
            payload.maxTurns = E.maxTurns === '' ? null : Number(E.maxTurns);
        }
        // 推理强度、升级到：选"默认""不升级"时传空串，核心删掉这一项。
        if (E.effort !== initial.effort) payload.effort = E.effort;
        if (E.escalate !== initial.escalate) payload.escalate = E.escalate;
        if (!rolesBox.valid) return;
        sheet.busy(true);
        try {
            await window.dock.console('agents:update', payload);
            // 可担任 / 模型范围：改过才写（ar roles set）。
            const roles = rolesBox.payload();
            if (Object.keys(roles).length) { await window.dock.console('roles:set', { name: a.name, ...roles }); rolesBox.commit(); }
            // 接口地址、密钥变量可能变了：旧的探针结果不再可信，下次打开重新查。
            forgetProbe(a.name);
            sheet.close();
            await this.refresh();
        }
        catch (e) { sheet.fail(String((e as Error).message || e)); sheet.busy(false); rolesBox.syncSave(sheet); }
    }
}

// ---------- 导入 Agent 向导（任务 005；Stage07 加 OpenAI 兼容接口、Qoder、自定义 CLI、从文件导入、模型与推理强度下拉）----------
// 预设卡片的名字、说明、"推荐"来自核心（agents:presets），这里不写任何服务商名。"自定义 CLI"和"从文件导入"是固定的两张卡片（名字以 @ 开头，不会和预设重名）。
// 密钥只在密码框里存在到"保存密钥"为止：调用一返回就清空，值只经 secrets:set（标准输入）交给核心。
type Preset = AgentPreset;
// 向导的预设卡片：带 card 的预设按 card.id 合成一张（标题、说明来自 card；位置与默认预设取组里第一个，即 order 最小的）；
// 其余预设各一张。members 是这张卡片包含的预设，卡片有"推荐"当且仅当其中任何一个是推荐。
export interface PresetCard { id?: string; name: string; title: string; description: string; recommended: boolean; members: AgentPreset[] }
export function presetCards(presets: AgentPreset[]): PresetCard[] {
    const cards: PresetCard[] = [];
    for (const x of presets) {
        const group = x.card ? cards.find(c => c.id === x.card!.id) : undefined;
        if (group) { group.members.push(x); group.recommended ||= x.recommended; }
        else cards.push({ id: x.card?.id, name: x.name, title: x.card?.title ?? x.title, description: x.card?.description ?? x.description, recommended: x.recommended, members: [x] });
    }
    return cards;
}
// 第 2 步第一行：合并卡片的分段按钮（套餐 / 认证方式 / 版本）；attr 是按钮上放预设名的属性，字段说明是当前预设的 variant.help。
export function variantField(card: PresetCard | undefined, selected: string, attr: string, disabled = false): string {
    if (!card || card.members.length < 2) return '';
    const current = card.members.find(m => m.name === selected) ?? card.members[0];
    const buttons = card.members.map(m => `<button ${attr}="${esc(m.name)}" class="${m === current ? 'on' : ''}" aria-pressed="${m === current}" ${disabled ? 'disabled' : ''}>${esc(m.variant?.option ?? m.name)}</button>`).join('');
    return field(current.variant?.label ?? '', esc(current.variant?.help ?? ''), `<div class="segm">${buttons}</div>`);
}
type TestResult = { ok: true; seconds: number; version: string | null; model: string | null; usage: { input: number | null; output: number | null } | null } | { ok: false; reason: string; seconds?: number; exit?: number | null };
const CUSTOM_CARD = '@custom', FILE_CARD = '@file';

export function openImportWizard(trigger: HTMLElement, existing: string[], done: () => void, initialCard?: string) {
    let step = 1, presets: Preset[] = [], selected = '', busy = false;
    let added = '', madeDefault = false, dirty = false, result: TestResult | null = null, testing = false, fromFile = false;
    const form = { name: '', label: '', model: '', baseUrl: '', secretVar: '', effort: '', auth: 'token' as 'login' | 'token' };
    const custom: Record<string, boolean | undefined> = {};
    // 模型 / 推理强度的探针（D102）：导入之前按预设和这一刻的参数查（ar agents models --preset … --probe），进入第 2 步查一次；
    // 导入之后（"返回修改"）按执行者名查。密钥没设置时不查，说明写原因；保存密钥后查一次；
    // 接口地址、密钥变量名或认证方式改了，旧结果作废（下拉退回预设值），点"刷新列表"才重查，不随敲字去查。
    let refocusRefresh = false;
    let secretState: 'set' | 'missing' | null = null, login: string | null = null;
    const preset = () => presets.find(x => x.name === selected);
    const presetSource: PresetSource = {
        query: () => ({ preset: selected, ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}), ...(form.secretVar ? { secretVar: form.secretVar } : {}) }),
        key: () => JSON.stringify([selected, form.baseUrl, form.secretVar, form.auth]),
    };
    // 已经被换掉的探针（换了预设 / 版本，或导入之后改按名字查）回来时不再重画：重画会先从界面读输入框写回 form，
    // 而切换后界面可能还没重画，会把刚设好的名称、显示名、密钥变量改回旧值（181）。
    let probe: ProbeBox;
    const newProbe = (name: string | null, source?: PresetSource) => { const box: ProbeBox = new ProbeBox(name, () => { if (box === probe) redrawKeep(); }, '', source); return box; };
    probe = newProbe(null, presetSource);
    // 第 2 步有模型下拉（Claude 类、通用适配器）的预设才查。
    const probing = () => { const x = preset(); return !!x && x.baseUrlOptions === undefined && (x.adapter === 'claude-code' || x.adapter === 'generic'); };
    const skipReason = () => form.auth === 'token' && secretState !== 'set' ? '还没有设置密钥' : '';
    const startProbe = (force = false) => { if (!probing() && !added) return; probe.skip = skipReason(); probe.load(force); };
    // 预设不支持推理强度（supportsEffort 为 false，D87）：第 2 步不显示这一行，已经有值的写"已忽略"。
    const effortRow = (x: Preset, efforts: ReturnType<ProbeBox['efforts']>) => x.supportsEffort === false
        ? (form.effort ? field(gx.effort, '', `<span class="muted" data-effort-ignored>${esc(ro.effortUnsupported)}</span>`) : '')
        : field(gx.effort, esc(efforts ? ag.effortSupported(efforts.levels.join(' / '), efforts.def) : gx.effortHelp(x.adapter === 'generic' ? x.title : x.adapter)), choiceHtml(spec('effort')!, state('effort')));
    const cardList = () => presetCards(presets);
    const cards = () => [...cardList().map(x => x.name), CUSTOM_CARD, FILE_CARD];
    const cardOf = () => cardList().find(c => c.members.some(m => m.name === selected));
    const stepsHtml = () => `<span class="wiz-steps in-sheet">${ag.steps.map((t, i) => `<span class="${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}"><b>${i + 1 < step ? icon('check-line') : i + 1}</b>${esc(t)}</span>`).join('<span class="ln"></span>')}</span>`;
    const uniqueName = (base: string) => { let name = base, n = 2; while (existing.includes(name)) name = `${base}-${n++}`; return name; };
    const val = (key: string) => (sheet.root.querySelector<HTMLInputElement>(`[data-w="${key}"]`)?.value ?? '').trim();
    const readForm = () => { for (const key of ['name', 'label', 'model', 'baseUrl', 'secretVar', 'effort'] as const) if (sheet.root.querySelector(`[data-w="${key}"]`)) form[key] = val(key); };
    const ready = () => form.auth === 'token' ? secretState === 'set' : login === 'in';
    const footBtn = (label: string, action: string, primary = false, disabled = false, tip = '') => `<button class="btn ${primary ? 'primary' : ''}" data-w-act="${action}" ${disabled || busy ? 'disabled' : ''} ${tip ? `title="${esc(tip)}"` : ''}>${esc(label)}</button>`;
    // name 是卡片的预设名（合并卡片取默认预设）；members 是卡片里的预设名，选中的预设在其中就算这张卡片选中。
    const preset1 = (name: string, title: string, description: string, recommended: boolean, members: string[] = [name], cardId?: string) => `<button class="preset ${members.includes(selected) ? 'on' : ''}" role="radio" aria-checked="${members.includes(selected)}" data-preset="${esc(name)}" ${cardId ? `data-card="${esc(cardId)}"` : ''} tabindex="${members.includes(selected) ? 0 : -1}"><span class="rd ${members.includes(selected) ? 'on' : ''}"></span><span class="pk"><b>${esc(title)}${recommended ? `<span class="tag brand">${esc(ag.recommended)}</span>` : ''}</b><span>${esc(description)}</span></span></button>`;
    const input = (key: string, value: string, { mono = true, ph = '', type = 'text', label = '' } = {}) => `<input class="inp${mono ? ' mono' : ''}" data-w="${key}" type="${type}" value="${esc(value)}" placeholder="${esc(ph)}" aria-label="${esc(label)}">`;
    // 下拉的可选值全来自预设（modelOptions / effortOptions / baseUrlOptions）。
    const spec = (key: string): ChoiceSpec | undefined => {
        const x = preset(); if (!x) return;
        if (key === 'model') return { key, attr: 'data-w', opts: probe.modelOpts(x.modelOptions ?? []), label: ag.model };
        if (key === 'effort') return { key, attr: 'data-w', lead: [{ value: '', label: gx.effortDefault, desc: gx.effortDefaultDesc }], opts: (probe.efforts(form.model)?.levels ?? x.effortOptions ?? []).map(value => ({ value })), label: gx.effort };
        if (key === 'baseUrl') return { key, attr: 'data-w', opts: (x.baseUrlOptions ?? []).map(value => ({ value })), label: gx.baseUrl, ph: 'https://' };
    };
    const state = (key: string): Choice => {
        const value = form[key as 'model'], opts = [...(spec(key)?.opts ?? [])].map(o => o.value);
        return { value, custom: custom[key] ?? (value !== '' && opts.length > 0 && !opts.includes(value)) };
    };
    const qoderSite = (x: Preset) => /qoder\.(cn|com)/.exec(x.description)?.[0] ?? (x.name === 'qoder-cn' ? 'qoder.cn' : 'qoder.com');
    const body = () => {
        if (step === 1) return `<p class="sheet-lead">${esc(ag.pickHelp)}</p><div class="presets" role="radiogroup" aria-label="${esc(ag.steps[0])}">${cardList().map(x => preset1(x.name, x.title, x.description, x.recommended, x.members.map(m => m.name), x.id)).join('')}${preset1(CUSTOM_CARD, gx.custom, gx.customDesc, false)}${preset1(FILE_CARD, gx.fromFile, gx.fromFileDesc, false)}</div>`;
        const x = preset()!;
        if (step === 2) {
            const rows: string[] = [];
            const variant = variantField(cardOf(), selected, 'data-w-variant', !!added);
            if (variant) rows.push(variant);
            const openai = x.baseUrlOptions !== undefined, generic = x.adapter === 'generic', claude = x.adapter === 'claude-code';
            if (x.adapter === 'codex' && !openai) rows.push(field(ag.auth, '', `<div class="segm">${[['login', ag.authLogin], ['token', ag.authToken]].map(([k, l]) => `<button data-w-auth="${k}" class="${form.auth === k ? 'on' : ''}" aria-pressed="${form.auth === k}">${esc(l)}</button>`).join('')}</div>`));
            if (form.auth === 'login') rows.push(field(ag.loginState, '', `<div class="statusline">${login === 'in' ? mark('ok') : mark('fail')}<span>${esc(login === 'in' ? ag.loginIn : login === 'out' ? ag.loginOut(x.adapter === 'codex' ? 'codex login' : 'claude setup-token') : ag.loginUnknown)}</span><button class="btn sm" data-w-act="redetect">${icon('refresh-line')}${esc(ag.redetect)}</button></div>`));
            rows.push(field(ag.name, ag.nameHelp, input('name', form.name, { label: ag.name })));
            rows.push(field(ag.label, ag.labelHelp, input('label', form.label, { mono: false, label: ag.label })));
            if (openai) {
                rows.push(field(gx.baseUrl, esc(gx.baseUrlHelp), choiceHtml(spec('baseUrl')!, state('baseUrl')), true));
                rows.push(field(ag.model, '', input('model', form.model, { label: ag.model }), true));
                rows.push(field(gx.wireApi, '', `<div class="statusline"><span class="mono">${esc(gx.wireApiValue)}</span><span class="muted">${esc(gx.wireApiHelp)}</span></div>`));
            } else if (claude || generic) {
                // 说明：查到 / 没查到各写一句；还没有结果时是常用值的说明；密钥没设置时写原因（不查）；问题变了写"点刷新列表重查"。
                probe.skip = skipReason(); probe.sync();
                const efforts = probe.efforts(form.model);
                rows.push(field(ag.model, `<span data-probe-note>${esc(probe.note() || gx.modelHelpPreset)}</span>`, modelControl(choiceHtml(spec('model')!, state('model')), probe)));
                if (claude) rows.push(field(ag.baseUrl, '', input('baseUrl', form.baseUrl, { label: ag.baseUrl })));
                rows.push(effortRow(x, efforts));
            } else rows.push(field(ag.model, ag.modelFollow, input('model', form.model, { ph: ag.followCodex, label: ag.model })));
            if (form.auth === 'token') {
                const tag = secretState === 'set' ? `<span class="tag ok" data-w-status>${esc(ag.keySet)}</span>` : `<span class="tag fail" data-w-status>${esc(ag.keyMissing)}</span>`;
                const help = generic && /^qoder/.test(x.name) ? esc(gx.qoderTokenHelp(qoderSite(x), form.secretVar || '…')) : ag.secretNameHelp;
                rows.push(field(ag.secretName, help, `<div class="statusline">${input('secretVar', form.secretVar, { label: ag.secretName })}${tag}</div>`));
                rows.push(field(ag.secretSet, ag.secretSetHelp, `<div class="statusline">${input('secret', '', { mono: false, type: 'password', ph: ag.secretPlaceholder, label: ag.secretSet })}<button class="btn" data-w-act="save-secret" ${busy ? 'disabled' : ''}>${esc(ag.secretSave)}</button></div>`));
            }
            return `<div class="form">${rows.join('')}</div>`;
        }
        if (testing) return `<div class="testbox">${mark('run')}<div><b>${esc(ag.testingLong)}</b><span>${esc(ag.testingHelp)}</span></div></div>`;
        if (!result) return '';
        const kv2 = (k: string, v: string) => `<div class="kv"><span class="lb">${esc(k)}</span><span class="val mono">${esc(v)}</span></div>`;
        if (result.ok) return `<div class="testbox ok" data-w-result="ok">${mark('ok')}<div><b>${esc(ag.testOkTitle)}</b><span>${esc(ag.testOkHelp(form.label || added, madeDefault))}</span></div></div><div><button class="btn quiet sm" data-w-suggest>${icon('route-line')}${esc(ro.suggestHint)}</button></div><div class="kvs">${kv2(ag.elapsed, `${result.seconds} 秒`)}${kv2(ag.version, result.version ?? '—')}${kv2(ag.model, result.model ?? '—')}${kv2(ag.tokens, result.usage && (result.usage.input != null || result.usage.output != null) ? ag.tokensValue(result.usage.input ?? 0, result.usage.output ?? 0) : '—')}</div>`;
        return `<div class="testbox fail" data-w-result="fail">${mark('fail')}<div><b>${esc(ag.testFail)}</b><span>${esc(result.reason)}</span></div></div><div class="kvs">${result.seconds !== undefined ? kv2(ag.elapsed, `${result.seconds} 秒`) : ''}${result.exit !== undefined ? kv2(ag.exit, String(result.exit ?? '—')) : ''}</div>`;
    };
    const foot = () => {
        if (step === 1) return footBtn(c.cancel, 'cancel') + footBtn(p.next, 'next', true, !selected);
        if (step === 2) return footBtn(p.previous, 'back', false, !!added) + footBtn(p.next, 'next', true, !ready(), ready() ? '' : form.auth === 'token' ? ag.needSecret : ag.needLogin);
        if (testing) return footBtn(p.previous, 'back', false, true) + footBtn(ag.testing, 'none', true, true);
        // 从文件导入的执行者没有"第 2 步"可回：失败时只能完成（配置已保存）或重新测试。
        return result?.ok ? footBtn(ag.done, 'done', true) : (fromFile ? footBtn(ag.done, 'done') : footBtn(ag.back, 'edit')) + footBtn(ag.retest, 'retest', true);
    };
    const note = () => step === 3 && result && !result.ok ? ag.savedNote : step === 2 && form.auth === 'login' ? ag.subscriptionShare : step === 2 && preset()?.baseUrlOptions !== undefined ? gx.openaiNote : '';
    const draw = (focus?: string) => {
        if (!sheet.root.isConnected) return;
        sheet.root.querySelector('.sheet-h .wiz-steps')?.replaceWith(Object.assign(document.createElement('span'), { innerHTML: stepsHtml() }).firstElementChild!);
        sheet.setBody(body()); sheet.setFoot(foot());
        const n = sheet.root.querySelector<HTMLElement>('.sheet-f .note'); if (n) n.textContent = note();
        (focus ? sheet.root.querySelector<HTMLElement>(focus) : sheet.root.querySelector<HTMLElement>('.preset.on, .sheet-b input, .sheet-f .btn.primary:not(:disabled)'))?.focus({ preventScroll: true });
    };
    const fail = (e: unknown) => sheet.fail(String((e as Error).message || e));
    // 探针结果回来（或点了"刷新列表"）：重画第 2 步，焦点留在原来的控件上，输入框的光标位置还原；没有焦点的控件时不抢焦点。
    const NO_FOCUS = '[data-no-focus]';
    const redrawKeep = () => {
        if (!sheet.root.isConnected || step !== 2) return;
        readForm();
        const active = document.activeElement instanceof HTMLElement && sheet.root.contains(document.activeElement) ? document.activeElement : null;
        const keep = refocusRefresh ? '[data-probe-refresh]' : active ? ['data-w', 'data-sel', 'data-probe-refresh', 'data-w-act', 'data-w-variant', 'data-w-auth'].filter(k => active.hasAttribute(k)).map(k => `[${k}="${CSS.escape(active.getAttribute(k)!)}"]`).join('') : '';
        const caret = active instanceof HTMLInputElement && keep ? [active.selectionStart, active.selectionEnd] as const : null;
        if (!probe.loading) refocusRefresh = false;
        // 密码框里还没保存的密钥不进 form，重画前先记下、画完放回（值只在这个密码框里）。
        const typed = sheet.root.querySelector<HTMLInputElement>('[data-w="secret"]')?.value ?? '';
        draw(keep || NO_FOCUS);
        const box = sheet.root.querySelector<HTMLInputElement>('[data-w="secret"]'); if (box && typed) box.value = typed;
        const target = keep ? sheet.root.querySelector<HTMLElement>(keep) : null;
        if (caret && target instanceof HTMLInputElement && caret[0] !== null) target.setSelectionRange(caret[0], caret[1]);
    };
    const refreshSecret = async () => {
        if (!form.secretVar || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(form.secretVar)) { secretState = 'missing'; return; }
        try { secretState = (await window.dock.console('secrets:status', { names: [form.secretVar] })).secrets[form.secretVar] ?? 'missing'; } catch { secretState = 'missing'; }
    };
    const refreshLogin = async () => { try { login = (await window.dock.preferences('detect')).codex.login; } catch { login = 'unknown'; } };
    const choose = async (name: string) => {
        selected = name;
        // 换了预设：上一个预设查到的结果不再适用（新的在进入第 2 步或换完版本后再查）。
        if (!added) probe = newProbe(null, presetSource);
        for (const key of Object.keys(custom)) delete custom[key];
        const x = preset(); if (!x) return;
        form.name = uniqueName(x.name); form.label = x.label; form.model = x.env?.ANTHROPIC_MODEL ?? x.model ?? ''; form.baseUrl = x.env?.ANTHROPIC_BASE_URL ?? x.baseUrlOptions?.[0] ?? '';
        form.effort = x.effort ?? '';
        form.secretVar = Object.values(x.secrets ?? {})[0] ?? (x.adapter === 'codex' && x.baseUrlOptions === undefined ? 'OPENAI_API_KEY' : ''); form.auth = x.auth;
    };
    const toTest = async () => {
        step = 3; testing = true; result = null; draw();
        try { const r = await window.dock.console('agents:test', { name: added }); result = { ok: true, seconds: r.seconds, version: r.version ?? null, model: r.model ?? null, usage: r.usage ?? null }; }
        catch (e) { result = { ok: false, reason: String((e as Error).message || e) }; }
        testing = false; draw();
    };
    const problems = (r: { errors?: { path: string; message: string }[]; error?: string }) => (r.errors?.length ? r.errors.slice(0, 3).map(e => `${e.path}：${e.message}`).join('；') : r.error) ?? '';
    const importFile = async () => {
        busy = true; draw();
        try {
            const r = await window.dock.console('agents:import-file');
            if (r.cancelled) { busy = false; draw(); return; }
            if (r.ok === false) { busy = false; draw(); sheet.fail(problems(r)); return; }
            added = r.name; madeDefault = !!r.madeDefault; fromFile = true; form.label = r.name;
            busy = false; await toTest();
        } catch (e) { busy = false; draw(); fail(e); }
    };
    const act = async (action: string) => {
        sheet.fail('');
        if (action === 'cancel') return close();
        if (action === 'done') { finish(); return; }
        if (action === 'redetect') { await refreshLogin(); draw('[data-w-act="redetect"]'); return; }
        if (action === 'back') { readForm(); step = 1; draw(); return; }
        if (action === 'edit') { step = 2; result = null; startProbe(); draw(); return; }
        if (action === 'retest') return toTest();
        if (action === 'save-secret') {
            readForm();
            const box = sheet.root.querySelector<HTMLInputElement>('[data-w="secret"]')!; const value = box.value;
            busy = true; draw('[data-w="secret"]');
            try { await window.dock.console('secrets:set', { name: form.secretVar, value }); }
            catch (e) { fail(e); }
            finally {
                // 调用一返回（成功或失败）就清空密码框，值不留在界面里。
                const again = sheet.root.querySelector<HTMLInputElement>('[data-w="secret"]'); if (again) again.value = '';
                busy = false; await refreshSecret(); const error = sheet.root.querySelector('.sheet-fail')?.textContent ?? '';
                // 密钥保存好了：自动查一次模型列表。
                startProbe();
                draw('[data-w-act="save-secret"]'); if (error) sheet.fail(error);
            }
            return;
        }
        if (action === 'next' && step === 1) {
            if (!selected) return;
            if (selected === CUSTOM_CARD) {
                // 自定义 CLI 是另一张宽表单：关掉向导（不刷新列表），"上一步"回到向导并选中这张卡片。
                finished = true; sheet.close();
                openCustomForm({ trigger, existing, onDone: () => done(), onBack: () => { openImportWizard(trigger, existing, done, CUSTOM_CARD); } });
                return;
            }
            if (selected === FILE_CARD) return importFile();
            step = 2; busy = true; draw();
            if (form.auth === 'token') await refreshSecret(); else await refreshLogin();
            busy = false; startProbe(); draw(); return;
        }
        if (action === 'next' && step === 2) {
            readForm(); const x = preset()!;
            const fields: Record<string, unknown> = { label: form.label };
            if (x.baseUrlOptions !== undefined) { fields.baseUrl = form.baseUrl; fields.model = form.model; }
            else if (x.adapter === 'claude-code') { if (form.model) fields.model = form.model; if (form.baseUrl) fields.baseUrl = form.baseUrl; }
            else if (form.model) fields.model = form.model;
            // 推理强度：选"默认"时新增不传；回到这一步改回"默认"后再保存，要把已写进去的 effort 清掉。
            if (['claude-code', 'generic'].includes(x.adapter) && x.supportsEffort !== false && (form.effort || added)) fields.effort = form.effort;
            if (form.auth === 'token' && form.secretVar) fields.secretVar = form.secretVar;
            busy = true; draw();
            try {
                if (!added) {
                    const { effort, ...rest } = fields;
                    const r = await window.dock.console('agents:add', { preset: x.name, name: form.name, ...rest, ...(effort ? { effort } : {}), ...(x.adapter === 'codex' && x.baseUrlOptions === undefined ? { auth: form.auth } : {}) });
                    added = r.name; madeDefault = !!r.madeDefault;
                    probe = newProbe(added);
                }
                else { await window.dock.console('agents:update', { name: added, ...fields }); forgetProbe(added); }
                dirty = false; busy = false; await toTest();
            } catch (e) { busy = false; draw(); fail(e); }
        }
    };
    let finished = false;
    const finish = () => { finished = true; sheet.close(); done(); };
    const close = () => { if (!sheet.root.isConnected) return; void tryClose(); };
    const unsaved = () => { const secret = sheet.root.querySelector<HTMLInputElement>('[data-w="secret"]'); return dirty || !!secret?.value; };
    const tryClose = async () => { if (await onClose() === false) return; finished = true; sheet.close(); };
    const onClose = async () => {
        if (!finished && unsaved() && !await confirmAction(ag.discardTitle, ag.discardBody, ag.discard, sheet.root.querySelector<HTMLElement>('.sheet-h .btn') ?? trigger, true)) return false;
        const secret = sheet.root.querySelector<HTMLInputElement>('[data-w="secret"]'); if (secret) secret.value = '';
        if (added && !finished) done();
        return true;
    };
    const mark = (state: string) => `<span class="mk ${state}">${icon(({ ok: 'checkbox-circle-line', fail: 'close-circle-line', info: 'information-line', run: 'loader-4-line' } as Record<string, string>)[state])}</span>`;
    const sheet: Sheet = openSheet({ title: ag.wizardTitle, trigger, steps: stepsHtml(), body: `<div class="testbox">${mark('run')}<div><b>${esc(p.detecting)}</b></div></div>`, buttons: [c.cancel], wide: true,
        // 底栏按钮由下面的点击监听按 data-w-act 处理；只有打开时那个还没换掉的"取消"走这里。
        onButton: () => { if (!sheet.root.querySelector('[data-w-act]')) void close(); }, onClose });
    sheet.root.addEventListener('click', e => {
        const b = (e.target as Element).closest<HTMLButtonElement>('button'); if (!b || b.disabled) return;
        if (b.dataset.preset) {
            // 点已选中的合并卡片：保留第 2 步里已选的那个预设，不重置回默认。
            if (b.dataset.card && cardOf()?.id === b.dataset.card) { draw(`[data-preset="${CSS.escape(b.dataset.preset)}"]`); return; }
            void choose(b.dataset.preset).then(() => draw(`[data-preset="${CSS.escape(b.dataset.preset!)}"]`)); return;
        }
        // 第 2 步的分段按钮：等于改选这个预设，整张表单按它重新填默认值并重新检测密钥 / 登录，焦点留在刚点的按钮上。
        if (b.dataset.wVariant) {
            const name = b.dataset.wVariant;
            if (name === selected) return;
            // 先按新 form 画一次（密钥 / 登录状态还没查到，先当未知），再异步重新检测，界面不会停在旧版本的值上（181）。
            void choose(name).then(async () => { dirty = true; secretState = null; login = null; draw(`[data-w-variant="${CSS.escape(name)}"]`); if (form.auth === 'token') await refreshSecret(); else await refreshLogin(); startProbe(); draw(`[data-w-variant="${CSS.escape(name)}"]`); });
            return;
        }
        if (b.hasAttribute('data-probe-refresh')) { readForm(); refocusRefresh = true; startProbe(true); redrawKeep(); return; }
        // 连接成功下面的一行：先关掉向导，再到路由页打开建议规则（151 第 2 项）。
        if (b.hasAttribute('data-w-suggest')) { finish(); goToSuggest(); return; }
        if (b.dataset.wAuth) { readForm(); form.auth = b.dataset.wAuth as 'login' | 'token'; dirty = true; secretState = null; login = null; draw(`[data-w-auth="${form.auth}"]`); void (form.auth === 'token' ? refreshSecret() : refreshLogin()).then(() => draw(`[data-w-auth="${form.auth}"]`)); return; }
        if (b.dataset.wAct) { e.stopPropagation(); void act(b.dataset.wAct).catch(fail); }
    });
    // 模型、推理强度、接口地址的下拉：选完把值记进 form（先读走输入框里已经敲的内容），重画并把焦点放回这个控件。
    bindChoices(sheet.root, {
        spec, state,
        set: (key, st) => { readForm(); form[key as 'model'] = st.value; custom[key] = st.custom || undefined; dirty = true; },
        redraw: focus => draw(focus),
    });
    sheet.root.addEventListener('input', e => { const t = e.target as HTMLElement; if (t.matches('[data-w]') && (t as HTMLInputElement).type !== 'password') dirty = true; });
    // 密钥变量名改了：重新读一次状态再重画。这段时间里用户可能已经 Tab 到别的输入框并开始敲字，所以重画前再读一次表单，焦点留在现在的输入框。
    // 接口地址写完（离开输入框）：旧的查询结果作废，说明与下拉马上更新；正按着鼠标时先不重画（会吃掉正要点的"刷新列表"），下次重画时对一下就行。
    let pointerDown = false;
    sheet.root.addEventListener('pointerdown', () => { pointerDown = true; }, true);
    document.addEventListener('pointerup', () => { pointerDown = false; }, true);
    sheet.root.addEventListener('change', e => {
        if ((e.target as HTMLElement).matches('[data-w="baseUrl"]') && step === 2) { readForm(); if (!pointerDown) redrawKeep(); return; }
    });
    sheet.root.addEventListener('change', e => {
        if (!(e.target as HTMLElement).matches('[data-w="secretVar"]')) return;
        readForm();
        void refreshSecret().then(() => {
            readForm();
            const now = document.activeElement instanceof HTMLElement && sheet.root.contains(document.activeElement) ? document.activeElement.dataset.w : undefined;
            draw(`[data-w="${now ?? 'secretVar'}"]`);
        });
    });
    // 方向键在预设卡片之间移动并选中（单选组的键盘约定）。
    sheet.root.addEventListener('keydown', e => {
        const card = (e.target as Element).closest<HTMLElement>('[data-preset]'); if (!card || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        e.preventDefault(); const names = cards(), i = names.indexOf(card.dataset.preset!), next = names[(i + (['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : -1) + names.length) % names.length];
        void choose(next).then(() => draw(`[data-preset="${CSS.escape(next)}"]`));
    });
    void (async () => {
        try {
            presets = (await window.dock.console('agents:presets')).presets;
            const list = cardList();
            const first = initialCard && (cards().includes(initialCard) || presets.some(x => x.name === initialCard)) ? initialCard : (list.find(x => x.recommended) ?? list[0])?.name;
            if (first) await choose(first);
            draw();
        }
        catch (e) { draw(); fail(e); }
    })();
    return sheet;
}