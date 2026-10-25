import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../core/lib/cli.mjs';
import { loadPreset, listAgentModels, checkPresetCards } from '../../core/lib/agents.mjs';
import { validateGeneric } from '../../core/lib/generic-schema.mjs';
import { withFakeCodex } from '../fixtures/fake-codex-path.mjs';

// Stage07 T5（任务 103）：Qoder 预设、--effort、models、validate / export / import、删除时清理声明。
// 每个测试用自己的隔离公共目录；假令牌只放在传入的环境里，任何输出都不能出现它的值。
const TOKEN = 'qoder-test-token-5d3f9a';
const modelsCli = path.resolve('tests/fixtures/generic/models-cli.mjs');

function setup(t, { token = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar agents 导入 '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // 密钥只从传入的环境和这个隔离文件里找，不碰注册表。
  const secretsFile = path.join(home, '.test-secrets.json');
  fs.writeFileSync(secretsFile, '{}\n');
  const env = withFakeCodex({ AGENT_ROUTER_HOME: home, AR_TEST_SECRETS_FILE: secretsFile, ...(token ? { QODERCN_PERSONAL_ACCESS_TOKEN: TOKEN } : {}), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, home);
  const outputs = [];
  const call = async (argv, extra = {}) => {
    const out = [];
    const code = await main(argv, { scriptPath: path.resolve('core/ar.mjs'), env, cwd: home, out: s => out.push(s), ...extra });
    outputs.push(...out);
    return { code, out, text: out.join('\n'), json: argv.includes('--json') ? JSON.parse(out.at(-1)) : null };
  };
  const file = name => path.join(home, name);
  const configFile = path.join(home, 'config.json');
  const config = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const writeConfig = value => fs.writeFileSync(configFile, JSON.stringify(value, null, 2));
  const writeJson = (name, value) => { fs.writeFileSync(file(name), JSON.stringify(value, null, 2)); return file(name); };
  return { home, env, call, config, writeConfig, writeJson, file, configFile, outputs };
}
const noToken = outputs => { for (const line of outputs) assert.ok(!line.includes(TOKEN), '输出里出现了令牌值'); };

test('add --preset qoder-cn：声明写进 generics.<名>，执行者配置只引用名字，预设说明字段不进配置', async t => {
  const { call, config } = setup(t);
  const added = await call(['agents', 'add', '--preset', 'qoder-cn', '--json']);
  assert.equal(added.code, 0);
  assert.deepEqual({ name: added.json.name, madeDefault: added.json.madeDefault, secrets: added.json.secrets, secretStatus: added.json.secretStatus },
    { name: 'qoder-cn', madeDefault: true, secrets: ['QODERCN_PERSONAL_ACCESS_TOKEN'], secretStatus: { QODERCN_PERSONAL_ACCESS_TOKEN: 'set' } });
  const profile = config().profiles['qoder-cn'];
  assert.equal(profile.adapter, 'generic');
  assert.equal(profile.generic, 'qoder-cn', '执行者配置里 generic 只写声明名');
  assert.deepEqual(profile.secrets, { QODERCN_PERSONAL_ACCESS_TOKEN: 'QODERCN_PERSONAL_ACCESS_TOKEN' });
  assert.equal(profile.auth, 'token'); assert.equal(profile.enabled, true);
  for (const key of ['modelOptions', 'effortOptions', 'listModels', 'types', 'baseUrlOptions']) assert.ok(!(key in profile), `${key} 不写进配置`);
  const declaration = config().generics['qoder-cn'];
  assert.deepEqual(declaration, loadPreset('qoder-cn').profile.generic, '声明是预设里的完整声明');
  assert.equal(declaration.executable, 'qoderclicn');
  assert.deepEqual(declaration.args.slice(-4), ['-m', '{model}', '--reasoning-effort', '{effort}']);
  assert.deepEqual(declaration.readOnlyArgs.slice(5, 9), ['--tools', 'Read', 'Grep', 'Glob'], '--tools 后面是分开的三项参数');
  assert.equal(validateGeneric(declaration).ok, true, '预设里的声明能通过校验');

  const again = await call(['agents', 'add', '--preset', 'qoder-cn', '--json']);
  assert.equal(again.code, 2); assert.match(again.json.error, /已有执行者 qoder-cn/);

  // 改名后声明也跟着改名；--model / --effort 写进执行者配置。
  const named = await call(['agents', 'add', '--preset', 'qoder-cn', '--name', 'my-qoder', '--model', 'Qwen3.8-Max', '--effort', 'high', '--json']);
  assert.equal(named.code, 0); assert.equal(named.json.madeDefault, false, '已有非 Codex 的默认执行者时不改默认');
  const mine = config().profiles['my-qoder'];
  assert.equal(mine.generic, 'my-qoder'); assert.equal(mine.model, 'Qwen3.8-Max'); assert.equal(mine.effort, 'high');
  assert.deepEqual(config().generics['my-qoder'], declaration);
  assert.equal(config().generics['qoder-cn'].executable, 'qoderclicn', '原来的声明不受影响');

  // 国际版：只有程序、令牌变量、显示名和说明不同。
  const intl = await call(['agents', 'add', '--preset', 'qoder', '--json']);
  assert.equal(intl.code, 0); assert.deepEqual(intl.json.secrets, ['QODER_PERSONAL_ACCESS_TOKEN']);
  assert.equal(config().generics.qoder.executable, 'qodercli');
  assert.equal(validateGeneric(config().generics.qoder).ok, true);
  assert.deepEqual({ ...config().generics.qoder, label: declaration.label, executable: declaration.executable, failureHints: declaration.failureHints }, declaration);
});

test('add：同名声明已在 generics 里（没有执行者）时拒绝，且不写入', async t => {
  const { call, config, writeConfig } = setup(t);
  writeConfig({ v: 2, defaultProfile: null, profiles: {}, generics: { 'qoder-cn': { label: 'x' } } });
  const r = await call(['agents', 'add', '--preset', 'qoder-cn', '--json']);
  assert.equal(r.code, 2); assert.match(r.json.error, /generics 里已有同名声明 qoder-cn/);
  assert.deepEqual(config().profiles, {}); assert.deepEqual(config().generics, { 'qoder-cn': { label: 'x' } });
});

test('presets --json：带 effortOptions / modelOptions / listModels / types；顺序固定', async t => {
  const { call } = setup(t);
  const { json, code } = await call(['agents', 'presets', '--json']);
  assert.equal(code, 0);
  assert.deepEqual(json.presets.map(p => p.name), ['deepseek', 'mimo', 'mimo-payg', 'claude-native', 'claude-subscription', 'compat', 'codex', 'qoder-cn', 'qoder', 'openai-compat']);
  const by = name => json.presets.find(p => p.name === name);
  for (const name of ['deepseek', 'mimo', 'mimo-payg', 'claude-native', 'claude-subscription', 'compat']) {
    assert.deepEqual(by(name).effortOptions, ['low', 'medium', 'high', 'xhigh', 'max'], name);
  }
  assert.deepEqual(by('codex').effortOptions, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(by('deepseek').modelOptions, ['deepseek-v4-pro', 'deepseek-v4-flash']);
  assert.ok(!('listModels' in by('deepseek')) && !('types' in by('deepseek')), '没有的字段不输出');
  const qoder = by('qoder-cn');
  assert.equal(qoder.adapter, 'generic'); assert.equal(qoder.auth, 'token'); assert.equal(qoder.title, 'Qoder（国内版）');
  assert.deepEqual(qoder.listModels, ['--list-models']);
  assert.deepEqual(qoder.types, ['research', 'docs', 'review']);
  assert.deepEqual(qoder.effortOptions, ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
  assert.equal(qoder.modelOptions.length, 11); assert.equal(qoder.modelOptions[0], 'Auto'); assert.equal(qoder.modelOptions.at(-1), 'MiniMax-M3.1-Flash');
  assert.deepEqual(qoder.secrets, { QODERCN_PERSONAL_ACCESS_TOKEN: 'QODERCN_PERSONAL_ACCESS_TOKEN' });
  assert.equal(by('qoder').secrets.QODER_PERSONAL_ACCESS_TOKEN, 'QODER_PERSONAL_ACCESS_TOKEN');
});

test('presets --json：Claude Code、Xiaomi MiMo、Qoder 各合成一张卡片（112）：同组 card 与 variant.label 一致，add 不把 card / variant 写进配置', async t => {
  const { call, config } = setup(t);
  const { json } = await call(['agents', 'presets', '--json']);
  const by = name => json.presets.find(p => p.name === name);
  const groups = { 'claude-code': ['claude-native', 'claude-subscription'], mimo: ['mimo', 'mimo-payg'], qoder: ['qoder-cn', 'qoder'] };
  for (const [id, names] of Object.entries(groups)) {
    for (const name of names) {
      assert.equal(by(name).card.id, id, `${name}.card.id`);
      assert.deepEqual(by(name).card, by(names[0]).card, `${name} 与同组的 card 一致`);
      assert.equal(by(name).variant.label, by(names[0]).variant.label, `${name} 与同组的 variant.label 一致`);
    }
    assert.equal(new Set(names.map(name => by(name).variant.option)).size, names.length, `${id} 的 variant.option 各不相同`);
  }
  assert.deepEqual(by('claude-native').variant, { label: '认证方式', option: 'API Key', help: '用 Claude API Key，变量 ANTHROPIC_API_KEY' });
  assert.deepEqual(by('claude-subscription').variant, { label: '认证方式', option: '订阅令牌', help: '在终端运行 claude setup-token 获取；用量计入你本人的同一份订阅' });
  assert.deepEqual(by('mimo').card, { id: 'mimo', title: 'Xiaomi MiMo', description: '经 Claude Code 外壳运行，Token Plan 或按量付费' });
  assert.deepEqual(by('qoder-cn').variant, { label: '版本', option: '国内版', help: '程序 qoderclicn，在 qoder.cn 的账户集成页生成个人访问令牌' });
  assert.deepEqual(by('qoder').variant, { label: '版本', option: '国际版', help: '程序 qodercli，在 qoder.com 的账户集成页生成个人访问令牌' });
  for (const name of ['deepseek', 'compat', 'codex', 'openai-compat']) assert.ok(!('card' in by(name)) && !('variant' in by(name)), `${name} 不合并`);

  for (const name of ['claude-subscription', 'mimo-payg', 'qoder']) {
    const added = await call(['agents', 'add', '--preset', name, '--json']);
    assert.equal(added.code, 0, name);
    assert.ok(!('card' in config().profiles[name]) && !('variant' in config().profiles[name]), `${name}：card / variant 不写进 config.json`);
  }
});

test('checkPresetCards：同组 card 或 variant.label 不一致、variant 不完整、option 重复都报预设模板错误', () => {
  const card = { id: 'g', title: 'G', description: 'd' };
  const variant = (option, label = '套餐') => ({ label, option, help: 'h' });
  const preset = (name, c, v) => ({ name, profile: { card: c, variant: v } });
  checkPresetCards([preset('a', card, variant('一')), preset('b', card, variant('二')), { name: 'c', profile: {} }]);
  assert.throws(() => checkPresetCards([preset('a', card, variant('一')), preset('b', { ...card, title: 'H' }, variant('二'))]), /预设模板错误.*不一致/);
  assert.throws(() => checkPresetCards([preset('a', card, variant('一')), preset('b', card, variant('二', '版本'))]), /预设模板错误.*不一致/);
  assert.throws(() => checkPresetCards([preset('a', card, variant('一')), preset('b', card, variant('一'))]), /预设模板错误.*重复/);
  assert.throws(() => checkPresetCards([preset('a', card, undefined)]), /预设模板错误.*不完整/);
  assert.throws(() => checkPresetCards([preset('a', card, { label: '套餐', option: '一' })]), /预设模板错误.*不完整/);
});

test('--effort：add / update 写进执行者配置；update --effort "" 删除；不在可选值里只提示不拦', async t => {
  const { call, config } = setup(t);
  const added = await call(['agents', 'add', '--preset', 'deepseek', '--effort', 'high', '--json']);
  assert.equal(added.code, 0); assert.ok(!('warnings' in added.json), '在可选值里不提示');
  assert.equal(config().profiles.deepseek.effort, 'high');
  assert.equal((await call(['agents', 'update', 'deepseek', '--effort', 'max', '--json'])).json.profile.effort, 'max');
  assert.equal(config().profiles.deepseek.effort, 'max');

  const odd = await call(['agents', 'update', 'deepseek', '--effort', 'turbo']);
  assert.equal(odd.code, 0);
  assert.match(odd.text, /提示：推理强度 turbo 不在可选值（low、medium、high、xhigh、max）里；仍按你填的值传给执行者/);
  assert.equal(config().profiles.deepseek.effort, 'turbo', '不拦，原样写入');
  const oddJson = await call(['agents', 'update', 'deepseek', '--effort', 'turbo', '--json']);
  assert.equal(oddJson.json.warnings.length, 1);

  const cleared = await call(['agents', 'update', 'deepseek', '--effort', '', '--json']);
  assert.equal(cleared.code, 0); assert.ok(!('effort' in cleared.json.profile));
  assert.ok(!('effort' in config().profiles.deepseek), '空串删掉这一项');

  // 自定义名字的 Claude 类执行者按适配器找可选值；add 带不在可选值里的强度也提示。
  const ds = await call(['agents', 'add', '--preset', 'claude-native', '--name', 'cn', '--effort', 'minimal']);
  assert.match(ds.text, /提示：推理强度 minimal 不在可选值/);
  assert.match((await call(['agents', 'update', 'cn', '--effort', 'minimal'])).text, /提示：推理强度 minimal/);
  assert.doesNotMatch((await call(['agents', 'update', 'cn', '--effort', 'xhigh'])).text, /提示/);
  // Codex 的取值是它自己的那一套。
  const codex = await call(['agents', 'update', 'codex', '--effort', 'minimal']);
  assert.doesNotMatch(codex.text, /提示/);
  assert.equal(config().profiles.codex.effort, 'minimal');
  // Qoder 的强度写进配置，派发时由占位符 {effort} 带给程序。
  await call(['agents', 'add', '--preset', 'qoder-cn']);
  assert.doesNotMatch((await call(['agents', 'update', 'qoder-cn', '--effort', 'ultracode', '--model', 'Fast'])).text, /提示/);
  assert.deepEqual([config().profiles['qoder-cn'].effort, config().profiles['qoder-cn'].model], ['ultracode', 'Fast']);
  const none = await call(['agents', 'update', 'cn', '--json']);
  assert.equal(none.code, 2, '至少给一项');
});

test('models：有 listModels 就运行程序（带密钥与沙箱用户目录），否则用预设的 modelOptions；运行失败给预设的可选值', async t => {
  const { home, call, config, writeConfig, outputs } = setup(t);
  await call(['agents', 'add', '--preset', 'qoder-cn']);
  await call(['agents', 'add', '--preset', 'deepseek']);
  await call(['agents', 'add', '--preset', 'claude-native']);
  // 假程序顶替 qoderclicn：只换声明里的 executable，参数仍是预设的 listModels。
  const patch = patchFn => { const c = config(); patchFn(c.generics['qoder-cn']); writeConfig(c); };
  patch(decl => { decl.executable = modelsCli; });

  const cli = await call(['agents', 'models', 'qoder-cn', '--json']);
  assert.equal(cli.code, 0);
  // 表头 MODEL 与空行被跳过；token-ok / sandbox-ok 是假程序按收到的环境打印的标记；args 行证明只加了 listModels 的参数。
  assert.deepEqual(cli.json, { ok: true, models: ['A', 'B', 'token-ok', 'sandbox-ok', 'args:--list-models'], source: 'cli' });
  assert.ok(fs.existsSync(path.join(home, 'workers', 'qoder-cn', 'home')), '沙箱用户目录已建好');
  const text = await call(['agents', 'models', 'qoder-cn']);
  assert.match(text.text, /^模型（来自程序的列表）：\n {2}A\n {2}B\n/);

  // 预设来源。
  assert.deepEqual((await call(['agents', 'models', 'deepseek', '--json'])).json, { ok: true, models: ['deepseek-v4-pro', 'deepseek-v4-flash'], source: 'preset' });
  assert.deepEqual((await call(['agents', 'models', 'claude-native', '--json'])).json, { ok: true, models: [], source: 'preset' });
  assert.match((await call(['agents', 'models', 'claude-native'])).text, /没有可选的模型列表/);
  assert.match((await call(['agents', 'models', 'nope', '--json'])).json.error, /找不到执行者：nope/);

  // 运行失败：程序退出码非 0，错误里用声明的 failureHints，models 退回预设的 modelOptions。
  patch(decl => { decl.env = { MODELS_CLI_MODE: 'fail' }; });
  const failed = await call(['agents', 'models', 'qoder-cn', '--json']);
  assert.equal(failed.code, 1);
  assert.equal(failed.json.ok, false); assert.equal(failed.json.source, 'preset');
  assert.match(failed.json.error, /Qoder 国内版没有登录或令牌无效/);
  assert.deepEqual(failed.json.models, loadPreset('qoder-cn').profile.modelOptions);
  assert.match((await call(['agents', 'models', 'qoder-cn'])).text, /^列出模型失败：Qoder 国内版没有登录或令牌无效.*\n预设的可选值：\n {2}Auto\n/);

  // 找不到程序也是运行失败。
  patch(decl => { delete decl.env; decl.executable = path.join(home, '不存在的程序.mjs'); });
  const missing = await call(['agents', 'models', 'qoder-cn', '--json']);
  assert.equal(missing.json.ok, false); assert.match(missing.json.error, /找不到 Qoder（国内版） 的程序/);
  noToken(outputs);
});

test('models：缺令牌、超时都算运行失败，错误里没有令牌值', async t => {
  const { home, call, config, writeConfig, outputs } = setup(t, { token: false });
  await call(['agents', 'add', '--preset', 'qoder-cn']);
  const c = config(); c.generics['qoder-cn'].executable = modelsCli; writeConfig(c);
  const noKey = await call(['agents', 'models', 'qoder-cn', '--json']);
  assert.equal(noKey.json.ok, false); assert.match(noKey.json.error, /未设置密钥 QODERCN_PERSONAL_ACCESS_TOKEN/);
  assert.equal(noKey.json.models.length, 11);

  // 超时：假程序一直不退出，核心结束它并报错（超时设短一点）。
  const withKey = { ...process.env, AGENT_ROUTER_HOME: home, AR_TEST_SECRETS_FILE: path.join(home, '.test-secrets.json'), QODERCN_PERSONAL_ACCESS_TOKEN: TOKEN };
  const c2 = config(); c2.generics['qoder-cn'].env = { MODELS_CLI_MODE: 'hang' }; writeConfig(c2);
  const started = Date.now();
  const slow = await listAgentModels(home, 'qoder-cn', { env: withKey, timeoutMs: 600 });
  assert.equal(slow.ok, false); assert.match(slow.error, /超过 1 秒没有结束，已停止/);
  assert.equal(slow.source, 'preset');
  assert.ok(Date.now() - started < 20000, '超时后很快返回');
  noToken(outputs);
});

const declarationOf = () => structuredClone(loadPreset('qoder-cn').profile.generic);

test('validate：有效声明、有效导出文件；只读，不写配置', async t => {
  const { call, writeJson, configFile } = setup(t);
  const bare = writeJson('decl.json', declarationOf());
  const ok = await call(['agents', 'validate', bare]);
  assert.equal(ok.code, 0); assert.equal(ok.text, '声明有效');
  assert.deepEqual((await call(['agents', 'validate', bare, '--json'])).json, { ok: true, errors: [], warnings: [] });

  await call(['agents', 'add', '--preset', 'qoder-cn']);
  const exported = path.join(path.dirname(bare), 'out.json');
  assert.equal((await call(['agents', 'export', 'qoder-cn', '--out', exported])).code, 0);
  const okExport = await call(['agents', 'validate', exported]);
  assert.equal(okExport.code, 0); assert.equal(okExport.text, '声明有效');
  fs.rmSync(configFile);
  assert.equal((await call(['agents', 'validate', exported])).code, 0);
  assert.ok(!fs.existsSync(configFile), 'validate 不写配置');

  // 警告逐条列出：output.format 为 text 却写了 map。
  const warn = writeJson('warn.json', { ...declarationOf(), output: { format: 'text', map: [] } });
  const warned = await call(['agents', 'validate', warn]);
  assert.equal(warned.code, 0);
  assert.equal(warned.text, '声明有效\n警告 generic.output.map：format 为 text 时 output.map 不会被用到，可以删掉。');
  assert.equal((await call(['agents', 'validate', warn, '--json'])).json.warnings[0].path, 'generic.output.map');
});

test('validate：无效声明逐条列出 <路径>：<原因>，退出码 2；读不到文件、不是 JSON 也是不通过', async t => {
  const { call, writeJson, file } = setup(t);
  const decl = declarationOf();
  decl.args = ['-p', '{nope}', 'x'];
  delete decl.executable;
  decl.extra = 1;
  const bad = writeJson('bad.json', decl);
  const r = await call(['agents', 'validate', bad, '--json']);
  assert.equal(r.code, 2); assert.equal(r.json.ok, false);
  const byPath = Object.fromEntries(r.json.errors.map(e => [e.path, e.message]));
  assert.match(byPath['generic.executable'], /缺少必填字段 executable/);
  assert.match(byPath['generic.args[1]'], /未知占位符 \{nope\}/);
  assert.match(byPath['generic.extra'], /不认识的字段 "extra"/);
  const text = await call(['agents', 'validate', bad]);
  assert.equal(text.code, 2);
  assert.ok(text.out.join('\n').split('\n').includes(`generic.executable：${byPath['generic.executable']}`));

  fs.writeFileSync(file('notjson.json'), '{ 这不是 JSON');
  const notJson = await call(['agents', 'validate', file('notjson.json'), '--json']);
  assert.equal(notJson.code, 2); assert.match(notJson.json.errors[0].message, /不是有效的 JSON/);
  const gone = await call(['agents', 'validate', file('不存在.json'), '--json']);
  assert.equal(gone.code, 2); assert.match(gone.json.errors[0].message, /读不到文件/);
  const arr = writeJson('arr.json', []);
  assert.equal((await call(['agents', 'validate', arr, '--json'])).code, 2);
  const kind = writeJson('kind.json', { kind: 'other' });
  assert.match((await call(['agents', 'validate', kind, '--json'])).json.errors[0].message, /不认识的文件类型/);
  // 带 BOM 的文件（Windows PowerShell 写出的）也能读。
  fs.writeFileSync(file('bom.json'), `\uFEFF${JSON.stringify(declarationOf())}`);
  assert.equal((await call(['agents', 'validate', file('bom.json')])).code, 0);
});

test('validate：导出文件检查执行者配置——适配器、secrets 的值像密钥、版本和名字', async t => {
  const { call, writeJson } = setup(t);
  await call(['agents', 'add', '--preset', 'qoder-cn']);
  const good = (await call(['agents', 'export', 'qoder-cn', '--json'])).json.bundle;
  const mutate = fn => { const b = structuredClone(good); fn(b); return b; };
  const errorsOf = async bundle => (await call(['agents', 'validate', writeJson('b.json', bundle), '--json'])).json;

  const secret = await errorsOf(mutate(b => { b.profile.secrets.QODERCN_PERSONAL_ACCESS_TOKEN = 'sk-abcdefghijklmnop'; }));
  assert.equal(secret.ok, false);
  assert.equal(secret.errors[0].path, 'profile.secrets.QODERCN_PERSONAL_ACCESS_TOKEN');
  assert.match(secret.errors[0].message, /不是合法的环境变量名.*不写密钥本身/);
  const longValue = await errorsOf(mutate(b => { b.profile.secrets.QODERCN_PERSONAL_ACCESS_TOKEN = 'aB'.repeat(25); }));
  assert.equal(longValue.errors[0].path, 'profile.secrets.QODERCN_PERSONAL_ACCESS_TOKEN');
  assert.match(longValue.errors[0].message, /像真实密钥/);

  assert.equal((await errorsOf(mutate(b => { b.profile.adapter = 'nope'; }))).errors[0].path, 'profile.adapter');
  assert.equal((await errorsOf(mutate(b => { b.v = 2; }))).errors[0].path, 'v');
  assert.equal((await errorsOf(mutate(b => { b.name = 'Bad Name'; }))).errors[0].path, 'name');
  assert.equal((await errorsOf(mutate(b => { b.profile = 3; }))).errors[0].path, 'profile');
  const noDecl = await errorsOf(mutate(b => { b.generic = null; }));
  assert.equal(noDecl.errors[0].path, 'generic'); assert.match(noDecl.errors[0].message, /必须带通用适配器声明/);
  const innerBad = await errorsOf(mutate(b => { b.generic.args = ['-p', '{nope}']; }));
  assert.equal(innerBad.errors[0].path, 'generic.args[1]'); assert.match(innerBad.errors[0].message, /未知占位符 \{nope\}/);
  const auth = await errorsOf(mutate(b => { b.profile.secrets = {}; delete b.generic.secrets; }));
  assert.equal(auth.ok, false); assert.match(auth.errors[0].message, /auth 为 token，但 secrets 为空/);
  // 非 generic 的执行者带着声明：只是警告。
  const extra = await errorsOf({ v: 1, kind: 'agentrouter-agent', name: 'x', profile: { adapter: 'fake', label: 'x' }, generic: declarationOf() });
  assert.equal(extra.ok, true); assert.equal(extra.warnings[0].path, 'generic');
  assert.equal(good.generic.executable, 'qoderclicn');
});

test('export：去掉本机状态；generic 执行者带声明，其他为 null；--out 已存在时拒绝，--force 覆盖；文件 UTF-8 无 BOM', async t => {
  const { call, config, writeConfig, file } = setup(t);
  await call(['agents', 'add', '--preset', 'claude-native', '--effort', 'high']);
  await call(['agents', 'add', '--preset', 'qoder-cn', '--model', 'Fast']);
  const c = config();
  Object.assign(c.profiles['claude-native'], { limits: { maxTasksPerDay: 5 }, path: 'C:\\本机\\claude.exe' });
  c.profiles['claude-native'].price = { inputPer1M: 1, outputPer1M: 2, currency: 'USD' };
  writeConfig(c);

  const plain = (await call(['agents', 'export', 'claude-native', '--json'])).json;
  assert.equal(plain.ok, true); assert.equal(plain.file, null);
  assert.deepEqual(Object.keys(plain.bundle), ['v', 'kind', 'name', 'profile', 'generic']);
  assert.deepEqual({ v: plain.bundle.v, kind: plain.bundle.kind, name: plain.bundle.name, generic: plain.bundle.generic }, { v: 1, kind: 'agentrouter-agent', name: 'claude-native', generic: null });
  for (const key of ['enabled', 'price', 'limits', 'path']) assert.ok(!(key in plain.bundle.profile), `${key} 不导出`);
  assert.equal(plain.bundle.profile.effort, 'high'); assert.equal(plain.bundle.profile.adapter, 'claude-code');
  assert.deepEqual(plain.bundle.profile.secrets, { ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' }, 'secrets 只有变量名，保留');

  const printed = await call(['agents', 'export', 'claude-native']);
  assert.deepEqual(JSON.parse(printed.text), plain.bundle, '没有 --out 时把 JSON 打印到标准输出');

  const out = file('qoder-cn.agent.json');
  const r = await call(['agents', 'export', 'qoder-cn', '--out', out, '--json']);
  assert.equal(r.code, 0); assert.equal(r.json.file, out); assert.ok(!('bundle' in r.json));
  const bytes = fs.readFileSync(out);
  assert.notEqual(bytes[0], 0xEF, '没有 BOM'); assert.equal(bytes.at(-1), 0x0A, '末尾换行');
  const bundle = JSON.parse(bytes.toString('utf8'));
  assert.equal(bundle.generic.executable, 'qoderclicn'); assert.equal(bundle.profile.generic, 'qoder-cn'); assert.equal(bundle.profile.model, 'Fast');
  assert.ok(!('enabled' in bundle.profile));

  const exists = await call(['agents', 'export', 'qoder-cn', '--out', out, '--json']);
  assert.equal(exists.code, 2); assert.match(exists.json.error, /文件已存在/);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), bundle, '拒绝时不改原文件');
  fs.writeFileSync(out, 'old');
  const forced = await call(['agents', 'export', 'qoder-cn', '--out', out, '--force', '--json']);
  assert.equal(forced.code, 0); assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), bundle);

  assert.match((await call(['agents', 'export', 'nope', '--json'])).json.error, /找不到执行者：nope/);
  assert.equal((await call(['agents', 'export', 'qoder-cn', '--force', '--json'])).code, 2, '--force 要和 --out 一起用');
});

test('export：secrets 的值像密钥、声明丢失或不合法时拒绝导出', async t => {
  const { call, config, writeConfig } = setup(t);
  await call(['agents', 'add', '--preset', 'qoder-cn']);
  const pristine = config();
  const withChange = fn => { const c = structuredClone(pristine); fn(c); writeConfig(c); };

  withChange(c => { c.profiles['qoder-cn'].secrets = { QODERCN_PERSONAL_ACCESS_TOKEN: 'aB'.repeat(25) }; });
  const secret = await call(['agents', 'export', 'qoder-cn', '--json']);
  assert.equal(secret.code, 2); assert.match(secret.json.error, /不能导出/); assert.match(secret.json.error, /profile\.secrets\.QODERCN_PERSONAL_ACCESS_TOKEN：.*像真实密钥/);
  assert.ok(!secret.json.error.includes('aB'.repeat(25)), '错误里不带那个值');

  withChange(c => { delete c.generics['qoder-cn']; });
  assert.match((await call(['agents', 'export', 'qoder-cn', '--json'])).json.error, /找不到通用适配器声明：config\.json 的 generics\.qoder-cn/);
  withChange(c => { c.generics['qoder-cn'].args = ['-p', '{nope}']; });
  assert.match((await call(['agents', 'export', 'qoder-cn', '--json'])).json.error, /generic\.args\[1\]：.*未知占位符 \{nope\}/);
});

test('import：校验不通过什么都不写；同名拒绝、--force 覆盖、--name 改名；单独的声明不能导入', async t => {
  const { call, config, writeJson, file, configFile } = setup(t);
  await call(['agents', 'add', '--preset', 'qoder-cn']);
  const exported = file('a.agent.json');
  await call(['agents', 'export', 'qoder-cn', '--out', exported]);
  const bundle = JSON.parse(fs.readFileSync(exported, 'utf8'));

  // 不通过：什么都不写。
  const before = fs.readFileSync(configFile, 'utf8');
  const bad = writeJson('bad.agent.json', { ...bundle, generic: { ...bundle.generic, args: ['-p', '{nope}'] } });
  const refused = await call(['agents', 'import', bad, '--name', 'other', '--json']);
  assert.equal(refused.code, 2); assert.equal(refused.json.ok, false); assert.match(refused.json.error, /没有导入/);
  assert.equal(refused.json.errors[0].path, 'generic.args[1]');
  assert.equal(fs.readFileSync(configFile, 'utf8'), before, '配置一个字节都没动');
  const refusedText = await call(['agents', 'import', bad, '--name', 'other']);
  assert.equal(refusedText.code, 2); assert.match(refusedText.text, /^文件不合法，没有导入：\ngeneric\.args\[1\]：/);
  const lone = writeJson('lone.json', declarationOf());
  const loneResult = await call(['agents', 'import', lone, '--json']);
  assert.equal(loneResult.code, 2); assert.match(loneResult.json.errors[0].message, /单独的通用适配器声明/);

  // 同名拒绝。
  const same = await call(['agents', 'import', exported, '--json']);
  assert.equal(same.code, 2); assert.match(same.json.error, /已有执行者 qoder-cn.*--force/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);

  // --name 改名：声明跟着改名。
  const renamed = await call(['agents', 'import', exported, '--name', 'q2', '--json']);
  assert.equal(renamed.code, 0); assert.equal(renamed.json.name, 'q2'); assert.equal(renamed.json.overwritten, false);
  assert.equal(config().profiles.q2.generic, 'q2'); assert.deepEqual(config().generics.q2, bundle.generic);
  assert.equal(config().profiles.q2.enabled, true);
  assert.deepEqual(renamed.json.secretStatus, { QODERCN_PERSONAL_ACCESS_TOKEN: 'set' });

  // generics 里已有同名声明（没有执行者）也拒绝；--force 才覆盖。
  const c = config(); c.generics.orphan = { label: '旧' }; fs.writeFileSync(configFile, JSON.stringify(c));
  const clash = await call(['agents', 'import', exported, '--name', 'orphan', '--json']);
  assert.equal(clash.code, 2); assert.match(clash.json.error, /generics 里已有同名声明 orphan/);
  assert.ok(!config().profiles.orphan);
  assert.equal((await call(['agents', 'import', exported, '--name', 'orphan', '--force', '--json'])).code, 0);
  assert.deepEqual(config().generics.orphan, bundle.generic);

  // --force 覆盖同名执行者：新的内容取代旧的。
  const changed = { ...bundle, profile: { ...bundle.profile, model: 'GLM-5.3', label: '覆盖后' } };
  const forced = await call(['agents', 'import', writeJson('changed.agent.json', changed), '--force', '--json']);
  assert.equal(forced.code, 0); assert.equal(forced.json.overwritten, true);
  assert.equal(config().profiles['qoder-cn'].model, 'GLM-5.3'); assert.equal(config().profiles['qoder-cn'].label, '覆盖后');

  // 声明还被别的执行者引用时，不能用 --force 覆盖它。
  const shared = config(); shared.profiles.user = { adapter: 'generic', generic: 'shared-decl', label: 'u', enabled: true }; shared.generics['shared-decl'] = bundle.generic; fs.writeFileSync(configFile, JSON.stringify(shared));
  const held = await call(['agents', 'import', exported, '--name', 'shared-decl', '--force', '--json']);
  assert.equal(held.code, 2); assert.match(held.json.error, /还被执行者 user 引用/);
});

test('import：默认执行者与 add 一致；缺密钥时提示；往返得到相同的执行者配置和声明', async t => {
  const a = setup(t);
  await a.call(['agents', 'add', '--preset', 'qoder-cn', '--model', 'Qwen3.8-Max', '--effort', 'xhigh', '--label', '我的 Qoder']);
  await a.call(['agents', 'add', '--preset', 'claude-native', '--effort', 'high', '--secret-var', 'MY_CLAUDE_KEY']);
  const qoderFile = a.file('qoder.agent.json'), claudeFile = a.file('claude.agent.json');
  await a.call(['agents', 'export', 'qoder-cn', '--out', qoderFile]);
  await a.call(['agents', 'export', 'claude-native', '--out', claudeFile]);

  // 另一个隔离目录：没有令牌，也没有任何配置。
  const b = setup(t, { token: false });
  const imported = await b.call(['agents', 'import', qoderFile]);
  assert.equal(imported.code, 0);
  assert.match(imported.text, /^已导入执行者 qoder-cn\n默认执行者改为 qoder-cn/);
  assert.match(imported.text, /还没有设置密钥：QODERCN_PERSONAL_ACCESS_TOKEN。运行 ar secrets set QODERCN_PERSONAL_ACCESS_TOKEN/);
  assert.equal(b.config().defaultProfile, 'qoder-cn');
  assert.deepEqual(b.config().profiles['qoder-cn'], a.config().profiles['qoder-cn'], '执行者配置相同');
  assert.deepEqual(b.config().generics['qoder-cn'], a.config().generics['qoder-cn'], '声明相同');

  // 默认执行者已是非 Codex 的，导入不改默认。
  const claude = await b.call(['agents', 'import', claudeFile, '--json']);
  assert.equal(claude.code, 0); assert.equal(claude.json.madeDefault, false);
  assert.deepEqual(claude.json.secrets, ['MY_CLAUDE_KEY']);
  assert.equal(b.config().defaultProfile, 'qoder-cn');
  const { price, ...claudeWithoutPrice } = a.config().profiles['claude-native'];
  assert.ok(price, '来源配置里有价格这一项本机状态');
  assert.deepEqual(b.config().profiles['claude-native'], claudeWithoutPrice, '除了价格，执行者配置相同');
  assert.deepEqual(Object.keys(b.config().generics), ['qoder-cn'], '非 generic 的执行者不写声明');

  // 导入的执行者能直接用：声明通过与派发相同的解析。
  const models = await b.call(['agents', 'models', 'qoder-cn', '--json']);
  assert.equal(models.json.source, 'preset', '程序 qoderclicn 不在测试机上时给预设的可选值，不抛错');
  noToken([...a.outputs, ...b.outputs]);
});

test('import：覆盖导出文件里的本机状态——文件里带 enabled / price / limits / path 时不照搬', async t => {
  const { call, config, writeJson } = setup(t);
  await call(['agents', 'add', '--preset', 'claude-native', '--name', 'src']);
  const bundle = (await call(['agents', 'export', 'src', '--json'])).json.bundle;
  bundle.profile = { ...bundle.profile, enabled: false, price: { inputPer1M: 9, outputPer1M: 9, currency: 'USD' }, limits: { maxTasksPerDay: 1 }, path: 'C:\\本机\\x.exe' };
  const r = await call(['agents', 'import', writeJson('local.agent.json', bundle), '--name', 'copy', '--json']);
  assert.equal(r.code, 0);
  const copy = config().profiles.copy;
  assert.equal(copy.enabled, true);
  for (const key of ['price', 'limits', 'path']) assert.ok(!(key in copy), `${key} 不导入`);
});

test('remove：generic 执行者的声明没有别人引用时一并删除；还有人引用就保留', async t => {
  const { call, config, writeConfig } = setup(t);
  await call(['agents', 'add', '--preset', 'qoder-cn']);
  await call(['agents', 'add', '--preset', 'qoder']);
  const removed = await call(['agents', 'remove', 'qoder-cn', '--json']);
  assert.equal(removed.code, 0); assert.equal(removed.json.removedGeneric, 'qoder-cn');
  assert.ok(!('qoder-cn' in config().generics)); assert.ok('qoder' in config().generics, '别的声明不动');

  // 两个执行者共用一份声明：删一个保留，删最后一个才清理。
  const c = config();
  c.profiles.twin = { ...c.profiles.qoder };
  writeConfig(c);
  const first = await call(['agents', 'remove', 'qoder', '--json']);
  assert.ok(!('removedGeneric' in first.json)); assert.ok('qoder' in config().generics);
  const second = await call(['agents', 'remove', 'twin', '--json']);
  assert.equal(second.json.removedGeneric, 'qoder'); assert.deepEqual(config().generics, {});

  // 非 generic 的执行者删除时结果不带 removedGeneric；generics 里无关的声明不会被误删。
  await call(['agents', 'add', '--preset', 'deepseek']);
  const keep = config(); keep.generics.manual = { label: '手写' }; writeConfig(keep);
  const ds = await call(['agents', 'remove', 'deepseek', '--json']);
  assert.ok(!('removedGeneric' in ds.json)); assert.deepEqual(config().generics, { manual: { label: '手写' } });
});

// ---- 107：测试连接带上 generic 声明；自定义 CLI 表单用的 --decl 命令；add --generic；update --escalate ----
const textCli = path.resolve('tests/fixtures/generic/text-cli.mjs'), jsonlCli = path.resolve('tests/fixtures/generic/jsonl-cli.mjs');
const textDecl = (extra = {}) => ({ label: 'Text CLI', executable: process.execPath, detect: [textCli, '--version'], args: [textCli, 'run', '{promptFile}'], output: { format: 'text' }, ...extra });
const jsonlDecl = () => {
  const text = fs.readFileSync('tests/fixtures/generic/jsonl-decl.json', 'utf8').replaceAll('@SCRIPT@', jsonlCli.replaceAll('\\', '\\\\'));
  return { ...JSON.parse(text), executable: process.execPath };
};

test('agents test：generic 执行者的声明一并写进临时配置，测试通过；声明不存在时照派发的规则报错', async t => {
  const { call, writeConfig, config } = setup(t, { token: false });
  writeConfig({ v: 2, defaultProfile: 'txt', profiles: { txt: { adapter: 'generic', generic: 'txt', label: 'Text CLI', enabled: true, escalate: 'nobody' } }, generics: { txt: textDecl() }, managed: false, watchWindow: 'never' });
  const ok = await call(['agents', 'test', 'txt', '--timeout', '60', '--json']);
  assert.equal(ok.code, 0, ok.text);
  assert.equal(ok.json.ok, true); assert.equal(ok.json.version, 'text-cli 1.2.3'); assert.match(ok.json.report, /OK/);
  assert.equal(config().profiles.txt.escalate, 'nobody', '测试不改你的配置');

  const broken = config(); delete broken.generics.txt; writeConfig(broken);
  const gone = await call(['agents', 'test', 'txt', '--json']);
  assert.equal(gone.code, 2); assert.match(gone.json.error, /找不到通用适配器声明：config\.json 的 generics\.txt/);
});

test('validate --decl / detect --decl：只用声明，不读不写配置', async t => {
  const { call, configFile } = setup(t, { token: false });
  const good = await call(['agents', 'validate', '--decl', JSON.stringify(textDecl()), '--json']);
  assert.equal(good.code, 0); assert.deepEqual(good.json, { ok: true, errors: [], warnings: [] });
  const bad = await call(['agents', 'validate', '--decl', JSON.stringify(textDecl({ args: ['run', '{bogus}'] })), '--json']);
  assert.equal(bad.code, 2); assert.equal(bad.json.ok, false);
  assert.ok(bad.json.errors.some(e => e.path === 'generic.args[1]' && /未知占位符 \{bogus\}/.test(e.message)), JSON.stringify(bad.json.errors));
  const notJson = await call(['agents', 'validate', '--decl', '{ 不是 JSON', '--json']);
  assert.equal(notJson.code, 2); assert.match(notJson.json.errors[0].message, /不是有效的 JSON/);

  const found = await call(['agents', 'detect', '--decl', JSON.stringify(textDecl()), '--json']);
  assert.equal(found.code, 0); assert.deepEqual(found.json, { ok: true, installed: true, version: 'text-cli 1.2.3' });
  const missing = await call(['agents', 'detect', '--decl', JSON.stringify(textDecl({ executable: path.join(os.tmpdir(), '不存在的程序-ar107') })), '--json']);
  assert.equal(missing.json.installed, false); assert.equal(missing.json.version, null);
  assert.equal((await call(['agents', 'detect', '--decl', JSON.stringify({ label: 'x' }), '--json'])).json.installed, false);
  assert.ok(!fs.existsSync(configFile), '这些命令不写配置');
});

test('test --decl：不写配置地跑一次"只回复 OK"，返回原始输出、映射出的事件、没有符合规则的行', async t => {
  const { call, configFile, home } = setup(t, { token: false });
  const ok = await call(['agents', 'test', '--decl', JSON.stringify(textDecl()), '--timeout', '30', '--json']);
  assert.equal(ok.code, 0, ok.text);
  assert.equal(ok.json.ok, true); assert.equal(ok.json.exit, 0); assert.match(ok.json.report, /OK/);
  assert.ok(ok.json.output.length >= 4 && ok.json.output.every(l => l.stream === 'stdout' && l.events.length === 1 && l.events[0].kind === 'text'));
  assert.deepEqual(ok.json.unmatched, []);

  const jl = await call(['agents', 'test', '--decl', JSON.stringify(jsonlDecl()), '--timeout', '30', '--json']);
  assert.equal(jl.code, 1, `汇报是最后一句话"完成"，不含 OK，不算通过：${jl.text}`);
  assert.equal(jl.json.ok, false); assert.equal(jl.json.exit, 0); assert.equal(jl.json.report, '完成'); assert.match(jl.json.error, /没有 OK/);
  const kinds = jl.json.output.map(l => l.events.map(e => e.kind).join('+'));
  assert.deepEqual(kinds.slice(0, 4), ['say', 'think', 'cmd', 'cmd']);
  assert.deepEqual(jl.json.unmatched, [9], '只有 {"mystery":true} 一行没有符合的规则（非 JSON 行按文本事件算）');
  assert.equal(jl.json.output[9].events[0].kind, 'text');

  const fail = await call(['agents', 'test', '--decl', JSON.stringify(textDecl({ args: [textCli, '--fail', '{promptFile}'], failureHints: [{ match: 'not logged in', text: '请先登录 Text CLI。' }] })), '--json']);
  assert.equal(fail.code, 1); assert.equal(fail.json.exit, 1); assert.equal(fail.json.error, '请先登录 Text CLI。');
  assert.ok(fail.json.output.some(l => l.stream === 'stderr' && l.text === 'not logged in'));

  const invalid = await call(['agents', 'test', '--decl', JSON.stringify(textDecl({ args: ['{bogus}'] })), '--json']);
  assert.equal(invalid.code, 2); assert.equal(invalid.json.ok, false); assert.ok(invalid.json.errors.length);
  const slow = await call(['agents', 'test', '--decl', JSON.stringify(textDecl({ args: ['-e', 'setInterval(()=>{},1000)', '{promptFile}'] })), '--timeout', '1', '--json']);
  assert.equal(slow.json.ok, false); assert.equal(slow.json.timedOut, true); assert.match(slow.json.error, /超过 1 秒/);
  assert.ok(!fs.existsSync(configFile), '不写配置');
  assert.ok(!fs.existsSync(path.join(home, 'workers')), '沙箱目录建在临时目录里，不在公共目录');
});

test('add --generic：声明写进 generics.<名>，执行者配置引用名字；声明不合法、重名时什么都不写', async t => {
  const { call, config, writeConfig, configFile } = setup(t, { token: false });
  const bad = await call(['agents', 'add', '--generic', JSON.stringify(textDecl({ args: ['{bogus}'] })), '--name', 'mine', '--json']);
  assert.equal(bad.code, 2); assert.match(bad.json.error, /声明不合法[\s\S]*generic\.args\[0\]/);
  assert.ok(!fs.existsSync(configFile), '声明不合法时什么都不写');
  assert.equal((await call(['agents', 'add', '--generic', JSON.stringify(textDecl()), '--json'])).code, 2, '缺 --name');

  const decl = textDecl({ secrets: { EXAMPLE_API_KEY: 'EXAMPLE_API_KEY' } });
  const added = await call(['agents', 'add', '--generic', JSON.stringify(decl), '--name', 'mine', '--label', '我的 CLI', '--json']);
  assert.equal(added.code, 0, added.text);
  assert.equal(added.json.name, 'mine'); assert.deepEqual(added.json.secrets, ['EXAMPLE_API_KEY']);
  assert.deepEqual(config().generics.mine, decl);
  assert.deepEqual(config().profiles.mine, { adapter: 'generic', generic: 'mine', label: '我的 CLI', enabled: true, auth: 'token', secrets: { EXAMPLE_API_KEY: 'EXAMPLE_API_KEY' } });
  assert.equal(config().defaultProfile, 'mine');
  const dup = await call(['agents', 'add', '--generic', JSON.stringify(textDecl()), '--name', 'mine', '--json']);
  assert.equal(dup.code, 2); assert.match(dup.json.error, /已有执行者 mine/);
  const lone = config(); delete lone.profiles.mine; writeConfig(lone);
  assert.match((await call(['agents', 'add', '--generic', JSON.stringify(textDecl()), '--name', 'mine', '--json'])).json.error, /generics 里已有同名声明 mine/);
});

test('update --escalate：必须是已有执行者且不是自己；空串删除', async t => {
  const { call, config } = setup(t, { token: false });
  await call(['agents', 'add', '--preset', 'deepseek']); await call(['agents', 'add', '--preset', 'mimo']);
  assert.equal((await call(['agents', 'update', 'deepseek', '--escalate', 'mimo', '--json'])).code, 0);
  assert.equal(config().profiles.deepseek.escalate, 'mimo');
  const self = await call(['agents', 'update', 'deepseek', '--escalate', 'deepseek', '--json']);
  assert.equal(self.code, 2); assert.match(self.json.error, /不能是执行者自己/);
  const none = await call(['agents', 'update', 'deepseek', '--escalate', 'nobody', '--json']);
  assert.equal(none.code, 2); assert.match(none.json.error, /升级目标不存在：nobody/);
  assert.equal(config().profiles.deepseek.escalate, 'mimo', '被拒绝时不改配置');
  assert.equal((await call(['agents', 'update', 'deepseek', '--escalate', '', '--json'])).code, 0);
  assert.ok(!('escalate' in config().profiles.deepseek));
});

test('qoder-cn 预设默认模型 DeepSeek-Flash、推理强度 ultracode；国际版不变', async t => {
  const { call, config } = setup(t);
  await call(['agents', 'add', '--preset', 'qoder-cn']); await call(['agents', 'add', '--preset', 'qoder']);
  assert.deepEqual([config().profiles['qoder-cn'].model, config().profiles['qoder-cn'].effort], ['DeepSeek-Flash', 'ultracode']);
  assert.deepEqual([config().profiles.qoder.model, config().profiles.qoder.effort], [null, null]);
  assert.ok(loadPreset('qoder-cn').profile.modelOptions.includes('DeepSeek-Flash') && loadPreset('qoder-cn').profile.effortOptions.includes('ultracode'));
});
test('presets --json：预设给了默认模型 / 推理强度（Qoder 国内版）时带 model / effort，没给的不带', async t => {
  const { call } = setup(t);
  const by = Object.fromEntries((await call(['agents', 'presets', '--json'])).json.presets.map(p => [p.name, p]));
  assert.deepEqual([by['qoder-cn'].model, by['qoder-cn'].effort], ['DeepSeek-Flash', 'ultracode']);
  for (const name of ['qoder', 'deepseek', 'codex', 'openai-compat']) assert.ok(!('model' in by[name]) && !('effort' in by[name]), name);
});