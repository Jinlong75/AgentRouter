// 导入向导的新部件（Stage07 O6 / O7）：下拉加"自定义…"的选择控件（模型、推理强度、接口地址、升级目标共用）、
// 自定义 CLI 表单（宽表单，标签式参数输入，事件映射行，每次改动用核心校验）和"测试并预览"。
// 校验、检测、预览、保存都经 console 通道交给核心（agents:validate-decl / detect-decl / test-decl / add-generic），界面不自己解释声明。
import { ag, gx, c, p } from '../shared/copy';
import { esc } from '../shared/markdown';
import type { DeclProblem, PreviewResult } from '../shared/types';
import { icon, field, openSheet, confirmAction, type Sheet } from './ui';

// ---------- 下拉选择（.selw / .sel / .menu）----------
// 选项菜单挂在模态框的遮罩上（背景是 inert，菜单要在框内可操作）；Esc / Tab 先关菜单，不关模态框（在 window 捕获阶段拦住）。
export const CUSTOM = '\u0000custom';
export interface Opt { value: string; label?: string; desc?: string }
let closeCurrent: (() => void) | null = null, currentAnchor: HTMLElement | null = null;

export function openOptionMenu(anchor: HTMLElement, items: Opt[], current: string, pick: (value: string) => void) {
    const again = currentAnchor === anchor;
    closeCurrent?.();
    if (again) return;
    const host = anchor.closest<HTMLElement>('.ov') ?? document.body;
    const menu = document.createElement('div');
    menu.className = 'menu optmenu scroll'; menu.setAttribute('role', 'listbox');
    menu.innerHTML = items.map((o, i) => `<button type="button" role="option" aria-selected="${o.value === current}" data-opt="${i}">${o.value === current ? icon('check-line') : '<span class="ri-sp"></span>'}<span>${esc(o.label ?? o.value)}</span>${o.desc ? `<em>${esc(o.desc)}</em>` : ''}</button>`).join('');
    host.append(menu);
    const a = anchor.getBoundingClientRect(), h = host === document.body ? { left: 0, top: 0, height: innerHeight } : host.getBoundingClientRect();
    menu.style.minWidth = `${Math.round(a.width)}px`;
    const below = a.bottom - h.top + 4, height = menu.offsetHeight;
    menu.style.left = `${Math.round(a.left - h.left)}px`;
    menu.style.top = `${Math.round(below + height > h.height - 8 ? Math.max(8, a.top - h.top - height - 4) : below)}px`;
    anchor.setAttribute('aria-expanded', 'true');
    currentAnchor = anchor;
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const close = (refocus = true) => {
        window.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', outside, true);
        menu.remove(); anchor.setAttribute('aria-expanded', 'false'); closeCurrent = null; currentAnchor = null;
        if (refocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
    const outside = (e: PointerEvent) => { if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(false); };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', outside, true);
    menu.onclick = e => { const b = (e.target as Element).closest<HTMLButtonElement>('button'); if (!b) return; const value = items[+b.dataset.opt!].value; close(false); pick(value); };
    closeCurrent = close;
    (buttons.find(b => b.getAttribute('aria-selected') === 'true') ?? buttons[0])?.focus({ preventScroll: true });
}

// 模型、推理强度这类"下拉 + 自定义"：value 是当前值，custom 为真时显示输入框。没有任何可选项时直接是输入框。
export interface Choice { value: string; custom: boolean }
// fixed：只能在选项里选（没有"自定义…"，例如升级目标）。
export interface ChoiceSpec { key: string; attr: string; opts: Opt[]; lead?: Opt[]; label: string; mono?: boolean; ph?: string; fixed?: boolean }
const menuItems = (spec: ChoiceSpec): Opt[] => [...(spec.lead ?? []), ...spec.opts, ...(spec.fixed ? [] : [{ value: CUSTOM, label: gx.modelCustom }])];

export function choiceHtml(spec: ChoiceSpec, st: Choice): string {
    const input = `<input class="inp${spec.mono === false ? '' : ' mono'}" ${spec.attr}="${esc(spec.key)}" value="${esc(st.value)}" placeholder="${esc(spec.ph ?? gx.modelCustomPh)}" aria-label="${esc(spec.label)}">`;
    if (!spec.opts.length && !spec.lead?.length) return input;
    if (st.custom && !spec.fixed) return `<div class="statusline">${input}<button type="button" class="btn icon quiet" data-sel="${esc(spec.key)}" aria-haspopup="listbox" aria-label="${esc(spec.label)}" title="${esc(spec.label)}">${icon('arrow-down-s-line')}</button></div>`;
    const shown = [...(spec.lead ?? []), ...spec.opts].find(o => o.value === st.value);
    return `<span class="selw"><button type="button" class="sel" data-sel="${esc(spec.key)}" aria-haspopup="listbox" aria-label="${esc(spec.label)}"><span class="${spec.mono === false ? '' : 'mono'}">${esc(shown?.label ?? shown?.value ?? st.value)}</span>${icon('arrow-down-s-line')}</button></span>`;
}

// 点 [data-sel] 打开菜单；选中后更新状态并要求重画（焦点放回这个控件，选"自定义…"时放进输入框）。
export interface ChoiceHost {
    spec(key: string): ChoiceSpec | undefined;
    state(key: string): Choice;
    set(key: string, st: Choice): void;
    redraw(focus: string): void;
}
export function bindChoices(root: HTMLElement, host: ChoiceHost) {
    root.addEventListener('click', e => {
        const b = (e.target as Element).closest<HTMLButtonElement>('[data-sel]');
        if (!b || b.disabled) return;
        const key = b.dataset.sel!, spec = host.spec(key);
        if (!spec) return;
        e.stopPropagation();
        const st = host.state(key);
        openOptionMenu(b, menuItems(spec), st.custom ? CUSTOM : st.value, value => {
            if (value === CUSTOM) { host.set(key, { value: st.value, custom: true }); host.redraw(`[${spec.attr}="${CSS.escape(key)}"]`); }
            else { host.set(key, { value, custom: false }); host.redraw(`[data-sel="${CSS.escape(key)}"]`); }
        });
    });
}

// ---------- 标签式输入（参数模板、只读参数）----------
const isPlaceholder = (arg: string) => /\{[A-Za-z_][A-Za-z0-9_-]*\}/.test(arg);
export const PLACEHOLDER_BUTTONS = ['{prompt}', '{promptFile}', '{worktree}', '{report}', '{model}', '{effort}'];
function tagsHtml(key: string, list: string[], aria: string, ph: string, placeholders: boolean) {
    const chips = list.map((arg, i) => `<span class="argchip ${isPlaceholder(arg) ? 'ph' : ''}"><span class="mono">${esc(arg)}</span><button type="button" class="x" data-tag-del="${key}" data-i="${i}" aria-label="${esc(gx.argRemove(arg))}" title="${esc(gx.argRemove(arg))}">${icon('close-line')}</button></span>`).join('');
    const bar = placeholders ? `<div class="phbar"><span class="muted">${esc(gx.insert)}</span>${PLACEHOLDER_BUTTONS.map(x => `<button type="button" class="btn sm quiet mono" data-tag-ph="${key}" data-v="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : '';
    return `<div class="argbox${list.length ? '' : ' empty'}">${chips}<input class="arginp mono" data-tag-in="${key}" aria-label="${esc(aria)}" placeholder="${esc(ph)}"></div>${bar}`;
}

// ---------- 事件映射的文本写法 ----------
// 条件：`键 = 值`，多个用逗号分隔；值是 true / false / null / 数字时按这个类型比较，其余是字符串（加引号可强制成字符串）。
// 字段：`字段 ← 取值路径`，多个用 ` · ` 分隔（`<-` 也认）。
const literal = (raw: string): string | number | boolean | null => {
    const s = raw.trim();
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0]) return s.slice(1, -1);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    return s !== '' && Number.isFinite(Number(s)) ? Number(s) : s;
};
export function parseWhen(text: string): { when: Record<string, unknown>; error?: string } {
    const when: Record<string, unknown> = {};
    for (const part of text.split(/[,，]/).map(x => x.trim()).filter(Boolean)) {
        const at = part.indexOf('=');
        if (at <= 0 || !part.slice(0, at).trim()) return { when, error: gx.whenFormat(part) };
        when[part.slice(0, at).trim()] = literal(part.slice(at + 1));
    }
    return { when };
}
export function parseFields(text: string): { fields: Record<string, string>; error?: string } {
    const fields: Record<string, string> = {};
    for (const part of text.split(/\s*[·]\s*/).map(x => x.trim()).filter(Boolean)) {
        const m = /^(.+?)\s*(?:←|<-)\s*(.+)$/.exec(part);
        if (!m) return { fields, error: gx.fieldsFormat(part) };
        fields[m[1].trim()] = m[2].trim();
    }
    return { fields };
}

// ---------- 事件在"映射结果"里的一行 ----------
const KIND_ICON: Record<string, string> = { say: 'chat-1-line', think: 'lightbulb-line', cmd: 'terminal-box-line', file: 'file-edit-line', plan: 'list-check-2', tool: 'tools-line', turn: 'cpu-line', error: 'error-warning-line', text: 'text' };
const val = (v: unknown) => v == null ? '' : typeof v === 'string' ? v : String(v);
export function eventLine(e: { kind: string; [key: string]: unknown }): string {
    const k = gx.kinds[e.kind] ?? e.kind;
    switch (e.kind) {
        case 'say': case 'think': case 'error': return `${k}：${val(e.text)}`;
        case 'cmd': return `${k}：${val(e.command)}${e.phase === 'end' ? ` → exit ${val(e.exit)}` : ''}`;
        case 'file': return `${k}：${((e.files as { path: string }[] | undefined) ?? []).map(f => f.path).join('、')}`;
        case 'plan': return `${k}：${((e.items as unknown[] | undefined) ?? []).length}`;
        case 'tool': return `${k}：${val(e.name)}${e.detail ? ` ${val(e.detail)}` : ''}`;
        case 'turn': { const u = (e.usage ?? {}) as { input?: number | null; output?: number | null }; return `${k}：${ag.tokensValue(u.input ?? 0, u.output ?? 0)}`; }
        default: return val(e.text);
    }
}

// ---------- 自定义 CLI 表单 ----------
interface MapRow { when: string; kind: string; fields: string }
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FORMATS = ['text', 'jsonl', 'stream-json'] as const;
const REPORTS = ['stdout', 'lastSay', 'file'] as const;

export interface CustomFormOptions {
    trigger: HTMLElement;
    existing: string[];
    onDone: (name: string) => void;
    onBack: () => void;
}

export function openCustomForm(o: CustomFormOptions): Sheet {
    const uniqueName = (base: string) => { let name = base, n = 2; while (o.existing.includes(name)) name = `${base}-${n++}`; return name; };
    const S = {
        name: uniqueName('custom'), label: '', program: '', detectArgs: '--version', args: [] as string[], stdin: '',
        format: 'jsonl' as typeof FORMATS[number], maps: [{ when: '', kind: 'say', fields: '' }] as MapRow[],
        report: 'lastSay' as typeof REPORTS[number], readOnly: [] as string[], secretVar: '',
    };
    let mode: 'form' | 'preview' = 'form', previewing = false, preview: PreviewResult | null = null, previewFailure = '';
    let dirty = false, touched = false, saved = false, saving = false;
    let errors: DeclProblem[] = [], validated = false, validateSeq = 0, validateTimer: ReturnType<typeof setTimeout> | undefined;
    let program: { state: 'idle' | 'checking' | 'found' | 'missing'; version: string; checked: string } = { state: 'idle', version: '', checked: '' };
    let detectSeq = 0;
    const kindOpts: Opt[] = Object.keys(gx.kinds).map(value => ({ value, label: gx.kinds[value] }));

    // 当前表单 → 声明。映射行的文本写法有误时记下本地错误（key 是字段名）。
    const build = () => {
        const local: Record<string, string[]> = {};
        const split = (s: string) => s.trim().split(/\s+/).filter(Boolean);
        const detect = split(S.detectArgs);
        const map = S.maps.map((row, i) => {
            const w = parseWhen(row.when), f = parseFields(row.fields);
            for (const error of [w.error, f.error]) if (error) (local.map ??= []).push(`${i + 1}：${error}`);
            return { ...(Object.keys(w.when).length ? { when: w.when } : {}), kind: row.kind, ...f.fields };
        });
        const decl: Record<string, unknown> = {
            label: (S.label || S.name).trim(), executable: S.program.trim(), ...(detect.length ? { detect } : {}), args: [...S.args],
            ...(S.stdin.trim() ? { stdin: S.stdin.trim() } : {}),
            output: S.format === 'jsonl' ? { format: 'jsonl', map } : { format: S.format },
            ...(S.format === 'stream-json' ? {} : { report: S.report }),
            ...(S.readOnly.length ? { readOnlyArgs: [...S.readOnly] } : {}),
            ...(S.secretVar.trim() ? { secrets: { [S.secretVar.trim()]: S.secretVar.trim() } } : {}),
        };
        const name = S.name.trim();
        if (!NAME_RE.test(name)) local.name = [gx.nameInvalid];
        else if (o.existing.includes(name)) local.name = [gx.nameTaken(name)];
        return { decl, local };
    };

    const mapRows = () => S.maps.map((row, i) => `<div class="map-row" data-map="${i}"><input class="inp mono" data-m="when" data-i="${i}" value="${esc(row.when)}" placeholder="type = message" aria-label="${esc(`${gx.mapWhen} ${i + 1}`)}"><span class="selw"><button type="button" class="sel" data-kind="${i}" aria-haspopup="listbox" aria-label="${esc(`${gx.mapKind} ${i + 1}`)}"><span>${esc(gx.kinds[row.kind] ?? row.kind)}</span>${icon('arrow-down-s-line')}</button></span><input class="inp mono" data-m="fields" data-i="${i}" value="${esc(row.fields)}" placeholder="text ← content" aria-label="${esc(`${gx.mapFields} ${i + 1}`)}"><button type="button" class="btn icon quiet sm" data-map-del="${i}" aria-label="${esc(gx.mapRemove(i + 1))}" title="${esc(gx.mapRemove(i + 1))}">${icon('delete-bin-line')}</button></div>`).join('');
    const seg = (key: string, items: readonly string[], labels: Record<string, string>, on: string, aria: string) => `<div class="segm" role="group" aria-label="${esc(aria)}">${items.map(v => `<button type="button" data-seg="${key}" data-v="${v}" class="${on === v ? 'on' : ''}" aria-pressed="${on === v}">${esc(labels[v])}</button>`).join('')}</div>`;
    const err = (key: string) => `<div class="ferr" data-err="${key}"></div>`;
    const input = (key: string, value: string, label: string, { mono = true, ph = '' } = {}) => `<input class="inp${mono ? ' mono' : ''}" data-c="${key}" value="${esc(value)}" placeholder="${esc(ph)}" aria-label="${esc(label)}">`;
    const formBody = () => `<div class="form"><div class="ferr general" data-err="general"></div>
        ${field(ag.name, esc(ag.nameHelp), input('name', S.name, ag.name) + err('name'), true)}
        ${field(ag.label, esc(ag.labelHelp), input('label', S.label, ag.label, { mono: false }) + err('label'))}
        ${field(gx.program, esc(gx.programHelp), `<div class="statusline">${input('program', S.program, gx.program)}<button type="button" class="btn" data-c-act="browse">${icon('folder-open-line')}${esc(gx.browse)}</button><span data-prog-status></span></div>${err('program')}`, true)}
        ${field(gx.detectArgs, esc(gx.detectArgsHelp), input('detectArgs', S.detectArgs, gx.detectArgs) + err('detectArgs'))}
        ${field(gx.argsTpl, esc(gx.argsTplHelp), tagsHtml('args', S.args, gx.argsTpl, gx.argAdd, true) + err('args'), true)}
        ${field(gx.stdin, esc(gx.stdinHelp), input('stdin', S.stdin, gx.stdin, { ph: gx.stdinPh }) + err('stdin'))}
        ${field(gx.outFormat, '', seg('format', FORMATS, gx.formats, S.format, gx.outFormat) + err('format'), true)}
        ${S.format === 'jsonl' ? field(gx.mapping, esc(gx.mappingHelp), `<div class="map-list">${mapRows()}<button type="button" class="btn sm" data-map-add>${icon('add-line')}${esc(gx.mapAdd)}</button></div>${err('map')}`, true) : ''}
        ${S.format === 'stream-json' ? '' : field(gx.reportFrom, '', seg('report', REPORTS, gx.reports, S.report, gx.reportFrom) + err('report'))}
        ${field(gx.readOnlyArgs, esc(gx.readOnlyArgsHelp), tagsHtml('readOnly', S.readOnly, gx.readOnlyArgs, gx.readOnlyPh, false) + err('readOnly'))}
        ${field(gx.secretVar, esc(gx.secretVarHelp), input('secretVar', S.secretVar, gx.secretVar, { ph: gx.secretVarPh }) + err('secretVar'))}</div>`;

    // ---- 预览 ----
    const previewBody = () => {
        if (previewing) return `<div class="testbox">${mark('run')}<div><b>${esc(ag.testingLong)}</b></div></div>`;
        const r = preview;
        if (!r) return `<div class="testbox fail" data-pv="fail">${mark('fail')}<div><b>${esc(gx.previewFail)}</b><span>${esc(previewFailure)}</span></div></div>`;
        const raw = r.output.map(l => l.text).join('\n');
        const rows = r.output.flatMap((l, i) => l.stream !== 'stdout' ? [] : l.events.length
            ? l.events.map(e => `<div class="pv-e">${icon(KIND_ICON[e.kind] ?? 'text')}<span>${esc(eventLine(e))}</span></div>`)
            : l.text.trim() ? [`<div class="pv-e skip"><span class="mk skip">${icon('subtract-line')}</span><span>${esc(gx.unmatched(i + 1))}</span></div>`] : []);
        const reason = r.error ?? previewFailure;
        const result = r.ok
            ? `<div class="testbox ok" data-pv="ok">${mark('ok')}<div><b>${esc(gx.previewOk)}</b><span>${esc(gx.previewOkHelp(r.exit ?? 0, String(r.seconds), (r.report ?? '').split(/\r?\n/)[0].slice(0, 120)))}</span></div></div>`
            : `<div class="testbox fail" data-pv="fail">${mark('fail')}<div><b>${esc(gx.previewFail)}</b><span>${esc(reason)}</span></div></div>`;
        return `<div class="pv2"><div><div class="sec-t">${esc(gx.rawOut)}</div><pre class="out selectable" data-pv-raw>${esc(raw)}</pre></div><div><div class="sec-t">${esc(gx.mapped)}</div><div class="pv-ev" data-pv-events>${rows.join('')}</div>${result}</div></div>`;
    };
    const mark = (state: string) => `<span class="mk ${state}">${icon(({ ok: 'checkbox-circle-line', fail: 'close-circle-line', run: 'loader-4-line' } as Record<string, string>)[state])}</span>`;

    const canSave = () => validated && !errors.length && !Object.keys(build().local).length;
    const foot = () => {
        const btn = (label: string, act: string, { primary = false, disabled = false, ic = '' } = {}) => `<button class="btn ${primary ? 'primary' : ''}" data-c-act="${act}" ${disabled ? 'disabled' : ''}>${ic ? icon(ic) : ''}${esc(label)}</button>`;
        if (mode === 'preview') return btn(gx.backEdit, 'edit', { disabled: previewing || saving }) + btn(gx.retest, 'preview', { ic: 'refresh-line', disabled: previewing || saving }) + btn(ag.save, 'save', { primary: true, disabled: previewing || saving || !canSave() });
        return btn(p.previous, 'back', { disabled: saving }) + btn(gx.testPreview, 'preview', { ic: 'play-line', disabled: saving || !canSave() }) + btn(ag.save, 'save', { primary: true, disabled: saving || !canSave() });
    };
    const noteText = () => {
        if (mode === 'form' && touched) { const n = errors.length + Object.values(build().local).flat().length; if (n) return gx.invalid(n); }
        return gx.customNote(S.name.trim() || '…');
    };
    // 只更新底栏按钮的可用状态与说明，不重画正文（输入框里的焦点不丢）。
    const syncFoot = () => {
        if (!sheet.root.isConnected) return;
        const states = { back: false, preview: !canSave() || saving || previewing, save: !canSave() || saving || previewing, edit: previewing || saving };
        for (const b of sheet.root.querySelectorAll<HTMLButtonElement>('[data-c-act]')) { const a = b.dataset.cAct as keyof typeof states; if (a in states) b.disabled = states[a]; }
        const n = sheet.root.querySelector<HTMLElement>('.sheet-f .note'); if (n) n.textContent = noteText();
    };
    const setTitle = (t: string) => { sheet.root.querySelector('.sheet-h > b')!.textContent = t; sheet.root.setAttribute('aria-label', t); };

    // 错误按路径对应到字段：generic.args[2] → args；generic.output.map[1].text → map（带第几条）。
    const fieldOf = (path: string): string => {
        const rest = path.replace(/^generic\.?/, '');
        if (/^output\.map/.test(rest)) return 'map';
        if (/^output/.test(rest)) return 'format';
        const head = /^[A-Za-z]+/.exec(rest)?.[0] ?? '';
        return ({ executable: 'program', detect: 'detectArgs', args: 'args', stdin: 'stdin', report: 'report', readOnlyArgs: 'readOnly', secrets: 'secretVar', label: 'label' } as Record<string, string>)[head] ?? 'general';
    };
    const showErrors = () => {
        if (mode !== 'form') return;
        const by: Record<string, string[]> = {};
        if (touched) for (const e of errors) {
            const row = /output\.map\[(\d+)\]/.exec(e.path);
            (by[fieldOf(e.path)] ??= []).push(row ? `${Number(row[1]) + 1}：${e.message}` : e.message);
        }
        for (const [key, list] of Object.entries(build().local)) (by[key] ??= []).push(...list);
        for (const el of sheet.root.querySelectorAll<HTMLElement>('[data-err]')) {
            const list = by[el.dataset.err!] ?? [];
            el.textContent = list.join('\n'); el.classList.toggle('on', list.length > 0);
        }
        for (const inp of sheet.root.querySelectorAll<HTMLElement>('[data-c], .argbox')) {
            const key = inp.dataset.c ?? inp.closest('.fc')?.querySelector<HTMLElement>('[data-err]')?.dataset.err ?? '';
            inp.classList.toggle('bad', (by[key]?.length ?? 0) > 0);
        }
    };
    const renderProgram = () => {
        const el = sheet.root.querySelector<HTMLElement>('[data-prog-status]'); if (!el) return;
        el.innerHTML = program.state === 'checking' ? `<span class="tag">${esc(gx.programChecking)}</span>` : program.state === 'found' ? `<span class="tag ok" data-prog="found">${esc(gx.programFound(program.version))}</span>` : program.state === 'missing' ? `<span class="tag fail" data-prog="missing">${esc(gx.programMissing)}</span>` : '';
    };
    const redraw = (focus?: string) => {
        if (!sheet.root.isConnected) return;
        sheet.setBody(mode === 'form' ? formBody() : previewBody()); sheet.setFoot(foot()); renderProgram(); showErrors(); syncFoot();
        if (focus) sheet.root.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
    };

    // ---- 校验、检测 ----
    const scheduleValidate = () => {
        validated = false; syncFoot();
        clearTimeout(validateTimer);
        validateTimer = setTimeout(() => { void validateNow(); }, 250);
    };
    const validateNow = async () => {
        const seq = ++validateSeq, { decl } = build();
        try {
            const r = await window.dock.console('agents:validate-decl', { decl });
            if (seq !== validateSeq) return;
            errors = r.ok === false ? (r.errors ?? []) : []; validated = true;
        } catch (e) {
            if (seq !== validateSeq) return;
            errors = [{ path: 'general', message: String((e as Error).message || e) }]; validated = true;
        }
        showErrors(); syncFoot();
    };
    const detectNow = async () => {
        const executable = S.program.trim(), detect = S.detectArgs.trim().split(/\s+/).filter(Boolean);
        const key = `${executable}\n${detect.join(' ')}`;
        if (!executable) { program = { state: 'idle', version: '', checked: '' }; renderProgram(); return; }
        if (program.checked === key && program.state !== 'checking') return;
        const seq = ++detectSeq;
        program = { state: 'checking', version: '', checked: key }; renderProgram();
        try {
            const r = await window.dock.console('agents:detect-decl', { decl: { executable, ...(detect.length ? { detect } : {}) } });
            if (seq !== detectSeq) return;
            program = r.installed ? { state: 'found', version: r.version ?? '—', checked: key } : { state: 'missing', version: '', checked: key };
        } catch { if (seq !== detectSeq) return; program = { state: 'missing', version: '', checked: key }; }
        renderProgram();
    };

    // ---- 预览 / 保存 ----
    const runPreview = async () => {
        collectPending();
        const { decl } = build();
        mode = 'preview'; previewing = true; preview = null; previewFailure = '';
        setTitle(gx.previewTitle); redraw();
        try {
            const r = await window.dock.console('agents:test-decl', { decl }) as PreviewResult;
            if (!r.output) { previewFailure = (r.errors ?? []).map(x => x.message).join('；') || r.error || ''; preview = null; }
            else preview = r;
        } catch (e) { previewFailure = String((e as Error).message || e); preview = null; }
        previewing = false; redraw('[data-c-act="save"]:not(:disabled), [data-c-act="preview"]');
    };
    const save = async () => {
        collectPending();
        const { decl } = build();
        saving = true; syncFoot(); sheet.fail('');
        try {
            await window.dock.console('agents:add-generic', { name: S.name.trim(), decl, ...((S.label || S.name).trim() ? { label: (S.label || S.name).trim() } : {}) });
            saved = true; sheet.close(); o.onDone(S.name.trim());
        } catch (e) { saving = false; syncFoot(); sheet.fail(String((e as Error).message || e)); }
    };
    // 还留在输入框里没回车的文字：当作最后一项加进去（避免点保存时丢掉）。
    const collectPending = () => {
        for (const key of ['args', 'readOnly'] as const) {
            const el = sheet.root.querySelector<HTMLInputElement>(`[data-tag-in="${key}"]`);
            if (el?.value.trim()) { S[key].push(el.value.trim()); el.value = ''; }
        }
    };

    const sheet: Sheet = openSheet({
        title: gx.customTitle, trigger: o.trigger, body: formBody(), buttons: [c.cancel], wide: true,
        onButton: () => {},
        onClose: () => {
            if (saved || !dirty) return;
            const closeBtn = sheet.root.querySelector<HTMLElement>('.sheet-h .btn');
            return confirmAction(ag.discardTitle, ag.discardBody, ag.discard, closeBtn ?? o.trigger, true).then(ok => ok ? undefined : false);
        },
    });
    sheet.setFoot(foot()); syncFoot(); showErrors();
    void validateNow();

    const root = sheet.root;
    const redrawKeep = (focus: string) => { dirty = touched = true; redraw(focus); scheduleValidate(); };
    root.addEventListener('click', e => {
        const t = e.target as Element;
        // 点参数框里不是小方块、也不是按钮的空白处，焦点进到这个框的输入框。
        if (t.classList.contains('argbox')) { t.querySelector<HTMLInputElement>('.arginp')?.focus({ preventScroll: true }); return; }
        const b = t.closest<HTMLButtonElement>('button'); if (!b || b.disabled) return;
        const act = b.dataset.cAct;
        if (act) {
            e.stopPropagation();
            if (act === 'back') { saved = true; sheet.close(); o.onBack(); }
            else if (act === 'edit') { mode = 'form'; setTitle(gx.customTitle); redraw('[data-c="program"]'); }
            else if (act === 'preview') void runPreview();
            else if (act === 'save') void save();
            else if (act === 'browse') void (async () => {
                try {
                    const r = await window.dock.console('agents:choose-program');
                    if (r.file) { S.program = r.file; dirty = touched = true; root.querySelector<HTMLInputElement>('[data-c="program"]')!.value = r.file; scheduleValidate(); await detectNow(); }
                } catch (error) { sheet.fail(String((error as Error).message || error)); }
            })();
            return;
        }
        if (b.dataset.seg) {
            const key = b.dataset.seg, v = b.dataset.v!;
            if (key === 'format') { S.format = v as typeof S.format; S.report = v === 'text' ? 'stdout' : 'lastSay'; if (v === 'jsonl' && !S.maps.length) S.maps.push({ when: '', kind: 'say', fields: '' }); }
            else S.report = v as typeof S.report;
            redrawKeep(`[data-seg="${key}"][data-v="${v}"]`); return;
        }
        if (b.dataset.tagDel) { const key = b.dataset.tagDel as 'args' | 'readOnly'; S[key].splice(Number(b.dataset.i), 1); redrawKeep(`[data-tag-in="${key}"]`); return; }
        if (b.dataset.tagPh) { const key = b.dataset.tagPh as 'args' | 'readOnly'; S[key].push(b.dataset.v!); redrawKeep(`[data-tag-ph="${key}"][data-v="${CSS.escape(b.dataset.v!)}"]`); return; }
        if (b.hasAttribute('data-map-add')) { S.maps.push({ when: '', kind: 'say', fields: '' }); redrawKeep(`[data-m="when"][data-i="${S.maps.length - 1}"]`); return; }
        if (b.dataset.mapDel !== undefined) { S.maps.splice(Number(b.dataset.mapDel), 1); redrawKeep('[data-map-add]'); return; }
        if (b.dataset.kind !== undefined) {
            const i = Number(b.dataset.kind);
            e.stopPropagation();
            openOptionMenu(b, kindOpts, S.maps[i].kind, value => { S.maps[i].kind = value; redrawKeep(`[data-kind="${i}"]`); });
        }
    });
    root.addEventListener('input', e => {
        const t = e.target as HTMLInputElement;
        if (t.dataset.c) (S as Record<string, unknown>)[t.dataset.c] = t.value;
        else if (t.dataset.m) S.maps[Number(t.dataset.i)][t.dataset.m as 'when' | 'fields'] = t.value;
        else return;
        dirty = touched = true; scheduleValidate();
        // 映射写法、名称这类本地就能判断的错误立刻显示，不等核心校验。
        showErrors(); syncFoot();
    });
    root.addEventListener('focusout', e => {
        const t = e.target as HTMLElement;
        if (t.matches('[data-c="program"], [data-c="detectArgs"]')) void detectNow();
    });
    // 标签式输入：回车把文字加成一项；输入框为空时退格删除最后一项。
    root.addEventListener('keydown', e => {
        const t = e.target as HTMLInputElement; if (!t.matches?.('[data-tag-in]')) return;
        const key = t.dataset.tagIn as 'args' | 'readOnly';
        if (e.key === 'Enter') { e.preventDefault(); const v = t.value.trim(); if (v) { S[key].push(v); redrawKeep(`[data-tag-in="${key}"]`); } }
        else if (e.key === 'Backspace' && !t.value && S[key].length) { e.preventDefault(); S[key].pop(); redrawKeep(`[data-tag-in="${key}"]`); }
    });
    return sheet;
}
