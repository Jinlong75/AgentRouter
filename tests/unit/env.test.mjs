import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildEnv, authOf, allowedEnv, secretSources, sandboxHome, ensureSandboxHome } from '../../core/lib/env.mjs';
import { codex } from '../../core/adapters/codex.mjs';
import { loadPreset, listPresets } from '../../core/lib/agents.mjs';
import { claudeCode } from '../../core/adapters/claude-code.mjs';
import { fake } from '../../core/adapters/fake.mjs';
import { resolveSettings } from '../../core/lib/config.mjs';
import { profileConfig } from '../../core/lib/run.mjs';
import { validRequest } from '../../core/lib/managed.mjs';

// 假密钥与假的主导会话环境；任何命令行参数里都不能出现密钥值。
const KEYS = { DEEPSEEK_API_KEY: 'sk-test-deepseek-1111', MIMO_API_KEY: 'sk-test-mimo-4444', ANTHROPIC_API_KEY: 'sk-test-anthropic-2222', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-3333' };
const lead = {
  PATH: 'C:\\bin', USERPROFILE: 'D:\\profiles\\real',
  CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 's-1', CLAUDE_CODE_MESSAGING_TOKEN: 'msg-token', CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\x',
  CLAUDE_CONFIG_DIR: 'D:\\profiles\\real\\.claude', Anthropic_Base_Url: 'https://lead.example', ANTHROPIC_AUTH_TOKEN: 'lead-token', ANTHROPIC_MODEL: 'lead-model',
};
const home = 'D:\\ar-home';
const noRegistry = name => { const v = { ...lead, ...KEYS }[name]; if (!v) throw new Error(`未设置密钥 ${name}`); return v; };
const build = (name, base = { ...lead, ...KEYS }) => {
  const { profile } = loadPreset(name);
  const env = buildEnv({ base, profile, adapter: claudeCode, home, profileName: name, resolve: noRegistry });
  const command = claudeCode.command({ prompt: '任务', settings: {}, profile, detection: { launcher: { executable: 'C:\\x\\claude.exe', args: [] } }, env: {} });
  return { env, command, profile };
};
const leaked = env => Object.keys(env).filter(k => /^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|MESSAGING_TOKEN|MESSAGING_SOCKET))$/i.test(k));

test('白名单 + 清除项（名字或模式、不区分大小写）；覆盖顺序 profile.env → secrets → 隔离项；不改传入的基础环境', () => {
  const base = { Path: 'p', TEMP: 't', Temp_Lower: 'x', FOO: 'base', Bar: 'base', lead_secret: 'x', KEY_SRC: 'k' };
  const snapshot = { ...base };
  const adapter = { isolate: () => ({ clear: ['TEMP'], set: { FOO: 'iso' } }) };
  const env = buildEnv({ base, adapter, home, profileName: 'p', profile: { env: { FOO: 'profile', foo2: 'v' }, secrets: { BAR: 'KEY_SRC' } }, resolve: n => `resolved:${n}` });
  // 064：执行者的用户目录指向沙箱（协议第 7 节），USERPROFILE / HOME（Windows 另有 HOMEDRIVE / HOMEPATH）是沙箱路径。
  const sandbox = sandboxHome(home, 'p');
  assert.deepEqual(env, { Path: 'p', FOO: 'iso', foo2: 'v', BAR: 'resolved:KEY_SRC', USERPROFILE: sandbox, HOME: sandbox,
    ...(process.platform === 'win32' ? { HOMEDRIVE: 'D:', HOMEPATH: sandbox.slice(2), PSModuleAnalysisCachePath: path.join(sandbox, 'AppData', 'Local', 'Microsoft', 'Windows', 'PowerShell', 'ModuleAnalysisCache') } : {}) });
  assert.deepEqual(base, snapshot);
});

test('认证方式：login 不注入任何凭据；token 注入；没写 auth 时有 secrets 即 token', () => {
  assert.equal(authOf({}), 'login');
  assert.equal(authOf({ secrets: { A: 'B' } }), 'token');
  assert.equal(authOf({ auth: 'login', secrets: { A: 'B' } }), 'login');
  const login = buildEnv({ base: { B: 'secret-b', PATH: 'p' }, profile: { auth: 'login', secrets: { A: 'B' } }, adapter: {}, resolve: () => assert.fail('login 不应解析密钥') });
  assert.deepEqual(login, { PATH: 'p' }, 'login 不注入，来源变量也不在白名单里');
  const token = buildEnv({ base: {}, profile: { auth: 'token', secrets: { A: 'B' } }, adapter: {}, resolve: () => 'v' });
  assert.equal(token.A, 'v');
});

test('缺少密钥时报错只含变量名', () => {
  assert.throws(() => buildEnv({ base: {}, profile: loadPreset('deepseek').profile, adapter: claudeCode, home, profileName: 'deepseek', resolve: n => { throw new Error(`未设置密钥 ${n}`); } }), /^Error: 未设置密钥 DEEPSEEK_API_KEY$/);
});

test('预设齐全：deepseek / mimo / mimo-payg / claude-native / claude-subscription 都是 claude-code 适配器', () => {
  for (const name of ['deepseek', 'mimo', 'mimo-payg', 'claude-native', 'claude-subscription']) {
    assert.ok(listPresets().includes(name), name);
    assert.equal(loadPreset(name).profile.adapter, 'claude-code');
  }
  assert.throws(() => loadPreset('../x'), /预设名无效/);
  assert.throws(() => loadPreset('nope'), /没有预设 nope/);
});

test('deepseek：指向兼容接口、注入 DeepSeek 密钥、隔离配置目录、清掉主导会话的变量', () => {
  const { env, command } = build('deepseek');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-pro');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, KEYS.DEEPSEEK_API_KEY);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(home, 'workers', 'deepseek', 'claude'));
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  assert.deepEqual(leaked(env), []);
  assert.ok(!('Anthropic_Base_Url' in env), '主导的 base url 被清掉（不区分大小写）');
  assert.ok(!('ANTHROPIC_API_KEY' in env), '更高优先级的 ANTHROPIC_API_KEY 不会遗留');
  assert.ok(command.args.includes('bypassPermissions'));
});

test('mimo：两种预设各用各的接口地址，密钥只以 ANTHROPIC_AUTH_TOKEN 传入，MIMO_API_KEY 本身不传给执行者', () => {
  for (const [name, baseUrl] of [['mimo', 'https://token-plan-cn.xiaomimimo.com/anthropic'], ['mimo-payg', 'https://api.xiaomimimo.com/anthropic']]) {
    const { env, command } = build(name);
    assert.equal(env.ANTHROPIC_BASE_URL, baseUrl, name);
    assert.equal(env.ANTHROPIC_MODEL, 'mimo-v2.6-pro', name);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, KEYS.MIMO_API_KEY, `${name}：密钥按目标变量注入`);
    assert.ok(!Object.keys(env).some(k => k.toUpperCase() === 'MIMO_API_KEY'), `${name}：来源变量名本身不传给执行者`);
    assert.deepEqual(Object.entries(env).filter(([, value]) => value === KEYS.MIMO_API_KEY).map(([key]) => key), ['ANTHROPIC_AUTH_TOKEN'], `${name}：密钥值只出现在 ANTHROPIC_AUTH_TOKEN`);
    assert.ok(!JSON.stringify(command.args).includes(KEYS.MIMO_API_KEY), `${name}：参数里没有密钥值`);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(home, 'workers', name, 'claude'), name);
    assert.deepEqual(leaked(env), [], name);
  }
});

test('claude-native：同一适配器去掉 ANTHROPIC_BASE_URL 即官方模型，用 ANTHROPIC_API_KEY', () => {
  const { env } = build('claude-native');
  assert.ok(!Object.keys(env).some(k => k.toUpperCase() === 'ANTHROPIC_BASE_URL'));
  assert.ok(!Object.keys(env).some(k => k.toUpperCase() === 'ANTHROPIC_MODEL'), '主导指定的模型不遗留');
  assert.equal(env.ANTHROPIC_API_KEY, KEYS.ANTHROPIC_API_KEY);
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in env));
  assert.deepEqual(leaked(env), []);
});

test('claude-subscription：注入订阅令牌，清掉优先级更高的 API Key / Auth Token / Base URL，不用 --bare', () => {
  const { env, command } = build('claude-subscription');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, KEYS.CLAUDE_CODE_OAUTH_TOKEN);
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) assert.ok(!Object.keys(env).some(k => k.toUpperCase() === name), name);
  assert.ok(!command.args.includes('--bare'));
  assert.deepEqual(leaked(env), []);
});

test('五种预设构建出的命令行参数里都没有密钥值，任务只经 stdin', () => {
  for (const name of ['deepseek', 'mimo', 'mimo-payg', 'claude-native', 'claude-subscription']) {
    const { command } = build(name);
    const argv = JSON.stringify(command.args);
    for (const value of Object.values(KEYS)) assert.ok(!argv.includes(value), `${name} 参数里出现了密钥`);
    assert.equal(command.stdin, '任务');
  }
});

test('配置校验：auth、secrets 变量名、maxTurns、非 codex 的 path', () => {
  const check = profile => resolveSettings({ v: 2, defaultProfile: 'p', profiles: { p: { adapter: 'claude-code', ...profile } } }, {}, {}, 'p');
  assert.doesNotThrow(() => check(loadPreset('deepseek').profile));
  assert.throws(() => check({ auth: 'cookie' }), /auth 必须为 login 或 token/);
  assert.throws(() => check({ auth: 'token' }), /secrets 为空/);
  assert.throws(() => check({ secrets: { A: 'sk-not a name' } }), /必须是环境变量名/);
  assert.throws(() => check({ maxTurns: 0 }), /maxTurns 必须为正整数或 null/);
  assert.throws(() => check({ path: 'relative\\claude.exe' }), /path 必须是绝对路径/);
});

test('托管请求的执行者快照只含非密钥部分；secrets 只能是变量名', () => {
  const snapshot = profileConfig(loadPreset('deepseek').profile, claudeCode);
  // 只带列出的字段：price、enabled、title 等无关字段不进请求。
  assert.deepEqual(snapshot, { env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_MODEL: 'deepseek-v4-pro' }, secrets: { ANTHROPIC_AUTH_TOKEN: 'DEEPSEEK_API_KEY' }, auth: 'token', maxTurns: null, label: 'DeepSeek V4 Pro', adapter: 'claude-code', path: null });
  // 适配器声明的额外字段（fake 的回放说明）随快照带上，未声明的不带。
  assert.deepEqual(profileConfig({ adapter: 'fake', events: [], exit: 3, price: { inputPer1M: 1 }, enabled: true }, fake), { env: {}, secrets: {}, auth: null, maxTurns: null, label: null, adapter: 'fake', path: null, events: [], exit: 3 });
  const request = { v: 1, id: 'r1', at: 1, script: path.resolve('s', 'ar.mjs'), node: path.resolve('n', 'node.exe'), repo: path.resolve('r'), name: 'n', args: { task: 't', extra: '', role: null, spec: null },
    settings: { model: null, effort: null, tier: null, path: null, sandbox: 'workspace-write' }, dispatcher: { host: 'unknown', session: null }, env: {}, profile: 'deepseek', adapter: 'claude-code' };
  assert.equal(validRequest(request), true, '旧请求没有快照仍有效');
  assert.equal(validRequest({ ...request, profileConfig: snapshot }), true);
  assert.equal(validRequest({ ...request, profileConfig: { ...snapshot, secrets: { ANTHROPIC_AUTH_TOKEN: KEYS.DEEPSEEK_API_KEY } } }), false, 'secrets 里出现非变量名（如密钥值）就拒绝');
  assert.equal(validRequest({ ...request, profileConfig: { ...snapshot, auth: 'cookie' } }), false);
});

// 执行者环境白名单（Stage03 O7）：别的密钥、令牌、个人配置都不传；代理与系统变量保留。
const SYSTEM_BASE = { SystemRoot: 'C:/Windows', windir: 'C:/Windows', ComSpec: 'C:/Windows/system32/cmd.exe', Path: 'C:/bin', PATHEXT: '.COM;.EXE', TEMP: 'D:/t', TMP: 'D:/t',
  USERPROFILE: 'D:/profiles/real', APPDATA: 'D:/profiles/real/AppData/Roaming', LOCALAPPDATA: 'D:/profiles/real/AppData/Local', ProgramData: 'C:/ProgramData',
  ProgramFiles: 'C:/Program Files', 'ProgramFiles(x86)': 'C:/Program Files (x86)', SystemDrive: 'C:', NUMBER_OF_PROCESSORS: '8', PROCESSOR_ARCHITECTURE: 'AMD64', OS: 'Windows_NT', LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' };
const PROXY = { HTTPS_PROXY: 'http://127.0.0.1:7890', http_proxy: 'http://127.0.0.1:7890', NO_PROXY: 'localhost', NODE_USE_ENV_PROXY: '1' };
const UNRELATED = { GITHUB_TOKEN: 'ghp-test-unrelated', NPM_TOKEN: 'npm-test-unrelated', AWS_SECRET_ACCESS_KEY: 'aws-test-unrelated', OPENAI_API_KEY: 'sk-test-openai', MY_PRIVATE_SETTING: 'private', AGENT_ROUTER_HOME: 'D:/ar-home' };
const FULL = { ...lead, ...SYSTEM_BASE, ...PROXY, ...UNRELATED, ...KEYS };
const values = env => JSON.stringify(Object.values(env));

test('白名单：codex 与 claude-code 执行者环境里都没有密钥来源变量与无关变量；代理、系统变量保留', () => {
  const codexEnv = buildEnv({ base: FULL, profile: { adapter: 'codex' }, adapter: codex, home, profileName: 'codex', resolve: noRegistry });
  const deepseekEnv = build('deepseek', FULL).env;
  for (const [name, env] of [['codex', codexEnv], ['deepseek', deepseekEnv]]) {
    for (const key of [...Object.keys(UNRELATED), ...Object.keys(KEYS), 'CLAUDECODE', 'CLAUDE_CODE_MESSAGING_TOKEN'])
      assert.ok(!Object.keys(env).some(k => k.toLowerCase() === key.toLowerCase()), `${name} 环境里出现了 ${key}`);
    for (const value of [...Object.values(UNRELATED), KEYS.ANTHROPIC_API_KEY, KEYS.CLAUDE_CODE_OAUTH_TOKEN, 'lead-token', 'msg-token', 'https://lead.example', 'lead-model'])
      assert.ok(!values(env).includes(value), `${name} 环境里出现了无关的值`);
    // 064：USERPROFILE 换成沙箱（单独断言），其余系统变量与代理照原样保留。
    for (const [k, v] of Object.entries({ ...SYSTEM_BASE, ...PROXY })) if (k !== 'USERPROFILE') assert.equal(env[k], v, `${name} 缺少 ${k}`);
    assert.equal(env.USERPROFILE, sandboxHome(home, name), `${name} 的 USERPROFILE 应是沙箱`);
  }
  assert.equal(deepseekEnv.ANTHROPIC_AUTH_TOKEN, KEYS.DEEPSEEK_API_KEY, '自己的 secrets 照常注入（改名为目标变量）');
  assert.ok(!values(codexEnv).includes(KEYS.DEEPSEEK_API_KEY), 'codex 读不到 deepseek 的密钥');
});

test('白名单：codex 保留自己的配置目录与接口地址；claude-code 不保留 CODEX_HOME', () => {
  const base = { ...FULL, CODEX_HOME: 'D:/codex', OPENAI_BASE_URL: 'https://api.example' };
  const codexEnv = buildEnv({ base, profile: { adapter: 'codex' }, adapter: codex, home, profileName: 'codex', resolve: noRegistry });
  assert.equal(codexEnv.CODEX_HOME, 'D:/codex'); assert.equal(codexEnv.OPENAI_BASE_URL, 'https://api.example');
  const deepseekEnv = build('deepseek', base).env;
  assert.ok(!('CODEX_HOME' in deepseekEnv) && !('OPENAI_BASE_URL' in deepseekEnv));
});

test('provider 执行者（OpenAI 兼容接口）：密钥变量只在它自己的环境里，CODEX_HOME 沿用调用者的（用户的 ~/.codex）', () => {
  const oai = { adapter: 'codex', label: '兼容接口', enabled: true, auth: 'token', model: 'm', provider: { baseUrl: 'https://api.example.com', wireApi: 'responses' }, secrets: { OAI_COMPAT_KEY: 'OAI_COMPAT_SOURCE' } };
  const config = { profiles: { oai, codex: { adapter: 'codex', auth: 'login' }, deepseek: loadPreset('deepseek').profile } };
  const base = { ...FULL, OAI_COMPAT_SOURCE: 'sk-test-oai-compat', OAI_COMPAT_KEY: 'sk-test-leaked-name', CODEX_HOME: 'D:/profiles/real/.codex' };
  const sources = secretSources(config);
  const resolve = n => base[n] ?? noRegistry(n);
  const own = buildEnv({ base, profile: oai, adapter: codex, home, profileName: 'oai', resolve, sources });
  assert.equal(own.OAI_COMPAT_KEY, 'sk-test-oai-compat', '密钥按 env_key 名注入');
  assert.equal(own.CODEX_HOME, 'D:/profiles/real/.codex', '与普通 Codex 执行者一样用调用者的 CODEX_HOME');
  assert.ok(!('OAI_COMPAT_SOURCE' in own), '来源变量名本身不传');
  const others = [
    buildEnv({ base, profile: config.profiles.codex, adapter: codex, home, profileName: 'codex', resolve, sources }),
    buildEnv({ base, profile: config.profiles.deepseek, adapter: claudeCode, home, profileName: 'deepseek', resolve, sources }),
  ];
  for (const env of others) {
    assert.ok(!values(env).includes('sk-test-oai-compat') && !values(env).includes('sk-test-leaked-name'), '别的执行者的环境里没有它的密钥');
    assert.ok(!('OAI_COMPAT_KEY' in env) && !('OAI_COMPAT_SOURCE' in env));
  }
  assert.equal(others[0].CODEX_HOME, 'D:/profiles/real/.codex', '没有 provider 的 codex 执行者照旧用调用者的 CODEX_HOME');
});

test('白名单：任何 profile 的密钥来源变量即使撞上白名单名字也不原样传；profile.env 可以补充变量', () => {
  const config = { profiles: { a: { secrets: { TOKEN: 'HTTPS_PROXY' } }, b: { secrets: { X: 'SOME_KEY' } }, c: {} } };
  assert.deepEqual(secretSources(config), ['HTTPS_PROXY', 'SOME_KEY']);
  const env = buildEnv({ base: FULL, profile: { env: { MY_PRIVATE_SETTING: 'explicit' } }, adapter: codex, home, profileName: 'c', resolve: noRegistry, sources: secretSources(config) });
  assert.ok(!('HTTPS_PROXY' in env), '别的 profile 的来源变量不传');
  assert.equal(env.http_proxy, PROXY.http_proxy);
  assert.equal(env.MY_PRIVATE_SETTING, 'explicit', '写在 profile.env 里的才传');
});

test('白名单：测试控制变量只在设置了测试执行者时传；缺密钥时的检测环境同样是白名单', () => {
  const real = allowedEnv({ base: { ...FULL, FAKE_EXIT: '1', AR_TEST_EXIT: '1' }, adapter: codex });
  assert.ok(!('FAKE_EXIT' in real) && !('AR_TEST_EXIT' in real));
  const testing = allowedEnv({ base: { ...FULL, AR_TEST_AGENT: 'D:/fake.mjs', FAKE_EXIT: '1' }, adapter: codex });
  assert.equal(testing.AR_TEST_AGENT, 'D:/fake.mjs'); assert.equal(testing.FAKE_EXIT, '1');
  for (const key of Object.keys(UNRELATED)) assert.ok(!(key in testing), key);
});
