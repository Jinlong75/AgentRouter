// 244：流水线横向拖动 + 重画前后的横向位置（任务详情与验收页共用）。
// 拖动走原生 pointer 事件与 .track 自己的 overflow-x 滚动；键盘 Tab、触控与普通滚轮仍由浏览器处理。
// 重画前后只记"宿主 + 任务"的横向位置：同任务保留（范围变短时由浏览器夹紧），换任务从起点开始。
// 同一任务重画后还把键盘焦点放回原来的节点：节点身份按"步骤名 + 第几个同名节点"派生，不能用共用的 data-tab 定位。
const THRESHOLD = 6;
interface Saved { key: string; left: number; focus: string | null }
interface DragState { track: HTMLElement; pointerId: number; startX: number; startLeft: number; moved: boolean }
const saved = new Map<string, Saved>();
const nodeLabel = (node: Element) => ((node.children[1]?.textContent ?? node.textContent ?? '').trim() || '节点');
// 给轨道里的节点写上稳定的身份（步骤名 + 同名序号）；重画前后用它找回原来的节点。
function labelNodes(track: HTMLElement): HTMLElement[] {
    const seen = new Map<string, number>(), nodes = Array.from(track.querySelectorAll<HTMLElement>('.node'));
    for (const node of nodes) {
        const label = nodeLabel(node), n = (seen.get(label) ?? 0) + 1;
        seen.set(label, n);
        node.dataset.trackNode = `${label}#${n}`;
    }
    return nodes;
}
const focusedTag = (track: HTMLElement) => {
    if (typeof document === 'undefined') return null;
    const active = document.activeElement;
    return active instanceof HTMLElement && track.contains(active) && active.dataset.trackNode ? active.dataset.trackNode : null;
};

export function bindTrackDrag(scope: HTMLElement): () => void {
    let drag: DragState | null = null;
    // 刚拖动过的那条轨道：紧接着的一次点击是拖动的余波，不当作点节点；只吞一次。
    let suppress: HTMLElement | null = null;
    const down = (e: PointerEvent) => {
        // 新指针手势不属于上一次拖动的click；上次若没有click，也不能吞掉这次普通轻点。
        suppress = null;
        if (e.button !== 0) return;
        const track = (e.target as Element | null)?.closest('.track') as HTMLElement | null;
        if (!track || !scope.contains(track) || track.scrollWidth <= track.clientWidth) return;
        drag = { track, pointerId: e.pointerId, startX: e.clientX, startLeft: track.scrollLeft, moved: false };
    };
    const move = (e: PointerEvent) => {
        const current = drag;
        if (!current || e.pointerId !== current.pointerId) return;
        const dx = e.clientX - current.startX;
        if (!current.moved && Math.abs(dx) < THRESHOLD) return;
        if (!current.moved) {
            current.moved = true;
            current.track.classList.add('dragging');
            try { current.track.setPointerCapture(current.pointerId); } catch { /* 指针已不在时忽略 */ }
        }
        current.track.scrollLeft = current.startLeft - dx;
        e.preventDefault();
    };
    const finish = (pointerId: number, suppressClick: boolean) => {
        const current = drag;
        if (!current || current.pointerId !== pointerId) return;
        current.track.classList.remove('dragging');
        if (suppressClick) suppress = current.track;
        drag = null;
        if (current.track.hasPointerCapture(pointerId)) {
            try { current.track.releasePointerCapture(pointerId); } catch { /* 已释放时忽略 */ }
        }
    };
    const up = (e: PointerEvent) => finish(e.pointerId, drag?.moved === true);
    const cancel = (e: PointerEvent) => finish(e.pointerId, false);
    const lost = (e: PointerEvent) => finish(e.pointerId, false);
    const click = (e: MouseEvent) => {
        const track = suppress;
        if (!track) return;
        suppress = null;
        if (!track.contains(e.target as Node)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
    };
    scope.addEventListener('pointerdown', down);
    scope.addEventListener('pointermove', move);
    scope.addEventListener('pointerup', up);
    scope.addEventListener('pointercancel', cancel);
    scope.addEventListener('lostpointercapture', lost);
    scope.addEventListener('click', click, true);
    return () => {
        scope.removeEventListener('pointerdown', down);
        scope.removeEventListener('pointermove', move);
        scope.removeEventListener('pointerup', up);
        scope.removeEventListener('pointercancel', cancel);
        scope.removeEventListener('lostpointercapture', lost);
        scope.removeEventListener('click', click, true);
        drag = null;
        suppress = null;
    };
}

export function captureTrack(scope: ParentNode | undefined, host: string): void {
    const holder = scope?.querySelector<HTMLElement>('.track-holder');
    if (!holder) return;
    const track = holder.querySelector<HTMLElement>('.track');
    const key = holder.dataset.trackKey;
    if (!track || !key) return;
    labelNodes(track);
    saved.set(host, { key, left: track.scrollLeft, focus: focusedTag(track) });
}

export function restoreTrack(scope: ParentNode | undefined, host: string, key: string): void {
    const holder = scope?.querySelector<HTMLElement>('.track-holder');
    if (!holder) return;
    holder.dataset.trackKey = key;
    const track = holder.querySelector<HTMLElement>('.track');
    const prev = saved.get(host);
    const same = !!prev && prev.key === key;
    const left = same ? prev.left : 0;
    if (track) {
        const nodes = labelNodes(track);
        track.scrollLeft = left;
        // 读回来的是浏览器夹紧后的值，下一次重画从这里继续。
        saved.set(host, { key, left: track.scrollLeft, focus: same ? prev.focus : null });
        // 同一任务重画：把键盘焦点放回原节点（不滚动，保持刚恢复的横向位置）；换任务不抢焦点。
        if (same && prev.focus) nodes.find(node => node.dataset.trackNode === prev.focus)?.focus({ preventScroll: true });
    }
    else saved.set(host, { key, left: 0, focus: null });
}
