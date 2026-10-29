import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordLimit } from '../../core/lib/limits-state.mjs';

// Stage07c 154（D83 的"已恢复"）：ar route limits clear <名>。隔离的 AGENT_ROUTER_HOME；只读配置与路由试算，不派发、不启动任何执行者。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const config = () => ({
  v: 2, managed: false, watchWindow: 'never', defaultProfile: 'alpha',
  profiles: {
    alpha: { adapter: 'fake', label: '甲执行者', enabled: true, events: [], report: '汇报\n', exit: 0 },
    beta: { adapter: 'fake', label: '乙执行者', enabled: true, events: [], report: '汇报\n', exit: 0 },
  },
  routing: { rules: [{ types: ['docs'], profile: 'alpha' }], fallback: 'beta', reviewer: null },
});

function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-limits-clear-'));
  t.after(() => { rmSync(base, { recursive: true, force: true }); });
  const home = path.join(base, 'home');
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_PROFILE']) delete env[key];
  assert.equal(path.dirname(env.AGENT_ROUTER_HOME), base, '隔离目录在临时目录里');
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(config()));
  const f = { home, base };
  f.ar = args => spawnSync(process.execPath, [script, ...args], { cwd: base, env, encoding: 'utf8', windowsHide: true, shell: false });
  f.json = args => { const r = f.ar([...args, '--json']); return { status: r.status, stderr: r.stderr, json: JSON.parse(r.stdout) }; };
  f.limits = () => JSON.parse(readFileSync(path.join(home, 'limits.json'), 'utf8'));
  f.routed = () => f.json(['route', '--type', 'docs']).json.profile;
  return f;
}

const WHEN = /额度到 (?:\d+月\d+日 )?\d{2}:\d{2} 恢复/;

test('标记后 route config 有"额度到 HH:MM 恢复"、路由跳过它；清除后没有、路由重新选中它', t => {
  const f = fixture(t);
  recordLimit(f.home, 'alpha', { kind: 'limit', resetsAt: Date.now() + 3 * 3600000, evidence: '429' });
  assert.match(f.ar(['route', 'config']).stdout, new RegExp(`^ {2}alpha：${WHEN.source}$`, 'm'));
  assert.equal(f.routed(), 'beta', '被限流的甲被跳过');

  const cleared = f.json(['route', 'limits', 'clear', 'alpha']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(cleared.json, { ok: true, cleared: true });
  assert.ok(!WHEN.test(f.ar(['route', 'config']).stdout), '清除后 route config 没有恢复时间');
  assert.equal(f.json(['route', 'config']).json.profiles.find(p => p.name === 'alpha').limited, undefined);
  assert.equal(f.routed(), 'alpha', '路由重新选中它');
  assert.deepEqual(f.limits(), { v: 1, profiles: {} });
});

test('清除不影响别的执行者的记录；没有记录时也成功（cleared: false），不写文件', t => {
  const f = fixture(t);
  recordLimit(f.home, 'alpha', { kind: 'limit', resetsAt: Date.now() + 3 * 3600000, evidence: '429' });
  recordLimit(f.home, 'beta', { kind: 'limit', resetsAt: Date.now() + 2 * 3600000, evidence: 'quota' });
  const beta = f.limits().profiles.beta;
  const text = f.ar(['route', 'limits', 'clear', 'alpha']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /已清除 alpha 的限流标记/);
  assert.deepEqual(Object.keys(f.limits().profiles), ['beta']);
  assert.deepEqual(f.limits().profiles.beta, beta, '乙的记录原样保留');
  assert.match(f.ar(['route', 'config']).stdout, new RegExp(`^ {2}beta：${WHEN.source}$`, 'm'));

  // 再清一次：没有记录，也成功。
  const again = f.json(['route', 'limits', 'clear', 'alpha']);
  assert.equal(again.status, 0);
  assert.deepEqual(again.json, { ok: true, cleared: false });
  assert.deepEqual(f.limits().profiles.beta, beta);

  // 没有 limits.json 的家：也成功，而且不凭空建文件。
  const g = fixture(t);
  const none = g.json(['route', 'limits', 'clear', 'alpha']);
  assert.equal(none.status, 0);
  assert.deepEqual(none.json, { ok: true, cleared: false });
  assert.throws(() => readFileSync(path.join(g.home, 'limits.json')), '没有记录时不写 limits.json');
});

test('执行者不存在：报错、退出码 2，limits.json 不变；用法不对也是退出码 2', t => {
  const f = fixture(t);
  recordLimit(f.home, 'alpha', { kind: 'limit', resetsAt: Date.now() + 3 * 3600000, evidence: '429' });
  const before = readFileSync(path.join(f.home, 'limits.json'), 'utf8');
  const missing = f.json(['route', 'limits', 'clear', 'nobody']);
  assert.equal(missing.status, 2);
  assert.deepEqual(missing.json, { ok: false, error: '找不到执行者：nobody' });
  assert.equal(f.ar(['route', 'limits', 'clear', 'nobody']).status, 2);
  assert.equal(f.ar(['route', 'limits', 'clear']).status, 2);
  assert.equal(f.ar(['route', 'limits']).status, 2);
  assert.equal(readFileSync(path.join(f.home, 'limits.json'), 'utf8'), before);
});
