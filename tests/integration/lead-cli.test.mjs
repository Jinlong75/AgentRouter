import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('选择主导、项目参数优先级、清除及错误', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-lead-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'), project = join(dir, 'project');
  mkdirSync(home); mkdirSync(project);
  const fake = join(dir, 'fake.js'); writeFileSync(fake, '');
  const config = { v: 2, profiles: { boss: { adapter: 'generic', label: '测试', roles: ['lead'], model: 'profile', effort: 'low', env: { TEST_ENV: 'value' }, secrets: { TEST_KEY: 'SOURCE_KEY' }, generic: { label: '测试', executable: fake, args: [], stdin: '{prompt}', output: { format: 'text' }, interactive: { args: [], model: ['-m', '{model}'], effort: ['-e', '{effort}'] } } }, off: { adapter: 'fake', enabled: false }, worker: { adapter: 'fake' }, unsupported: { adapter: 'fake', roles: ['lead'] } } };
  const file = join(home, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  writeFileSync(join(home, 'projects.json'), JSON.stringify({ v: 1, projects: [{ path: project, name: 'project' }] }));
  const ar = (...args) => { const r = spawnSync(process.execPath, [resolve('core/ar.mjs'), ...args, '--json'], { cwd: dir, env: { ...process.env, AGENT_ROUTER_HOME: home }, encoding: 'utf8' }); return { code: r.status, value: JSON.parse(r.stdout) }; };
  assert.equal(ar('lead').value.problem, '还没有选主导：ar lead set <执行者名>');
  for (const [name, message] of [['missing', '没有这个执行者：missing'], ['off', 'off 已停用'], ['worker', 'worker 不能担任主导：先运行 ar roles set worker roles=…,lead'], ['unsupported', '假执行者 还不支持作为主导启动（适配器没有交互启动方式）']]) {
    const result = ar('lead', 'set', name); assert.equal(result.code, 2); assert.equal(result.value.error, message);
  }
  assert.equal(ar('lead', 'set', 'boss').code, 0);
  assert.equal(ar('projects', 'config', project, 'lead.model=project', 'lead.effort=medium').code, 0);
  assert.deepEqual(ar('projects', 'show', project).value.project.lead, { model: 'project', effort: 'medium' });
  const plan = ar('lead', 'plan', '--project', project, '--model', 'cli model').value;
  const log = join(home, 'leads.jsonl');
  assert.equal(existsSync(log), false);
  const opened = ar('lead', 'open', '--project', project, '--model', 'cli model');
  assert.equal(opened.code, 0);
  assert.deepEqual(opened.value, { ...plan, recorded: true });
  const rows = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], at: 0 }, { v: 1, event: 'lead-launch', at: 0, project, profile: 'boss', label: '测试', adapter: 'generic', model: 'cli model', effort: 'medium' });
  assert.equal(typeof rows[0].at, 'number');
  assert.equal(ar('lead', 'open', '--project', join(dir, 'missing')).code, 2);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
  rmSync(log); mkdirSync(log);
  const failed = ar('lead', 'open', '--project', project);
  assert.equal(failed.code, 1);
  assert.match(failed.value.error, /^记录主导启动失败：/);
  assert.equal(failed.value.executable, undefined);
  rmSync(log, { recursive: true });
  assert.deepEqual(plan.args, [fake, '-m', 'cli model', '-e', 'medium']);
  assert.deepEqual(plan.sources, { model: '命令行', effort: '项目' });
  assert.deepEqual(plan.envNames, ['TEST_ENV', 'TEST_KEY']);
  const saved = JSON.parse(readFileSync(file));
  saved.profiles.boss.auth = 'login'; writeFileSync(file, JSON.stringify(saved));
  assert.deepEqual(ar('lead', 'plan', '--project', project).value.envNames, ['TEST_ENV']);
  saved.profiles.boss.generic.executable = join(dir, 'missing-agent'); writeFileSync(file, JSON.stringify(saved));
  const message = `找不到 测试 的程序：${saved.profiles.boss.generic.executable}`;
  assert.equal(ar('lead', 'show').value.problem, message);
  const missing = ar('lead', 'plan', '--project', project);
  assert.equal(missing.code, 2); assert.equal(missing.value.error, message);
  for (const adapter of ['claude-code', 'codex']) {
    const program = join(dir, `missing-${adapter}`);
    saved.profiles.boss = { adapter, path: program, label: '测试', roles: ['lead'] };
    writeFileSync(file, JSON.stringify(saved));
    const expected = `找不到 测试 的程序：${program}`;
    assert.equal(ar('lead', 'show').value.problem, expected);
    const result = ar('lead', 'plan', '--project', project);
    assert.equal(result.code, 2); assert.equal(result.value.error, expected);
  }
  assert.equal(ar('projects', 'config', project, 'lead.model=-bad').value.error, 'lead.model 不能以 - 开头');
  assert.equal(ar('projects', 'config', project, 'lead.model=', 'lead.effort=').code, 0);
  assert.equal(JSON.parse(readFileSync(join(home, 'projects.json'))).projects[0].lead, undefined);
  assert.equal(ar('lead', 'clear').code, 0);
});
