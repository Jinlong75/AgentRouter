// 链路报告与评分：ar report。零依赖，只读（归因标记 marks.json 除外）。
// 每个用任务说明派发的任务结束后，按执行者与主导各算一组指标和一个 0～100 的分数：按事件扣分，性能只列出、不进分数。
// git 调用一律走 git.mjs（参数数组、shell: false）。
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configInvalid, leadUsageSetting, priceTable, readConfig, reportWeights, userDirectory } from './config.mjs';
import { git } from './git.mjs';
import { readJson } from './json.mjs';
import { readNeedsScope } from './needs-scope.mjs';
import { readOutsideWrites } from './outside-writes.mjs';
import { revertedOf, taskState } from './status.mjs';
import { locateStart, reverseRows } from './wait.mjs';

export const notSpecTask = '这个任务不是用任务说明派发的，没有评分';
export const stillRunning = '任务还在进行，结束后才有评分';
const noWorktreeNote = '不用 worktree，没有验收';
const notYetAccepted = '还没验收';
const inProgressStates = ['queued', 'preparing', 'running', 'gating'];
const sha = /^[0-9a-f]{40,64}$/;

// 文字输出里每一项的名称与计数单位（key 同 config.json 的 reportWeights）。
const labels = {
  executor: {
    attemptGate: ['多一次尝试：门禁未通过', '次'], attemptAgent: ['多一次尝试：执行者异常退出', '次'], outsideFile: ['越界文件', '个'],
    protectedFile: ['动了受保护的路径', '个'], outsideWrites: ['工作区外写入', '次'], escalated: ['升级了执行者', '次'],
    toolError: ['工具报错', '个'], needsScope: ['写了"需要越界"', '次'], envBlame: ['环境原因', '次'],
  },
  lead: {
    specEdit: ['派发后改任务说明', '次'], specBlame: ['门禁失败归因到任务说明', '次'], manualRetry: ['手动重试', '次'],
    needsScope: ['执行者写了"需要越界"', '次'], rejected: ['驳回', '次'], conflict: ['合并时冲突', '次'], envBlame: ['环境原因', '次'],
  },
};

const blameValues = ['spec', 'worker', 'environment'];
const envCount = blamed => [...blamed.values()].filter(who => who === 'environment').length;

// 纯函数：按扣分表给一组指标打分。items: [{ key, count, detail }]；weights: { <key>: { points, max } }；cap: 分数上限或 null。
// 每项扣 count × points，最多扣 max（max 为 null 不封顶）；总分 100 起扣，最低 0，再不超过 cap。
export function scoreRole(items, weights, cap = null) {
  let deducted = 0;
  const scored = items.map(item => {
    const weight = weights[item.key] ?? { points: 0, max: null };
    const raw = item.count * weight.points;
    const points = weight.max == null ? raw : Math.min(raw, weight.max);
    deducted += points;
    return { key: item.key, count: item.count, points: points === 0 ? 0 : -points, detail: item.detail ?? null };
  });
  let score = Math.max(0, 100 - deducted);
  if (cap != null) score = Math.min(score, cap);
  return { score, items: scored };
}

const homesOf = home => [home].flat();
const first5 = list => list.slice(0, 5).join('、');
const sum = (values) => values.reduce((total, value) => total + value, 0);

// 定位任务并检查能不能出报告。返回 { file, start（清单里第一条 start，不受手动重试影响）, resumed（带最近一次 resume 的 start）, rows（按时间顺序）, state }。
function loadTask({ homes, root, name }) {
  const found = locateStart(homes, root, name);
  if (!found) throw new Error(`报告：在当前仓库找不到记录 ${name}`);
  const state = taskState(found.file, found.start);
  if (inProgressStates.includes(state)) throw new Error(stillRunning);
  if (typeof found.start.gate !== 'boolean') throw new Error(notSpecTask);
  const rows = [];
  for (const row of reverseRows(found.file)) if (row.id === found.start.id) rows.push(row);
  rows.reverse();
  const start = rows.find(row => row.event === 'start') ?? found.start;
  return { ...found, start, rows, state };
}

function recordDir(start) {
  return typeof start.dir === 'string' && start.dir ? start.dir : path.join(start.repo, '.agent-runs', start.name);
}

const marksFile = start => path.join(recordDir(start), 'marks.json');

// 归因标记：{ v: 1, blame: { "<n>": "spec" | "environment" } }。读不了、格式不对、未知值都当作没有。返回 Map<尝试编号, 'spec' | 'environment'>。
function readMarks(start) {
  try {
    const value = readJson(marksFile(start));
    const blamed = new Map();
    if (value && typeof value.blame === 'object' && value.blame && !Array.isArray(value.blame)) {
      for (const [key, who] of Object.entries(value.blame)) if ((who === 'spec' || who === 'environment') && /^[1-9]\d*$/.test(key)) blamed.set(Number(key), who);
    }
    return blamed;
  } catch { return new Map(); }
}

function readGateFile(file) {
  try {
    const value = readJson(file);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// 清单里的尝试：attempt 事件加对应的 attempt-end；Stage04 及更早的任务没有 attempt 事件，按一次尝试合成。
function readAttempts({ start, rows, dir, blamed }) {
  const ends = new Map();
  for (const row of rows) if (row.event === 'attempt-end' && Number.isSafeInteger(row.n)) ends.set(row.n, row);
  let list = rows.filter(row => row.event === 'attempt' && Number.isSafeInteger(row.n)).map(row => ({ n: row.n, reason: row.reason ?? null, profile: row.profile ?? start.profile ?? null, end: ends.get(row.n) ?? null }));
  let legacy = false;
  if (!list.length) {
    const end = rows.findLast(row => row.event === 'end');
    if (!end) return [];
    const gate = rows.findLast(row => row.event === 'gate');
    legacy = true;
    list = [{
      n: 1, reason: 'first', profile: start.profile ?? null,
      end: { exit: end.agentExit ?? end.exit ?? null, gate: gate ? gate.ok === true : null, usage: null, ms: Number.isFinite(end.minutes) ? Math.round(end.minutes * 60000) : null, needsScope: end.needsScope },
    }];
  }
  return list.map(item => {
    const gateFile = readGateFile(path.join(dir, 'attempts', String(item.n), 'gate.json')) ?? (legacy ? readGateFile(path.join(dir, 'gate.json')) : null);
    const gate = item.end && typeof item.end.gate === 'boolean' ? item.end.gate : null;
    return {
      ...item, gate, gateFile,
      summary: typeof gateFile?.summary === 'string' ? gateFile.summary : null,
      blame: gate === false ? (blamed.get(item.n) ?? 'worker') : null,
    };
  });
}

// events.jsonl：统计工具调用与出错。读不了按没有。
function readEventCounts(start, dir) {
  const counts = { toolCalls: 0, toolErrors: 0 };
  let text = '';
  try { text = readFileSync(typeof start.events === 'string' && start.events ? start.events : path.join(dir, 'events.jsonl'), 'utf8'); } catch { return counts; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    if (event.kind === 'tool') counts.toolCalls += 1;
    else if (event.kind === 'error') counts.toolErrors += 1;
    else if (event.kind === 'cmd') {
      if (event.phase === 'start') counts.toolCalls += 1;
      else if (event.phase === 'end' && event.exit != null && event.exit !== 0) counts.toolErrors += 1;
    }
  }
  return counts;
}

function executorItems({ attempts, counts, blamed }) {
  const byReason = reason => attempts.filter(item => item.reason === reason);
  // 第 n 次被归因到任务说明或环境时，第 n+1 次（reason: gate）不算执行者的。
  const relieved = byReason('gate').filter(item => blamed.has(item.n - 1)).length;
  const outside = new Set(), protectedPaths = new Set(), added = [];
  const listed = [];
  for (const item of attempts) {
    // 被归因到任务说明或环境的那次尝试，越界、受保护路径、工作区外写入都不算执行者的。
    if (!blamed.has(item.n)) {
      const scope = item.gateFile?.scope;
      for (const file of Array.isArray(scope?.outside) ? scope.outside : []) if (typeof file === 'string') outside.add(file);
      for (const file of Array.isArray(scope?.protected) ? scope.protected : []) if (typeof file === 'string') protectedPaths.add(file);
      for (const source of [readOutsideWrites(item.gateFile?.outsideWrites), readOutsideWrites(item.end?.outsideWrites)]) {
        for (const entry of source?.added ?? []) if (!added.some(other => other.root === entry.root && other.name === entry.name)) added.push(entry);
      }
    }
    const scopeList = readNeedsScope(item.end?.needsScope);
    if (scopeList) listed.push({ n: item.n, list: scopeList });
  }
  for (const file of protectedPaths) outside.delete(file);
  const retried = byReason('gate').concat(byReason('agent'));
  const firstProfile = attempts[0]?.profile ?? null;
  const switched = retried.filter(item => item.profile !== firstProfile);
  const needsScopePaths = [...new Set(listed.flatMap(item => item.list.map(entry => entry.path)))];
  return [
    { key: 'attemptGate', count: Math.max(0, byReason('gate').length - relieved), detail: null },
    { key: 'attemptAgent', count: byReason('agent').length, detail: null },
    { key: 'outsideFile', count: outside.size, detail: outside.size ? first5([...outside]) : null },
    { key: 'protectedFile', count: protectedPaths.size, detail: protectedPaths.size ? first5([...protectedPaths]) : null },
    { key: 'outsideWrites', count: added.length ? 1 : 0, detail: added.length ? first5(added.map(entry => `${entry.root}/${entry.name}`)) : null },
    { key: 'escalated', count: switched.length ? 1 : 0, detail: switched.length ? `${firstProfile} → ${switched[0].profile}` : null },
    { key: 'toolError', count: counts.toolErrors, detail: null },
    { key: 'needsScope', count: listed.length, detail: needsScopePaths.length ? first5(needsScopePaths) : null },
    { key: 'envBlame', count: envCount(blamed), detail: null },
  ];
}

// 派发后任务说明文件的提交数（只算提交时间早于任务结束的）。返回 { count, detail }。
function specEdits({ root, start, rows, endAt }) {
  if (typeof start.spec !== 'string' || !start.spec) return { count: 0, detail: null };
  if (typeof start.base !== 'string' || !sha.test(start.base)) return { count: 0, detail: '任务开始时没有记录基线，没能统计' };
  let ref = 'HEAD';
  if (start.worktree === true) {
    const accepted = rows.findLast(row => row.event === 'accepted');
    if (accepted && typeof accepted.merge === 'string' && sha.test(accepted.merge)) ref = `${accepted.merge}^1`;
    else {
      let baseBranch = null;
      try { baseBranch = readJson(path.join(root, '.agent-router', 'project.json')).baseBranch; } catch { /* 读不到就用当前分支。 */ }
      if (typeof baseBranch === 'string' && baseBranch.trim() && !baseBranch.startsWith('-')) ref = baseBranch.trim();
    }
  }
  const result = git(root, ['--literal-pathspecs', 'rev-list', '--timestamp', `${start.base}..${ref}`, '--', start.spec]);
  if (result.status !== 0) return { count: 0, detail: '没能读取 git 记录，没能统计' };
  const count = result.stdout.split('\n').filter(line => {
    const stamp = Number(line.split(' ')[0]);
    return line.trim() !== '' && Number.isFinite(stamp) && stamp * 1000 < endAt;
  }).length;
  return { count, detail: null };
}

function leadItems({ start, rows, attempts, blamed, state, root, endAt }) {
  const edits = specEdits({ root, start, rows, endAt });
  const plain = start.worktree !== true;
  const pending = state === 'awaiting' || state === 'conflict';
  const reverted = state === 'accepted' ? revertedOf([...rows].reverse()) : null;
  return [
    { key: 'specEdit', count: edits.count, detail: edits.detail },
    { key: 'specBlame', count: [...blamed.values()].filter(who => who === 'spec').length, detail: null },
    { key: 'manualRetry', count: attempts.filter(item => item.reason === 'manual').length, detail: null },
    { key: 'needsScope', count: attempts.some(item => readNeedsScope(item.end?.needsScope)) ? 1 : 0, detail: null },
    // 撤销合并不改分，只在这一项的说明里注明（129）。
    { key: 'rejected', count: plain ? 0 : rows.some(row => row.event === 'rejected') ? 1 : 0, detail: plain ? noWorktreeNote : pending ? notYetAccepted : reverted ? `已撤销（提交 ${reverted.commit.slice(0, 7)}）` : null },
    { key: 'conflict', count: plain ? 0 : rows.some(row => row.event === 'conflict') ? 1 : 0, detail: plain ? noWorktreeNote : null },
    { key: 'envBlame', count: envCount(blamed), detail: null },
  ];
}

// 读 Claude Code 的会话记录，把时间在 [from, to] 里的消息的 token 数字相加。
// 只取数字，不复制、不返回、不打印任何会话内容；读不到（没有会话 ID、找不到文件、读失败）返回 unavailable，不抛出。
export function leadUsage({ env = process.env, session, from = -Infinity, to = Infinity } = {}) {
  const unavailable = { state: 'unavailable', usage: null };
  if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(session)) return unavailable;
  try {
    const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(userDirectory(env), '.claude'), 'projects');
    let file = null;
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projects, entry.name, `${session}.jsonl`);
      if (existsSync(candidate)) { file = candidate; break; }
    }
    if (!file) return unavailable;
    // 同一条回复会按内容块分成多行记录，每行带同样的用量：按消息 ID 去重（同一个 ID 取各字段的最大值）。
    const byMessage = new Map();
    let anonymous = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const at = Date.parse(record?.timestamp);
      const usage = record?.message?.usage;
      if (!Number.isFinite(at) || at < from || at > to || !usage || typeof usage !== 'object') continue;
      const key = typeof record.message.id === 'string' && record.message.id ? record.message.id : `#${anonymous++}`;
      const previous = byMessage.get(key) ?? { input: 0, output: 0 };
      const number = value => (Number.isFinite(value) && value >= 0 ? value : 0);
      byMessage.set(key, { input: Math.max(previous.input, number(usage.input_tokens)), output: Math.max(previous.output, number(usage.output_tokens)) });
    }
    const values = [...byMessage.values()];
    return { state: 'ok', usage: { input: sum(values.map(item => item.input)), output: sum(values.map(item => item.output)) } };
  } catch { return unavailable; }
}

// 执行者的用量与估算费用。cost 为 null 的情况：有一次缺价格、缺用量，或币种不一致。
function executorPerf({ attempts, counts, start, prices }) {
  const ran = attempts.filter(item => item.reason !== 'rebase');
  const finished = attempts.filter(item => item.end);
  const total = field => {
    const values = finished.map(item => item.end.usage?.[field]).filter(value => Number.isFinite(value));
    return values.length ? sum(values) : null;
  };
  const input = total('input'), output = total('output');
  let cost = null;
  if (ran.length) {
    let amount = 0, currency = null, ok = true;
    for (const item of ran) {
      const price = prices[item.profile];
      const usage = item.end?.usage;
      if (!price || !usage || !Number.isFinite(usage.input) || !Number.isFinite(usage.output) || (currency && currency !== price.currency)) { ok = false; break; }
      currency = price.currency;
      amount += usage.input / 1e6 * price.input + usage.output / 1e6 * price.output;
    }
    if (ok) cost = { amount: Math.round(amount * 1e6) / 1e6, currency };
  }
  const profiles = [...new Set(ran.map(item => item.profile).filter(Boolean))];
  return {
    ms: finished.length ? sum(finished.map(item => (Number.isFinite(item.end.ms) ? item.end.ms : 0))) : 0,
    usage: input === null && output === null ? null : { input, output },
    cost, toolCalls: counts.toolCalls, profiles: profiles.length ? profiles : [start.profile].filter(Boolean),
  };
}

// 只读：返回报告对象。home 可以是公共目录，也可以是 [新目录, 旧目录]。任务还在进行、不是用任务说明派发的任务抛出中文原因（退出码 2）。
export function buildReport({ home, root, name, env = process.env }) {
  const homes = homesOf(home);
  const state = readConfig(homes[0]);
  if (state.reason) throw configInvalid(state, '这次没有生成报告');
  const task = loadTask({ homes, root, name });
  const { start, rows, state: taskStateName } = task;
  const dir = recordDir(start);
  const weightSetting = reportWeights(state.config), priceSetting = priceTable(state.config), usageSetting = leadUsageSetting(state.config);
  const { weights } = weightSetting;

  const marks = readMarks(start);
  const attempts = readAttempts({ start, rows, dir, blamed: marks });
  // 只有门禁没通过的尝试才能被归因；标记里多出来的编号不算。
  const blamed = new Map(attempts.filter(item => item.blame === 'spec' || item.blame === 'environment').map(item => [item.n, item.blame]));
  const counts = readEventCounts(start, dir);

  const startedAt = Number.isFinite(start.started) ? start.started : Number.isFinite(start.at) ? start.at : null;
  const ends = rows.filter(row => row.event === 'end' && Number.isFinite(row.at));
  const lastEnd = ends.at(-1) ?? null;
  const finishedAt = [...ends, ...rows.filter(row => ['accepted', 'rejected', 'interrupted'].includes(row.event) && Number.isFinite(row.at))].reduce((max, row) => Math.max(max, row.at), -Infinity);
  const endAt = Number.isFinite(finishedAt) ? finishedAt : Infinity;

  const cap = taskStateName === 'failed' ? 'failed' : taskStateName === 'rejected' ? 'rejected' : null;
  const executor = scoreRole(executorItems({ attempts, counts, blamed }), weights.executor, cap === 'failed' ? weights.capFailed : cap === 'rejected' ? weights.capRejected : null);
  const lead = scoreRole(leadItems({ start, rows, attempts, blamed, state: taskStateName, root, endAt }), weights.lead);

  // 主导：用时、等待验收的时间、可选的 token。
  const verdict = rows.findLast(row => row.event === 'accepted' || row.event === 'rejected');
  const entered = verdict ? rows.slice(0, rows.lastIndexOf(verdict)).findLast(row => row.event === 'end') : null;
  const awaitMs = start.worktree === true && verdict && entered && Number.isFinite(verdict.at) && Number.isFinite(entered.at) ? verdict.at - entered.at : null;
  let usage = null, usageState = 'off';
  if (usageSetting.enabled) {
    const read = leadUsage({ env, session: start.dispatcher?.session, from: startedAt ?? -Infinity, to: Number.isFinite(lastEnd?.at) ? lastEnd.at : endAt });
    usage = read.usage; usageState = read.state;
  }

  const warnings = [...weightSetting.warnings, ...priceSetting.warnings, ...usageSetting.warnings];
  return {
    ok: true, id: start.id, name: start.name, state: taskStateName,
    executor: { score: executor.score, cap, items: executor.items, perf: executorPerf({ attempts, counts, start, prices: priceSetting.prices }) },
    lead: { score: lead.score, items: lead.items, perf: { ms: startedAt !== null && lastEnd && Number.isFinite(lastEnd.at) ? lastEnd.at - startedAt : null, awaitMs, usage, usageState } },
    attempts: attempts.map(item => ({ n: item.n, reason: item.reason, profile: item.profile, exit: Number.isFinite(item.end?.exit) ? item.end.exit : null, gate: item.gate, summary: item.summary, blame: item.blame })),
    weights,
    ...(warnings.length ? { warnings } : {}),
  };
}

// 归因（只对门禁没通过的尝试）：写 <记录目录>/marks.json。worker 是默认，写 worker 时删掉这个键。先写临时文件再改名。
export function setBlame({ home, root, name, n, blame }) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`尝试编号必须是正整数：${n}`);
  if (!blameValues.includes(blame)) throw new Error(`归因只能是 spec、worker 或 environment：${blame}`);
  const { start, rows } = loadTask({ homes: homesOf(home), root, name });
  const attempt = rows.findLast(row => row.event === 'attempt-end' && row.n === n);
  if (!attempt || attempt.gate !== false) throw new Error(`第 ${n} 次尝试的门禁没有失败，不能归因（只有门禁未通过的尝试才能归因）`);
  const blamed = readMarks(start);
  if (blame === 'worker') blamed.delete(n); else blamed.set(n, blame);
  const file = marksFile(start);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ v: 1, blame: Object.fromEntries([...blamed].sort((a, b) => a[0] - b[0]).map(([key, who]) => [String(key), who])) })}\n`, { flag: 'w' });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
  return { ok: true, n, blame };
}

const durationText = ms => (ms < 60000 ? `${(ms / 1000).toFixed(1)} 秒` : `${(ms / 60000).toFixed(1)} 分钟`);
const tokenText = usage => `token 输入 ${usage.input ?? '—'}、输出 ${usage.output ?? '—'}`;

// 不加 --json 时给人看的文字：两节，每节一行"<角色> <分数>/100"、每项一行、一行性能。
export function reportLines(report) {
  const lines = [...(report.warnings ?? [])];
  const section = (title, role, kind, extra) => {
    lines.push(`${title} ${role.score}/100`);
    for (const item of role.items) {
      const [label, unit] = labels[kind][item.key];
      const detail = item.count > 0 ? `${item.count} ${unit}${item.detail ? `：${item.detail}` : ''}` : item.detail ?? `0 ${unit}`;
      lines.push(`  ${label}：${detail}（${item.points ? `−${-item.points}` : '0'}）`);
    }
    if (role.cap) lines.push(`  封顶：${role.cap === 'failed' ? '任务最终失败' : '任务被驳回'}，分数最高 ${role.cap === 'failed' ? report.weights.capFailed : report.weights.capRejected}`);
    lines.push(`  性能：${extra.join('；')}`);
  };
  const exec = report.executor.perf, lead = report.lead.perf;
  section('执行者', report.executor, 'executor', [
    `用时 ${durationText(exec.ms)}`,
    exec.usage ? tokenText(exec.usage) : 'token 没有记录',
    exec.cost ? `估算费用 ${exec.cost.amount} ${exec.cost.currency}` : '估算费用算不出（没有设置价格，或缺少用量）',
    `工具调用 ${exec.toolCalls} 次`,
    `执行者 ${exec.profiles.join('、')}`,
  ]);
  section('主导', report.lead, 'lead', [
    lead.ms === null ? '用时 未知' : `用时 ${durationText(lead.ms)}`,
    ...(lead.awaitMs === null ? [] : [`等待验收 ${durationText(lead.awaitMs)}`]),
    lead.usageState === 'off' ? 'token 没有读取（config.json 的 leadUsage 为 false）' : lead.usage ? tokenText(lead.usage) : 'token 读取不到会话记录',
  ]);
  return lines;
}
