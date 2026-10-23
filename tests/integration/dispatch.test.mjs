import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codex, mapLine, limitOutput, shortCommand, resolveLauncher } from '../../core/adapters/codex.mjs';
import { loadConfig, homeDirectory } from '../../core/lib/config.mjs';
import { dispatcher, parseArgs, taskDetails } from '../../core/lib/options.mjs';
import { formatProgress } from '../../core/lib/progress.mjs';
import { recordPaths, registryWriter } from '../../core/lib/records.mjs';
import { viewerTakesOver, shouldWatch, watchCommand, latestWatchScript } from '../../core/lib/watch.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(project, 'core/ar.mjs');
const fixture = name => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const samples = ['codex-sample.jsonl', 'codex-extra.jsonl'].map(fixture);
const sampleLines = samples.flatMap(file => fs.readFileSync(file, 'utf8').trimEnd().split('\n'));
const jsonl = file => fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);

function setup(t) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'dispatch 测试 '));
  assert.ok(path.isAbsolute(base));
  t.after(() => {
    // 仅清理由本测试创建、位于系统临时目录中的目录。
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const root = path.join(base, '示例 仓库'), home = path.join(base, '公共 配置');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const fake = path.join(base, '假 agent.mjs');
  fs.copyFileSync(fixture('fake-agent.txt'), fake);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CODEX_|^CLAUDECODE$|^CLAUDE_CODE_SESSION_ID$|^FAKE_/.test(k)) delete env[k];
  // 开发者的终端里可能设着派发用的新名；本用例只设旧名，必须删掉新名，否则新名优先（协议 1）。
  // 复制出来的是普通对象，Windows 上要自己按不区分大小写删。
  for (const key of Object.keys(env)) if (process.platform === 'win32' ? key.toLowerCase() === 'agent_router_home' : key === 'AGENT_ROUTER_HOME') delete env[key];
  Object.assign(env, { USERPROFILE: base, HOME: base, APPDATA: base, CLAUDE_CONFIG_DIR: path.join(base, 'claude'), CODEX_HOME: path.join(base, 'codex'), XDG_CONFIG_HOME: base, CODEX_DISPATCH_HOME: home, CODEX_NO_WATCH: '1', CODEX_DISPATCH_TEST_AGENT: fake,
    FAKE_ECHO: path.join(base, 'argv.json'), FAKE_FIXTURES: JSON.stringify(samples) });
  for (const key of ['USERPROFILE', 'HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'CODEX_DISPATCH_HOME']) {
    const relative = path.relative(path.resolve(tmpdir()), env[key]);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  const config = value => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(value));
  config({ v: 2, defaultProfile: 'codex', profiles: { codex: { adapter: 'codex', label: 'Codex', enabled: true } } });
  const invoke = (args = [], overrides = {}, script = entry) => spawnSync(process.execPath, [script, '只回复 OK', '--name', '中文 记录', ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000, windowsHide: true, shell: false,
  });
  return { base, root, home, env, config, invoke };
}

test('端到端：参数完整、清单兼容、事件顺序、原始日志和汇报', t => {
  const s = setup(t), result = s.invoke(['--host', 'claude-code'], { CLAUDE_CODE_SESSION_ID: 'fake-session' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /DEP0190/);
  const rows = jsonl(path.join(s.home, 'runs.jsonl'));
  assert.deepEqual(rows.map(e => e.event), ['start', 'attempt', 'spawned', 'attempt-end', 'end']);
  const [start, , spawned, , end] = rows;
  for (const key of ['repo', 'progress', 'report', 'raw', 'events']) assert.ok(path.isAbsolute(start[key]), key);
  assert.equal(start.name, '中文 记录');
  assert.equal(start.progress, path.join(s.root, '.agent-runs', '中文 记录', 'progress.log')); assert.equal(start.report, path.join(s.root, '.agent-runs', '中文 记录', 'report.md'));
  assert.equal(start.raw, path.join(s.root, '.agent-runs', '中文 记录', 'raw.log')); assert.equal(start.events, path.join(s.root, '.agent-runs', '中文 记录', 'events.jsonl'));
  assert.equal(start.v, 2); assert.equal(start.dir, path.join(s.root, '.agent-runs', '中文 记录')); assert.equal(start.project, '示例 仓库'); assert.equal(start.adapter, 'codex'); assert.equal(start.profile, 'codex');
  assert.equal(spawned.v, 1); assert.equal(end.v, 1);
  for (const key of ['spec', 'role', 'model', 'effort', 'tier']) assert.equal(start[key], null);
  for (const key of ['pid', 'started']) assert.ok(Number.isFinite(start[key]));
  assert.equal(start.agent, 'codex'); assert.equal(start.agentVersion, 'codex-cli test-fixture');
  assert.equal(start.sandbox, 'workspace-write'); assert.equal(start.title, '只回复 OK');
  assert.deepEqual(start.dispatcher, { host: 'claude-code', session: 'fake-session' });
  assert.equal(spawned.agentPid, spawned.codexPid); assert.ok(spawned.agentPid > 0);
  assert.equal(end.id, start.id); assert.equal(spawned.id, start.id); assert.equal(end.exit, 0);
  assert.equal(fs.readFileSync(start.report, 'utf8'), 'OK\n');
  const echo = JSON.parse(fs.readFileSync(s.env.FAKE_ECHO, 'utf8'));
  // 058：汇报路径指到第 1 次尝试的 attempts/1/report.md（顶层 report.md 是复制过去的最新一份）。
  assert.deepEqual(echo.args, ['exec', '--json', '-C', s.root, '-s', 'workspace-write', '-o', path.join(start.dir, 'attempts', '1', 'report.md'), '-']);
  assert.equal(echo.prompt, '任务：\n只回复 OK');
  const events = jsonl(start.events);
  events.forEach((e, n) => { assert.equal(e.seq, n + 1); assert.equal(e.v, 1); assert.ok(e.at >= start.started); });
  assert.deepEqual(new Set(events.map(e => e.kind)), new Set(['say', 'think', 'cmd', 'file', 'plan', 'tool', 'turn', 'error', 'text']));
  const commands = events.filter(e => e.kind === 'cmd');
  assert.deepEqual(commands.map(e => e.phase), ['start', 'end', 'start', 'end']);
  assert.equal(commands[0].id, commands[1].id); assert.equal(commands[2].id, commands[3].id);
  assert.equal(commands[1].exit, 0); assert.notEqual(commands[3].exit, 0);
  assert.equal(commands[0].command, 'node check.mjs');
  assert.equal(commands[1].output, '验证通过\n'); assert.equal(commands[1].truncated, false);
  assert.equal(events.find(e => e.kind === 'say').text, '已检查示例仓库。\n接下来执行验证。');
  const raw = fs.readFileSync(start.raw, 'utf8').trimEnd().split('\n');
  assert.equal(raw.length, sampleLines.length);
  raw.forEach((line, n) => {
    if (!sampleLines[n].startsWith('{')) { assert.equal(line, sampleLines[n]); return; }
    const parsed = JSON.parse(line), { _at, ...original } = parsed;
    assert.ok(Number.isFinite(_at)); assert.deepEqual(original, JSON.parse(sampleLines[n]));
  });
});

test('固定进度标准答案：与定稿协议逐行一致', t => {
  const s = setup(t); assert.equal(s.invoke().status, 0);
  const current = fs.readFileSync(path.join(s.root, '.agent-runs/中文 记录/progress.log'), 'utf8');
  const normalize = text => text.replace(/\[\d{2}:\d{2}:\d{2}\] /g, '').replace(/  \d{4}\/.* ===\n/, '  <时间> ===\n')
    .replace(/用时 [\d.]+ 分钟，汇报在 .* ===/, '用时 <分钟> 分钟，汇报在 <路径> ===');
  assert.equal(normalize(current), fs.readFileSync(fixture('expected-progress.txt'), 'utf8').replaceAll('\r\n', '\n'));
});

test('配置优先级：命令行 > 环境变量 > 文件 > 默认；null 不传模型参数', t => {
  const s = setup(t);
  s.config({ v: 1, agents: { codex: { model: 'file-model', effort: 'low', tier: 'default', sandbox: 'read-only' } }, watchWindow: 'never' });
  const env = { CODEX_MODEL: 'env-model', CODEX_EFFORT: 'medium', CODEX_TIER: 'env-tier', CODEX_SANDBOX: 'workspace-write' };
  assert.equal(s.invoke(['--model', 'cli-model', '--effort', 'high', '--tier', 'cli-tier', '--sandbox', 'read-only'], env).status, 0);
  const row = jsonl(path.join(s.home, 'runs.jsonl'))[0];
  assert.equal(row.model, 'cli-model'); assert.equal(row.effort, 'high'); assert.equal(row.tier, 'cli-tier'); assert.equal(row.sandbox, 'read-only');
  const args = JSON.parse(fs.readFileSync(s.env.FAKE_ECHO, 'utf8')).args;
  assert.ok(args.includes('model_reasoning_effort="high"')); assert.ok(args.includes('service_tier="cli-tier"'));
  assert.equal(loadConfig(s.home, {}, env).settings.model, 'env-model');
  assert.equal(loadConfig(s.home, {}, {}).settings.model, 'file-model');
  assert.equal(loadConfig(s.home, {}, { CODEX_NO_WATCH: '1' }).settings.watchWindow, 'never');
  assert.equal(loadConfig(s.home, { 'watch-window': 'always' }, { CODEX_NO_WATCH: '1' }).settings.watchWindow, 'always');
  s.config({ v: 1, agents: { codex: { model: null, effort: null, tier: null } } });
  const settings = loadConfig(s.home, {}, {}).settings;
  assert.deepEqual(settings, { model: null, effort: null, tier: null, sandbox: 'workspace-write', path: null, watchWindow: 'auto' });
  const command = codex.command({ root: s.root, report: path.join(s.root, '汇报.md'), prompt: 'OK', settings, env: s.env });
  assert.ok(!command.args.includes('-m')); assert.ok(!command.args.includes('-c'));
});

test('配置缺失只提示一次继续完成任务；配置无效拒绝派发（协议第 4 节，063）', t => {
  const s = setup(t);
  // 没有 config.json：行为不变，按内置默认继续完成任务，只提示一次。
  fs.unlinkSync(path.join(s.home, 'config.json'));
  let result = s.invoke(); assert.equal(result.status, 0, result.stderr);
  let start = jsonl(path.join(s.home, 'runs.jsonl')).filter(e => e.event === 'start').at(-1);
  assert.equal((fs.readFileSync(start.progress, 'utf8').match(/配置：/g) ?? []).length, 1);
  assert.equal(start.model, null);
  // 文件存在却读不了：不再按内置默认继续，拒绝派发，不留下记录。
  for (const invalid of ['{', '{"v":3}']) {
    fs.writeFileSync(path.join(s.home, 'config.json'), invalid);
    const rows = jsonl(path.join(s.home, 'runs.jsonl')).length;
    result = s.invoke(); assert.equal(result.status, 2);
    assert.ok(result.stderr.includes('配置：config.json 无法读取'), result.stderr);
    assert.ok(result.stderr.includes('这次没有派发'), result.stderr);
    assert.equal(jsonl(path.join(s.home, 'runs.jsonl')).length, rows, '没有新的清单行');
  }
});

test('重名追加序号，dry-run 不创建目录或修改已有文件', t => {
  const s = setup(t);
  assert.equal(s.invoke([], { CODEX_DRY_RUN: '1' }).status, 0);
  assert.ok(!fs.existsSync(path.join(s.root, '.agent-runs')));
  assert.ok(!fs.existsSync(path.join(s.home, 'runs.jsonl')));
  assert.ok(!fs.existsSync(s.env.FAKE_ECHO));
  assert.equal(s.invoke().status, 0);
  const first = path.join(s.root, '.agent-runs/中文 记录/progress.log'), before = fs.readFileSync(first);
  assert.match(s.invoke([], { CODEX_DRY_RUN: '1' }).stdout, /记录名：中文 记录-2/);
  assert.equal(s.invoke().status, 0); assert.equal(s.invoke().status, 0);
  assert.deepEqual(jsonl(path.join(s.home, 'runs.jsonl')).filter(e => e.event === 'start').map(e => e.name), ['中文 记录', '中文 记录-2', '中文 记录-3']);
  assert.deepEqual(fs.readFileSync(first), before);
});

test('并发派发独占记录名，不覆盖同名任务', async t => {
  const s = setup(t);
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, '只回复 OK', '--name', '同时 派发'], { cwd: s.root, env: s.env, stdio: 'ignore', windowsHide: true });
    child.on('error', reject); child.on('close', resolve);
  });
  assert.deepEqual(await Promise.all([launch(), launch()]), [0, 0]);
  const names = jsonl(path.join(s.home, 'runs.jsonl')).filter(e => e.event === 'start').map(e => e.name).sort();
  assert.deepEqual(names, ['同时 派发', '同时 派发-2']);
});

test('显式 host 优先，Claude 自动识别，会话不猜测', t => {
  const s = setup(t);
  const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'fake-session' };
  assert.deepEqual(dispatcher('claude-code', {}), { host: 'claude-code', session: null });
  assert.deepEqual(dispatcher(undefined, env), { host: 'claude-code', session: 'fake-session' });
  assert.deepEqual(dispatcher(undefined, {}), { host: 'unknown', session: null });
  assert.equal(s.invoke([], { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'fake-session' }).status, 0);
  assert.equal(jsonl(path.join(s.home, 'runs.jsonl'))[0].dispatcher.host, 'claude-code');
  assert.throws(() => parseArgs(['task', '--host', 'other']));
});

// 015：软件派发记 agentrouter（会话为空）；redispatch 的 --host 可选，不给时沿用原来的环境判断。
test('agentrouter 写进 start.dispatcher；redispatch --host 覆盖派活方', t => {
  const s = setup(t);
  const starts = () => jsonl(path.join(s.home, 'runs.jsonl')).filter(e => e.event === 'start');
  const run = args => spawnSync(process.execPath, [entry, ...args], { cwd: s.root, env: s.env, encoding: 'utf8', timeout: 15000, windowsHide: true, shell: false });
  // 显式 --host agentrouter：环境里有 CLAUDECODE 也以显式值为准，会话不猜。
  assert.equal(s.invoke(['--host', 'agentrouter'], { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'fake-session' }).status, 0);
  assert.deepEqual(starts()[0].dispatcher, { host: 'agentrouter', session: null });
  // redispatch 带 --host：再派一次的 start 记 agentrouter。
  const again = run(['redispatch', '中文 记录', '--host', 'agentrouter', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(starts().at(-1).name, '中文 记录-2');
  assert.deepEqual(starts().at(-1).dispatcher, { host: 'agentrouter', session: null });
  // 不带 --host：沿用原来的环境判断（这里没有 CLAUDECODE，记 unknown）。
  assert.equal(run(['redispatch', '中文 记录']).status, 0);
  assert.deepEqual(starts().at(-1).dispatcher, { host: 'unknown', session: null });
  // 非法取值仍然报错，不再派发。
  const before = starts().length;
  const bad = run(['redispatch', '中文 记录', '--host', 'other', '--json']);
  assert.notEqual(bad.status, 0);
  const value = JSON.parse(bad.stdout);
  assert.equal(value.ok, false);
  assert.match(value.error, /无效的派活方/);
  assert.equal(starts().length, before, '非法取值没有新记录');
});

test('codex-watch.cmd 只含 ASCII，编码脚本与原文一致，GBK 控制台下中文正常', t => {
  const file = path.join(project, 'core/ar-watch.cmd'), bytes = fs.readFileSync(file);
  assert.ok(bytes.every(b => b < 0x80), 'cmd 按控制台代码页读取，不能有非 ASCII 字符');
  const encoded = bytes.toString('ascii').match(/-EncodedCommand ([A-Za-z0-9+/=]+)\r\n/)[1];
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), latestWatchScript);
  if (process.platform !== 'win32') return;
  const empty = fs.mkdtempSync(path.join(tmpdir(), '进度 窗口 '));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  // 复现用户环境：代码页 936 下运行；stdin 为空时 -NoExit 的 PowerShell 读到结尾即退出。
  const result = spawnSync('cmd.exe', ['/d', '/c', `chcp 936 >nul & call "${file}" "${empty}"`], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true });
  assert.equal(result.stdout.split(/\r?\n/)[0], '还没有任务进度');
  assert.equal(result.stderr.replace(/#< CLIXML[\s\S]*/, '').trim(), '');
});

test('npm cmd 包装解析为 Node 入口，检测版本且没有 shell', t => {
  const s = setup(t), wrapper = path.join(s.base, 'npm 安装'); fs.mkdirSync(wrapper);
  fs.copyFileSync(fixture('fake-agent.txt'), path.join(wrapper, 'codex.js'));
  fs.writeFileSync(path.join(wrapper, 'codex.cmd'), '@echo off\n"%_prog%" "%dp0%\\codex.js" %*\n');
  assert.deepEqual(resolveLauncher({ PATH: wrapper }, 'win32'), { executable: process.execPath, args: [path.join(wrapper, 'codex.js')] });
  assert.equal(codex.detect({ env: s.env }).version, 'codex-cli test-fixture');
  assert.equal(codex.detect({ env: { PATH: '' } }).installed, false);
  fs.writeFileSync(path.join(wrapper, 'codex.cmd'), '@echo unsupported');
  assert.throws(() => resolveLauncher({ PATH: wrapper }, 'win32'), /无法解析/);
});

test('复制完整技能目录到其他路径后仍能直接运行', t => {
  const s = setup(t), copied = path.join(s.base, '其他 技能/codex-dispatch');
  // 逐项复制，避免当前 Windows 环境下 cpSync 对含中文的嵌套目标静默漏文件。
  const copyTree = (source, target) => {
    fs.mkdirSync(target, { recursive: true });
    for (const item of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, item.name), to = path.join(target, item.name);
      if (item.isDirectory()) copyTree(from, to);
      else fs.copyFileSync(from, to);
    }
  };
  copyTree(path.join(project, 'core'), copied);
  const result = s.invoke([], {}, path.join(copied, 'ar.mjs'));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(jsonl(path.join(s.home, 'runs.jsonl'))[0].dispatcher, { host: 'unknown', session: null });
});

test('退出前排空大块 stdout，保留最后事件；失败退出码传递', t => {
  const s = setup(t), result = s.invoke([], { FAKE_LARGE_FINAL: '1', FAKE_EXIT: '7', FAKE_STDERR: '1' });
  assert.equal(result.status, 7, result.stderr);
  const rows = jsonl(path.join(s.home, 'runs.jsonl'));
  const events = jsonl(rows[0].events);
  assert.equal(events.filter(e => e.kind === 'say').at(-1).text.length, 200000);
  assert.equal(events.at(-1).kind, 'error'); assert.equal(events.at(-1).text, '示例 stderr');
  assert.equal(rows.at(-1).exit, 7);
  assert.match(fs.readFileSync(rows[0].raw, 'utf8'), /示例 stderr/);
});

test('干活方启动即拒绝：stderr 原因进出错事件、进度和标准输出，并附中文提示', t => {
  const s = setup(t), refusal = 'Not inside a trusted directory and --skip-git-repo-check was not specified.';
  const result = s.invoke([], { FAKE_REFUSE: refusal });
  assert.equal(result.status, 1, result.stderr);
  const rows = jsonl(path.join(s.home, 'runs.jsonl'));
  assert.deepEqual(rows.map(e => e.event), ['start', 'attempt', 'spawned', 'attempt-end', 'end']);
  const errors = jsonl(rows[0].events).filter(e => e.kind === 'error').map(e => e.text);
  assert.equal(errors.length, 2);
  assert.equal(errors[0], refusal);
  assert.match(errors[1], /^当前目录不是 git 仓库/);
  const progress = fs.readFileSync(rows[0].progress, 'utf8');
  assert.match(progress, /出错：Not inside a trusted directory/);
  assert.match(progress, /出错：当前目录不是 git 仓库/);
  // 原因排在 exit 行之前，后台派发的派活方读输出就能看到。
  assert.match(result.stdout, /出错：Not inside a trusted directory[^\n]*\r?\n出错：当前目录不是 git 仓库[^\n]*\r?\nexit=1 /);
  // 成功的任务即使有 stderr 也不报错。
  const ok = s.invoke([], { FAKE_STDERR: '1' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stdout, /出错：/);
});

test('清单不能写入时任务照常完成；找不到 agent 时记录错误和 end', t => {
  const s = setup(t), blocked = path.join(s.base, '不能作为目录'); fs.writeFileSync(blocked, '占位');
  assert.doesNotThrow(() => registryWriter(blocked)({ event: 'start' }));
  assert.equal(s.invoke([], { CODEX_DISPATCH_HOME: blocked }).status, 0);
  const result = s.invoke([], { CODEX_DISPATCH_TEST_AGENT: '', PATH: '', Path: '' });
  assert.equal(result.status, 1, result.stderr);
  const rows = jsonl(path.join(s.home, 'runs.jsonl'));
  assert.deepEqual(rows.map(e => e.event), ['start', 'attempt', 'attempt-end', 'end']);
  assert.equal(jsonl(rows[0].events)[0].kind, 'error');
});

test('适配器不写汇报时用最后一条 say；spawn 错误也有完整结束记录', t => {
  const s = setup(t), wrapper = path.join(s.base, '测试 入口.mjs');
  const runURL = new URL('../../core/lib/run.mjs', import.meta.url).href;
  const adapterURL = new URL('../../core/adapters/codex.mjs', import.meta.url).href;
  fs.writeFileSync(wrapper, `import { run } from ${JSON.stringify(runURL)};
import { codex } from ${JSON.stringify(adapterURL)};
const adapter = { ...codex, writesReport: false };
if (process.env.FAKE_SPAWN_ERROR) adapter.command = () => ({ executable: ${JSON.stringify(path.join(s.base, '不存在.exe'))}, args: [], stdin: '' });
process.exitCode = await run({ adapter, scriptPath: import.meta.filename });\n`);
  assert.equal(s.invoke([], { FAKE_SKIP_REPORT: '1' }, wrapper).status, 0);
  let rows = jsonl(path.join(s.home, 'runs.jsonl'));
  assert.equal(fs.readFileSync(rows[0].report, 'utf8'), '已检查示例仓库。\n接下来执行验证。');
  const result = s.invoke([], { FAKE_SPAWN_ERROR: '1' }, wrapper);
  assert.equal(result.status, 1, result.stderr);
  rows = jsonl(path.join(s.home, 'runs.jsonl'));
  const failed = rows.filter(e => e.event === 'start').at(-1);
  assert.equal(rows.at(-1).exit, 1); assert.match(fs.readFileSync(failed.events, 'utf8'), /启动 Codex 失败/);
});

test('派发信号保留 interrupted 记录，不停止其他进程', t => {
  const s = setup(t), wrapper = path.join(s.base, '信号 入口.mjs');
  const runURL = new URL('../../core/lib/run.mjs', import.meta.url).href;
  const adapterURL = new URL('../../core/adapters/codex.mjs', import.meta.url).href;
  // 假 agent 输出首行后，测试入口自行触发信号；处理器只结束本测试的假 agent 树。
  fs.writeFileSync(wrapper, `import { run } from ${JSON.stringify(runURL)};
import { codex } from ${JSON.stringify(adapterURL)};
const adapter = { ...codex, mapLine(line, context) { process.emit('SIGTERM'); return codex.mapLine(line, context); } };
process.exitCode = await run({ adapter, scriptPath: import.meta.filename });\n`);
  const result = s.invoke([], {}, wrapper);
  assert.equal(result.status, 1, result.stderr);
  const rows = jsonl(path.join(s.home, 'runs.jsonl'));
  assert.deepEqual(rows.map(e => e.event), ['start', 'attempt', 'spawned', 'interrupted']);
  assert.equal(rows.at(-1).signal, 'SIGTERM');
  assert.match(fs.readFileSync(rows[0].progress, 'utf8'), /派发脚本收到 SIGTERM，被外部中断/);
});

test('fake 执行者：按 profile 选择适配器，进度首行写执行者名，回放事件、写汇报、传递退出码', t => {
  const s = setup(t);
  s.config({ v: 2, defaultProfile: 'codex', profiles: { codex: { adapter: 'codex' }, demo: { adapter: 'fake', label: '演示执行者', exit: 3, report: '假汇报\n',
    events: [{ kind: 'say', text: '开始回放' }, { kind: 'error', text: '回放里的错误' }] } } });
  const result = s.invoke(['--profile', 'demo']);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /出错：回放里的错误/);
  const [start, , , , end] = jsonl(path.join(s.home, 'runs.jsonl'));
  assert.equal(start.profile, 'demo'); assert.equal(start.adapter, 'fake'); assert.equal(start.agent, 'fake'); assert.equal(start.agentVersion, 'fake-agent 1.0');
  assert.equal(end.exit, 3);
  assert.equal(fs.readFileSync(start.report, 'utf8'), '假汇报\n');
  const progress = fs.readFileSync(start.progress, 'utf8');
  assert.match(progress, /^=== 演示执行者 开始：只回复 OK/); assert.match(progress, /说：开始回放/); assert.match(progress.trimEnd(), /=== 演示执行者 结束：exit=3/);
  assert.deepEqual(jsonl(start.events).map(e => e.kind), ['say', 'error']);
  assert.ok(!fs.existsSync(s.env.FAKE_ECHO), '没有启动假 codex');
});

test('执行者选择失败：报中文原因，不创建记录、不写清单', t => {
  const s = setup(t);
  s.config({ v: 2, profiles: { off: { adapter: 'fake', enabled: false } } });
  assert.equal(s.invoke().status, 2); assert.match(s.invoke().stderr, /还没有可用的执行者/);
  s.config({ v: 2, profiles: { off: { adapter: 'fake', enabled: false }, odd: { adapter: 'qoder' }, demo: { adapter: 'fake' } } });
  for (const [args, message] of [[[], /有多个可用的执行者（odd、demo）/], [['--profile', 'off'], /执行者 off 已停用/], [['--profile', 'none'], /找不到执行者：none/], [['--profile', 'odd'], /不支持的执行者类型：qoder/]]) {
    const result = s.invoke(args);
    assert.equal(result.status, 2); assert.match(result.stderr, message);
  }
  assert.ok(!fs.existsSync(path.join(s.root, '.agent-runs'))); assert.ok(!fs.existsSync(path.join(s.home, 'runs.jsonl')));
});

test('新旧写法派发结果相同；dispatch --json 只输出一个 JSON 对象', t => {
  const s = setup(t);
  assert.equal(s.invoke([], {}).status, 0);
  const viaDispatch = spawnSync(process.execPath, [entry, 'dispatch', '只回复 OK', '--name', '中文 记录'], { cwd: s.root, env: s.env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(viaDispatch.status, 0, viaDispatch.stderr);
  const starts = jsonl(path.join(s.home, 'runs.jsonl')).filter(e => e.event === 'start');
  const comparable = ({ id, name, pid, started, dir, progress, report, raw, events, ...rest }) => rest;
  assert.deepEqual(starts.map(e => e.name), ['中文 记录', '中文 记录-2']);
  assert.deepEqual(comparable(starts[1]), comparable(starts[0]));
  const json = spawnSync(process.execPath, [entry, 'dispatch', '只回复 OK', '--name', 'JSON 记录', '--json'], { cwd: s.root, env: s.env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(json.status, 0, json.stderr);
  const lines = json.stdout.trim().split('\n'); assert.equal(lines.length, 1);
  const value = JSON.parse(lines[0]);
  assert.equal(value.ok, true); assert.equal(value.exit, 0); assert.equal(value.name, 'JSON 记录');
  assert.equal(value.progress, path.join(s.root, '.agent-runs', 'JSON 记录', 'progress.log'));
  const failed = spawnSync(process.execPath, [entry, 'dispatch', '只回复 OK', '--profile', '不存在', '--json'], { cwd: s.root, env: s.env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.notEqual(failed.status, 0); assert.deepEqual(JSON.parse(failed.stdout), { ok: false, error: '找不到执行者：不存在' }); assert.equal(failed.stderr, '');
});
