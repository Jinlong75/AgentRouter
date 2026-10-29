import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// 纯函数在 app/src/main/shots-input.ts（执行者只能改这个文件）：用 esbuild 打包后引用，electron 换成空桩（与 tests/gui/monitor.ts 相同做法）。
const source = fileURLToPath(new URL('../../app/src/main/shots-input.ts', import.meta.url));
const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-shots-scene-'));
const outfile = path.join(dir, 'shots-input.cjs');
await build({
  entryPoints: [source], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
  plugins: [{ name: 'electron-stub', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
  } }],
});
const { INPUT_LOG_SIZE, OUTER_HTML_LIMIT, createHarness, focusFailureExtra, instantFocusState, progress, pushInput, redactScene, safeFileName, sceneBaseName, sceneRecord, truncate } = createRequire(import.meta.url)(outfile);
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

test('safeFileName：去掉文件名不允许的字符与控制字符，空白合并，保留中文', () => {
  assert.equal(safeFileName('通用 设置页（dark，1160×720）第 7 个可操作元素'), '通用_设置页（dark，1160×720）第_7_个可操作元素');
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeFileName('x\u0000y\u001fz'), 'x_y_z');
  assert.doesNotMatch(safeFileName('C:\\Users\\某人\\file.png'), /[\\/:]/);
});

test('safeFileName：空、全是非法字符、点开头结尾时退回 check 或去掉首尾', () => {
  assert.equal(safeFileName(''), 'check');
  assert.equal(safeFileName(undefined), 'check');
  assert.equal(safeFileName('???***'), 'check');
  assert.equal(safeFileName('..name..'), 'name');
});

test('safeFileName：按字符截断（不拆代码点），默认 60、可指定', () => {
  assert.equal(Array.from(safeFileName('长'.repeat(100))).length, 60);
  assert.equal(safeFileName('abcdefghij', 4), 'abcd');
  const emoji = '😀'.repeat(70);
  assert.equal(Array.from(safeFileName(emoji)).length, 60);
  assert.equal(safeFileName('ab cd', 3), 'ab');
});

test('truncate：按字符数截断，不超过时原样', () => {
  assert.equal(truncate('abcdef', 3), 'abc');
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate(null, 3), '');
  assert.equal(Array.from(truncate('😀😀😀', 2)).length, 2);
});

test('sceneBaseName：两位序号 + 安全化标签', () => {
  assert.equal(sceneBaseName(1, 'UI17 再派一次 / 失败'), '01-UI17_再派一次_失败');
  assert.equal(sceneBaseName(12, ''), '12-check');
});

test('redactScene：额外根目录（两种斜杠）写成 <临时目录>，系统临时目录与用户目录由 redactPaths 处理', () => {
  const root = 'T:\\fake-home\\ar-demo';
  assert.equal(redactScene(`在 ${root}\\runs.jsonl 和 ${root.replace(/\\/g, '/')}/x`, [root]), '在 <临时目录>\\runs.jsonl 和 <临时目录>/x');
  assert.equal(redactScene(`${os.tmpdir()}\\abc`), '<TEMP>\\abc');
  // 用户目录可能就在系统临时目录下（隔离环境），所以只断言原路径不再出现、换成了 <HOME> 或 <TEMP>。
  const home = redactScene(`${os.homedir()}\\Documents\\a.txt`);
  assert.ok(!home.includes(os.homedir()) && /^<(HOME|TEMP)>/.test(home), home);
  assert.equal(redactScene(null), '');
});

test('pushInput：只留最近 20 条', () => {
  const log = [];
  for (let i = 0; i < 25; i++) pushInput(log, { type: 'key', key: `K${i}`, at: String(i) });
  assert.equal(log.length, INPUT_LOG_SIZE);
  assert.equal(log[0].key, 'K5');
  assert.equal(log.at(-1).key, 'K24');
});

test('sceneRecord：字段齐全，outerHTML 脱敏后截 300 字符，输入记录与窗口状态原样带上', () => {
  const root = 'T:\\fake-home\\ar-demo';
  const record = sceneRecord({
    message: '设置页 第 7 个可操作元素：焦点环不可见（<button> outline=none 3px focusVisible=false）',
    label: '通用 设置页（dark，1160×720）第 7 个可操作元素',
    now: Date.UTC(2026, 9, 22, 8, 0, 0),
    page: { outerHTML: `<button title="${root}\\x">` + 'a'.repeat(1000), outlineStyle: 'none', outlineWidth: '3px', outlineColor: 'rgb(0, 0, 0)', boxShadow: 'none', focusVisible: false, focus: true, hasFocus: false, visibilityState: 'visible' },
    win: { isFocused: false, webContentsIsFocused: true, isVisible: false, isMinimized: false, focusedWindowIsThis: false },
    inputs: [{ type: 'key', key: 'Tab', at: '2026-10-22T08:00:00.000Z' }, { type: 'type', selector: '#a', text: `${root}\\z`, at: '2026-10-22T08:00:01.000Z' }],
    screenshot: '01-x.png',
    roots: [root],
  });
  assert.deepEqual(Object.keys(record), ['message', 'label', 'at', 'screenshot', 'captureError', 'readError', 'activeElement', 'document', 'window', 'recentInputs']);
  assert.equal(record.at, '2026-10-22T08:00:00.000Z');
  assert.equal(record.screenshot, '01-x.png');
  assert.equal(record.captureError, null);
  assert.equal(Array.from(record.activeElement.outerHTML).length, OUTER_HTML_LIMIT);
  assert.ok(record.activeElement.outerHTML.startsWith('<button title="<临时目录>\\x">'));
  assert.deepEqual({ ...record.activeElement, outerHTML: undefined }, { outerHTML: undefined, outlineStyle: 'none', outlineWidth: '3px', outlineColor: 'rgb(0, 0, 0)', boxShadow: 'none', matchesFocusVisible: false, matchesFocus: true });
  assert.deepEqual(record.document, { hasFocus: false, visibilityState: 'visible' });
  assert.deepEqual(record.window, { isFocused: false, webContentsIsFocused: true, isVisible: false, isMinimized: false, focusedWindowIsThis: false });
  assert.equal(record.recentInputs.length, 2);
  assert.deepEqual(record.recentInputs[0], { type: 'key', key: 'Tab', at: '2026-10-22T08:00:00.000Z' });
  assert.equal(record.recentInputs[1].text, '<临时目录>\\z');
  assert.ok(!JSON.stringify(record).includes(root));
});

test('sceneRecord：页面或窗口读不到、截图失败时字段为 null，原因写进 readError / captureError，失败信息原文保留', () => {
  const record = sceneRecord({ message: '原来的失败信息', label: '某检查', now: 0, captureError: '截图超时（10000 ms）', readError: '页面：读取焦点元素超时（5000 ms）', inputs: [] });
  assert.equal(record.message, '原来的失败信息');
  assert.equal(record.activeElement, null);
  assert.equal(record.document, null);
  assert.equal(record.window, null);
  assert.equal(record.screenshot, null);
  assert.equal(record.captureError, '截图超时（10000 ms）');
  assert.equal(record.readError, '页面：读取焦点元素超时（5000 ms）');
  assert.deepEqual(record.recentInputs, []);
  assert.ok(!('extra' in record));
});

test('sceneRecord：专项现场 extra 原样写出', () => {
  const root = 'T:\\fake-home\\ar-demo';
  const record = sceneRecord({ message: 'm', label: 'l', now: 0, roots: [root], extra: { pathElements: [{ tag: 'DIV', text: `在 ${root}\\a` }], gapMs: 12, none: null } });
  assert.deepEqual(record.extra, { pathElements: [{ tag: 'DIV', text: '在 <临时目录>\\a' }], gapMs: 12, none: null });
});

test('focusFailureExtra：即时记录带时刻与页面/窗口状态，进入失败现场后脱敏且原失败信息不变', () => {
  const root = 'T:\\fake-home\\ar-demo';
  const at = '2026-10-30T08:00:00.000Z';
  const message = '通用 路由页（dark，1160×720）第 3 个可操作元素：焦点环不可见（<button> outline=none 3px focusVisible=false）';
  const extra = focusFailureExtra({
    at,
    page: { outerHTML: `<button title="${root}\\x">` + 'a'.repeat(1000), outlineStyle: 'none', outlineWidth: '3px', boxShadow: 'none', focusVisible: false, focus: false, hasFocus: false, visibilityState: 'visible' },
    win: { isFocused: false, webContentsIsFocused: true, isVisible: false, isMinimized: false, focusedWindowIsThis: false },
    readError: null,
  }, [{
    label: 'Tab 到 [data-pref=wizard]', at, restored: true,
    before: { at, docFocus: false, webContentsIsFocused: false },
    after: { at: '2026-10-30T08:00:00.050Z', docFocus: true, webContentsIsFocused: true },
  }], `<button> focusVisible=false 在 ${root}\\y`);
  const record = sceneRecord({ message, label: '某检查', now: 0, roots: [root], extra });
  assert.equal(record.message, message);
  assert.equal(record.extra.focusFailure.phase, '即时记录（focusRing 断言之前）');
  assert.equal(record.extra.focusFailure.at, at);
  assert.equal(record.extra.focusFailure.activeElement.focusVisible, false);
  assert.equal(record.extra.focusFailure.activeElement.focus, false);
  assert.ok(Array.from(record.extra.focusFailure.activeElement.outerHTML).length <= OUTER_HTML_LIMIT);
  assert.ok(record.extra.focusFailure.activeElement.outerHTML.startsWith('<button title="<临时目录>\\x">'));
  assert.deepEqual(record.extra.focusFailure.document, { hasFocus: false, visibilityState: 'visible' });
  assert.deepEqual(record.extra.focusFailure.window, { isFocused: false, webContentsIsFocused: true, isVisible: false, isMinimized: false });
  assert.equal(record.extra.focusFailure.observed, '<button> focusVisible=false 在 <临时目录>\\y');
  assert.equal(record.extra.focusFailure.readError, null);
  assert.equal(record.extra.outerCleanup.phase, '外层保存时记录（可能已经清理，不是即时记录）');
  assert.equal(record.extra.focusRestored.length, 1);
  assert.equal(record.extra.focusRestored[0].label, 'Tab 到 [data-pref=wizard]');
  assert.equal(record.extra.focusRestored[0].restored, true);
  assert.deepEqual(record.extra.focusRestored[0].before, { at, docFocus: false, webContentsIsFocused: false });
  assert.deepEqual(record.extra.focusRestored[0].after, { at: '2026-10-30T08:00:00.050Z', docFocus: true, webContentsIsFocused: true });
  assert.ok(!JSON.stringify(record).includes(root));
});

test('focusFailureExtra：采样失败只记采样错误，页面/窗口为 null，原失败信息保留', () => {
  const extra = focusFailureExtra({
    at: '2026-10-30T08:00:00.000Z',
    page: null,
    win: null,
    readError: '页面：即时读取页面焦点超时（2000 ms）；窗口：即时读取窗口状态超时（2000 ms）',
  }, []);
  const record = sceneRecord({ message: '原来的失败信息', label: '某检查', now: 0, extra });
  assert.equal(record.message, '原来的失败信息');
  assert.equal(record.extra.focusFailure.activeElement, null);
  assert.equal(record.extra.focusFailure.document, null);
  assert.equal(record.extra.focusFailure.window, null);
  assert.equal(record.extra.focusFailure.readError, '页面：即时读取页面焦点超时（2000 ms）；窗口：即时读取窗口状态超时（2000 ms）');
  assert.deepEqual(record.extra.focusRestored, []);
});

// 224 补修：新诊断的 outerHTML 必须与顶层 activeElement 同一顺序（先完整脱敏、再截 300 字符）。
// 根目录正好跨过截断点时，先截断会留下半截路径；这里用超出根目录长度的精确期望，不只检查完整根目录消失。
test('focusFailureExtra：outerHTML 先完整脱敏再截断，根目录跨截断点时不留下路径片段', () => {
  const root = 'T:\\fake-home\\ar-demo';
  const at = '2026-10-30T08:00:00.000Z';
  const extra = focusFailureExtra({
    at,
    page: { outerHTML: 'a'.repeat(290) + root + 'b'.repeat(100), focus: false, focusVisible: false },
    win: null,
    readError: null,
  }, []);
  const record = sceneRecord({ message: 'm', label: 'l', now: 0, roots: [root], extra });
  const got = record.extra.focusFailure.activeElement.outerHTML;
  assert.equal(got, 'a'.repeat(290) + '<临时目录>' + 'b'.repeat(4));
  assert.equal(Array.from(got).length, OUTER_HTML_LIMIT);
  assert.ok(!got.includes(root));
  assert.ok(!got.includes('T:\\fake-h'), `截断点留下了根目录片段：${got.slice(280)}`);
});

// 224 补修：用本文件已有的 esbuild 桩驱动 instantFocusState，不启动 Electron 窗口、不跑焦点恢复、不改限时常量。
function fakeWin(executeJavaScript) {
  return {
    id: 224,
    isFocused: () => false,
    isVisible: () => false,
    isMinimized: () => false,
    webContents: { on: () => {}, isFocused: () => false, executeJavaScript },
  };
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('instantFocusState：页面读取被拒绝、窗口读取失败都只记 readError，不抛出', async () => {
  const rejected = await instantFocusState(fakeWin(async () => { throw Error('页面读取被拒绝'); }), 200);
  assert.match(rejected.at, ISO);
  assert.equal(rejected.page, null);
  assert.match(rejected.readError, /页面：页面读取被拒绝/);
  // 桩里没有 BrowserWindow，窗口状态读取本身失败，也只记进 readError。
  assert.match(rejected.readError, /窗口：/);
  const windowFailed = await instantFocusState({ ...fakeWin(async () => ({ focusVisible: false })), isFocused: () => { throw Error('窗口读取失败'); } }, 200);
  assert.deepEqual(windowFailed.page, { focusVisible: false });
  assert.equal(windowFailed.win, null);
  assert.match(windowFailed.readError, /窗口：窗口读取失败/);
});

test('instantFocusState：页面读取不完成时按传入上限降级，不改变内置常量', async () => {
  const started = Date.now();
  const timedOut = await instantFocusState(fakeWin(() => new Promise(() => {})), 50);
  const elapsed = Date.now() - started;
  assert.equal(timedOut.page, null);
  assert.match(timedOut.readError, /页面：即时读取页面焦点超时（50 ms）/);
  assert.ok(elapsed >= 40 && elapsed < 2000, `降级用时 ${elapsed} ms`);
});

test('focusRing：即时采样失败只记进失败现场 extra，原断言信息与拒绝条件不变', async () => {
  const at = '2026-10-30T08:00:00.000Z';
  const ringText = '<button data-pref=wizard> outline=none 0px focusVisible=false';
  let calls = 0;
  const win = fakeWin(async () => {
    calls += 1;
    if (calls === 1) return ringText;
    throw Error('即时读取被拒绝');
  });
  const harness = createHarness(win, async () => {});
  progress.focusRestored.push({ label: 'Tab 到 [data-pref=wizard]', at, restored: true, before: { at, docFocus: false, webContentsIsFocused: false }, after: { at, docFocus: true, webContentsIsFocused: true } });
  try {
    await assert.rejects(harness.focusRing('焦点实验 测试'), error => {
      // Node 会在自定义信息后追加 actual/expected 对照，所以断言原信息前缀，不改变拒绝条件。
      assert.ok(error.message.startsWith(`焦点实验 测试：焦点环不可见（${ringText}）`), error.message);
      return true;
    });
    const extra = progress.sceneExtra;
    assert.equal(extra.focusFailure.phase, '即时记录（focusRing 断言之前）');
    assert.equal(extra.focusFailure.activeElement, null);
    assert.equal(extra.focusFailure.window, null);
    assert.match(extra.focusFailure.readError, /页面：即时读取被拒绝/);
    assert.equal(extra.outerCleanup.phase, '外层保存时记录（可能已经清理，不是即时记录）');
    assert.equal(extra.focusRestored.length, 1);
    assert.equal(extra.focusRestored[0].label, 'Tab 到 [data-pref=wizard]');
  } finally {
    progress.focusRestored.length = 0;
    progress.sceneExtra = undefined;
  }
});
