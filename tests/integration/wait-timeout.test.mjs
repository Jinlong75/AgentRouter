import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { locateStartWaiting } from '../../core/lib/wait.mjs';

const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
function fixture(t) {
  const base = fs.mkdtempSync(join(tmpdir(), 'ar-wait-timeout-'));
  const repo = join(base, 'repo'), home = join(base, 'home'), children = [];
  fs.mkdirSync(repo); fs.mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, CODEX_DISPATCH_HOME: home };
  const file = join(home, 'runs.jsonl');
  const append = row => fs.appendFileSync(file, JSON.stringify({ v: 1, ...row }) + '\n');
  function launch(args) {
    const child = spawn(process.execPath, [entry, ...args], { cwd: repo, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.done = new Promise((res, rej) => { child.on('error', rej); child.on('close', code => res({ code, stdout, stderr })); });
    return child;
  }
  async function fake() {
    const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(child); child.done = once(child, 'close'); await once(child, 'message');
    append({ event: 'start', id: 'sample', repo, name: '中文任务', pid: child.pid, started: Date.now(), report: join(repo, 'report.md') });
    return child;
  }
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(children.map(child => child.done));
    assert.equal(dirname(base), resolve(tmpdir()));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { repo, home, file, append, launch, fake };
}

test('超时只读且不停止任务，任务随后可以正常结束', async t => {
  const f = fixture(t), fake = await f.fake(), before = fs.readFileSync(f.file);
  const result = await f.launch(['wait', '中文任务', '--timeout', '1']).done;
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stdout, /等待超时（1 秒），任务仍在运行：中文任务\n/);
  assert.equal(fake.exitCode, null); assert.equal(fake.signalCode, null);
  assert.deepEqual(fs.readFileSync(f.file), before);
  f.append({ event: 'end', id: 'sample', exit: 0 });
  assert.equal((await f.launch(['wait', '中文任务']).done).code, 0);
});

test('时限内结束与不带超时的结果相同', async t => {
  const f = fixture(t); await f.fake();
  const timed = f.launch(['wait', '中文任务', '--timeout', '2']);
  const ordinary = f.launch(['wait', '中文任务']);
  await delay(500); f.append({ event: 'end', id: 'sample', exit: 0 });
  const a = await timed.done, b = await ordinary.done;
  assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
  assert.equal(a.stdout, b.stdout);
});

test('JSON 超时包含任务名和当前状态', async t => {
  const f = fixture(t); await f.fake();
  const result = await f.launch(['wait', '--timeout', '1', '--json']).done;
  assert.equal(result.code, 4, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: 'TIMEOUT', error: '等待超时（1 秒），任务仍在运行：中文任务', name: '中文任务', state: 'running', concurrencyAdjust: null, warnings: [] });
});

test('托管请求尚未写入 start 时也受超时限制', async t => {
  const f = fixture(t); fs.mkdirSync(join(f.home, 'managed'));
  fs.writeFileSync(join(f.home, 'managed', 'sample.running.json'), JSON.stringify({ repo: f.repo, name: '中文任务' }));
  const result = await f.launch(['wait', '中文任务', '--timeout', '1', '--json']).done;
  assert.equal(result.code, 4, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, 'running');
});

test('非法超时值退出 2 并给出中文原因', async t => {
  const f = fixture(t);
  for (const value of ['0', '-1', '1.5', 'abc', '', undefined]) {
    const result = await f.launch(['wait', '中文任务', '--timeout', ...(value === undefined ? [] : [value]), '--json']).done;
    assert.equal(result.code, 2, String(value));
    assert.match(JSON.parse(result.stdout).error, /正整数秒/);
  }
});


test('timeout outlasts the start lookup limit', async t => {
  const f = fixture(t); fs.mkdirSync(join(f.home, 'managed'));
  fs.writeFileSync(join(f.home, 'managed', 'sample.running.json'), JSON.stringify({ repo: f.repo, name: 'task' }));
  let timedOut = false;
  const began = performance.now();
  const result = await locateStartWaiting(f.home, f.repo, 'task', {
    startLimit: 20, timeoutDeadline: began + 150, onTimeout: () => { timedOut = true; }
  });
  assert.equal(result, null); assert.equal(timedOut, true);
  assert.ok(performance.now() - began >= 150);
});

test('concurrent retry requests use the selected task', async t => {
  const f = fixture(t); await f.fake(); f.append({ event: 'end', id: 'sample', exit: 1 });
  fs.mkdirSync(join(f.home, 'managed'));
  fs.writeFileSync(join(f.home, 'managed', 'a.running.json'), JSON.stringify({ repo: f.repo, id: 'other', name: 'other' }));
  fs.writeFileSync(join(f.home, 'managed', 'b.running.json'), JSON.stringify({ repo: f.repo, id: 'sample', name: 'task', retry: { n: 2 } }));
  const result = await f.launch(['wait', '--timeout', '1', '--json']).done;
  assert.equal(result.code, 4, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.name, '\u4e2d\u6587\u4efb\u52a1'); assert.equal(value.state, 'failed');
  assert.ok(value.error.includes(value.name));
});
