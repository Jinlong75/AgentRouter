import { c } from '../shared/copy';
import { esc } from '../shared/markdown';
export const icon = (name: string) => `<i class="ri ri-${name}" aria-hidden="true"></i>`;
// 交互追踪：只有验收把 <html data-ar-trace="1"> 打开时才记录（平时不记、不占内存），用于定位"点了菜单却没有动作"断在哪一步。
export function trace(event: string, detail: Record<string, unknown> = {}) {
    if (document.documentElement.dataset.arTrace !== '1') return;
    const w = window as unknown as { __arTrace?: unknown[] };
    (w.__arTrace ??= []).push({ at: Date.now(), event, ...detail });
}
export function menu(anchor: HTMLElement, items: {
    label: string;
    disabled?: boolean;
    separator?: boolean;
    run: () => void;
}[], select = false) {
    document.querySelector('.ctx')?.remove();
    const panel = document.createElement('div');
    panel.className = 'ctx scroll';
    panel.setAttribute('role', select ? 'listbox' : 'menu');
    panel.innerHTML = items.map((i, n) => `${i.separator ? '<hr>' : ''}<button role="${select ? 'option' : 'menuitem'}" data-option="${n}" ${i.disabled ? 'disabled' : ''}>${esc(i.label)}</button>`).join('');
    document.body.append(panel);
    trace('menu-open', { items: items.length });
    panel.addEventListener('pointerdown', e => trace('menu-pointerdown', { target: (e.target as Element).closest('button')?.textContent ?? (e.target as Element).tagName }), true);
    const r = anchor.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, r.left))}px`;
    panel.style.top = `${Math.min(innerHeight - panel.offsetHeight - 8, r.bottom + 4)}px`;
    anchor.setAttribute('aria-expanded', 'true');
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const close = () => { trace('menu-close'); panel.remove(); anchor.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); anchor.focus({ preventScroll: true }); };
    const outside = (e: PointerEvent) => { if (!panel.contains(e.target as Node) && e.target !== anchor) {
        trace('menu-outside', { target: (e.target as Element)?.tagName + '.' + ((e.target as Element)?.className ?? '') });
        close();
    } };
    document.addEventListener('pointerdown', outside, true);
    panel.onclick = e => { const b = (e.target as Element).closest<HTMLButtonElement>('button'); trace('menu-click', { label: b?.textContent ?? null, disabled: !!b?.disabled }); if (b && !b.disabled) {
        close();
        trace('menu-run', { label: items[+b.dataset.option!].label });
        items[+b.dataset.option!].run();
    } };
    panel.onkeydown = e => { if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        close();
    } if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement), n = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[n]?.focus();
    } };
    requestAnimationFrame(() => panel.classList.add('motion-open'));
    buttons[0]?.focus();
}
export function confirmStop(name: string, executor: string, trigger: HTMLElement): Promise<boolean> {
    return confirmAction(c.stopTitle(name), c.stopBody(executor), c.stop, trigger, true);
}
export function confirmAction(title: string, body: string, label: string, trigger: HTMLElement, danger = false): Promise<boolean> {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `<section class="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body"><h2 id="confirm-title">${esc(title)}</h2><p id="confirm-body">${esc(body)}</p><div class="confirm-actions"><button class="btn">${c.cancel}</button><button class="btn ${danger ? 'danger' : 'primary'}">${esc(label)}</button></div></section>`;
        const background = [...document.body.children].filter((e): e is HTMLElement => e instanceof HTMLElement).map(e => ({ e, inert: e.inert }));
        background.forEach(({ e }) => e.inert = true);
        document.body.append(overlay);
        const buttons = [...overlay.querySelectorAll<HTMLButtonElement>('button')];
        const close = (ok: boolean) => { background.forEach(({ e, inert }) => e.inert = inert); overlay.remove(); trigger.focus({ preventScroll: true }); resolve(ok); };
        buttons[0].onclick = () => close(false);
        buttons[1].onclick = () => close(true);
        overlay.onkeydown = e => { if (e.key === 'Escape') {
            e.preventDefault();
            close(false);
        } if (e.key === 'Tab') {
            e.preventDefault();
            buttons[document.activeElement === buttons[0] ? 1 : 0].focus();
        } };
        requestAnimationFrame(() => overlay.classList.add('motion-open'));
        buttons[0].focus();
    });
}
// 表单行：左边标签与说明，右边控件；必填项标签后有 *。help 是内部生成的 HTML，不转义。
export const field = (label: string, help: string, ctl: string, req = false) =>
    `<div class="fld"><label class="fl"><b>${esc(label)}${req ? '<em>*</em>' : ''}</b>${help ? `<span>${help}</span>` : ''}</label><div class="fc">${ctl}</div></div>`;

// 模态框控制对象：openSheet 返回它，调用方用来替换正文/底栏、设忙碌、显示失败横幅、关闭。
export interface Sheet {
    root: HTMLElement;
    setBody(html: string | Element): void;
    setFoot(html: string): void;
    busy(on: boolean): void;
    fail(text: string): void;
    close(): void;
}
// 通用模态框：标题 56px + 可滚动正文 + 底栏（左侧说明 + 按钮从次到主）。
// 打开时背景 inert、焦点进入第一个可操作控件；Tab 只在框内循环；Esc 关闭（onClose 可先确认）；
// 关闭后焦点回到触发它的按钮。按钮点击默认关闭；给了 onButton 则由它决定（自己调 sheet.close()）。
export function openSheet(options: {
    title: string;
    trigger: HTMLElement;
    body?: string | Element;
    steps?: string;
    note?: string;
    buttons: string[];
    wide?: boolean;
    onButton?: (index: number, sheet: Sheet) => void | boolean | Promise<void | boolean>;
    onClose?: () => boolean | void | Promise<boolean | void>;
}): Sheet {
    const overlay = document.createElement('div');
    overlay.className = 'ov';
    overlay.innerHTML = `<section class="sheet ${options.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(options.title)}"><div class="sheet-h"><b>${esc(options.title)}</b>${options.steps ?? ''}<button class="btn icon quiet" aria-label="关闭" title="关闭">${icon('close-line')}</button></div><div class="sheet-b scroll"></div><div class="sheet-f"><span class="note">${options.note ?? ''}</span><span class="sheet-btns">${options.buttons.map((label, i) => `<button class="btn ${i === options.buttons.length - 1 ? 'primary' : ''}" data-sheet-btn="${i}">${esc(label)}</button>`).join('')}</span></div></section>`;
    const root = overlay.querySelector<HTMLElement>('.sheet')!;
    const bodyEl = overlay.querySelector<HTMLElement>('.sheet-b')!;
    const btnsEl = overlay.querySelector<HTMLElement>('.sheet-btns')!;
    const closeBtn = overlay.querySelector<HTMLButtonElement>('.sheet-h .btn')!;
    const nodes = (content: string | Element) => typeof content === 'string' ? (() => { const t = document.createElement('div'); t.innerHTML = content; return [...t.childNodes]; })() : [content];
    bodyEl.replaceChildren(...nodes(options.body ?? ''));
    const background = [...document.body.children].filter((e): e is HTMLElement => e instanceof HTMLElement).map(e => ({ e, inert: e.inert }));
    background.forEach(({ e }) => e.inert = true);
    document.body.append(overlay);
    const focusables = () => [...root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => !(el as HTMLButtonElement).disabled && !el.closest('[inert],[hidden]') && el.getClientRects().length > 0);
    const primaryLabel = btnsEl.querySelector<HTMLButtonElement>('button:last-of-type')?.innerHTML ?? '';
    let closed = false;
    // 触发按钮可能在模态框打开期间随页面重建被替换：按它的 data-* 属性找到新的同一个按钮再放回焦点。
    const triggerNow = () => { if (options.trigger.isConnected) return options.trigger; const attrs = [...options.trigger.attributes].filter(a => a.name.startsWith('data-')); return attrs.length ? document.querySelector<HTMLElement>(attrs.map(a => `[${a.name}="${CSS.escape(a.value)}"]`).join('')) : null; };
    const close = () => { if (closed) return; closed = true; document.removeEventListener('keydown', onKey, true); background.forEach(({ e, inert }) => e.inert = inert); overlay.remove(); triggerNow()?.focus({ preventScroll: true }); };
    const tryClose = async () => { if (closed) return; if (await options.onClose?.() === false) return; close(); };
    const sheet: Sheet = {
        root,
        setBody(html) { bodyEl.replaceChildren(...nodes(html)); },
        setFoot(html) { btnsEl.innerHTML = html; bind(); },
        busy(on) { for (const b of btnsEl.querySelectorAll<HTMLButtonElement>('button')) b.disabled = on; const p = btnsEl.querySelector<HTMLButtonElement>('button:last-of-type'); if (p) p.innerHTML = on ? `<span class="mk run">${icon('loader-4-line')}</span>${primaryLabel}` : primaryLabel; if (!on && !root.contains(document.activeElement)) p?.focus({ preventScroll: true }); },
        fail(text) { bodyEl.querySelector('.sheet-fail')?.remove(); if (!text) return; const b = document.createElement('div'); b.className = 'banner fail sheet-fail'; b.setAttribute('role', 'alert'); b.innerHTML = `<span class="mk fail">${icon('close-circle-line')}</span><span>${esc(text)}</span>`; bodyEl.prepend(b); },
        close,
    };
    const bind = () => { [...btnsEl.querySelectorAll<HTMLButtonElement>('button')].forEach((btn, i) => { btn.onclick = () => { if (btn.disabled) return; if (options.onButton) void Promise.resolve(options.onButton(i, sheet)).catch(() => {}); else void tryClose(); }; }); };
    bind();
    closeBtn.onclick = () => void tryClose();
    // 在 document 上监听：按钮忙碌被禁用时焦点会落到 body，Esc / Tab 也要照常作用于模态框（上面还有确认框时让给确认框）。
    const onKey = (e: KeyboardEvent) => {
        if (closed || document.querySelector('.confirm-overlay')) return;
        if (e.key === 'Escape') { e.preventDefault(); void tryClose(); }
        else if (e.key === 'Tab') { e.preventDefault(); const list = focusables(); if (list.length) list[(list.indexOf(document.activeElement as HTMLElement) + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => overlay.classList.add('motion-open'));
    focusables()[0]?.focus({ preventScroll: true });
    return sheet;
}
export function tooltips() {
    let timer: ReturnType<typeof setTimeout> | undefined, tip: HTMLElement | undefined;
    const hide = () => { clearTimeout(timer); tip?.remove(); tip = undefined; };
    const over = (e: Event) => { const target = (e.target as Element).closest<HTMLElement>('[data-tip]'); if (!target)
        return; hide(); timer = setTimeout(() => { if (!target.isConnected)
        return; tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role', 'tooltip'); tip.textContent = target.dataset.tip!; document.body.append(tip); const r = target.getBoundingClientRect(); tip.style.left = `${Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left))}px`; tip.style.top = `${Math.min(innerHeight - tip.offsetHeight - 8, r.bottom + 6)}px`; }, 500); };
    document.addEventListener('mouseover', over);
    document.addEventListener('focusin', over);
    for (const event of ['mouseout', 'focusout', 'pointerdown', 'scroll'])
        document.addEventListener(event, hide, true);
}
export function notice(error: unknown) { document.querySelector('.notice')?.remove(); const box = document.createElement('div'); box.className = 'notice'; box.setAttribute('role', 'alert'); box.textContent = (error instanceof Error ? [c.changed, c.reportMissing, c.fileMissing].find(known => error.message.includes(known)) : undefined) ?? c.error; document.body.append(box); setTimeout(() => box.remove(), 5000); }
// 017：操作成功提示，沿用右下角 .notice 的位置与样式（不是错误，role 用 status）。
export function toast(text: string) { document.querySelector('.notice')?.remove(); const box = document.createElement('div'); box.className = 'notice'; box.setAttribute('role', 'status'); box.textContent = text; document.body.append(box); setTimeout(() => box.remove(), 5000); }
