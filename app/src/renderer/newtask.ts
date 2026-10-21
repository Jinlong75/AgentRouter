import { c, cx, nt, pj } from '../shared/copy';
import { esc, markdown } from '../shared/markdown';
import { dayGroup } from '../shared/types';
import type { AgentRow, ProjectRow, ProjectShow, SpecRow, Task } from '../shared/types';
import { field, icon, menu, openSheet } from './ui';
import { openIdentitySheet } from './projects';
import { mergeSpec } from '../../../core/lib/spec.mjs';

// 新建任务页：选项目 → 选来源（已有说明 / 新建说明 / 直接写文字）→ 选执行者 → 派发。
// 派发走核心的分离进程（console 的 tasks:dispatch 会加 --detach），成功后切回任务页并选中新任务。
type Source = 'existing' | 'new' | 'text';
type FormKey = 'title' | 'goal' | 'type' | 'allowed' | 'verify' | 'nonGoals' | 'refs' | 'questions' | 'text';

interface FormState {
    title: string;
    goal: string;
    type: string;
    allowed: string;
    verify: string;
    nonGoals: string;
    refs: string;
    questions: string;
    text: string;
}

interface NewTaskHost {
    tasks(): Task[];
    openTask(id: string): void;
}

const SOURCES: Source[] = ['existing', 'new', 'text'];
const FALLBACK_SPEC = 'NNN-标题.md';
const failure = (error: unknown) => String((error as Error)?.message || error);
// 核心错误码（console 通道失败时随错误带出）：用来识别"没有提交身份"并在失败横幅里给出设置按钮。
const errorCode = (error: unknown) => (error as Error & { code?: unknown })?.code;
const lines = (value: unknown) => Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
const requiredHint = (name: string) => `<span class="fhint fail" data-nt-required role="alert">${esc(nt.required(name))}</span>`;
const emptyForm = (): FormState => ({ title: '', goal: '', type: 'code', allowed: '', verify: '', nonGoals: '', refs: '', questions: '', text: '' });

// 任务说明的修改时间：今天、昨天显示时分，更早显示日期（与任务列表的分组口径一致，037 第 2 项的同一个纯函数）。
// 验收 / 演示模式下"现在"由 preload 送来（AR_DEMO_NOW 固定），平时用当前时间。
function formatMtime(value: number) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const group = dayGroup(value, window.dock.demoNow ?? Date.now());
    const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (group === 'today') return `${c.today} ${time}`;
    if (group === 'yesterday') return `${c.yesterday} ${time}`;
    return date.toLocaleDateString('zh-CN');
}

export class NewTaskView {
    private container?: HTMLElement;
    private projects: ProjectRow[] = [];
    private agents: AgentRow[] = [];
    private show: ProjectShow | null = null;
    private specs: SpecRow[] = [];
    private project = '';
    private source: Source = 'new';
    private selectedSpec = '';
    private worker = '';
    private commit = true;
    private form: FormState = emptyForm();
    private defaultsFrom = '';
    private invalid = '';
    private error = '';
    private failure = '';
    // 派发因缺少提交身份失败：失败横幅里带"设置提交身份…"；文件已写好时记下相对路径与表单指纹，重试直接派发它。
    private identityFailure = false;
    private pendingSpec: { rel: string; key: string } | null = null;
    private dry: { rel: string; content: string } | null = null;
    private busy = false;
    private loaded = false;
    private loading = false;
    private loadSeq = 0;
    private projectSeq = 0;
    private drySeq = 0;
    private dryTimer?: ReturnType<typeof setTimeout>;

    constructor(private host: NewTaskHost) { }

    mount(container: HTMLElement) {
        this.container = container;
        this.failure = '';
        this.error = '';
        this.invalid = '';
        container.onclick = e => this.click(e);
        container.onkeydown = e => this.keys(e);
        container.oninput = e => this.input(e);
        this.render();
        if (this.loaded)
            this.setReady(false);
        void this.load();
    }

    unmount() {
        this.container = undefined;
        this.loadSeq++;
        this.projectSeq++;
        this.drySeq++;
        if (this.dryTimer) clearTimeout(this.dryTimer);
        this.dryTimer = undefined;
    }

    private enabledAgents() {
        return this.agents.filter(a => a.enabled && a.supported);
    }

    private autoAgent(): AgentRow | undefined {
        const enabled = this.enabledAgents();
        return enabled.find(a => a.default) ?? (enabled.length === 1 ? enabled[0] : undefined);
    }

    private workerLabel() {
        const enabled = this.enabledAgents();
        if (this.worker) return enabled.find(a => a.name === this.worker)?.label ?? this.worker;
        return this.autoAgent()?.label ?? '';
    }

    private ensureWorker() {
        const enabled = this.enabledAgents();
        if (this.worker && !enabled.some(a => a.name === this.worker)) this.worker = '';
        if (!enabled.length) { this.worker = ''; return; }
        // 没有默认执行者又不止一个时，核心不会替我们猜：改为明确选第一个，派发时带上 profile。
        if (!this.autoAgent() && !this.worker) this.worker = enabled[0].name;
    }

    private specsDirLabel() {
        const dir = this.show?.config?.specsDir;
        return typeof dir === 'string' && dir ? dir : 'docs/specs';
    }

    // 这份新说明派发后会不会跑门禁：直接用核心的 mergeSpec（任务说明 > 项目配置 > 默认），
    // 与派发时的判断同一份代码；只有新建说明才显示"先提交任务说明"。
    // 051：锁定时还要说明为什么跑门禁，原因按 类型 → 验收命令 → 允许路径 的顺序收集；
    // 条数与是否成立都取合并结果，"来自表单还是项目配置"只看表单那一栏解析后是否为空。
    private gatePlan() {
        if (this.source !== 'new') return { gate: false, commands: 0, reasons: [] as string[] };
        const config = (this.show?.config ?? {}) as { allowedPaths?: string[]; verify?: string[] };
        const formAllowed = lines(this.form.allowed.split(/\r?\n/)), formVerify = lines(this.form.verify.split(/\r?\n/));
        const merged = mergeSpec({ type: this.form.type, allowed_paths: formAllowed, verify: formVerify }, config);
        const paths = merged.allowed_paths, limited = !(paths.length === 1 && paths[0] === '**');
        const reasons: string[] = [];
        if (merged.gate) {
            if (merged.expect_commit) reasons.push(nt.gateWhyType(this.form.type));
            if (merged.verify.length) reasons.push(formVerify.length ? nt.gateWhyVerify(merged.verify.length) : nt.gateWhyVerifyProject(merged.verify.length));
            if (limited) reasons.push(formAllowed.length ? nt.gateWhyPaths : nt.gateWhyPathsProject);
        }
        return { gate: merged.gate === true, commands: merged.verify.length, reasons };
    }

    private note() {
        if (this.busy) return nt.dispatchingNote;
        if (!this.enabledAgents().length) return '';
        const label = this.workerLabel();
        if (!label) return '';
        if (this.source === 'text') return nt.conseqText(label);
        if (this.source === 'existing') return this.selectedSpec ? nt.conseqExisting(this.selectedSpec, label) : '';
        const plan = this.gatePlan(), text = nt.conseqNew(this.dry?.rel || FALLBACK_SPEC, label, this.commit || plan.gate);
        // 会跑门禁时说明后果：结束时由核心跑验收命令，条数用合并后的结果（后缀文案在 copy.ts 的 nt.conseqGate）。
        return plan.gate ? `${text}${nt.conseqGate(plan.commands)}` : text;
    }

    // 输入允许改动 / 验收命令时只同步"先提交任务说明"与后果说明，不重建表单（不打断输入和光标）。
    private updateCommit() {
        const button = this.container?.querySelector<HTMLButtonElement>('[data-nt-commit]');
        if (!button) return;
        const plan = this.gatePlan(), on = this.commit || plan.gate;
        button.setAttribute('aria-checked', String(on));
        button.disabled = plan.gate;
        // 050：会跑门禁时整行变灰、带锁形图标，与 disabled 一起切换。
        button.classList.toggle('off', plan.gate);
        if (plan.gate) button.setAttribute('aria-disabled', 'true');
        else button.removeAttribute('aria-disabled');
        button.querySelector('.cb')?.classList.toggle('on', on);
        const cb = button.querySelector('.cb');
        if (cb) cb.innerHTML = on ? icon('check-line') : '';
        const help = button.querySelector('.ct span');
        if (help) help.innerHTML = `${plan.gate ? icon('lock-line') : ''}${esc(plan.gate ? nt.commitSpecForcedWhy(plan.reasons) : nt.commitSpecHelp)}`;
    }

    private canDispatch() {
        if (this.busy || !this.loaded || !this.project) return false;
        if (!this.enabledAgents().length) return false;
        if (!this.worker && !this.autoAgent()) return false;
        if (this.source === 'existing' && !this.selectedSpec) return false;
        return true;
    }

    private missing(): { key: FormKey | 'spec'; name: string } | null {
        if (this.source === 'new') {
            if (!this.form.title.trim()) return { key: 'title', name: nt.titleField };
            if (!this.form.goal.trim()) return { key: 'goal', name: nt.goal };
        }
        else if (this.source === 'text') {
            if (!this.form.text.trim()) return { key: 'text', name: nt.text };
        }
        else if (!this.selectedSpec) return { key: 'spec', name: nt.specs };
        return null;
    }

    private failValidation(key: FormKey | 'spec', name: string) {
        this.invalid = key;
        this.render();
        const selector = key === 'spec' ? '[data-nt-spec].on' : `[data-nt-f="${key}"]`;
        this.container?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    }

    private formPayload() {
        const f = this.form;
        return {
            title: f.title.trim(), goal: f.goal.trim(), type: f.type,
            allowedPaths: lines(f.allowed.split(/\r?\n/)), verify: lines(f.verify.split(/\r?\n/)),
            nonGoals: f.nonGoals, refs: f.refs, acceptance: '', questions: f.questions,
            worker: this.worker || 'auto',
        };
    }

    private async load() {
        const token = ++this.loadSeq;
        this.loading = true;
        this.setReady(false);
        try {
            const [list, agents] = await Promise.all([window.dock.console('projects:list'), window.dock.console('agents:list')]);
            if (token !== this.loadSeq || !this.container) return;
            this.projects = Array.isArray(list?.projects) ? list.projects : [];
            this.agents = Array.isArray(agents?.agents) ? agents.agents : [];
            if (!this.projects.some(p => p.path === this.project)) this.project = this.projects[0]?.path ?? '';
            this.ensureWorker();
            this.loaded = true;
            await this.loadProject(this.project, token);
        }
        catch (error) {
            if (token !== this.loadSeq || !this.container) return;
            this.loaded = true;
            this.error = failure(error);
        }
        finally {
            if (token === this.loadSeq && this.container) {
                this.loading = false;
                this.render();
                this.setReady(true);
            }
        }
    }

    private async loadProject(path: string, loadToken = this.loadSeq) {
        if (!path) return;
        const token = ++this.projectSeq, before = this.dataKey();
        try {
            const [show, specs] = await Promise.all([
                window.dock.console('projects:show', { path }),
                window.dock.console('specs:list', { project: path }),
            ]);
            if (token !== this.projectSeq || loadToken !== this.loadSeq || this.project !== path) return;
            this.show = show?.project ?? null;
            this.specs = Array.isArray(specs?.specs) ? specs.specs : [];
            if (!this.specs.some(s => s.rel === this.selectedSpec)) this.selectedSpec = this.specs[0]?.rel ?? '';
            if (this.defaultsFrom !== path) {
                this.defaultsFrom = path;
                const config = (this.show?.config ?? {}) as Record<string, unknown>;
                this.form.allowed = lines(config.allowedPaths).join('\n');
                this.form.verify = lines(config.verify).join('\n');
            }
            if (this.dataKey() !== before) this.render();
        }
        catch (error) {
            if (token !== this.projectSeq || loadToken !== this.loadSeq || this.project !== path) return;
            this.error = failure(error);
            this.render();
        }
    }

    private dataKey() {
        return JSON.stringify([this.loaded, this.projects, this.agents, this.show, this.specs, this.selectedSpec, this.project, this.defaultsFrom]);
    }

    private setReady(ready: boolean) {
        if (this.container) this.container.dataset.ntReady = ready ? '1' : '0';
    }

    private render() {
        const container = this.container;
        if (!container?.isConnected) return;
        const scroller = container.querySelector<HTMLElement>('.doc-scroll'), top = scroller?.scrollTop ?? 0;
        const identity = this.identity();
        if (!this.loaded) {
            container.innerHTML = `<div class="doc scroll"><div class="page-h sticky"><h1>${esc(nt.title)}</h1><span class="lead">${esc(nt.lead)}</span></div><div class="doc-in narrow"></div></div>`;
        }
        else if (!this.projects.length) {
            container.innerHTML = this.emptyPage();
        }
        else {
            container.innerHTML = this.fullPage();
        }
        const box = container.querySelector<HTMLElement>('.doc-scroll');
        if (box) box.scrollTop = top;
        if (identity) container.querySelector<HTMLElement>(identity)?.focus({ preventScroll: true });
        this.setReady(!this.loading);
    }

    private emptyPage() {
        return `<div class="doc scroll"><div class="page-h sticky"><h1>${esc(nt.title)}</h1></div><div class="doc-in narrow">${this.banner()}<div class="empty tall">${icon('folder-add-line')}<b>${esc(nt.noProject)}</b><p>${esc(nt.noProjectHelp)}</p><button class="btn primary sm" data-page="projects">${icon('add-line')}${esc(nt.addProject)}</button></div></div></div>`;
    }

    private identityButton() {
        return `<button class="btn sm" data-nt-identity ${this.busy ? 'disabled' : ''}>${esc(pj.identitySet)}</button>`;
    }

    // 选中的 git 项目没有生效的提交身份（用户名或邮箱缺失）。
    private identityMissing() {
        const s = this.show;
        return !!(s?.git && s.identity) && !(s.identity.name && s.identity.email);
    }

    private banner() {
        if (this.failure)
            return `<div class="banner fail" role="alert"><span class="mk fail">${icon('close-circle-line')}</span><div class="rt"><b>${esc(nt.failed)}</b><span>${esc(this.failure)}</span></div>${this.identityFailure ? this.identityButton() : ''}</div>`;
        if (this.error)
            return `<div class="banner fail" role="alert"><span class="mk fail">${icon('close-circle-line')}</span><span>${esc(this.error)}</span></div>`;
        return '';
    }

    // 表单上方的警告横幅：派发不被禁止，只是提示"先提交任务说明"和执行者提交会失败。
    private identityWarn() {
        if (!this.identityMissing()) return '';
        return `<div class="banner brand" role="status"><span class="mk brand">${icon('information-line')}</span><span>${esc(nt.identityWarn)}</span>${this.identityButton()}</div>`;
    }

    private fullPage() {
        const disabled = this.busy ? 'disabled' : '';
        const row = this.projects.find(p => p.path === this.project);
        const branch = this.show?.branch ? ` · ${this.show.branch}` : '';
        const projectCtl = `<button class="sel" data-nt-project ${disabled} aria-haspopup="listbox" aria-expanded="false"><span class="mono">${esc(row?.name ?? this.project)}</span>${icon('arrow-down-s-line')}</button><span class="fhint mono nt-path" data-nt-path>${esc(this.project + branch)}</span>`;
        const sourceCtl = `<div class="segm" data-nt-seg="source" role="group" aria-label="${esc(nt.source)}">${SOURCES.map(s => `<button data-nt-source="${s}" class="${this.source === s ? 'on' : ''}" aria-pressed="${this.source === s}" ${disabled}>${esc(nt.sources[s])}</button>`).join('')}</div>`;
        const body = this.source === 'existing' ? this.existingBody(disabled) : this.source === 'text' ? this.textBody(disabled) : this.newBody(disabled);
        const enabled = this.enabledAgents(), auto = this.autoAgent();
        const workerCtl = !enabled.length
            ? `<button class="sel" disabled><span class="ph">${esc(nt.noWorker)}</span></button>`
            : `<button class="sel" data-nt-worker ${disabled} aria-haspopup="listbox" aria-expanded="false"><span>${esc(this.worker ? this.workerLabel() : auto ? nt.auto(auto.label) : this.workerLabel())}</span>${icon('arrow-down-s-line')}</button>`;
        // "先提交任务说明"只对新建的说明有意义：已有说明本来就在仓库里，直接写文字不生成文件。
        // 会跑门禁时必须先提交说明（门禁从干净的基线比较改动）：勾选并禁用，整行变灰、说明前带锁形图标，说明文字换成原因。
        const plan = this.gatePlan(), commitOn = this.commit || plan.gate;
        const commitCtl = this.source !== 'new' ? '' : field('', '', `<button class="choice${plan.gate ? ' off' : ''}" data-nt-commit role="checkbox" aria-checked="${commitOn}"${plan.gate ? ' aria-disabled="true"' : ''} ${disabled}${plan.gate ? ' disabled' : ''}><span class="cb ${commitOn ? 'on' : ''}">${commitOn ? icon('check-line') : ''}</span><span class="ct">${esc(nt.commitSpec)}<span>${plan.gate ? icon('lock-line') : ''}${esc(plan.gate ? nt.commitSpecForcedWhy(plan.reasons) : nt.commitSpecHelp)}</span></span></button>`);
        const dispatch = this.busy
            ? `<span class="mk run">${icon('loader-4-line')}</span>${esc(nt.dispatching)}`
            : `${icon('send-plane-line')}${esc(nt.dispatch)}`;
        const buttons = `<span class="note" data-nt-note aria-live="polite">${esc(this.note())}</span>${this.source === 'new' ? `<button class="btn" data-nt-preview ${disabled}>${esc(nt.preview)}</button>` : ''}<button class="btn primary" data-nt-dispatch ${this.canDispatch() ? '' : 'disabled'}>${dispatch}</button>`;
        return `<div class="doc with-bar"><div class="scroll doc-scroll"><div class="page-h sticky"><h1>${esc(nt.title)}</h1><span class="lead">${esc(nt.lead)}</span></div><div class="doc-in narrow">${this.identityWarn()}<div class="form">${this.banner()}${field(nt.project, '', projectCtl)}${field(nt.source, '', sourceCtl)}${body}${field(nt.worker, '', workerCtl)}${commitCtl}</div></div></div><div class="actbar">${buttons}</div></div>`;
    }

    private existingBody(disabled: string) {
        const help = esc(nt.specsHelp(this.specsDirLabel()));
        if (!this.specs.length) return field(nt.specs, help, `<p class="fhint" data-nt-specs-empty>${esc(nt.specsEmpty)}</p>`);
        const rows = this.specs.map(s => {
            const on = s.rel === this.selectedSpec;
            return `<button class="pick ${on ? 'on' : ''}" data-nt-spec="${esc(s.rel)}" role="radio" aria-checked="${on}" ${disabled}><span class="rd ${on ? 'on' : ''}"></span><span class="pk"><b class="mono">${esc(s.file)}</b><span>${esc(s.title)} · ${esc(nt.dispatched(s.dispatched))}</span></span><span class="mono muted">${esc(formatMtime(s.mtime))}</span></button>`;
        }).join('');
        return field(nt.specs, help, `<div class="picks" data-nt-picks role="radiogroup" aria-label="${esc(nt.specs)}">${rows}</div>`);
    }

    private textBody(disabled: string) {
        const hint = this.invalid === 'text' ? requiredHint(nt.text) : '';
        return field(nt.text, esc(nt.textHelp), `<textarea class="inp area" data-nt-f="text" rows="6" aria-label="${esc(nt.text)}" placeholder="" ${disabled}>${esc(this.form.text)}</textarea>${hint}`, true);
    }

    private newBody(disabled: string) {
        const text = (key: FormKey, label: string, help: string, rows: number, mono = false, placeholder = '', req = false) => {
            const hint = this.invalid === key ? requiredHint(label) : '';
            return field(label, help ? esc(help) : '', `<textarea class="inp area${mono ? ' mono' : ''}" data-nt-f="${key}" rows="${rows}" aria-label="${esc(label)}" placeholder="${esc(placeholder)}" ${disabled}>${esc(this.form[key])}</textarea>${hint}`, req);
        };
        const titleHint = this.invalid === 'title' ? requiredHint(nt.titleField) : '';
        const goalHint = this.invalid === 'goal' ? requiredHint(nt.goal) : '';
        return `${field(nt.titleField, esc(nt.titleHelp), `<input class="inp" data-nt-f="title" aria-label="${esc(nt.titleField)}" value="${esc(this.form.title)}" ${disabled}>${titleHint}`, true)}
            ${field(nt.goal, esc(nt.goalHelp), `<textarea class="inp area" data-nt-f="goal" rows="3" aria-label="${esc(nt.goal)}" ${disabled}>${esc(this.form.goal)}</textarea>${goalHint}`, true)}
            ${field(nt.type, '', `<div class="segm sm" data-nt-seg="type" role="group" aria-label="${esc(nt.type)}">${nt.types.map(t => `<button data-nt-type="${esc(t)}" class="${this.form.type === t ? 'on' : ''}" aria-pressed="${this.form.type === t}" ${disabled}>${esc(t)}</button>`).join('')}</div>`)}
            ${text('allowed', nt.allowed, nt.allowedHelp, 2, true)}
            ${text('verify', nt.verify, nt.verifyHelp, 2, true)}
            ${text('nonGoals', nt.nonGoals, '', 2)}
            ${text('refs', nt.refs, nt.refsHelp, 2, false, nt.refsPlaceholder)}
            ${text('questions', nt.questions, '', 2, false, nt.questionsPlaceholder)}`;
    }

    // 重建后把焦点放回同一个控件：先看 data-*，再看表单字段、来源/类型分段与任务说明行。
    private identity(): string | null {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !this.container?.contains(active)) return null;
        const d = active.dataset;
        if (d.ntProject !== undefined) return '[data-nt-project]';
        if (d.ntWorker !== undefined) return '[data-nt-worker]';
        if (d.ntCommit !== undefined) return '[data-nt-commit]';
        if (d.ntPreview !== undefined) return '[data-nt-preview]';
        if (d.ntDispatch !== undefined) return '[data-nt-dispatch]';
        if (d.ntIdentity !== undefined) return '[data-nt-identity]';
        if (d.ntSource) return `[data-nt-source="${d.ntSource}"]`;
        if (d.ntType) return `[data-nt-type="${d.ntType}"]`;
        if (d.ntSpec) return `[data-nt-spec="${CSS.escape(d.ntSpec)}"]`;
        if (d.ntF) return `[data-nt-f="${d.ntF}"]`;
        return null;
    }

    private updateNote() {
        const note = this.container?.querySelector<HTMLElement>('[data-nt-note]');
        if (note) note.textContent = this.note();
    }

    private click(e: MouseEvent) {
        const button = (e.target as Element).closest<HTMLButtonElement>('button');
        if (!button || button.disabled || this.busy || !this.container?.contains(button)) return;
        const d = button.dataset;
        if (d.ntSource && SOURCES.includes(d.ntSource as Source)) { this.setSource(d.ntSource as Source); return; }
        if (d.ntType && this.form.type !== d.ntType) {
            this.form.type = d.ntType;
            this.render();
            this.container?.querySelector<HTMLElement>(`[data-nt-type="${d.ntType}"]`)?.focus({ preventScroll: true });
            this.scheduleDry();
            return;
        }
        if (d.ntSpec) {
            this.selectedSpec = d.ntSpec;
            this.invalid = '';
            this.render();
            return;
        }
        if (d.ntProject !== undefined) { this.chooseProject(button); return; }
        if (d.ntWorker !== undefined) { this.chooseWorker(button); return; }
        if (d.ntCommit !== undefined) { this.commit = !this.commit; this.render(); this.updateNote(); return; }
        if (d.ntPreview !== undefined) { void this.preview(button); return; }
        if (d.ntDispatch !== undefined) { void this.dispatch(); return; }
        if (d.ntIdentity !== undefined) { this.editIdentity(button); return; }
    }

    private setSource(source: Source) {
        if (this.busy || this.source === source) return;
        this.source = source;
        this.invalid = '';
        this.render();
        this.container?.querySelector<HTMLElement>(`[data-nt-source="${source}"]`)?.focus({ preventScroll: true });
        if (source === 'new') this.scheduleDry();
    }

    private chooseProject(anchor: HTMLElement) {
        menu(anchor, this.projects.map(p => ({
            label: p.name,
            run: () => {
                if (this.project === p.path) return;
                this.project = p.path;
                this.selectedSpec = '';
                this.show = null;
                this.specs = [];
                this.dry = null;
                this.invalid = '';
                this.failure = '';
                this.error = '';
                this.identityFailure = false;
                this.pendingSpec = null;
                this.render();
                void this.loadProject(p.path);
            },
        })), true);
    }

    // 设置提交身份（与项目页同一个模态框）：保存后重新读项目详情，警告 / 失败横幅随之更新。
    private editIdentity(trigger: HTMLElement) {
        if (!this.project) return;
        const path = this.project;
        openIdentitySheet({
            path, trigger, identity: this.show?.identity,
            onSaved: async () => {
                this.identityFailure = false;
                this.failure = '';
                await this.loadProject(path);
            },
        });
    }

    private chooseWorker(anchor: HTMLElement) {
        const items: { label: string; run: () => void }[] = [];
        const auto = this.autoAgent();
        if (auto) items.push({ label: nt.auto(auto.label), run: () => { this.worker = ''; this.render(); this.updateNote(); } });
        for (const agent of this.enabledAgents()) items.push({ label: agent.label, run: () => { this.worker = agent.name; this.render(); this.updateNote(); } });
        menu(anchor, items, true);
    }

    private input(e: Event) {
        const target = e.target as HTMLInputElement | HTMLTextAreaElement;
        const key = target.dataset?.ntF as FormKey | undefined;
        if (!key || !(key in this.form)) return;
        this.form[key] = target.value;
        if (this.invalid === key && target.value.trim()) {
            this.invalid = '';
            target.closest('.fc')?.querySelector('[data-nt-required]')?.remove();
        }
        if (this.source === 'new') this.scheduleDry();
        this.updateNote();
        if (key === 'allowed' || key === 'verify') this.updateCommit();
    }

    private keys(e: KeyboardEvent) {
        if (this.busy) return;
        const target = e.target as Element;
        const segment = target.closest<HTMLElement>('[data-nt-seg]');
        if (segment && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            const kind = segment.dataset.ntSeg;
            if (kind === 'source') {
                const i = SOURCES.indexOf(this.source);
                const next = e.key === 'Home' ? 0 : e.key === 'End' ? SOURCES.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + SOURCES.length) % SOURCES.length;
                this.setSource(SOURCES[next]);
            }
            else if (kind === 'type') {
                const i = Math.max(0, nt.types.indexOf(this.form.type));
                const next = e.key === 'Home' ? 0 : e.key === 'End' ? nt.types.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + nt.types.length) % nt.types.length;
                this.form.type = nt.types[next];
                this.render();
                this.container?.querySelector<HTMLElement>(`[data-nt-type="${nt.types[next]}"]`)?.focus({ preventScroll: true });
                this.scheduleDry();
            }
            return;
        }
        const picks = target.closest<HTMLElement>('[data-nt-picks]');
        if (picks && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) && this.specs.length) {
            e.preventDefault();
            const i = Math.max(0, this.specs.findIndex(s => s.rel === this.selectedSpec));
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? this.specs.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + this.specs.length) % this.specs.length;
            this.selectedSpec = this.specs[next].rel;
            this.invalid = '';
            this.render();
            this.container?.querySelector<HTMLElement>(`[data-nt-spec="${CSS.escape(this.selectedSpec)}"]`)?.focus({ preventScroll: true });
        }
    }

    private scheduleDry() {
        if (this.dryTimer) clearTimeout(this.dryTimer);
        this.dryTimer = setTimeout(() => { this.dryTimer = undefined; void this.refreshDry(); }, 300);
    }

    // 只刷新"会写入哪个文件"这一行；不重建表单，避免打断输入。
    private async refreshDry() {
        if (this.source !== 'new' || !this.project || !this.form.title.trim() || !this.form.goal.trim()) {
            this.dry = null;
            this.updateNote();
            return;
        }
        const token = ++this.drySeq, project = this.project;
        try {
            const result = await window.dock.console('specs:new', { project, form: this.formPayload(), dryRun: true });
            if (token !== this.drySeq || this.project !== project || this.source !== 'new') return;
            this.dry = { rel: String(result?.rel ?? ''), content: String(result?.content ?? '') };
        }
        catch {
            if (token !== this.drySeq) return;
            this.dry = null;
        }
        this.updateNote();
    }

    private async preview(trigger: HTMLElement) {
        if (this.busy) return;
        const missing = this.missing();
        if (missing) { this.failValidation(missing.key, missing.name); return; }
        this.error = '';
        let result: any;
        try {
            result = await window.dock.console('specs:new', { project: this.project, form: this.formPayload(), dryRun: true });
        }
        catch (error) {
            this.error = failure(error);
            this.render();
            return;
        }
        const content = String(result?.content ?? '');
        if (!content) {
            this.error = cx.noResult;
            this.render();
            return;
        }
        const rel = String(result?.rel ?? '');
        this.dry = { rel, content };
        this.updateNote();
        // 排版 / 源码分段：默认排版视图；两块都在 DOM 里，切换只显隐，键盘可操作且焦点留在分段上。
        const views = ['rendered', 'source'] as const;
        const body = document.createElement('div');
        body.className = 'nt-preview';
        body.innerHTML = `<div class="segm sm" data-nt-seg="preview" role="group" aria-label="${esc(nt.previewTitle)}">${views.map(view => `<button data-nt-view="${view}" class="${view === 'rendered' ? 'on' : ''}" aria-pressed="${view === 'rendered'}">${esc(nt.previewViews[view])}</button>`).join('')}</div><div class="md selectable">${markdown(content)}</div><pre class="mdsrc selectable" hidden>${esc(content)}</pre>`;
        const setView = (view: typeof views[number], focus: boolean) => {
            body.querySelector('.md')!.toggleAttribute('hidden', view !== 'rendered');
            body.querySelector('.mdsrc')!.toggleAttribute('hidden', view !== 'source');
            for (const button of body.querySelectorAll<HTMLButtonElement>('[data-nt-view]')) {
                const on = button.dataset.ntView === view;
                button.classList.toggle('on', on);
                button.setAttribute('aria-pressed', String(on));
                if (on && focus)
                    button.focus({ preventScroll: true });
            }
        };
        body.onclick = e => {
            const button = (e.target as Element).closest<HTMLButtonElement>('[data-nt-view]');
            if (button && body.contains(button))
                setView(button.dataset.ntView === 'source' ? 'source' : 'rendered', true);
        };
        body.onkeydown = e => {
            const segment = (e.target as Element).closest<HTMLElement>('[data-nt-seg="preview"]');
            if (!segment || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
                return;
            e.preventDefault();
            const current = segment.querySelector<HTMLButtonElement>('[data-nt-view].on')?.dataset.ntView === 'source' ? 1 : 0;
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? views.length - 1 : (current + (e.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length;
            setView(views[next], true);
        };
        openSheet({
            title: nt.previewTitle,
            trigger,
            wide: true,
            body,
            note: esc(rel),
            buttons: [nt.close, nt.dispatch],
            onButton: (index, sheet) => {
                sheet.close();
                if (index === 1) void this.dispatch();
            },
        });
    }

    private async send(project: string, body: Record<string, unknown>) {
        const payload: Record<string, unknown> = { project, ...body };
        if (this.worker) payload.profile = this.worker;
        const result = await window.dock.console('tasks:dispatch', payload);
        return typeof result?.id === 'string' ? result.id : '';
    }

    // 派发成功后回到初始状态：文本字段清空、来源回默认、已有说明选择与草稿标记清掉；
    // 保留"项目"与"执行者"。允许改动的文件 / 验收命令的初始状态是项目配置默认值，
    // 所以把 defaultsFrom 清空，下次进入页面时 loadProject 会重新取项目配置。
    private clearForm() {
        this.form = emptyForm();
        this.selectedSpec = '';
        this.source = 'new';
        this.commit = true;
        this.defaultsFrom = '';
        this.dry = null;
        this.pendingSpec = null;
        this.invalid = '';
        this.failure = '';
        this.error = '';
        this.identityFailure = false;
    }

    private async dispatch() {
        if (!this.canDispatch()) return;
        const missing = this.missing();
        if (missing) { this.failValidation(missing.key, missing.name); return; }
        // 会跑门禁时无论勾选状态如何都先提交说明：与表单上被固定为勾选的复选框一致。
        const project = this.project, source = this.source, form = this.formPayload(), commit = this.commit || this.gatePlan().gate;
        // 表单指纹：只有内容没变时才沿用上次已经写好的任务说明，避免派发到旧文件。
        const key = JSON.stringify([form, commit]);
        let planned = '';
        this.busy = true;
        this.invalid = '';
        this.failure = '';
        this.error = '';
        this.identityFailure = false;
        this.render();
        try {
            let id = '';
            if (source === 'new') {
                let rel = '', content = '';
                // 上次因缺少提交身份失败：任务说明文件已经写好了，直接派发这一份，不重复编号。
                const pending = this.pendingSpec;
                if (pending && pending.key === key) {
                    try {
                        const read = await window.dock.console('specs:read', { project, rel: pending.rel });
                        rel = pending.rel;
                        content = String(read?.content ?? '');
                    }
                    catch { this.pendingSpec = null; }
                    // 补好身份后，先补提交这份说明再派发（门禁要求说明已提交）；提交失败不派发。
                    if (rel) await window.dock.console('specs:commit', { project, rel });
                }
                if (!rel) {
                    // 先预览一次拿到将要写入的文件名（只读，不写文件）：提交失败时用它记录已写好的文件。
                    if (commit) planned = String((await window.dock.console('specs:new', { project, form, dryRun: true }))?.rel ?? '');
                    const created = await window.dock.console('specs:new', { project, form, commit });
                    rel = String(created?.rel ?? '');
                    content = String(created?.content ?? '');
                }
                this.pendingSpec = null;
                this.selectedSpec = rel;
                this.dry = { rel, content };
                id = await this.send(project, { source: 'spec', spec: rel });
            }
            else if (source === 'existing')
                id = await this.send(project, { source: 'spec', spec: this.selectedSpec });
            else
                id = await this.send(project, { source: 'text', text: this.form.text });
            this.busy = false;
            // 派发成功：表单回到初始状态，下次进入"新建任务"页是空白表单（失败路径保留输入）。
            this.clearForm();
            await this.finish(id);
        }
        catch (error) {
            this.busy = false;
            // 文件已写好但提交失败：横幅里给设置按钮；补好身份后再点派发，直接派发这份文件。
            if (source === 'new' && errorCode(error) === 'NEED_GIT_IDENTITY') {
                this.identityFailure = true;
                if (planned) this.pendingSpec = { rel: planned, key };
            }
            this.failure = failure(error);
            this.render();
        }
    }

    // 派发是分离进程：核心先返回 id，runs.jsonl 里的 start 行稍后才出现。最多等 5 秒，
    // 等到了再切回任务页选中它；没等到也切回任务页，只是不选中，派发本身已经成功。
    private async finish(id: string) {
        if (!id) { if (this.container) this.host.openTask(''); return; }
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            if (this.host.tasks().some(t => t.id === id)) { if (this.container) this.host.openTask(id); return; }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (this.container) this.host.openTask('');
    }
}
