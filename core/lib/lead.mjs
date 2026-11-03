import { confirmAck } from './lead-ack.mjs';
// 主导选择与启动计划：只计算参数，不启动进程。
import { leadBrief } from './lead-brief.mjs';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readEffectiveConfig, updateConfig } from './config.mjs';
import { rolesOf } from './roles.mjs';
import { authOf } from './env.mjs';
import { registeredProject } from './project.mjs';
import { adapterFor, resolveProfile } from '../adapters/index.mjs';

const unset = '还没有选主导：ar lead set <执行者名>';
const usage = '用法：ar lead [show] | set <执行者名> | clear | plan --project <路径> [--model <模型>] [--effort <级别>] | practices [<节号>] | brief | ack <确认码>';

function selected(config, name, { setting = false } = {}) {
  const raw = config.profiles?.[name];
  if (!raw) throw new Error(setting ? `没有这个执行者：${name}` : `主导 ${name} 不存在或已停用`);
  if (raw.enabled === false) throw new Error(setting ? `${name} 已停用` : `主导 ${name} 不存在或已停用`);
  if (!rolesOf(raw).lead) throw new Error(`${name} 不能担任主导：先运行 ar roles set ${name} roles=…,lead`);
  const profile = resolveProfile(raw, config), adapter = adapterFor(profile, { config });
  const label = profile.label || adapter.label || name;
  const capabilities = profile.adapter === 'generic'
    ? (adapter.declaration?.interactive ? { model: !!adapter.declaration.interactive.model, effort: !!adapter.declaration.interactive.effort } : null)
    : (typeof adapter.interactiveLaunch === 'function' ? { model: true, effort: true } : null);
  return { profile, adapter, label, capabilities };
}

function launchFor(chosen, options) {
  try { return chosen.adapter.interactiveLaunch(chosen.profile, options); }
  catch (error) {
    if (!error.message.startsWith('找不到 ')) throw error;
    const program = chosen.profile.adapter === 'generic' ? chosen.adapter.declaration.executable
      : chosen.profile.path || (chosen.profile.adapter === 'codex' ? 'codex' : 'claude');
    throw new Error(`找不到 ${chosen.label} 的程序：${program}`);
  }
}

export function leadCommand(rest, { home, cwd, env = process.env, coreDir }) {
  const action = rest[0] ?? 'show';
  if (action === 'practices') {
    if (rest.length > 2 || (rest.length === 2 && !/^(?:[1-9]|[1-9][0-9])$/.test(rest[1]))) throw new Error(usage);
    const section = rest.length === 2 ? Number(rest[1]) : null;
    const dir = resolve(coreDir, 'templates/lead-practices');
    const file = join(dir, 'checklist.md'), examples = join(dir, 'examples.md'), closeout = join(dir, 'closeout.md');
    let checklist;
    try { checklist = readFileSync(file, 'utf8'); }
    catch { const text = `核心里没有经验清单：${file}`; return { result: { error: text }, text, code: 2 }; }
    const headings = [...checklist.matchAll(/^## (\d+)\.[^\n]*$/gm)];
    let text = checklist.trimEnd();
    if (section !== null) {
      const index = headings.findIndex(match => Number(match[1]) === section);
      if (index < 0) {
        text = `没有第 ${section} 节；可选：${headings.map(match => match[1]).join(',')}`;
        return { result: { error: text }, text, code: 2 };
      }
      text = `${checklist.slice(0, headings[0].index)}${checklist.slice(headings[index].index, headings[index + 1]?.index ?? checklist.length)}`.trimEnd();
    }
    return { result: { section, text, examples, closeout }, text: `${text}\n原因与例子：${examples}；收尾核对表：${closeout}` };
  }
  if (action === 'brief' && rest.length === 1) return leadBrief({ root: cwd, home, env, coreDir }).then(({ ok, sections, text, ack }) => ({ result: { ok, sections, ...(ack ? { ack } : {}) }, text }));
  if (action === 'ack' && rest.length === 2 && rest[1] && !rest[1].startsWith('--')) return confirmAck(cwd, coreDir, rest[1], env);
  if (action === 'clear' && rest.length === 1) {
    updateConfig(home, config => { delete config.lead; });
    return { result: {}, text: '已清除主导设置' };
  }
  if (action === 'set' && rest.length === 2 && rest[1] && !rest[1].startsWith('--')) {
    let chosen;
    updateConfig(home, config => {
      chosen = selected(config, rest[1], { setting: true });
      if (!chosen.capabilities) throw new Error(`${chosen.label} 还不支持作为主导启动（适配器没有交互启动方式）`);
      config.lead = rest[1];
    });
    return { result: { lead: rest[1] }, text: `主导：${chosen.label}` };
  }
  const config = readEffectiveConfig(home), name = config.lead;
  if (action === 'show' && rest.length <= 1) {
    if (!name || !config.profiles?.[name] || config.profiles[name].enabled === false) {
      const problem = name ? `主导 ${name} 不存在或已停用` : unset;
      return { result: { lead: null, problem }, text: problem };
    }
    // 显示已有选择时，即使角色后来被移除也照实展示。
    const profile = resolveProfile(config.profiles[name], config), adapter = adapterFor(profile, { config });
    const capabilities = profile.adapter === 'generic' ? (adapter.declaration?.interactive ? { model: !!adapter.declaration.interactive.model, effort: !!adapter.declaration.interactive.effort } : null) : (adapter.interactiveLaunch ? { model: true, effort: true } : null);
    const lead = { profile: name, label: profile.label || adapter.label || name, adapter: profile.adapter, supported: !!capabilities, capabilities: capabilities ?? { model: false, effort: false } };
    let problem;
    if (capabilities) {
      try { launchFor({ profile, adapter, label: lead.label }, { env }); }
      catch (error) { if (!error.message.startsWith('找不到 ')) throw error; problem = error.message; }
    }
    const text = `主导：${lead.label}（${name}，${lead.adapter}）\n交互启动：${lead.supported ? '支持' : '不支持'}；模型：${lead.capabilities.model ? '支持' : '不支持'}；推理强度：${lead.capabilities.effort ? '支持' : '不支持'}`;
    return { result: { lead, ...(problem ? { problem } : {}) }, text: problem ? `${text}\n${problem}` : text };
  }
  if (action !== 'plan' && action !== 'open') throw new Error(usage);
  const opts = {};
  for (let i = 1; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--project', '--model', '--effort'].includes(key) || Object.hasOwn(opts, key) || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new Error(usage);
    opts[key] = rest[i + 1];
  }
  if (!opts['--project']) throw new Error(usage);
  if (!name) throw new Error(unset);
  const chosen = selected(config, name);
  if (!chosen.capabilities) throw new Error(`${chosen.label} 还不支持作为主导启动（适配器没有交互启动方式）`);
  const root = resolve(cwd, opts['--project']), project = registeredProject(home, root);
  const sources = {}, values = {};
  for (const key of ['model', 'effort']) {
    const candidates = [[opts[`--${key}`], '命令行'], [project.lead?.[key], '项目'], [chosen.profile[key], '执行者配置']];
    const found = candidates.find(([value]) => typeof value === 'string' && value.length);
    values[key] = found?.[0] ?? null;
    sources[key] = found?.[1] ?? '工具默认';
    if (values[key] && !chosen.capabilities[key]) throw new Error(`${chosen.label} 不支持在启动时指定${key === 'model' ? '模型' : '推理强度'}`);
  }
  const launch = launchFor(chosen, { ...values, env });
  const envNames = [...new Set([...Object.keys(chosen.profile.env ?? {}), ...(authOf(chosen.profile) === 'token' ? Object.keys(chosen.profile.secrets ?? {}) : [])])];
  const result = { profile: name, label: chosen.label, adapter: chosen.profile.adapter, executable: launch.executable, args: launch.args, ...(launch.verbatim ? { verbatim: true } : {}), cwd: root, ...values, sources, capabilities: launch.capabilities, envNames };
  if (action === 'open') {
    try {
      mkdirSync(home, { recursive: true });
      appendFileSync(join(home, 'leads.jsonl'), `${JSON.stringify({ v: 1, event: 'lead-launch', at: Date.now(), project: project.path, profile: name, label: chosen.label, adapter: chosen.profile.adapter, ...values })}\n`);
    } catch (error) {
      return { result: { error: `记录主导启动失败：${error.message}` }, text: `记录主导启动失败：${error.message}`, code: 1 };
    }
    result.recorded = true;
  }
  return { result, text: JSON.stringify(result, null, 2) };
}
