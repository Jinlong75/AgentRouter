import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../core/lib/cli.mjs';
import { loadPreset } from '../../core/lib/agents.mjs';

// 隔离公共目录；假密钥只放在传入的环境里。任何输出都不能出现它的值。
const SECRET = 'sk-test-agents-cli-5c1e';
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar agents 测试 '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { AGENT_ROUTER_HOME: home, DEEPSEEK_API_KEY: SECRET, MIMO_API_KEY: SECRET, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const outputs = [];
  const call = async (argv, extra = {}) => {
    const out = [];
    const code = await main(argv, { scriptPath: path.resolve('core/ar.mjs'), env, cwd: home, out: s => out.push(s), ...extra });
    outputs.push(...out);
    return { code, out, json: argv.includes('--json') ? JSON.parse(out.at(-1)) : null };
  };
  const config = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  return { home, env, call, config, outputs };
}

test('agents：add → list → disable → enable → remove；--json 只输出一个对象；默认执行者按 D2 切换', async t => {
  const { call, config, outputs } = setup(t);
  const added = await call(['agents', 'add', '--preset', 'deepseek', '--json']);
  assert.equal(added.code, 0); assert.equal(added.out.length, 1);
  assert.deepEqual({ ...added.json, secretStatus: added.json.secretStatus }, { ok: true, name: 'deepseek', preset: 'deepseek', madeDefault: true, secrets: ['DEEPSEEK_API_KEY'], secretStatus: { DEEPSEEK_API_KEY: 'set' } });
  assert.deepEqual(config().profiles.deepseek, loadPreset('deepseek').profile);
  assert.equal(config().defaultProfile, 'deepseek', '有了 DeepSeek 后默认执行者是它');
  assert.equal(config().profiles.codex.enabled, true, 'Codex 保持启用');

  const list = (await call(['agents', 'list', '--json'])).json.agents;
  const deepseek = list.find(a => a.name === 'deepseek'), codex = list.find(a => a.name === 'codex');
  assert.deepEqual(deepseek, { name: 'deepseek', adapter: 'claude-code', label: 'DeepSeek V4 Pro', enabled: true, supported: true, default: true, auth: 'token', secrets: { DEEPSEEK_API_KEY: 'set' }, login: null, model: 'deepseek-v4-pro', lastTest: null });
  assert.equal(codex.default, false); assert.equal(codex.auth, 'login');

  const again = await call(['agents', 'add', '--preset', 'deepseek', '--json']);
  assert.equal(again.code, 2); assert.match(again.json.error, /已有执行者 deepseek/);

  assert.equal((await call(['agents', 'disable', 'deepseek', '--json'])).json.enabled, false);
  assert.equal(config().profiles.deepseek.enabled, false);
  assert.equal((await call(['agents', 'enable', 'deepseek', '--json'])).json.enabled, true);

  const native = (await call(['agents', 'add', '--preset', 'claude-native', '--name', 'native', '--json'])).json;
  assert.equal(native.madeDefault, false, '默认已是非 Codex 执行者时不改');
  assert.equal(config().defaultProfile, 'deepseek');

  assert.equal((await call(['agents', 'remove', 'deepseek', '--json'])).json.defaultProfile, 'native', '删掉默认执行者后优先用别的非 Codex 执行者');
  assert.equal((await call(['agents', 'remove', 'native', '--json'])).json.defaultProfile, 'codex');
  assert.deepEqual(Object.keys(config().profiles), ['codex']);
  assert.match((await call(['agents', 'remove', 'native', '--json'])).json.error, /找不到执行者：native/);

  const text = await call(['agents', 'list']);
  assert.match(text.out.join('\n'), /codex\s+Codex（codex）\s+已启用\s+默认/);
  for (const line of outputs) assert.ok(!line.includes(SECRET), '输出里出现了密钥值');
});

test('secrets：status 只报告 set / missing；set 的值只从标准输入读，命令行与输出里都没有', async t => {
  const { call, outputs } = setup(t);
  await call(['agents', 'add', '--preset', 'deepseek', '--json']);
  const status = (await call(['secrets', 'status', '--json'])).json;
  assert.deepEqual(status, { ok: true, secrets: { DEEPSEEK_API_KEY: 'set' } });
  assert.deepEqual((await call(['secrets', 'status', 'AR_TEST_SURELY_MISSING_KEY_9F2', '--json'])).json.secrets, { AR_TEST_SURELY_MISSING_KEY_9F2: 'missing' });
  const text = (await call(['secrets', 'status'])).out.join('\n');
  assert.equal(text, 'DEEPSEEK_API_KEY：已设置');

  const written = [];
  const set = await call(['secrets', 'set', 'MY_NEW_KEY', '--json'], { readSecret: async name => { assert.equal(name, 'MY_NEW_KEY'); return SECRET; }, setSecret: (name, value) => written.push([name, value]) });
  assert.deepEqual(set.json, { ok: true, name: 'MY_NEW_KEY', status: 'set' });
  assert.deepEqual(written, [['MY_NEW_KEY', SECRET]], '值经标准输入读入后交给写入函数');
  assert.match((await call(['secrets', 'set', 'bad name', '--json'], { readSecret: async () => SECRET, setSecret: () => assert.fail('不应写入') })).json.error, /变量名无效|用法/);
  for (const line of outputs) assert.ok(!line.includes(SECRET), '输出里出现了密钥值');
});

test('agents test：在临时仓库与临时公共目录里跑"只回复 OK"，不写入真实任务清单', async t => {
  const { home, call } = setup(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'ok', profiles: {
    ok: { adapter: 'fake', label: '假执行者', events: [{ kind: 'say', text: 'OK' }, { kind: 'turn', usage: { input: 10, output: 2 } }], report: 'OK\n' },
    bad: { adapter: 'fake', label: '假执行者', events: [{ kind: 'error', text: '接口返回 401' }], report: '没有完成\n', exit: 3 },
  } }));
  const ok = await call(['agents', 'test', 'ok', '--json']);
  assert.equal(ok.code, 0);
  assert.deepEqual({ ok: ok.json.ok, exit: ok.json.exit, report: ok.json.report, usage: ok.json.usage }, { ok: true, exit: 0, report: 'OK', usage: { input: 10, output: 2 } });
  const bad = await call(['agents', 'test', 'bad', '--json']);
  assert.equal(bad.code, 1); assert.equal(bad.json.ok, false); assert.equal(bad.json.exit, 3); assert.match(bad.json.error, /401/);
  assert.ok(!fs.existsSync(path.join(home, 'runs.jsonl')), '测试连接不写入真实任务清单');
});

test('agents presets --json：按 order 排序，含 title/description/recommended/adapter/label/auth/env/secrets', async t => {
  const { call } = setup(t);
  const r = await call(['agents', 'presets', '--json']);
  assert.equal(r.code, 0); assert.equal(r.out.length, 1);
  assert.deepEqual(r.json.presets.map(p => p.name), ['deepseek', 'mimo', 'mimo-payg', 'claude-native', 'claude-subscription', 'compat', 'codex']);
  assert.deepEqual(r.json.presets.filter(p => p.recommended).map(p => p.name), ['deepseek'], '推荐标记只在 DeepSeek 上');
  const deepseek = r.json.presets[0];
  assert.deepEqual(deepseek, { name: 'deepseek', title: 'DeepSeek', description: '经 Claude Code 外壳运行，按量付费，用 API Key', recommended: true, adapter: 'claude-code', label: 'DeepSeek V4 Pro', auth: 'token', env: loadPreset('deepseek').profile.env, secrets: { ANTHROPIC_AUTH_TOKEN: 'DEEPSEEK_API_KEY' } });
  const codex = r.json.presets.find(p => p.name === 'codex');
  assert.deepEqual(codex, { name: 'codex', title: 'Codex', description: '用 ChatGPT 登录或 OpenAI API Key', recommended: false, adapter: 'codex', label: 'Codex', auth: 'login', env: {}, secrets: {} });
  const compat = r.json.presets.find(p => p.name === 'compat');
  assert.equal(compat.auth, 'token'); assert.equal(compat.recommended, false);
  assert.deepEqual(compat.env, { ANTHROPIC_BASE_URL: '', ANTHROPIC_MODEL: '' });
  assert.deepEqual(compat.secrets, { ANTHROPIC_AUTH_TOKEN: 'COMPAT_API_KEY' });
  const text = await call(['agents', 'presets']);
  assert.match(text.out.join('\n'), /^可用预设：deepseek、mimo、mimo-payg、claude-native、claude-subscription、compat、codex$/);
});

test('预设 mimo / mimo-payg：完整内容与模板文件精确一致', () => {
  const shared = {
    adapter: 'claude-code', label: 'MiMo V2.6 Pro', enabled: true,
    auth: 'token', secrets: { ANTHROPIC_AUTH_TOKEN: 'MIMO_API_KEY' }, maxTurns: null,
    price: { inputPer1M: null, outputPer1M: null, currency: 'CNY' }, recommended: false,
  };
  assert.deepEqual(loadPreset('mimo'), { name: 'mimo', profile: { ...shared,
    env: { ANTHROPIC_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/anthropic', ANTHROPIC_MODEL: 'mimo-v2.6-pro' },
    title: 'Xiaomi MiMo（Token Plan）', description: '经 Claude Code 外壳运行，用 Token Plan 的 API Key（tp- 开头）', order: 2 } });
  assert.deepEqual(loadPreset('mimo-payg'), { name: 'mimo-payg', profile: { ...shared,
    env: { ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic', ANTHROPIC_MODEL: 'mimo-v2.6-pro' },
    title: 'Xiaomi MiMo（按量付费）', description: '经 Claude Code 外壳运行，按量付费，用 sk- 开头的 API Key', order: 3 } });
});

test('agents add --preset mimo：配置与 list --json 的 env / secrets / auth 正确', async t => {
  const { call, config, outputs } = setup(t);
  const env = { ANTHROPIC_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/anthropic', ANTHROPIC_MODEL: 'mimo-v2.6-pro' };
  const added = await call(['agents', 'add', '--preset', 'mimo', '--json']);
  assert.equal(added.code, 0);
  assert.equal(added.json.name, 'mimo'); assert.equal(added.json.preset, 'mimo');
  assert.deepEqual(added.json.secrets, ['MIMO_API_KEY']);
  assert.deepEqual(added.json.secretStatus, { MIMO_API_KEY: 'set' });
  assert.deepEqual(config().profiles.mimo.env, env);
  assert.deepEqual(config().profiles.mimo.secrets, { ANTHROPIC_AUTH_TOKEN: 'MIMO_API_KEY' });
  assert.equal(config().profiles.mimo.auth, 'token');

  const row = (await call(['agents', 'list', '--json'])).json.agents.find(a => a.name === 'mimo');
  assert.equal(row.auth, 'token');
  assert.deepEqual(row.secrets, { MIMO_API_KEY: 'set' });
  assert.equal(row.model, 'mimo-v2.6-pro');
  assert.ok(!('MIMO_API_KEY' in row) && !Object.keys(row).includes('env'), '列表只给密钥状态，不给变量值');
  const preset = (await call(['agents', 'presets', '--json'])).json.presets.find(p => p.name === 'mimo');
  assert.deepEqual(preset.env, env);
  for (const line of outputs) assert.ok(!line.includes(SECRET), '输出里出现了密钥值');
});

test('agents add：--name/--label/--model/--base-url/--secret-var 覆盖预设；codex 传 --model 报错且不写入', async t => {
  const { call, config } = setup(t);
  const added = await call(['agents', 'add', '--preset', 'deepseek', '--name', 'ds', '--label', '我的 DS', '--model', 'deepseek-v4-new', '--base-url', 'https://example.invalid/anthropic', '--secret-var', 'MY_DS_KEY', '--json']);
  assert.equal(added.code, 0);
  assert.equal(added.json.name, 'ds'); assert.equal(added.json.preset, 'deepseek');
  const p = config().profiles.ds;
  assert.equal(p.label, '我的 DS');
  assert.equal(p.env.ANTHROPIC_MODEL, 'deepseek-v4-new');
  assert.equal(p.env.ANTHROPIC_BASE_URL, 'https://example.invalid/anthropic');
  assert.deepEqual(p.secrets, { ANTHROPIC_AUTH_TOKEN: 'MY_DS_KEY' });

  const bad = await call(['agents', 'add', '--preset', 'codex', '--name', 'cx', '--model', 'o4', '--json']);
  assert.equal(bad.code, 2); assert.match(bad.json.error, /--model 只对 Claude Code 适配器有效/);
  assert.ok(!config().profiles.cx, '报错后不写入配置');

  const cx = await call(['agents', 'add', '--preset', 'codex', '--name', 'cx', '--auth', 'token', '--json']);
  assert.equal(cx.code, 0);
  assert.equal(config().profiles.cx.auth, 'token');
  assert.deepEqual(config().profiles.cx.secrets, { OPENAI_API_KEY: 'OPENAI_API_KEY' });
});

test('agents add：兼容后端缺地址或模型报错，且不写入配置', async t => {
  const { home, call, config } = setup(t);
  const profiles = () => { const file = path.join(home, 'config.json'); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).profiles ?? {} : {}; };
  const missing = await call(['agents', 'add', '--preset', 'compat', '--json']);
  assert.equal(missing.code, 2); assert.match(missing.json.error, /缺少接口地址：用 --base-url 指定/);
  assert.ok(!profiles().compat, '缺地址不写入');
  const onlyBase = await call(['agents', 'add', '--preset', 'compat', '--base-url', 'https://example.invalid', '--json']);
  assert.equal(onlyBase.code, 2); assert.match(onlyBase.json.error, /缺少模型：用 --model 指定/);
  assert.ok(!profiles().compat, '缺模型不写入');
  const ok = await call(['agents', 'add', '--preset', 'compat', '--name', 'my-compat', '--base-url', 'https://example.invalid', '--model', 'my-model', '--json']);
  assert.equal(ok.code, 0);
  assert.deepEqual(config().profiles['my-compat'].env, { ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_MODEL: 'my-model' });
});

test('agents update：改 label/model/base-url/secret-var/max-turns；至少给一项；- 清空 maxTurns', async t => {
  const { call, config } = setup(t);
  await call(['agents', 'add', '--preset', 'deepseek', '--json']);
  const r = await call(['agents', 'update', 'deepseek', '--label', 'DeepSeek 新', '--model', 'deepseek-v4-new2', '--base-url', 'https://x.invalid', '--secret-var', 'KEY_X', '--max-turns', '9', '--json']);
  assert.equal(r.code, 0); assert.equal(r.json.name, 'deepseek');
  const p = r.json.profile;
  assert.equal(p.label, 'DeepSeek 新'); assert.equal(p.env.ANTHROPIC_MODEL, 'deepseek-v4-new2'); assert.equal(p.env.ANTHROPIC_BASE_URL, 'https://x.invalid');
  assert.deepEqual(p.secrets, { ANTHROPIC_AUTH_TOKEN: 'KEY_X' }); assert.equal(p.maxTurns, 9);
  assert.deepEqual(config().profiles.deepseek, p, '已写入配置');
  assert.equal((await call(['agents', 'update', 'deepseek', '--max-turns', '-', '--json'])).json.profile.maxTurns, null);
  assert.equal((await call(['agents', 'update', 'deepseek', '--json'])).code, 2);
  const badMax = await call(['agents', 'update', 'deepseek', '--max-turns', '0', '--json']);
  assert.equal(badMax.code, 2); assert.match(badMax.json.error, /--max-turns 必须为正整数或 -/);
  assert.match((await call(['agents', 'update', 'nope', '--label', 'x', '--json'])).json.error, /找不到执行者：nope/);
});

test('agents default：设为默认；不存在或已停用报错', async t => {
  const { call, config } = setup(t);
  await call(['agents', 'add', '--preset', 'deepseek', '--json']);
  await call(['agents', 'add', '--preset', 'claude-native', '--name', 'native', '--json']);
  const r = await call(['agents', 'default', 'native', '--json']);
  assert.equal(r.code, 0); assert.equal(r.json.defaultProfile, 'native'); assert.equal(config().defaultProfile, 'native');
  assert.match((await call(['agents', 'default', 'nope', '--json'])).json.error, /找不到执行者：nope/);
  await call(['agents', 'disable', 'native', '--json']);
  const disabled = await call(['agents', 'default', 'native', '--json']);
  assert.equal(disabled.code, 2); assert.match(disabled.json.error, /已停用/);
});

test('agents list --detect：给每项加 installed/version；不带 --detect 不加', async t => {
  const { home, call } = setup(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'fake1', profiles: { fake1: { adapter: 'fake', label: '假执行者', enabled: true } } }));
  const detected = (await call(['agents', 'list', '--detect', '--json'])).json.agents;
  assert.equal(detected.length, 1);
  assert.equal(detected[0].installed, true); assert.equal(detected[0].version, 'fake-agent 1.0');
  const plain = (await call(['agents', 'list', '--json'])).json.agents;
  assert.ok(!('installed' in plain[0]) && !('version' in plain[0]), '不带 --detect 不加这两项');
});
