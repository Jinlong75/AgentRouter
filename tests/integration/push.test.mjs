import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';
import { displayUrl, pullBranch, pushBranch, runNetworkGit, scrubUrls, urlHasCredential } from '../../core/lib/push.mjs';

// Stage07b 128：ar push / ar pull / 批准后推送 / 项目配置 push / projects show 的 remote。
// 远程一律是临时目录里的裸仓库，绝不连真实 GitHub；公共目录（AGENT_ROUTER_HOME）、git 全局配置都在临时目录里。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const pushSource = fileURLToPath(new URL('../../core/lib/push.mjs', import.meta.url));

// 整个测试进程的 git 全局配置：隔离到临时目录（提交身份、默认分支名在这里）。进程内直接调用 push.mjs 的用例用的也是它。
const shared = mkdtempSync(path.join(os.tmpdir(), 'ar 推送全局 '));
const gitconfig = path.join(shared, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = 推送测试\n\temail = push@example.test\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n[protocol "file"]\n\tallow = always\n');
process.env.GIT_CONFIG_GLOBAL = gitconfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const key of ['CLAUDECODE', 'AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AGENT_ROUTER_HOME', 'CODEX_DISPATCH_HOME']) delete process.env[key];
after(() => rmSync(shared, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, 'utf8'); };
const commitFile = (dir, rel, text, message = `改 ${rel}`) => { write(path.join(dir, rel), text); git(dir, ['add', '--', rel]); git(dir, ['commit', '-q', '-m', message]); };
const readLines = file => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

// 主工作区的字节指纹（除 .git 与 .agent-runs）。
function treeHash(root) {
  const hash = createHash('sha256');
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (dir === root && (entry.name === '.git' || entry.name === '.agent-runs')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(`${path.relative(root, full)}\0`).update(readFileSync(full)).update('\0');
    }
  };
  walk(root);
  return hash.digest('hex');
}

function fixture(t, { project = {} } = {}) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 推送 '));
  const remote = path.join(base, 'remote.git');
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  const wtRoot = path.join(base, 'wt 根');
  mkdirSync(repo);
  mkdirSync(home);
  git(base, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(repo, ['init', '-q', '-b', 'main']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true, ...project }, null, 2));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', 'origin', 'main']);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: wtRoot, AR_NO_WATCH: '1' };
  const f = { base, remote, repo, home, wtRoot, env, since, count: 0, clones: 0 };
  f.ar = (args, { env: extra = {}, cwd = repo, timeout = 90000 } = {}) => {
    const run = spawnSync(process.execPath, [script, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout, windowsHide: true, shell: false });
    return { code: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', json: () => JSON.parse(run.stdout) };
  };
  // 另一个克隆（模拟别人推了提交）。
  f.clone = () => {
    const dir = path.join(base, `别人的克隆 ${++f.clones}`);
    git(base, ['clone', '-q', remote, dir]);
    return dir;
  };
  f.remoteHead = () => git(remote, ['rev-parse', 'refs/heads/main']);
  f.rows = () => readLines(path.join(home, 'push.jsonl'));
  f.setProfile = value => writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
    profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...value } },
  }));
  f.setProfile({});
  f.config = () => JSON.parse(readFileSync(path.join(repo, '.agent-router/project.json'), 'utf8'));
  f.runs = () => readLines(path.join(home, 'runs.jsonl'));
  // 派发一个会改 src/a.js 并提交的假任务，返回 { name, id, title }。
  f.task = name => {
    f.setProfile({ writes: [{ path: 'src/a.js', content: `改过 ${name}\n` }], commit: `假执行者：${name}` });
    f.count += 1;
    const title = `推送测试 ${name}`;
    const rel = `docs/specs/${String(900 + f.count)}-${name}.md`;
    write(path.join(repo, rel), ['---', `id: ${900 + f.count}`, `title: ${title}`, 'type: code', 'expect_commit: false', 'allowed_paths:', '  - src/**', '---', '', '测试说明正文。', ''].join('\n'));
    git(repo, ['add', '--', rel]);
    git(repo, ['commit', '-q', '-m', `任务说明 ${name}`]);
    const run = f.ar(['dispatch', rel, '--name', name, '--json']);
    assert.equal(run.code, 0, run.stderr + run.stdout);
    const start = f.runs().find(row => row.event === 'start' && row.name === name);
    assert.ok(start, `${name} 的 start`);
    return { name, id: start.id, title };
  };
  t.after(async () => {
    await cleanupProcesses(base, { recorded: recordedStarts(f.runs(), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 推送 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

// ---------- 地址：识别凭据、显示时去掉 ----------

test('1 地址：https 的 用户:密码@ 与 令牌@ 算带凭据；SSH 写法、普通地址、本地路径不算；显示时一律去掉用户名密码', () => {
  assert.equal(urlHasCredential('https://user:secret@example.invalid/x.git'), true);
  assert.equal(urlHasCredential('https://ghp_token@example.invalid/x.git'), true);
  assert.equal(urlHasCredential('http://u@example.invalid/x.git'), true);
  assert.equal(urlHasCredential('ssh://u:pw@example.invalid/x.git'), true);
  assert.equal(urlHasCredential('git@github.com:o/r.git'), false);
  assert.equal(urlHasCredential('ssh://git@github.com/o/r.git'), false);
  assert.equal(urlHasCredential('https://github.com/o/r.git'), false);
  assert.equal(urlHasCredential('C:\\work\\remote.git'), false);
  assert.equal(urlHasCredential('/tmp/remote.git'), false);
  assert.equal(urlHasCredential('file:///tmp/remote.git'), false);
  assert.equal(displayUrl('https://user:secret@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(displayUrl('https://token@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(displayUrl('ssh://git@github.com/o/r.git'), 'ssh://github.com/o/r.git');
  assert.equal(displayUrl('git@github.com:o/r.git'), 'github.com:o/r.git');
  assert.equal(displayUrl('https://github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(displayUrl('C:\\work\\remote.git'), 'C:\\work\\remote.git');
  assert.equal(scrubUrls("fatal: unable to access 'https://user:secret@example.invalid/x.git/': Could not resolve host"), "fatal: unable to access 'https://example.invalid/x.git/': Could not resolve host");
});

// ---------- --dry-run ----------

test('2 --dry-run：领先 2 → ahead；返回字段齐全，地址是显示用的；不写 push.jsonl', t => {
  const f = fixture(t);
  commitFile(f.repo, 'src/a.js', '一\n');
  commitFile(f.repo, 'src/a.js', '二\n');
  const run = f.ar(['push', f.repo, '--dry-run', '--json']);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  const value = run.json();
  assert.deepEqual(Object.keys(value).sort(), ['ahead', 'behind', 'branch', 'lastPush', 'ok', 'remote', 'state', 'url']);
  assert.deepEqual({ ok: value.ok, remote: value.remote, branch: value.branch, ahead: value.ahead, behind: value.behind, state: value.state, lastPush: value.lastPush }, { ok: true, remote: 'origin', branch: 'main', ahead: 2, behind: 0, state: 'ahead', lastPush: null });
  assert.ok(value.url.endsWith('remote.git'));
  assert.equal(f.remoteHead(), git(f.repo, ['rev-parse', 'origin/main']), '远程没有被推送');
  assert.deepEqual(f.rows(), [], '--dry-run 不写 push.jsonl');
  // 文字输出给人看。
  const text = f.ar(['push', f.repo, '--dry-run']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /main 领先 2 个提交/);
});

test('3 --dry-run：一样 → same；别人推了 1 个提交 → behind: 1；两边各有新提交 → diverged', t => {
  const f = fixture(t);
  assert.equal(f.ar(['push', f.repo, '--dry-run', '--json']).json().state, 'same');
  const other = f.clone();
  commitFile(other, 'src/b.js', '别人\n');
  git(other, ['push', '-q', 'origin', 'main']);
  const behind = f.ar(['push', f.repo, '--dry-run', '--json']).json();
  assert.deepEqual({ ahead: behind.ahead, behind: behind.behind, state: behind.state }, { ahead: 0, behind: 1, state: 'behind' });
  commitFile(f.repo, 'src/c.js', '我的\n');
  const diverged = f.ar(['push', f.repo, '--dry-run', '--json']).json();
  assert.deepEqual({ ahead: diverged.ahead, behind: diverged.behind, state: diverged.state }, { ahead: 1, behind: 1, state: 'diverged' });
});

test('4 --dry-run：远程没有这个分支 → noUpstream（领先 = 本机全部提交）；fetch 失败如实返回 FETCH_FAILED，--no-fetch 不访问远程', t => {
  const f = fixture(t);
  const empty = path.join(f.base, 'empty.git');
  git(f.base, ['init', '-q', '--bare', '-b', 'main', empty]);
  git(f.repo, ['remote', 'add', 'second', empty]);
  assert.equal(f.ar(['projects', 'config', f.repo, 'push.remote=second', '--json']).code, 0);
  const none = f.ar(['push', f.repo, '--dry-run', '--json']).json();
  assert.deepEqual({ remote: none.remote, ahead: none.ahead, behind: none.behind, state: none.state }, { remote: 'second', ahead: 1, behind: 0, state: 'noUpstream' });

  // 回到 origin，把它的地址改成不存在的路径：有 fetch 时失败，--no-fetch 时只读本地已有的跟踪分支。
  assert.equal(f.ar(['projects', 'config', f.repo, 'push.remote=', '--json']).code, 0);
  commitFile(f.repo, 'src/a.js', '领先\n');
  git(f.repo, ['remote', 'set-url', 'origin', path.join(f.base, '不存在.git')]);
  const failed = f.ar(['push', f.repo, '--dry-run', '--json']);
  assert.equal(failed.code, 2);
  const failure = failed.json();
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'FETCH_FAILED');
  assert.match(failure.error, /取远程状态失败/);
  const local = f.ar(['push', f.repo, '--dry-run', '--no-fetch', '--json']);
  assert.equal(local.code, 0, local.stderr + local.stdout);
  assert.deepEqual({ ahead: local.json().ahead, behind: local.json().behind, state: local.json().state }, { ahead: 1, behind: 0, state: 'ahead' });
});

// ---------- 推送 ----------

test('5 推送：领先时成功，远程出现提交；push.jsonl 多一行且不含地址；再推一次 pushed: false 不再写记录；lastPush 是这次的时间', t => {
  const f = fixture(t);
  commitFile(f.repo, 'src/a.js', '一\n');
  commitFile(f.repo, 'src/a.js', '二\n');
  const before = git(f.repo, ['rev-parse', 'origin/main']);
  const head = git(f.repo, ['rev-parse', 'HEAD']);
  const run = f.ar(['push', f.repo, '--json']);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  const value = run.json();
  assert.deepEqual({ ok: value.ok, pushed: value.pushed, from: value.from, to: value.to, remote: value.remote, branch: value.branch }, { ok: true, pushed: true, from: before, to: head, remote: 'origin', branch: 'main' });
  assert.equal(f.remoteHead(), head);
  const rows = f.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'branch', 'by', 'from', 'ok', 'op', 'project', 'remote', 'to', 'v']);
  assert.deepEqual({ v: rows[0].v, op: rows[0].op, branch: rows[0].branch, remote: rows[0].remote, from: rows[0].from, to: rows[0].to, ok: rows[0].ok, by: rows[0].by }, { v: 1, op: 'push', branch: 'main', remote: 'origin', from: before, to: head, ok: true, by: 'cli' });
  assert.ok(Number.isFinite(rows[0].at));
  const logText = readFileSync(path.join(f.home, 'push.jsonl'), 'utf8');
  assert.ok(!logText.includes('remote.git') && !logText.includes(f.base), 'push.jsonl 不记地址');
  assert.ok(!existsSync(path.join(f.repo, 'push.jsonl')) && !existsSync(path.join(f.repo, '.agent-router', 'push.jsonl')), '不写进项目目录');

  assert.equal(f.ar(['push', f.repo, '--dry-run', '--json']).json().lastPush, rows[0].at);
  const again = f.ar(['push', f.repo, '--json']).json();
  assert.deepEqual({ ok: again.ok, pushed: again.pushed }, { ok: true, pushed: false });
  assert.equal(f.rows().length, 1, '没有推送任何东西时不写记录');
  assert.match(f.ar(['push', f.repo]).stdout, /一样/);
});

test('6 推送：落后或分叉时拒绝（BEHIND），本机和远程都不变，记一行失败', t => {
  const f = fixture(t);
  const other = f.clone();
  commitFile(other, 'src/b.js', '别人\n');
  git(other, ['push', '-q', 'origin', 'main']);
  const remoteBefore = f.remoteHead();
  const localBefore = git(f.repo, ['rev-parse', 'HEAD']);
  const tree = treeHash(f.repo);
  const behind = f.ar(['push', f.repo, '--json']);
  assert.equal(behind.code, 2);
  assert.deepEqual({ ok: behind.json().ok, code: behind.json().code }, { ok: false, code: 'BEHIND' });
  assert.match(behind.json().error, /先拉取/);
  assert.equal(f.remoteHead(), remoteBefore);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), localBefore);
  assert.equal(treeHash(f.repo), tree);

  commitFile(f.repo, 'src/c.js', '我的\n');
  const diverged = f.ar(['push', f.repo, '--json']);
  assert.equal(diverged.code, 2);
  assert.equal(diverged.json().code, 'BEHIND');
  assert.match(diverged.json().error, /合并或 rebase/);
  assert.equal(f.remoteHead(), remoteBefore, '分叉时也没有推送');
  const rows = f.rows();
  assert.deepEqual(rows.map(row => [row.op, row.ok, row.code]), [['push', false, 'BEHIND'], ['push', false, 'BEHIND']]);
});

// ---------- 拒绝情况 ----------

test('7 拒绝：没有远程 → NO_REMOTE；地址带凭据 → CREDENTIAL_IN_URL，输出里没有密码 / 令牌，也不写记录；拉取同样拒绝', t => {
  const f = fixture(t);
  git(f.repo, ['remote', 'set-url', 'origin', 'https://user:secret@example.invalid/x.git']);
  for (const args of [['push', f.repo, '--json'], ['push', f.repo, '--dry-run', '--json'], ['pull', f.repo, '--json'], ['push', f.repo]]) {
    const run = f.ar(args);
    assert.equal(run.code, 2, args.join(' '));
    assert.ok(!(run.stdout + run.stderr).includes('secret'), `${args.join(' ')} 的输出不含密码`);
    if (args.includes('--json')) assert.equal(run.json().code, 'CREDENTIAL_IN_URL');
    else assert.match(run.stderr, /凭据助手/);
  }
  git(f.repo, ['remote', 'set-url', 'origin', 'https://ghp_tokenvalue@example.invalid/x.git']);
  const token = f.ar(['push', f.repo, '--json']);
  assert.equal(token.json().code, 'CREDENTIAL_IN_URL');
  assert.ok(!(token.stdout + token.stderr).includes('tokenvalue'));
  assert.deepEqual(f.rows(), [], '拒绝发生在联网之前，不写记录');

  git(f.repo, ['remote', 'remove', 'origin']);
  for (const args of [['push', f.repo, '--json'], ['pull', f.repo, '--json']]) {
    const run = f.ar(args);
    assert.equal(run.code, 2);
    assert.equal(run.json().code, 'NO_REMOTE');
  }
});

test('8 主导推送：--by lead（或环境里 CLAUDECODE=1）在 allowLead 未开时 LEAD_NOT_ALLOWED；开了以后成功；human / cli 不受限制', t => {
  const f = fixture(t);
  commitFile(f.repo, 'src/a.js', '一\n');
  const denied = f.ar(['push', f.repo, '--by', 'lead', '--json']);
  assert.equal(denied.code, 2);
  assert.equal(denied.json().code, 'LEAD_NOT_ALLOWED');
  assert.match(denied.json().error, /没有开启允许主导推送/);
  assert.equal(f.ar(['push', f.repo, '--dry-run', '--by', 'lead', '--json']).json().code, 'LEAD_NOT_ALLOWED', '--dry-run 也受限制');
  assert.equal(f.ar(['pull', f.repo, '--by', 'lead', '--json']).json().code, 'LEAD_NOT_ALLOWED', '拉取同样受限制');
  assert.equal(f.ar(['push', f.repo, '--json'], { env: { CLAUDECODE: '1' } }).json().code, 'LEAD_NOT_ALLOWED', '没写 --by 时按环境判断主导');
  assert.notEqual(f.remoteHead(), git(f.repo, ['rev-parse', 'HEAD']));
  assert.deepEqual(f.rows(), []);

  assert.equal(f.ar(['projects', 'config', f.repo, 'push.allowLead=true', '--json']).code, 0);
  const allowed = f.ar(['push', f.repo, '--by', 'lead', '--json']);
  assert.equal(allowed.code, 0, allowed.stderr + allowed.stdout);
  assert.equal(allowed.json().pushed, true);
  assert.equal(f.remoteHead(), git(f.repo, ['rev-parse', 'HEAD']));
  assert.equal(f.rows().at(-1).by, 'lead');

  assert.equal(f.ar(['projects', 'config', f.repo, 'push.allowLead=false', '--json']).code, 0);
  commitFile(f.repo, 'src/a.js', '二\n');
  assert.equal(f.ar(['push', f.repo, '--by', 'human', '--json']).json().pushed, true, 'human 不受限制');
  assert.equal(f.rows().at(-1).by, 'human');
  commitFile(f.repo, 'src/a.js', '三\n');
  assert.equal(f.ar(['push', f.repo, '--by', 'cli', '--json']).json().pushed, true, 'cli 不受限制');
});

test('9 参数错误给用法：缺项目路径、多余参数、--by 取值不对', t => {
  const f = fixture(t);
  for (const args of [['push'], ['pull'], ['push', f.repo, '--bogus'], ['pull', f.repo, '--dry-run'], ['push', f.repo, '--by'], ['push', f.repo, '--by', 'root'], ['push', f.repo, '另一个']]) {
    const run = f.ar([...args, '--json']);
    assert.equal(run.code, 2, args.join(' '));
    assert.match(run.json().error, /^用法：ar (push|pull) /, args.join(' '));
  }
  // 没初始化的项目。
  const bare = path.join(f.base, '没初始化');
  mkdirSync(bare);
  git(bare, ['init', '-q', '-b', 'main']);
  const notInit = f.ar(['push', bare, '--json']);
  assert.equal(notInit.code, 2);
  assert.equal(notInit.json().code, 'NOT_INITIALIZED');
});

// ---------- 不卡住 ----------

test('10 不交互：联网 git 的子进程环境带 GIT_TERMINAL_PROMPT=0、GCM_INTERACTIVE=never、超时 120 秒与 D33 代理变量；连不上的地址在超时内失败', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: 'x\n', exit: 0 } }, proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' } }));
  const calls = [];
  const spy = (root, args, options) => { calls.push({ args, options }); return runNetworkGit(root, args, options); };
  commitFile(f.repo, 'src/a.js', '一\n');
  const pushed = pushBranch({ root: f.repo, home: f.home, exec: spy });
  assert.equal(pushed.ok, true, JSON.stringify(pushed));
  assert.deepEqual(calls.map(call => call.args[0]), ['fetch', 'push']);
  for (const { options } of calls) {
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(options.env.GCM_INTERACTIVE, 'never');
    assert.equal(options.timeout, 120000);
    assert.match(options.env.HTTPS_PROXY, /^http:\/\/127\.0\.0\.1:7890/);
  }
  assert.deepEqual(calls[0].args, ['fetch', '--no-tags', 'origin', 'main']);
  assert.deepEqual(calls[1].args, ['push', '--no-follow-tags', 'origin', 'refs/heads/main:refs/heads/main']);
  calls.length = 0;
  commitFile(f.repo, 'src/a.js', '二\n');
  assert.equal(pullBranch({ root: f.repo, home: f.home, exec: spy }).code, 'AHEAD');
  assert.deepEqual(calls.map(call => call.args[0]), ['fetch'], '拉取只 fetch，不 push');
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');

  // 立即连接失败的地址：超时内返回失败，原因归为网络。
  rmSync(path.join(f.home, 'config.json'));
  git(f.repo, ['remote', 'set-url', 'origin', 'https://127.0.0.1:9/x.git']);
  const started = Date.now();
  const run = f.ar(['push', f.repo, '--json'], { env: { NO_PROXY: '*' } });
  assert.equal(run.code, 2, run.stderr + run.stdout);
  const failure = run.json();
  assert.deepEqual({ ok: failure.ok, code: failure.code, cause: failure.cause }, { ok: false, code: 'FETCH_FAILED', cause: 'NETWORK' });
  assert.ok(Date.now() - started < 100000, '没有卡住');
  assert.equal(f.rows().at(-1).ok, false);
});

test('11 失败原因归类：认证失败 → NO_CREDENTIAL（给出登录办法）、网络 → NETWORK、其他原样转述最后几行；报错里的地址去掉用户信息', t => {
  const f = fixture(t);
  commitFile(f.repo, 'src/a.js', '一\n');
  const failing = stderr => (root, args) => (args[0] === 'fetch' ? { status: 0, stdout: '', stderr: '', timedOut: false } : { status: 128, stdout: '', stderr, timedOut: false });
  const push = stderr => pushBranch({ root: f.repo, home: f.home, exec: failing(stderr) });
  for (const text of ['remote: Invalid username or password.\nfatal: Authentication failed for \'https://x/y.git/\'', 'fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.']) {
    const result = push(text);
    assert.equal(result.code, 'NO_CREDENTIAL', text);
    assert.match(result.error, /手动 git push 一次完成登录/);
  }
  assert.equal(push("fatal: unable to access 'https://user:secret@example.invalid/x.git/': Could not resolve host: example.invalid").code, 'NETWORK');
  assert.ok(!JSON.stringify(push("fatal: unable to access 'https://user:secret@example.invalid/x.git/': Could not resolve host: example.invalid")).includes('secret'));
  const other = push('一\n二\n三\n四\nerror: 某个奇怪的失败');
  assert.equal(other.code, 'PUSH_FAILED');
  assert.equal(other.error, '三；四；error: 某个奇怪的失败');
  const timeout = pushBranch({ root: f.repo, home: f.home, exec: () => ({ status: null, stdout: '', stderr: '', timedOut: true }) });
  assert.deepEqual({ code: timeout.code, cause: timeout.cause }, { code: 'FETCH_FAILED', cause: 'NETWORK' });
  // 以上每次失败都写了记录，只有 ok / code，没有 git 原始输出。
  const text = readFileSync(path.join(f.home, 'push.jsonl'), 'utf8');
  assert.ok(!text.includes('Authentication') && !text.includes('secret'));
});

// ---------- 拉取 ----------

test('12 拉取：远程领先时快进成功并写 pull 记录；一样 → pulled: false 不写记录', t => {
  const f = fixture(t);
  assert.deepEqual({ ok: f.ar(['pull', f.repo, '--json']).json().ok, pulled: f.ar(['pull', f.repo, '--json']).json().pulled }, { ok: true, pulled: false });
  assert.deepEqual(f.rows(), []);
  const other = f.clone();
  commitFile(other, 'src/b.js', '别人\n');
  git(other, ['push', '-q', 'origin', 'main']);
  const before = git(f.repo, ['rev-parse', 'HEAD']);
  const run = f.ar(['pull', f.repo, '--json']);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  const value = run.json();
  assert.deepEqual({ ok: value.ok, pulled: value.pulled, from: value.from, to: value.to }, { ok: true, pulled: true, from: before, to: f.remoteHead() });
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), f.remoteHead());
  assert.equal(readFileSync(path.join(f.repo, 'src/b.js'), 'utf8'), '别人\n');
  assert.deepEqual(f.rows().map(row => [row.op, row.ok, row.from, row.to]), [['pull', true, before, f.remoteHead()]]);
  assert.match(f.ar(['pull', f.repo]).stdout, /一样/);
});

test('13 拉取：分叉 → DIVERGED、本机领先 → AHEAD，都不拉取，本机字节级不变', t => {
  const f = fixture(t);
  commitFile(f.repo, 'src/a.js', '我的\n');
  const ahead = f.ar(['pull', f.repo, '--json']);
  assert.equal(ahead.code, 2);
  assert.equal(ahead.json().code, 'AHEAD');
  assert.match(ahead.json().error, /先推送/);
  const other = f.clone();
  commitFile(other, 'src/b.js', '别人\n');
  git(other, ['push', '-q', 'origin', 'main']);
  const snapshot = { head: git(f.repo, ['rev-parse', 'HEAD']), tree: treeHash(f.repo), status: git(f.repo, ['status', '--porcelain']) };
  const diverged = f.ar(['pull', f.repo, '--json']);
  assert.equal(diverged.code, 2);
  assert.equal(diverged.json().code, 'DIVERGED');
  assert.match(diverged.json().error, /本机和远程各有新提交，需要在终端里合并或 rebase/);
  assert.deepEqual({ head: git(f.repo, ['rev-parse', 'HEAD']), tree: treeHash(f.repo), status: git(f.repo, ['status', '--porcelain']) }, snapshot);
  assert.deepEqual(f.rows().map(row => [row.op, row.ok, row.code]), [['pull', false, 'AHEAD'], ['pull', false, 'DIVERGED']]);
});

test('14 拉取：远程改了本机未提交的同一文件时 git 拒绝、如实转述（WOULD_OVERWRITE）、本机不变；不在主分支上时 NOT_ON_BASE', t => {
  const f = fixture(t);
  const other = f.clone();
  commitFile(other, 'src/a.js', '远程改的\n');
  git(other, ['push', '-q', 'origin', 'main']);
  write(path.join(f.repo, 'src/a.js'), '本机未提交的改动\n');
  const snapshot = { head: git(f.repo, ['rev-parse', 'HEAD']), tree: treeHash(f.repo), status: git(f.repo, ['status', '--porcelain']) };
  const run = f.ar(['pull', f.repo, '--json']);
  assert.equal(run.code, 2);
  assert.equal(run.json().code, 'WOULD_OVERWRITE');
  assert.match(run.json().error, /overwritten/);
  assert.deepEqual({ head: git(f.repo, ['rev-parse', 'HEAD']), tree: treeHash(f.repo), status: git(f.repo, ['status', '--porcelain']) }, snapshot);
  assert.equal(readFileSync(path.join(f.repo, 'src/a.js'), 'utf8'), '本机未提交的改动\n');

  git(f.repo, ['checkout', '-q', '--', 'src/a.js']);
  git(f.repo, ['switch', '-q', '-c', 'feature']);
  const off = f.ar(['pull', f.repo, '--json']);
  assert.equal(off.code, 2);
  assert.equal(off.json().code, 'NOT_ON_BASE');
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), snapshot.head);
});

test('15 拉取：allowLead 规则同推送', t => {
  const f = fixture(t);
  const other = f.clone();
  commitFile(other, 'src/b.js', '别人\n');
  git(other, ['push', '-q', 'origin', 'main']);
  const head = git(f.repo, ['rev-parse', 'HEAD']);
  assert.equal(f.ar(['pull', f.repo, '--by', 'lead', '--json']).json().code, 'LEAD_NOT_ALLOWED');
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), head);
  assert.equal(f.ar(['projects', 'config', f.repo, 'push.allowLead=true', '--json']).code, 0);
  assert.equal(f.ar(['pull', f.repo, '--by', 'lead', '--json']).json().pulled, true);
  assert.equal(f.rows().at(-1).by, 'lead');
});

// ---------- 批准后推送 ----------

test('16 批准后推送：afterAccept 为 true 时合并后远程出现合并提交，JSON 有 push.ok，记录多一条 push 事件，accepted 事件字段不变', t => {
  const f = fixture(t, { project: { push: { afterAccept: true } } });
  const task = f.task('合并后推送');
  const run = f.ar(['accept', task.name, '--json']);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  const value = run.json();
  assert.deepEqual(Object.keys(value), ['ok', 'merge', 'mode', 'cleanup', 'push']);
  assert.deepEqual(value.push, { ok: true, pushed: true });
  assert.equal(f.remoteHead(), value.merge, '远程出现合并提交');
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), value.merge);
  const events = f.runs().filter(row => row.id === task.id);
  const accepted = events.find(row => row.event === 'accepted');
  assert.deepEqual(Object.keys(accepted).sort(), ['at', 'by', 'event', 'id', 'merge', 'mode', 'v']);
  const pushEvent = events.find(row => row.event === 'push');
  assert.deepEqual(Object.keys(pushEvent).sort(), ['at', 'by', 'event', 'id', 'ok', 'v']);
  assert.deepEqual({ v: pushEvent.v, id: pushEvent.id, ok: pushEvent.ok, by: pushEvent.by }, { v: 1, id: task.id, ok: true, by: 'cli' });
  assert.ok(Number.isFinite(pushEvent.at));
  assert.ok(events.indexOf(pushEvent) > events.indexOf(accepted));
  assert.equal(f.rows().at(-1).ok, true);
});

test('17 批准后推送：远程不可达时合并照样成功（退出码 0、主分支有合并提交），push.ok 为 false，事件带 code', t => {
  const f = fixture(t, { project: { push: { afterAccept: true } } });
  const task = f.task('推送失败');
  git(f.repo, ['remote', 'set-url', 'origin', path.join(f.base, '不存在.git')]);
  const remoteBefore = f.remoteHead();
  const run = f.ar(['accept', task.name, '--json']);
  assert.equal(run.code, 0, run.stderr + run.stdout);
  const value = run.json();
  assert.equal(value.ok, true);
  assert.equal(value.push.ok, false);
  assert.equal(value.push.code, 'FETCH_FAILED');
  assert.equal(typeof value.push.error, 'string');
  assert.equal(git(f.repo, ['log', '-1', '--format=%s']), `[执行] 合并 ${task.name}：${task.title}`);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), value.merge);
  assert.equal(f.remoteHead(), remoteBefore);
  const pushEvent = f.runs().find(row => row.id === task.id && row.event === 'push');
  assert.deepEqual({ ok: pushEvent.ok, code: pushEvent.code, by: pushEvent.by }, { ok: false, code: 'FETCH_FAILED', by: 'cli' });
  // 文字输出：写明"已合并，推送失败"。
  const task2 = f.task('推送失败文字');
  const text = f.ar(['accept', task2.name]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /已合并，推送失败：/);
});

test('18 批准后推送：--no-push 覆盖配置；没配置也没传 --push 时 JSON 没有 push 键；--push 在没配置时也推送；--push 与 --no-push 同时给是用法错误', t => {
  const f = fixture(t, { project: { push: { afterAccept: true } } });
  const first = f.task('不推送');
  const remoteBefore = f.remoteHead();
  const skipped = f.ar(['accept', first.name, '--no-push', '--json']);
  assert.equal(skipped.code, 0, skipped.stderr + skipped.stdout);
  assert.deepEqual(Object.keys(skipped.json()), ['ok', 'merge', 'mode', 'cleanup']);
  assert.equal(f.remoteHead(), remoteBefore);
  assert.ok(!f.runs().some(row => row.id === first.id && row.event === 'push'));
  assert.deepEqual(f.rows(), []);

  assert.equal(f.ar(['projects', 'config', f.repo, 'push.afterAccept=', '--json']).code, 0);
  assert.equal(f.config().push, undefined);
  git(f.repo, ['commit', '-q', '-am', '提交配置']);
  const second = f.task('没配置');
  const plain = f.ar(['accept', second.name, '--json']);
  assert.deepEqual(Object.keys(plain.json()), ['ok', 'merge', 'mode', 'cleanup'], '没推送时与以前逐字相同');
  assert.equal(f.remoteHead(), remoteBefore);

  const third = f.task('显式推送');
  const forced = f.ar(['accept', third.name, '--push', '--json']);
  assert.equal(forced.code, 0, forced.stderr + forced.stdout);
  assert.deepEqual(forced.json().push, { ok: true, pushed: true });
  assert.equal(f.remoteHead(), forced.json().merge);

  const fourth = f.task('参数冲突');
  const both = f.ar(['accept', fourth.name, '--push', '--no-push', '--json']);
  assert.equal(both.code, 2);
  assert.match(both.json().error, /^用法：ar accept/);
});

test('19 批准后推送：主导（CLAUDECODE=1）在 allowLead 未开时不推送但合并成功；--by human 不受限制', t => {
  const f = fixture(t, { project: { push: { afterAccept: true } } });
  const first = f.task('主导批准');
  const lead = f.ar(['accept', first.name, '--json'], { env: { CLAUDECODE: '1' } });
  assert.equal(lead.code, 0, lead.stderr + lead.stdout);
  assert.equal(lead.json().ok, true);
  assert.equal(lead.json().push.ok, false);
  assert.equal(lead.json().push.code, 'LEAD_NOT_ALLOWED');
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), lead.json().merge);
  assert.notEqual(f.remoteHead(), lead.json().merge);
  const second = f.task('人批准');
  const human = f.ar(['accept', second.name, '--by', 'human', '--json'], { env: { CLAUDECODE: '1' } });
  assert.deepEqual(human.json().push, { ok: true, pushed: true });
  assert.equal(f.remoteHead(), human.json().merge);
  assert.equal(f.runs().filter(row => row.event === 'push').at(-1).by, 'human');
});

// ---------- 源码扫描 ----------

test('20 源码扫描：push.mjs 里没有强制推送、推标签、镜像、删除远程分支的字样', () => {
  const source = readFileSync(pushSource, 'utf8');
  for (const word of ['--force', '-f ', '--tags', '--mirror', '--delete', '+refs/']) assert.ok(!source.includes(word), `push.mjs 不应出现 ${word}`);
  assert.ok(!/['"`]\+/.test(source), '没有以 + 开头的 refspec 字符串');
  assert.ok(!/\bforce\b/i.test(source), '没有 force 字样');
  // 推送与拉取只用这几种 git 子命令。
  const verbs = [...source.matchAll(/(?:exec\([^,]+,|git\([^,]+,) \[('[a-z-]+')/g)].map(match => match[1]);
  assert.ok(verbs.length > 0);
  assert.ok(verbs.every(verb => ["'fetch'", "'push'", "'merge'", "'rev-parse'", "'rev-list'", "'remote'", "'symbolic-ref'", "'check-ref-format'"].includes(verb)), verbs.join(','));
});

// ---------- 项目配置与 projects show ----------

test('21 projects config：push.remote / push.afterAccept / push.allowLead 的合法值写入 push 对象，留空删除，删光后 push 消失；126 的键不受影响', t => {
  const f = fixture(t);
  const set = (...pairs) => f.ar(['projects', 'config', f.repo, ...pairs, '--json']);
  git(f.repo, ['remote', 'add', 'upstream', f.remote]);
  const run = set('push.remote=upstream', 'push.afterAccept=true', 'push.allowLead=false');
  assert.equal(run.code, 0, run.stderr + run.stdout);
  assert.deepEqual(run.json().config.push, { remote: 'upstream', afterAccept: true, allowLead: false });
  assert.deepEqual(f.config().push, { remote: 'upstream', afterAccept: true, allowLead: false });
  assert.equal(f.config().baseBranch, 'main', '其他键不变');
  assert.equal(set('push.remote=origin/dev').code, 0, '带斜杠的远程名也是合法的');
  assert.equal(f.config().push.remote, 'origin/dev');
  assert.equal(set('push.remote=', 'push.afterAccept=').code, 0);
  assert.deepEqual(f.config().push, { allowLead: false });
  assert.equal(set('push.allowLead=').code, 0);
  assert.equal(f.config().push, undefined, '三个键都删掉后 push 对象消失');
  assert.equal(set('push.allowLead=').code, 0, '删不存在的键不报错');
  assert.equal(set('baseBranch=main', 'push.allowLead=true').code, 0, '和已有键一起写');
  assert.equal(f.config().push.allowLead, true);
});

test('22 projects config：非法值（push.afterAccept=yes、push.remote=-x、push.remote=a b、push.allowLead=1）报错且文件不变；未知键仍然拒绝', t => {
  const f = fixture(t);
  const file = path.join(f.repo, '.agent-router/project.json');
  const before = readFileSync(file, 'utf8');
  for (const pair of ['push.afterAccept=yes', 'push.remote=-x', 'push.remote=a b', 'push.allowLead=1', 'push.allowLead=TRUE', 'push.remote=a..b', 'push.other=1', 'push=1']) {
    const run = f.ar(['projects', 'config', f.repo, pair, '--json']);
    assert.equal(run.code, 2, pair);
    assert.equal(run.json().ok, false, pair);
    assert.equal(readFileSync(file, 'utf8'), before, `${pair} 不改文件`);
  }
  // 一组里有一个非法就整组不写。
  const mixed = f.ar(['projects', 'config', f.repo, 'push.allowLead=true', 'push.afterAccept=yes', '--json']);
  assert.equal(mixed.code, 2);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(f.ar(['projects', 'config', f.repo, 'unknown=1', '--json']).code, 2);
});

test('23 projects show --json 的 remote 字段：有远程（地址去掉用户名密码、只读本地跟踪分支、不联网）与没有远程两种', t => {
  const f = fixture(t);
  assert.equal(f.ar(['projects', 'add', f.repo, '--json']).code, 0);
  const show = () => f.ar(['projects', 'show', f.repo, '--json']);
  const first = show();
  assert.equal(first.code, 0, first.stderr);
  const remote = first.json().project.remote;
  assert.deepEqual(Object.keys(remote).sort(), ['ahead', 'behind', 'exists', 'name', 'state', 'url']);
  assert.deepEqual({ name: remote.name, exists: remote.exists, ahead: remote.ahead, behind: remote.behind, state: remote.state }, { name: 'origin', exists: true, ahead: 0, behind: 0, state: 'same' });
  assert.ok(remote.url.endsWith('remote.git'));
  commitFile(f.repo, 'src/a.js', '领先\n');
  // 地址不可达也能返回（不联网）；带凭据的地址显示时去掉，并标出不能推送。
  git(f.repo, ['remote', 'set-url', 'origin', 'https://user:secret@example.invalid/x.git']);
  const second = show();
  assert.ok(!second.stdout.includes('secret'));
  assert.deepEqual(second.json().project.remote, { name: 'origin', url: 'https://example.invalid/x.git', exists: true, ahead: 1, behind: 0, state: 'ahead', credentialInUrl: true });
  git(f.repo, ['remote', 'set-url', 'origin', f.remote]);
  assert.deepEqual({ ahead: show().json().project.remote.ahead, state: show().json().project.remote.state }, { ahead: 1, state: 'ahead' });
  assert.match(f.ar(['projects', 'show', f.repo]).stdout, /远程：origin（.*remote\.git），领先 1 个提交/);
  git(f.repo, ['remote', 'remove', 'origin']);
  assert.deepEqual(show().json().project.remote, { name: 'origin', exists: false });
  assert.match(f.ar(['projects', 'show', f.repo]).stdout, /远程：没有/);
});

test('24 GH007：远程拒绝并输出邮箱隐私那一行 → EMAIL_PRIVACY，带要推送的提交的作者邮箱；不改提交、不改写历史；其他拒绝照旧', t => {
  const f = fixture(t);
  const hook = path.join(f.remote, 'hooks', 'pre-receive');
  write(hook, '#!/bin/sh\necho "remote: error: GH007: Your push would publish a private email address." >&2\nexit 1\n');
  try { chmodSync(hook, 0o755); } catch { /* Windows 上没有执行位，Git for Windows 用自带的 sh 跑。 */ }
  git(f.repo, ['config', 'user.email', 'private@example.test']);
  commitFile(f.repo, 'src/a.js', '一\n');
  commitFile(f.repo, 'src/a.js', '二\n');
  const before = git(f.repo, ['rev-parse', 'HEAD']);
  const remoteBefore = f.remoteHead();
  const run = f.ar(['push', f.repo, '--json']);
  // 钩子没跑起来（没有 sh）时远程会正常接收：在这里说明并跳过。
  if (f.remoteHead() !== remoteBefore) { t.skip('本机跑不了 pre-receive 钩子（需要 sh）'); return; }
  const result = run.json();
  assert.equal(run.code, 2, run.stdout + run.stderr);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMAIL_PRIVACY');
  assert.equal(result.email, 'private@example.test', '要推送的提交的作者邮箱');
  assert.match(result.error, /GitHub 拒绝了这次推送：账号开了邮箱隐私保护，提交用的邮箱是 private@example\.test；把提交身份的邮箱换成 GitHub 的 noreply 地址后重新提交、推送/);
  assert.equal(git(f.repo, ['rev-parse', 'HEAD']), before, '不改已有提交');
  assert.equal(f.rows().at(-1).code, 'EMAIL_PRIVACY');
  assert.ok(!JSON.stringify(f.rows()).includes('private@example.test'), 'push.jsonl 不记邮箱');
  const text = f.ar(['push', f.repo]);
  assert.match(text.stderr + text.stdout, /GitHub 拒绝了这次推送/);
  // 其他拒绝照旧：同一个钩子换成别的输出 → PUSH_FAILED。
  write(hook, '#!/bin/sh\necho "remote: error: 别的原因" >&2\nexit 1\n');
  assert.equal(f.ar(['push', f.repo, '--json']).json().code, 'PUSH_FAILED');
  // 注入执行函数：远程没有这个分支时取分支最近的提交的邮箱。
  const empty = path.join(f.base, 'empty.git');
  git(f.base, ['init', '-q', '--bare', '-b', 'main', empty]);
  git(f.repo, ['remote', 'set-url', 'origin', empty]);
  const injected = pushBranch({ root: f.repo, home: f.home, exec: (root, args) => (args[0] === 'push' ? { status: 1, stdout: '', stderr: 'remote: error: GH007: Your push would publish a private email address.', timedOut: false } : runNetworkGit(root, args, { env: process.env })) });
  assert.deepEqual({ code: injected.code, email: injected.email }, { code: 'EMAIL_PRIVACY', email: 'private@example.test' });
});