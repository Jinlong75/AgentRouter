import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopTask } from '../../core/lib/stop.mjs';
import { registryWriter } from '../../core/lib/records.mjs';
import { tracing } from '../../core/lib/trace.mjs';

// 隔离目录 + 清单里一条 start；pid 默认用本测试进程，身份查询全部由用例注入。
function fixture(t, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ar-stop-check-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const start = { event: 'start', id: 'sample', repo: home, name: '中文 空格', pid: process.pid, started: Date.now(), ...overrides };
  registryWriter(home)(start);
  return { home, start };
}
// 已退出的真实 PID：构造"PID 不存活"时用，避免撞上正在运行的进程。
function endedPid() {
  return spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
}
// 记录标准输出与标准错误（标准错误收 A 的核对明细）；结束进程树的调用不应发生。
async function refuse(f, options = {}) {
  const stdout = [], stderr = [];
  const code = await stopTask(f.home, f.home, '中文 空格', {
    log: text => stdout.push(text), err: text => stderr.push(text), killTree: () => assert.fail('不应结束进程'), ...options,
  });
  return { code, stdout, stderr, detail: stderr.join('\n') };
}

// 065 改写（用户 2026-10-22 批准的唯一一条已有断言）：
// 原断言 deepEqual(r.stdout, ['停止：中文 空格 的进程已经不在了']) →
// 新断言按协议第 9 节：查询失败（重试 3 次仍失败）不再当成"进程已经不在了"，改报"无法核对进程"。
test('核对明细：查询抛错（同一次查询的错误与用时）', async t => {
  const f = fixture(t);
  const r = await refuse(f, { info: async (pid, platform, observe) => { observe?.({ ok: false, ms: 12, error: 'PowerShell 查询超时（5000ms）' }); return null; } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout, ['停止：中文 空格 无法核对进程（进程查询失败：PowerShell 查询超时（5000ms）），没有结束任何进程']);
  assert.match(r.detail, /\[ar-stop 核对\]/);
  assert.match(r.detail, /进程查询：期望 得到结果；实际 没有结果；用时 12ms；错误：PowerShell 查询超时/);
  assert.match(r.detail, /不匹配：进程查询得到结果/);
  // 065 只增加：核对明细里列出 3 次查询各自的用时与错误（协议第 9 节）。
  assert.match(r.detail, /查询第 1 次：失败，用时 12ms，错误：PowerShell 查询超时（5000ms）/);
  assert.match(r.detail, /查询第 2 次：失败，用时 12ms，错误：PowerShell 查询超时（5000ms）/);
  assert.match(r.detail, /查询第 3 次：失败，用时 12ms，错误：PowerShell 查询超时（5000ms）/);
});

test('核对明细：命令行不含派发脚本名', async t => {
  const f = fixture(t);
  const r = await refuse(f, { info: async () => ({ name: 'node.exe', created: f.start.started - 1000, command: 'node other.mjs' }) });
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout, ['停止：中文 空格 的进程已经不在了']);
  assert.match(r.detail, /名称：期望 派发执行者的运行时.*实际 node\.exe/);
  assert.match(r.detail, /命令行：期望 包含 ar\.mjs \/ codex-task\.mjs 之一；实际 不含/);
  assert.match(r.detail, /不匹配：命令行包含派发脚本名/);
});

test('核对明细：创建时间晚于 started', async t => {
  const f = fixture(t);
  const r = await refuse(f, { info: async () => ({ name: 'node.exe', created: f.start.started + 10000, command: 'node core/ar.mjs 只回复 OK' }) });
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout, ['停止：中文 空格 的进程已经不在了']);
  assert.match(r.detail, new RegExp(`创建时间：期望 有限数且 ≤ started；实际 ${f.start.started + 10000}；创建时间 ≤ started：不成立`));
  assert.match(r.detail, /不匹配：创建时间 ≤ started/);
});

test('核对明细：PID 不存活', async t => {
  const f = fixture(t, { pid: endedPid() });
  const r = await refuse(f, { info: async () => ({ name: 'node.exe', created: f.start.started - 1000, command: 'node core/ar.mjs 只回复 OK' }) });
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout, ['停止：中文 空格 的进程已经不在了']);
  assert.match(r.detail, /PID 存活：期望 存活；实际 不存活/);
  assert.match(r.detail, /不匹配：PID 存活/);
});

test('正常停止的输出逐字不变，且不写核对明细（AR_CORE_TRACE=1 时才写）', async t => {
  const f = fixture(t);
  const stdout = [], stderr = [];
  const code = await stopTask(f.home, f.home, '中文 空格', {
    info: async () => ({ name: 'node.exe', created: f.start.started - 1000, command: 'node core/ar.mjs 只回复 OK' }),
    alive: async () => true, killTree: async () => {}, log: text => stdout.push(text), err: text => stderr.push(text),
  });
  assert.equal(code, 0);
  assert.deepEqual(stdout, ['停止：中文 空格 已停止，工作区里没提交的改动还在']);
  assert.equal(stderr.length, tracing ? 1 : 0, tracing ? 'AR_CORE_TRACE=1 时会额外写核对明细' : '平时不写标准错误');
});

// ---- 065 A：查询失败间隔约 1 秒重试、最多共查 3 次（协议第 9 节） ----

test('查询前 2 次失败、第 3 次成功 → 正常停止', async t => {
  const f = fixture(t);
  const stdout = [], stderr = [];
  let calls = 0;
  const code = await stopTask(f.home, f.home, '中文 空格', {
    retryDelayMs: 0,
    info: async (pid, platform, observe) => {
      calls += 1;
      if (calls <= 2) { observe?.({ ok: false, ms: 5, error: 'PowerShell 查询失败' }); return null; }
      return { name: 'node.exe', created: f.start.started - 1000, command: 'node core/ar.mjs 只回复 OK' };
    },
    alive: async () => true, killTree: async () => {},
    log: text => stdout.push(text), err: text => stderr.push(text),
  });
  assert.equal(calls, 3, '查询了 3 次');
  assert.equal(code, 0);
  assert.deepEqual(stdout, ['停止：中文 空格 已停止，工作区里没提交的改动还在']);
});

test('3 次查询都失败 → 新文案、退出码 1、不结束进程树、核对明细列出 3 次查询', async t => {
  const f = fixture(t);
  const r = await refuse(f, {
    retryDelayMs: 0,
    info: async (pid, platform, observe) => { observe?.({ ok: false, ms: 7, error: '查询出错' }); return null; },
  });
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout, ['停止：中文 空格 无法核对进程（进程查询失败：查询出错），没有结束任何进程']);
  assert.equal((r.detail.match(/查询第 \d 次：失败/g) ?? []).length, 3, '核对明细里有 3 次查询');
  assert.match(r.detail, /查询第 1 次：失败，用时 7ms，错误：查询出错/);
  assert.match(r.detail, /查询第 3 次：失败，用时 7ms，错误：查询出错/);
});

test('查询没有结果但 PID 仍存活 → 按查询失败处理（重试后仍失败）', async t => {
  const f = fixture(t); // start.pid 是本测试进程，存活
  const r = await refuse(f, { retryDelayMs: 0, info: async () => null });
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout, ['停止：中文 空格 无法核对进程（进程查询失败：查询没有结果但 PID 仍然存活），没有结束任何进程']);
});

test('查询没有结果且 PID 不存活 → 仍是"进程已经不在了"', async t => {
  const f = fixture(t, { pid: endedPid() });
  const r = await refuse(f, { retryDelayMs: 0, info: async () => null });
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout, ['停止：中文 空格 的进程已经不在了']);
  assert.match(r.detail, /不匹配：进程查询得到结果/);
});
