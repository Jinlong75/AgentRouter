import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../../core/lib/agents.mjs';
import { readDispatch, retryOptions, explicitOptions, optionArgs } from '../../core/lib/records.mjs';

// 067：dispatch.json 的 options（命令行明确给出的派发选项），ar redispatch / ar retry 沿用。
// 隔离的 AGENT_ROUTER_HOME 与系统临时目录里的仓库，用 fake / 假的 Claude Code，不碰真实安装与真实进程。
const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const fixture = name => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const BASE = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];

function setup(t, profiles, defaultProfile, { claude = false } = {}) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'ar-options-067-'));
  t.after(() => { assert.equal(path.dirname(base), path.resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const repo = path.join(base, 'repo'), home = path.join(base, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile, profiles }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_)/i.test(k)) delete env[k];
  Object.assign(env, { AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', USERPROFILE: base, HOME: base, APPDATA: base,
    DEEPSEEK_API_KEY: 'sk-test-options-067' });
  // 假的 Claude Code 只在需要看参数时启用（fake 执行者不经过它）。
  if (claude) Object.assign(env, { AR_TEST_AGENT: fixture('fake-claude-code.mjs'), AR_TEST_ENV_REPORT: path.join(base, 'env.json') });
  const ar = (...args) => spawnSync(process.execPath, [entry, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 60000, windowsHide: true, shell: false });
  const rows = () => { try { return fs.readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const dispatchJson = name => path.join(repo, '.agent-runs', name, 'dispatch.json');
  const progress = name => fs.readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  return { base, repo, home, env, ar, rows, dispatchJson, progress, starts: () => rows().filter(r => r.event === 'start') };
}
const fakeProfile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 };

test('dispatch.json：带 --model --sandbox --watch-window → options 恰好是这三个键；什么都不带 → 没有 options', t => {
  const f = setup(t, { fake: fakeProfile }, 'fake');
  const a = f.ar('dispatch', '任务甲', '--name', 'with-opts', '--model', 'x', '--sandbox', 'y', '--watch-window', 'never');
  assert.equal(a.status, 0, a.stderr);
  const saved = JSON.parse(fs.readFileSync(f.dispatchJson('with-opts'), 'utf8'));
  assert.deepEqual(saved.options, { model: 'x', sandbox: 'y', watchWindow: 'never' });
  assert.deepEqual(Object.keys(saved.options).sort(), ['model', 'sandbox', 'watchWindow']);
  const b = f.ar('dispatch', '任务乙', '--name', 'no-opts');
  assert.equal(b.status, 0, b.stderr);
  const plain = JSON.parse(fs.readFileSync(f.dispatchJson('no-opts'), 'utf8'));
  assert.equal(Object.hasOwn(plain, 'options'), false);
  assert.deepEqual(plain, { v: 1, task: '任务乙', extra: '', role: null, spec: null, profile: 'fake', name: 'no-opts' });
});

test('readDispatch：options 有坏值的文件照常读，坏值被忽略；旧文件（没有 options）照常读', t => {
  const f = setup(t, { fake: fakeProfile }, 'fake');
  const write = (name, options) => {
    fs.mkdirSync(path.dirname(f.dispatchJson(name)), { recursive: true });
    const body = { v: 1, task: 't', extra: '', role: null, spec: null, profile: 'fake', name };
    fs.writeFileSync(f.dispatchJson(name), JSON.stringify(options === undefined ? body : { ...body, options }));
  };
  write('old');
  assert.equal(Object.hasOwn(readDispatch(f.repo, 'old'), 'options'), false);
  write('mixed', { model: 'm', effort: '', tier: 5, sandbox: ['a'], watchWindow: 'never', unknown: 'z' });
  assert.deepEqual(readDispatch(f.repo, 'mixed').options, { model: 'm', watchWindow: 'never' });
  for (const [i, bad] of [null, 'text', 7, ['model'], { tier: null }].entries()) {
    write(`bad-${i}`, bad);
    const value = readDispatch(f.repo, `bad-${i}`);
    assert.ok(value, '文件仍有效');
    assert.equal(Object.hasOwn(value, 'options'), false);
  }
});

test('explicitOptions / optionArgs / retryOptions：键名与开关对应，换配置只留 sandbox / watchWindow', () => {
  assert.equal(explicitOptions({ name: 'n' }), null);
  assert.deepEqual(explicitOptions({ model: 'm', 'watch-window': 'never', host: 'claude-code' }), { model: 'm', watchWindow: 'never' });
  assert.deepEqual(optionArgs({ model: 'm', watchWindow: 'never' }), ['--model', 'm', '--watch-window', 'never']);
  const all = { model: 'm', effort: 'e', tier: 't', sandbox: 's', watchWindow: 'w' };
  assert.deepEqual(retryOptions(all, false), all);
  assert.deepEqual(retryOptions(all, true), { sandbox: 's', watchWindow: 'w' });
  assert.deepEqual(retryOptions(undefined, true), {});
});

test('ar redispatch 沿用保存的选项：新派发的 start 记录里有这些值', t => {
  const f = setup(t, { fake: fakeProfile }, 'fake');
  const first = f.ar('dispatch', '任务丙', '--name', 'again', '--model', 'm-1', '--effort', 'high', '--tier', 'flex', '--sandbox', 'read-only', '--watch-window', 'never');
  assert.equal(first.status, 0, first.stderr);
  const again = f.ar('redispatch', 'again');
  assert.equal(again.status, 0, again.stderr + again.stdout);
  const second = f.starts().find(r => r.name === 'again-2');
  assert.ok(second, '去重后的新记录');
  assert.equal(second.model, 'm-1'); assert.equal(second.effort, 'high'); assert.equal(second.tier, 'flex'); assert.equal(second.sandbox, 'read-only');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.dispatchJson('again-2'), 'utf8')).options, { model: 'm-1', effort: 'high', tier: 'flex', sandbox: 'read-only', watchWindow: 'never' });
});

function claudeProfiles() {
  const profile = loadPreset('deepseek').profile;
  return { a: { ...profile }, b: { ...profile } };
}
const lastArgs = f => JSON.parse(fs.readFileSync(path.join(f.base, 'env.json'), 'utf8')).args;

test('ar retry：同一执行者配置沿用 model / effort，换配置不沿用并在进度里写一行说明', t => {
  const f = setup(t, claudeProfiles(), 'a', { claude: true });
  const first = f.ar('dispatch', '任务丁', '--name', 'keep', '--profile', 'a', '--model', 'm-keep', '--effort', 'high', '--tier', 'flex');
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(lastArgs(f), [...BASE, '--model', 'm-keep', '--effort', 'high']);

  const same = f.ar('retry', 'keep', '--note', '再来一次');
  assert.equal(same.status, 0, same.stderr + same.stdout);
  assert.deepEqual(lastArgs(f), [...BASE, '--model', 'm-keep', '--effort', 'high'], '同一配置：沿用全部选项');
  assert.ok(!f.progress('keep').includes('不沿用'), '没换配置不写说明');

  const other = f.ar('retry', 'keep', '--note', '换个执行者', '--profile', 'b');
  assert.equal(other.status, 0, other.stderr + other.stdout);
  assert.deepEqual(lastArgs(f), BASE, '换配置：model / effort 不沿用');
  assert.match(f.progress('keep'), /手动重试：换了执行者配置（a → b），不沿用 model \/ effort \/ tier/);
});
