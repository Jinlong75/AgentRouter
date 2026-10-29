import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Stage07c T5：ar route reviewer set 能写 differFromLead。隔离的 AGENT_ROUTER_HOME；只读写 config.json，不派发。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 主导 '));
  t.after(() => { rmSync(base, { recursive: true, force: true }); });
  const home = path.join(base, '隔离 公共目录');
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_PROFILE']) delete env[key];
  const file = path.join(home, 'config.json');
  writeFileSync(file, JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
    profiles: {
      fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 },
      kimi: { adapter: 'claude-code', label: 'Kimi', enabled: true, model: 'kimi-k3' },
    },
    routing: { rules: [], fallback: null, reviewer: null },
  }));
  const f = { file };
  f.ar = args => spawnSync(process.execPath, [script, ...args], { cwd: base, env, encoding: 'utf8' });
  f.json = args => { const r = f.ar([...args, '--json']); return { status: r.status, stderr: r.stderr, json: JSON.parse(r.stdout) }; };
  f.read = () => JSON.parse(readFileSync(file, 'utf8'));
  return f;
}

const set = (f, value) => f.json(['route', 'reviewer', 'set', JSON.stringify(value)]);

test('没写过 differFromLead / differFamily：不写这两个键，route config 与 ar roles 按默认读', t => {
  const f = fixture(t);
  assert.equal(set(f, { profiles: ['kimi'] }).status, 0);
  assert.deepEqual(f.read().routing.reviewer, { profiles: ['kimi'], mustDiffer: true });
  assert.equal(f.json(['route', 'config']).json.reviewer.differFromLead, true);
  assert.equal(f.json(['route', 'config']).json.reviewer.differFamily, true, '没写时随 mustDiffer');
  assert.equal(f.json(['roles']).json.differFromLead, true);
  assert.equal(f.json(['roles']).json.differFamily, true);
});

test('写 false：config.json 是 false，route config --json 是 false，ar roles 跟着变；只带 profiles 再写一次时保留', t => {
  const f = fixture(t);
  const written = set(f, { profiles: ['kimi'], differFromLead: false });
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.json.reviewer.differFromLead, false);
  assert.equal(f.read().routing.reviewer.differFromLead, false);
  assert.deepEqual(f.json(['route', 'config']).json.reviewer, { profiles: ['kimi'], mustDiffer: true, differFamily: true, differFromLead: false });
  assert.equal(f.json(['roles']).json.differFromLead, false);

  assert.equal(set(f, { profiles: ['kimi', 'fake'] }).status, 0);
  assert.deepEqual(f.read().routing.reviewer, { profiles: ['kimi', 'fake'], mustDiffer: true, differFromLead: false }, '没写就保留已有的值');
  assert.equal(f.json(['roles']).json.differFromLead, false);

  // 再写回 true。
  assert.equal(set(f, { profiles: ['kimi'], differFromLead: true }).status, 0);
  assert.equal(f.read().routing.reviewer.differFromLead, true);
  assert.equal(f.json(['roles']).json.differFromLead, true);
});

test('differFamily（190 D128）：单独写 false、保留、再写回 true；与 mustDiffer 互不影响', t => {
  const f = fixture(t);
  assert.equal(set(f, { profiles: ['kimi'], mustDiffer: true, differFamily: false }).status, 0);
  assert.deepEqual(f.read().routing.reviewer, { profiles: ['kimi'], mustDiffer: true, differFamily: false });
  assert.deepEqual(f.json(['route', 'config']).json.reviewer, { profiles: ['kimi'], mustDiffer: true, differFamily: false, differFromLead: true });
  assert.equal(f.json(['roles']).json.differFamily, false);
  assert.equal(f.json(['roles']).json.mustDiffer, true);
  // 只改 mustDiffer：没写 differFamily 时保留已有的值（false）。
  assert.equal(set(f, { profiles: ['kimi'], mustDiffer: false }).status, 0);
  assert.deepEqual(f.read().routing.reviewer, { profiles: ['kimi'], mustDiffer: false, differFamily: false });
  assert.equal(set(f, { profiles: ['kimi'], mustDiffer: false, differFamily: true }).status, 0);
  assert.deepEqual(f.read().routing.reviewer, { profiles: ['kimi'], mustDiffer: false, differFamily: true });
  assert.equal(f.json(['roles']).json.differFamily, true);
});

test('differFromLead / differFamily 不是布尔值：退出码 2、中文原因、config.json 不变', t => {
  const f = fixture(t);
  const before = readFileSync(f.file);
  for (const [key, bad] of [['differFromLead', 'no'], ['differFromLead', 0], ['differFromLead', null], ['differFamily', 'no'], ['differFamily', 0], ['differFamily', null]]) {
    const r = f.ar(['route', 'reviewer', 'set', JSON.stringify({ profiles: ['kimi'], [key]: bad })]);
    assert.equal(r.status, 2, `${key}=${String(bad)}`);
    assert.match(r.stderr, new RegExp(`审查者设置的 ${key} 必须是布尔值`));
    assert.deepEqual(readFileSync(f.file), before);
  }
});
