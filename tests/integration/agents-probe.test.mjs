import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from '../../core/lib/cli.mjs';
import { probeAgentModels } from '../../core/lib/agents.mjs';
import { probeEnv, parseModelsBody, parseCodexModels } from '../../core/lib/probe.mjs';
import { withFakeCodex } from '../fixtures/fake-codex-path.mjs';

// Stage07c 142：ar agents models <名> --probe。全部在本机：假接口开在 127.0.0.1 的随机端口，假 codex 在 tests/fixtures/probe/，
// 密钥是编造的字符串，不联网、不读真实密钥、不碰真实目录。
const SECRET = 'sk-probe-test-secret-7f3a91';
const fakeCodex = path.resolve('tests/fixtures/probe/fake-codex.mjs');
const fakeCodexFail = path.resolve('tests/fixtures/probe/fake-codex-fail.mjs');

const DEEPSEEK_LIST = {
  object: 'list',
  data: [
    { id: 'deepseek-flash', object: 'model', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
    { id: 'deepseek-pro', object: 'model', effort: { supported_levels: ['high', 'max'], default_level: 'max' } },
    { id: 'mimo-v2.5-TTS', object: 'model' },
    { id: 'mimo-asr-1', object: 'model' },
    { id: 'Voice-Clone', object: 'model' },
    { id: 'text-embedding-3', object: 'model' },
    { id: 'whisper-large', object: 'model' },
    { id: 'gen-image-2', object: 'model' },
    { id: 'bge-RERANK-v2', object: 'model' },
  ],
};

// 起一个假接口；handler(req, res, body) 自己写响应。返回 { url, hits, close }。
async function serve(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, headers: req.headers });
    handler(req, res, hits.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, hits, server };
}
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

function setup(t, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar agents 探针 '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const secretsFile = path.join(home, '.test-secrets.json');
  fs.writeFileSync(secretsFile, '{}\n');
  // 密钥只从传入的环境变量和这个隔离文件里找，不碰注册表；PATH 前面放假 codex，防止找到真实的。
  const env = withFakeCodex({ AGENT_ROUTER_HOME: home, AR_TEST_SECRETS_FILE: secretsFile, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...extraEnv }, home);
  const outputs = [];
  const call = async (argv, callEnv = env) => {
    const out = [];
    const code = await main(argv, { scriptPath: path.resolve('core/ar.mjs'), env: callEnv, cwd: home, out: s => out.push(s) });
    outputs.push(...out);
    return { code, text: out.join('\n'), json: argv.includes('--json') ? JSON.parse(out.at(-1)) : null };
  };
  const configFile = path.join(home, 'config.json');
  const config = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const writeConfig = value => fs.writeFileSync(configFile, JSON.stringify(value, null, 2));
  return { home, env, call, config, writeConfig, outputs };
}
const noSecret = outputs => { for (const line of outputs) assert.ok(!String(line).includes(SECRET), '输出里出现了密钥值'); };

// Codex（ChatGPT 登录）执行者，程序指向 file（假 codex）。
function useCodex(ctx, file) {
  ctx.writeConfig({ v: 2, defaultProfile: 'codex', profiles: { codex: { adapter: 'codex', label: 'Codex', auth: 'login', enabled: true, path: file } }, generics: {} });
}

// DeepSeek 式：Claude Code 适配器 + 自定义接口地址 <base>/anthropic，密钥变量 DEEPSEEK_API_KEY。
async function addDeepseek(ctx, base, { secret = SECRET } = {}) {
  await ctx.call(['agents', 'add', '--preset', 'deepseek', '--base-url', `${base}/anthropic`]);
  return secret === null ? ctx.env : { ...ctx.env, DEEPSEEK_API_KEY: secret };
}

test('OpenAI 格式列表（DeepSeek 式 effort 字段）→ source api；语音等非对话模型被过滤；用 Bearer 密钥', async t => {
  const api = await serve(t, (req, res) => req.url === '/models' ? json(res, 200, DEEPSEEK_LIST) : json(res, 404, {}));
  const ctx = setup(t);
  const env = await addDeepseek(ctx, api.url);
  const r = await ctx.call(['agents', 'models', 'deepseek', '--probe', '--json'], env);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, {
    ok: true, source: 'api', models: ['deepseek-flash', 'deepseek-pro'],
    details: [
      { id: 'deepseek-flash', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      { id: 'deepseek-pro', efforts: ['high', 'max'], defaultEffort: 'max' },
    ],
  });
  assert.equal(api.hits.length, 1);
  assert.equal(api.hits[0].headers.authorization, `Bearer ${SECRET}`);
  const text = await ctx.call(['agents', 'models', 'deepseek', '--probe'], env);
  assert.equal(text.text, '模型（来自接口）：\n  deepseek-flash  推理强度：low / high / max（默认 high）\n  deepseek-pro  推理强度：high / max（默认 max）');
  noSecret(ctx.outputs);
});

test('只有 id 的列表（MiMo 式）没有 efforts / defaultEffort；display_name 进 name', async t => {
  const api = await serve(t, (req, res) => json(res, 200, { data: [{ id: 'mimo-v2.6-pro', display_name: 'MiMo Pro' }, { id: 'mimo-v2.5' }] }));
  const ctx = setup(t);
  const env = await addDeepseek(ctx, api.url);
  const r = await ctx.call(['agents', 'models', 'deepseek', '--probe', '--json'], env);
  assert.deepEqual(r.json.details, [{ id: 'mimo-v2.6-pro', name: 'MiMo Pro' }, { id: 'mimo-v2.5' }]);
  assert.equal((await ctx.call(['agents', 'models', 'deepseek', '--probe'], env)).text, '模型（来自接口）：\n  mimo-v2.6-pro\n  mimo-v2.5');
});

test('第一个地址 404、第二个 200 → 用第二个的结果', async t => {
  const api = await serve(t, (req, res) => req.url === '/v1/models' ? json(res, 200, { data: [{ id: 'second-ok' }] }) : json(res, 404, { error: 'not found' }));
  const ctx = setup(t);
  const env = await addDeepseek(ctx, api.url);
  const r = await ctx.call(['agents', 'models', 'deepseek', '--probe', '--json'], env);
  assert.deepEqual(r.json, { ok: true, source: 'api', models: ['second-ok'], details: [{ id: 'second-ok' }] });
  assert.deepEqual(api.hits.map(h => h.url), ['/models', '/v1/models']);
});

test('401 → 退回预设，reason 含 401，models 是预设的 modelOptions；不再试第二个地址', async t => {
  const api = await serve(t, (req, res) => json(res, 401, { error: 'invalid key' }));
  const ctx = setup(t);
  const env = await addDeepseek(ctx, api.url);
  const r = await ctx.call(['agents', 'models', 'deepseek', '--probe', '--json'], env);
  assert.equal(r.code, 0, '退回预设是正常结果');
  assert.equal(r.json.ok, false); assert.equal(r.json.source, 'preset');
  assert.match(r.json.reason, /^接口返回 401：密钥无效或没有权限/);
  assert.deepEqual(r.json.models, ['deepseek-v4-pro', 'deepseek-v4-flash']);
  assert.ok(!('details' in r.json));
  assert.equal(api.hits.length, 1);
  const text = await ctx.call(['agents', 'models', 'deepseek', '--probe'], env);
  assert.match(text.text, /^没有查到（接口返回 401：密钥无效或没有权限.*）?，用预设的可选值：\n {2}deepseek-v4-pro\n {2}deepseek-v4-flash\n推理强度：low \/ medium \/ high \/ xhigh \/ max$/);
});

test('超时（注入短超时）→ 退回预设，原因写明没有响应', async t => {
  const api = await serve(t, () => { /* 不回应 */ });
  const ctx = setup(t);
  const env = await addDeepseek(ctx, api.url);
  const started = Date.now();
  const { result } = await probeAgentModels(ctx.home, 'deepseek', { env, timeoutMs: 400 });
  assert.ok(Date.now() - started < 8000, '没有真等 10 秒');
  assert.equal(result.ok, false); assert.equal(result.source, 'preset');
  assert.equal(result.reason, '0.4 秒没有响应，已停止');
});

test('返回的不是 JSON / 没有 data → 原因写明格式不对', async t => {
  const bodies = ['<html>hello</html>', JSON.stringify({ models: [] }), JSON.stringify({ data: 'x' })];
  let n = 0;
  const api = await serve(t, (req, res) => json(res, 200, bodies[Math.floor(n++ / 2) % bodies.length]));
  const ctx = setup(t);
  const env = await addDeepseek(ctx, api.url);
  for (const _ of bodies) {
    const r = await ctx.call(['agents', 'models', 'deepseek', '--probe', '--json'], env);
    assert.equal(r.json.source, 'preset');
    assert.equal(r.json.reason, '接口返回的不是模型列表');
  }
});

test('没有设置密钥环境变量 → 不发请求，原因写明变量名', async t => {
  const api = await serve(t, (req, res) => json(res, 200, DEEPSEEK_LIST));
  const ctx = setup(t);
  const env = await addDeepseek(ctx, api.url, { secret: null });
  const r = await ctx.call(['agents', 'models', 'deepseek', '--probe', '--json'], env);
  assert.equal(r.json.source, 'preset');
  assert.equal(r.json.reason, '没有设置密钥环境变量 DEEPSEEK_API_KEY');
  assert.equal(api.hits.length, 0);
});

test('密钥不出现在任何输出里：接口在错误正文里回显 Authorization 头，--json 与文字输出都只有 ***', async t => {
  for (const status of [401, 500]) {
    const api = await serve(t, (req, res) => json(res, status, `bad request, header was: ${req.headers.authorization} / key ${SECRET}`));
    const ctx = setup(t);
    const env = await addDeepseek(ctx, api.url);
    const j = await ctx.call(['agents', 'models', 'deepseek', '--probe', '--json'], env);
    const x = await ctx.call(['agents', 'models', 'deepseek', '--probe'], env);
    assert.equal(j.json.source, 'preset');
    assert.match(j.json.reason, /Bearer \*\*\*/);
    assert.match(x.text, /Bearer \*\*\*/);
    assert.ok(api.hits.some(h => h.headers.authorization === `Bearer ${SECRET}`), '请求确实带了密钥');
    noSecret(ctx.outputs);
    assert.ok(!JSON.stringify(j.json).includes(SECRET));
    assert.ok(!fs.readFileSync(path.join(ctx.home, 'config.json'), 'utf8').includes(SECRET), '配置里没有密钥值');
  }
});

test('响应正文最多取 200 字放进 reason', async t => {
  const api = await serve(t, (req, res) => json(res, 500, 'x'.repeat(5000)));
  const ctx = setup(t);
  const env = await addDeepseek(ctx, api.url);
  const r = await ctx.call(['agents', 'models', 'deepseek', '--probe', '--json'], env);
  assert.equal(r.json.reason, `接口返回 500：${'x'.repeat(200)}`);
});

test('Codex：运行 codex debug models，只留 visibility 为 list 的，推理强度与默认值正确', async t => {
  const ctx = setup(t);
  useCodex(ctx, fakeCodex);
  const r = await ctx.call(['agents', 'models', 'codex', '--probe', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, {
    ok: true, source: 'program', models: ['test-pro', 'test-mini'],
    details: [
      { id: 'test-pro', name: 'Test Pro', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'medium' },
      { id: 'test-mini', name: 'Test Mini', efforts: ['low', 'medium'], defaultEffort: 'low' },
    ],
  });
  const text = await ctx.call(['agents', 'models', 'codex', '--probe']);
  assert.equal(text.text, '模型（来自 codex debug models）：\n  test-pro  推理强度：low / medium / high / max（默认 medium）\n  test-mini  推理强度：low / medium（默认 low）');
});

test('Codex：程序退出码非 0 / 找不到程序 / 输出不是模型列表 → 退回预设并给出原因', async t => {
  const ctx = setup(t);
  const use = file => useCodex(ctx, file);
  use(fakeCodexFail);
  const failed = await ctx.call(['agents', 'models', 'codex', '--probe', '--json']);
  assert.equal(failed.code, 0);
  assert.deepEqual([failed.json.ok, failed.json.source, failed.json.reason], [false, 'preset', 'codex debug models 失败（退出码 3）']);
  assert.match((await ctx.call(['agents', 'models', 'codex', '--probe'])).text, /^没有查到（codex debug models 失败（退出码 3）），用预设的可选值：\n推理强度：minimal \/ low \/ medium \/ high \/ xhigh$/);
  use(path.join(ctx.home, '不存在的codex.js'));
  assert.equal((await ctx.call(['agents', 'models', 'codex', '--probe', '--json'])).json.source, 'preset');
  // 输出不是 JSON：用本测试文件所在目录里的 JSON 当"程序"不行，直接测解析函数。
  assert.equal(parseCodexModels('not json'), null);
  assert.equal(parseCodexModels('{"models":"x"}'), null);
  assert.deepEqual(parseCodexModels('{"models":[{"slug":"a","visibility":"hide"}]}'), []);
});

test('订阅令牌的执行者 → 不发请求，原因是"订阅令牌不能查询模型列表"', async t => {
  const api = await serve(t, (req, res) => json(res, 200, DEEPSEEK_LIST));
  const ctx = setup(t);
  await ctx.call(['agents', 'add', '--preset', 'claude-subscription']);
  const env = { ...ctx.env, CLAUDE_CODE_OAUTH_TOKEN: SECRET };
  const r = await probeAgentModels(ctx.home, 'claude-subscription', { env, nativeUrl: `${api.url}/v1/models` });
  assert.deepEqual([r.result.ok, r.result.source, r.result.reason], [false, 'preset', '订阅令牌不能查询模型列表']);
  assert.equal(api.hits.length, 0);
  const cli = await ctx.call(['agents', 'models', 'claude-subscription', '--probe', '--json'], env);
  assert.equal(cli.json.reason, '订阅令牌不能查询模型列表');
});

test('Claude 官方 API Key：x-api-key + anthropic-version，解析 data[].id 与 display_name', async t => {
  const api = await serve(t, (req, res) => json(res, 200, { data: [{ type: 'model', id: 'claude-test-1', display_name: 'Claude Test 1' }], has_more: false }));
  const ctx = setup(t);
  await ctx.call(['agents', 'add', '--preset', 'claude-native']);
  const env = { ...ctx.env, ANTHROPIC_API_KEY: SECRET };
  const { result } = await probeAgentModels(ctx.home, 'claude-native', { env, nativeUrl: `${api.url}/v1/models?limit=1000` });
  assert.deepEqual(result, { ok: true, source: 'api', models: ['claude-test-1'], details: [{ id: 'claude-test-1', name: 'Claude Test 1' }] });
  assert.equal(api.hits[0].headers['x-api-key'], SECRET);
  assert.equal(api.hits[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(api.hits[0].headers.authorization, undefined);
  // 没设密钥：不发请求。
  const none = await probeAgentModels(ctx.home, 'claude-native', { env: ctx.env, nativeUrl: `${api.url}/v1/models` });
  assert.equal(none.result.reason, '没有设置密钥环境变量 ANTHROPIC_API_KEY');
  assert.equal(api.hits.length, 1);
});

test('OpenAI 兼容接口（codex + provider）：<接口地址>/models，Bearer', async t => {
  const api = await serve(t, (req, res) => req.url === '/v1/models' ? json(res, 200, { data: [{ id: 'gpt-test' }, { id: 'tts-1' }] }) : json(res, 404, {}));
  const ctx = setup(t);
  await ctx.call(['agents', 'add', '--preset', 'openai-compat', '--base-url', `${api.url}/v1`, '--model', 'gpt-test', '--secret-var', 'COMPAT_TEST_KEY']);
  const env = { ...ctx.env, COMPAT_TEST_KEY: SECRET };
  const r = await ctx.call(['agents', 'models', 'openai-compat', '--probe', '--json'], env);
  assert.deepEqual(r.json, { ok: true, source: 'api', models: ['gpt-test'], details: [{ id: 'gpt-test' }] });
  assert.equal(api.hits[0].headers.authorization, `Bearer ${SECRET}`);
});

test('没有可查询接口的执行者（fake、通用适配器没有 listModels）→ 退回预设并写明原因', async t => {
  const ctx = setup(t);
  ctx.writeConfig({ v: 2, defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true } }, generics: {} });
  const r = await ctx.call(['agents', 'models', 'fake', '--probe', '--json']);
  assert.deepEqual(r.json, { ok: false, source: 'preset', models: [], reason: '这个执行者没有可查询的接口' });
  assert.match((await ctx.call(['agents', 'models', 'nope', '--probe', '--json'])).json.error, /找不到执行者：nope/);
  assert.match((await ctx.call(['agents', 'models', '--probe', '--json'])).json.error, /用法/);
});

test('通用适配器有 listModels → 运行程序，source 是 program', async t => {
  const ctx = setup(t);
  await ctx.call(['agents', 'add', '--preset', 'qoder-cn']);
  const cfg = ctx.config(); cfg.generics['qoder-cn'].executable = path.resolve('tests/fixtures/generic/models-cli.mjs'); ctx.writeConfig(cfg);
  const r = await ctx.call(['agents', 'models', 'qoder-cn', '--probe', '--json'], { ...ctx.env, QODERCN_PERSONAL_ACCESS_TOKEN: 'qoder-probe-token-1' });
  assert.equal(r.json.source, 'program'); assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.models.slice(0, 2), ['A', 'B']);
  assert.deepEqual(r.json.details.slice(0, 2), [{ id: 'A' }, { id: 'B' }]);
  assert.match((await ctx.call(['agents', 'models', 'qoder-cn', '--probe'], { ...ctx.env, QODERCN_PERSONAL_ACCESS_TOKEN: 'qoder-probe-token-1' })).text, /^模型（来自程序的列表）：\n {2}A\n {2}B\n/);
});

test('不带 --probe 的输出和原来逐字节相同（对照 agents-import 里的 deepseek 用例）', async t => {
  const ctx = setup(t);
  await ctx.call(['agents', 'add', '--preset', 'deepseek']);
  await ctx.call(['agents', 'add', '--preset', 'claude-native']);
  const j = await ctx.call(['agents', 'models', 'deepseek', '--json']);
  assert.equal(j.code, 0);
  assert.equal(JSON.stringify(j.json), JSON.stringify({ ok: true, models: ['deepseek-v4-pro', 'deepseek-v4-flash'], source: 'preset' }));
  assert.equal((await ctx.call(['agents', 'models', 'deepseek'])).text, '模型（预设的可选值）：\n  deepseek-v4-pro\n  deepseek-v4-flash');
  assert.equal(JSON.stringify((await ctx.call(['agents', 'models', 'claude-native', '--json'])).json), JSON.stringify({ ok: true, models: [], source: 'preset' }));
  assert.equal((await ctx.call(['agents', 'models', 'claude-native'])).text, '没有可选的模型列表');
});

test('代理：子进程环境带 HTTPS_PROXY 与 NODE_USE_ENV_PROXY=1；设置里的代理真的被用上（请求经假代理到达）', async t => {
  // 单元：probeEnv 保留代理变量、加 NODE_USE_ENV_PROXY，不含无关变量与密钥来源变量。
  const env = probeEnv({ PATH: process.env.PATH, HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: 'localhost', DEEPSEEK_API_KEY: SECRET, UNRELATED_TOKEN: 'x' }, { sources: ['DEEPSEEK_API_KEY'] });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1'); assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.ok(!('DEEPSEEK_API_KEY' in env) && !('UNRELATED_TOKEN' in env));

  // 端到端：config.json 配手动代理 → cli 把代理变量加进环境 → 请求发给假代理（目标地址是解析不了的名字，只有走代理才能拿到结果）。
  // Node 的环境变量代理对 http 目标也先发 CONNECT；假代理收到 CONNECT 后回 200，再把这条连接交给"源站"那台假接口。
  const origin = await serve(t, (req, res) => req.url === '/models' ? json(res, 200, { data: [{ id: 'via-proxy' }] }) : json(res, 404, {}));
  const proxy = await serve(t, (req, res) => json(res, 502, {}));
  const connects = [];
  proxy.server.on('connect', (req, socket) => {
    connects.push(req.url);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    origin.server.emit('connection', socket);
  });
  const ctx = setup(t);
  await ctx.call(['agents', 'add', '--preset', 'deepseek', '--base-url', 'http://models.example.invalid:8081/anthropic']);
  const cfg = ctx.config(); cfg.proxy = { mode: 'manual', url: proxy.url }; ctx.writeConfig(cfg);
  const r = await ctx.call(['agents', 'models', 'deepseek', '--probe', '--json'], { ...ctx.env, DEEPSEEK_API_KEY: SECRET });
  assert.deepEqual(r.json.models, ['via-proxy'], r.json.reason);
  assert.deepEqual(connects, ['models.example.invalid:8081'], '请求经代理发出');
  assert.equal(origin.hits[0].headers.authorization, `Bearer ${SECRET}`);
  noSecret(ctx.outputs);
});

test('解析函数：非对话模型按 id 不分大小写过滤；格式不对返回 null', () => {
  assert.deepEqual(parseModelsBody(JSON.stringify(DEEPSEEK_LIST)).map(d => d.id), ['deepseek-flash', 'deepseek-pro']);
  assert.equal(parseModelsBody('nope'), null);
  assert.equal(parseModelsBody('{"data":{}}'), null);
  assert.deepEqual(parseModelsBody('{"data":[{"id":"ok"},{"name":"no id"},{"id":""}]}'), [{ id: 'ok' }]);
});


// ---- D102 / 169：导入之前就能查（ar agents models --preset …），按导入后会得到的执行者配置去查，不读不写执行者配置 ----
const sha = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;

test('169：--preset deepseek + --secret-var + 假接口 → source api；config.json 前后哈希相同；用的是指定变量的密钥', async t => {
  const api = await serve(t, (req, res) => req.url === '/models' ? json(res, 200, DEEPSEEK_LIST) : json(res, 404, {}));
  const ctx = setup(t);
  // 配置里已有别的执行者：它也不能被读出来用、改动。
  ctx.writeConfig({ v: 2, defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true } }, generics: {} });
  const before = sha(path.join(ctx.home, 'config.json'));
  const env = { ...ctx.env, PREIMPORT_TEST_KEY: SECRET, DEEPSEEK_API_KEY: 'sk-should-not-be-used' };
  const r = await ctx.call(['agents', 'models', '--preset', 'deepseek', '--base-url', `${api.url}/anthropic`, '--secret-var', 'PREIMPORT_TEST_KEY', '--probe', '--json'], env);
  assert.equal(r.code, 0);
  assert.equal(r.json.source, 'api'); assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.models, ['deepseek-flash', 'deepseek-pro']);
  assert.equal(api.hits[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(sha(path.join(ctx.home, 'config.json')), before, 'config.json 一个字节都没变');
  assert.deepEqual(Object.keys(ctx.config().profiles), ['fake']);
  noSecret(ctx.outputs);
  // 没有 config.json 时也不会凭空建出来。
  const empty = setup(t);
  await empty.call(['agents', 'models', '--preset', 'deepseek', '--base-url', `${api.url}/anthropic`, '--secret-var', 'PREIMPORT_TEST_KEY', '--probe', '--json'], { ...empty.env, PREIMPORT_TEST_KEY: SECRET });
  assert.equal(fs.existsSync(path.join(empty.home, 'config.json')), false);
});

test('169：--preset codex 走 codex debug models（假程序），source 是 program', async t => {
  const ctx = setup(t);
  // 预设没有程序路径，按 PATH 找 codex：把 PATH 前面那个假 codex 换成会回答 debug models 的。
  fs.writeFileSync(path.join(ctx.home, '假 codex', 'codex.js'), `import(${JSON.stringify(pathToFileURL(fakeCodex).href)});\n`);
  const r = await ctx.call(['agents', 'models', '--preset', 'codex', '--probe', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.json.source, 'program'); assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.models, ['test-pro', 'test-mini']);
  assert.equal(fs.existsSync(path.join(ctx.home, 'config.json')), false, '没有写 config.json');
});

test('169：没有设置密钥变量 → 退回预设的可选值，reason 写明缺哪个变量，不发请求', async t => {
  const api = await serve(t, (req, res) => json(res, 200, DEEPSEEK_LIST));
  const ctx = setup(t);
  const base = ['agents', 'models', '--preset', 'deepseek', '--base-url', `${api.url}/anthropic`];
  const r = await ctx.call([...base, '--probe', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual([r.json.ok, r.json.source, r.json.reason], [false, 'preset', '没有设置密钥环境变量 DEEPSEEK_API_KEY']);
  assert.deepEqual(r.json.models, ['deepseek-v4-pro', 'deepseek-v4-flash']);
  const named = await ctx.call([...base, '--secret-var', 'PREIMPORT_MISSING_KEY', '--probe', '--json']);
  assert.equal(named.json.reason, '没有设置密钥环境变量 PREIMPORT_MISSING_KEY');
  assert.equal(api.hits.length, 0);
  // 不带 --probe：返回预设的可选值，和 ar agents models <名> 一样。
  const plain = await ctx.call(['agents', 'models', '--preset', 'deepseek', '--json']);
  assert.equal(JSON.stringify(plain.json), JSON.stringify({ ok: true, models: ['deepseek-v4-pro', 'deepseek-v4-flash'], source: 'preset' }));
  assert.equal((await ctx.call(['agents', 'models', '--preset', 'deepseek'])).text, '模型（预设的可选值）：\n  deepseek-v4-pro\n  deepseek-v4-flash');
});

test('169：名字和 --preset 同时给 / 都不给 / 预设不存在 / 参数不合法 → 报错，退出码 2', async t => {
  const ctx = setup(t);
  const both = await ctx.call(['agents', 'models', 'deepseek', '--preset', 'deepseek', '--probe', '--json']);
  assert.equal(both.code, 2); assert.match(both.json.error, /用法/);
  const none = await ctx.call(['agents', 'models', '--probe', '--json']);
  assert.equal(none.code, 2); assert.match(none.json.error, /用法/);
  const missing = await ctx.call(['agents', 'models', '--preset', 'no-such-preset', '--probe', '--json']);
  assert.equal(missing.code, 2); assert.match(missing.json.error, /没有预设 no-such-preset/);
  const badAuth = await ctx.call(['agents', 'models', '--preset', 'codex', '--auth', 'oops', '--probe', '--json']);
  assert.equal(badAuth.code, 2); assert.match(badAuth.json.error, /--auth 必须为 login 或 token/);
  const noBase = await ctx.call(['agents', 'models', '--preset', 'openai-compat', '--probe', '--json']);
  assert.equal(noBase.code, 2); assert.match(noBase.json.error, /缺少接口地址/);
  assert.equal(fs.existsSync(path.join(ctx.home, 'config.json')), false);
});

test('169：同一组参数下，--preset 查到的结果与先 add 再 models <名> --probe 相同', async t => {
  const api = await serve(t, (req, res) => req.url === '/v1/models' ? json(res, 200, { data: [{ id: 'gpt-test' }, { id: 'tts-1' }] }) : json(res, 404, {}));
  const ctx = setup(t);
  const env = { ...ctx.env, COMPAT_TEST_KEY: SECRET };
  const args = ['--base-url', `${api.url}/v1`, '--model', 'gpt-test', '--secret-var', 'COMPAT_TEST_KEY'];
  const pre = await ctx.call(['agents', 'models', '--preset', 'openai-compat', ...args, '--probe', '--json'], env);
  await ctx.call(['agents', 'add', '--preset', 'openai-compat', ...args]);
  const post = await ctx.call(['agents', 'models', 'openai-compat', '--probe', '--json'], env);
  assert.equal(pre.json.source, 'api');
  assert.deepEqual(pre.json, post.json);
  assert.deepEqual(api.hits.map(h => h.headers.authorization), [`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
  // 通用适配器预设（声明来自预设）：同样一致。
  const generic = path.resolve('tests/fixtures/generic/models-cli.mjs');
  assert.ok(fs.existsSync(generic));
  const g = await ctx.call(['agents', 'models', '--preset', 'qoder-cn', '--json'], env);
  await ctx.call(['agents', 'add', '--preset', 'qoder-cn']);
  assert.deepEqual(g.json, (await ctx.call(['agents', 'models', 'qoder-cn', '--json'], env)).json);
  noSecret(ctx.outputs);
});