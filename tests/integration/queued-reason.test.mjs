import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 任务 148（给 141 的排队横幅用）：独占门禁在跑、自动档下机器正忙时，queued 事件也带原因——
// { event: 'queued', id, reason: 'exclusive', blockers: [{ id, name }], command, at } 与 { event: 'queued', id, reason: 'busy', cpu, memLow, freeGb, at }（memLow、freeGb 是 171 加的）。
// 每个用例在系统临时目录里建真实 git 仓库；AGENT_ROUTER_HOME、AR_WORKTREE_ROOT 都指向用例自己的临时目录，执行者是 fake。
// 独占用例照 schedule.test.mjs 第 3 条，但不造"孤立标记"（那一段在负载下不稳），只测"别人的独占门禁在跑"。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const rows = home => {
  try { return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
};
async function until(fn, label, timeout = 60000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

const specText = ({ allowed, verify = [] }) => {
  const lines = ['---', 'id: 901', 'title: 排队原因测试', 'type: code', 'expect_commit: true', 'max_retries: 0', 'allowed_paths:'];
  for (const item of allowed) lines.push(`  - ${item}`);
  if (verify.length) {
    lines.push('verify:');
    for (const line of verify) lines.push(`  - ${line}`);
  }
  lines.push('---', '', '测试说明正文。', '');
  return lines.join('\n');
};

function fixture(t, { project = {}, config = {} } = {}) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-queued-reason-'));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'wt'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_TEST_LOAD_FILE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '排队原因测试']);
  git(repo, ['config', 'user.email', 'queued-reason@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'docs/readme.md'), '说明\n');
  // 慢验收脚本：写一个"已开始"标记，等放行文件出现才退出（两个文件都在仓库的上一级目录，不进仓库）。
  write(path.join(repo, 'scripts/slow.mjs'), [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const outside = path.resolve(process.env.AR_BASE_REPO, '..');",
    "writeFileSync(path.join(outside, 'gate-started.flag'), String(process.pid));",
    "while (!existsSync(path.join(outside, 'gate-go.flag'))) await new Promise(resolve => setTimeout(resolve, 50));",
    '',
  ].join('\n'));
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({
    v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true, ...project,
  }, null, 2));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 };
  const f = { base, repo, home, env, profile };
  f.setProfile = value => {
    Object.assign(profile, value);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile }, concurrency: 4, ...config,
    }));
  };
  f.setProfile({});
  f.spec = (rel, fields) => {
    write(path.join(repo, rel), specText(fields));
    git(repo, ['add', '--', rel]);
    git(repo, ['commit', '-q', '-m', `任务说明 ${path.basename(rel)}`]);
    return rel;
  };
  f.ar = (args, { timeout = 90000, env: extra = {} } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  f.dispatch = async (spec, name, options) => {
    const result = await f.ar(['dispatch', spec, '--name', name, '--detach', '--json'], options);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout).id;
  };
  f.events = id => rows(home).filter(row => row.id === id);
  f.has = (id, event) => rows(home).some(row => row.id === id && row.event === event);
  f.progress = name => { try { return readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8'); } catch { return ''; } };
  t.after(async () => {
    // 先放行慢验收，再按身份结束本用例清单里记录的进程，绝不按进程名终止。
    writeFileSync(path.join(base, 'gate-go.flag'), 'go');
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-queued-reason-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('1 独占门禁在跑：新任务的 queued 事件带 reason: exclusive、blockers（占着的任务 id 与名字）与 command；进度文字不变；只写这一条', async t => {
  const f = fixture(t, { project: { exclusiveCommands: ['node scripts/slow.mjs'] } });
  const specD = f.spec('docs/specs/D.md', { allowed: ['docs/d/**'], verify: ['node scripts/slow.mjs'] });
  const specE = f.spec('docs/specs/E.md', { allowed: ['docs/e/**'] });
  const started = path.join(f.base, 'gate-started.flag');

  f.setProfile({ writes: [{ path: 'docs/d/x.md', content: 'D\n' }], commit: '假执行者：D' });
  const d = await f.dispatch(specD, '丁');
  await until(() => existsSync(started), 'D 的独占验收命令开始');

  f.setProfile({ writes: [{ path: 'docs/e/x.md', content: 'E\n' }], commit: '假执行者：E' });
  const e = await f.dispatch(specE, '戊');
  const queued = await until(() => f.events(e).find(row => row.event === 'queued'), 'E 排队');
  assert.equal(queued.reason, 'exclusive');
  assert.deepEqual(queued.blockers, [{ id: d, name: '丁' }]);
  assert.equal(queued.command, 'node scripts/slow.mjs');
  assert.equal(queued.id, e);
  assert.equal(Number.isFinite(queued.at), true);
  assert.deepEqual(Object.keys(queued).sort(), ['at', 'blockers', 'command', 'event', 'id', 'reason', 'v']);
  assert.match(f.progress('戊'), /排队：丁 的门禁正在独占运行（node scripts\/slow\.mjs），等它结束/, '进度文字不变');

  // 等几个轮询周期：原因没变，不重复写；也没有补一条没有原因的 queued。
  await delay(2600);
  assert.equal(f.has(e, 'preparing'), false, 'D 的门禁还在跑，E 不开始');
  assert.deepEqual(f.events(e).filter(row => row.event === 'queued').map(row => row.reason), ['exclusive']);

  writeFileSync(path.join(f.base, 'gate-go.flag'), 'go');
  await until(() => f.has(d, 'gate') && f.has(e, 'end'), 'D 门禁结束后 E 开始并结束');
  assert.equal(f.events(e).find(row => row.event === 'end').exit, 0);
});

test('2 自动档机器正忙：queued 事件带 reason: busy 与 cpu（百分比数字）；进度文字不变；恢复后任务照常开始', async t => {
  const f = fixture(t, { config: { concurrency: 'auto', concurrencyMax: 3 } });
  const spec = f.spec('docs/specs/G.md', { allowed: ['docs/g/**'] });
  const load = path.join(f.base, 'load.json');
  writeFileSync(load, JSON.stringify({ busy: true, cpu: 92 }));
  f.setProfile({ writes: [{ path: 'docs/g/x.md', content: 'G\n' }], commit: '假执行者：G' });

  const g = await f.dispatch(spec, '庚', { env: { AR_TEST_LOAD_FILE: load } });
  const queued = await until(() => f.events(g).find(row => row.event === 'queued'), '忙时排队');
  assert.equal(queued.reason, 'busy');
  assert.equal(queued.cpu, 92);
  assert.equal(queued.id, g);
  assert.equal(Number.isFinite(queued.at), true);
  // 171：多带 memLow（布尔）与 freeGb（一位小数）；CPU 忙时 memLow 为 false。
  assert.equal(queued.memLow, false);
  assert.equal(Number.isFinite(queued.freeGb), true);
  assert.equal(queued.freeGb, Number(queued.freeGb.toFixed(1)), 'freeGb 是一位小数');
  assert.deepEqual(Object.keys(queued).sort(), ['at', 'cpu', 'event', 'freeGb', 'id', 'memLow', 'reason', 'v']);
  assert.match(f.progress('庚'), /排队：机器正忙（CPU 92%），暂停启动新任务/, '进度文字不变');

  // CPU 数字变了：进度文字变了，原因（busy）的事件再写一条，cpu 是新的数字。
  writeFileSync(load, JSON.stringify({ busy: true, cpu: 88 }));
  const second = await until(() => f.events(g).filter(row => row.event === 'queued').find(row => row.cpu === 88), 'cpu 变化后再写一条');
  assert.equal(second.reason, 'busy');
  assert.ok(f.events(g).filter(row => row.event === 'queued').every(row => row.reason === 'busy'), '没有补没有原因的 queued 事件');

  writeFileSync(load, JSON.stringify({ busy: false, cpu: 10 }));
  await until(() => f.has(g, 'end'), '不忙之后开始并结束');
  assert.equal(f.events(g).find(row => row.event === 'end').exit, 0);
});

test('3 自动档可用内存不够：queued 事件带 reason: busy、memLow: true 与 freeGb（一位小数）；进度文字写内存', async t => {
  const f = fixture(t, { config: { concurrency: 'auto', concurrencyMax: 3 } });
  const spec = f.spec('docs/specs/H.md', { allowed: ['docs/h/**'] });
  const load = path.join(f.base, 'load.json');
  writeFileSync(load, JSON.stringify({ busy: true, cpu: 30, memLow: true, freeGb: 1.2 }));
  f.setProfile({ writes: [{ path: 'docs/h/x.md', content: 'H\n' }], commit: '假执行者：H' });

  const h = await f.dispatch(spec, '辛', { env: { AR_TEST_LOAD_FILE: load } });
  const queued = await until(() => f.events(h).find(row => row.event === 'queued'), '内存不够时排队');
  assert.equal(queued.reason, 'busy');
  assert.equal(queued.memLow, true);
  assert.equal(queued.freeGb, 1.2);
  assert.equal(queued.cpu, 30);
  assert.deepEqual(Object.keys(queued).sort(), ['at', 'cpu', 'event', 'freeGb', 'id', 'memLow', 'reason', 'v']);
  assert.match(f.progress('辛'), /排队：机器正忙（可用内存 1\.2 GB），暂停启动新任务/, '进度文字不变，写内存');

  writeFileSync(load, JSON.stringify({ busy: false, cpu: 10 }));
  await until(() => f.has(h, 'end'), '内存回来之后开始并结束');
  assert.equal(f.events(h).find(row => row.event === 'end').exit, 0);
});
