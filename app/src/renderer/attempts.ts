import { c, gt, rt } from '../shared/copy';
import type { AgentRow, GateFile, GateResult, Task, TaskAttempt } from '../shared/types';
import { esc } from '../shared/markdown';
import { executorLabel, executorTag } from '../shared/executor';
import { field, icon, openSheet, menu } from './ui';
import type { AttemptSep } from './timeline';

// 多次尝试界面（Stage05，协议第 14 节；界面稿 app/design/preview.js 的 attTag / attBar / attSelect / attSep / retryTab / retrySheet）。
// 只按快照里的 attempt / attempt-end（任务的 attempts 列表）和 attempts/<n>/ 下的文件渲染，不改核心与协议。
export const attemptList = (t: Task): TaskAttempt[] => t.attempts ?? [];
// 至少 2 次尝试才出现切换条、下拉与"重试"标签。
export const multiAttempts = (t: Task) => attemptList(t).length >= 2;
const clock = (n: number) => new Date(n).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const okm = `<span class="mk ok">${icon('checkbox-circle-line')}</span>`;
const failm = `<span class="mk fail">${icon('close-circle-line')}</span>`;
const runm = `<span class="mk run">${icon('loader-4-line')}</span>`;
const stopm = `<span class="mk stale">${icon('stop-circle-line')}</span>`;

// 列表第二行的"尝试 n/N"：当前尝试的 total 大于 1（手动重试的 total 为 null，不显示）。
export function attemptBadge(t: Task) {
    const a = t.attempt;
    if (!a || !a.total || a.total <= 1)
        return '';
    return `<span class="att mono" title="${esc(rt.tagTip(a.n, a.total))}">${esc(rt.tag(a.n, a.total))}</span>`;
}

// 某一次尝试的执行者显示名：与任务本身同一个配置就用任务记录的名字，否则按执行者列表（name → label）查，查不到用配置名。
export type Labels = Map<string, string>;
export const attemptLabel = (t: Task, a: TaskAttempt, labels: Labels) => !a.profile || a.profile === t.profile ? executorLabel(t) : labels.get(a.profile) ?? a.profile;
// 原因文字；自动重试里换了执行者的那一次是"升级"（手动重试换执行者是用户自己选的，不算）。
export function reasonText(list: TaskAttempt[], a: TaskAttempt) {
    const prev = list[list.indexOf(a) - 1];
    const escalated = (a.reason === 'gate' || a.reason === 'agent') && !!prev && !!a.profile && !!prev.profile && a.profile !== prev.profile;
    return (rt.reason[a.reason] ?? a.reason) + (escalated ? rt.escalated : '');
}

// 进展里每次尝试开头的分隔行内容（交给 Timeline）。
export function separators(t: Task, labels: Labels): AttemptSep[] {
    const list = attemptList(t);
    return list.map(a => ({ n: a.n, at: a.at, time: clock(a.at), title: rt.sep(a.n), meta: rt.sepMeta(attemptLabel(t, a, labels), reasonText(list, a)) }));
}

// 进展顶部的尝试切换条；选中态由调用方按当前选择套上（markup 不带状态，重绘时不丢焦点）。
export function attemptBar(t: Task) {
    const items: [string, string][] = [['all', rt.all], ...attemptList(t).map((a): [string, string] => [String(a.n), rt.nth(a.n)])];
    return `<div class="att-bar"><div class="segm sm" role="group" aria-label="${esc(rt.barLabel)}">${items.map(([key, label]) => `<button data-att="${key}" aria-pressed="false">${esc(label)}</button>`).join('')}</div></div>`;
}
// 汇报、门禁顶部的尝试下拉：默认最新。
export function attemptPick(t: Task, n: number | null, labels: Labels) {
    const list = attemptList(t), a = list.find(x => x.n === n) ?? list.at(-1)!;
    return `<div class="att-pick"><span class="muted">${esc(rt.pick)}</span><button class="sel" data-att-pick aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(rt.pick)}"><span>${esc(rt.pickOption(a.n, a === list.at(-1), attemptLabel(t, a, labels)))}</span>${icon('arrow-down-s-line')}</button></div>`;
}
export function attemptPickItems(t: Task, labels: Labels, choose: (n: number) => void) {
    const list = attemptList(t);
    return list.map(a => ({ label: rt.pickOption(a.n, a === list.at(-1), attemptLabel(t, a, labels)), run: () => choose(a.n) }));
}

// ---- 重试历史（"重试"标签） ----
const tokenText = (n: number | null | undefined) => n == null ? '—' : n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
// 一次尝试的结果：ok 为 null 是进行中，false 标红；失败的门禁带那一次 gate.json 的 summary。
export function outcomeOf(t: Task, list: TaskAttempt[], a: TaskAttempt, gate: GateResult | undefined): { ok: boolean | null; result: string } {
    const last = a === list.at(-1);
    if (a.ok === undefined)
        return last && t.status === 'run' ? { ok: null, result: rt.resultRunning } : { ok: false, result: rt.resultStopped };
    if (a.gate === false) {
        const file = gate && typeof gate === 'object' && !('error' in gate) ? gate as GateFile : null;
        const summary = file?.summary ?? (last ? t.gateSummary : undefined);
        return { ok: false, result: summary ? rt.resultGateFail(summary) : gt.failTitle };
    }
    if (a.exit !== undefined && a.exit !== 0)
        return { ok: false, result: rt.resultAgent(a.exit) };
    if (a.ok === false)
        return { ok: false, result: rt.resultAgent(a.exit ?? null) };
    return { ok: true, result: a.gate === true ? rt.resultGateOk : rt.resultDone };
}
export function historyTab(t: Task, labels: Labels, gates: Map<number, GateResult>) {
    const list = attemptList(t), total = list.find(a => a.total)?.total ?? null;
    const row = (a: TaskAttempt) => {
        const label = attemptLabel(t, a, labels), out = outcomeOf(t, list, a, gates.get(a.n));
        const mark = out.ok === true ? okm : out.ok === false ? (a.ok === undefined ? stopm : failm) : runm;
        const dur = a.ms !== undefined ? `${(a.ms / 60000).toFixed(1)} ${c.minutes}` : '—';
        const tokens = a.usage && (a.usage.input != null || a.usage.output != null) ? rt.tokens(tokenText(a.usage.input), tokenText(a.usage.output)) : '—';
        return `<button class="ahist-r ${out.ok === false ? 'bad' : ''}" data-att-row="${a.n}" aria-label="${esc(rt.rowLabel(a.n, out.result))}">${mark}<span class="m"><span class="l1"><b>${esc(rt.nth(a.n))}</b><span class="xtag mono" title="${esc(label)}">${esc(executorTag(label))}</span><span class="ex">${esc(label)}</span><span class="why">${esc(`原因：${reasonText(list, a)}`)}</span></span><span class="res">${esc(out.result)}</span></span><span class="meta"><span>${esc(dur)}</span><span>${esc(tokens)}</span></span></button>`;
    };
    return `<div class="sec-t">${esc(rt.histHead(list.length, total))}<span class="sp"></span><span>${esc(rt.histHint)}</span></div><div class="ahist">${list.map(row).join('')}</div>`;
}

// ---- 重试弹窗 ----
const messageOf = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error);
// 上一次失败的原因（门禁没过用 summary，执行者异常退出写 exit）；完成的任务不显示这一块。
export function lastFailure(t: Task, summary: string) {
    if (t.status !== 'fail')
        return '';
    return summary || rt.resultAgent(t.agentExit ?? t.exit ?? null);
}
export function openRetrySheet(options: { t: Task; trigger: HTMLElement; failure: string; gate: boolean; started?: () => void }) {
    const { t, trigger } = options, done = t.status === 'done';
    const next = (attemptList(t).at(-1)?.n ?? 1) + 1;
    let worker = '', workerText = rt.workerOrig(executorLabel(t)), busy = false;
    // 执行者列表在弹窗打开时就开始读，点下拉时才需要；读不到就只剩"原执行者"一项。
    const agents: Promise<AgentRow[]> = window.dock.console('agents:list').then(result => (result?.agents ?? []) as AgentRow[]).catch(() => []);
    const last = options.failure ? `<div class="retry-last">${failm}<span><b>${esc(rt.lastFail)}</b>${esc(options.failure)}</span></div>` : '';
    const body = `<div class="form">${last}${field(rt.worker, esc(rt.workerHelp), `<button class="sel" data-retry-worker aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(rt.worker)}"><span>${esc(workerText)}</span>${icon('arrow-down-s-line')}</button>`)}${field(rt.note, esc(done ? rt.noteHelpRequired : rt.noteHelp), `<textarea class="inp area" data-retry-note rows="4" aria-label="${esc(rt.note)}" placeholder="${esc(rt.notePh)}"></textarea>`, done)}</div>`;
    const primary = `${icon('arrow-go-forward-line')}${esc(rt.start(next))}`;
    const sheet = openSheet({
        title: rt.title(t.title), trigger, body, note: esc(rt.consequence(options.gate)), buttons: [c.cancel, ''],
        // 提交中、或下拉菜单开着时 Esc 不关弹窗（菜单自己处理 Esc）。
        onClose: () => busy || !!document.querySelector('.ctx') ? false : undefined,
        onButton: (index, s) => { if (index === 0) { if (!busy) s.close(); return; } void submit(); },
    });
    const note = sheet.root.querySelector<HTMLTextAreaElement>('[data-retry-note]')!;
    const buttons = () => [...sheet.root.querySelectorAll<HTMLButtonElement>('.sheet-btns button')];
    const primaryButton = () => buttons()[1];
    primaryButton().innerHTML = primary;
    // 已完成的任务补充说明必填：没写时主按钮禁用。
    const sync = () => { primaryButton().disabled = busy || (done && !note.value.trim()); };
    sync();
    note.addEventListener('input', sync);
    const workerButton = sheet.root.querySelector<HTMLButtonElement>('[data-retry-worker]')!;
    workerButton.addEventListener('click', () => {
        void agents.then(list => {
            if (busy)
                return;
            const others = list.filter(a => a.enabled && a.supported && a.name !== t.profile);
            const items = [{ label: rt.workerOrig(executorLabel(t)), run: () => { worker = ''; workerText = rt.workerOrig(executorLabel(t)); workerButton.firstElementChild!.textContent = workerText; } },
                ...others.map(a => ({ label: a.label, run: () => { worker = a.name; workerText = a.label; workerButton.firstElementChild!.textContent = workerText; } }))];
            menu(workerButton, items, true);
        });
    });
    const failBanner = (text: string) => {
        sheet.root.querySelector('.sheet-fail')?.remove();
        if (!text)
            return;
        const banner = document.createElement('div');
        banner.className = 'banner fail sheet-fail';
        banner.setAttribute('role', 'alert');
        banner.innerHTML = `<span class="mk fail">${icon('close-circle-line')}</span><div class="rt"><b>${esc(rt.failed)}</b><span>${esc(text)}</span></div>`;
        sheet.root.querySelector('.sheet-b')!.prepend(banner);
    };
    async function submit() {
        if (busy || primaryButton().disabled)
            return;
        busy = true;
        failBanner('');
        for (const b of buttons())
            b.disabled = true;
        primaryButton().innerHTML = `${runm}${esc(rt.starting)}`;
        try {
            const text = note.value;
            await window.dock.console('tasks:retry', { project: t.repo, name: t.name, ...(worker ? { profile: worker } : {}), ...(text.trim() ? { note: text } : {}) });
            busy = false;
            sheet.close();
            options.started?.();
        }
        catch (error) {
            busy = false;
            failBanner(messageOf(error));
            for (const b of buttons())
                b.disabled = false;
            primaryButton().innerHTML = primary;
            sync();
        }
    }
    note.focus({ preventScroll: true });
    return sheet;
}
