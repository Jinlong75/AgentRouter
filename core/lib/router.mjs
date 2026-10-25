// 路由器：按任务类型自动选执行者，并记下为什么选它（Stage07 T4）。
// route() 只计算、不写任何文件；usageToday() 只读公共目录的 runs.jsonl（Stage08 选审查者时也会用）。
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { adapters } from '../adapters/index.mjs';
import { makeGeneric } from '../adapters/generic.mjs';
import { readJson } from './json.mjs';
import { readEffectiveConfig, updateConfig } from './config.mjs';
import { readProjects } from './project.mjs';
import { SPEC_TYPES } from './spec.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value !== '' ? value : null);

// 需要只读的任务类型（docs 默认要写入）。
export const READ_ONLY_TYPES = ['research', 'review'];

// 执行者配置是否支持只读运行。单独成函数，其余适配器看注册表里声明的 capabilities.readOnly。
// generic：执行者配置的 generic 是声明名（声明在 config.generics 里）或直接内嵌的声明（派发时解析好的在 genericDecl）；
// 以 makeGeneric(声明).capabilities.readOnly 为准（声明里有 readOnlyArgs 才支持）。这里不做完整校验，找不到声明就是不支持。
export function supportsReadOnly(profile, config = {}) {
  const kind = profile?.adapter;
  // fake 不区分读写模式（回放说明照常运行），按现有能力算支持；已有的测试用它派发研究类任务说明。
  if (kind === 'claude-code' || kind === 'codex' || kind === 'fake') return true;
  if (kind === 'generic') {
    const decl = object(profile.genericDecl) ? profile.genericDecl : object(profile.generic) ? profile.generic : config.generics?.[profile.generic];
    return object(decl) && makeGeneric(decl).capabilities.readOnly === true;
  }
  return adapters[kind]?.capabilities?.readOnly === true;
}

// 本地日期"今天"里这个执行者已经开始的任务数与用掉的 token（输入 + 输出）。
// token 取这些任务各次 attempt-end 的 usage；没有记录（usage 为 null）的算 0。now 可注入（测试用）。
export function usageToday({ home, profile, now = Date.now() } = {}) {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  let content = '';
  try { content = readFileSync(join(home, 'runs.jsonl'), 'utf8'); } catch { /* 没有清单就是还没用过。 */ }
  const rows = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (object(row)) rows.push(row); } catch { /* 忽略坏行。 */ }
  }
  const ids = new Set();
  for (const row of rows) {
    if (row.event === 'start' && row.profile === profile && typeof row.id === 'string' && Number.isFinite(row.started)
      && row.started >= from.getTime() && row.started < to.getTime()) ids.add(row.id);
  }
  let tokens = 0;
  for (const row of rows) {
    if (row.event !== 'attempt-end' || !ids.has(row.id) || !object(row.usage)) continue;
    for (const key of ['input', 'output']) if (Number.isFinite(row.usage[key])) tokens += row.usage[key];
  }
  return { tasks: ids.size, tokens };
}

// 1200000 → 1.2M，1000000 → 1M，1500 → 1.5K。
const tokenText = number => {
  if (number >= 1e6) return `${+(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `${+(number / 1e3).toFixed(1)}K`;
  return String(number);
};
const limitOf = value => (Number.isSafeInteger(value) && value > 0 ? value : null);

// 路由。失败时抛错，错误对象带 code（NO_PROFILE / PROFILE_UNAVAILABLE）和 trace。
// spec：{ type, worker, read_only }（用任务说明派发时），直接写任务文字派发时不给；explicit：命令行 / AR_PROFILE 指定的名字。
export function route({ spec = null, projectConfig = {}, config = {}, explicit = null, home, now = Date.now() } = {}) {
  const trace = [];
  const profiles = object(config.profiles) ? config.profiles : {};
  const type = text(spec?.type);
  const needsReadOnly = READ_ONLY_TYPES.includes(type) || spec?.read_only === true;
  const fail = (code, message) => { throw Object.assign(new Error(message), { code, trace }); };
  const escalateOf = name => text(profiles[name]?.escalate);
  const done = (name, rule = null, ruleEscalate = null) => ({ profile: name, escalate: ruleEscalate ?? escalateOf(name), rule, needsReadOnly, trace });

  // 每个执行者的用量只算一次。
  const usage = new Map();
  const used = name => {
    if (!usage.has(name)) usage.set(name, usageToday({ home, profile: name, now }));
    return usage.get(name);
  };
  // 不可用的原因；可用返回 null。
  const unavailable = name => {
    const profile = profiles[name];
    if (!object(profile)) return '不存在';
    if (profile.enabled === false) return '已停用';
    if (needsReadOnly && !supportsReadOnly(profile, config)) return '不支持只读任务';
    const limits = object(profile.limits) ? profile.limits : {};
    const maxTasks = limitOf(limits.maxTasksPerDay), maxTokens = limitOf(limits.maxTokensPerDay);
    if (maxTasks || maxTokens) {
      const today = used(name);
      if (maxTasks && today.tasks >= maxTasks) return `已达每日上限（今天 ${today.tasks}/${maxTasks} 个任务）`;
      if (maxTokens && today.tokens >= maxTokens) return `已达每日上限（今天 ${tokenText(today.tokens)}/${tokenText(maxTokens)} token）`;
    }
    return null;
  };

  // 1. 命令行 --profile / AR_PROFILE：不存在或已停用就报错，不换别人（文案同旧的 selectProfile）。
  if (text(explicit)) {
    const profile = profiles[explicit];
    if (!object(profile)) { trace.push(`命令行指定：${explicit}：不存在`); fail('PROFILE_UNAVAILABLE', `找不到执行者：${explicit}`); }
    if (profile.enabled === false) { trace.push(`命令行指定：${explicit}：已停用`); fail('PROFILE_UNAVAILABLE', `执行者 ${explicit} 已停用`); }
    trace.push(`命令行指定：${explicit}`);
    return done(explicit);
  }

  // 2. 任务说明 worker 是具体的配置名：不可用就报错，不悄悄换人。
  const worker = text(spec?.worker)?.trim();
  if (worker && worker !== 'auto') {
    const reason = unavailable(worker);
    if (reason) { trace.push(`任务说明指定：${worker}：${reason}`); fail('PROFILE_UNAVAILABLE', `任务说明指定的执行者 ${worker} 不可用：${reason}`); }
    trace.push(`任务说明指定：${worker}`);
    return done(worker);
  }

  // 3～4. 项目规则、全局规则：按顺序找第一条类型包含任务类型、并且执行者可用的规则。没有类型（直接写任务文字）时跳过。
  if (type) {
    const lists = [['project', '项目规则', projectConfig?.routing?.rules], ['global', '全局规则', config.routing?.rules]];
    for (const [scope, label, rules] of lists) {
      if (!Array.isArray(rules)) continue;
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        if (!object(rule) || !Array.isArray(rule.types) || !rule.types.includes(type) || !text(rule.profile)) continue;
        const head = `${label} ${i + 1}：[${rule.types.filter(item => typeof item === 'string').join(', ')}] → ${rule.profile}`;
        const reason = unavailable(rule.profile);
        if (reason) { trace.push(`${head}：${reason}，跳过`); continue; }
        trace.push(head);
        return done(rule.profile, { scope, index: i + 1 }, text(rule.escalate));
      }
    }
  }

  // 5. 兜底：routing.fallback，再 defaultProfile；没有 defaultProfile 时取唯一启用的（与旧的选择一致）。
  const enabled = Object.keys(profiles).filter(name => object(profiles[name]) && profiles[name].enabled !== false);
  const candidates = [text(config.routing?.fallback), text(config.defaultProfile), ...(text(config.defaultProfile) || enabled.length !== 1 ? [] : [enabled[0]])]
    .filter((name, index, all) => name && all.indexOf(name) === index);
  for (const name of candidates) {
    const reason = unavailable(name);
    if (reason) { trace.push(`兜底：${name}：${reason}，跳过`); continue; }
    trace.push(`兜底：${name}`);
    return done(name);
  }

  // 6. 都不可用。
  fail('NO_PROFILE', `没有可用的执行者处理${type ? `「${type}」类` : '这个'}任务`);
}

// ---- 路由配置的读写（Stage07 T8：软件"路由"页用；技能与软件走同一条路径，写入都由核心校验后原子写 config.json） ----

const profileLabel = (name, profile) => text(profile?.label) ?? adapters[profile?.adapter]?.label ?? name;

// routing.reviewer 的读法：{ profiles, mustDiffer }。没有或 null 按空处理；旧的单值写法（字符串，或只写 profile 的对象）读成只有一项的 profiles；mustDiffer 默认 true。
export function reviewerOf(routing) {
  const value = routing?.reviewer;
  let profiles = [];
  if (typeof value === 'string' && value) profiles = [value];
  else if (object(value)) {
    if (Array.isArray(value.profiles)) profiles = value.profiles.filter(name => typeof name === 'string' && name);
    else if (text(value.profile)) profiles = [value.profile];
  }
  return { profiles, mustDiffer: object(value) ? value.mustDiffer !== false : true };
}

// 软件"路由"页要的整份视图（只读）：规则、兜底、审查者候选、默认执行者、每个执行者的只读能力 / 每日上限 / 今天已用、已登记项目各有几条自己的规则。
export function routeConfigView(home, { now = Date.now() } = {}) {
  const config = readEffectiveConfig(home);
  const profiles = object(config.profiles) ? config.profiles : {};
  const enabled = Object.keys(profiles).filter(name => object(profiles[name]) && profiles[name].enabled !== false);
  let projects = [];
  try { projects = readProjects(home); } catch { /* 登记表读不了就当没有项目规则。 */ }
  const projectRules = [];
  for (const project of projects) {
    let rules = null;
    try { rules = readJson(join(project.path, '.agent-router', 'project.json'))?.routing?.rules; } catch { /* 没有项目配置就没有规则。 */ }
    if (Array.isArray(rules) && rules.length) projectRules.push({ project: text(project.name) ?? basename(project.path), path: project.path, count: rules.length });
  }
  return {
    rules: Array.isArray(config.routing?.rules) ? config.routing.rules : [],
    fallback: text(config.routing?.fallback),
    reviewer: reviewerOf(config.routing),
    // 与路由器的兜底顺序一致：defaultProfile，没有时取唯一启用的执行者。
    defaultProfile: text(config.defaultProfile) ?? (enabled.length === 1 ? enabled[0] : null),
    profiles: Object.entries(profiles).filter(([, profile]) => object(profile)).map(([name, profile]) => {
      const limits = object(profile.limits) ? profile.limits : {};
      return {
        name, label: profileLabel(name, profile), enabled: profile.enabled !== false, readOnly: supportsReadOnly(profile, config),
        limits: { maxTasksPerDay: limitOf(limits.maxTasksPerDay), maxTokensPerDay: limitOf(limits.maxTokensPerDay) },
        usage: usageToday({ home, profile: name, now }),
      };
    }),
    projectRules,
  };
}

// 命令行传来的 JSON 参数：解析失败给中文原因。
function parseArgument(source, what) {
  if (source === undefined) throw new Error(`缺少${what}`);
  try { return JSON.parse(source); } catch { throw new Error(`${what}不是有效的 JSON`); }
}
const known = (config, name) => object(config.profiles?.[name]);

// 规则的校验与整理：types 非空、每项是已知类型；profile 必须是已有的执行者；escalate 为 null / 不写或已有的执行者；不能有别的字段。
function checkRules(value, config) {
  if (!Array.isArray(value)) throw new Error('规则必须是数组');
  return value.map((rule, index) => {
    const at = `第 ${index + 1} 条规则`;
    if (!object(rule)) throw new Error(`${at}必须是对象`);
    const extra = Object.keys(rule).filter(key => !['types', 'profile', 'escalate'].includes(key));
    if (extra.length) throw new Error(`${at}不能有这些字段：${extra.join('、')}`);
    if (!Array.isArray(rule.types) || !rule.types.length) throw new Error(`${at}的 types 至少要有一个任务类型`);
    const unknown = rule.types.filter(type => !SPEC_TYPES.includes(type));
    if (unknown.length) throw new Error(`${at}的任务类型只能是 ${SPEC_TYPES.join('、')}（当前：${unknown.map(String).join('、')}）`);
    if (typeof rule.profile !== 'string' || !known(config, rule.profile)) throw new Error(`${at}的执行者 ${String(rule.profile)} 不存在`);
    if (rule.escalate != null && (typeof rule.escalate !== 'string' || !known(config, rule.escalate))) throw new Error(`${at}的升级执行者 ${String(rule.escalate)} 不存在`);
    return { types: [...rule.types], profile: rule.profile, ...(rule.escalate !== undefined ? { escalate: rule.escalate } : {}) };
  });
}

// 审查者候选的校验与整理：{ profiles: [已有的执行者名], mustDiffer?: 布尔 }；兼容只写一个 profile 的旧写法。写入时统一成 { profiles, mustDiffer }。
function checkReviewer(value, config) {
  if (!object(value)) throw new Error('审查者设置必须是对象');
  const extra = Object.keys(value).filter(key => !['profiles', 'profile', 'mustDiffer'].includes(key));
  if (extra.length) throw new Error(`审查者设置不能有这些字段：${extra.join('、')}`);
  if (value.mustDiffer !== undefined && typeof value.mustDiffer !== 'boolean') throw new Error('审查者设置的 mustDiffer 必须是布尔值');
  let profiles;
  if (value.profiles !== undefined) {
    if (!Array.isArray(value.profiles)) throw new Error('审查者设置的 profiles 必须是数组');
    profiles = value.profiles;
  } else if (value.profile !== undefined) profiles = [value.profile];
  else throw new Error('审查者设置要写 profiles（执行者名数组）');
  const missing = profiles.filter(name => typeof name !== 'string' || !known(config, name));
  if (missing.length) throw new Error(`审查者候选里的执行者不存在：${missing.map(String).join('、')}`);
  return { profiles: [...profiles], mustDiffer: value.mustDiffer !== false };
}

// 上限的值：正整数；空串表示删除这一项。
function limitValue(source, flag) {
  if (source === '') return null;
  if (!/^[1-9]\d*$/.test(source) || !Number.isSafeInteger(Number(source))) throw new Error(`${flag} 必须是正整数，或用空串表示删除（当前：${source}）`);
  return Number(source);
}

const routeWriteUsage = [
  '用法：ar route config',
  '  ar route rules set \'<JSON 数组>\'',
  '  ar route fallback set <执行者名> | clear',
  '  ar route reviewer set \'<JSON>\'',
  '  ar route limit set <执行者名> [--tasks <正整数>|""] [--tokens <正整数>|""]',
].join('\n');

// 路由配置的子命令（ar route config / rules / fallback / reviewer / limit）。
// 都是读写 config.json 的 routing 与执行者的 limits：核心校验后原子写入，其余字段原样保留；校验不通过抛出中文原因（退出码 2），一个字节都不写。
// 返回 { result, text }：result 是 routeConfigView（写入后重新读的整份视图），text 是文字输出。
export function routeConfigCommand(rest, { home }) {
  const [group, action, ...args] = rest;
  const view = message => { const result = routeConfigView(home); return { result, text: message }; };
  if (group === 'config') {
    if (rest.length !== 1) throw new Error(routeWriteUsage);
    const result = routeConfigView(home);
    const name = profile => `${profile}（${result.profiles.find(item => item.name === profile)?.label ?? '未知'}）`;
    const lines = [`规则：${result.rules.length} 条`, ...result.rules.map((rule, i) => `  ${i + 1}. [${rule.types?.join(', ')}] → ${rule.profile}${rule.escalate ? `，升级到 ${rule.escalate}` : ''}`),
      `兜底：${result.fallback ? name(result.fallback) : '无（用默认执行者）'}`,
      `审查者候选：${result.reviewer.profiles.length ? result.reviewer.profiles.join('、') : '无'}（必须与执行者不同：${result.reviewer.mustDiffer ? '是' : '否'}）`,
      ...result.profiles.map(p => `执行者 ${p.name}：今天 ${p.usage.tasks} 个任务、${p.usage.tokens} token；上限 任务 ${p.limits.maxTasksPerDay ?? '不限'}、token ${p.limits.maxTokensPerDay ?? '不限'}${p.readOnly ? '' : '；不支持只读'}`),
      ...result.projectRules.map(p => `项目 ${p.project} 有 ${p.count} 条自己的规则`)];
    return { result, text: lines.join('\n') };
  }
  if (group === 'rules' && action === 'set' && args.length === 1) {
    updateConfig(home, config => {
      config.routing = { ...(object(config.routing) ? config.routing : {}), rules: checkRules(parseArgument(args[0], '规则'), config) };
    });
    return view(`已更新路由规则`);
  }
  if (group === 'fallback' && action === 'set' && args.length === 1) {
    updateConfig(home, config => {
      if (!known(config, args[0])) throw new Error(`找不到执行者：${args[0]}`);
      config.routing = { ...(object(config.routing) ? config.routing : {}), fallback: args[0] };
    });
    return view(`已设置兜底执行者：${args[0]}`);
  }
  if (group === 'fallback' && action === 'clear' && !args.length) {
    updateConfig(home, config => { config.routing = { ...(object(config.routing) ? config.routing : {}), fallback: null }; });
    return view('已清除兜底执行者');
  }
  if (group === 'reviewer' && action === 'set' && args.length === 1) {
    updateConfig(home, config => {
      config.routing = { ...(object(config.routing) ? config.routing : {}), reviewer: checkReviewer(parseArgument(args[0], '审查者设置'), config) };
    });
    return view('已更新审查者候选');
  }
  if (group === 'limit' && action === 'set') {
    const [name, ...flags] = args;
    if (!name || name.startsWith('--')) throw new Error(routeWriteUsage);
    const given = {};
    for (let i = 0; i < flags.length; i += 2) {
      if (!['--tasks', '--tokens'].includes(flags[i]) || flags[i + 1] === undefined || flags[i] in given) throw new Error(routeWriteUsage);
      given[flags[i]] = limitValue(flags[i + 1], flags[i]);
    }
    if (!Object.keys(given).length) throw new Error(routeWriteUsage);
    updateConfig(home, config => {
      if (!known(config, name)) throw new Error(`找不到执行者：${name}`);
      const limits = { ...(object(config.profiles[name].limits) ? config.profiles[name].limits : {}) };
      for (const [flag, key] of [['--tasks', 'maxTasksPerDay'], ['--tokens', 'maxTokensPerDay']]) {
        if (!(flag in given)) continue;
        if (given[flag] === null) delete limits[key]; else limits[key] = given[flag];
      }
      if (Object.keys(limits).length) config.profiles[name].limits = limits; else delete config.profiles[name].limits;
    });
    return view(`已更新 ${name} 的每日上限`);
  }
  throw new Error(routeWriteUsage);
}