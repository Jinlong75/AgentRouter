import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 门禁名额接入派发的集成测试：隔离的公共目录、系统临时目录里的仓库、fake 执行者。
// 验收命令是一个小脚本：记录开始时刻，等放行文件出现（再多等一会儿）后记录结束时刻，
// 这样"谁在门禁里、谁在排队"完全由测试控制，不靠计时碰运气。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const forward = file => file.replaceAll('\\', '/');
const probeSource = `import { appendFileSync, existsSync } from 'node:fs';
const [log, label, hold] = process.argv.slice(2);
const at = () => Date.now();
appendFileSync(log, 'start ' + label + ' ' + at() + '\\n');
while (!existsSync(hold)) await new Promise(resolve => setTimeout(resolve, 25));
await new Promise(resolve => setTimeout(resolve, 300));
appendFileSync(log, 'end ' + label + ' ' + at() + '\\n');
`;

async function until(fn, label, timeout = 90000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

function fixture(t, { gateConcurrency } = {}) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-gate-slot-'));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '门禁名额测试']);
  git(repo, ['config', 'user.email', 'gate-slot@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  git(repo, ['add', '--', '.gitignore', 'src/a.js']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 };
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile },
    ...(gateConcurrency === undefined ? {} : { gateConcurrency }),
  }));
  const probe = path.join(base, 'probe.mjs');
  const log = path.join(base, 'gate.log');
  const hold = path.join(base, 'release.flag');
  write(probe, probeSource);
  write(log, '');
  const f = { base, repo, home, env, log, hold, since };
  // 一份任务说明：不要求提交、不自动重试，验收命令是上面的探针。
  f.spec = label => {
    const rel = `docs/specs/${label}.md`;
    write(path.join(repo, rel), [
      '---', 'id: 900', `title: 门禁名额 ${label}`, 'type: code', 'allowed_paths:', '  - src/**',
      'verify:', `  - node "${forward(probe)}" "${forward(log)}" ${label} "${forward(hold)}"`,
      'expect_commit: false', 'max_retries: 0', '---', '', '测试说明正文。', '',
    ].join('\n'));
    git(repo, ['add', '--', rel]);
    git(repo, ['commit', '-q', '-m', `任务说明 ${label}`, '--', rel]);
    return rel;
  };
  f.ar = (args, { timeout = 60000 } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  f.rows = () => {
    try { return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch { return []; }
  };
  f.events = id => f.rows().filter(row => row.id === id);
  f.ended = id => f.events(id).find(row => row.event === 'end');
  f.progress = name => {
    try { return readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8'); }
    catch { return ''; }
  };
  // 探针日志：[{ kind: 'start' | 'end', label, at }]。
  f.probeLog = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => {
    const [kind, label, at] = line.split(' ');
    return { kind, label, at: Number(at) };
  });
  f.probed = (kind, label) => f.probeLog().find(item => item.kind === kind && item.label === label);
  f.slotFiles = () => (existsSync(path.join(home, 'slots')) ? readdirSync(path.join(home, 'slots')).sort() : []);
  f.release = () => writeFileSync(hold, 'go');
  // 说明都要在派发之前提交好：之后再提交会改变 HEAD，让先派发的任务的门禁看到范围外的改动。
  f.dispatch = async (label, name) => {
    const result = await f.ar(['dispatch', `docs/specs/${label}.md`, '--name', name, '--detach', '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout).id;
  };
  t.after(async () => {
    f.release();   // 万一用例中途失败，让还在等放行文件的探针结束
    // 只结束本 fixture 清单里记录的派发进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { recorded: recordedStarts(f.rows(), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-gate-slot-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('门禁名额 1：两个任务的门禁不重叠，后一个进度写"等门禁名额"，都通过，结束后 slots/ 没有残留', async t => {
  const f = fixture(t);
  f.spec('甲'); f.spec('乙');
  const a = await f.dispatch('甲', '门禁名额甲');
  await until(() => f.probed('start', '甲'), '甲的门禁开始');
  assert.deepEqual(f.slotFiles(), ['gate-1.json']);
  const b = await f.dispatch('乙', '门禁名额乙');
  await until(() => /等门禁名额：已有 1 个门禁在运行/.test(f.progress('门禁名额乙')), '乙在等门禁名额');
  assert.equal(f.probed('start', '乙'), undefined, '乙的验收命令还没开始');
  assert.equal(f.events(b).some(row => row.event === 'gating'), false, '乙还没写 gating');
  assert.doesNotMatch(f.progress('门禁名额甲'), /等门禁名额/);
  f.release();
  const endA = await until(() => f.ended(a), '甲结束');
  const endB = await until(() => f.ended(b), '乙结束');
  assert.equal(endA.exit, 0);
  assert.equal(endB.exit, 0);
  for (const id of [a, b]) {
    const kinds = f.events(id).map(row => row.event);
    assert.deepEqual(kinds, ['start', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end']);
    assert.equal(f.events(id).find(row => row.event === 'gate').ok, true);
  }
  assert.equal([...f.progress('门禁名额乙').matchAll(/等门禁名额/g)].length, 1, '只写一次');
  const spans = Object.fromEntries(['甲', '乙'].map(label => [label, { start: f.probed('start', label).at, end: f.probed('end', label).at }]));
  t.diagnostic(`门禁时刻：甲 ${spans.甲.start}～${spans.甲.end}；乙 ${spans.乙.start}～${spans.乙.end}`);
  assert.ok(spans.乙.start >= spans.甲.end, '乙的门禁在甲结束之后才开始');
  // attempt-end.ms 包括等待时间，gate.json 的 ms 不包括。
  const gateMs = JSON.parse(readFileSync(path.join(f.rows().find(row => row.id === b && row.event === 'start').dir, 'gate.json'), 'utf8')).ms;
  const attemptMs = f.events(b).find(row => row.event === 'attempt-end').ms;
  assert.ok(attemptMs > gateMs, `attempt-end.ms（${attemptMs}）包括等名额的时间，大于 gate.ms（${gateMs}）`);
  assert.deepEqual(f.slotFiles(), [], 'slots/ 里没有残留文件');
});

test('门禁名额 2：两个门禁可以同时跑，都通过，没有残留', async t => {
  const f = fixture(t, { gateConcurrency: 2 });
  f.spec('甲'); f.spec('乙');
  const a = await f.dispatch('甲', '门禁名额甲');
  const b = await f.dispatch('乙', '门禁名额乙');
  // 放行文件还没有：两个门禁都已经开始，说明名额 2 让它们同时在跑。
  await until(() => f.probed('start', '甲') && f.probed('start', '乙'), '两个门禁都开始');
  assert.deepEqual(f.slotFiles(), ['gate-1.json', 'gate-2.json']);
  assert.doesNotMatch(f.progress('门禁名额甲') + f.progress('门禁名额乙'), /等门禁名额/);
  f.release();
  assert.equal((await until(() => f.ended(a), '甲结束')).exit, 0);
  assert.equal((await until(() => f.ended(b), '乙结束')).exit, 0);
  assert.deepEqual(f.slotFiles(), []);
});

test('等门禁名额时 ar stop：interrupted、没有 gating、没有名额残留，另一个任务照常完成', async t => {
  const f = fixture(t);
  f.spec('甲'); f.spec('乙');
  const a = await f.dispatch('甲', '门禁名额甲');
  await until(() => f.probed('start', '甲'), '甲的门禁开始');
  const b = await f.dispatch('乙', '门禁名额乙');
  await until(() => /等门禁名额/.test(f.progress('门禁名额乙')), '乙在等门禁名额');

  const stopped = await f.ar(['stop', '门禁名额乙']);
  assert.equal(stopped.code, 0, stopped.stderr + stopped.stdout);
  const kinds = f.events(b).map(row => row.event);
  assert.ok(kinds.includes('interrupted'), kinds.join(','));
  assert.equal(kinds.includes('gating'), false);
  assert.equal(kinds.includes('end'), false);
  assert.equal(f.probed('start', '乙'), undefined, '乙的验收命令从没开始');
  // 名额里只有甲自己的那一个，乙没占过。
  assert.deepEqual(f.slotFiles(), ['gate-1.json']);
  assert.equal(JSON.parse(readFileSync(path.join(f.home, 'slots', 'gate-1.json'), 'utf8')).id, a);

  f.release();
  const endA = await until(() => f.ended(a), '甲结束');
  assert.equal(endA.exit, 0);
  assert.equal(f.events(a).find(row => row.event === 'gate').ok, true);
  assert.deepEqual(f.slotFiles(), [], '没有残留名额');
});
