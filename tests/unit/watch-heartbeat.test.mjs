import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { VIEWER_STALE_MS, viewerState, viewerTakesOver, watchPlan } from '../../core/lib/watch.mjs';

// 纯函数用例：只在系统临时目录里建一个公共目录，不启动任何进程。
function setup(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'watch 心跳 '));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return dir;
}
const writeViewer = (dir, value) => fs.writeFileSync(path.join(dir, 'viewer.json'), JSON.stringify(value));

test('updated 在 90 秒内：软件接管', t => {
  const dir = setup(t), now = Date.now();
  assert.equal(VIEWER_STALE_MS, 90000);
  writeViewer(dir, { pid: process.pid, suppressWatchWindow: true, updated: now - 10000 });
  assert.equal(viewerTakesOver(dir, undefined, now), true);
  assert.deepEqual(viewerState(dir, undefined, now), { takeover: true, pid: process.pid });
});

// 反向实验：去掉 viewerTakesOver 里的心跳过期判断后，这条会变成 true。
test('updated 超过 90 秒：心跳过期，不接管（即使进程号还被占用）', t => {
  const dir = setup(t), now = Date.now();
  writeViewer(dir, { pid: process.pid, suppressWatchWindow: true, updated: now - 100000 });
  assert.equal(viewerTakesOver(dir, undefined, now), false);
  assert.deepEqual(viewerState(dir, undefined, now), { takeover: false, pid: null });
});

test('没有 updated 的旧格式：只看进程是否存活', t => {
  const dir = setup(t);
  writeViewer(dir, { pid: 1234, suppressWatchWindow: true });
  assert.equal(viewerTakesOver(dir, () => { }), true);
  assert.equal(viewerTakesOver(dir, () => { throw new Error('进程已退出'); }), false);
});

test('updated 不是数字：当作没有心跳，只看进程', t => {
  const dir = setup(t);
  writeViewer(dir, { pid: 1234, suppressWatchWindow: true, updated: '刚刚' });
  assert.equal(viewerTakesOver(dir, () => { }), true);
  assert.equal(viewerTakesOver(dir, () => { throw new Error('进程已退出'); }), false);
});

// 不弹窗的原因：会弹窗的平台被软件接管（Windows、macOS）写 reason；本来就不弹窗的平台（Linux）没有原因。
// 策略 never 同样写明原因；接管但策略 always 时照常弹窗。
test('软件接管时看平台写原因：macOS 与 Windows 一样，Linux 不写', () => {
  const viewer = { takeover: true, pid: 1234 };
  assert.deepEqual(watchPlan({ platform: 'win32', interactive: false, policy: 'auto', viewer }), { opened: false, reason: 'viewer', pid: 1234 });
  assert.deepEqual(watchPlan({ platform: 'darwin', interactive: false, policy: 'auto', viewer }), { opened: false, reason: 'viewer', pid: 1234 });
  assert.deepEqual(watchPlan({ platform: 'linux', interactive: false, policy: 'auto', viewer }), { opened: false });
  assert.deepEqual(watchPlan({ platform: 'win32', interactive: false, policy: 'never', viewer }), { opened: false, reason: 'never' });
  assert.deepEqual(watchPlan({ platform: 'darwin', interactive: false, policy: 'always', viewer }), { opened: true });
});
