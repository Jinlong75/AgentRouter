import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const rows = home => { try { const s = fs.readFileSync(path.join(home, 'runs.jsonl'), 'utf8'); return s.trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
async function until(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = fn(); if (result) return result; await delay(25); }
  throw Error('隔离测试等待超时');
}

function fixture(t, { delayMs = 1000 } = {}) {
  const since = Date.now();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-redispatch-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo');
  for (const dir of [home, repo, path.join(repo, 'docs', 'roles'), path.join(repo, 'docs', 'specs')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'roles', 'worker.md'), '# 执行者\n');
  fs.writeFileSync(path.join(repo, 'docs', 'specs', '001-测试.md'), '# 测试任务\n');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'say', text: '正在做' }], report: '假汇报\n', exit: 0, delayMs };
  // 密钥来源与值只放在环境变量里；测试检查它们不会出现在 dispatch.json 或托管请求文件里。
  profile.secrets = { FAKE_API_KEY: 'FAKE_SECRET_SOURCE' };
  env.FAKE_SECRET_SOURCE = '假密钥值-不可出现在派发参数里';
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile } }));
  const children = new Set();
  function command(args) {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
    return child;
  }
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null && alive(child.pid)) child.kill();
    // 只清理本 fixture 记录的执行者进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-redispatch-'));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { base, home, repo, env, command };
}

const json = text => JSON.parse(text);
const dispatchFile = (repo, name) => path.join(repo, '.agent-runs', name, 'dispatch.json');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('派发写入 dispatch.json：完整任务文字、补充说明、角色与执行者，且不含密钥', async t => {
  const f = fixture(t, { delayMs: 2000 });
  const task = `请实现这个很长的任务说明，长度明显超过六十个字，确保保存的是完整原文而不是标题截断后的版本。${'继续补充细节。'.repeat(6)}结尾标记-完整任务文字`;
  assert.ok(task.length > 60);
  const result = await f.command(['dispatch', task, '补充说明一二三', '--name', 'long-text', '--role', 'worker', '--detach', '--json']).done;
  assert.equal(result.code, 0, result.stderr);
  const value = json(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.name, 'long-text');
  assert.equal(value.detached, true);

  const saved = readJson(dispatchFile(f.repo, 'long-text'));
  assert.deepEqual(saved, { v: 1, task, extra: '补充说明一二三', role: 'worker', spec: null, profile: 'fake', name: 'long-text' });

  // 请求文件在任务运行期间存在：先等它出现，再检查两份文件都没有密钥值或密钥来源。
  const managed = path.join(f.home, 'managed');
  await until(() => fs.existsSync(managed) && fs.readdirSync(managed).some(n => /\.(claimed|running)\.json$/.test(n)));
  const requests = fs.readdirSync(managed).filter(n => /\.(claimed|running)\.json$/.test(n)).map(n => fs.readFileSync(path.join(managed, n), 'utf8')).join('\n');
  assert.ok(!fs.readFileSync(dispatchFile(f.repo, 'long-text'), 'utf8').includes('假密钥值-不可出现在派发参数里'));
  assert.ok(!requests.includes('假密钥值-不可出现在派发参数里'), '请求文件不含密钥值');
  assert.ok(requests.includes('FAKE_SECRET_SOURCE'), '请求里只有密钥来源变量名');

  const start = await until(() => rows(f.home).find(r => r.event === 'start'));
  assert.equal(start.spec, null);
  assert.equal(start.profile, 'fake');
  assert.equal(start.role, '执行者');
  const end = await until(() => rows(f.home).find(r => r.event === 'end'), 15000);
  assert.equal(end.exit, 0);
});

test('redispatch --detach：同样参数派发到去重后的新记录，start 的 profile/spec/role 一致', async t => {
  const f = fixture(t, { delayMs: 800 });
  const first = await f.command(['dispatch', 'docs/specs/001-测试.md', '补充说明', '--name', 'spec-task', '--role', 'worker', '--detach', '--json']).done;
  assert.equal(first.code, 0, first.stderr);
  const firstValue = json(first.stdout);
  const firstStart = await until(() => rows(f.home).find(r => r.event === 'start' && r.name === 'spec-task'));
  await until(() => rows(f.home).find(r => r.event === 'end' && r.id === firstStart.id), 15000);
  const saved = readJson(dispatchFile(f.repo, 'spec-task'));
  assert.equal(saved.spec, 'docs/specs/001-测试.md');
  assert.equal(saved.task, 'docs/specs/001-测试.md');
  assert.equal(saved.role, 'worker');

  const again = await f.command(['redispatch', 'spec-task', '--detach', '--json']).done;
  assert.equal(again.code, 0, again.stderr);
  const value = json(again.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.exit, 0);
  assert.equal(value.detached, true);
  assert.equal(value.name, 'spec-task-2', '记录名自动去重');
  assert.ok(value.id);
  assert.ok(value.progress.endsWith(path.join('.agent-runs', 'spec-task-2', 'progress.log')));
  // 与 dispatch --detach --json 的字段一致（值当然不同）。
  assert.deepEqual(Object.keys(value).sort(), Object.keys(firstValue).sort());

  const start = await until(() => rows(f.home).find(r => r.event === 'start' && r.name === 'spec-task-2'));
  assert.equal(start.profile, firstStart.profile);
  assert.equal(start.spec, firstStart.spec);
  assert.equal(start.role, firstStart.role);
  assert.equal(start.title, firstStart.title);
  const end = await until(() => rows(f.home).find(r => r.event === 'end' && r.id === start.id), 15000);
  assert.equal(end.exit, 0);

  const copied = readJson(dispatchFile(f.repo, 'spec-task-2'));
  assert.deepEqual(copied, { ...saved, name: 'spec-task-2' });
});

test('redispatch：旧任务没有 dispatch.json 时给出固定错误，不产生新记录', async t => {
  const f = fixture(t, { delayMs: 100 });
  fs.mkdirSync(path.join(f.repo, '.agent-runs', 'legacy'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.agent-runs', 'legacy', 'progress.log'), '[00:00:00] 旧任务\n');
  const result = await f.command(['redispatch', 'legacy', '--json']).done;
  assert.equal(result.code, 2);
  assert.deepEqual(json(result.stdout), {
    ok: false,
    error: '这个任务是旧版本派发的，没有保存派发参数，不能再派一次',
  });
  assert.deepEqual(fs.readdirSync(path.join(f.repo, '.agent-runs')), ['legacy']);
  const plain = await f.command(['redispatch', 'legacy']).done;
  assert.equal(plain.code, 2);
  assert.match(plain.stderr, /这个任务是旧版本派发的，没有保存派发参数，不能再派一次/);
});
