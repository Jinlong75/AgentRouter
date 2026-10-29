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

class FakeElement {
  constructor(tagName) { this.tagName = tagName.toUpperCase(); this.dataset = {}; this.attributes = new Map(); this.disabled = false; this.selectionStart = null; this.selectionEnd = null; }
  focus() { doc.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}
class FakeInputElement extends FakeElement {
  constructor() { super('input'); this.value = ''; }
}
class FakeContainer {
  constructor() { this.html = ''; this.elements = []; }
  get innerHTML() { return this.html; }
  set innerHTML(text) {
    if (this.elements.includes(doc.activeElement)) doc.activeElement = doc.body;
    this.html = text;
    this.elements = [];
    for (const tag of text.matchAll(TAG)) {
      const name = tag[1].toLowerCase();
      if (name !== 'input' && name !== 'button') continue;
      const el = name === 'input' ? new FakeInputElement() : new FakeElement('button');
      for (const attr of tag[2].matchAll(ATTR)) {
        const value = decode(attr[2]);
        el.attributes.set(attr[1], value);
        const key = toKey(attr[1]);
        if (key) el.dataset[key] = value;
      }
      el.disabled = el.attributes.has('disabled');
      if (name === 'input') {
        el.value = el.attributes.get('value') ?? '';
        el.selectionStart = el.selectionEnd = el.value.length;
      }
      this.elements.push(el);
    }
  }
  contains(el) { return this.elements.includes(el); }
  querySelectorAll(selector) { return this.elements.filter(el => this.matches(el, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  matches(el, selector) {
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
  }
}

const doc = { activeElement: null, body: new FakeElement('body'), container: null, querySelector: selector => doc.container?.querySelector(selector) ?? null };
doc.activeElement = doc.body;
globalThis.document = doc;
globalThis.HTMLElement = FakeElement;
globalThis.HTMLInputElement = FakeInputElement;
globalThis.CSS = { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`) };

// 假的 console IPC：review:show / agents:list 按用例设置，调用本身同步记录。
const ipc = { responses: new Map(), calls: [] };
globalThis.window = { dock: { console: (action, payload) => { ipc.calls.push({ action, payload }); return Promise.resolve(ipc.responses.get(action)); } } };

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
