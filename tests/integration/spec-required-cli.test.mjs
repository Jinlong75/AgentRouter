import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../../core/lib/cli.mjs';

test('缺少字段的派发在创建记录之前拒绝', t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-spec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home); mkdirSync(join(root, '.agent-router'));
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ specRequired: { fields: ['effort'] } }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '完成', exit: 0 } }, defaultProfile: 'fake' }));
  writeFileSync(join(root, 'task.md'), '---\ntype: code\n---\n任务\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const result = spawnSync(process.execPath, [resolve('core/ar.mjs'), 'dispatch', 'task.md', '--profile', 'fake'], { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home }, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /任务说明缺少必填项：task\.md：字段 effort（项目配置 specRequired）/);
  assert.equal(existsSync(join(root, '.agent-runs')), false);
  writeFileSync(join(root, 'task.md'), '---\ntype: docs\neffort: high\n---\n任务\n');
  const success = spawnSync(process.execPath, [resolve('core/ar.mjs'), 'dispatch', 'task.md', '--profile', 'fake'], { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home, AR_TEST_AGENT: '1' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(success.status, 0, success.stderr + success.stdout);
});

test('next 跳过缺项说明并继续派发', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-required-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = join(dir, 'repo'), home = join(dir, 'home');
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(join(root, '.agent-router')); mkdirSync(home);
  const git = (...args) => execFileSync('git', args, { cwd: root });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ baseBranch: 'main', worktree: true, specRequired: { fields: ['effort'] } }));
  writeFileSync(join(root, '.gitignore'), '.agent-runs/\n');
  for (const [id, effort] of [['100', ''], ['101', 'effort: high\n']]) writeFileSync(join(root, 'docs', 'specs', `${id}-test.md`), `---\ntitle: 任务${id}\ntype: code\nexpect_commit: false\nallowed_paths:\n  - src/${id}\n${effort}---\n任务\n`);
  git('add', '.gitignore', '.agent-router/project.json', 'docs/specs'); git('commit', '-qm', 'fixtures');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 1, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true, events: [], report: '完成', exit: 0 } } }));
  const script = resolve('core/ar.mjs');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: join(dir, 'worktrees'), AR_NO_WATCH: '1', AR_TEST_AGENT: '1' };
  const out = []; const code = await main(['next', '--dispatch', '--json'], { cwd: root, env, scriptPath: script, out: line => out.push(line) });
  assert.equal(code, 0, out.join('\n'));
  const result = JSON.parse(out[0]);
  assert.match(result.skipped[0], /任务说明缺少必填项：100-test\.md：字段 effort/);
  assert.equal(result.dispatched.length, 1);
  const waited = spawnSync(process.execPath, [script, 'wait', result.dispatched[0], '--timeout', '60', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 70000 });
  assert.equal(waited.status, 0, waited.stderr || waited.stdout);
});

function nextFixture(t, specs, required) {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-validation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = join(dir, 'repo'), home = join(dir, 'home');
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(join(root, '.agent-router')); mkdirSync(home);
  const git = (...args) => execFileSync('git', args, { cwd: root });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ baseBranch: 'main', worktree: true, ...(required ? { specRequired: required } : {}) }));
  writeFileSync(join(root, '.gitignore'), '.agent-runs/\n');
  for (const [file, content] of Object.entries(specs)) writeFileSync(join(root, 'docs', 'specs', file), content);
  git('add', '.gitignore', '.agent-router/project.json', 'docs/specs'); git('commit', '-qm', 'fixtures');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 1, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true, events: [], report: '完成', exit: 0 } } }));
  const script = resolve('core/ar.mjs');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'absent-claude'), AR_WORKTREE_ROOT: join(dir, 'worktrees'), AR_NO_WATCH: '1', AR_TEST_AGENT: '1' };
  const cli = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8', timeout: 70000 });
  return { cli };
}

test('缺必填项不占全仓范围，原因与直接派发一致', t => {
  const { cli } = nextFixture(t, {
    '100-test.md': '---\ntitle: 缺项任务\ntype: code\nexpect_commit: false\n---\n任务\n',
    '101-test.md': '---\ntitle: 有效任务\ntype: code\nexpect_commit: false\neffort: high\n---\n# 验收\n# 自测\n',
  }, { fields: ['effort'], sections: ['验收', '自测'] });
  const direct = cli('dispatch', 'docs/specs/100-test.md', '--profile', 'fake', '--json');
  assert.equal(direct.status, 2);
  const reason = JSON.parse(direct.stdout).error;
  const text = cli('next');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /缺必填项（1）：/);
  assert.match(text.stdout, /可以派发（1）：\n  101 有效任务/);
  assert.ok(text.stdout.includes(`  100 缺项任务：${reason}`));
  const dispatched = cli('next', '--dispatch', '--json');
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const result = JSON.parse(dispatched.stdout);
  assert.equal(result.skipped[0], reason);
  assert.equal(result.candidates[0].missing, reason);
  assert.equal(result.dispatched.length, 1);
  t.diagnostic(`文字样例：${text.stdout.match(/缺必填项（1）：\n  [^\n]+/)[0]}；JSON 样例：${JSON.stringify({ candidate: result.candidates[0], skipped: result.skipped })}`);
  const waited = cli('wait', result.dispatched[0], '--timeout', '60', '--json');
  assert.equal(waited.status, 0, waited.stderr || waited.stdout);
});

test('无效说明列出直接派发的原始错误且不阻挡有效说明', t => {
  const specs = {};
  for (const [id, field] of [['100', 'effort: ""'], ['101', 'model: ""'], ['102', 'reviewer: []']]) {
    specs[`${id}-test.md`] = `---\ntype: code\nallowed_paths:\n  - src/${id}\n${field}\n---\n# 任务${id}\n`;
  }
  specs['103-test.md'] = '---\ntitle: 有效任务\ntype: code\nexpect_commit: false\nallowed_paths:\n  - src/103\n---\n任务\n';
  const { cli } = nextFixture(t, specs);
  const errors = ['100', '101', '102'].map(id => {
    const result = cli('dispatch', `docs/specs/${id}-test.md`, '--profile', 'fake', '--json');
    assert.equal(result.status, 2);
    return JSON.parse(result.stdout).error;
  });
  const text = cli('next');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /说明无效（3）：/);
  for (const [index, id] of ['100', '101', '102'].entries()) assert.ok(text.stdout.includes(`  ${id} 任务${id}：${errors[index]}`));
  const dispatched = cli('next', '--dispatch', '--json');
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const result = JSON.parse(dispatched.stdout);
  assert.equal(result.invalid.length, 3);
  for (const [index, id] of ['100', '101', '102'].entries()) {
    assert.equal(result.invalid[index], `说明无效：docs/specs/${id}-test.md：${errors[index]}`);
    assert.equal(result.candidates[index].invalid, errors[index]);
  }
  assert.equal(result.dispatched.length, 1);
  t.diagnostic(`文字样例：${text.stdout.match(/说明无效（3）：\n(?:  [^\n]+\n){3}/)[0].trim()}；JSON 样例：${JSON.stringify({ candidate: result.candidates[0], invalid: result.invalid })}`);
  const waited = cli('wait', result.dispatched[0], '--timeout', '60', '--json');
  assert.equal(waited.status, 0, waited.stderr || waited.stdout);
});
