import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createPlan, executePlan, project, version } from '../../installer/lib/install.mjs';
import { checkSkills } from '../../core/lib/skills-check.mjs';

test('缺失、旧版、正文差异及手装技能', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-skills-'));
  assert.ok(!relative(tmpdir(), dir).startsWith('..') && !isAbsolute(relative(tmpdir(), dir)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, 'claude'), root = join(dir, 'repo'), env = { CLAUDE_CONFIG_DIR: claude };
  mkdirSync(claude); mkdirSync(root);
  const put = (file, data) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, data); };
  for (const skill of ['agent-router', 'lead-workflow']) put(join(claude, 'skills', skill, 'SKILL.md'), 'same');
  put(join(claude, 'skills', 'agent-router', '.agent-router.json'), JSON.stringify({ version: '1.2.9' }));
  put(join(root, 'skills', 'agent-router', 'SKILL.md'), 'different');
  const check = () => checkSkills({ env, root, coreVersion: '1.10.0' });
  assert.deepEqual(check().issues.map(({ skill, kind }) => [skill, kind]), [['agent-router', 'old'], ['agent-router', 'differs'], ['lead-practices', 'missing']]);
  put(join(claude, 'skills', 'agent-router', '.agent-router.json'), JSON.stringify({ version: '1.10.0' }));
  put(join(root, 'skills', 'agent-router', 'SKILL.md'), 'same');
  put(join(claude, 'skills', 'lead-practices', 'SKILL.md'), 'custom');
  assert.deepEqual(check(), { ok: true, issues: [] });
  assert.deepEqual(checkSkills({ env: { CLAUDE_CONFIG_DIR: join(dir, 'absent') }, root, coreVersion: '1.0.0' }), { ok: true, issues: [] });
});


test('配置目录没有 skills 时跳过，真实安装后的正文与仓库一致', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-skills-install-'));
  assert.ok(!relative(tmpdir(), dir).startsWith('..') && !isAbsolute(relative(tmpdir(), dir)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, 'claude'), env = { ...process.env, CLAUDE_CONFIG_DIR: claude, AGENT_ROUTER_HOME: join(dir, 'home') };
  mkdirSync(claude);
  assert.deepEqual(checkSkills({ env, root: project, coreVersion: version }), { ok: true, issues: [] });
  executePlan(createPlan({ env }), { env });
  assert.deepEqual(checkSkills({ env, root: project, coreVersion: version }), { ok: true, issues: [] });
  const file = join(claude, 'skills', 'lead-practices', 'SKILL.md');
  writeFileSync(file, '修改的一行\n');
  assert.deepEqual(checkSkills({ env, root: project, coreVersion: version }).issues.map(i => [i.skill, i.kind]), [['lead-practices', 'differs']]);
});
