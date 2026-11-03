// 执行者运行时限（383）：任务说明的 timeout_min 对所有执行者运行生效，超时结束进程树并按执行者失败处理；
// 只读调研仍用原来的原文与处理。用隔离的 AGENT_ROUTER_HOME、系统临时目录里的仓库与 fake 执行者，不碰真实安装、配置与进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREATED_TOLERANCE_MS, pidAlive, processList } from '../../core/lib/process.mjs';
import { executorTimeoutMs } from '../../core/lib/pipeline.mjs';
import { cleanupProcesses } from '../fixtures/identity.mjs';

const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const commitAll = (root, message) => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
};
const rows = home => {
  try {
    return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};
const startOf = (home, name) => rows(home).find(row => row.event === 'start' && row.name === name);

// 任务说明 frontmatter：只写关心的字段。type 默认 docs（不要求提交），门禁默认不启用。
function specText({ type = 'docs', maxRetries, timeoutMin = 1 } = {}) {
  return [
    '---',
    'id: 383',
    'title: 执行者运行时限测试',
    `type: ${type}`,
    `timeout_min: ${timeoutMin}`,
    'expect_commit: false',
    ...(maxRetries === undefined ? [] : [`max_retries: ${maxRetries}`]),
    '---',
    '',
    '执行者运行时限测试正文。',
    '',
  ].join('\n');
}

function fixture(t) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-executor-timeout-383-'));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '执行者时限测试']);
  git(repo, ['config', 'user.email', 'executor-timeout-383@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  commitAll(repo, '初始提交');
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 };
  const f = { base, repo, home, env, profile };
  f.setProfile = value => {
    Object.assign(profile, value);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile },
    }));
  };
  f.setProfile({});
  f.spec = (rel, fields = {}) => {
    write(path.join(repo, rel), specText(fields));
    commitAll(repo, `任务说明 ${path.basename(rel)}`);
    return rel;
  };
  f.ar = (args, { timeout = 120000, extraEnv = {} } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  f.progress = name => readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  f.prompt = (name, n) => readFileSync(path.join(repo, '.agent-runs', name, 'attempts', String(n), 'prompt.md'), 'utf8');
  f.list = name => {
    const start = startOf(home, name);
    return rows(home).filter(row => row.id === start.id);
  };
  t.after(async () => {
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(realpathSync.native(os.tmpdir()), base).startsWith('ar-executor-timeout-383-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

// 执行者进程是否还活着：PID 仍存在时再看创建时间——晚于 spawned 记录的是被别的进程复用了这个 PID（负载高时第 2 次尝试
// 结束后常见），不算原来的执行者。快照查询失败时抛出，不当作通过。
async function agentStillAlive(spawned) {
  if (!pidAlive(spawned.agentPid)) return false;
  const [row] = await processList(spawned.agentPid);
  return !!row && Number.isFinite(row.created) && row.created <= spawned.at + CREATED_TOLERANCE_MS;
}

// 一直不退出：等一个不会出现的放行文件（等待上限设为 10 分钟，远长于测试里的 1.5 秒时限）。
const hang = base => ({ releaseFile: path.join(base, 'never-release'), releaseTimeoutMs: 600000 });

test('代码类任务超时：结束进程树、不代提交、attempt-end 带 timedOut，自动重试指令里有超时原因', async t => {
  const f = fixture(t);
  f.setProfile({
    ...hang(f.base),
    events: [{ kind: 'say', text: '第一次尝试' }],
    report: '假汇报\n',
    exit: 0,
    autoCommit: true,
    // 第 2 次尝试在时限内正常结束，任务最终成功。
    attempts: { 2: { releaseFile: null, report: '第二次完成\n', exit: 0 } },
  });
  const spec = f.spec('docs/specs/383-超时重试.md', { maxRetries: 1, timeoutMin: 1 });
  const result = await f.ar(['dispatch', spec, '--name', '超时重试', '--json'], { extraEnv: { AR_TEST_EXECUTOR_TIMEOUT_MS: '1500' } });
  assert.equal(result.code, 0, result.stderr + result.stdout);

  const list = f.list('超时重试');
  const spawned = list.find(row => row.event === 'spawned');
  assert.ok(Number.isSafeInteger(spawned.agentPid));
  assert.equal(await agentStillAlive(spawned), false, '执行者进程树已被结束');

  const progress = f.progress('超时重试');
  assert.ok(progress.includes('执行超过时限（1 分钟），正在结束执行者'), '进度里有超时原文');
  assert.ok(!progress.includes('调研超过时限'), '非只读任务不用调研的原文');
  assert.ok(!progress.includes('AgentRouter 代提交'), '超时后不代提交');

  const attemptEnds = list.filter(row => row.event === 'attempt-end');
  assert.equal(attemptEnds.length, 2);
  assert.equal(attemptEnds[0].timedOut, true);
  assert.equal(attemptEnds[0].ok, false);
  assert.notEqual(attemptEnds[0].exit, 0, '按执行者异常退出处理');
  assert.equal(Object.hasOwn(attemptEnds[0], 'autoCommit'), false, '没有代提交记录');
  assert.equal(Object.hasOwn(attemptEnds[1], 'timedOut'), false, '最后一次没有超时');
  assert.equal(attemptEnds[1].ok, true);

  const end = list.at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.exit, 0);
  assert.equal(Object.hasOwn(end, 'timedOut'), false, 'end 只在最后一次超时出现 timedOut');

  const prompt1 = f.prompt('超时重试', 1);
  const prompt2 = f.prompt('超时重试', 2);
  assert.ok(!prompt1.includes('上一次执行超过时限'), '第 1 次是原始指令');
  assert.ok(prompt2.includes('上一次执行超过时限（1 分钟）被结束'), '自动重试指令里写明上一次是超时被结束');
  assert.match(prompt2, /## 上一次尝试没有通过验收（第 1 次，共允许 2 次）/);
});

test('假执行者在时限内正常结束：不出现超时原文，事件里没有 timedOut', async t => {
  const f = fixture(t);
  f.setProfile({ events: [{ kind: 'say', text: '完成' }], report: '完成汇报\n', exit: 0 });
  const spec = f.spec('docs/specs/383-按时结束.md', { maxRetries: 0, timeoutMin: 1 });
  const result = await f.ar(['dispatch', spec, '--name', '按时结束', '--json'], { extraEnv: { AR_TEST_EXECUTOR_TIMEOUT_MS: '15000' } });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.ok(!f.progress('按时结束').includes('超过时限'));
  const list = f.list('按时结束');
  const attemptEnd = list.find(row => row.event === 'attempt-end');
  assert.equal(attemptEnd.ok, true);
  assert.equal(Object.hasOwn(attemptEnd, 'timedOut'), false);
  assert.equal(Object.hasOwn(list.at(-1), 'timedOut'), false);
});

test('只读调研超时仍是原来的原文与处理：没有 timedOut 事件字段', async t => {
  const f = fixture(t);
  f.setProfile({ ...hang(f.base), events: [{ kind: 'say', text: '调研中' }], report: '调研汇报\n', exit: 0 });
  const spec = f.spec('docs/specs/383-调研超时.md', { type: 'research', maxRetries: 0, timeoutMin: 1 });
  const result = await f.ar(['dispatch', spec, '--name', '调研超时', '--json'], { extraEnv: { AR_TEST_EXECUTOR_TIMEOUT_MS: '1500' } });
  assert.notEqual(result.code, 0, result.stderr + result.stdout);

  const progress = f.progress('调研超时');
  assert.ok(progress.includes('调研超过时限，正在结束执行者'));
  assert.ok(!progress.includes('执行超过时限（'), '只读任务不用代码类任务的原文');

  const list = f.list('调研超时');
  const spawned = list.find(row => row.event === 'spawned');
  assert.equal(await agentStillAlive(spawned), false, '执行者进程树已被结束');
  const attemptEnd = list.find(row => row.event === 'attempt-end');
  assert.equal(attemptEnd.ok, false);
  assert.notEqual(attemptEnd.exit, 0);
  assert.equal(Object.hasOwn(attemptEnd, 'timedOut'), false, '只读调研发事件不变');
  assert.equal(Object.hasOwn(list.at(-1), 'timedOut'), false);
});

test('执行者运行时限的毫秒换算：AR_TEST_EXECUTOR_TIMEOUT_MS 只在正数时覆盖', () => {
  assert.equal(executorTimeoutMs(2, {}), 120000);
  assert.equal(executorTimeoutMs(2, { AR_TEST_EXECUTOR_TIMEOUT_MS: '1500' }), 1500);
  assert.equal(executorTimeoutMs(2, { AR_TEST_EXECUTOR_TIMEOUT_MS: '0' }), 120000);
  assert.equal(executorTimeoutMs(2, { AR_TEST_EXECUTOR_TIMEOUT_MS: 'abc' }), 120000);
});
