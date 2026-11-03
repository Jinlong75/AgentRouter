import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { leadBrief } from '../../core/lib/lead-brief.mjs';
import { ackToken } from '../../core/lib/lead-ack.mjs';

const cli = resolve('core/ar.mjs');
test('启动钩子输出 JSON、空项目无输出、stdin 可指定仓库', t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-brief-cli-')), repo = join(base, 'repo'), other = join(base, 'other'), home = join(base, 'home');
  for (const dir of [repo, other, home]) mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', repo]); spawnSync('git', ['init', '-q', other]);
  mkdirSync(join(repo, '.agent-router')); writeFileSync(join(repo, '.agent-router/project.json'), '{}'); writeFileSync(join(repo, 'handoff.md'), '交接测试');
  const invoke = (cwd, input = '') => spawnSync(process.execPath, [cli, 'lead', 'brief', '--hook'], { cwd, input, encoding: 'utf8', env: { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(base, 'claude') } });
  const normal = invoke(repo); assert.equal(normal.status, 0); assert.equal(JSON.parse(normal.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  const empty = invoke(other); assert.equal(empty.status, 0); assert.equal(empty.stdout, '');
  const fromStdin = invoke(other, JSON.stringify({ cwd: repo })); assert.equal(fromStdin.status, 0); assert.match(JSON.parse(fromStdin.stdout).hookSpecificOutput.additionalContext, /交接测试/);
});

test('开工包末行和 JSON 提供同一确认码', t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-brief-ack-')), repo = join(base, 'repo'), home = join(base, 'home');
  mkdirSync(repo); mkdirSync(home); mkdirSync(join(repo, '.agent-router'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', repo]); writeFileSync(join(repo, '.agent-router/project.json'), '{}');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(base, 'claude') };
  const invoke = args => spawnSync(process.execPath, [cli, 'lead', 'brief', ...args], { cwd: repo, env, encoding: 'utf8' });
  const result = JSON.parse(invoke(['--json']).stdout);
  assert.equal(result.ack.files.length, 3);
  const last = invoke([]).stdout.trimEnd().split('\n').at(-1);
  assert.equal(last, `读完后确认：ar lead ack ${result.ack.token}（项目开了 leadStrict 时，派发、重试、合入前必须先确认）`);
  assert.equal(JSON.parse(invoke(['--hook']).stdout).hookSpecificOutput.additionalContext.split('\n').at(-1), last);
});

test('开工包读取期间文件变化时确认码仍对应展示的快照', async t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-brief-snapshot-')), repo = join(base, 'repo'), home = join(base, 'home');
  mkdirSync(join(repo, '.agent-router'), { recursive: true }); mkdirSync(home);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, '.agent-router/project.json'), '{}');
  writeFileSync(join(repo, 'handoff.md'), '读取前');
  const promise = leadBrief({ root: repo, home, coreDir: resolve('core'), env: { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(base, 'claude') } });
  writeFileSync(join(repo, 'handoff.md'), '读取后');
  const result = await promise;
  assert.equal(result.sections.find(section => section.title === '交接文件').text, '读取前');
  const files = result.ack.files.map((path, i) => ({ path, content: i === 0 ? '读取前' : i === 1 ? readFileSync(resolve('core/templates/lead-practices/checklist.md'), 'utf8') : '' }));
  assert.equal(result.ack.token, ackToken(files));
});
