import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runGate } from '../../core/lib/gate.mjs';

test('本次汇报缺节时门禁失败，补齐后通过', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q']); git(['config', 'user.name', 'test']); git(['config', 'user.email', 'test@example.test']);
  writeFileSync(join(root, 'a'), 'a'); git(['add', 'a']); git(['commit', '-qm', 'initial']);
  const base = git(['rev-parse', 'HEAD']).trim();
  const dir = join(root, '.agent-runs', 'test'); mkdirSync(dir, { recursive: true });
  const options = { root, base, dir, spec: { reportRequired: { sections: ['推断清单'] } } };
  writeFileSync(join(dir, 'report.md'), '# 完成\n');
  const failed = await runGate(options);
  assert.equal(failed.ok, false);
  assert.equal(failed.summary, '汇报缺少必需的小节：推断清单（项目配置 reportRequired）');
  writeFileSync(join(dir, 'report.md'), '## 推断清单\n无\n');
  assert.equal((await runGate(options)).ok, true);
  const attempts = join(dir, 'attempts');
  for (const n of [1, 2, 3, 4]) mkdirSync(join(attempts, String(n)), { recursive: true });
  writeFileSync(join(attempts, '1', 'report.md'), '## 推断清单\n');
  writeFileSync(join(attempts, '2', 'report.md'), '# 缺节\n');
  assert.equal((await runGate({ ...options, dir: join(attempts, '3') })).summary, '汇报缺少必需的小节：推断清单（项目配置 reportRequired）');
  writeFileSync(join(attempts, '4', 'prompt.md'), '执行者指令');
  assert.equal((await runGate({ ...options, dir: join(attempts, '4') })).ok, true);
});

test('真实派发自动重试传递缺节原因，且无执行者的重跑沿用最近汇报', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-report-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = join(dir, 'repo'), home = join(dir, 'home');
  mkdirSync(join(root, '.agent-router'), { recursive: true }); mkdirSync(home);
  const git = (...args) => execFileSync('git', args, { cwd: root });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.agent-runs/\n');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ baseBranch: 'main', worktree: true, reportRequired: { sections: ['推断清单'], types: ['code'] } }));
  for (const [name, retries] of [['retry', 1], ['regate', 0]]) writeFileSync(join(root, `${name}.md`), `---\ntype: code\nexpect_commit: false\nmax_retries: ${retries}\n---\n任务\n`);
  git('add', '.gitignore', '.agent-router/project.json', 'retry.md', 'regate.md'); git('commit', '-qm', 'fixtures');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true, events: [], report: '# 完成\n', exit: 0, attempts: { 2: { report: '## 推断清单\n无\n' } } } } }));
  const script = resolve('core/ar.mjs');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: join(dir, 'worktrees'), AR_NO_WATCH: '1', AR_TEST_AGENT: '1' };
  const ar = args => spawnSync(process.execPath, [script, ...args, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  const reason = '汇报缺少必需的小节：推断清单（项目配置 reportRequired）';
  const first = ar(['dispatch', 'retry.md', '--name', 'retry', '--profile', 'fake']);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const record = join(root, '.agent-runs', 'retry', 'attempts');
  assert.equal(JSON.parse(readFileSync(join(record, '1', 'gate.json'), 'utf8')).summary, reason);
  assert.ok(readFileSync(join(record, '2', 'prompt.md'), 'utf8').includes(reason));
  assert.equal(JSON.parse(readFileSync(join(record, '2', 'gate.json'), 'utf8')).ok, true);
  const failed = ar(['dispatch', 'regate.md', '--name', 'regate', '--profile', 'fake']);
  assert.equal(failed.status, 3, failed.stderr + failed.stdout);
  const repeated = ar(['retry', 'regate', '--regate']);
  assert.equal(repeated.status, 3, repeated.stderr + repeated.stdout);
  assert.equal(JSON.parse(readFileSync(join(root, '.agent-runs', 'regate', 'attempts', '2', 'gate.json'), 'utf8')).summary, reason);
});

test('任务报告小节内容', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-report-content-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(join(root, 'a'), 'a'); git('add', 'a'); git('commit', '-qm', 'initial');
  const dir = join(root, '.agent-runs', 'attempt'); mkdirSync(dir, { recursive: true }); const file = join(dir, 'report.md');
  const options = { root, base: git('rev-parse', 'HEAD').trim(), dir, spec: { reportRequired: { sections: ['项目节'] }, report_sections: ['反向实验'] } };
  writeFileSync(file, '# 汇报\n'); let gate = await runGate(options); assert.match(gate.summary, /项目配置 reportRequired/); assert.match(gate.summary, /任务说明 report_sections/);
  writeFileSync(file, '## 项目节\n无\n## 反向实验\n无。\n'); gate = await runGate(options); assert.equal(gate.ok, false); assert.match(gate.summary, /反向实验/);
  writeFileSync(file, '## 项目节\n无\n## 反向实验\n失败输出\n'); assert.equal((await runGate(options)).ok, true);
  writeFileSync(file, '# 汇报\n'); assert.equal((await runGate({ ...options, readOnly: true })).ok, true);
});

test('普通门禁不注入全量验收环境变量', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-gate-env-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test');
  writeFileSync(join(root, 'a'), 'a'); git('add', 'a'); git('commit', '-qm', 'initial');
  const dir = join(root, '.agent-runs', 'attempt'); mkdirSync(dir, { recursive: true });
  const env = { ...process.env }; delete env.AR_FULL_VERIFY;
  const gate = await runGate({ root, base: git('rev-parse', 'HEAD').trim(), dir, env, spec: { verify: [`node -e "process.exit(process.env.AR_FULL_VERIFY?1:0)"`] } });
  assert.equal(gate.ok, true);
});
