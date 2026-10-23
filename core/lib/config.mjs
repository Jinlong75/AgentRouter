import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homeDirectory, legacyHomeFor, userDirectory, noWatchEnv, pickName } from './compat.mjs';
import { parseJson } from './json.mjs';

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

function readJson(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { return { exists: error.code !== 'ENOENT', reason: error.code === 'ENOENT' ? null : `读取失败：${error.code}` }; }
  let value;
  try { value = parseJson(text); }
  catch { return { exists: true, reason: '不是有效的 JSON' }; }
  if (!object(value) || ![1, 2].includes(value.v)) return { exists: true, reason: 'v 不是 1 或 2' };
  return { exists: true, reason: null, value };
}

// 只读：返回 v2 配置。v1 文件按 v2 解读（upgraded）；新目录没有配置时，带回旧目录里可迁移的 v1 配置（legacy）。
export function readConfig(home) {
  const file = join(home, 'config.json'), state = readJson(file);
  if (state.value) {
    const upgraded = state.value.v === 1;
    return { file, exists: true, reason: null, config: upgraded ? migrateV1(state.value) : state.value, upgraded };
  }
  if (state.reason) return { file, exists: true, reason: state.reason, config: {} };
  const legacyFile = join(legacyHomeFor(home), 'config.json');
  if (legacyFile !== file) {
    const legacy = readJson(legacyFile);
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

function validateV2(config) {
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
  }
  if (config.defaultProfile != null && typeof config.defaultProfile !== 'string') throw new Error('config.json 的 defaultProfile 必须为字符串或 null');
  if (config.managed !== undefined) validate('managed', config.managed, 'config.json');
  validate('watchWindow', config.watchWindow, 'config.json');
  return config;
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

export function loadConfig(home, opts = {}, env = process.env) {
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
  const { profileName, profile } = selectProfile(config, opts, env);
  return { ...state, config, profileName, profile, ...resolveSettings(config, opts, env, profileName), warning };
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
  // 中文字符占两列；保留原有列宽，不引入终端格式化依赖。
  const padColumn = (text, width) => {
    const length = [...text].reduce((sum, char) => sum + (/\p{Script=Han}/u.test(char) ? 2 : 1), 0);
    return text + ' '.repeat(Math.max(0, width - length));
  };
  for (const [key, value] of Object.entries(settings)) lines.push(`${padColumn(key, 13)}${padColumn(String(value ?? (key === 'path' ? '自动查找' : '跟随 Codex')), 22)}${sources[key]}`);
  return lines.join('\n');
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
  return message + formatConfig(home, env);
}
