import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 手动重试（不带 --rebase）的门禁基线（任务 164）：取最近一次尝试的基线，而不是派发时的。
// 每个用例在系统临时目录里建真实 git 仓库；AGENT_ROUTER_HOME、AR_WORKTREE_ROOT 都指向用例自己的临时目录，执行者是 fake。
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

function specText({ allowed, verify = [] }) {
  const lines = ['---', 'id: 901', 'title: 重试门禁基线测试', 'type: code', 'expect_commit: true', 'max_retries: 0'];
  lines.push('allowed_paths:');
  for (const item of allowed) lines.push(`  - ${item}`);
  if (verify.length) {
    lines.push('verify:');
    for (const line of verify) lines.push(`  - ${line}`);
  }
  lines.push('---', '', '测试说明正文。', '');
  return lines.join('\n');
}

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-retrybase-it-'));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'wt'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_TEST_LOAD_FILE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '重试基线测试']);
  git(repo, ['config', 'user.email', 'retry-base-it@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'docs/readme.md'), '说明\n');
  // 验收脚本：仓库上一级目录里有放行标记才通过（标记不进仓库）。
  write(path.join(repo, 'scripts/check.mjs'), [
    "import { existsSync } from 'node:fs';",
    "import path from 'node:path';",
    "process.exit(existsSync(path.join(path.resolve(process.env.AR_BASE_REPO, '..'), 'ok.flag')) ? 0 : 1);",
    '',
  ].join('\n'));
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({
    v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true,
  }, null, 2));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 };
  const f = { base, repo, home, env, since };
  f.setProfile = value => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { ...profile, ...value } }, concurrency: 4,
    }));
  };
  f.setProfile({});
  f.spec = (rel, fields) => {
    write(path.join(repo, rel), specText(fields));
    git(repo, ['add', '--', rel]);
    git(repo, ['commit', '-q', '-m', `任务说明 ${path.basename(rel)}`]);
    return rel;
  };
  // 主分支前进一个提交（改一个允许清单以外的文件），返回新提交。
  f.advance = (file, text) => {
    write(path.join(repo, file), text);
    git(repo, ['add', '--', file]);
    git(repo, ['commit', '-q', '-m', `主分支前进 ${file}`]);
    return git(repo, ['rev-parse', 'main']);
  };
  f.ar = (args, { timeout = 90000 } = {}) => new Promise((resolve, reject) => {
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
  // 重试并等这一次结束（前台等进程退出；脱离等清单里多一条 end）。
  f.retry = async (name, id, extra) => {
    const ends = f.events(id).filter(row => row.event === 'end').length;
    const result = await f.ar(['retry', name, ...extra]);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    await until(() => f.events(id).filter(row => row.event === 'end').length > ends, `${name} 重试结束`);
  };
  f.events = id => rows(home).filter(row => row.id === id);
  f.has = (id, event) => rows(home).some(row => row.id === id && row.event === event);
  f.gate = (name, n) => JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'attempts', String(n), 'gate.json'), 'utf8'));
  t.after(async () => {
    for (const file of [path.join(base, 'go-a.flag')]) writeFileSync(file, 'go');
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-retrybase-it-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

// A、B 改动范围重叠，B 排队；排队期间主分支前进；A 结束后 B 出队，第 1 次门禁通过。返回新基线。
async function queuedScenario(f) {
  const goA = path.join(f.base, 'go-a.flag');
  const specA = f.spec('docs/specs/A.md', { allowed: ['src/**'] });
  const specB = f.spec('docs/specs/B.md', { allowed: ['src/a.js'] });
  f.setProfile({ releaseFile: goA, releaseTimeoutMs: 120000, writes: [{ path: 'src/a.js', content: 'A 的改动\n' }], commit: '假执行者：A' });
  const a = await f.dispatch(specA, '甲');
  await until(() => f.has(a, 'spawned'), 'A 启动执行者');
  f.setProfile({ writes: [{ path: 'src/a.js', content: 'B 第 1 次\n' }], commit: '假执行者：B1' });
  const b = await f.dispatch(specB, '乙');
  await until(() => f.events(b).find(row => row.event === 'queued'), 'B 排队');
  const merge = f.advance('docs/other.md', '先合入\n');
  writeFileSync(goA, 'go');
  await until(() => f.has(a, 'end'), 'A 结束');
  await until(() => f.has(b, 'end'), 'B 结束');
  const first = f.gate('乙', 1);
  assert.equal(first.base, merge);
  assert.equal(first.ok, true, JSON.stringify(first));
  return { b, merge };
}

async function checkQueuedRetry(t, extra) {
  const f = fixture(t);
  const { b, merge } = await queuedScenario(f);
  f.setProfile({ writes: [{ path: 'src/a.js', content: 'B 第 2 次\n' }], commit: '假执行者：B2' });
  await f.retry('乙', b, ['--note', '再改一处', ...extra]);
  const gate = f.gate('乙', 2);
  assert.equal(gate.base, merge, '第 2 次门禁的基线是出队时更新后的基线');
  assert.equal(gate.scope.changed.includes('docs/other.md'), false, `主分支前进的文件不算改动：${JSON.stringify(gate.scope)}`);
  assert.equal(gate.ok, true, JSON.stringify(gate));
  const attempts = f.events(b).filter(row => row.event === 'attempt');
  assert.equal(attempts.at(-1).n, 2);
  assert.equal(attempts.at(-1).base, merge, '第 2 次 attempt 事件的 base 与门禁一致');
}

test('1 排队出队后基线更新过：手动重试（前台）的门禁基线是出队时的新基线', async t => {
  await checkQueuedRetry(t, []);
});

test('2 同样的场景用 --detach 重试，结果相同', async t => {
  await checkQueuedRetry(t, ['--detach']);
});

test('3 对照：没有排队、基线没变过的任务手动重试，门禁基线与派发时相同', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/B.md', { allowed: ['src/a.js'] });
  f.setProfile({ writes: [{ path: 'src/a.js', content: '第 1 次\n' }], commit: '假执行者：1' });
  const b = await f.dispatch(spec, '乙');
  await until(() => f.has(b, 'end'), 'B 结束');
  const start = f.events(b).find(row => row.event === 'start');
  assert.equal(f.gate('乙', 1).base, start.base);
  f.setProfile({ writes: [{ path: 'src/a.js', content: '第 2 次\n' }], commit: '假执行者：2' });
  await f.retry('乙', b, ['--note', '再改一处']);
  const gate = f.gate('乙', 2);
  assert.equal(gate.base, start.base);
  assert.equal(gate.ok, true, JSON.stringify(gate));
});

test('4 先 --rebase（主分支又前进）、再普通重试：普通重试的门禁基线是 --rebase 那次的新基线', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/B.md', { allowed: ['src/a.js'], verify: ['node scripts/check.mjs'] });
  f.setProfile({ writes: [{ path: 'src/a.js', content: '第 1 次\n' }], commit: '假执行者：1' });
  const b = await f.dispatch(spec, '乙');
  await until(() => f.has(b, 'end'), 'B 结束');
  assert.equal(f.gate('乙', 1).ok, false, '没有放行标记，验收命令失败');
  // 放行，主分支前进，--rebase：没有冲突，只重跑门禁。
  writeFileSync(path.join(f.base, 'ok.flag'), 'go');
  const merge = f.advance('docs/other.md', '先合入\n');
  await f.retry('乙', b, ['--rebase']);
  const rebased = f.gate('乙', 2);
  assert.equal(rebased.base, merge);
  assert.equal(rebased.ok, true, JSON.stringify(rebased));
  // 普通重试：沿用 --rebase 的基线。
  f.setProfile({ writes: [{ path: 'src/a.js', content: '第 3 次\n' }], commit: '假执行者：3' });
  await f.retry('乙', b, ['--note', '再改一处']);
  const gate = f.gate('乙', 3);
  assert.equal(gate.base, merge);
  assert.equal(gate.scope.changed.includes('docs/other.md'), false, JSON.stringify(gate.scope));
  assert.equal(gate.ok, true, JSON.stringify(gate));
  assert.equal(f.events(b).filter(row => row.event === 'attempt').at(-1).base, merge);
});
