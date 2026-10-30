import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 244：流水线横向拖动与重画前后的横向位置。用 esbuild 打包真正的共享控制器 app/src/renderer/track-scroll.ts，
// 配一个只实现控制器用到的那几个 DOM 接口（事件冒泡、pointer capture、scrollLeft 夹紧）的最小替身；
// 不复制生产算法，也不匹配源码字符串。
const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-track-scroll-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败留给系统临时目录。 */ } });
const outfile = path.join(dir, 'track-scroll.mjs');
await build({
  entryPoints: [fileURLToPath(new URL('../../app/src/renderer/track-scroll.ts', import.meta.url))],
  outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
});

const { bindTrackDrag, captureTrack, restoreTrack } = await import(pathToFileURL(outfile).href);

// 共享控制器只看 document.activeElement（有 document 时）；这里给一个最小替身，用来验重画后的节点焦点。
const fakeDoc = { activeElement: null };
globalThis.document = fakeDoc;

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.parent = null;
    this.children = [];
    this.classes = new Set();
    this.dataset = {};
    this.listeners = new Map();
    this.capture = null;
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this._scrollLeft = 0;
    this.textContent = '';
  }
  focus() { fakeDoc.activeElement = this; }
  get classList() { return { add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name) }; }
  get scrollLeft() { return this._scrollLeft; }
  set scrollLeft(value) { const max = Math.max(0, this.scrollWidth - this.clientWidth); this._scrollLeft = Math.min(Math.max(0, value), max); }
  append(child) { child.parent = this; this.children.push(child); return child; }
  contains(node) { for (let at = node; at; at = at.parent) if (at === this) return true; return false; }
  closest(selector) {
    for (let at = this; at; at = at.parent) {
      if (selector.startsWith('.')) { if (at.classes.has(selector.slice(1))) return at; }
      else if (at.tagName === selector.toUpperCase()) return at;
    }
    return null;
  }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture(id) { if (this.capture === id) this.capture = null; }
  addEventListener(type, fn, capture = false) { const list = this.listeners.get(type) ?? []; list.push({ fn, capture: capture === true }); this.listeners.set(type, list); }
  removeEventListener(type, fn, capture = false) { const list = this.listeners.get(type) ?? []; this.listeners.set(type, list.filter(item => !(item.fn === fn && item.capture === (capture === true)))); }
  querySelectorAll(selector) {
    const all = [];
    const walk = node => { for (const child of node.children) { all.push(child); walk(child); } };
    walk(this);
    return all.filter(node => selector.startsWith('.') ? node.classes.has(selector.slice(1)) : node.tagName === selector.toUpperCase());
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  dispatch(type, event) {
    event.type = type;
    if (!event.target) event.target = this;
    const route = [];
    for (let at = this; at; at = at.parent) route.push(at);
    for (const at of [...route].reverse()) for (const item of at.listeners.get(type) ?? []) { if (event.stopped) break; if (item.capture) item.fn.call(at, event); }
    for (const at of route) for (const item of at.listeners.get(type) ?? []) { if (event.stopped) break; if (!item.capture) item.fn.call(at, event); }
    return event;
  }
}
// 控制器用 `active instanceof HTMLElement` 判断焦点在不在轨道里；替身必须挂到全局。
globalThis.HTMLElement = FakeNode;

function world(scrollWidth = 600, clientWidth = 300) {
  const scope = new FakeNode('div');
  const holder = new FakeNode('div');
  holder.classes.add('track-holder');
  const track = new FakeNode('div');
  track.classes.add('track');
  scope.append(holder);
  holder.append(track);
  track.scrollWidth = scrollWidth;
  track.clientWidth = clientWidth;
  const node = new FakeNode('button');
  node.classes.add('node');
  track.append(node);
  const unbind = bindTrackDrag(scope);
  return { scope, holder, track, node, unbind };
}
function pipeline(labels, tabs) {
  const scope = new FakeNode('div');
  const holder = new FakeNode('div');
  holder.classes.add('track-holder');
  const track = new FakeNode('div');
  track.classes.add('track');
  scope.append(holder);
  holder.append(track);
  track.scrollWidth = 600;
  track.clientWidth = 300;
  const nodes = labels.map((label, index) => {
    const node = new FakeNode('button');
    node.classes.add('node');
    node.dataset.tab = tabs[index];
    node.textContent = label;
    track.append(node);
    return node;
  });
  return { scope, holder, track, nodes, unbind: bindTrackDrag(scope) };
}
const pointer = (target, type, x, extra = {}) => {
  const event = { target, pointerId: 1, button: 0, clientX: x, clientY: 20, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
  target.dispatch(type, event);
  return event;
};
const mouseClick = target => {
  const event = { target, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  target.dispatch('click', event);
  return event;
};

test('溢出时按住拖动改 scrollLeft；拖动中加 dragging，松开后去掉', () => {
  const w = world();
  pointer(w.node, 'pointerdown', 200);
  pointer(w.node, 'pointermove', 130);
  assert.equal(w.track.scrollLeft, 70, '鼠标向左 70px，内容跟着向左滚 70px');
  assert.ok(w.track.classList.contains('dragging'), '拖动中轨道有 dragging');
  pointer(w.node, 'pointerup', 130);
  assert.ok(!w.track.classList.contains('dragging'), '松开后去掉 dragging');
});

test('拖动不超过阈值不算拖动：scrollLeft 与 dragging 都不变', () => {
  const w = world();
  pointer(w.node, 'pointerdown', 200);
  pointer(w.node, 'pointermove', 195);
  assert.equal(w.track.scrollLeft, 0);
  assert.ok(!w.track.classList.contains('dragging'));
  pointer(w.node, 'pointermove', 194);
  assert.equal(w.track.scrollLeft, 6, '超过阈值后从起点算位移');
  assert.ok(w.track.classList.contains('dragging'));
});

test('拖动结束没有产生click：下一次完整轻点不被旧抑制标记吞掉', () => {
  const w = world();
  pointer(w.node, 'pointerdown', 200);
  pointer(w.node, 'pointermove', 130);
  pointer(w.node, 'pointerup', 130);
  // 上次手势没有click；新的pointerdown标志这是一次独立的普通轻点。
  pointer(w.node, 'pointerdown', 130);
  pointer(w.node, 'pointerup', 130);
  assert.equal(mouseClick(w.node).defaultPrevented, false, '新手势的真实轻点应按原行为生效');
  w.unbind();
});

test('轻点仍是原点击，不抑制；拖动后的第一次点击被抑制，下一次点击恢复', () => {
  const w = world();
  let clicks = 0;
  const fresh = new FakeNode('button');
  fresh.classes.add('node');
  w.track.append(fresh);
  fresh.addEventListener('click', () => { clicks++; });
  pointer(fresh, 'pointerdown', 150);
  pointer(fresh, 'pointerup', 150);
  const tap = mouseClick(fresh);
  assert.equal(tap.defaultPrevented, false, '轻点不拦点击');
  assert.equal(clicks, 1, '轻点照常触发原点击');

  pointer(w.node, 'pointerdown', 200);
  pointer(w.node, 'pointermove', 120);
  pointer(w.node, 'pointerup', 120);
  const swallowed = mouseClick(fresh);
  assert.equal(swallowed.defaultPrevented, true, '拖动后落在轨道里的点击被抑制');
  assert.equal(clicks, 1, '拖动不误触发节点');
  const again = mouseClick(fresh);
  assert.equal(again.defaultPrevented, false, '下一次普通点击不再被抑制');
  assert.equal(clicks, 2);
});

test('pointercancel 与 lostpointercapture 都结束拖动，随后的普通点击仍有效', () => {
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    const w = world();
    let clicks = 0;
    w.node.addEventListener('click', () => { clicks++; });
    pointer(w.node, 'pointerdown', 200);
    pointer(w.node, 'pointermove', 120);
    assert.ok(w.track.classList.contains('dragging'));
    pointer(w.node, ending, 120);
    assert.ok(!w.track.classList.contains('dragging'), `${ending} 后去掉 dragging`);
    const click = mouseClick(w.node);
    assert.equal(click.defaultPrevented, false, `${ending} 之后不抑制点击`);
    assert.equal(clicks, 1);
  }
});

test('没有横向溢出时不进入拖动，scrollLeft 不变', () => {
  const w = world(300, 300);
  pointer(w.node, 'pointerdown', 200);
  pointer(w.node, 'pointermove', 100);
  assert.equal(w.track.scrollLeft, 0);
  assert.ok(!w.track.classList.contains('dragging'));
});

test('同一宿主同一任务的局部重画保留横向位置，范围缩短时夹紧在最大值', () => {
  const w = world();
  restoreTrack(w.scope, 'tasks', 'tasks:t1');
  w.track.scrollLeft = 120;
  captureTrack(w.scope, 'tasks');

  const holder = new FakeNode('div');
  holder.classes.add('track-holder');
  const track = new FakeNode('div');
  track.classes.add('track');
  holder.append(track);
  w.holder.parent = null;
  w.scope.children = [holder];
  holder.parent = w.scope;
  track.scrollWidth = 600;
  track.clientWidth = 300;
  restoreTrack(w.scope, 'tasks', 'tasks:t1');
  assert.equal(track.scrollLeft, 120, '同任务重画后回到原来的横向位置');

  track.scrollLeft = 180;
  captureTrack(w.scope, 'tasks');
  const narrow = new FakeNode('div');
  narrow.classes.add('track-holder');
  const shorter = new FakeNode('div');
  shorter.classes.add('track');
  narrow.append(shorter);
  holder.parent = null;
  w.scope.children = [narrow];
  narrow.parent = w.scope;
  shorter.scrollWidth = 400;
  shorter.clientWidth = 300;
  restoreTrack(w.scope, 'tasks', 'tasks:t1');
  assert.equal(shorter.scrollLeft, 100, '范围缩短时夹紧到最后能滚到的位置');
});

test('换任务从起点开始；任务详情与验收页两个宿主互不影响', () => {
  const w = world();
  restoreTrack(w.scope, 'tasks', 'tasks:t1');
  w.track.scrollLeft = 90;
  captureTrack(w.scope, 'tasks');

  const other = world();
  restoreTrack(other.scope, 'accept', 'accept:t9');
  assert.equal(other.track.scrollLeft, 0, '验收页没有横向位置的历史，从起点开始');
  other.track.scrollLeft = 40;
  captureTrack(other.scope, 'accept');

  restoreTrack(w.scope, 'tasks', 'tasks:t1');
  assert.equal(w.track.scrollLeft, 90, '任务详情的横向位置没有被验收页覆盖');
  restoreTrack(other.scope, 'accept', 'accept:t9');
  assert.equal(other.track.scrollLeft, 40, '验收页的横向位置也没有被任务详情覆盖');

  restoreTrack(w.scope, 'tasks', 'tasks:t2');
  assert.equal(w.track.scrollLeft, 0, '换任务从起点开始');
});

test('解绑后不再处理拖动事件', () => {
  const w = world();
  w.unbind();
  pointer(w.node, 'pointerdown', 200);
  pointer(w.node, 'pointermove', 100);
  assert.equal(w.track.scrollLeft, 0);
  assert.ok(!w.track.classList.contains('dragging'));
});

// 真实流水线：执行 / 待验收 / 合并三个节点共用 data-tab=flow，只能靠"步骤名 + 同名序号"认出焦点节点。
const LABELS = ['派发', '执行', '门禁', '审查', '待验收', '合并'];
const TABS = ['params', 'flow', 'gate', 'review', 'flow', 'flow'];

test('同一任务重画：保留横向位置，并把键盘焦点放回原节点（共用 data-tab 也能认对）', () => {
  const first = pipeline(LABELS, TABS);
  restoreTrack(first.scope, 'tasks', 'tasks:t1');
  first.track.scrollLeft = 90;
  first.nodes[4].focus();
  captureTrack(first.scope, 'tasks');
  assert.equal(first.nodes[4].dataset.trackNode, '待验收#1', '焦点节点写上了稳定身份');
  assert.equal(first.nodes[1].dataset.trackNode, '执行#1', '同名序号按节点区分，不只看 data-tab');

  const fresh = pipeline(LABELS, TABS);
  fakeDoc.activeElement = null;
  restoreTrack(fresh.scope, 'tasks', 'tasks:t1');
  assert.equal(fresh.track.scrollLeft, 90, '同任务重画后横向位置不变');
  assert.equal(fakeDoc.activeElement, fresh.nodes[4], '焦点回到待验收节点');
  assert.notEqual(fakeDoc.activeElement, fresh.nodes[1], '不会因为共用 data-tab=flow 落到前面的节点');
});

test('换任务：横向位置回到起点，也不把焦点抢到任何节点', () => {
  const first = pipeline(LABELS, TABS);
  restoreTrack(first.scope, 'tasks', 'tasks:t1');
  first.track.scrollLeft = 90;
  first.nodes[4].focus();
  captureTrack(first.scope, 'tasks');

  const fresh = pipeline(LABELS, TABS);
  fakeDoc.activeElement = null;
  restoreTrack(fresh.scope, 'tasks', 'tasks:t2');
  assert.equal(fresh.track.scrollLeft, 0, '换任务从起点开始');
  assert.equal(fakeDoc.activeElement, null, '换任务不抢焦点');
});
