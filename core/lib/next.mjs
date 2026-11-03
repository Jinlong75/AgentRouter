import { fullVerifyStatus, dateText } from './verify-full.mjs';
import { checkSkills, installedCoreVersion } from './skills-check.mjs';
import { sampleResources, effectiveConcurrency, concurrencyAdjustLine } from './resources.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { basename, join, relative, resolve, sep } from 'node:path';
import { readConfig, slotLimits } from './config.mjs';
import { currentLoad, createTaskLimit, pathsOverlap, readProject, taskScope } from './schedule.mjs';
import { liveHolders } from './slots.mjs';
import { parseSpec, validateSpec, mergeSpec, missingSpecRequired } from './spec.mjs';
import { taskAlive } from './process.mjs';
import { git, headSha } from './git.mjs';
import { needsReadOnly } from './run.mjs';

const repoKey = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
const runningEvents = new Set(['preparing', 'worktree', 'setup', 'attempt', 'gating', 'gate', 'attempt-end']);

async function nextVerifyStatus({ home, root, branch }) {
  const status = await fullVerifyStatus({ home, root, branch });
  let passed = false;
  try {
    passed = readFileSync(join(home, 'runs.jsonl'), 'utf8').split('\n').some(line => {
      try { const row = JSON.parse(line); return row.event === 'full-verify' && row.ok === true && typeof row.repo === 'string' && repoKey(row.repo) === repoKey(root) && row.branch === branch; } catch { return false; }
    });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...status, passed };
}

// 与 run.mjs readAndMergeSpec 的文字保持一致。
function missingReason(parsed, rule, file) {
  const missing = missingSpecRequired(parsed, rule), parts = [];
  if (missing.fields.length) parts.push(`字段 ${missing.fields.join('、')}`);
  if (missing.sections.length) parts.push(`正文小节${missing.sections.map(x => `「${x}」`).join('、')}`);
  return parts.length ? `任务说明缺少必填项：${basename(file)}：${parts.join('；')}（项目配置 specRequired）` : null;
}

// 一次读取同时用于派发统计、依赖和重叠判断。
export async function nextTasks({ root, home, env = process.env, all = false, readRuns = file => readFileSync(file, 'utf8'), clock = Date.now }) {
  root = resolve(root);
  const skills = checkSkills({ env, root, coreVersion: installedCoreVersion() });
  const skillFields = skills.ok ? {} : { skills };
  const state = readConfig(home);
  if (state.reason) throw new Error(state.reason);
  const info = effectiveConcurrency(home, slotLimits(state.config), { consumeWarning: true }), load = currentLoad({ memLowPercent: info.memLowPercent });
  const eventAge = clock() - info.concurrencyAdjust?.at;
  if (!Number.isFinite(eventAge) || eventAge < 0 || eventAge > 30 * 60 * 1000) info.concurrencyAdjust = null;
  const limit = info.limits.concurrency;
  let pauseReason = null;
  const availableLimit = await createTaskLimit({ home, readLimits: () => info, env, progress: line => { pauseReason = line; } })();
  const running = await liveHolders({ home, kind: 'task' });
  const slots = { limit, running, free: Math.max(0, availableLimit - running), mode: info.mode, estimate: info.estimate, cpu: load.cpu, freeMemGb: Number((load.freeMemBytes / 1024 ** 3).toFixed(1)), ...(pauseReason ? { pauseReason } : {}) };
  const project = readProject(root);
  const dir = resolve(root, typeof project.specsDir === 'string' && project.specsDir ? project.specsDir : 'docs/specs');
  const relativeDir = relative(root, dir);
  if (relativeDir === '..' || relativeDir.startsWith(`..${sep}`) || resolve(root, relativeDir) !== dir) throw new Error(`specsDir 必须在项目内：${project.specsDir}`);
  let names = [];
  try { names = readdirSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const head = headSha(root);
  if (!head) return { ok: true, project: root, slots, concurrencyAdjust: info.concurrencyAdjust, warnings: info.warnings, candidates: [], awaiting: [], noCommits: true, fullVerify: await nextVerifyStatus({ home, root, branch: null }), ...skillFields, ...(all ? { all: true } : {}) };
  const branchResult = git(root, ['branch', '--show-current']);
  if (branchResult.status !== 0) throw new Error(`读取当前分支失败：${branchResult.stderr.trim()}`);
  const branch = branchResult.stdout.trim();
  const titles = git(root, ['log', 'HEAD', '--format=%s']);
  if (titles.status !== 0) throw new Error(`读取合并记录失败：${titles.stderr.trim()}`);
  const merged = new Set(titles.stdout.split(/\r?\n/).map(title => /^\[\u6267\u884c\] \u5408\u5e76 (\d{3,}[a-z]?)-/.exec(title)?.[1]).filter(Boolean));
  let content = '';
  try { content = readRuns(join(home, 'runs.jsonl')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rows = content.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } });
  const dispatched = new Set(rows.filter(row => row?.event === 'start' && typeof row.repo === 'string' && repoKey(row.repo) === repoKey(root)).map(row => row.spec));
  const tasks = new Map();
  if (!content.endsWith('\n')) rows.pop();
  const accepted = rows.filter(row => row?.event === 'accepted' && typeof row.id === 'string' && typeof row.merge === 'string');
  if (accepted.length) {
    const ancestors = git(root, ['rev-list', head]);
    if (ancestors.status !== 0) throw new Error(`读取基线祖先失败：${ancestors.stderr.trim()}`);
    const reachable = new Set(ancestors.stdout.split(/\r?\n/));
    const acceptedIds = new Set(accepted.filter(row => reachable.has(row.merge)).map(row => row.id));
    for (const row of rows) {
      if (row?.event !== 'start' || !acceptedIds.has(row.id) || typeof row.repo !== 'string' || repoKey(row.repo) !== repoKey(root) || typeof row.spec !== 'string') continue;
      const id = /^(\d{3,}[a-z]?)-/.exec(basename(row.spec))?.[1];
      if (id) merged.add(id);
    }
  }
  for (const row of rows.reverse()) {
    if (!row || (row.v !== 1 && row.v !== 2) || typeof row.id !== 'string') continue;
    let task = tasks.get(row.id);
    if (!task) { task = { id: row.id, state: null, start: null, resume: null, running: false, reviewSeen: false, reviewVerdict: null, since: null }; tasks.set(row.id, task); }
    if (task.start) continue;
    if (row.event === 'review' && !task.reviewSeen) {
      task.reviewSeen = true;
      task.reviewVerdict = ['pass', 'concerns', 'fail'].includes(row.verdict) ? row.verdict : null;
    }
    if (task.state === null) {
      if (['accepted', 'rejected', 'interrupted'].includes(row.event)) task.state = 'ended';
      else if (row.event === 'conflict') { task.state = 'conflict'; task.since = row.at ?? null; }
      else if (row.event === 'end') { task.state = (row.exit ?? 1) === 0 ? 'awaiting' : 'ended'; task.since = row.at ?? null; }
      else if (row.event === 'start' || row.event === 'resume') task.state = 'active';
      else if (runningEvents.has(row.event)) task.running = true;
    }
    if (row.event === 'resume' && !task.resume) task.resume = row;
    if (row.event === 'start') task.start = row;
  }
  const awaiting = [...tasks.values()].filter(task => task.start && task.start.worktree === true && ['awaiting', 'conflict'].includes(task.state) && typeof task.start.repo === 'string' && repoKey(task.start.repo) === repoKey(root)).map(task => ({ name: task.start.name, state: task.state, reviewVerdict: task.reviewVerdict, since: task.since }));
  const blockers = [], now = Date.now();
  for (const task of tasks.values()) {
    const { start } = task;
    if (!start || !['active', 'awaiting'].includes(task.state) || start.worktree !== true || typeof start.repo !== 'string' || repoKey(start.repo) !== repoKey(root)) continue;
    if (task.state === 'active') {
      const at = task.running ? start.started : (task.resume?.at ?? start.started);
      if (!(at < now || (at === now && task.id < ''))) continue;
    }
    const scope = taskScope(start.dir ?? '');
    if (scope.readOnly) continue;
    if (task.state === 'active' && !(await taskAlive({ pid: task.resume?.pid ?? start.pid, started: task.resume?.at ?? start.started }))) continue;
    blockers.push({ name: start.name, patterns: scope.patterns, state: task.state });
  }
  let recent = null;
  if (!all) {
    const log = git(root, ['log', 'HEAD', '--since=14.days', '--name-only', '--format=', '-z', '--', relativeDir || '.']);
    if (log.status !== 0) throw new Error(`读取近期任务说明失败：${log.stderr.trim()}`);
    recent = new Set(log.stdout.split('\0').map(name => name.replace(/^\n+/, '')).filter(Boolean));
  }
  const listed = names.filter(file => file.endsWith('.md') && file !== 'README.md' && /^(\d{3,}[a-z]?)-/.test(file)).map(file => ({ id: /^(\d{3,}[a-z]?)-/.exec(file)[1], rel: relative(root, join(dir, file)).split(sep).join('/') })).filter(row => !merged.has(row.id) && !dispatched.has(row.rel) && (!recent || recent.has(row.rel))).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  const candidates = [], scopes = [];
  for (const row of listed) {
    let spec, parsed, text;
    try { text = readFileSync(join(root, row.rel), 'utf8'); } catch { continue; }
    const fallbackTitle = text.split(/\r?\n/).find(line => line.startsWith('# '))?.slice(2).trim() || basename(row.rel);
    try { parsed = parseSpec(text, row.rel); spec = validateSpec(parsed, row.rel); }
    catch (error) { candidates.push({ ...row, title: fallbackTitle, ready: false, blockedBy: [], overlapsWith: [], invalid: error.message }); continue; }
    const title = typeof spec.title === 'string' ? spec.title : fallbackTitle;
    const missing = missingReason(parsed, project.specRequired, row.rel);
    if (missing) { candidates.push({ ...row, title, ready: false, blockedBy: [], overlapsWith: [], missing }); continue; }
    const patterns = mergeSpec(spec, project).allowed_paths;
    const readOnly = needsReadOnly(spec);
    const overlapsWith = readOnly ? [] : [...new Set(blockers.filter(item => pathsOverlap(patterns, item.patterns)).sort((a, b) => (a.state === 'active' ? 0 : 1) - (b.state === 'active' ? 0 : 1)).map(item => item.name))];
    if (!readOnly) for (const previous of scopes) if (!previous.readOnly && pathsOverlap(patterns, previous.patterns)) overlapsWith.push(`${previous.id}（候选）`);
    scopes.push({ id: row.id, patterns, readOnly });
    const blockedBy = (spec.depends ?? []).filter(id => !merged.has(id));
    candidates.push({ id: row.id, rel: row.rel, title, ready: !blockedBy.length && !overlapsWith.length, blockedBy, overlapsWith });
  }
  return { ok: true, project: root, slots, concurrencyAdjust: info.concurrencyAdjust, warnings: info.warnings, candidates, awaiting, branch, fullVerify: await nextVerifyStatus({ home, root, branch }), ...skillFields, ...(all ? { all: true } : {}) };
}

export function nextVerifyLine(s) {
  if (s.running) return `全量验收：正在运行（日志 ${s.running}）`;
  const tail = s.mergedSince >= s.every ? '；建议 ar verify --detach' : '';
  return s.last && s.passed ? `全量验收：上次 ${dateText(s.last.at)} ${s.last.ok ? '通过' : '失败'}（${s.last.head.slice(0, 7)}）；自上次通过以来已合入 ${s.mergedSince} 个任务${tail}` : `全量验收：还没有通过的全量验收，已合入 ${s.mergedSince} 个任务${tail}`;
}

export function nextLines({ slots, candidates, awaiting = [], all = false, noCommits = false, branch = null, skills, fullVerify, concurrencyAdjust, warnings = [] }) {
  // 第一行写明基线（296 审查 R2-3）。
  const lines = [...(branch ? [`基线：${branch}`] : []), `名额：运行 ${slots.running} / 上限 ${slots.limit}（${slots.mode === 'auto' ? '自动档' : '固定档'}，CPU ${slots.cpu ?? '?'}%，可用内存 ${slots.freeMemGb.toFixed(1)} GB）`];
  if (concurrencyAdjust) lines.push(concurrencyAdjustLine(concurrencyAdjust));
  lines.push(...warnings);
  if (skills && !skills.ok) lines.push(`技能需要更新：${skills.issues.map(issue => issue.text).join('；')}（ar lead brief 看详情）`);
  if (!all) lines.push('只列最近 14 天提交的说明（--all 看全部）');
  if (!slots.free) lines.push(slots.pauseReason ? `${slots.pauseReason.replace(/^排队：/, '')}，先等` : '名额已满，先等任务结束');
  if (noCommits) return [...lines, '仓库还没有提交', ...(fullVerify ? [nextVerifyLine(fullVerify)] : [])];
  if (awaiting.length) lines.push(`待验收（${awaiting.length}）：`, ...awaiting.map(task => `  ${task.name}：${task.state === 'conflict' ? '冲突，需要 ar retry --rebase' : `审查 ${task.reviewVerdict ?? '无'}`}`));
  if (!candidates.length) return [...lines, '没有未派发的任务说明', ...(fullVerify ? [nextVerifyLine(fullVerify)] : [])];
  const groups = [ ['可以派发', candidates.filter(c => c.ready), c => `${c.id} ${c.title}`], ['等依赖', candidates.filter(c => c.blockedBy.length), c => `${c.id} ${c.title}：等 ${c.blockedBy.join('、')} 合入`], ['范围重叠', candidates.filter(c => c.overlapsWith.length), c => `${c.id} ${c.title}：和 ${c.overlapsWith.join('、')} 重叠`], ['缺必填项', candidates.filter(c => c.missing), c => `${c.id} ${c.title}：${c.missing}`], ['说明无效', candidates.filter(c => c.invalid), c => `${c.id} ${c.title}：${c.invalid}`] ];
  for (const [label, items, format] of groups) if (items.length) lines.push(`${label}（${items.length}）：`, ...items.map(c => `  ${format(c)}`));
  if (fullVerify) lines.push(nextVerifyLine(fullVerify));
  return lines;
}

// wait 提示在独立线程中计算，同步操作也受时限约束。
export function nextWithTimeout(options, timeoutMs = 3000) {
  return new Promise(resolve => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { nextSuggestion: true, options } });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate(); resolve(value); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    worker.once('message', finish);
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
  });
}

if (!isMainThread && workerData?.nextSuggestion) {
  Promise.all([nextTasks(workerData.options), sampleResources()]).then(([result, resources]) => parentPort.postMessage({ ...result, resources }), () => parentPort.postMessage(null));
}
