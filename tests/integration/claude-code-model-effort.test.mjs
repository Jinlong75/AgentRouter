import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../../core/lib/agents.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(project, 'core/ar.mjs');
const fixture = name => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const jsonl = file => fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
const BASE = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];
const TIER_LINE = '配置：claude-code 执行者不支持 tier，已忽略';

// 假的 Claude Code 记录收到的参数；隔离的 AGENT_ROUTER_HOME 与临时仓库，不启动真实程序。
function setup(t, profileExtra = {}) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'claude 模型强度 '));
  t.after(() => { assert.equal(path.dirname(base), path.resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const root = path.join(base, '示例 仓库'), home = path.join(base, '公共 配置');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const profile = { ...loadPreset('deepseek').profile, ...profileExtra };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'deepseek', profiles: { deepseek: profile }, managed: false }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_)/i.test(k)) delete env[k];
  Object.assign(env, {
    AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', USERPROFILE: base, HOME: base, APPDATA: base,
    AR_TEST_AGENT: fixture('fake-claude-code.mjs'), AR_TEST_ENV_REPORT: path.join(base, 'env.json'), DEEPSEEK_API_KEY: 'sk-test-model-effort',
  });
  assert.equal(path.dirname(env.AGENT_ROUTER_HOME), base);
  const dispatch = (...extra) => spawnSync(process.execPath, [entry, 'dispatch', '创建 hello.txt 并报告', '--name', '记录', '--profile', 'deepseek', ...extra], {
    cwd: root, env, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
  const args = () => JSON.parse(fs.readFileSync(path.join(base, 'env.json'), 'utf8')).args;
  const start = () => jsonl(path.join(home, 'runs.jsonl'))[0];
  const progress = () => fs.readFileSync(path.join(root, '.agent-runs', '记录', 'progress.log'), 'utf8');
  return { dispatch, args, start, progress };
}

test('claude-code 派发：--model / --effort 传给 Claude Code，start 记录这两个值', t => {
  const s = setup(t), r = s.dispatch('--effort', 'high', '--model', 'm-x');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.args(), [...BASE, '--model', 'm-x', '--effort', 'high']);
  assert.equal(s.start().model, 'm-x'); assert.equal(s.start().effort, 'high');
  assert.ok(!s.progress().includes(TIER_LINE));
});

test('claude-code 派发：profile 里的 effort 在命令行没给时生效', t => {
  const s = setup(t, { effort: 'medium' }), r = s.dispatch();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.args(), [...BASE, '--effort', 'medium']);
  assert.equal(s.start().effort, 'medium');
  assert.equal(s.start().model, 'deepseek-v4-pro', '没给 --model 时仍取 ANTHROPIC_MODEL');
});

test('claude-code 派发：--tier 不传入参数，进度里只有一行提示', t => {
  const s = setup(t), r = s.dispatch('--tier', 'flex');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.args(), BASE);
  assert.equal(s.progress().split('\n').filter(l => l.includes(TIER_LINE)).length, 1);
  assert.equal(s.start().tier, 'flex');
});

test('claude-code 派发：什么都不给时参数与原来相同，start.model 取 ANTHROPIC_MODEL', t => {
  const s = setup(t), r = s.dispatch();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.args(), BASE);
  assert.equal(s.start().model, 'deepseek-v4-pro'); assert.equal(s.start().effort, null);
  assert.ok(!s.progress().includes('不支持 tier'));
});
