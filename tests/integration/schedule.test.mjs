import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';
import { pidAlive } from '../../core/lib/process.mjs';

// 并行调度（Stage07c 140）端到端：改动范围重叠时排队、独占命令、并发"自动"档。
// 每个用例在系统临时目录里建真实 git 仓库；AGENT_ROUTER_HOME、AR_WORKTREE_ROOT 都指向用例自己的临时目录，执行者是 fake。
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

function specText({ allowed, verify = [] }) {
  const lines = ['---', 'id: 900', 'title: 并行调度测试', 'type: code', 'expect_commit: true', 'max_retries: 0'];
  lines.push('allowed_paths:');
  for (const item of allowed) lines.push(`  - ${item}`);
  if (verify.length) {
    lines.push('verify:');
    for (const line of verify) lines.push(`  - ${line}`);
  }
  lines.push('---', '', '测试说明正文。', '');
  return lines.join('\n');
}

function fixture(t, { project = {}, config = {} } = {}) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-schedule-it-'));
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'wt'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_TEST_LOAD_FILE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '并行调度测试']);
  git(repo, ['config', 'user.email', 'schedule-it@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
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
  const f = { base, repo, home, env, profile, since };
  // 执行者配置在派发时取快照：改了再派发的任务才用新配置。
  f.setProfile = (value, replace = false) => {
    if (replace) for (const key of Object.keys(profile)) delete profile[key];
    Object.assign(profile, replace ? { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 } : {}, value);
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
  f.release = file => writeFileSync(file, 'go');
  f.slotFiles = () => { try { return readdirSync(path.join(home, 'slots')); } catch { return []; } };
  t.after(async () => {
    // 先放行所有等放行文件的假执行者与慢验收，再按身份结束本用例清单里记录的进程，绝不按进程名终止。
    for (const file of [path.join(base, 'go-a.flag'), path.join(base, 'gate-go.flag')]) writeFileSync(file, 'go');
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-schedule-it-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('1 改动范围重叠：B 排队等 A，C 不重叠直接运行；A 结束（待验收不挡人）后 B 用新基线开始，门禁基线是等待期间前进后的主分支', async t => {
  const f = fixture(t);
  const goA = path.join(f.base, 'go-a.flag');
  const specA = f.spec('docs/specs/A.md', { allowed: ['src/**'] });
  const specB = f.spec('docs/specs/B.md', { allowed: ['src/a.js'] });
  const specC = f.spec('docs/specs/C.md', { allowed: ['docs/**'] });

  // A：改 src/a.js 并提交，等放行文件。
  f.setProfile({ releaseFile: goA, releaseTimeoutMs: 120000, writes: [{ path: 'src/a.js', content: 'A 的改动\n' }], commit: '假执行者：A' });
  const a = await f.dispatch(specA, '甲');
  await until(() => f.has(a, 'spawned'), 'A 启动执行者');

  // B：改 src/a.js（在 A 的改动之上），不等任何文件。
  f.setProfile({ releaseFile: null, writes: [{ path: 'src/a.js', content: 'B 的改动\n' }], commit: '假执行者：B' }, true);
  const b = await f.dispatch(specB, '乙');
  const queued = await until(() => f.events(b).find(row => row.event === 'queued'), 'B 排队');
  assert.equal(queued.reason, 'overlap');
  assert.deepEqual(queued.blockers, [{ id: a, name: '甲', paths: ['src/**'] }]);
  assert.match(f.progress('乙'), /排队：与 甲 的改动范围重叠（src\/\*\*），等它结束/);

  // C：docs/** 不重叠，直接运行到待验收。
  f.setProfile({ writes: [{ path: 'docs/readme.md', content: 'C 的改动\n' }], commit: '假执行者：C' }, true);
  const c = await f.dispatch(specC, '丙');
  await until(() => f.has(c, 'end'), 'C 结束');
  assert.equal(f.events(c).some(row => row.event === 'queued'), false, 'C 没有排队');
  assert.equal(f.events(c).find(row => row.event === 'end').exit, 0);
  assert.equal(f.has(b, 'preparing'), false, 'C 都结束了 B 还在等 A');

  // B 等的时候主分支前进了一个提交（模拟先合入的改动）。
  const before = git(f.repo, ['rev-parse', 'main']);
  write(path.join(f.repo, 'docs/other.md'), '先合入\n');
  git(f.repo, ['add', '--', 'docs/other.md']);
  git(f.repo, ['commit', '-q', '-m', '主分支前进']);
  const merge = git(f.repo, ['rev-parse', 'main']);
  assert.notEqual(merge, before);

  // A 放行 → 门禁 → 待验收（待验收不挡人），B 开始。
  f.release(goA);
  await until(() => f.has(a, 'end'), 'A 结束');
  await until(() => f.has(b, 'end'), 'B 结束');
  const events = f.events(b);
  assert.equal(events.find(row => row.event === 'worktree').base, merge, 'worktree 事件里是合并后的基线');
  assert.equal(events.find(row => row.event === 'attempt').base, merge, '第一次 attempt 带新基线');
  assert.equal(events.find(row => row.event === 'start').base, before, 'start 里仍是派发时的基线');
  assert.match(f.progress('乙'), /基线更新：main 从 [0-9a-f]{7} 前进到 [0-9a-f]{7}/);
  const gate = JSON.parse(readFileSync(path.join(f.repo, '.agent-runs', '乙', 'attempts', '1', 'gate.json'), 'utf8'));
  assert.equal(gate.base, merge, '门禁记录里的 base 是合并后的提交');
  assert.equal(gate.ok, true, JSON.stringify(gate));
  assert.equal(events.find(row => row.event === 'end').exit, 0);
  // B 的分支建立在新基线之上：主分支前进的那个提交是它的祖先。
  const branch = events.find(row => row.event === 'worktree').branch;
  execFileSync('git', ['merge-base', '--is-ancestor', merge, branch], { cwd: f.repo });
  // 乙排在两处：重叠的那一次，没有因为槽位再写别的 reason。
  assert.equal(events.filter(row => row.event === 'queued' && row.reason === 'overlap').length, 1);
});

test('2 重叠的任务说明不在新基线里：按准备失败处理，写明原因', async t => {
  const f = fixture(t);
  const goA = path.join(f.base, 'go-a.flag');
  const specA = f.spec('docs/specs/A.md', { allowed: ['src/**'] });
  const specB = f.spec('docs/specs/B.md', { allowed: ['src/a.js'] });
  f.setProfile({ releaseFile: goA, releaseTimeoutMs: 120000, writes: [{ path: 'src/a.js', content: 'A\n' }], commit: '假执行者：A' });
  const a = await f.dispatch(specA, '甲');
  await until(() => f.has(a, 'spawned'), 'A 启动执行者');
  f.setProfile({ releaseFile: null }, true);
  const b = await f.dispatch(specB, '乙');
  await until(() => f.events(b).find(row => row.event === 'queued'), 'B 排队');
  // 主分支上的任务说明在 B 排队期间被删掉（提交到 main）。
  git(f.repo, ['rm', '-q', '--', specB]);
  git(f.repo, ['commit', '-q', '-m', '删掉乙的任务说明']);
  f.release(goA);
  await until(() => f.has(b, 'end'), 'B 结束');
  const events = f.events(b);
  const setup = events.find(row => row.event === 'setup');
  assert.equal(setup.ok, false);
  assert.match(setup.summary, /重新取基线失败：任务说明还没提交到 main，执行者看不到它/);
  assert.equal(events.some(row => row.event === 'worktree'), false, '没有建 worktree');
  assert.notEqual(events.find(row => row.event === 'end').exit, 0);
  assert.deepEqual(f.slotFiles().filter(name => /^(slot|gate)-/.test(name)), [], '名额释放');
});

test('3 独占命令：独占门禁运行期间新任务排队，门禁结束后才开始；孤立的独占标记被回收', async t => {
  const f = fixture(t, { project: { exclusiveCommands: ['node scripts/slow.mjs'] } });
  const specD = f.spec('docs/specs/D.md', { allowed: ['docs/d/**'], verify: ['node scripts/slow.mjs'] });
  const specE = f.spec('docs/specs/E.md', { allowed: ['docs/e/**'] });
  const specF = f.spec('docs/specs/F.md', { allowed: ['docs/f/**'] });
  const started = path.join(f.base, 'gate-started.flag');
  const go = path.join(f.base, 'gate-go.flag');

  f.setProfile({ writes: [{ path: 'docs/d/x.md', content: 'D\n' }], commit: '假执行者：D' });
  const d = await f.dispatch(specD, '丁');
  await until(() => existsSync(started), 'D 的独占验收命令开始');
  const marker = JSON.parse(readFileSync(path.join(f.home, 'slots', 'exclusive.json'), 'utf8'));
  assert.equal(marker.id, d);
  assert.equal(marker.name, '丁');
  assert.equal(marker.command, 'node scripts/slow.mjs');
  assert.equal(Number.isSafeInteger(marker.pid), true);
  assert.equal(Number.isFinite(marker.created) || marker.created === null, true);

  f.setProfile({ writes: [{ path: 'docs/e/x.md', content: 'E\n' }], commit: '假执行者：E' });
  const e = await f.dispatch(specE, '戊');
  await until(() => f.has(e, 'queued'), 'E 排队');
  assert.match(f.progress('戊'), /排队：丁 的门禁正在独占运行（node scripts\/slow\.mjs），等它结束/);
  await delay(2600);
  assert.equal(f.has(e, 'preparing'), false, 'D 的门禁还在跑，E 不开始');
  assert.equal(f.has(d, 'gate'), false);

  f.release(go);
  await until(() => f.has(d, 'gate') && f.has(e, 'end'), 'D 门禁结束后 E 开始并结束');
  assert.equal(f.events(d).find(row => row.event === 'gate').ok, true);
  const order = rows(f.home);
  assert.ok(order.findIndex(row => row.id === e && row.event === 'preparing') > order.findIndex(row => row.id === d && row.event === 'gate'), 'E 在 D 的 gate 事件之后才 preparing');
  await until(() => !existsSync(path.join(f.home, 'slots', 'exclusive.json')), '标记删除');

  // 占用者进程不在了的标记会被回收：先留一个孤立标记，新任务照常开始。
  // 占用者的 pid 用一个确定不存在的值（超过 Windows 与常见系统的 PID 上限）。原先用"刚结束的子进程的 pid"，
  // Windows 上刚释放的 pid 有一小段时间还查得到、查不到创建时间，孤立判定会走"像是活着"的分支，新任务先排了一次队。
  const ghostPid = 2147483646;
  assert.equal(pidAlive(ghostPid), false, '测试前提：这个 pid 确实不存在');
  write(path.join(f.home, 'slots', 'exclusive.json'), JSON.stringify({ id: 'ghost', pid: ghostPid, created: 1, at: 1, name: '幽灵', command: 'node scripts/slow.mjs' }));
  f.setProfile({ writes: [{ path: 'docs/f/x.md', content: 'F\n' }], commit: '假执行者：F' });
  const g = await f.dispatch(specF, '己');
  await until(() => f.has(g, 'end'), '孤立标记不挡新任务');
  assert.equal(f.events(g).some(row => row.event === 'queued'), false);
  assert.equal(existsSync(path.join(f.home, 'slots', 'exclusive.json')), false, '孤立标记被回收');
});

test('4 并发自动档：机器忙时排队的任务不开始，不忙后开始；ar config 显示估算值与上限', async t => {
  const f = fixture(t, { config: { concurrency: 'auto', concurrencyMax: 3 } });
  const spec = f.spec('docs/specs/G.md', { allowed: ['docs/g/**'] });
  const load = path.join(f.base, 'load.json');
  writeFileSync(load, JSON.stringify({ busy: true, cpu: 92 }));
  f.setProfile({ writes: [{ path: 'docs/g/x.md', content: 'G\n' }], commit: '假执行者：G' });
  // setProfile 会按 config 参数重写 config.json（带 auto）。

  const shown = await f.ar(['config']);
  assert.equal(shown.code, 0, shown.stderr + shown.stdout);
  assert.match(shown.stdout, /^concurrency\s+[1-3]\s+config\.json$/m, '自动档下 limits.concurrency 是估算值，不超过上限 3');
  assert.match(shown.stdout, /^concurrencyMode\s+auto\s+config\.json$/m);
  assert.match(shown.stdout, /^concurrencyMax\s+3\s+config\.json$/m);
  assert.match(shown.stdout, /^memLowPercent\s+5\s+内置默认$/m, '182：没写时默认 5%');
  assert.match(shown.stdout, /^autoEstimate\s+[1-3]\s+\d+ 核、可用内存 [\d.]+ GB$/m);
  assert.match(shown.stdout, /^autoState\s+\S+/m);
  const json = JSON.parse((await f.ar(['config', '--json'])).stdout);
  assert.equal(json.config.concurrency, 'auto');
  assert.ok(json.lines.some(line => line.startsWith('autoEstimate')));

  const g = await f.dispatch(spec, '庚', { env: { AR_TEST_LOAD_FILE: load } });
  await until(() => f.has(g, 'queued'), '忙时排队');
  assert.match(f.progress('庚'), /排队：机器正忙（CPU 92%），暂停启动新任务/);
  await delay(2600);
  assert.equal(f.has(g, 'preparing'), false, '机器忙，任务不开始');
  assert.equal(f.slotFiles().filter(name => /^slot-/.test(name)).length, 0, '没有占名额');

  writeFileSync(load, JSON.stringify({ busy: false, cpu: 10 }));
  await until(() => f.has(g, 'end'), '不忙之后开始并结束');
  assert.match(f.progress('庚'), /排队：机器恢复空闲/);
  assert.equal(f.events(g).find(row => row.event === 'end').exit, 0);
});

test('5 ar projects config exclusiveCommands：写入字符串数组，空数组可以，非法值拒绝且不改文件；ar init 模板里没有这个键', async t => {
  const f = fixture(t);
  const file = path.join(f.repo, '.agent-router', 'project.json');
  const wrote = await f.ar(['projects', 'config', f.repo, 'exclusiveCommands=["npm run shots","node a.mjs"]', '--json']);
  assert.equal(wrote.code, 0, wrote.stderr + wrote.stdout);
  assert.deepEqual(JSON.parse(wrote.stdout).config.exclusiveCommands, ['npm run shots', 'node a.mjs']);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).exclusiveCommands, ['npm run shots', 'node a.mjs']);
  const before = readFileSync(file, 'utf8');
  for (const bad of ['exclusiveCommands=npm run shots', 'exclusiveCommands={"a":1}', 'exclusiveCommands=[1]', 'exclusiveCommands=[""]', 'exclusiveCommands=["  "]', 'exclusiveCommands=["a\\nb"]']) {
    const result = await f.ar(['projects', 'config', f.repo, bad, '--json']);
    assert.notEqual(result.code, 0, bad);
    assert.equal(readFileSync(file, 'utf8'), before, `${bad} 不改文件`);
  }
  const cleared = await f.ar(['projects', 'config', f.repo, 'exclusiveCommands=[]', '--json']);
  assert.equal(cleared.code, 0, cleared.stderr + cleared.stdout);
  assert.deepEqual(JSON.parse(cleared.stdout).config.exclusiveCommands, []);
  assert.equal(readFileSync(path.join(fileURLToPath(new URL('../../core/templates/', import.meta.url)), 'project.json'), 'utf8').includes('exclusiveCommands'), false, '模板不带这个键');
});