// Agent 页"执行者"区：列出配置里的执行者，可以测试连接、编辑、设为默认、停用 / 启用、删除。
// 数据来自 console 通道的 agents:list（detect: true）；Codex 的编辑由 preferences.ts 复用设置控件，
// 其余执行者（claude-code）用通用模态框表单，保存走 agents:update。
import { ag, p, c } from '../shared/copy';
import { esc } from '../shared/markdown';
import type { AgentRow, Settings } from '../shared/types';
import { executorTag } from '../shared/executor';
import { icon, menu, confirmAction, openSheet, field, type Sheet } from './ui';

const mark = (state: string) => `<span class="mk ${state}">${icon(({ ok: 'checkbox-circle-line', fail: 'close-circle-line', info: 'information-line', run: 'loader-4-line' } as Record<string, string>)[state])}</span>`;
const banner = (text: string) => text ? `<div class="banner fail" role="alert">${mark('fail')}<span>${esc(text)}</span></div>` : '';

// preferences.ts 提供的回调：Codex 的编辑在设置视图里复用设置控件，版本变更提示与"知道了"也由它掌管。
export interface AgentsHost {
    openCodexEdit(trigger: HTMLElement): void;
    codexChange(): { old: string; next: string } | undefined;
    ack(): void;
}

export class AgentsView {
    private agents: AgentRow[] = [];
    private profiles: Settings['profiles'] = {};
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
            const [list, settings] = await Promise.all([
                window.dock.console('agents:list', { detect: true }),
                window.dock.preferences('settings'),
            ]);
            this.agents = list.agents;
            this.profiles = settings.profiles;
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
        const identity = focused ? ['data-test', 'data-more-agent', 'data-agent-ack'].filter(k => focused.hasAttribute(k)).map(k => `[${k}="${CSS.escape(focused.getAttribute(k)!)}"]`).join('') : '';
        this.container.innerHTML = `<div class="sect">${banner(this.error)}<h2>${esc(p.workers)}</h2><p>${esc(p.workerHelp)}</p>${card}</div>`;
        if (identity) this.container.querySelector<HTMLElement>(identity)?.focus({ preventScroll: true });
    }
    private tags(a: AgentRow) {
        const items = [a.default ? `<span class="tag brand">${esc(ag.isDefault)}</span>` : '', !a.enabled ? `<span class="tag">${esc(ag.disabled)}</span>` : '', a.adapter === 'codex' && !a.default && a.enabled ? `<span class="tag">${esc(ag.onlyExplicit)}</span>` : ''];
        return items.filter(Boolean).join('');
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
        const name = b.dataset.test ?? b.dataset.moreAgent;
        if (!name) return;
        const a = this.agent(name);
        if (!a) return;
        if (b.hasAttribute('data-test')) return this.test(a);
        if (b.hasAttribute('data-more-agent')) this.more(b, a);
    }
    private more(anchor: HTMLElement, a: AgentRow) {
        menu(anchor, [
            { label: ag.menu.edit, disabled: !['codex', 'claude-code'].includes(a.adapter), run: () => this.edit(a, anchor) },
            { label: ag.menu.setDefault, disabled: a.default || !a.enabled, run: () => { void this.act('default', a.name); } },
            { label: a.enabled ? ag.menu.disable : ag.menu.enable, run: () => { void this.act(a.enabled ? 'disable' : 'enable', a.name); } },
            { label: ag.menu.remove, run: () => { void this.remove(a, anchor); } },
        ]);
    }
    private edit(a: AgentRow, trigger: HTMLElement) {
        if (a.adapter === 'codex') { this.host.openCodexEdit(trigger); return; }
        if (a.adapter === 'claude-code') { this.openClaudeEdit(a, trigger); }
    }
    private async act(action: 'default' | 'enable' | 'disable' | 'remove', name: string) {
        this.busy = true; this.error = ''; this.render();
        try { await window.dock.console(`agents:${action}`, { name }); }
        catch (e) { this.error = String((e as Error).message || e); }
        finally { this.busy = false; await this.refresh(); }
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
    private openClaudeEdit(a: AgentRow, trigger: HTMLElement) {
        const profile = this.profiles[a.name] ?? {};
        const env = profile.env ?? {};
        const pre = { label: a.label, model: env.ANTHROPIC_MODEL ?? '', baseUrl: env.ANTHROPIC_BASE_URL ?? '', secretVar: Object.values(profile.secrets ?? {})[0] ?? '', maxTurns: profile.maxTurns == null ? '' : String(profile.maxTurns) };
        const input = (key: string, value: string, mono: boolean) => `<input class="inp${mono ? ' mono' : ''}" data-e="${key}" value="${esc(value)}">`;
        const body = () => `<div class="form">${field(ag.label, ag.labelHelp, input('label', pre.label, false), true)}${field(ag.model, '', input('model', pre.model, true))}${field(ag.baseUrl, '', input('baseUrl', pre.baseUrl, true))}${field(ag.secretName, ag.secretNameHelp, input('secretVar', pre.secretVar, true))}${field(ag.maxTurns, ag.maxTurnsHelp, input('maxTurns', pre.maxTurns, true))}</div>`;
        const sheet = openSheet({
            title: ag.editTitle(a.label), trigger, body: body(), note: ag.editNote(a.name), buttons: [c.cancel, ag.save], wide: true,
            onButton: (index, s) => { if (index === 0) { s.close(); return; } void this.saveClaudeEdit(s, a); },
            onClose: () => {
                const val = (key: string) => (sheet.root.querySelector<HTMLInputElement>(`[data-e="${key}"]`)?.value ?? '').trim();
                if (['label', 'model', 'baseUrl', 'secretVar', 'maxTurns'].every(key => val(key) === pre[key as keyof typeof pre].trim())) return;
                const closeBtn = sheet.root.querySelector<HTMLElement>('.sheet-h .btn');
                return confirmAction(ag.discardTitle, ag.discardBody, ag.discard, closeBtn ?? trigger, true).then(ok => ok ? undefined : false);
            },
        });
    }
    private async saveClaudeEdit(sheet: Sheet, a: AgentRow) {
        const val = (key: string) => (sheet.root.querySelector<HTMLInputElement>(`[data-e="${key}"]`)?.value ?? '').trim();
        const label = val('label');
        if (!label) { sheet.fail(ag.labelRequired); return; }
        const payload: Record<string, unknown> = { name: a.name, label };
        const model = val('model'); if (model) payload.model = model;
        const baseUrl = val('baseUrl'); if (baseUrl) payload.baseUrl = baseUrl;
        const secretVar = val('secretVar'); if (secretVar) payload.secretVar = secretVar;
        // 最大轮数：留空按不限制（null → 核心的 -）；其余交给核心校验（0、非数字等会拒绝，文件不变）。
        const maxTurns = val('maxTurns'); payload.maxTurns = maxTurns === '' ? null : Number(maxTurns);
        sheet.busy(true);
        try {
            await window.dock.console('agents:update', payload);
            sheet.close();
            await this.refresh();
        }
        catch (e) { sheet.fail(String((e as Error).message || e)); sheet.busy(false); }
    }
}

// ---------- 导入 Agent 向导（任务 005）：选类型 → 填参数 → 测试连接 ----------
// 预设卡片的名字、说明、"推荐"来自核心（agents:presets），这里不写任何服务商名。
// 密钥只在密码框里存在到"保存密钥"为止：调用一返回就清空，值只经 secrets:set（标准输入）交给核心。
interface Preset { name: string; title: string; description: string; recommended: boolean; adapter: string; label: string; auth: 'login' | 'token'; env?: Record<string, string>; secrets?: Record<string, string> }
type TestResult = { ok: true; seconds: number; version: string | null; model: string | null; usage: { input: number | null; output: number | null } | null } | { ok: false; reason: string; seconds?: number; exit?: number | null };

export function openImportWizard(trigger: HTMLElement, existing: string[], done: () => void) {
    let step = 1, presets: Preset[] = [], selected = '', busy = false;
    let added = '', madeDefault = false, dirty = false, result: TestResult | null = null, testing = false;
    const form = { name: '', label: '', model: '', baseUrl: '', secretVar: '', auth: 'token' as 'login' | 'token' };
    let secretState: 'set' | 'missing' | null = null, login: string | null = null;
    const preset = () => presets.find(x => x.name === selected);
    const stepsHtml = () => `<span class="wiz-steps in-sheet">${ag.steps.map((t, i) => `<span class="${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}"><b>${i + 1 < step ? icon('check-line') : i + 1}</b>${esc(t)}</span>`).join('<span class="ln"></span>')}</span>`;
    const uniqueName = (base: string) => { let name = base, n = 2; while (existing.includes(name)) name = `${base}-${n++}`; return name; };
    const val = (key: string) => (sheet.root.querySelector<HTMLInputElement>(`[data-w="${key}"]`)?.value ?? '').trim();
    const readForm = () => { for (const key of ['name', 'label', 'model', 'baseUrl', 'secretVar'] as const) if (sheet.root.querySelector(`[data-w="${key}"]`)) form[key] = val(key); };
    const ready = () => form.auth === 'token' ? secretState === 'set' : login === 'in';
    const footBtn = (label: string, action: string, primary = false, disabled = false, tip = '') => `<button class="btn ${primary ? 'primary' : ''}" data-w-act="${action}" ${disabled || busy ? 'disabled' : ''} ${tip ? `title="${esc(tip)}"` : ''}>${esc(label)}</button>`;
    const preset1 = (x: Preset) => `<button class="preset ${x.name === selected ? 'on' : ''}" role="radio" aria-checked="${x.name === selected}" data-preset="${esc(x.name)}" tabindex="${x.name === selected ? 0 : -1}"><span class="rd ${x.name === selected ? 'on' : ''}"></span><span class="pk"><b>${esc(x.title)}${x.recommended ? `<span class="tag brand">${esc(ag.recommended)}</span>` : ''}</b><span>${esc(x.description)}</span></span></button>`;
    const input = (key: string, value: string, { mono = true, ph = '', type = 'text', label = '' } = {}) => `<input class="inp${mono ? ' mono' : ''}" data-w="${key}" type="${type}" value="${esc(value)}" placeholder="${esc(ph)}" aria-label="${esc(label)}">`;
    const body = () => {
        if (step === 1) return `<p class="sheet-lead">${esc(ag.pickHelp)}</p><div class="presets" role="radiogroup" aria-label="${esc(ag.steps[0])}">${presets.map(preset1).join('')}</div>`;
        const x = preset()!;
        if (step === 2) {
            const rows: string[] = [];
            if (x.adapter === 'codex') rows.push(field(ag.auth, '', `<div class="segm">${[['login', ag.authLogin], ['token', ag.authToken]].map(([k, l]) => `<button data-w-auth="${k}" class="${form.auth === k ? 'on' : ''}" aria-pressed="${form.auth === k}">${esc(l)}</button>`).join('')}</div>`));
            else rows.push(field(ag.auth, '', `<div class="segm"><button class="on" aria-pressed="true">${esc(ag.authToken)}</button><button disabled title="${esc(ag.authTokenOnly(x.title))}">${esc(ag.authLogin)}</button></div>`));
            if (form.auth === 'login') rows.push(field(ag.loginState, '', `<div class="statusline">${login === 'in' ? mark('ok') : mark('fail')}<span>${esc(login === 'in' ? ag.loginIn : login === 'out' ? ag.loginOut(x.adapter === 'codex' ? 'codex login' : 'claude setup-token') : ag.loginUnknown)}</span><button class="btn sm" data-w-act="redetect">${icon('refresh-line')}${esc(ag.redetect)}</button></div>`));
            rows.push(field(ag.name, ag.nameHelp, input('name', form.name, { label: ag.name })));
            rows.push(field(ag.label, ag.labelHelp, input('label', form.label, { mono: false, label: ag.label })));
            if (x.adapter === 'claude-code') { rows.push(field(ag.model, '', input('model', form.model, { label: ag.model }))); rows.push(field(ag.baseUrl, '', input('baseUrl', form.baseUrl, { label: ag.baseUrl }))); }
            else rows.push(field(ag.model, ag.modelFollow, input('model', form.model, { ph: ag.followCodex, label: ag.model })));
            if (form.auth === 'token') {
                const tag = secretState === 'set' ? `<span class="tag ok" data-w-status>${esc(ag.keySet)}</span>` : `<span class="tag fail" data-w-status>${esc(ag.keyMissing)}</span>`;
                rows.push(field(ag.secretName, ag.secretNameHelp, `<div class="statusline">${input('secretVar', form.secretVar, { label: ag.secretName })}${tag}</div>`));
                rows.push(field(ag.secretSet, ag.secretSetHelp, `<div class="statusline">${input('secret', '', { mono: false, type: 'password', ph: ag.secretPlaceholder, label: ag.secretSet })}<button class="btn" data-w-act="save-secret" ${busy ? 'disabled' : ''}>${esc(ag.secretSave)}</button></div>`));
            }
            return `<div class="form">${rows.join('')}</div>`;
        }
        if (testing) return `<div class="testbox">${mark('run')}<div><b>${esc(ag.testingLong)}</b><span>${esc(ag.testingHelp)}</span></div></div>`;
        if (!result) return '';
        const kv2 = (k: string, v: string) => `<div class="kv"><span class="lb">${esc(k)}</span><span class="val mono">${esc(v)}</span></div>`;
        if (result.ok) return `<div class="testbox ok" data-w-result="ok">${mark('ok')}<div><b>${esc(ag.testOkTitle)}</b><span>${esc(ag.testOkHelp(form.label || added, madeDefault))}</span></div></div><div class="kvs">${kv2(ag.elapsed, `${result.seconds} 秒`)}${kv2(ag.version, result.version ?? '—')}${kv2(ag.model, result.model ?? '—')}${kv2(ag.tokens, result.usage && (result.usage.input != null || result.usage.output != null) ? ag.tokensValue(result.usage.input ?? 0, result.usage.output ?? 0) : '—')}</div>`;
        return `<div class="testbox fail" data-w-result="fail">${mark('fail')}<div><b>${esc(ag.testFail)}</b><span>${esc(result.reason)}</span></div></div><div class="kvs">${result.seconds !== undefined ? kv2(ag.elapsed, `${result.seconds} 秒`) : ''}${result.exit !== undefined ? kv2(ag.exit, String(result.exit ?? '—')) : ''}</div>`;
    };
    const foot = () => {
        if (step === 1) return footBtn(c.cancel, 'cancel') + footBtn(p.next, 'next', true, !selected);
        if (step === 2) return footBtn(p.previous, 'back', false, !!added) + footBtn(p.next, 'next', true, !ready(), ready() ? '' : form.auth === 'token' ? ag.needSecret : ag.needLogin);
        if (testing) return footBtn(p.previous, 'back', false, true) + footBtn(ag.testing, 'none', true, true);
        return result?.ok ? footBtn(ag.done, 'done', true) : footBtn(ag.back, 'edit') + footBtn(ag.retest, 'retest', true);
    };
    const note = () => step === 3 && result && !result.ok ? ag.savedNote : step === 2 && form.auth === 'login' ? ag.subscriptionShare : '';
    const draw = (focus?: string) => {
        if (!sheet.root.isConnected) return;
        sheet.root.querySelector('.sheet-h .wiz-steps')?.replaceWith(Object.assign(document.createElement('span'), { innerHTML: stepsHtml() }).firstElementChild!);
        sheet.setBody(body()); sheet.setFoot(foot());
        const n = sheet.root.querySelector<HTMLElement>('.sheet-f .note'); if (n) n.textContent = note();
        (focus ? sheet.root.querySelector<HTMLElement>(focus) : sheet.root.querySelector<HTMLElement>('.preset.on, .sheet-b input, .sheet-f .btn.primary:not(:disabled)'))?.focus({ preventScroll: true });
    };
    const fail = (e: unknown) => sheet.fail(String((e as Error).message || e));
    const refreshSecret = async () => {
        if (!form.secretVar || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(form.secretVar)) { secretState = 'missing'; return; }
        try { secretState = (await window.dock.console('secrets:status', { names: [form.secretVar] })).secrets[form.secretVar] ?? 'missing'; } catch { secretState = 'missing'; }
    };
    const refreshLogin = async () => { try { login = (await window.dock.preferences('detect')).codex.login; } catch { login = 'unknown'; } };
    const choose = async (name: string) => {
        selected = name; const x = preset()!;
        form.name = uniqueName(x.name); form.label = x.label; form.model = x.env?.ANTHROPIC_MODEL ?? ''; form.baseUrl = x.env?.ANTHROPIC_BASE_URL ?? '';
        form.secretVar = Object.values(x.secrets ?? {})[0] ?? (x.adapter === 'codex' ? 'OPENAI_API_KEY' : ''); form.auth = x.auth;
    };
    const toTest = async () => {
        step = 3; testing = true; result = null; draw();
        try { const r = await window.dock.console('agents:test', { name: added }); result = { ok: true, seconds: r.seconds, version: r.version ?? null, model: r.model ?? null, usage: r.usage ?? null }; }
        catch (e) { result = { ok: false, reason: String((e as Error).message || e) }; }
        testing = false; draw();
    };
    const act = async (action: string) => {
        sheet.fail('');
        if (action === 'cancel') return close();
        if (action === 'done') { finish(); return; }
        if (action === 'redetect') { await refreshLogin(); draw('[data-w-act="redetect"]'); return; }
        if (action === 'back') { readForm(); step = 1; draw(); return; }
        if (action === 'edit') { step = 2; result = null; draw(); return; }
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
                draw('[data-w-act="save-secret"]'); if (error) sheet.fail(error);
            }
            return;
        }
        if (action === 'next' && step === 1) {
            if (!selected) return;
            step = 2; busy = true; draw();
            if (form.auth === 'token') await refreshSecret(); else await refreshLogin();
            busy = false; draw(); return;
        }
        if (action === 'next' && step === 2) {
            readForm(); const x = preset()!;
            const fields: Record<string, unknown> = { label: form.label };
            if (x.adapter === 'claude-code') { if (form.model) fields.model = form.model; if (form.baseUrl) fields.baseUrl = form.baseUrl; }
            else if (form.model) fields.model = form.model;
            if (form.auth === 'token' && form.secretVar) fields.secretVar = form.secretVar;
            busy = true; draw();
            try {
                if (!added) { const r = await window.dock.console('agents:add', { preset: x.name, name: form.name, ...fields, ...(x.adapter === 'codex' ? { auth: form.auth } : {}) }); added = r.name; madeDefault = !!r.madeDefault; }
                else await window.dock.console('agents:update', { name: added, ...fields });
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
    const sheet: Sheet = openSheet({ title: ag.wizardTitle, trigger, steps: stepsHtml(), body: `<div class="testbox">${mark('run')}<div><b>${esc(p.detecting)}</b></div></div>`, buttons: [c.cancel], wide: true,
        // 底栏按钮由下面的点击监听按 data-w-act 处理；只有打开时那个还没换掉的"取消"走这里。
        onButton: () => { if (!sheet.root.querySelector('[data-w-act]')) void close(); }, onClose });
    sheet.root.addEventListener('click', e => {
        const b = (e.target as Element).closest<HTMLButtonElement>('button'); if (!b || b.disabled) return;
        if (b.dataset.preset) { void choose(b.dataset.preset).then(() => draw(`[data-preset="${CSS.escape(b.dataset.preset!)}"]`)); return; }
        if (b.dataset.wAuth) { readForm(); form.auth = b.dataset.wAuth as 'login' | 'token'; dirty = true; void (form.auth === 'token' ? refreshSecret() : refreshLogin()).then(() => draw(`[data-w-auth="${form.auth}"]`)); return; }
        if (b.dataset.wAct) { e.stopPropagation(); void act(b.dataset.wAct).catch(fail); }
    });
    sheet.root.addEventListener('input', e => { const t = e.target as HTMLElement; if (t.matches('[data-w]') && (t as HTMLInputElement).type !== 'password') dirty = true; });
    sheet.root.addEventListener('change', e => { if ((e.target as HTMLElement).matches('[data-w="secretVar"]')) { readForm(); void refreshSecret().then(() => draw('[data-w="secretVar"]')); } });
    // 方向键在预设卡片之间移动并选中（单选组的键盘约定）。
    sheet.root.addEventListener('keydown', e => {
        const card = (e.target as Element).closest<HTMLElement>('[data-preset]'); if (!card || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        e.preventDefault(); const i = presets.findIndex(x => x.name === card.dataset.preset), next = presets[(i + (['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : -1) + presets.length) % presets.length];
        void choose(next.name).then(() => draw(`[data-preset="${CSS.escape(next.name)}"]`));
    });
    void (async () => {
        try { presets = (await window.dock.console('agents:presets')).presets; const rec = presets.find(x => x.recommended) ?? presets[0]; if (rec) await choose(rec.name); draw(); }
        catch (e) { draw(); fail(e); }
    })();
    return sheet;
}
