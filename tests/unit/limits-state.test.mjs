import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIMIT_MS, activeLimits, classifyFailure, clockText, limitOf, limitedUntil, maskSecrets, parseResetTime, recordLimit,
} from '../../core/lib/limits-state.mjs';
import { createMapper } from '../../core/adapters/claude-code.mjs';
import { mapLine as codexMapLine } from '../../core/adapters/codex.mjs';
import { makeGeneric } from '../../core/adapters/generic.mjs';
import { route, routeConfigCommand } from '../../core/lib/router.mjs';

// 任务 148：限流 / 额度用完 / 服务不可用的识别（纯函数）与 limits.json 的读写。全部用临时目录与注入的时间，不碰真实公共目录。
const fixture = name => fileURLToPath(new URL(`../fixtures/limits/${name}`, import.meta.url));
const temp = t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-limits-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};
// 固定的"现在"：本地时间 2026-10-26 10:00:00（用本地时间构造，解析出的 HH:MM 才与机器时区无关）。
const NOW = new Date(2026, 9, 26, 10, 0, 0).getTime();
const at = (month, day, hour, minute = 0, year = 2026) => new Date(year, month - 1, day, hour, minute).getTime();
const rateEvent = info => ({ type: 'rate_limit_event', rate_limit_info: info });
const err = text => ({ kind: 'error', text });

test('classifyFailure：Claude Code 的 rate_limit_event——rejected 带 resetsAt 算限流，allowed / allowed_warning 不算', () => {
  const resets = Math.floor(NOW / 1000) + 7200;
  const rejected = classifyFailure({ adapter: 'claude-code', events: [rateEvent({ status: 'rejected', resetsAt: resets, rateLimitType: 'five_hour' })], now: NOW });
  assert.equal(rejected.kind, 'limit');
  assert.equal(rejected.resetsAt, resets * 1000, 'resetsAt 是 unix 秒，返回毫秒时间戳');
  assert.match(rejected.evidence, /status=rejected/);
  assert.match(rejected.evidence, /type=five_hour/);

  for (const status of ['allowed', 'allowed_warning']) {
    assert.deepEqual(classifyFailure({ adapter: 'claude-code', events: [rateEvent({ status, resetsAt: resets })], now: NOW }), { kind: null, evidence: null }, status);
  }
  // 看最后一条：先 rejected 后 allowed 不算；先 allowed 后 rejected 算。
  assert.equal(classifyFailure({ adapter: 'claude-code', events: [rateEvent({ status: 'rejected', resetsAt: resets }), rateEvent({ status: 'allowed', resetsAt: resets })], now: NOW }).kind, null);
  assert.equal(classifyFailure({ adapter: 'claude-code', events: [rateEvent({ status: 'allowed' }), rateEvent({ status: 'rejected' })], now: NOW }).kind, 'limit');
  // 没有 resetsAt、不是数字、已经过去：都没有 resetsAt 键（调用方按默认 1 小时）。
  for (const resetsAt of [undefined, 'soon', Math.floor(NOW / 1000) - 60]) {
    const result = classifyFailure({ adapter: 'claude-code', events: [rateEvent({ status: 'rejected', resetsAt })], now: NOW });
    assert.equal(result.kind, 'limit');
    assert.equal(Object.hasOwn(result, 'resetsAt'), false);
  }
});

test('Claude Code 适配器的映射：rate_limit_event 不产生统一事件，只记在 mapper.rateLimit（最后一条）', () => {
  const mapper = createMapper();
  assert.equal(mapper.rateLimit, null);
  assert.deepEqual(mapper(JSON.stringify(rateEvent({ status: 'allowed', resetsAt: 1 })), { root: '.' }), []);
  assert.deepEqual(mapper(JSON.stringify(rateEvent({ status: 'rejected', resetsAt: 2 })), { root: '.' }), []);
  assert.deepEqual(mapper.rateLimit, { status: 'rejected', resetsAt: 2 });
  // 没有 rate_limit_info 的行照旧当作没有内容的事件。
  assert.deepEqual(createMapper()('{"type":"rate_limit_event"}', { root: '.' }), []);
});

test('classifyFailure：429 / rate limit / too many requests 文字（Claude Code 的出错事件、标准错误）', () => {
  for (const text of ['API Error: 429 Too Many Requests', 'rate limit exceeded, slow down', 'Rate_Limit reached', 'You are being rate-limited', 'too many requests']) {
    const result = classifyFailure({ adapter: 'claude-code', events: [err(text)], now: NOW });
    assert.equal(result.kind, 'limit', text);
    assert.ok(result.evidence.length > 0 && result.evidence.length <= 200);
  }
  assert.equal(classifyFailure({ adapter: 'claude-code', stderr: 'HTTP 429 from upstream\n', now: NOW }).kind, 'limit');
  // 适配器自己的中文失败提示也算。
  assert.equal(classifyFailure({ adapter: 'claude-code', events: [err('请求过于频繁，被限流；稍后重试或降低并发')], now: NOW }).kind, 'limit');
  // 普通失败不算。
  for (const text of ['Execution error', 'exit 1', 'Cannot read properties of undefined', '达到最大轮数仍未完成（error_max_turns）', 'order 4290 shipped']) {
    assert.equal(classifyFailure({ adapter: 'claude-code', events: [err(text)], stderr: text, now: NOW }).kind, null, text);
  }
});

test('classifyFailure：402 / 余额 / quota / 额度', () => {
  for (const text of ['402 Payment Required', 'Insufficient balance', 'insufficient_quota: You exceeded your current quota', 'Your credit balance is too low to access the API', '账户余额或额度不足', '余额不足', 'quota exceeded']) {
    assert.equal(classifyFailure({ adapter: 'claude-code', events: [err(text)], now: NOW }).kind, 'limit', text);
  }
});

test('classifyFailure：Codex 的原文（来自 codex-rs/protocol/src/error.rs，样例文件 codex-usage-limit.jsonl）', () => {
  // 经 Codex 适配器的映射得到出错事件，再识别——和真实流程一致。
  const events = readFileSync(fixture('codex-usage-limit.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap(line => codexMapLine(line, { root: '.' }));
  assert.equal(events.filter(event => event.kind === 'error').length, 2);
  const result = classifyFailure({ adapter: 'codex', events, now: NOW });
  assert.equal(result.kind, 'limit');
  assert.equal(result.resetsAt, at(10, 26, 15, 15), '"try again at 3:15 PM" 是今天 15:15（现在是 10:00）');
  assert.match(result.evidence, /hit your usage limit/);
  assert.ok(result.evidence.length <= 200);

  // 源码里其它几种限流 / 额度 / 容量文字。
  const variants = [
    ['limit', 'You’ve hit your usage limit. To get more access now, send a request to your admin or try again later.'],
    ['limit', 'You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Jan 5th, 2026 3:05 PM.'],
    ['limit', 'You’ve hit your usage limit for GPT-5-Codex. Switch to another model now, or try again at 4:30 PM.'],
    ['limit', 'Your workspace is out of credits. Add credits to continue.'],
    ['limit', 'Quota exceeded. Check your plan and billing details.'],
    ['limit', 'exceeded retry limit, last status: 429 Too Many Requests, request id: abc'],
    ['limit', 'rate limit exceeded: tokens per minute'],
    ['unavailable', 'Selected model is at capacity. Please try a different model.'],
    ['unavailable', 'We’re currently experiencing high demand, which may cause temporary errors.'],
  ];
  for (const [kind, text] of variants) assert.equal(classifyFailure({ adapter: 'codex', events: [err(text)], now: NOW }).kind, kind, text);
  // Codex 把服务端返回的整段 JSON 放进 message，适配器取出里面的状态码与说明后照样识别。
  const mapped = codexMapLine(JSON.stringify({ type: 'error', message: JSON.stringify({ status: 429, error: { message: 'Rate limit reached for requests' } }) }), { root: '.' });
  assert.equal(classifyFailure({ adapter: 'codex', events: mapped, now: NOW }).kind, 'limit');
});

test('classifyFailure：通用适配器——只认声明里带 kind 的 failureHints，不套内置文字规则；limit 优先于 unavailable', () => {
  const hints = [
    { match: 'ECONNRESET|proxy down', text: '网络断了', kind: 'unavailable' },
    { match: 'daily cap|每日额度', text: '额度用完', kind: 'limit' },
    { match: 'not logged in', text: '没登录' },
  ];
  const limit = classifyFailure({ adapter: 'generic', events: [err('Daily CAP reached, try again in 90 minutes')], hints, now: NOW });
  assert.equal(limit.kind, 'limit');
  assert.equal(limit.resetsAt, NOW + 90 * 60000, '"try again in 90 minutes"');
  assert.equal(classifyFailure({ adapter: 'generic', stderr: 'proxy down\n', hints, now: NOW }).kind, 'unavailable');
  assert.equal(classifyFailure({ adapter: 'generic', stderr: 'daily cap and proxy down', hints, now: NOW }).kind, 'limit');
  // 没写 kind 的提示不算；内置规则对通用适配器不生效（它们是别人的程序，429 可能是任务内容）。
  assert.equal(classifyFailure({ adapter: 'generic', stderr: 'not logged in', hints, now: NOW }).kind, null);
  assert.equal(classifyFailure({ adapter: 'generic', stderr: '429 Too Many Requests', hints, now: NOW }).kind, null);
  assert.equal(classifyFailure({ adapter: 'generic', stderr: '429 Too Many Requests', now: NOW }).kind, null);
  // 通用适配器把写了 kind 的提示交出来（limitHints），没写的不在里面。
  const adapter = makeGeneric({ label: 'x', executable: 'x', args: ['{prompt}'], failureHints: hints });
  assert.deepEqual(adapter.limitHints.map(hint => hint.kind), ['unavailable', 'limit']);
  assert.deepEqual(makeGeneric({ label: 'x', executable: 'x', args: ['{prompt}'] }).limitHints, []);
  // 标准输出里的原因（stdout 参数）同样参与。
  assert.equal(classifyFailure({ adapter: 'generic', stdout: 'error: 每日额度已用完', hints, now: NOW }).kind, 'limit');
});

test('classifyFailure：网络错误与 5xx 是 unavailable（不带恢复时间）', () => {
  for (const text of ['connect ECONNREFUSED 127.0.0.1:443', 'getaddrinfo ENOTFOUND api.example.test', 'read ECONNRESET', 'ETIMEDOUT', 'getaddrinfo EAI_AGAIN host', 'TypeError: fetch failed', 'API Error: 503 Service Unavailable', 'status 502', 'HTTP 500 Internal Server Error', 'upstream returned status: 504', '529 overloaded_error']) {
    const result = classifyFailure({ adapter: 'claude-code', events: [err(text)], now: NOW });
    assert.equal(result.kind, 'unavailable', text);
    assert.equal(Object.hasOwn(result, 'resetsAt'), false, text);
  }
  // 5xx 要有状态码字样；单独的数字、文件数不算。
  for (const text of ['processed 500 files', 'line 503 of the file', 'port 5000']) assert.equal(classifyFailure({ adapter: 'claude-code', stderr: text, now: NOW }).kind, null, text);
  // 限流优先：同时出现 429 与网络错误按限流算。
  assert.equal(classifyFailure({ adapter: 'claude-code', stderr: 'ETIMEDOUT then 429 Too Many Requests', now: NOW }).kind, 'limit');
});

test('parseResetTime：Codex 的两种时间写法、相对时间、Claude 订阅提示、ISO；读不到、过去、太远都是 null', () => {
  // Codex（format_retry_timestamp）：当天 "3:15 PM"，不是当天 "Jan 5th, 2026 3:05 PM"；另有 "20 Aug 2026, 16:29"。
  assert.equal(parseResetTime('Try again at 3:15 PM.', NOW), at(10, 26, 15, 15));
  assert.equal(parseResetTime('or try again at 12:05 AM.', NOW), at(10, 27, 0, 5), '现在 10:00，00:05 已过，算明天');
  assert.equal(parseResetTime('Try again at 12:30 PM.', NOW), at(10, 26, 12, 30));
  assert.equal(parseResetTime('or try again at Nov 3rd, 2026 3:05 PM.', NOW), at(11, 3, 15, 5));
  assert.equal(parseResetTime('try again at Nov 1st, 2026 11:59 AM', NOW), at(11, 1, 11, 59));
  assert.equal(parseResetTime('Upgrade your plan or add credits to continue, or try again at 5 Nov 2026, 16:29.', NOW), at(11, 5, 16, 29));
  // 相对时间。
  assert.equal(parseResetTime('Please try again in 2 hours 5 minutes.', NOW), NOW + (2 * 60 + 5) * 60000);
  assert.equal(parseResetTime('retry after 30 seconds', NOW), NOW + 30000);
  assert.equal(parseResetTime('Retry-After: 120', NOW), NOW + 120000);
  assert.equal(parseResetTime('try again in 1h30m', NOW), NOW + 90 * 60000);
  assert.equal(parseResetTime('额度已用完，请 3 小时 10 分钟后再试', NOW), NOW + (3 * 60 + 10) * 60000);
  // Claude 订阅提示。
  assert.equal(parseResetTime('5-hour limit reached ∙ resets 3pm', NOW), at(10, 26, 15));
  assert.equal(parseResetTime('limit will reset at 15:00', NOW), at(10, 26, 15));
  assert.equal(parseResetTime('resets 9am', NOW), at(10, 27, 9));
  // ISO 日期时间。
  assert.equal(parseResetTime('quota resets 2026-10-27T08:30:00Z', NOW), Date.parse('2026-10-27T08:30:00Z'));
  // 读不到 / 已经过去 / 离现在超过 14 天 / 不像时间的数字。
  for (const text of ['Try again later.', 'too many requests', 'resets at 2026', 'try again at 2020-01-01T00:00:00Z', 'try again in 400 days', 'in 3 files']) assert.equal(parseResetTime(text, NOW), null, text);
});

test('classifyFailure：文字里的恢复时间进 resetsAt，读不到就没有这个键；evidence 最多 200 字', () => {
  assert.equal(classifyFailure({ adapter: 'claude-code', events: [err('429 rate limit, try again in 20 minutes')], now: NOW }).resetsAt, NOW + 20 * 60000);
  assert.equal(Object.hasOwn(classifyFailure({ adapter: 'claude-code', events: [err('429 Too Many Requests')], now: NOW }), 'resetsAt'), false);
  const long = classifyFailure({ adapter: 'claude-code', events: [err(`429 ${'很长的说明 '.repeat(200)}`)], now: NOW });
  assert.equal(long.kind, 'limit');
  assert.ok(long.evidence.length <= 200, `${long.evidence.length}`);
});

test('密钥掩码：evidence 与 maskSecrets 不留下 Key、令牌、赋值里的值', () => {
  const key = 'sk-abcdefgh12345';
  const result = classifyFailure({ adapter: 'claude-code', events: [err(`429 Too Many Requests for key ${key}, Authorization: Bearer abcdef0123456789tokenvalue, api_key=hunter2hunter2, token: s3cr3t-value-xyz`)], now: NOW });
  assert.equal(result.kind, 'limit');
  for (const secret of [key, 'abcdef0123456789tokenvalue', 'hunter2hunter2', 's3cr3t-value-xyz']) assert.ok(!result.evidence.includes(secret), `evidence 里还有 ${secret}：${result.evidence}`);
  assert.match(result.evidence, /\*\*\*/);
  // 已知的密钥值（调用方传入）整段替换；长串的无空格字母数字也掩掉。
  assert.equal(maskSecrets('value=MyVerySecret1 end', ['MyVerySecret1']), 'value=*** end');
  assert.equal(maskSecrets(`id ${'a1B2'.repeat(10)} end`), 'id *** end');
  assert.equal(maskSecrets('429 Too Many Requests'), '429 Too Many Requests', '普通文字不动');
  // 本机的用户目录写成 <HOME>，不把用户名路径带进 limits.json 和进度。
  const own = path.join(os.homedir(), 'project', 'file.txt');
  const located = classifyFailure({ adapter: 'claude-code', events: [err(`429 Too Many Requests while writing ${own}`)], now: NOW });
  assert.ok(!located.evidence.includes(os.homedir()), located.evidence);
  assert.match(located.evidence, /<HOME>/);
});

test('limits.json：写入（原子）、读取、恢复时间过了自动失效、默认 1 小时、不存密钥', t => {
  const home = path.join(temp(t), 'home');
  assert.deepEqual(activeLimits(home, NOW), {}, '目录不存在也不报错');
  assert.equal(limitedUntil(home, 'alpha', NOW), null);

  const entry = recordLimit(home, 'alpha', { kind: 'limit', resetsAt: NOW + 7200000, evidence: '429 usage limit sk-abcdefgh12345' }, NOW);
  assert.deepEqual([entry.kind, entry.until, entry.since], ['limit', NOW + 7200000, NOW]);
  const file = path.join(home, 'limits.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.v, 1);
  assert.deepEqual(Object.keys(raw.profiles), ['alpha']);
  assert.deepEqual(Object.keys(raw.profiles.alpha).sort(), ['evidence', 'kind', 'since', 'until']);
  assert.deepEqual(readdirSync(home).filter(name => name.endsWith('.tmp')), [], '没有残留的临时文件');
  assert.equal(limitedUntil(home, 'alpha', NOW + 1000), NOW + 7200000);
  assert.equal(limitOf(home, 'alpha', NOW + 1000).kind, 'limit');
  assert.equal(limitedUntil(home, 'beta', NOW), null);
  // 恰好到点、过了：失效（读的时候判断，文件不动）。
  assert.equal(limitedUntil(home, 'alpha', NOW + 7200000), null);
  assert.equal(limitedUntil(home, 'alpha', NOW + 9000000), null);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).profiles.alpha, '读取不删文件里的条目');

  // 读不到恢复时间：默认现在 + 1 小时；已经过去的 resetsAt 同样按默认。
  assert.equal(recordLimit(home, 'beta', { kind: 'limit' }, NOW).until, NOW + DEFAULT_LIMIT_MS);
  assert.equal(recordLimit(home, 'gamma', { kind: 'limit', resetsAt: NOW - 5000 }, NOW).until, NOW + DEFAULT_LIMIT_MS);
  assert.equal(DEFAULT_LIMIT_MS, 3600000);
  // 同一个执行者再次被限流：since 保留第一次的时间，until 更新；写入时顺手清掉别人已过期的条目。
  const again = recordLimit(home, 'alpha', { kind: 'limit', resetsAt: NOW + 8000000 }, NOW + 3000000);
  assert.deepEqual([again.since, again.until], [NOW, NOW + 8000000]);
  recordLimit(home, 'delta', { kind: 'limit' }, NOW + 9000000);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).profiles), ['delta'], '过期的 alpha / beta / gamma 被清掉');

  // 坏文件、格式不对的条目当作没有。
  writeFileSync(file, '{坏的');
  assert.deepEqual(activeLimits(home, NOW), {});
  writeFileSync(file, JSON.stringify({ v: 1, profiles: { a: { kind: 'limit', until: NOW + 1000 }, b: { kind: 'other', until: NOW + 1000 }, c: 'x', d: { kind: 'limit', until: 'soon' } } }));
  assert.deepEqual(Object.keys(activeLimits(home, NOW)), ['a']);
  // BOM 也认。
  writeFileSync(file, `${String.fromCharCode(0xfeff)}${JSON.stringify({ v: 1, profiles: { a: { kind: 'limit', until: NOW + 1000 } } })}`);
  assert.deepEqual(Object.keys(activeLimits(home, NOW)), ['a']);
});

test('clockText：当天 HH:MM，别的日子带月日', () => {
  assert.equal(clockText(at(10, 26, 15, 5), NOW), '15:05');
  assert.equal(clockText(at(10, 26, 9, 0), NOW), '09:00');
  assert.equal(clockText(at(10, 27, 8, 30), NOW), '10月27日 08:30');
});

const profile = (extra = {}) => ({ adapter: 'fake', label: '假', enabled: true, ...extra });
const config = () => ({
  v: 2, defaultProfile: 'beta', profiles: { alpha: profile(), beta: profile(), gamma: profile() },
  routing: { rules: [{ types: ['docs'], profile: 'alpha' }, { types: ['docs'], profile: 'gamma' }], fallback: 'beta' },
});

test('路由：被限流的执行者在规则 / 兜底 / 默认里被跳过并写 trace，恢复后重新可用；skip 同理', t => {
  const home = path.join(temp(t), 'home');
  recordLimit(home, 'alpha', { kind: 'limit', resetsAt: at(10, 26, 15) }, NOW);
  const result = route({ spec: { type: 'docs' }, config: config(), home, now: NOW });
  assert.equal(result.profile, 'gamma', '跳过被限流的 alpha，用下一条规则');
  assert.ok(result.trace.some(line => /规则 1.*alpha.*被限流（额度到 15:00 恢复），跳过/.test(line)), result.trace.join('\n'));
  // 恢复时间过后（注入时间）重新可用。
  assert.equal(route({ spec: { type: 'docs' }, config: config(), home, now: at(10, 26, 15) }).profile, 'alpha');
  assert.equal(route({ spec: { type: 'docs' }, config: config(), home, now: at(10, 26, 15, 1) }).profile, 'alpha');
  // 规则里的都不可用就到兜底；兜底也被限流就到默认执行者（beta 同时是兜底与默认，去重后没有别人）→ NO_PROFILE。
  recordLimit(home, 'gamma', { kind: 'limit', resetsAt: at(10, 26, 15) }, NOW);
  assert.equal(route({ spec: { type: 'docs' }, config: config(), home, now: NOW }).profile, 'beta');
  recordLimit(home, 'beta', { kind: 'limit', resetsAt: at(10, 26, 15) }, NOW);
  assert.throws(() => route({ spec: { type: 'docs' }, config: config(), home, now: NOW }), error => error.code === 'NO_PROFILE' && error.trace.some(line => /兜底：beta：被限流/.test(line)));
  // skip：这个任务里已经换掉的执行者。
  const clean = path.join(temp(t), 'clean');
  assert.equal(route({ spec: { type: 'docs' }, config: config(), home: clean, now: NOW, skip: ['alpha'] }).profile, 'gamma');
  assert.equal(route({ spec: { type: 'docs' }, config: config(), home: clean, now: NOW, skip: ['alpha', 'gamma'] }).profile, 'beta');
  assert.throws(() => route({ spec: { type: 'docs' }, config: config(), home: clean, now: NOW, skip: ['alpha', 'gamma', 'beta'] }), error => error.code === 'NO_PROFILE');
});

test('路由：命令行 / 任务说明明确指定的照旧使用，trace 里提示被限流到几点', t => {
  const home = path.join(temp(t), 'home');
  recordLimit(home, 'alpha', { kind: 'limit', resetsAt: at(10, 26, 15) }, NOW);
  const explicit = route({ spec: { type: 'docs' }, config: config(), home, now: NOW, explicit: 'alpha' });
  assert.equal(explicit.profile, 'alpha');
  assert.deepEqual(explicit.trace, ['alpha 被限流（额度到 15:00 恢复），按明确指定仍使用', '命令行指定：alpha'], '最后一行仍是原来的"命令行指定"');
  const pinned = route({ spec: { type: 'docs', worker: 'alpha' }, config: config(), home, now: NOW });
  assert.equal(pinned.profile, 'alpha');
  assert.deepEqual(pinned.trace, ['alpha 被限流（额度到 15:00 恢复），按明确指定仍使用', '任务说明指定：alpha']);
  // 没被限流时 trace 与以前逐字相同。
  assert.deepEqual(route({ spec: { type: 'docs' }, config: config(), home: path.join(temp(t), 'none'), now: NOW, explicit: 'alpha' }).trace, ['命令行指定：alpha']);
});

test('ar route config：被限流的执行者多一行"额度到 HH:MM 恢复"，--json 的 profiles 里多 limited 字段；没被限流时输出不变', t => {
  const home = path.join(temp(t), 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(config()));
  const before = routeConfigCommand(['config'], { home });
  assert.ok(before.result.profiles.every(item => !Object.hasOwn(item, 'limited')));
  assert.ok(!before.text.includes('额度到'));
  const until = Date.now() + 2 * 3600000;
  recordLimit(home, 'alpha', { kind: 'limit', resetsAt: until }, Date.now());
  const after = routeConfigCommand(['config'], { home });
  const alpha = after.result.profiles.find(item => item.name === 'alpha');
  assert.deepEqual([alpha.limited.kind, alpha.limited.until], ['limit', until]);
  assert.ok(!Object.hasOwn(after.result.profiles.find(item => item.name === 'beta'), 'limited'));
  // 只加行：原来的行一行不少、顺序不变，多出的一行紧跟在 alpha 那一行后面。
  const lines = after.text.split('\n');
  assert.deepEqual(lines.filter(line => !line.includes('额度到')), before.text.split('\n'));
  const index = lines.findIndex(line => line.startsWith('执行者 alpha：'));
  assert.equal(lines[index + 1], `  alpha：额度到 ${clockText(until)} 恢复`);
  assert.ok(existsSync(path.join(home, 'limits.json')));
});

test('ar route config --json：limited 带记录时的限流原文 evidence；记录里没有原文就没有这个键', t => {
  const home = path.join(temp(t), 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(config()));
  const until = Date.now() + 2 * 3600000;
  recordLimit(home, 'alpha', { kind: 'limit', resetsAt: until, evidence: '429 usage limit reached' }, Date.now());
  recordLimit(home, 'beta', { kind: 'limit', resetsAt: until }, Date.now());
  const { result } = routeConfigCommand(['config'], { home });
  assert.equal(result.profiles.find(item => item.name === 'alpha').limited.evidence, '429 usage limit reached');
  const beta = result.profiles.find(item => item.name === 'beta').limited;
  assert.equal(beta.kind, 'limit');
  assert.equal(Object.hasOwn(beta, 'evidence'), false);
});
