// 任务状态查询（协议 15.11）：ar status <记录名>。只读清单，不等待、不碰进程。零依赖。
import { join, resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { readJson } from './json.mjs';
import { activeLimits, clockText } from './limits-state.mjs';
import { parseNeedsScope, readNeedsScope } from './needs-scope.mjs';
import { readOutsideWrites } from './outside-writes.mjs';
import { findTerminal, locateStart, reverseRows, worktreeOutcome } from './wait.mjs';

// worktree 任务的十种状态（协议 15.3）与非 worktree 任务的四种状态。
export const worktreeStates = ['queued', 'preparing', 'running', 'gating', 'awaiting', 'conflict', 'accepted', 'rejected', 'failed', 'stopped'];
export const plainStates = ['running', 'done', 'failed', 'stopped'];

// 这个任务的基线分支（Stage07c 136）：派发时用 --base 指定的记在 start 事件 / dispatch.json 的 baseBranch 里，
// 没有就是项目配置的 baseBranch（projectBaseBranch）。门禁基线、--rebase、批准合并、撤销、链路报告都从这里取。
export function taskBaseBranch(record, projectBaseBranch) {
  return typeof record?.baseBranch === 'string' && record.baseBranch.trim() !== '' ? record.baseBranch : projectBaseBranch;
}

// 这个任务的全部清单行，最新的在前。
function taskRows(file, id) {
  const rows = [];
  for (const row of reverseRows(file)) if (row.id === id) rows.push(row);
  return rows;
}

// 最近一条 start / resume 之后的行（最新的在前，不含这条）。
function sinceLastStart(rows) {
  const at = rows.findIndex(row => row.event === 'start' || row.event === 'resume');
  return at < 0 ? rows : rows.slice(0, at);
}

// 还没结束的 worktree 任务（协议 15.3）：看最近一条与进度有关的事件。
// 只有 start、或最后是 queued → queued；准备阶段的事件 → preparing；attempt 之后 running，gating 之后 gating，gate 写完回到 running。
function inProgressState(recent) {
  for (const row of recent) {
    if (row.event === 'gating') return 'gating';
    if (['attempt', 'spawned', 'gate', 'attempt-end', 'reviewing', 'review', 'review-needs-human'].includes(row.event)) return 'running';
    if (['preparing', 'worktree', 'setup'].includes(row.event)) return 'preparing';
    if (row.event === 'queued') return 'queued';
  }
  return 'queued';
}

// 审查结果的摘要（Stage08 T3）：{ verdict, reviewer, crossed, issues, high, needsHuman }；review 不是审查结果对象时返回 null。
export function reviewBrief(review) {
  if (review === null || typeof review !== 'object' || typeof review.verdict !== 'string') return null;
  const issues = Array.isArray(review.issues) ? review.issues : [];
  return {
    verdict: review.verdict, reviewer: typeof review.reviewer === 'string' ? review.reviewer : null, crossed: review.crossed === true,
    issues: issues.length, high: issues.filter(issue => issue?.severity === 'high').length, needsHuman: review.needsHuman === true,
  };
}
export const reviewLine = brief => `审查：${brief.verdict}（${brief.reviewer ?? '无'}，${brief.issues} 个问题，其中高 ${brief.high}）`;

// 任务目录里的顶层 review.json 的摘要；没有、读不了、不是审查结果都返回 null。
function readReviewBrief(dir) {
  if (typeof dir !== 'string' || dir === '') return null;
  try { return reviewBrief(readJson(join(dir, 'review.json'))); } catch { return null; }
}

// TODO(lead) 按全文字面出现次数计数；推断清单也认汇报模板的编号项及其子项，
// 越界节标题复用协议 14.5 的解析器；两节按列表项计数，
// “无”表示零项，缺节、空节、重复节或无法辨认的正文记 null；代码块不作为标题或列表。
function reportBrief(text) {
  const sections = { 推断清单: [], 需要越界: [] };
  let current = null, level = 0, fence = null, numberedIndent = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^\s*(?:`+|~+)\s*$/.test(line)) fence = null;
      else if (current) current.invalid = true;
      continue;
    }
    if (marker) { fence = marker; if (current) current.invalid = true; continue; }
    const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (numberedIndent !== null || (current && heading[1].length <= level)) { current = null; numberedIndent = null; }
      const title = heading[2].replace(/^(?:\d+[.、)）]|[（(]\d+[)）])\s*/, '').replace(/[:：]$/, '').replace(/^\*\*(.*?)\*\*$/, '$1').replace(/[:：]$/, '').trim();
      const name = parseNeedsScope(`${line}\n- __status_probe__`).length ? '需要越界' : title === '推断清单' ? title : null;
      if (name && !current) {
        current = { name, count: 0, inline: 0, none: false, invalid: false, content: false };
        sections[name].push(current); level = heading[1].length;
      } else if (current) current.invalid = true;
      continue;
    }
    const numbered = /^(\s*)\d+[.)]\s+\*\*推断清单\*\*\s*[:：]\s*(.*)$/.exec(line);
    if (numbered && (!current || numberedIndent !== null)) {
      current = { name: '推断清单', count: 0, inline: 0, none: false, invalid: false, content: false };
      sections.推断清单.push(current); numberedIndent = numbered[1].length;
      // 同一行冒号后的文字：后面没有子条目时它就是唯一一条推断；后面有子条目时它只是引言（审查 R4-1）。
      if (numbered[2]) {
        if (/^(?:无|没有)[。.]?$/.test(numbered[2].trim())) current.none = current.content = true;
        else { current.inline = 1; current.content = true; }
      }
      continue;
    }
    if (numberedIndent !== null && new RegExp(`^\\s{0,${numberedIndent}}\\d+[.)]\\s+`).test(line)) {
      current = null; numberedIndent = null;
    }
    if (!current || !line.trim()) continue;
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(line);
    const content = (item?.[1] ?? line).trim();
    if (/^(?:无|没有)[。.]?$/.test(content)) { current.none = true; current.content = true; }
    else if (item) { current.count++; current.content = true; }
    // 需要越界节里的非列表行是说明，不算路径（协议 14.5，与 parseNeedsScope 一致，审查 R4-2）。
    else if (current.name !== '需要越界') current.invalid = true;
  }
  const count = name => {
    const entries = sections[name], section = entries[0];
    const total = section && (section.count || section.inline);
    return entries.length !== 1 || !section.content || section.invalid || (section.none && total) ? null : total;
  };
  // 需要越界：有这一节时直接用协议 14.5 的 parseNeedsScope 计数，节边界、下级标题、说明行都与它一致（审查 R5-1）；没有这一节为 null。
  const needsScope = sections.需要越界.length ? parseNeedsScope(text).length : null;
  return { todoLead: (text.match(/TODO\(lead\)/g) ?? []).length, inferences: count('推断清单'), needsScope };
}

function readReportBrief(dir) {
  if (typeof dir !== 'string' || dir === '') return null;
  try { return reportBrief(readFileSync(join(dir, 'report.md'), 'utf8')); } catch { return null; }
}

// 任务当前状态。不查进程：进程已经不在、清单里又没有结束记录的任务仍按进行中显示；ar wait 会把它当中断（协议 15.11）。
export function taskState(file, start, rows = taskRows(file, start.id)) {
  if (start.worktree === true) {
    return worktreeOutcome(file, start.id) ?? inProgressState(sinceLastStart(rows));
  }
  const terminal = findTerminal(file, start.id);
  if (!terminal) return 'running';
  if (terminal.event === 'interrupted') return 'stopped';
  return (terminal.exit ?? 1) === 0 ? 'done' : 'failed';
}

// ar status 的结果（协议 15.11）。找不到记录时抛出中文原因（退出码 2）。
export function taskStatus({ homes, root, name }) {
  const found = locateStart(homes, root, name);
  if (!found) throw new Error(`状态：在当前仓库找不到记录 ${name}`);
  const { file, start } = found;
  const rows = taskRows(file, start.id);
  const recent = sinceLastStart(rows);
  const latestLaunch = rows.find(row => row.event === 'start' || row.event === 'resume');
  const launch = latestLaunch?.launch ?? (latestLaunch?.managed === true ? 'managed' : 'unknown');
  const state = taskState(file, start, rows);
  const attempts = rows.reduce((max, row) => (row.event === 'attempt' && Number.isSafeInteger(row.n) ? Math.max(max, row.n) : max), 0)
    || rows.find(row => row.event === 'end')?.attempts || 0;
  const gate = rows.find(row => row.event === 'gate');
  const end = recent.find(row => row.event === 'end');
  const outside = readOutsideWrites(recent.find(row => row.event === 'attempt-end')?.outsideWrites);
  const worktree = start.worktree === true ? rows.find(row => row.event === 'worktree') : null;
  const conflict = state === 'conflict' ? rows.find(row => row.event === 'conflict') : null;
  const reverted = state === 'accepted' ? revertedOf(rows) : null;
  // model / effort 的来源（Stage07c T6、154）：新任务每次派发都记（旧任务没有）；手动重试的 resume 带了生效值与来源就以它为准。
  const resume = rows.find(row => row.event === 'resume' && Object.hasOwn(row, 'settingSources'));
  const layered = resume ?? start;
  const settingSources = layered.settingSources && typeof layered.settingSources === 'object' ? layered.settingSources : null;
  // 现在被限流的执行者（Stage07c T7，limits.json）：{ <名>: { kind, until, since } }；没有被限流的就没有这个字段，输出保持原样。
  let route = null;
  try { route = readJson(join(start.dir, 'dispatch.json'))?.route ?? null; } catch { /* 旧任务可能没有派发记录。 */ }
  const review = readReviewBrief(start.dir);
  const report = readReportBrief(start.dir);
  const limited = Object.fromEntries(Object.entries(activeLimits([homes].flat()[0])).map(([profile, entry]) => [profile, { kind: entry.kind, until: entry.until, since: entry.since }]));
  return {
    ok: true, id: start.id, name: start.name, state, attempts,
    ...(['queued', 'preparing', 'running', 'gating'].includes(state) ? { launch, started: start.started } : {}),
    ...(route?.rule?.scope === 'implicit' ? { route: { source: 'implicit', profile: route.profile } } : {}),
    gate: gate ? { ok: gate.ok === true, summary: gate.summary ?? null } : null,
    needsScope: end ? readNeedsScope(end.needsScope) : null,
    outsideWrites: outside?.added.length ? { added: outside.added } : null,
    worktree: worktree ? { dir: worktree.dir, branch: worktree.branch, base: worktree.base } : null,
    // 这次派发用 --base 指定了基线分支才有这个字段（136）。
    ...(taskBaseBranch(start, null) ? { baseBranch: taskBaseBranch(start, null) } : {}),
    merge: state === 'accepted' ? rows.find(row => row.event === 'accepted')?.merge ?? null : null,
    conflict: conflict ? { files: Array.isArray(conflict.files) ? conflict.files : [] } : null,
    // 撤销合并（129）：只在已撤销时才有这个字段，其余任务的 JSON 保持原样。
    ...(reverted ? { reverted } : {}),
    // 参数：生效的 model / effort 和各自的来源；记录里没有来源的旧任务没有这个字段。
    ...(settingSources ? { params: { model: layered.model ?? null, effort: layered.effort ?? null, sources: { model: settingSources.model ?? null, effort: settingSources.effort ?? null } } } : {}),
    ...(Object.keys(limited).length ? { limits: limited } : {}),
    // 审查结果（Stage08 T3）：只在有审查结果时才有这个字段，其余任务的 JSON 保持原样。
    ...(review ? { review } : {}),
    ...(report ? { report } : {}),
  };
}

// 已合并任务的撤销记录（rows 最新的在前）：accepted 之后的 reverted 事件，没有返回 null。
export function revertedOf(rows) {
  for (const row of rows) {
    if (row.event === 'accepted') return null;
    if (row.event === 'reverted' && typeof row.commit === 'string') return { commit: row.commit, at: Number.isFinite(row.at) ? row.at : null, by: row.by ?? 'cli' };
  }
  return null;
}

// 本地时间，年-月-日 时:分（不随系统语言变）。
const localStamp = ms => {
  const date = new Date(ms), two = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

// 不加 --json 时给人看的几行。
export function statusLines(status) {
  const lines = [`状态：${status.name}（${status.state}）`, `尝试次数：${status.attempts}`];
  if (status.launch) lines.push(`启动方式：${launchLabel(status.launch)}`);
  if (status.route?.source === 'implicit') lines.push(`路由：预设默认规则 → ${status.route.profile}`);
  if (status.gate) lines.push(status.gate.ok ? '门禁：通过' : `门禁：未通过（${status.gate.summary ?? '无说明'}）`);
  if (status.worktree) lines.push(`worktree：${status.worktree.dir}（分支 ${status.worktree.branch}）`);
  if (status.review) lines.push(reviewLine(status.review));
  // params 现在每个新任务都有（D81：每个值都记来源，--json 里总是有）；文字输出仍只在至少一项来自任务说明 / 路由规则时才多这一行（146 的规则）。
  if (status.params && ['model', 'effort'].some(key => ['任务说明', '路由规则'].includes(status.params.sources[key]))) {
    // 只给来自任务说明 / 路由规则的值加"（来自…）"，其余值照常显示、不加说明。
    const part = (label, key) => {
      const value = status.params[key];
      if (value == null) return null;
      const from = status.params.sources[key];
      return `${label} ${value}${from === '任务说明' || from === '路由规则' ? `（来自${from}）` : ''}`;
    };
    const parts = [part('模型', 'model'), part('推理强度', 'effort')].filter(Boolean);
    if (parts.length) lines.push(`参数：${parts.join('，')}`);
  }
  if (status.baseBranch) lines.push(`基线分支：${status.baseBranch}（这次派发指定）`);
  if (status.merge) lines.push(`合并提交：${status.merge}`);
  if (status.reverted) lines.push(`已撤销：提交 ${status.reverted.commit.slice(0, 7)}${status.reverted.at === null ? '' : `（${localStamp(status.reverted.at)}）`}`);
  if (status.conflict) lines.push(`冲突文件：${status.conflict.files.join('、')}`);
  if (status.needsScope) lines.push(`需要越界：${status.needsScope.map(item => item.path).join('、')}`);
  if (status.outsideWrites) lines.push(`工作区外新文件：${status.outsideWrites.added.map(item => item.name).join('、')}`);
  for (const [profile, entry] of Object.entries(status.limits ?? {})) lines.push(`${profile}：额度到 ${clockText(entry.until)} 恢复`);
  return lines;
}

export const launchLabel = launch => ({ managed: '托管', detached: '自行后台', foreground: '随当前会话', unknown: '未知' }[launch] ?? '未知');

// 与单任务状态共用记录定位和状态判断，兼容新旧公共目录。
export function sessionBoundTasks({ homes, root }) {
  const names = new Map();
  // 记录里的 repo 可能是 Windows 8.3 短路径（用户名被缩写成带 ~1 的形式），开工包的 root 来自 git 是长路径：先取真实路径再比较。
  const real = value => { try { return realpathSync.native(value); } catch { return resolve(value); } };
  const key = value => process.platform === 'win32' ? real(value).toLowerCase() : real(value);
  for (const home of new Set([homes].flat())) {
    for (const row of reverseRows(join(home, 'runs.jsonl'))) {
      if (row.event === 'start' && typeof row.repo === 'string' && key(row.repo) === key(root) && typeof row.name === 'string' && !names.has(row.name)) names.set(row.name, row.repo);
    }
  }
  // 用记录里原样的 repo 查状态（locateStart 按原路径比较）；单个任务读不到时跳过，开工包不能因此整体失败。
  return [...names].flatMap(([name, repo]) => { try { return [taskStatus({ homes, root: repo, name })]; } catch { return []; } })
    .filter(task => ['queued', 'preparing', 'running', 'gating'].includes(task.state) && task.launch !== 'managed');
}
