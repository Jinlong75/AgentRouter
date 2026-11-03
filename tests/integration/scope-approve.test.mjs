import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quoteRetryNames } from '../../core/lib/scope.mjs';

const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
function fixture(t, { worktree = false, name = '测试', empty = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ar-340-')), repo = join(base, 'repo'), home = join(base, 'home');
  mkdirSync(repo); mkdirSync(home); mkdirSync(join(repo, 'docs'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', '测试'); git('config', 'user.email', 'test@example.test'); git('config', 'core.autocrlf', 'false'); git('config', 'commit.gpgsign', 'false');
  const spec = 'docs/001.md';
  const original = '---\r\nid: 1\r\ntitle: 测试\r\ntype: code\r\nallowed_paths: # 保留\r\n  - "src/a" # 原有\r\nverify:\r\n  - node -e "process.exit(1)"\r\n---\r\n正文\r\n';
  writeFileSync(join(repo, spec), empty === null ? original : original.replace('allowed_paths: # 保留\r\n  - "src/a" # 原有', empty)); writeFileSync(join(repo, '.gitignore'), '.agent-runs/\n');
  if (empty !== null) {
    mkdirSync(join(repo, '.agent-router'));
    writeFileSync(join(repo, '.agent-router', 'project.json'), JSON.stringify({ allowedPaths: ['src/a'] }));
    git('add', '--', '.agent-router/project.json');
  }
  if (worktree) {
    mkdirSync(join(repo, '.agent-router'));
    writeFileSync(join(repo, '.agent-router', 'project.json'), JSON.stringify({ worktree: true, baseBranch: git('branch', '--show-current').trim() }));
    git('add', '--', '.agent-router/project.json');
  }
  git('add', '--', spec, '.gitignore'); git('commit', '-qm', '初始');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true, report: '## 需要越界\n- src/b：理由\n- src/c\n', events: [], exit: 0 } } }));
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: join(base, 'worktrees'), AR_NO_WATCH: '1' };
  for (const key of ['AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  const ar = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: repo, env, encoding: 'utf8', windowsHide: true });
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dispatched = ar('dispatch', spec, '--name', name, '--json');
  assert.equal(dispatched.status, 3, dispatched.stderr + dispatched.stdout);
  return { repo, home, git, ar, spec, original };
}
test('预览只读，路径验证及重复参数', t => {
  const f = fixture(t), head = f.git('rev-parse', 'HEAD');
  const preview = f.ar('scope', 'approve', '测试', '--paths', 'src/b', 'src/b', '--dry-run', '--json');
  assert.equal(preview.status, 0, preview.stderr + preview.stdout);
  const value = JSON.parse(preview.stdout);
  assert.deepEqual(value.paths, ['src/b']); assert.equal(value.commit, null); assert.match(value.note, /<hash>/);
  assert.equal(readFileSync(join(f.repo, f.spec), 'utf8'), f.original); assert.equal(f.git('rev-parse', 'HEAD'), head);
  for (const args of [['--paths'], ['--paths', '../x'], ['--paths', 'src/*'], ['--paths', 'src/b', '--paths', 'src/c'], ['--dry-run', '--dry-run']]) {
    assert.equal(f.ar('scope', 'approve', '测试', ...args, '--json').status, 2, args.join(' '));
  }
  assert.equal(readFileSync(join(f.repo, f.spec), 'utf8'), f.original); assert.equal(f.git('rev-parse', 'HEAD'), head);
});
test('提交只包含说明，保留其他暂存文件，重试收到提交号', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'other.txt'), '保留\n'); f.git('add', '--', 'other.txt');
  const result = f.ar('scope', 'approve', '测试', '--paths', 'src/b', '--json');
  assert.equal(result.status, 3, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout); assert.match(value.commit, /^[a-f0-9]{40,64}$/); assert.match(value.note, new RegExp(value.commit));
  assert.equal(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim(), f.spec);
  assert.equal(f.git('diff', '--cached', '--name-only').trim(), 'other.txt');
  const text = readFileSync(join(f.repo, f.spec), 'utf8');
  assert.ok(text.includes('allowed_paths: # 保留\r\n  - "src/a" # 原有\r\n  - "src/b"\r\n  - "docs/001.md"\r\n'));
  assert.ok(!text.includes('"src/c"'));
  const prompt = readFileSync(join(f.repo, '.agent-runs', '测试', 'attempts', '2', 'prompt.md'), 'utf8');
  assert.ok(prompt.includes(value.note));
});

test('默认全选；提交失败保留现场并且不重试', t => {
  const f = fixture(t), head = f.git('rev-parse', 'HEAD');
  f.git('config', 'commit.gpgsign', 'true');
  f.git('config', 'gpg.program', 'ar-test-missing-signer');
  const result = f.ar('scope', 'approve', '测试', '--json');
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.match(JSON.parse(result.stdout).error, /git commit/);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  const text = readFileSync(join(f.repo, f.spec), 'utf8');
  assert.ok(text.includes('"src/b"') && text.includes('"src/c"'));
  assert.equal(f.git('diff', '--cached', '--name-only').trim(), f.spec);
  const rows = readFileSync(join(f.home, 'runs.jsonl'), 'utf8');
  assert.ok(!rows.includes('"event":"resume"'));
});

test('说明有未提交修改时拒绝且保留原样', t => {
  const f = fixture(t), head = f.git('rev-parse', 'HEAD');
  const dirty = f.original + '未提交\r\n';
  writeFileSync(join(f.repo, f.spec), dirty);
  const result = f.ar('scope', 'approve', '测试', '--json');
  assert.equal(result.status, 2);
  assert.match(JSON.parse(result.stdout).error, /未提交/);
  assert.equal(readFileSync(join(f.repo, f.spec), 'utf8'), dirty);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
});

test('批准后实际门禁接受新增范围', t => {
  const f = fixture(t);
  const configFile = join(f.home, 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.profiles.fake.writes = [{ path: 'src/b', content: '完成\n' }];
  config.profiles.fake.commit = '假执行者完成';
  writeFileSync(configFile, JSON.stringify(config));
  const result = f.ar('scope', 'approve', '测试', '--json');
  assert.equal(result.status, 3, result.stderr + result.stdout);
  const gate = JSON.parse(readFileSync(join(f.repo, '.agent-runs', '测试', 'attempts', '2', 'gate.json'), 'utf8'));
  assert.ok(gate.scope.allowed.includes('src/b'));
  assert.ok(gate.scope.changed.includes('src/b'));
  assert.deepEqual(gate.scope.outside, []);
  assert.equal(readFileSync(join(f.repo, 'src/b'), 'utf8'), '完成\n');
});

test('最新尝试启动失败没有汇报时不使用上一轮申请', t => {
  const f = fixture(t), registry = join(f.home, 'runs.jsonl');
  const rows = readFileSync(registry, 'utf8').trim().split('\n').map(JSON.parse);
  const id = rows.find(row => row.event === 'start').id;
  writeFileSync(registry, `${readFileSync(registry, 'utf8')}${JSON.stringify({ v: 1, event: 'resume', id, n: 2 })}\n${JSON.stringify({ v: 1, event: 'end', id, exit: 1, attempts: 2 })}\n`);
  const before = f.git('rev-parse', 'HEAD');
  const result = f.ar('scope', 'approve', '测试', '--json');
  assert.equal(result.status, 2);
  assert.match(JSON.parse(result.stdout).error, /最新一次尝试没有汇报/);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
});

test('批准后的重试被拒及后续两次手动重试都保留批准说明来源', t => {
  const f = fixture(t, { worktree: true });
  const file = join(f.home, 'config.json'), config = JSON.parse(readFileSync(file, 'utf8'));
  config.profiles.fake.enabled = false;
  writeFileSync(file, JSON.stringify(config));
  const approved = f.ar('scope', 'approve', '测试', '--json');
  assert.equal(approved.status, 2, approved.stderr + approved.stdout);
  const result = JSON.parse(approved.stdout);
  assert.match(result.commit, /^[a-f0-9]{40,64}$/);
  assert.ok(result.error);
  assert.equal(JSON.parse(readFileSync(join(f.repo, '.agent-runs', '测试', 'dispatch.json'), 'utf8')).scopeCommit, result.commit);
  config.profiles.fake.enabled = true;
  writeFileSync(file, JSON.stringify(config));
  for (const n of [2, 3]) {
    const retry = f.ar('retry', '测试', '--note', '继续', '--json');
    assert.equal(retry.status, 3, retry.stderr + retry.stdout);
    const gate = JSON.parse(readFileSync(join(f.repo, '.agent-runs', '测试', 'attempts', String(n), 'gate.json'), 'utf8'));
    assert.ok(gate.scope.allowed.includes('src/b'));
    assert.ok(gate.scope.allowed.includes('src/c'));
  }
});

test('文本模式重试失败提示具体门禁原因', t => {
  const f = fixture(t);
  const result = f.ar('scope', 'approve', '测试');
  assert.equal(result.status, 3, result.stderr + result.stdout);
  assert.match(result.stdout, /重试失败：门禁未通过：/);
  assert.match(result.stdout, /说明提交 [a-f0-9]{40,64}/);
});


test('空允许列表保留项目范围并追加批准路径', t => {
  for (const empty of ['allowed_paths: []', 'allowed_paths: # 保留']) {
    const f = fixture(t, { empty });
    const file = join(f.home, 'config.json'), config = JSON.parse(readFileSync(file, 'utf8'));
    config.profiles.fake.writes = [{ path: 'src/a', content: '甲\n' }, { path: 'src/b', content: '乙\n' }];
    config.profiles.fake.commit = '假执行者完成';
    writeFileSync(file, JSON.stringify(config));
    const result = f.ar('scope', 'approve', '测试', '--paths', 'src/b', '--json');
    assert.equal(result.status, 3, result.stderr + result.stdout);
    const gate = JSON.parse(readFileSync(join(f.repo, '.agent-runs', '测试', 'attempts', '2', 'gate.json'), 'utf8'));
    assert.ok(gate.scope.allowed.includes('src/a')); assert.ok(gate.scope.allowed.includes('src/b'));
    assert.ok(gate.scope.changed.includes('src/a')); assert.ok(gate.scope.changed.includes('src/b'));
    assert.deepEqual(gate.scope.outside, []);
  }
});

test('失败提示的记录名安全引用，命令不包含 note', t => {
  assert.deepEqual(quoteRetryNames('记录 "一"'), { posix: `'记录 "一"'`, powershell: `'记录 "一"'` });
  assert.deepEqual(quoteRetryNames("a'$`b"), { posix: "'a'\\''$`b'", powershell: "'a''$`b'" });
  const f = fixture(t, { name: '测试 一' });
  const result = f.ar('scope', 'approve', '测试 一');
  assert.match(result.stdout, /PowerShell）：ar retry '测试 一'；POSIX shell：ar retry '测试 一'/);
  assert.doesNotMatch(result.stdout, /请手动重试[^\n]*--note/);
});

test('脱离批准可等待重试，重复选项拒绝，预览不重试', t => {
  const f = fixture(t), head = f.git('rev-parse', 'HEAD');
  const duplicate = f.ar('scope', 'approve', '测试', '--detach', '--detach', '--json');
  assert.equal(duplicate.status, 2);
  const preview = f.ar('scope', 'approve', '测试', '--detach', '--dry-run', '--json');
  assert.equal(preview.status, 0); assert.equal(JSON.parse(preview.stdout).dryRun, true);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.ok(!readFileSync(join(f.home, 'runs.jsonl'), 'utf8').includes('"event":"resume"'));
  const result = f.ar('scope', 'approve', '测试', '--paths', 'src/b', '--detach', '--json');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.exit, 0); assert.equal(value.detached, true);
  const waited = f.ar('wait', '测试', '--timeout', '30', '--json');
  assert.equal(waited.status, 3, waited.stderr + waited.stdout);
  const prompt = readFileSync(join(f.repo, '.agent-runs', '测试', 'attempts', '2', 'prompt.md'), 'utf8');
  assert.ok(prompt.includes(value.note)); assert.match(prompt, /src\/b/);
});
