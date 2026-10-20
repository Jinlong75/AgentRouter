import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { main } from '../../core/lib/cli.mjs';

// 只用 fake 适配器，不真实调用任何付费服务；隔离的 AGENT_ROUTER_HOME。
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar agents-test 测试 '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { AGENT_ROUTER_HOME: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const call = async (argv, extra = {}) => {
    const out = [];
    const code = await main(argv, { scriptPath: path.resolve('core/ar.mjs'), env, cwd: home, out: s => out.push(s), ...extra });
    return { code, out, json: argv.includes('--json') ? JSON.parse(out.at(-1)) : null };
  };
  return { home, env, call };
}

test('agents test：成功（exit 0 且有 OK）写 agent-tests.json，list 读出 lastTest', async t => {
  const { home, call } = setup(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'ok', profiles: {
    ok: { adapter: 'fake', label: '假执行者', events: [{ kind: 'say', text: 'OK' }, { kind: 'turn', usage: { input: 10, output: 2 } }], report: 'OK\n' },
  } }));
  const r = await call(['agents', 'test', 'ok', '--json']);
  assert.equal(r.code, 0); assert.equal(r.out.length, 1);
  assert.equal(r.json.ok, true); assert.equal(r.json.exit, 0); assert.equal(r.json.timedOut, false);
  assert.equal(r.json.report, 'OK'); assert.deepEqual(r.json.usage, { input: 10, output: 2 });
  assert.equal(r.json.version, 'fake-agent 1.0'); assert.equal(r.json.model, null);
  assert.equal(typeof r.json.seconds, 'number');
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'agent-tests.json'), 'utf8')).ok;
  assert.equal(saved.ok, true); assert.equal(saved.version, 'fake-agent 1.0'); assert.equal(saved.error, null);
  assert.equal(typeof saved.at, 'number'); assert.equal(typeof saved.seconds, 'number');
  const list = (await call(['agents', 'list', '--json'])).json.agents;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].lastTest, saved, 'list 的 lastTest 来自 agent-tests.json');
  assert.ok(!fs.existsSync(path.join(home, 'runs.jsonl')), '不写入真实任务清单');
});

test('agents test：失败（exit 非 0 且有 error 事件）', async t => {
  const { home, call } = setup(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'bad', profiles: {
    bad: { adapter: 'fake', label: '假执行者', events: [{ kind: 'error', text: '接口返回 401' }], report: '没有完成\n', exit: 3 },
  } }));
  const r = await call(['agents', 'test', 'bad', '--json']);
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false); assert.equal(r.json.exit, 3); assert.equal(r.json.timedOut, false);
  assert.match(r.json.error, /401/);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'agent-tests.json'), 'utf8')).bad;
  assert.equal(saved.ok, false); assert.match(saved.error, /401/);
  assert.ok(!fs.existsSync(path.join(home, 'runs.jsonl')));
});

test('agents test：超时 --timeout 2 结束进程树，临时目录删除', async t => {
  const { home, call } = setup(t);
  // delayMs 足够大：不被 killProcessTree 结束的话，回放要很久才完成。
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'slow', profiles: {
    slow: { adapter: 'fake', label: '慢执行者', events: [{ kind: 'say', text: '开始' }, { kind: 'say', text: 'OK' }], report: 'OK\n', delayMs: 30000 },
  } }));
  const dirs = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('ar-agent-test-'));
  const before = new Set(dirs());
  const start = Date.now();
  const r = await call(['agents', 'test', 'slow', '--timeout', '2', '--json']);
  const elapsed = Date.now() - start;
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false); assert.equal(r.json.timedOut, true);
  assert.match(r.json.error, /超过 2 秒没有结束，测试已停止/);
  assert.ok(elapsed < 20000, `超时后应立刻结束进程树（实际用时 ${elapsed}ms）`);
  const leftover = [...new Set(dirs())].filter(n => !before.has(n));
  let note = '';
  if (leftover.length) {
    // 诊断（PR #5 CI）：残留目录是谁的（config.json 的 defaultProfile；本用例是 slow）、5 秒后是否消失。判断仍以上面第一次观察为准。
    const owner = n => { try { return JSON.parse(fs.readFileSync(path.join(os.tmpdir(), n, 'home', 'config.json'), 'utf8')).defaultProfile ?? '（无）'; } catch (e) { return `读不到（${e.code ?? e.message}）`; } };
    // 还剩哪些文件（相对路径，最多 15 个）：区分"删了一半、被占用的文件留着"和"别的用例刚建的完整目录"。
    const contents = n => { try { const all = fs.readdirSync(path.join(os.tmpdir(), n), { recursive: true }).map(String); return `${all.length} 项：${all.slice(0, 15).join(', ') || '（空目录）'}`; } catch (e) { return `读不到（${e.code ?? e.message}）`; } };
    // 还有哪些进程的命令行里带着这个目录（结束进程树后是否有进程存活、仍占着目录）；只在 Windows 上查，查不到就写原因。
    const holders = n => {
      if (process.platform !== 'win32') return '（非 Windows，不查）';
      try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${n}*' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
        return out ? out.split(/\r?\n/).join('、') : '没有';
      } catch (e) { return `查询失败（${e.code ?? e.message}）`; }
    };
    const owners = leftover.map(n => `${n}=${owner(n)}（${contents(n)}；相关进程 ${holders(n)}）`).join('、');
    await new Promise(resolve => setTimeout(resolve, 5000));
    note = `；残留 ${owners}；5 秒后仍在 ${leftover.filter(n => fs.existsSync(path.join(os.tmpdir(), n))).map(n => `${n}（${contents(n)}）`).join('、') || '（都消失了）'}`;
  }
  assert.deepEqual(leftover, [], '临时目录已删除' + note);
  assert.ok(!fs.existsSync(path.join(home, 'runs.jsonl')));
});
