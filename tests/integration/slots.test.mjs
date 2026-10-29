import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 多个真实进程抢同一组任务名额：任意时刻最多 limit 个持有者；持有者被杀后它的名额被回收。
// 子进程只由本测试启动，也只结束它们自己；公共目录是系统临时目录里的隔离目录。
const slotsUrl = pathToFileURL(fileURLToPath(new URL('../../core/lib/slots.mjs', import.meta.url))).href;

// 子进程：抢名额（limit 2），拿到后写一行 acq，等放行文件出现后写 rel 再释放。
// rel 写在释放之前，日志里的先后顺序因此不会比真实占用更宽松。
const childSource = `import { appendFileSync, existsSync } from 'node:fs';
const [slotsUrl, home, log, hold, id] = process.argv.slice(1);
const { acquireSlot } = await import(slotsUrl);
const note = text => appendFileSync(log, text + '\\n');
const release = await acquireSlot({ home, kind: 'task', id, limit: 2, intervalMs: 100, onWait: () => note('wait ' + id) });
note('acq ' + id);
while (!existsSync(hold)) await new Promise(resolve => setTimeout(resolve, 25));
note('rel ' + id);
release();
`;

async function until(fn, label, timeout = 60000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

test('三个进程抢两个任务名额：任意时刻最多 2 个持有；杀掉一个持有者后名额被回收', async t => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-slots-it-'));
  const home = path.join(base, 'home');
  const log = path.join(base, 'slots.log');
  const hold = path.join(base, 'release.flag');
  writeFileSync(log, '');
  const children = new Map();
  t.after(() => {
    // 只结束本测试自己启动的子进程。
    for (const child of children.values()) if (child.exitCode === null && child.signalCode === null) child.kill();
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const has = text => lines().includes(text);
  const slotNames = () => (existsSync(path.join(home, 'slots')) ? readdirSync(path.join(home, 'slots')).sort() : []);
  const start = id => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, slotsUrl, home, log, hold, id], { stdio: 'ignore', windowsHide: true, shell: false });
    children.set(id, child);
    child.on('error', () => {});
    return child;
  };

  start('c1');
  start('c2');
  await until(() => has('acq c1') && has('acq c2'), 'c1、c2 各拿到一个名额');
  assert.deepEqual(slotNames(), ['slot-1.json', 'slot-2.json']);
  start('c3');
  await until(() => has('wait c3'), 'c3 开始排队');
  await delay(500);   // 排队的进程多试几轮，仍然拿不到
  assert.equal(has('acq c3'), false, '名额满了，c3 拿不到');

  // 杀掉 c1（本测试自己启动的子进程）：它的名额文件留在原处，c3 按孤立回收后拿到。
  const killed = children.get('c1');
  const exited = new Promise(resolve => killed.once('exit', resolve));
  killed.kill();
  await exited;
  await until(() => has('acq c3'), 'c3 回收 c1 的名额后拿到');
  const owners = slotNames().map(name => JSON.parse(readFileSync(path.join(home, 'slots', name), 'utf8')).id).sort();
  assert.deepEqual(owners, ['c2', 'c3'], '名额现在由 c2、c3 持有，没有 c1 的残留');
  assert.equal(slotNames().length, 2, '没有 .stale- 残留');

  writeFileSync(hold, 'go');
  await until(() => has('rel c2') && has('rel c3'), 'c2、c3 释放');
  await Promise.all(['c2', 'c3'].map(id => until(() => children.get(id).exitCode !== null, `${id} 退出`)));
  await until(() => slotNames().length === 0, '名额文件全部删除');

  // 按日志顺序重放：任意时刻持有者不超过 2。c1 被杀时来不及写 rel，c3 拿到名额时它早已不在，重放时先把它去掉。
  const holders = new Set();
  let peak = 0;
  for (const line of lines()) {
    const [kind, id] = line.split(' ');
    if (kind === 'acq') {
      if (id === 'c3') holders.delete('c1');
      holders.add(id);
      peak = Math.max(peak, holders.size);
    } else if (kind === 'rel') holders.delete(id);
  }
  assert.ok(peak <= 2, `最多同时 ${peak} 个持有者`);
  assert.equal(lines().filter(line => line.startsWith('acq ')).length, 3);
});

// 端到端：排队期间调大 config.json 的 concurrency，已在排队的任务按新上限开始，不用重新派发。
// 仓库、公共目录与 worktree 根都在系统临时目录里，执行者是 fake（等放行文件）。
test('排队中调大 concurrency：B 不重新派发就开始，进度写"并发上限改为 2（原来 1）"', async t => {
  const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-slots-e2e-'));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const wtRoot = path.join(base, 'wt');
  const release = path.join(base, 'go.flag');
  mkdirSync(repo);
  mkdirSync(home);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, 'utf8'); };
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: wtRoot, CLAUDE_CONFIG_DIR: path.join(base, 'claude'), AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  const rows = () => {
    try { return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch { return []; }
  };
  t.after(async () => {
    writeFileSync(release, 'go');
    await cleanupProcesses(base, { recorded: recordedStarts(rows(), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-slots-e2e-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', '名额端到端测试']);
  git(['config', 'user.email', 'slots-e2e@example.test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({
    v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true,
  }, null, 2));
  for (const label of ['甲', '乙']) {
    write(path.join(repo, `docs/specs/${label}.md`), ['---', 'id: 900', `title: 名额 ${label}`, 'type: code', 'expect_commit: false', 'max_retries: 0', 'allowed_paths:', `  - ${label}/**`, '---', '', '测试说明正文。', ''].join('\n'));
  }
  git(['add', '--', '.gitignore', 'src/a.js', '.agent-router/project.json', 'docs/specs/甲.md', 'docs/specs/乙.md']);
  git(['commit', '-q', '-m', '初始提交']);
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, releaseFile: release, releaseTimeoutMs: 60000 };
  const writeConfig = concurrency => writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile }, concurrency,
  }));
  writeConfig(1);
  const ar = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, 90000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const dispatch = async label => {
    const result = await ar(['dispatch', `docs/specs/${label}.md`, '--name', `名额${label}`, '--detach', '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout).id;
  };
  const progress = label => { try { return readFileSync(path.join(repo, '.agent-runs', `名额${label}`, 'progress.log'), 'utf8'); } catch { return ''; } };
  const has = (id, event) => rows().some(row => row.id === id && row.event === event);

  const a = await dispatch('甲');
  await until(() => has(a, 'spawned'), '甲启动执行者');
  const b = await dispatch('乙');
  await until(() => has(b, 'queued'), '乙排队');
  assert.match(progress('乙'), /排队：同时最多 1 个任务/);
  await delay(500);
  assert.equal(has(b, 'preparing'), false, '上限 1 时乙还在排队');

  writeConfig(2);
  await until(() => has(b, 'spawned'), '乙在新上限下开始（甲还没结束）');
  assert.equal(has(a, 'end'), false, '甲仍在运行');
  assert.match(progress('乙'), /排队：并发上限改为 2（原来 1）/);
  assert.equal([...progress('乙').matchAll(/并发上限改为/g)].length, 1, '只写一次');

  writeFileSync(release, 'go');
  await until(() => has(a, 'end') && has(b, 'end'), '甲、乙结束', 60000);
  await until(() => !existsSync(path.join(home, 'slots')) || readdirSync(path.join(home, 'slots')).length === 0, '名额清空');
});
