// 路由规则建议（Stage07c T5）：按已导入、启用、测试连接通过的执行者和预设 types 生成建议规则。
// suggestRules 是纯函数；suggestCommand（ar route suggest）只读 config.json 与 agent-tests.json，不写任何文件，采用建议仍走 ar route rules set。
import { join } from 'node:path';
import { adapters } from '../adapters/index.mjs';
import { readJson } from './json.mjs';
import { readEffectiveConfig } from './config.mjs';
import { presetObjects } from './agents.mjs';
import { rolesOf } from './roles.mjs';
import { supportsReadOnly, READ_ONLY_TYPES } from './router.mjs';
import { SPEC_TYPES } from './spec.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value !== '' ? value : null);

const TYPE_LABELS = { code: '代码', test: '测试', fix: '修复', refactor: '重构', research: '调研', docs: '文档', review: '审查' };
const typeText = types => types.map(type => TYPE_LABELS[type] ?? type).join('、');
const pad = number => String(number).padStart(2, '0');
const timeText = at => {
  const date = new Date(at);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

// 执行者对应的预设：先按名字加适配器，再按接口地址（Claude Code）/ 程序名（通用适配器）/ 有无 provider（Codex）。
// 兼容后端、OpenAI 兼容接口、自定义 CLI 找不到带 types 的预设，不参与。
function presetOf(name, profile, presets, config) {
  const same = presets.find(p => p.name === name && p.profile.adapter === profile.adapter);
  if (same) return same.profile;
  const kind = presets.filter(p => p.profile.adapter === profile.adapter && (p.profile.provider != null) === (profile.provider != null));
  if (profile.adapter === 'claude-code') {
    const url = text(profile.env?.ANTHROPIC_BASE_URL);
    if (url) return kind.find(p => p.profile.env?.ANTHROPIC_BASE_URL === url)?.profile ?? null;
    // 没有接口地址：官方 Claude，按用到的密钥变量名分辨。
    const secrets = Object.keys(object(profile.secrets) ? profile.secrets : {});
    return kind.find(p => !p.profile.env?.ANTHROPIC_BASE_URL && Object.keys(p.profile.secrets ?? {}).some(key => secrets.includes(key)))?.profile ?? null;
  }
  if (profile.adapter === 'generic') {
    const decl = object(profile.genericDecl) ? profile.genericDecl : object(profile.generic) ? profile.generic : config.generics?.[profile.generic];
    const executable = text(decl?.executable);
    return executable ? kind.find(p => p.profile.generic?.executable === executable)?.profile ?? null : null;
  }
  return kind[0]?.profile ?? null;
}

// config：配置（profiles 的顺序即优先顺序，routing.rules 是已有规则）；presets：presetObjects() 的结果；tests：agent-tests.json 的内容。
export function suggestRules({ config = {}, presets = [], tests = {} } = {}) {
  const profiles = object(config.profiles) ? config.profiles : {};
  const existing = Array.isArray(config.routing?.rules) ? config.routing.rules : [];
  const rules = [], skipped = [];
  const taken = new Map(); // 类型 → 已经分给它的执行者
  let candidates = 0;

  for (const [name, profile] of Object.entries(profiles)) {
    if (!object(profile)) continue;
    const skip = (why, types) => skipped.push({ profile: name, ...(types ? { types } : {}), why });
    if (profile.enabled === false) { skip('已停用'); continue; }
    if (!rolesOf(profile).executor) { skip('没有设为可担任执行者'); continue; }
    const test = object(tests[name]) ? tests[name] : null;
    if (!test) { skip('还没有测试连接'); continue; }
    if (test.ok !== true) { skip('测试连接没有通过'); continue; }
    const preset = presetOf(name, profile, presets, config);
    const presetTypes = Array.isArray(preset?.types) ? preset.types.filter(type => SPEC_TYPES.includes(type)) : [];
    if (!presetTypes.length) { skip('没有预设的任务类型（兼容后端、OpenAI 兼容接口、自定义 CLI 不参与建议）'); continue; }
    candidates++;

    const mine = [];
    for (const type of presetTypes) {
      if (type === 'review') continue; // 审查交给审查者候选。
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
  const { candidates, ...result } = suggestRules({ config, presets: presetObjects(), tests });
  const lines = result.rules.map(rule => `${typeText(rule.types)} → ${rule.profile}：${rule.why}`);
  if (!result.rules.length) lines.push(candidates ? '没有可建议的规则：能建议的类型已被已有规则覆盖' : '没有可建议的规则：先导入并测试通过至少一个执行者');
  for (const item of result.skipped) lines.push(`跳过 ${item.profile ?? typeText(item.types)}${item.profile && item.types ? `（${typeText(item.types)}）` : ''}：${item.why}`);
  if (result.rules.length) lines.push(`采用：${result.write}`);
  return { result: { rules: result.rules, skipped: result.skipped, write: result.write }, text: lines.join('\n') };
}
