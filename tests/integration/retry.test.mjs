import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { identityAlive, pidAlive, processList, redactPaths } from '../../core/lib/process.mjs';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// 058：多次尝试与自动重试的集成测试（协议第 14 节）。每个用例在系统临时目录里建仓库、
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
// 停止后按 PID + 创建时间核对"这个进程"是否还在（同 stop-order.test.mjs：只按 PID 会撞上被复用的 PID）。
const sameProcessesAlive = async procs => {
  const list = await processList();
  return procs.filter(proc => list.some(p => p.pid === proc.pid && p.created === proc.created));
};
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
  const lines = ['---', 'id: 958', 'title: 多次尝试测试', `type: ${type}`];
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
  lines.push('---', '', '多次尝试测试正文。', '');
  return lines.join('\n');
}

// 验收命令：src/done.txt 里出现"完成"才通过；失败时输出带这行文字（重试 prompt 要引用它的输出末尾）。
const DONE_CHECK = `node -e "const fs=require('fs');let s='';try{s=fs.readFileSync('src/done.txt','utf8')}catch(e){};if(!s.includes('完成')){console.log('src/done.txt 还没有 完成 标记，门禁不予通过');process.exit(1)}"`;
// 第 2 次尝试的回放覆盖：写入完成标记并提交，让门禁通过。
const DONE_WRITE = { writes: [{ path: 'src/done.txt', content: '任务完成\n' }], commit: '假执行者：写入完成标记' };

function fixture(t) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-retry-058-'));
  const repo = path.join(base, 'repo 058'), home = path.join(base, 'home 058');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '多次尝试测试']);
  git(repo, ['config', 'user.email', 'retry-058@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  commitAll(repo, '初始提交');
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 };
  const f = { base, repo, home, env, profile };
  // profiles 可以整个替换（升级用例要第二个配置）；默认只有 fake。
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
  // 停止用例：拿得住还没结束的派发进程本身（不 await）。
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
  // 069：targets 里的元素是 { pid, created } 身份时按身份（PID + 创建时间）匹配，PID 被别的进程复用不算；纯 PID 数字仍按 PID 匹配（停止前取快照用）。
  f.related = async targets => {
    const list = await processList();
    const matches = p => targets.some(target => typeof target === 'number' ? target === p.pid : identityAlive([p], target));
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
    assert.ok(path.relative(realpathSync.native(os.tmpdir()), base).startsWith('ar-retry-058-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('第 1 次门禁失败、第 2 次通过：attempts 目录齐全、清单顺序、顶层 gate.json 是第 2 次的', async t => {
  const f = fixture(t);
  f.setProfile({
    events: [{ kind: 'say', text: '第一次尝试' }],
    attempts: { 2: { events: [{ kind: 'say', text: '第二次尝试' }], ...DONE_WRITE } },
  });
  const spec = f.spec('docs/specs/001-先败后成.md', { allowed: ['src/**'], verify: [DONE_CHECK], maxRetries: 1 });

  const result = await f.ar(['dispatch', spec, '--name', '先败后成', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).exit, 0);

  const start = startOf(f.home, '先败后成');
  assert.deepEqual(eventsOf(f.home, start.id),
    ['start', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end'],
    '两次尝试的完整清单顺序');
  const list = rows(f.home).filter(row => row.id === start.id);
  const attempts = list.filter(row => row.event === 'attempt');
  assert.deepEqual(attempts.map(row => [row.n, row.total, row.reason, row.profile]), [[1, 2, 'first', 'fake'], [2, 2, 'gate', 'fake']]);
  const gates = list.filter(row => row.event === 'gate');
  assert.deepEqual(gates.map(row => [row.attempt, row.ok]), [[1, false], [2, true]]);
  const end = list.at(-1);
  assert.equal(end.exit, 0);
  assert.equal(end.attempts, 2);
  assert.equal(end.agentExit, 0, '跑过门禁的任务 end 另有 agentExit');

  // attempts/1、attempts/2 各有 prompt.md、raw.log、gate.json；第 1 次 prompt 是原始指令。
  for (const n of [1, 2]) {
    for (const file of ['prompt.md', 'raw.log', 'gate.json']) {
      assert.ok(existsSync(path.join(f.dir('先败后成'), 'attempts', String(n), file)), `attempts/${n}/${file} 存在`);
    }
  }
  const prompt1 = readFileSync(path.join(f.dir('先败后成'), 'attempts', '1', 'prompt.md'), 'utf8');
  const prompt2 = readFileSync(path.join(f.dir('先败后成'), 'attempts', '2', 'prompt.md'), 'utf8');
  assert.ok(!prompt1.includes('上一次尝试没有通过验收'), '第 1 次 prompt 是原始指令');
  assert.match(prompt2, /## 上一次尝试没有通过验收（第 1 次，共允许 2 次）/);
  assert.match(prompt2, /src\/done\.txt 还没有 完成 标记/, '第 2 次 prompt 含第 1 次失败命令的输出末尾');
  assert.match(prompt2, /输出末尾/);
  // 顶层 gate.json 与第 2 次的一字不差（每次门禁跑完立即复制）。
  assert.equal(
    readFileSync(path.join(f.dir('先败后成'), 'gate.json'), 'utf8'),
    readFileSync(path.join(f.dir('先败后成'), 'attempts', '2', 'gate.json'), 'utf8'),
    '顶层 gate.json 是第 2 次的');
  // raw.log 两份：attempts/<n>/ 只有这次，顶层跨两次尝试连续。
  const raw1 = readFileSync(path.join(f.dir('先败后成'), 'attempts', '1', 'raw.log'), 'utf8');
  const raw2 = readFileSync(path.join(f.dir('先败后成'), 'attempts', '2', 'raw.log'), 'utf8');
  assert.ok(raw1.includes('第一次尝试') && !raw1.includes('第二次尝试'));
  assert.ok(raw2.includes('第二次尝试') && !raw2.includes('第一次尝试'));
  const rawTop = readFileSync(path.join(f.dir('先败后成'), 'raw.log'), 'utf8');
  assert.ok(rawTop.includes('第一次尝试') && rawTop.includes('第二次尝试'), '顶层 raw.log 连续追加两次');
  // events.jsonl：每个事件带 attempt，seq 跨尝试连续。
  const events = readFileSync(start.events, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.length >= 2, '两次尝试各有事件');
  events.forEach((event, n) => {
    assert.ok([1, 2].includes(event.attempt), `第 ${n + 1} 个事件有 attempt`);
    assert.equal(event.seq, n + 1, 'seq 跨尝试连续');
  });
  assert.deepEqual(events.map(event => event.attempt), [1, 2]);
  // 进度分隔行只从第 2 次开始写。
  assert.match(f.progress('先败后成'), /=== 第 2 次尝试（执行者：假执行者；原因：门禁未通过）===/);
  assert.ok(!f.progress('先败后成').includes('第 1 次尝试'), '第 1 次不写分隔行');
});

test('一直失败：共 1 + max_retries 次，end.exit 3，每次分隔行各一条', async t => {
  const f = fixture(t);
  f.setProfile({}); // 什么都不写 → 每次门禁都"没有提交任何改动"
  const spec = f.spec('docs/specs/002-一直失败.md', { allowed: ['src/**'] }); // 不写 max_retries → 默认 2

  const result = await f.ar(['dispatch', spec, '--name', '一直失败', '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  const start = startOf(f.home, '一直失败');
  const list = rows(f.home).filter(row => row.id === start.id);
  const end = list.at(-1);
  assert.equal(end.exit, 3, '门禁未通过时 end.exit 是 3');
  assert.equal(end.attempts, 3);
  assert.equal(list.filter(row => row.event === 'attempt').length, 3);
  assert.equal(list.filter(row => row.event === 'attempt-end').length, 3);
  assert.equal(list.filter(row => row.event === 'end').length, 1, '只写一次 end');
  for (const n of [1, 2, 3]) assert.ok(existsSync(path.join(f.dir('一直失败'), 'attempts', String(n), 'gate.json')), `attempts/${n}/gate.json`);
  const progress = f.progress('一直失败');
  assert.equal((progress.match(/=== 第 \d+ 次尝试（执行者：假执行者；原因：门禁未通过）===/g) ?? []).length, 2, '第 2、3 次各一条分隔行');
});

test('执行者崩溃（exit 1）后重试成功：第 2 次 reason agent，prompt 含出错信息', async t => {
  const f = fixture(t);
  f.setProfile({
    attempts: {
      1: { exit: 1, events: [{ kind: 'error', text: '模拟崩溃：连接中断' }] },
      2: { ...DONE_WRITE },
    },
  });
  const spec = f.spec('docs/specs/003-崩溃后成功.md', { allowed: ['src/**'], verify: [DONE_CHECK], maxRetries: 1 });

  const result = await f.ar(['dispatch', spec, '--name', '崩溃后成功', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const start = startOf(f.home, '崩溃后成功');
  assert.deepEqual(eventsOf(f.home, start.id),
    ['start', 'attempt', 'spawned', 'attempt-end', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end'],
    '第 1 次执行者失败不跑门禁');
  const attempts = rows(f.home).filter(row => row.id === start.id && row.event === 'attempt');
  assert.deepEqual(attempts.map(row => [row.n, row.reason]), [[1, 'first'], [2, 'agent']]);
  const ends = rows(f.home).filter(row => row.id === start.id && row.event === 'attempt-end');
  assert.deepEqual(ends.map(row => [row.n, row.ok, row.exit, row.gate]), [[1, false, 1, null], [2, true, 0, true]]);
  const end = rows(f.home).filter(row => row.id === start.id).at(-1);
  assert.equal(end.exit, 0);
  assert.equal(end.attempts, 2);
  const prompt2 = readFileSync(path.join(f.dir('崩溃后成功'), 'attempts', '2', 'prompt.md'), 'utf8');
  assert.match(prompt2, /失败原因：执行者异常退出（exit 1）/);
  assert.match(prompt2, /模拟崩溃：连接中断/, '第 2 次 prompt 含出错信息');
  assert.match(f.progress('崩溃后成功'), /=== 第 2 次尝试（执行者：假执行者；原因：执行者异常退出（exit 1））===/);
});

test('执行者没能启动（缺密钥）：不重试，只有 1 次尝试', async t => {
  const f = fixture(t);
  f.setProfile({ secrets: { RETRY_TEST_KEY: 'RETRY_MISSING_SOURCE_058' } });
  const spec = f.spec('docs/specs/004-缺密钥.md', { allowed: ['src/**'] });

  const result = await f.ar(['dispatch', spec, '--name', '缺密钥', '--json']);
  assert.equal(result.code, 1, result.stderr + result.stdout);
  assert.match(result.stdout + result.stderr + f.progress('缺密钥'), /未设置密钥 RETRY_MISSING_SOURCE_058/);
  const start = startOf(f.home, '缺密钥');
  assert.deepEqual(eventsOf(f.home, start.id), ['start', 'attempt', 'attempt-end', 'end'], '没启动成功就没有 spawned');
  const list = rows(f.home).filter(row => row.id === start.id);
  assert.equal(list.filter(row => row.event === 'attempt').length, 1, '启动失败不重试');
  assert.equal(list.at(-1).attempts, 1);
  assert.equal(list.at(-1).exit, 1);
});

test('升级：最后一次自动重试换成 escalate 的配置（attempt.profile），start.profile 不变', async t => {
  const f = fixture(t);
  f.setProfiles({
    fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 1, escalate: 'strong' },
    strong: { adapter: 'fake', label: '强执行者', enabled: true, events: [{ kind: 'say', text: '强执行者完成' }], report: '强汇报\n', exit: 0 },
  });
  const spec = f.spec('docs/specs/005-升级.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 2 });

  const result = await f.ar(['dispatch', spec, '--name', '升级任务', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const start = startOf(f.home, '升级任务');
  assert.equal(start.profile, 'fake', 'start.profile 仍是原来的配置');
  const list = rows(f.home).filter(row => row.id === start.id);
  const attempts = list.filter(row => row.event === 'attempt');
  assert.deepEqual(attempts.map(row => [row.n, row.profile, row.reason]), [[1, 'fake', 'first'], [2, 'fake', 'agent'], [3, 'strong', 'agent']]);
  const end = list.at(-1);
  assert.equal(end.exit, 0);
  assert.equal(end.attempts, 3);
  assert.match(f.progress('升级任务'), /=== 第 3 次尝试（执行者：强执行者；原因：执行者异常退出（exit 1））===/);
});

test('升级：目标未启用时不升级，进度行写明原因', async t => {
  const f = fixture(t);
  f.setProfiles({
    fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 1, escalate: 'strong' },
    strong: { adapter: 'fake', label: '强执行者', enabled: false, events: [], report: '强汇报\n', exit: 0 },
  });
  const spec = f.spec('docs/specs/006-升级停用.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 1 });

  const result = await f.ar(['dispatch', spec, '--name', '升级停用', '--json']);
  assert.equal(result.code, 1, result.stderr + result.stdout);
  const start = startOf(f.home, '升级停用');
  const attempts = rows(f.home).filter(row => row.id === start.id && row.event === 'attempt');
  assert.deepEqual(attempts.map(row => [row.n, row.profile]), [[1, 'fake'], [2, 'fake']], '目标停用时两次都是原配置');
  const end = rows(f.home).filter(row => row.id === start.id).at(-1);
  assert.equal(end.exit, 1);
  assert.equal(end.attempts, 2);
  assert.match(f.progress('升级停用'), /升级：strong 没有启用，继续用 假执行者/);
});

test('升级：--detach 派发时同样升级（升级快照随请求带走，执行者进程内完成）', async t => {
  const f = fixture(t);
  f.setProfiles({
    fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 1, escalate: 'strong' },
    strong: { adapter: 'fake', label: '强执行者', enabled: true, events: [{ kind: 'say', text: '强执行者完成' }], report: '强汇报\n', exit: 0 },
  });
  const spec = f.spec('docs/specs/007-脱离升级.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 1 });

  const detached = await f.ar(['dispatch', spec, '--name', '脱离升级', '--detach', '--json']);
  assert.equal(detached.code, 0, detached.stderr + detached.stdout);
  await until(() => startOf(f.home, '脱离升级'), '脱离升级的 start 记录');
  const waited = await f.ar(['wait', '脱离升级', '--json'], { timeout: 90000 });
  assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  const start = startOf(f.home, '脱离升级');
  assert.equal(start.profile, 'fake');
  const attempts = rows(f.home).filter(row => row.id === start.id && row.event === 'attempt');
  assert.deepEqual(attempts.map(row => [row.n, row.profile]), [[1, 'fake'], [2, 'strong']], '第 2 次（最后一次自动重试）已升级');
  const end = rows(f.home).filter(row => row.id === start.id).at(-1);
  assert.equal(end.exit, 0);
  assert.equal(end.attempts, 2);
});

test('max_retries 0 只跑一次；项目配置 maxRetries 生效；直接任务文字不重试', async t => {
  const f = fixture(t);
  // 1) 任务说明 max_retries: 0：门禁失败也只跑一次。
  f.setProfile({});
  const specA = f.spec('docs/specs/008-次数为零.md', { allowed: ['src/**'], maxRetries: 0 });
  const zero = await f.ar(['dispatch', specA, '--name', '次数为零', '--json']);
  assert.equal(zero.code, 3, zero.stderr + zero.stdout);
  const startA = startOf(f.home, '次数为零');
  assert.deepEqual(eventsOf(f.home, startA.id), ['start', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end']);
  const attemptA = rows(f.home).find(row => row.id === startA.id && row.event === 'attempt');
  assert.equal(attemptA.total, 1);
  assert.equal(rows(f.home).filter(row => row.id === startA.id).at(-1).attempts, 1);

  // 2) 项目配置 maxRetries: 1：说明没写时按它重试（共 2 次）。
  write(path.join(f.repo, '.agent-router/project.json'), `${JSON.stringify({ maxRetries: 1 })}\n`);
  const specB = f.spec('docs/specs/009-项目次数.md', { allowed: ['src/**'] });
  const project = await f.ar(['dispatch', specB, '--name', '项目次数', '--json']);
  assert.equal(project.code, 3, project.stderr + project.stdout);
  const startB = startOf(f.home, '项目次数');
  const attemptB = rows(f.home).find(row => row.id === startB.id && row.event === 'attempt');
  assert.equal(attemptB.total, 2, '项目配置 maxRetries 生效');
  assert.equal(rows(f.home).filter(row => row.id === startB.id).at(-1).attempts, 2);

  // 3) 直接任务文字：没有任务说明，总次数 1（即使项目配置写了 maxRetries）。
  const direct = await f.ar(['dispatch', '直接写的 任务文字', '--name', '直接不重试', '--json']);
  assert.equal(direct.code, 0, direct.stderr + direct.stdout);
  const startC = startOf(f.home, '直接不重试');
  assert.equal(Object.hasOwn(startC, 'gate'), false, '直接任务文字没有 gate 字段');
  assert.deepEqual(eventsOf(f.home, startC.id), ['start', 'attempt', 'spawned', 'attempt-end', 'end']);
  const attemptC = rows(f.home).find(row => row.id === startC.id && row.event === 'attempt');
  assert.equal(attemptC.total, 1);
  assert.equal(rows(f.home).filter(row => row.id === startC.id).at(-1).attempts, 1);
});

test('重试中途 ar stop：写 interrupted，不写第 2 个 attempt-end 与 end，不开始第 3 次，进程树都退出', async t => {
  const f = fixture(t);
  // 第 1 次快速以 exit 1 结束；第 2 次跑起来后长时间不退出，留出停止窗口。
  f.setProfile({
    exit: 1,
    attempts: { 2: { events: [{ kind: 'say', text: '第二次尝试运行中' }], delayMs: 60000, exit: 1 } },
  });
  const spec = f.spec('docs/specs/010-中途停止.md', { allowed: ['src/**'], maxRetries: 2 });
  const name = '中途停止';

  const dispatching = f.spawnAr(['dispatch', spec, '--name', name]);
  const start = await until(() => startOf(f.home, name), '中途停止的 start 记录');
  const second = await until(() => {
    const spawned = rows(f.home).filter(row => row.id === start.id && row.event === 'spawned');
    return spawned.length >= 2 ? spawned[1] : null;
  }, '第 2 次尝试的 spawned 记录');
  assert.ok(pidAlive(start.pid), '停止前派发进程存活');
  assert.ok(pidAlive(second.agentPid), '停止前第 2 次的执行者存活');
  const before = await f.related([start.pid, second.agentPid]);
  assert.ok(before.some(p => p.pid === start.pid), '停止前快照里有派发进程');
  assert.ok(before.some(p => p.pid === second.agentPid), '停止前快照里有第 2 次的执行者');

  const stop = await f.ar(['stop', name]);
  assert.equal(stop.code, 0, stop.stderr + stop.stdout);
  await dispatching.done; // 被停止的派发进程退出（不设断言：被强杀时退出码因平台而异）

  const events = eventsOf(f.home, start.id);
  assert.deepEqual(events, ['start', 'attempt', 'spawned', 'attempt-end', 'attempt', 'spawned', 'interrupted'],
    '没有第 2 个 attempt-end，也没有 end');
  assert.ok(!events.includes('end'), '不写 end');
  const attempts = rows(f.home).filter(row => row.id === start.id && row.event === 'attempt');
  assert.deepEqual(attempts.map(row => row.n), [1, 2], '不开始第 3 次');
  assert.equal(rows(f.home).filter(row => row.id === start.id && row.event === 'attempt-end').length, 1);
  assert.equal(rows(f.home).filter(row => row.id === start.id).at(-1).signal, 'stopped-by-command');
  const progress = f.progress(name);
  assert.match(progress, /=== 第 2 次尝试（执行者：假执行者；原因：执行者异常退出（exit 1））===/);
  assert.ok(!progress.includes('第 3 次尝试'), '不写第 3 次分隔行');
  // 进程树都退出（按停止前快照里的身份核对，防止 PID 复用误判）。
  const identities = [before.find(p => p.pid === start.pid), before.find(p => p.pid === second.agentPid)];
  assert.ok(identities.every(p => p && Number.isFinite(p.created)), '停止前快照里有派发进程与第 2 次执行者的创建时间');
  await f.waitGone(identities, '停止后仍有进程'); // 069：按停止前的身份（PID + 创建时间）
  assert.deepEqual(await sameProcessesAlive(identities), [], '派发进程与第 2 次执行者（同一 PID、同一创建时间）都已退出');
});

// 102：派发进程意外退出、清单里没有结束记录（实测 094）：ar retry 先补写 interrupted（process-gone）再重试，不再卡在"任务还在进行"。
test('派发进程意外退出后直接 ar retry：补写 interrupted，resume 与第 2 次尝试正常开始，进度里有那一行', async t => {
  const f = fixture(t);
  f.setProfile({
    attempts: {
      1: { events: [{ kind: 'say', text: '跑着' }], delayMs: 60000, exit: 1 },
      2: { events: [{ kind: 'say', text: '第二次完成' }], exit: 0 },
    },
  });
  const spec = f.spec('docs/specs/012-意外退出后重试.md', { type: 'research', allowed: null, verify: [], expectCommit: false, maxRetries: 0 });
  const name = '意外退出后重试';
  const dispatching = f.spawnAr(['dispatch', spec, '--name', name]);
  const start = await until(() => startOf(f.home, name), '意外退出后重试的 start 记录');
  const spawned = await until(() => rows(f.home).find(row => row.id === start.id && row.event === 'spawned'), 'spawned 记录');
  // 结束派发进程本身，不写任何结束记录（模拟意外退出）；只结束这次测试自己启动的两个进程，按创建时间核对身份。
  const before = await f.related([start.pid, spawned.agentPid]);
  const agentIdentity = before.find(p => p.pid === spawned.agentPid);
  dispatching.kill();
  await dispatching.done;
  if (agentIdentity && identityAlive(await processList(), agentIdentity)) { try { process.kill(spawned.agentPid); } catch { /* 已经退出。 */ } }
  assert.deepEqual(eventsOf(f.home, start.id), ['start', 'attempt', 'spawned'], '意外退出：没有 end，也没有 interrupted');

  const retried = await f.ar(['retry', name, '--note', '接着做', '--json']);
  assert.equal(retried.code, 0, retried.stderr + retried.stdout);
  assert.equal(JSON.parse(retried.stdout).n, 2);

  const events = rows(f.home).filter(row => row.id === start.id);
  assert.deepEqual(events.map(row => row.event).slice(0, 7), ['start', 'attempt', 'spawned', 'interrupted', 'resume', 'attempt', 'spawned']);
  const interrupted = events.find(row => row.event === 'interrupted');
  assert.equal(interrupted.signal, 'process-gone');
  assert.ok(Number.isFinite(interrupted.at));
  assert.equal(events.filter(row => row.event === 'interrupted').length, 1);
  assert.equal(events.find(row => row.event === 'resume').n, 2);
  assert.deepEqual(events.filter(row => row.event === 'attempt').map(row => row.n), [1, 2]);
  const end = events.at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.exit, 0);
  assert.equal(end.attempts, 2);
  assert.match(f.progress(name), /\] 重试：上一次的派发进程意外退出，已记为中断\n/);
  assert.ok(existsSync(path.join(f.dir(name), 'attempts', '2', 'prompt.md')), '第 2 次尝试目录存在');
});

test('密钥扫描：重试时 prompt.md、raw.log、events.jsonl 都不含密钥值', async t => {
  const f = fixture(t);
  const secretValue = '假密钥值-058-绝不能出现在任何文件里-XYZZY';
  f.setProfile({
    secrets: { RETRY_SCAN_KEY: 'RETRY_SCAN_SOURCE_058' },
    events: [{ kind: 'say', text: '跑一次' }],
    attempts: { 2: { ...DONE_WRITE } },
  });
  const spec = f.spec('docs/specs/011-密钥扫描.md', { allowed: ['src/**'], verify: [DONE_CHECK], maxRetries: 1 });

  const result = await f.ar(['dispatch', spec, '--name', '密钥扫描', '--json'], { extraEnv: { RETRY_SCAN_SOURCE_058: secretValue } });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.ok(!result.stdout.includes(secretValue) && !result.stderr.includes(secretValue), '密钥值不出现在命令输出里');
  // 扫描任务目录与公共目录里的每个文件（prompt.md、raw.log、events.jsonl 在其中），都不含密钥值。
  const files = [];
  const collect = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(p);
      else files.push(p);
    }
  };
  collect(path.join(f.repo, '.agent-runs'));
  collect(f.home);
  assert.ok(files.some(file => file.endsWith(path.join('attempts', '1', 'prompt.md'))), '扫描覆盖 attempts/1/prompt.md');
  assert.ok(files.some(file => file.endsWith(path.join('attempts', '2', 'prompt.md'))), '扫描覆盖 attempts/2/prompt.md');
  assert.ok(files.some(file => file.endsWith('events.jsonl')), '扫描覆盖 events.jsonl');
  for (const file of files) {
    assert.ok(!readFileSync(file, 'utf8').includes(secretValue), `密钥出现在 ${path.relative(f.base, file)}`);
  }
});

test('--detach：多次尝试全部在执行者进程内完成，ar wait 等到最终结果', async t => {
  const f = fixture(t);
  f.setProfile({
    events: [{ kind: 'say', text: '第一次尝试' }],
    attempts: { 2: { events: [{ kind: 'say', text: '第二次尝试' }], ...DONE_WRITE } },
  });
  const spec = f.spec('docs/specs/012-脱离重试.md', { allowed: ['src/**'], verify: [DONE_CHECK], maxRetries: 1 });

  const detached = await f.ar(['dispatch', spec, '--name', '脱离重试', '--detach', '--json']);
  assert.equal(detached.code, 0, detached.stderr + detached.stdout);
  assert.equal(JSON.parse(detached.stdout).detached, true);
  await until(() => startOf(f.home, '脱离重试'), '脱离重试的 start 记录');

  const waited = await f.ar(['wait', '脱离重试', '--json'], { timeout: 90000 });
  assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  const result = JSON.parse(waited.stdout);
  assert.equal(result.exit, 0);
  assert.deepEqual(result.gate, { ok: true, summary: '门禁通过' });
  const start = startOf(f.home, '脱离重试');
  assert.deepEqual(eventsOf(f.home, start.id),
    ['start', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end'],
    '两次尝试都在执行者进程内的清单顺序');
  const end = rows(f.home).filter(row => row.id === start.id).at(-1);
  assert.equal(end.exit, 0);
  assert.equal(end.attempts, 2);
});
