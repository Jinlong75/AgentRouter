import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';
import { worktreeDir } from '../../core/lib/worktree.mjs';

// 085：准备失败后手动 ar retry 重跑准备命令（协议 15.4）。真实 git 仓库，AR_WORKTREE_ROOT 与 AGENT_ROUTER_HOME 在用例自己的临时目录，执行者是 fake。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const commitAll = (root, message) => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
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

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 准备重试 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  const wtRoot = path.join(base, 'wt 根');
  const marker = path.join(base, '标记 文件.flag');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: wtRoot, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '准备重试测试']);
  git(repo, ['config', 'user.email', 'setup-retry@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  // 准备脚本：标记文件（在项目之外，测试随时可以补上）不存在就失败。
  write(path.join(repo, 'scripts/setup.mjs'), [
    "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
    `if (!existsSync(${JSON.stringify(marker)})) { console.error('缺少标记文件'); process.exit(1); }`,
    "mkdirSync('node_modules', { recursive: true });",
    "writeFileSync('node_modules/.setup-ran', 'x');",
    "console.log('准备完成');",
    '',
  ].join('\n'));
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: ['node scripts/setup.mjs'], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true }, null, 2));
  commitAll(repo, '初始提交');
  const f = { base, repo, home, wtRoot, env, marker, count: 0 };
  write(path.join(home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
    profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改 a.js' } },
  }));
  f.ar = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, 120000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  // 提交任务说明并派发，返回 { name, start, rel, result }。
  f.dispatch = async (name, expect) => {
    f.count += 1;
    const rel = `docs/specs/${930 + f.count}-setup.md`;
    write(path.join(repo, rel), ['---', 'id: 930', 'title: 准备重试', 'type: code', 'expect_commit: false', 'allowed_paths:', '  - src/**', 'verify:', '  - node -e "process.exit(0)"', '---', '', '正文。', ''].join('\n'));
    commitAll(repo, `任务说明 ${name}`);
    const result = await f.ar(['dispatch', rel, '--name', name, '--json']);
    assert.equal(result.code, expect, result.stderr + result.stdout);
    const start = rows(home).find(row => row.event === 'start' && row.name === name);
    return { name, start, rel, result };
  };
  f.events = id => rows(home).filter(row => row.id === id);
  f.slots = () => { try { return readdirSync(path.join(home, 'slots')); } catch { return []; } };
  t.after(async () => {
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 准备重试 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}
test('1 准备命令第 1 次失败 → 补上标记文件 → ar retry --note：第二条 preparing 与 setup（ok）、attempts/<n>/setup.log、执行者启动、门禁通过、end.exit 0，之后能 accept', async t => {
  const f = fixture(t);
  const task = await f.dispatch('准备重试一', 1);
  let events = f.events(task.start.id);
  assert.deepEqual(events.map(row => row.event), ['start', 'preparing', 'worktree', 'setup', 'end']);
  assert.equal(events.at(-1).reason, 'setup');
  assert.equal(events.at(-1).attempts, 0);
  assert.equal(events.find(row => row.event === 'setup').ok, false);
  const wt = events.find(row => row.event === 'worktree');
  assert.ok(existsSync(wt.dir));
  assert.match(readFileSync(path.join(task.start.dir, 'attempts', '0', 'setup.log'), 'utf8'), /缺少标记文件/);

  writeFileSync(f.marker, '好了');
  const result = await f.ar(['retry', task.name, '--note', '依赖已经装好了', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.n, 1, '一次尝试都没开始过，从第 1 次起');
  assert.deepEqual(value.gate, { ok: true, summary: '门禁通过' });

  events = f.events(task.start.id);
  const names = events.map(row => row.event);
  assert.deepEqual(names.slice(names.indexOf('resume')), ['resume', 'preparing', 'setup', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end']);
  assert.equal(names.filter(name => name === 'preparing').length, 2, '第二条 preparing');
  assert.equal(names.filter(name => name === 'worktree').length, 1, '不再建 worktree');
  const setups = events.filter(row => row.event === 'setup');
  assert.deepEqual(setups.map(row => row.ok), [false, true]);
  assert.equal(setups[1].summary, '准备命令完成');
  const attempt = events.findLast(row => row.event === 'attempt');
  assert.equal(attempt.n, 1);
  assert.equal(attempt.reason, 'manual');
  assert.equal(events.at(-1).exit, 0);
  assert.equal(events.at(-1).reason, undefined);
  assert.equal(events.at(-1).attempts, 1);

  const log = readFileSync(path.join(task.start.dir, 'attempts', '1', 'setup.log'), 'utf8');
  assert.match(log, /^\$ node scripts\/setup\.mjs\r?\n准备完成\r?\n$/);
  assert.match(readFileSync(path.join(task.start.dir, 'attempts', '0', 'setup.log'), 'utf8'), /缺少标记文件/, '第一次的日志还在');
  assert.ok(existsSync(path.join(wt.dir, 'node_modules/.setup-ran')), '准备命令在原 worktree 里重跑');
  // 执行者没有上一次失败的段落（它从没跑过），但带补充说明。
  const prompt = readFileSync(path.join(task.start.dir, 'attempts', '1', 'prompt.md'), 'utf8');
  assert.ok(!prompt.includes('上一次尝试没有通过验收'));
  assert.match(prompt, /## 主导补充说明\n\n依赖已经装好了/);
  assert.equal(readFileSync(path.join(wt.dir, 'src/a.js'), 'utf8'), '改过\n');
  assert.deepEqual(f.slots(), [], '名额释放');
  assert.match(readFileSync(path.join(task.start.dir, 'progress.log'), 'utf8'), /准备命令：准备命令完成/);

  const accepted = await f.ar(['accept', task.name, '--json']);
  assert.equal(accepted.code, 0, accepted.stderr + accepted.stdout);
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), '改过\n');
});

test('2 准备命令再失败：end.exit 1、reason setup、没有 attempt、日志是这次的；补上标记文件后再 retry（--detach）通过，日志不累积', async t => {
  const f = fixture(t);
  const task = await f.dispatch('准备重试二', 1);

  let result = await f.ar(['retry', task.name, '--json']);
  assert.equal(result.code, 1, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.match(JSON.parse(result.stdout).error, /准备命令失败：node scripts\/setup\.mjs（exit 1）/);
  let events = f.events(task.start.id);
  let names = events.map(row => row.event);
  assert.deepEqual(names.slice(names.indexOf('resume')), ['resume', 'preparing', 'setup', 'end'], '没有 attempt');
  assert.equal(events.at(-1).exit, 1);
  assert.equal(events.at(-1).reason, 'setup');
  assert.equal(events.at(-1).attempts, 0);
  assert.equal(events.findLast(row => row.event === 'setup').ok, false);
  const firstLog = readFileSync(path.join(task.start.dir, 'attempts', '1', 'setup.log'), 'utf8');
  assert.match(firstLog, /缺少标记文件/);
  assert.deepEqual(f.slots(), [], '准备又失败也释放名额');

  writeFileSync(f.marker, '好了');
  const endsBefore = events.filter(row => row.event === 'end').length;
  result = await f.ar(['retry', task.name, '--detach', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  await until(() => f.events(task.start.id).filter(row => row.event === 'end').length > endsBefore, '第三次的 end');
  events = f.events(task.start.id);
  names = events.map(row => row.event);
  assert.deepEqual(names.slice(names.lastIndexOf('resume')), ['resume', 'preparing', 'setup', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end']);
  assert.equal(events.at(-1).exit, 0);
  assert.equal(events.findLast(row => row.event === 'attempt').n, 1);
  const log = readFileSync(path.join(task.start.dir, 'attempts', '1', 'setup.log'), 'utf8');
  assert.ok(!log.includes('缺少标记文件'), '重跑时日志从头写，不累积上一次的失败输出');
  assert.match(log, /^\$ node scripts\/setup\.mjs\r?\n准备完成\r?\n$/);
  assert.deepEqual(f.slots(), []);
});

test('3 建 worktree 本身失败（没有 worktree 事件）的任务 ar retry：退出码 2、协议原文，什么都不写', async t => {
  const f = fixture(t);
  // 先把 worktree 的目标目录占住：建 worktree 失败，清单里没有 worktree 事件。
  const dir = worktreeDir({ root: f.repo, name: '准备重试三', env: f.env });
  mkdirSync(dir, { recursive: true });
  const task = await f.dispatch('准备重试三', 1);
  const events = f.events(task.start.id);
  assert.deepEqual(events.map(row => row.event), ['start', 'preparing', 'setup', 'end']);
  assert.match(events.find(row => row.event === 'setup').summary, /worktree 目录已存在/);
  assert.equal(events.at(-1).reason, 'setup');

  const result = await f.ar(['retry', task.name, '--json']);
  assert.equal(result.code, 2, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: 'worktree 已经不在了：（清单里没有记录），用 ar redispatch 重新派发' });
  assert.equal(f.events(task.start.id).length, events.length, '没有写任何事件');
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), '初始\n', '主工作区没动');
});
