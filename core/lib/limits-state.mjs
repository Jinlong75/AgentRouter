// 限流 / 额度用完 / 服务不可用的识别与状态（Stage07c T7，任务 148）。零依赖。
// 一、classifyFailure：一次失败的尝试是不是"环境"原因（纯函数，不读写文件）；
// 二、<公共目录>/limits.json：被限流的执行者与恢复时间，路由跳过它，恢复时间过了读的时候自动失效。
// 只存执行者名、时间、命中的原文片段（已掩码），绝不存密钥。
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson } from './json.mjs';
import { redactPaths } from './process.mjs';

// 读不到恢复时间时默认限流多久（主导决定 D83）。
export const DEFAULT_LIMIT_MS = 60 * 60 * 1000;
// 解析出的恢复时间离现在超过这么久就不信（多半是读错了），按默认处理。
const MAX_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;
const EVIDENCE_LIMIT = 200;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---- 密钥掩码 ----

// 常见的密钥写法：sk- / tp- / ttp- 开头的 Key、Bearer 令牌、key=值 / token: 值 一类的赋值、长串无空格的字母数字（32 位以上）。
// 报错原文里偶尔会回显请求头或 Key 的前几位，证据片段先掩码再写盘、再放进进度。
export function maskSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const value of secrets) if (typeof value === 'string' && value.length >= 6) out = out.split(value).join('***');
  return out
    .replace(/\b(?:sk|tp|ttp|pk|rk)-[A-Za-z0-9_-]{6,}/g, '***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***')
    .replace(/\b((?:api[_-]?key|auth(?:orization)?|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1***')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***');
}

// 命中位置所在的那一行，最多 200 字（太长就围着命中位置截一段），先掩码。
function evidenceAround(text, index, length, secrets) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  let end = text.indexOf('\n', index + length);
  if (end === -1) end = text.length;
  let line = text.slice(start, end).trim();
  if (line.length > EVIDENCE_LIMIT * 2) {
    const from = Math.max(start, index - 80);
    line = text.slice(from, Math.min(end, index + EVIDENCE_LIMIT)).trim();
  }
  // 证据会写进 limits.json 和进度：先掩密钥，再把本机的用户目录 / 临时目录写成 <HOME> / <TEMP>。
  return redactPaths(maskSecrets(line, secrets)).slice(0, EVIDENCE_LIMIT);
}

// ---- 恢复时间的解析 ----

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const hour24 = (hour, meridiem) => {
  if (!meridiem) return hour;
  const pm = /^p/i.test(meridiem);
  return (hour % 12) + (pm ? 12 : 0);
};
const UNIT_MS = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
const unitKey = unit => (/^(?:day|d|天|日)/i.test(unit) ? 'd' : /^(?:hour|hr|h|小时|时)/i.test(unit) ? 'h' : /^(?:min|m|分)/i.test(unit) ? 'm' : 's');

// 时长："2 hours 5 minutes"、"1h30m"、"in 30 minutes"、"2 小时 5 分钟"、"90 seconds"。读不到返回 null。
function parseDuration(text) {
  const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|天|日|小时|时|分钟|分|秒)(?![A-Za-z])/gi;
  let total = 0, found = false, match;
  while ((match = re.exec(text)) !== null) { total += Number(match[1]) * UNIT_MS[unitKey(match[2])]; found = true; }
  return found ? total : null;
}

// 从报错原文里读恢复时间（毫秒时间戳）。能解析的写法：
//  - Codex：Try again at 3:15 PM. / Try again at Jan 5th, 2026 3:05 PM.（codex-rs/protocol/src/error.rs 的 format_retry_timestamp）、or try again at 20 Aug 2026, 16:29.
//  - 相对：try again in 2 hours 5 minutes / retry after 30 seconds / Retry-After: 120 / 2 小时后
//  - Claude Code 订阅提示：resets 3pm / resets at 15:00
//  - ISO 时间：2026-10-26T15:00:00Z
// 读不到、已经过去、离现在超过 14 天都返回 null（调用方按默认 1 小时）。时间一律按本机本地时间解释。
export function parseResetTime(text, now = Date.now()) {
  const s = String(text ?? '');
  const valid = ms => (Number.isFinite(ms) && ms > now && ms - now <= MAX_LIMIT_MS ? ms : null);
  let m;
  // ISO 日期时间。
  if ((m = /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(s))) {
    // 没写时区的按本地时间（Date.parse 对 "T" 分隔、不带时区的日期时间就是这样处理）。
    const at = Date.parse(m[1].replace(' ', 'T'));
    if (valid(at)) return at;
  }
  // 相对时长：in / after / 后。
  if ((m = /(?:\bin|\bafter|retry[- ]after:?)\s+((?:\d+(?:\.\d+)?\s*[A-Za-z]+[\s,]*(?:and\s+)?)+)/i.exec(s))) {
    const ms = parseDuration(m[1]);
    if (ms !== null && valid(now + ms)) return now + ms;
  }
  if ((m = /Retry-After["']?\s*[:=]\s*["']?(\d+)/i.exec(s))) {
    if (valid(now + Number(m[1]) * 1000)) return now + Number(m[1]) * 1000;
  }
  if ((m = /((?:\d+(?:\.\d+)?\s*(?:天|日|小时|分钟|分|秒)\s*)+)后/.exec(s))) {
    const ms = parseDuration(m[1]);
    if (ms !== null && valid(now + ms)) return now + ms;
  }
  // 带日期："Jan 5th, 2026 3:05 PM"、"Jan 5 3:05 PM"。
  if ((m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?,?\s+(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i.exec(s)) && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) {
    const date = new Date(now);
    const year = m[3] ? Number(m[3]) : date.getFullYear();
    let at = new Date(year, MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]), hour24(Number(m[4]), m[6]), Number(m[5])).getTime();
    if (!m[3] && at <= now) at = new Date(year + 1, MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]), hour24(Number(m[4]), m[6]), Number(m[5])).getTime();
    if (valid(at)) return at;
  }
  // "20 Aug 2026, 16:29"。
  if ((m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i.exec(s)) && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) {
    const at = new Date(Number(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]), hour24(Number(m[4]), m[6]), Number(m[5])).getTime();
    if (valid(at)) return at;
  }
  // 只有时间："try again at 3:15 PM"、"resets 3pm"、"resets at 15:00"、"到 15:00 恢复"：今天这个时刻，已经过了就是明天。
  const clock = /(?:\bat|\buntil|\bresets?(?:\s+at)?|\bby|到)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?![\d:])/i;
  if ((m = clock.exec(s)) && (m[2] !== undefined || m[3] !== undefined)) {
    const date = new Date(now);
    let at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour24(Number(m[1]), m[3]), Number(m[2] ?? 0)).getTime();
    if (at <= now) at += 86400000;
    if (valid(at)) return at;
  }
  return null;
}

// ---- 识别 ----

// Claude Code 的 rate_limit_event：status 是 allowed / allowed_warning 以外的值就是被限流了。
const ALLOWED_STATUS = new Set(['allowed', 'allowed_warning']);

// 限流 / 额度：429、rate limit、too many requests、402、余额 / 额度不足、usage limit（Codex）、quota（含 Codex 的 "Quota exceeded"）。
const LIMIT_PATTERNS = [
  /\b429\b/,
  /rate[ _-]?limit(?:ed|s)?\b/i,
  /too many requests/i,
  /\b402\b/,
  /insufficient[ _-]?(?:balance|quota|credits?|funds?)/i,
  /credit balance is too low|out of credits|add credits|purchase more credits/i,
  /quota[ _-]?(?:exceeded|exhausted|reached)|exceeded[^\n]{0,40}quota|\bquota\b/i,
  /usage[ _-]?limit/i,
  /hit your (?:\w+ )?limit/i,
  /余额不足|额度(?:已)?(?:用完|不足|耗尽)|超出额度|请求过于频繁|限流/,
];
// 服务不可用 / 网络：连接类错误码与 fetch failed，以及报错里的 5xx（状态码字样或常见的 5xx 文字）。
const UNAVAILABLE_PATTERNS = [
  /\b(?:ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)\b/,
  /fetch failed/i,
  /(?:status|http|error|code|api error)\W{0,4}5\d\d\b/i,
  /\b5\d\d\s+(?:internal server error|bad gateway|service unavailable|gateway time-?out)/i,
  /service unavailable|bad gateway|gateway time-?out|selected model is at capacity|currently experiencing high demand|overloaded/i,
];

function firstMatch(texts, patterns, secrets) {
  for (const pattern of patterns) {
    for (const text of texts) {
      const match = pattern.exec(text);
      if (match) return { text, match, evidence: evidenceAround(text, match.index, match[0].length, secrets) };
    }
  }
  return null;
}

// 一次失败是不是限流 / 额度用完（limit）或服务不可用 / 网络（unavailable）；都不是返回 { kind: null, evidence: null }。
//  adapter：适配器 id（claude-code / codex / generic / fake…）。generic 只认声明里写了 kind 的 failureHints，不套内置文字规则（它们是别人的程序，文字可能是任务内容）。
//  events：对象数组——Claude Code 的 { type: 'rate_limit_event', rate_limit_info }（取最后一条）与统一事件 { kind: 'error', text }（文字参与匹配）。
//  stderr / stdout：标准错误 / 标准输出的文字（stdout 只在失败原因会写在标准输出里的程序才需要传）。
//  hints：通用适配器声明里的 failureHints（{ match, text, kind? }），只看带 kind 的。
//  now：当前时间（毫秒，测试可注入），用来解析 "in 2 hours" 这类相对时间。
// 返回 { kind, resetsAt?, evidence }：resetsAt 是恢复时间（毫秒时间戳），读不到就没有这个键（调用方按默认 1 小时）；evidence 最多 200 字，已掩码。
export function classifyFailure({ adapter = null, events = [], stderr = '', stdout = '', hints = [], now = Date.now(), secrets = [] } = {}) {
  const list = Array.isArray(events) ? events.filter(object) : [];
  const none = { kind: null, evidence: null };
  const errorTexts = list.filter(event => event.kind === 'error' && typeof event.text === 'string').map(event => event.text);
  const texts = [errorTexts.join('\n'), String(stderr ?? ''), String(stdout ?? '')].filter(text => text.trim() !== '');

  // 1. Claude Code 的 rate_limit_event：看最后一条。
  const rates = list.filter(event => event.type === 'rate_limit_event' && object(event.rate_limit_info));
  const info = rates.at(-1)?.rate_limit_info;
  if (info && typeof info.status === 'string' && !ALLOWED_STATUS.has(info.status)) {
    const at = Number(info.resetsAt);
    const evidence = maskSecrets(`rate_limit_event status=${info.status}${info.rateLimitType ? ` type=${info.rateLimitType}` : ''}${Number.isFinite(at) ? ` resetsAt=${at}` : ''}`, secrets).slice(0, EVIDENCE_LIMIT);
    // resetsAt 是 unix 秒；不是有限数字或已经过去按读不到处理。
    const ms = Number.isFinite(at) && at > 0 ? at * 1000 : null;
    return { kind: 'limit', ...(ms !== null && ms > now && ms - now <= MAX_LIMIT_MS ? { resetsAt: ms } : {}), evidence };
  }

  // 2. 通用适配器声明里带 kind 的失败提示（limit 优先于 unavailable）。
  const declared = (Array.isArray(hints) ? hints : []).filter(hint => object(hint) && (hint.kind === 'limit' || hint.kind === 'unavailable') && typeof hint.match === 'string');
  for (const kind of ['limit', 'unavailable']) {
    for (const hint of declared.filter(item => item.kind === kind)) {
      let pattern;
      try { pattern = new RegExp(hint.match, 'i'); } catch { continue; }
      for (const text of texts) {
        const match = pattern.exec(text);
        if (!match) continue;
        const resetsAt = kind === 'limit' ? parseResetTime(text, now) : null;
        return { kind, ...(resetsAt !== null ? { resetsAt } : {}), evidence: evidenceAround(text, match.index, match[0].length, secrets) };
      }
    }
  }
  if (adapter === 'generic') return none;

  // 3. 内置的文字规则（报错原文）。
  const limited = firstMatch(texts, LIMIT_PATTERNS, secrets);
  if (limited) {
    const resetsAt = parseResetTime(limited.text, now);
    return { kind: 'limit', ...(resetsAt !== null ? { resetsAt } : {}), evidence: limited.evidence };
  }
  const down = firstMatch(texts, UNAVAILABLE_PATTERNS, secrets);
  if (down) return { kind: 'unavailable', evidence: down.evidence };
  return none;
}

// ---- limits.json ----

const limitsFile = home => join(home, 'limits.json');
const validEntry = entry => object(entry) && (entry.kind === 'limit' || entry.kind === 'unavailable') && Number.isFinite(entry.until);

// 读出文件里所有条目（含已过期的）；文件不存在、坏了都当没有。
function readAll(home) {
  try {
    const value = readJson(limitsFile(home));
    const profiles = object(value) && object(value.profiles) ? value.profiles : {};
    return Object.fromEntries(Object.entries(profiles).filter(([, entry]) => validEntry(entry)));
  } catch { return {}; }
}

// 现在仍被限流的执行者：{ <名>: { kind, until, since, evidence } }。恢复时间过了的不返回（读的时候判断，不用定时清理）。
export function activeLimits(home, now = Date.now()) {
  if (!home) return {};
  return Object.fromEntries(Object.entries(readAll(home)).filter(([, entry]) => entry.until > now));
}

// 这个执行者现在是否被限流：返回条目（{ kind, until, since, evidence }），没有或已恢复返回 null。
export function limitOf(home, name, now = Date.now()) {
  return activeLimits(home, now)[name] ?? null;
}

// 被限流到什么时候（毫秒时间戳）；没有被限流返回 null。
export function limitedUntil(home, name, now = Date.now()) {
  return limitOf(home, name, now)?.until ?? null;
}

// 记下某个执行者被限流了：恢复时间用 resetsAt（毫秒），读不到或已过去就是现在 + 1 小时。已过期的条目顺手清掉。原子写（临时文件 + 改名）。
export function recordLimit(home, name, { kind = 'limit', resetsAt = null, evidence = null } = {}, now = Date.now()) {
  const until = Number.isFinite(resetsAt) && resetsAt > now ? resetsAt : now + DEFAULT_LIMIT_MS;
  const profiles = Object.fromEntries(Object.entries(readAll(home)).filter(([, entry]) => entry.until > now));
  const previous = profiles[name];
  const entry = { kind, until, since: previous && previous.until > now ? previous.since : now, evidence: typeof evidence === 'string' ? evidence.slice(0, EVIDENCE_LIMIT) : null };
  profiles[name] = entry;
  mkdirSync(home, { recursive: true });
  const temp = join(home, `.limits-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify({ v: 1, profiles }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, limitsFile(home));
  } finally { rmSync(temp, { force: true }); }
  return entry;
}

// 手动清除某个执行者的限流记录（Stage07c 154，D83 的"已恢复"）：只删它自己的条目，别的执行者的原样保留；原子写。
// 返回是否真的删掉了记录（没有记录时什么都不写，返回 false）。
export function clearLimit(home, name) {
  const profiles = readAll(home);
  if (!Object.hasOwn(profiles, name)) return false;
  delete profiles[name];
  mkdirSync(home, { recursive: true });
  const temp = join(home, `.limits-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify({ v: 1, profiles }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, limitsFile(home));
  } finally { rmSync(temp, { force: true }); }
  return true;
}

// 恢复时间的显示：当天写 HH:MM，别的日子带上月日（本地时间）。
export function clockText(ms, now = Date.now()) {
  const date = new Date(ms), today = new Date(now), two = n => String(n).padStart(2, '0');
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return date.toDateString() === today.toDateString() ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}
