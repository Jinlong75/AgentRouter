import { matchesGlob, isAbsolute, win32, join, resolve, relative } from 'node:path';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { git } from './git.mjs';
import { locateStart, findTerminal } from './wait.mjs';

const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value);

export function collectResearch({ root, homes, name }) {
  if (!safeName(name)) throw new Error('调研名不安全');
  const dir = join(root, '.agent-runs', 'research', name);
  let plan;
  try { plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')); }
  catch { throw new Error('调研不存在或计划无法读取'); }
  if (!Array.isArray(plan.batches) || plan.batches.some(b => !safeName(b.record) || !Array.isArray(b.files))) throw new Error('调研计划无效');
  const missing = [], lines = [`# 调研汇总`, '', `问题：${plan.question}`, `快照提交：${plan.snapshot}`, ''];
  for (const part of plan.batches) {
    const taskDir = join(root, '.agent-runs', part.record);
    const found = locateStart(homes, root, part.record);
    const ended = found && findTerminal(found.file, found.start.id);
    let report = null;
    try { report = readFileSync(join(taskDir, 'report.md'), 'utf8'); } catch { /* 没有汇报按未交处理。 */ }
    if (!ended || report === null || !report.trim()) missing.push(part.index);
    lines.push(`## 第 ${part.index} 批`, '', '文件清单：', ...part.files.map(file => `- ${file}`), '', '汇报：', ended && report?.trim() ? report : '未交', '', '超出本批范围的读取：');
    let events = '';
    try { events = readFileSync(join(taskDir, 'events.jsonl'), 'utf8'); } catch { /* 没有事件无法判断。 */ }
    const outside = new Set();
    for (const line of events.split('\n')) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.kind !== 'tool' || event.name !== 'Read' || typeof event.detail !== 'string' || !event.detail.startsWith('Read ')) continue;
      // claude-code 的 describe 将 detail 截到 200 字符；达到上限时路径可能不完整，不能判为越界。
      if (event.detail.length >= 200) continue;
      const file = event.detail.slice(5);
      if (!part.files.includes(relative(root, resolve(root, file)).replaceAll('\\', '/'))) outside.add(file);
    }
    lines.push(...[...outside].map(file => `- ${file}`), '无法判断是否还有其他读取', '');
  }
  if (missing.length) lines.push(`未交批次：${missing.join('、')}`, '');
  else lines.push('未交批次：无', '');
  const summary = join(dir, 'summary.md'), temp = `${summary}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try { writeFileSync(temp, lines.join('\n'), { flag: 'wx' }); renameSync(temp, summary); }
  finally { rmSync(temp, { force: true }); }
  return { name, summary, missing };
}

// 只从固定提交枚举文件，避免工作区里的未跟踪文件影响分批。
export function planResearch({ root, question, patterns, batch = 10, budgetMin = 30 }) {
  if (typeof question !== 'string' || !question.trim()) throw new Error('调研问题不能为空');
  if (!Array.isArray(patterns) || !patterns.length) throw new Error('请指定文件匹配模式');
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern || isAbsolute(pattern) || win32.isAbsolute(pattern)
      || /^[A-Za-z]:/.test(pattern) || pattern.includes('\\') || pattern.split('/').includes('..')) {
      throw new Error('文件匹配模式必须是项目内的相对路径');
    }
  }
  for (const value of [batch, budgetMin]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('批次大小和时限必须是正整数');
  }
  // 时限上限 24 小时：setTimeout 超过约 24.8 天会溢出成立即触发，这里留足余量。
  if (budgetMin > 1440) throw new Error('时限最多 1440 分钟');
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const snapshot = head.stdout.trim();
  if (head.status !== 0 || !/^[a-f0-9]{40,64}$/.test(snapshot)) throw new Error('当前目录不是有提交的 git 项目');
  const listing = git(root, ['ls-tree', '-r', '-z', '--name-only', snapshot]);
  if (listing.status !== 0) throw new Error('无法枚举快照文件');
  const files = listing.stdout.split('\0').filter(file => file && patterns.some(pattern => matchesGlob(file, pattern))).sort();
  if (!files.length) throw new Error('没有匹配的已跟踪文件');
  const batches = [];
  for (let i = 0; i < files.length; i += batch) batches.push({ index: batches.length + 1, files: files.slice(i, i + batch) });
  return { question: question.trim(), snapshot, budgetMin, batches };
}
