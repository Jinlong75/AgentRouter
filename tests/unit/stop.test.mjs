import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDispatch, recordProcessGone, stopTask } from '../../core/lib/stop.mjs';
import { registryWriter } from '../../core/lib/records.mjs';
import { tracing } from '../../core/lib/trace.mjs';
import { processList } from '../../core/lib/process.mjs';

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

// 102 改写（Stage07 T8k 第三项）：确认派发进程已经不在了、清单里又没有结束记录时，ar stop 补写 interrupted（process-gone）。
// 下面三条核对明细用例与"查询没有结果且 PID 不存活"一条，原断言 code === 1 与 stdout 为 ['停止：中文 空格 的进程已经不在了'] →
// 新断言 code === 0、stdout 为 ['停止：中文 空格 的进程已经不在了，已记为中断（派发进程意外退出）']，并断言清单多了一条 process-gone；
// 原因：任务说明 102 规定，确认原派发进程已经不在时不再只报告、要补写记录。核对明细（标准错误）的断言一字未动。
const GONE_TEXT = '停止：中文 空格 的进程已经不在了，已记为中断（派发进程意外退出）';
const rowsOf = f => readFileSync(join(f.home, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const assertRecorded = f => {
  const last = rowsOf(f).at(-1);
  assert.equal(last.event, 'interrupted');
  assert.equal(last.id, 'sample');
  assert.equal(last.signal, 'process-gone');
  assert.equal(last.v, 1);
  assert.ok(Number.isFinite(last.at) && last.at >= f.start.started);
};

test('核对明细：命令行不含派发脚本名', async t => {
  const f = fixture(t);
  const r = await refuse(f, { info: async () => ({ name: 'node.exe', created: f.start.started - 1000, command: 'node other.mjs' }) });
  assert.equal(r.code, 0);
  assert.deepEqual(r.stdout, [GONE_TEXT]);
  assertRecorded(f);
  assert.match(r.detail, /名称：期望 派发执行者的运行时.*实际 node\.exe/);
  assert.match(r.detail, /命令行：期望 包含 ar\.mjs \/ codex-task\.mjs 之一；实际 不含/);
  assert.match(r.detail, /不匹配：命令行包含派发脚本名/);
});

test('核对明细：创建时间晚于 started', async t => {
  const f = fixture(t);
  const r = await refuse(f, { info: async () => ({ name: 'node.exe', created: f.start.started + 10000, command: 'node core/ar.mjs 只回复 OK' }) });
  assert.equal(r.code, 0);
  assert.deepEqual(r.stdout, [GONE_TEXT]);
  assertRecorded(f);
  assert.match(r.detail, new RegExp(`创建时间：期望 有限数且 ≤ started；实际 ${f.start.started + 10000}；创建时间 ≤ started：不成立`));
  assert.match(r.detail, /不匹配：创建时间 ≤ started/);
});

test('核对明细：PID 不存活', async t => {
  const f = fixture(t, { pid: endedPid() });
  const r = await refuse(f, { info: async () => ({ name: 'node.exe', created: f.start.started - 1000, command: 'node core/ar.mjs 只回复 OK' }) });
  assert.equal(r.code, 0);
  assert.deepEqual(r.stdout, [GONE_TEXT]);
  assertRecorded(f);
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

test('查询没有结果且 PID 不存活 → "进程已经不在了"，补写 interrupted（102 改写，见上）', async t => {
  const f = fixture(t, { pid: endedPid() });
  const r = await refuse(f, { retryDelayMs: 0, info: async () => null });
  assert.equal(r.code, 0);
  assert.deepEqual(r.stdout, [GONE_TEXT]);
  assertRecorded(f);
  assert.match(r.detail, /不匹配：进程查询得到结果/);
});

// ---- 102：确认派发进程不在时补写 interrupted；查询失败 / 已经结束 / 说不准时不写 ----

test('102 补写：写在旧 start 之后，前面补换行，只多一条，并释放这个任务的名额', async t => {
  const f = fixture(t, { pid: endedPid() });
  const slots = join(f.home, 'slots');
  mkdirSync(slots);
  writeFileSync(join(slots, 'slot-1.json'), JSON.stringify({ id: 'sample', pid: 1, created: null, at: 1 }));
  writeFileSync(join(slots, 'slot-2.json'), JSON.stringify({ id: 'other', pid: 1, created: null, at: 1 }));
  appendFileSync(join(f.home, 'runs.jsonl'), 'broken half');
  const r = await refuse(f, { retryDelayMs: 0, info: async () => null });
  assert.equal(r.code, 0);
  assert.match(readFileSync(join(f.home, 'runs.jsonl'), 'utf8'), /broken half\n\{"v":1,"event":"interrupted","id":"sample","signal":"process-gone","at":\d+\}\n$/);
  assert.deepEqual(readdirSync(slots), ['slot-2.json'], '只释放自己的名额');
});

test('102 查询失败：不写记录，仍报无法核对进程', async t => {
  const f = fixture(t, { pid: endedPid() });
  const before = readFileSync(join(f.home, 'runs.jsonl'), 'utf8');
  const r = await refuse(f, { retryDelayMs: 0, info: async (pid, platform, observe) => { observe?.({ ok: false, ms: 3, error: '查询出错' }); return null; } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout, ['停止：中文 空格 无法核对进程（进程查询失败：查询出错），没有结束任何进程']);
  assert.equal(readFileSync(join(f.home, 'runs.jsonl'), 'utf8'), before, '查询失败时清单一个字节都不变');
});

test('102 创建时间不是有限数：说不准是不是原进程，不写记录', async t => {
  const f = fixture(t);
  const before = readFileSync(join(f.home, 'runs.jsonl'), 'utf8');
  const r = await refuse(f, { info: async () => ({ name: 'node.exe', created: null, command: 'node core/ar.mjs 只回复 OK' }) });
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout, ['停止：中文 空格 的进程已经不在了']);
  assert.equal(readFileSync(join(f.home, 'runs.jsonl'), 'utf8'), before);
});

test('102 已经有 end 或 interrupted：打印"已经结束"，不重复写，不查进程', async t => {
  for (const ending of [{ event: 'end', id: 'sample', exit: 0 }, { event: 'interrupted', id: 'sample', signal: 'process-gone' }]) {
    const f = fixture(t, { pid: endedPid() });
    registryWriter(f.home)(ending);
    const before = readFileSync(join(f.home, 'runs.jsonl'), 'utf8');
    const r = await refuse(f, { info: async () => assert.fail('已经结束的任务不该再查进程') });
    assert.equal(r.code, 0);
    assert.deepEqual(r.stdout, ['停止：中文 空格（已经结束）']);
    assert.equal(readFileSync(join(f.home, 'runs.jsonl'), 'utf8'), before);
  }
});

test('102 有 resume 的任务：按最近一次 resume 的 pid 核对，resume 之前的 end 不算', async t => {
  const f = fixture(t);
  registryWriter(f.home)({ event: 'end', id: 'sample', exit: 1 });
  registryWriter(f.home)({ event: 'resume', id: 'sample', pid: endedPid(), n: 2, at: Date.now() });
  const queried = [];
  const r = await refuse(f, { retryDelayMs: 0, info: async pid => { queried.push(pid); return null; } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.stdout, [GONE_TEXT]);
  assert.equal(queried.length, 1);
  assert.notEqual(queried[0], process.pid, '核对的是 resume 的进程，不是最初的 start.pid');
  assertRecorded(f);
});

test('102 有 resume 的任务：resume 之后已经有 end，不写', async t => {
  const f = fixture(t);
  registryWriter(f.home)({ event: 'resume', id: 'sample', pid: endedPid(), n: 2, at: Date.now() });
  registryWriter(f.home)({ event: 'end', id: 'sample', exit: 0 });
  const before = readFileSync(join(f.home, 'runs.jsonl'), 'utf8');
  const r = await refuse(f, { info: async () => assert.fail('不该查进程') });
  assert.deepEqual(r.stdout, ['停止：中文 空格（已经结束）']);
  assert.equal(readFileSync(join(f.home, 'runs.jsonl'), 'utf8'), before);
});

test('102 checkDispatch 只读：gone / running / unclear / failed 四种结论，recordProcessGone 遇到结束记录不重复写', async t => {
  const f = fixture(t);
  const before = readFileSync(join(f.home, 'runs.jsonl'), 'utf8');
  const ours = { name: 'node.exe', created: f.start.started - 1000, command: 'node core/ar.mjs' };
  assert.equal((await checkDispatch(f.start, { info: async () => ours })).state, 'running');
  assert.equal((await checkDispatch(f.start, { info: async () => ({ ...ours, created: f.start.started + 5 }) })).state, 'gone');
  assert.equal((await checkDispatch(f.start, { info: async () => ({ ...ours, command: 'node other.mjs' }) })).state, 'gone');
  assert.equal((await checkDispatch(f.start, { info: async () => ({ ...ours, created: NaN }) })).state, 'unclear');
  const failed = await checkDispatch(f.start, { retryDelayMs: 0, info: async () => { throw Error('坏了'); } });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.reason, '进程查询失败：坏了');
  assert.equal(readFileSync(join(f.home, 'runs.jsonl'), 'utf8'), before, 'checkDispatch 不写任何文件');
  assert.equal(recordProcessGone(f.home, f.start), true);
  assert.equal(recordProcessGone(f.home, f.start), false, '已经有 interrupted 就不再写');
  assert.equal(rowsOf(f).filter(row => row.event === 'interrupted').length, 1);
});

// ---- 101：进程查询超时时 ar stop 的输出是中文原因，不再打印整段 PowerShell 命令 ----
const TIMEOUT_TEXT = '进程查询超时（20 秒）：机器负载很高时可能发生，稍后再试';
const hugeCommand = Object.assign(new Error('Command failed: powershell.exe -NoProfile -NonInteractive -Command $ErrorActionPreference=\'Stop\'; Get-CimInstance Win32_Process'), { killed: true, signal: 'SIGTERM', code: null });
// 与真实 processInfo 一样：查询抛出的错误通过 observe 交出去、返回 null；这里的查询走真实 processList，只是 execFile 被替换成"超时"。
const timedOutInfo = async (pid, platform, observe) => {
  try { await processList(pid, 'win32', 20000, async () => { throw hugeCommand; }); }
  catch (error) { observe?.({ ok: false, ms: 20000, error: error.message }); }
  return null;
};

test('查询 3 次都超时：输出中文超时原因，不含 Command failed / powershell.exe', async t => {
  const f = fixture(t);
  const r = await refuse(f, { retryDelayMs: 0, info: timedOutInfo });
  assert.equal(r.code, 1);
  assert.deepEqual(r.stdout, [`停止：中文 空格 无法核对进程（${TIMEOUT_TEXT}），没有结束任何进程`]);
  const all = [...r.stdout, ...r.stderr].join('\n');
  assert.ok(!all.includes('Command failed') && !all.includes('powershell.exe'), all);
  assert.match(r.detail, new RegExp(`查询第 3 次：失败，用时 20000ms，错误：${TIMEOUT_TEXT}`));
});

test('结束进程树时查询超时：输出中文超时原因，不含 Command failed / powershell.exe', async t => {
  const f = fixture(t);
  const stdout = [], stderr = [];
  const code = await stopTask(f.home, f.home, '中文 空格', {
    info: async () => ({ name: 'node.exe', created: f.start.started - 1000, command: 'node core/ar.mjs 只回复 OK' }),
    alive: async () => true,
    killTree: async () => { await processList(undefined, 'win32', 20000, async () => { throw hugeCommand; }); },
    log: text => stdout.push(text), err: text => stderr.push(text),
  });
  assert.equal(code, 1);
  assert.deepEqual(stdout, [`停止：中文 空格 没能停下（${TIMEOUT_TEXT}）`]);
  const all = [...stdout, ...stderr].join('\n');
  assert.ok(!all.includes('Command failed') && !all.includes('powershell.exe'), all);
});
