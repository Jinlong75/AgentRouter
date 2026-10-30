import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 222：审查说明刷新时按"渲染时的说明基线"判断草稿。
// 用 esbuild 打包真正的 app/src/renderer/review.ts，再配一个只模拟 ReviewView 用到的那几个 DOM 接口的最小替身：
// 不复制、不重写 capture/restore，只让它的 querySelector / dataset / value / focus 真的被调用。
const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-review-drafts-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败留给系统临时目录。 */ } });
const outfile = path.join(dir, 'review.mjs');
await build({
  entryPoints: [fileURLToPath(new URL('../../app/src/renderer/review.ts', import.meta.url))],
  outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent',
});

// ---- 最小 DOM 替身 ----
const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, s => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[s]));
const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const ATTR = /([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g;
const toKey = name => { const m = /^data-(.+)$/.exec(name); return m ? m[1].replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()) : null; };

const matchesSelector = (el, selector) => {
  if (/^[a-zA-Z][\w-]*$/.test(selector)) return el.tagName === selector.toUpperCase();
  const m = /^([a-zA-Z][\w-]*)?((?:\[data-[\w-]+(?:="(?:[^"\\]|\\.)*")?\])+)$/.exec(selector);
  if (!m) throw new Error(`最小 DOM 不支持的查询：${selector}`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const part of m[2].matchAll(/\[data-([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]/g)) {
    const key = toKey(`data-${part[1]}`);
    if (!(key in el.dataset)) return false;
    if (part[2] !== undefined && el.dataset[key] !== part[2].replace(/\\(.)/g, '$1')) return false;
  }
  return true;
};
// 事件沿 parent 链冒泡（attach 的监听都挂在容器上）。
const fireEvent = (target, type, event) => {
  const route = [];
  for (let at = target; at; at = at.parent) route.push(at);
  for (const at of [...route].reverse()) for (const fn of at.listeners?.get(type) ?? []) { if (event.stopped) return; fn(event); }
  for (const at of route) for (const fn of at.listeners?.get(type) ?? []) { if (event.stopped) return; fn(event); }
};

class FakeElement {
  constructor(tagName) { this.tagName = tagName.toUpperCase(); this.dataset = {}; this.attributes = new Map(); this.disabled = false; this.selectionStart = null; this.selectionEnd = null; this.parent = null; this.listeners = new Map(); }
  addEventListener(type, fn) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { const list = this.listeners.get(type); if (list) this.listeners.set(type, list.filter(item => item !== fn)); }
  focus() { doc.activeElement = this; }
  blur() { if (doc.activeElement !== this) return; doc.activeElement = doc.body; fireEvent(this, 'focusout', { target: this }); }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  closest(selector) { for (let at = this; at; at = at.parent) if (matchesSelector(at, selector)) return at; return null; }
  get isConnected() { return this.parent !== null; }
}
class FakeInputElement extends FakeElement {
  constructor() { super('input'); this.value = ''; }
}
class FakeContainer {
  constructor() { this.tagName = 'CONTAINER'; this.dataset = {}; this.html = ''; this.elements = []; this.parent = null; this.listeners = new Map(); }
  addEventListener(type, fn) { const list = this.listeners.get(type) ?? []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { const list = this.listeners.get(type); if (list) this.listeners.set(type, list.filter(item => item !== fn)); }
  get innerHTML() { return this.html; }
  set innerHTML(text) {
    if (this.elements.includes(doc.activeElement)) doc.activeElement = doc.body;
    for (const el of this.elements) el.parent = null;
    this.html = text;
    this.elements = [];
    for (const tag of text.matchAll(TAG)) {
      const name = tag[1].toLowerCase(), attrs = tag[2];
      // 失败提示是 div；其它 div/span 不参与本文件的断言。
      const fail = name === 'div' && attrs.includes('data-rv-fail');
      if (name !== 'input' && name !== 'button' && !fail) continue;
      const el = name === 'input' ? new FakeInputElement() : new FakeElement(name);
      for (const attr of attrs.matchAll(ATTR)) {
        const value = decode(attr[2]);
        el.attributes.set(attr[1], value);
        const key = toKey(attr[1]);
        if (key) el.dataset[key] = value;
      }
      el.disabled = el.attributes.has('disabled');
      el.parent = this;
      if (name === 'input') {
        el.value = el.attributes.get('value') ?? '';
        el.selectionStart = el.selectionEnd = el.value.length;
      }
      if (fail) el.textContent = decode((text.slice(tag.index + tag[0].length).split('</div>')[0] ?? '').replace(/<[^>]*>/g, '').trim());
      this.elements.push(el);
    }
  }
  contains(el) { return this.elements.includes(el); }
  querySelectorAll(selector) { return this.elements.filter(el => matchesSelector(el, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  matches(el, selector) { return matchesSelector(el, selector); }
}

const doc = { activeElement: null, body: new FakeElement('body'), container: null, querySelector: selector => doc.container?.querySelector(selector) ?? null };
doc.activeElement = doc.body;
globalThis.document = doc;
globalThis.HTMLElement = FakeElement;
globalThis.HTMLInputElement = FakeInputElement;
globalThis.CSS = { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`) };

// 假的 console IPC：review:show / agents:list 按用例设置，调用本身同步记录；可注入失败或挂起的确认。
const ipc = { responses: new Map(), calls: [], errors: new Set(), gates: new Map() };
const defer = action => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  ipc.gates.set(action, { promise, resolve, reject });
  return { promise, resolve, reject };
};
globalThis.window = { dock: { console: (action, payload) => {
  ipc.calls.push({ action, payload });
  const gate = ipc.gates.get(action);
  if (gate) { ipc.gates.delete(action); return gate.promise; }
  if (ipc.errors.has(action)) return Promise.reject(new Error('核心拒绝：审查结果暂时不可用'));
  return Promise.resolve(ipc.responses.get(action));
} } };
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)); };
// 真实 keydown（沿 parent 链冒泡到 attach 在容器上的监听）。
const pressKey = (target, key, extra = {}) => {
  const event = { target, key, isComposing: false, keyCode: 0, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
  fireEvent(target, 'keydown', event);
  return event;
};

const { ReviewView } = await import(pathToFileURL(outfile).href);

// ---- 数据与场景 ----
const issue = (id, note, extra = {}) => ({ id, severity: 'medium', title: `问题 ${id}`, detail: '细节', ...(note === undefined ? {} : { confirmation: { result: 'valid', by: 'lead', note, at: 1 } }), ...extra });
const reviewFile = issues => ({ at: 1, verdict: 'concerns', reviewer: 'rev1', crossed: true, summary: '', reviewed: [], ms: 1000, issues });
const task = (id, issues) => ({ id, name: id, repo: 'C:/repo', title: `任务 ${id}`, status: 'done', review: { at: 1, verdict: 'concerns', issues: issues.length, confirmedAt: 0, needsHuman: false } });
const noteInput = (body, id) => {
  const el = body.querySelector(`input[data-rv-note="${id}"]`);
  assert.ok(el, `应渲染出 ${id} 的说明输入框`);
  return el;
};
const type = (body, id, text) => { const el = noteInput(body, id); el.value = text; el.focus(); el.setSelectionRange(text.length, text.length); return el; };

async function world(tasks) {
  const body = new FakeContainer();
  doc.container = body;
  ipc.errors.clear();
  ipc.gates.clear();
  const host = { tasks: () => tasks, changed: () => { }, jump: () => { } };
  const view = new ReviewView(host);
  ipc.responses.set('agents:list', { agents: [] });
  return { body, host, view };
}
async function load(s, t, review) {
  ipc.responses.set('review:show', { review });
  await s.view.ensure(t);
}
// 远端数据变了：清单里的 review 事件时间变了，ensure 读完通知宿主重画。
async function remote(s, t, review, repaint) {
  s.host.changed = () => repaint();
  ipc.responses.set('review:show', { review });
  t.review = { ...t.review, at: t.review.at + 1 };
  await s.view.ensure(t);
  await Promise.resolve();
}
// 两种真实宿主顺序（app/src/renderer/index.ts 681-683 与 accept.ts 367/374）。
const orderIndex = s => { const focus = s.view.capture(s.body); s.body.innerHTML = s.view.html(s.task); s.view.restore(s.body, focus); };
const orderAccept = s => { const content = s.view.html(s.task); const focus = s.view.capture(s.body); s.body.innerHTML = content; s.view.restore(s.body, focus); };

test('未编辑旧空说明：远端变为"主导标的"后，capture→html 与连续刷新都显示新说明，草稿不遮挡', async () => {
  const t = task('T1', [issue('R1-1')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1')]));
  s.body.innerHTML = s.view.html(t);
  assert.equal(noteInput(s.body, 'R1-1').value, '');

  await remote(s, t, reviewFile([issue('R1-1', '主导标的')]), () => orderIndex(s));
  assert.equal(noteInput(s.body, 'R1-1').value, '主导标的', 'capture→html 顺序：远端写入的说明不能被空草稿盖掉');

  orderIndex(s);
  assert.equal(noteInput(s.body, 'R1-1').value, '主导标的', '连续刷新后仍显示远端说明');
});

test('html→capture→DOM 替换顺序（验收页）与再交错一次完整重画都不闪回旧值', async () => {
  const t = task('T1', [issue('R1-1')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1')]));
  s.body.innerHTML = s.view.html(t);

  await remote(s, t, reviewFile([issue('R1-1', '主导标的')]), () => orderAccept(s));
  assert.equal(noteInput(s.body, 'R1-1').value, '主导标的', '验收页顺序：远端说明应显示');
  orderAccept(s);
  assert.equal(noteInput(s.body, 'R1-1').value, '主导标的', '再交错一次完整重画：不能闪回旧的空说明');
  orderIndex(s);
  assert.equal(noteInput(s.body, 'R1-1').value, '主导标的', '交错到 capture→html 顺序的完整重画：远端说明仍在，不闪回旧值');
});

test('本地另一问题已输入 abc 且光标在 3：远端更新不同问题时，本地内容、focus/selection 与远端新值都保留', async () => {
  const t = task('T1', [issue('R1-1'), issue('R1-2')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1'), issue('R1-2')]));
  s.body.innerHTML = s.view.html(t);
  const local = type(s.body, 'R1-2', 'abc');

  await remote(s, t, reviewFile([issue('R1-1', '主导标的'), issue('R1-2')]), () => orderIndex(s));
  const kept = noteInput(s.body, 'R1-2'), fresh = noteInput(s.body, 'R1-1');
  assert.equal(kept.value, 'abc', '本地已输入的内容要保留');
  assert.equal(doc.activeElement, kept, '焦点仍在本地的说明框');
  assert.equal(kept.selectionStart, 3);
  assert.equal(kept.selectionEnd, 3);
  assert.equal(fresh.value, '主导标的', '远端新说明不能被本地草稿盖住');
  assert.notEqual(doc.activeElement, local, '重画后焦点应落在新的说明框上');

  // R2-1：真正中间的非空选择区（abc 选中 [1,2]），重画后焦点、选择区与内容都要保留。
  kept.setSelectionRange(1, 2);
  await remote(s, t, reviewFile([issue('R1-1', '主导标的二'), issue('R1-2')]), () => orderIndex(s));
  const selected = noteInput(s.body, 'R1-2');
  assert.notEqual(selected, kept, '选择区场景：重画后说明框已换新');
  assert.equal(selected.value, 'abc', '选择区场景：本地内容仍保留');
  assert.equal(doc.activeElement, selected, '选择区场景：焦点仍在本地的说明框');
  assert.equal(selected.selectionStart, 1, '选择区场景：选择区起点 1 保留');
  assert.equal(selected.selectionEnd, 2, '选择区场景：选择区终点 2 保留');
  assert.equal(noteInput(s.body, 'R1-1').value, '主导标的二', '选择区场景：远端新说明同时显示');
});

test('用户主动清空旧非空说明：空串是有效草稿，远端刷新不覆盖；空串与无草稿不混同', async () => {
  const t = task('T1', [issue('R1-1', '旧说明'), issue('R1-2')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', '旧说明'), issue('R1-2')]));
  s.body.innerHTML = s.view.html(t);
  assert.equal(noteInput(s.body, 'R1-1').value, '旧说明');
  const cleared = type(s.body, 'R1-1', '');

  await remote(s, t, reviewFile([issue('R1-1', '旧说明'), issue('R1-2', '新增说明')]), () => orderIndex(s));
  assert.equal(noteInput(s.body, 'R1-1').value, '', '用户清空后的空串要作为草稿保留');
  assert.equal(doc.activeElement, noteInput(s.body, 'R1-1'), '清空后焦点仍在这个说明框');
  assert.equal(noteInput(s.body, 'R1-2').value, '新增说明', '没有草稿的问题显示远端说明，不被空串混淆');
  orderIndex(s);
  assert.equal(noteInput(s.body, 'R1-1').value, '', '再次刷新仍保留清空草稿');
  assert.equal(noteInput(s.body, 'R1-2').value, '新增说明');
  assert.equal(cleared.selectionStart, 0);
  const redrawn = noteInput(s.body, 'R1-1');
  assert.notEqual(redrawn, cleared, '两次重画后说明框已换新：不能只检查脱离 DOM 的旧元素');
  assert.equal(redrawn.selectionStart, 0, '重画后的新说明框光标也在开头');
  assert.equal(redrawn.selectionEnd, 0);
});

test('同名问题的草稿按 task 隔离；说明基线里的引号、&、尖括号、中文正确转义且不破坏结构', async () => {
  const special = `a"b&c<d>e中文'f`;
  const t1 = task('T1', [issue('R1-1', special)]), t2 = task('T2', [issue('R1-1', '任务二说明')]);
  const s = await world([t1, t2]);
  await load(s, t1, reviewFile([issue('R1-1', special)]));
  s.body.innerHTML = s.view.html(t1);
  const input = noteInput(s.body, 'R1-1');
  assert.equal(input.value, special, '带引号与尖括号的说明要原样放进输入框');
  assert.equal(input.dataset.rvBase, special, 'data-rv-base 要是当次渲染的原始说明（转义后写进属性）');
  // R2-3：固定现有 esc 输出契约（不是断言安全漏洞）：原始 HTML 里属性值按 &<>"' 转义。
  const rawBase = 'data-rv-base="a&quot;b&amp;c&lt;d&gt;e中文&#39;f"';
  assert.ok(s.body.innerHTML.includes(rawBase), `原始 HTML 里 data-rv-base 应按现状转义：${rawBase}`);
  assert.equal(s.body.querySelectorAll('input[data-rv-note]').length, 1, '转义不能多出输入框');
  assert.equal(s.body.querySelectorAll('button').length, 2, '转义不能破坏卡片结构');

  type(s.body, 'R1-1', '甲');
  s.view.capture(s.body);
  await load(s, t2, reviewFile([issue('R1-1', '任务二说明')]));
  s.body.innerHTML = s.view.html(t2);
  assert.equal(noteInput(s.body, 'R1-1').value, '任务二说明', '任务一的草稿不能串到任务二');

  await remote(s, t2, reviewFile([issue('R1-1', '任务二新说明')]), () => { s.task = t2; orderIndex(s); });
  assert.equal(noteInput(s.body, 'R1-1').value, '任务二新说明', '任务二没有草稿，显示远端新说明');

  s.body.innerHTML = s.view.html(t1);
  assert.equal(noteInput(s.body, 'R1-1').value, '甲', '任务一的草稿按 task 保留');
});

test('确认提交成功后连续重画：已提交的说明不成为陈旧草稿，焦点/光标保留，后续远端新说明能显示', async () => {
  const t = task('T1', [issue('R1-1', '旧说明')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', '旧说明')]));
  s.body.innerHTML = s.view.html(t);
  const typed = type(s.body, 'R1-1', '已提交说明');

  // 假核心：确认成功返回 human 写入的结果，之后 review:show 读到的是更新过的 review。
  // R2-2：从本次确认前清空调用记录，只断言这次真实 review:confirm 的完整载荷。
  ipc.calls.length = 0;
  ipc.responses.set('review:confirm', { by: 'human', note: '已提交说明' });
  ipc.responses.set('review:show', { review: reviewFile([issue('R1-1', '已提交说明')]) });
  s.host.changed = () => orderIndex(s);
  await s.view.confirm(t, 'R1-1', 'valid', '已提交说明');

  const confirms = ipc.calls.filter(entry => entry.action === 'review:confirm');
  assert.deepEqual(confirms, [{ action: 'review:confirm', payload: { project: 'C:/repo', name: 'T1', issue: 'R1-1', result: 'valid', note: '已提交说明' } }], '这次确认的 IPC 载荷完整（project/name/issue/result/note）且只发一次');

  const committed = noteInput(s.body, 'R1-1');
  assert.equal(committed.value, '已提交说明', '确认成功后显示已提交的说明');
  assert.notEqual(committed, typed, '确认触发的重画换成了新的输入框');
  assert.equal(doc.activeElement, committed, '焦点仍在说明框');
  assert.equal(committed.selectionStart, 5, '光标在已提交说明末尾');
  assert.equal(committed.selectionEnd, 5);

  orderIndex(s);
  orderIndex(s);
  assert.equal(noteInput(s.body, 'R1-1').value, '已提交说明', '连续重画后仍是已提交的说明');
  assert.equal(doc.activeElement, noteInput(s.body, 'R1-1'));

  await remote(s, t, reviewFile([issue('R1-1', '远端新说明')]), () => orderIndex(s));
  assert.equal(noteInput(s.body, 'R1-1').value, '远端新说明', '已提交内容不能变成陈旧草稿挡住远端新说明');
});

// ---- 244：回车结束编辑（真实 keydown / attach 路径） ----

for (const [hostName, repaint] of [['任务详情', orderIndex], ['验收页', orderAccept]]) {
  test(`Enter 提交在途：${hostName}首次重画与回应后均显示提交值，不闪回旧说明`, async () => {
    const t = task('T1', [issue('R1-1', '旧说明')]);
    const s = await world([t]);
    s.task = t;
    await load(s, t, reviewFile([issue('R1-1', '旧说明')]));
    s.view.attach(s.body);
    s.body.innerHTML = s.view.html(t);
    const input = type(s.body, 'R1-1', '新说明');
    const gate = defer('review:confirm');
    s.host.changed = () => repaint(s);
    try {
      pressKey(input, 'Enter');
      assert.equal(noteInput(s.body, 'R1-1').value, '新说明', 'IPC仍在途，第一次重画也必须保留用户刚提交的内容');
      assert.notEqual(doc.activeElement?.dataset?.rvNote, 'R1-1', '提交时已结束编辑');
    } finally {
      gate.resolve({ by: 'human', note: '新说明' });
      await flush();
    }
    assert.equal(noteInput(s.body, 'R1-1').value, '新说明', '回应后仍显示同一提交内容');
    assert.notEqual(doc.activeElement?.dataset?.rvNote, 'R1-1', '回应后不偷回焦点');
  });
}

for (const queuedB of [false, true]) {
  test(`验收页排队回改原值：${queuedB ? '覆盖旧B' : '直接回改'}，后一次IPC在途也不闪回A`, async () => {
    const t = task('T1', [issue('R1-1', '原值')]);
    const s = await world([t]);
    s.task = t;
    await load(s, t, reviewFile([issue('R1-1', '原值')]));
    s.view.attach(s.body);
    s.body.innerHTML = s.view.html(t);
    s.host.changed = () => orderAccept(s);
    ipc.calls.length = 0;
    const gateA = defer('review:confirm');
    pressKey(type(s.body, 'R1-1', 'A'), 'Enter');
    if (queuedB) pressKey(type(s.body, 'R1-1', 'B'), 'Enter');
    pressKey(type(s.body, 'R1-1', '原值'), 'Enter');
    const gateO = defer('review:confirm');
    try {
      gateA.resolve({ by: 'human', note: 'A' });
      await flush();
      assert.deepEqual(ipc.calls.filter(entry => entry.action === 'review:confirm').map(entry => entry.payload.note), ['A', '原值']);
      assert.equal(noteInput(s.body, 'R1-1').value, '原值', '第二次提交在途时仍显示最新保存意图，不闪回已完成的A');
      assert.notEqual(doc.activeElement?.dataset?.rvNote, 'R1-1');
    } finally {
      gateO.resolve({ by: 'human', note: '原值' });
      await flush();
    }
    assert.equal(noteInput(s.body, 'R1-1').value, '原值');
  });
}

test('未确认说明按Enter后：验收页首次重画仍保留草稿，不制造确认', async () => {
  const t = task('T1', [issue('R1-1')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1')]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  const input = type(s.body, 'R1-1', '未确认草稿');
  ipc.calls.length = 0;
  pressKey(input, 'Enter');
  orderAccept(s);
  assert.equal(noteInput(s.body, 'R1-1').value, '未确认草稿');
  assert.equal(ipc.calls.filter(entry => entry.action === 'review:confirm').length, 0);
  assert.notEqual(doc.activeElement?.dataset?.rvNote, 'R1-1');
});

test('Enter 结束说明编辑：非 IME 时只写一次、焦点离开，重画不把焦点带回', async () => {
  const t = task('T1', [issue('R1-1', '旧说明')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', '旧说明')]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  const input = type(s.body, 'R1-1', '新说明');
  ipc.calls.length = 0;
  ipc.responses.set('review:confirm', { by: 'human', note: '新说明' });
  s.host.changed = () => orderIndex(s);
  const event = pressKey(input, 'Enter');
  await flush();
  assert.equal(event.defaultPrevented, true, 'Enter 不插入换行');
  assert.deepEqual(ipc.calls.filter(entry => entry.action === 'review:confirm'), [{ action: 'review:confirm', payload: { project: 'C:/repo', name: 'T1', issue: 'R1-1', result: 'valid', note: '新说明' } }], '只发一次完整载荷（不因 blur / focusout 重复）');
  assert.notEqual(doc.activeElement, input, 'Enter 后焦点离开说明框');
  assert.notEqual(doc.activeElement?.dataset?.rvNote, 'R1-1', '后续重画没有把焦点带回说明框');
  assert.equal(noteInput(s.body, 'R1-1').value, '新说明', '确认内容完整写入');
});

test('相同说明回车不写；未确认的问题回车只结束编辑、不自动制造成立/不成立', async () => {
  const t = task('T1', [issue('R1-1', '同值'), issue('R1-2')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', '同值'), issue('R1-2')]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  ipc.calls.length = 0;
  const same = type(s.body, 'R1-1', '同值');
  assert.equal(pressKey(same, 'Enter').defaultPrevented, true);
  await flush();
  assert.equal(ipc.calls.filter(entry => entry.action === 'review:confirm').length, 0, '相同值无多余写入');
  assert.notEqual(doc.activeElement, same, '相同值也结束编辑');

  const draft = type(s.body, 'R1-2', '未确认草稿');
  assert.equal(pressKey(draft, 'Enter').defaultPrevented, true);
  await flush();
  assert.equal(ipc.calls.filter(entry => entry.action === 'review:confirm').length, 0, '未确认的问题不自动写');
  assert.notEqual(doc.activeElement, draft, '未确认的问题回车也结束编辑');
  assert.equal(s.body.querySelector('[data-rv-conf]'), null, '没有自动制造确认');
});

test('输入法组合态的 Enter 不提交、不夺焦点（isComposing 与 keyCode 229）', async () => {
  const t = task('T1', [issue('R1-1', '旧说明')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', '旧说明')]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  ipc.calls.length = 0;
  const input = type(s.body, 'R1-1', '组合中的字');
  assert.equal(pressKey(input, 'Enter', { isComposing: true }).defaultPrevented, false);
  assert.equal(pressKey(input, 'Enter', { keyCode: 229 }).defaultPrevented, false);
  await flush();
  assert.equal(doc.activeElement, input, '组合态 Enter 不夺焦点');
  assert.equal(ipc.calls.filter(entry => entry.action === 'review:confirm').length, 0, '组合态 Enter 不提交');
});

test('鼠标失焦自动保存行为保留：已有确认的问题离开说明框时按原结果写一次', async () => {
  const t = task('T1', [issue('R1-1', '旧说明')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', '旧说明')]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  ipc.calls.length = 0;
  ipc.responses.set('review:confirm', { by: 'human', note: '鼠标提交' });
  const input = type(s.body, 'R1-1', '鼠标提交');
  input.blur();
  await flush();
  assert.deepEqual(ipc.calls.filter(entry => entry.action === 'review:confirm').map(entry => entry.payload.note), ['鼠标提交']);
  assert.notEqual(doc.activeElement, input);
});

test('保存失败显示原错误、保留草稿、不把焦点偷回；恢复后仍可重试', async () => {
  const t = task('T1', [issue('R1-1', '旧说明')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', '旧说明')]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  s.host.changed = () => orderIndex(s);
  ipc.errors.add('review:confirm');
  const input = type(s.body, 'R1-1', '会失败');
  assert.equal(pressKey(input, 'Enter').defaultPrevented, true);
  await flush();
  const fail = s.body.querySelector('[data-rv-fail="R1-1"]');
  assert.ok(fail, '失败后卡片上有错误提示');
  assert.ok(fail.textContent.includes('核心拒绝'), '显示核心给的原错误');
  assert.equal(noteInput(s.body, 'R1-1').value, '会失败', '失败后草稿保留');
  assert.notEqual(doc.activeElement, noteInput(s.body, 'R1-1'), '失败后不把焦点偷回说明框');

  ipc.errors.clear();
  ipc.responses.set('review:confirm', { by: 'human', note: '会失败' });
  ipc.calls.length = 0;
  const retry = type(s.body, 'R1-1', '会失败');
  pressKey(retry, 'Enter');
  await flush();
  assert.equal(ipc.calls.filter(entry => entry.action === 'review:confirm').length, 1, '失败后可以返回重试');
  assert.equal(s.body.querySelector('[data-rv-fail="R1-1"]'), null, '成功重试后错误提示消失');
});

test('同一条说明提交 A 还没回来时又输入 B 并真实失焦：A 回来不覆盖 B，随后串行只提交一次 B', async () => {
  const t = task('T1', [issue('R1-1', '旧说明')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', '旧说明')]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  s.host.changed = () => orderIndex(s);
  ipc.calls.length = 0;

  const gateA = defer('review:confirm');
  const first = type(s.body, 'R1-1', 'A');
  assert.equal(pressKey(first, 'Enter').defaultPrevented, true);
  await flush();
  assert.deepEqual(ipc.calls.filter(entry => entry.action === 'review:confirm').map(entry => entry.payload.note), ['A'], 'A 在途');

  // 用户回到说明框改写成 B 并真的失焦（越过宿主重画后的静默窗口）。
  await new Promise(resolve => setTimeout(resolve, 320));
  const gateB = defer('review:confirm');
  const second = type(s.body, 'R1-1', 'B');
  second.blur();
  await flush();
  assert.deepEqual(ipc.calls.filter(entry => entry.action === 'review:confirm').map(entry => entry.payload.note), ['A'], 'B 排在 A 后面，不并发、不丢');

  gateA.resolve({ by: 'human', note: 'A' });
  await flush();
  assert.deepEqual(ipc.calls.filter(entry => entry.action === 'review:confirm').map(entry => entry.payload.note), ['A', 'B'], 'A 回来后才串行提交 B，每个版本一次');
  assert.equal(noteInput(s.body, 'R1-1').value, 'B', 'A 的结果不能把正在输入的 B 覆盖掉');

  gateB.resolve({ by: 'human', note: 'B' });
  await flush();
  assert.deepEqual(ipc.calls.filter(entry => entry.action === 'review:confirm').map(entry => entry.payload.note), ['A', 'B'], 'B 只提交一次');
  assert.equal(noteInput(s.body, 'R1-1').value, 'B', '最终显示 B');
});

for (const original of ['O', '']) test(`在途说明改回原值 ${JSON.stringify(original)} 仍串行保存最新意图`, async () => {
  const t = task('T1', [issue('R1-1', original)]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', original)]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  s.host.changed = () => orderIndex(s);
  ipc.calls.length = 0;
  const gateA = defer('review:confirm');
  pressKey(type(s.body, 'R1-1', 'A'), 'Enter');
  await flush();
  const gateO = defer('review:confirm');
  pressKey(type(s.body, 'R1-1', original), 'Enter');
  await flush();
  assert.deepEqual(ipc.calls.filter(x => x.action === 'review:confirm').map(x => x.payload.note ?? ''), ['A']);
  gateA.resolve({ by: 'human', note: 'A' });
  await flush();
  assert.deepEqual(ipc.calls.filter(x => x.action === 'review:confirm').map(x => x.payload.note ?? ''), ['A', original], '最新回改须在 A 后提交');
  gateO.resolve({ by: 'human', note: original || null });
  await flush();
  assert.equal(noteInput(s.body, 'R1-1').value, original);
});

test('A 在途时 B 排队、随后回到旧值 O：只提交最新的 O', async () => {
  const t = task('T1', [issue('R1-1', 'O')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', 'O')]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  s.host.changed = () => orderIndex(s);
  ipc.calls.length = 0;
  const gateA = defer('review:confirm');
  pressKey(type(s.body, 'R1-1', 'A'), 'Enter');
  await flush();
  pressKey(type(s.body, 'R1-1', 'B'), 'Enter');
  pressKey(type(s.body, 'R1-1', 'O'), 'Enter');
  const gateO = defer('review:confirm');
  gateA.resolve({ by: 'human', note: 'A' });
  await flush();
  assert.deepEqual(ipc.calls.filter(x => x.action === 'review:confirm').map(x => x.payload.note ?? ''), ['A', 'O']);
  gateO.resolve({ by: 'human', note: 'O' });
  await flush();
});

test('A 在途时 B 仍在聚焦编辑、还没失焦：A 回来不自动提交 B，草稿与焦点都保留', async () => {
  const t = task('T1', [issue('R1-1', '旧说明')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', '旧说明')]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  s.host.changed = () => orderIndex(s);
  ipc.calls.length = 0;

  const gateA = defer('review:confirm');
  pressKey(type(s.body, 'R1-1', 'A'), 'Enter');
  await flush();
  await new Promise(resolve => setTimeout(resolve, 320));
  type(s.body, 'R1-1', 'B');

  gateA.resolve({ by: 'human', note: 'A' });
  await flush();
  assert.deepEqual(ipc.calls.filter(entry => entry.action === 'review:confirm').map(entry => entry.payload.note), ['A'], 'B 没有失焦，不自动提交');
  assert.equal(noteInput(s.body, 'R1-1').value, 'B', 'B 仍作为草稿保留');
  assert.equal(doc.activeElement?.dataset?.rvNote, 'R1-1', '焦点仍在正在编辑的说明框');
});

test('提交期间用户把焦点移到别的说明框：回应到达后不把焦点偷回原来的输入框', async () => {
  const t = task('T1', [issue('R1-1', '旧说明'), issue('R1-2')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', '旧说明'), issue('R1-2')]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  s.host.changed = () => orderIndex(s);
  ipc.calls.length = 0;
  const input = type(s.body, 'R1-1', '提交中');
  const gate = defer('review:confirm');
  pressKey(input, 'Enter');
  await flush();
  assert.equal(ipc.calls.filter(entry => entry.action === 'review:confirm').length, 1);
  const other = type(s.body, 'R1-2', '别处');
  gate.resolve({ by: 'human', note: '提交中' });
  await flush();
  assert.equal(doc.activeElement?.dataset?.rvNote, 'R1-2', '焦点留在用户后来选的输入框');
  assert.equal(doc.activeElement, noteInput(s.body, 'R1-2'), '重画后用户选的输入框仍聚焦');
  assert.equal(noteInput(s.body, 'R1-2').value, '别处', '另一张卡片的草稿保留');
  assert.notEqual(doc.activeElement, other, '重画换成了新的说明框');
});

test('不同问题不全局串行：第一条挂起时第二条仍立即提交并可先完成', async () => {
  const t = task('T1', [issue('R1-1', '旧A'), issue('R1-2', '旧B')]);
  const s = await world([t]);
  s.task = t;
  await load(s, t, reviewFile([issue('R1-1', '旧A'), issue('R1-2', '旧B')]));
  s.view.attach(s.body);
  s.body.innerHTML = s.view.html(t);
  s.host.changed = () => orderIndex(s);
  ipc.calls.length = 0;
  const gateA = defer('review:confirm');
  pressKey(type(s.body, 'R1-1', '新A'), 'Enter');
  const gateB = defer('review:confirm');
  try {
    pressKey(type(s.body, 'R1-2', '新B'), 'Enter');
    assert.deepEqual(ipc.calls.filter(entry => entry.action === 'review:confirm').map(entry => entry.payload.issue), ['R1-1', 'R1-2'], '第一条尚未返回，第二条已独立发出');
    gateB.resolve({ by: 'human', note: '新B' });
    await flush();
    assert.equal(s.view.review(t).issues[1].confirmation.note, '新B', '第二条先完成');
    assert.equal(s.view.review(t).issues[0].confirmation.note, '旧A', '第一条仍挂起');
  } finally {
    gateA.resolve({ by: 'human', note: '新A' });
    gateB.resolve({ by: 'human', note: '新B' });
    await flush();
  }
  assert.equal(noteInput(s.body, 'R1-1').value, '新A');
  assert.equal(noteInput(s.body, 'R1-2').value, '新B');
});
