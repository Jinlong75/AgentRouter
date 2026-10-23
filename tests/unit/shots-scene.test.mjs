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
const { INPUT_LOG_SIZE, OUTER_HTML_LIMIT, pushInput, redactScene, safeFileName, sceneBaseName, sceneRecord, truncate } = createRequire(import.meta.url)(outfile);
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
