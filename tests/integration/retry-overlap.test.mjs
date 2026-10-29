import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 手动重试也检查改动范围重叠（Stage07c 152）端到端：真实 git 仓库在系统临时目录里，
// AGENT_ROUTER_HOME、AR_WORKTREE_ROOT、CLAUDE_CONFIG_DIR 都指向用例自己的临时目录，执行者是 fake。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const rows = home => {
  try { return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
};
async function until(fn, label, timeout = 60000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

const specText = allowed => ['---', 'id: 901', 'title: 重试重叠测试', 'type: code', 'expect_commit: true', 'max_retries: 0', 'allowed_paths:', ...allowed.map(item => `  - ${item}`), '---', '', '测试说明正文。', ''].join('\n');

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-retry-overlap-'));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'wt'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_TEST_LOAD_FILE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '重试重叠测试']);
  git(repo, ['config', 'user.email', 'retry-overlap@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'docs/readme.md'), '说明\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({
    v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true,
  }, null, 2));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 };
  const f = { base, repo, home, env, profile };
  // 执行者配置在派发时取快照：改了再派发的任务才用新配置；ar retry 重新读配置。
  f.setProfile = value => {
    for (const key of Object.keys(profile)) delete profile[key];
    Object.assign(profile, { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 }, value);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile }, concurrency: 4 }));
  };
  f.setProfile({});
  f.spec = (rel, allowed) => {
    write(path.join(repo, rel), specText(allowed));
    git(repo, ['add', '--', rel]);
    git(repo, ['commit', '-q', '-m', `任务说明 ${path.basename(rel)}`]);
    return rel;
  };
  f.ar = (args, timeout = 90000) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  f.dispatch = async (spec, name) => {
    const result = await f.ar(['dispatch', spec, '--name', name, '--detach', '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout).id;
  };
  f.retry = async name => {
    const result = await f.ar(['retry', name, '--detach', '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout).id;
  };
  // 派发一个会失败的任务（假执行者不提交，门禁报“没有提交任何改动”），等它结束。
  f.fail = async (spec, name) => {
    f.setProfile({});
    const id = await f.dispatch(spec, name);
    const end = await until(() => f.events(id).find(row => row.event === 'end'), `${name} 结束`);
    assert.notEqual(end.exit, 0, `${name} 应该失败`);
    return id;
  };
  f.events = id => rows(home).filter(row => row.id === id);
  f.has = (id, event) => rows(home).some(row => row.id === id && row.event === event);
  f.progress = name => { try { return readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8'); } catch { return ''; } };
  f.release = file => writeFileSync(file, 'go');
  t.after(async () => {
    // 先放行所有等放行文件的假执行者，再按身份结束本用例清单里记录的进程，绝不按进程名终止。
    writeFileSync(path.join(base, 'go-b.flag'), 'go');
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-retry-overlap-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

// 让下一次 ar retry 的假执行者能在 src 下提交，通过门禁。
const passing = (file = 'src/retry.js') => ({ writes: [{ path: file, content: '重试的改动\n' }], commit: '假执行者：重试' });

test('1 重试时改动范围与正在运行的任务重叠：排队，对方结束（待验收）后在原 worktree 里继续，不重新定基线', async t => {
  const f = fixture(t);
  const goB = path.join(f.base, 'go-b.flag');
  const specA = f.spec('docs/specs/A.md', ['src/**']);
  const specB = f.spec('docs/specs/B.md', ['src/a.js']);
  const a = await f.fail(specA, '甲');
  const worktreeA = f.events(a).find(row => row.event === 'worktree');

  // B 比 A 晚派发、正在运行（等放行文件），改动范围与 A 重叠。
  f.setProfile({ releaseFile: goB, releaseTimeoutMs: 120000, writes: [{ path: 'src/a.js', content: 'B 的改动\n' }], commit: '假执行者：B' });
  const b = await f.dispatch(specB, '乙');
  await until(() => f.has(b, 'spawned'), 'B 启动执行者');

  // 主分支在 A 排队期间前进：重试不重新定基线，worktree 事件里的基线不变。
  write(path.join(f.repo, 'docs/other.md'), '主分支前进\n');
  git(f.repo, ['add', '--', 'docs/other.md']);
  git(f.repo, ['commit', '-q', '-m', '主分支前进']);

  f.setProfile(passing());
  await f.retry('甲');
  const queued = await until(() => f.events(a).find(row => row.event === 'queued' && row.reason === 'overlap'), 'A 重试排队');
  assert.deepEqual(queued.blockers, [{ id: b, name: '乙', paths: ['src/a.js'] }]);
  assert.match(f.progress('甲'), /排队：与 乙 的改动范围重叠（src\/a\.js），等它结束/);
  await delay(2600);
  assert.equal(f.events(a).some(row => row.event === 'attempt' && row.n === 2), false, 'B 还在运行，A 的重试不开始');

  // B 放行 → 门禁 → 待验收（待验收不挡人），A 的重试开始并通过。
  f.release(goB);
  await until(() => f.has(b, 'end'), 'B 结束');
  const endA = await until(() => f.events(a).filter(row => row.event === 'end')[1], 'A 重试结束');
  assert.equal(endA.exit, 0, f.progress('甲'));
  const events = f.events(a);
  assert.equal(events.filter(row => row.event === 'worktree').length, 1, '没有重新建 worktree');
  assert.equal(events.find(row => row.event === 'worktree').base, worktreeA.base, '基线不变');
  assert.doesNotMatch(f.progress('甲'), /基线更新/);
  assert.equal(events.filter(row => row.event === 'queued' && row.reason === 'overlap').length, 1);
  const order = rows(f.home);
  assert.ok(order.findIndex(row => row.id === a && row.event === 'attempt' && row.n === 2) > order.findIndex(row => row.id === b && row.event === 'end'), 'A 的重试在 B 结束之后才开始');
});

test('2 重试时改动范围不重叠：直接开始，不排队', async t => {
  const f = fixture(t);
  const goB = path.join(f.base, 'go-b.flag');
  const specA = f.spec('docs/specs/A.md', ['src/**']);
  const specB = f.spec('docs/specs/B.md', ['docs/**']);
  const a = await f.fail(specA, '甲');
  f.setProfile({ releaseFile: goB, releaseTimeoutMs: 120000, writes: [{ path: 'docs/readme.md', content: 'B 的改动\n' }], commit: '假执行者：B' });
  const b = await f.dispatch(specB, '乙');
  await until(() => f.has(b, 'spawned'), 'B 启动执行者');
  f.setProfile(passing());
  await f.retry('甲');
  const endA = await until(() => f.events(a).filter(row => row.event === 'end')[1], 'A 重试结束');
  assert.equal(endA.exit, 0, f.progress('甲'));
  assert.equal(f.events(a).some(row => row.event === 'queued'), false, '没有排队');
  assert.equal(f.has(b, 'end'), false, 'B 还在运行，A 没有等它');
});

test('3 两个重叠的重试同时排队：先排队的先开始，后排队的等它，不会互相等死', async t => {
  const f = fixture(t);
  const goB = path.join(f.base, 'go-b.flag');
  const specA = f.spec('docs/specs/A.md', ['src/**']);
  const specC = f.spec('docs/specs/C.md', ['src/**']);
  const specB = f.spec('docs/specs/B.md', ['src/a.js']);
  const a = await f.fail(specA, '甲');
  const c = await f.fail(specC, '丙');
  f.setProfile({ releaseFile: goB, releaseTimeoutMs: 120000, writes: [{ path: 'src/a.js', content: 'B 的改动\n' }], commit: '假执行者：B' });
  const b = await f.dispatch(specB, '乙');
  await until(() => f.has(b, 'spawned'), 'B 启动执行者');

  f.setProfile(passing('src/retry-a.js'));
  await f.retry('甲');
  await until(() => f.events(a).find(row => row.event === 'queued' && row.reason === 'overlap'), 'A 重试排队');
  f.setProfile(passing('src/retry-c.js'));
  await f.retry('丙');
  const queuedC = await until(() => f.events(c).find(row => row.event === 'queued' && row.reason === 'overlap'), 'C 重试排队');
  assert.ok(queuedC.blockers.some(item => item.id === b), 'C 等 B');
  assert.ok(queuedC.blockers.some(item => item.id === a), 'C 也等先排队的 A');
  assert.equal(f.events(a).find(row => row.event === 'queued' && row.reason === 'overlap').blockers.some(item => item.id === c), false, 'A 不等后排队的 C');

  f.release(goB);
  await until(() => f.events(a).filter(row => row.event === 'end')[1] && f.events(c).filter(row => row.event === 'end')[1], 'A、C 的重试都结束');
  const order = rows(f.home);
  const at = (id, event, n) => order.findIndex(row => row.id === id && row.event === event && (n === undefined || row.n === n));
  assert.ok(at(a, 'attempt', 2) > at(b, 'end'), 'A 在 B 结束之后开始');
  assert.ok(at(c, 'attempt', 2) > order.findLastIndex(row => row.id === a && row.event === 'end'), 'C 在 A 的重试结束之后才开始');
  for (const id of [a, c]) assert.equal(f.events(id).filter(row => row.event === 'end')[1].exit, 0);
});
