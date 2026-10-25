import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homeDirectory, legacyHomeFor, userDirectory, noWatchEnv, pickName } from './compat.mjs';
import { parseJson } from './json.mjs';
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

function writeAtomic(home, file, config) {
  mkdirSync(home, { recursive: true });
  const temp = join(home, `.config-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
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

// routing（路由器用）：rules 每条 { types: [字符串], profile: 字符串, escalate?: 字符串 | null }，fallback 是字符串或 null，reviewer 见下。
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
    });
  }
  if (routing.fallback != null && typeof routing.fallback !== 'string') throw new Error('config.json 的 routing.fallback 必须为字符串或 null');
  // reviewer：{ profiles: [执行者名], mustDiffer: 布尔 }；兼容只写一个 profile 的旧写法（对象或字符串）；null 或不写按空处理。
  const reviewer = routing.reviewer;
  if (reviewer != null && typeof reviewer !== 'string') {
    if (!object(reviewer)) throw new Error('config.json 的 routing.reviewer 必须为对象、字符串或 null');
    if (reviewer.profiles != null && (!Array.isArray(reviewer.profiles) || reviewer.profiles.some(name => typeof name !== 'string'))) throw new Error('config.json 的 routing.reviewer.profiles 必须为字符串数组');
    if (reviewer.profile != null && typeof reviewer.profile !== 'string') throw new Error('config.json 的 routing.reviewer.profile 必须为字符串');
    if (reviewer.mustDiffer != null && typeof reviewer.mustDiffer !== 'boolean') throw new Error('config.json 的 routing.reviewer.mustDiffer 必须为布尔值');
  }
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
  if (config.defaultProfile != null && typeof config.defaultProfile !== 'string') throw new Error('config.json 的 defaultProfile 必须为字符串或 null');
  if (config.managed !== undefined) validate('managed', config.managed, 'config.json');
  validate('watchWindow', config.watchWindow, 'config.json');
  return config;
}

// 并发名额上限（协议 15.5）：concurrency 是任务名额（默认 2），gateConcurrency 是门禁名额（默认 1）。
// 不是正整数的值按默认处理，warnings 里写一条提示（ar config 显示）。sources 与 formatConfig 的来源列同一写法。
export const slotDefaults = { concurrency: 2, gateConcurrency: 1 };
export function slotLimits(config = {}) {
  const limits = {}, sources = {}, warnings = [];
  for (const [key, fallback] of Object.entries(slotDefaults)) {
    const value = config?.[key];
    if (Number.isSafeInteger(value) && value > 0) { limits[key] = value; sources[key] = 'config.json'; continue; }
    limits[key] = fallback; sources[key] = '内置默认';
    if (value !== undefined) warnings.push(`配置：${key} 必须为正整数，已按默认值 ${fallback} 处理`);
  }
  return { limits, sources, warnings };
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
  capFailed: 40,
  capRejected: 60,
});
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

// config.json 的 reportWeights：{ "<key>": { "points": 数, "max": 数 } }，只写要改的键；
// 键同扣分表的 key（needsScope 同时出现在两张表里，这里只作用于主导的那一项）；capFailed / capRejected 直接写数。
// 形状不对按默认；不是正数的值忽略并按默认，warnings 里各写一条（ar config 显示）。
export function reportWeights(config = {}) {
  const weights = { executor: {}, lead: {}, capFailed: reportWeightDefaults.capFailed, capRejected: reportWeightDefaults.capRejected };
  for (const role of ['executor', 'lead']) for (const [key, value] of Object.entries(reportWeightDefaults[role])) weights[role][key] = { ...value };
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
    const role = Object.hasOwn(reportWeightDefaults.lead, key) ? 'lead' : Object.hasOwn(reportWeightDefaults.executor, key) ? 'executor' : null;
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

export function resolveSettings(config, opts = {}, env = {}, profileName) {
  const v2 = validateV2(config.v === 2 ? config : migrateV1(config));
  const name = profileName ?? v2.defaultProfile ?? 'codex';
  const profile = v2.profiles?.[name] ?? {}, codex = profile.adapter === 'codex';
  const settings = {}, sources = {};
  for (const key of Object.keys(defaults)) {
    const fromFile = key === 'watchWindow' ? v2.watchWindow : profile[key];
    const option = key === 'watchWindow' ? opts['watch-window'] : key === 'path' ? undefined : opts[key];
    // CODEX_* 只作用于 adapter 为 codex 的 profile；关窗口变量对所有执行者有效。
    const envName = key === 'watchWindow' ? pickName(env, ...noWatchEnv) ?? noWatchEnv[0] : `CODEX_${key.toUpperCase()}`;
    const fromEnv = key === 'path' ? undefined : key === 'watchWindow' ? (env[envName] ? 'never' : undefined) : codex ? (env[envName] || undefined) : undefined;
    validate(key, fromEnv, `环境变量 ${envName}`); validate(key, option, '命令行');
    const value = option ?? fromEnv ?? fromFile;
    settings[key] = value == null ? defaults[key] : value;
    sources[key] = option != null ? '命令行' : fromEnv != null ? `环境变量 ${envName}` : fromFile !== undefined ? 'config.json' : '内置默认';
  }
  return { settings, sources };
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

export function writeConfig(home, changes = {}, { init = false } = {}) {
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
  const target = 'codex';
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
// ar config 在设置表后面附上两个并发名额上限（gateConcurrency 比其他键长，键列加宽、值列收窄，来源列仍对齐）；
// 不合法的值按默认处理并提示一行。
function formatSlotLines(home) {
  const config = readConfig(home).config;
  const { limits, sources, warnings } = slotLimits(config);
  const retention = sessionRetention(config);
  const weights = reportWeights(config), prices = priceTable(config), usage = leadUsageSetting(config);
  const priced = Object.keys(prices.prices).length;
  return [
    ...Object.entries(limits).map(([key, value]) => `${padColumn(key, 16)}${padColumn(String(value), 19)}${sources[key]}`),
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
