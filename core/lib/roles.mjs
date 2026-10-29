// 角色设置与模型家族（Stage07c T4 + 190 D128）：每个执行者"可担任"执行者 / 审查者 / 主导，审查者按模型家族挑选。
// 主导家族由设为主导的 Agent 决定，一个都没设时按 Claude Code 算。
// 这里的函数都只读配置、不写文件；只有 rolesCommand 的 set 子命令经 updateConfig 写 config.json。
import { readFileSync } from 'node:fs';
import { adapters } from '../adapters/index.mjs';
import { FAMILY_NAME, readEffectiveConfig, updateConfig } from './config.mjs';
import { reviewerOf, supportsReadOnly } from './router.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

export const ROLE_NAMES = ['executor', 'reviewer', 'lead'];
// 没写 roles 时可担任执行者与审查者；主导要显式设置（D128：角色由用户决定）。
const DEFAULT_ROLES = ['executor', 'reviewer'];
// 没有任何 Agent 设为主导时，主导的模型家族按 Claude Code 算（D128）。TODO(Stage09)：主导可选工具后改成按所选工具取。
export const LEAD_FAMILY = 'claude';

// 前缀 → 家族表放在数据文件里（D17：代码里不写死服务商或模型名）。按顺序匹配，不分大小写。
// 读不到或格式不对时返回空表，所有判断都是"未知"，不抛错。
function loadFamilyTable() {
  try {
    const table = JSON.parse(readFileSync(new URL('../templates/model-families.json', import.meta.url), 'utf8'));
    if (!Array.isArray(table)) return [];
    return table.filter(item => object(item) && text(item.prefix) && text(item.family))
      .map(item => ({ prefix: item.prefix.trim().toLowerCase(), family: item.family.trim().toLowerCase(), host: item.host === true }));
  } catch { return []; }
}
const FAMILY_TABLE = loadFamilyTable();
// 让 Agent 自己选模型的值：这时看不出具体家族。
const SELF_CHOSEN = new Set(['auto', 'fast', 'default']);

// config.json 的 familyRules（Stage07c 154，D88）：形状不对的条目忽略（config 校验会先拒绝，这里只防手写绕过）；同一前缀（不分大小写）第一条为准。
function ruleEntries(config) {
  const seen = new Set(), entries = [];
  for (const rule of Array.isArray(config?.familyRules) ? config.familyRules : []) {
    const prefix = object(rule) ? text(rule.prefix)?.toLowerCase() : null, family = object(rule) ? text(rule.family) : null;
    if (!prefix || !family || !/^[a-z0-9-]+$/.test(family) || seen.has(prefix)) continue;
    seen.add(prefix);
    entries.push({ prefix, family });
  }
  return entries;
}

// 合并后的前缀 → 家族表：familyRules 在前（按它们的顺序），模板里同一前缀的条目被它们覆盖（保留模板的 host 标记：它说的是这个前缀是个域名关键字）。
// 每项带 source（familyRules / template）。
export function familyTable(config) {
  const rules = ruleEntries(config);
  const ruled = new Set(rules.map(item => item.prefix));
  const hostOf = new Map(FAMILY_TABLE.map(item => [item.prefix, item.host]));
  return [
    ...rules.map(item => ({ ...item, host: hostOf.get(item.prefix) === true, source: 'familyRules' })),
    ...FAMILY_TABLE.filter(item => !ruled.has(item.prefix)).map(item => ({ ...item, source: 'template' })),
  ];
}

// 合并后可选的家族名（去重、按名字排序）：界面"修改…"的多选与 modelFamilies 的校验都用它。
export function familyNames(config) {
  return [...new Set(familyTable(config).map(item => item.family))].sort();
}

export function familyOf(model, table = FAMILY_TABLE) {
  const name = text(model)?.toLowerCase();
  if (!name) return null;
  return table.find(item => name.startsWith(item.prefix))?.family ?? null;
}

// 接口地址里的域名 → 家族（只认表里标了 host 的项，其余是未知）。
function familyOfUrl(url, table = FAMILY_TABLE) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return table.find(item => item.host && host.includes(item.prefix))?.family ?? null;
}

// 可担任的角色：roles 没写就是执行者、审查者两项都有（source: 'default'），写了按写的（source: 'set'）；主导要显式设置。
export function rolesOf(profile) {
  const set = Array.isArray(profile?.roles) && profile.roles.length > 0;
  const roles = set ? ROLE_NAMES.filter(role => profile.roles.includes(role)) : [...DEFAULT_ROLES];
  return { executor: roles.includes('executor'), reviewer: roles.includes('reviewer'), lead: roles.includes('lead'), roles, source: set ? 'set' : 'default' };
}

export function declaredFamilies(profile) {
  return Array.isArray(profile?.modelFamilies) ? [...new Set(profile.modelFamilies.map(text).filter(Boolean).map(item => item.toLowerCase()))] : [];
}

// 这个执行者"这次实际用的模型"属于哪些家族。model 不给就看执行者配置里的 model。
export function familiesOf(profile, { model, table = FAMILY_TABLE } = {}) {
  const used = text(model) ?? text(profile?.model);
  const unknown = { families: [], unknown: true, source: 'unknown' };
  if (used && !SELF_CHOSEN.has(used.toLowerCase())) {
    const family = familyOf(used, table);
    return family ? { families: [family], unknown: false, source: 'model' } : unknown;
  }
  const declared = declaredFamilies(profile);
  if (declared.length) return { families: declared, unknown: false, source: 'declared' };
  if (profile?.adapter === 'codex') {
    const url = text(profile.provider?.baseUrl);
    if (!url) return { families: ['gpt'], unknown: false, source: 'adapter' };
    const family = familyOfUrl(url, table);
    return family ? { families: [family], unknown: false, source: 'host' } : unknown;
  }
  if (profile?.adapter === 'claude-code') {
    const url = text(profile.env?.ANTHROPIC_BASE_URL);
    if (!url) return { families: ['claude'], unknown: false, source: 'adapter' };
    const family = familyOfUrl(url, table);
    return family ? { families: [family], unknown: false, source: 'host' } : unknown;
  }
  return unknown;
}

// 主导家族（D128）：所有启用且可担任 lead 的 Agent 的家族并集（familiesOf 算）。一个都没设时按 Claude Code 算（source: 'default'）。
// 其中有主导的家族未知时 unknown 为 true：differFromLead 开着就无法确认与主导不同家族，按"未知"跳过候选，不悄悄放行。
export function leadOf(config) {
  const profiles = object(config?.profiles) ? config.profiles : {};
  const table = familyTable(config);
  const names = Object.entries(profiles)
    .filter(([, profile]) => object(profile) && profile.enabled !== false && rolesOf(profile).lead)
    .map(([name]) => name);
  if (!names.length) return { profiles: [], families: [LEAD_FAMILY], unknown: false, source: 'default' };
  const families = new Set();
  let unknown = false;
  for (const name of names) {
    const info = familiesOf(profiles[name], { table });
    if (info.unknown) unknown = true;
    else for (const family of info.families) families.add(family);
  }
  return { profiles: names, families: [...families].sort(), unknown, source: 'set' };
}

const labelOf = (name, profile) => text(profile?.label) ?? adapters[profile?.adapter]?.label ?? name;
const familyText = info => (info.unknown ? '家族未知' : info.families.join('、'));

// 候选在原因里的写法：qoder-cn（Auto，声明范围含 xx 家族）。
function describe(name, profile, info) {
  const model = text(profile.model);
  if (info.source === 'declared') return `${name}（${model ?? '未指定模型'}，声明范围含 ${info.families.join('、')}）`;
  return `${name}（${model ?? '未指定模型'}，家族 ${familyText(info)}）`;
}

// 为这次执行挑审查者：按 routing.reviewer.profiles 的顺序取第一个合适的。
// executor 是执行者名；model 是这次实际用的模型（不给就用执行者配置里的）。
// exclude：这次审查已经失败过的审查者名，直接跳过（换下一个审查者再审时用）。
// unavailable：可选函数 (名字, 配置) => 原因 | null，给了的话在"不支持只读"之后调用（review.mjs 用它跳过被限流、已达每日上限的）。
// 三个开关（D128）：mustDiffer 只管"不能是执行者本人"；differFamily 管"不能与执行者同家族"（默认随 mustDiffer）；
// differFromLead 管"不能与主导同家族"。都关时任何可担任审查者、支持只读的执行者都能审，包括执行者本人。
export function pickReviewer({ config, executor, model, exclude = [], unavailable = null } = {}) {
  const profiles = object(config?.profiles) ? config.profiles : {};
  const reasons = [];
  const exec = profiles[executor];
  if (!object(exec)) return { ok: false, reasons: [{ profile: executor, why: `找不到执行者：${executor}` }] };
  const { profiles: candidates, mustDiffer, differFamily, differFromLead } = reviewerOf(config.routing);
  const lead = leadOf(config);
  const table = familyTable(config);
  const execInfo = familiesOf(exec, { model, table });
  const execLabel = `${labelOf(executor, exec)} 执行者`;
  if (!candidates.length) return { ok: false, reasons: [{ profile: null, why: '没有设置审查者候选：先在路由页或 ar route reviewer set 里添加' }] };
  const failed = new Set(Array.isArray(exclude) ? exclude : []);
  for (const name of candidates) {
    const profile = profiles[name];
    const skip = why => reasons.push({ profile: name, why });
    if (failed.has(name)) { skip('这次审查已经失败过'); continue; }
    if (!object(profile)) { skip('不存在'); continue; }
    if (profile.enabled === false) { skip('已停用'); continue; }
    if (!rolesOf(profile).reviewer) { skip('没有设为可担任审查者'); continue; }
    if (!supportsReadOnly(profile, config)) { skip('不支持只读'); continue; }
    const blocked = typeof unavailable === 'function' ? unavailable(name, profile) : null;
    if (blocked) { skip(blocked); continue; }
    if (mustDiffer && name === executor) { skip('就是执行者本人'); continue; }
    const info = familiesOf(profile, { table });
    if ((differFamily || differFromLead) && info.unknown) { skip('家族未知：请在编辑里补"可能用到的模型范围"或手动指定审查者'); continue; }
    if (differFromLead) {
      if (lead.unknown) { skip('主导的家族未知：请在编辑里补"可能用到的模型范围"或手动指定审查者'); continue; }
      const shared = info.families.filter(family => lead.families.includes(family));
      if (shared.length) { skip(`与主导同家族（${shared.join('、')}）`); continue; }
    }
    if (differFamily) {
      if (execInfo.unknown) { skip(`${execLabel}的家族未知：请在编辑里补"可能用到的模型范围"或手动指定审查者`); continue; }
      const shared = info.families.filter(family => execInfo.families.includes(family));
      if (shared.length) { skip(`${execLabel}与 ${describe(name, profile, info)}同家族（${shared.join('、')}）`); continue; }
    }
    return { ok: true, profile: name, families: info.families, reasons };
  }
  return { ok: false, reasons };
}

// ---- ar roles ----

const rolesUsage = [
  '用法：ar roles [--json]',
  '  ar roles --review-for <执行者名> [--model <模型>]',
  '  ar roles set <执行者名> [roles=executor,reviewer,lead] [modelFamilies=<家族,…>]',
  '      值为空表示恢复默认 / 清除；家族只能从 ar roles family list 的列表里选',
  '  ar roles family set <模型名前缀> <家族> | clear <模型名前缀> | list [--json]',
  '      补充或覆盖模型到家族的对应，存在 config.json 的 familyRules',
].join('\n');

export function rolesView(config) {
  const profiles = object(config.profiles) ? config.profiles : {};
  const reviewer = reviewerOf(config.routing);
  const lead = leadOf(config);
  const table = familyTable(config);
  return {
    // 合并后的家族名（模板 + familyRules，去重、按名字排序）：界面"修改…"的多选用它。
    families: familyNames(config),
    profiles: Object.entries(profiles).filter(([, profile]) => object(profile) && profile.enabled !== false).map(([name, profile]) => {
      const roles = rolesOf(profile);
      const family = familiesOf(profile, { table });
      return { name, label: labelOf(name, profile), roles: roles.roles, rolesSource: roles.source, model: text(profile.model), modelFamilies: declaredFamilies(profile), families: family.families, familiesUnknown: family.unknown, familiesSource: family.source };
    }),
    reviewerOrder: reviewer.profiles,
    mustDiffer: reviewer.mustDiffer,
    differFamily: reviewer.differFamily,
    differFromLead: reviewer.differFromLead,
    // 主导（D128）：设为主导的 Agent、它们的家族（并集），source 为 'set' / 'default'（没设时按 Claude Code）。
    lead: { profiles: lead.profiles, families: lead.families, source: lead.source },
    // 保留原来的字段给已有读取方：值取 families 的第一个。
    leadFamily: lead.families[0] ?? null,
  };
}

const sourceText = { model: '按模型', declared: '按声明', adapter: '按适配器默认', host: '按接口地址', unknown: '' };
const roleText = { executor: '执行者', reviewer: '审查者', lead: '主导' };

// 主导那一行（D128）：设了写"名字（家族 …）"，没设写默认。
// 有主导的家族未知时，已知家族照写，再补"另有家族未知"；全部未知时只写"家族未知"。
function leadLine(lead) {
  if (lead.source === 'default') return `主导：未设置（按 Claude Code，家族 ${LEAD_FAMILY}）`;
  const known = lead.families.length ? `家族 ${lead.families.join('、')}` : '家族未知';
  const family = lead.unknown && lead.families.length ? `${known}，另有家族未知` : known;
  return `主导：${lead.profiles.join('、')}（${family}）`;
}

// lead 是 leadOf 的结果：rolesView 的 lead 字段只给 JSON 的部分字段（不含 unknown），这一行要用完整的。
function viewLines(view, lead) {
  const lines = ['执行者：'];
  for (const p of view.profiles) {
    const family = p.familiesUnknown ? '未知' : `${p.families.join('、')}（${sourceText[p.familiesSource]}）`;
    lines.push(`  ${p.name}（${p.label}）：可担任 ${p.roles.map(role => roleText[role]).join('、')}（${p.rolesSource === 'default' ? '默认' : '设置'}）；模型 ${p.model ?? '未指定'}；家族 ${family}`);
  }
  lines.push(`审查者候选顺序：${view.reviewerOrder.length ? view.reviewerOrder.join('、') : '无'}`);
  lines.push(leadLine(lead));
  lines.push(`审查者必须与执行者不同（mustDiffer）：${view.mustDiffer ? '是' : '否'}`);
  lines.push(`审查者必须与执行者不同家族（differFamily）：${view.differFamily ? '是' : '否'}`);
  lines.push(`审查者必须与主导不同（differFromLead）：${view.differFromLead ? '是' : '否'}`);
  return lines;
}

function reviewLines(executor, result) {
  const lines = [result.ok ? `审查者：${result.profile}（家族 ${result.families.join('、')}）` : `没有合适的审查者（执行者 ${executor}）`];
  for (const { profile, why } of result.reasons) lines.push(`  跳过${profile ? ` ${profile}` : ''}：${why}`);
  return lines;
}

// 返回 { result, text }；出错抛中文原因。ar roles set 与 ar route ... set 一样：校验在 updateConfig 里，不通过一个字节都不写。
// 合并后的整张前缀 → 家族表（ar roles family list / set / clear 的结果）。
function familyListing(config) {
  const table = familyTable(config);
  return {
    families: familyNames(config),
    table: table.map(({ prefix, family, source }) => ({ prefix, family, source })),
    familyRules: ruleEntries(config).map(({ prefix, family }) => ({ prefix, family })),
  };
}

function familyLines(listing) {
  const lines = [`模型名前缀 → 家族（共 ${listing.table.length} 项，来自 familyRules 的排在前面）：`];
  for (const item of listing.table) lines.push(`  ${item.prefix} → ${item.family}（${item.source === 'familyRules' ? 'familyRules' : '内置'}）`);
  lines.push(`可选的家族：${listing.families.join('、')}`);
  return lines;
}

// ar roles family list / set <前缀> <家族> / clear <前缀>：只改 config.json 的 familyRules（校验不过一个字节都不写，写入走 updateConfig 的原子写入）。
function familyCommand(rest, { home }) {
  const [, action, ...args] = rest;
  if (action === 'list' && !args.length) {
    const listing = familyListing(readEffectiveConfig(home));
    return { result: listing, text: familyLines(listing).join('\n') };
  }
  if ((action === 'set' && args.length === 2) || (action === 'clear' && args.length === 1)) {
    if (args.some(item => !item || item.startsWith('--'))) throw new Error(rolesUsage);
    const prefix = args[0].trim().toLowerCase();
    if (!prefix) throw new Error(rolesUsage);
    let cleared = false;
    updateConfig(home, config => {
      const existing = Array.isArray(config.familyRules) ? config.familyRules : [];
      const same = rule => object(rule) && text(rule.prefix)?.toLowerCase() === prefix;
      const others = existing.filter(rule => !same(rule));
      cleared = others.length !== existing.length;
      if (action === 'set') {
        const family = args[1].trim();
        if (!FAMILY_NAME.test(family)) throw new Error(`家族名只能由小写字母、数字、连字符组成：${args[1]}`);
        // 同一前缀已有的条目原地替换（多余的重复项并掉），没有就追加到最后。
        const at = existing.findIndex(same);
        config.familyRules = at >= 0 ? [...others.slice(0, at), { prefix, family }, ...others.slice(at)] : [...others, { prefix, family }];
      } else if (others.length) config.familyRules = others;
      else delete config.familyRules;
    });
    const listing = familyListing(readEffectiveConfig(home));
    const message = action === 'set' ? `已设置：${prefix} → ${args[1].trim()}` : cleared ? `已清除 familyRules 里的前缀 ${prefix}` : `familyRules 里没有前缀 ${prefix}，没有改动`;
    return { result: { ...listing, updated: prefix, ...(action === 'clear' ? { cleared } : {}) }, text: message };
  }
  throw new Error(rolesUsage);
}

export function rolesCommand(rest, { home }) {
  if (rest[0] === 'family') return familyCommand(rest, { home });
  if (rest[0] === 'set') {
    const [, name, ...pairs] = rest;
    if (!name || name.startsWith('--') || !pairs.length) throw new Error(rolesUsage);
    const given = {};
    for (const pair of pairs) {
      const at = pair.indexOf('=');
      const key = at < 0 ? pair : pair.slice(0, at);
      if (at < 0 || !['roles', 'modelFamilies'].includes(key) || key in given) throw new Error(rolesUsage);
      given[key] = pair.slice(at + 1).split(',').map(item => item.trim()).filter(Boolean);
    }
    updateConfig(home, config => {
      if (!object(config.profiles?.[name])) throw new Error(`找不到执行者：${name}`);
      // 家族只能从合并后的列表里选（模板 + familyRules）；不在列表里时报错并列出可选值。
      if (given.modelFamilies?.length) {
        const allowed = familyNames(config);
        const unknown = given.modelFamilies.filter(item => !allowed.includes(item.toLowerCase()));
        if (unknown.length) throw new Error(`不认识的模型家族：${unknown.join('、')}。可选值：${allowed.join('、')}（要补充用 ar roles family set <前缀> <家族>）`);
      }
      for (const [key, value] of Object.entries(given)) {
        if (value.length) config.profiles[name][key] = key === 'modelFamilies' ? value.map(item => item.toLowerCase()) : value;
        else delete config.profiles[name][key];
      }
    });
    const config = readEffectiveConfig(home);
    return { result: { ...rolesView(config), updated: name }, text: `已更新 ${name} 的角色设置` };
  }
  const config = readEffectiveConfig(home);
  if (rest[0] === '--review-for') {
    const executor = rest[1];
    if (!executor || executor.startsWith('--')) throw new Error(rolesUsage);
    let model;
    if (rest.length === 4 && rest[2] === '--model' && rest[3] && !rest[3].startsWith('--')) model = rest[3];
    else if (rest.length !== 2) throw new Error(rolesUsage);
    const picked = pickReviewer({ config, executor, model });
    return { result: { executor, ...(model ? { model } : {}), ...picked }, text: reviewLines(executor, picked).join('\n') };
  }
  if (rest.length) throw new Error(rolesUsage);
  const view = rolesView(config);
  return { result: view, text: viewLines(view, leadOf(config)).join('\n') };
}
