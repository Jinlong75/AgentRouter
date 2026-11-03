import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { planHook, applyHook, removeHook, writeSettings } from '../../installer/lib/claude-hook.mjs';
import { createPlan, executePlan, rollback } from '../../installer/lib/install.mjs';
import { runInstaller } from '../../installer/cli.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'ar-hook-'));
  const rel = relative(os.tmpdir(), root);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, claudeDir: join(root, 'claude'), coreDir: join(root, 'core'), env: { AGENT_ROUTER_HOME: join(root, 'home') } };
}
const read = f => JSON.parse(fs.readFileSync(join(f.claudeDir, 'settings.json'), 'utf8'));
const options = f => ({ env: f.env, claudeDir: join(f.claudeDir, 'skills'), host: 'claude-code', skill: 'agent-router' });

test('安装、更新、去重和卸载只影响自己的钩子', t => {
  const f = fixture(t), path = join(f.claudeDir, 'settings.json');
  applyHook(planHook(f));
  assert.equal(read(f).hooks.SessionStart.length, 1);
  assert.equal(read(f).hooks.PreToolUse.length, 1);
  assert.equal(read(f).hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(read(f).hooks.PreToolUse[0].hooks[0].command, `node "${join(f.coreDir, 'hooks', 'bash-guard.mjs')}"`);
  const other = { hooks: [{ type: 'command', command: 'echo other' }] };
  fs.writeFileSync(path, JSON.stringify({ theme: 'dark', hooks: { SessionStart: [other, ...read(f).hooks.SessionStart], PreToolUse: [other, ...read(f).hooks.PreToolUse], Stop: [other] } }));
  applyHook(planHook(f));
  applyHook(planHook({ ...f, coreDir: join(f.root, 'new core') }));
  const settings = read(f);
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.hooks.Stop, [other]);
  assert.equal(settings.hooks.SessionStart.length, 2);
  assert.deepEqual(settings.hooks.SessionStart[0], other);
  assert.match(settings.hooks.SessionStart[1].hooks[0].command, /new core/);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.deepEqual(settings.hooks.PreToolUse[0], other);
  assert.equal(settings.hooks.PreToolUse[1].hooks[0].command, `node "${join(f.root, 'new core', 'hooks', 'bash-guard.mjs')}"`);
  removeHook(planHook(f));
  assert.deepEqual(read(f).hooks.SessionStart, [other]);
  assert.deepEqual(read(f).hooks.PreToolUse, [other]);
});

test('非法 JSON 不修改，技能仍安装', t => {
  const f = fixture(t); fs.mkdirSync(f.claudeDir); const path = join(f.claudeDir, 'settings.json');
  fs.writeFileSync(path, '{broken');
  assert.ok(planHook(f).error);
  const plan = createPlan(options(f));
  assert.match(plan.warnings[0].message, /不是合法 JSON/);
  executePlan(plan, options(f));
  assert.equal(fs.readFileSync(path, 'utf8'), '{broken');
  assert.ok(fs.existsSync(join(f.claudeDir, 'skills', 'agent-router', 'SKILL.md')));
});

test('安装后的回退逐字节还原原设置，原来不存在则删除', t => {
  for (const original of ['{  "theme": "dark" }\r\n', null]) {
    const f = fixture(t); fs.mkdirSync(f.claudeDir); const path = join(f.claudeDir, 'settings.json');
    if (original !== null) fs.writeFileSync(path, original);
    const opt = options(f), result = executePlan(createPlan(opt), opt);
    const backup = JSON.parse(fs.readFileSync(join(result.backup, 'backup.json'), 'utf8'));
    assert.deepEqual(backup.claudeSettings, { path, existed: original !== null, text: original ?? '' });
    assert.equal(read(f).hooks.SessionStart.length, 1);
    assert.equal(read(f).hooks.PreToolUse.length, 1);
    rollback(opt);
    if (original === null) assert.equal(fs.existsSync(path), false);
    else assert.equal(fs.readFileSync(path, 'utf8'), original);
  }
});

test('--dry-run 展示钩子，--no-hook 不改已注册设置', async t => {
  const f = fixture(t), root = join(f.claudeDir, 'skills'), args = ['--host', 'claude-code', '--skill', 'agent-router', '--claude-dir', root, '--yes'];
  const lines = [], opts = { env: f.env, output: line => lines.push(line) };
  await runInstaller([...args, '--dry-run'], opts);
  assert.ok(lines.some(line => line.includes(`注册会话启动钩子：${join(f.claudeDir, 'settings.json')}`)));
  assert.equal(fs.existsSync(f.claudeDir), false);
  fs.mkdirSync(f.claudeDir); const path = join(f.claudeDir, 'settings.json');
  fs.writeFileSync(path, '{"existing":true}');
  await runInstaller([...args, '--no-hook'], opts);
  assert.equal(fs.readFileSync(path, 'utf8'), '{"existing":true}');
});

test('安装器卸载钩子，禁用钩子选项保留已有注册', t => {
  const f = fixture(t), opt = options(f), path = join(f.claudeDir, 'settings.json');
  executePlan(createPlan(opt), opt);
  const installed = fs.readFileSync(path, 'utf8');
  executePlan(createPlan({ ...opt, noHook: true }), opt);
  assert.equal(fs.readFileSync(path, 'utf8'), installed);
  executePlan(createPlan({ ...opt, uninstall: true }), opt);
  assert.deepEqual(read(f).hooks.SessionStart, []);
  assert.deepEqual(read(f).hooks.PreToolUse, []);
});


test('preserves settings permissions and secures new files', { skip: process.platform === 'win32' ? 'Windows does not support POSIX mode semantics' : false }, t => {
  const f = fixture(t), path = join(f.claudeDir, 'settings.json');
  applyHook(planHook(f));
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  fs.chmodSync(path, 0o640);
  applyHook(planHook(f));
  assert.equal(fs.statSync(path).mode & 0o777, 0o640);
  removeHook(planHook(f));
  assert.equal(fs.statSync(path).mode & 0o777, 0o640);
});

test('interactive replacement prints new plan warnings', async t => {
  const f = fixture(t), root = join(f.claudeDir, 'skills'), target = join(root, 'agent-router');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(join(target, 'foreign.txt'), 'original');
  const path = join(f.claudeDir, 'settings.json');
  fs.writeFileSync(path, '{broken');
  const lines = [], answers = ['y', 'y'];
  const result = await runInstaller(['--host', 'claude-code', '--skill', 'agent-router', '--claude-dir', root, '--no-config'], {
    env: f.env, interactive: true, ask: async () => answers.shift(), output: line => lines.push(line),
  });
  assert.ok(lines.some(line => line.includes('Claude Code \u8bbe\u7f6e\u6587\u4ef6\u4e0d\u662f\u5408\u6cd5 JSON\uff0c\u6ca1\u6709\u6ce8\u518c\u4f1a\u8bdd\u542f\u52a8\u94a9\u5b50')));
  assert.equal(fs.readFileSync(path, 'utf8'), '{broken');
  assert.ok(result.changed.some(item => item.skill === 'agent-router'));
  assert.ok(fs.existsSync(join(target, 'SKILL.md')));
});

test('特殊字符路径不注册钩子并提示，技能仍安装', t => {
  const f = fixture(t);
  f.claudeDir = join(f.root, 'claude$test');
  const opt = options(f), plan = createPlan(opt);
  assert.ok(plan.warnings.some(w => w.message === '钩子路径含 shell 特殊字符，未注册会话启动钩子；可手动在 Claude Code 设置里添加'));
  assert.equal(plan.hook, undefined);
  executePlan(plan, opt);
  assert.equal(fs.existsSync(join(f.claudeDir, 'settings.json')), false);
  assert.ok(fs.existsSync(join(f.claudeDir, 'skills', 'agent-router', 'SKILL.md')));
  const direct = planHook({ claudeDir: f.claudeDir, coreDir: join(f.root, 'core$test') });
  applyHook(direct);
  assert.equal(fs.existsSync(direct.path), false);
});

test('计划单独保存钩子，过滤技能后只随 agent-router 执行', t => {
  for (const original of [null, '{"theme":"dark"}']) {
    const f = fixture(t), opt = { ...options(f), skill: 'all' }, path = join(f.claudeDir, 'settings.json');
    if (original !== null) { fs.mkdirSync(f.claudeDir); fs.writeFileSync(path, original); }
    const plan = createPlan(opt);
    assert.equal(plan.items.length, 3);
    assert.equal(plan.items.some(i => i.kind === 'claude-hook'), false);
    assert.equal(plan.hook.action, 'install');
    plan.items = plan.items.filter(i => i.skill === 'lead-workflow');
    const result = executePlan(plan, opt);
    assert.equal(fs.existsSync(path), original !== null);
    if (original !== null) assert.equal(fs.readFileSync(path, 'utf8'), original);
    assert.equal(JSON.parse(fs.readFileSync(join(result.backup, 'backup.json'), 'utf8')).claudeSettings, undefined);
    const agentPlan = createPlan(opt);
    agentPlan.items = agentPlan.items.filter(i => i.skill === 'agent-router');
    executePlan(agentPlan, opt);
    assert.equal(read(f).hooks.SessionStart.length, 1);
  }
});

test('备份目录及说明文件权限受限', { skip: process.platform === 'win32' ? 'Windows 不支持 POSIX 权限语义' : false }, t => {
  const f = fixture(t), opt = options(f);
  const result = executePlan(createPlan(opt), opt);
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o700);
  assert.equal(fs.statSync(join(result.backup, 'backup.json')).mode & 0o777, 0o600);
});

function linkedSettings(t, original) {
  const f = fixture(t), link = join(f.claudeDir, 'settings.json'), target = join(f.root, 'target.json');
  fs.mkdirSync(f.claudeDir);
  if (original !== undefined) fs.writeFileSync(target, original);
  try { fs.symlinkSync(target, link, 'file'); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('\u6ca1\u6709\u521b\u5efa\u7b26\u53f7\u94fe\u63a5\u7684\u6743\u9650'); return; }
    throw error;
  }
  return { f, link, target };
}

test('install preserves settings symlink', t => {
  const linked = linkedSettings(t, '{"a":1}'); if (!linked) return;
  const { f, link, target } = linked;
  applyHook(planHook(f));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  const settings = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(settings.a, 1);
  assert.equal(settings.hooks.SessionStart.length, 1);
});

test('remove preserves settings symlink', t => {
  const linked = linkedSettings(t, '{"a":1}'); if (!linked) return;
  const { f, link, target } = linked;
  applyHook(planHook(f));
  removeHook(planHook(f));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  const settings = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(settings.a, 1);
  assert.deepEqual(settings.hooks.SessionStart, []);
});

test('rollback preserves settings symlink', t => {
  const original = '{"a":1}', linked = linkedSettings(t, original); if (!linked) return;
  const { f, link, target } = linked;
  applyHook(planHook(f));
  writeSettings(link, original);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('dangling settings symlink creates target', t => {
  const linked = linkedSettings(t); if (!linked) return;
  const { f, link, target } = linked;
  applyHook(planHook(f));
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.SessionStart.length, 1);
});

test('invalid PreToolUse leaves settings unchanged', t => {
  const f = fixture(t), path = join(f.claudeDir, 'settings.json');
  fs.mkdirSync(f.claudeDir);
  const original = '{"hooks":{"PreToolUse":{}}}';
  fs.writeFileSync(path, original);
  const plan = planHook(f);
  assert.ok(plan.error);
  applyHook(plan);
  removeHook(plan);
  assert.equal(fs.readFileSync(path, 'utf8'), original);
});

test('upgrade preserves user hooks in mixed entries', t => {
  const f = fixture(t), path = join(f.claudeDir, 'settings.json');
  fs.mkdirSync(f.claudeDir);
  const other = { type: 'command', command: 'echo user' };
  fs.writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/old/ar.mjs" lead brief --hook' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [other, { type: 'command', command: 'node "/old/hooks/bash-guard.mjs"' }] }] } }));
  applyHook(planHook(f));
  const settings = read(f);
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks, [other]);
  removeHook(planHook(f));
  assert.deepEqual(read(f).hooks.PreToolUse[0].hooks, [other]);
});
