import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Stage07c T5：ar route suggest。隔离的 AGENT_ROUTER_HOME；只计算建议，不写任何文件，不派发、不启动任何执行者。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const AT = new Date(2026, 9, 26, 10, 42).getTime();

const config = () => ({
  v: 2, managed: false, watchWindow: 'never', defaultProfile: 'ds',
  profiles: {
    ds: { adapter: 'claude-code', label: 'DeepSeek V4 Pro', enabled: true, env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, secrets: { ANTHROPIC_AUTH_TOKEN: 'DEEPSEEK_API_KEY' } },
    codex: { adapter: 'codex', label: 'Codex', enabled: true },
    claude: { adapter: 'claude-code', label: 'Claude', enabled: true, secrets: { ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' } },
  },
  routing: { rules: [{ types: ['fix'], profile: 'codex' }], fallback: null, reviewer: null },
});

function fixture(t, cfg = config(), tests = { ds: { at: AT, ok: true }, codex: { at: AT, ok: false }, claude: { at: AT, ok: true } }) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 建议 '));
  t.after(() => { rmSync(base, { recursive: true, force: true }); });
  const home = path.join(base, '隔离 公共目录');
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_PROFILE']) delete env[key];
  // 配置和测试记录用 Node 写（无 BOM）。
  const file = path.join(home, 'config.json');
  writeFileSync(file, JSON.stringify(cfg));
  if (tests) writeFileSync(path.join(home, 'agent-tests.json'), JSON.stringify(tests));
  const f = { home, file, env };
  f.ar = args => spawnSync(process.execPath, [script, ...args], { cwd: base, env, encoding: 'utf8' });
  f.json = args => { const r = f.ar([...args, '--json']); return { status: r.status, stderr: r.stderr, json: JSON.parse(r.stdout) }; };
  f.read = () => JSON.parse(readFileSync(file, 'utf8'));
  return f;
}

test('ar route suggest --json：只建议测试通过的执行者，已有规则覆盖的类型去掉，skipped 带原因', t => {
  const f = fixture(t);
  const { status, stderr, json } = f.json(['route', 'suggest']);
  assert.equal(status, 0, stderr);
  assert.equal(json.ok, true);
  assert.deepEqual(json.rules, [
    { types: ['test', 'docs'], profile: 'ds', why: 'DeepSeek V4 Pro 的预设建议用于测试、文档；测试连接 10-26 10:42 通过', fit: { good: ['文档与大段中文文本编辑', '按清单补测试'], avoid: [] } },
    { types: ['code', 'refactor'], profile: 'claude', why: 'Claude 的预设建议用于代码、修复、重构；测试连接 10-26 10:42 通过', fit: { good: ['代码、修复、重构', '大段中文文本与文档编辑'], avoid: [] } },
  ]);
  assert.deepEqual(json.skipped, [{ profile: 'codex', why: '测试连接没有通过' }, { types: ['fix'], why: '已有规则 1 覆盖修复' }]);
  assert.ok(json.write.startsWith("ar route rules set '"));
});

test('ar route suggest 文字输出：每条一行"类型 → 执行者：原因"，跳过的另起几行，最后给出采用命令', t => {
  const f = fixture(t);
  const r = f.ar(['route', 'suggest']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines[0], '测试、文档 → ds：DeepSeek V4 Pro 的预设建议用于测试、文档；测试连接 10-26 10:42 通过；擅长：文档与大段中文文本编辑、按清单补测试；避免：');
  assert.equal(lines[1], '代码、重构 → claude：Claude 的预设建议用于代码、修复、重构；测试连接 10-26 10:42 通过；擅长：代码、修复、重构、大段中文文本与文档编辑；避免：');
  assert.ok(lines.includes('跳过 codex：测试连接没有通过'), r.stdout);
  assert.ok(lines.includes('跳过 修复：已有规则 1 覆盖修复'), r.stdout);
  assert.ok(lines.at(-1).startsWith("采用：ar route rules set '"), r.stdout);
});

test('没有可建议的规则时说明原因（先导入并测试通过至少一个执行者）', t => {
  const f = fixture(t, config(), null);
  const r = f.ar(['route', 'suggest']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('先导入并测试通过至少一个执行者'), r.stdout);
  assert.deepEqual(f.json(['route', 'suggest']).json.rules, []);
});

test('ar route suggest 不写任何文件；多余参数报用法、退出码 2', t => {
  const f = fixture(t);
  const list = () => readdirSync(f.home).sort();
  const before = { config: readFileSync(f.file), tests: readFileSync(path.join(f.home, 'agent-tests.json')), files: list() };
  assert.equal(f.ar(['route', 'suggest']).status, 0);
  assert.equal(f.json(['route', 'suggest']).status, 0);
  assert.deepEqual(readFileSync(f.file), before.config, 'config.json 不变');
  assert.deepEqual(readFileSync(path.join(f.home, 'agent-tests.json')), before.tests);
  assert.deepEqual(list(), before.files, '公共目录里没有新文件');
  const bad = f.ar(['route', 'suggest', 'extra']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /用法：ar route suggest/);
});

test('用 write 给出的命令真的执行一次：规则写入后 = 已有规则 + 建议', t => {
  const f = fixture(t);
  const { json } = f.json(['route', 'suggest']);
  const quoted = json.write.slice("ar route rules set '".length, -1);
  const set = f.ar(['route', 'rules', 'set', quoted]);
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(f.read().routing.rules, [
    { types: ['fix'], profile: 'codex' },
    { types: ['test', 'docs'], profile: 'ds' },
    { types: ['code', 'refactor'], profile: 'claude' },
  ]);
  // 采用后再建议：没有新的了。
  assert.deepEqual(f.json(['route', 'suggest']).json.rules, []);
});


test('别名与未知兼容后端的 fit 回填', t => {
  const cfg = config();
  cfg.profiles = {
    alias: cfg.profiles.ds,
    unknown: { adapter: 'claude-code', enabled: true, env: { ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic' }, secrets: { ANTHROPIC_AUTH_TOKEN: 'EXAMPLE_KEY' } },
  };
  cfg.defaultProfile = 'alias';
  cfg.routing.rules = [];
  cfg.prices = { unknown: { input: 1, output: 1, currency: 'CNY' } };
  const f = fixture(t, cfg, { alias: { at: AT, ok: true }, unknown: { at: AT, ok: true } });
  const listed = f.json(['agents', 'list']);
  assert.equal(listed.status, 0, listed.stderr);
  const agents = listed.json.agents;
  assert.deepEqual(agents.find(a => a.name === 'alias').fit, { good: ['文档与大段中文文本编辑', '按清单补测试'], avoid: [] });
  assert.equal(agents.find(a => a.name === 'unknown').fit, undefined);
  const listText = f.ar(['agents', 'list']);
  assert.match(listText.stdout, /alias.*擅长：文档与大段中文文本编辑、按清单补测试/);
  assert.doesNotMatch(listText.stdout.split('\n').find(line => line.includes('unknown')), /擅长：/);
  const suggested = f.json(['route', 'suggest']);
  assert.equal(suggested.status, 0, suggested.stderr);
  assert.deepEqual(suggested.json.rules.find(r => r.profile === 'alias').fit, { good: ['文档与大段中文文本编辑', '按清单补测试'], avoid: [] });
  assert.equal(suggested.json.rules.find(r => r.profile === 'unknown').fit, undefined);
  const text = f.ar(['route', 'suggest']).stdout;
  assert.match(text, /alias.*擅长：文档与大段中文文本编辑、按清单补测试/);
  assert.doesNotMatch(text.split('\n').find(line => line.includes('→ unknown')), /擅长：/);
});
