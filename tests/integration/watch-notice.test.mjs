import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { VIEWER_STALE_MS, viewerState, viewerTakesOver, watchPlan } from '../../core/lib/watch.mjs';

const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const NOTICE = /AgentRouter 软件在运行（进程 \d+），进度在软件的任务页，没有弹出只读窗口；想要窗口可以在设置里把"进度窗口"改为总是弹出/;

// 隔离的公共目录与仓库、假执行者。心跳新鲜的 viewer 让 auto 策略不弹窗，所以真实派发不会弹出任何窗口。
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-watch-notice-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo');
  for (const dir of [home, repo]) fs.mkdirSync(dir);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (lower === 'agent_router_home' || lower === 'codex_dispatch_home' || lower === 'ar_no_watch' || lower === 'codex_no_watch'
      || lower === 'ar_dry_run' || lower === 'codex_dry_run' || lower === 'node_options' || lower === 'electron_run_as_node'
      || lower === 'ar_test_agent' || lower === 'codex_dispatch_test_agent') delete env[key];
  }
  Object.assign(env, { AGENT_ROUTER_HOME: home });
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'say', text: '做完了' }], report: '假汇报\n', exit: 0 };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'auto', defaultProfile: 'fake', profiles: { fake: profile } }));
  t.after(() => {
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-watch-notice-'));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const viewer = value => fs.writeFileSync(path.join(home, 'viewer.json'), JSON.stringify(value));
  const dispatch = (args = [], overrides = {}) => spawnSync(process.execPath, [script, 'dispatch', '隔离任务', ...args], {
    cwd: repo, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false,
  });
  return { home, repo, viewer, dispatch };
}

// 前台判断函数：心跳新鲜时由软件接管，auto 策略下后台不弹窗（opened=false），所以真实派发不会启动窗口进程。
// 平台写 win32（Windows 与 macOS 走同一条分支）：Linux 上真实派发本来就不会弹窗。
test('前台判断：心跳新鲜时接管，auto 策略不弹窗', t => {
  const f = fixture(t);
  f.viewer({ pid: process.pid, suppressWatchWindow: true, updated: Date.now() });
  const viewer = viewerState(f.home);
  assert.equal(viewer.takeover, true);
  assert.equal(viewerTakesOver(f.home), true);
  assert.deepEqual(watchPlan({ platform: 'win32', interactive: false, policy: 'auto', viewer }), { opened: false, reason: 'viewer', pid: process.pid });
});

// 真实派发的文字输出；--json 时这一行收在 lines 里、另有 watch 字段。没有心跳的旧格式不受影响（已有测试覆盖）。
// 只在会弹窗的平台（Windows、macOS）上跑：Linux 的派发本来就不弹窗、也不写原因行。
test('派发输出写明不弹窗原因：文字与 --json 的行', { skip: !['win32', 'darwin'].includes(process.platform) }, t => {
  const f = fixture(t);
  f.viewer({ pid: process.pid, suppressWatchWindow: true, updated: Date.now() });
  const text = f.dispatch(['--name', 'watch-notice-text']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, NOTICE);
  const json = f.dispatch(['--name', 'watch-notice-json', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const value = JSON.parse(json.stdout);
  assert.equal(value.ok, true);
  assert.match(value.lines.join('\n'), NOTICE);
  assert.equal(value.watch.opened, false);
  assert.equal(value.watch.reason, 'viewer');
  assert.equal(value.watch.pid, process.pid);
});

// 心跳过期：不接管；auto 策略因此会弹窗（opened=true）。真实派发用 AR_NO_WATCH（策略 never）避免真的弹出窗口，
// 这一路的原因是 never，所以不写原因行、--json 写明原因——过期本身由上一条判断函数断言。
test('心跳过期：不接管，auto 策略会弹窗，策略 never 不写原因行', t => {
  const f = fixture(t);
  const now = Date.now();
  f.viewer({ pid: process.pid, suppressWatchWindow: true, updated: now - VIEWER_STALE_MS - 10000 });
  const viewer = viewerState(f.home, undefined, now);
  assert.deepEqual(viewer, { takeover: false, pid: null });
  assert.equal(viewerTakesOver(f.home, undefined, now), false);
  assert.deepEqual(watchPlan({ platform: 'win32', interactive: false, policy: 'auto', viewer }), { opened: true });
  const result = f.dispatch(['--name', 'watch-notice-stale'], { AR_NO_WATCH: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /没有弹出只读窗口/);
  const never = f.dispatch(['--name', 'watch-notice-never', '--json'], { AR_NO_WATCH: '1' });
  assert.equal(never.status, 0, never.stderr);
  const value = JSON.parse(never.stdout);
  assert.equal(value.watch.opened, false);
  assert.equal(value.watch.reason, 'never');
  assert.equal(value.watch.pid, undefined);
});
