import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../../core/lib/agents.mjs';

const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const agent = fileURLToPath(new URL('../fixtures/fake-claude-code.mjs', import.meta.url));
test('分批调研派发、计划、参数和适配器检查', t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-research-cli-'));
  const repo = join(base, 'repo'), home = join(base, 'home'); mkdirSync(repo); mkdirSync(home);
  t.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 2000));
    // Windows 上脱离派发的子进程可能在 wait 返回后再过几秒才释放目录；清理失败只留下临时目录，不算测试失败。
    try { rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 留给系统清理 */ }
  });
  const git = args => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(repo, name), name);
  writeFileSync(join(repo, '.gitignore'), '.agent-runs/\n'); git(['add', '--', '.gitignore', 'a.txt', 'b.txt', 'c.txt']); git(['commit', '-qm', 'fixture']);
  const snapshot = git(['rev-parse', 'HEAD']);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', HOME: base, USERPROFILE: base, APPDATA: base, AR_TEST_AGENT: agent, AR_TEST_ENV_REPORT: join(base, 'env.json'), DEEPSEEK_API_KEY: 'test-key' };
  writeFileSync(join(base, 'env.json'), '{}');
  mkdirSync(join(base, 'AppData'));
  for (const key of ['AR_PROFILE', 'AR_DRY_RUN', 'CODEX_DRY_RUN', 'CLAUDECODE', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, defaultProfile: 'cc', profiles: { cc: loadPreset('deepseek').profile, fake: { adapter: 'fake' } } }));
  const ar = (args, cwd = repo) => spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
  const response = ar(['research', '这个模块怎么用', '--files', '*.txt', 'a.txt', '--batch', '2', '--budget-min', '7', '--json']);
  assert.equal(response.status, 0, response.stdout + response.stderr);
  const result = JSON.parse(response.stdout); assert.equal(result.snapshot, snapshot);
  assert.deepEqual(result.batches.map(b => b.files), [['a.txt', 'b.txt'], ['c.txt']]);
  const saved = JSON.parse(readFileSync(join(repo, '.agent-runs', 'research', result.name, 'plan.json'), 'utf8'));
  assert.deepEqual(saved.batches, result.batches); assert.equal(saved.snapshot, snapshot); assert.equal(saved.budgetMin, 7);
  for (const part of result.batches) {
    const dispatch = JSON.parse(readFileSync(join(repo, '.agent-runs', part.record, 'dispatch.json'), 'utf8'));
    assert.equal(dispatch.type, 'research'); assert.equal(dispatch.readOnly, true); assert.equal(dispatch.noWorktree, true); assert.equal(dispatch.gate.merged.timeout_min, 7);
    assert.match(dispatch.task, new RegExp(snapshot)); for (const file of part.files) assert.ok(dispatch.task.includes(file));
    const waited = ar(['wait', part.record, '--timeout', '30', '--json']); assert.equal(waited.status, 0, waited.stdout + waited.stderr);
  }
  const firstDir = join(repo, '.agent-runs', result.batches[0].record);
  const secondDir = join(repo, '.agent-runs', result.batches[1].record);
  writeFileSync(join(firstDir, 'report.md'), '第一批完整汇报\n第二行\n');
  writeFileSync(join(secondDir, 'report.md'), '第二批完整汇报\n');
  writeFileSync(join(firstDir, 'events.jsonl'), [
    { kind: 'tool', name: 'Read', detail: 'Read a.txt' },
    { kind: 'tool', name: 'Read', detail: 'Read c.txt' },
    { kind: 'tool', name: 'Read', detail: 'Read ' + 'x'.repeat(195) },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const collected = ar(['research', 'collect', result.name, '--json']);
  assert.equal(collected.status, 0, collected.stdout + collected.stderr);
  const summary = JSON.parse(collected.stdout);
  assert.deepEqual(summary, { name: result.name, summary: join(repo, '.agent-runs', 'research', result.name, 'summary.md'), missing: [] });
  const content = readFileSync(summary.summary, 'utf8');
  for (const value of ['这个模块怎么用', snapshot, '- a.txt', '- b.txt', '- c.txt', '第一批完整汇报\n第二行', '第二批完整汇报', '超出本批范围的读取：\n- c.txt', '无法判断']) assert.ok(content.includes(value), value);
  assert.ok(!content.includes('x'.repeat(195)));
  assert.ok(content.indexOf('第一批完整汇报') < content.indexOf('第二批完整汇报'));
  const repeated = ar(['research', 'collect', result.name]);
  assert.equal(repeated.status, 0); assert.match(repeated.stdout, /；未交 0 批/); assert.equal(readFileSync(summary.summary, 'utf8'), content);
  const registry = join(home, 'runs.jsonl'), originalRegistry = readFileSync(registry, 'utf8');
  const rows = originalRegistry.trim().split('\n').map(line => JSON.parse(line));
  const secondId = rows.find(row => row.event === 'start' && row.name === result.batches[1].record).id;
  writeFileSync(registry, rows.filter(row => !(row.id === secondId && ['end', 'interrupted'].includes(row.event))).map(row => JSON.stringify(row)).join('\n') + '\n');
  const running = ar(['research', 'collect', result.name, '--json']);
  assert.equal(running.status, 0); assert.deepEqual(JSON.parse(running.stdout).missing, [2]);
  writeFileSync(registry, originalRegistry);
  unlinkSync(join(secondDir, 'report.md'));
  const incomplete = ar(['research', 'collect', result.name, '--json']);
  assert.equal(incomplete.status, 0); assert.deepEqual(JSON.parse(incomplete.stdout).missing, [2]);
  assert.match(readFileSync(summary.summary, 'utf8'), /未交批次：2/);
  for (const name of ['不存在', '../escape', 'missing']) assert.equal(ar(['research', 'collect', name, '--json']).status, 2);
  const collectQuestion = ar(['research', 'collect', '--files', 'a.txt', '--json']);
  assert.equal(collectQuestion.status, 0, collectQuestion.stdout + collectQuestion.stderr);
  const collectDispatch = JSON.parse(collectQuestion.stdout);
  assert.equal(JSON.parse(readFileSync(join(repo, '.agent-runs', 'research', collectDispatch.name, 'plan.json'), 'utf8')).question, 'collect');
  const collectWait = ar(['wait', collectDispatch.batches[0].record, '--timeout', '30', '--json']);
  assert.equal(collectWait.status, 0, collectWait.stdout + collectWait.stderr);
  const text = ar(['research', '另一问题', '--files', 'a.txt']); assert.equal(text.status, 0, text.stdout + text.stderr); assert.match(text.stdout, /^调研已派发：research-.*（1 批）/);
  const name = /调研已派发：(.*)（1 批）/.exec(text.stdout)[1];
  const last = JSON.parse(readFileSync(join(repo, '.agent-runs', 'research', name, 'plan.json'), 'utf8'));
  const lastWait = ar(['wait', last.batches[0].record, '--timeout', '30', '--json']);
  assert.equal(lastWait.status, 0, lastWait.stdout + lastWait.stderr);
  for (const args of [[], ['', '--files', '*'], ['这个模块怎么用', '--files'], ['这个模块怎么用', '--files', '../*'], ['这个模块怎么用', '--files', '/tmp/*'], ['这个模块怎么用', '--files', 'missing'], ['这个模块怎么用', '--files', '*', '--batch', '0'], ['这个模块怎么用', '--files', '*', '--budget-min', '1.5'], ['这个模块怎么用', '--files', '*', '--unknown']]) assert.equal(ar(['research', ...args, '--json']).status, 2, JSON.stringify(args));
  assert.equal(ar(['research', '这个模块怎么用', '--files', '*', '--json'], base).status, 2);
  const rejected = ar(['research', '问题', '--files', '*.txt', '--profile', 'fake', '--json']); assert.equal(rejected.status, 2); assert.match(rejected.stdout, /无法从最终输出收集汇报/);
});
