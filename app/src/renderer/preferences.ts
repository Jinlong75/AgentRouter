import { ag, c, p, pj, s6, sc } from '../shared/copy';
import { esc } from '../shared/markdown';
import type { Connections, GcItems, GcRun, Settings } from '../shared/types';
import { icon, menu, confirmAction, openSheet, field, trace, type Sheet } from './ui';
import { AgentsView } from './agents';
import brand from '../../design/icons/mark.svg';

const hostName = (host: string) => host === 'claude-code' ? 'Claude Code' : host;
const mark = (state: string) => `<span class="mk ${state}">${icon(({ok:'checkbox-circle-line',warn:'error-warning-line',fail:'close-circle-line',info:'information-line',skip:'indeterminate-circle-line',run:'loader-4-line'} as Record<string,string>)[state])}</span>`;
const hint = (text: string) => `<div class="hint">${mark('info')}<span>${esc(text)}</span></div>`;
const banner = (text: string) => text ? `<div class="banner fail" role="alert">${mark('fail')}<span>${esc(text)}</span></div>` : '';
const kv = (label: string, value: string, state = 'ok', tag = '') => `<div class="kv">${mark(state)}<span class="lb">${esc(label)}</span><span class="val mono" title="${esc(value)}">${esc(value)}</span>${tag}</div>`;
const row = (label: string, description: string, control: string) => `<div class="set-r"><div class="l">${esc(label)}<span>${description}</span></div><div class="ctl">${control}</div></div>`;
const section = (title: string, description: string, body: string) => `<div class="sect"><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}${body}</div>`;
// 与 agents.ts 的导入向导同形：预设与测试结果都来自核心（agents:presets / agents:test）。
interface Preset { name: string; title: string; description: string; recommended: boolean; adapter: string; label: string; auth: 'login' | 'token'; env?: Record<string, string>; secrets?: Record<string, string> }
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
    // Agent 页"执行者"区（B）；Codex 的编辑回调到这里复用设置控件（C10）。
    private agentsView = new AgentsView({
        openCodexEdit: trigger => { void this.openCodexEdit(trigger); },
        codexChange: () => this.connections?.codex.change,
        ack: () => { void this.ack(); },
        settingsLoaded: settings => { this.settings = settings; this.redrawStatus(); },
    });
    private codexSheet?: Sheet;
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
    // 引导第 4 步：所选项目文件夹与"添加后打开初始化预览"。
    private wizardProject = '';
    private wizardOpenInit = true;
    constructor(private redrawShell: () => void, private redrawStatus: () => void, private openProject?: (path: string) => void, private running: () => number = () => 0) {}
    focusManaged() { this.container?.querySelector('#managed-section')?.scrollIntoView({block:'start'}); }
    unmount() { this.container=undefined; this.active=''; }
    async init() { this.settings = await window.dock.preferences('settings'); this.wizard = !this.settings.own.wizardDone; void this.detect(); void this.gcCheck(); }
    mount(container: HTMLElement, page: string, version: string) {
        this.container = container; this.active = page; this.version = version;
        this.error='';
        container.replaceChildren();
        this.render();
        container.onclick = e => { void this.click(e).catch(error => { this.error = String(error.message || error); this.render(); }); };
        if (page === 'connect') void this.detect();
        if (page === 'settings') void this.refreshSettings();
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
        const top = this.container.querySelector('.scroll')?.scrollTop || 0;
        // 整块重建会丢掉焦点：记下焦点所在控件的身份，重建后放回同一个控件（键盘用户连续操作不用重新 Tab）。
        const focused = document.activeElement instanceof HTMLElement && this.container.contains(document.activeElement) ? document.activeElement : null;
        const identity = focused ? ['data-choice','data-pref','data-setting','data-segment','data-value','data-operation','data-host'].filter(a => focused.hasAttribute(a)).map(a => `[${a}="${CSS.escape(focused.getAttribute(a)!)}"]`).join('') : '';
        this.container.innerHTML = this.wizard ? this.wizardPage() : `<div class="doc scroll"><div class="page-h sticky"><h1>${({connect:c.connect,settings:c.settings,about:c.about} as Record<string,string>)[this.active]}</h1>${this.active === 'connect' ? `<span class="lead">${p.subtitle}</span><span class="sp"></span>${this.button(p.detect,'detect','',this.detecting?'disabled':'')}<button class="btn primary" data-import-agent ${this.busy?'disabled':''}>${icon('add-line')}${esc(ag.import)}</button>` : ''}</div><div class="doc-in">${banner(this.error)}${this.active === 'connect' ? this.connectPage() : this.active === 'settings' ? this.settingsPage() : this.aboutPage()}</div></div>`;
        const scroll = this.container.querySelector('.scroll'); if(scroll) scroll.scrollTop = top;
        if (identity) (this.container.querySelector(identity) as HTMLElement | null)?.focus({ preventScroll: true });
        const agents = this.container.querySelector<HTMLElement>('[data-agents]');
        if (agents) this.agentsView.mount(agents);
        this.renderCodexSheet();
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
            return `<div class="card ${!h.detected?'is-off':custom?'is-brand':''}" data-host-card="${h.host}"><div class="card-h">${icon('terminal-line')}<b>${hostName(h.host)}</b><span class="aside">${h.detected?mark('ok')+p.detected:p.missingHost}</span></div><div class="card-b">${h.detected?`<div class="path mono">${esc(h.root)}</div>${skills}${h.skills.some(s=>s.skill==='agent-router'&&s.state==='custom')?hint(p.customHelp):''}${h.legacy?.length?`<div data-legacy-skills>${hint(p.legacySkills(h.legacy.join('、')))}</div>`:''}`:hint(p.hostMissing(hostName(h.host)))}${banner(this.hostErrors.get(h.host)||'')}</div>${h.detected?`<div class="card-f"><span class="note" role="status">${esc(this.messages.get(h.host)||(custom?p.customIdle:installed))}</span>${buttons}</div>`:''}</div>`;
        }).join('');
        return section(p.dispatchers,p.dispatchHelp,`<div class="cards2">${hosts}</div>`)+`<div data-agents></div>`;
    }
    private description(key: string, fallback = '') { const o=this.settings.overrides[key]; return o?`<span class="override">${esc(p.override(o.name,o.value))}</span>`:esc(fallback); }
    private defaultRows(sandbox = true) {
        const rows = ['model','effort','tier'].map(key=>row(key==='model'?c.model:key==='effort'?c.effort:p.tier,this.description(key,key==='model'&&!this.settings.values.model?p.currentHelp:''),`<button class="sel" data-setting="${key}" aria-haspopup="listbox" aria-expanded="false" ${this.settings.reason||this.busy?'disabled':''}><span class="${this.settings.values[key]?'mono':'ph'}">${esc(this.settings.values[key]||p.follow(this.settings.current[key]))}</span>${icon('arrow-down-s-line')}</button>`));
        if(sandbox) rows.push(row(c.sandbox,this.description('sandbox',p.sandboxHelp),this.segment('sandbox',['workspace-write','read-only'],[p.writable,p.readonly],this.settings.values.sandbox!)));
        return rows.join('');
    }
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
        section(sc.settingsSec,'',`<div class="set">${row(sc.leadUsage,esc(sc.leadUsageHelp),`<button class="toggle ${this.settings.leadUsage?'on':''}" data-pref="lead-usage" role="switch" aria-label="${sc.leadUsage}" aria-checked="${this.settings.leadUsage}" ${this.busy||this.settings.reason?'disabled':''}></button>`)}</div>`)+
        section(p.watch,'',`<div class="set">${row(p.watchTitle,this.description('watchWindow',p.watchHelp),this.segment('watchWindow',['auto','always','never'],p.watchOptions,this.settings.values.watchWindow!))}</div>`)+
        section(p.notifications,'',`<div class="set">${row(p.notify,esc(p.notifyHelp),`<button class="toggle ${this.settings.own.notifications?'on':''}" data-pref="notifications" role="switch" aria-label="${p.notify}" aria-checked="${this.settings.own.notifications}" ${this.busy?'disabled':''}></button>`)}</div>`)+
        section(p.appearance,'',`<div class="set">${row(p.theme,'',this.segment('theme',['system','light','dark'],p.themes,this.settings.own.theme,['computer-line','sun-line','moon-line']))}</div>`)+
        section(p.window,'',`<div class="set">${row(p.closeAction,esc(p.closeActionHelp),this.segment('closeAction',['ask','tray','quit'],[p.closeOptions.ask,p.closeOptions.tray,p.closeOptions.quit],this.settings.own.closeAction))}</div>`)+
        section(p.config,'',banner(this.settings.reason?p.configError(this.settings.reason):'')+`<div class="set">${row(p.location,`<span class="mono">${esc(this.settings.file)}</span>`,this.button(p.openFolder,'folder','sm quiet'))}</div>`)+
        this.listsSection()+
        this.dataSection();
    }
    // 并行一节：同时运行的任务数（config.json 的 concurrency）。分段控件 1～4；配置里手写的越界值不选任何一项，在控件前显示当前值。
    private parallelSection() {
        const value = this.settings.concurrency, inRange = Number.isInteger(value) && value >= 1 && value <= 4;
        const current = inRange ? '' : `<span class="mono muted" data-concurrency-value>${value}</span>`;
        return section(s6.parallelSec, s6.parallelLead, `<div class="set">${row(s6.concurrency, esc(s6.concurrencyHelp), current + this.segment('concurrency', ['1','2','3','4'], ['1','2','3','4'], inRange ? String(value) : ''))}</div>`);
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
        const cards = this.wizardPresets.map(item => {
            const on = item.name === this.wizardPreset;
            return `<button class="preset ${on?'on':''}" role="radio" aria-checked="${on}" data-wizard-preset="${esc(item.name)}" tabindex="${on?0:-1}" ${this.busy||this.wizardAdded?'disabled':''}><span class="rd ${on?'on':''}"></span><span class="pk"><b>${esc(item.title)}${item.recommended?`<span class="tag brand">${esc(ag.recommended)}</span>`:''}</b><span>${esc(item.description)}</span></span></button>`;
        }).join('');
        const parts: string[] = [`<div class="presets" role="radiogroup" aria-label="${esc(p.wizardAgent)}">${cards}</div>`];
        if (x) {
            parts.push(field(ag.auth, '', `<span>${esc(x.auth === 'token' ? ag.authToken : ag.authLogin)}</span>`));
            if (x.auth === 'token') {
                const state = this.wizardSecretState === 'set'
                    ? `<span class="tag ok" data-wizard-secret-state>${esc(ag.keySet)}</span>`
                    : `<span class="tag fail" data-wizard-secret-state>${esc(ag.keyMissing)}</span>`;
                parts.push(field(ag.secretName, ag.secretNameHelp, `<span class="mono">${esc(this.wizardSecretVar)}</span>`));
                parts.push(field(ag.secretSet, ag.secretSetHelp, `<div class="statusline"><input class="inp" data-wizard-secret type="password" placeholder="${esc(ag.secretPlaceholder)}" aria-label="${esc(ag.secretSet)}" ${this.busy?'disabled':''}><button class="btn" data-pref="wizard-secret" ${this.busy?'disabled':''}>${esc(ag.secretSave)}</button>${state}</div>`));
            }
            else parts.push(hint(ag.subscriptionShare));
        }
        if (this.wizardTesting) parts.push(`<div class="testbox">${mark('run')}<div><b>${esc(ag.testingLong)}</b><span>${esc(ag.testingHelp)}</span></div></div>`);
        else if (this.wizardResult) parts.push(this.wizardResult.ok
            ? `<div class="testbox ok" data-wizard-result="ok">${mark('ok')}<div><b>${esc(ag.testOk(String(this.wizardResult.seconds ?? '—'), this.wizardResult.version ?? '—'))}</b><span>${esc(ag.testOkHelp(x?.label ?? this.wizardAdded, false))}</span></div></div>`
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
            preset = this.wizardPresets.find(x => x.recommended) ?? this.wizardPresets[0];
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
        if(d.setting) {
            const key=d.setting;
            menu(b,[{label:p.follow(this.settings.current[key]),run:()=>{void this.save(key,null);}},...(key==='model'?[{label:p.customModel,run:()=>this.modelInput(b)}]:(key==='effort'?['minimal','low','medium','high','xhigh']:['default','priority','flex']).map(value=>({label:value,run:()=>{void this.save(key,value);}})))],true); return;
        }
        if(d.segment) { await this.save(d.segment,d.segment==='concurrency'?Number(d.value):d.value!,d.segment==='theme'||d.segment==='closeAction'); return; }
        if(d.pref==='gc') { this.openGc(b); return; }
        if(d.pref==='gc-recheck') { await this.gcCheck(true); return; }
        if(d.pref==='clear-cache') { await this.clearCache(); return; }
        if(d.pref==='clear-tasks') { await this.clearTasks(b); return; }
        if(d.pref==='clear-projects') { await this.clearProjects(b); return; }
        if(d.pref==='reset-app') { await this.openReset(b); return; }
        if(d.pref==='ack-leftover') { this.settings=await window.dock.preferences('ackLeftover'); this.render(); return; }
        if(d.choice) { this.selected.has(d.choice)?this.selected.delete(d.choice):this.selected.add(d.choice); this.render(); return; }
        if(d.wizardPreset) { await this.chooseWizardPreset(d.wizardPreset); return; }
        if(d.pref==='wizard-secret') { await this.saveWizardSecret(); return; }
        if(d.pref==='wizard-agent') { await this.importWizardAgent(); return; }
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
            if(this.step===3) { this.step=4; this.error=''; this.render(); return; }
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
            if(d.operation==='rollback'&&!await confirmAction(p.rollbackTitle(hostName(d.host!)),p.rollbackBody,p.actions.rollback,b)) return;
            if(d.operation==='replace'&&!await confirmAction(p.replaceTitle(d.skill!),p.replaceBody,p.replace,b,true)) return;
            this.busy=true; this.hostErrors.delete(d.host!); this.render(); trace('host-op-start', { host: d.host, operation: d.operation });
            try {
                const result=await window.dock.preferences('install',{host:d.host,operation:d.operation,...(d.skill?{skills:[d.skill]}:{})});
                trace('host-op-done', { host: d.host, operation: d.operation, changed: result.changed.length });
                this.messages.set(d.host!,d.operation==='rollback'?p.rolledBack:p.installed(result.changed.length));
                clearTimeout(this.messageTimers.get(d.host!));
                this.messageTimers.set(d.host!,setTimeout(()=>{this.messages.delete(d.host!);this.messageTimers.delete(d.host!);trace('host-message-cleared', { host: d.host, wizard: this.wizard, active: this.active });if(!this.wizard&&this.active==='connect')this.render();},3000));
            } catch(e) { this.hostErrors.set(d.host!,String((e as Error).message||e)); trace('host-op-error', { host: d.host, operation: d.operation, error: String((e as Error).message||e) }); }
            finally { this.busy=false; await this.detect(); }
        }
    }
    private async ack() { this.connections=await window.dock.preferences('ack'); this.render(); void this.agentsView.refresh(true); }
    // 编辑执行者 · Codex（C10）：Codex 的派发参数是设置类改动，沿用原来的控件与即时写入；底栏只有"完成"。
    private codexBody() {
        const a=this.connections?.codex;
        const location=row(ag.location,esc(a?.path||p.auto),`${a?.path?this.button(p.reset,'reset','sm quiet'):''}${this.button(p.choose,'choose','sm')}`);
        return `${banner(this.settings.reason?p.configError(this.settings.reason):'')}<div class="set">${this.defaultRows(true)}${location}</div>`;
    }
    private async openCodexEdit(trigger: HTMLElement) {
        await this.refreshSettings();
        const close=()=>{ this.codexSheet=undefined; };
        this.codexSheet=openSheet({ title: ag.editTitle('Codex'), trigger, body: this.codexBody(), note: ag.editNote('codex'), buttons: [ag.done], wide: true,
            onButton: (_i, s) => { close(); s.close(); void this.agentsView.refresh(true); }, onClose: () => { close(); void this.agentsView.refresh(true); } });
        this.codexSheet.root.onclick=e=>{ void this.click(e).catch(error=>{ this.codexSheet?.fail(String(error.message||error)); }); };
    }
    // 设置变化后重画模态框正文，焦点放回同一个控件。
    private renderCodexSheet() {
        const sheet=this.codexSheet; if(!sheet?.root.isConnected) return;
        const focused=document.activeElement instanceof HTMLElement&&sheet.root.contains(document.activeElement)?document.activeElement:null;
        const identity=focused?['data-pref','data-setting','data-segment','data-value'].filter(a=>focused.hasAttribute(a)).map(a=>`[${a}="${CSS.escape(focused.getAttribute(a)!)}"]`).join(''):'';
        sheet.setBody(this.codexBody());
        if(this.error) sheet.fail(this.error);
        if(identity) (sheet.root.querySelector(identity) as HTMLElement|null)?.focus({preventScroll:true});
    }
    private modelInput(button: HTMLElement) {
        const input=document.createElement('input'); input.className='model-input mono'; input.value=this.settings.values.model||''; input.setAttribute('aria-label',c.model); button.replaceWith(input);
        let saved=false;
        const commit=()=>{if(saved)return;saved=true;void this.save('model',input.value.trim()||null);};
        input.onblur=commit; input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();commit();}if(e.key==='Escape'){saved=true;this.render();}};
        input.focus(); input.select();
    }
    private async finish(configure: boolean, project = '') {
        this.settings=await window.dock.preferences('finish',{configure}); this.wizard=false; this.error=''; this.resetWizard(); this.redrawShell();
        // 勾选了"添加后打开初始化预览"：切到项目页并选中它；初始化预览仍要用户自己点。
        if(project) this.openProject?.(project);
    }
}
