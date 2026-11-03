// 路由规则建议（Stage07c T5）：按已导入、启用、测试连接通过的执行者和预设 types 生成建议规则。
// suggestRules 是纯函数；suggestCommand（ar route suggest）只读 config.json 与 agent-tests.json，不写任何文件，采用建议仍走 ar route rules set。
import { join } from 'node:path';
import { adapters } from '../adapters/index.mjs';
import { readJson } from './json.mjs';
import { readEffectiveConfig, priceTable } from './config.mjs';
import { presetObjects, suggestionPresetOf } from './agents.mjs';
import { rolesOf } from './roles.mjs';
import { makeGeneric } from '../adapters/generic.mjs';
import { SPEC_TYPES } from './spec.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value !== '' ? value : null);

const TYPE_LABELS = { code: '代码', test: '测试', fix: '修复', refactor: '重构', research: '调研', docs: '文档', review: '审查', chore: '杂务' };
const typeText = types => types.map(type => TYPE_LABELS[type] ?? type).join('、');
const pad = number => String(number).padStart(2, '0');
const timeText = at => {
  const date = new Date(at);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

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


// config：配置（profiles 的顺序即优先顺序，routing.rules 是已有规则）；presets：presetObjects() 的结果；tests：agent-tests.json 的内容。
export function suggestRules({ config = {}, presets = [], tests = {} } = {}) {
  const profiles = object(config.profiles) ? config.profiles : {};
  const existing = Array.isArray(config.routing?.rules) ? config.routing.rules : [];
  const rules = [], skipped = [];
  const taken = new Map(); // 类型 → 已经分给它的执行者
  let candidates = 0;
  const prices = priceTable(config).prices;
  const priced = Object.entries(profiles).filter(([name, profile]) => object(profile) && profile.enabled !== false && rolesOf(profile).executor && tests[name]?.ok === true && prices[name]);
  for (const type of ['research', 'chore']) {
    if (existing.some(rule => object(rule) && Array.isArray(rule.types) && rule.types.includes(type))) continue;
    const eligible = priced.filter(([, profile]) => type !== 'research' || supportsReadOnly(profile, config));
    const currencies = [...new Set(eligible.map(([name]) => prices[name].currency))].sort();
    if (currencies.length > 1) {
      skipped.push({ types: [type], why: `已填单价的币种不同（${currencies.join('、')}），不比较高低` });
      continue;
    }
    eligible.sort(([a], [b]) => prices[a].input + prices[a].output - prices[b].input - prices[b].output);
    if (!eligible.length) continue;
    const name = eligible[0][0];
    taken.set(type, name);
    rules.push({ types: [type], profile: name, why: `按单价最低（输入加输出，${currencies[0]}）` });
  }

  for (const [name, profile] of Object.entries(profiles)) {
    if (!object(profile)) continue;
    const skip = (why, types) => skipped.push({ profile: name, ...(types ? { types } : {}), why });
    if (profile.enabled === false) { skip('已停用'); continue; }
    if (!rolesOf(profile).executor) { skip('没有设为可担任执行者'); continue; }
    const test = object(tests[name]) ? tests[name] : null;
    if (!test) { skip('还没有测试连接'); continue; }
    if (test.ok !== true) { skip('测试连接没有通过'); continue; }
    const preset = suggestionPresetOf(name, profile, presets, config);
    const presetTypes = Array.isArray(preset?.types) ? preset.types.filter(type => SPEC_TYPES.includes(type)) : [];
    if (!presetTypes.length) { skip('没有预设的任务类型（兼容后端、OpenAI 兼容接口、自定义 CLI 不参与建议）'); continue; }
    candidates++;

    const mine = [];
    for (const type of presetTypes) {
      if (type === 'review') continue; // 审查交给审查者候选。
      if (type === 'research' && taken.has(type) && prices[taken.get(type)]) continue;
      if (READ_ONLY_TYPES.includes(type) && !supportsReadOnly(profile, config)) { skip(`${TYPE_LABELS[type]}需要只读，这个执行者不支持`, [type]); continue; }
      const covered = existing.findIndex(rule => object(rule) && Array.isArray(rule.types) && rule.types.includes(type));
      if (covered >= 0) { skipped.push({ types: [type], why: `已有规则 ${covered + 1} 覆盖${TYPE_LABELS[type]}` }); continue; }
      if (taken.has(type)) { skip(`${TYPE_LABELS[type]}已建议给排在前面的 ${taken.get(type)}`, [type]); continue; }
      taken.set(type, name);
      mine.push(type);
    }
    if (!mine.length) continue;
    const label = text(profile.label) ?? text(preset.title) ?? adapters[profile.adapter]?.label ?? name;
    rules.push({ types: mine, profile: name, why: `${label} 的预设建议用于${typeText(presetTypes)}；测试连接 ${timeText(test.at)} 通过` });
  }

  const merged = [...existing, ...rules.map(({ types, profile }) => ({ types, profile }))];
  return { rules, skipped, candidates, write: `ar route rules set '${JSON.stringify(merged)}'` };
}

// ar route suggest [--json]：返回 { result, text }。
export function suggestCommand(rest, { home }) {
  if (rest.length !== 1) throw new Error('用法：ar route suggest [--json]');
  const config = readEffectiveConfig(home);
  let tests = {};
  try { const value = readJson(join(home, 'agent-tests.json')); if (object(value)) tests = value; } catch { /* 没有测试记录就是都没测过。 */ }
  const presets = presetObjects();
  const { candidates, ...result } = suggestRules({ config, presets, tests });
  result.rules = result.rules.map(rule => {
    const fit = suggestionPresetOf(rule.profile, config.profiles[rule.profile], presets, config)?.fit;
    return fit ? { ...rule, fit } : rule;
  });
  const lines = result.rules.map(rule => `${typeText(rule.types)} → ${rule.profile}：${rule.why}${rule.fit ? `；擅长：${rule.fit.good.join('、')}；避免：${rule.fit.avoid.join('、')}` : ''}`);
  if (!result.rules.length) lines.push(candidates ? '没有可建议的规则：能建议的类型已被已有规则覆盖' : '没有可建议的规则：先导入并测试通过至少一个执行者');
  for (const item of result.skipped) lines.push(`跳过 ${item.profile ?? typeText(item.types)}${item.profile && item.types ? `（${typeText(item.types)}）` : ''}：${item.why}`);
  if (result.rules.length) lines.push(`采用：${result.write}`);
  return { result: { rules: result.rules, skipped: result.skipped, write: result.write }, text: lines.join('\n') };
}
