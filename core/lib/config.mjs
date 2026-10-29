import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homeDirectory, legacyHomeFor, userDirectory, noWatchEnv, pickName } from './compat.mjs';
import os from 'node:os';
import { parseJson } from './json.mjs';
import { concurrencyCap, estimateConcurrency, machineCores, currentLoad, memLowPercentDefault, memLowPercentMax, validMemLowPercent } from './schedule.mjs';
import { PROXY_MODES, validateProxyUrl, resolveProxy, proxyText } from './proxy.mjs';

export { homeDirectory, userDirectory };
// codex 执行者的派发设置与窗口策略的内置默认值。
export const defaults = { model: null, effort: null, tier: null, sandbox: 'workspace-write', path: null, watchWindow: 'auto' };
const codexKeys = ['model', 'effort', 'tier', 'sandbox', 'path'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const noProfile = '还没有可用的执行者：在软件的 Agent 页导入，或运行 ar agents 查看';

function validate(key, value, source) {
  if (key === 'managed') { if (typeof value !== 'boolean') throw new Error(`${source} 的 managed 必须为布尔值`); return; }
  if (value == null) return;
  if (typeof value !== 'string') throw new Error(`${source} 的 ${key} 必须为字符串或 null`);
  if (key === 'watchWindow' && !['auto', 'always', 'never'].includes(value)) throw new Error(`${source} 的 watchWindow 必须为 auto、always 或 never`);
  if (key === 'path' && !isAbsolute(value)) throw new Error(`${source} 的 path 必须是绝对路径`);
}

// v1（DispatchDock）→ v2：agents.codex 变成名为 codex 的 profile；未知字段原样保留。
export function migrateV1(v1 = {}) {
  if (v1.agents != null && !object(v1.agents)) throw new Error('config.json 的 agents 必须为对象');
  if (v1.agents?.codex != null && !object(v1.agents.codex)) throw new Error('config.json 的 agents.codex 必须为对象');
  const { v, agents, watchWindow, managed, ...rest } = v1;
  const { codex = {}, ...otherAgents } = agents ?? {};
  const codexProfile = { adapter: 'codex', label: 'Codex', enabled: true, ...codex };
  return {
    ...rest, v: 2, defaultProfile: 'codex',
    profiles: { codex: codexProfile },
    generics: {}, routing: { rules: [], fallback: null, reviewer: null },
    concurrency: 2, managed: managed ?? false, ...(watchWindow !== undefined ? { watchWindow } : {}),
    ...(Object.keys(otherAgents).length ? { agents: otherAgents } : {}),
  };
}
// 没有配置时的内置默认：等同于迁移一份空的 v1 配置（Codex 可用，与 DispatchDock 行为一致）。
// 配置存在却读不了时不走这里（协议第 4 节：拒绝，不回退到内置默认的真实 Codex）。
export const builtinConfig = () => migrateV1({});
// 首次写入（config init、首次引导）时把默认值显式写进文件，之后来源显示 config.json（继承 v1 的写法）。
const initialConfig = () => migrateV1({ agents: { codex: { model: null, effort: null, tier: null, sandbox: 'workspace-write' } }, watchWindow: 'auto', managed: false });

// ENOENT 与 ENOTDIR 都算"没有这个文件"：公共目录被一个文件占着时，Linux 返回 ENOTDIR，Windows 返回 ENOENT。
const absent = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';

function readJson(file, read = readFileSync) {
  let text;
  try { text = read(file, 'utf8'); }
  catch (error) { return { exists: !absent(error), reason: absent(error) ? null : `读取失败：${error.code}` }; }
  let value;
  try { value = parseJson(text); }
  catch { return { exists: true, reason: '不是有效的 JSON' }; }
  if (!object(value) || ![1, 2].includes(value.v)) return { exists: true, reason: 'v 不是 1 或 2' };
  return { exists: true, reason: null, value };
}

// 只读：返回 v2 配置。v1 文件按 v2 解读（upgraded）；新目录没有配置时，带回旧目录里可迁移的 v1 配置（legacy）。
// read：读文件的函数，默认 readFileSync，可注入以模拟不同平台的错误码（测试用）。
export function readConfig(home, read = readFileSync) {
  const file = join(home, 'config.json'), state = readJson(file, read);
  if (state.value) {
    const upgraded = state.value.v === 1;
    return { file, exists: true, reason: null, config: upgraded ? migrateV1(state.value) : state.value, upgraded };
  }
  if (state.reason) return { file, exists: true, reason: state.reason, config: {} };
  const legacyFile = join(legacyHomeFor(home), 'config.json');
  if (legacyFile !== file) {
    const legacy = readJson(legacyFile, read);
    if (legacy.value?.v === 1) return { file, exists: false, reason: null, config: {}, legacy: { file: legacyFile, config: migrateV1(legacy.value) } };
  }
  return { file, exists: false, reason: null, config: {} };
}

// 配置文件存在却读不了（不是 JSON、v 不是 1 或 2、读取出错）：一律拒绝（协议第 4 节，Stage05 058 事故——
// 回退到内置默认等于悄悄改用真实 Codex）。action：派发族与只读命令是"这次没有派发"（协议原文），
// 写入类命令换成"这次没有改动配置"，其余文字与路径不变。
export function configInvalid(state, action = '这次没有派发') {
  return Object.assign(new Error(`配置：config.json 无法读取（${state.reason}）。为免改用你没有选的执行者，${action}。请修好这个文件，或者删掉它（删掉后按内置默认）：${state.file}`), { arCode: 'CONFIG_INVALID' });
}

// Windows 上 config.json 的原子替换可能收到 EPERM / EBUSY（192；占用来源尚未确认）。
// 只对这两种错误、只在 Windows 上有界重试：首次立即尝试，再最多 4 次，每次间隔 50ms（额外总等待至多 200ms）。
// 其他平台、其他错误码原样抛出；等待用 Atomics.wait，保持同步 API、核心仍是零依赖。
const renameRetryCodes = new Set(['EPERM', 'EBUSY']);
const renameRetryLimit = 4;
const renameRetryDelay = 50;
const sleepSync = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try { return renameSync(from, to); }
    catch (error) {
      if (process.platform !== 'win32' || !renameRetryCodes.has(error?.code) || attempt >= renameRetryLimit) throw error;
      sleepSync(renameRetryDelay);
    }
  }
}

function writeAtomic(home, file, config) {
  mkdirSync(home, { recursive: true });
  const temp = join(home, `.config-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameWithRetry(temp, file);
  } catch (error) {
    // 替换失败时清理临时文件；清理也失败就把它留在原处，不能让清理错误盖过原来的失败原因（192）。
    try { rmSync(temp, { force: true }); } catch { /* 删不掉的临时文件保留原样，原错误照原样抛出 */ }
    throw error;
  }
  rmSync(temp, { force: true });
}

// provider：OpenAI 兼容接口（经 Codex 外壳）。只有 codex 适配器的执行者可以写；
// secrets 里正好一个变量，它的键就是 Codex 的 env_key（启动时由核心注入）。
function validateProvider(name, profile) {
  const at = `config.json 的 profiles.${name}`;
  const { provider } = profile;
  if (profile.adapter !== 'codex') throw new Error(`${at}.provider 只能用于 codex 适配器的执行者（OpenAI 兼容接口经 Codex 外壳）`);
  if (!object(provider)) throw new Error(`${at}.provider 必须为对象`);
  if (typeof provider.baseUrl !== 'string' || !provider.baseUrl) throw new Error(`${at}.provider.baseUrl 必须填写接口地址（http:// 或 https:// 开头）`);
  let url;
  try { url = new URL(provider.baseUrl); } catch { throw new Error(`${at}.provider.baseUrl 不是有效的地址（需要 http:// 或 https:// 开头）`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${at}.provider.baseUrl 只接受 http:// 或 https:// 开头的地址`);
  if (url.username || url.password) throw new Error(`${at}.provider.baseUrl 里不能带用户名和密码；密钥请放在 secrets 里`);
  if (provider.wireApi === 'chat') throw new Error(`${at}.provider.wireApi 不能是 chat：Codex 0.163 起不再支持 Chat Completions，只能用 responses；服务只支持 Chat Completions 时，请改用"Claude Code 兼容后端"或通用适配器`);
  if (provider.wireApi != null && provider.wireApi !== 'responses') throw new Error(`${at}.provider.wireApi 只接受 responses`);
  if (typeof profile.model !== 'string' || !profile.model) throw new Error(`${at}.model 必须填写（有 provider 时必填）`);
  if (profile.auth === 'login') throw new Error(`${at} 有 provider 时 auth 必须为 token`);
  const keys = Object.keys(profile.secrets ?? {});
  if (keys.length !== 1) throw new Error(`${at}.secrets 有 provider 时必须正好有一个密钥变量（现在有 ${keys.length} 个）`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keys[0])) throw new Error(`${at}.secrets 的键必须是环境变量名（它就是 Codex 的 env_key）`);
}

// familyRules（Stage07c 154，D88）：模型名前缀 → 模型家族，补充或覆盖 core/templates/model-families.json。family 只能是小写字母、数字、连字符。
export const FAMILY_NAME = /^[a-z0-9-]+$/;
function validateFamilyRules(rules) {
  if (rules == null) return;
  if (!Array.isArray(rules)) throw new Error('config.json 的 familyRules 必须为数组');
  rules.forEach((rule, index) => {
    const at = `config.json 的 familyRules[${index}]`;
    if (!object(rule)) throw new Error(`${at} 必须为对象（prefix、family）`);
    if (typeof rule.prefix !== 'string' || !rule.prefix.trim()) throw new Error(`${at}.prefix 必须为非空字符串`);
    if (typeof rule.family !== 'string' || !FAMILY_NAME.test(rule.family)) throw new Error(`${at}.family 必须是由小写字母、数字、连字符组成的非空字符串`);
  });
}

// routing（路由器用）：rules 每条 { types: [字符串], profile: 字符串, escalate?: 字符串 | null, effort?: 字符串 | null }，fallback 与 strongExecutor 是字符串或 null，reviewer 见下。
function validateRouting(routing) {
  if (routing == null) return;
  if (!object(routing)) throw new Error('config.json 的 routing 必须为对象');
  if (routing.rules != null) {
    if (!Array.isArray(routing.rules)) throw new Error('config.json 的 routing.rules 必须为数组');
    routing.rules.forEach((rule, index) => {
      const at = `config.json 的 routing.rules[${index}]`;
      if (!object(rule)) throw new Error(`${at} 必须为对象`);
      if (!Array.isArray(rule.types) || rule.types.some(item => typeof item !== 'string')) throw new Error(`${at}.types 必须为字符串数组`);
      if (typeof rule.profile !== 'string' || !rule.profile) throw new Error(`${at}.profile 必须为执行者名`);
      if (rule.escalate != null && typeof rule.escalate !== 'string') throw new Error(`${at}.escalate 必须为字符串或 null`);
      if (rule.effort != null && (typeof rule.effort !== 'string' || !rule.effort.trim())) throw new Error(`${at}.effort 必须为非空字符串或 null`);
    });
  }
  if (routing.fallback != null && typeof routing.fallback !== 'string') throw new Error('config.json 的 routing.fallback 必须为字符串或 null');
  // strongExecutor（默认升级链，Stage07c T8）：最后一次自动重试换用的"强执行者"名或 null。这里只校验形状：
  // 名字指向的执行者之后被删除 / 停用时配置仍然有效，派发时按"没有强执行者"处理并写进度；设置命令（ar route strong set）才校验存在。
  if (routing.strongExecutor != null && (typeof routing.strongExecutor !== 'string' || !routing.strongExecutor.trim())) throw new Error('config.json 的 routing.strongExecutor 必须为执行者名（非空字符串）或 null');
  // reviewer：{ profiles: [执行者名], mustDiffer, differFamily, differFromLead }（190 D128 起三个布尔开关都可关）；
  // 兼容只写一个 profile 的旧写法（对象或字符串）；null 或不写按空处理。
  const reviewer = routing.reviewer;
  if (reviewer != null && typeof reviewer !== 'string') {
    if (!object(reviewer)) throw new Error('config.json 的 routing.reviewer 必须为对象、字符串或 null');
    if (reviewer.profiles != null && (!Array.isArray(reviewer.profiles) || reviewer.profiles.some(name => typeof name !== 'string'))) throw new Error('config.json 的 routing.reviewer.profiles 必须为字符串数组');
    if (reviewer.profile != null && typeof reviewer.profile !== 'string') throw new Error('config.json 的 routing.reviewer.profile 必须为字符串');
    if (reviewer.mustDiffer != null && typeof reviewer.mustDiffer !== 'boolean') throw new Error('config.json 的 routing.reviewer.mustDiffer 必须为布尔值');
    if (reviewer.differFamily != null && typeof reviewer.differFamily !== 'boolean') throw new Error('config.json 的 routing.reviewer.differFamily 必须为布尔值');
    if (reviewer.differFromLead != null && typeof reviewer.differFromLead !== 'boolean') throw new Error('config.json 的 routing.reviewer.differFromLead 必须为布尔值');
  }
}

// review（审查设置，Stage08 T3）：全局 config.json 与项目 project.json 共用。只允许 default（布尔）、block（none | high）、
// maxReworks（0～5 的整数）三个键；null 与不写都表示没设。at 是出错信息里的位置前缀。
export const REVIEW_BLOCKS = ['none', 'high'];
export const REVIEW_DEFAULTS = Object.freeze({ default: false, block: 'none', maxReworks: 1 });
export const MAX_REWORKS_LIMIT = 5;
export function validateReviewSetting(review, at = 'config.json 的 review') {
  if (review == null) return;
  if (!object(review)) throw new Error(`${at} 必须为对象（default、block、maxReworks）`);
  for (const key of Object.keys(review)) if (!Object.hasOwn(REVIEW_DEFAULTS, key)) throw new Error(`${at} 不认识的键：${key}（只有 default、block、maxReworks）`);
  if (review.default !== undefined && typeof review.default !== 'boolean') throw new Error(`${at}.default 必须为布尔值`);
  if (review.block !== undefined && !REVIEW_BLOCKS.includes(review.block)) throw new Error(`${at}.block 必须为 ${REVIEW_BLOCKS.join(' 或 ')}`);
  if (review.maxReworks !== undefined && !(Number.isInteger(review.maxReworks) && review.maxReworks >= 0 && review.maxReworks <= MAX_REWORKS_LIMIT)) throw new Error(`${at}.maxReworks 必须是 0～${MAX_REWORKS_LIMIT} 的整数`);
}

// proxy（网络代理，Stage07 099）：{ mode: off | system | manual, url? }。manual 时 url 必须合法；
// 地址里带用户名或密码一律拒绝（任何模式下都不允许把凭据留在配置文件里）。
function validateProxy(proxy) {
  if (proxy == null) return;
  if (!object(proxy)) throw new Error('config.json 的 proxy 必须为对象');
  if (!PROXY_MODES.includes(proxy.mode)) throw new Error(`config.json 的 proxy.mode 必须为 ${PROXY_MODES.join('、')} 之一`);
  const url = proxy.url;
  if (proxy.mode === 'manual' || (url != null && url !== '')) {
    if (url != null && typeof url !== 'string') throw new Error('config.json 的 proxy.url 必须为字符串');
    const checked = validateProxyUrl(url);
    if (!checked.ok && (proxy.mode === 'manual' || checked.code === 'PROXY_CREDENTIALS')) throw new Error(`config.json 的 proxy.url ${checked.error}`);
  }
}

export function validateV2(config) {
  validateProxy(config.proxy);
  if (config.profiles != null && !object(config.profiles)) throw new Error('config.json 的 profiles 必须为对象');
  for (const [name, profile] of Object.entries(config.profiles ?? {})) {
    if (!object(profile)) throw new Error(`config.json 的 profiles.${name} 必须为对象`);
    if (typeof profile.adapter !== 'string' || !profile.adapter) throw new Error(`config.json 的 profiles.${name}.adapter 必须为非空字符串`);
    if (profile.enabled !== undefined && typeof profile.enabled !== 'boolean') throw new Error(`config.json 的 profiles.${name}.enabled 必须为布尔值`);
    // env 与 secrets：值都是字符串；secrets 的值是"从哪个环境变量读"的变量名，不是密钥本身。
    for (const key of ['env', 'secrets']) {
      if (profile[key] != null && (!object(profile[key]) || Object.values(profile[key]).some(v => typeof v !== 'string'))) throw new Error(`config.json 的 profiles.${name}.${key} 必须为字符串映射`);
    }
    if (Object.values(profile.secrets ?? {}).some(v => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))) throw new Error(`config.json 的 profiles.${name}.secrets 的值必须是环境变量名`);
    // 认证方式（D18）：login 沿用 CLI 自己的登录；token 必须写明从哪些环境变量注入。
    if (profile.auth !== undefined && !['login', 'token'].includes(profile.auth)) throw new Error(`config.json 的 profiles.${name}.auth 必须为 login 或 token`);
    if (profile.auth === 'token' && !Object.keys(profile.secrets ?? {}).length) throw new Error(`config.json 的 profiles.${name} 的 auth 为 token，但 secrets 为空`);
    if (profile.maxTurns != null && !(Number.isInteger(profile.maxTurns) && profile.maxTurns > 0)) throw new Error(`config.json 的 profiles.${name}.maxTurns 必须为正整数或 null`);
    if (profile.label != null && typeof profile.label !== 'string') throw new Error(`config.json 的 profiles.${name}.label 必须为字符串`);
    // 角色设置（Stage07c T4、190 D128）：roles 是 executor / reviewer / lead 的非空子集，没写是执行者与审查者；
    // modelFamilies 是用户声明的"可能用到的模型家族"。
    if (profile.roles != null) {
      const roles = profile.roles;
      if (!Array.isArray(roles) || !roles.length || roles.some(role => !['executor', 'reviewer', 'lead'].includes(role)) || new Set(roles).size !== roles.length) throw new Error(`config.json 的 profiles.${name}.roles 必须是 executor、reviewer、lead 中的一项或几项（不重复）`);
    }
    if (profile.modelFamilies != null && (!Array.isArray(profile.modelFamilies) || profile.modelFamilies.some(item => typeof item !== 'string' || !item.trim()))) throw new Error(`config.json 的 profiles.${name}.modelFamilies 必须为非空字符串数组`);
    if (profile.adapter === 'codex') for (const key of codexKeys) validate(key, profile[key], 'config.json');
    else validate('path', profile.path, 'config.json');
    if (profile.provider != null) validateProvider(name, profile);
    // 每日上限（路由器用）：不写或 null 表示不限；写了必须是正整数。
    if (profile.limits != null) {
      if (!object(profile.limits)) throw new Error(`config.json 的 profiles.${name}.limits 必须为对象`);
      for (const key of ['maxTasksPerDay', 'maxTokensPerDay']) {
        const value = profile.limits[key];
        if (value != null && !(Number.isSafeInteger(value) && value > 0)) throw new Error(`config.json 的 profiles.${name}.limits.${key} 必须为正整数或 null`);
      }
    }
  }
  validateRouting(config.routing);
  validateFamilyRules(config.familyRules);
  validateReviewSetting(config.review);
  if (config.defaultProfile != null && typeof config.defaultProfile !== 'string') throw new Error('config.json 的 defaultProfile 必须为字符串或 null');
  if (config.managed !== undefined) validate('managed', config.managed, 'config.json');
  validate('watchWindow', config.watchWindow, 'config.json');
  return config;
}

// 并发名额上限（协议 15.5）：concurrency 是任务名额（默认 2），gateConcurrency 是门禁名额（默认 1）。
// 不是正整数的值按默认处理，warnings 里写一条提示（ar config 显示）。sources 与 formatConfig 的来源列同一写法。
// 并行调度（Stage07c 140）：concurrency 可以是 1～8 的整数，或 "auto"（按 CPU 核数与可用内存估算，上限 concurrencyMax，默认 8）。
// 结果另带 mode（'auto' / 'fixed'）、estimate（自动估算值，固定档也算出来供显示）、max（concurrencyMax）；
// 自动档下 limits.concurrency 就是估算值，所以读它的代码照常工作。probe 供测试注入 { cores, freeMemBytes }。
export const slotDefaults = { concurrency: 2, gateConcurrency: 1 };
export function slotLimits(config = {}, probe = {}) {
  const limits = {}, sources = {}, warnings = [];
  const inRange = value => Number.isSafeInteger(value) && value >= 1 && value <= concurrencyCap;
  const maxValue = config?.concurrencyMax;
  const max = inRange(maxValue) ? maxValue : concurrencyCap;
  if (maxValue !== undefined && !inRange(maxValue)) warnings.push(`配置：concurrencyMax 必须为 1～${concurrencyCap} 的整数，已按默认值 ${concurrencyCap} 处理`);
  // memLowPercent（D114，182）：自动档"可用内存低于总内存的这个比例（且不低于 1.5 GB）就暂停"，1～50 的整数，默认 5。
  const percentValue = config?.memLowPercent;
  const memLowPercent = validMemLowPercent(percentValue) ? percentValue : memLowPercentDefault;
  if (percentValue !== undefined && !validMemLowPercent(percentValue)) warnings.push(`配置：memLowPercent 必须为 1～${memLowPercentMax} 的整数，已按默认值 ${memLowPercentDefault} 处理`);
  const estimate = estimateConcurrency({ cores: probe.cores ?? machineCores(), freeMemBytes: probe.freeMemBytes ?? os.freemem(), max });
  let mode = 'fixed';
  for (const [key, fallback] of Object.entries(slotDefaults)) {
    const value = config?.[key];
    if (key === 'concurrency') {
      if (value === 'auto') { mode = 'auto'; limits[key] = estimate; sources[key] = 'config.json'; continue; }
      if (inRange(value)) { limits[key] = value; sources[key] = 'config.json'; continue; }
      limits[key] = fallback; sources[key] = '内置默认';
      if (value !== undefined) warnings.push(`配置：${key} 必须为 1～${concurrencyCap} 的整数或 "auto"，已按默认值 ${fallback} 处理`);
      continue;
    }
    if (Number.isSafeInteger(value) && value > 0) { limits[key] = value; sources[key] = 'config.json'; continue; }
    limits[key] = fallback; sources[key] = '内置默认';
    if (value !== undefined) warnings.push(`配置：${key} 必须为正整数，已按默认值 ${fallback} 处理`);
  }
  return { limits, sources, warnings, mode, estimate, max, maxSource: inRange(maxValue) ? 'config.json' : '内置默认', memLowPercent, memLowSource: validMemLowPercent(percentValue) ? 'config.json' : '内置默认' };
}

// 执行者会话记录的保留天数（ar gc 用）：sessionRetentionDays 为正整数，没写为 14；不是正整数的值按默认处理并提示。
export const sessionRetentionDefault = 14;
export function sessionRetention(config = {}) {
  const value = config?.sessionRetentionDays;
  if (Number.isSafeInteger(value) && value > 0) return { days: value, source: 'config.json', warnings: [] };
  return {
    days: sessionRetentionDefault, source: '内置默认',
    warnings: value === undefined ? [] : [`配置：sessionRetentionDays 必须为正整数，已按默认值 ${sessionRetentionDefault} 处理`],
  };
}

// 链路报告的扣分表：每项 { points: 每次扣多少, max: 最多扣多少（null 为不封顶） }。
// 执行者与主导的 needsScope 同名不同值，所以按角色分开存；capFailed / capRejected 是任务失败、被驳回时执行者分数的上限。
export const reportWeightDefaults = Object.freeze({
  executor: Object.freeze({
    attemptGate: { points: 15, max: null }, attemptAgent: { points: 20, max: null },
    outsideFile: { points: 10, max: 30 }, protectedFile: { points: 15, max: 30 },
    outsideWrites: { points: 20, max: null }, escalated: { points: 10, max: null },
    toolError: { points: 1, max: 10 }, needsScope: { points: 0, max: null },
  }),
  lead: Object.freeze({
    specEdit: { points: 10, max: 30 }, specBlame: { points: 15, max: null },
    manualRetry: { points: 10, max: 30 }, needsScope: { points: 10, max: null },
    rejected: { points: 20, max: null }, conflict: { points: 5, max: null },
  }),
  reviewer: Object.freeze({
    reviewInvalid: { points: 30, max: 60 }, reviewFormat: { points: 10, max: 30 },
    reviewFalse: { points: 5, max: 30 }, reviewFalseHigh: { points: 10, max: 40 },
  }),
  capFailed: 40,
  capRejected: 60,
});
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

// config.json 的 reportWeights：{ "<key>": { "points": 数, "max": 数 } }，只写要改的键；
// 键同扣分表的 key（needsScope 同时出现在两张表里，这里只作用于主导的那一项）；capFailed / capRejected 直接写数。
// 形状不对按默认；不是正数的值忽略并按默认，warnings 里各写一条（ar config 显示）。
export function reportWeights(config = {}) {
  const weights = { executor: {}, lead: {}, reviewer: {}, capFailed: reportWeightDefaults.capFailed, capRejected: reportWeightDefaults.capRejected };
  for (const role of ['executor', 'lead', 'reviewer']) for (const [key, value] of Object.entries(reportWeightDefaults[role])) weights[role][key] = { ...value };
  const raw = config?.reportWeights;
  if (raw === undefined) return { weights, custom: 0, source: '内置默认', warnings: [] };
  if (!object(raw)) return { weights, custom: 0, source: '内置默认', warnings: ['配置：reportWeights 必须为对象，已按默认处理'] };
  const warnings = [];
  let custom = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'capFailed' || key === 'capRejected') {
      if (positive(value)) { weights[key] = value; custom += 1; } else warnings.push(`配置：reportWeights.${key} 必须为正数，已按默认值 ${reportWeightDefaults[key]} 处理`);
      continue;
    }
    // 同名的 needsScope 只作用于主导；其余键在哪张表里就改哪一项。
    const role = ['lead', 'executor', 'reviewer'].find(name => Object.hasOwn(reportWeightDefaults[name], key)) ?? null;
    if (!role) { warnings.push(`配置：reportWeights.${key} 不是已知的扣分项，已忽略`); continue; }
    if (!object(value)) { warnings.push(`配置：reportWeights.${key} 必须为对象（points、max），已按默认处理`); continue; }
    for (const field of ['points', 'max']) {
      if (value[field] === undefined) continue;
      if (positive(value[field])) { weights[role][key][field] = value[field]; custom += 1; }
      else warnings.push(`配置：reportWeights.${key}.${field} 必须为正数，已按默认处理`);
    }
  }
  return { weights, custom, source: custom ? 'config.json' : '内置默认', warnings };
}

// config.json 的 prices：{ "<执行者配置名>": { "input": 每百万 token 价格, "output": …, "currency": "CNY" | "USD" } }。
// 不合法的条目整条忽略（该执行者按"没有设置价格"处理），warnings 里写一条。
export const priceCurrencies = ['CNY', 'USD'];
export function priceTable(config = {}) {
  const raw = config?.prices;
  if (raw === undefined) return { prices: {}, source: '内置默认', warnings: [] };
  if (!object(raw)) return { prices: {}, source: '内置默认', warnings: ['配置：prices 必须为对象，已忽略'] };
  const prices = {}, warnings = [];
  const price = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  for (const [name, item] of Object.entries(raw)) {
    if (object(item) && price(item.input) && price(item.output) && priceCurrencies.includes(item.currency)) prices[name] = { input: item.input, output: item.output, currency: item.currency };
    else warnings.push(`配置：prices.${name} 必须是 { input, output, currency }（价格不小于 0，currency 为 CNY 或 USD），已忽略`);
  }
  return { prices, source: Object.keys(prices).length ? 'config.json' : '内置默认', warnings };
}

// config.json 的 leadUsage：布尔，默认 false；为 true 时报告才读主导的会话记录。
export function leadUsageSetting(config = {}) {
  const value = config?.leadUsage;
  if (typeof value === 'boolean') return { enabled: value, source: 'config.json', warnings: [] };
  return { enabled: false, source: '内置默认', warnings: value === undefined ? [] : ['配置：leadUsage 必须为布尔值，已按默认值 false 处理'] };
}

// profile 选择：--profile > AR_PROFILE > defaultProfile > 唯一启用的 profile。
export function selectProfile(config, opts = {}, env = {}) {
  const profiles = config.profiles ?? {};
  const enabled = Object.keys(profiles).filter(name => profiles[name].enabled !== false);
  const name = opts.profile ?? (env.AR_PROFILE || undefined) ?? config.defaultProfile ?? (enabled.length === 1 ? enabled[0] : undefined);
  if (!name && enabled.length > 1) throw new Error(`有多个可用的执行者（${enabled.join('、')}），请用 --profile 指定，或在配置里设 defaultProfile`);
  if (!name) throw new Error(noProfile);
  const profile = profiles[name];
  if (!profile) throw new Error(`找不到执行者：${name}`);
  if (profile.enabled === false) throw new Error(`执行者 ${name} 已停用`);
  return { profileName: name, profile };
}

// layers（Stage07c T6，可不传）：{ spec: { model, effort }, rule: { effort } }，只对 model、effort 两项生效。
// 生效顺序：命令行 > 环境变量 CODEX_*（只对 codex）> 任务说明 > 命中的路由规则 > 执行者配置 > 内置默认（主导决定 D81）。
export function resolveSettings(config, opts = {}, env = {}, profileName, layers = {}) {
  const v2 = validateV2(config.v === 2 ? config : migrateV1(config));
  const name = profileName ?? v2.defaultProfile ?? 'codex';
  const profile = v2.profiles?.[name] ?? {}, codex = profile.adapter === 'codex';
  const settings = {}, sources = {};
  const layered = key => ({
    spec: ['model', 'effort'].includes(key) ? layers?.spec?.[key] : undefined,
    rule: key === 'effort' ? layers?.rule?.effort : undefined,
  });
  for (const key of Object.keys(defaults)) {
    const fromFile = key === 'watchWindow' ? v2.watchWindow : profile[key];
    const option = key === 'watchWindow' ? opts['watch-window'] : key === 'path' ? undefined : opts[key];
    // CODEX_* 只作用于 adapter 为 codex 的 profile；关窗口变量对所有执行者有效。
    const envName = key === 'watchWindow' ? pickName(env, ...noWatchEnv) ?? noWatchEnv[0] : `CODEX_${key.toUpperCase()}`;
    const fromEnv = key === 'path' ? undefined : key === 'watchWindow' ? (env[envName] ? 'never' : undefined) : codex ? (env[envName] || undefined) : undefined;
    const { spec: fromSpec, rule: fromRule } = layered(key);
    validate(key, fromEnv, `环境变量 ${envName}`); validate(key, option, '命令行'); validate(key, fromSpec, '任务说明'); validate(key, fromRule, '路由规则');
    const value = option ?? fromEnv ?? fromSpec ?? fromRule ?? fromFile;
    settings[key] = value == null ? defaults[key] : value;
    sources[key] = option != null ? '命令行' : fromEnv != null ? `环境变量 ${envName}` : fromSpec != null ? '任务说明' : fromRule != null ? '路由规则' : fromFile !== undefined ? 'config.json' : '内置默认';
  }
  return { settings, sources };
}

// 记进 start / dispatch.json 的来源：每次派发都记 model、effort 各自的来源（Stage07c 154，D81：参数标签写明每个值的来源）。
export function settingSourcesOf(sources) {
  return { model: sources?.model ?? null, effort: sources?.effort ?? null };
}

// 只读取得"实际生效"的配置（ar route 用，不写任何文件，也不迁移旧目录的配置）：
// 没有配置文件时是旧目录里的 v1 配置（迁移后的样子），再没有就是内置默认；读不了就拒绝。
export function readEffectiveConfig(home) {
  const state = readConfig(home);
  if (state.reason) throw configInvalid(state);
  return validateV2(state.exists ? state.config : state.legacy?.config ?? builtinConfig());
}

// choose：派发时用路由器选执行者（config => { profileName, profile, ...附带信息 }），附带信息原样带回；不给就是旧的 selectProfile。
export function loadConfig(home, opts = {}, env = process.env, { choose } = {}) {
  const state = readConfig(home);
  // 配置无效：在读取任何回退之前就拒绝，不派发、不写入（063）。
  if (state.reason) throw configInvalid(state);
  let config = state.config, warning = null;
  if (state.legacy) {
    // 旧目录的 v1 配置迁移到新目录；旧文件不动。
    config = state.legacy.config;
    writeAtomic(home, state.file, config);
    warning = `配置：已把旧版 config.json 迁移到 AgentRouter（原文件保留在 ${state.legacy.file}）`;
    Object.assign(state, { exists: true, config });
  } else if (!state.exists) {
    config = builtinConfig(); warning = '配置：未找到 config.json，模型、强度、档位跟随 Codex 自己的配置';
  } else if (state.upgraded) warning = '配置：config.json 是旧版本，已按 v2 解读';
  validateV2(config);
  const { profileName, profile, ...chosen } = choose ? choose(config) : selectProfile(config, opts, env);
  return { ...state, config, profileName, profile, ...chosen, ...resolveSettings(config, opts, env, profileName), warning };
}

// profile（可选）：指定写进哪个 Codex 执行者（改过名的 Codex 执行者，如 codex-pro）；必须是已有的、adapter 为 codex 的执行者，
// 否则报错、什么都不写。不给时仍是 codex（不存在时新建）。
export function writeConfig(home, changes = {}, { init = false, profile } = {}) {
  const state = readConfig(home);
  // 写入类命令在配置无效时拒绝（063）：坏文件一个字节都不动；config init 也不再拿"文件存在"搪塞。
  if (state.reason) throw configInvalid(state, '这次没有改动配置');
  if (init && state.exists) return { ...state, unchanged: true };
  for (const [key, value] of Object.entries(changes)) {
    if (key !== 'managed' && !Object.hasOwn(defaults, key)) throw new Error(`未知配置键：${key}`);
    validate(key, value, '命令行');
  }
  const config = structuredClone(state.exists ? state.config : state.legacy?.config ?? initialConfig());
  validateV2(config);
  // model / effort / tier / sandbox / path 是 Codex 执行者的设置：一律写进 codex profile（不存在时新建），
  // 不写进默认执行者——默认执行者可能是别的适配器（D2：加入其他执行者后默认改用它）。
  const target = profile ?? 'codex';
  if (profile !== undefined) {
    const existing = Object.hasOwn(config.profiles ?? {}, profile) ? config.profiles[profile] : null;
    if (!existing) throw new Error(`找不到执行者：${profile}，这次没有改动配置`);
    if (existing.adapter !== 'codex') throw new Error(`执行者 ${profile} 不是 Codex 适配器，这次没有改动配置`);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'watchWindow' || key === 'managed') config[key] = value;
    else {
      config.profiles ??= {};
      config.profiles[target] ??= { adapter: 'codex', label: 'Codex', enabled: true };
      config.profiles[target][key] = value;
    }
  }
  config.v = 2;
  writeAtomic(home, state.file, config);
  return readConfig(home);
}

// 修改整份配置（执行者增删、启停）：在当前配置（没有时用首次写入的默认、或旧目录迁移来的）上修改，校验后原子写入。
export function updateConfig(home, mutate) {
  const state = readConfig(home);
  // 执行者增删改走这里：配置无效时拒绝（063），不写入任何文件。
  if (state.reason) throw configInvalid(state, '这次没有改动配置');
  const config = structuredClone(state.exists ? state.config : state.legacy?.config ?? initialConfig());
  mutate(config);
  config.v = 2;
  validateV2(config);
  writeAtomic(home, state.file, config);
  return config;
}

export function formatConfig(home, env = process.env) {
  const state = readConfig(home);
  // 只读显示也拒绝（063）：不列出内置默认的执行者。
  if (state.reason) throw configInvalid(state);
  let profileLine = '', settings, sources, codexNote = null;
  try {
    const loaded = loadConfig(home, {}, env);
    // 下面这些行是 Codex 执行者的设置（与 writeConfig 写入的位置一致），不论默认执行者是谁。
    ({ settings, sources } = resolveSettings(loaded.config, {}, env, 'codex'));
    profileLine = `  执行者：${loaded.profileName}（${loaded.profile.label ?? loaded.profile.adapter}）`;
    if (loaded.profile.adapter !== 'codex') codexNote = loaded.config.profiles?.codex ? '以下是 Codex 执行者（可选）的设置：' : '以下是 Codex 执行者的设置（当前配置里没有 codex 执行者，写入时会新建）：';
  } catch (error) {
    ({ settings, sources } = resolveSettings(builtinConfig(), {}, env));
    profileLine = `  执行者：无（${error.message}）`;
  }
  const lines = [`配置文件：${state.file}（${state.exists || state.legacy ? '已存在' : '不存在'}）${profileLine}`];
  if (codexNote) lines.push(codexNote);
  for (const [key, value] of Object.entries(settings)) lines.push(`${padColumn(key, 13)}${padColumn(String(value ?? (key === 'path' ? '自动查找' : '跟随 Codex')), 22)}${sources[key]}`);
  return lines.join('\n');
}
// 中文字符占两列；保留原有列宽，不引入终端格式化依赖。
const padColumn = (text, width) => {
  const length = [...text].reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - length));
};
// 并发"自动"档多显示四行：模式、上限、现在的估算值、现在是不是在暂停（瞬时判断：CPU 持续多久要排队中的任务才知道）。
function autoLines(slots) {
  if (slots.mode !== 'auto') return [];
  const load = currentLoad({ memLowPercent: slots.memLowPercent });
  const gb = (load.freeMemBytes / 1024 ** 3).toFixed(1);
  const busy = load.memLow ? `暂停（可用内存 ${gb} GB）` : load.cpu !== null && load.cpu > 85 ? `可能暂停（CPU ${load.cpu}%）` : '正常';
  return [
    `${padColumn('concurrencyMode', 16)}${padColumn('auto', 19)}config.json`,
    `${padColumn('concurrencyMax', 16)}${padColumn(String(slots.max), 19)}${slots.maxSource}`,
    `${padColumn('memLowPercent', 16)}${padColumn(String(slots.memLowPercent), 19)}${slots.memLowSource}`,
    `${padColumn('autoEstimate', 16)}${padColumn(String(slots.estimate), 19)}${machineCores()} 核、可用内存 ${gb} GB`,
    `${padColumn('autoState', 16)}${padColumn(busy, 19)}CPU ${load.cpu ?? '?'}%`,
  ];
}
// ar config 在设置表后面附上两个并发名额上限（gateConcurrency 比其他键长，键列加宽、值列收窄，来源列仍对齐）；
// 不合法的值按默认处理并提示一行。
function formatSlotLines(home) {
  const config = readConfig(home).config;
  const slots = slotLimits(config);
  const { limits, sources, warnings } = slots;
  const retention = sessionRetention(config);
  const weights = reportWeights(config), prices = priceTable(config), usage = leadUsageSetting(config);
  const priced = Object.keys(prices.prices).length;
  return [
    ...Object.entries(limits).map(([key, value]) => `${padColumn(key, 16)}${padColumn(String(value), 19)}${sources[key]}`),
    ...autoLines(slots),
    // 键名更长，用自己的列宽，来源列仍对齐在第 35 列。
    `${padColumn('sessionRetentionDays', 21)}${padColumn(String(retention.days), 14)}${retention.source}`,
    // 链路报告的三项设置。
    `${padColumn('reportWeights', 16)}${padColumn(weights.custom ? `自定义 ${weights.custom} 项` : '默认', 19)}${weights.source}`,
    `${padColumn('prices', 16)}${padColumn(priced ? `${priced} 个执行者` : '未设置', 19)}${prices.source}`,
    `${padColumn('leadUsage', 16)}${padColumn(String(usage.enabled), 19)}${usage.source}`,
    // 网络代理：模式与地址；system 时写这一刻读到的结果（只读，不写任何东西）。
    `${padColumn('proxy', 16)}${proxyText(resolveProxy(config))}`,
    ...warnings, ...retention.warnings, ...weights.warnings, ...prices.warnings, ...usage.warnings,
  ];
}
export function configCommand(args, env = process.env) {
  const home = homeDirectory(env);
  let message = '';
  if (args.length === 1 && args[0] === 'init') {
    if (writeConfig(home, {}, { init: true }).unchanged) message = 'config.json 已存在\n';
  } else if (args.length) {
    const changes = {};
    for (const arg of args) {
      const at = arg.indexOf('=');
      if (at < 1) throw new Error(`配置参数必须为 键=值：${arg}`);
      changes[arg.slice(0, at)] = arg.slice(at + 1) === '-' ? null : arg.slice(at + 1);
    }
    writeConfig(home, changes);
  }
  return `${message}${[formatConfig(home, env), ...formatSlotLines(home)].join('\n')}`;
}
