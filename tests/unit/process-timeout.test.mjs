import { test } from 'node:test';
import assert from 'node:assert/strict';
import { killProcessTree, processList } from '../../core/lib/process.mjs';

const root = { pid: 900001, parent: 1, created: 1000 };
const child = { pid: 900002, parent: root.pid, created: 2000 };

test('首次查询前预算耗尽仍给查询最低时限，超时原因反映实际秒数', async () => {
  const original = Date.now;
  let calls = 0;
  Date.now = () => ++calls === 1 ? 0 : 30000;
  try {
    for (const platform of ['win32', 'linux']) {
      calls = 0;
      let given;
      await assert.rejects(killProcessTree(root.pid, {
        platform, timeout: 30000, alive: () => true,
        list: (pid, os, timeout) => {
          given = timeout;
          return processList(pid, os, timeout, async () => { throw Object.assign(new Error('timeout'), { killed: true }); });
        },
      }), /进程查询超时（10 秒）/);
      assert.equal(given, 10000);
    }
  } finally { Date.now = original; }
});

test('首次查询很慢耗尽预算后，结束子孙所需的查询仍有最低时限', async () => {
  const original = Date.now;
  let now = 0;
  Date.now = () => now;
  const timeouts = [], live = new Set([root.pid, child.pid]);
  try {
    await killProcessTree(root.pid, {
      platform: 'win32', timeout: 30000, alive: pid => live.has(pid),
      list: async (pid, platform, timeout) => {
        timeouts.push(timeout);
        if (timeouts.length === 1) now = 30000;
        return [root, child];
      },
      executeFile: async (file, args) => {
        for (let i = 0; i < args.length; i++) if (args[i] === '/PID') live.delete(Number(args[i + 1]));
      },
    });
    assert.deepEqual(timeouts, [30000, 10000, 10000]);
    assert.equal(live.size, 0);
  } finally { Date.now = original; }
});

test('Windows 预算耗尽后仍扫描新子孙，无法确认完整结束时报错', async () => {
  const original = Date.now;
  try {
    for (const hasChild of [true, false]) {
      let now = 0, calls = 0;
      const live = new Set([root.pid]);
      const terminated = [];
      Date.now = () => now;
      const stopping = killProcessTree(root.pid, {
        platform: 'win32', timeout: 30000, alive: pid => live.has(pid),
        list: async () => {
          calls++;
          if (calls === 1) { now = 30000; return [root]; }
          now = 40000;
          return hasChild && live.has(child.pid) ? [child] : [];
        },
        terminate: async targets => {
          for (const target of targets) {
            terminated.push(target.pid);
            if (target.pid === root.pid && hasChild) live.add(child.pid);
            live.delete(target.pid);
          }
          return new Map(targets.map(target => [target.pid, 'killed']));
        },
      });
      if (hasChild) {
        await assert.rejects(stopping, /等待进程退出超时/);
        assert.ok(terminated.includes(child.pid));
        assert.equal(live.has(child.pid), false);
      } else {
        await stopping;
        assert.equal(live.size, 0);
      }
    }
  } finally { Date.now = original; }
});

test('Windows 收尾扫描失败时，即使已知进程退出也不能返回成功', async () => {
  const original = Date.now;
  try {
    let now = 0, calls = 0, live = true;
    Date.now = () => now;
    await assert.rejects(killProcessTree(root.pid, {
      platform: 'win32', timeout: 30000, alive: () => live,
      list: async () => {
        if (++calls === 1) { now = 30000; return [root]; }
        throw Error('收尾查询失败');
      },
      terminate: async () => { live = false; return new Map([[root.pid, 'killed']]); },
    }), /收尾查询失败/);
    assert.equal(live, false);
  } finally { Date.now = original; }
});

test('Windows 扫描未完成且终止出错时保留终止错误', async () => {
  const original = Date.now;
  let now = 0, calls = 0, live = true;
  Date.now = () => now;
  try {
    await assert.rejects(killProcessTree(root.pid, {
      platform: 'win32', timeout: 30000, alive: () => live,
      list: async () => { if (++calls === 1) { now = 30000; return [root]; } now = 40000; return [child]; },
      terminate: async targets => {
        live = false;
        return new Map(targets.map(target => [target.pid, 'denied']));
      },
    }), /结束进程 900001 失败（denied）/);
  } finally { Date.now = original; }
});

test('查询耗尽预算后 Windows 的结束操作仍有最低时限', async () => {
  const original = Date.now;
  try {
    for (const method of ['taskkill', 'terminate']) {
      let now = 0, live = true, given;
      Date.now = () => now;
      await killProcessTree(root.pid, {
        platform: 'win32', timeout: 30000, alive: () => live,
        list: async () => { now = 30000; return [root]; },
        executeFile: async (file, args, options) => { given = options.timeout; live = false; },
        terminate: method === 'terminate' ? async (targets, options) => {
          given = options.timeout; live = false;
          return new Map(targets.map(target => [target.pid, 'killed']));
        } : null,
      });
      assert.equal(given, 10000, method);
      assert.equal(live, false, method);
    }
  } finally { Date.now = original; }
});

test('查询耗尽预算后 POSIX 仍结束已知进程', async () => {
  const originalNow = Date.now, originalKill = process.kill;
  let now = 0, live = true;
  const signals = [];
  Date.now = () => now;
  process.kill = (pid, signal) => { signals.push(signal); if (signal === 'SIGKILL') live = false; };
  try {
    await killProcessTree(root.pid, {
      platform: 'linux', timeout: 30000,
      list: async () => { now = 30000; return live ? [root] : []; },
    });
    assert.ok(signals.includes('SIGKILL'));
    assert.equal(live, false);
  } finally { Date.now = originalNow; process.kill = originalKill; }
});

test('POSIX 预算耗尽后扫描并结束新子进程，收尾时限耗尽则报错', async () => {
  const originalNow = Date.now, originalKill = process.kill;
  try {
    for (const expires of [false, true]) {
      let now = 0, calls = 0;
      const live = new Set([root.pid, child.pid]);
      const signals = [];
      Date.now = () => now;
      process.kill = (pid, signal) => { signals.push(`${signal}:${pid}`); if (signal === 'SIGKILL') live.delete(pid); };
      const stopping = killProcessTree(root.pid, {
        platform: 'linux', timeout: 30000,
        list: async () => {
          calls++;
          if (calls === 1) { now = 30000; return [root]; }
          if (calls === 2 && expires) now = 40000;
          return [root, child].filter(p => live.has(p.pid));
        },
      });
      if (expires) await assert.rejects(stopping, /等待进程退出超时/);
      else {
        await stopping;
        assert.ok(signals.includes(`SIGSTOP:${child.pid}`));
        assert.ok(signals.includes(`SIGKILL:${child.pid}`));
        assert.equal(live.size, 0);
      }
    }
  } finally { Date.now = originalNow; process.kill = originalKill; }
});
