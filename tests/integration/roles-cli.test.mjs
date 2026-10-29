import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Stage07c T4：ar roles 与路由的执行者池。隔离的 AGENT_ROUTER_HOME；只读配置与路由试算，不派发、不启动任何执行者。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const config = () => ({
  v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
  profiles: {
    fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 },
    ds: { adapter: 'claude-code', label: 'DeepSeek', enabled: true, model: 'deepseek-v4-flash' },
    qoder: { adapter: 'claude-code', label: 'Qoder', enabled: true, model: 'Auto', modelFamilies: ['deepseek', 'qwen'], roles: ['reviewer'] },
    kimi: { adapter: 'claude-code', label: 'Kimi', enabled: true, model: 'kimi-k3', limits: { maxTasksPerDay: 3 } },
    off: { adapter: 'claude-code', label: '停用的', enabled: false, model: 'glm-5' },
  },
  routing: { rules: [{ types: ['docs'], profile: 'qoder' }, { types: ['code'], profile: 'ds' }], fallback: 'qoder', reviewer: { profiles: ['qoder', 'kimi'], mustDiffer: true } },
});

function fixture(t, cfg = config()) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 角色 '));
  t.after(() => { rmSync(base, { recursive: true, force: true }); });
  const home = path.join(base, '隔离 公共目录');
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_PROFILE']) delete env[key];
  // 配置用 Node 写（无 BOM）。
  const file = path.join(home, 'config.json');
  writeFileSync(file, JSON.stringify(cfg));
  const f = { home, file, env };
  f.ar = args => spawnSync(process.execPath, [script, ...args], { cwd: base, env, encoding: 'utf8' });
  f.json = args => { const r = f.ar([...args, '--json']); return { status: r.status, stderr: r.stderr, json: JSON.parse(r.stdout) }; };
  f.read = () => JSON.parse(readFileSync(file, 'utf8'));
  return f;
}

test('ar roles：文字输出列出执行者、可担任（默认 / 设置）、模型、家族与来源，以及审查者设置', t => {
  const f = fixture(t);
  const r = f.ar(['roles']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.ok(lines.includes('  ds（DeepSeek）：可担任 执行者、审查者（默认）；模型 deepseek-v4-flash；家族 deepseek（按模型）'), r.stdout);
  assert.ok(lines.includes('  qoder（Qoder）：可担任 审查者（设置）；模型 Auto；家族 deepseek、qwen（按声明）'), r.stdout);
  assert.ok(lines.some(line => line.startsWith('  fake（假执行者）') && line.endsWith('家族 未知')), r.stdout);
  assert.ok(!r.stdout.includes('停用的'), '已停用的不列');
  assert.ok(lines.includes('审查者候选顺序：qoder、kimi'));
  assert.ok(lines.includes('审查者必须与执行者不同（mustDiffer）：是'));
  assert.ok(lines.includes('审查者必须与执行者不同家族（differFamily）：是'));
  assert.ok(lines.includes('审查者必须与主导不同（differFromLead）：是'));
  assert.ok(lines.includes('主导：未设置（按 Claude Code，家族 claude）'));
});

test('ar roles --json：结构化输出', t => {
  const f = fixture(t);
  const { status, json } = f.json(['roles']);
  assert.equal(status, 0);
  assert.equal(json.ok, true);
  assert.deepEqual(json.reviewerOrder, ['qoder', 'kimi']);
  assert.equal(json.mustDiffer, true);
  assert.equal(json.differFamily, true);
  assert.equal(json.differFromLead, true);
  assert.deepEqual(json.lead, { profiles: [], families: ['claude'], source: 'default' });
  assert.equal(json.leadFamily, 'claude', '保留原来的字段，取 families 的第一个');
  assert.deepEqual(json.profiles.map(p => p.name), ['fake', 'ds', 'qoder', 'kimi']);
  const qoder = json.profiles.find(p => p.name === 'qoder');
  assert.deepEqual([qoder.roles, qoder.rolesSource, qoder.families, qoder.familiesSource, qoder.modelFamilies], [['reviewer'], 'set', ['deepseek', 'qwen'], 'declared', ['deepseek', 'qwen']]);
  const ds = json.profiles.find(p => p.name === 'ds');
  assert.deepEqual([ds.roles, ds.rolesSource, ds.families, ds.familiesSource], [['executor', 'reviewer'], 'default', ['deepseek'], 'model']);
});

test('ar roles --review-for：选谁、跳过谁、为什么；--model 改变执行者家族', t => {
  const f = fixture(t);
  const a = f.json(['roles', '--review-for', 'ds']);
  assert.equal(a.json.ok, true);
  assert.equal(a.json.profile, 'kimi');
  assert.equal(a.json.reasons.length, 1);
  assert.equal(a.json.reasons[0].profile, 'qoder');
  assert.match(a.json.reasons[0].why, /DeepSeek 执行者与 qoder（Auto，声明范围含 deepseek、qwen）同家族/);
  const text = f.ar(['roles', '--review-for', 'ds']);
  assert.match(text.stdout, /^审查者：kimi/);
  assert.match(text.stdout, /跳过 qoder：/);
  const b = f.json(['roles', '--review-for', 'ds', '--model', 'kimi-k3']);
  assert.equal(b.json.profile, 'qoder', '执行者这次用 kimi 模型，qoder 的声明范围不含 kimi');
  assert.equal(b.json.model, 'kimi-k3');
  const none = f.json(['roles', '--review-for', 'kimi', '--model', 'deepseek-v4-flash']);
  assert.equal(none.json.profile, undefined);
  const bad = f.ar(['roles', '--review-for']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /用法：ar roles/);
});

test('ar roles --review-for：没有合适的审查者时 ok:false 并给原因', t => {
  const cfg = config();
  cfg.routing.reviewer.profiles = ['qoder'];
  const f = fixture(t, cfg);
  const r = f.json(['roles', '--review-for', 'ds']);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.reasons.length, 1);
  assert.match(f.ar(['roles', '--review-for', 'ds']).stdout, /^没有合适的审查者/);
});

test('ar roles set：写 roles 与 modelFamilies，其余字段与其他执行者原样保留；空值清除', t => {
  const f = fixture(t);
  const before = f.read();
  const r = f.json(['roles', 'set', 'kimi', 'roles=executor', 'modelFamilies=Kimi,Qwen']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.updated, 'kimi');
  const after = f.read();
  assert.deepEqual(after.profiles.kimi, { ...before.profiles.kimi, roles: ['executor'], modelFamilies: ['kimi', 'qwen'] });
  assert.deepEqual({ ...after, profiles: { ...after.profiles, kimi: null } }, { ...before, profiles: { ...before.profiles, kimi: null } });
  assert.deepEqual(r.json.profiles.find(p => p.name === 'kimi').roles, ['executor']);
  f.json(['roles', 'set', 'kimi', 'roles=', 'modelFamilies=']);
  assert.deepEqual(f.read(), before, '清除后回到原样');
});

test('ar roles set：非法值与未知执行者被拒绝，配置文件一个字节都不变', t => {
  const f = fixture(t);
  const before = readFileSync(f.file);
  for (const [args, pattern] of [
    [['roles', 'set', 'kimi', 'roles=boss'], /roles 必须是 executor、reviewer、lead/],
    [['roles', 'set', 'kimi', 'roles=executor,executor'], /roles 必须是 executor、reviewer、lead/],
    [['roles', 'set', 'kimi', 'roles=lead,lead'], /roles 必须是 executor、reviewer、lead/],
    [['roles', 'set', 'ghost', 'roles=executor'], /找不到执行者：ghost/],
    [['roles', 'set', 'kimi', 'color=red'], /用法：ar roles/],
    [['roles', 'set', 'kimi'], /用法：ar roles/],
    [['roles', 'set', 'kimi', 'roles=executor', 'roles=reviewer'], /用法：ar roles/],
  ]) {
    const r = f.ar(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, pattern, args.join(' '));
    assert.deepEqual(readFileSync(f.file), before, args.join(' '));
  }
});

test('ar roles set：可以写 lead（190 D128）；只设主导的 Agent 不进路由、不当审查者', t => {
  const f = fixture(t);
  const r = f.json(['roles', 'set', 'kimi', 'roles=lead,executor']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.read().profiles.kimi.roles, ['lead', 'executor']);
  const kimi = r.json.profiles.find(p => p.name === 'kimi');
  assert.deepEqual([kimi.roles, kimi.rolesSource], [['executor', 'lead'], 'set']);
  assert.deepEqual(r.json.lead, { profiles: ['kimi'], families: ['kimi'], source: 'set' });
  assert.equal(r.json.leadFamily, 'kimi');
  assert.ok(f.ar(['roles']).stdout.includes('主导：kimi（家族 kimi）'));

  // 只设 lead：路由不选它，审查者候选也跳过它。
  assert.equal(f.json(['roles', 'set', 'kimi', 'roles=lead']).status, 0);
  const docs = f.json(['route', '--type', 'docs']);
  assert.notEqual(docs.json.profile, 'kimi');
  assert.ok(docs.json.trace.includes('兜底：qoder：没有设为可担任执行者，跳过'), docs.json.trace.join('\n'));
  const review = f.json(['roles', '--review-for', 'ds']);
  assert.equal(review.json.profile, undefined);
  assert.ok(review.json.reasons.some(item => item.profile === 'kimi' && item.why === '没有设为可担任审查者'), JSON.stringify(review.json.reasons));
});

test('ar roles：没设主导时按 Claude Code（claude 家族的审查者被 differFromLead 跳过）', t => {
  const cfg = config();
  cfg.profiles.sonnet = { adapter: 'claude-code', label: 'Sonnet', enabled: true, model: 'claude-sonnet-5-5' };
  cfg.routing.reviewer.profiles = ['sonnet', 'kimi'];
  const f = fixture(t, cfg);
  const r = f.json(['roles', '--review-for', 'ds']);
  assert.equal(r.json.profile, 'kimi');
  assert.deepEqual(r.json.reasons, [{ profile: 'sonnet', why: '与主导同家族（claude）' }]);
  assert.deepEqual(f.json(['roles']).json.lead, { profiles: [], families: ['claude'], source: 'default' });
});

test('ar roles：主导家族按设为主导的 Agent 算（一个 / 两个取并集）', t => {
  const f = fixture(t);
  // ds（deepseek 家族）设为主导：deepseek 家族的审查者 qoder 被 differFromLead 跳过。
  assert.equal(f.json(['roles', 'set', 'ds', 'roles=lead']).status, 0);
  const lead = f.json(['roles']);
  assert.deepEqual(lead.json.lead, { profiles: ['ds'], families: ['deepseek'], source: 'set' });
  assert.equal(lead.json.leadFamily, 'deepseek');
  assert.ok(f.ar(['roles']).stdout.includes('主导：ds（家族 deepseek）'));
  const picked = f.json(['roles', '--review-for', 'fake']);
  assert.ok(picked.json.reasons.some(item => item.profile === 'qoder' && item.why === '与主导同家族（deepseek）'), JSON.stringify(picked.json.reasons));
  // 再设 kimi 为主导：并集是 deepseek、kimi。
  assert.equal(f.json(['roles', 'set', 'kimi', 'roles=lead']).status, 0);
  const both = f.json(['roles']);
  assert.deepEqual(both.json.lead, { profiles: ['ds', 'kimi'], families: ['deepseek', 'kimi'], source: 'set' });
});

test('ar roles：主导里有家族未知的，已知家族与"另有家族未知"都要写（190 R1-1）', t => {
  const cfg = config();
  cfg.profiles.boss = { adapter: 'claude-code', label: 'Boss', enabled: true, roles: ['lead'], model: 'deepseek-v4-flash' };
  cfg.profiles.mystery = { adapter: 'claude-code', label: '未知家族的主导', enabled: true, roles: ['lead'], model: 'Auto', env: { ANTHROPIC_BASE_URL: 'https://example.test' } };
  const f = fixture(t, cfg);
  const view = f.json(['roles']).json;
  assert.deepEqual(view.lead, { profiles: ['boss', 'mystery'], families: ['deepseek'], source: 'set' });
  const out = f.ar(['roles']).stdout;
  assert.ok(out.includes('主导：boss、mystery（家族 deepseek，另有家族未知）'), out);
  // 全部主导的家族都未知时只写"家族未知"。
  const onlyUnknown = config();
  onlyUnknown.profiles.mystery = cfg.profiles.mystery;
  const g = fixture(t, onlyUnknown);
  assert.ok(g.ar(['roles']).stdout.includes('主导：mystery（家族未知）'));
});

test('ar route reviewer set：保留已有的 differFromLead', t => {
  const cfg = config();
  cfg.routing.reviewer.differFromLead = false;
  const f = fixture(t, cfg);
  assert.equal(f.json(['route', 'reviewer', 'set', JSON.stringify({ profiles: ['kimi'], mustDiffer: true })]).status, 0);
  assert.deepEqual(f.read().routing.reviewer, { profiles: ['kimi'], mustDiffer: true, differFromLead: false });
  assert.equal(f.json(['roles']).json.differFromLead, false);
});

test('路由：规则与兜底跳过不能当执行者的执行者并在 trace 里写原因；明确 --profile 仍可用', t => {
  const f = fixture(t);
  // docs 规则指向 qoder（只能当审查者），跳过后落到兜底 qoder，也跳过，最后是 defaultProfile fake。
  const docs = f.json(['route', '--type', 'docs']);
  assert.equal(docs.status, 0, docs.stderr);
  assert.equal(docs.json.profile, 'fake');
  assert.ok(docs.json.trace.includes('全局规则 1：[docs] → qoder：没有设为可担任执行者，跳过'), docs.json.trace.join('\n'));
  assert.ok(docs.json.trace.includes('兜底：qoder：没有设为可担任执行者，跳过'));
  // 没写 roles 的执行者行为不变。
  assert.equal(f.json(['route', '--type', 'code']).json.profile, 'ds');
  // 明确指定照旧可以用，trace 写一句说明。
  const explicit = f.json(['route', '--profile', 'qoder']);
  assert.equal(explicit.status, 0);
  assert.equal(explicit.json.profile, 'qoder');
  assert.deepEqual(explicit.json.trace, ['qoder 没有设为可担任执行者，按明确指定使用', '命令行指定：qoder']);
});

test('路由：唯一启用的执行者不能当执行者时报错并说明', t => {
  const cfg = config();
  cfg.profiles = { only: { adapter: 'claude-code', label: '唯一的', enabled: true, model: 'kimi-k3', roles: ['reviewer'] } };
  cfg.defaultProfile = null;
  cfg.routing = { rules: [], fallback: null, reviewer: null };
  const f = fixture(t, cfg);
  const r = f.json(['route', '--type', 'code']);
  assert.equal(r.status, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'NO_PROFILE');
  assert.match(r.json.error, /唯一启用的执行者 only 没有设为可担任执行者/);
  assert.equal(f.json(['route', '--profile', 'only']).json.profile, 'only');
});
