// 审查核心（Stage08 T2 + T2c）：选审查者、组装审查指令、以只读方式运行审查者、解析结论、核对只读并恢复、
// 判定审查是否完成（没完成就换下一个审查者）、写 review.json 与清单事件 review。
// 这里不写状态事件（reviewing 由流水线写）、不改任务状态、不触发重试；也不接 ar review 命令。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { adapterFor, resolveProfile } from '../adapters/index.mjs';
import { MAX_REWORKS_LIMIT, REVIEW_BLOCKS, REVIEW_DEFAULTS, readEffectiveConfig, resolveSettings, updateConfig, validateReviewSetting } from './config.mjs';
import { readDispatch, registryWriter, taskPaths } from './records.mjs';
import { parseSpec, validateSpec } from './spec.mjs';
import { reviewBrief, reviewLine, taskState } from './status.mjs';
import { readJson } from './json.mjs';
import { locateStart, reverseRows } from './wait.mjs';
import { allowedEnv, buildEnv, ensureSandboxHome, secretSources, withProxy } from './env.mjs';
import { git } from './git.mjs';
import { clockText, limitOf } from './limits-state.mjs';
import { killProcessTree } from './process.mjs';
import { pickReviewer } from './roles.mjs';
import { supportsReadOnly, usageToday } from './router.mjs';
import { runOnce } from './runner.mjs';

// 一次审查的超时（毫秒）：超时结束进程树，这次算失败。
export const REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
// 最多试几个审查者（第一个失败了换下一个，试满为止）。
export const MAX_TRIES = 3;
// 放进审查指令的汇报与差异的字节上限；超出的差异换成文件清单。
export const REPORT_LIMIT = 8 * 1024;
export const DIFF_LIMIT = 60 * 1024;
// 解析出的结论里各字段的长度上限。
const MAX_ISSUES = 50, TITLE_LIMIT = 200, DETAIL_LIMIT = 2000, SUMMARY_LIMIT = 300;
const SEVERITIES = ['high', 'medium', 'low'];
const VERDICTS = ['pass', 'concerns', 'fail'];
// 汇报里只有这类话、没有结论：算这次审查失败。
const BLOCKED = /被阻塞|无法读取|无法访问|读取失败|blocked|cannot read|can't read|unable to read|couldn't read/i;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const clip = (value, max) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '').slice(0, max);

// ---- 选审查者 ----

const tokenText = number => {
  if (number >= 1e6) return `${+(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `${+(number / 1e3).toFixed(1)}K`;
  return String(number);
};
const positive = value => (Number.isSafeInteger(value) && value > 0 ? value : null);

// 候选现在不能用的原因（被限流、已达每日上限，写法同路由）；可用返回 null。home 没给就不查。
function limitReason({ home, name, profile, now, usage }) {
  if (!home) return null;
  const limit = limitOf(home, name, now);
  if (limit) return `被限流（额度到 ${clockText(limit.until, now)} 恢复）`;
  const limits = object(profile.limits) ? profile.limits : {};
  const maxTasks = positive(limits.maxTasksPerDay), maxTokens = positive(limits.maxTokensPerDay);
  if (!maxTasks && !maxTokens) return null;
  if (!usage.has(name)) usage.set(name, usageToday({ home, profile: name, now }));
  const today = usage.get(name);
  if (maxTasks && today.tasks >= maxTasks) return `已达每日上限（今天 ${today.tasks}/${maxTasks} 个任务）`;
  if (maxTokens && today.tokens >= maxTokens) return `已达每日上限（今天 ${tokenText(today.tokens)}/${tokenText(maxTokens)} token）`;
  return null;
}

// 为这次审查挑审查者。返回 { ok, profile, crossed, reasons }：crossed = 审查者不是执行者本人；reasons 是每个被跳过的候选和原因。
// 任务说明写了 reviewer：只要求存在、启用、支持只读、不在 exclude 里，不套家族规则，不满足就报原因，不悄悄换人。
// 否则按 pickReviewer（角色、家族、mustDiffer / differFamily / differFromLead 三个开关），另外跳过被限流、已达每日上限的；exclude 是这次审查已经失败过的审查者。
export function chooseReviewer({ config, spec = null, executor, model, exclude = [], home = null, now = Date.now() } = {}) {
  const profiles = object(config?.profiles) ? config.profiles : {};
  const failed = Array.isArray(exclude) ? exclude : [];
  const pinned = text(spec?.reviewer);
  if (pinned) {
    const profile = profiles[pinned];
    const why = !object(profile) ? '不存在' : profile.enabled === false ? '已停用' : !supportsReadOnly(profile, config) ? '不支持只读'
      : failed.includes(pinned) ? '这次审查已经失败过' : null;
    if (why) return { ok: false, profile: null, crossed: false, reasons: [{ profile: pinned, why: `任务说明指定的审查者 ${pinned} 不可用：${why}` }] };
    return { ok: true, profile: pinned, crossed: pinned !== executor, reasons: [] };
  }
  const usage = new Map();
  const picked = pickReviewer({ config, executor, model, exclude: failed, unavailable: (name, profile) => limitReason({ home, name, profile, now, usage }) });
  return picked.ok
    ? { ok: true, profile: picked.profile, crossed: picked.profile !== executor, reasons: picked.reasons }
    : { ok: false, profile: null, crossed: false, reasons: picked.reasons };
}

// ---- 审查指令 ----

// 最多 limit 字节（按 UTF-8 算），不在多字节字符中间截断；超出的部分换成 note。
function capBytes(value, limit, note) {
  const buffer = Buffer.from(String(value ?? ''), 'utf8');
  if (buffer.length <= limit) return buffer.toString('utf8');
  return `${buffer.subarray(0, limit).toString('utf8').replace(/�+$/, '')}\n${note}`;
}

// 门禁段：summary 与每条验收命令的结果。gate 可以是 runGate 的结果、纯文字，或没有。
function gateText(gate) {
  if (typeof gate === 'string') return gate.trim() || '（没有门禁信息）';
  if (!object(gate)) return '（没有运行门禁）';
  const lines = [`门禁${gate.ok === true ? '通过' : '未通过'}：${gate.summary ?? ''}`.trimEnd()];
  const commands = Array.isArray(gate.commands) ? gate.commands : [];
  if (commands.length) lines.push('', '验收命令：');
  for (const item of commands) {
    const status = item.timedOut ? '超时' : item.error != null ? `出错（${item.error}）` : item.exit === 0 ? '通过' : `exit ${item.exit}`;
    lines.push(`- ${item.line} → ${status}`);
  }
  return lines.join('\n');
}

let template = null;
const readTemplate = () => (template ??= readFileSync(new URL('../templates/review-prompt.md', import.meta.url), 'utf8'));

// 组装审查指令：只替换 {{spec}} {{report}} {{diff}} {{gate}} {{base}} {{head}} 六个占位符（一次替换，内容里出现的占位符不再展开）。
// diff 超过 60KB 时换成 files（[{ path, added, deleted }]）的清单，请审查者自己读文件；汇报最多 8KB。
export function reviewPrompt({ specText = '', report = '', diff = '', files = [], gate = null, base = '', head = '' } = {}) {
  const diffBytes = Buffer.byteLength(String(diff ?? ''), 'utf8');
  let diffPart;
  if (diffBytes > DIFF_LIMIT) {
    const list = (Array.isArray(files) ? files : []).map(item => `- ${item.path}（+${item.added ?? '?'} −${item.deleted ?? '?'}）`);
    diffPart = `改动太大（${Math.ceil(diffBytes / 1024)} KB），只列文件清单：${list.length ? `\n${list.join('\n')}\n` : '（读不到文件清单）'}请自己阅读这些文件。`;
  } else diffPart = String(diff ?? '').trim() === '' ? '（没有改动）' : String(diff);
  const values = {
    spec: String(specText ?? ''),
    report: capBytes(report, REPORT_LIMIT, `（汇报超过 ${REPORT_LIMIT / 1024} KB，已截断）`),
    diff: diffPart,
    gate: gateText(gate),
    base: String(base ?? ''),
    head: String(head ?? ''),
  };
  return readTemplate().replace(/\{\{(spec|report|diff|gate|base|head)\}\}/g, (_, name) => values[name]);
}

// ---- 解析与完成判定 ----

// 取汇报里最后一个 ```json 代码块的内容；没有返回 null。
function lastJsonBlock(report) {
  const blocks = [...String(report ?? '').matchAll(/```json[^\S\r\n]*\r?\n([\s\S]*?)\r?\n?[^\S\r\n]*```/gi)];
  return blocks.length ? blocks.at(-1)[1] : null;
}

// 只在字符串内部扫描：合法转义（含 \\ 与 \uXXXX）整体跳过，其余反斜杠改成 \\（字面反斜杠）。
function fixBadEscapes(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) { if (ch === '"') inString = true; out += ch; continue; }
    if (ch === '"') { inString = false; out += ch; continue; }
    if (ch !== '\\') { out += ch; continue; }
    const next = text[i + 1];
    if (next !== undefined && '"\\/bfnrt'.includes(next)) { out += ch + next; i++; continue; }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { out += text.slice(i, i + 6); i += 5; continue; }
    out += '\\\\';
  }
  return out;
}

// 解析审查者的汇报。成功 { ok: true, verdict, summary, reviewed, issues, warnings }；
// 这次审查没完成（没有结论）{ ok: false, why }：没有 json 代码块、JSON 解析失败、verdict 非法、
// pass 且没有问题却没说看了什么（reviewed 为空）、正文只有"被阻塞 / 无法读取"之类。
// 问题编号 R<attempt>-<序号>（序号从 1 开始），confirmation 先是 null。
export function parseReview(report, { attempt = 1 } = {}) {
  const body = String(report ?? '');
  if (body.trim() === '') return { ok: false, why: '审查者的汇报是空的' };
  const block = lastJsonBlock(body);
  if (block === null) return { ok: false, why: BLOCKED.test(body) ? '审查者说被阻塞或无法读取，没有给出结论' : '汇报里没有 json 代码块，没有给出结论' };
  let value;
  const warnings = [];
  try { value = JSON.parse(block); } catch (error) {
    const fixed = fixBadEscapes(block);
    try {
      if (fixed === block) throw error;
      value = JSON.parse(fixed);
      warnings.push('结论 json 里有非法的反斜杠转义，已按字面反斜杠处理');
    } catch { return { ok: false, why: `结论的 json 无法解析：${error.message}` }; }
  }
  if (!object(value)) return { ok: false, why: '结论的 json 不是对象' };
  if (!VERDICTS.includes(value.verdict)) return { ok: false, why: `verdict 非法：${clip(JSON.stringify(value.verdict) ?? 'undefined', 40)}（只能是 ${VERDICTS.join(' / ')}）` };
  let list = [];
  if (Array.isArray(value.issues)) list = value.issues;
  else if (value.issues !== undefined) warnings.push('issues 不是数组，按没有问题处理');
  if (list.length > MAX_ISSUES) warnings.push(`问题超过 ${MAX_ISSUES} 条，只保留前 ${MAX_ISSUES} 条`);
  const issues = [];
  list.slice(0, MAX_ISSUES).forEach((item, index) => {
    if (!object(item)) { warnings.push(`第 ${index + 1} 条问题不是对象，已忽略`); return; }
    let severity = item.severity;
    if (!SEVERITIES.includes(severity)) { warnings.push(`第 ${index + 1} 条问题的 severity 非法（${clip(JSON.stringify(item.severity) ?? 'undefined', 40)}），按 medium 处理`); severity = 'medium'; }
    issues.push({
      id: `R${attempt}-${issues.length + 1}`,
      severity,
      file: clip(item.file, 500).replaceAll('\\', '/'),
      line: Number.isInteger(item.line) ? item.line : null,
      title: clip(item.title, TITLE_LIMIT),
      detail: clip(item.detail, DETAIL_LIMIT),
      confirmation: null,
    });
  });
  const reviewed = Array.isArray(value.reviewed) ? value.reviewed.map(item => (typeof item === 'string' ? item.trim().replaceAll('\\', '/') : '')).filter(Boolean) : [];
  if (value.reviewed !== undefined && !Array.isArray(value.reviewed)) warnings.push('reviewed 不是数组，按空处理');
  if (value.verdict === 'pass' && issues.length === 0 && reviewed.length === 0) return { ok: false, why: '结论是 pass 但 reviewed 为空，没说看了什么' };
  return { ok: true, verdict: value.verdict, summary: clip(value.summary, SUMMARY_LIMIT), reviewed, issues, warnings };
}

// ---- 运行 ----

// 临时文件 + 改名，读的人要么读到完整文件，要么什么都读不到。
function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

const gitText = (dir, args) => {
  const result = git(dir, args);
  return result.status === 0 ? result.stdout : null;
};

// base..head 每个文件的增删行数（diff 太大时给审查者的清单）。
function diffFiles(dir, base, head) {
  const out = gitText(dir, ['diff', '--numstat', '-z', '-M', `${base}..${head}`]);
  if (out === null) return [];
  const fields = out.split('\0');
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i]);
    if (!match) continue;
    // 重命名项：第三段为空，后面跟旧路径、新路径两个字段。
    const path = match[3] === '' ? (i += 2, fields[i]) : match[3];
    if (path) files.push({ path, added: match[1] === '-' ? '?' : Number(match[1]), deleted: match[2] === '-' ? '?' : Number(match[2]) });
  }
  return files;
}

// 把 worktree 恢复成审查前的样子：切回原分支（或原来的游离提交），reset --hard，再删未跟踪的文件（clean -fd，不动被忽略的文件）。
// 只在任务专属的 worktree 里调用。
function restore(dir, { head, branch }) {
  if (branch) git(dir, ['checkout', '-f', branch]);
  else git(dir, ['checkout', '-f', '--detach', head]);
  git(dir, ['reset', '--hard', head]);
  git(dir, ['clean', '-fd']);
}

const sumUsage = list => {
  const total = { input: null, output: null };
  for (const usage of list) for (const key of ['input', 'output']) if (Number.isFinite(usage?.[key])) total[key] = (total[key] ?? 0) + usage[key];
  return total;
};

const durationText = ms => (ms >= 60000 ? `${+(ms / 60000).toFixed(1)} 分钟` : `${+(ms / 1000).toFixed(1)} 秒`);

// 用一个审查者跑一次审查（只读）。返回 { ok: true, parsed, ms, usage, report } 或 { ok: false, kind, why, ms, usage, report }；
// kind：invalid（改了文件，已恢复）/ timeout / start（没能启动）/ exit（异常退出）/ parse（没有给出结论）。不抛错。
async function reviewOnce({ ctx, pick, files, prompt, wt, before, attempt, idTag = attempt, timeoutMs, stopped }) {
  const { paths, id, config, registry, progress, home } = ctx;
  const env = ctx.env ?? process.env;
  const started = Date.now();
  const reportFile = join(files, 'report.md');
  const rawFile = join(files, 'raw.log');
  const reportRel = relative(paths.dir, reportFile).replaceAll('\\', '/');
  const done = (extra, usage = { input: null, output: null }) => ({ ms: Date.now() - started, usage, report: reportRel, ...extra });
  const name = pick.profile;
  let run, timedOut = false, timer = null;
  try {
    const profile = resolveProfile(config.profiles[name], config);
    const adapter = adapterFor(profile, { config, tolerant: true });
    const settings = resolveSettings(config, {}, env, name).settings;
    const sources = secretSources(config);
    const { base: envBase } = withProxy(env, home);
    let childEnv, envError = null;
    try { childEnv = buildEnv({ base: envBase, profile, adapter, home, profileName: name, sources }); ensureSandboxHome(childEnv, { home, profileName: name }); }
    catch (error) { envError = error; childEnv = allowedEnv({ base: envBase, adapter, home, profileName: name, sources }); }
    const detection = await adapter.detect({ env: childEnv, settings, profile });
    writeFileSync(rawFile, '');
    const errors = [];
    const usage = { input: 0, output: 0, sawInput: false, sawOutput: false };
    const emit = event => {
      if (event.kind === 'error') errors.push(event.text);
      if (event.kind === 'turn' && object(event.usage)) {
        if (Number.isFinite(event.usage.input)) { usage.input += event.usage.input; usage.sawInput = true; }
        if (Number.isFinite(event.usage.output)) { usage.output += event.usage.output; usage.sawOutput = true; }
      }
    };
    const onSpawn = pid => {
      ctx.onSpawn?.(pid);
      if (pid) timer = setTimeout(() => { timedOut = true; killProcessTree(pid).catch(() => {}); }, timeoutMs);
    };
    // 审查者的原始输出写到 review 目录自己的 raw.log，不进任务顶层的 raw.log；spawned 事件不写（会把任务状态改回 running，pid 经 ctx.onSpawn 交给流水线）。
    const result = await runOnce({
      adapter, label: profile.label ?? adapter.label ?? adapter.id, profile, profileName: name, settings, detection,
      workdir: wt, childEnv, paths: { ...paths, raw: rawFile, report: reportFile },
      registry: record => { if (record.event !== 'spawned') registry(record); }, id, progress,
      prompt, envError, emit, errors, mapLine: adapter.createMapper ? adapter.createMapper() : adapter.mapLine, stopped,
      attempt, readOnly: true, onSpawn, beforeSpawn: null,
    });
    clearTimeout(timer);
    run = { adapter, result, errors, usage: { input: usage.sawInput ? usage.input : null, output: usage.sawOutput ? usage.output : null } };
  } catch (error) {
    clearTimeout(timer);
    return done({ ok: false, kind: 'start', why: `没能启动：${error.message}` });
  }
  const { adapter, result, errors, usage } = run;
  // 只读校验：HEAD、分支或 git status 有变化，只在这个任务的 worktree 里恢复，这次审查无效。
  const after = snapshot(wt);
  if (!after || after.head !== before.head || after.branch !== before.branch || after.status !== before.status) {
    if (after) {
      restore(wt, before);
      progress(`审查：${name} 试图修改文件，已恢复，这次审查无效`);
      return done({ ok: false, kind: 'invalid', why: '试图修改文件，已恢复，这次审查无效' }, usage);
    }
    return done({ ok: false, kind: 'invalid', why: '审查后读不到 worktree 的 git 状态，无法确认没有改动，这次审查无效' }, usage);
  }
  if (stopped()) return done({ ok: false, kind: 'exit', why: '被停止' }, usage);
  if (timedOut) return done({ ok: false, kind: 'timeout', why: `超过 ${durationText(timeoutMs)}没结束，已结束进程` }, usage);
  if (result.startFailed) return done({ ok: false, kind: 'start', why: `没能启动${errors.length ? `：${clip(errors[0], 200)}` : ''}` }, usage);
  if (result.exit !== 0) return done({ ok: false, kind: 'exit', why: `异常退出（exit ${result.exit}）` }, usage);
  // 汇报：自己写汇报文件的适配器读文件，其余的由核心写（同流水线）。
  let report = null;
  if (adapter.writesReport) {
    try { report = readFileSync(reportFile, 'utf8'); } catch { /* 没写汇报文件就是没有汇报。 */ }
  } else {
    report = adapter.finish ? adapter.finish({ lastSay: result.lastSay, result: result.result, stdoutText: result.stdoutText }) : result.lastSay;
    if (report != null) writeFileSync(reportFile, report);
  }
  const parsed = parseReview(report, { attempt: idTag });
  if (!parsed.ok) return done({ ok: false, kind: 'parse', why: parsed.why }, usage);
  return done({ ok: true, parsed }, usage);
}

// worktree 当前的 HEAD、所在分支（游离为空串）与 git status --porcelain；读不到返回 null。
function snapshot(dir) {
  const head = gitText(dir, ['rev-parse', 'HEAD']);
  const status = gitText(dir, ['status', '--porcelain']);
  if (head === null || status === null) return null;
  return { head: head.trim(), branch: (gitText(dir, ['symbolic-ref', '-q', '--short', 'HEAD']) ?? '').trim(), status };
}

// 这个目录是不是任务专属的 linked worktree（不是项目的主工作区）：git-dir 与 common-dir 不同。
function isLinkedWorktree(dir) {
  const gitDir = gitText(dir, ['rev-parse', '--absolute-git-dir']);
  const common = gitText(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (gitDir === null || common === null) return null;
  return resolve(gitDir.trim()) !== resolve(common.trim());
}

// 审查一次任务的改动。ctx：
//   root          项目根（主工作区）           paths      任务记录路径（taskPaths：name、dir…）
//   id            任务 id                      worktree   任务专属 worktree 目录（不用 worktree 的任务为 null / 不给）
//   executor      执行者配置名                 model      执行者这次实际用的模型（可不给）
//   attempt       这次尝试号                   spec       解析后的任务说明对象（用它的 reviewer 字段；可不给）
//   specText      任务说明全文                 report     执行者的汇报全文
//   gate          门禁结果（runGate 的结果）   base       基线提交（diff 的起点；head 取审查前 worktree 的 HEAD）
//   config        readEffectiveConfig 的结果   home       公共目录（限流、每日用量、沙箱用户目录）
//   env           核心进程的环境（默认 process.env）   registry / progress   清单与进度写入函数
//   signal        { stopped } 停止信号         onSpawn    (pid) => void，审查者进程启动后回调（流水线用它装停止信号）
//   exclude       已经失败过的审查者（可不给）  timeoutMs  单次审查超时（测试用，默认 REVIEW_TIMEOUT_MS）
//   run           这次尝试的第几次审查（ar review 再审用，2 起；不给或 1 是自动审查）：文件写 review-<run>.json 与 review-<run>/，
//                 问题编号 R<attempt>.<run>-<序号>，review.json 与 review/ 不动；顶层 review.json 总是最新的一次
// 不抛错；返回写进 review.json 的对象。非 worktree 任务返回 verdict: 'skipped'（不写文件和事件）。
export async function runReview(ctx) {
  const { root, paths, id, executor, model, attempt = 1, config, registry = () => {}, progress = () => {} } = ctx;
  const timeoutMs = Number.isFinite(ctx.timeoutMs) && ctx.timeoutMs > 0 ? ctx.timeoutMs : REVIEW_TIMEOUT_MS;
  const stopped = () => ctx.signal?.stopped === true;
  const started = Date.now();
  const run = Number.isSafeInteger(ctx.run) && ctx.run > 1 ? ctx.run : 1;
  const attemptDir = join(paths.dir, 'attempts', String(attempt));
  const reviewDir = join(attemptDir, run > 1 ? `review-${run}` : 'review');
  const idTag = run > 1 ? `${attempt}.${run}` : attempt;
  const skeleton = { v: 1, attempt, at: started, reviewer: null, crossed: false, base: ctx.base ?? null, head: null, verdict: 'unknown', summary: '', reviewed: [], issues: [], warnings: [], tries: [], ms: 0, usage: { input: null, output: null }, raw: null, ...(run > 1 ? { run } : {}) };

  // 写 review.json（这次尝试的目录与顶层各一份）与 review 事件；写不进去不影响返回值。
  const save = fields => {
    const result = { ...skeleton, ...fields, ms: Date.now() - started };
    try {
      mkdirSync(attemptDir, { recursive: true });
      writeJson(join(attemptDir, run > 1 ? `review-${run}.json` : 'review.json'), result);
      writeJson(join(paths.dir, 'review.json'), result);
    } catch (error) { progress(`审查：review.json 写入失败：${error.message}`); }
    registry({ event: 'review', id, attempt, ...(run > 1 ? { run } : {}), reviewer: result.reviewer, crossed: result.crossed, verdict: result.verdict,
      issues: result.issues.length, high: result.issues.filter(issue => issue.severity === 'high').length, at: Date.now() });
    return result;
  };

  // 1. 不用 worktree（或目录不是任务专属的 worktree）：不审查，因为审查者万一改了文件无法安全恢复。
  const wt = ctx.worktree ? resolve(ctx.worktree) : null;
  const skippedSummary = '不用 worktree 的任务无法安全恢复，不审查';
  if (!wt || !existsSync(wt) || wt === resolve(root)) {
    progress(`审查：${skippedSummary}`);
    return { ...skeleton, verdict: 'skipped', summary: skippedSummary, ms: Date.now() - started };
  }
  const linked = isLinkedWorktree(wt);
  if (linked === null) return save({ summary: '无法读取 worktree 的 git 信息，不审查' });
  if (!linked) {
    progress(`审查：${skippedSummary}`);
    return { ...skeleton, verdict: 'skipped', summary: skippedSummary, ms: Date.now() - started };
  }

  // 2. 选审查者。
  const choose = exclude => chooseReviewer({ config, spec: ctx.spec, executor, model, exclude, home: ctx.home });
  let pick = choose(ctx.exclude ?? []);
  if (!pick.ok) {
    progress('审查：没有可用的审查者');
    return save({ summary: '没有可用的审查者', reasons: pick.reasons });
  }

  // 3. 只读校验准备：审查前 worktree 必须是干净的。
  const before = snapshot(wt);
  if (!before) return save({ summary: '无法读取 worktree 的 git 状态，不审查' });
  if (before.status.trim() !== '') {
    const lines = before.status.split(/\r?\n/).filter(Boolean);
    progress('审查：审查前 worktree 里有未提交的改动，不审查');
    return save({ head: before.head, summary: `审查前 worktree 里有未提交的改动（git status 非空），不审查：${lines.slice(0, 5).join('；')}${lines.length > 5 ? '…' : ''}` });
  }
  skeleton.head = before.head;

  // 4. 组装指令：差异取基线到审查前 HEAD；太大时只给文件清单。
  const diff = ctx.base ? gitText(wt, ['diff', `${ctx.base}..${before.head}`]) : null;
  const prompt = reviewPrompt({
    specText: ctx.specText, report: ctx.report,
    diff: diff ?? '（读不到差异，请自己用 git 查看）',
    files: diff !== null && Buffer.byteLength(diff, 'utf8') > DIFF_LIMIT ? diffFiles(wt, ctx.base, before.head) : [],
    gate: ctx.gate, base: ctx.base ?? '', head: before.head,
  });

  // 5. 依次试审查者，最多 MAX_TRIES 个：失败（超时、异常退出、改了文件、没有结论）就换下一个。
  rmSync(reviewDir, { recursive: true, force: true });
  const exclude = [...(ctx.exclude ?? [])];
  const tries = [], usages = [];
  let last = null, success = null;
  for (let k = 0; k < MAX_TRIES; k++) {
    // 第一次的文件在 review/，后面几次在 review/try-<n>/，互不覆盖。
    const files = k === 0 ? reviewDir : join(reviewDir, `try-${k + 1}`);
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, 'prompt.md'), prompt);
    const outcome = await reviewOnce({ ctx, pick, files, prompt, wt, before, attempt, idTag, timeoutMs, stopped });
    usages.push(outcome.usage);
    tries.push({ reviewer: pick.profile, ok: outcome.ok, ...(outcome.ok ? {} : { why: outcome.why, kind: outcome.kind }), ms: outcome.ms });
    last = { ...outcome, reviewer: pick.profile, crossed: pick.crossed };
    if (stopped()) return { ...skeleton, reviewer: pick.profile, crossed: pick.crossed, summary: '审查被停止', tries, stopped: true, ms: Date.now() - started };
    if (outcome.ok) { success = last; break; }
    exclude.push(pick.profile);
    const next = k + 1 < MAX_TRIES ? choose(exclude) : null;
    progress(`审查：${pick.profile} ${outcome.why}，${next?.ok ? `换 ${next.profile}` : k + 1 >= MAX_TRIES ? `已试满 ${MAX_TRIES} 个审查者` : '没有别的审查者可换'}`);
    if (!next?.ok) break;
    pick = next;
  }

  // 6. 写结果。
  if (success) {
    const { parsed } = success;
    progress(`审查：${success.reviewer} 的结论是 ${parsed.verdict}，${parsed.issues.length} 条问题`);
    return save({ reviewer: success.reviewer, crossed: success.crossed, verdict: parsed.verdict, summary: parsed.summary, reviewed: parsed.reviewed,
      issues: parsed.issues, warnings: parsed.warnings, tries, usage: sumUsage(usages), raw: success.report });
  }
  return save({
    reviewer: last.reviewer, crossed: last.crossed, verdict: last.kind === 'invalid' ? 'invalid' : 'unknown',
    summary: `审查没有完成：${last.reviewer} ${last.why}${tries.length > 1 ? `（共试了 ${tries.length} 个审查者）` : ''}`,
    tries, usage: sumUsage(usages), raw: last.report,
  });
}

// ---- 流水线策略（Stage08 T3）----

const READ_ONLY_TYPES = ['research', 'review'];
const plain = value => (object(value) ? value : {});

// 这个任务审不审、拦不拦、最多返工几次。优先级：任务说明 > 项目配置 > 全局配置 > 内置默认（maxReworks 没有任务说明字段）。
// spec 是解析后的任务说明对象；project 是 project.json 内容；global 是 config.json 内容（只看各自的 review 键，类型不对的值当没写）。
export function reviewSettings({ spec = null, project = null, global = null } = {}) {
  const projectReview = plain(plain(project).review), globalReview = plain(plain(global).review);
  const validReworks = value => Number.isInteger(value) && value >= 0 && value <= MAX_REWORKS_LIMIT;
  return {
    enabled: [spec?.review, projectReview.default, globalReview.default].find(value => typeof value === 'boolean') ?? REVIEW_DEFAULTS.default,
    block: [spec?.review_block, projectReview.block, globalReview.block].find(value => REVIEW_BLOCKS.includes(value)) ?? REVIEW_DEFAULTS.block,
    maxReworks: [projectReview.maxReworks, globalReview.maxReworks].find(validReworks) ?? REVIEW_DEFAULTS.maxReworks,
  };
}

// 只读类任务（research / review，或这次以只读运行）没有改动，不审查。
export const reviewApplies = ({ spec = null, readOnly = false } = {}) => !readOnly && !READ_ONLY_TYPES.includes(spec?.type);

// 会触发拦截的问题：severity 是 high，且没有被人工标为"不成立"。
export const blockingIssues = review => (Array.isArray(review?.issues) ? review.issues : [])
  .filter(issue => issue?.severity === 'high' && issue.confirmation?.result !== 'invalid');

// 审查完成后怎么办：accept（进入待验收）/ rework（自动返工）/ needs-human（返工次数用完，进入待验收并要人工处理）。
// 只有审查给出了结论（pass / concerns / fail）才可能拦；建议模式（block: none）永远是 accept。reworks 是这个任务已经由审查触发过的返工次数。
export function reviewDecision({ review, block = REVIEW_DEFAULTS.block, maxReworks = REVIEW_DEFAULTS.maxReworks, reworks = 0 } = {}) {
  const blocking = VERDICTS.includes(review?.verdict) ? blockingIssues(review) : [];
  if (block !== 'high' || !blocking.length) return { action: 'accept', blocking };
  return { action: reworks < maxReworks ? 'rework' : 'needs-human', blocking };
}

// 把审查结果标成"需人工处理"：这次审查在任务目录顶层与这次尝试目录里的 review 文件都写 needsHuman: true，返回更新后的对象。
export function markNeedsHuman(paths, review) {
  const marked = { ...review, needsHuman: true };
  const name = review.run > 1 ? `review-${review.run}.json` : 'review.json';
  for (const file of [join(paths.dir, 'review.json'), join(paths.dir, 'attempts', String(review.attempt), name)]) {
    try {
      if (readJson(file).at === review.at) writeJson(file, marked);
    } catch { /* 文件不在或写不进去：流水线照常往下走，清单里有 review-needs-human 事件。 */ }
  }
  return marked;
}

// 任务说明（派发记录里的 spec 路径）：返回 { spec: 解析校验后的对象 | null, text: 全文 | null }；读不了或解析不过的部分为 null。
export function reviewSpecOf(root, name) {
  const record = readDispatch(root, name);
  if (!record?.spec) return { spec: null, text: null };
  let text;
  try { text = readFileSync(resolve(root, record.spec), 'utf8'); } catch { return { spec: null, text: null }; }
  try { return { spec: validateSpec(parseSpec(text, record.spec), record.spec), text }; } catch { return { spec: null, text }; }
}

// ---- ar review（Stage08 T4）----

const SEVERITY_LABEL = { high: '高', medium: '中', low: '低' };
const REVIEW_USAGE = [
  '用法：ar review <记录名> [--profile <审查者>] [--json]（对待验收的 worktree 任务再审一次）',
  '  ar review confirm <记录名> <问题编号> valid|invalid [--note "<说明>"] [--by human|lead] [--json]',
  '  ar review show <记录名> [--json]',
  '  ar review stats [--json]',
  '  ar review config [--json]',
  '  ar review config set [default=true|false] [block=none|high] [maxReworks=<0～5>] [--json]',
].join('\n');
// 某审查者的 high 问题已确认这么多条、准确率达到这个比例，stats 才提示可以开拦截。
const SUGGEST_MIN_CONFIRMED = 20;

// 参数：记录名等位置参数 + 若干带值开关；不认识的 -- 开关、开关缺值都报用法。
function parseArguments(args, values = []) {
  const positional = [], options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (values.includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(REVIEW_USAGE);
      options[arg] = value;
    } else if (arg.startsWith('--')) throw new Error(REVIEW_USAGE);
    else positional.push(arg);
  }
  return { positional, options };
}

function taskOf({ homes, root, name }) {
  const found = locateStart(homes, root, name);
  if (!found) throw new Error(`审查：在当前仓库找不到记录 ${name}`);
  return found;
}

const readJsonFile = file => { try { return readJson(file); } catch { return null; } };

// 审查结果的文字：第一行是摘要行（同 ar status），再按严重度列问题（带确认状态），需要人工处理的最后一行说明。
function reviewLines(review) {
  const brief = reviewBrief(review);
  if (!brief) throw new Error('审查：review.json 的格式不对');
  const lines = [reviewLine(brief)];
  if (review.summary) lines.push(`摘要：${review.summary}`);
  const rank = { high: 0, medium: 1, low: 2 };
  const issues = [...(Array.isArray(review.issues) ? review.issues : [])].sort((a, b) => (rank[a?.severity] ?? 3) - (rank[b?.severity] ?? 3));
  for (const issue of issues) {
    const where = issue.file ? `${issue.file}${Number.isInteger(issue.line) ? `:${issue.line}` : ''}` : '（没有指明文件）';
    const confirmed = issue.confirmation ? `　[已确认${issue.confirmation.result === 'valid' ? '成立' : '不成立'}（${issue.confirmation.by}）]` : '';
    lines.push(`${issue.id}　${SEVERITY_LABEL[issue.severity] ?? issue.severity}　${where}　${issue.title}${confirmed}`);
    if (issue.detail) lines.push(`  ${String(issue.detail).replace(/\r?\n/g, '\n  ')}`);
  }
  if (brief.needsHuman) lines.push('审查问题未解决，需人工处理');
  return lines;
}

// ar review <记录名> [--profile <审查者>]：手动再审一次。只对待验收的 worktree 任务；不改任务状态。
async function rerunCommand(args, { homes, root, env }) {
  const { positional, options } = parseArguments(args, ['--profile']);
  if (positional.length !== 1 || !positional[0]) throw new Error(REVIEW_USAGE);
  const [name] = positional;
  const found = taskOf({ homes, root, name });
  const { file, start } = found;
  if (start.worktree !== true) throw new Error('审查：只能审查待验收的 worktree 任务（这个任务没有用 worktree）');
  const state = taskState(file, start);
  if (state !== 'awaiting') throw new Error(`审查：只能审查待验收的任务（${name} 现在是 ${state}）`);
  const rows = [];
  for (const row of reverseRows(file)) if (row.id === start.id) rows.push(row);
  const attempts = rows.filter(row => row.event === 'attempt' && Number.isSafeInteger(row.n));
  const n = attempts.reduce((max, row) => Math.max(max, row.n), 0);
  if (n < 1) throw new Error('审查：这个任务没有尝试记录，无法审查');
  const lastAttempt = attempts.find(row => row.n === n);
  const worktree = rows.find(row => row.event === 'worktree');
  if (!worktree?.dir || !existsSync(worktree.dir)) throw new Error('审查：这个任务的 worktree 已经不存在，无法审查');
  const config = readEffectiveConfig(homes[0]);
  const repo = resolve(start.repo ?? root);
  const paths = taskPaths(repo, start.name);
  const attemptDir = join(paths.dir, 'attempts', String(n));
  // 这次尝试已有的审查文件：review.json 是第 1 次，review-<k>.json 是第 k 次；这次是最大的加 1（没有就是第 1 次）。
  let existing = [];
  try { existing = readdirSync(attemptDir).map(item => /^review(?:-(\d+))?\.json$/.exec(item)).filter(Boolean).map(match => (match[1] ? Number(match[1]) : 1)); } catch { /* 没有目录就是没审过。 */ }
  const run = existing.length ? Math.max(...existing) + 1 : 1;
  const gate = readJsonFile(join(attemptDir, 'gate.json'));
  let report = '';
  for (const candidate of [join(attemptDir, 'report.md'), paths.report]) {
    try { report = readFileSync(candidate, 'utf8'); break; } catch { /* 换下一个位置。 */ }
  }
  const { spec, text: specSource } = reviewSpecOf(repo, start.name);
  const specText = specSource ?? readDispatch(repo, start.name)?.task ?? '';
  const resume = rows.find(row => row.event === 'resume' && row.model !== undefined);
  const lines = [];
  // 再审没有给出结论（没有可用的审查者、审查者没完成……）时不该把已有的顶层 review.json（连同其中的确认）换成"未知"：先留一份原文，必要时放回去。
  const topFile = join(paths.dir, 'review.json');
  let previous = null;
  try { previous = readFileSync(topFile, 'utf8'); } catch { /* 没有顶层 review.json。 */ }
  const review = await runReview({
    root: repo, paths, id: start.id, worktree: worktree.dir,
    executor: lastAttempt?.profile ?? start.profile, model: (resume ?? start).model ?? null,
    attempt: n, run, spec: { ...(spec ?? {}), ...(options['--profile'] ? { reviewer: options['--profile'] } : {}) },
    specText, report, gate, base: gate?.base ?? lastAttempt?.base ?? worktree.base ?? start.base ?? null,
    config, home: homes[0], env, registry: registryWriter(found.home), progress: line => lines.push(line),
  });
  const done = VERDICTS.includes(review.verdict);
  if (!done) {
    try { if (previous === null) rmSync(topFile, { force: true }); else writeFileSync(topFile, previous); } catch { /* 放不回去就留着最新的。 */ }
  }
  const output = [...lines, ...(done ? reviewLines(review) : [`审查没有完成：${String(review.summary ?? '').replace(/^审查没有完成：/, '')}`])];
  return {
    result: done ? { ok: true, name, attempt: n, run, review, lines } : { ok: false, name, attempt: n, run, error: review.summary, review, lines },
    text: output.join('\n'), code: done ? 0 : 1,
  };
}

// ar review confirm：在顶层 review.json 的这条问题上写确认，并写 review-confirm 事件（统计准确率用）。
function confirmCommand(args, { homes, root, env }) {
  const { positional, options } = parseArguments(args, ['--note', '--by']);
  if (positional.length !== 3 || !['valid', 'invalid'].includes(positional[2])) throw new Error(REVIEW_USAGE);
  const [name, issueId, result] = positional;
  const by = options['--by'] ?? (env.CLAUDECODE === '1' ? 'lead' : 'human');
  if (!['human', 'lead'].includes(by)) throw new Error(`--by 只接受 human 或 lead：${by}`);
  const found = taskOf({ homes, root, name });
  const dir = found.start.dir ?? taskPaths(resolve(found.start.repo ?? root), found.start.name).dir;
  const file = join(dir, 'review.json');
  const review = readJsonFile(file);
  if (!reviewBrief(review)) throw new Error(`审查：${name} 还没有审查结果`);
  const issue = (Array.isArray(review.issues) ? review.issues : []).find(item => item?.id === issueId);
  if (!issue) throw new Error(`审查：${name} 的审查结果里没有问题 ${issueId}（现有：${review.issues.map(item => item.id).join('、') || '无'}）`);
  const at = Date.now();
  const note = options['--note'] ?? null;
  issue.confirmation = { result, by, note, at };
  writeJson(file, review);
  registryWriter(found.home)({ event: 'review-confirm', id: found.start.id, issue: issueId, severity: issue.severity, result, by, reviewer: review.reviewer ?? null, at });
  return {
    result: { ok: true, name, issue: issueId, severity: issue.severity, result, by, note },
    text: `已确认：${issueId} ${result === 'valid' ? '成立' : '不成立'}（${by}）`,
  };
}

function showCommand(args, { homes, root }) {
  const { positional } = parseArguments(args);
  if (positional.length !== 1 || !positional[0]) throw new Error(REVIEW_USAGE);
  const [name] = positional;
  const found = taskOf({ homes, root, name });
  const dir = found.start.dir ?? taskPaths(resolve(found.start.repo ?? root), found.start.name).dir;
  const review = readJsonFile(join(dir, 'review.json'));
  if (!reviewBrief(review)) throw new Error(`审查：${name} 还没有审查结果`);
  return { result: { ok: true, name, review }, text: reviewLines(review).join('\n') };
}

// 每个审查者 × 严重度的准确率：清单里所有 review-confirm 事件，每个任务每条问题取最后一次。
function statsCommand(args, { homes }) {
  if (args.length) throw new Error(REVIEW_USAGE);
  const last = new Map();
  let text = '';
  try { text = readFileSync(join(homes[0], 'runs.jsonl'), 'utf8'); } catch { /* 没有清单就是还没有确认过。 */ }
  for (const line of text.split('\n')) {
    if (!line.includes('review-confirm')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.event !== 'review-confirm' || typeof row.id !== 'string' || typeof row.issue !== 'string' || !['valid', 'invalid'].includes(row.result)) continue;
    last.set(`${row.id}\0${row.issue}`, row);
  }
  const byReviewer = new Map();
  for (const row of last.values()) {
    if (!Object.hasOwn(SEVERITY_LABEL, row.severity)) continue;
    const name = typeof row.reviewer === 'string' && row.reviewer ? row.reviewer : '（未知）';
    if (!byReviewer.has(name)) byReviewer.set(name, Object.fromEntries(Object.keys(SEVERITY_LABEL).map(key => [key, { confirmed: 0, valid: 0 }])));
    const cell = byReviewer.get(name)[row.severity];
    cell.confirmed += 1;
    if (row.result === 'valid') cell.valid += 1;
  }
  const reviewers = [...byReviewer].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, cells]) => {
    const severities = Object.fromEntries(Object.entries(cells).map(([key, cell]) => [key, { ...cell, accuracy: cell.confirmed ? Math.round((cell.valid / cell.confirmed) * 1000) / 1000 : null }]));
    // 整数比较，避免浮点误差：valid / confirmed ≥ 0.8 即 valid × 5 ≥ confirmed × 4。
    const suggest = cells.high.confirmed >= SUGGEST_MIN_CONFIRMED && cells.high.valid * 5 >= cells.high.confirmed * 4;
    return { reviewer: name, severities, ...(suggest ? { suggestBlock: true } : {}) };
  });
  const lines = reviewers.length ? reviewers.flatMap(item => [
    `${item.reviewer}：${Object.entries(item.severities).map(([key, cell]) => `${SEVERITY_LABEL[key]} 已确认 ${cell.confirmed}、成立 ${cell.valid}、准确率 ${cell.accuracy === null ? '—' : `${Math.round(cell.accuracy * 100)}%`}`).join('；')}`,
    ...(item.suggestBlock ? ['  高严重度问题的准确率已经够高，可以考虑把拦截模式打开（ar review config set block=high）'] : []),
  ]) : ['还没有确认过的审查问题'];
  return { result: { ok: true, reviewers }, text: lines.join('\n') };
}

// 全局 config.json 的 review 设置（没写过的键给默认值）。
const reviewConfigView = home => ({ ...REVIEW_DEFAULTS, ...plain(readEffectiveConfig(home).review) });
const reviewConfigText = review => ['审查设置（全局）：', `  default     ${review.default}`, `  block       ${review.block}`, `  maxReworks  ${review.maxReworks}`].join('\n');

function configCommand(args, { homes }) {
  const home = homes[0];
  if (!args.length) {
    const review = reviewConfigView(home);
    return { result: { ok: true, review }, text: reviewConfigText(review) };
  }
  if (args[0] !== 'set' || args.length < 2) throw new Error(REVIEW_USAGE);
  const changes = {};
  for (const arg of args.slice(1)) {
    const at = arg.indexOf('=');
    const key = at > 0 ? arg.slice(0, at) : '', value = at > 0 ? arg.slice(at + 1) : '';
    if (!Object.hasOwn(REVIEW_DEFAULTS, key)) throw new Error(`审查设置：不认识的键 ${arg}（只有 default、block、maxReworks，写成 键=值）`);
    if (Object.hasOwn(changes, key)) throw new Error(`审查设置：${key} 写了两次`);
    if (key === 'default') {
      if (value !== 'true' && value !== 'false') throw new Error(`审查设置：default 必须是 true 或 false（当前：${value}）`);
      changes.default = value === 'true';
    } else if (key === 'maxReworks') {
      if (!/^\d+$/.test(value)) throw new Error(`审查设置：maxReworks 必须是 0～${MAX_REWORKS_LIMIT} 的整数（当前：${value}）`);
      changes.maxReworks = Number(value);
    } else changes.block = value;
  }
  // updateConfig 先校验再原子写入：任何一项不合法，config.json 一个字节都不动。
  updateConfig(home, config => {
    const next = { ...plain(config.review), ...changes };
    validateReviewSetting(next, '审查设置');
    config.review = next;
  });
  const review = reviewConfigView(home);
  return { result: { ok: true, review }, text: `已更新审查设置\n${reviewConfigText(review)}` };
}

// ar review 的入口：返回 { result, text, code }；出错抛出中文原因（退出码 2）。
export async function reviewCommand(rest, { homes, root, env = process.env }) {
  const [first, ...more] = rest;
  if (first === undefined) throw new Error(REVIEW_USAGE);
  const context = { homes, root, env };
  if (first === 'confirm') return confirmCommand(more, context);
  if (first === 'show') return showCommand(more, context);
  if (first === 'stats') return statsCommand(more, context);
  if (first === 'config') return configCommand(more, context);
  return rerunCommand(rest, context);
}
