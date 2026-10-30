import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// 243：用真实 createHarness 与最小 DOM / BrowserWindow 桩驱动通用键盘审计和新增的"断言前焦点复核"。
// 不启动 Electron、不跑 GUI；electron 换成空桩（与 shots-scene.test.mjs 相同做法）。
const source = fileURLToPath(new URL('../../app/src/main/shots-input.ts', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-shots-keyboard-focus-'));
const outfile = path.join(dir, 'shots-input.cjs');
await build({
  entryPoints: [source], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
  plugins: [{ name: 'electron-stub', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({ contents: 'module.exports = { nativeTheme: {}, BrowserWindow: class { static getFocusedWindow() { return null; } } };', loader: 'js' }));
  } }],
});
const { INPUT_FOCUS_LIMIT, createHarness, progress } = createRequire(import.meta.url)(outfile);
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const ID_READ = 'document.activeElement?.getAttribute("data-audit")';

// 最小可执行 DOM / BrowserWindow 桩：
// - data-audit 元素按 ids 排列，真实 Tab（sendInputEvent keyDown）移到下一个；
// - 只有 document 有焦点时 :focus-visible 与焦点环才会成立（与 Electron 实测一致）；
// - loseFocusAfterIdRead：在实际读取 data-audit 之后、原 focusRing 之前让文档失焦；
// - activeAfterRestore：webContents.focus() 后焦点落到别的元素或丢失，用来验证恢复不是"冒充"。
function fakeWindow({ ids = ['0', '1', '2'], docFocus = true, loseFocusAfterIdRead = Infinity, ringEnabled = true, restoreOnFocus = true } = {}) {
  const state = {
    ids, docFocus, active: -1, idReads: 0, keyEvents: [], expressions: [], focusCalls: 0, showCalls: 0,
    loseFocusAfterIdRead, ringEnabled, restoreOnFocus, activeAfterRestore: undefined,
  };
  const idOf = () => state.active >= 0 ? ids[state.active] : null;
  const ringVisible = () => state.docFocus && state.ringEnabled;
  const executeJavaScript = async expr => {
    state.expressions.push(expr);
    if (expr === 'document.hasFocus()') return state.docFocus;
    if (expr.includes('visibilityState')) return {
      outerHTML: `<button data-audit="${idOf()}">`,
      outlineStyle: ringVisible() ? 'solid' : 'none', outlineWidth: ringVisible() ? '2px' : '0px', boxShadow: 'none',
      focusVisible: state.docFocus, focus: state.docFocus, hasFocus: state.docFocus, visibilityState: 'visible',
    };
    if (expr.includes('usable.forEach')) { state.active = -1; return ids.length; }
    if (expr.includes(':scope > .page-h.sticky')) return { covered: false };
    if (expr.trim() === '!!document.querySelector(".page-h.sticky")') return false;
    if (expr.includes('.filter(el =') && expr.includes('data-audit')) return [];
    if (expr === ID_READ) {
      state.idReads += 1;
      if (state.idReads === state.loseFocusAfterIdRead) state.docFocus = false;
      return idOf();
    }
    if (expr.includes('getComputedStyle(el)') && expr.includes('focusVisible=')) {
      return ringVisible() ? true : `<button data-audit="${idOf()}"> outline=none 0px focusVisible=false`;
    }
    if (expr.includes('scrollingElement.scrollWidth')) return true;
    if (expr.includes('getAttribute("aria-label")')) return [];
    if (expr.includes('prefers-reduced-motion')) return true;
    if (expr.includes('removeAttribute("data-audit")')) return true;
    throw Error(`未桩接的界面表达式：${expr.slice(0, 120)}`);
  };
  const win = {
    id: 243,
    setContentSize() {},
    isFocused: () => state.docFocus,
    isVisible: () => false,
    isMinimized: () => false,
    show() { state.showCalls += 1; },
    hide() { state.showCalls += 1; },
    blur() {},
    focus() {},
    webContents: {
      on() {},
      isFocused: () => state.docFocus,
      focus() {
        state.focusCalls += 1;
        if (!state.restoreOnFocus) return;
        state.docFocus = true;
        if (state.activeAfterRestore !== undefined) state.active = state.activeAfterRestore;
      },
      executeJavaScript,
      sendInputEvent(event) {
        state.keyEvents.push(`${event.type}:${event.keyCode}`);
        if (event.type === 'keyDown' && event.keyCode === 'Tab' && ids.length) {
          const step = event.modifiers?.includes('shift') ? -1 : 1;
          state.active = state.active < 0 ? (step === 1 ? 0 : ids.length - 1) : (state.active + step + ids.length) % ids.length;
        }
      },
      debugger: { attach() {}, detach() {}, sendCommand: async () => ({}) },
      capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
    },
  };
  return { win, state };
}

function resetProgress() {
  progress.focusRestored.length = 0;
  progress.sceneExtra = undefined;
  progress.current = '';
}

// 旧实现跑这一条必须红在"焦点环不可见"（不是缺方法 / 导入失败 / fixture 异常）：
// audit 的真实 key 完成后、读取 data-audit 之后让文档失焦，原 focusRing 随即失败。
// 实现断言前复核后，同一路径应由新增的真实方法恢复一次并保持同一 data-audit，然后绿。
test('audit：真实 key 后、原断言前失焦，旧实现红；断言前复核恢复同一 data-audit 后绿', async () => {
  resetProgress();
  const { win, state } = fakeWindow({ ids: ['0', '1', '2'], loseFocusAfterIdRead: 2 });
  const h = createHarness(win, async () => {});
  try {
    await h.audit('测试页', async () => {});
    assert.equal(state.focusCalls, 1, '失焦后只恢复一次输入焦点');
    assert.equal(state.showCalls, 0, '不显示或恢复窗口');
    assert.equal(progress.focusRestored.length, 1);
    const entry = progress.focusRestored[0];
    assert.equal(entry.restored, true);
    assert.match(entry.label, /第 1 个可操作元素/);
    assert.equal(entry.before.docFocus, false);
    assert.equal(entry.after.docFocus, true);
    assert.ok(entry.after.at >= entry.before.at);
  } finally {
    resetProgress();
  }
});

test('断言前复核：已聚焦不恢复；失焦时恢复一次、仍是同一 data-audit，不重发 Tab、不调用元素 focus', async () => {
  resetProgress();
  const { win, state } = fakeWindow({ ids: ['0', '1'] });
  const h = createHarness(win, async () => {});
  try {
    await h.key('Tab');
    assert.equal(state.active, 0);
    const before = { calls: state.focusCalls, keys: state.keyEvents.length, records: progress.focusRestored.length };
    await h.keyboardFocusRing('测试 已聚焦', '0');
    assert.deepEqual({ calls: state.focusCalls, keys: state.keyEvents.length, records: progress.focusRestored.length }, before, '已聚焦时不恢复、不按键、不记录');

    state.docFocus = false;
    const keysBefore = state.keyEvents.length;
    await h.keyboardFocusRing('测试 第 0 个可操作元素', '0');
    assert.equal(state.focusCalls, 1);
    assert.equal(state.keyEvents.length, keysBefore, '不重发 Tab / Shift+Tab');
    assert.ok(state.expressions.every(expr => !expr.includes('.focus(')), '不调用 DOM.focus');
    assert.equal(progress.focusRestored.length, 1);
    const entry = progress.focusRestored[0];
    assert.equal(entry.restored, true);
    assert.equal(entry.before.docFocus, false);
    assert.equal(entry.after.docFocus, true);
    assert.match(entry.label, /第 0 个可操作元素/);
  } finally {
    resetProgress();
  }
});

test('断言前复核：文档有焦点但 CSS 没有焦点环仍按原条件失败', async () => {
  resetProgress();
  const { win, state } = fakeWindow({ ids: ['0'], ringEnabled: false });
  const h = createHarness(win, async () => {});
  try {
    await assert.rejects(h.keyboardFocusRing('测试 无焦点环', '0'), error => {
      assert.match(error.message, /测试 无焦点环：焦点环不可见/);
      return true;
    });
    assert.equal(state.docFocus, true);
    assert.equal(progress.focusRestored.length, 0);
  } finally {
    resetProgress();
  }
});

test('负对照：直接调用原 focusRing 遇失焦仍按原条件拒绝，不被断言前复核吞掉', async () => {
  resetProgress();
  const { win, state } = fakeWindow({ ids: ['0'] });
  const h = createHarness(win, async () => {});
  state.docFocus = false;
  await assert.rejects(h.focusRing('测试 失焦负对照'), /焦点环不可见/);
  assert.equal(progress.focusRestored.length, 0, '直接调用不产生恢复记录');
  resetProgress();
});

test('断言前复核：恢复后 data-audit 改变或丢失都失败，不把下一个元素当本元素', async () => {
  for (const [name, activeAfterRestore] of [['改变', 1], ['丢失', -1]]) {
    resetProgress();
    const { win, state } = fakeWindow({ ids: ['0', '1'] });
    const h = createHarness(win, async () => {});
    await h.key('Tab');
    assert.equal(state.active, 0);
    state.docFocus = false;
    state.activeAfterRestore = activeAfterRestore;
    await assert.rejects(h.keyboardFocusRing(`测试 ${name}`, '0'), /焦点元素变了|data-audit/);
    const entry = progress.focusRestored.at(-1);
    assert.equal(entry.restored, true);
    assert.equal(entry.after.docFocus, true);
    resetProgress();
  }
});

// 243 补修：截止点在 key 开始时按绝对单调时刻登记。文档失焦且绝对截止点已到/已过时，
// 既不能先 focus，也不能用 Math.max(0, 截止点 - 现在) 新开一个 0ms 的相对 poll 窗口——
// 否则页面即使没焦点也会"首次真值"误过。以下三条边界在旧实现上都必须红在"没有拒绝"或"调用了恢复"。
async function withStaticClock(t, fn) {
  const clockState = { t };
  const realSetTimeout = globalThis.setTimeout;
  mock.method(performance, 'now', () => clockState.t);
  try { return await fn(clockState, realSetTimeout); }
  finally { globalThis.setTimeout = realSetTimeout; mock.restoreAll(); }
}

test('断言前复核：恰在绝对截止点时不再恢复、不新开相对 poll，记录 restored=false 并拒绝', async () => {
  resetProgress();
  await withStaticClock(30_000, async clockState => {
    const { win, state } = fakeWindow({ ids: ['0'] });
    const h = createHarness(win, async () => {});
    await h.key('Tab');
    assert.equal(state.active, 0);
    state.docFocus = false;
    clockState.t = 30_000 + INPUT_FOCUS_LIMIT;
    const callsBefore = state.focusCalls;
    const timers = [];
    globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 0; };
    await assert.rejects(h.keyboardFocusRing('测试 恰在截止点', '0'), /焦点环不可见/);
    assert.equal(state.focusCalls, callsBefore, '截止点已到时不调用恢复');
    // 原 focusRing 失败现场的即时采样另有 2000ms 限时；这里只排除 pollUntil 的相对 poll 窗口。
    assert.deepEqual(timers.filter(ms => ms <= 100), [], '不启动新的相对 poll 尝试');
    const entry = progress.focusRestored.at(-1);
    assert.equal(entry.restored, false);
    assert.equal(entry.before.docFocus, false);
    assert.equal(entry.after.docFocus, false);
    assert.match(entry.label, /恰在截止点（断言前复核）/);
    resetProgress();
  });
});

test('断言前复核：已过截止点但 focus 可立即成功，也不恢复、不即时成功，记录 restored=false 并拒绝', async () => {
  resetProgress();
  await withStaticClock(30_000, async clockState => {
    const { win, state } = fakeWindow({ ids: ['0'], restoreOnFocus: true });
    const h = createHarness(win, async () => {});
    await h.key('Tab');
    state.docFocus = false;
    clockState.t = 30_000 + INPUT_FOCUS_LIMIT + 1;
    const callsBefore = state.focusCalls;
    const timers = [];
    globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 0; };
    await assert.rejects(h.keyboardFocusRing('测试 已过期', '0'), /焦点环不可见/);
    assert.equal(state.focusCalls, callsBefore, '截止点已过时即使能立即获得焦点也不恢复');
    assert.deepEqual(timers.filter(ms => ms <= 100), [], '不启动新的相对 poll 尝试');
    const entry = progress.focusRestored.at(-1);
    assert.equal(entry.restored, false);
    assert.equal(entry.after.docFocus, false);
    resetProgress();
  });
});

test('断言前复核：没有本次 key 登记的预算时不恢复、记录 restored=false 并拒绝', async () => {
  resetProgress();
  await withStaticClock(5_000, async () => {
    const { win, state } = fakeWindow({ ids: ['0'], docFocus: false, restoreOnFocus: true });
    const h = createHarness(win, async () => {});
    const timers = [];
    globalThis.setTimeout = (fn, ms) => { timers.push(ms); return 0; };
    await assert.rejects(h.keyboardFocusRing('测试 无预算', '0'), /焦点环不可见/);
    assert.equal(state.focusCalls, 0, '没有本次 key 预算时不调用恢复');
    assert.deepEqual(timers.filter(ms => ms <= 100), [], '不启动新的相对 poll 尝试');
    const entry = progress.focusRestored.at(-1);
    assert.equal(entry.restored, false);
    assert.equal(entry.after.docFocus, false);
    resetProgress();
  });
});

test('断言前复核与输入前恢复共用原 1000ms 预算：预算耗尽按原严格条件失败，记录 restored=false', async () => {
  resetProgress();
  const clockState = { t: 10_000 };
  const realSetTimeout = globalThis.setTimeout;
  mock.method(performance, 'now', () => clockState.t);
  let delays = [];
  try {
    assert.equal(INPUT_FOCUS_LIMIT, 1000);
    const { win, state } = fakeWindow({ ids: ['0'] });
    const h = createHarness(win, async () => {});
    clockState.t = 20_000;
    await h.key('Tab');
    // key 开始时登记截止点 20_000 + 1000；这里模拟已经用掉 400ms。
    clockState.t = 20_000 + INPUT_FOCUS_LIMIT - 600;
    state.docFocus = false;
    state.restoreOnFocus = false;
    delays = [];
    globalThis.setTimeout = (fn, ms) => { delays.push(ms); clockState.t += ms; queueMicrotask(fn); return 0; };
    await assert.rejects(h.keyboardFocusRing('测试 预算耗尽', '0'), /焦点环不可见/);
    const guardDelays = delays.filter(ms => ms <= 100);
    assert.equal(guardDelays.reduce((sum, ms) => sum + ms, 0), 600, '只用剩余预算，不重新给 1 秒');
    const entry = progress.focusRestored.at(-1);
    assert.equal(entry.restored, false);
    assert.equal(entry.after.docFocus, false);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    mock.restoreAll();
    resetProgress();
  }
});
