import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 086：ar status 与 ar wait 遇到待验收（协议 15.11）。每个用例在系统临时目录里建一个名字含中文与空格的真实 git 仓库，
// AR_WORKTREE_ROOT 与 AGENT_ROUTER_HOME 都指向用例自己的临时目录，执行者是 fake；不碰真实安装、配置、进程与 worktree 根。
// 排队、准备、运行、门禁中、已停止这几种进行中的状态用手写的清单行造出来（pid 是测试进程自己，id 带 fab- 前缀，清理时不会被当成派发进程）。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const commitAll = (root, message) => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
};
const rows = home => {
  try {
    return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};
async function until(fn, label, timeout = 30000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

function specText({ title, verify = [] }) {
  const lines = ['---', 'id: 900', `title: ${title}`, 'type: code', 'expect_commit: false', 'allowed_paths:', '  - src/**'];
  if (verify.length) lines.push('verify:', ...verify.map(line => `  - ${line}`));
  lines.push('---', '', '测试说明正文。', '');
  return lines.join('\n');
}

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 状态 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  const wtRoot = path.join(base, 'wt 根');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: wtRoot, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '状态测试']);
  git(repo, ['config', 'user.email', 'status@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true, maxRetries: 0 }, null, 2));
  commitAll(repo, '初始提交');
  const f = { base, repo, home, wtRoot, env, since, count: 0 };
  f.setProfile = value => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
      profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...value } },
    }));
  };
  f.setProfile({});
  f.ar = (args, { timeout = 90000 } = {}) => new Promise((resolve, reject) => {
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
  // 派发一个任务（真实走完）：profile 是这次的假执行者设置；返回 { name, id, start, wt }。
  f.task = async (name, profile = {}, { verify = [], args = [], expect = 0 } = {}) => {
    f.setProfile(profile);
    f.count += 1;
    const rel = `docs/specs/${String(900 + f.count)}-${name.replace(/\W+/g, '')}.md`;
    write(path.join(repo, rel), specText({ title: `状态测试 ${name}`, verify }));
    commitAll(repo, `任务说明 ${name}`);
    const result = await f.ar(['dispatch', rel, '--name', name, ...args, '--json']);
    assert.equal(result.code, expect, result.stderr + result.stdout);
    const start = await until(() => rows(home).find(row => row.event === 'start' && row.name === name), `${name} 的 start`);
    const wt = rows(home).find(row => row.id === start.id && row.event === 'worktree');
    return { name, id: start.id, start, wt };
  };
  // 手写一个任务的清单行：start 之后依次追加 events（每个事件补 v 与 at）。
  f.fabricate = (name, events, { worktree = true } = {}) => {
    const id = `fab-${name}`;
    // 手写的进行中任务也带一份派发记录，allowed_paths 与真实任务的 src/** 不重叠（否则按 140 的规则，后面真派发的任务会排队等它）。
    const dir = path.join(base, 'fab', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'dispatch.json'), JSON.stringify({ v: 1, gate: { enabled: true, base: 'b'.repeat(40), merged: { allowed_paths: ['fab/**'] } } }));
    const lines = [{ v: 2, event: 'start', id, repo, name, dir, spec: null, title: name, role: null, pid: process.pid, started: Date.now() - 60000, profile: 'fake', adapter: 'fake', ...(worktree ? { worktree: true, base: 'b'.repeat(40) } : {}), at: Date.now() },
      ...events.map(event => ({ v: 1, id, at: Date.now(), ...event }))];
    appendFileSync(path.join(home, 'runs.jsonl'), lines.map(line => `${JSON.stringify(line)}\n`).join(''));
    return id;
  };
  f.status = async name => {
    const result = await f.ar(['status', name, '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  t.after(async () => {
    // 只结束本 fixture 清单里记录的派发进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止；手写行不算。
    const real = rows(home).filter(row => !String(row.id).startsWith('fab-'));
    await cleanupProcesses(base, { recorded: recordedStarts(real, script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 状态 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

// 手写的记录没有参数来源（旧任务），--json 没有 params；真实派发的任务每次都记来源，多一个 params（154）。
const legacyKeys = ['ok', 'id', 'name', 'state', 'attempts', 'gate', 'needsScope', 'outsideWrites', 'worktree', 'merge', 'conflict'];
const keys = [...legacyKeys, 'params'];
const change = { writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改 src/a.js' };

test('1 worktree 任务的十种状态各一例：排队、准备、运行、门禁中、待验收、冲突、已合并、已驳回、失败、已停止', async t => {
  const f = fixture(t);
  const wtEvent = { event: 'worktree', dir: path.join(f.wtRoot, 'abcdef-手写'), branch: 'ar/手写', base: 'b'.repeat(40) };
  const fab = [
    // 排队：只有 start / 最后是 queued。
    ['只有开始', [], 'queued'],
    ['排队中', [{ event: 'queued' }], 'queued'],
    // 准备：preparing、worktree、成功的 setup。
    ['准备中', [{ event: 'queued' }, { event: 'preparing' }], 'preparing'],
    ['建好了', [{ event: 'preparing' }, wtEvent], 'preparing'],
    ['准备命令跑完', [{ event: 'preparing' }, wtEvent, { event: 'setup', ok: true, ms: 5, summary: '准备命令完成' }], 'preparing'],
    // 运行：attempt 之后；门禁中：gating 之后；gate 写完回到运行（下一次尝试之前）。
    ['运行中', [{ event: 'preparing' }, wtEvent, { event: 'setup', ok: true, ms: 5, summary: 'x' }, { event: 'attempt', n: 1, total: 3, profile: 'fake', reason: 'first' }, { event: 'spawned' }], 'running'],
    ['门禁中', [{ event: 'attempt', n: 1, total: 3, profile: 'fake', reason: 'first' }, { event: 'gating' }], 'gating'],
    ['门禁刚写完', [{ event: 'attempt', n: 1, total: 3, profile: 'fake', reason: 'first' }, { event: 'gating' }, { event: 'gate', ok: false, attempt: 1, summary: '未通过' }], 'running'],
    ['第二次尝试', [{ event: 'attempt', n: 1, total: 3, profile: 'fake', reason: 'first' }, { event: 'gate', ok: false, attempt: 1, summary: '未通过' }, { event: 'attempt-end', n: 1, ok: false }, { event: 'attempt', n: 2, total: 3, profile: 'fake', reason: 'gate' }], 'running'],
    // 已停止。
    ['被停止', [{ event: 'attempt', n: 1, total: 3, profile: 'fake', reason: 'first' }, { event: 'interrupted', signal: 'stopped-by-command' }], 'stopped'],
    // 手动重试（resume）之后重新算：之前的 end 不算。
    ['重试中', [{ event: 'attempt', n: 1, total: 3, profile: 'fake', reason: 'first' }, { event: 'end', exit: 3, attempts: 1 }, { event: 'resume', pid: process.pid, n: 2 }, { event: 'attempt', n: 2, total: null, profile: 'fake', reason: 'manual' }, { event: 'gating' }], 'gating'],
  ];
  for (const [name, events] of fab) f.fabricate(name, events);
  for (const [name, , expected] of fab) {
    const value = await f.status(name);
    assert.equal(value.state, expected, `${name} 应为 ${expected}`);
    assert.deepEqual(Object.keys(value), legacyKeys, name);
    assert.equal(value.ok, true);
    assert.equal(value.name, name);
  }
  // 字段细节：尝试次数、最近一次门禁、worktree 来自 worktree 事件；还没有的为 null。
  const second = await f.status('第二次尝试');
  assert.equal(second.attempts, 2);
  assert.deepEqual(second.gate, { ok: false, summary: '未通过' });
  assert.equal(second.worktree, null);
  const prepared = await f.status('准备命令跑完');
  assert.deepEqual(prepared.worktree, { dir: wtEvent.dir, branch: 'ar/手写', base: 'b'.repeat(40) });
  assert.equal(prepared.attempts, 0);
  assert.equal(prepared.gate, null);

  // 待验收 → 已合并（带合并提交）。
  const awaiting = await f.task('待验收任务', change, { verify: ['node -e "process.exit(0)"'] });
  let value = await f.status('待验收任务');
  assert.equal(value.state, 'awaiting');
  assert.deepEqual(Object.keys(value), keys);
  assert.equal(value.id, awaiting.id);
  assert.equal(value.attempts, 1);
  assert.equal(value.gate.ok, true);
  assert.equal(typeof value.gate.summary, 'string');
  assert.deepEqual(value.worktree, { dir: awaiting.wt.dir, branch: awaiting.wt.branch, base: awaiting.wt.base });
  assert.equal(value.merge, null);
  assert.equal(value.conflict, null);
  assert.equal(value.needsScope, null);
  assert.equal(value.outsideWrites, null);

  // 冲突：两个任务都改 src/a.js，先合并甲，再合并乙。
  await f.task('冲突甲', { writes: [{ path: 'src/a.js', content: '甲\n' }], commit: '甲' });
  await f.task('冲突乙', { writes: [{ path: 'src/a.js', content: '乙\n' }], commit: '乙' });
  const first = await f.ar(['accept', '冲突甲', '--json']);
  assert.equal(first.code, 0, first.stderr + first.stdout);
  const merged = await f.status('冲突甲');
  assert.equal(merged.state, 'accepted');
  assert.equal(merged.merge, git(f.repo, ['rev-parse', 'HEAD']), 'merge 是合并提交的 SHA');
  assert.equal(merged.conflict, null);
  // 批准甲之后，乙自动按新基线重跑门禁，有冲突：撤销合并，进入冲突状态（不再等批准乙才得到退出码 4）。
  for (const deadline = Date.now() + 60000; (await f.status('冲突乙')).state !== 'conflict';) {
    assert.ok(Date.now() < deadline, '等待超时：冲突乙的自动重跑冲突');
    await delay(200);
  }
  value = await f.status('冲突乙');
  assert.equal(value.state, 'conflict');
  assert.deepEqual(value.conflict, { files: ['src/a.js'] });
  assert.equal(value.merge, null);

  // 已驳回；驳回的任务没有合并提交，worktree 事件仍在清单里。
  const rejected = await f.task('驳回任务', change);
  const reject = await f.ar(['reject', '驳回任务', '--reason', '不要了', '--json']);
  assert.equal(reject.code, 0, reject.stderr + reject.stdout);
  value = await f.status('驳回任务');
  assert.equal(value.state, 'rejected');
  assert.equal(value.merge, null);
  assert.equal(value.worktree.dir, rejected.wt.dir);

  // 失败：执行者以 1 退出（maxRetries 为 0，一次就结束）；汇报里的"需要越界"带出来。
  await f.task('失败任务', { exit: 1, report: '## 需要越界\n- `docs/x.md`：要改这里\n' }, { expect: 1 });
  value = await f.status('失败任务');
  assert.equal(value.state, 'failed');
  assert.equal(value.attempts, 1);
  assert.deepEqual(value.needsScope, [{ path: 'docs/x.md', reason: '要改这里' }]);
  assert.equal(value.gate, null);
});

test('2 非 worktree 任务的四种状态：进行中、完成、失败、已停止；没有 worktree / merge / conflict', async t => {
  const f = fixture(t);
  await f.task('完成任务', change, { args: ['--no-worktree'] });
  let value = await f.status('完成任务');
  assert.equal(value.state, 'done');
  assert.deepEqual(Object.keys(value), keys);
  assert.equal(value.worktree, null);
  assert.equal(value.merge, null);
  assert.equal(value.conflict, null);
  assert.equal(value.attempts, 1);

  await f.task('失败任务', { exit: 1 }, { args: ['--no-worktree'], expect: 1 });
  assert.equal((await f.status('失败任务')).state, 'failed');

  f.fabricate('进行任务', [{ event: 'attempt', n: 1, total: 3, profile: 'fake', reason: 'first' }, { event: 'gating' }], { worktree: false });
  value = await f.status('进行任务');
  assert.equal(value.state, 'running', '非 worktree 任务没有门禁中，一律是进行中');
  assert.equal(value.attempts, 1);

  f.fabricate('停止任务', [{ event: 'attempt', n: 1, total: 3, profile: 'fake', reason: 'first' }, { event: 'interrupted', signal: 'stopped-by-command' }], { worktree: false });
  assert.equal((await f.status('停止任务')).state, 'stopped');
});

test('3 ar status 的文字输出与错误：找不到记录、参数不对都是退出码 2', async t => {
  const f = fixture(t);
  await f.task('待验收任务', change);
  const text = await f.ar(['status', '待验收任务']);
  assert.equal(text.code, 0, text.stderr + text.stdout);
  const lines = text.stdout.trim().split(/\r?\n/);
  assert.equal(lines[0], '状态：待验收任务（awaiting）');
  assert.ok(lines.some(line => line.startsWith('worktree：')), text.stdout);

  const missing = await f.ar(['status', '不存在的任务', '--json']);
  assert.equal(missing.code, 2);
  assert.deepEqual(JSON.parse(missing.stdout), { ok: false, error: '状态：在当前仓库找不到记录 不存在的任务' });
  const noName = await f.ar(['status', '--json']);
  assert.equal(noName.code, 2);
  assert.equal(JSON.parse(noName.stdout).ok, false);
  const two = await f.ar(['status', '甲', '乙', '--json']);
  assert.equal(two.code, 2);
});

test('3b 已撤销的合并（129）：状态仍是 accepted，JSON 多 reverted、文字多一行；没撤销的任务 JSON 没有 reverted 键；撤销写在合并之前的不算', async t => {
  const f = fixture(t);
  const commit = 'd'.repeat(40), at = Date.UTC(2026, 9, 25, 6, 5);
  const merged = { event: 'accepted', merge: 'c'.repeat(40), mode: 'no-ff', by: 'human' };
  f.fabricate('合并后撤销', [{ event: 'end', exit: 0 }, merged, { event: 'reverted', commit, by: 'human', at }]);
  f.fabricate('合并没撤销', [{ event: 'end', exit: 0 }, merged]);
  f.fabricate('撤销在合并前', [{ event: 'end', exit: 0 }, { event: 'reverted', commit, by: 'human', at }, merged]);

  const value = await f.status('合并后撤销');
  assert.equal(value.state, 'accepted');
  assert.deepEqual(Object.keys(value), [...legacyKeys, 'reverted']);
  assert.equal(value.merge, 'c'.repeat(40));
  assert.deepEqual(value.reverted, { commit, at, by: 'human' });
  const text = await f.ar(['status', '合并后撤销']);
  assert.match(text.stdout, new RegExp(`^已撤销：提交 ${commit.slice(0, 7)}（\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}）$`, 'm'));

  for (const name of ['合并没撤销', '撤销在合并前']) {
    const other = await f.status(name);
    assert.equal(other.state, 'accepted', name);
    assert.deepEqual(Object.keys(other), legacyKeys, `${name}：没有 reverted 键`);
    assert.ok(!(await f.ar(['status', name])).stdout.includes('已撤销'), name);
  }
});

test('4 ar wait 遇到待验收：退出码 0、多一行原文、--json 多 state；已合并、失败、已停止也带 state；非 worktree 任务不变', async t => {
  const f = fixture(t);
  await f.task('待验收任务', change);
  const line = '待验收：用 ar accept 待验收任务 合并，或 ar reject 待验收任务 --reason "…" 驳回';

  const plain = await f.ar(['wait', '待验收任务']);
  assert.equal(plain.code, 0, plain.stderr + plain.stdout);
  assert.equal(plain.stdout.trim().split(/\r?\n/).at(-1), line, '提示在最后一行');
  assert.ok(plain.stdout.includes('exit=0 report='));

  const json = await f.ar(['wait', '待验收任务', '--json']);
  assert.equal(json.code, 0, json.stderr + json.stdout);
  const value = JSON.parse(json.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.exit, 0);
  assert.equal(value.state, 'awaiting');
  assert.ok(value.lines.includes(line));

  // 合并之后再等：仍是退出码 0，状态 accepted，没有待验收提示。
  const accepted = await f.ar(['accept', '待验收任务', '--json']);
  assert.equal(accepted.code, 0, accepted.stderr + accepted.stdout);
  const after = await f.ar(['wait', '待验收任务', '--json']);
  assert.equal(after.code, 0);
  const afterValue = JSON.parse(after.stdout);
  assert.equal(afterValue.state, 'accepted');
  assert.ok(!afterValue.lines.some(item => item.startsWith('待验收：')));

  // 失败：退出码照旧透传执行者的退出码，state 为 failed。
  await f.task('失败任务', { exit: 1 }, { expect: 1 });
  const failed = await f.ar(['wait', '失败任务', '--json']);
  assert.equal(failed.code, 1);
  assert.equal(JSON.parse(failed.stdout).state, 'failed');

  // 已停止（清单里有 interrupted）。
  f.fabricate('停止任务', [{ event: 'attempt', n: 1, total: 3, profile: 'fake', reason: 'first' }, { event: 'interrupted', signal: 'stopped-by-command' }]);
  const stopped = await f.ar(['wait', '停止任务', '--json']);
  assert.equal(stopped.code, 1);
  assert.equal(JSON.parse(stopped.stdout).state, 'stopped');

  // 非 worktree 任务：行为不变，没有 state，也没有待验收提示。
  await f.task('完成任务', { writes: [{ path: 'src/b.js', content: '新文件\n' }], commit: '假执行者：加 src/b.js' }, { args: ['--no-worktree'] });
  const plainTask = await f.ar(['wait', '完成任务', '--json']);
  assert.equal(plainTask.code, 0);
  const plainValue = JSON.parse(plainTask.stdout);
  assert.ok(!('state' in plainValue));
  assert.ok(!plainValue.lines.some(item => item.startsWith('待验收：')));
});
