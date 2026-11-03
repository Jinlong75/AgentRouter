import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeProcessIdentity, renameWithRetry } from '../../tools/shots-move.mjs';

const identity = (name, created) => ({ name, created });
// 假时钟：计时与等待都注入，测试不真的等。
function clock() {
  let t = 0;
  return { now: () => t, wait: async ms => { t += ms; } };
}

test('进程身份：查询成功且没有该 PID 才算已退出', () => {
  assert.equal(judgeProcessIdentity({ ok: true, process: null }, identity('electron.exe', 1)), 'exited');
  assert.equal(judgeProcessIdentity({ ok: true, process: null }, null), 'exited');
});

test('进程身份：查询失败是状态未知，不是已退出', () => {
  const error = new Error('powershell 退出码 1');
  assert.equal(judgeProcessIdentity({ ok: false, error }, identity('electron.exe', 1)), 'unknown');
  assert.equal(judgeProcessIdentity({ ok: false, error }, null), 'unknown');
  assert.equal(judgeProcessIdentity(undefined, null), 'unknown');
});

test('进程身份：名字和创建时间都一致才是同一个进程', () => {
  assert.equal(judgeProcessIdentity({ ok: true, process: identity('electron.exe', 100) }, identity('electron.exe', 100)), 'same');
  assert.equal(judgeProcessIdentity({ ok: true, process: identity('electron.exe', 200) }, identity('electron.exe', 100)), 'reused');
  assert.equal(judgeProcessIdentity({ ok: true, process: identity('other.exe', 100) }, identity('electron.exe', 100)), 'reused');
  assert.equal(judgeProcessIdentity({ ok: true, process: identity('electron.exe', 100) }, null), 'present');
});

test('挪目录：前两次 EPERM 后成功，每次失败都打印重试日志', async () => {
  const c = clock(), logs = [], calls = [];
  let attempt = 0;
  const rename = async (source, destination) => {
    calls.push([source, destination]);
    if (++attempt <= 2) throw Object.assign(new Error('被占用'), { code: 'EPERM' });
  };
  await renameWithRetry('公共目录/shots-a', '旁边/shots-a', {
    rename, diagnose: async () => '没有占用进程', now: c.now, wait: c.wait, log: line => logs.push(line),
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], ['公共目录/shots-a', '旁边/shots-a']);
  assert.equal(logs.length, 2);
  assert.equal(logs[0], '移出目录失败（shots-a，第 1 次，EPERM）：进程诊断 没有占用进程');
  assert.equal(logs[1], '移出目录失败（shots-a，第 2 次，EPERM）：进程诊断 没有占用进程');
});

test('挪目录：一直 EBUSY 时到总时长上限抛出原错误，诊断附在错误里', async () => {
  const c = clock(), logs = [];
  const original = Object.assign(new Error('一直被占用'), { code: 'EBUSY' });
  let calls = 0;
  const rename = async () => { calls++; throw original; };
  await assert.rejects(
    renameWithRetry('公共目录/shots-b', '旁边/shots-b', {
      rename, diagnose: async () => 'electron.exe pid=42',
      timeoutMs: 1000, retryDelayMs: 500, now: c.now, wait: c.wait, log: line => logs.push(line),
    }),
    actual => {
      assert.equal(actual, original);
      assert.match(actual.message, /移出目录进程诊断：electron\.exe pid=42/);
      return true;
    },
  );
  assert.equal(calls, 2);
  assert.equal(logs.length, 2);
});

test('挪目录：不可重试的错误码直接抛出，不重试也不诊断', async () => {
  const original = Object.assign(new Error('目录不在'), { code: 'ENOENT' });
  let calls = 0, diagnosed = 0, logs = 0;
  await assert.rejects(
    renameWithRetry('a', 'b', {
      rename: async () => { calls++; throw original; },
      diagnose: async () => { diagnosed++; return ''; },
      log: () => { logs++; },
    }),
    actual => actual === original,
  );
  assert.equal(calls, 1);
  assert.equal(diagnosed, 0);
  assert.equal(logs, 0);
});

test('挪目录：诊断函数自身失败时仍抛出原错误', async () => {
  const c = clock(), logs = [];
  const original = Object.assign(new Error('一直忙'), { code: 'EBUSY' });
  await assert.rejects(
    renameWithRetry('a', 'b', {
      rename: async () => { throw original; },
      diagnose: async () => { throw Object.assign(new Error('CIM 查询炸了'), { code: 'EACCES' }); },
      timeoutMs: 1000, retryDelayMs: 10, now: c.now, wait: c.wait, log: line => logs.push(line),
    }),
    actual => {
      assert.equal(actual, original);
      assert.match(actual.message, /移出目录进程诊断：查询失败：EACCES/);
      return true;
    },
  );
  assert.ok(logs.length >= 1);
  assert.match(logs[0], /查询失败：EACCES/);
});
