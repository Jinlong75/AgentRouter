import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ar = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
test('spec check 的其他异常统一返回结构化结果', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-check-invalid-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/specs'), { recursive: true }); mkdirSync(join(root, '.agent-router')); mkdirSync(home);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const invalid = 'docs/specs/100-invalid.md', valid = 'docs/specs/101-valid.md', missing = 'docs/specs/missing.md';
  writeFileSync(join(root, invalid), '---\ntitle: 测试\ntype: 不存在的类型\n---\n');
  writeFileSync(join(root, valid), '---\ntitle: 测试\ntype: code\n---\n');
  writeFileSync(join(root, '.agent-router/project.json'), JSON.stringify({ baseBranch: 'main', worktree: false }));
  git('add', invalid, valid, '.agent-router/project.json'); git('commit', '-qm', 'fixture');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  const call = args => spawnSync(process.execPath, [ar, 'spec', 'check', ...args], { cwd: root, env, encoding: 'utf8', shell: false });
  for (const [spec, options] of [[invalid, []], [missing, []], [valid, ['--base', 'missing-branch']]]) {
    if (options.length) writeFileSync(join(root, '.agent-router/project.json'), JSON.stringify({ baseBranch: 'main', worktree: true }));
    const json = call([spec, ...options, '--json']), value = JSON.parse(json.stdout);
    assert.equal(json.status, 2); assert.equal(value.ok, false);
    assert.equal(value.errors[0].code, 'SPEC_INVALID'); assert.equal(value.errors[0].message, value.error);
    assert.equal(value.errors[0].file, spec); assert.equal(value.errors[0].line, null); assert.deepEqual(value.warnings, []);
    const plain = call([spec, ...options]);
    assert.equal(plain.status, 2); assert.ok((plain.stdout + plain.stderr).includes(value.error));
  }
  const usage = call([]);
  assert.equal(usage.status, 2); assert.match(usage.stdout + usage.stderr, /用法：ar spec check/);
});
test('spec check 与 dispatch 的结构化拒绝一致且没有记录', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-check-cli-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/specs'), { recursive: true }); mkdirSync(home);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 1, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true } } }));
  const spec = 'docs/specs/100-test.md';
  writeFileSync(join(root, spec), '---\ntitle: 测试 # 丢失\n---\n'); git('add', spec); git('commit', '-qm', 'fixture');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  const call = args => { const r = spawnSync(process.execPath, [ar, ...args, '--json'], { cwd: root, env, encoding: 'utf8', shell: false }); return { code: r.status, value: JSON.parse(r.stdout) }; };
  const checked = call(['spec', 'check', spec]), dispatched = call(['dispatch', spec]), next = call(['next', '--dispatch']);
  assert.equal(checked.code, 2); assert.equal(dispatched.code, 2); assert.equal(next.code, 2);
  assert.deepEqual(next.value.specCheck.errors, checked.value.errors);
  assert.deepEqual(dispatched.value.specCheck.errors, checked.value.errors);
  assert.equal(checked.value.error, checked.value.errors[0].message);
  assert.equal(existsSync(join(home, 'runs.jsonl')), false);
  assert.equal(existsSync(join(root, '.agent-runs')), false);
  assert.match(readFileSync(join(root, spec), 'utf8'), /丢失/);
});

test('worktree 检查所选基线，跨分支须显式指定基线', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-check-revision-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/specs'), { recursive: true }); mkdirSync(join(root, '.agent-router')); mkdirSync(home);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const spec = 'docs/specs/100-test.md';
  writeFileSync(join(root, '.agent-router/project.json'), JSON.stringify({ baseBranch: 'main', worktree: true }));
  writeFileSync(join(root, spec), '---\ntitle: 基线\n---\n'); git('add', '.agent-router/project.json', spec); git('commit', '-qm', 'base');
  git('switch', '-qc', 'stage'); writeFileSync(join(root, spec), '---\ntitle: 阶段 # 截断\n---\n'); git('add', spec); git('commit', '-qm', 'stage');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  const call = args => { const r = spawnSync(process.execPath, [ar, 'spec', 'check', spec, ...args, '--json'], { cwd: root, env, encoding: 'utf8', shell: false }); return { code: r.status, value: JSON.parse(r.stdout) }; };
  const implicit = call([]), main = call(['--base', 'main']), stage = call(['--base', 'stage']);
  assert.equal(implicit.code, 2); assert.equal(implicit.value.errors[0].code, 'SPEC_BASE');
  assert.equal(main.code, 0); assert.deepEqual(main.value.errors, []);
  assert.equal(stage.code, 2); assert.equal(stage.value.errors[0].code, 'SPEC_COMMENT');
  assert.equal(existsSync(join(home, 'runs.jsonl')), false); assert.equal(existsSync(join(root, '.agent-runs')), false);
});

test('非法检查配置在三个入口返回结构化结果', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-check-config-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/specs'), { recursive: true }); mkdirSync(join(root, '.agent-router')); mkdirSync(home);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const spec = 'docs/specs/100-test.md';
  writeFileSync(join(root, spec), '---\ntitle: 测试\nallowed_paths:\n  - src/**\n---\n');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 1, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true } } }));
  git('add', spec); git('commit', '-qm', 'fixture');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  const call = args => { const r = spawnSync(process.execPath, [ar, ...args, '--json'], { cwd: root, env, encoding: 'utf8', shell: false }); return { code: r.status, value: JSON.parse(r.stdout) }; };
  for (const [key, value] of [['fullExclusiveTimeoutMin', 0], ['specSplitWarning', 'false']]) {
    writeFileSync(join(root, '.agent-router/project.json'), JSON.stringify({ baseBranch: 'main', [key]: value }));
    const checked = call(['spec', 'check', spec]), dispatched = call(['dispatch', spec]), next = call(['next', '--dispatch']);
    assert.equal(checked.code, 2); assert.equal(dispatched.code, 2); assert.equal(next.code, 2);
    assert.match(checked.value.errors.find(e => e.code === 'SPEC_CONFIG').message, new RegExp(key));
    assert.deepEqual(dispatched.value.specCheck.errors, checked.value.errors); assert.deepEqual(next.value.specCheck.errors, checked.value.errors);
    assert.deepEqual(checked.value.warnings, []);
  }
  assert.equal(existsSync(join(root, '.agent-runs')), false);
});

test('基线缺少说明时三个入口返回结构化拒绝', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-check-missing-base-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/specs'), { recursive: true }); mkdirSync(join(root, '.agent-router')); mkdirSync(home);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, '.agent-router/project.json'), JSON.stringify({ baseBranch: 'main', worktree: true }));
  git('add', '.agent-router/project.json'); git('commit', '-qm', 'base');
  const spec = 'docs/specs/100-test.md'; writeFileSync(join(root, spec), '---\ntitle: 测试\n---\n');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 1, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true } } }));
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  const call = args => { const r = spawnSync(process.execPath, [ar, ...args, '--json'], { cwd: root, env, encoding: 'utf8', shell: false }); return { code: r.status, value: JSON.parse(r.stdout) }; };
  const checked = call(['spec', 'check', spec]), dispatched = call(['dispatch', spec]), next = call(['next', '--all', '--dispatch']);
  assert.equal(checked.code, 2); assert.equal(dispatched.code, 2); assert.equal(next.code, 2);
  assert.equal(checked.value.errors[0].code, 'SPEC_BASE'); assert.deepEqual(checked.value.warnings, []);
  assert.deepEqual(dispatched.value.specCheck.errors, checked.value.errors);
  assert.deepEqual(next.value.specCheck.errors, checked.value.errors);
});

for (const mode of ['dispatch', 'next', 'spec check', 'next 无项目基线']) {
  test(`${mode}：跨分支使用正确的派发模式`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-check-mode-')), root = join(dir, 'repo'), home = join(dir, 'home');
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    mkdirSync(join(root, 'docs/specs'), { recursive: true }); mkdirSync(join(root, '.agent-router')); mkdirSync(home);
    const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); assert.equal(r.status, 0, r.stderr); };
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    const worktree = mode === 'next 无项目基线', spec = 'docs/specs/100-test.md';
    writeFileSync(join(root, '.gitignore'), '.agent-runs/\n');
    writeFileSync(join(root, '.agent-router/project.json'), JSON.stringify(worktree ? { worktree: true } : { baseBranch: 'main', worktree: false }));
    writeFileSync(join(root, spec), '---\ntitle: 测试\ntype: code\nexpect_commit: false\nallowed_paths:\n  - src/**\n---\n');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 1, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true, events: [], report: '完成', exit: 0 } } }));
    git('add', '.gitignore', '.agent-router/project.json', spec); git('commit', '-qm', 'fixture'); git('switch', '-qc', 'stage');
    const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', AR_WORKTREE_ROOT: join(dir, 'worktrees') };
    const call = args => { const r = spawnSync(process.execPath, [ar, ...args, '--json'], { cwd: root, env, encoding: 'utf8', shell: false, timeout: 70000 }); assert.equal(r.status, 0, r.stderr || r.stdout); return JSON.parse(r.stdout); };
    const args = mode === 'dispatch' ? ['dispatch', spec, '--detach'] : mode === 'spec check' ? ['spec', 'check', spec] : ['next', '--dispatch'];
    const result = call(args);
    if (mode === 'spec check') { assert.equal(result.ok, true); assert.deepEqual(result.errors, []); return; }
    const name = mode === 'dispatch' ? result.name : result.dispatched[0];
    assert.ok(name); call(['wait', name, '--timeout', '60']);
    const records = readFileSync(join(home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const start = records.find(row => row.event === 'start');
    if (worktree) assert.equal(start.baseBranch, 'stage');
    else assert.equal(start.baseBranch, undefined);
  });
}
