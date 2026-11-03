import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t, { review = true, gate = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ar-hard-'));
  const repo = join(base, 'repo'), home = join(base, 'home'), wt = join(base, 'wt');
  mkdirSync(repo); mkdirSync(home);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Test']); git(repo, ['config', 'user.email', 'test@example.test']);
  mkdirSync(join(repo, '.agent-router')); mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, '.gitignore'), '.agent-runs/\n');
  writeFileSync(join(repo, '.agent-router', 'project.json'), JSON.stringify({ baseBranch: 'main' }));
  writeFileSync(join(repo, 'docs', 'spec.md'), `---\nid: 1\ntitle: Test\ntype: code\nreview: ${review}\n---\n`);
  git(repo, ['add', '.gitignore', '.agent-router/project.json', 'docs/spec.md']); git(repo, ['commit', '-qm', 'base']);
  const sha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['worktree', 'add', '-qb', 'task', wt]);
  const dir = join(repo, '.agent-runs', 'task'); mkdirSync(join(dir, 'attempts', '1'), { recursive: true });
  const write = (name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
  write('dispatch.json', { v: 1, task: 'test', extra: '', role: null, profile: 'fake', name: 'task', spec: 'docs/spec.md', gate: { enabled: gate } });
  write('gate.json', { ok: true, head: sha });
  write('review.json', { verdict: 'concerns', head: sha, issues: [{ id: 'R1-1', confirmation: { result: 'valid' } }, { id: 'R1-2', confirmation: null }] });
  write('attempts/1/report.md', '## 已知问题\n无\n## 需要越界\n无。\n');
  const rows = [{ event: 'start', id: 'x', name: 'task', repo, worktree: true, base: sha, spec: 'docs/spec.md' }, { event: 'worktree', id: 'x', dir: wt, branch: 'task' }, { event: 'attempt', id: 'x', n: 1 }, ...(review ? [{ event: 'reviewing', id: 'x', attempt: 1 }] : []), { event: 'end', id: 'x', exit: 0 }];
  writeFileSync(join(home, 'runs.jsonl'), rows.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true } } }));
  const ar = (...args) => spawnSync(process.execPath, [script, 'accept', 'task', ...args], { cwd: repo, env: { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: join(base, 'other-wt') }, encoding: 'utf8', windowsHide: true });
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { ar, write, sha, wt, repo, home, dir };
}

test('逐条确认与报告、HEAD 检查，失败不清理，修正后确认', t => {
  const f = fixture(t);
  let r = f.ar('--json');
  assert.equal(r.status, 2); assert.match(r.stdout, /R1-2/); assert.ok(existsSync(f.wt));
  f.write('review.json', { verdict: 'concerns', head: 'old', issues: [{ id: 'R1-2', confirmation: { result: 'invalid' } }] });
  f.write('gate.json', { ok: true, head: 'old' });
  f.write('attempts/1/report.md', '## 已知问题\n有问题\n## 需要越界\n有问题\n');
  r = f.ar('--json'); assert.equal(r.status, 2); assert.match(r.stdout, /门禁.*过期/); assert.match(r.stdout, /审查.*过期/); assert.match(r.stdout, /--regate/); assert.match(r.stdout, /已知问题/); assert.match(r.stdout, /需要越界/);
  f.write('gate.json', { ok: true, head: f.sha });
  f.write('review.json', { verdict: 'pass', head: f.sha, issues: [] });
  r = f.ar('--ack', '已核对', '--json'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout); assert.equal(result.mode, 'confirm'); assert.equal(result.checks.ack, '已核对'); assert.deepEqual(result.checks.failures, []);
});

test('审查依据执行记录与已有结果，不受验收时配置变化影响', async t => {
  await t.test('说明改掉或删除且项目关闭审查，已有结果仍检查', t => {
    const f = fixture(t);
    writeFileSync(join(f.repo, '.agent-router', 'project.json'), JSON.stringify({ baseBranch: 'main', review: { default: false } }));
    for (const action of ['change', 'delete']) {
      if (action === 'change') writeFileSync(join(f.repo, 'docs', 'spec.md'), '---\nid: 1\ntype: code\nreview: false\n---\n');
      else rmSync(join(f.repo, 'docs', 'spec.md'));
      const r = f.ar('--json'); assert.equal(r.status, 2); assert.match(r.stdout, /R1-2/);
    }
  });
  await t.test('执行时未启用，验收时打开也不挡', t => {
    const f = fixture(t, { review: false }); rmSync(join(f.dir, 'review.json'));
    writeFileSync(join(f.repo, '.agent-router', 'project.json'), JSON.stringify({ baseBranch: 'main', review: { default: true } }));
    assert.equal(f.ar('--json').status, 0);
  });
  await t.test('审查事件存在而结果缺失', t => {
    const f = fixture(t, { review: false }); rmSync(join(f.dir, 'review.json'));
    const file = join(f.home, 'runs.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ v: 1, event: 'reviewing', id: 'x' }) + '\n');
    const r = f.ar('--json'); assert.equal(r.status, 2); assert.match(r.stdout, /缺少有效审查/);
  });
});

test('汇报忽略代码围栏，逐个检查重复小节和空正文', async t => {
  for (const [name, report, expected, message = /已知问题/] of [
    ['空白', '## 已知问题\n \n## 需要越界\n\t\n', 0],
    ['分散空白的无', '## 已知问题\n 没 有 。\n## 需要越界\n 无 。\n', 0],
    ['重复标题有内容', '## 已知问题\n无\n## 已知问题\n有问题\n## 需要越界\n无\n', 2],
    ['代码块中的标题和内容', '```md\n## 已知问题\n有问题\n```\n## 已知问题\n无\n## 需要越界\n~~~md\n有问题\n## 其他\n~~~\n无\n', 0],
    ['只有代码块标题', '```\n## 已知问题\n无\n```\n## 需要越界\n无\n', 2],
    ['没有需要越界一节', '## 已知问题\n无\n', 0],
    ['只有需要越界有内容', '## 已知问题\n无\n## 需要越界\n- core/x.mjs：原因\n', 2, /需要越界/],
    ['缺已知问题', '## 需要越界\n无\n', 2, /已知问题/],
  ]) await t.test(name, t => {
    const f = fixture(t); f.write('review.json', { verdict: 'pass', head: f.sha, issues: [] });
    f.write('attempts/1/report.md', report);
    const r = f.ar('--json'); assert.equal(r.status, expected, r.stdout + r.stderr);
    if (expected) assert.match(r.stdout, message);
  });
});

test('force 留痕，human 提醒，原有脏工作区检查仍有效', async t => {
  await t.test('force', t => {
    const f = fixture(t); assert.equal(f.ar('--force', '--json').status, 2);
    const r = f.ar('--force', '--reason', '已复核', '--json'); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(JSON.parse(r.stdout).checks.override.failures.join(' '), /R1-2/);
    const row = readFileSync(join(f.home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(x => x.event === 'accepted');
    assert.equal(row.override.reason, '已复核');
  });
  await t.test('human', t => {
    const f = fixture(t); writeFileSync(join(f.wt, 'dirty'), 'dirty');
    assert.equal(f.ar('--by', 'human', '--json').status, 2);
    rmSync(join(f.wt, 'dirty'));
    const r = f.ar('--by', 'human'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /验收提醒：.*R1-2/);
  });
  await t.test('human 合并并记录警告', t => {
    const f = fixture(t); writeFileSync(join(f.wt, 'change.txt'), 'changed');
    git(f.wt, ['add', 'change.txt']); git(f.wt, ['commit', '-qm', 'change']);
    const r = f.ar('--by', 'human', '--json'); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).mode, 'no-ff');
    const row = readFileSync(join(f.home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(x => x.event === 'accepted');
    assert.ok(row.warnings.some(warning => warning.includes('R1-2')));
  });
});

test('不启用门禁和审查时无需证据；缺绑定的旧证据只提醒', async t => {
  await t.test('未启用', t => { const f = fixture(t, { gate: false, review: false }); rmSync(join(f.dir, 'gate.json')); rmSync(join(f.dir, 'review.json')); assert.equal(f.ar('--json').status, 0); });
  await t.test('旧证据', t => { const f = fixture(t); f.write('gate.json', { ok: true }); f.write('review.json', { verdict: 'pass', issues: [] }); const r = f.ar('--json'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(JSON.parse(r.stdout).checks.warnings.join(' '), /无法核对证据对应的提交/); });
});

test('缺证据、参数边界与逐条确认', async t => {
  await t.test('缺失门禁和审查', t => {
    const f = fixture(t); rmSync(join(f.dir, 'gate.json')); rmSync(join(f.dir, 'review.json'));
    const r = f.ar('--json'); assert.equal(r.status, 2); assert.match(r.stdout, /缺少有效门禁/); assert.match(r.stdout, /缺少有效审查/);
  });
  await t.test('空参数与单独原因', t => {
    const f = fixture(t);
    for (const args of [['--ack', ' '], ['--reason', '原因'], ['--force', '--reason', ' ']]) assert.equal(f.ar(...args, '--json').status, 2);
    assert.ok(existsSync(f.wt));
  });
  await t.test('全部确认并接受无和没有', t => {
    const f = fixture(t);
    f.write('review.json', { verdict: 'concerns', head: f.sha, issues: [{ id: 'R1-1', confirmation: { result: 'valid' } }, { id: 'R1-2', confirmation: { result: 'invalid' } }] });
    f.write('attempts/1/report.md', '## 已知问题\n没有。\n## 需要越界\n没有\n');
    const r = f.ar('--json'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.deepEqual(JSON.parse(r.stdout).checks.failures, []);
  });
  await t.test('只读任务不要求审查，仍要求启用的门禁', t => {
    const f = fixture(t);
    f.write('dispatch.json', { v: 1, task: 'test', extra: '', role: null, profile: 'fake', name: 'task', spec: 'docs/spec.md', gate: { enabled: true, readOnly: true } });
    rmSync(join(f.dir, 'review.json')); rmSync(join(f.dir, 'gate.json'));
    // 真实路径里只读任务不进审查阶段，记录里没有 reviewing。
    const runs = join(f.home, 'runs.jsonl'); writeFileSync(runs, readFileSync(runs, 'utf8').split('\n').filter(line => !line.includes('"reviewing"')).join('\n'));
    const r = f.ar('--json'); assert.equal(r.status, 2); assert.match(r.stdout, /缺少有效门禁/); assert.doesNotMatch(r.stdout, /缺少有效审查/);
    f.write('gate.json', { ok: true, head: f.sha }); assert.equal(f.ar('--json').status, 0);
  });
});
