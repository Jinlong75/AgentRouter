import type { Event as TaskEvent, Page } from '../shared/types';
import { c } from '../shared/copy';
import { esc, markdown } from '../shared/markdown';
import { icon } from './ui';
export function combine(events: TaskEvent[]): TaskEvent[] {
    const rows: TaskEvent[] = [], commands = new Map<string, TaskEvent>();
    for (const e of [...events].sort((a, b) => a.offset - b.offset)) {
        if (e.kind !== 'cmd') {
            rows.push(e);
            continue;
        }
        const key = e.id ?? `legacy:${e.command}`, old = commands.get(key) ?? (!e.id && e.phase === 'end' ? [...rows].reverse().find(r => r.kind === 'cmd' && r.command === e.command && r.phase !== 'end') : undefined);
        if (old) {
            const offset = old.offset, at = old.at;
            Object.assign(old, e, { offset, at });
        }
        else {
            const row = { ...e };
            rows.push(row);
            commands.set(key, row);
        }
    }
    return rows;
}
export function fileChip(f: {
    kind: string;
    path: string;
}) { return `<button class="fchip ${esc(f.kind)}" data-file="${esc(f.path)}">${icon(f.kind === 'add' ? 'add-line' : f.kind === 'delete' ? 'delete-bin-line' : 'edit-line')}${esc(f.path)}</button>`; }
// 多次尝试（Stage05，界面稿 attSep）：每次尝试开头的分隔行内容；time / title / meta 由调用方按文案生成。
export interface AttemptSep {
    n: number;
    at: number;
    time: string;
    title: string;
    meta: string;
}
export class Timeline {
    events: TaskEvent[] = [];
    cursor?: Page['cursor'];
    think = false;
    follow = true;
    // 时间线末尾的附加行（Stage04：门禁开始的分隔行）；为空时不占位置。
    footer = '';
    // 尝试列表（至少 2 次才分组）与当前查看的尝试：'all' 按尝试分组并在每次开头插分隔行；某一次只显示那一次的事件。
    attempts: AttemptSep[] = [];
    attemptFilter: 'all' | number = 'all';
    private heights = new Map<number, number>();
    private open = new Set<number>();
    private fresh = new Set<number>();
    private signature = '';
    private renderedRows = new WeakMap<HTMLElement, string>();
    private topSpacer = document.createElement('div');
    private bottomSpacer = document.createElement('div');
    private footerEl = document.createElement('div');
    constructor(private host: HTMLElement, private viewport: HTMLElement) {
        host.onclick = e => { const b = (e.target as Element).closest<HTMLElement>('[data-cmd]'); if (!b)
            return; const key = +b.dataset.cmd!; this.open.has(key) ? this.open.delete(key) : this.open.add(key); this.signature = ''; this.render(); };
    }
    merge(page: Page, before = false) { if (!page.reset && !page.events.length) {
        this.cursor = page.cursor;
        return;
    } if (page.reset) {
        this.events = [];
        this.heights.clear();
        this.fresh.clear();
    } const old = new Map(this.events.map(e => [e.offset, e])); for (const e of page.events) {
        if (!old.has(e.offset) && this.cursor && !before && !page.reset)
            this.fresh.add(e.offset);
        old.set(e.offset, e);
    } this.events = [...old.values()].sort((a, b) => a.offset - b.offset); this.cursor = page.cursor; this.signature = ''; }
    // 事件属于哪一次尝试：事件自带 attempt 字段就用它；否则取开始时刻不晚于事件时刻的最后一次尝试（最早一次兜底）。
    private owner(e: TaskEvent) {
        if (e.attempt !== undefined && this.attempts.some(a => a.n === e.attempt))
            return e.attempt;
        let n = this.attempts[0].n;
        for (const a of this.attempts)
            if (e.at >= a.at)
                n = a.n;
        return n;
    }
    // 按尝试分组：分隔行用负的 offset（-n）当键，与真实事件的 offset 不冲突；选了某一次只留那一次，第 1 次不画分隔行。
    private arrange(rows: TaskEvent[]) {
        if (this.attempts.length < 2)
            return rows;
        const out: TaskEvent[] = [];
        for (const a of this.attempts) {
            if (this.attemptFilter !== 'all' && this.attemptFilter !== a.n)
                continue;
            if (this.attemptFilter === 'all' || a.n > 1)
                out.push({ v: 1, seq: -a.n, at: a.at, offset: -a.n, kind: 'text' });
            out.push(...rows.filter(e => this.owner(e) === a.n));
        }
        return out;
    }
    private separator(n: number) {
        const a = this.attempts.find(x => x.n === n)!;
        return `<div class="tl k-att"><span class="t mono">${esc(a.time)}</span><div class="c"><b>${esc(a.title)}</b><span>${esc(a.meta)}</span></div></div>`;
    }
    render() {
        const rows = this.arrange(combine(this.events).filter(e => e.kind !== 'plan' && (this.think || e.kind !== 'think')));
        for (const el of this.host.querySelectorAll<HTMLElement>('[data-event]'))
            this.heights.set(+el.dataset.event!, el.getBoundingClientRect().height);
        const sizes = rows.map(e => this.heights.get(e.offset) ?? 44);
        const top = Math.max(0, this.viewport.scrollTop - this.host.offsetTop + this.viewport.offsetTop);
        let index = 0, total = 0;
        while (index < sizes.length && total + sizes[index] < top)
            total += sizes[index++];
        let start = rows.length > 500 ? Math.max(0, index - 60) : 0, end = rows.length > 500 ? Math.min(rows.length, index + Math.ceil(this.viewport.clientHeight / 32) + 60) : rows.length;
        if (this.follow && rows.length > 500) {
            end = rows.length;
            start = Math.max(0, end - 150);
        }
        const signature = `${start}:${end}:${this.think}:${rows.length}:${this.footer}:${this.attemptFilter}:${this.attempts.map(a => `${a.n}/${a.at}/${a.title}/${a.meta}`).join('|')}`;
        if (signature === this.signature)
            return;
        this.signature = signature;
        const anchor = [...this.host.querySelectorAll<HTMLElement>('[data-event]')].find(el => el.getBoundingClientRect().bottom >= this.viewport.getBoundingClientRect().top), anchorId = anchor?.dataset.event, anchorY = anchor?.getBoundingClientRect().top;
        const existing = new Map([...this.host.querySelectorAll<HTMLElement>('[data-event]')].map(el => [+el.dataset.event!, el]));
        const nodes: HTMLElement[] = [this.topSpacer];
        this.topSpacer.style.height = `${sizes.slice(0, start).reduce((a, b) => a + b, 0)}px`;
        for (const e of rows.slice(start, end)) {
            const row = existing.get(e.offset) ?? document.createElement('div'), html = e.offset < 0 ? this.separator(-e.offset) : eventRow(e, this.open.has(e.offset), false);
            row.dataset.event = String(e.offset);
            if (this.renderedRows.get(row) !== html) {
                row.innerHTML = html;
                this.renderedRows.set(row, html);
            }
            if (this.fresh.delete(e.offset)) {
                const content = row.firstElementChild!;
                content.classList.add('new');
                content.addEventListener('animationend', () => content.classList.remove('new'), { once: true });
            }
            nodes.push(row);
        }
        this.bottomSpacer.style.height = `${sizes.slice(end).reduce((a, b) => a + b, 0)}px`;
        nodes.push(this.bottomSpacer);
        if (this.footer) {
            if (this.footerEl.innerHTML !== this.footer)
                this.footerEl.innerHTML = this.footer;
            nodes.push(this.footerEl);
        }
        // 已有行保留节点身份；追加进展不能打断输出选择或键盘焦点。
        const keep = new Set(nodes);
        for (const child of [...this.host.children])
            if (!keep.has(child as HTMLElement))
                child.remove();
        for (let i = 0; i < nodes.length; i++)
            if (this.host.children[i] !== nodes[i])
                this.host.insertBefore(nodes[i], this.host.children[i] ?? null);
        if (this.follow)
            this.viewport.scrollTop = this.viewport.scrollHeight;
        else if (anchorId && anchorY !== undefined) {
            const next = this.host.querySelector<HTMLElement>(`[data-event="${anchorId}"]`);
            if (next)
                this.viewport.scrollTop += next.getBoundingClientRect().top - anchorY;
        }
    }
    invalidate() { this.signature = ''; }
}
function eventRow(e: TaskEvent, open: boolean, fresh: boolean) {
    const time = e.time ?? (e.at ? new Date(e.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—');
    let cls = e.kind === 'error' ? 'err' : e.kind, content = '', glyph = 'text';
    if (e.kind === 'cmd') {
        glyph = e.exit ? 'close-circle-line' : 'terminal-box-line';
        if (e.exit)
            cls += ' bad';
        content = `<button class="cmd" data-cmd="${e.offset}" aria-expanded="${open}">${e.output ? icon('arrow-right-s-line') : ''}<code>${esc(e.command)}</code>${e.phase === 'start' ? `<span class="x">${c.runningCmd}</span>` : e.exit ? `<span class="x">exit=${e.exit}</span>` : ''}</button>${open && e.output ? `<pre class="out scroll selectable">${esc(e.output)}</pre>` : ''}`;
    }
    else if (e.kind === 'file') {
        glyph = 'file-edit-line';
        content = `<div class="files">${e.files?.map(fileChip).join('') ?? ''}</div>`;
    }
    else if (e.kind === 'turn') {
        const compact = (n: number | null | undefined) => n == null ? '—' : n >= 1000000 ? `${+(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}K` : String(n);
        content = esc(e.text ?? `${c.turn} · ${c.input} ${compact(e.usage?.input)} · ${c.output} ${compact(e.usage?.output)}`);
        glyph = 'time-line';
    }
    else {
        glyph = ({ say: 'chat-3-line', think: 'lightbulb-line', error: 'close-circle-line', tool: 'tools-line', text: 'text', plan: 'list-check-2' } as Record<string, string>)[e.kind];
        content = e.kind === 'say' ? `<div class="say"><div class="md">${markdown(e.text ?? '')}</div></div>` : esc(e.text ?? [e.name, e.detail].filter(Boolean).join(' · '));
    }
    return `<div class="tl k-${cls}${fresh ? ' new' : ''}"><span class="t mono">${time}</span>${e.kind === 'turn' ? '' : icon(glyph)}<div class="c">${content}</div></div>`;
}
