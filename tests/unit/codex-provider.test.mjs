import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codex, providerArgs } from '../../core/adapters/codex.mjs';
import { buildEnv } from '../../core/lib/env.mjs';
import { resolveSettings } from '../../core/lib/config.mjs';

// 不真实调用接口、不碰真实 ~/.codex：只检查生成的参数数组与环境。
const detection = { launcher: { executable: 'codex', args: [] } };
const root = path.join(os.tmpdir(), 'ar-codex-provider-root');
const report = path.join(root, 'report.md');
const provider = { baseUrl: 'https://api.example.com', wireApi: 'responses' };
const profile = { adapter: 'codex', label: 'DeepSeek（OpenAI 格式）', enabled: true, auth: 'token', model: 'deepseek-v4-flash', provider, secrets: { EXAMPLE_API_KEY: 'EXAMPLE_API_KEY' } };
const command = (p, settings, env = {}, extra = {}) => codex.command({ root, report, prompt: '任务', settings, detection, env, profile: p, ...extra });

test('有 provider：在 -C 之后、-o 之前加整组 -c，每项一个参数，-m 跟在后面', () => {
  const { args, stdin } = command(profile, { model: 'deepseek-v4-flash', sandbox: 'workspace-write' }, {}, { profileName: 'deepseek-openai' });
  assert.deepEqual(args, ['exec', '--json', '-C', root,
    '-c', 'model_provider="ar-deepseek-openai"',
    '-c', 'model_providers.ar-deepseek-openai.name="DeepSeek（OpenAI 格式）"',
    '-c', 'model_providers.ar-deepseek-openai.base_url="https://api.example.com"',
    '-c', 'model_providers.ar-deepseek-openai.env_key="EXAMPLE_API_KEY"',
    '-c', 'model_providers.ar-deepseek-openai.wire_api="responses"',
    '-m', 'deepseek-v4-flash', '-s', 'workspace-write', '-o', report, '-']);
  assert.equal(stdin, '任务');
});

test('有 provider：推理强度等其他 -c 排在接口参数之后；wireApi 没写时默认 responses；没有 label 用配置名', () => {
  const p = { ...profile, label: undefined, provider: { baseUrl: 'https://api.example.com' } };
  const { args } = command(p, { model: p.model, effort: 'high' }, {}, { profileName: 'x1' });
  assert.deepEqual(args.slice(4, 14), ['-c', 'model_provider="ar-x1"', '-c', 'model_providers.ar-x1.name="x1"', '-c', 'model_providers.ar-x1.base_url="https://api.example.com"',
    '-c', 'model_providers.ar-x1.env_key="EXAMPLE_API_KEY"', '-c', 'model_providers.ar-x1.wire_api="responses"']);
  assert.ok(args.indexOf('model_reasoning_effort="high"') > args.indexOf('-m'));
});

test('有 provider：值里的引号、反斜杠按 TOML 基本字符串转义，整项仍是一个参数', () => {
  const args = providerArgs({ name: 'q', label: 'a"b\\c', provider: { baseUrl: 'https://api.example.com/v1?x="1"\\y' }, secrets: { K: 'K' } });
  assert.equal(args.length, 10);
  assert.equal(args[3], 'model_providers.ar-q.name="a\\"b\\\\c"');
  assert.equal(args[5], 'model_providers.ar-q.base_url="https://api.example.com/v1?x=\\"1\\"\\\\y"');
  assert.ok(args.filter((_, i) => i % 2 === 0).every(a => a === '-c'));
});

test('有 provider：接口名来自 profileName（不看 CODEX_HOME 的路径），没传用 custom；不建任何目录', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-codex-provider-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const codexHome = path.join(base, 'workers', 'my-oai', 'codex');
  assert.ok(command(profile, { model: profile.model }, { CODEX_HOME: codexHome }, { profileName: 'other-name' }).args.includes('model_provider="ar-other-name"'));
  assert.ok(command(profile, { model: profile.model }, { CODEX_HOME: codexHome }).args.includes('model_provider="ar-custom"'), '路径里的名字不再被反推');
  assert.ok(!fs.existsSync(codexHome), '核心不再替 provider 执行者建 CODEX_HOME');
});

test('没有 provider：参数与以前逐字相同（传不传 profile 都一样），不建目录', () => {
  const settings = { model: 'm', effort: 'high', tier: 'fast', sandbox: 'workspace-write' };
  const expected = ['exec', '--json', '-C', root, '-m', 'm', '-c', 'model_reasoning_effort="high"', '-c', 'service_tier="fast"', '-s', 'workspace-write', '-o', report, '-'];
  const plain = { adapter: 'codex', label: 'Codex', auth: 'login' };
  assert.deepEqual(command(undefined, settings).args, expected);
  assert.deepEqual(command(plain, settings, { CODEX_HOME: path.join(os.tmpdir(), 'ar-不应创建') }).args, expected);
  assert.deepEqual(command({ ...plain, provider: null }, { sandbox: 'read-only' }).args, ['exec', '--json', '-C', root, '-s', 'read-only', '-o', report, '-']);
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'ar-不应创建')));
});

test('readOnly（调研 / 审查类任务）：参数里是 -s read-only，覆盖 settings.sandbox；没有设置 sandbox 时也加；不影响其余参数的顺序', () => {
  const settings = { model: 'm', effort: 'high', sandbox: 'workspace-write' };
  assert.deepEqual(command(undefined, settings, {}, { readOnly: true }).args,
    ['exec', '--json', '-C', root, '-m', 'm', '-c', 'model_reasoning_effort="high"', '-s', 'read-only', '-o', report, '-']);
  assert.deepEqual(command(undefined, {}, {}, { readOnly: true }).args, ['exec', '--json', '-C', root, '-s', 'read-only', '-o', report, '-']);
  // 有 provider 的执行者同样：-s read-only 紧跟在 -m 之后。
  const { args } = command(profile, { model: profile.model, sandbox: 'danger-full-access' }, {}, { profileName: 'oai', readOnly: true });
  assert.deepEqual(args.slice(-7), ['-m', 'deepseek-v4-flash', '-s', 'read-only', '-o', report, '-']);
  assert.equal(args.filter(a => a === '-s').length, 1, '只有一个 -s');
  // 不只读（没传或传 false）与以前逐字相同。
  assert.deepEqual(command(undefined, settings, {}, { readOnly: false }).args, command(undefined, settings).args);
  assert.ok(command(undefined, settings).args.includes('workspace-write'));
});

test('isolate：有没有 provider 都指向用户真实 ~/.codex（没设 CODEX_HOME 时），不再设 set', () => {
  const home = path.join(os.tmpdir(), 'ar-home');
  const withProvider = codex.isolate({ home, profileName: 'oai', profile });
  assert.equal(withProvider.set, undefined);
  assert.deepEqual(withProvider, { keep: ['CODEX_HOME', 'OPENAI_BASE_URL'], realHomeDefaults: { CODEX_HOME: '.codex' } });
  for (const arg of [{ home, profileName: 'codex', profile: { adapter: 'codex', auth: 'login' } }, { home, profileName: 'codex' }, undefined]) {
    assert.deepEqual(codex.isolate(arg), { keep: ['CODEX_HOME', 'OPENAI_BASE_URL'], realHomeDefaults: { CODEX_HOME: '.codex' } });
  }
});

test('buildEnv：provider 执行者与普通 Codex 执行者一样用调用者的 CODEX_HOME，没设时指向真实 ~/.codex', () => {
  const home = path.join(os.tmpdir(), 'ar-home');
  const base = { PATH: 'p', USERPROFILE: path.join(os.tmpdir(), 'ar-real-user'), CODEX_HOME: path.join(os.tmpdir(), 'ar-real-user', '.codex') };
  const env = buildEnv({ base, profile, adapter: codex, home, profileName: 'oai', resolve: () => 'sk-test-x' });
  assert.equal(env.CODEX_HOME, base.CODEX_HOME);
  assert.equal(env.EXAMPLE_API_KEY, 'sk-test-x');
  const unset = buildEnv({ base: { PATH: 'p', USERPROFILE: base.USERPROFILE }, profile, adapter: codex, home, profileName: 'oai', resolve: () => 'sk-test-x' });
  assert.equal(unset.CODEX_HOME, path.join(base.USERPROFILE, '.codex'));
  const login = buildEnv({ base: { PATH: 'p', USERPROFILE: base.USERPROFILE }, profile: { adapter: 'codex', auth: 'login' }, adapter: codex, home, profileName: 'codex' });
  assert.equal(login.CODEX_HOME, path.join(base.USERPROFILE, '.codex'));
});

// 配置校验：resolveSettings 会先校验整份 v2 配置。
const check = p => resolveSettings({ v: 2, defaultProfile: 'x', profiles: { x: p } }, {}, {}, 'x');
const invalid = (p, pattern) => assert.throws(() => check(p), pattern);

test('配置校验：合法的 provider 执行者通过；wireApi 可省略；provider 为 null 视同没有', () => {
  check(profile);
  check({ ...profile, provider: { baseUrl: 'http://127.0.0.1:8080/v1' } });
  check({ adapter: 'codex', auth: 'login', provider: null });
});

test('配置校验：provider 只允许 codex 适配器', () => {
  invalid({ adapter: 'claude-code', provider, model: 'm', secrets: { K: 'K' }, auth: 'token' }, /profiles\.x\.provider 只能用于 codex 适配器/);
  invalid({ adapter: 'fake', provider }, /profiles\.x\.provider 只能用于 codex 适配器/);
});

test('配置校验：baseUrl 必填、只接受 http(s)、不能带用户名和密码', () => {
  invalid({ ...profile, provider: {} }, /provider\.baseUrl 必须填写/);
  invalid({ ...profile, provider: { baseUrl: null } }, /provider\.baseUrl 必须填写/);
  invalid({ ...profile, provider: { baseUrl: '' } }, /provider\.baseUrl 必须填写/);
  invalid({ ...profile, provider: { baseUrl: 'not a url' } }, /provider\.baseUrl 不是有效的地址/);
  invalid({ ...profile, provider: { baseUrl: 'ftp://api.example.com' } }, /provider\.baseUrl 只接受 http/);
  invalid({ ...profile, provider: { baseUrl: 'https://user:pw@api.example.com' } }, /provider\.baseUrl 里不能带用户名和密码/);
  invalid({ ...profile, provider: { baseUrl: 'https://user@api.example.com' } }, /provider\.baseUrl 里不能带用户名和密码/);
  invalid({ ...profile, provider: 'https://api.example.com' }, /provider 必须为对象/);
});

test('配置校验：wireApi 写 chat 时说明 Codex 0.163 起不支持；其他取值也拒绝', () => {
  invalid({ ...profile, provider: { ...provider, wireApi: 'chat' } }, /provider\.wireApi 不能是 chat：Codex 0\.163 起不再支持.*Claude Code 兼容后端.*通用适配器/);
  invalid({ ...profile, provider: { ...provider, wireApi: 'completions' } }, /provider\.wireApi 只接受 responses/);
});

test('配置校验：有 provider 时 model 必填、auth 不能是 login、secrets 正好一个且键是变量名', () => {
  invalid({ ...profile, model: null }, /profiles\.x\.model 必须填写/);
  invalid({ ...profile, model: '' }, /profiles\.x\.model 必须填写/);
  const { model: _drop, ...noModel } = profile;
  invalid(noModel, /profiles\.x\.model 必须填写/);
  invalid({ ...profile, auth: 'login' }, /auth 必须为 token/);
  invalid({ ...profile, secrets: {} }, /secrets 为空/);
  const { auth: _auth, ...noAuth } = profile;
  invalid({ ...noAuth, secrets: {} }, /secrets 有 provider 时必须正好有一个密钥变量（现在有 0 个）/);
  invalid({ ...profile, secrets: { A_KEY: 'A_KEY', B_KEY: 'B_KEY' } }, /正好有一个密钥变量（现在有 2 个）/);
  invalid({ ...profile, secrets: { 'bad key': 'A_KEY' } }, /secrets 的键必须是环境变量名/);
});
