import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { identityAlive, pidAlive, processList, redactPaths } from '../../core/lib/process.mjs';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// 049：停止任务时的结束顺序。全部在系统临时目录、隔离的 AGENT_ROUTER_HOME 与 fake 执行者里做，
// 不碰真实安装、配置与进程。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const registrySource = fileURLToPath(new URL('../../app/src/main/registry.ts', import.meta.url));
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const commitAll = (root, message) => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
};
// 停止后核对"这个进程"是否还在：按 PID + 创建时间（停止前快照里记下的身份），只按 PID 判断时，
// PID 被别的进程复用会误判为仍存活（051 运行中出现过一次，疑似、未确认）。
const sameProcessesAlive = async procs => {
  const list = await processList();
  return procs.filter(proc => list.some(p => p.pid === proc.pid && p.created === proc.created));
};
// 结束顺序（049 任务说明规定的追踪行，只在 AR_CORE_TRACE=1 时输出）：先"结束根"、确认"根已结束"，再"结束子孙"；
// 任何一次结束调用都不带 /T。旧实现一次 taskkill /T 没有这些行，必定失败（用户要求的确定性负向对照）。
const assertRootFirst = (stderr, label) => {
  const lines = stderr.split('\n').filter(line => line.includes('[ar-trace]') && line.includes('进程树结束'));
  const at = text => lines.findIndex(line => line.includes(text));
  const root = at(' 结束根 '), gone = at(' 根已结束'), descendants = at(' 结束子孙 ');
  assert.ok(root >= 0 && gone > root && descendants > gone, `${label}：追踪里应先"结束根""根已结束"，再"结束子孙"：\n${lines.join('\n')}`);
  assert.ok(!lines.some(line => line.includes('/T')), `${label}：任何结束调用都不带 /T：\n${lines.join('\n')}`);
};
const rows = home => {
  try {
    return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};
async function until(fn, label, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

// 临时目录先取长路径：进程命令行里的 cwd 是长路径，Windows 8.3 短名会让快照比对失败。
const tempRoot = realpathSync.native(os.tmpdir());

function fixture(t, profile = {}, spec = null) {
  const base = mkdtempSync(path.join(tempRoot, 'ar-stop-order-'));
  // 目录名用 ASCII：Windows 上 processList 的 PowerShell 输出对中文命令行会乱码，按命令行核对进程时会漏。
  // 保留空格，仍然覆盖带空格的路径。
  const home = path.join(base, 'home 049'), repo = path.join(base, 'repo 049');
  mkdirSync(home);
  mkdirSync(repo);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_CORE_TRACE']) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '停止顺序测试']);
  git(repo, ['config', 'user.email', 'stop-order@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
    profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...profile } },
  }));
  commitAll(repo, '初始提交');
  if (spec) {
    write(path.join(repo, spec.relative), spec.text);
    commitAll(repo, `任务说明 ${path.basename(spec.relative)}`);
  }
  const f = { base, home, repo, env };
  f.ar = (args, { env: extra = {}, timeout = 120000 } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repo, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  // 命令行里带着这个临时仓库或隔离公共目录的进程，加上指定的进程。
  // 069：targets 里的元素是 { pid, created } 身份时按身份（PID + 创建时间）匹配——PID 被别的进程复用不算；是纯 PID 数字时仍按 PID 匹配（停止前取快照用）。
  f.related = async targets => {
    const list = await processList();
    const matches = p => targets.some(target => typeof target === 'number' ? target === p.pid : identityAlive([p], target));
    return list.filter(p => matches(p) || String(p.command).includes(repo) || String(p.command).includes(home));
  };
  f.waitGone = async (pids, label, timeout = 5000) => {
    let left = [];
    for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
      left = await f.related(pids);
      if (!left.length) return;
      await delay(50);
    }
    throw Error(`${label}：仍有进程存活：${left.map(p => `pid=${p.pid} ${redactPaths(p.command)}`).join('；')}`);
  };
  t.after(async () => {
    // 只结束命令行里带着这个临时目录的进程，按身份（PID + 创建时间）逐个结束，不带 /T，不按 PID。
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(tempRoot, base).startsWith('ar-stop-order-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

// 用软件自己的读取规则（app/src/main/registry.ts，与 tests/gui/monitor.ts 相同做法）读清单。
async function readWithApp(base, file) {
  const outfile = path.join(base, 'registry-check.cjs');
  await build({ entryPoints: [registrySource], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' });
  return createRequire(import.meta.url)(outfile).parseRegistry(readFileSync(file, 'utf8'));
}

test('--detach 任务被 ar stop 停止：清单只有 start / spawned / interrupted，整棵进程树都退出（连续 10 次）', async t => {
  const f = fixture(t, { events: [{ kind: 'say', text: '正在做' }], delayMs: 60000 });
  let traceSample = '';
  for (let i = 1; i <= 10; i++) {
    const name = `stop-order-${i}`;
    const dispatched = await f.ar(['dispatch', '隔离任务', '--name', name, '--detach', '--json']);
    assert.equal(dispatched.code, 0, dispatched.stderr + dispatched.stdout);
    const start = await until(() => rows(f.home).find(row => row.event === 'start' && row.name === name), `第 ${i} 次 start 记录`);
    const spawned = await until(() => rows(f.home).find(row => row.event === 'spawned' && row.id === start.id), `第 ${i} 次 spawned 记录`);
    assert.ok(pidAlive(start.pid), `第 ${i} 次派发进程在停止前存活`);
    assert.ok(pidAlive(spawned.agentPid), `第 ${i} 次执行者在停止前存活`);

    // 派发后的完整进程快照：派发进程、执行者都在，执行者的命令行带着这个临时仓库。
    const before = await f.related([start.pid, spawned.agentPid]);
    const describe = list => list.map(p => `pid=${p.pid} ${redactPaths(p.command)}`).join('；') || '（空）';
    assert.ok(before.some(p => p.pid === start.pid), `第 ${i} 次快照里有派发进程：${describe(before)}`);
    assert.ok(before.some(p => p.pid === spawned.agentPid && String(p.command).includes(f.repo)), `第 ${i} 次快照里有执行者（仓库 ${redactPaths(f.repo)}）：${describe(before)}`);

    const stop = await f.ar(['stop', name], { env: { AR_CORE_TRACE: '1' } });
    assert.equal(stop.code, 0, `第 ${i} 次停止失败：${stop.stderr}${stop.stdout}`);
    assertRootFirst(stop.stderr, `第 ${i} 次停止`);
    if (!traceSample) {
      const lines = stop.stderr.split('\n').filter(line => line.includes('[ar-trace]') && line.includes('进程树结束'));
      traceSample = lines.join('\n');
      t.diagnostic(`第 1 次 ar stop 的进程树追踪：\n${traceSample}`);
    }

    // 清单事件只有 start、attempt、spawned、interrupted：没有 end。
    assert.deepEqual(rows(f.home).filter(row => row.id === start.id).map(row => row.event),
      ['start', 'attempt', 'spawned', 'interrupted'], `第 ${i} 次清单事件`);
    // 停止后的完整进程快照：命令行里带着这个临时仓库 / 隔离公共目录的进程为 0，两个 pid 也不在。
    const identities = [before.find(p => p.pid === start.pid), before.find(p => p.pid === spawned.agentPid)];
    assert.ok(identities.every(p => p && Number.isFinite(p.created)), `第 ${i} 次停止前快照里有派发进程与执行者的创建时间`);
    // 069：按停止前的身份（PID + 创建时间）等它们退出，PID 被复用不再算"仍有进程存活"。
    await f.waitGone(identities, `第 ${i} 次停止后仍有进程`);
    assert.deepEqual(await sameProcessesAlive(identities), [], `第 ${i} 次派发进程与执行者（同一 PID、同一创建时间）都已退出`);
  }

  // 软件读取：被停止的任务是"已中断"（stop），不是"失败"。
  const tasks = await readWithApp(f.base, path.join(f.home, 'runs.jsonl'));
  assert.equal(tasks.length, 10);
  assert.deepEqual([...new Set(tasks.map(task => task.status))], ['stop']);
});

test('门禁中停止：清单没有 end、有 interrupted，验收命令的整棵进程树与派发进程都退出', async t => {
  const marker = 'AR049_GATE';
  // 长时间运行并再派生一个子进程的验收命令；两个进程的命令行都带 marker，便于按快照核对。
  const verify = `node -e "const cp=require('child_process');cp.spawn(process.execPath,['-e','setTimeout(()=>{},120000)/*${marker}_CHILD*/'],{stdio:'ignore'});setTimeout(()=>{},120000)/*${marker}*/"`;
  const spec = {
    relative: 'docs/specs/901-门禁中停止.md',
    text: ['---', 'id: 901', 'title: 门禁中停止', 'type: code', 'allowed_paths:', '  - src/**', 'verify:', `  - ${verify}`, '---', '', '测试说明正文。', ''].join('\n'),
  };
  const f = fixture(t, {
    writes: [{ path: 'src/a.js', content: '改过\n' }],
    commit: '假执行者：改 src/a.js',
  }, spec);
  const name = '门禁中停止';

  const dispatched = await f.ar(['dispatch', spec.relative, '--name', name, '--detach', '--json']);
  assert.equal(dispatched.code, 0, dispatched.stderr + dispatched.stdout);
  const start = await until(() => rows(f.home).find(row => row.event === 'start' && row.name === name), 'start 记录');
  await until(() => rows(f.home).some(row => row.event === 'gating' && row.id === start.id), 'gating 事件');
  // 等到验收命令与它派生的子进程都出现，再停止。
  const running = await until(async () => {
    const list = await processList();
    const hit = list.filter(p => String(p.command).includes(marker));
    return hit.length >= 2 ? hit : null;
  }, '验收命令及其子进程');
  assert.ok(running.some(p => String(p.command).includes(`${marker}_CHILD`)), '验收命令派生的子进程存在');
  assert.ok(pidAlive(start.pid), '派发进程仍在运行');
  const rootBefore = (await processList()).find(p => p.pid === start.pid);
  assert.ok(rootBefore && Number.isFinite(rootBefore.created), '停止前快照里有派发进程与它的创建时间');

  const stop = await f.ar(['stop', name], { env: { AR_CORE_TRACE: '1' } });
  assert.equal(stop.code, 0, stop.stderr + stop.stdout);
  assertRootFirst(stop.stderr, '门禁中停止');
  t.diagnostic(`门禁中停止的进程树追踪：\n${stop.stderr.split('\n').filter(line => line.includes('[ar-trace]') && line.includes('进程树结束')).join('\n')}`);

  const events = rows(f.home).filter(row => row.id === start.id).map(row => row.event);
  assert.ok(!events.includes('end'), `停止后清单里不应有 end：${events.join(',')}`);
  assert.equal(events.at(-1), 'interrupted');
  assert.ok(events.includes('gating'));
  assert.deepEqual(await sameProcessesAlive([rootBefore]), [], '派发进程（同一 PID、同一创建时间）已退出');
  await f.waitGone([rootBefore], '停止后仍有进程'); // 069：按停止前的身份（PID + 创建时间）
  const left = (await processList()).filter(p => String(p.command).includes(marker));
  assert.deepEqual(left, [], '验收命令及其整棵进程树都已退出');

  const tasks = await readWithApp(f.base, path.join(f.home, 'runs.jsonl'));
  const task = tasks.find(item => item.id === start.id);
  assert.equal(task?.status, 'stop', '软件读到的状态是已中断，不是失败');
});
