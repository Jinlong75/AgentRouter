import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
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
