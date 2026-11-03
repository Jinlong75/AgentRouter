import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = resolve('core/ar.mjs');
test('严格模式在顶层拦截并支持确认与豁免', t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-strict-')), root = join(base, 'repo'), home = join(base, 'home');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(root); mkdirSync(home); mkdirSync(join(root, '.agent-router'));
  spawnSync('git', ['init', '-q', root]);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true, events: [], report: '完成', exit: 0 } } }));
  const config = value => writeFileSync(join(root, '.agent-router/project.json'), JSON.stringify(value));
  const env = { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(base, 'claude'), CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'one' };
  const call = (args, extra = {}) => spawnSync(process.execPath, [cli, ...args, '--json'], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });
  config({ leadStrict: true });
  for (const args of [['dispatch', 'task'], ['retry', 'missing'], ['accept', 'missing'], ['reject', 'missing'], ['redispatch', 'missing'], ['next', '--dispatch']]) {
    const r = call(args), value = JSON.parse(r.stdout); assert.equal(r.status, 2); assert.equal(value.code, 'LEAD_ACK_REQUIRED'); assert.match(value.error, /没有确认记录/);
  }
  for (const args of [
    ['dispatch', 'task', '--', '--host', 'agentrouter'],
    ['dispatch', 'task', '--host', 'agentrouter', '--host', 'claude-code'],
    ['retry', 'missing', '--note', '--host', 'agentrouter'],
    ['accept', 'missing', '--by', 'human', '--by', 'other']
  ]) {
    const result = call(args);
    assert.notEqual(result.status, 0);
  }
  assert.equal(JSON.parse(call(['dispatch', 'task', '--', '--host', 'agentrouter']).stdout).code, 'LEAD_ACK_REQUIRED');
  assert.equal(JSON.parse(call(['dispatch', 'task', '--host', 'agentrouter', '--host', 'claude-code']).stdout).code, 'LEAD_ACK_REQUIRED');
  assert.equal(existsSync(join(root, '.agent-runs')), false); assert.equal(existsSync(join(home, 'runs.jsonl')), false);
  assert.equal(call(['dispatch', 'task', '--name', 'software', '--host', 'agentrouter']).status, 0);
  assert.notEqual(JSON.parse(call(['accept', 'missing', '--by', 'human']).stdout).code, 'LEAD_ACK_REQUIRED');
  const brief = JSON.parse(call(['lead', 'brief']).stdout), token = brief.ack.token;
  assert.equal(call(['lead', 'ack', token]).status, 0);
  assert.equal(call(['dispatch', 'task', '--name', 'confirmed', '--profile', 'fake']).status, 0);
  assert.match(JSON.parse(call(['dispatch', 'task'], { CLAUDE_CODE_SESSION_ID: 'two' }).stdout).error, /会话已换/);
  writeFileSync(join(root, 'handoff.md'), '新交接');
  assert.match(JSON.parse(call(['dispatch', 'task']).stdout).error, /文件已改：handoff.md/);
  const wrong = call(['lead', 'ack', token]); assert.equal(wrong.status, 2);
  assert.equal(JSON.parse(wrong.stdout).error, '确认码不对：文件在你读过之后改过（已改动），重新运行 ar lead brief 再确认');
  config({ leadStrict: 'yes' }); assert.match(JSON.parse(call(['dispatch', 'task']).stdout).error, /项目配置无效：leadStrict/);
  // R2-1（主导）：配置损坏时严格模式不能静默放行。
  writeFileSync(join(root, '.agent-router/project.json'), '{ "leadStrict": true, '); { const r = call(['dispatch', 'task']); assert.equal(r.status, 2); assert.match(JSON.parse(r.stdout).error, /项目配置无法解析/); }
  config({ leadStrict: false }); assert.equal(call(['dispatch', 'task', '--name', 'disabled', '--profile', 'fake']).status, 0);
  assert.ok(readFileSync(join(root, '.agent-runs/lead-ack.json'), 'utf8'));
});
