import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../../core/lib/agents.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(project, 'core/ar.mjs');
const fixture = name => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const jsonl = file => fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
// 测试密钥：只放在传入的环境里，不能出现在任何输出文件、标准输出或标准错误中。
const SECRET = 'sk-test-claude-dispatch-8d42';

function setup(t, { profile = loadPreset('deepseek').profile } = {}) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'claude 派发测试 '));
  t.after(() => { assert.equal(path.dirname(base), path.resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const root = path.join(base, '示例 仓库'), home = path.join(base, '公共 配置');
  fs.mkdirSync(root); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'deepseek', profiles: { deepseek: profile }, managed: false }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_)/i.test(k)) delete env[k];
  Object.assign(env, {
    AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', USERPROFILE: base, HOME: base, APPDATA: base,
    AR_TEST_AGENT: fixture('fake-claude-code.mjs'), AR_TEST_ENV_REPORT: path.join(base, 'env.json'), DEEPSEEK_API_KEY: SECRET,
    AR_TEST_TOKEN_SHA256: createHash('sha256').update(SECRET).digest('hex'),
    // 模拟由主导会话启动：这些都不能传给执行者。
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'lead-session', CLAUDE_CODE_MESSAGING_TOKEN: 'lead-messaging-token',
    CLAUDE_CONFIG_DIR: path.join(base, '主导 配置'), ANTHROPIC_API_KEY: 'lead-api-key', ANTHROPIC_BASE_URL: 'https://lead.example', ANTHROPIC_MODEL: 'lead-model',
  });
  const invoke = (overrides = {}) => spawnSync(process.execPath, [entry, 'dispatch', '创建 hello.txt 并报告', '--name', '中文 记录'], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
  const dir = path.join(root, '.agent-runs', '中文 记录');
  const evidence = () => JSON.parse(fs.readFileSync(path.join(base, 'env.json'), 'utf8'));
  // 扫描 AgentRouter 写出的所有文件（任务目录与公共目录）与命令输出，不能出现密钥值。
  const assertNoSecret = result => {
    const files = [];
    const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk(path.join(root, '.agent-runs')); walk(home);
    for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET), `密钥出现在 ${path.relative(base, f)}`);
    assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET), '密钥出现在命令输出里');
    return files.length;
  };
  return { base, root, home, dir, invoke, evidence, assertNoSecret };
}

// 样例里的文件路径是 Windows 写法，换成实际工作目录后只在 Windows 上能算出相对路径。
test('claude-code 端到端（回放真实样例）：进度、统一事件、汇报 = result 文本、清单带 profile 与 adapter', { skip: process.platform !== 'win32' }, t => {
  const s = setup(t), result = s.invoke();
  assert.equal(result.status, 0, result.stderr);
  const [start, attempt, spawned, attemptEnd, end] = jsonl(path.join(s.home, 'runs.jsonl'));
  assert.deepEqual([start.event, attempt.event, spawned.event, attemptEnd.event, end.event], ['start', 'attempt', 'spawned', 'attempt-end', 'end']);
  assert.equal(start.profile, 'deepseek'); assert.equal(start.adapter, 'claude-code'); assert.equal(start.agent, 'claude-code');
  assert.equal(start.model, 'deepseek-v4-pro', '模型名取自执行者配置');
  assert.equal(start.agentVersion, '2.1.302 (Claude Code)');
  assert.equal(end.exit, 0);
  assert.equal(fs.readFileSync(path.join(s.dir, 'report.md'), 'utf8'), '完成', '汇报正文是 result 文本');
  assert.deepEqual(jsonl(path.join(s.dir, 'events.jsonl')).map(e => e.kind), ['tool', 'think', 'file', 'think', 'cmd', 'tool', 'cmd', 'file', 'say', 'turn']);
  const progress = fs.readFileSync(path.join(s.dir, 'progress.log'), 'utf8');
  for (const line of ['=== DeepSeek V4 Pro 开始：创建 hello.txt 并报告', '模型：deepseek-v4-pro', '新增文件：hello.txt', '运行：git status --short', '工具：Read hello.txt', '修改文件：hello.txt', '说：完成', '一轮结束（输入 1200，输出 300 tokens）', '=== DeepSeek V4 Pro 结束：exit=0'])
    assert.ok(progress.includes(line), `进度缺少：${line}`);
  assert.equal(jsonl(path.join(s.dir, 'raw.log')).length, 18, 'raw.log 原样保存每一行');
  assert.ok(s.assertNoSecret(result) >= 5);
});

test('claude-code 执行者环境：清掉主导会话变量、注入密钥、隔离配置目录、写任务用 bypassPermissions', t => {
  const s = setup(t), result = s.invoke();
  assert.equal(result.status, 0, result.stderr);
  const e = s.evidence();
  assert.deepEqual(e.names, ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR'], '只剩执行者自己的变量');
  assert.equal(e.tokenFromSource, true, 'ANTHROPIC_AUTH_TOKEN 来自 DEEPSEEK_API_KEY');
  assert.equal(e.baseUrl, 'https://api.deepseek.com/anthropic'); assert.equal(e.model, 'deepseek-v4-pro');
  assert.equal(e.configDir, path.join(s.home, 'workers', 'deepseek', 'claude')); assert.ok(fs.statSync(e.configDir).isDirectory());
  assert.equal(e.disableAutoupdater, '1');
  assert.deepEqual(e.args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']);
  // 执行者的 cwd 是长路径（124）：两边都取真实路径再比较，Windows 上不含 8.3 短名的 ~1。
  assert.equal(fs.realpathSync.native(e.cwd), fs.realpathSync.native(s.root));
  if (process.platform === 'win32') assert.ok(!/~\d/.test(e.cwd), `cwd 不应含 8.3 短名：${e.cwd}`);
  s.assertNoSecret(result);
});

test('claude-code 失败：接口 401 时退出码传递，给出通用的中文提示（变量名取自配置），密钥不外泄', t => {
  const s = setup(t), result = s.invoke({ AR_TEST_FIXTURE: fixture('claude-code-extra.jsonl'), AR_TEST_EXIT: '1', AR_TEST_STDERR: 'API Error: 401 {"type":"authentication_error"}' });
  assert.equal(result.status, 1);
  const progress = fs.readFileSync(path.join(s.dir, 'progress.log'), 'utf8');
  assert.match(progress, /出错：达到最大轮数仍未完成（error_max_turns）/);
  assert.match(progress, /出错：密钥无效或未设置：检查用户环境变量 DEEPSEEK_API_KEY/);
  assert.match(result.stdout, /出错：密钥无效或未设置/, '后台派发时失败原因放在标准输出');
  assert.equal(fs.readFileSync(path.join(s.dir, 'report.md'), 'utf8'), '测试仍有 1 个失败，已达到轮数上限。', '没有 result 文本时汇报用最后一条说话');
  s.assertNoSecret(result);
});

test('claude-code 缺少密钥：不启动执行者，记录启动失败，提示只含变量名', t => {
  const profile = { ...loadPreset('deepseek').profile, secrets: { ANTHROPIC_AUTH_TOKEN: 'AR_TEST_SURELY_MISSING_KEY_7Q' } };
  const s = setup(t, { profile }), result = s.invoke();
  assert.equal(result.status, 1);
  assert.ok(!fs.existsSync(path.join(s.base, 'env.json')), '执行者没有启动');
  const progress = fs.readFileSync(path.join(s.dir, 'progress.log'), 'utf8');
  assert.match(progress, /出错：启动 DeepSeek V4 Pro 失败：未设置密钥 AR_TEST_SURELY_MISSING_KEY_7Q/);
  assert.deepEqual(jsonl(path.join(s.home, 'runs.jsonl')).map(r => r.event), ['start', 'attempt', 'attempt-end', 'end']);
  s.assertNoSecret(result);
});
