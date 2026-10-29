import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordLimit } from '../../core/lib/limits-state.mjs';
import { route } from '../../core/lib/router.mjs';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// 任务 148（Stage07c T7）：额度用完 / 限流 / 服务不可用时自动换人。
// 失败的执行者用 fake 适配器输出限流原文（出错事件），另有经假的 Claude Code / Codex（AR_TEST_AGENT，tests/fixtures/limits/）和通用适配器的几条。
// 隔离的 AGENT_ROUTER_HOME、USERPROFILE / HOME、CLAUDE_CONFIG_DIR，系统临时目录里的仓库；不联网，不真的耗额度。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const limitAgent = fileURLToPath(new URL('../fixtures/limits/fake-limit-agent.mjs', import.meta.url));
const codexFixture = fileURLToPath(new URL('../fixtures/limits/codex-usage-limit.jsonl', import.meta.url));
const textCli = fileURLToPath(new URL('../fixtures/generic/text-cli.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, 'utf8'); };
const jsonl = file => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

// 限流原文（出处见 tests/fixtures/limits/README.md 与 docs 里对各家的说明）：429 + usage limit + 相对恢复时间。
const LIMIT_TEXT = 'API Error: 429 Too Many Requests: you have hit your usage limit. Please try again in 2 hours.';
const NETWORK_TEXT = 'request failed: read ECONNRESET';
const WHEN = /(?:\d+月\d+日 )?\d{2}:\d{2}/;

const failing = (text, extra = {}) => ({ adapter: 'fake', label: '甲执行者', enabled: true, events: [{ kind: 'error', text }], report: '', exit: 1, ...extra });
const succeeding = (label = '乙执行者', extra = {}) => ({ adapter: 'fake', label, enabled: true, events: [{ kind: 'say', text: `${label}完成` }], report: `${label}汇报\n`, exit: 0, ...extra });

function fixture(t) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-limit-148-'));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home'), user = path.join(base, 'user');
  for (const dir of [repo, home, user, path.join(user, 'AppData')]) mkdirSync(dir);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_)/i.test(key)) delete env[key];
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'HOMEDRIVE', 'HOMEPATH']) delete env[key];
  Object.assign(env, {
    AGENT_ROUTER_HOME: home, USERPROFILE: user, HOME: user, APPDATA: user, CLAUDE_CONFIG_DIR: path.join(user, 'claude'), CODEX_HOME: path.join(user, 'codex'),
    AR_WORKTREE_ROOT: path.join(base, 'wt'), AR_NO_WATCH: '1', AR_TEST_AGENT: limitAgent,
  });
  assert.equal(path.dirname(env.AGENT_ROUTER_HOME), base, '隔离目录在临时目录里');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '限流测试']);
  git(repo, ['config', 'user.email', 'limit-148@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'a.txt'), '初始\n');
  git(repo, ['add', '.gitignore', 'a.txt']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  const f = { base, repo, home, env };
  // 默认配置：docs 类任务的规则 → alpha（总是限流），兜底 / 默认 → beta（成功）。patch 里再改。
  f.config = patch => {
    const config = {
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'beta',
      profiles: { alpha: failing(LIMIT_TEXT), beta: succeeding() },
      routing: { rules: [{ types: ['docs'], profile: 'alpha' }], fallback: 'beta', reviewer: null, strongExecutor: null },
    };
    patch?.(config);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    return config;
  };
  f.ar = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 90000, windowsHide: true, shell: false });
  f.spec = (name, maxRetries) => {
    const rel = `docs/specs/${name}.md`;
    write(path.join(repo, rel), ['---', 'id: 148', 'title: 限流换人测试', 'type: docs', `max_retries: ${maxRetries}`, '---', '', '正文', ''].join('\n'));
    return rel;
  };
  // 派发一个 docs 任务，返回 info；expectExit 给了就断言退出码。
  f.dispatch = (name, maxRetries, expectExit, extraArgs = []) => {
    const r = f.ar(['dispatch', f.spec(name, maxRetries), '--name', name, ...extraArgs]);
    if (expectExit !== undefined) assert.equal(r.status, expectExit, `${r.stdout}\n${r.stderr}`);
    return { ...f.info(name), stdout: r.stdout };
  };
  f.info = name => {
    const all = jsonl(path.join(home, 'runs.jsonl'));
    const start = all.find(row => row.event === 'start' && row.name === name);
    const rows = all.filter(row => row.id === start.id);
    return { name, start, rows, attempts: rows.filter(row => row.event === 'attempt'), end: rows.at(-1), progress: f.progress(name) };
  };
  f.progress = name => readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  f.prompt = (name, n) => readFileSync(path.join(repo, '.agent-runs', name, 'attempts', String(n), 'prompt.md'), 'utf8');
  f.marks = name => { try { return JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'marks.json'), 'utf8')); } catch { return null; } };
  f.limits = () => { try { return JSON.parse(readFileSync(path.join(home, 'limits.json'), 'utf8')); } catch { return null; } };
  f.dispatchRecord = name => JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'dispatch.json'), 'utf8'));
  f.report = name => {
    const r = f.ar(['report', name, '--json']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  t.after(async () => {
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(realpathSync.native(os.tmpdir()), base).startsWith('ar-limit-148-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  f.config();
  return f;
}
const item = (role, key) => role.items.find(entry => entry.key === key);

test('1 A 被限流、路由链里有 B：自动换 B；这次不计重试；marks.json 有 environment；limits.json 有 A 的恢复时间；进度有那句话；评分里 A 不扣分', t => {
  const f = fixture(t);
  const before = Date.now();
  // max_retries 0：普通失败不会再试；换人照样发生，说明它不消耗重试次数。
  const task = f.dispatch('lim1', 0, 0);
  assert.deepEqual(task.attempts.map(row => [row.n, row.profile, row.reason, row.total]), [[1, 'alpha', 'first', 1], [2, 'beta', 'agent', 2]], 'attempt 编号照常加 1，total 含换人多出来的一次');
  assert.equal(task.end.exit, 0);
  assert.equal(task.end.attempts, 2);
  assert.equal(Object.hasOwn(task.end, 'handBack'), false);
  const attemptEnds = task.rows.filter(row => row.event === 'attempt-end');
  assert.deepEqual(attemptEnds.map(row => [row.n, row.ok]), [[1, false], [2, true]]);

  // 进度：那句话（执行者名用显示名，换上的用配置名）、分隔行里写换人原因。
  assert.match(task.progress, new RegExp(`甲执行者 被限流（额度到 ${WHEN.source} 恢复），换 beta，这次不计重试`));
  assert.match(task.progress, /=== 第 2 次尝试（执行者：乙执行者；原因：换执行者（甲执行者额度用完或被限流））===/);
  // 归因：marks.json 里第 1 次是环境。
  assert.deepEqual(f.marks('lim1'), { v: 1, blame: { 1: 'environment' } });
  // limits.json：A 的恢复时间取自报错里的 "in 2 hours"。
  const limits = f.limits();
  assert.equal(limits.v, 1);
  assert.deepEqual(Object.keys(limits.profiles), ['alpha']);
  const alpha = limits.profiles.alpha;
  assert.equal(alpha.kind, 'limit');
  assert.ok(alpha.until >= before + 7200000 && alpha.until <= Date.now() + 7200000, `until=${alpha.until}`);
  assert.ok(alpha.since >= before && alpha.since <= alpha.until);
  assert.match(alpha.evidence, /429/);
  assert.ok(alpha.evidence.length <= 200);
  assert.equal(JSON.stringify(limits).includes('sk-'), false);
  // 换人的那次：指令是原始指令（和被换掉的那次同一步）加接手说明，不是"上一次没通过验收"。
  assert.ok(f.prompt('lim1', 2).startsWith(f.prompt('lim1', 1)));
  assert.match(f.prompt('lim1', 2), /## 接手说明\n\n上一个执行者（甲执行者）因额度用完或被限流中断了任务/);
  assert.ok(!f.prompt('lim1', 2).includes('上一次尝试没有通过验收'));
  assert.ok(!f.prompt('lim1', 1).includes('接手说明'));

  // 评分：A 不扣分（多一次尝试、工具报错都不算），环境原因记 1 次且不扣分。
  const report = f.report('lim1');
  assert.deepEqual([report.executor.score, report.lead.score], [100, 100]);
  assert.deepEqual([item(report.executor, 'attemptAgent').count, item(report.executor, 'attemptAgent').points], [0, 0]);
  assert.equal(item(report.executor, 'escalated').count, 0, '自动换人不算"升级了执行者"');
  assert.equal(item(report.executor, 'toolError').count, 0, '限流那次的出错事件不算');
  assert.deepEqual(item(report.executor, 'envBlame'), { key: 'envBlame', count: 1, points: 0, detail: null });
  assert.deepEqual(item(report.lead, 'envBlame'), { key: 'envBlame', count: 1, points: 0, detail: null });
  assert.deepEqual(report.attempts.map(a => [a.n, a.profile, a.blame]), [[1, 'alpha', 'environment'], [2, 'beta', null]]);
  const text = f.ar(['report', 'lim1']).stdout;
  assert.equal(text.split(/\r?\n/).filter(line => line === '  环境原因：1 次（0）').length, 2, text);

  // 数据出口：ar route config（文字多一行、--json 多 limited）、ar status --json 的 limits。
  const route = f.ar(['route', 'config']);
  assert.match(route.stdout, new RegExp(`^ {2}alpha：额度到 ${WHEN.source} 恢复$`, 'm'));
  assert.ok(!/^ {2}beta：/m.test(route.stdout));
  const routeJson = JSON.parse(f.ar(['route', 'config', '--json']).stdout);
  assert.deepEqual(routeJson.profiles.find(p => p.name === 'alpha').limited, { kind: 'limit', until: alpha.until, since: alpha.since, evidence: alpha.evidence });
  assert.equal(Object.hasOwn(routeJson.profiles.find(p => p.name === 'beta'), 'limited'), false);
  const status = JSON.parse(f.ar(['status', 'lim1', '--json']).stdout);
  assert.deepEqual(status.limits, { alpha: { kind: 'limit', until: alpha.until, since: alpha.since } });
  assert.match(f.ar(['status', 'lim1']).stdout, new RegExp(`^alpha：额度到 ${WHEN.source} 恢复$`, 'm'));
});

test('1b 换人不消耗重试次数：换上的 B 自己失败后仍有一次重试；评分只算 B 的这一次重试', t => {
  const f = fixture(t);
  f.config(config => { config.profiles.beta = succeeding('乙执行者', { attempts: { 2: { events: [{ kind: 'error', text: '测试没过' }], report: '', exit: 1 } } }); });
  // max_retries 1：总共 2 步。第 1 步 A 限流 → 换 B（第 2 次尝试，仍是第 1 步）；B 失败 → 重试（第 3 次尝试，第 2 步）成功。
  const task = f.dispatch('lim1b', 1, 0);
  assert.deepEqual(task.attempts.map(row => [row.n, row.profile, row.reason, row.total]), [[1, 'alpha', 'first', 2], [2, 'beta', 'agent', 3], [3, 'beta', 'agent', 3]]);
  assert.equal(task.end.attempts, 3);
  assert.match(task.progress, /换 beta，这次不计重试/);
  assert.match(task.progress, /=== 第 3 次尝试（执行者：乙执行者；原因：执行者异常退出（exit 1））===/);
  // 第 3 次是真正的重试：升级链按"第 2 步 = 最后一次"走，没设强执行者，进度这么写。
  assert.match(task.progress, /没有设强执行者，最后一次仍用 beta/);
  assert.match(f.prompt('lim1b', 3), /## 上一次尝试没有通过验收（第 1 次，共允许 2 次）/, '重试指令里的次数按"计入重试的步数"算，不含换人');
  assert.deepEqual(f.marks('lim1b'), { v: 1, blame: { 1: 'environment' } });
  const report = f.report('lim1b');
  assert.equal(item(report.executor, 'attemptAgent').count, 1, '第 2 次（换人）免掉，第 3 次（B 自己的重试）照算');
  assert.equal(item(report.executor, 'toolError').count, 1, 'B 的"测试没过"算，A 的限流不算');
  assert.equal(item(report.executor, 'escalated').count, 0);
});

test('2 A 恢复前再派一个任务：路由跳过 A（trace 写原因）；恢复时间过后（注入时间 / 过期的记录）A 重新可用', t => {
  const f = fixture(t);
  f.dispatch('lim2a', 0, 0);
  const until = f.limits().profiles.alpha.until;

  const second = f.dispatch('lim2b', 0, 0);
  assert.deepEqual(second.attempts.map(row => row.profile), ['beta'], 'A 被限流，路由直接用 B');
  assert.equal(second.rows.some(row => row.event === 'attempt-end' && row.ok === false), false);
  const trace = f.dispatchRecord('lim2b').route.trace;
  assert.ok(trace.some(line => new RegExp(`规则 1：\\[docs\\] → alpha：被限流（额度到 ${WHEN.source} 恢复），跳过`).test(line)), trace.join('\n'));
  assert.equal(trace.at(-1), '兜底：beta');
  assert.equal(f.marks('lim2b'), null, '没有失败，没有归因');

  // 注入时间：恢复时间过后路由重新选 A；之前仍然跳过。
  const config = JSON.parse(readFileSync(path.join(f.home, 'config.json'), 'utf8'));
  assert.equal(route({ spec: { type: 'docs' }, config, home: f.home, now: until - 1000 }).profile, 'beta');
  assert.equal(route({ spec: { type: 'docs' }, config, home: f.home, now: until + 1000 }).profile, 'alpha');

  // 真实流程：记录里的恢复时间已过（写成过去的时间），新任务又从 A 开始（A 这次仍然限流 → 又换 B，记录更新）。
  writeFileSync(path.join(f.home, 'limits.json'), JSON.stringify({ v: 1, profiles: { alpha: { kind: 'limit', until: Date.now() - 60000, since: Date.now() - 3600000, evidence: '429' } } }));
  const third = f.dispatch('lim2c', 0, 0);
  assert.deepEqual(third.attempts.map(row => row.profile), ['alpha', 'beta']);
  assert.ok(f.limits().profiles.alpha.until > Date.now(), '又被限流：记录更新成新的恢复时间');
});

test('3 路由链里没有别的可用执行者：任务失败，原因写明，不空转', t => {
  const f = fixture(t);
  f.config(config => {
    delete config.profiles.beta;
    config.defaultProfile = 'alpha';
    config.routing = { rules: [{ types: ['docs'], profile: 'alpha' }], fallback: null, reviewer: null, strongExecutor: null };
  });
  const task = f.dispatch('lim3', 2, 1);
  assert.deepEqual(task.attempts.map(row => row.profile), ['alpha'], '只跑了一次，没有拿同一个被限流的执行者再试');
  assert.equal(task.end.exit, 1);
  assert.equal(Object.hasOwn(task.end, 'handBack'), false);
  assert.match(task.progress, /甲执行者 被限流（额度到 (?:\d+月\d+日 )?\d{2}:\d{2} 恢复），不换执行者：所有可用执行者都被限流或不可用/);
  assert.match(task.stdout, /出错：所有可用执行者都被限流或不可用/);
  // 这次失败仍归环境，A 的恢复时间照记。
  assert.deepEqual(f.marks('lim3'), { v: 1, blame: { 1: 'environment' } });
  assert.deepEqual(Object.keys(f.limits().profiles), ['alpha']);
  assert.equal(task.rows.filter(row => row.event === 'spawned').length, 1);
});

test('4 网络错误：同一执行者一次不换（按普通失败重试），连续两次才换；不记恢复时间', t => {
  const f = fixture(t);
  // 4a 第 1 次网络错误，重试时好了：不换人，不归因，不记 limits。
  f.config(config => { config.profiles.alpha = failing(NETWORK_TEXT, { attempts: { 2: { events: [{ kind: 'say', text: '好了' }], report: 'OK\n', exit: 0 } } }); });
  const once = f.dispatch('lim4a', 2, 0);
  assert.deepEqual(once.attempts.map(row => [row.n, row.profile]), [[1, 'alpha'], [2, 'alpha']]);
  assert.ok(!once.progress.includes('换 beta'));
  assert.equal(f.marks('lim4a'), null);
  assert.equal(f.limits(), null);

  // 4b 连续两次：第 3 次换 B，前两次都归环境，仍不记恢复时间；换人不计重试。
  f.config(config => { config.profiles.alpha = failing(NETWORK_TEXT); });
  const twice = f.dispatch('lim4b', 2, 0);
  assert.deepEqual(twice.attempts.map(row => [row.n, row.profile, row.total]), [[1, 'alpha', 3], [2, 'alpha', 3], [3, 'beta', 4]]);
  assert.match(twice.progress, /甲执行者 连续两次服务不可用，换 beta，这次不计重试/);
  assert.deepEqual(f.marks('lim4b'), { v: 1, blame: { 1: 'environment', 2: 'environment' } });
  assert.equal(f.limits(), null, '服务不可用不记恢复时间，只换人');
  const report = f.report('lim4b');
  assert.equal(item(report.executor, 'attemptAgent').count, 0, '第 2、3 次的前一次都是环境原因');
  assert.equal(item(report.executor, 'envBlame').count, 2);
  assert.equal(report.executor.score, 100);
  // 下一个任务不会跳过 A（没有恢复时间）。
  assert.equal(f.dispatch('lim4c', 0, 1).attempts[0].profile, 'alpha');

  // 4d 中间隔了一次别的失败就不算连续：网络、普通失败、网络，不换人。
  f.config(config => {
    config.profiles.alpha = failing(NETWORK_TEXT, { attempts: { 2: { events: [{ kind: 'error', text: '测试没过' }], report: '', exit: 1 } } });
  });
  const apart = f.dispatch('lim4d', 2, 1);
  assert.deepEqual(apart.attempts.map(row => row.profile), ['alpha', 'alpha', 'alpha']);
  assert.equal(f.marks('lim4d'), null);
  assert.ok(!apart.progress.includes('连续两次服务不可用'));
});

test('5 明确 --profile A：照旧用 A，trace 有提示；A 再限流也不换人', t => {
  const f = fixture(t);
  const until = Date.now() + 3 * 3600000;
  recordLimit(f.home, 'alpha', { kind: 'limit', resetsAt: until, evidence: '429' }, Date.now());
  const task = f.dispatch('lim5', 2, 1, ['--profile', 'alpha']);
  assert.deepEqual(task.attempts.map(row => row.profile), ['alpha'], '没有悄悄换成 B');
  const trace = f.dispatchRecord('lim5').route.trace;
  assert.match(trace[0], /^alpha 被限流（额度到 (?:\d+月\d+日 )?\d{2}:\d{2} 恢复），按明确指定仍使用$/);
  assert.equal(trace.at(-1), '命令行指定：alpha');
  assert.match(task.progress, /不换执行者：这个任务明确指定了执行者/);
  assert.deepEqual(f.marks('lim5'), { v: 1, blame: { 1: 'environment' } });
  // 记录里的恢复时间没被缩短（取这次报错里的 2 小时，但 since 保留第一次）。
  assert.ok(f.limits().profiles.alpha.since <= Date.now());
  // 任务说明里写 worker: alpha 同样算明确指定。
  const rel = f.spec('lim5b', 2);
  write(path.join(f.repo, rel), ['---', 'id: 148', 'title: 限流换人测试', 'type: docs', 'worker: alpha', 'max_retries: 2', '---', '', '正文', ''].join('\n'));
  const r = f.ar(['dispatch', rel, '--name', 'lim5b']);
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  const pinned = f.info('lim5b');
  assert.deepEqual(pinned.attempts.map(row => row.profile), ['alpha']);
  assert.equal(f.dispatchRecord('lim5b').route.trace.at(-1), '任务说明指定：alpha');
  assert.match(pinned.progress, /不换执行者：这个任务明确指定了执行者/);
});

test('6 换人次数上限：最多换 5 次，第 6 个执行者也限流时停下', t => {
  const f = fixture(t);
  const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  f.config(config => {
    config.profiles = Object.fromEntries(names.map(name => [name, failing(LIMIT_TEXT, { label: `执行者${name}` })]));
    config.defaultProfile = 'p1';
    config.routing = { rules: names.map(profile => ({ types: ['docs'], profile })), fallback: null, reviewer: null, strongExecutor: null };
  });
  const task = f.dispatch('lim6', 3, 1);
  assert.deepEqual(task.attempts.map(row => row.profile), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], '1 次 + 换 5 次，p7 没有被用');
  assert.equal(task.progress.match(/这次不计重试/g).length, 5);
  assert.match(task.progress, /执行者p6 被限流（额度到 (?:\d+月\d+日 )?\d{2}:\d{2} 恢复），不换执行者：换执行者已到 5 次的上限/);
  assert.deepEqual(Object.keys(f.limits().profiles).sort(), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  assert.deepEqual(f.marks('lim6'), { v: 1, blame: { 1: 'environment', 2: 'environment', 3: 'environment', 4: 'environment', 5: 'environment', 6: 'environment' } });
  assert.equal(task.end.attempts, 6);
  assert.equal(Object.hasOwn(task.end, 'handBack'), false, '重试次数一次都没用，不提示"自动重试都没通过"');
});

test('7 Claude Code：rate_limit_event 的 status 是 rejected 就算限流（恢复时间取 resetsAt）；allowed 不算', t => {
  const f = fixture(t);
  const resets = Math.floor(Date.now() / 1000) + 5 * 3600;
  f.config(config => {
    config.profiles = {
      cc1: { adapter: 'claude-code', label: 'Claude 甲', enabled: true, env: { AR_LIMIT_MODE: 'rejected', AR_LIMIT_RESETS: String(resets) } },
      cc2: { adapter: 'claude-code', label: 'Claude 乙', enabled: true, env: { AR_LIMIT_MODE: 'ok' } },
    };
    config.defaultProfile = 'cc2';
    config.routing = { rules: [{ types: ['docs'], profile: 'cc1' }], fallback: 'cc2', reviewer: null, strongExecutor: null };
  });
  const task = f.dispatch('lim7', 0, 0);
  assert.deepEqual(task.attempts.map(row => row.profile), ['cc1', 'cc2']);
  // 报错文字里没有任何限流字样（Execution error），识别靠 rate_limit_event。
  assert.ok(!jsonl(path.join(f.repo, '.agent-runs', 'lim7', 'events.jsonl')).some(event => /429|limit/i.test(event.text ?? '')));
  const entry = f.limits().profiles.cc1;
  assert.equal(entry.until, resets * 1000, '恢复时间就是 resetsAt（unix 秒）');
  assert.match(entry.evidence, /status=rejected/);
  assert.match(task.progress, /Claude 甲 被限流（额度到 (?:\d+月\d+日 )?\d{2}:\d{2} 恢复），换 cc2，这次不计重试/);
  assert.deepEqual(f.marks('lim7'), { v: 1, blame: { 1: 'environment' } });

  // allowed 的 rate_limit_event + 普通失败：不是限流，不换人、不记录。
  const g = fixture(t);
  g.config(config => {
    config.profiles = { cc1: { adapter: 'claude-code', label: 'Claude 甲', enabled: true, env: { AR_LIMIT_MODE: 'allowed-fail' } }, cc2: { adapter: 'claude-code', label: 'Claude 乙', enabled: true, env: { AR_LIMIT_MODE: 'ok' } } };
    config.defaultProfile = 'cc2';
    config.routing = { rules: [{ types: ['docs'], profile: 'cc1' }], fallback: 'cc2', reviewer: null, strongExecutor: null };
  });
  const plain = g.dispatch('lim7b', 0, 1);
  assert.deepEqual(plain.attempts.map(row => row.profile), ['cc1']);
  assert.equal(g.limits(), null);
  assert.equal(g.marks('lim7b'), null);
});

test('8 Codex：usage limit 原文（样例来自 Codex 源码）算限流，"try again at 3:15 PM" 解析成恢复时间；换到下一个执行者', t => {
  const f = fixture(t);
  f.config(config => {
    config.profiles = {
      cx: { adapter: 'codex', label: 'Codex 甲', enabled: true, env: { AR_LIMIT_MODE: 'codex-limit', AR_LIMIT_FIXTURE: codexFixture } },
      cc2: { adapter: 'claude-code', label: 'Claude 乙', enabled: true, env: { AR_LIMIT_MODE: 'ok' } },
    };
    config.defaultProfile = 'cc2';
    config.routing = { rules: [{ types: ['docs'], profile: 'cx' }], fallback: 'cc2', reviewer: null, strongExecutor: null };
  });
  const before = Date.now();
  const task = f.dispatch('lim8', 0, 0);
  assert.deepEqual(task.attempts.map(row => row.profile), ['cx', 'cc2']);
  const entry = f.limits().profiles.cx;
  const until = new Date(entry.until);
  assert.deepEqual([until.getHours(), until.getMinutes()], [15, 15], '本地时间 15:15');
  assert.ok(entry.until > before && entry.until - before <= 24 * 3600000 + 1000, '今天或明天的 15:15');
  assert.match(entry.evidence, /hit your usage limit/);
  assert.match(task.progress, /Codex 甲 被限流（额度到 (?:\d+月\d+日 )?15:15 恢复），换 cc2，这次不计重试/);
  // Codex 适配器自己的失败提示（中文）也写进了出错事件。
  assert.match(readFileSync(path.join(f.repo, '.agent-runs', 'lim8', 'events.jsonl'), 'utf8'), /Codex 的使用额度已用完/);
});

test('9 通用适配器：failureHints 带 kind 才算；没写 kind 的提示照旧只是提示', t => {
  const f = fixture(t);
  const generic = hints => ({ label: '通用甲', executable: process.execPath, detect: [textCli, '--version'], args: [textCli, '--fail', 'run', '{promptFile}'], output: { format: 'text' }, failureHints: hints });
  f.config(config => {
    config.generics = { gen: generic([{ match: 'not logged in', text: '额度用完了', kind: 'limit' }]) };
    config.profiles = { gen: { adapter: 'generic', generic: 'gen', label: '通用甲', enabled: true }, beta: succeeding() };
    config.defaultProfile = 'beta';
    config.routing = { rules: [{ types: ['docs'], profile: 'gen' }], fallback: 'beta', reviewer: null, strongExecutor: null };
  });
  const task = f.dispatch('lim9', 0, 0);
  assert.deepEqual(task.attempts.map(row => row.profile), ['gen', 'beta']);
  assert.equal(f.limits().profiles.gen.kind, 'limit');
  assert.match(task.progress, /通用甲 被限流（额度到 (?:\d+月\d+日 )?\d{2}:\d{2} 恢复），换 beta/);

  // 没写 kind：只是失败提示，不换人。
  const g = fixture(t);
  g.config(config => {
    config.generics = { gen: generic([{ match: 'not logged in', text: '请先登录' }]) };
    config.profiles = { gen: { adapter: 'generic', generic: 'gen', label: '通用甲', enabled: true }, beta: succeeding() };
    config.defaultProfile = 'beta';
    config.routing = { rules: [{ types: ['docs'], profile: 'gen' }], fallback: 'beta', reviewer: null, strongExecutor: null };
  });
  const plain = g.dispatch('lim9b', 0, 1);
  assert.deepEqual(plain.attempts.map(row => row.profile), ['gen']);
  assert.equal(g.limits(), null);
  assert.equal(existsSync(path.join(g.repo, '.agent-runs', 'lim9b', 'marks.json')), false);
});
