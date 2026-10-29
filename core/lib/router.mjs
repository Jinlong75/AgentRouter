// 路由器：按任务类型自动选执行者，并记下为什么选它（Stage07 T4）。
// route() 只计算、不写任何文件；usageToday() 只读公共目录的 runs.jsonl（Stage08 选审查者时也会用）。
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { adapters, genericDeclaration } from '../adapters/index.mjs';
import { makeGeneric } from '../adapters/generic.mjs';
import { presetObjects } from './agents.mjs';
import { readJson } from './json.mjs';
import { readEffectiveConfig, updateConfig } from './config.mjs';
import { activeLimits, clearLimit, clockText, limitOf as limitStateOf } from './limits-state.mjs';
import { readProjects } from './project.mjs';
import { SPEC_TYPES } from './spec.mjs';
import { suggestCommand } from './suggest.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value !== '' ? value : null);

// 可担任执行者：roles 没写（或为空）就是两项都有。
const canExecute = profile => !(Array.isArray(profile?.roles) && profile.roles.length) || profile.roles.includes('executor');

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

// 推理强度的可选值（Stage07c T6）：取这个执行者对应预设的 effortOptions；预设没有 effortOptions（或找不到预设）返回 null，此时不校验。
// 找预设的规则与 agents.mjs 的 presetFor 一致：先按名字加适配器，再按适配器（通用适配器再按程序名、OpenAI 兼容接口再按有无 provider）。
// TODO(lead): presetFor 在 agents.mjs 里没有导出（不在 146 的允许清单里），这里照抄了一份；之后可以导出后改成直接用。
function presetOf(name, profile, config) {
  if (!object(profile)) return null;
  let preset = null;
  try {
    const presets = presetObjects();
    preset = presets.find(p => p.name === name && p.profile.adapter === profile.adapter);
    if (!preset) {
      let executable = null, usable = true;
      if (profile.adapter === 'generic') {
        try { executable = genericDeclaration(profile, config).decl.executable; } catch { usable = false; }
      }
      if (usable) {
        preset = presets.find(p => p.profile.adapter === profile.adapter && (p.profile.provider != null) === (profile.provider != null)
          && (profile.adapter !== 'generic' || p.profile.generic?.executable === executable));
      }
    }
  } catch { return null; }
  return preset ?? null;
}

export function effortOptionsFor(name, profile, config = {}) {
  const options = presetOf(name, profile, config)?.profile.effortOptions;
  return Array.isArray(options) && options.length ? options.filter(item => typeof item === 'string') : null;
}

// 这个执行者支持不支持推理强度（Stage07c 154、D87）：对应预设写了 supportsEffort: false 才是不支持；没写、找不到预设都按支持。
export function supportsEffort(name, profile, config = {}) {
  return presetOf(name, profile, config)?.profile.supportsEffort !== false;
}

// 任务说明或路由规则给的推理强度不在执行者支持的范围里：返回中文原因；没问题（或预设没有 effortOptions）返回 null。
// from：'任务说明' / '路由规则'。命令行给的强度不校验，不走这里。
export function effortRefusal({ effort, from, name, profile, config }) {
  if (typeof effort !== 'string' || effort === '') return null;
  const options = effortOptionsFor(name, profile, config);
  if (!options || options.includes(effort)) return null;
  return `${from}里的推理强度 ${effort} 不在执行者 ${name} 支持的范围里。可选值：${options.join('、')}。探针查到的强度以 ar agents models ${name} --probe 为准。`;
}

// 默认升级链（Stage07c T8）：按预设 effortOptions 的顺序，当前强度的下一档。
// 返回 { next } 或 { skip: 原因 }（原因是一句中文，进度里写）；"空 / 默认 / auto"表示没有明确的强度，不知道该升到哪。
export function effortStep(options, current) {
  const value = typeof current === 'string' ? current.trim() : '';
  if (!value || ['auto', 'default', '默认'].includes(value.toLowerCase())) return { skip: '没有明确的推理强度（未设置或默认 / auto），不知道该升到哪，不提高' };
  if (!Array.isArray(options) || !options.length) return { skip: `不知道这个执行者支持哪些推理强度，${value} 不提高` };
  const at = options.indexOf(value);
  if (at === -1) return { skip: `推理强度 ${value} 不在这个执行者支持的档位里，不提高` };
  if (at === options.length - 1) return { skip: `推理强度已是最高档（${value}），不再提高` };
  return { next: options[at + 1] };
}

// 当前强度的下一档；没有可升的档位返回 null（中间档升一档，最高档、不在列表里、空 / 默认 / auto 都是 null）。
export function nextEffort(options, current) {
  return effortStep(options, current).next ?? null;
}

// 全局配置 routing.strongExecutor 的状态：{ name: null }（没设）/ { name, why }（设了但不存在或已停用，按没有强执行者处理）/ { name }（可用）。
export function strongStatus(config = {}) {
  const name = text(config.routing?.strongExecutor)?.trim() || null;
  if (!name) return { name: null };
  const profile = config.profiles?.[name];
  if (!object(profile)) return { name, why: '不存在' };
  if (profile.enabled === false) return { name, why: '已停用' };
  return { name };
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
// 限流（Stage07c T7）：规则 / 兜底 / 默认执行者里，limits.json 记着"现在仍被限流"的跳过，trace 写原因；
// 命令行或任务说明明确指定的照旧使用，只在 trace 里提示。skip：这个任务里已经失败过（限流 / 服务不可用）的执行者名，派发过程中换人时用，同样跳过。
export function route({ spec = null, projectConfig = {}, config = {}, explicit = null, home, now = Date.now(), skip = [] } = {}) {
  const trace = [];
  const profiles = object(config.profiles) ? config.profiles : {};
  const type = text(spec?.type);
  const needsReadOnly = READ_ONLY_TYPES.includes(type) || spec?.read_only === true;
  const fail = (code, message) => { throw Object.assign(new Error(message), { code, trace }); };
  const escalateOf = name => text(profiles[name]?.escalate);
  // effort：命中的规则写了推理强度才有这个键（没写时结果与以前逐字相同）。
  const done = (name, rule = null, ruleEscalate = null, ruleEffort = null) => ({ profile: name, escalate: ruleEscalate ?? escalateOf(name), rule, needsReadOnly, trace, ...(ruleEffort ? { effort: ruleEffort } : {}) });

  // 每个执行者的用量只算一次。
  const usage = new Map();
  const used = name => {
    if (!usage.has(name)) usage.set(name, usageToday({ home, profile: name, now }));
    return usage.get(name);
  };
  // 不可用的原因；可用返回 null。
  // pool：规则 / 兜底 / 默认从执行者池里选，要求可担任执行者；任务说明或命令行明确指定的不看这一条。
  const skipped = new Set(Array.isArray(skip) ? skip : []);
  // 明确指定的执行者现在被限流：trace 里提示一句，照旧使用。
  const limitNote = name => {
    const limit = limitStateOf(home, name, now);
    if (limit) trace.push(`${name} 被限流（额度到 ${clockText(limit.until, now)} 恢复），按明确指定仍使用`);
  };
  const unavailable = (name, { pool = true } = {}) => {
    const profile = profiles[name];
    if (!object(profile)) return '不存在';
    if (profile.enabled === false) return '已停用';
    if (pool && !canExecute(profile)) return '没有设为可担任执行者';
    if (pool && skipped.has(name)) return '这个任务里已经因限流或服务不可用换掉了它';
    const limit = pool ? limitStateOf(home, name, now) : null;
    if (limit) return `被限流（额度到 ${clockText(limit.until, now)} 恢复）`;
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
    if (!canExecute(profile)) trace.push(`${explicit} 没有设为可担任执行者，按明确指定使用`);
    limitNote(explicit);
    trace.push(`命令行指定：${explicit}`);
    return done(explicit);
  }

  // 2. 任务说明 worker 是具体的配置名：不可用就报错，不悄悄换人。
  const worker = text(spec?.worker)?.trim();
  if (worker && worker !== 'auto') {
    const reason = unavailable(worker, { pool: false });
    if (reason) { trace.push(`任务说明指定：${worker}：${reason}`); fail('PROFILE_UNAVAILABLE', `任务说明指定的执行者 ${worker} 不可用：${reason}`); }
    if (!canExecute(profiles[worker])) trace.push(`${worker} 没有设为可担任执行者，按明确指定使用`);
    limitNote(worker);
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
        return done(rule.profile, { scope, index: i + 1 }, text(rule.escalate), text(rule.effort)?.trim() || null);
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
  if (enabled.length === 1 && !canExecute(profiles[enabled[0]])) fail('NO_PROFILE', `唯一启用的执行者 ${enabled[0]} 没有设为可担任执行者：先用 ar roles set ${enabled[0]} roles=executor,reviewer 打开，或启用别的执行者`);
  fail('NO_PROFILE', `没有可用的执行者处理${type ? `「${type}」类` : '这个'}任务`);
}

// ---- 路由配置的读写（Stage07 T8：软件"路由"页用；技能与软件走同一条路径，写入都由核心校验后原子写 config.json） ----

const profileLabel = (name, profile) => text(profile?.label) ?? adapters[profile?.adapter]?.label ?? name;

// routing.reviewer 的读法：{ profiles, mustDiffer, differFamily, differFromLead }。没有或 null 按空处理；旧的单值写法（字符串，或只写 profile 的对象）读成只有一项的 profiles。
// 三个开关都可以关（190 D128）：mustDiffer 只管不能是执行者本人，默认 true；differFamily 管不能与执行者同家族，没写时等于 mustDiffer（旧配置 mustDiffer: false 不会多出家族限制）；
// differFromLead 管不能与主导同家族，默认 true。
export function reviewerOf(routing) {
  const value = routing?.reviewer;
  let profiles = [];
  if (typeof value === 'string' && value) profiles = [value];
  else if (object(value)) {
    if (Array.isArray(value.profiles)) profiles = value.profiles.filter(name => typeof name === 'string' && name);
    else if (text(value.profile)) profiles = [value.profile];
  }
  const mustDiffer = object(value) ? value.mustDiffer !== false : true;
  const differFamily = object(value) && typeof value.differFamily === 'boolean' ? value.differFamily : mustDiffer;
  return { profiles, mustDiffer, differFamily, differFromLead: object(value) ? value.differFromLead !== false : true };
}

// 软件"路由"页要的整份视图（只读）：规则、兜底、审查者候选、默认执行者、每个执行者的只读能力 / 每日上限 / 今天已用、已登记项目各有几条自己的规则。
export function routeConfigView(home, { now = Date.now() } = {}) {
  const config = readEffectiveConfig(home);
  const profiles = object(config.profiles) ? config.profiles : {};
  const enabled = Object.keys(profiles).filter(name => object(profiles[name]) && profiles[name].enabled !== false);
  const limitedNow = activeLimits(home, now);
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
    strongExecutor: text(config.routing?.strongExecutor),
    reviewer: reviewerOf(config.routing),
    // 与路由器的兜底顺序一致：defaultProfile，没有时取唯一启用的执行者。
    defaultProfile: text(config.defaultProfile) ?? (enabled.length === 1 ? enabled[0] : null),
    profiles: Object.entries(profiles).filter(([, profile]) => object(profile)).map(([name, profile]) => {
      const limits = object(profile.limits) ? profile.limits : {};
      const limited = limitedNow[name];
      return {
        name, label: profileLabel(name, profile), enabled: profile.enabled !== false, readOnly: supportsReadOnly(profile, config),
        limits: { maxTasksPerDay: limitOf(limits.maxTasksPerDay), maxTokensPerDay: limitOf(limits.maxTokensPerDay) },
        usage: usageToday({ home, profile: name, now }),
        // 现在被限流（额度用完 / 限流）才有这个字段：{ kind, until（恢复时间，毫秒）, since, evidence? }；evidence 是记录限流时的原文（已掩码），记录里没有才不带这个键；没被限流的执行者输出与以前相同。
        ...(limited ? { limited: { kind: limited.kind, until: limited.until, since: limited.since, ...(typeof limited.evidence === 'string' ? { evidence: limited.evidence } : {}) } } : {}),
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

// 规则的校验与整理：types 非空、每项是已知类型；profile 必须是已有的执行者；escalate 为 null / 不写或已有的执行者；effort 为 null / 不写或非空字符串；不能有别的字段。
function checkRules(value, config) {
  if (!Array.isArray(value)) throw new Error('规则必须是数组');
  return value.map((rule, index) => {
    const at = `第 ${index + 1} 条规则`;
    if (!object(rule)) throw new Error(`${at}必须是对象`);
    const extra = Object.keys(rule).filter(key => !['types', 'profile', 'escalate', 'effort'].includes(key));
    if (extra.length) throw new Error(`${at}不能有这些字段：${extra.join('、')}`);
    if (!Array.isArray(rule.types) || !rule.types.length) throw new Error(`${at}的 types 至少要有一个任务类型`);
    const unknown = rule.types.filter(type => !SPEC_TYPES.includes(type));
    if (unknown.length) throw new Error(`${at}的任务类型只能是 ${SPEC_TYPES.join('、')}（当前：${unknown.map(String).join('、')}）`);
    if (typeof rule.profile !== 'string' || !known(config, rule.profile)) throw new Error(`${at}的执行者 ${String(rule.profile)} 不存在`);
    if (rule.escalate != null && (typeof rule.escalate !== 'string' || !known(config, rule.escalate))) throw new Error(`${at}的升级执行者 ${String(rule.escalate)} 不存在`);
    if (rule.effort != null && (typeof rule.effort !== 'string' || !rule.effort.trim())) throw new Error(`${at}的推理强度 effort 必须是非空字符串（或 null、不写）`);
    return { types: [...rule.types], profile: rule.profile, ...(rule.escalate !== undefined ? { escalate: rule.escalate } : {}), ...(rule.effort !== undefined ? { effort: typeof rule.effort === 'string' ? rule.effort.trim() : rule.effort } : {}) };
  });
}

// 审查者候选的校验与整理：{ profiles: [已有的执行者名], mustDiffer?, differFamily?, differFromLead? }（三个布尔开关，190 D128）；
// 兼容只写一个 profile 的旧写法。写入时统一成 { profiles, mustDiffer }，写了 differFamily / differFromLead 才带它。
function checkReviewer(value, config) {
  if (!object(value)) throw new Error('审查者设置必须是对象');
  const extra = Object.keys(value).filter(key => !['profiles', 'profile', 'mustDiffer', 'differFamily', 'differFromLead'].includes(key));
  if (extra.length) throw new Error(`审查者设置不能有这些字段：${extra.join('、')}`);
  if (value.mustDiffer !== undefined && typeof value.mustDiffer !== 'boolean') throw new Error('审查者设置的 mustDiffer 必须是布尔值');
  if (value.differFamily !== undefined && typeof value.differFamily !== 'boolean') throw new Error('审查者设置的 differFamily 必须是布尔值');
  if (value.differFromLead !== undefined && typeof value.differFromLead !== 'boolean') throw new Error('审查者设置的 differFromLead 必须是布尔值');
  let profiles;
  if (value.profiles !== undefined) {
    if (!Array.isArray(value.profiles)) throw new Error('审查者设置的 profiles 必须是数组');
    profiles = value.profiles;
  } else if (value.profile !== undefined) profiles = [value.profile];
  else throw new Error('审查者设置要写 profiles（执行者名数组）');
  const missing = profiles.filter(name => typeof name !== 'string' || !known(config, name));
  if (missing.length) throw new Error(`审查者候选里的执行者不存在：${missing.map(String).join('、')}`);
  return { profiles: [...profiles], mustDiffer: value.mustDiffer !== false, ...(value.differFamily !== undefined ? { differFamily: value.differFamily } : {}), ...(value.differFromLead !== undefined ? { differFromLead: value.differFromLead } : {}) };
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
  '  ar route strong set <执行者名> | clear',
  '  ar route suggest [--json]',
  '  ar route limit set <执行者名> [--tasks <正整数>|""] [--tokens <正整数>|""]',
  '  ar route limits clear <执行者名>（手动清除限流标记，之后路由立刻把它当可用）',
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
    const lines = [`规则：${result.rules.length} 条`, ...result.rules.map((rule, i) => `  ${i + 1}. [${rule.types?.join(', ')}] → ${rule.profile}${rule.escalate ? `，升级到 ${rule.escalate}` : ''}${rule.effort ? `，推理强度 ${rule.effort}` : ''}`),
      `兜底：${result.fallback ? name(result.fallback) : '无（用默认执行者）'}`,
      `审查者候选：${result.reviewer.profiles.length ? result.reviewer.profiles.join('、') : '无'}（必须与执行者不同：${result.reviewer.mustDiffer ? '是' : '否'}；必须与执行者不同家族：${result.reviewer.differFamily ? '是' : '否'}；必须与主导不同：${result.reviewer.differFromLead ? '是' : '否'}）`,
      `强执行者：${result.strongExecutor ? name(result.strongExecutor) : '未设置（最后一次自动重试不换人，全部失败后提示主导接手）'}`,
      ...result.profiles.flatMap(p => [
        `执行者 ${p.name}：今天 ${p.usage.tasks} 个任务、${p.usage.tokens} token；上限 任务 ${p.limits.maxTasksPerDay ?? '不限'}、token ${p.limits.maxTokensPerDay ?? '不限'}${p.readOnly ? '' : '；不支持只读'}`,
        // 被限流的执行者多一行（只加行，不改上面的行）。
        ...(p.limited ? [`  ${p.name}：额度到 ${clockText(p.limited.until)} 恢复`] : []),
      ]),
      ...result.projectRules.map(p => `项目 ${p.project} 有 ${p.count} 条自己的规则`)];
    return { result, text: lines.join('\n') };
  }
  if (group === 'suggest') return suggestCommand(rest, { home });
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
  if (group === 'strong' && action === 'set' && args.length === 1) {
    updateConfig(home, config => {
      if (!known(config, args[0])) throw new Error(`找不到执行者：${args[0]}`);
      config.routing = { ...(object(config.routing) ? config.routing : {}), strongExecutor: args[0] };
    });
    return view(`已设置强执行者：${args[0]}`);
  }
  if (group === 'strong' && action === 'clear' && !args.length) {
    updateConfig(home, config => { config.routing = { ...(object(config.routing) ? config.routing : {}), strongExecutor: null }; });
    return view('已清除强执行者');
  }
  if (group === 'reviewer' && action === 'set' && args.length === 1) {
    updateConfig(home, config => {
      const reviewer = checkReviewer(parseArgument(args[0], '审查者设置'), config);
      // 这次没写 differFamily / differFromLead 就保留已有的值（Stage07c T4、190 D128）。
      const current = object(config.routing?.reviewer) ? config.routing.reviewer : {};
      for (const key of ['differFamily', 'differFromLead']) {
        if (reviewer[key] === undefined && typeof current[key] === 'boolean') reviewer[key] = current[key];
      }
      config.routing = { ...(object(config.routing) ? config.routing : {}), reviewer };
    });
    return view('已更新审查者候选');
  }
  // 手动清除限流标记（Stage07c 154）：执行者必须存在；没有记录也成功（cleared: false）。
  if (group === 'limits' && action === 'clear' && args.length === 1) {
    if (!known(readEffectiveConfig(home), args[0])) throw new Error(`找不到执行者：${args[0]}`);
    const cleared = clearLimit(home, args[0]);
    return { result: { cleared }, text: cleared ? `已清除 ${args[0]} 的限流标记` : `${args[0]} 没有限流标记，没有改动` };
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