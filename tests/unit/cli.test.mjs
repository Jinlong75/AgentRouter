import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { normalizeArgs, main, commands } from '../../core/lib/cli.mjs';
import { parseArgs } from '../../core/lib/options.mjs';

test('旧写法与新写法解析结果相同', () => {
  const same = (a, b) => assert.deepEqual(normalizeArgs(a), normalizeArgs(b));
  same(['只回复 OK', '--name', '记录'], ['dispatch', '只回复 OK', '--name', '记录']);
  same(['docs/specs/012.md', '补充', '--role', 'worker'], ['dispatch', 'docs/specs/012.md', '补充', '--role', 'worker']);
  same(['--wait', '记录'], ['wait', '记录']);
  same(['--wait'], ['wait']);
  same(['--stop', '记录'], ['stop', '记录']);
  same(['--config', 'model=x'], ['config', 'model=x']);
  assert.deepEqual(normalizeArgs(['wait', '记录']), { command: 'wait', rest: ['记录'], json: false });
  assert.deepEqual(normalizeArgs([]), { command: 'dispatch', rest: [], json: false });
  assert.deepEqual(normalizeArgs(['version', '--json']), { command: 'version', rest: [], json: true });
  assert.deepEqual(normalizeArgs(['--json', '--wait', '记录']), { command: 'wait', rest: ['记录'], json: true });
  assert.deepEqual(normalizeArgs(['--run-request', 'a.claimed.json']), { command: '--run-request', rest: ['a.claimed.json'], json: false });
  assert.ok(commands.includes('init') && commands.includes('projects'));
});

test('不认识的子命令：只含小写字母、数字、连字符且不是文件时不派发；其他写法照旧当成 dispatch', () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'ar unknown '));
  try {
    fs.writeFileSync(path.join(dir, 'notes'), 'x');
    fs.mkdirSync(path.join(dir, 'folder'));
    assert.deepEqual(normalizeArgs(['list'], dir), { command: 'unknown', rest: ['list'], json: false });
    assert.deepEqual(normalizeArgs(['lsit', '--json'], dir), { command: 'unknown', rest: ['lsit'], json: true });
    assert.deepEqual(normalizeArgs(['fix-bug2', '补充'], dir), { command: 'unknown', rest: ['fix-bug2'], json: false });
    // 目录不算文件。
    assert.equal(normalizeArgs(['folder'], dir).command, 'unknown');
    // 存在的文件照旧派发。
    assert.deepEqual(normalizeArgs(['notes'], dir), { command: 'dispatch', rest: ['notes'], json: false });
    // 空格、中文、路径分隔符、扩展名、大写、数字开头、-- 开头都不是子命令的样子。
    for (const word of ['只回复 OK', '只回复', 'docs/specs/x.md', 'x.md', 'List', '2list', 'a_b', '-x', '--name'])
      assert.equal(normalizeArgs([word], dir).command, 'dispatch', word);
    // 已知子命令与 dispatch 本身不受影响。
    assert.equal(normalizeArgs(['dispatch', 'list'], dir).command, 'dispatch');
    assert.equal(normalizeArgs(['status', 'x'], dir).command, 'status');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('help / --help / -h 识别成帮助命令，任务文字里含 help 仍是派发', () => {
  for (const argv of [['help'], ['--help'], ['-h'], ['--help', '--json'], ['-h', 'retry']]) {
    assert.equal(normalizeArgs(argv).command, 'help', argv.join(' '));
  }
  assert.equal(normalizeArgs(['--help', '--json']).json, true);
  assert.deepEqual(normalizeArgs(['帮我写个 help 页面']), { command: 'dispatch', rest: ['帮我写个 help 页面'], json: false });
  assert.equal(normalizeArgs(['写个 --help 说明', '--name', 'x']).command, 'dispatch');
  assert.ok(commands.includes('help'));
});

test('push / pull 是子命令，不会被当作任务文字派发；用法里有这两条', async () => {
  assert.ok(commands.includes('push') && commands.includes('pull'));
  assert.deepEqual(normalizeArgs(['push', 'proj', '--dry-run', '--json']), { command: 'push', rest: ['proj', '--dry-run'], json: true });
  assert.deepEqual(normalizeArgs(['pull', 'proj']), { command: 'pull', rest: ['proj'], json: false });
  const { usage } = await import('../../core/lib/cli.mjs');
  assert.match(usage, /ar push <项目路径>/);
  assert.match(usage, /ar pull <项目路径>/);
  assert.match(usage, /ar accept <记录名> \[--squash\] \[--push\|--no-push\]/);
});

test('ar help：退出码 0、打印用法，不派发、不建任何文件', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ar help '));
  try {
    const home = path.join(root, 'home'), cwd = path.join(root, 'cwd');
    fs.mkdirSync(home); fs.mkdirSync(cwd);
    const env = { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), AR_WORKTREE_ROOT: path.join(root, 'wt') };
    const script = path.resolve('core/ar.mjs');
    for (const word of ['help', '--help', '-h']) {
      const r = spawnSync(process.execPath, [script, word], { cwd, env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /用法：/);
      // 原断言：retry 一行里含"--rebase 用于合并冲突、…，协议 15.8"；新断言：用法按用途分组、说明另起一行，句子仍在但分两行（用户反馈 ar help 难读）。
      assert.match(r.stdout, /ar retry [^\n]*--rebase[^\n]*\n(?:[^\n]*\n)*?\s+同一工作区手动重试下一次尝试（协议 14\.3）；--rebase 用于合并冲突、门禁失败或已中断的 worktree 任务：\n\s+在原 worktree 合并主分支后重跑门禁（协议 15\.8）/);
      // D102 新增用法：导入之前查模型列表。原断言：models 与 --preset 写在同一行；新断言：拆成两条用法，说明各另起一行，--preset 那条以 ar agents models --preset 开头。
      assert.match(r.stdout, /ar agents models <名> \[--probe\]\n\s+可选的模型\n\s+ar agents models --preset <预设>[^\n]*\n\s+导入之前查[^\n]*可加 --probe/);
      assert.deepEqual(fs.readdirSync(home), [], '公共目录里没有 runs.jsonl 等文件');
      assert.deepEqual(fs.readdirSync(cwd), [], '当前目录没有 .agent-runs');
    }
    const j = spawnSync(process.execPath, [script, '--help', '--json'], { cwd, env, encoding: 'utf8' });
    assert.equal(j.status, 0, j.stderr);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.ok, true);
    assert.match(parsed.usage, /^用法：/);
    assert.deepEqual(fs.readdirSync(home), []);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('--detach 是布尔参数，不吃掉后面的参数', () => {
  const parsed = parseArgs(['任务', '补充', '--detach', '--name', '记录']);
  assert.equal(parsed.opts.detach, true);
  assert.equal(parsed.opts.name, '记录');
  assert.equal(parsed.task, '任务');
  assert.equal(parsed.extra, '补充');
  assert.equal(parseArgs(['任务', '--name', '记录']).opts.detach, undefined);
});

// 015：派活方取值 claude-code（技能 / 会话）与 agentrouter（监控软件派发）；其他值报错不变。
test('--host 只接受 claude-code 与 agentrouter', () => {
  assert.equal(parseArgs(['任务', '--host', 'claude-code']).opts.host, 'claude-code');
  assert.equal(parseArgs(['任务', '--host', 'agentrouter']).opts.host, 'agentrouter');
  assert.equal(parseArgs(['任务', '--host', 'agentrouter', '--detach']).opts.host, 'agentrouter');
  assert.equal(parseArgs(['任务']).opts.host, undefined);
  for (const bad of ['other', 'AgentRouter', 'unknown'])
    assert.throws(() => parseArgs(['任务', '--host', bad]), /无效的派活方/, `应拒绝：${bad}`);
  // 空值在"参数无效或缺少值"那层就被拦下，走不到取值校验。
  assert.throws(() => parseArgs(['任务', '--host', '']), /参数无效或缺少值/);
});

test('--json：成功与失败都只输出一个 JSON 对象，失败退出码非 0', async t => {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'cli 测试 '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { AGENT_ROUTER_HOME: home };
  const call = async argv => { const out = []; const code = await main(argv, { scriptPath: path.resolve('core/ar.mjs'), env, cwd: home, out: s => out.push(s) }); return { code, out }; };
  for (const argv of [['version', '--json'], ['agents', 'list', '--json'], ['config', '--json'], ['agents', 'bad', '--json'], ['stop', '--json'], ['wait', '没有这个', '--json']]) {
    const { code, out } = await call(argv);
    assert.equal(out.length, 1, argv.join(' '));
    const value = JSON.parse(out[0]);
    assert.equal(typeof value.ok, 'boolean');
    assert.equal(code === 0, value.ok, argv.join(' '));
    if (!value.ok) { assert.equal(typeof value.error, 'string'); assert.ok(value.error.length > 0); }
  }
  const version = JSON.parse((await call(['version', '--json'])).out[0]);
  assert.equal(version.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version); assert.equal(version.node, process.versions.node);
  const agents = JSON.parse((await call(['agents', 'list', '--json'])).out[0]).agents;
  assert.deepEqual(agents, [{ name: 'codex', adapter: 'codex', label: 'Codex', enabled: true, supported: true, default: true, auth: 'login', secrets: {}, login: 'unknown', model: null, lastTest: null }]);
  assert.ok(!fs.existsSync(path.join(home, 'config.json')), 'agents list 只读');
  assert.match(JSON.parse((await call(['wait', '没有这个', '--json'])).out[0]).error, /找不到记录 没有这个/);
  assert.match(JSON.parse((await call(['init', '--json'])).out[0]).error, /不是 git 仓库/);
});
