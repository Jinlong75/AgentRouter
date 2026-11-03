import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const ar = resolve('core/ar.mjs');
test('无验收命令和用法错误返回 2，last 可读取', (t) => {
  const root = mkdtempSync(join(tmpdir(),'ar-verify-')), home = join(root,'home'); mkdirSync(home);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => spawnSync('git', args, { cwd:root, encoding:'utf8' }); git('init'); git('config','user.email','test@example.invalid'); git('config','user.name','Test'); writeFileSync(join(root,'a'), 'a'); git('add','a'); git('commit','-m','init');
  const run = (...args) => spawnSync(process.execPath, [ar, 'verify', ...args], { cwd:root, env:{ ...process.env, AGENT_ROUTER_HOME:home }, encoding:'utf8' });
  assert.equal(run().status, 2); assert.match(run().stderr + run().stdout, /项目配置没有全量验收命令/);
  assert.equal(run('--timeout-min','0').status, 2); const last = run('--last','--json'); assert.equal(last.status, 0); assert.equal(JSON.parse(last.stdout).last, null);
});
test('记录通过和失败，并拒绝已跟踪的改动', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ar-full-cli-')), home = join(root, 'home'); mkdirSync(home); mkdirSync(join(root, '.agent-router'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  const config = join(root, '.agent-router', 'project.json');
  writeFileSync(config, JSON.stringify({ verify: ['node -e "process.exit(0)"'] }));
  git('add', '.agent-router/project.json'); git('commit', '-m', 'init');
  const run = (...args) => spawnSync(process.execPath, [ar, 'verify', ...args], { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home }, encoding: 'utf8' });
  const pass = run('--json'); assert.equal(pass.status, 0, pass.stderr); const result = JSON.parse(pass.stdout); assert.equal(result.ok, true);
  assert.ok(run().stdout.includes(`全量验收通过：${result.branch} ${result.head.slice(0, 7)}`));
  assert.equal(JSON.parse(readFileSync(join(result.log, '..', 'result.json'), 'utf8')).head, result.head);
  assert.match(readFileSync(join(home, 'runs.jsonl'), 'utf8'), /"event":"full-verify"/);
  writeFileSync(config, JSON.stringify({ verify: ['node -e "process.exit(7)"'] })); assert.equal(run().status, 2);
  git('add', '.agent-router/project.json'); git('commit', '-m', 'failure');
  const failed = run('--json'); assert.equal(failed.status, 3, failed.stderr); assert.equal(JSON.parse(failed.stdout).exitCode, 7);
  const failure = JSON.parse(failed.stdout); const textFailure = run(); assert.equal(textFailure.status, 3); assert.ok(textFailure.stdout.includes(`全量验收失败：${failure.branch} ${failure.head.slice(0, 7)}，失败命令：${failure.failed}；日志：`));
  assert.match(run('--last').stdout, /失败/);
});


test('additional verification coverage', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ar-full-detach-')), home = join(root, 'home'); mkdirSync(home); mkdirSync(join(root, '.agent-router'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ verify: ['node -e "process.exit(0)"'] }));
  git('add', '.agent-router/project.json'); git('commit', '-m', 'init');
  const run = (...args) => spawnSync(process.execPath, [ar, 'verify', ...args], { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home }, encoding: 'utf8' });
  const started = run('--detach'); assert.equal(started.status, 0, started.stderr); assert.match(started.stdout, /ar verify --last/);
  let last;
  for (let i = 0; i < 50; i++) { await new Promise(resolve => setTimeout(resolve, 100)); const result = run('--last', '--json'); assert.equal(result.status, 0, result.stderr); last = JSON.parse(result.stdout); if (last.last) break; }
  assert.equal(last.last?.ok, true); assert.equal(last.running, null); assert.match(run('--last').stdout, /\d{2}-\d{2}/);
});

function fixture(t, script) {
  const root = mkdtempSync(join(tmpdir(), 'ar-verify-case-')), home = join(root, 'home'); mkdirSync(home); mkdirSync(join(root, '.agent-router'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ verify: [typeof script === 'function' ? script(root) : script] }));
  git('add', '.agent-router/project.json'); git('commit', '-m', 'init');
  const env = { ...process.env, AGENT_ROUTER_HOME: home };
  const run = (...args) => spawnSync(process.execPath, [ar, 'verify', ...args], { cwd: root, env, encoding: 'utf8' });
  return { root, home, git, env, run };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const value = fn(); if (value) return value; await pause(200); } throw new Error('等待验收状态超时'); }
function waitingCommand(root) {
  const started = JSON.stringify(join(root, 'verify-started'));
  const release = JSON.stringify(join(root, 'verify-release'));
  return `node -e 'const fs=require("fs");fs.writeFileSync(${started},"1");const timer=setInterval(()=>{if(fs.existsSync(${release})){clearInterval(timer);clearTimeout(limit)}},100);const limit=setTimeout(()=>process.exit(1),60000)'`;
}

test('后台运行可查询并拒绝重复运行', async (t) => {
  const f = fixture(t, waitingCommand);
  const start = f.run('--detach'); assert.equal(start.status, 0); assert.match(start.stdout, /已在后台开始/);
  let last;
  try {
    await until(() => existsSync(join(f.root, 'verify-started')));
    const running = f.run('--last'); assert.match(running.stdout, /正在运行/);
    assert.equal(f.run().status, 2);
  } finally {
    writeFileSync(join(f.root, 'verify-release'), '');
    last = await until(() => { const v = JSON.parse(f.run('--last', '--json').stdout); return v.last && !v.running && v; });
  }
  assert.equal(last.last.ok, true); assert.match(f.run('--last').stdout, /通过/);
});

test('运行中提交变化使结果作废', async (t) => {
  const f = fixture(t, waitingCommand);
  const before = f.git('rev-parse', 'HEAD').stdout.trim();
  const child = spawn(process.execPath, [ar, 'verify'], { cwd: f.root, env: f.env });
  const closed = new Promise(resolve => child.on('close', resolve));
  let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  let after, code;
  try {
    // 等验收命令真正开始后提交，确保提交落在命令运行期间。
    await until(() => existsSync(join(f.root, 'verify-started')));
    writeFileSync(join(f.root, 'change'), 'change'); f.git('add', 'change'); f.git('commit', '-m', 'change');
    after = f.git('rev-parse', 'HEAD').stdout.trim();
  } finally {
    writeFileSync(join(f.root, 'verify-release'), '');
    code = await closed;
  }
  assert.equal(code, 3, stderr);
  assert.ok(stdout.includes(`全量验收作废：验收期间分支或提交变了（${before.slice(0,7)} → ${after.slice(0,7)}），请在不提交、不合入时重跑`));
  const row = JSON.parse(readFileSync(join(f.home, 'runs.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(row.failed, `验收期间分支或提交变了：${before.slice(0,7)} → ${after.slice(0,7)}`); assert.equal(row.ok, false);
  const result = JSON.parse(readFileSync(join(row.log, '..', 'result.json'), 'utf8')); assert.equal(result.failed, row.failed); assert.equal(result.head, before); assert.equal(result.branch, row.branch);
});

test('日志实时保存完整输出', async (t) => {
  // stdout 与 stderr 分别写进日志：END（stderr）可能先落盘，等两条流都写全再读。
  const f = fixture(t, `node -e "process.stdout.write('START'+'x'.repeat(320000));process.stderr.write('END');const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync('log-observed'))clearInterval(timer)},100)"`);
  const start = f.run('--detach'); assert.equal(start.status, 0);
  try {
    const log = await until(() => { const v = JSON.parse(f.run('--last', '--json').stdout); if (!v.running) return null; try { const text = readFileSync(v.running, 'utf8'); return text.includes('END') && text.length > 300000 && v.running; } catch { return null; } });
    const text = readFileSync(log, 'utf8'); assert.match(text, /START/); assert.match(text, /END/); assert.ok(text.length > 300000);
  } finally { writeFileSync(join(f.root, 'log-observed'), ''); }
  await until(() => { const v = JSON.parse(f.run('--last', '--json').stdout); return v.last && !v.running; });
});
test('取得名额后发现未提交改动：抛错且留下失败记录（后台运行时 --last 能看到）', async (t) => {
  // 336c R3-1（主导）：直接调用 executeVerify 模拟后台进程取得名额后的检查。
  const { executeVerify } = await import('../../core/lib/verify-full.mjs');
  const root = mkdtempSync(join(tmpdir(), 'ar-verify-refuse-')), home = join(root, 'home'), dir = join(root, '.agent-runs', '_verify', 'run');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(home); mkdirSync(join(root, '.agent-router')); mkdirSync(dir, { recursive: true });
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test'); git('config', 'core.autocrlf', 'false');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ verify: ['node -e "process.exit(0)"'] }));
  writeFileSync(join(root, 'a.txt'), '1'); git('add', '.'); git('commit', '-q', '-m', 'init');
  writeFileSync(join(root, 'a.txt'), '2');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  await assert.rejects(executeVerify({ root, home, env: process.env, commands: ['node -e "process.exit(0)"'], branch: 'main', head, startedAt: Date.now(), dir, timeoutMin: 1, out: () => {} }), /未提交的改动/);
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  assert.equal(result.ok, false); assert.match(result.failed, /未提交的改动/); assert.equal(result.exitCode, 2);
  const events = readFileSync(join(home, 'runs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.event === 'full-verify');
  assert.equal(events.length, 1); assert.equal(events[0].ok, false); assert.match(events[0].failed, /未提交的改动/);
  const last = spawnSync(process.execPath, [ar, 'verify', '--last'], { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home }, encoding: 'utf8' });
  assert.match(last.stdout, /失败/);
});

test('全量配置优先与发布检查', async t => {
  const f = fixture(t, 'node -e "process.exit(9)"');
  const config = join(f.root, '.agent-router', 'project.json');
  const command = `node -e "process.exit(process.env.AR_FULL_VERIFY==='1'?0:8)"`;
  writeFileSync(config, JSON.stringify({ verify: ['node -e "process.exit(9)"'], fullVerify: [command], fullVerifyTimeoutMin: 2 }));
  f.git('add', '.agent-router/project.json'); f.git('commit', '-m', 'full');
  let required = f.run('--require', '--json'); assert.equal(required.status, 1); assert.deepEqual(JSON.parse(required.stdout).reasons, ['还没有全量验收记录']);
  assert.equal(f.run('--require', '--last').status, 2); assert.equal(f.run('--require', '--detach').status, 2);
  const pass = f.run('--json'); assert.equal(pass.status, 0, pass.stderr); const result = JSON.parse(pass.stdout);
  assert.deepEqual(result.commands, [command]); assert.equal(result.source, 'fullVerify');
  assert.match(f.run('--last').stdout, /命令：/); required = f.run('--require', '--json'); assert.equal(required.status, 0); assert.equal(JSON.parse(required.stdout).ok, true);
  writeFileSync(config, '{}'); assert.match(f.run('--require').stdout, /工作区有未提交的改动/);
  f.git('add', '.agent-router/project.json'); f.git('commit', '-m', 'next'); assert.match(f.run('--require').stdout, /最近一次全量验收对应/);
  const records = join(f.home, 'runs.jsonl'); const old = JSON.parse(readFileSync(records, 'utf8').trim().split('\n').at(-1));
  const { appendFileSync } = await import('node:fs'); appendFileSync(records, JSON.stringify({ ...old, head: f.git('rev-parse', 'HEAD').stdout.trim(), ok: false }) + '\n');
  assert.match(f.run('--require').stdout, /最近一次全量验收没有通过/);
  const dir = join(f.root, '.agent-runs', '_verify'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'running.json'), JSON.stringify({ pid: process.pid, started: Date.now(), log: 'test.log' }));
  assert.match(f.run('--require').stdout, /全量验收正在运行/);
});
