import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));

// 不显式指定公共目录，只给 APPDATA：新目录 = APPDATA/agent-router，旧目录 = APPDATA/codex-dispatch，与真实环境一致。
function fixture(t) {
  const base = fs.mkdtempSync(join(tmpdir(), '旧任务 兼容 '));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const repo = join(base, '示例 仓库'), appdata = join(base, 'appdata');
  fs.mkdirSync(repo); fs.mkdirSync(appdata);
  // 回显文件放进预先建好的子目录：USERPROFILE 就是 base，写在 base 根的第一层会被当作工作区外的新文件。
  fs.mkdirSync(join(base, 'echo'));
  const fake = join(base, '假 agent.mjs'); fs.copyFileSync(join(fixtures, 'fake-agent.txt'), fake);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CODEX_|AR_|AGENT_ROUTER_|FAKE_)|^CLAUDECODE$/.test(k)) delete env[k];
  Object.assign(env, { APPDATA: appdata, USERPROFILE: base, HOME: base, XDG_CONFIG_HOME: appdata, CODEX_HOME: join(base, 'codex'), AR_NO_WATCH: '1', AR_TEST_AGENT: fake,
    FAKE_ECHO: join(base, 'echo', 'argv.json'), FAKE_FIXTURES: JSON.stringify([join(fixtures, 'codex-sample.jsonl')]) });
  const home = join(appdata, 'agent-router'), legacy = join(appdata, 'codex-dispatch');
  const ar = args => spawnSync(process.execPath, [entry, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false });
  // v1 旧任务：平铺在 .codex-runs/，清单在旧公共目录。
  const oldTask = (name, exit, started) => {
    const runs = join(repo, '.codex-runs'); fs.mkdirSync(runs, { recursive: true });
    const p = { progress: join(runs, `${name}.progress.log`), report: join(runs, `${name}.md`), raw: join(runs, `${name}.log`), events: join(runs, `${name}.events.jsonl`) };
    fs.writeFileSync(p.progress, `=== Codex 开始：${name} ===\n`); fs.writeFileSync(p.report, '旧汇报\n'); fs.writeFileSync(p.raw, ''); fs.writeFileSync(p.events, '');
    fs.mkdirSync(legacy, { recursive: true });
    const id = `${name}-1`;
    fs.appendFileSync(join(legacy, 'runs.jsonl'), [
      { v: 1, event: 'start', id, repo, name, title: name, spec: null, role: null, pid: 2147483647, started, ...p, agent: 'codex', dispatcher: { host: 'claude-code', session: null } },
      { v: 1, event: 'end', id, exit, at: started + 1000, minutes: 0 },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    return p;
  };
  return { base, repo, home, legacy, ar, oldTask };
}

test('v1 旧任务：记录在旧公共目录与 .codex-runs/，ar --wait / ar wait 都能返回原结果', t => {
  const f = fixture(t), p = f.oldTask('旧 任务', 3, Date.now() - 60000);
  for (const args of [['--wait', '旧 任务'], ['wait', '旧 任务']]) {
    const result = f.ar(args);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /等待：旧 任务（已结束）/);
    assert.ok(result.stdout.includes(`exit=3 report=${p.report}`));
  }
  assert.ok(!fs.existsSync(join(f.home, 'runs.jsonl')), '等待旧任务不写新清单');
});

test('v2 新任务写在新公共目录与 .agent-runs/<名>/；与旧任务并存时各自能找到，省略记录名取最近的', t => {
  const f = fixture(t); f.oldTask('旧 任务', 0, Date.now() - 60000);
  const dispatched = f.ar(['只回复 OK', '--name', '新 任务']);
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const rows = fs.readFileSync(join(f.home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => [r.event, r.v]), [['start', 2], ['attempt', 1], ['spawned', 1], ['attempt-end', 1], ['end', 1]]);
  assert.equal(rows[0].dir, join(f.repo, '.agent-runs', '新 任务'));
  const report = join(f.repo, '.agent-runs', '新 任务', 'report.md');
  assert.equal(fs.readFileSync(report, 'utf8'), 'OK\n');
  let result = f.ar(['--wait', '新 任务']); assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.includes(`exit=0 report=${report}`));
  result = f.ar(['--wait']); assert.equal(result.status, 0); assert.match(result.stdout, /等待：新 任务（已结束）/);
  result = f.ar(['--wait', '旧 任务']); assert.equal(result.status, 0); assert.match(result.stdout, /等待：旧 任务（已结束）/);
  for (const name of ['新 任务', '旧 任务']) {
    result = f.ar(['--stop', name]); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, new RegExp(`停止：${name}（已经结束）`));
  }
});
