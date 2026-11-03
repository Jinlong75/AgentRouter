import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 384：Qoder 的非交互 -p 模式默认在后台任务等久了之后把它们停掉并退出。两个 Qoder 预设的声明里设了
// QODERCLI_PRINT_BG_WAIT_CEILING_MS=0；已导入的旧配置（声明还没有这个 env）在执行时也补上，
// 配置里自己写了同名键时以配置为准，对应不到预设的自定义声明不动，而且不改写用户的 config.json。
const project = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(project, 'core/ar.mjs');
const KEY = 'QODERCLI_PRINT_BG_WAIT_CEILING_MS';
const NOT_SET = '(未设置)';
const TOKEN = 'qoder-bg-wait-test-token';
const presetGeneric = name => JSON.parse(fs.readFileSync(path.join(project, 'core/templates/agents', `${name}.json`), 'utf8')).generic;
// 假执行者只打印这一个变量（配置里还可能有令牌，别的变量一概不打印）。
const scriptText = `process.stdout.write(${JSON.stringify(`${KEY}=`)} + (process.env.${KEY} ?? ${JSON.stringify(NOT_SET)}) + '\\n');\n`;

function setup(t, { generics = {}, profiles = {} } = {}) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'qoder 后台等待测试 '));
  t.after(() => { assert.equal(path.dirname(base), path.resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const root = path.join(base, '示例 仓库'), home = path.join(base, '公共 配置');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const script = path.join(base, '假 qoder.mjs');
  fs.writeFileSync(script, scriptText);
  const secretsFile = path.join(home, '.test-secrets.json');
  fs.writeFileSync(secretsFile, '{}\n');
  const configFile = path.join(home, 'config.json');
  const writeConfig = value => fs.writeFileSync(configFile, JSON.stringify(value, null, 2));
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  writeConfig({ v: 2, defaultProfile: Object.keys(profiles)[0] ?? null, profiles, generics, managed: false, watchWindow: 'never' });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_|QODER)/i.test(k)) delete env[k];
  Object.assign(env, {
    AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', AR_TEST_SECRETS_FILE: secretsFile,
    USERPROFILE: base, HOME: base, APPDATA: base,
    AR_WORKTREE_ROOT: path.join(base, 'wt 根'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), CODEX_HOME: path.join(base, 'codex'),
  });
  const ar = (args, overrides = {}) => spawnSync(process.execPath, [entry, ...args], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
  const dispatch = (name, nameOfProfile, overrides) => ar(['dispatch', '打印收到的环境变量', '--name', name, '--profile', nameOfProfile], overrides);
  const report = name => fs.readFileSync(path.join(root, '.agent-runs', name, 'report.md'), 'utf8');
  return { base, root, home, script, ar, dispatch, report, readConfig, writeConfig, configFile };
}

// 预设的声明只换程序与输出：程序用假执行者（node 跑脚本），输出用纯文本；其余字段（secrets、参数名等）随预设。
const fakeDecl = (preset, script, { env, dropEnv = false } = {}) => {
  const decl = structuredClone(presetGeneric(preset));
  if (dropEnv) delete decl.env;
  // 假执行者不读任务指令，但要有一个传指令的地方才合法；只读参数用不上，去掉（否则同样缺 {prompt}）。
  Object.assign(decl, { executable: process.execPath, args: [script, '{prompt}'], output: { format: 'text' } });
  delete decl.stdin;
  delete decl.readOnlyArgs;
  if (env) decl.env = env;
  return decl;
};
const profile = name => ({ adapter: 'generic', generic: name, label: 'Qoder（国内版）', enabled: true });
const sees = (report, value) => report.split('\n').includes(`${KEY}=${value}`);

test('① 从 qoder-cn 预设导入的执行者收到 QODERCLI_PRINT_BG_WAIT_CEILING_MS=0', t => {
  const s = setup(t);
  const added = s.ar(['agents', 'add', '--preset', 'qoder-cn']);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  // 程序换成假执行者，声明里预设给的 env 原样保留。
  const config = s.readConfig();
  config.generics['qoder-cn'] = fakeDecl('qoder-cn', s.script);
  s.writeConfig(config);
  const result = s.dispatch('预设导入', 'qoder-cn', { QODERCN_PERSONAL_ACCESS_TOKEN: TOKEN });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(sees(s.report('预设导入'), '0'), '预设的 env 传给执行者');
});

test('② 已导入的旧声明（没有 env）执行时也补上，且不改写 config.json', t => {
  const s = setup(t, { profiles: { 'qoder-cn': profile('qoder-cn') } });
  const config = s.readConfig();
  config.generics['qoder-cn'] = fakeDecl('qoder-cn', s.script, { dropEnv: true });
  s.writeConfig(config);
  assert.ok(!('env' in s.readConfig().generics['qoder-cn']), '旧声明里没有 env');
  const result = s.dispatch('旧声明', 'qoder-cn');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(sees(s.report('旧声明'), '0'), '旧声明也补上了');
  assert.ok(!('env' in s.readConfig().generics['qoder-cn']), '只在内存里补，用户的 config.json 不动');
});

test('③ 配置里已经设了这个键：以配置为准，不覆盖', t => {
  const s = setup(t, { profiles: { 'qoder-cn': profile('qoder-cn') } });
  const config = s.readConfig();
  config.generics['qoder-cn'] = fakeDecl('qoder-cn', s.script, { env: { [KEY]: '5000' } });
  s.writeConfig(config);
  const result = s.dispatch('配置值优先', 'qoder-cn');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(sees(s.report('配置值优先'), '5000'), '配置里的值优先');
});

test('④ 对应不到预设的自定义 generic 声明没有这个变量', t => {
  const s = setup(t, { profiles: { mine: profile('mine') } });
  const config = s.readConfig();
  config.generics.mine = { label: '自定义 CLI', executable: process.execPath, args: [s.script, '{prompt}'], output: { format: 'text' } };
  s.writeConfig(config);
  const result = s.dispatch('自定义声明', 'mine');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(sees(s.report('自定义声明'), NOT_SET), '自定义声明不动');
});
