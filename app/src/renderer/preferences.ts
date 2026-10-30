import { ag, c, gx, p, pj, px, ro, s6, sc } from '../shared/copy';
import { esc } from '../shared/markdown';
import type { AgentPreset, Connections, GcItems, GcRun, Settings } from '../shared/types';
import { icon, menu, confirmAction, openSheet, field, trace, type Sheet } from './ui';
import { AgentsView, ProbeBox, RolesBox, forgetProbe, loadRoles, modelControl, presetCards, redrawSheet, variantField } from './agents';
import { bindChoices, choiceHtml, type Choice, type ChoiceSpec, type Opt } from './agent-custom';
import { goToSuggest } from './routing';
import brand from '../../design/icons/mark.svg';

const hostName = (host: string) => host === 'claude-code' ? 'Claude Code' : host;
const mark = (state: string) => `<span class="mk ${state}">${icon(({ok:'checkbox-circle-line',warn:'error-warning-line',fail:'close-circle-line',info:'information-line',skip:'indeterminate-circle-line',run:'loader-4-line'} as Record<string,string>)[state])}</span>`;
const hint = (text: string) => `<div class="hint">${mark('info')}<span>${esc(text)}</span></div>`;
const banner = (text: string) => text ? `<div class="banner fail" role="alert">${mark('fail')}<span>${esc(text)}</span></div>` : '';
const kv = (label: string, value: string, state = 'ok', tag = '') => `<div class="kv">${mark(state)}<span class="lb">${esc(label)}</span><span class="val mono" title="${esc(value)}">${esc(value)}</span>${tag}</div>`;
const row = (label: string, description: string, control: string) => `<div class="set-r"><div class="l">${esc(label)}<span>${description}</span></div><div class="ctl">${control}</div></div>`;
// 机器正忙按原因写：可用内存不够写内存，其余写 CPU。
const MEM_LOW_CHOICES = [3, 5, 10, 15, 20];
const busyText = (info: Settings['parallel']) => info.busyReason === 'memory' ? s6.concurrencyAutoBusyMem(info.busyFreeGb ?? info.freeGb) : s6.concurrencyAutoBusy(info.cpu ?? 0);
const section = (title: string, description: string, body: string) => `<div class="sect"><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}${body}</div>`;
// 与 agents.ts 的导入向导同形：预设与测试结果都来自核心（agents:presets / agents:test）。
type Preset = AgentPreset;
interface WizardTest { ok: boolean; seconds?: number; version?: string | null; reason?: string }

export class PreferencesView {
    settings!: Settings;
    connections?: Connections;
    wizard = false;
    step = 1;
    private selected = new Set<string>();
    private active = '';
    private version = '';
    private container?: HTMLElement;
    private detecting = false;
    // 检测在途时又收到检测请求：记下来，等在途检测结束后补做一次（多次请求合并成一次）。
    // 技能操作完成后的刷新如果被在途检测直接丢掉，界面会停在操作前的状态（020 B）。
    private detectPending = false;
    private busy = false;
    // 引导页上一次画出的 HTML：内容没变就不重画（172）。离开引导或重新进入页面时清空。
    private renderedWizard = '';
    private installProgress = { done: 0, total: 0 };
    private error = '';
    private hostErrors = new Map<string,string>();
    private messages = new Map<string,string>();
    private messageTimers = new Map<string,ReturnType<typeof setTimeout>>();
    // 数据一节（012）：清除缓存的忙碌态与结果说明。
    private cacheBusy = false;
    private cacheNote = '';
    // 列表一节（018）：清空任务列表 / 项目列表后的行内说明。
    private tasksNote = '';
    private projectsNote = '';
    // 数据一节的“清理”（ar gc）：启动时在后台检查一次（只列出，不删）；结果、检查状态与上次清理完成的说明。
    private gcState: 'checking' | 'ready' | 'failed' = 'checking';
    private gcItems: GcItems | null = null;
    private gcError = '';
    private gcDone = '';
    // 网络代理一节（099）：点"手动填写"只是显示地址行（不写配置，保存通过校验才写）；地址输入框的草稿、错误码和"已保存"的短暂提示。
    private proxyManual = false;
    private proxyDraft: string | null = null;
    private proxyError = '';
    private proxySaved = false;
    private proxyTimer?: ReturnType<typeof setTimeout>;
    // Agent 页"执行者"区（B）；Codex 的编辑回调到这里复用设置控件（C10）。
    private agentsView = new AgentsView({
        openCodexEdit: (trigger, name, label, others) => { void this.openCodexEdit(trigger, name, label, others); },
        codexChange: () => this.connections?.codex.change,
        ack: () => { void this.ack(); },
        settingsLoaded: settings => { this.settings = settings; this.redrawStatus(); },
    });
    // 引导第 3 步：要导入的 Agent（预设、密钥状态、导入与测试结果都在这里，不跨次运行保留）。
    private wizardPresets: Preset[] = [];
    private wizardAgents: string[] = [];
    private wizardPreset = '';
    private wizardAgentName = '';
    private wizardAdded = '';
    private wizardSecretVar = '';
    private wizardSecretState: 'set' | 'missing' | null = null;
    private wizardResult: WizardTest | null = null;
    private wizardTesting = false;
    private wizardLoading = false;
    // 引导第 3 步：可选的每日任务上限草稿与校验提示（空着就是不限，不写 limits）。
    private wizardLimit = '';
    private wizardLimitErr = '';
    // 第 3 步"失败时想换用的强执行者"：测试通过后读到的已启用执行者，和所选的那个（空串是"不设"）。
    private wizardStrongList: { name: string; label: string }[] = [];
    private wizardStrong = '';
    // 引导第 4 步：所选项目文件夹与"添加后打开初始化预览"。
    private wizardProject = '';
    private wizardOpenInit = true;
    constructor(private redrawShell: () => void, private redrawStatus: () => void, private openProject?: (path: string) => void, private running: () => number = () => 0) {}
    focusManaged() { this.container?.querySelector('#managed-section')?.scrollIntoView({block:'start'}); }
    unmount() { this.container=undefined; this.active=''; clearInterval(this.parallelTimer); }
    async init() { this.settings = await window.dock.preferences('settings'); this.wizard = !this.settings.own.wizardDone; void this.detect(); void this.gcCheck(); }
    mount(container: HTMLElement, page: string, version: string) {
        // 进入页面时丢掉上次没保存的代理草稿（同一页面内重绘不丢）。
        if (this.active !== page) { this.proxyManual = false; this.proxyDraft = null; this.proxyError = ''; this.proxySaved = false; }
        this.container = container; this.active = page; this.version = version;
        this.error='';
        container.replaceChildren(); this.renderedWizard = '';
        this.render();
        container.onclick = e => { void this.click(e).catch(error => { this.error = String(error.message || error); this.render(); }); };
        // 代理地址输入框：输入时记下草稿（整块重建后还在）；回车等同点"保存"。
        container.oninput = e => { const input = e.target as HTMLInputElement; if (input.matches?.('[data-pref=proxy-url]')) this.proxyDraft = input.value; if (input.matches?.('[data-wizard-limit]')) { this.wizardLimit = input.value; this.wizardLimitErr = ''; const er = container.querySelector<HTMLElement>('[data-wizard-limit-error]'); if (er) { er.textContent = ''; er.classList.remove('on'); } input.classList.remove('bad'); } };
        container.onkeydown = e => { if (e.key === 'Enter' && (e.target as HTMLElement).matches?.('[data-pref=proxy-url]')) { e.preventDefault(); void this.saveProxyAddress(); } };
        if (page === 'connect') void this.detect();
        if (page === 'settings') { void this.refreshSettings(); this.startParallelTimer(); } else clearInterval(this.parallelTimer);
    }
    async refreshSettings() { try { this.settings = await window.dock.preferences('settings'); this.render(); this.redrawStatus(); } catch(e) { this.error=String(e); this.render(); } }
    async detect() {
        if (this.detecting) { this.detectPending = true; trace('detect-skip', { reason: '已有检测在进行，结束后补做一次' }); return; }
        const redraw = () => { if(this.wizard || this.active==='connect') this.render(); };
        this.detecting = true; redraw(); trace('detect-start');
        try { this.connections = await window.dock.preferences('detect'); trace('detect-done', { hosts: this.connections?.hosts.map(h => `${h.host}:${h.actions.join('/')}:${h.skills.map(s => s.skill + '=' + s.state).join(',')}`).join(' ') }); }
        catch(e) { this.error = String(e); }
        finally {
            this.detecting = false; redraw(); if (!this.wizard && this.active === 'connect') void this.agentsView.refresh(true);
            // 在途检测期间收到的请求合并成一次补做：只补一次，补做期间再来的请求才会再记一次。
            if (this.detectPending) { this.detectPending = false; trace('detect-again', { reason: '在途检测结束后补做一次' }); void this.detect(); }
        }
    }
    private button(label: string, action: string, cls = '', attrs = '') { return `<button class="btn ${cls}" data-pref="${action}" ${this.busy ? 'disabled' : ''} ${attrs}>${esc(label)}</button>`; }
    private render() {
        if (!this.container?.isConnected || (!this.wizard && this.active === 'tasks')) return;
        const html = this.wizard ? this.wizardPage() : `<div class="doc scroll"><div class="page-h sticky"><h1>${({connect:c.connect,settings:c.settings,about:c.about} as Record<string,string>)[this.active]}</h1>${this.active === 'connect' ? `<span class="lead">${p.subtitle}</span><span class="sp"></span>${this.button(p.detect,'detect','',this.detecting?'disabled':'')}<button class="btn primary" data-import-agent ${this.busy?'disabled':''}>${icon('add-line')}${esc(ag.import)}</button>` : ''}</div><div class="doc-in">${banner(this.error)}${this.active === 'connect' ? this.connectPage() : this.active === 'settings' ? this.settingsPage() : this.aboutPage()}</div></div>`;
        // 引导期间内容没变就不重画（172）：用户刚点中的输入框不会被换成新元素。检测、读密钥状态等异步结果回来时常常没有新内容。
        // 非引导页面照旧整块重建：页内还有 Agent 区等自己管理的子视图。
        if (this.wizard && html === this.renderedWizard && this.container.firstElementChild) return;
        this.renderedWizard = this.wizard ? html : '';
        const top = this.container.querySelector('.scroll')?.scrollTop || 0;
        // 整块重建会丢掉焦点：记下焦点所在控件的身份，重建后放回同一个控件（键盘用户连续操作不用重新 Tab）。
        const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
        const identity = focused ? ['data-choice','data-pref','data-pick','data-segment','data-value','data-operation','data-host','data-wizard-secret','data-wizard-limit','data-wizard-preset','data-wizard-variant'].filter(a => focused.hasAttribute(a)).map(a => `[${a}="${CSS.escape(focused.getAttribute(a)!)}"]`).join('') : '';
        // 输入框里还没保存的内容与光标：密钥框的值不在 HTML 里（只在输入框上），必须带过去；上限框的值在状态里，光标位置也要还原。
        const secret = this.container.querySelector<HTMLInputElement>('input[data-wizard-secret]');
        const typed = secret?.value ? { value: secret.value, name: secret.dataset.secretFor } : null;
        const caret = focused instanceof HTMLInputElement ? { start: focused.selectionStart, end: focused.selectionEnd } : null;
        this.container.innerHTML = html;
        // 代理一节的两处样式（界面稿里的内联样式）：页面的内容安全策略不允许 style 属性，改用脚本设置样式。
        this.container.querySelectorAll<HTMLElement>('[data-proxy-error]').forEach(node => { node.style.color = 'var(--fail)'; });
        this.container.querySelectorAll<HTMLElement>('[data-pref=proxy-url]').forEach(node => { node.style.width = '280px'; });
        const scroll = this.container.querySelector('.scroll'); if(scroll) scroll.scrollTop = top;
        const again = this.container.querySelector<HTMLInputElement>('input[data-wizard-secret]');
        // 换了预设（密钥变量名不同）就不带过去。
        if (typed && again && again.dataset.secretFor === typed.name) again.value = typed.value;
        const next = identity ? this.container.querySelector<HTMLElement>(identity) : null;
        next?.focus({ preventScroll: true });
        if (next instanceof HTMLInputElement && caret?.start != null) { try { next.setSelectionRange(caret.start, caret.end ?? caret.start); } catch { /* 该类型的输入框没有光标位置 */ } }
        const agents = this.container.querySelector<HTMLElement>('[data-agents]');
        if (agents) this.agentsView.mount(agents);
    }
    private connectPage() {
        const data = this.connections;
        if (!data) return hint(p.detecting);
        const hosts = data.hosts.map(h => {
            const custom = h.skills.some(s=>s.state==='custom');
            const skills = h.skills.map(s => kv(s.skill, s.state === 'custom' ? p.custom : s.version || p.missing, s.state === 'custom' ? 'brand' : s.state==='missing' ? 'skip' : s.state==='update' ? 'info':s.state==='newer'?'skip':'ok', s.state==='missing' ? '' : `<span class="tag ${s.state==='custom'?'brand':s.state==='update'?'info':s.state==='newer'?'':'ok'}">${esc(s.state==='custom'?p.protected:s.state==='update'?p.update(data.availableVersion):s.state==='newer'?p.newer:p.latest)}</span>`)).join('');
            const order=['rollback','install','reinstall','replace','update'];
            const buttons = [...h.actions].sort((a,b)=>order.indexOf(a)-order.indexOf(b)).flatMap(action => action==='replace' ? h.skills.filter(s=>s.state==='custom').map(s=>this.button(p.actions[action],'host','sm',`data-host="${h.host}" data-operation="replace" data-skill="${s.skill}"`)) : [this.button(p.actions[action],'host',`sm ${action==='update'?'primary':action==='rollback'?'quiet':''}`,`data-host="${h.host}" data-operation="${action}"`)]).join('');
            const date=new Date(h.installedAt),pad=(n:number)=>String(n).padStart(2,'0');
            const installed=h.installedAt?p.lastInstall(`${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`):'';
            return `<div class="card ${!h.detected?'is-off':custom?'is-brand':''}" data-host-card="${h.host}"><div class="card-h">${icon('terminal-line')}<b>${hostName(h.host)}</b><span class="aside">${h.detected?mark('ok')+p.detected:p.missingHost}</span></div><div class="card-b">${h.detected?`<div class="path mono">${esc(h.root)}</div>${skills}${h.skills.some(s=>s.skill==='agent-router'&&s.state==='custom')?hint(p.customHelp):''}${h.legacy?.length?`<div data-legacy-skills>${hint(p.legacySkills(h.legacy.map(l=>l.skill).join('、')))}${h.legacy.some(l=>!l.link)?this.button(p.removeLegacy,'host','sm',`data-legacy-remove data-host="${h.host}" data-operation="removeLegacy"`):''}</div>`:''}`:hint(p.hostMissing(hostName(h.host)))}${banner(this.hostErrors.get(h.host)||'')}</div>${h.detected?`<div class="card-f"><span class="note" role="status">${esc(this.messages.get(h.host)||(custom?p.customIdle:installed))}</span>${buttons}</div>`:''}</div>`;
        }).join('');
        return section(p.dispatchers,p.dispatchHelp,`<div class="cards2">${hosts}</div>`)+`<div data-agents></div>`;
    }
    private description(key: string, fallback = '') { const o=this.settings.overrides[key]; return o?`<span class="override">${esc(p.override(o.name,o.value))}</span>`:esc(fallback); }
    private segment(key: string, values: string[], labels: string[], selected: string, icons?: string[]) {
        // theme 与 closeAction 是软件自己的偏好，不受执行者配置错误影响。
        const own = key === 'theme' || key === 'closeAction';
        return `<div class="segm ${icons?'icons':''}">${values.map((v,i)=>`<button data-segment="${key}" data-value="${v}" class="${selected===v?'on':''}" aria-pressed="${selected===v}" title="${labels[i]}" aria-label="${labels[i]}" ${this.busy||this.settings.reason&&!own?'disabled':''}>${icons?icon(icons[i]):labels[i]}</button>`).join('')}</div>`;
    }
    private managedToggle(wizard = false) {
        return `<div class="set">${row(wizard?p.wizardManaged:p.managedToggle,esc(wizard?p.wizardManagedHelp:p.managedToggleHelp),`<button class="toggle ${this.settings.managed?'on':''}" data-pref="managed" role="switch" aria-label="${wizard?p.wizardManaged:p.managedToggle}" aria-checked="${this.settings.managed}" ${this.busy||this.settings.reason?'disabled':''}></button>`)}</div>`;
    }
    private settingsPage() {
        return `<div id="managed-section">${section(p.managed,p.managedHelp,this.managedToggle())}</div>`+
        this.parallelSection()+
        this.proxySection()+
        section(sc.settingsSec,'',`<div class="set">${row(sc.leadUsage,esc(sc.leadUsageHelp),`<button class="toggle ${this.settings.leadUsage?'on':''}" data-pref="lead-usage" role="switch" aria-label="${sc.leadUsage}" aria-checked="${this.settings.leadUsage}" ${this.busy||this.settings.reason?'disabled':''}></button>`)}</div>`)+
        section(p.watch,'',`<div class="set">${row(p.watchTitle,this.description('watchWindow',p.watchHelp),this.segment('watchWindow',['auto','always','never'],p.watchOptions,this.settings.values.watchWindow!))}</div>`)+
        section(p.notifications,'',`<div class="set">${row(p.notify,esc(p.notifyHelp),`<button class="toggle ${this.settings.own.notifications?'on':''}" data-pref="notifications" role="switch" aria-label="${p.notify}" aria-checked="${this.settings.own.notifications}" ${this.busy?'disabled':''}></button>`)}</div>`)+
        section(p.appearance,'',`<div class="set">${row(p.theme,'',this.segment('theme',['system','light','dark'],p.themes,this.settings.own.theme,['computer-line','sun-line','moon-line']))}</div>`)+
        section(p.window,'',`<div class="set">${row(p.closeAction,esc(p.closeActionHelp),this.segment('closeAction',['ask','tray','quit'],[p.closeOptions.ask,p.closeOptions.tray,p.closeOptions.quit],this.settings.own.closeAction))}</div>`)+
        section(p.config,'',banner(this.settings.reason?p.configError(this.settings.reason):'')+`<div class="set">${row(p.location,`<span class="mono">${esc(this.settings.file)}</span>`,this.button(p.openFolder,'folder','sm quiet'))}</div>`)+
        this.listsSection()+
        this.dataSection();
    }
    // 并行一节（D59，界面稿"并行·自动 / 并行·机器正忙 / 并行·固定"）：同时运行的任务数（config.json 的 concurrency）是"自动 / 固定"分段。
    // 自动：一行估算（核心给的估算值、核数、可用内存；机器正忙时换成暂停说明）+ "自动时最多"1～8 的下拉（concurrencyMax）。
    // 固定：一行 1～8 的下拉；配置里手写的越界值不选任何一项，在下拉前显示当前值。
    private parallelSection() {
        const value = this.settings.concurrency, auto = value === 'auto', info = this.settings.parallel, max = this.settings.concurrencyMax;
        const pick = (key: string, label: string, selected: number | null) => `<button class="sel" data-pick="${key}" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}" ${this.settings.reason || this.busy ? 'disabled' : ''}><span class="${selected === null ? 'ph' : 'mono'}">${selected === null ? '–' : selected}</span>${icon('arrow-down-s-line')}</button>`;
        const head = row(s6.concurrency, esc(s6.concurrencyHelp), this.segment('concurrencyMode', ['auto', 'fixed'], [s6.concurrencyModes.auto, s6.concurrencyModes.fixed], auto ? 'auto' : 'fixed'));
        if (!auto) {
            const inRange = Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 8;
            const current = inRange ? '' : `<span class="mono muted" data-concurrency-value>${value}</span>`;
            return section(s6.parallelSec, s6.parallelLead, `<div class="set">${head}${row(s6.concurrencyFixed, esc(s6.concurrencyFixedHelp), current + pick('concurrency', s6.concurrencyModes.fixed, inRange ? value as number : null))}</div>`);
        }
        const memLowPick = `<button class="sel" data-pick="memLowPercent" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(s6.memLowPercent)}" ${this.settings.reason || this.busy ? 'disabled' : ''}><span class="mono">${esc(s6.memLowPercentOption(this.settings.memLowPercent))}</span>${icon('arrow-down-s-line')}</button>`;
        const now = info.busy ? `<span class="tag info" data-parallel-now>${esc(busyText(info))}</span>` : `<span class="mono muted" data-parallel-now>${esc(s6.concurrencyAutoNow(info.estimate, info.cores, info.freeGb))}</span>`;
        return section(s6.parallelSec, s6.parallelLead, `<div class="set">${head}${row(s6.concurrencyAuto, esc(s6.concurrencyAutoHelp), now)}${row(s6.concurrencyMax, esc(s6.concurrencyMaxHelp), pick('concurrencyMax', s6.concurrencyMax, max))}${row(s6.memLowPercent, esc(s6.memLowPercentHelp(info.memLowGb)), memLowPick)}</div>`);
    }
    // 估算信息每 10 秒刷新一次：只在设置页可见（窗口没隐藏）、没有操作在进行、没有下拉菜单打开时重读；
    // 只原地改"自动估算"那一行的文字与样式，不重建页面，免得打断操作、重绘别的节点。
    private parallelTimer?: ReturnType<typeof setInterval>;
    private startParallelTimer() {
        clearInterval(this.parallelTimer);
        this.parallelTimer = setInterval(() => {
            if (this.active !== 'settings' || this.wizard || !this.container?.isConnected || document.hidden || this.busy || document.querySelector('.ctx')) return;
            void this.refreshParallelNow();
        }, 10000);
    }
    private async refreshParallelNow() {
        try {
            const fresh = await window.dock.preferences('settings');
            // 等待期间如果开始了操作或离开了设置页，丢弃这次结果。
            if (this.active !== 'settings' || this.wizard || this.busy || document.querySelector('.ctx')) return;
            this.settings.parallel = fresh.parallel;
            const node = this.container?.querySelector<HTMLElement>('[data-parallel-now]');
            if (!node) return;
            const info = fresh.parallel;
            node.className = info.busy ? 'tag info' : 'mono muted';
            node.textContent = info.busy ? busyText(info) : s6.concurrencyAutoNow(info.estimate, info.cores, info.freeGb);
        } catch { /* 这次没读到就等下一次 */ }
    }
    private async choosePick(button: HTMLElement, key: string) {
        // 内存不够时暂停的比例（182）：3、5、10、15、20 五项，文字是 s6.memLowPercentOption。
        if (key === 'memLowPercent') { menu(button, MEM_LOW_CHOICES.map(n => ({ label: s6.memLowPercentOption(n), run: () => { void this.save(key, n); } })), true); return; }
        menu(button, [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ label: String(n), run: () => { void this.save(key, n); } })), true);
    }
    // 网络代理一节（099，界面稿"代理·跟随系统 / 代理·系统代理未开启 / 代理·手动填写"）：不使用 / 跟随系统代理 / 手动填写。
    // 说明行：不使用与手动填写各一句固定的话；跟随系统代理写这一刻读到的结果。手动填写多一行地址，保存前由核心校验，不合法时在地址行显示原因。
    private proxySection() {
        const state = this.settings.proxy, mode = this.proxyManual ? 'manual' : state.mode;
        const found = state.system?.url;
        const system = found ? esc(px.systemFound(found)).replace(esc(found), `<span class="mono">${esc(found)}</span>`)
            : esc(state.system?.reason === 'unreadable' || state.system?.reason === 'unsupported' ? px.systemUnreadable : px.systemNone);
        const description = mode === 'off' ? esc(px.offHelp) : mode === 'system' ? system : esc(px.manualHelp);
        const choices = ['off', 'system', 'manual'];
        const lead = row(px.row, description, this.segment('proxy', choices, choices.map(value => px.modes[value]), mode));
        const failure = ({ PROXY_CREDENTIALS: px.errCredentials, PROXY_FORMAT: px.errFormat, PROXY_EMPTY: px.errEmpty } as Record<string, string>)[this.proxyError];
        const off = this.busy || this.settings.reason ? 'disabled' : '';
        const address = mode !== 'manual' ? '' : row(px.url, failure ? `<span data-proxy-error>${esc(failure)}</span>` : '',
            `<input class="inp mono" data-pref="proxy-url" aria-label="${px.url}" placeholder="${px.urlPlaceholder}" value="${esc(this.proxyDraft ?? state.url)}" ${this.settings.reason ? 'disabled' : ''}>`
            + `<button class="btn sm" data-pref="proxy-save" ${off}>${esc(this.proxySaved ? px.saved : px.save)}</button>`);
        return section(px.sec, px.lead, `<div class="set">${lead}${address}</div>`);
    }
    // 切换模式：不使用 / 跟随系统代理立即写入；手动填写只显示地址行，等保存通过校验才写。
    private async chooseProxyMode(mode: string) {
        this.proxyError = ''; this.proxySaved = false;
        if (mode === 'manual') { this.proxyManual = true; this.render(); return; }
        this.proxyManual = false; this.proxyDraft = null;
        await this.saveProxy({ mode });
    }
    private async saveProxyAddress() {
        if (this.busy) return;
        this.proxyDraft ??= this.settings.proxy.url;
        await this.saveProxy({ mode: 'manual', url: this.proxyDraft });
    }
    private async saveProxy(value: { mode: string; url?: string }) {
        this.busy = true; this.error = ''; this.proxyError = ''; this.proxySaved = false; this.render();
        try {
            this.settings = await window.dock.preferences('save', { key: 'proxy', value });
            if (value.mode === 'manual') {
                // 保存成功：说明行恢复，按钮短暂显示"已保存"。
                this.proxyManual = false; this.proxyDraft = null; this.proxySaved = true;
                clearTimeout(this.proxyTimer);
                this.proxyTimer = setTimeout(() => { this.proxySaved = false; if (!this.wizard && this.active === 'settings') this.render(); }, 2000);
            }
        }
        catch (e) {
            const message = String((e as Error).message || e), code = /PROXY_(?:CREDENTIALS|FORMAT|EMPTY)/.exec(message)?.[0];
            if (code) this.proxyError = code; else this.error = message;
        }
        finally { this.busy = false; this.render(); this.redrawStatus(); }
    }
    // 列表一节（018）：清空任务列表与清空项目列表，放在"数据"一节之前。只清软件里的列表。
    private listsSection() {
        const tasksNote = this.tasksNote ? `<span class="note" role="status" data-tasks-note>${esc(this.tasksNote)}</span>` : '';
        const projectsNote = this.projectsNote ? `<span class="note" role="status" data-projects-note>${esc(this.projectsNote)}</span>` : '';
        return section(p.lists, p.listsHelp, `<div class="set">${row(p.clearTasks, esc(p.clearTasksHelp) + tasksNote, `<button class="btn sm danger" data-pref="clear-tasks" ${this.busy?'disabled':''}>${esc(p.clearTasksButton)}</button>`)}${row(p.clearProjects, esc(p.clearProjectsHelp) + projectsNote, `<button class="btn sm danger" data-pref="clear-projects" ${this.busy?'disabled':''}>${esc(p.clearProjectsButton)}</button>`)}</div>`);
    }
    // 数据一节（012）：清除缓存与重置。重置的确认框在 openReset 里。
    private dataSection() {
        const note = this.cacheNote ? `<span class="note" role="status" data-cache-result>${esc(this.cacheNote)}</span>` : '';
        const clear = `<button class="btn sm" data-pref="clear-cache" ${this.busy||this.cacheBusy?'disabled':''}>${esc(this.cacheBusy?p.clearingCache:p.clearCacheButton)}</button>`;
        // 上次重置没删完：提示路径，用户看过就清除标记。
        const leftover = this.settings.leftover
            ? `<div class="banner info" data-leftover>${mark('info')}<div class="rt"><span>${esc(p.resetLeftover(this.settings.leftover.home))}</span></div><button class="btn sm" data-pref="ack-leftover">${esc(p.ack)}</button></div>`
            : '';
        return section(p.data, p.dataHelp, leftover + `<div class="set">${this.gcRow()}${row(p.clearCache, esc(p.clearCacheHelp)+note, clear)}${row(p.resetApp, esc(p.resetHelp), `<button class="btn sm danger" data-pref="reset-app" ${this.busy?'disabled':''}>${esc(p.resetButton)}</button>`)}</div>`);
    }
    // 清理（ar gc）：KB / MB / GB 写法，一位小数。
    private sizeText(bytes: number) {
        const kb = bytes / 1024;
        return kb < 1024 ? `${kb.toFixed(1)} KB` : kb < 1024 * 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${(kb / 1024 / 1024).toFixed(1)} GB`;
    }
    private gcCount() { const g = this.gcItems; return g ? g.worktrees.length + g.slots.length + g.sessions.length : 0; }
    // 数据一节最上面的“清理”一行：说明末尾写检查结果；有可清理项时品牌色写数量与大小，按钮是“清理…”（点了才打开确认框，不自动删）。
    private gcRow() {
        const found = this.gcState === 'ready' && this.gcCount() > 0;
        // 完成说明后面接检查结果，中间补一个句号。
        const done = this.gcDone ? ` <span class="ok-text" data-gc-done>${esc(this.gcDone)}</span>。` : '';
        const tail = this.gcState === 'checking' ? ` ${esc(s6.gcChecking)}`
            : this.gcState === 'failed' ? ` ${esc(s6.gcCheckFailed(this.gcError))}`
                : found ? ` <em class="attn" data-gc-found>${esc(s6.gcFound(this.gcCount(), this.sizeText(this.gcItems!.bytes)))}</em>` : ` ${esc(s6.gcIdle)}`;
        const button = found
            ? `<button class="btn sm" data-pref="gc" ${this.busy?'disabled':''}>${esc(s6.gcButton)}</button>`
            : `<button class="btn sm quiet" data-pref="gc-recheck" ${this.busy||this.gcState==='checking'?'disabled':''}>${esc(s6.gcRecheck)}</button>`;
        return row(s6.gc, esc(s6.gcHelp(this.settings.retentionDays)) + done + tail, button).replace('<div class="set-r">', '<div class="set-r" data-gc-row>');
    }
    // 软件启动时在后台检查一次，也供“重新检查”和清理完成后复用；只列出，不删。手动重新检查会清掉上次清理完成的说明。
    async gcCheck(manual = false) {
        if (manual) this.gcDone = '';
        this.gcState = 'checking'; this.gcError = '';
        this.renderSettings();
        try { this.gcItems = await window.dock.console('gc:check') as GcItems; this.gcState = 'ready'; }
        catch (e) { this.gcError = String((e as Error)?.message || e); this.gcState = 'failed'; }
        this.renderSettings();
    }
    private renderSettings() { if (!this.wizard && this.active === 'settings') this.render(); }
    // 清理确认框：逐项写原因、名字和大小；点“清理”才调用 gc:run。worktree 写目录名，会话记录写“执行者 · 日期”。
    private openGc(trigger: HTMLElement) {
        const g = this.gcItems;
        if (!g) return;
        const base = (file: string) => file.split(/[\\/]/).filter(Boolean).at(-1) ?? file;
        const now = window.dock.demoNow ?? Date.now();
        const line = (iconName: string, reason: string, name: string, size: number) => `<div class="kv" data-gc-item><span class="mk">${icon(iconName)}</span><span class="lb">${esc(reason)}</span><span class="val mono" title="${esc(name)}">${esc(name)}</span><span class="mono muted">${size > 0 ? esc(this.sizeText(size)) : ''}</span></div>`;
        const rows = [
            ...g.worktrees.map(w => line('git-branch-line', s6.gcReason[w.reason] ?? w.reason, base(w.dir), w.size)),
            ...g.slots.map(s => line('git-branch-line', s6.gcReason.slot, base(s.file), s.size)),
            ...g.sessions.map(s => line('chat-history-line', s6.gcSessionReason(this.settings.retentionDays), s6.gcSession(s.worker, new Date(now - s.ageDays * 86400000).toLocaleDateString('en-CA')), s.size)),
        ].join('');
        const sheet = openSheet({ title: s6.gcTitle(this.gcCount()), trigger, body: `<p class="sheet-lead">${esc(s6.gcLead(this.sizeText(g.bytes)))}</p><div class="card"><div class="card-b">${rows}</div></div>`, buttons: [c.cancel, s6.gcConfirm],
            onButton: (index, s) => {
                if (index === 0) { s.close(); return; }
                s.busy(true);
                s.fail('');
                s.root.querySelector<HTMLElement>('.sheet-btns button:last-of-type')!.innerHTML = `<span class="mk run">${icon('loader-4-line')}</span>${esc(s6.gcRunning)}`;
                void (async () => {
                    try {
                        const result = await window.dock.console('gc:run') as GcRun;
                        const failed = result.errors?.length ?? 0, cleaned = (result.worktrees?.length ?? 0) + (result.slots?.length ?? 0) + (result.sessions?.length ?? 0) - failed;
                        this.gcDone = s6.gcDone(cleaned, this.sizeText(result.bytes ?? 0)) + (failed ? s6.gcPartial(failed) : '');
                        s.close();
                        await this.gcCheck();
                    }
                    catch (e) { s.busy(false); s.fail(String((e as Error)?.message || e)); }
                })();
            } });
        // 底栏最后一个按钮默认是主按钮：清理换成危险样式；默认焦点在取消。
        const buttons = sheet.root.querySelectorAll<HTMLButtonElement>('.sheet-btns button');
        buttons[1]?.classList.remove('primary');
        buttons[1]?.classList.add('danger');
        buttons[0]?.focus({ preventScroll: true });
    }
    private secretNames() {
        const names = new Set<string>();
        for (const profile of Object.values(this.settings.profiles ?? {}))
            for (const name of Object.values(profile.secrets ?? {})) if (typeof name === 'string') names.add(name);
        return [...names].sort();
    }
    private formatBytes(bytes: number) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
        return `${(bytes/1024/1024).toFixed(1)} MB`;
    }
    private async clearCache() {
        if (this.cacheBusy) return;
        this.cacheBusy = true; this.cacheNote = ''; this.error = ''; this.render();
        try {
            const result = await window.dock.preferences('clearCache');
            const bytes = Number(result?.bytes) || 0, skipped = Number(result?.skipped) || 0;
            // 有跳过的文件时在大小后面补一句；什么都没清到才显示"没有可清除的缓存"。
            this.cacheNote = bytes > 0 || skipped > 0
                ? p.cacheCleared(this.formatBytes(bytes)) + (skipped > 0 ? ` · ${p.cacheSkipped(skipped)}` : '')
                : p.cacheNothing;
        }
        catch(e) { this.error = String((e as Error)?.message || e); }
        finally { this.cacheBusy = false; this.render(); }
    }
    // 清空任务列表（018）：确认框正文的数量是打开时会清掉的已结束任务数（进行中的保留）；为 0 时直接显示"列表已经是空的"。
    // 确认后主进程一次把已结束任务的键加入 hidden；项目里的任务记录文件不删，不改 runs.jsonl。
    private async clearTasks(trigger: HTMLElement) {
        this.error = ''; this.tasksNote = '';
        // TODO(lead): A.2 写"n 是实际会清掉的数量"，这里按 C.9 的"已结束任务数"算（渲染层拿不到派发进程是否仍存活）。
        // 严格一致要主进程提供可清数量预览（打开确认框多一次进程查询，约 1～4 秒）；正常情况两者相等，边角情况见汇报。
        const finished = (await window.dock.snapshot()).tasks.filter(t => t.status !== 'run').length;
        if (!finished) { this.tasksNote = p.listEmpty; this.render(); return; }
        if (!await confirmAction(p.clearTasksTitle(finished), p.clearTasksBody(finished), p.clearConfirm, trigger, true)) return;
        this.busy = true; this.render();
        try {
            const result = await window.dock.preferences('clearTasks');
            this.tasksNote = p.tasksCleared(Number(result?.removed) || 0);
        }
        catch(e) { this.error = String((e as Error)?.message || e); }
        finally { this.busy = false; this.render(); this.redrawStatus(); }
    }
    // 清空项目列表（018）：所有项目取消登记；项目文件夹和里面的文件都不动，之后可以重新添加。
    private async clearProjects(trigger: HTMLElement) {
        this.error = ''; this.projectsNote = '';
        const list = await window.dock.console('projects:list');
        const count = Array.isArray(list?.projects) ? list.projects.length : 0;
        if (!count) { this.projectsNote = p.listEmpty; this.render(); return; }
        if (!await confirmAction(p.clearProjectsTitle(count), p.clearProjectsBody(count), p.clearConfirm, trigger, true)) return;
        this.busy = true; this.render();
        try {
            const result = await window.dock.console('projects:clear');
            this.projectsNote = p.projectsCleared(Number(result?.removed) || 0);
        }
        catch(e) { this.error = String((e as Error)?.message || e); }
        finally { this.busy = false; this.render(); this.redrawStatus(); }
    }
    // 重置确认框：默认焦点在"取消"，正文列出要删除的公共目录；有进行中任务时禁用确认并说明原因。
    private async openReset(trigger: HTMLElement) {
        await this.refreshSettings();
        const running = this.running();
        const names = this.secretNames();
        const choice = (key: string, label: string, help: string) => `<button class="choice" role="checkbox" aria-checked="false" data-reset-check="${key}"><span class="cb"></span><span class="ct">${esc(label)}<span>${esc(help)}</span></span></button>`;
        const body = `<p class="sheet-lead">${esc(p.resetBody)}</p><div class="reset-path mono" data-reset-home>${esc(this.settings.home)}</div><div class="hint">${mark('info')}<span>${esc(p.resetKeep)}</span></div>`+
            (running ? `<div class="banner fail" role="alert">${mark('fail')}<div class="rt"><span>${esc(p.resetRunning(running))}</span></div></div>` : '')+
            (names.length ? choice('secrets', p.resetSecrets, p.resetSecretsHelp(names.join('、'))) : '')+
            choice('skills', p.resetSkills, p.resetSkillsHelp);
        const sheet = openSheet({ title: p.resetTitle, trigger, body, buttons: [c.cancel, p.resetConfirm],
            onButton: (index, s) => {
                if (index === 0) { s.close(); return; }
                if (running) return;
                const on = (key: string) => s.root.querySelector<HTMLElement>(`[data-reset-check=${key}]`)?.getAttribute('aria-checked') === 'true';
                s.busy(true); s.fail('');
                const primary = s.root.querySelector<HTMLButtonElement>('.sheet-btns button:last-of-type');
                if (primary) primary.innerHTML = `<span class="mk run">${icon('loader-4-line')}</span>${esc(p.resetting)}`;
                void window.dock.preferences('reset', { secrets: on('secrets'), skills: on('skills') }).catch(error => {
                    s.busy(false); s.fail(String((error as Error)?.message || error));
                });
            } });
        const buttons = sheet.root.querySelectorAll<HTMLButtonElement>('.sheet-btns button');
        // 危险样式与默认焦点：确认按钮危险色，焦点放在取消（规范 012 B8）。
        buttons[1].classList.remove('primary'); buttons[1].classList.add('danger');
        buttons[1].disabled = running > 0;
        buttons[0].focus({ preventScroll: true });
        for (const option of sheet.root.querySelectorAll<HTMLButtonElement>('[data-reset-check]')) option.onclick = () => {
            const on = option.getAttribute('aria-checked') !== 'true';
            option.setAttribute('aria-checked', String(on));
            const cb = option.querySelector('.cb')!;
            cb.classList.toggle('on', on);
            cb.innerHTML = on ? icon('check-line') : '';
        };
    }
    private aboutPage() { return `<div class="sect about"><div class="about-brand"><div class="about-mark">${brand}</div><h2 class="wordmark">${c.app}</h2></div><p class="mono">${esc(this.version)}</p><p>${c.protocol}</p><p>${p.about}</p>${this.button(p.rerun,'wizard')}</div>`; }
    private wizardPage() {
        const steps=p.wizardSteps.map((label,i)=>`<span class="${this.step===i+1?'on':this.step>i+1?'done':''}"><b>${this.step>i+1?icon('check-line'):i+1}</b>${label}</span>`).join('<span class="ln"></span>');
        let body='';
        if(this.step===1) body=`<h1>${p.welcome}</h1><p>${p.welcomeHelp}</p><div class="card"><div class="card-b">${['claude-code'].map(host=>{const h=this.connections?.hosts.find(h=>h.host===host);return kv(hostName(host),this.detecting?p.detecting:h?.detected?h.root:p.missingHost,this.detecting?'run':h?.detected?'ok':'skip');}).join('')}${kv('Codex CLI',this.detecting?p.detecting:this.connections?.codex.version||p.codexMissing,this.detecting?'run':this.connections?.codex.installed?'ok':'fail')}</div></div>`;
        if(this.step===2) body=`<h1>${p.installSkills}</h1><p>${p.installHelp}</p>${this.connections?.hosts.filter(h=>h.detected).flatMap(h=>h.skills.map(s=>{const key=h.host+'/'+s.skill,on=this.selected.has(key);return `<button class="choice" role="checkbox" aria-checked="${on}" data-choice="${key}" ${this.busy||s.state==='newer'?'disabled':''}><span class="cb ${on?'on':''}">${on?icon('check-line'):''}</span><span class="ct">${hostName(h.host)} · ${s.skill}<span>${s.state==='custom'?p.customChoice:p.skillHelp[s.skill]}</span></span>${s.state==='latest'||s.state==='custom'||s.state==='newer'?`<span class="tag ${s.state==='custom'?'brand':''}">${esc(s.state==='latest'?p.wizardLatest:s.state==='custom'?p.wizardCustom:p.newer)}</span>`:''}</button>`;})).join('')||''}${this.busy?`<div class="hint" role="status">${mark('run')}<span>${p.installing} <span class="mono">${this.installProgress.done}/${this.installProgress.total}</span></span></div>`:''}${this.managedToggle(true)}`;
        if(this.step===3) body=this.wizardAgentPage();
        if(this.step===4) body=this.wizardProjectPage();
        // 第 3 步测试通过后主按钮变成"下一步"；第 4 步完成时若选了文件夹才写 projects.json（不写仓库文件）。
        const primary = this.step===1 ? this.button(p.next,'next','primary',this.detecting?'disabled':'')
            : this.step===2 ? this.button(p.installNext,'next','primary',this.detecting?'disabled':'')
            : this.step===3 ? (this.wizardResult?.ok ? this.button(p.next,'next','primary','') : this.button(p.wizardAgentNext,'wizard-agent','primary',!this.wizardPreset||this.wizardLoading||this.wizardTesting?'disabled':''))
            : this.button(p.finish,'wizard-finish','primary','');
        return `<div class="wiz"><div class="wiz-steps">${steps}</div><div class="wiz-body scroll">${banner(this.error)}${body}</div><div class="wiz-f">${this.step>1?this.button(p.previous,'previous','quiet'):''}<span class="sp"></span>${this.button(p.skip,'skip','quiet')}${primary}</div></div>`;
    }
    // 引导第 3 步：只做"导入第一个 Agent"的最小版本（预设单选 + API Key 密码框 + 导入并测试）。
    private wizardPresetObj() { return this.wizardPresets.find(x => x.name === this.wizardPreset); }
    private wizardAgentPage() {
        const heading = `<h1>${p.wizardAgent}</h1><p>${p.wizardAgentHelp}</p>`;
        if (this.wizardLoading) return `${heading}<div class="hint" role="status">${mark('run')}<span>${p.detecting}</span></div>`;
        if (!this.wizardPresets.length) return `${heading}<div class="hint">${mark('info')}<span>${esc(p.wizardNoPresets)}</span></div>`;
        const x = this.wizardPresetObj();
        const cardList = presetCards(this.wizardPresets);
        const cards = cardList.map(item => {
            const on = item.members.some(m => m.name === this.wizardPreset);
            return `<button class="preset ${on?'on':''}" role="radio" aria-checked="${on}" data-wizard-preset="${esc(item.name)}" ${item.id?`data-card="${esc(item.id)}"`:''} tabindex="${on?0:-1}" ${this.busy||this.wizardAdded?'disabled':''}><span class="rd ${on?'on':''}"></span><span class="pk"><b>${esc(item.title)}${item.recommended?`<span class="tag brand">${esc(ag.recommended)}</span>`:''}</b><span>${esc(item.description)}</span></span></button>`;
        }).join('');
        const parts: string[] = [`<div class="presets" role="radiogroup" aria-label="${esc(p.wizardAgent)}">${cards}</div>`];
        if (x) {
            const variant = variantField(cardList.find(item => item.members.some(m => m.name === this.wizardPreset)), this.wizardPreset, 'data-wizard-variant', this.busy || !!this.wizardAdded);
            if (variant) parts.push(variant);
            parts.push(field(ag.auth, '', `<span>${esc(x.auth === 'token' ? ag.authToken : ag.authLogin)}</span>`));
            if (x.auth === 'token') {
                const state = this.wizardSecretState === 'set'
                    ? `<span class="tag ok" data-wizard-secret-state>${esc(ag.keySet)}</span>`
                    : `<span class="tag fail" data-wizard-secret-state>${esc(ag.keyMissing)}</span>`;
                parts.push(field(ag.secretName, ag.secretNameHelp, `<span class="mono">${esc(this.wizardSecretVar)}</span>`));
                parts.push(field(ag.secretSet, ag.secretSetHelp, `<div class="statusline"><input class="inp" data-wizard-secret data-secret-for="${esc(this.wizardSecretVar)}" type="password" placeholder="${esc(ag.secretPlaceholder)}" aria-label="${esc(ag.secretSet)}" ${this.busy?'disabled':''}><button class="btn" data-pref="wizard-secret" ${this.busy?'disabled':''}>${esc(ag.secretSave)}</button>${state}</div>`));
            }
            else parts.push(hint(ag.subscriptionShare));
        }
        if (this.wizardTesting) parts.push(`<div class="testbox">${mark('run')}<div><b>${esc(ag.testingLong)}</b><span>${esc(ag.testingHelp)}</span></div></div>`);
        else if (this.wizardResult) parts.push(this.wizardResult.ok
            ? `<div class="testbox ok" data-wizard-result="ok">${mark('ok')}<div><b>${esc(ag.testOk(String(this.wizardResult.seconds ?? '—'), this.wizardResult.version ?? '—'))}</b><span>${esc(ag.testOkHelp(x?.label ?? this.wizardAdded, false))}</span></div></div><div><button class="btn quiet sm" data-pref="wizard-suggest" ${this.busy ? 'disabled' : ''}>${icon('route-line')}${esc(ro.suggestHint)}</button></div><div class="form">${this.wizardLimitBlock()}${this.wizardStrongBlock()}</div>`
            : `<div class="testbox fail" data-wizard-result="fail">${mark('fail')}<div><b>${esc(ag.testFail)}</b><span>${esc(this.wizardResult.reason ?? '')}</span></div></div><div class="hint">${mark('info')}<span>${esc(ag.testFailHelp)}</span></div>`);
        return `${heading}<div class="form">${parts.join('')}</div>`;
    }
    // 引导第 4 步：只登记项目，不点"初始化…"、不写仓库里的任何文件。
    private wizardProjectPage() {
        const folder = this.wizardProject
            ? `<span class="mono" data-wizard-folder title="${esc(this.wizardProject)}">${esc(this.wizardProject)}</span>`
            : `<span class="ph" data-wizard-folder>${esc(p.wizardProjectNone)}</span>`;
        const choose = field(p.wizardProjectFolder, '', `<div class="statusline">${folder}<button class="btn" data-pref="wizard-choose-folder" ${this.busy?'disabled':''}>${icon('folder-3-line')}${esc(pj.chooseFolder)}</button></div>`);
        const open = `<button class="choice" data-pref="wizard-open-init" role="checkbox" aria-checked="${this.wizardOpenInit}" ${this.busy?'disabled':''}><span class="cb ${this.wizardOpenInit?'on':''}">${this.wizardOpenInit?icon('check-line'):''}</span><span class="ct">${esc(p.wizardOpenInit)}<span>${esc(p.wizardOpenInitHelp)}</span></span></button>`;
        return `<h1>${p.wizardProject}</h1><p>${p.wizardProjectHelp}</p><div class="form">${choose}${open}</div>`;
    }
    private wizardLimitBlock() {
        const bad = !!this.wizardLimitErr;
        const ctl = `<div class="statusline"><span>${esc(p.wizardLimitLabel)}</span><input class="inp${bad?' bad':''}" data-wizard-limit inputmode="numeric" value="${esc(this.wizardLimit)}" placeholder="${esc(p.wizardLimitNone)}" aria-label="${esc(p.wizardLimitLabel)}" ${this.busy?'disabled':''}><span>${esc(p.wizardLimitUnit)}</span></div><div class="ferr${bad?' on':''}" data-wizard-limit-error role="alert">${esc(this.wizardLimitErr)}</div>`;
        return field(p.wizardLimitQ, p.wizardLimitHelp, ctl);
    }
    // 第 3 步的第二个可跳过的问题（Stage07c 150，D82、D90）：失败时想换用的强执行者。
    // 只有一个执行者时不出下拉，只写一句说明；有多个已启用的执行者时是下拉，第一项"不设"。
    private wizardStrongBlock() {
        if (this.wizardStrongList.length < 2) return field(p.wizardStrongQ, esc(p.wizardStrongHelp), `<span class="muted" data-wizard-strong-only>${esc(p.wizardStrongOnly)}</span>`);
        const text = this.wizardStrongList.find(item => item.name === this.wizardStrong)?.label ?? p.wizardStrongNone;
        return field(p.wizardStrongQ, esc(p.wizardStrongHelp), `<span class="selw"><button class="sel" data-pref="wizard-strong" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(`${p.wizardStrongQ}：${text}`)}" ${this.busy ? 'disabled' : ''}><span>${esc(text)}</span>${icon('arrow-down-s-line')}</button></span>`);
    }
    private chooseWizardStrong(anchor: HTMLElement) {
        const pick = (name: string) => { this.wizardStrong = name; this.render(); this.container?.querySelector<HTMLElement>('[data-pref="wizard-strong"]')?.focus({ preventScroll: true }); };
        menu(anchor, [{ label: p.wizardStrongNone, run: () => pick('') }, ...this.wizardStrongList.map(item => ({ label: item.label, run: () => pick(item.name) }))], true);
    }
    // 测试通过后读一次已启用的执行者，决定第 3 步的强执行者问题是下拉还是说明；读不到按"只有一个"处理。
    private async loadWizardStrong() {
        try {
            const list = await window.dock.console('agents:list');
            this.wizardStrongList = (Array.isArray(list?.agents) ? list.agents as { name: string; label: string; enabled: boolean }[] : []).filter(item => item.enabled).map(item => ({ name: item.name, label: item.label }));
        }
        catch { this.wizardStrongList = []; }
        if (this.wizardStrong && !this.wizardStrongList.some(item => item.name === this.wizardStrong)) this.wizardStrong = '';
    }
    // 第 3 步点“下一步”：每日上限空着跳过（不写 limits），填了合法整数就经 route:limit 写进这个执行者；选了强执行者就经 route:strong 写入（"不设"不写）；
    // 上限非法或任一写入失败时留在第 3 步。
    private async commitWizardLimit() {
        const raw = this.wizardLimit.trim();
        if (raw !== '' && !(/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)))) { this.wizardLimitErr = p.wizardLimitBad; this.render(); return; }
        this.wizardLimitErr = '';
        if (raw === '' && !this.wizardStrong) { this.step = 4; this.error = ''; this.render(); return; }
        this.busy = true; this.error = ''; this.render();
        try {
            if (raw !== '') await window.dock.console('route:limit', { name: this.wizardAdded, tasks: Number(raw) });
            if (this.wizardStrong) await window.dock.console('route:strong', { name: this.wizardStrong });
            this.busy = false;
            this.step = 4;
        }
        catch (e) { this.busy = false; this.error = String((e as Error)?.message || e); }
        this.render();
    }
    // 第 3 步测试通过后的"可以按你的执行者生成建议规则"：路由页在引导期间不可用，所以先结束引导（等同"跳过"），再跳到路由页并打开建议弹窗。
    // 第 3 步已经填了每日上限或选了强执行者时，先照"下一步"写入；写入失败就留在这一步。
    private async wizardSuggest() {
        if (this.wizardLimit.trim() !== '' || this.wizardStrong) { await this.commitWizardLimit(); if (this.step !== 4) return; }
        await this.finish(false);
        goToSuggest();
    }
    private useWizardPreset(name: string) {
        const x = this.wizardPresets.find(item => item.name === name);
        if (!x) return;
        this.wizardPreset = name;
        let agent = x.name, n = 2;
        while (this.wizardAgents.includes(agent)) agent = `${x.name}-${n++}`;
        this.wizardAgentName = agent;
        this.wizardSecretVar = Object.values(x.secrets ?? {})[0] ?? '';
        this.wizardSecretState = null;
        this.wizardResult = null;
        this.wizardAdded = '';
        this.wizardLimit = ''; this.wizardLimitErr = '';
        this.wizardStrong = ''; this.wizardStrongList = [];
    }
    private async loadWizardPresets() {
        if (this.wizardLoading) return;
        this.wizardLoading = true;
        this.error = '';
        this.render();
        let preset: Preset | undefined;
        try {
            const [list, agents] = await Promise.all([window.dock.console('agents:presets'), window.dock.console('agents:list')]);
            this.wizardPresets = Array.isArray(list?.presets) ? list.presets : [];
            this.wizardAgents = Array.isArray(agents?.agents) ? agents.agents.map((a: { name: string }) => a.name) : [];
            const cardList = presetCards(this.wizardPresets);
            preset = (cardList.find(x => x.recommended) ?? cardList[0])?.members[0];
            if (!this.wizardPreset && preset) this.useWizardPreset(preset.name);
        }
        catch (e) { this.error = String((e as Error)?.message || e); }
        finally {
            this.wizardLoading = false;
            if (this.wizardPreset && this.wizardPresetObj()?.auth === 'token') await this.refreshWizardSecret();
            if (this.wizard && this.step === 3) this.render();
        }
    }
    private async chooseWizardPreset(name: string) {
        if (this.wizardAdded || this.busy) return;
        this.useWizardPreset(name);
        this.render();
        await this.refreshWizardSecret();
        this.render();
    }
    private async refreshWizardSecret() {
        const x = this.wizardPresetObj();
        if (!x || x.auth !== 'token' || !this.wizardSecretVar) { this.wizardSecretState = x?.auth === 'login' ? null : 'missing'; return; }
        try { this.wizardSecretState = (await window.dock.console('secrets:status', { names: [this.wizardSecretVar] }))?.secrets?.[this.wizardSecretVar] === 'set' ? 'set' : 'missing'; }
        catch { this.wizardSecretState = 'missing'; }
    }
    private async saveWizardSecret() {
        const input = this.container?.querySelector<HTMLInputElement>('[data-wizard-secret]');
        const value = input?.value ?? '';
        if (!this.wizardSecretVar || !value) { this.error = ag.needSecret; this.render(); return; }
        this.busy = true;
        this.error = '';
        this.render();
        try { await window.dock.console('secrets:set', { name: this.wizardSecretVar, value }); }
        catch (e) { this.error = String((e as Error)?.message || e); }
        finally {
            // 调用一返回（成功或失败）就清空密码框，值不留在界面里。
            const again = this.container?.querySelector<HTMLInputElement>('[data-wizard-secret]');
            if (again) again.value = '';
            this.busy = false;
            await this.refreshWizardSecret();
            this.render();
        }
    }
    private async importWizardAgent() {
        const x = this.wizardPresetObj();
        if (!x || this.busy) return;
        this.busy = true;
        this.wizardTesting = true;
        this.wizardResult = null;
        this.error = '';
        this.render();
        try {
            if (!this.wizardAdded) {
                const added = await window.dock.console('agents:add', { preset: x.name, name: this.wizardAgentName });
                this.wizardAdded = typeof added?.name === 'string' ? added.name : this.wizardAgentName;
            }
            const tested = await window.dock.console('agents:test', { name: this.wizardAdded });
            await this.loadWizardStrong();
            this.wizardResult = { ok: true, seconds: Number(tested?.seconds ?? 0), version: tested?.version ?? null };
        }
        catch (e) { this.wizardResult = { ok: false, reason: String((e as Error)?.message || e) }; }
        finally {
            this.busy = false;
            this.wizardTesting = false;
            this.render();
        }
    }
    private async chooseWizardProject() {
        if (this.busy) return;
        this.busy = true;
        this.error = '';
        this.render();
        try { const chosen = await window.dock.console('projects:choose'); if (typeof chosen === 'string' && chosen) this.wizardProject = chosen; }
        catch (e) { this.error = String((e as Error)?.message || e); }
        finally { this.busy = false; this.render(); }
    }
    private async finishWizardProject() {
        if (this.busy) return;
        this.busy = true;
        this.error = '';
        this.render();
        try {
            if (this.wizardProject) await window.dock.console('projects:add', { path: this.wizardProject });
            const open = this.wizardOpenInit && this.wizardProject ? this.wizardProject : '';
            this.busy = false;
            await this.finish(true, open);
        }
        catch (e) {
            this.error = String((e as Error)?.message || e);
            this.busy = false;
            this.render();
        }
    }
    private resetWizard() {
        this.step = 1;
        this.selected = new Set();
        this.wizardPresets = [];
        this.wizardAgents = [];
        this.wizardPreset = '';
        this.wizardAgentName = '';
        this.wizardAdded = '';
        this.wizardSecretVar = '';
        this.wizardSecretState = null;
        this.wizardResult = null;
        this.wizardTesting = false;
        this.wizardLoading = false;
        this.wizardLimit = ''; this.wizardLimitErr = '';
        this.wizardStrong = ''; this.wizardStrongList = [];
        this.wizardProject = '';
        this.wizardOpenInit = true;
    }
    private async save(key: string, value: string|number|boolean|null, own = false) {
        this.busy=true; this.error=''; this.render();
        try { this.settings=await window.dock.preferences(own?'own':'save',{key,value}); }
        catch(e) { this.error=String((e as Error).message||e); }
        finally { this.busy=false; this.render(); this.redrawStatus(); }
    }
    private async click(e: MouseEvent) {
        const b=(e.target as Element).closest<HTMLButtonElement>('button'); if(!b||b.disabled||this.busy) return;
        const d=b.dataset;
        if(d.pick) { await this.choosePick(b,d.pick); return; }
        // 自动 / 固定：切到固定时默认选当前估算值；已经在这个模式就不重复写。
        if(d.segment==='concurrencyMode') { const auto=this.settings.concurrency==='auto'; if(d.value==='auto'&&!auto) await this.save('concurrency','auto'); else if(d.value==='fixed'&&auto) await this.save('concurrency',this.settings.parallel.estimate); return; }
        if(d.segment==='proxy') { await this.chooseProxyMode(d.value!); return; }
        if(d.pref==='proxy-save') { await this.saveProxyAddress(); return; }
        if(d.segment) { await this.save(d.segment,d.value!,d.segment==='theme'||d.segment==='closeAction'); return; }
        if(d.pref==='gc') { this.openGc(b); return; }
        if(d.pref==='gc-recheck') { await this.gcCheck(true); return; }
        if(d.pref==='clear-cache') { await this.clearCache(); return; }
        if(d.pref==='clear-tasks') { await this.clearTasks(b); return; }
        if(d.pref==='clear-projects') { await this.clearProjects(b); return; }
        if(d.pref==='reset-app') { await this.openReset(b); return; }
        if(d.pref==='ack-leftover') { this.settings=await window.dock.preferences('ackLeftover'); this.render(); return; }
        if(d.choice) { this.selected.has(d.choice)?this.selected.delete(d.choice):this.selected.add(d.choice); this.render(); return; }
        // 点已选中的合并卡片：保留已选的预设，不重置回默认。
        if(d.wizardPreset) { if(!(d.card&&presetCards(this.wizardPresets).find(item=>item.id===d.card)?.members.some(m=>m.name===this.wizardPreset))) await this.chooseWizardPreset(d.wizardPreset); return; }
        if(d.wizardVariant) { await this.chooseWizardPreset(d.wizardVariant); return; }
        if(d.pref==='wizard-secret') { await this.saveWizardSecret(); return; }
        if(d.pref==='wizard-agent') { await this.importWizardAgent(); return; }
        if(d.pref==='wizard-strong') { this.chooseWizardStrong(b); return; }
        if(d.pref==='wizard-suggest') { await this.wizardSuggest(); return; }
        if(d.pref==='wizard-choose-folder') { await this.chooseWizardProject(); return; }
        if(d.pref==='wizard-open-init') { this.wizardOpenInit=!this.wizardOpenInit; this.render(); return; }
        if(d.pref==='wizard-finish') { await this.finishWizardProject(); return; }
        if(d.pref==='managed') { await this.save('managed',!this.settings.managed); return; }
        if(d.pref==='lead-usage') { await this.save('leadUsage',!this.settings.leadUsage); return; }
        if(d.pref==='detect') return this.detect();
        if(b.hasAttribute('data-import-agent')) { this.agentsView.openImport(b); return; }
        if(d.pref==='folder') return window.dock.preferences('openConfig');
        if(d.pref==='notifications') { this.settings=await window.dock.preferences('own',{key:'notifications',value:!this.settings.own.notifications}); this.render(); }
        if(d.pref==='choose') { const result=await window.dock.preferences('choosePath'); if(result) { this.settings=result; await this.detect(); } }
        if(d.pref==='reset') { await this.save('path',null); await this.detect(); }
        if(d.pref==='ack') { await this.ack(); }
        if(d.pref==='wizard') { this.resetWizard(); this.wizard=true; this.error=''; this.redrawShell(); await this.detect(); }
        if(d.pref==='skip') await this.finish(false);
        if(d.pref==='previous') { if(this.step>1){ this.step--; this.error=''; this.render(); } return; }
        if(d.pref==='next') {
            if(this.step===1) { this.selected=new Set(this.connections?.hosts.filter(h=>h.detected).flatMap(h=>h.skills.filter(s=>s.checked).map(s=>h.host+'/'+s.skill))); this.step=2; this.error=''; this.render(); return; }
            if(this.step===3) { await this.commitWizardLimit(); return; }
            this.busy=true; this.installProgress={done:0,total:this.selected.size}; this.error=''; this.render();
            try {
                for(const h of this.connections!.hosts.filter(h=>h.detected)) {
                    const skills=h.skills.filter(s=>this.selected.has(h.host+'/'+s.skill)).map(s=>s.skill);
                    if(skills.length) {
                        const result=await window.dock.preferences('install',{host:h.host,operation:'selected',skills});
                        this.installProgress.done+=result.changed.length;
                        for(const skill of skills)this.selected.delete(h.host+'/'+skill);
                        this.render();
                    }
                }
                this.step=3;
            } catch(e) { this.error=String((e as Error).message||e); }
            finally { this.busy=false; await this.refreshSettings(); if(this.wizard&&this.step===3) void this.loadWizardPresets(); }
        }
        if(d.pref==='host') {
            if(d.operation==='removeLegacy'&&!await confirmAction(p.removeLegacyTitle,p.removeLegacyBody(this.connections?.hosts.find(h=>h.host===d.host)?.legacy?.filter(l=>!l.link).map(l=>l.skill).join('\u3001') || ''),p.removeLegacy,b,true)) return;
            if(d.operation==='rollback'&&!await confirmAction(p.rollbackTitle(hostName(d.host!)),p.rollbackBody,p.actions.rollback,b)) return;
            if(d.operation==='replace'&&!await confirmAction(p.replaceTitle(d.skill!),p.replaceBody,p.replace,b,true)) return;
            this.busy=true; this.hostErrors.delete(d.host!); this.render(); trace('host-op-start', { host: d.host, operation: d.operation });
            try {
                const result=await window.dock.preferences('install',{host:d.host,operation:d.operation,...(d.skill?{skills:[d.skill]}:{})});
                trace('host-op-done', { host: d.host, operation: d.operation, changed: result.changed.length });
                this.messages.set(d.host!,d.operation==='rollback'?p.rolledBack:d.operation==='removeLegacy'?p.legacyRemoved:p.installed(result.changed.length));
                clearTimeout(this.messageTimers.get(d.host!));
                this.messageTimers.set(d.host!,setTimeout(()=>{this.messages.delete(d.host!);this.messageTimers.delete(d.host!);trace('host-message-cleared', { host: d.host, wizard: this.wizard, active: this.active });if(!this.wizard&&this.active==='connect')this.render();},3000));
            } catch(e) { this.hostErrors.set(d.host!,String((e as Error).message||e)); trace('host-op-error', { host: d.host, operation: d.operation, error: String((e as Error).message||e) }); }
            finally { this.busy=false; await this.detect(); }
        }
    }
    private async ack() { this.connections=await window.dock.preferences('ack'); this.render(); void this.agentsView.refresh(true); }
    // 编辑执行者 · Codex（Stage07c T3）：和其他执行者一样的表单式——显示名、模型、推理强度、服务档位、沙箱、位置、升级到，底栏"取消 / 保存"，点"保存"才写入。
    // 写入走两条原有的路径：显示名、升级到走 agents:update；模型、推理强度、服务档位、沙箱、位置走设置通道的 save（key 为 codex，一次 writeConfig 全写，
    // 这几项原来就走设置通道：核心的 agents update 只认 Claude 类与兼容接口的模型）。
    // 模型与推理强度的下拉来自探针（codex debug models），"刷新列表"重新查；"跟随 Codex"始终是第一项（不传参数）。
    private async openCodexEdit(trigger: HTMLElement, name: string, label: string, others: { name: string; label: string }[]) {
        // 设置、预设、角色三项一起读（互不依赖），打开表单不比以前多等一轮核心调用。
        const [, presets, rolesData] = await Promise.all([
            this.refreshSettings(),
            window.dock.console('agents:presets').then((r: { presets: AgentPreset[] }) => r.presets).catch(() => [] as AgentPreset[]),
            loadRoles(name),
        ]);
        const settings = this.settings, locked = !!settings.reason;
        const presetEfforts = presets.find(x => x.name === 'codex')?.effortOptions ?? ['minimal', 'low', 'medium', 'high', 'xhigh'];
        const effortSupported = presets.find(x => x.name === 'codex')?.supportsEffort !== false;
        const keys = ['model', 'effort', 'tier', 'sandbox', 'path'] as const;
        // 预填用这个执行者自己的值（改过名的 Codex 执行者如 codex-pro 不读 codex 的）；核心没给到时退回设置页 Codex 一节的值。
        const mine = settings.codexProfiles?.[name] ?? settings.values;
        const initial = { label, model: mine.model ?? '', effort: mine.effort ?? '', tier: mine.tier ?? '', sandbox: mine.sandbox ?? 'workspace-write', path: mine.path ?? '', escalate: settings.profiles?.[name]?.escalate ?? '' };
        const E = { ...initial };
        const custom: Record<string, boolean | undefined> = {};
        const rolesBox = new RolesBox(rolesData);
        const current = settings.current;
        const choices = others.map(x => ({ value: x.name, label: x.label }));
        let refocusRefresh = false;
        // 配置无效时不查（核心会拒绝，原因在正文顶部的横幅里），也没有"刷新列表"。
        const box = new ProbeBox(locked ? null : name, () => { if (!sheet.root.isConnected) return; read(); redraw(refocusRefresh ? '[data-probe-refresh]' : undefined); refocusRefresh = false; });
        box.load();
        const spec = (key: string): ChoiceSpec | undefined => {
            if (key === 'model') return { key, attr: 'data-e', lead: [{ value: '', label: p.follow(current.model) }], opts: box.modelOpts([]), label: c.model };
            // 推理强度跟着所选模型变：模型选"跟随 Codex"时看 Codex 现在用的模型；探针没给这个模型的强度时用预设的。
            if (key === 'effort') return { key, attr: 'data-e', lead: [{ value: '', label: p.follow(current.effort) }], opts: (box.efforts(E.model || current.model || '')?.levels ?? presetEfforts).map(value => ({ value })), label: c.effort };
            if (key === 'tier') return { key, attr: 'data-e', fixed: true, lead: [{ value: '', label: p.follow(current.tier) }], opts: ['default', 'priority', 'flex'].map(value => ({ value })), label: p.tier };
            if (key === 'escalate') {
                const opts: Opt[] = [...choices];
                if (E.escalate && !opts.some(x => x.value === E.escalate)) opts.push({ value: E.escalate });
                return { key, attr: 'data-e', fixed: true, mono: false, lead: [{ value: '', label: gx.escalateNone }], opts, label: gx.escalate };
            }
        };
        // 当前值不在选项里（手写的、探针换了列表）：显示成输入框，值原样保留，不悄悄改掉。
        const state = (key: string): Choice => {
            const value = E[key as 'model'], opts = (spec(key)?.opts ?? []).map(o => o.value);
            return { value, custom: custom[key] ?? (value !== '' && !opts.includes(value)) };
        };
        const override = (key: string) => settings.overrides[key] ? `<span class="override">${esc(p.override(settings.overrides[key].name, settings.overrides[key].value))}</span>` : '';
        const input = (key: string, value: string) => `<input class="inp" data-e="${key}" value="${esc(value)}">`;
        const sandbox = () => `<div class="segm">${[['workspace-write', p.writable], ['read-only', p.readonly]].map(([value, text]) => `<button type="button" data-e-seg="sandbox" data-value="${value}" class="${E.sandbox === value ? 'on' : ''}" aria-pressed="${E.sandbox === value}">${esc(text)}</button>`).join('')}</div>`;
        const location = () => {
            // 探测到的位置（this.connections）是 codex 那一份的；别的 Codex 执行者没指定位置时写"自动"，不借用它。
            const where = E.path === initial.path && name === 'codex' ? (this.connections?.codex.path || p.auto) : (E.path || p.auto);
            return `<div class="statusline"><span class="mono muted" title="${esc(where)}">${esc(where)}</span><button type="button" class="btn sm" data-loc="choose">${esc(p.choose)}</button>${E.path ? `<button type="button" class="btn sm quiet" data-loc="reset">${esc(p.reset)}</button>` : ''}</div>`;
        };
        const efforts = () => box.efforts(E.model || current.model || '');
        const body = () => `${banner(locked ? p.configError(settings.reason!) : '')}<div class="form">${field(ag.label, ag.labelHelp, input('label', E.label), true)}`
            + field(c.model, override('model') + `<span data-probe-note>${esc(box.note())}</span>`, modelControl(choiceHtml(spec('model')!, state('model')), box))
            + (effortSupported ? field(c.effort, override('effort') + esc(efforts() ? ag.effortSupported(efforts()!.levels.join(' / '), efforts()!.def) : ''), choiceHtml(spec('effort')!, state('effort')))
                // 预设声明这个执行者不支持推理强度（Stage07c D87）：这一行隐藏；已经有值的在原位置显示一句"已忽略"。
                : E.effort ? field(c.effort, '', `<span class="muted" data-effort-ignored>${esc(ro.effortUnsupported)}</span>`) : '')
            + field(p.tier, override('tier'), choiceHtml(spec('tier')!, state('tier')))
            + field(c.sandbox, override('sandbox') || esc(p.sandboxHelp), sandbox())
            + field(ag.location, '', location())
            + rolesBox.html()
            + field(gx.escalate, esc(gx.escalateHelp), choiceHtml(spec('escalate')!, state('escalate'))) + '</div>';
        const read = () => { for (const key of ['label', 'model', 'effort'] as const) { const el = sheet.root.querySelector<HTMLInputElement>(`[data-e="${key}"]`); if (el) E[key] = el.value.trim(); } };
        // 配置无效时所有控件禁用、不能保存（原因在正文顶部的横幅里）。
        const lock = () => { if (!locked) return; sheet.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('.sheet-b [data-sel], .sheet-b .inp, .sheet-b [data-e-seg], .sheet-b [data-loc], .sheet-b [data-probe-refresh], .sheet-b [data-role], .sheet-b [data-family], .sheet-b [data-family-open]').forEach(el => { el.disabled = true; }); sheet.root.querySelector<HTMLButtonElement>('[data-sheet-btn="1"]')!.disabled = true; };
        const redraw = (focus?: string) => { if (!sheet.root.isConnected) return; redrawSheet(sheet, body(), focus); rolesBox.syncSave(sheet); lock(); };
        const changed = () => { read(); return rolesBox.dirty || (Object.keys(initial) as (keyof typeof initial)[]).some(key => E[key] !== initial[key]); };
        // 保存：一次写入所有改动，没改的不写。失败时留在框里显示原因，字段保持用户填的值；已经写成功的那一部分记为新的起点，重试不重复写。
        const save = async (s: Sheet) => {
            read();
            if (!E.label) { s.fail(ag.labelRequired); return; }
            const update: Record<string, unknown> = {};
            if (E.label !== initial.label) update.label = E.label;
            if (E.escalate !== initial.escalate) update.escalate = E.escalate;
            const write: Record<string, string | null> = {};
            for (const key of keys) if (E[key] !== initial[key]) write[key] = E[key] === '' ? null : E[key];
            s.fail('');
            if (!rolesBox.valid) return;
            const roles = rolesBox.payload();
            if (!Object.keys(update).length && !Object.keys(write).length && !Object.keys(roles).length) { s.close(); return; }
            s.busy(true);
            try {
                if (Object.keys(update).length) { await window.dock.console('agents:update', { name, ...update }); initial.label = E.label; initial.escalate = E.escalate; }
                if (Object.keys(write).length) { this.settings = await window.dock.preferences('save', { key: 'codex', value: write, profile: name }); for (const key of keys) initial[key] = E[key]; }
                // 可担任 / 模型范围：改过才写（ar roles set）。
                if (Object.keys(roles).length) { await window.dock.console('roles:set', { name, ...roles }); rolesBox.commit(); }
                forgetProbe(name);
                s.close(); this.redrawStatus(); void this.agentsView.refresh(true);
            }
            catch (e) { s.fail(String((e as Error).message || e)); s.busy(false); rolesBox.syncSave(s); lock(); }
        };
        const sheet: Sheet = openSheet({ title: ag.editTitle(label), trigger, body: body(), note: ag.editNote(name), buttons: [c.cancel, ag.save], wide: true,
            onButton: (index, s) => { if (index === 0) { s.close(); return; } void save(s); },
            onClose: () => {
                if (!changed()) return;
                const closeBtn = sheet.root.querySelector<HTMLElement>('.sheet-h .btn');
                return confirmAction(ag.discardTitle, ag.discardBody, ag.discard, closeBtn ?? trigger, true).then(ok => ok ? undefined : false);
            } });
        lock();
        bindChoices(sheet.root, {
            spec, state,
            set: (key, st) => { read(); E[key as 'model'] = st.value; custom[key] = st.custom || undefined; },
            redraw: focus => { redraw(focus); },
        });
        // 可担任、模型范围：只改本地状态并重画，点"保存"才写入。
        sheet.root.addEventListener('click', e => {
            const focus = rolesBox.handle(e.target as Element);
            if (focus === null) return;
            e.stopPropagation(); read(); redraw(focus);
        });
        rolesBox.syncSave(sheet); lock();
        sheet.root.addEventListener('click', e => {
            const b = (e.target as Element).closest<HTMLButtonElement>('[data-probe-refresh], [data-e-seg], [data-loc]');
            if (!b || b.disabled) return;
            e.stopPropagation(); read();
            if (b.hasAttribute('data-probe-refresh')) { refocusRefresh = true; box.load(true); redraw(); return; }
            if (b.dataset.eSeg) { E.sandbox = b.dataset.value!; redraw(`[data-e-seg="sandbox"][data-value="${b.dataset.value}"]`); return; }
            if (b.dataset.loc === 'reset') { E.path = ''; redraw('[data-loc="choose"]'); return; }
            // 指定位置：只把选中的程序记在表单里，点"保存"才写入。取消选择什么都不变。
            void window.dock.console('agents:choose-program').then((r: { file?: string }) => { if (r.file) { E.path = r.file; } redraw('[data-loc="choose"]'); }).catch(error => { sheet.fail(String((error as Error).message || error)); });
        });
    }
    private async finish(configure: boolean, project = '') {
        this.settings=await window.dock.preferences('finish',{configure}); this.wizard=false; this.error=''; this.resetWizard(); this.redrawShell();
        // 勾选了"添加后打开初始化预览"：切到项目页并选中它；初始化预览仍要用户自己点。
        if(project) this.openProject?.(project);
    }
}
