import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { identityAlive, pidAlive, processList, redactPaths } from '../../core/lib/process.mjs';
import { validRequest } from '../../core/lib/managed.mjs';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// 059：ar retry 手动重试的集成测试（协议第 14.3、14.4 节）。每个用例在系统临时目录里建仓库、
// 用隔离的 AGENT_ROUTER_HOME 与 fake 执行者，通过子进程跑 core/ar.mjs；
// 不碰真实安装、配置与真实进程，也不手动派发——只走自动测试。
// 目录名用 ASCII（保留空格）：停止用例要按命令行核对进程，PowerShell 的进程查询对中文命令行会乱码。
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
const eventsOf = (home, id) => rows(home).filter(row => row.id === id).map(row => row.event);
async function until(fn, label, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

// 任务说明 frontmatter：只写关心的字段；maxRetries 映射成 max_retries（不写就用默认 2）。
function specText({ type = 'code', allowed = ['src/**'], verify = [], expectCommit, maxRetries } = {}) {
  const lines = ['---', 'id: 959', 'title: 手动重试测试', `type: ${type}`];
  if (allowed !== null) {
    lines.push('allowed_paths:');
    for (const item of allowed) lines.push(`  - ${item}`);
  }
  if (verify.length) {
    lines.push('verify:');
    for (const line of verify) lines.push(`  - ${line}`);
  }
  if (expectCommit !== undefined) lines.push(`expect_commit: ${expectCommit}`);
  if (maxRetries !== undefined) lines.push(`max_retries: ${maxRetries}`);
  lines.push('---', '', '手动重试测试正文。', '');
  return lines.join('\n');
}

// 验收命令：src/done.txt 里出现"完成"才通过；失败时输出带这行文字（重试 prompt 要引用它的输出末尾）。
const DONE_CHECK = `node -e "const fs=require('fs');let s='';try{s=fs.readFileSync('src/done.txt','utf8')}catch(e){};if(!s.includes('完成')){console.log('src/done.txt 还没有 完成 标记，门禁不予通过');process.exit(1)}"`;
// 重试那次的回放覆盖：写入完成标记并提交，让门禁通过。
const DONE_WRITE = { writes: [{ path: 'src/done.txt', content: '任务完成\n' }], commit: '假执行者：写入完成标记' };

function fixture(t) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-retry-cli-059-'));
  const repo = path.join(base, 'repo 059'), home = path.join(base, 'home 059');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '手动重试测试']);
  git(repo, ['config', 'user.email', 'retry-059@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  commitAll(repo, '初始提交');
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 };
  const f = { base, repo, home, env, profile };
  // profiles 可以整个替换（换执行者用例要第二个配置）；默认只有 fake。
  f.setProfiles = profiles => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles,
    }));
  };
  f.setProfile = value => {
    Object.assign(profile, value);
    f.setProfiles({ fake: profile });
  };
  f.setProfile({});
  // 写任务说明并提交（启用门禁时派发前要求说明已提交、工作区干净）。
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
  // 停止用例：拿得住还没结束的重试进程本身（不 await）。
  f.spawnAr = args => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
    return child;
  };
  f.progress = name => readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  f.dir = name => path.join(repo, '.agent-runs', name);
  // 命令行里带着这个临时仓库或隔离公共目录的进程，加上指定的进程（停止后核对身份用）。
  // 069：targets 里的元素是 { pid, created } 身份时按身份（PID + 创建时间）匹配，PID 被别的进程复用不算；纯 PID 数字仍按 PID 匹配（停止前取快照用）；函数按它自己的判断匹配。
  f.related = async targets => {
    const list = await processList();
    const matches = p => targets.some(target => typeof target === 'number' ? target === p.pid : typeof target === 'function' ? target(p) : identityAlive([p], target));
    return list.filter(p => matches(p) || String(p.command).includes(repo) || String(p.command).includes(home));
  };
  f.waitGone = async (pids, label, timeout = 8000) => {
    let left = [];
    for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
      left = await f.related(pids);
      if (!left.length) return;
      await delay(50);
    }
    throw Error(`${label}：仍有进程存活：${left.map(p => `pid=${p.pid} ${redactPaths(p.command)}`).join('；')}`);
  };
  t.after(async () => {
    // 只结束命令行里带着本临时目录的进程，绝不按进程名终止。
    // 按身份（PID + 创建时间）逐个结束，不带 /T，不按 PID。
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(realpathSync.native(os.tmpdir()), base).startsWith('ar-retry-cli-059-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('门禁失败的任务 ar retry：resume→attempt(manual)→…→end，prompt 带失败信息与补充说明，ar wait 返回新结果', async t => {
  const f = fixture(t);
  f.setProfile({
    events: [{ kind: 'say', text: '第一次尝试' }],
    attempts: { 2: { events: [{ kind: 'say', text: '重试完成' }], ...DONE_WRITE } },
  });
  const spec = f.spec('docs/specs/001-门禁失败后手动重试.md', { allowed: ['src/**'], verify: [DONE_CHECK], maxRetries: 0 });
  const dispatched = await f.ar(['dispatch', spec, '--name', '手动重试', '--json']);
  assert.equal(dispatched.code, 3, dispatched.stderr + dispatched.stdout);
  const start = startOf(f.home, '手动重试');
  assert.deepEqual(eventsOf(f.home, start.id),
    ['start', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end'],
    '派发本身只跑一次（max_retries 0）');

  const retried = await f.ar(['retry', '手动重试', '--note', '把完成标记补上', '--json']);
  assert.equal(retried.code, 0, retried.stderr + retried.stdout);
  const value = JSON.parse(retried.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.exit, 0);
  assert.equal(value.id, start.id, '重试沿用同一个任务 id');
  assert.equal(value.name, '手动重试');
  assert.equal(value.n, 2);
  assert.ok(value.progress.endsWith(path.join('.agent-runs', '手动重试', 'progress.log')));
  assert.equal(Object.hasOwn(value, 'detached'), false, '前台重试没有 detached 字段');

  assert.deepEqual(eventsOf(f.home, start.id),
    ['start', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end', 'resume', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end'],
    '重试从 resume 开始接着写');
  const list = rows(f.home).filter(row => row.id === start.id);
  const resume = list.find(row => row.event === 'resume');
  assert.equal(resume.n, 2);
  assert.ok(Number.isSafeInteger(resume.pid), 'resume 记录 pid');
  const attempts = list.filter(row => row.event === 'attempt');
  assert.deepEqual(attempts.map(row => [row.n, row.total, row.reason, row.profile]),
    [[1, 1, 'first', 'fake'], [2, null, 'manual', 'fake']]);
  const end = list.at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.exit, 0);
  assert.equal(end.attempts, 2);

  // attempts/2/prompt.md：上一次门禁失败信息（手动重试标题不带"共允许"）与 --note 段落。
  const prompt2 = readFileSync(path.join(f.dir('手动重试'), 'attempts', '2', 'prompt.md'), 'utf8');
  assert.match(prompt2, /## 上一次尝试没有通过验收（第 1 次）/);
  assert.match(prompt2, /src\/done\.txt 还没有 完成 标记/, 'prompt 含失败命令的输出末尾');
  assert.match(prompt2, /## 主导补充说明\n\n把完成标记补上/);
  // 进度分隔行（原因：手动重试）。
  assert.match(f.progress('手动重试'), /=== 第 2 次尝试（执行者：假执行者；原因：手动重试）===/);
  // events.jsonl 的 seq 跨进程连续（协议 14.2 第 4 条），attempt 标注两次尝试。
  const events = readFileSync(start.events, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(row => row.seq), events.map((_, index) => index + 1), 'seq 跨重试连续');
  assert.deepEqual(events.map(row => row.attempt), [1, 2], '两次尝试各有事件');
  // ar wait 返回新结果（旧的 end 不再算数）。
  const waited = await f.ar(['wait', '手动重试', '--json']);
  assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  const waitedValue = JSON.parse(waited.stdout);
  assert.equal(waitedValue.exit, 0);
  assert.deepEqual(waitedValue.gate, { ok: true, summary: '门禁通过' });
});

test('执行者失败的任务重试：prompt 带出错信息，不给 --note 也放行', async t => {
  const f = fixture(t);
  f.setProfile({
    exit: 1,
    events: [{ kind: 'error', text: '模拟崩溃：连接中断' }],
    attempts: { 2: { events: [{ kind: 'say', text: '重试成功' }], report: '重试汇报\n', exit: 0 } },
  });
  const spec = f.spec('docs/specs/002-执行者失败后手动重试.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 0 });
  const dispatched = await f.ar(['dispatch', spec, '--name', '执行者失败', '--json']);
  assert.equal(dispatched.code, 1, dispatched.stderr + dispatched.stdout);

  const retried = await f.ar(['retry', '执行者失败', '--json']);
  assert.equal(retried.code, 0, retried.stderr + retried.stdout);
  const value = JSON.parse(retried.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.n, 2);
  const start = startOf(f.home, '执行者失败');
  const list = rows(f.home).filter(row => row.id === start.id);
  const attempts = list.filter(row => row.event === 'attempt');
  assert.deepEqual(attempts.map(row => [row.n, row.total, row.reason]), [[1, 1, 'first'], [2, null, 'manual']]);
  const end = list.at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.exit, 0);
  assert.equal(end.attempts, 2);
  const prompt2 = readFileSync(path.join(f.dir('执行者失败'), 'attempts', '2', 'prompt.md'), 'utf8');
  assert.match(prompt2, /失败原因：执行者异常退出（exit 1）/);
  assert.match(prompt2, /模拟崩溃：连接中断/, 'prompt 含出错事件文字');
  assert.match(prompt2, /出错信息末尾/, 'prompt 带 raw.log 末尾');
  assert.ok(!prompt2.includes('主导补充说明'), '没给 --note 就没有补充说明段落');
});

test('中断的任务重试：没有失败段落，只带补充说明', async t => {
  const f = fixture(t);
  f.setProfile({
    attempts: {
      1: { events: [{ kind: 'say', text: '跑着' }], delayMs: 60000, exit: 1 },
      2: { events: [{ kind: 'say', text: '重试完成' }], report: '重试汇报\n', exit: 0 },
    },
  });
  const spec = f.spec('docs/specs/003-中断后手动重试.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 0 });
  const dispatching = f.spawnAr(['dispatch', spec, '--name', '中断后重试']);
  const start = await until(() => startOf(f.home, '中断后重试'), '中断后重试的 start 记录');
  await until(() => rows(f.home).some(row => row.id === start.id && row.event === 'spawned'), '第一次 spawned 记录');
  const stop = await f.ar(['stop', '中断后重试']);
  assert.equal(stop.code, 0, stop.stderr + stop.stdout);
  await dispatching.done;
  assert.equal(rows(f.home).filter(row => row.id === start.id).at(-1).event, 'interrupted');

  const retried = await f.ar(['retry', '中断后重试', '--note', '继续做完', '--json']);
  assert.equal(retried.code, 0, retried.stderr + retried.stdout);
  assert.equal(JSON.parse(retried.stdout).n, 2);
  assert.deepEqual(eventsOf(f.home, start.id),
    ['start', 'attempt', 'spawned', 'interrupted', 'resume', 'attempt', 'spawned', 'attempt-end', 'end']);
  const prompt2 = readFileSync(path.join(f.dir('中断后重试'), 'attempts', '2', 'prompt.md'), 'utf8');
  assert.ok(!prompt2.includes('上一次尝试没有通过验收'), '中断没有失败段落');
  assert.match(prompt2, /## 主导补充说明\n\n继续做完/);
  const end = rows(f.home).filter(row => row.id === start.id).at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.exit, 0);
  assert.equal(end.attempts, 2);
});

test('完成的任务：不给 --note 退出码 2 且不写 resume；给了才重试，prompt 只有补充说明', async t => {
  const f = fixture(t);
  f.setProfile({ events: [{ kind: 'say', text: '完成' }], report: '完成汇报\n', exit: 0 });
  const spec = f.spec('docs/specs/004-完成后再改一轮.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 0 });
  const dispatched = await f.ar(['dispatch', spec, '--name', '完成后重试', '--json']);
  assert.equal(dispatched.code, 0, dispatched.stderr + dispatched.stdout);
  const start = startOf(f.home, '完成后重试');

  const rejected = await f.ar(['retry', '完成后重试', '--json']);
  assert.equal(rejected.code, 2, rejected.stderr + rejected.stdout);
  assert.deepEqual(JSON.parse(rejected.stdout), { ok: false, error: '已完成的任务重试时必须写补充说明（--note）' });
  assert.equal(rows(f.home).some(row => row.id === start.id && row.event === 'resume'), false, '拒绝时不写 resume');

  const retried = await f.ar(['retry', '完成后重试', '--note', '再润色一轮', '--json']);
  assert.equal(retried.code, 0, retried.stderr + retried.stdout);
  assert.equal(JSON.parse(retried.stdout).n, 2);
  const prompt2 = readFileSync(path.join(f.dir('完成后重试'), 'attempts', '2', 'prompt.md'), 'utf8');
  assert.ok(!prompt2.includes('上一次尝试没有通过验收'), '完成后重试没有失败段落');
  assert.match(prompt2, /## 主导补充说明\n\n再润色一轮/);
  const end = rows(f.home).filter(row => row.id === start.id).at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.exit, 0);
  assert.equal(end.attempts, 2);
});

test('进行中的任务拒绝重试：退出码 2，不写 resume', async t => {
  const f = fixture(t);
  f.setProfile({
    attempts: {
      1: { events: [{ kind: 'say', text: '跑着' }], delayMs: 60000, exit: 1 },
      2: { events: [{ kind: 'say', text: '跑着' }], delayMs: 60000, exit: 1 },
    },
  });
  const spec = f.spec('docs/specs/005-进行中拒绝重试.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 0 });
  const running = f.spawnAr(['dispatch', spec, '--name', '进行中重试']);
  const start = await until(() => startOf(f.home, '进行中重试'), '进行中重试的 start 记录');
  await until(() => rows(f.home).some(row => row.id === start.id && row.event === 'spawned'), 'spawned 记录');

  const rejected = await f.ar(['retry', '进行中重试', '--json']);
  assert.equal(rejected.code, 2, rejected.stderr + rejected.stdout);
  assert.equal(JSON.parse(rejected.stdout).error, '任务还在进行，先停止');
  assert.equal(rows(f.home).some(row => row.id === start.id && row.event === 'resume'), false, '拒绝时不写 resume');

  const stop = await f.ar(['stop', '进行中重试']);
  assert.equal(stop.code, 0, stop.stderr + stop.stdout);
  await running.done;
});

test('旧任务（没有 dispatch.json）拒绝重试：与 redispatch 同一句话，退出码 2', async t => {
  const f = fixture(t);
  f.setProfile({ exit: 1, events: [{ kind: 'error', text: '旧任务出错了' }] });
  const dispatched = await f.ar(['dispatch', '旧版本派发的任务文字', '--name', '旧任务', '--json']);
  assert.equal(dispatched.code, 1, dispatched.stderr + dispatched.stdout);
  const start = startOf(f.home, '旧任务');
  rmSync(path.join(f.dir('旧任务'), 'dispatch.json'));

  const rejected = await f.ar(['retry', '旧任务', '--json']);
  assert.equal(rejected.code, 2, rejected.stderr + rejected.stdout);
  assert.deepEqual(JSON.parse(rejected.stdout),
    { ok: false, error: '这个任务是旧版本派发的，没有保存派发参数，不能再派一次' });
  assert.equal(rows(f.home).some(row => row.id === start.id && row.event === 'resume'), false, '拒绝时不写 resume');
  assert.equal(existsSync(path.join(f.dir('旧任务'), 'attempts', '2')), false, '不产生新的尝试目录');
});

test('--profile 不存在或未启用：退出码 2，用现有报错文案，不写 resume', async t => {
  const f = fixture(t);
  f.setProfiles({
    fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '失败汇报\n', exit: 1 },
    off: { adapter: 'fake', label: '停用的执行者', enabled: false, events: [], report: '停用汇报\n', exit: 0 },
  });
  const spec = f.spec('docs/specs/006-执行者不对.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 0 });
  const dispatched = await f.ar(['dispatch', spec, '--name', '缺执行者', '--json']);
  assert.equal(dispatched.code, 1, dispatched.stderr + dispatched.stdout);
  const start = startOf(f.home, '缺执行者');

  const missing = await f.ar(['retry', '缺执行者', '--profile', '不存在的', '--json']);
  assert.equal(missing.code, 2, missing.stderr + missing.stdout);
  assert.deepEqual(JSON.parse(missing.stdout), { ok: false, error: '找不到执行者：不存在的' });
  const disabled = await f.ar(['retry', '缺执行者', '--profile', 'off', '--json']);
  assert.equal(disabled.code, 2, disabled.stderr + disabled.stdout);
  assert.deepEqual(JSON.parse(disabled.stdout), { ok: false, error: '执行者 off 已停用' });
  assert.equal(rows(f.home).some(row => row.id === start.id && row.event === 'resume'), false, '拒绝时不写 resume');
});

test('--profile 换执行者：第 2 次 attempt.profile 是新配置，分隔行也写它', async t => {
  const f = fixture(t);
  f.setProfiles({
    fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '失败汇报\n', exit: 1 },
    strong: { adapter: 'fake', label: '强执行者', enabled: true, events: [{ kind: 'say', text: '强执行者完成' }], report: '强汇报\n', exit: 0 },
  });
  const spec = f.spec('docs/specs/007-换执行者重试.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 0 });
  const dispatched = await f.ar(['dispatch', spec, '--name', '换执行者', '--json']);
  assert.equal(dispatched.code, 1, dispatched.stderr + dispatched.stdout);

  const retried = await f.ar(['retry', '换执行者', '--profile', 'strong', '--json']);
  assert.equal(retried.code, 0, retried.stderr + retried.stdout);
  assert.equal(JSON.parse(retried.stdout).n, 2);
  const start = startOf(f.home, '换执行者');
  const attempts = rows(f.home).filter(row => row.id === start.id && row.event === 'attempt');
  assert.deepEqual(attempts.map(row => [row.n, row.profile]), [[1, 'fake'], [2, 'strong']]);
  assert.match(f.progress('换执行者'), /=== 第 2 次尝试（执行者：强执行者；原因：手动重试）===/);
  const end = rows(f.home).filter(row => row.id === start.id).at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.exit, 0);
});

test('--detach 重试：请求带 retry 字段且合法，resume.pid 是执行者进程，ar wait 等到最终结果', async t => {
  const f = fixture(t);
  f.setProfile({
    events: [{ kind: 'say', text: '第一次尝试' }],
    // 重试那次放慢一点，留出核对执行者进程的窗口（太快会先退出，查不到进程）。
    attempts: { 2: { events: [{ kind: 'say', text: '重试完成' }], delayMs: 2000, ...DONE_WRITE } },
  });
  const spec = f.spec('docs/specs/008-脱离手动重试.md', { allowed: ['src/**'], verify: [DONE_CHECK], maxRetries: 0 });
  const dispatched = await f.ar(['dispatch', spec, '--name', '脱离重试', '--json']);
  assert.equal(dispatched.code, 3, dispatched.stderr + dispatched.stdout);

  const detached = await f.ar(['retry', '脱离重试', '--note', '再试一次', '--detach', '--json']);
  assert.equal(detached.code, 0, detached.stderr + detached.stdout);
  const value = JSON.parse(detached.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.exit, 0);
  assert.equal(value.detached, true);
  assert.equal(value.name, '脱离重试');
  assert.equal(value.n, 2);
  assert.ok(value.id);
  assert.ok(value.progress.endsWith(path.join('.agent-runs', '脱离重试', 'progress.log')));
  const start = startOf(f.home, '脱离重试');
  assert.equal(value.id, start.id, '脱离重试沿用同一个任务 id');

  // 请求文件带 retry 字段，且是合法托管请求（协议第 7 节第 8 条）。
  const managed = path.join(f.home, 'managed');
  await until(() => existsSync(path.join(managed, `${value.id}.claimed.json`)) || existsSync(path.join(managed, `${value.id}.running.json`)), '请求文件');
  const read = suffix => { const file = path.join(managed, `${value.id}${suffix}`); return existsSync(file) ? readFileSync(file, 'utf8') : ''; };
  const request = JSON.parse(read('.running.json') || read('.claimed.json'));
  assert.equal(validRequest(request), true, '脱离重试请求是合法托管请求');
  assert.deepEqual(request.retry, { n: 2, note: '再试一次', profile: 'fake' });
  assert.equal(request.name, '脱离重试');

  // resume 出现，pid 是 --run-request 执行者进程（不是已经返回的调用者）。
  const resume = await until(() => rows(f.home).filter(row => row.id === start.id && row.event === 'resume')[0], 'resume 记录', 20000);
  assert.equal(resume.n, 2);
  const worker = await until(async () => {
    const list = await processList();
    return list.find(item => item.pid === resume.pid) ?? null;
  }, 'resume.pid 出现在进程列表', 20000);
  assert.ok(String(worker.command).includes('--run-request'),
    `resume.pid 应是执行者进程：${redactPaths(worker.command ?? '') || '（命令行为空）'}`);

  const waited = await f.ar(['wait', '脱离重试', '--json'], { timeout: 90000 });
  assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  assert.equal(JSON.parse(waited.stdout).exit, 0);
  const end = rows(f.home).filter(row => row.id === start.id).at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.attempts, 2);
  assert.equal(end.exit, 0);
});

test('重试中途 ar stop：按 resume 的进程结束，写 interrupted，不写第 2 个 attempt-end 与 end', async t => {
  const f = fixture(t);
  f.setProfile({
    exit: 1,
    attempts: { 2: { events: [{ kind: 'say', text: '重试运行中' }], delayMs: 60000, exit: 1 } },
  });
  const spec = f.spec('docs/specs/009-重试中途停止.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 0 });
  const dispatched = await f.ar(['dispatch', spec, '--name', '重试中途停止', '--json']);
  assert.equal(dispatched.code, 1, dispatched.stderr + dispatched.stdout);
  const start = startOf(f.home, '重试中途停止');

  const retrying = f.spawnAr(['retry', '重试中途停止']);
  const resume = await until(() => rows(f.home).filter(row => row.id === start.id && row.event === 'resume')[0], 'resume 记录');
  assert.equal(resume.n, 2);
  // 第 2 条 spawned 才是重试那次（第 1 条属于已经结束的第一次尝试）。
  const spawned = await until(() => {
    const list = rows(f.home).filter(row => row.id === start.id && row.event === 'spawned');
    return list.length >= 2 ? list.at(-1) : null;
  }, '重试的 spawned 记录');
  assert.ok(pidAlive(resume.pid), '停止前重试进程存活');
  assert.ok(pidAlive(spawned.agentPid), '停止前重试的执行者存活');
  const before = await f.related([resume.pid, spawned.agentPid]);
  const identities = [before.find(p => p.pid === resume.pid), before.find(p => p.pid === spawned.agentPid)];
  assert.ok(identities.every(p => p && Number.isFinite(p.created)), '停止前快照里有重试进程与执行者的创建时间');

  const stop = await f.ar(['stop', '重试中途停止']);
  assert.equal(stop.code, 0, stop.stderr + stop.stdout);
  await retrying.done; // 被停止的重试进程退出（不设断言：被强杀时退出码因平台而异）

  const events = eventsOf(f.home, start.id);
  assert.deepEqual(events,
    ['start', 'attempt', 'spawned', 'attempt-end', 'end', 'resume', 'attempt', 'spawned', 'interrupted'],
    '重试被停止：没有第 2 个 attempt-end，也没有新的 end（第 1 个 end 是第一次尝试收尾的）');
  assert.equal(rows(f.home).filter(row => row.id === start.id && row.event === 'attempt-end').length, 1);
  assert.equal(rows(f.home).filter(row => row.id === start.id && row.event === 'end').length, 1, '重试不再写 end');
  assert.equal(rows(f.home).filter(row => row.id === start.id).at(-1).signal, 'stopped-by-command');
  await f.waitGone(identities, '停止后仍有进程'); // 069：按停止前的身份（PID + 创建时间）
});

// 060 主导补充②：ar retry --detach 后、执行者写 resume 之前，按 managed/ 里的 retry 请求等待，
// 不把上一次的 end（exit 1）当成本次结果。
test('retry --detach 后立刻 ar wait：空档里按请求等 resume，返回新结果而不是旧 end', async t => {
  const f = fixture(t);
  f.setProfile({
    exit: 1,
    events: [{ kind: 'error', text: '第一次失败' }],
    attempts: { 2: { events: [{ kind: 'say', text: '重试完成' }], delayMs: 4000, exit: 0 } },
  });
  const spec = f.spec('docs/specs/011-脱离重试空档.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 0 });
  const dispatched = await f.ar(['dispatch', spec, '--name', '脱离重试空档', '--json']);
  assert.equal(dispatched.code, 1, dispatched.stderr + dispatched.stdout);
  const start = startOf(f.home, '脱离重试空档');

  const detached = await f.ar(['retry', '脱离重试空档', '--note', '再试一次', '--detach', '--json']);
  assert.equal(detached.code, 0, detached.stderr + detached.stdout);
  // 派发一返回就等待：resume 可能还没写入；应当等到新一次尝试的结果（exit 0），而不是旧的 exit 1。
  const waited = await f.ar(['wait', '脱离重试空档', '--json'], { timeout: 90000 });
  assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  assert.equal(JSON.parse(waited.stdout).exit, 0);
  const end = rows(f.home).filter(row => row.id === start.id).at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.exit, 0);
});

// 060 主导补充②：ar stop 在同一段空档里也按请求等待，停到的是重试进程并写 interrupted。
test('retry --detach 后立刻 ar stop：空档里按请求等 resume，停到重试进程并写 interrupted', async t => {
  const f = fixture(t);
  f.setProfile({
    exit: 1,
    attempts: { 2: { events: [{ kind: 'say', text: '重试运行中' }], delayMs: 60000, exit: 1 } },
  });
  const spec = f.spec('docs/specs/012-脱离重试停止.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 0 });
  const dispatched = await f.ar(['dispatch', spec, '--name', '脱离重试停止', '--json']);
  assert.equal(dispatched.code, 1, dispatched.stderr + dispatched.stdout);
  const start = startOf(f.home, '脱离重试停止');

  const detached = await f.ar(['retry', '脱离重试停止', '--detach', '--json']);
  assert.equal(detached.code, 0, detached.stderr + detached.stdout);
  const stop = await f.ar(['stop', '脱离重试停止'], { timeout: 60000 });
  assert.equal(stop.code, 0, stop.stderr + stop.stdout);

  const events = eventsOf(f.home, start.id);
  assert.ok(events.includes('resume'), `应先写 resume：${events.join(',')}`);
  assert.equal(events.at(-1), 'interrupted', `空档里等待后按 resume 判断并写 interrupted：${events.join(',')}`);
  assert.equal(events.filter(event => event === 'end').length, 1, '不因旧 end 提前返回（只有第一次尝试的 end）');
  const resume = rows(f.home).filter(row => row.id === start.id && row.event === 'resume').at(-1);
  assert.equal(resume.n, 2);
  // 069：停止前记不下来重试进程的身份（resume 在空档之后才写），改按"同 PID 且创建时间不晚于它自己写 resume 的时间"认定是同一个进程——
  // 停止之后复用这个 PID 的新进程创建得更晚，不再被误判成没退出（taskAlive 同样用 start.started 做这个界限）。
  await f.waitGone([p => p.pid === resume.pid && p.created <= resume.at], '停止后重试进程仍存活');
});

test('Stage04 的旧任务（没有 attempt 事件与 attempts/）也能重试：n = 2，prompt 按 dispatch.json 重新生成', async t => {
  const f = fixture(t);
  f.setProfile({
    exit: 1,
    events: [{ kind: 'error', text: '旧任务出错了' }],
    // 门禁来自 dispatch.json（code 类型 + allowed_paths 启用）：重试那次要提交改动才过得去。
    attempts: { 2: { events: [{ kind: 'say', text: '旧任务重试' }], report: '旧任务重试汇报\n', exit: 0, ...DONE_WRITE } },
  });
  const spec = f.spec('docs/specs/010-旧任务.md', { allowed: ['src/**'], verify: [], maxRetries: 0 });
  const dispatched = await f.ar(['dispatch', spec, '--name', '旧任务记录', '--json']);
  assert.equal(dispatched.code, 1, dispatched.stderr + dispatched.stdout);
  const start = startOf(f.home, '旧任务记录');

  // 模拟 Stage04：没有 attempt / attempt-end 事件，也没有 attempts/（dispatch.json 保留）。
  rmSync(path.join(f.dir('旧任务记录'), 'attempts'), { recursive: true, force: true });
  writeFileSync(path.join(f.home, 'runs.jsonl'),
    rows(f.home)
      .filter(row => !(row.id === start.id && ['attempt', 'attempt-end'].includes(row.event)))
      .map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(start.events,
    readFileSync(start.events, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      .map(({ attempt, ...rest }) => rest).map(row => JSON.stringify(row)).join('\n') + '\n');

  const retried = await f.ar(['retry', '旧任务记录', '--json']);
  assert.equal(retried.code, 0, retried.stderr + retried.stdout);
  assert.equal(JSON.parse(retried.stdout).n, 2, '没有 attempt 事件按已有 1 次算，n = 2');
  const list = rows(f.home).filter(row => row.id === start.id);
  const attempts = list.filter(row => row.event === 'attempt');
  assert.deepEqual(attempts.map(row => [row.n, row.reason, row.profile]), [[2, 'manual', 'fake']]);
  const prompt2 = readFileSync(path.join(f.dir('旧任务记录'), 'attempts', '2', 'prompt.md'), 'utf8');
  assert.equal(existsSync(path.join(f.dir('旧任务记录'), 'attempts', '1')), false, '旧任务没有 attempts/1');
  assert.ok(prompt2.includes('然后完成任务说明 docs/specs/010-旧任务.md 中的全部内容，按要求验证、提交，最后给出汇报。'),
    'prompt 按 dispatch.json 重新生成');
  assert.match(prompt2, /## 上一次尝试没有通过验收（第 1 次）/);
  assert.match(prompt2, /失败原因：执行者异常退出（exit 1）/);
  assert.match(prompt2, /出错信息末尾/, 'stderrTail 退回顶层 raw.log');
  const end = list.at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.exit, 0);
  assert.equal(end.attempts, 2);
});

test('--json 与参数错误：找不到记录、缺记录名、无效派活方都返回 { ok:false, error }，退出码 2', async t => {
  const f = fixture(t);
  const missing = await f.ar(['retry', '根本没有这条', '--json']);
  assert.equal(missing.code, 2, missing.stderr + missing.stdout);
  assert.deepEqual(JSON.parse(missing.stdout), { ok: false, error: '重试：在当前仓库找不到记录 根本没有这条' });

  const noName = await f.ar(['retry', '--json']);
  assert.equal(noName.code, 2, noName.stderr + noName.stdout);
  assert.deepEqual(JSON.parse(noName.stdout),
    { ok: false, error: '用法：ar retry <记录名> [--profile <名>] [--note "<补充说明>"] [--detach] [--host claude-code|agentrouter]' });

  const badHost = await f.ar(['retry', '某记录', '--host', 'bad', '--json']);
  assert.equal(badHost.code, 2, badHost.stderr + badHost.stdout);
  assert.deepEqual(JSON.parse(badHost.stdout), { ok: false, error: '无效的派活方：bad' });

  const missingValue = await f.ar(['retry', '某记录', '--note', '--json']);
  assert.equal(missingValue.code, 2, missingValue.stderr + missingValue.stdout);
  assert.match(JSON.parse(missingValue.stdout).error, /^用法：ar retry /);

  // 找不到记录时不留下任何痕迹（没有 .agent-runs 目录）。
  assert.equal(existsSync(path.join(f.repo, '.agent-runs')), false, '全部被拒绝时不建任务目录');
});
