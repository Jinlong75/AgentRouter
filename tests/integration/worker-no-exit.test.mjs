// 执行者不自行退出的兜底（183，D115）：看到最后的结果事件、汇报已有后，一段时间没有新输出、进程仍不退出，就结束进程树，按结果判定。
// 用假执行者（tests/fixtures/no-exit/agent.mjs 冒充 claude-code，以及 fake 适配器），不联网；等待时间用 AR_TEST_NO_EXIT_GRACE_MS 缩短。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../../core/lib/agents.mjs';
import { busyDescendants, identityAlive, pidAlive, processList } from '../../core/lib/process.mjs';
import { claudeCode, finalResultOf } from '../../core/adapters/claude-code.mjs';
import { codex } from '../../core/adapters/codex.mjs';
import { fake } from '../../core/adapters/fake.mjs';
import { makeGeneric } from '../../core/adapters/generic.mjs';
import { NO_EXIT_GRACE_MS, noExitGrace } from '../../core/lib/runner.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(project, 'core/ar.mjs');
const agent = fileURLToPath(new URL('../fixtures/no-exit/agent.mjs', import.meta.url));
const jsonl = file => fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
const NOTICE = '执行者没有自行退出：看到结果后';

function fixture(t, profiles) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'ar-no-exit-'));
  t.after(() => { assert.equal(path.dirname(base), path.resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const root = path.join(base, 'repo'), home = path.join(base, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const first = Object.keys(profiles)[0];
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: first, profiles, managed: false }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_)/i.test(k)) delete env[k];
  Object.assign(env, {
    AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', USERPROFILE: base, HOME: base, APPDATA: base, CLAUDE_CONFIG_DIR: path.join(base, 'claude-config'),
    AR_WORKTREE_ROOT: path.join(base, 'worktrees'), AR_TEST_PID_FILE: path.join(base, 'pids.json'),
  });
  const dir = name => path.join(root, '.agent-runs', name);
  const run = (name, extra = {}) => new Promise(resolve => {
    const child = spawn(process.execPath, [entry, 'dispatch', '做点事', '--name', name], { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const started = Date.now();
    const limit = setTimeout(() => child.kill(), 100000);
    child.on('close', status => { clearTimeout(limit); resolve({ status, stdout, stderr, ms: Date.now() - started }); });
  });
  const records = () => jsonl(path.join(home, 'runs.jsonl'));
  const events = name => jsonl(path.join(dir(name), 'events.jsonl'));
  const progress = name => fs.readFileSync(path.join(dir(name), 'progress.log'), 'utf8');
  const report = name => fs.readFileSync(path.join(dir(name), 'report.md'), 'utf8');
  return { base, root, home, run, records, events, progress, report };
}

// 按进程身份（PID + 创建时间）判断进程已结束：同一个 PID 被别的新进程占用不算还活着。
// 假执行者没查到创建时间（null）时退回只看 PID。
async function identityGone(pid, created) {
  if (!Number.isFinite(created)) return !pidAlive(pid);
  return !identityAlive(await processList(pid), { pid, created });
}

const claudeProfile = () => loadPreset('deepseek').profile;
// 密钥只是占位（假执行者不联网）；DEEPSEEK_API_KEY 是预设里密钥来源的变量名。
const claudeEnv = (mode, extra = {}) => ({ AR_TEST_AGENT: agent, AR_TEST_NOEXIT_MODE: mode, DEEPSEEK_API_KEY: 'sk-test-no-exit', ...extra });

test('成功结果后挂住：到时被结束（进程树都没了），按成功结束，进度与事件里有那一条', async t => {
  const f = fixture(t, { claude: claudeProfile() });
  const result = await f.run('挂住成功', claudeEnv('hang', { AR_TEST_NO_EXIT_GRACE_MS: '1500' }));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(result.ms < 55000, `应当在保险时限（60 秒）之前被结束：${result.ms} 毫秒`);
  const pids = JSON.parse(fs.readFileSync(path.join(f.base, 'pids.json'), 'utf8'));
  assert.equal(await identityGone(pids.agent, pids.agentCreated), true, '执行者进程已结束');
  assert.equal(pids.child, null, '进程树里只有执行者自己');
  const spawned = f.records().find(r => r.event === 'spawned');
  assert.equal(spawned.agentPid, pids.agent);
  const notices = f.events('挂住成功').filter(e => e.noExit);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'text'); assert.equal(notices[0].result, 'success');
  assert.equal(notices[0].text, '执行者没有自行退出：看到结果后 1.5 秒仍在运行，已结束它的进程（按结果判定）');
  assert.ok(f.progress('挂住成功').includes(notices[0].text), '进度里有同一行');
  assert.equal(f.report('挂住成功'), '完成');
  const rows = f.records();
  const attemptEnd = rows.filter(r => r.event === 'attempt-end'), end = rows.find(r => r.event === 'end');
  assert.equal(attemptEnd.length, 1, '不重试');
  assert.equal(attemptEnd[0].ok, true); assert.equal(attemptEnd[0].exit, 0);
  assert.equal(end.exit, 0);
  assert.ok(!rows.some(r => r.event === 'interrupted'), '不算中断');
});

test('结果后还有正在运行的子进程（等后台命令）：不被结束；子进程退出后仍不退出才结束', async t => {
  const f = fixture(t, { claude: claudeProfile() });
  // 等待 1.5 秒、后台子进程跑 6 秒：结果后 1.5 / 3 / 4.5 秒的三次检查都看到子进程在跑，不能被结束；子进程退出后的下一次检查才结束。
  const result = await f.run('等后台', claudeEnv('bg-child', { AR_TEST_NO_EXIT_GRACE_MS: '1500', AR_TEST_NOEXIT_BG_MS: '6000' }));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(result.ms < 55000, `应当在保险时限之前被结束：${result.ms} 毫秒`);
  const pids = JSON.parse(fs.readFileSync(path.join(f.base, 'pids.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(pids.child));
  assert.equal(await identityGone(pids.agent, pids.agentCreated), true, '执行者进程已结束');
  assert.equal(await identityGone(pids.child, pids.childCreated), true, '后台子进程已结束');
  const attemptEnd = f.records().find(r => r.event === 'attempt-end');
  // 子进程至少跑到启动后 6 秒；若在子进程还在跑时就结束，用时会落在 1.5～4.5 秒。
  assert.ok(attemptEnd.ms >= 5500, `执行者要等到后台子进程退出之后才被结束：${attemptEnd.ms} 毫秒`);
  const notices = f.events('等后台').filter(e => e.noExit);
  assert.equal(notices.length, 1); assert.equal(notices[0].result, 'success');
  assert.equal(f.report('等后台'), '完成');
  assert.equal(attemptEnd.exit, 0);
});

test('busyDescendants：控制台宿主不算，其余子孙算；根不在返回空；查询失败抛出', async () => {
  const row = (pid, parent, name, created) => ({ pid, parent, name, created, command: '' });
  const snapshot = [
    row(100, 1, 'claude.exe', 1000),
    row(101, 100, 'conhost.exe', 1001),
    row(102, 100, 'powershell.exe', 1002),
    row(103, 102, 'node.exe', 1003),
    row(104, 100, 'OpenConsole.exe', 1004),
    row(200, 1, 'node.exe', 1005),
    row(300, 100, 'old.exe', 500), // 比根还早创建：PID 复用造成的假父子，不算子孙
  ];
  const list = async () => snapshot;
  assert.deepEqual((await busyDescendants(100, { list })).map(p => p.pid), [102, 103]);
  assert.deepEqual(await busyDescendants(101, { list }), [], '只有控制台宿主自己时没有子孙');
  assert.deepEqual(await busyDescendants(999, { list }), [], '根已不在快照里');
  assert.deepEqual((await busyDescendants(100, { list: async () => snapshot.filter(p => p.pid !== 102 && p.pid !== 103) })), [], '只剩控制台宿主');
  await assert.rejects(busyDescendants(100, { list: async () => { throw new Error('进程查询超时'); } }), /进程查询超时/);
});

test('结果后又有输出（后台通知多一轮）、然后自己退出：不被提前结束，没有那一条', async t => {
  const f = fixture(t, { claude: claudeProfile() });
  // 第一条结果后 3.5 秒才有新输出（短于 6 秒等待）、之后再过 3.5 秒退出：不重新计时的话，第一条结果后 6 秒就会被结束。
  const result = await f.run('多一轮', claudeEnv('more', { AR_TEST_NO_EXIT_GRACE_MS: '6000', AR_TEST_NOEXIT_GAP_MS: '3500' }));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const events = f.events('多一轮');
  assert.equal(events.filter(e => e.kind === 'turn').length, 2, '两轮结果都收到了');
  assert.ok(!events.some(e => e.noExit));
  assert.ok(!f.progress('多一轮').includes(NOTICE));
  assert.equal(f.report('多一轮'), '最终汇报：后台任务也完成了', '汇报取最长的一条结果');
  assert.equal(f.records().find(r => r.event === 'end').exit, 0);
});

test('结果后立刻退出：行为与现在一样（没有那一条，退出码照旧）', async t => {
  const f = fixture(t, { claude: claudeProfile() });
  const result = await f.run('立刻退出', claudeEnv('quick', { AR_TEST_NO_EXIT_GRACE_MS: '1500' }));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(!f.events('立刻退出').some(e => e.noExit));
  assert.ok(!f.progress('立刻退出').includes(NOTICE));
  assert.equal(f.report('立刻退出'), '完成');
  assert.equal(f.records().find(r => r.event === 'end').exit, 0);
});

test('错误结果后挂住：被结束，按失败处理（退出码 1，ok 为 false）', async t => {
  const f = fixture(t, { claude: claudeProfile() });
  const result = await f.run('挂住失败', claudeEnv('hang-error', { AR_TEST_NO_EXIT_GRACE_MS: '1500' }));
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.ok(result.ms < 55000, `应当在保险时限之前被结束：${result.ms} 毫秒`);
  const pids = JSON.parse(fs.readFileSync(path.join(f.base, 'pids.json'), 'utf8'));
  assert.equal(await identityGone(pids.agent, pids.agentCreated), true);
  const notices = f.events('挂住失败').filter(e => e.noExit);
  assert.equal(notices.length, 1); assert.equal(notices[0].result, 'error');
  assert.ok(f.events('挂住失败').some(e => e.kind === 'error' && e.text.includes('执行失败')), '结果里的错误事件还在');
  const rows = f.records();
  const attemptEnd = rows.find(r => r.event === 'attempt-end');
  assert.equal(attemptEnd.ok, false); assert.equal(attemptEnd.exit, 1);
  assert.equal(rows.find(r => r.event === 'end').exit, 1);
});

test('没有结果事件就挂着：不触发兜底（执行者自己按时退出）', async t => {
  const f = fixture(t, { claude: claudeProfile() });
  // 4 秒的静默远长于 1.5 秒的等待；没有结果事件，兜底不该动。
  const result = await f.run('没有结果', claudeEnv('silent', { AR_TEST_NO_EXIT_GRACE_MS: '1500', AR_TEST_NOEXIT_HOLD_MS: '4000' }));
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.ok(!f.events('没有结果').some(e => e.noExit));
  assert.ok(!f.progress('没有结果').includes(NOTICE));
  const attemptEnd = f.records().find(r => r.event === 'attempt-end');
  assert.ok(attemptEnd.ms >= 3500, `执行者跑满了它自己的 4 秒：${attemptEnd.ms}`);
  assert.equal(attemptEnd.exit, 0);
});

test('没有汇报就不兜底：fake 回放了 turn 但在等放行文件，到时也不动它', async t => {
  const f = fixture(t, { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'turn', usage: { input: 1, output: 1 } }], report: '假汇报\n', exit: 0, releaseFile: path.join(tmpdir(), 'ar-no-exit-never-exists'), releaseTimeoutMs: 4000 } });
  const result = await f.run('没有汇报', { AR_TEST_NO_EXIT_GRACE_MS: '1500' });
  // 放行超时后假执行者自己以 2 退出；兜底没有动手，所以是它自己的退出码，没有那一条。
  assert.equal(result.status, 2, result.stderr + result.stdout);
  assert.ok(!f.events('没有汇报').some(e => e.noExit));
});

test('各适配器的结果事件（finalResult）', () => {
  const claude = claudeCode.createMapper();
  const map = line => claude(JSON.stringify(line), { root: project });
  const ok = claudeCode.finalResult(map({ type: 'result', subtype: 'success', is_error: false, result: '完成', usage: {} }));
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(claudeCode.finalResult(map({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '', usage: {} })), { ok: false });
  assert.equal(claudeCode.finalResult(map({ type: 'assistant', message: { content: [{ type: 'text', text: '说话' }] } })), null);
  assert.equal(claudeCode.finalResult(map({ type: 'system', subtype: 'init', model: 'm' })), null);

  const codexMap = line => codex.mapLine(JSON.stringify(line), { root: project });
  assert.deepEqual(codex.finalResult(codexMap({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } })), { ok: true });
  assert.equal(codex.finalResult(codexMap({ type: 'turn.failed', error: { message: '失败' } })), null);
  assert.equal(codex.finalResult(codexMap({ type: 'item.completed', item: { type: 'agent_message', text: '说话' } })), null);

  assert.deepEqual(fake.finalResult(fake.mapLine(JSON.stringify({ kind: 'turn', usage: {} }))), { ok: true });
  assert.equal(fake.finalResult(fake.mapLine(JSON.stringify({ kind: 'say', text: '说话' }))), null);

  const decl = format => ({ label: '通用', executable: 'x', args: [], output: { format } });
  assert.equal(makeGeneric(decl('stream-json')).finalResult, finalResultOf, 'stream-json 复用 claude-code 的结果事件');
  assert.equal(makeGeneric(decl('text')).finalResult, undefined, 'text 没有结束条件，不启用兜底');
  assert.equal(makeGeneric(decl('jsonl')).finalResult, undefined, 'jsonl 没有结束条件，不启用兜底');
});

test('等待时间：默认 2 分钟，AR_TEST_NO_EXIT_GRACE_MS 可缩短（只认正数）', () => {
  assert.equal(NO_EXIT_GRACE_MS, 120000);
  assert.equal(noExitGrace({}), 120000);
  assert.equal(noExitGrace({ AR_TEST_NO_EXIT_GRACE_MS: '1500' }), 1500);
  assert.equal(noExitGrace({ AR_TEST_NO_EXIT_GRACE_MS: '0' }), 120000);
  assert.equal(noExitGrace({ AR_TEST_NO_EXIT_GRACE_MS: 'abc' }), 120000);
});
