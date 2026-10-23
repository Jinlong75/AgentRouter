import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../../core/lib/agents.mjs';
import { ALLOWED } from '../../core/lib/env.mjs';

// 真实派发入口 + 假执行者：执行者进程里只能看到白名单变量（Stage03 O7）。只比较变量名，假执行者从不写值。
const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const fake = fileURLToPath(new URL('../fixtures/fake-env-names.mjs', import.meta.url));
const SOURCE = 'sk-test-whitelist-5b19';
const UNRELATED = { GITHUB_TOKEN: 'ghp-test-unrelated', NPM_TOKEN: 'npm-test-unrelated', AWS_SECRET_ACCESS_KEY: 'aws-test-unrelated', OPENAI_API_KEY: 'sk-test-openai', MY_PRIVATE_SETTING: 'private' };
const PROXY = { HTTPS_PROXY: 'http://127.0.0.1:9', no_proxy: 'localhost', NODE_USE_ENV_PROXY: '1' };

function dispatch(t, profileName) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'ar 白名单 '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const root = path.join(base, '仓库'), home = path.join(base, '公共');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const profiles = { codex: { adapter: 'codex' }, deepseek: loadPreset('deepseek').profile };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: profileName, profiles, managed: false }));
  const env = {};
  // GIT_CONFIG_GLOBAL 也不带进来：064 起核心会把调用方的这个变量交给执行者（沙箱里 git 仍用真实全局配置），
  // 在执行者会话里跑测试时外层环境就带着它（Stage05 058 第 4 次派发），这里要的是与外层无关的固定输入。
  for (const [k, v] of Object.entries(process.env)) if (!/^(CODEX_|ANTHROPIC_|CLAUDE|AR_|FAKE_|AGENT_ROUTER_|GIT_CONFIG_GLOBAL$)/i.test(k)) env[k] = v;
  Object.assign(env, UNRELATED, PROXY, { DEEPSEEK_API_KEY: SOURCE, CLAUDECODE: '1', CLAUDE_CODE_MESSAGING_TOKEN: 'lead-messaging-token',
    AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', AR_TEST_AGENT: fake, AR_TEST_ENV_NAMES: path.join(base, 'names.json'),
    USERPROFILE: base, HOME: base, APPDATA: base, CODEX_HOME: path.join(base, 'codex') });
  const result = spawnSync(process.execPath, [entry, 'dispatch', '只回复 OK', '--name', '白名单'], { cwd: root, env, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
  assert.equal(result.status, 0, result.stderr);
  const names = JSON.parse(fs.readFileSync(path.join(base, 'names.json'), 'utf8'));
  return { names, has: key => names.some(n => n.toLowerCase() === key.toLowerCase()), result };
}

for (const profileName of ['codex', 'deepseek']) {
  test(`白名单（${profileName}）：执行者读不到密钥来源变量、无关变量与主导会话变量；代理变量仍在；派发照常完成`, t => {
    const { names, has, result } = dispatch(t, profileName);
    for (const key of [...Object.keys(UNRELATED), 'DEEPSEEK_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_MESSAGING_TOKEN', 'AGENT_ROUTER_HOME', 'AR_NO_WATCH'])
      assert.ok(!has(key), `执行者读到了 ${key}`);
    for (const key of Object.keys(PROXY)) assert.ok(has(key), `代理变量 ${key} 没有传下去`);
    assert.ok(has('PATH') && has('USERPROFILE') && has('TEMP') || process.platform !== 'win32', '系统变量缺失');
    // 除白名单、本 profile 的 env / secrets / 隔离项、适配器保留项与测试控制变量外，没有别的变量。
    const own = profileName === 'deepseek'
      ? ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']
      : ['CODEX_HOME'];
    const matches = (p, k) => p instanceof RegExp ? p.test(k) : p.toLowerCase() === k.toLowerCase();
    const extra = names.filter(n => ![...ALLOWED, ...own, /^AR_TEST_/i].some(p => matches(p, n)));
    assert.deepEqual(extra, [], '出现了白名单以外的变量');
    assert.ok(!result.stdout.includes(SOURCE) && !result.stderr.includes(SOURCE));
  });
}
