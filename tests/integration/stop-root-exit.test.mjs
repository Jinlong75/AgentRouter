import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { stopTask } from '../../core/lib/stop.mjs';
import { registryWriter } from '../../core/lib/records.mjs';
import { pidAlive, processList } from '../../core/lib/process.mjs';
import { assertIdentitiesGone } from '../fixtures/identity.mjs';

// 等假进程真的出现在平台查询里，拿到它的身份（创建时间、命令行）：全量 verify 并发时固定睡 200ms 可能还没起来。
async function settleIdentity(pid) {
  for (let i = 0; i < 50; i++) {
    const rows = await processList(pid).catch(() => []);
    const row = rows.find(p => p.pid === pid);
    if (row) return row;
    await delay(100);
  }
  throw new Error(`假进程 ${pid} 没有出现在平台查询里`);
}

// 065 B：`ar stop` 返回 0 之前必须确认派发进程本身（start.pid）已经退出（协议第 9 节）。
// 用一个"晚一点才退出"的真实假进程扮演派发进程：命令行含 ar.mjs（身份核对能通过），活到 killTree 被调用后 800ms 由计时器结束；
// 注入的 killTree 立刻返回、自己不结束进程——模拟"结束进程树后派发进程晚一点才退出"。
// 预检查询注入已核实的假进程身份（B 的确认按实现固定用真实查询，不受注入影响）。
// 修复前：stopTask 在 killTree 返回后立刻写 interrupted 并返回 0，此时 pidAlive 仍为真，本用例失败（负向对照）。
test('注入的 killTree 提前返回：ar stop 等派发进程真正退出（pidAlive 为假）才写 interrupted 返回 0', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ar-stop-root-exit-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const scriptDir = join(home, 'fake-core');
  mkdirSync(scriptDir);
  const fake = join(scriptDir, 'ar.mjs');
  writeFileSync(fake, 'setTimeout(() => {}, 120000);\n', 'utf8');
  const child = spawn(process.execPath, [fake, '隔离的假派发'], { stdio: 'ignore', windowsHide: true, shell: false });
  t.after(() => { if (pidAlive(child.pid)) { try { process.kill(child.pid); } catch { /* 已退出。 */ } } });
  const identity = await settleIdentity(child.pid);
  registryWriter(home)({ event: 'start', id: 'sample', repo: home, name: '延迟退出', pid: child.pid, started: Date.now() });
  let killCalls = 0;
  const stdout = [];
  const code = await stopTask(home, home, '延迟退出', {
    info: async () => identity,
    alive: async () => true,
    // 提前返回：killTree 本身不结束假进程、不等它；假进程改为在 stopTask 等待期间（killTree 调用后 800ms）被计时器真正结束，
    // 仍是"树结束后根晚一点才退出"。时机从 killTree 调用起算，与机器负载无关；最后的断言验证的还是同一件事。
    killTree: async () => { killCalls += 1; setTimeout(() => { try { process.kill(child.pid); } catch { /* 已退出。 */ } }, 800); },
    log: line => stdout.push(line),
  });
  assert.equal(killCalls, 1);
  assert.equal(code, 0, stdout.join('\n'));
  // 069：按身份（PID + 创建时间）认定"已退出"：PID 被别的进程复用不算还活着。
  // 不等待：这条用例的意图正是"返回 0 的那一刻派发进程已经退出"，晚一点才退出的实现要继续被它抓住。
  await assertIdentitiesGone([{ pid: child.pid, created: identity.created }], '返回 0 时派发进程必须已经退出（PID 不存活，或这个 PID 已是另一个创建时间的进程）');
  assert.deepEqual(stdout, ['停止：延迟退出 已停止，工作区里没提交的改动还在']);
});

// 派发进程在时限内一直不退出：不写 interrupted，按"没能停下"处理（协议第 9 节，退出码与文案不变）。
test('派发进程超出 10 秒仍不退出：没能停下、退出码 1、不写 interrupted', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ar-stop-root-exit-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const scriptDir = join(home, 'fake-core');
  mkdirSync(scriptDir);
  const fake = join(scriptDir, 'ar.mjs');
  writeFileSync(fake, 'setTimeout(() => {}, 600000);\n', 'utf8');
  const child = spawn(process.execPath, [fake, '不退出'], { stdio: 'ignore', windowsHide: true, shell: false });
  const kill = () => { if (pidAlive(child.pid)) { try { process.kill(child.pid); } catch { /* 已退出。 */ } } };
  t.after(kill);
  const identity = await settleIdentity(child.pid);
  registryWriter(home)({ event: 'start', id: 'sample', repo: home, name: '不退出', pid: child.pid, started: Date.now() });
  const stdout = [];
  const started = Date.now();
  const code = await stopTask(home, home, '不退出', {
    info: async () => identity,
    alive: async () => true,
    killTree: async () => {}, // 模拟树"结束"了但根没退出
    log: line => stdout.push(line),
  });
  const elapsed = Date.now() - started;
  assert.equal(code, 1);
  assert.match(stdout.at(-1), /^停止：不退出 没能停下（.+）$/);
  assert.equal(stdout.some(line => line.includes('已停止')), false, '不写"已停止"');
  assert.ok(elapsed >= 9000, `等待计入原来的 10 秒上限（实际 ${elapsed}ms）`);
  const rows = readFileSync(join(home, 'runs.jsonl'), 'utf8');
  assert.equal(rows.includes('interrupted'), false, '不写 interrupted');
});
