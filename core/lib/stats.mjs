import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { configInvalid, priceTable, readConfig, statsSourcesOf } from './config.mjs';
import { buildReport, readAttempts, readMarks } from './report.mjs';
import { latestReviewConfirms } from './review.mjs';
import { parseSpec } from './spec.mjs';
import { taskState } from './status.mjs';
import { reverseRows } from './wait.mjs';
import { readOutsideWrites } from './outside-writes.mjs';

const text = value => typeof value === 'string' && value ? value : null;
const num = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const median = values => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const i = Math.floor(values.length / 2);
  return values.length % 2 ? values[i] : (values[i - 1] + values[i]) / 2;
};
const ratio = (numerator, denominator) => {
  if (!denominator) return { numerator, denominator, value: null, wilson95: null };
  const z = 1.959963984540054, p = numerator / denominator, d = 1 + z * z / denominator;
  const center = (p + z * z / (2 * denominator)) / d;
  const margin = z * Math.sqrt(p * (1 - p) / denominator + z * z / (4 * denominator ** 2)) / d;
  return { numerator, denominator, value: p, wilson95: { low: Math.max(0, center - margin), high: Math.min(1, center + margin) } };
};
const key = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const localDate = time => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const sorted = (a, b) => a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

export function summarizeScoreItems(values) {
  const items = new Map();
  for (const value of values) for (const item of value.items ?? []) if (text(item.key) && num(item.count)) {
    const counts = items.get(item.key) ?? []; counts.push(item.count); items.set(item.key, counts);
  }
  return [...items].sort(([a], [b]) => sorted(a, b)).map(([key, counts]) => ({ key, count: counts.length, mean: counts.reduce((a, b) => a + b, 0) / counts.length }));
}

export function buildStats({ home, range = 'all', project = null, now = Date.now(), env = process.env }) {
  const homes = [...new Set([home].flat())];
  const from = range === 'all' ? null : now - (range === '7d' ? 7 : 30) * 86400000;
  const selected = project === null ? null : path.resolve(project);
  const config = readConfig(homes[0]);
  if (config.reason) throw configInvalid(config, '这次没有生成统计');
  // 额外的只读数据源（427）：公共目录在前，同一任务 id 以公共目录为准；只读，不往这些目录写任何东西。
  // 去重只针对额外来源：多个公共目录各自是独立注册表，同编号仍分别统计（沿用原有行为）。
  const primary = [...new Set(homes.map(directory => path.resolve(directory)))];
  const primarySet = new Set(primary);
  const extra = statsSourcesOf(config.config).map(directory => path.resolve(directory)).filter(directory => !primarySet.has(directory));
  const directories = [...new Set([...primary, ...extra])];
  const sources = [], skippedSources = [], seenIds = new Set();
  const prices = priceTable(config.config).prices;
  const tasks = [], projects = new Set();
  let legacyTasks = 0;
  for (const directory of directories) {
    let present = false;
    try { present = statSync(directory).isDirectory(); } catch { /* 不存在的目录跳过。 */ }
    const isExtra = !primarySet.has(directory);
    // 公共目录（含不存在的旧目录）不算"跳过的来源"：skippedSources 只列额外来源（427 审查 R2-1）。
    if (!present) { if (isExtra) skippedSources.push(directory); continue; }
    const file = path.join(directory, 'runs.jsonl'), byId = new Map();
    // 额外来源存在但没有 runs.jsonl：归入 skippedSources，不进 sources（427）。
    if (isExtra && !existsSync(file)) { skippedSources.push(directory); continue; }
    let readable = false;
    try {
      for (const row of reverseRows(file)) {
        if (typeof row.id !== 'string') continue;
        if (!byId.has(row.id)) byId.set(row.id, []);
        byId.get(row.id).push(row);
      }
      readable = true;
    } catch { /* 读不到 runs.jsonl 时按跳过处理。 */ }
    // 额外来源存在但读不到 runs.jsonl：同样归入 skippedSources，不进 sources。
    if (isExtra && !readable) { skippedSources.push(directory); continue; }
    sources.push(directory);
    if (!readable) continue;
    const names = new Map();
    for (const reversed of byId.values()) {
      const start = reversed.find(row => row.event === 'start');
      if (text(start?.repo) && text(start?.name)) {
        const id = JSON.stringify([key(start.repo), start.name]);
        names.set(id, (names.get(id) ?? 0) + 1);
      }
    }
    for (const reversed of byId.values()) {
      const rows = reversed.reverse(), start = rows.find(row => row.event === 'start');
      if (!start) continue;
      // 额外来源里与公共目录（或更早的额外来源）重复的任务 id 只算一次：公共目录在前，所以以公共目录为准。
      const duplicate = !primarySet.has(directory) && seenIds.has(start.id);
      seenIds.add(start.id);
      if (duplicate) continue;
      if (!num(start.started) || start.started > now || (from !== null && start.started < from)) continue;
      if (selected !== null && (typeof start.repo !== 'string' || key(start.repo) !== key(selected))) continue;
      if (start.v === 1) { legacyTasks++; continue; }
      if (start.v !== 2) continue;
      if (text(start.repo)) projects.add(path.resolve(start.repo));
      let type = null;
      try { type = text(parseSpec(readFileSync(path.resolve(start.repo, start.spec), 'utf8'), start.spec).meta.type); } catch { /* 无法读取历史说明。 */ }
      type ??= text(start.type);
      const dir = text(start.dir) ?? (text(start.repo) && text(start.name) ? path.join(start.repo, '.agent-runs', start.name) : null);
      const attempts = dir ? readAttempts({ start, rows, dir, blamed: readMarks(start) }) : [];
      const state = taskState(file, start, [...rows].reverse());
      tasks.push({ start, rows, attempts, state, type, dir, directory, unique: text(start.repo) && text(start.name) && names.get(JSON.stringify([key(start.repo), start.name])) === 1 });
    }
  }
  const groups = new Map();
  for (const task of tasks) {
    const dimensions = [text(task.start.profile), task.type, text(task.start.effort)];
    const id = JSON.stringify(dimensions);
    if (!groups.has(id)) groups.set(id, { dimensions, tasks: [] });
    groups.get(id).tasks.push(task);
  }
  const strata = [...groups.values()].sort((a, b) => a.dimensions.map((v, i) => sorted(v, b.dimensions[i])).find(v => v !== 0) ?? 0).map(group => {
    const done = group.tasks.filter(t => ['accepted', 'rejected', 'failed', 'stopped'].includes(t.state));
    const merged = done.flatMap(t => {
      const accepted = t.rows.findLast(r => r.event === 'accepted');
      return t.state === 'accepted' && text(accepted?.merge) ? [{ ...t, accepted }] : [];
    });
    const failures = { worker: 0, spec: 0, unknown: 0 };
    for (const t of done) for (const a of t.attempts) if (a.gate === false && a.blame !== 'environment') failures[a.blame === 'worker' || a.blame === 'spec' ? a.blame : 'unknown']++;
    const outside = done.map(t => t.attempts.filter(a => a.gateFile || readOutsideWrites(a.end?.outsideWrites))).filter(a => a.length);
    const hasOutside = attempts => attempts.some(a => (Array.isArray(a.gateFile?.scope?.outside) && a.gateFile.scope.outside.length) || (Array.isArray(a.gateFile?.scope?.protected) && a.gateFile.scope.protected.length) || readOutsideWrites(a.gateFile?.outsideWrites)?.added.length || readOutsideWrites(a.end?.outsideWrites)?.added.length);
    const profiles = done.map(t => t.attempts.filter(a => a.blame !== 'environment').map(a => text(a.profile))).filter(p => p.length && p.every(Boolean));
    const confirms = done.flatMap(t => [...latestReviewConfirms(t.rows).values()]);
    const attributed = confirms.filter(r => text(r.reviewer));
    const valid = confirms.filter(r => r.result === 'valid');
    const reviews = done.flatMap(t => t.rows.filter(r => r.event === 'review'));
    const durations = done.map(t => {
      const first = t.rows.find(r => r.event === 'attempt'), end = t.rows.findLast(r => r.event === 'end' && r.exit === 0);
      return num(first?.at) && num(end?.at) && end.at >= first.at ? end.at - first.at : null;
    }).filter(v => v !== null);
    const usage = field => {
      if (!merged.length || merged.some(t => !t.attempts.length || t.attempts.some(a => !num(a.end?.usage?.[field])))) return null;
      return merged.reduce((sum, t) => sum + t.attempts.reduce((n, a) => n + a.end.usage[field], 0), 0) / merged.length;
    };
    let cost = merged.length ? {} : null;
    for (const t of merged) {
      if (!t.attempts.length) { cost = null; break; }
      for (const a of t.attempts) {
        const price = prices[a.profile], u = a.end?.usage;
        if (!price || !num(u?.input) || !num(u?.output)) { cost = null; break; }
        cost[price.currency] = (cost[price.currency] ?? 0) + (u.input * price.input + u.output * price.output) / 1e6 / merged.length;
      }
      if (cost === null) break;
    }
    const nFailures = failures.worker + failures.spec + failures.unknown;
    const knownFirst = done.filter(t => typeof t.attempts[0]?.gate === 'boolean');
    return {
      profile: group.dimensions[0], type: group.dimensions[1], effort: group.dimensions[2], sampleSize: done.length, insufficient: done.length < 5,
      executor: {
        firstPass: knownFirst.length ? ratio(knownFirst.filter(t => t.attempts[0].gate === true && t.state === 'accepted').length, knownFirst.length) : null,
        avgAttempts: done.length && done.every(t => t.attempts.length) ? done.reduce((sum, t) => sum + t.attempts.length, 0) / done.length : null,
        gateFailures: failures, outsideRate: ratio(outside.filter(hasOutside).length, outside.length),
        escalationRate: ratio(profiles.filter(p => p.some(v => v !== p[0])).length, profiles.length), medianMs: median(durations),
        tokensPerMerged: { input: usage('input'), output: usage('output') }, costPerMerged: cost,
        validHighIssues: valid.filter(r => r.severity === 'high').length,
      },
      reviewer: { accuracy: ratio(attributed.filter(r => r.result === 'valid').length, attributed.length), failedReviewRate: ratio(reviews.filter(r => ['unknown', 'invalid'].includes(r.verdict)).length, reviews.length), validIssuesPerReview: reviews.length ? attributed.filter(r => r.result === 'valid').length / reviews.length : null },
      lead: { specGateFailureRate: ratio(failures.spec, nFailures), supplementCount: null, dispatchToMergeMedianMs: median(merged.map(t => num(t.accepted.at) && t.accepted.at >= t.start.started ? t.accepted.at - t.start.started : null).filter(v => v !== null)) },
    };
  });
  const scoreGroups = new Map(), scoreDaily = new Map(), reports = new Map();
  let skipped = 0;
  for (const task of tasks) {
    let report;
    try {
      if (!task.unique || !task.dir || !existsSync(task.dir) || !text(task.start.spec) || !['accepted', 'rejected', 'failed', 'stopped'].includes(task.state)) throw new Error('skip');
      report = buildReport({ home: task.directory, root: task.start.repo, name: task.start.name, env });
      if (report.id !== task.start.id) throw new Error('skip');
    } catch { skipped++; continue; }
    reports.set(task, report);
    for (const role of ['lead', 'executor', 'reviewer']) {
      const result = report[role];
      if (!result || !num(result.score)) continue;
      const dims = [role, text(task.start.profile), task.type, text(task.start.effort)];
      const date = localDate(task.start.started);
      for (const [map, dimensions] of [[scoreGroups, dims], [scoreDaily, [...dims, date]]]) {
        const id = JSON.stringify(dimensions);
        if (!map.has(id)) map.set(id, { dimensions, values: [] });
        map.get(id).values.push(result);
      }
    }
  }
  const summarize = map => [...map.values()].sort((a, b) => a.dimensions.map((v, i) => sorted(v, b.dimensions[i])).find(v => v !== 0) ?? 0).map(({ dimensions, values }) => {
    return { role: dimensions[0], profile: dimensions[1], type: dimensions[2], effort: dimensions[3], ...(dimensions.length > 4 ? { date: dimensions[4] } : {}), sampleSize: values.length, insufficient: values.length < 5, score: values.reduce((sum, v) => sum + v.score, 0) / values.length, items: summarizeScoreItems(values) };
  });
  const weeks = new Map(), durations = [];
  const humanInterventions = { manualRetry: 0, rejected: 0, needsHuman: 0, total: 0 };
  for (const task of tasks) {
    for (const row of task.rows) {
      if (row.event === 'attempt' && row.reason === 'manual') humanInterventions.manualRetry++;
      if (row.event === 'rejected') humanInterventions.rejected++;
      if (row.event === 'review-needs-human') humanInterventions.needsHuman++;
    }
    const accepted = task.rows.findLast(r => r.event === 'accepted');
    if (num(accepted?.at) && accepted.at >= task.start.started) durations.push(accepted.at - task.start.started);
    if (typeof accepted?.merge === 'string' && num(accepted.at)) {
      const d = new Date(accepted.at);
      d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
      const year = d.getUTCFullYear(), first = Date.UTC(year, 0, 1);
      const week = `${year}-W${String(Math.ceil(((d.getTime() - first) / 86400000 + 1) / 7)).padStart(2, '0')}`;
      weeks.set(week, (weeks.get(week) ?? 0) + 1);
    }
  }
  humanInterventions.total = humanInterventions.manualRetry + humanInterventions.rejected + humanInterventions.needsHuman;
  let leadTokens = 0, executorTokens = 0, complete = tasks.length > 0;
  for (const task of tasks) {
    const lead = reports.get(task)?.lead?.perf?.usage;
    const attempts = task.attempts.filter(a => a.reason !== 'rebase');
    if (!num(lead?.input) || !num(lead?.output) || !attempts.length || attempts.some(a => !num(a.end?.usage?.input) || !num(a.end?.usage?.output))) { complete = false; break; }
    leadTokens += lead.input + lead.output;
    executorTokens += attempts.reduce((sum, a) => sum + a.end.usage.input + a.end.usage.output, 0);
  }
  const taskCost = (task, cost = {}) => {
    const addCost = (profile, usage) => {
      const price = prices[profile];
      if (!price || !num(usage?.input) || !num(usage?.output)) return false;
      cost[price.currency] = (cost[price.currency] ?? 0) + (usage.input * price.input + usage.output * price.output) / 1e6;
      return true;
    };
    const attempts = task.attempts.filter(a => a.reason !== 'rebase');
    if (!attempts.length || attempts.some(a => !addCost(a.profile, a.end?.usage))) return null;
    const seen = new Set();
    for (const row of task.rows.filter(r => r.event === 'review')) {
      const run = Number.isSafeInteger(row.run) && row.run > 1 ? row.run : 1;
      const id = `${row.attempt}.${run}`;
      if (seen.has(id)) continue;
      seen.add(id);
      let review;
      try { review = JSON.parse(readFileSync(path.join(task.dir, 'attempts', String(row.attempt), run > 1 ? `review-${run}.json` : 'review.json'), 'utf8')); } catch { return null; }
      // 没有可用审查者时没有审查花费。
      if (Array.isArray(review?.tries) && review.tries.length === 0) continue;
      if (!Array.isArray(review?.tries) || review.tries.length !== 1 || !addCost(review.tries[0]?.reviewer, review.usage)) return null;
    }
    return cost;
  };
  const addCosts = (a, b) => {
    if (a === null || b === null) return null;
    for (const [currency, value] of Object.entries(b)) a[currency] = (a[currency] ?? 0) + value;
    return a;
  };
  let cost = tasks.length ? {} : null;
  const days = new Map(), leadMap = new Map(), launches = new Map();
  const day = date => {
    if (!days.has(date)) days.set(date, { date, tasks: 0, accepted: 0, cost: {} });
    return days.get(date);
  };
  for (const task of tasks) {
    const d = day(localDate(task.start.started));
    d.tasks++;
    const c = taskCost(task);
    d.cost = addCosts(d.cost, c);
    if (cost !== null) cost = taskCost(task, cost);
    const accepted = task.rows.find(r => r.event === 'accepted' && num(r.at) && r.at <= now);
    if (accepted) day(localDate(accepted.at)).accepted++;
    if (!launches.has(task.directory)) {
      let rows = [];
      try { rows = [...reverseRows(path.join(task.directory, 'leads.jsonl'))]; } catch { /* 没有启动记录。 */ }
      launches.set(task.directory, rows);
    }
    let latest = null;
    for (const row of launches.get(task.directory)) {
      if (row.v !== 1 || row.event !== 'lead-launch' || !text(row.project) || !text(task.start.repo) || key(row.project) !== key(task.start.repo) || !num(row.at) || row.at > task.start.started || !text(row.label) || !(row.model == null || typeof row.model === 'string')) continue;
      if (!latest || row.at > latest.at) latest = row;
    }
    const dimensions = [text(latest?.label), text(latest?.model)];
    const id = JSON.stringify(dimensions);
    if (!leadMap.has(id)) leadMap.set(id, { dimensions, tasks: [] });
    leadMap.get(id).tasks.push(task);
  }
  const daily = [...days.values()].sort((a, b) => sorted(a.date, b.date));
  const leadGroups = [...leadMap.values()].sort((a, b) => a.dimensions.map((v, i) => sorted(v, b.dimensions[i])).find(v => v !== 0) ?? 0).map(group => {
    const done = group.tasks.filter(t => ['accepted', 'rejected', 'failed', 'stopped'].includes(t.state));
    let spec = 0, failures = 0;
    for (const t of done) for (const a of t.attempts) if (a.gate === false && a.blame !== 'environment') {
      failures++;
      if (a.blame === 'spec') spec++;
    }
    const durations = done.flatMap(t => {
      const accepted = t.rows.findLast(r => r.event === 'accepted');
      return t.state === 'accepted' && text(accepted?.merge) && num(accepted.at) && accepted.at >= t.start.started ? [accepted.at - t.start.started] : [];
    });
    return { label: group.dimensions[0], model: group.dimensions[1], sampleSize: done.length, lead: { specGateFailureRate: ratio(spec, failures), supplementCount: null, dispatchToMergeMedianMs: median(durations) } };
  });
  const overall = { weeks: [...weeks].sort(([a], [b]) => sorted(a, b)).map(([week, merged]) => ({ week, merged })), medianEndToEndMs: median(durations), humanInterventions, cost, leadExecutorTokenRatio: complete && executorTokens ? leadTokens / executorTokens : null };
  const scores = { groups: summarize(scoreGroups), daily: summarize(scoreDaily), skipped };
  return { scores, overall, daily, leadGroups, ok: true, range: { kind: range, from, to: now }, project: selected, projects: [...projects].sort(), legacyTasks, totals: { tasks: tasks.length, finished: tasks.filter(t => ['accepted', 'rejected', 'failed', 'stopped'].includes(t.state)).length }, strata, sources, extraSources: sources.filter(directory => !primarySet.has(directory)), skippedSources };
}
