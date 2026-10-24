// 任务页与项目页共用的搜索框、命中高亮、排序菜单和标题栏拼装。
import { s6 } from '../shared/copy';
import { esc } from '../shared/markdown';
import { icon } from './ui';

// 命中处用 <mark> 包住：先按原文切片，每一片单独转义再拼，用户输入不会当成 HTML。
export function hit(text: string, query: string): string {
    if (!query) return esc(text);
    const lower = text.toLowerCase(), needle = query.toLowerCase();
    // 个别字符转小写会改变长度，这时偏移对不上，不高亮。
    if (lower.length !== text.length) return esc(text);
    let html = '', at = 0;
    for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
        html += esc(text.slice(at, i)) + `<mark class="hit">${esc(text.slice(i, i + needle.length))}</mark>`;
        at = i + needle.length;
    }
    return html + esc(text.slice(at));
}
// 不区分大小写的包含；没有关键字时全部匹配。
export const matches = (query: string, ...fields: (string | null | undefined)[]) => !query || fields.some(f => !!f && f.toLowerCase().includes(query.toLowerCase()));

// 搜索框：放在标题栏里，元素只建一次、重建标题栏时原样放回（输入法组词与光标位置都不被打断）。
export class SearchField {
    readonly el: HTMLLabelElement;
    private input: HTMLInputElement;
    private clear: HTMLButtonElement;
    constructor(placeholder: string, private changed: (query: string) => void) {
        this.el = document.createElement('label');
        this.el.className = 'search';
        this.el.innerHTML = `${icon('search-line')}<input type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" autocomplete="off" spellcheck="false"><button type="button" class="btn icon quiet sm" data-search-clear aria-label="${esc(s6.clearSearch)}" title="${esc(s6.clearSearch)}" hidden>${icon('close-line')}</button>`;
        this.input = this.el.querySelector('input')!;
        this.clear = this.el.querySelector('button')!;
        this.input.addEventListener('input', () => this.sync());
        // Esc 先清空搜索框；框里没有内容时不拦截，让页面上其他 Esc 行为照常。
        this.input.addEventListener('keydown', e => {
            if (e.key !== 'Escape' || !this.input.value) return;
            e.preventDefault();
            e.stopPropagation();
            this.set('');
        });
        this.clear.addEventListener('click', e => { e.stopPropagation(); this.set(''); this.input.focus({ preventScroll: true }); });
    }
    // 去掉首尾空白后的关键字。
    get query() { return this.input.value.trim(); }
    set(value: string) { this.input.value = value; this.sync(); }
    focus() { this.input.focus({ preventScroll: true }); }
    private last = '';
    private sync() {
        this.el.classList.toggle('has', this.input.value !== '');
        this.clear.hidden = this.input.value === '';
        // 关键字没变（只是首尾空白变了）不重画列表。
        if (this.query === this.last) return;
        this.last = this.query;
        this.changed(this.query);
    }
}

// 标题栏三段：左（标题与筛选）、搜索框（保留原元素）、右（其余控件）。左右两段每次整段重写，搜索框不动。
// 给了 tools 时（任务页）搜索框与 tools（项目下拉、排序）放进同一个 .ph-tools：窗口够宽时和其余控件排成一行，窄了单独占第二行。
export function paintHeader(header: HTMLElement, field: SearchField, left: string, right: string, tools?: string) {
    let l = header.querySelector<HTMLElement>(':scope > .ph-l'), r = header.querySelector<HTMLElement>(':scope > .ph-r');
    let t = header.querySelector<HTMLElement>(':scope > .ph-tools > .ph-t');
    const host = tools === undefined ? header : t?.parentElement;
    if (!l || !r || field.el.parentElement !== host || (tools !== undefined) !== !!t) {
        l = document.createElement('span'); l.className = 'ph-l';
        r = document.createElement('span'); r.className = 'ph-r';
        if (tools === undefined) {
            t = null;
            header.replaceChildren(l, field.el, r);
        }
        else {
            const box = document.createElement('div'); box.className = 'ph-tools';
            t = document.createElement('span'); t.className = 'ph-t';
            box.replaceChildren(field.el, t);
            header.replaceChildren(l, box, r);
        }
    }
    if (l.innerHTML !== left) l.innerHTML = left;
    if (r.innerHTML !== right) r.innerHTML = right;
    if (t && t.innerHTML !== tools) t.innerHTML = tools ?? '';
}

// 排序按钮：图标 + 当前排序名 + 下拉箭头；最窄窗口只留图标（样式控制），title 写完整说明。
export const sortButton = (attr: string, label: string) =>
    `<button class="sel sm sort" ${attr} aria-haspopup="menu" aria-expanded="false" title="${esc(s6.sortTip(label))}" aria-label="${esc(s6.sortTip(label))}">${icon('sort-desc')}<span>${esc(label)}</span>${icon('arrow-down-s-line')}</button>`;

// 排序菜单：role="menu"，菜单项是 menuitemradio；方向键 / Home / End 移动，回车选中，Esc 与 Tab 关闭。
// 菜单挂在 body 上，标题栏重画时不会被带走；关闭后焦点回到按钮（用选择器重新找，按钮可能已经被重画）。
let openMenu: (() => void) | undefined;
// 菜单开着时再点排序按钮就是收起：调用方先试 closeSortMenu()，返回 true 表示刚关掉了一个。
export function closeSortMenu() {
    const close = openMenu;
    close?.();
    return !!close;
}
export function openSortMenu(anchor: HTMLElement, anchorSelector: string, entries: [key: string, label: string, hint: string][], current: string, pick: (key: string) => void, alignLeft = false) {
    closeSortMenu();
    const panel = document.createElement('div');
    panel.className = 'menu sort-pop';
    panel.setAttribute('role', 'menu');
    panel.innerHTML = entries.map(([key, label, hint]) => `<button type="button" role="menuitemradio" aria-checked="${key === current}" data-sort-key="${esc(key)}">${key === current ? icon('check-line') : '<span class="ri-sp"></span>'}<span>${esc(label)}</span>${hint ? `<em>${esc(hint)}</em>` : ''}</button>`).join('');
    document.body.append(panel);
    const r = anchor.getBoundingClientRect();
    // 默认从按钮右边对齐向左展开；alignLeft（任务页标题栏分两行时，排序在第二行靠左）从按钮左边对齐向右展开。
    panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, alignLeft ? r.left : r.right - panel.offsetWidth))}px`;
    panel.style.top = `${r.bottom + 4}px`;
    anchor.setAttribute('aria-expanded', 'true');
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button')];
    const outside = (e: PointerEvent) => { if (!panel.contains(e.target as Node) && !(e.target as Element).closest(anchorSelector)) close(false); };
    function close(refocus = false) {
        document.removeEventListener('pointerdown', outside, true);
        panel.remove();
        if (openMenu === close) openMenu = undefined;
        const button = document.querySelector<HTMLElement>(anchorSelector);
        button?.setAttribute('aria-expanded', 'false');
        if (refocus) button?.focus({ preventScroll: true });
    }
    document.addEventListener('pointerdown', outside, true);
    openMenu = close;
    panel.onclick = e => {
        const b = (e.target as Element).closest<HTMLButtonElement>('button');
        if (!b) return;
        close(true);
        pick(b.dataset.sortKey!);
    };
    panel.onkeydown = e => {
        if (e.key === 'Escape' || e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            close(true);
        }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
    };
    requestAnimationFrame(() => panel.classList.add('motion-open'));
    (buttons.find(b => b.getAttribute('aria-checked') === 'true') ?? buttons[0])?.focus();
}

// "N 个任务包含…" / "没有任务包含…" 一行（列表顶部），右边是"清除"。
export const foundRow = (text: string, attr: string) => `<div class="found" data-found><span>${esc(text)}</span><button class="btn sm quiet" ${attr}>${esc(s6.clear)}</button></div>`;
