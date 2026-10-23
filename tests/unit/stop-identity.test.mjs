import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopTask } from '../../core/lib/stop.mjs';
import { registryWriter } from '../../core/lib/records.mjs';
import { processList } from '../../core/lib/process.mjs';

// 069：stopTask 确认派发进程退出时按身份（PID + 创建时间）认定。
// 用本测试进程当"PID 已被另一个进程占用"的那个 PID：清单里记的身份（注入的 info）与它真实的创建时间不同，
// killTree 注入为立刻返回——协议第 9 节：PID 被复用不算"没能停下"，不必等满 10 秒。
test('派发进程的 PID 被另一个进程占用（创建时间不同）：按已退出处理，很快写 interrupted 返回 0', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ar-stop-identity-'));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const real = (await processList(process.pid)).find(p => p.pid === process.pid);
  assert.ok(real && Number.isFinite(real.created), '能查到本测试进程的真实创建时间');
  const started = Date.now();
  registryWriter(home)({ event: 'start', id: 'sample', repo: home, name: 'PID 被复用', pid: process.pid, started });
  const stdout = [];
  const before = Date.now();
  const code = await stopTask(home, home, 'PID 被复用', {
    // 清单里记的派发进程身份：同 PID、更早的创建时间（真正的派发进程早就退出了）。
    info: async () => ({ name: 'node.exe', created: real.created - 60000, command: 'node core/ar.mjs 隔离的派发' }),
    alive: async () => true, killTree: async () => {}, log: line => stdout.push(line),
  });
  assert.equal(code, 0, stdout.join('\n'));
  assert.deepEqual(stdout, ['停止：PID 被复用 已停止，工作区里没提交的改动还在']);
  assert.ok(Date.now() - before < 8000, `身份已不在应当很快返回，不等满 10 秒（用时 ${Date.now() - before}ms）`);
});
