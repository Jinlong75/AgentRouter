import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';
import { loadPreset } from '../../core/lib/agents.mjs';

// 105：调研 / 审查类任务以只读模式运行，门禁不允许任何改动。每个用例在系统临时目录里建一个真实 git 仓库，
// AR_WORKTREE_ROOT、AGENT_ROUTER_HOME、USERPROFILE / HOME 都指向用例自己的临时目录，执行者是 fake、假 Claude Code 和用 node 写的通用 CLI；不碰真实安装、配置与进程。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const fakeClaude = fileURLToPath(new URL('../fixtures/fake-claude-code.mjs', import.meta.url));

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

// 任务说明：type 与额外的 frontmatter 行由用例给；max_retries: 0 让失败的任务只跑一次。
function specText({ title, type, extra = [] }) {
  return ['---', 'id: 950', `title: ${title}`, `type: ${type}`, 'max_retries: 0', ...extra, '---', '', '测试说明正文。', ''].join('\n');
}

// 通用 CLI 的假执行者：每次运行往日志里追加一行当前模式（RW / RO），日志路径是第一个参数；
// 'exit1' 让它以 1 退出（用来测手动重试）。
const marker = mode => `require('fs').appendFileSync(process.argv[1], '${mode}\\n'); process.exitCode = process.argv[2] === 'exit1' ? 1 : 0`;

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 只读 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  const wtRoot = path.join(base, 'wt 根');
  // 证据文件放在先建好的子目录里：用户目录根（这里是 base）第一层出现新条目会被"工作区外写入"检查算成新文件。
  const evidence = path.join(base, '证据');
  const log = path.join(evidence, 'generic-mode.log');
  mkdirSync(repo);
  mkdirSync(home);
  mkdirSync(evidence);
  const env = {
    ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: wtRoot, AR_NO_WATCH: '1', USERPROFILE: base, HOME: base, APPDATA: base,
    AR_TEST_AGENT: fakeClaude, AR_TEST_ENV_REPORT: path.join(evidence, 'claude-args.json'), DEEPSEEK_API_KEY: 'sk-test-readonly-only',
  };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '只读测试']);
  git(repo, ['config', 'user.email', 'readonly@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true }, null, 2));
  commitAll(repo, '初始提交');
  const f = { base, repo, home, wtRoot, env, log, count: 0 };
  // 执行者：fake（默认）、cc（假 Claude Code，经 AR_TEST_AGENT）、ro（有只读参数的通用 CLI）、plain（没有只读参数的通用 CLI）。
  f.setFake = (value, { roFail = false } = {}) => {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
      profiles: {
        fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...value },
        cc: loadPreset('deepseek').profile,
        ro: { adapter: 'generic', generic: 'ro', enabled: true },
        plain: { adapter: 'generic', generic: 'plain', enabled: true },
      },
      generics: {
        ro: { label: '只读 CLI', executable: process.execPath, args: ['-e', marker('RW'), log, '{prompt}'], readOnlyArgs: ['-e', marker('RO'), log, ...(roFail ? ['exit1'] : []), '{prompt}'], output: { format: 'text' } },
        plain: { label: '普通 CLI', executable: process.execPath, args: ['-e', marker('RW'), log, '{prompt}'], output: { format: 'text' } },
      },
    }));
  };
  f.setFake({});
  f.ar = (args, { env: extra = {}, timeout = 90000 } = {}) => new Promise((resolve, reject) => {
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
  // 提交任务说明并派发（前台等它跑完）；返回 { name, id, start, result }。expect 是期望的退出码，null 表示不检查（拒绝派发时用）。
  f.dispatch = async (name, { type, extra = [], profile = null, fake = {}, roFail = false, expect = 0 } = {}) => {
    f.setFake(fake, { roFail });
    f.count += 1;
    const rel = `docs/specs/${String(950 + f.count)}-${name.replace(/\W+/g, '')}.md`;
    write(path.join(repo, rel), specText({ title: `只读测试 ${name}`, type, extra }));
    commitAll(repo, `任务说明 ${name}`);
    const result = await f.ar(['dispatch', rel, '--name', name, ...(profile ? ['--profile', profile] : []), '--json']);
    if (expect !== null) assert.equal(result.code, expect, result.stderr + result.stdout);
    const start = rows(home).find(row => row.event === 'start' && row.name === name);
    return { name, rel, id: start?.id, start, result };
  };
  f.events = id => rows(home).filter(row => row.id === id);
  f.dispatchJson = name => JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'dispatch.json'), 'utf8'));
  f.gateJson = name => JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'gate.json'), 'utf8'));
  t.after(async () => {
    // 只结束本 fixture 清单里记录的派发进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 只读 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('1 research / review 任务与 read_only: true 的任务：start 与 dispatch.json 记 readOnly: true，门禁照常写 gate: true 并通过', async t => {
  const f = fixture(t);
  for (const [name, options] of [['调研', { type: 'research' }], ['审查', { type: 'review' }], ['标记只读', { type: 'docs', extra: ['read_only: true'] }]]) {
    const task = await f.dispatch(name, options);
    assert.equal(task.start.readOnly, true, `${name}：start.readOnly`);
    assert.equal(task.start.gate, true, `${name}：门禁启用（没有 allowed_paths / verify 也一样）`);
    assert.equal(f.dispatchJson(name).readOnly, true, `${name}：dispatch.json.readOnly`);
    assert.equal(f.dispatchJson(name).gate.readOnly, true, `${name}：门禁信息里带 readOnly，重试与托管请求靠它沿用`);
    const gate = f.gateJson(name);
    assert.equal(gate.ok, true, `${name}：${gate.summary}`);
    assert.deepEqual(gate.scope.allowed, [], `${name}：允许路径视为空`);
    assert.equal(gate.commit.required, false, `${name}：不要求提交`);
    assert.deepEqual(f.events(task.id).filter(row => row.event === 'gate').map(row => row.ok), [true]);
  }
});

test('2 可写任务不带 readOnly 字段：start、dispatch.json 与门禁信息里都没有', async t => {
  const f = fixture(t);
  const task = await f.dispatch('写代码', { type: 'code', extra: ['expect_commit: false', 'allowed_paths:', '  - src/**'] });
  assert.ok(!('readOnly' in task.start), 'start 没有 readOnly');
  assert.ok(!('readOnly' in f.dispatchJson('写代码')), 'dispatch.json 没有 readOnly');
  assert.ok(!('readOnly' in f.dispatchJson('写代码').gate), '门禁信息没有 readOnly');
  assert.equal(f.gateJson('写代码').ok, true);
});

test('3 只读任务改了文件：门禁不通过，summary 写"只读任务改动了文件"，已提交与没提交的都算', async t => {
  const f = fixture(t);
  // 改了文件但没提交：本来的写法是"有未提交的文件"，只读任务合成一段。
  const dirty = await f.dispatch('偷偷改', { type: 'research', fake: { writes: [{ path: 'src/a.js', content: '偷改\n' }] }, expect: 3 });
  const gate = f.gateJson('偷偷改');
  assert.equal(gate.ok, false);
  assert.equal(gate.summary, '只读任务改动了文件：src/a.js');
  assert.deepEqual(gate.scope.outside, ['src/a.js']);
  assert.deepEqual(gate.uncommitted, ['src/a.js']);
  assert.deepEqual(gate.scope.allowed, []);
  assert.deepEqual(f.events(dirty.id).filter(row => row.event === 'gate').map(row => row.ok), [false]);
  assert.equal(f.events(dirty.id).at(-1).exit, 3);

  // 改了文件并提交：base..HEAD 里的改动算越界；顺带新增一个文件。
  await f.dispatch('提交了改动', {
    type: 'research', expect: 3,
    fake: { writes: [{ path: 'src/a.js', content: '改过\n' }, { path: 'notes/新.md', content: '新\n' }], commit: '假执行者：偷偷提交' },
  });
  const committed = f.gateJson('提交了改动');
  assert.equal(committed.ok, false);
  assert.match(committed.summary, /^只读任务改动了文件：/);
  assert.deepEqual([...committed.scope.outside].sort(), ['notes/新.md', 'src/a.js']);
  assert.deepEqual(committed.uncommitted, []);
  assert.equal(committed.commit.required, false);

  // 同样的改动，可写的 code 任务（允许 src/** 与 notes/**）门禁通过：对照只读的规则。
  await f.dispatch('可写对照', {
    type: 'code', extra: ['expect_commit: false', 'allowed_paths:', '  - src/**', '  - notes/**'],
    fake: { writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：正常提交' },
  });
  assert.equal(f.gateJson('可写对照').ok, true);
});

test('4 验收命令照常运行：只读任务的 verify 失败仍然让门禁失败', async t => {
  const f = fixture(t);
  await f.dispatch('验收失败', { type: 'research', extra: ['verify:', '  - node -e "process.exit(5)"'], expect: 3 });
  const gate = f.gateJson('验收失败');
  assert.equal(gate.ok, false);
  assert.equal(gate.commands.length, 1);
  assert.equal(gate.commands[0].exit, 5);
  assert.match(gate.summary, /^验收命令失败：/);
});

test('5 Claude Code 执行者：只读任务带只读参数（dontAsk + 只读工具），可写任务仍是 bypassPermissions', async t => {
  const f = fixture(t);
  const args = () => JSON.parse(readFileSync(path.join(f.base, '证据', 'claude-args.json'), 'utf8')).args;
  await f.dispatch('只读运行', { type: 'research', profile: 'cc' });
  const readOnly = args();
  assert.equal(readOnly[readOnly.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(readOnly.includes('--tools') && readOnly.includes('--allowedTools'), readOnly.join(' '));
  assert.ok(!readOnly.includes('bypassPermissions'));
  await f.dispatch('可写运行', { type: 'code', extra: ['expect_commit: false'], profile: 'cc' });
  const writable = args();
  assert.equal(writable[writable.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.ok(!writable.includes('--tools'));
});

test('6 通用 CLI：只读任务用 readOnlyArgs，可写任务用 args；手动重试沿用只读', async t => {
  const f = fixture(t);
  const modes = () => (existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n') : []);
  await f.dispatch('通用只读', { type: 'research', profile: 'ro' });
  assert.deepEqual(modes(), ['RO']);
  await f.dispatch('通用可写', { type: 'docs', extra: ['expect_commit: false'], profile: 'ro' });
  assert.deepEqual(modes(), ['RO', 'RW']);

  // 只读参数让执行者以 1 退出（roFail），任务失败后手动重试：第二次仍是只读参数。
  const task = await f.dispatch('重试只读', { type: 'research', profile: 'ro', roFail: true, expect: 1 });
  assert.deepEqual(modes().slice(2), ['RO'], '派发时跑了一次');
  const retried = await f.ar(['retry', '重试只读', '--note', '再来一次', '--json']);
  assert.equal(retried.code, 1, retried.stderr + retried.stdout);
  assert.deepEqual(modes().slice(2), ['RO', 'RO'], '手动重试仍是只读参数');
  assert.equal(f.events(task.id).filter(row => row.event === 'attempt').length, 2);
});

test('7 --profile 指定不支持只读的执行者：派发前拒绝（退出码 2，不留记录）；可写任务照常', async t => {
  const f = fixture(t);
  const refused = await f.dispatch('拒绝只读', { type: 'research', profile: 'plain', expect: 2 });
  const message = JSON.parse(refused.result.stdout).error;
  assert.equal(message, '普通 CLI 不支持只读任务');
  assert.equal(refused.start, undefined, '没有 start 事件');
  assert.ok(!existsSync(path.join(f.repo, '.agent-runs', '拒绝只读')), '没有记录目录');
  assert.ok(!existsSync(f.log), '执行者没启动');
  assert.equal(git(f.repo, ['worktree', 'list']).split('\n').length, 1, '没有建 worktree');

  // read_only: true 同样；可写类型用同一个执行者可以派发。
  const flagged = await f.dispatch('拒绝标记', { type: 'docs', extra: ['read_only: true'], profile: 'plain', expect: 2 });
  assert.equal(JSON.parse(flagged.result.stdout).error, '普通 CLI 不支持只读任务');
  await f.dispatch('普通可写', { type: 'docs', extra: ['expect_commit: false'], profile: 'plain' });
  assert.deepEqual(readFileSync(f.log, 'utf8').trim().split('\n'), ['RW']);
});
