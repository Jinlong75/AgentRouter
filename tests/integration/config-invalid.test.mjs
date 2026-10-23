import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 063：config.json 存在但读不了（不是 JSON、v 不是 1 或 2、读取出错）时，需要选执行者或会改写配置的命令一律拒绝
// （协议第 4 节）：不派发、不写入、不动坏文件，打印协议原文；--json 为 { ok:false, error, code: "CONFIG_INVALID" }。
// 全部用隔离公共目录与 fake 执行者；"没有启动任何执行者进程"用 fake 的写文件标记断言（进程一跑就会写下标记）。
const project = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(project, 'core/ar.mjs');
const rows = home => { try { const s = fs.readFileSync(path.join(home, 'runs.jsonl'), 'utf8'); return s.trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
async function until(fn, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = fn(); if (result) return result; await delay(25); }
  throw Error('隔离测试等待超时');
}

function setup(t, { delayMs = 0 } = {}) {
  const since = Date.now();
  const base = fs.mkdtempSync(path.join(tmpdir(), '配置无效 测试 '));
  const root = path.join(base, '仓库'), home = path.join(base, '公共 配置');
  const file = path.join(home, 'config.json'), marker = path.join(root, '执行者已启动.txt');
  fs.mkdirSync(root); fs.mkdirSync(home);
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs/任务.md'), '任务', 'utf8');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^CODEX_|^CLAUDECODE$|^CLAUDE_CODE_SESSION_ID$|^FAKE_/.test(key)) delete env[key];
  // 开发者的终端里可能设着公共目录的新名 / 旧名；本用例只设新名，两个名字都删掉再设。
  for (const key of Object.keys(env)) if (process.platform === 'win32' ? key.toLowerCase() === 'agent_router_home' : key === 'AGENT_ROUTER_HOME') delete env[key];
  Object.assign(env, {
    AGENT_ROUTER_HOME: home, USERPROFILE: base, HOME: base, APPDATA: base,
    CLAUDE_CONFIG_DIR: path.join(base, 'claude'), CODEX_HOME: path.join(base, 'codex'), XDG_CONFIG_HOME: base,
    CODEX_NO_WATCH: '1',
  });
  for (const key of ['USERPROFILE', 'HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'AGENT_ROUTER_HOME']) {
    const rel = path.relative(path.resolve(tmpdir()), env[key]);
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), key);
  }
  // fake 执行者：进程一启动就会写标记文件（writes），用来断言"没有启动任何执行者进程"。
  const good = () => fs.writeFileSync(file, JSON.stringify({ v: 2, defaultProfile: 'fake', managed: false, watchWindow: 'never',
    profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'say', text: '做完了' }], report: '假汇报\n', delayMs, writes: [{ path: '执行者已启动.txt', content: '已启动' }] } } }), 'utf8');
  const corrupt = bad => fs.writeFileSync(file, bad, 'utf8');
  const ar = (args = []) => spawnSync(process.execPath, [entry, ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000, windowsHide: true, shell: false });
  // 协议第 4 节的原文；路径在句尾。派发族"这次没有派发"，写入类"这次没有改动配置"。
  const line = (reason, action = '这次没有派发') => `配置：config.json 无法读取（${reason}）。为免改用你没有选的执行者，${action}。请修好这个文件，或者删掉它（删掉后按内置默认）：${file}`;
  t.after(async () => {
    // 只清理本用例记录的执行者进程及其子孙，按身份（PID + 创建时间）逐个结束；绝不按进程名终止。临时目录整体删除（只删系统临时目录下本用例的目录）。
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), entry, since), diagnostic: message => t.diagnostic(message) });
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { base, root, home, file, marker, env, good, corrupt, ar, line };
}

// 一条命令在配置无效时的统一断言：非 --json 打协议原文到标准错误；--json 是 { ok:false, error, code: "CONFIG_INVALID" }。
function refuse(s, args, reason, action = '这次没有派发') {
  const plain = s.ar(args);
  assert.equal(plain.status, 2, `${args.join(' ')}：${plain.stderr}`);
  assert.equal(plain.stderr.trim(), s.line(reason, action), `${args.join(' ')}：${plain.stderr}`);
  assert.equal(plain.stdout, '', `${args.join(' ')}：拒绝时标准输出里不列任何东西`);
  const json = s.ar([...args, '--json']);
  assert.equal(json.status, 2, json.stderr);
  const value = JSON.parse(json.stdout);
  assert.equal(value.ok, false);
  assert.equal(value.code, 'CONFIG_INVALID');
  assert.equal(value.error, s.line(reason, action));
  assert.equal(value.agents, undefined, '不返回内置默认的执行者列表');
}

test('dispatch（任务文字与任务说明）在配置无效时拒绝：不派发、不写入、坏文件不变', t => {
  const s = setup(t);
  for (const [bad, reason] of [['{', '不是有效的 JSON'], ['{"v":3}', 'v 不是 1 或 2']]) {
    s.corrupt(bad);
    const before = fs.statSync(s.file);
    for (const args of [['只回复 OK', '--name', '文字任务'], ['docs/任务.md', '--name', '说明任务']]) refuse(s, args, reason);
    assert.ok(!fs.existsSync(path.join(s.root, '.agent-runs')), '没有新的任务目录');
    assert.ok(!fs.existsSync(path.join(s.home, 'runs.jsonl')), '没有新的清单行');
    assert.ok(!fs.existsSync(s.marker), '假执行者进程没有启动');
    assert.equal(fs.readFileSync(s.file, 'utf8'), bad);
    assert.equal(fs.statSync(s.file).mtimeMs, before.mtimeMs, '坏文件的修改时间不变');
  }
});

test('agents 写入类命令与 config 写入在配置无效时拒绝改动，agents test 不测试、不写结果', t => {
  const s = setup(t); s.corrupt('{');
  const before = fs.statSync(s.file);
  for (const args of [['agents', 'add', '--preset', 'deepseek'], ['agents', 'update', 'codex', '--label', '换个名字'],
    ['agents', 'default', 'codex'], ['agents', 'remove', 'codex'], ['agents', 'enable', 'codex'], ['agents', 'disable', 'codex'],
    ['config', 'model=new'], ['config', 'init']]) refuse(s, args, '不是有效的 JSON', '这次没有改动配置');
  // 测试连接会真实派发一次：按派发族原文拒绝，测试结果与进程都不出现。
  refuse(s, ['agents', 'test', 'codex'], '不是有效的 JSON');
  assert.ok(!fs.existsSync(path.join(s.home, 'agent-tests.json')), '没有写测试结果');
  assert.ok(!fs.existsSync(s.marker), '假执行者进程没有启动');
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{');
  assert.equal(fs.statSync(s.file).mtimeMs, before.mtimeMs, '坏文件的修改时间不变');
});

test('agents list 与 config 显示在配置无效时拒绝：有提示、退出 2、不列出内置默认的执行者', t => {
  const s = setup(t); s.corrupt('{"v":3}');
  for (const args of [['agents', 'list'], ['config'], ['secrets', 'status']]) refuse(s, args, 'v 不是 1 或 2');
  assert.ok(!fs.existsSync(path.join(s.home, 'runs.jsonl')), '没有新的清单行');
});

test('redispatch 在配置无效时拒绝；retry 同样拒绝（059 前 retry 按任务文字派发，仍走同一配置检查）', t => {
  const s = setup(t); s.good();
  const first = s.ar(['先派一次', '--name', '老任务']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.ok(fs.existsSync(s.marker), '对照：配置正常时假执行者进程会启动');
  const runsBefore = rows(s.home).length, dirsBefore = fs.readdirSync(path.join(s.root, '.agent-runs'));
  fs.rmSync(s.marker, { force: true });
  s.corrupt('{');
  for (const args of [['redispatch', '老任务'], ['retry', '老任务']]) refuse(s, args, '不是有效的 JSON');
  assert.deepEqual(fs.readdirSync(path.join(s.root, '.agent-runs')), dirsBefore, '没有新的任务目录');
  assert.equal(rows(s.home).length, runsBefore, '没有新的清单行');
  assert.ok(!fs.existsSync(s.marker), '假执行者进程没有启动');
});

test('脱离派发的执行者进程用请求快照：先派发，再写坏配置，任务照常完成', async t => {
  const s = setup(t, { delayMs: 2000 }); s.good();
  const caller = s.ar(['慢任务', '--name', '脱离任务', '--detach', '--json']);
  assert.equal(caller.status, 0, caller.stderr);
  assert.equal(JSON.parse(caller.stdout).detached, true);
  // 调用方已经把请求快照交给独立进程（--run-request）：公共目录的配置再坏也不影响它。
  s.corrupt('{');
  const end = await until(() => rows(s.home).find(r => r.event === 'end'), 20000);
  assert.equal(end.exit, 0);
  assert.ok(fs.existsSync(s.marker), '执行者进程按请求快照完成了任务');
});
