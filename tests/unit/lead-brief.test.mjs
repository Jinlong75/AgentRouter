import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { briefNext, leadBrief } from '../../core/lib/lead-brief.mjs';
import { AR_MARKER } from '../../core/lib/ar-command.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'ar-brief-')), root = join(base, 'repo'), home = join(base, 'home'), coreDir = join(base, 'agent-router/core');
  for (const dir of [root, home, coreDir]) mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q', root]);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const put = (path, value) => { const file = join(root, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, value); };
  return { root, home, coreDir, put, base };
}
const run = f => leadBrief({ ...f, env: { ...process.env, AGENT_ROUTER_HOME: f.home, CLAUDE_CONFIG_DIR: join(f.base, 'claude') } });

test('没有项目配置时为空', async t => {
  const f = fixture(t); assert.deepEqual(await run(f), { ok: true, sections: [], text: '' });
});
test('读取各节并截断交接文件', async t => {
  const f = fixture(t); f.put('.agent-router/project.json', '{}');
  f.put('handoff.md', Array.from({ length: 151 }, (_, i) => `行${i}`).join('\n'));
  f.put('skills/lead-practices/SKILL.md', '---\nname: test\n---\n经验正文'); f.put('docs/roles/lead.md', '角色正文');
  const result = await run(f);
  assert.deepEqual(result.sections.map(s => s.title), ['交接文件', '主导经验清单', '角色文档', '当前任务', '固定提醒']);
  assert.ok(result.sections.find(s => s.title === '固定提醒').text.includes('ar research "<问题>" --files <glob…>'));
  assert.ok(result.sections.find(s => s.title === '固定提醒').text.includes('ar dispatch "<任务文字>" --type research|chore'));
  assert.match(result.text, /（交接文件共 151 行，只放了前 150 行，其余用 Read 读）/);
  assert.match(result.text, /经验正文/); assert.doesNotMatch(result.text, /name: test/); assert.match(result.text, /角色正文/);
});
test('并列安装的经验清单优先', async t => {
  const f = fixture(t); f.put('.agent-router/project.json', '{}'); f.put('skills/lead-practices/SKILL.md', '仓库版');
  const dir = join(f.base, 'lead-practices'); mkdirSync(dir); writeFileSync(join(dir, 'SKILL.md'), '安装版');
  const result = await run(f); assert.match(result.text, /安装版/); assert.doesNotMatch(result.text, /仓库版/);
});
test('总长度超限时按优先级保留整节', async t => {
  const f = fixture(t); f.put('.agent-router/project.json', '{}'); f.put('handoff.md', '交'.repeat(15000));
  f.put('docs/roles/lead.md', '角'.repeat(10000)); f.put('skills/lead-practices/SKILL.md', '经'.repeat(10000));
  const result = await run(f); assert.ok(result.text.length <= 24000); assert.match(result.text, /交{100}/);
  assert.match(result.text, /角色文档 太长未放入/); assert.match(result.text, /主导经验清单 太长未放入/); assert.match(result.text, /你是本项目的主导/); assert.match(result.text, /## 当前任务/);
});

test('交接路径越界时提示并回退默认文件', async t => {
  const f = fixture(t); f.put('handoff.md', '安全交接');
  const outside = join(f.base, 'outside.md'); writeFileSync(outside, '仓库外内容');
  const values = [outside, '../outside.md', 'C:outside.md'];
  try { symlinkSync(outside, join(f.root, 'link.md'), 'file'); values.push('link.md'); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    t.diagnostic('Windows 无权限创建符号链接，跳过链接越界子用例');
  }
  const outsideDir = join(f.base, 'outside-dir'); mkdirSync(outsideDir); writeFileSync(join(outsideDir, 'handoff.md'), '仓库外内容');
  try { symlinkSync(outsideDir, join(f.root, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir'); values.push('linked-dir/handoff.md'); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    t.diagnostic('Windows 无权限创建目录联接，跳过目录联接越界子用例');
  }
  for (const value of values) {
    f.put('.agent-router/project.json', JSON.stringify({ lead: { handoff: value } }));
    const result = await run(f);
    assert.ok(result.text.includes(`交接文件路径不在仓库内，已忽略：${value}`));
    assert.match(result.text, /安全交接/); assert.doesNotMatch(result.text, /仓库外内容/);
  }
});

test('经验清单和角色文档不跟随仓库外链接', async t => {
  const f = fixture(t); f.put('.agent-router/project.json', '{}');
  const outside = join(f.base, 'outside.md'); writeFileSync(outside, '仓库外内容');
  f.put('skills/lead-practices/placeholder', ''); f.put('docs/roles/placeholder', '');
  try {
    symlinkSync(outside, join(f.root, 'skills/lead-practices/SKILL.md'), 'file');
    symlinkSync(outside, join(f.root, 'docs/roles/lead.md'), 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    t.skip('Windows 无权限创建符号链接'); return;
  }
  const result = await run(f); assert.doesNotMatch(result.text, /仓库外内容/);
  assert.match(result.text, /没有找到 lead-practices 技能/);
});

test('当前任务区分超时和失败', async t => {
  const f = fixture(t); f.put('.agent-router/project.json', '{}');
  assert.deepEqual(await briefNext({ root: f.root, home: f.home, env: {} }, 0), { timeout: true });
  writeFileSync(join(f.home, 'config.json'), '无效 JSON');
  const result = await run(f);
  assert.match(result.sections.find(s => s.title === '当前任务').text, /^取不到：不是有效的 JSON$/);
});


test('没有安装或仓库技能时读取核心副本', async t => {
  const f = fixture(t); f.put('.agent-router/project.json', '{}');
  const target = join(f.coreDir, 'templates/lead-practices');
  mkdirSync(join(target, '..'), { recursive: true });
  cpSync(resolve('core/templates/lead-practices'), target, { recursive: true });
  const result = await run(f), section = result.sections.find(item => item.title === '主导经验清单');
  assert.match(section.text, /# 主导经验清单/); assert.equal(section.path, join(target, 'checklist.md'));
});

test('开工包第一行写明本机核心命令，ar 被挡住时改用 agr', async t => {
  const f = fixture(t); f.put('.agent-router/project.json', '{}');
  const win = process.platform === 'win32', sep = win ? ';' : ':';
  const shadow = join(f.base, 'shadow'), aliasBin = join(f.base, 'alias-bin'), ownBin = join(f.base, 'own-bin');
  for (const dir of [shadow, aliasBin, ownBin]) mkdirSync(dir, { recursive: true });
  const foreignAr = join(shadow, win ? 'ar.exe' : 'ar'), installedAr = join(ownBin, win ? 'ar.cmd' : 'ar'), installedAgr = join(aliasBin, win ? 'agr.cmd' : 'agr');
  writeFileSync(foreignAr, '别的 ar');
  writeFileSync(installedAr, `${AR_MARKER}\n@echo off\n`);
  writeFileSync(installedAgr, `${AR_MARKER}\n@echo off\n`);
  // 只往 PATH 前面加临时目录，后面的真实 PATH 留着让 git 和 node 照常找到。
  const envFor = dirs => ({ ...process.env, PATH: [...dirs, process.env.PATH ?? ''].join(sep), AGENT_ROUTER_HOME: f.home, CLAUDE_CONFIG_DIR: join(f.base, 'claude') });
  const blocked = await leadBrief({ ...f, env: envFor([shadow, aliasBin]) });
  assert.equal(blocked.text.split('\n')[0], `本机核心命令：agr（这台机器上的 ar 是 ${foreignAr}，不是 AgentRouter；下文和技能里写的 ar 都换成它）`);
  const normal = await leadBrief({ ...f, env: envFor([ownBin]) });
  assert.equal(normal.text.split('\n')[0], '本机核心命令：ar');
  assert.equal(blocked.ack.token, normal.ack.token);
});
