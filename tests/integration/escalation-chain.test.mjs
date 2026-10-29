import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../../core/lib/agents.mjs';
import { routeConfigCommand } from '../../core/lib/router.mjs';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// Stage07c T8（147）：默认升级链——自动重试先同样设置、再提高推理强度、最后一次换"强执行者"（设了才换）；都失败时提示主导接手。
// 失败的执行者是经假的 Claude Code（AR_TEST_AGENT，总是 exit 1）跑的 deepseek 预设（有 effortOptions）；强执行者 / 升级目标用 fake 适配器。
// 隔离的 AGENT_ROUTER_HOME、USERPROFILE / HOME、CLAUDE_CONFIG_DIR，系统临时目录里的仓库；ar retry 只对测试自己的临时仓库调用。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const fixtureAgent = fileURLToPath(new URL('../fixtures/fake-claude-code.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, 'utf8'); };
const jsonl = file => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

const STRONG = { adapter: 'fake', label: '强执行者', enabled: true, events: [{ kind: 'say', text: '强执行者完成' }], report: '强汇报\n', exit: 0 };
const HAND_BACK = '自动重试都没通过，建议主导接手';

function fixture(t) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-chain-147-'));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home'), user = path.join(base, 'user');
  // user/AppData 先建好：--detach 派发的 7b 里它偶发在任务运行中才出现，被"工作区外写入检查"当成新文件而停止自动重试（谁建的没查到，日志在汇报里）。
  for (const dir of [repo, home, user, path.join(user, 'AppData')]) mkdirSync(dir);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_)/i.test(key)) delete env[key];
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'HOMEDRIVE', 'HOMEPATH']) delete env[key];
  Object.assign(env, {
    AGENT_ROUTER_HOME: home, USERPROFILE: user, HOME: user, APPDATA: user, CLAUDE_CONFIG_DIR: path.join(user, 'claude'), AR_NO_WATCH: '1',
    AR_TEST_AGENT: fixtureAgent, AR_TEST_ENV_REPORT: path.join(base, 'report.json'), AR_TEST_EXIT: '1', DEEPSEEK_API_KEY: 'sk-test-147',
  });
  assert.equal(path.dirname(env.AGENT_ROUTER_HOME), base, '隔离目录在临时目录里');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '升级链测试']);
  git(repo, ['config', 'user.email', 'chain-147@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'a.txt'), '初始\n');
  git(repo, ['add', '.gitignore', 'a.txt']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  const f = { base, repo, home, env };
  // deepseek（经假的 Claude Code，总是失败）+ 强执行者 strong（fake，成功）；patch 里再改。
  f.config = patch => {
    const config = { v: 2, managed: false, watchWindow: 'never', defaultProfile: 'deepseek',
      profiles: { deepseek: { ...loadPreset('deepseek').profile, effort: 'high' }, strong: structuredClone(STRONG) },
      routing: { rules: [], fallback: null, reviewer: null, strongExecutor: 'strong' } };
    patch?.(config);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  };
  f.readConfig = () => JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
  f.ar = args => spawnSync(process.execPath, [script, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 90000, windowsHide: true, shell: false });
  f.spec = (name, maxRetries) => {
    const rel = `docs/specs/${name}.md`;
    write(path.join(repo, rel), ['---', 'id: 147', 'title: 升级链测试', 'type: docs', `max_retries: ${maxRetries}`, '---', '', '正文', ''].join('\n'));
    return rel;
  };
  // 派发一个会失败的任务，返回 { name, id, rows, attempts, end, progress }。
  f.dispatch = (name, maxRetries, expectExit) => {
    const r = f.ar(['dispatch', f.spec(name, maxRetries), '--name', name]);
    if (expectExit !== undefined) assert.equal(r.status, expectExit, `${r.stdout}\n${r.stderr}`);
    return f.info(name);
  };
  f.info = name => {
    const all = jsonl(path.join(home, 'runs.jsonl'));
    const start = all.find(row => row.event === 'start' && row.name === name);
    const rows = all.filter(row => row.id === start.id);
    return { name, start, rows, attempts: rows.filter(row => row.event === 'attempt'), end: rows.at(-1), progress: f.progress(name) };
  };
  f.progress = name => readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  f.report = name => readFileSync(path.join(repo, '.agent-runs', name, 'report.md'), 'utf8');
  f.prompt = (name, n) => readFileSync(path.join(repo, '.agent-runs', name, 'attempts', String(n), 'prompt.md'), 'utf8');
  f.agentArgs = () => JSON.parse(readFileSync(env.AR_TEST_ENV_REPORT, 'utf8')).args;
  t.after(async () => {
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(realpathSync.native(os.tmpdir()), base).startsWith('ar-chain-147-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  f.config();
  return f;
}

test('1 maxRetries 2、有强执行者：第 2 次尝试同样设置，第 3 次换强执行者（不升档）；进度、attempt、prompt 都有记录', t => {
  const f = fixture(t);
  const task = f.dispatch('chain1', 2, 0);
  assert.deepEqual(task.attempts.map(row => [row.n, row.profile]), [[1, 'deepseek'], [2, 'deepseek'], [3, 'strong']]);
  // attempt 事件：只有升级链提高过强度之后才多 effort 与来源"升级链"；这里一次都没升，三次都没有。
  for (const row of task.attempts) {
    assert.equal(Object.hasOwn(row, 'effort'), false);
    assert.equal(Object.hasOwn(row, 'settingSources'), false);
  }
  // start 记的是派发时的生效值。
  assert.equal(task.start.effort, 'high');
  // 进度：换强执行者一行，没有提高强度；分隔行里的执行者也对。
  assert.match(task.progress, /最后一次重试：换强执行者 strong/);
  assert.ok(!task.progress.includes('提高推理强度'), '换人那次不升档，第 1 次重试也不升档');
  assert.match(task.progress, /=== 第 3 次尝试（执行者：强执行者；原因：执行者异常退出（exit 1））===/);
  // 重试指令：第 2 次与原始指令只差失败原因段（没有升级说明），第 3 次补了换人这一句。
  assert.ok(!f.prompt('chain1', 2).includes('这一次已把推理强度'));
  assert.ok(!f.prompt('chain1', 2).includes('这一次换成了另一个执行者'));
  assert.match(f.prompt('chain1', 3), /这一次换成了另一个执行者（强执行者）接手。/);
  assert.ok(!f.prompt('chain1', 1).includes('这一次'), '第 1 次是原始指令');
  // 成功结束：没有 handBack。
  assert.equal(task.end.exit, 0);
  assert.equal(task.end.attempts, 3);
  assert.equal(Object.hasOwn(task.end, 'handBack'), false);
  assert.ok(!task.progress.includes(HAND_BACK));

  // maxRetries 3：第 2 次同样，第 3 次升一档，第 4 次换强执行者（沿用升档后的设置）。
  const long = f.dispatch('chain1b', 3, 0);
  assert.deepEqual(long.attempts.map(row => [row.n, row.profile, row.effort]), [[1, 'deepseek', undefined], [2, 'deepseek', undefined], [3, 'deepseek', 'xhigh'], [4, 'strong', 'xhigh']]);
  assert.deepEqual(long.attempts[2].settingSources, { model: '内置默认', effort: '升级链' });
  assert.match(long.progress, /第 2 次重试：提高推理强度 high → xhigh/);
  assert.match(long.progress, /最后一次重试：换强执行者 strong/);
  assert.ok(long.progress.indexOf('提高推理强度') < long.progress.indexOf('换强执行者'));
  assert.ok(!/第 1 次重试：提高/.test(long.progress) && !/第 3 次重试：提高/.test(long.progress), '进度里的"第 N 次重试"按重试序号写');
  assert.match(f.prompt('chain1b', 3), /这一次已把推理强度从 high 提高到 xhigh。/);
  assert.match(f.prompt('chain1b', 4), /这一次换成了另一个执行者（强执行者）接手。/);
  assert.equal(long.end.attempts, 4);
  assert.equal(Object.hasOwn(long.end, 'handBack'), false);
});

test('2 没设强执行者：最后一次仍用原执行者（强度继续升）；全部失败后 end.handBack 为 true，进度与汇报末尾有提示', t => {
  const f = fixture(t);
  f.config(config => { config.routing.strongExecutor = null; });
  const task = f.dispatch('chain2', 2, 1);
  assert.deepEqual(task.attempts.map(row => [row.n, row.profile]), [[1, 'deepseek'], [2, 'deepseek'], [3, 'deepseek']]);
  assert.match(task.progress, /没有设强执行者，最后一次仍用 deepseek/);
  assert.match(task.progress, /第 2 次重试：提高推理强度 high → xhigh/);
  assert.deepEqual(task.attempts.map(row => row.effort), [undefined, undefined, 'xhigh'], '第 2 次尝试不升档，第 3 次升一档');
  assert.deepEqual(f.agentArgs().slice(-2), ['--effort', 'xhigh'], '最后一次真的用提高后的强度启动执行者');
  assert.equal(task.end.exit, 1);
  assert.equal(task.end.handBack, true);
  assert.ok(f.progress('chain2').trimEnd().split('\n').some(line => line.endsWith(HAND_BACK)), '进度里有提示');
  assert.ok(task.progress.indexOf(HAND_BACK) < task.progress.indexOf('结束：exit=1'), '提示在页脚之前');
  assert.ok(f.report('chain2').trimEnd().endsWith(HAND_BACK), '汇报末尾有提示');

  // maxRetries 3：第 3、4 次尝试各升一档（high → xhigh → max）。
  const long = f.dispatch('chain2b', 3, 1);
  assert.deepEqual(long.attempts.map(row => row.effort), [undefined, undefined, 'xhigh', 'max']);
  assert.match(long.progress, /第 2 次重试：提高推理强度 high → xhigh/);
  assert.match(long.progress, /第 3 次重试：提高推理强度 xhigh → max/);
  assert.deepEqual(f.agentArgs().slice(-2), ['--effort', 'max']);
  assert.equal(long.end.handBack, true);

  // maxRetries 1、没有强执行者：唯一一次重试同样强度、不升档。
  const one = f.dispatch('chain2c', 1, 1);
  assert.deepEqual(one.attempts.map(row => [row.profile, row.effort]), [['deepseek', undefined], ['deepseek', undefined]]);
  assert.match(one.progress, /没有设强执行者，最后一次仍用 deepseek/);
  assert.ok(!one.progress.includes('提高推理强度'));
  assert.deepEqual(f.agentArgs().slice(-2), ['--effort', 'high']);
  assert.equal(one.end.handBack, true);
});

test('3 执行者配置写了 escalate：最后一次用 escalate，不用强执行者；提高强度照做', t => {
  const f = fixture(t);
  f.config(config => {
    config.profiles.deepseek.escalate = 'helper';
    config.profiles.helper = { ...structuredClone(STRONG), label: '升级目标' };
  });
  const task = f.dispatch('chain3', 3, 0);
  assert.deepEqual(task.attempts.map(row => [row.n, row.profile]), [[1, 'deepseek'], [2, 'deepseek'], [3, 'deepseek'], [4, 'helper']]);
  assert.match(task.progress, /第 2 次重试：提高推理强度 high → xhigh/);
  assert.match(task.progress, /最后一次重试：换升级目标 helper/);
  assert.ok(!task.progress.includes('换强执行者'), '没有换强执行者');
  assert.ok(!task.progress.includes('没有设强执行者'));
  // 升级目标不可用时也不退到强执行者：进度沿用原来的"升级：… 没有启用"一行，最后一次仍用原执行者。
  f.config(config => {
    config.profiles.deepseek.escalate = 'helper';
    config.profiles.helper = { ...structuredClone(STRONG), enabled: false };
  });
  const off = f.dispatch('chain3b', 2, 1);
  assert.deepEqual(off.attempts.map(row => row.profile), ['deepseek', 'deepseek', 'deepseek']);
  assert.match(off.progress, /升级：helper 没有启用，继续用 /);
  assert.ok(!off.progress.includes('换强执行者'));
  assert.equal(off.end.handBack, true);
});

test('4 已是最高档：跳过升档，进度写明；没有明确的推理强度同样跳过', t => {
  const f = fixture(t);
  f.config(config => { config.profiles.deepseek.effort = 'max'; });
  const top = f.dispatch('chain4', 3, 0);
  assert.match(top.progress, /第 2 次重试：推理强度已是最高档（max），不再提高/);
  assert.match(top.progress, /最后一次重试：换强执行者 strong/);
  assert.deepEqual(top.attempts.map(row => row.profile), ['deepseek', 'deepseek', 'deepseek', 'strong']);
  assert.ok(top.attempts.every(row => !Object.hasOwn(row, 'effort')), '没提高过：attempt 事件没有 effort');
  assert.ok(!f.prompt('chain4', 3).includes('提高到'), '没提高就不补这句');
  // 没有明确的推理强度（配置里没写）。
  f.config(config => { delete config.profiles.deepseek.effort; });
  const none = f.dispatch('chain4b', 3, 0);
  assert.match(none.progress, /第 2 次重试：没有明确的推理强度/);
  assert.deepEqual(none.attempts.map(row => row.profile), ['deepseek', 'deepseek', 'deepseek', 'strong']);
  // maxRetries 1：第 2 次就是最后一次，直接换强执行者（不升档）。
  f.config(config => { config.profiles.deepseek.effort = 'high'; });
  const one = f.dispatch('chain4c', 1, 0);
  assert.match(one.progress, /最后一次重试：换强执行者 strong/);
  assert.ok(!one.progress.includes('提高推理强度'));
  assert.deepEqual(one.attempts.map(row => row.profile), ['deepseek', 'strong']);
  // 配置里写 auto 同样算没有明确的强度。
  f.config(config => { config.profiles.deepseek.effort = 'auto'; config.routing.strongExecutor = null; });
  assert.match(f.dispatch('chain4d', 2, 1).progress, /第 2 次重试：没有明确的推理强度/);
});

test('5 强执行者自己的任务：不换人，失败后 handBack', t => {
  const f = fixture(t);
  f.config(config => { config.routing.strongExecutor = 'deepseek'; });
  const task = f.dispatch('chain5', 2, 1);
  assert.deepEqual(task.attempts.map(row => row.profile), ['deepseek', 'deepseek', 'deepseek']);
  assert.match(task.progress, /最后一次重试：本任务的执行者就是强执行者 deepseek，不换人/);
  assert.equal(task.end.handBack, true);
  assert.ok(f.report('chain5').trimEnd().endsWith(HAND_BACK));
});

test('6 强执行者已停用（或已被删除）：按没有强执行者处理，进度写明', t => {
  const f = fixture(t);
  f.config(config => { config.profiles.strong.enabled = false; });
  const off = f.dispatch('chain6', 2, 1);
  assert.deepEqual(off.attempts.map(row => row.profile), ['deepseek', 'deepseek', 'deepseek']);
  assert.match(off.progress, /强执行者 strong 已停用，按没有强执行者处理，最后一次仍用 deepseek/);
  assert.equal(off.end.handBack, true);
  f.config(config => { delete config.profiles.strong; });
  const gone = f.dispatch('chain6b', 2, 1);
  assert.deepEqual(gone.attempts.map(row => row.profile), ['deepseek', 'deepseek', 'deepseek']);
  assert.match(gone.progress, /强执行者 strong 不存在，按没有强执行者处理/);
  assert.equal(gone.end.handBack, true);
});

test('7 手动 ar retry 不走升级链：不提高强度、不换人，也不写 handBack', t => {
  const f = fixture(t);
  const task = f.dispatch('chain7', 2, 0);
  assert.equal(task.attempts.length, 3);
  // 第 3 次已经换了强执行者并成功；手动重试要求完成的任务写 --note，沿用最后一次的执行者配置（strong）。
  const retried = f.ar(['retry', 'chain7', '--note', '再来一次']);
  assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
  const after = f.info('chain7');
  const manual = after.attempts.at(-1);
  assert.equal(manual.n, 4);
  assert.equal(manual.reason, 'manual');
  assert.equal(manual.total, null);
  assert.equal(Object.hasOwn(manual, 'effort'), false, '手动重试的 attempt 没有升级链的强度');
  const section = after.progress.slice(after.progress.lastIndexOf('=== 第 4 次尝试'));
  assert.ok(!/提高推理强度|换强执行者|没有设强执行者|重试：/.test(section), `手动重试这一段没有升级链的行：${section}`);
  // 用 deepseek 再试一次：失败时也不写 handBack、不提高强度。
  const again = f.ar(['retry', 'chain7', '--profile', 'deepseek', '--note', '换回原来的执行者']);
  assert.equal(again.status, 1, `${again.stdout}\n${again.stderr}`);
  const last = f.info('chain7');
  assert.equal(last.attempts.at(-1).profile, 'deepseek');
  assert.deepEqual(f.agentArgs().slice(-2), ['--effort', 'high'], '用配置里原来的强度');
  assert.equal(Object.hasOwn(last.end, 'handBack'), false);
  assert.ok(!last.progress.slice(last.progress.lastIndexOf('=== 第 5 次尝试')).includes(HAND_BACK));
});

test('7b --detach 派发：强执行者与推理强度档位随请求快照带给执行者进程，同样走升级链', async t => {
  const f = fixture(t);
  const detached = f.ar(['dispatch', f.spec('chain9', 3), '--name', 'chain9', '--detach']);
  assert.equal(detached.status, 0, `${detached.stdout}\n${detached.stderr}`);
  for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    if (jsonl(path.join(f.home, 'runs.jsonl')).some(row => row.event === 'start' && row.name === 'chain9')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const waited = f.ar(['wait', 'chain9']);
  assert.equal(waited.status, 0, `${waited.stdout}\n${waited.stderr}\n${f.progress('chain9')}\n${JSON.stringify(f.info('chain9').rows)}`);
  const task = f.info('chain9');
  assert.deepEqual(task.attempts.map(row => [row.n, row.profile, row.effort]), [[1, 'deepseek', undefined], [2, 'deepseek', undefined], [3, 'deepseek', 'xhigh'], [4, 'strong', 'xhigh']]);
  assert.match(task.progress, /第 2 次重试：提高推理强度 high → xhigh/);
  assert.match(task.progress, /最后一次重试：换强执行者 strong/);
});

test('8 ar route strong set / clear 写入 routing.strongExecutor，校验名字；route config 多一行', t => {
  const f = fixture(t);
  f.config(config => { config.routing.strongExecutor = null; config.routing.rules = [{ types: ['docs'], profile: 'deepseek' }]; });
  const before = f.readConfig();
  const config = () => routeConfigCommand(['config'], { home: f.home });
  assert.equal(config().result.strongExecutor, null);
  assert.match(config().text, /^强执行者：未设置/m);

  const set = routeConfigCommand(['strong', 'set', 'strong'], { home: f.home });
  assert.equal(set.text, '已设置强执行者：strong');
  assert.equal(set.result.strongExecutor, 'strong');
  assert.deepEqual(f.readConfig(), { ...before, routing: { ...before.routing, strongExecutor: 'strong' } }, '只改 routing.strongExecutor，其余原样');
  assert.match(config().text, /^强执行者：strong（强执行者）$/m);

  // 不存在的执行者被拒绝，配置一个字节都不变。
  const text = readFileSync(path.join(f.home, 'config.json'), 'utf8');
  assert.throws(() => routeConfigCommand(['strong', 'set', 'ghost'], { home: f.home }), /找不到执行者：ghost/);
  assert.equal(readFileSync(path.join(f.home, 'config.json'), 'utf8'), text);
  // 写法不对给用法。
  assert.throws(() => routeConfigCommand(['strong', 'set'], { home: f.home }), /ar route strong set <执行者名> \| clear/);
  assert.throws(() => routeConfigCommand(['strong', 'clear', 'x'], { home: f.home }), /ar route strong set/);
  assert.throws(() => routeConfigCommand(['strong'], { home: f.home }), /ar route strong set/);

  const cleared = routeConfigCommand(['strong', 'clear'], { home: f.home });
  assert.equal(cleared.text, '已清除强执行者');
  assert.equal(f.readConfig().routing.strongExecutor, null);
  assert.deepEqual({ ...f.readConfig(), routing: { ...f.readConfig().routing, strongExecutor: undefined } }.profiles, before.profiles);
  assert.equal(config().result.strongExecutor, null);

  // route config 已有的几行文字原样还在（只加行）。
  const lines = config().text.split('\n');
  assert.equal(lines[0], '规则：1 条');
  assert.match(lines[1], /^ {2}1\. \[docs\] → deepseek$/);
  assert.match(lines[2], /^兜底：无/);
  assert.match(lines[3], /^审查者候选：无/);
  assert.match(lines[4], /^强执行者：未设置/);
  assert.match(lines[5], /^执行者 deepseek：/);
});

test('8b 从命令行跑 ar route strong set / clear：写入配置，--json 输出，名字不存在时失败且不改配置', t => {
  const f = fixture(t);
  f.config(config => { config.routing.strongExecutor = null; });
  const set = f.ar(['route', 'strong', 'set', 'strong']);
  assert.equal(set.status, 0, `${set.stdout}\n${set.stderr}`);
  assert.match(set.stdout, /已设置强执行者：strong/);
  assert.equal(f.readConfig().routing.strongExecutor, 'strong');
  const shown = f.ar(['route', 'config', '--json']);
  assert.equal(shown.status, 0, `${shown.stdout}\n${shown.stderr}`);
  assert.equal(JSON.parse(shown.stdout).strongExecutor, 'strong');

  const text = readFileSync(path.join(f.home, 'config.json'), 'utf8');
  const bad = f.ar(['route', 'strong', 'set', 'ghost']);
  assert.notEqual(bad.status, 0);
  assert.match(`${bad.stdout}${bad.stderr}`, /找不到执行者：ghost/);
  assert.equal(readFileSync(path.join(f.home, 'config.json'), 'utf8'), text, '失败时配置一个字节都不变');

  const cleared = f.ar(['route', 'strong', 'clear', '--json']);
  assert.equal(cleared.status, 0, `${cleared.stdout}\n${cleared.stderr}`);
  assert.equal(JSON.parse(cleared.stdout).strongExecutor, null);
  assert.equal(f.readConfig().routing.strongExecutor, null);
  assert.match(f.ar(['help']).stdout + f.ar(['--help']).stdout, /ar route strong set <名>\|clear/);
});