import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const NOTICE = /AgentRouter 软件在运行（进程 \d+），进度在软件的任务页，没有弹出只读窗口；想要窗口可以在设置里把"进度窗口"改为总是弹出/;

function fixture(t, policy = 'auto') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-detach-watch-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo'), log = path.join(base, 'watch.jsonl');
  fs.mkdirSync(home); fs.mkdirSync(repo);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['agent_router_home', 'codex_dispatch_home', 'ar_no_watch', 'codex_no_watch', 'ar_dry_run', 'codex_dry_run', 'node_options', 'electron_run_as_node', 'ar_test_agent', 'codex_dispatch_test_agent', 'ar_test_watch_log'].includes(key.toLowerCase())) delete env[key];
  }
  Object.assign(env, { AGENT_ROUTER_HOME: home, AR_TEST_WATCH_LOG: log });
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'say', text: '做完了' }], report: '假汇报\n', exit: 0 };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: policy, defaultProfile: 'fake', profiles: { fake: profile } }));
  t.after(() => {
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-detach-watch-'));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const ar = args => spawnSync(process.execPath, [script, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 70000, windowsHide: true, shell: false });
  const lines = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const wait = name => { const result = ar(['wait', name, '--timeout', '60']); assert.equal(result.status, 0, result.stderr || result.stdout); };
  return { home, repo, ar, lines, wait };
}

const options = { skip: !['win32', 'darwin'].includes(process.platform) && '此平台不会弹出进度窗口' };
test('脱离派发与重试各弹一次，前台派发也只弹一次', options, t => {
  const f = fixture(t);
  const first = f.ar(['dispatch', '任务', '--name', '甲', '--detach']);
  assert.equal(first.status, 0, first.stderr); f.wait('甲');
  assert.deepEqual(f.lines(), [{ name: '甲', progress: path.join(f.repo, '.agent-runs', '甲', 'progress.log'), label: '假执行者' }]);
  const retry = f.ar(['retry', '甲', '--note', '再试', '--detach']);
  assert.equal(retry.status, 0, retry.stderr || retry.stdout); f.wait('甲');
  assert.equal(f.lines().length, 2); assert.equal(f.lines()[1].name, '甲');
  const foreground = f.ar(['dispatch', '任务', '--name', '前台']);
  assert.equal(foreground.status, 0, foreground.stderr || foreground.stdout);
  assert.equal(f.lines().length, 3); assert.equal(f.lines()[2].name, '前台');
});

test('脱离派发遵守 never 策略', options, t => {
  const f = fixture(t, 'never');
  const result = f.ar(['dispatch', '任务', '--name', '甲', '--detach']);
  assert.equal(result.status, 0, result.stderr); f.wait('甲');
  assert.deepEqual(f.lines(), []);
});

test('软件接管时脱离派发和重试输出说明并且不弹窗', options, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'viewer.json'), JSON.stringify({ pid: process.pid, suppressWatchWindow: true, updated: Date.now() }));
  const result = f.ar(['dispatch', '任务', '--name', '甲', '--detach']);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, NOTICE); f.wait('甲');
  const retry = f.ar(['retry', '甲', '--note', '再试', '--detach']);
  assert.equal(retry.status, 0, retry.stderr); assert.match(retry.stdout, NOTICE); f.wait('甲');
  assert.deepEqual(f.lines(), []);
});
