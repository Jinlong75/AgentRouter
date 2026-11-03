import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
test('文字类型路由与参数校验', t => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-chore-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home');
  mkdirSync(repo); mkdirSync(home);
  const git = args => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git(['init', '-q']); git(['config', 'user.name', '测试']); git(['config', 'user.email', 'test@example.test']);
  writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
  git(['add', '--', '.gitignore']); git(['commit', '-q', '-m', '初始']);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  delete env.AR_PROFILE; delete env.AR_DRY_RUN; delete env.AR_TEST_AGENT;
  const fake = { adapter: 'fake', enabled: true, events: [], report: '完成', exit: 0 };
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', profiles: { a: fake, b: fake }, routing: { rules: [{ types: ['research'], profile: 'a' }, { types: ['chore'], profile: 'b' }] } }));
  const ar = args => spawnSync(process.execPath, [script, ...args, '--json'], { cwd: repo, env, encoding: 'utf8' });
  for (const [type, profile] of [['research', 'a'], ['chore', 'b']]) {
    const result = ar(['dispatch', '整理日志', '--type', type]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const rows = readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const start = rows.filter(row => row.event === 'start').at(-1);
    assert.equal(start.profile, profile); assert.equal(start.type, type);
    assert.equal(start.readOnly === true, type === 'research'); assert.notEqual(start.worktree, true);
  }
  writeFileSync(path.join(repo, 'task.md'), '正文');
  const rejected = ar(['dispatch', 'task.md', '--type', 'chore']);
  assert.equal(rejected.status, 2); assert.match(rejected.stdout, /--type 只用于直接写任务文字的派发，任务说明的类型写在 frontmatter/);
  assert.equal(ar(['dispatch', '文字', '--type', 'bad']).status, 2);
});

test('文字调研的只读门禁检查工作区改动', t => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-text-readonly-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home');
  mkdirSync(repo); mkdirSync(home);
  const git = args => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git(['init', '-q']); git(['config', 'user.name', '测试']); git(['config', 'user.email', 'test@example.test']);
  writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
  git(['add', '--', '.gitignore']); git(['commit', '-q', '-m', '初始']);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', USERPROFILE: base, HOME: base, APPDATA: base };
  delete env.AR_PROFILE; delete env.AR_DRY_RUN; delete env.AR_TEST_AGENT;
  const dispatch = (name, writes) => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', writes } } }));
    return spawnSync(process.execPath, [script, 'dispatch', '调研文字', '--type', 'research', '--name', name, '--json'], { cwd: repo, env, encoding: 'utf8' });
  };
  const clean = dispatch('clean', []);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  const cleanGate = JSON.parse(readFileSync(path.join(repo, '.agent-runs', 'clean', 'gate.json'), 'utf8'));
  assert.equal(cleanGate.ok, true); assert.deepEqual(cleanGate.commands, []); assert.equal(cleanGate.commit.required, false);
  const dirty = dispatch('dirty', [{ path: 'changed.txt', content: '改动' }]);
  assert.equal(dirty.status, 3, dirty.stdout + dirty.stderr);
  const dirtyGate = JSON.parse(readFileSync(path.join(repo, '.agent-runs', 'dirty', 'gate.json'), 'utf8'));
  assert.equal(dirtyGate.summary, '只读任务改动了文件：changed.txt');
  const rows = readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.event === 'end').at(-1).exit, 3);
});
