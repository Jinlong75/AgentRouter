// 执行者管理：预设（core/templates/agents/*.json）与 ar agents / ar secrets 命令。
// 预设是唯一允许写具体服务商与模型的地方（D17、O10）。所有输出只含密钥的变量名与 set / missing，从不含值。
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig, builtinConfig, loadConfig, updateConfig, configInvalid, validateV2 } from './config.mjs';
import { secretStatus, setUserSecret } from './secrets.mjs';
import { authOf, buildEnv, ensureSandboxHome, secretSources } from './env.mjs';
import { adapterFor, adapters, genericDeclaration, resolveProfile } from '../adapters/index.mjs';
import { makeGeneric } from '../adapters/generic.mjs';
import { validateGeneric } from './generic-schema.mjs';
import { killProcessTree, pidAlive, redactPaths } from './process.mjs';
import { trace, traced, tracing } from './trace.mjs';
import { parseJson, readJson } from './json.mjs';
import { failureReason } from './progress.mjs';

const presetDir = fileURLToPath(new URL('../templates/agents/', import.meta.url));
const validProfileName = name => typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(name);
const AUTH_VALUES = ['login', 'token'];
const validEnvName = name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 全部预设对象，按 order 升序（没有 order 的按 0 排在最前）；order 相同时按文件名排，结果不随文件系统顺序变。
export function presetObjects() {
  return readdirSync(presetDir).filter(f => f.endsWith('.json')).sort().map(f => loadPreset(f.slice(0, -5)))
    .sort((a, b) => (a.profile.order ?? 0) - (b.profile.order ?? 0));
}

export function listPresets() {
  return presetObjects().map(p => p.name);
}

// 返回 { name, profile }；profile 不含 name 字段（名字是 profiles 的键）。
// 定位先按文件名；兼容后端等预设的文件名（claude-compat）与模板内 name（compat）不同，也允许用 name 字段定位。
export function loadPreset(name) {
  if (!validProfileName(name)) throw new Error(`预设名无效：${String(name).slice(0, 40)}`);
  let text;
  try { text = readFileSync(path.join(presetDir, `${name}.json`), 'utf8'); }
  catch {
    const match = readdirSync(presetDir).filter(f => f.endsWith('.json')).find(f => {
      try { return readJson(path.join(presetDir, f)).name === name; } catch { return false; }
    });
    if (!match) throw new Error(`没有预设 ${name}（可用：${listPresets().join('、')}）`);
    text = readFileSync(path.join(presetDir, match), 'utf8');
  }
  const { name: presetName, ...profile } = parseJson(text);
  return { name: presetName ?? name, profile };
}

// 预设里只给界面下拉用的说明字段：add 时不写进 config.json，presets --json 里有就输出。
// types：预设建议的任务类型；listModels：列出模型用的命令行参数（ar agents models 用）。
// card / variant：导入向导把同一服务的几个预设合成一张卡片（card），第 2 步用 variant 的分段按钮选具体预设。
const PRESET_ONLY = ['modelOptions', 'effortOptions', 'baseUrlOptions', 'listModels', 'types', 'card', 'variant'];

// 带 card 的预设按 card.id 分组：同组的 card 与 variant.label 必须一致，且 variant 完整，否则是模板错误。
export function checkPresetCards(presets) {
  const groups = new Map();
  for (const { name, profile } of presets) {
    const { card, variant } = profile;
    if (card === undefined && variant === undefined) continue;
    const ok = isObject(card) && isObject(variant) && [card.id, card.title, card.description, variant.label, variant.option, variant.help].every(v => typeof v === 'string' && v);
    if (!ok) throw new Error(`预设模板错误：${name} 的 card / variant 不完整（需要 card.id、title、description 与 variant.label、option、help）`);
    const group = groups.get(card.id) ?? [];
    group.push({ name, card, variant });
    groups.set(card.id, group);
  }
  for (const [id, group] of groups) {
    for (const item of group.slice(1)) {
      if (JSON.stringify(item.card) !== JSON.stringify(group[0].card) || item.variant.label !== group[0].variant.label) {
        throw new Error(`预设模板错误：卡片 ${id} 里 ${group[0].name} 与 ${item.name} 的 card 或 variant.label 不一致`);
      }
    }
    if (new Set(group.map(item => item.variant.option)).size !== group.length) throw new Error(`预设模板错误：卡片 ${id} 里有重复的 variant.option`);
  }
}

// --json 的预设摘要：name/title/description/recommended/adapter/label/auth/env/secrets，加上预设有的下拉说明字段。
function presetSummary({ name, profile }) {
  return { name, title: profile.title ?? name, description: profile.description ?? '', recommended: profile.recommended === true,
    adapter: profile.adapter, label: profile.label ?? profile.adapter, auth: authOf(profile), env: profile.env ?? {}, secrets: profile.secrets ?? {},
    // 预设给了默认模型 / 推理强度（例如 Qoder 国内版）：软件导入第 2 步的下拉据此选中初始值。
    ...(typeof profile.model === 'string' && profile.model ? { model: profile.model } : {}), ...(typeof profile.effort === 'string' && profile.effort ? { effort: profile.effort } : {}),
    ...Object.fromEntries(PRESET_ONLY.filter(key => profile[key] !== undefined).map(key => [key, profile[key]])) };
}

// 每项的模型名：适配器能算就由适配器算（Claude Code 读 env.ANTHROPIC_MODEL），否则取配置里的 model 字段。
function modelOf(adapter, profile) {
  if (adapter?.modelName) return adapter.modelName({ profile }) ?? null;
  if (profile.adapter === 'codex') return profile.model ?? null;
  return null;
}

// 只读：不触发迁移写入；没有配置时显示内置默认。配置存在却读不了时拒绝（协议第 4 节，063），
// 不列出内置默认的执行者。--detect 时才给每项补 installed / version。
// traceSteps：只有 ar agents list 打开阶段追踪（AR_CORE_TRACE=1 时才有输出）；其他调用者保持原样。
export function listAgents(home, { env = process.env, query, detect = false, traceSteps = false } = {}) {
  const step = (label, run) => traceSteps ? traced(label, run) : run();
  const state = step('agents list 读配置', () => readConfig(home));
  if (state.reason) throw configInvalid(state);
  const config = state.exists ? state.config : state.legacy?.config ?? builtinConfig();
  let selected = null;
  try { selected = step('agents list 确定默认执行者', () => loadConfig(home, {}, {}).profileName); } catch { /* 没有可用执行者时不标默认。 */ }
  const lastTests = step('agents list 读测试结果', () => readTestResults(home));
  const rows = Object.entries(config.profiles ?? {}).map(([name, p]) => {
    // generic 执行者的适配器由 config.generics 里的声明现做；声明有问题时是一个检测必然失败的适配器。
    let adapter;
    try { adapter = adapterFor(p, { config, tolerant: true }); } catch { adapter = undefined; }
    const auth = authOf(p);
    // 子进程步骤的追踪前缀：标签里有执行者名与适配器名（同名时只写一次）。
    const tracePrefix = traceSteps ? `agents list ${name}${name === p.adapter ? '' : ` ${p.adapter}`}` : undefined;
    // tracePrefix 只用于追踪标签，适配器忽略没有的字段；不改变 detect / loginStatus 的行为。
    const detectOptions = { env, settings: p, profile: p, ...(tracePrefix ? { tracePrefix } : {}) };
    const row = { name, adapter: p.adapter, label: p.label ?? adapter?.label ?? p.adapter, enabled: p.enabled !== false, supported: !!adapter, default: name === selected, auth,
      model: modelOf(adapter, p), lastTest: lastTests[name] ?? null };
    const detection = detect && adapter?.detect ? adapter.detect(detectOptions) : null;
    const secretNames = Object.values(p.secrets ?? {});
    // token：各个密钥变量是否已设置（只有 set / missing）；login：适配器能检测时显示是否已登录。
    row.secrets = auth === 'token' ? step(`agents list ${name} secretStatus（${secretNames.length} 个变量）`,
      () => secretStatus(secretNames, { env, ...(query ? { query } : {}), ...(tracePrefix ? { tracePrefix } : {}) })) : {};
    // generic 的登录状态永远是 unknown（声明里没有登录检测），不为它单独运行一次用户配置的程序。
    row.login = auth === 'login' && adapter?.loginStatus ? adapter.loginStatus({ env, detection: detection ?? (adapter.id === 'generic' ? null : adapter.detect(detectOptions)), ...(tracePrefix ? { tracePrefix } : {}) }) : null;
    if (detect) { row.installed = detection?.installed ?? false; row.version = detection?.version ?? null; }
    return row;
  });
  if (traceSteps) trace(`agents list 结果写出前（${rows.length} 项）`);
  return rows;
}

// D2（修订）：Codex 不当默认执行者。加入别的执行者时，如果当前默认是 Codex 或没有默认，就改用新加入的。
function shouldBecomeDefault(config, adapter) {
  return adapter !== 'codex' && (config.defaultProfile == null || config.profiles?.[config.defaultProfile]?.adapter === 'codex');
}

// add / update 共用的覆盖参数（原地修改）。校验失败直接抛错，调用方在写文件前就不会写入。
function applyProfileOptions(profile, { label, model, baseUrl, secretVar, maxTurns, effort }) {
  if (label !== undefined) profile.label = label;
  if (maxTurns !== undefined) profile.maxTurns = maxTurns;
  // 推理强度原样传给执行者（与 model 相同，不校验取值）；空串表示"默认"，删掉这一项。
  if (effort !== undefined) {
    if (effort === '') delete profile.effort;
    else profile.effort = effort;
  }
  // OpenAI 兼容接口（codex + provider）与通用适配器（{model} 占位符读 profile.model）：模型写 model，
  // 地址写 provider.baseUrl，密钥变量名同时是注入名（env_key）。
  const compat = profile.adapter === 'codex' && profile.provider != null;
  if (model !== undefined) {
    if (compat || profile.adapter === 'generic') profile.model = model;
    else if (profile.adapter !== 'claude-code') throw new Error('--model 只对 Claude Code 适配器有效');
    else profile.env = { ...profile.env, ANTHROPIC_MODEL: model };
  }
  if (baseUrl !== undefined) {
    if (compat) profile.provider = { ...profile.provider, baseUrl };
    else if (profile.adapter !== 'claude-code') throw new Error('--base-url 只对 Claude Code 适配器有效');
    else profile.env = { ...profile.env, ANTHROPIC_BASE_URL: baseUrl };
  }
  if (secretVar !== undefined) {
    if (!validEnvName(secretVar)) throw new Error(`变量名无效：${String(secretVar).slice(0, 64)}`);
    if (compat && !Object.keys(profile.secrets ?? {}).length) profile.secrets = { [secretVar]: secretVar };
    else if (!Object.keys(profile.secrets ?? {}).length) throw new Error('--secret-var 需要该执行者有密钥（token 认证）');
    else profile.secrets = Object.fromEntries(Object.entries(profile.secrets).map(([k]) => [k, secretVar]));
  }
  if (compat) {
    if (!profile.provider.baseUrl) throw new Error('缺少接口地址：用 --base-url 指定');
    if (!profile.model) throw new Error('缺少模型：用 --model 指定');
    if (!Object.keys(profile.secrets ?? {}).length) throw new Error('缺少密钥变量：用 --secret-var 指定');
  }
  // 兼容后端等预设把地址 / 模型留空，必须补齐后才能用（避免把空值写进配置）。
  if (profile.adapter === 'claude-code') {
    if (profile.env?.ANTHROPIC_BASE_URL === '') throw new Error('缺少接口地址：用 --base-url 指定');
    if (profile.env?.ANTHROPIC_MODEL === '') throw new Error('缺少模型：用 --model 指定');
  }
}

// 这个执行者对应的预设（取预设的下拉说明用）：先按名字，再按适配器（通用适配器再按程序名、OpenAI 兼容接口再按有无 provider）。
function presetFor(name, profile, config) {
  const presets = presetObjects();
  const same = presets.find(p => p.name === name && p.profile.adapter === profile.adapter);
  if (same) return same;
  let executable = null;
  if (profile.adapter === 'generic') {
    try { executable = genericDeclaration(profile, config).decl.executable; } catch { return null; }
  }
  return presets.find(p => p.profile.adapter === profile.adapter && (p.profile.provider != null) === (profile.provider != null)
    && (profile.adapter !== 'generic' || p.profile.generic?.executable === executable)) ?? null;
}

// 推理强度不在预设的可选值里时给一句提示（不拦：取值原样传给执行者）。
function effortWarning(effort, options) {
  if (typeof effort !== 'string' || effort === '' || !Array.isArray(options) || options.includes(effort)) return [];
  return [`提示：推理强度 ${effort} 不在可选值（${options.join('、')}）里；仍按你填的值传给执行者`];
}

export function addAgent(home, { preset, name, label, model, baseUrl, secretVar, auth, effort }) {
  const { name: presetName, profile } = loadPreset(preset);
  const target = name ?? presetName;
  if (!validProfileName(target)) throw new Error(`执行者名无效：${String(target).slice(0, 40)}（小写字母、数字、连字符）`);
  const p = structuredClone(profile);
  // 预设里给软件下拉用的说明字段，不写进 config.json。
  for (const key of PRESET_ONLY) delete p[key];
  // 通用适配器预设：声明写进 config.generics.<执行者名>，执行者配置里的 generic 只写这个名字。
  let declaration = null;
  if (p.adapter === 'generic' && isObject(p.generic)) { declaration = p.generic; p.generic = target; }
  if (auth !== undefined) {
    if (!AUTH_VALUES.includes(auth)) throw new Error('--auth 必须为 login 或 token');
    p.auth = auth;
    // Codex 从登录改 token 时没有密钥来源：补默认变量名 OPENAI_API_KEY（可用 --secret-var 覆盖）；OpenAI 兼容接口的密钥变量由 --secret-var 给。
    if (auth === 'token' && p.adapter === 'codex' && p.provider == null) p.secrets = { OPENAI_API_KEY: 'OPENAI_API_KEY' };
  }
  applyProfileOptions(p, { label, model, baseUrl, secretVar, maxTurns: undefined, effort });
  let madeDefault = false;
  updateConfig(home, config => {
    config.profiles ??= {};
    if (config.profiles[target]) throw new Error(`已有执行者 ${target}；换个名字（--name）或先 ar agents remove ${target}`);
    if (declaration) {
      config.generics ??= {};
      if (config.generics[target] !== undefined) throw new Error(`config.json 的 generics 里已有同名声明 ${target}；换个名字（--name）`);
      config.generics[target] = structuredClone(declaration);
    }
    config.profiles[target] = p;
    if (shouldBecomeDefault(config, p.adapter)) { config.defaultProfile = target; madeDefault = true; }
  });
  const warnings = effortWarning(effort, profile.effortOptions);
  return { name: target, preset, madeDefault, secrets: Object.values(p.secrets ?? {}), ...(warnings.length ? { warnings } : {}) };
}

// 通用适配器声明对应的执行者配置：add --generic 与导入单独声明共用。
function genericProfile(name, decl, label) {
  const secrets = isObject(decl.secrets) && Object.keys(decl.secrets).length ? structuredClone(decl.secrets) : null;
  return { adapter: 'generic', generic: name, label: label || decl.label || name, enabled: true, ...(secrets ? { auth: 'token', secrets } : { auth: 'login' }) };
}

// 自定义 CLI：用表单组装的声明直接加入执行者（声明写进 generics.<名>，执行者配置只引用名字）。
// 声明里的 secrets 同时写进执行者配置（列表里的认证状态按执行者配置算）。声明不合法时什么都不写。
export function addGenericAgent(home, { name, decl, label }) {
  if (!validProfileName(name)) throw new Error(`执行者名无效：${String(name).slice(0, 40)}（小写字母、数字、连字符）`);
  const checked = validateGeneric(decl, { path: 'generic' });
  if (!checked.ok) throw new Error(`通用适配器声明不合法：\n${problemLines(checked.errors.slice(0, 3)).join('\n')}`);
  const profile = genericProfile(name, decl, label);
  const secrets = profile.secrets ?? null;
  let madeDefault = false;
  updateConfig(home, config => {
    config.profiles ??= {};
    if (config.profiles[name]) throw new Error(`已有执行者 ${name}；换个名字（--name）或先 ar agents remove ${name}`);
    config.generics ??= {};
    if (config.generics[name] !== undefined) throw new Error(`config.json 的 generics 里已有同名声明 ${name}；换个名字（--name）`);
    config.generics[name] = structuredClone(decl);
    config.profiles[name] = profile;
    if (shouldBecomeDefault(config, 'generic')) { config.defaultProfile = name; madeDefault = true; }
  });
  return { name, madeDefault, secrets: Object.values(secrets ?? {}), ...(checked.warnings.length ? { warnings: problemLines(checked.warnings) } : {}) };
}

export function updateAgent(home, name, opts) {
  const config = updateConfig(home, config => {
    const profile = config.profiles?.[name];
    if (!profile) throw new Error(`找不到执行者：${name}`);
    applyProfileOptions(profile, opts);
    // 升级目标：必须是已有执行者且不是自己；空串删除这一项。
    if (opts.escalate !== undefined) {
      if (opts.escalate === '') delete profile.escalate;
      else if (opts.escalate === name) throw new Error('升级目标不能是执行者自己');
      else if (!config.profiles[opts.escalate]) throw new Error(`升级目标不存在：${opts.escalate}`);
      else profile.escalate = opts.escalate;
    }
  });
  const profile = config.profiles[name];
  const warnings = effortWarning(opts.effort, presetFor(name, profile, config)?.profile.effortOptions);
  return { name, profile, ...(warnings.length ? { warnings } : {}) };
}

export function setDefault(home, name) {
  updateConfig(home, config => {
    const profile = config.profiles?.[name];
    if (!profile) throw new Error(`找不到执行者：${name}`);
    if (profile.enabled === false) throw new Error(`执行者 ${name} 已停用，不能设为默认`);
    config.defaultProfile = name;
  });
  return { name, defaultProfile: name };
}

// generics.<名> 没有任何执行者引用时删掉，返回是否删了。
function pruneGeneric(config, ref) {
  if (typeof ref !== 'string' || config.generics?.[ref] === undefined) return false;
  if (Object.values(config.profiles ?? {}).some(p => p.generic === ref)) return false;
  delete config.generics[ref];
  return true;
}

export function removeAgent(home, name) {
  let defaultProfile, removedGeneric = null;
  updateConfig(home, config => {
    if (!config.profiles?.[name]) throw new Error(`找不到执行者：${name}`);
    const ref = config.profiles[name].adapter === 'generic' ? config.profiles[name].generic : null;
    delete config.profiles[name];
    // 通用适配器执行者的声明没有别人引用时一并删除。
    if (pruneGeneric(config, ref)) removedGeneric = ref;
    if (config.defaultProfile === name) {
      // 默认执行者被删：有别的非 Codex 启用执行者就用它，否则用 Codex，都没有则不设默认。
      const enabled = Object.entries(config.profiles).filter(([, p]) => p.enabled !== false);
      config.defaultProfile = enabled.find(([, p]) => p.adapter !== 'codex')?.[0] ?? enabled[0]?.[0] ?? null;
    }
    defaultProfile = config.defaultProfile ?? null;
  });
  return { name, defaultProfile, ...(removedGeneric ? { removedGeneric } : {}) };
}

export function setEnabled(home, name, enabled) {
  updateConfig(home, config => {
    if (!config.profiles?.[name]) throw new Error(`找不到执行者：${name}`);
    config.profiles[name].enabled = enabled;
  });
  return { name, enabled };
}

// ---- ar agents models ----

// 运行一次"列出模型"（或声明预览）的程序：默认标准输入关闭、工作目录是系统临时目录；给了 stdin 就写入后关闭。
// 超时后结束整棵进程树。返回 { status, stdout, stderr, error, timedOut }。
function runListing(spec, { env, timeoutMs, cwd = tmpdir(), stdin = null }) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false, timedOut = false, child;
    const done = value => { if (settled) return; settled = true; clearTimeout(timer); resolve({ stdout, stderr, timedOut, ...value }); };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid).catch(() => {}).finally(() => done({ status: null }));
    }, timeoutMs);
    try {
      child = spawn(spec.executable, spec.args, { cwd, env, shell: false, windowsHide: true, stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsVerbatimArguments: spec.verbatim === true });
      if (stdin != null) { child.stdin.on('error', () => {}); child.stdin.end(stdin, 'utf8'); }
    } catch (error) { done({ status: null, error }); return; }
    const keep = (text, chunk) => text.length < 1_000_000 ? text + chunk : text;
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout = keep(stdout, chunk); });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = keep(stderr, chunk); });
    child.on('error', error => done({ status: null, error }));
    child.on('close', status => done({ status }));
  });
}

// 解析 --list-models 一类命令的输出：跳过空行和表头行 MODEL（大小写不敏感），其余每行一个模型名。
export function parseModelList(text) {
  return String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line && line.toLowerCase() !== 'model');
}

// 执行者可选的模型：预设有 listModels（程序加上这些参数运行，环境与派发相同）就运行它，否则用预设的 modelOptions。
// 运行失败时 ok 为 false，models 仍给预设的 modelOptions，方便软件继续显示下拉。
export async function listAgentModels(home, name, { env = process.env, timeoutMs = 60000 } = {}) {
  const state = readConfig(home);
  if (state.reason) throw configInvalid(state, '这次没有运行任何程序');
  const config = state.exists ? state.config : state.legacy?.config ?? builtinConfig();
  const profile = config.profiles?.[name];
  if (!profile) throw new Error(`找不到执行者：${name}`);
  const preset = presetFor(name, profile, config)?.profile;
  const fallback = Array.isArray(preset?.modelOptions) ? preset.modelOptions : [];
  const listArgs = preset?.listModels;
  if (profile.adapter !== 'generic' || !Array.isArray(listArgs) || !listArgs.length) return { ok: true, models: fallback, source: 'preset' };
  const resolved = resolveProfile(profile, config);
  let secrets = [];
  try {
    if (resolved.genericError) throw new Error(resolved.genericError);
    const adapter = adapterFor(resolved, { config });
    const childEnv = buildEnv({ base: env, profile: resolved, adapter, home, profileName: name, sources: secretSources(config) });
    ensureSandboxHome(childEnv, { home, profileName: name });
    secrets = Object.keys(resolved.secrets ?? {}).map(key => childEnv[key]).filter(value => typeof value === 'string' && value.length >= 4);
    // 复用通用适配器拼命令（含 .cmd 规则）：只换掉参数，不带任务指令。
    const lister = makeGeneric({ ...resolved.genericDecl, args: listArgs, readOnlyArgs: undefined, stdin: null, output: { format: 'text' } }, { name });
    const spec = lister.command({ root: tmpdir(), report: '', prompt: '', env: childEnv, profile: resolved });
    const r = await runListing(spec, { env: childEnv, timeoutMs });
    const first = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).findLast(Boolean) ?? null;
    if (r.timedOut) throw new Error(`列出模型超过 ${Math.round(timeoutMs / 1000)} 秒没有结束，已停止`);
    if (r.error) throw new Error(`无法运行 ${resolved.genericDecl.label}：${r.error.message}`);
    if (r.status !== 0) throw new Error(adapter.failureHint?.(`${r.stderr}\n${r.stdout}`) ?? first(r.stderr) ?? first(r.stdout) ?? `列出模型失败（退出码 ${r.status}）`);
    const models = parseModelList(r.stdout);
    if (!models.length) throw new Error('列出模型没有输出任何模型名');
    return { ok: true, models, source: 'cli' };
  } catch (error) {
    // 错误文字里不带密钥值（程序有可能把收到的令牌回显出来）。
    let message = redactPaths(String(error.message ?? error));
    for (const value of secrets) message = message.split(value).join('***');
    return { ok: false, error: message.slice(0, 300), models: fallback, source: 'preset' };
  }
}

// ---- ar agents detect / test --decl（自定义 CLI 表单用：只用声明，不读不写配置） ----

// 检测程序：只看 executable 与 detect 参数（表单没填完整时也能检测）。返回 { ok, installed, version, error? }。
export function detectDeclaration(decl, { env = process.env } = {}) {
  if (!isObject(decl)) return { ok: false, installed: false, version: null, error: '声明必须是一个 JSON 对象' };
  if (typeof decl.executable !== 'string' || !decl.executable.trim()) return { ok: true, installed: false, version: null, error: '还没有填程序' };
  const detect = Array.isArray(decl.detect) && decl.detect.every(item => typeof item === 'string') ? decl.detect : ['--version'];
  const found = makeGeneric({ label: 'cli', executable: decl.executable.trim(), detect, args: [], output: { format: 'text' } }).detect({ env });
  return { ok: true, installed: found.installed === true, version: found.version ?? null, ...(found.error ? { error: found.error } : {}) };
}

const PREVIEW_PROMPT = '只回复 OK，不要修改任何文件';
const PREVIEW_MAX_LINES = 200;

// 用声明临时跑一次"只回复 OK"，不写配置、不建 git 仓库：在临时目录里直接运行程序，
// 返回原始输出（每行带映射出的统一事件）、汇报与退出码。声明不合法时返回 { ok: false, valid: false, errors }。
export async function previewDeclaration(decl, { env = process.env, timeoutSeconds = 60 } = {}) {
  const checked = validateGeneric(decl, { path: 'generic' });
  if (!checked.ok) return { ok: false, valid: false, errors: checked.errors, warnings: checked.warnings };
  const base = mkdtempSync(path.join(tmpdir(), 'ar-agent-preview-'));
  const started = Date.now();
  const secrets = [];
  try {
    const workdir = path.join(base, 'work'), home = path.join(base, 'home'), reportPath = path.join(base, 'report.md');
    mkdirSync(workdir); mkdirSync(home);
    const profile = resolveProfile({ adapter: 'generic', generic: decl, label: decl.label }, null);
    if (profile.genericError) throw new Error(profile.genericError);
    const adapter = makeGeneric(profile.genericDecl, { name: 'preview' });
    const childEnv = buildEnv({ base: env, profile, adapter, home, profileName: 'preview', sources: [] });
    ensureSandboxHome(childEnv, { home, profileName: 'preview' });
    for (const key of Object.keys(profile.secrets ?? {})) if (typeof childEnv[key] === 'string' && childEnv[key].length >= 4) secrets.push(childEnv[key]);
    const mask = text => secrets.reduce((acc, value) => acc.split(value).join('***'), redactPaths(String(text ?? ''), [base]));
    const spec = adapter.command({ root: workdir, report: reportPath, prompt: PREVIEW_PROMPT, settings: {}, env: childEnv, profile });
    let r;
    try { r = await runListing(spec, { env: childEnv, timeoutMs: timeoutSeconds * 1000, cwd: workdir, stdin: spec.stdin ?? null }); }
    finally { for (const file of spec.cleanup ?? []) rmSync(file, { force: true }); }
    const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    // 逐行映射：标准输出每行经过同一个映射器（有状态的映射器按顺序喂），标准错误只列出、不映射。
    const mapper = adapter.createMapper();
    const lines = [];
    let lastSay = null;
    for (const text of r.stdout.split(/\r?\n/)) {
      if (!text.trim() && !lines.length) continue;
      let events = [];
      try { events = mapper(text, { root: workdir }); } catch { events = []; }
      for (const e of events) if (e.kind === 'say') lastSay = e.text;
      lines.push({ stream: 'stdout', text: mask(text).slice(0, 500), events: events.map(e => JSON.parse(mask(JSON.stringify(e)))) });
    }
    while (lines.length && !lines.at(-1).text.trim()) lines.pop();
    for (const text of r.stderr.split(/\r?\n/)) if (text.trim()) lines.push({ stream: 'stderr', text: mask(text).slice(0, 500), events: [] });
    const shown = lines.slice(0, PREVIEW_MAX_LINES);
    const unmatched = shown.map((l, i) => l.stream === 'stdout' && l.text.trim() && !l.events.length ? i + 1 : null).filter(n => n !== null);
    const decl2 = profile.genericDecl;
    let report = null;
    if ((decl2.report ?? (decl2.output.format === 'text' ? 'stdout' : 'lastSay')) === 'file') {
      try { report = readFileSync(reportPath, 'utf8').trim() || null; } catch { report = null; }
    } else {
      report = adapter.finish({ lastSay, result: mapper.lastResult ?? null, stdoutText: r.stdout.trim() ? r.stdout : null });
    }
    report = report == null ? null : mask(String(report).trim()).slice(0, 500) || null;
    const exit = r.timedOut || r.error ? null : r.status;
    const ok = !r.timedOut && !r.error && exit === 0 && /\bOK\b/i.test(report ?? '');
    const error = ok ? null : r.error ? `无法运行 ${decl.label}：${mask(r.error.message)}` : r.timedOut ? `超过 ${timeoutSeconds} 秒没有结束，已停止`
      : adapter.failureHint?.(`${r.stderr}\n${r.stdout}`) ?? (exit === 0 ? '程序退出码是 0，但汇报里没有 OK' : failureReason(mask(r.stderr)) ?? `退出码 ${exit}`);
    return { ok, valid: true, exit, timedOut: r.timedOut, seconds, report, output: shown, unmatched, truncated: lines.length > shown.length, warnings: checked.warnings, ...(error ? { error } : {}) };
  } catch (error) {
    return { ok: false, valid: true, exit: null, timedOut: false, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), report: null, output: [], unmatched: [], error: redactPaths(String(error.message ?? error), [base]).slice(0, 300), warnings: checked.warnings };
  } finally {
    try { rmSync(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch { /* 留给系统清理临时目录。 */ }
  }
}

// ---- ar agents validate / export / import ----

const BUNDLE_KIND = 'agentrouter-agent';
// 导出时去掉的本机状态：启停、价格、每日上限、本机程序路径、派发时才生成的声明快照。
const LOCAL_FIELDS = ['enabled', 'price', 'limits', 'path', 'genericDecl', 'genericError'];
const looksLikeSecret = value => typeof value === 'string' && (/^sk-/.test(value) || (value.length > 40 && !/^[A-Z][A-Z0-9_]*$/.test(value)));

// secrets 的值只能是环境变量名，不能是密钥本身（规则同 generic-schema 对声明 secrets 的校验）。
function checkSecrets(secrets, at, err) {
  if (secrets === undefined) return;
  if (!isObject(secrets)) { err(at, 'secrets 必须是对象（变量名 → 宿主环境变量名）。'); return; }
  for (const [key, value] of Object.entries(secrets)) {
    if (!validEnvName(key)) err(`${at}.${key}`, `环境变量名 "${key}" 不合法，只能用字母、数字、下划线，且不能以数字开头。`);
    if (typeof value !== 'string') err(`${at}.${key}`, `secrets.${key} 的值必须是环境变量名（字符串）。`);
    else if (!validEnvName(value)) err(`${at}.${key}`, `secrets.${key} 的值不是合法的环境变量名。这里只写环境变量名，不写密钥本身。`);
    else if (looksLikeSecret(value)) err(`${at}.${key}`, `secrets.${key} 的值像真实密钥。这里只写环境变量名，不写密钥本身。`);
  }
}

// 校验一个已解析的 JSON：单独的通用适配器声明，或 ar agents export 导出的文件。只读。
// 返回 { ok, kind: 'declaration' | 'export' | null, errors: [{ path, message }], warnings: [{ path, message }] }。
export function checkAgentFile(value) {
  const errors = [], warnings = [];
  const err = (at, message) => errors.push({ path: at, message });
  if (!isObject(value)) {
    err('(文件)', '文件内容必须是一个 JSON 对象。');
    return { ok: false, kind: null, errors, warnings };
  }
  const verdict = (decl, at) => {
    const checked = validateGeneric(decl, { path: at });
    errors.push(...checked.errors); warnings.push(...checked.warnings);
  };
  if (value.kind === undefined) {
    verdict(value, 'generic');
    return { ok: errors.length === 0, kind: 'declaration', errors, warnings };
  }
  if (value.kind !== BUNDLE_KIND) {
    err('kind', `不认识的文件类型 ${JSON.stringify(value.kind)}（导出文件的 kind 应为 "${BUNDLE_KIND}"）。`);
    return { ok: false, kind: null, errors, warnings };
  }
  if (value.v !== 1) err('v', `不支持的版本 ${JSON.stringify(value.v)}（现在只认 1）。`);
  if (!validProfileName(value.name)) err('name', '执行者名无效（小写字母、数字、连字符，最长 40 个字符）。');
  const profile = value.profile;
  if (!isObject(profile)) err('profile', 'profile 必须是对象（执行者配置）。');
  else {
    const known = [...Object.keys(adapters), 'generic'];
    if (typeof profile.adapter !== 'string' || !known.includes(profile.adapter)) err('profile.adapter', `不认识的适配器 ${JSON.stringify(profile.adapter)}（可用：${known.join('、')}）。`);
    const before = errors.length;
    checkSecrets(profile.secrets, 'profile.secrets', err);
    // 其余字段交给配置文件自己的校验（auth、env、maxTurns、provider 等）；密钥已经报错时不重复报。
    if (errors.length === before) {
      const decl = profile.adapter === 'generic' && isObject(value.generic) ? value.generic : null;
      // 通用适配器的执行者没写 secrets 时，运行时用声明里的 secrets，这里按同样的方式检查。
      const checked = decl && !Object.keys(profile.secrets ?? {}).length && decl.secrets ? { ...profile, secrets: decl.secrets } : profile;
      try { validateV2({ v: 2, profiles: { [validProfileName(value.name) ? value.name : 'x']: checked } }); }
      catch (error) { err('profile', error.message.replace(/config\.json 的 profiles\.[^.\s]+/, 'profile')); }
    }
    if (profile.adapter === 'generic') {
      if (!isObject(value.generic)) err('generic', 'adapter 为 generic 时必须带通用适配器声明（generic 对象）。');
    } else if (value.generic !== null && value.generic !== undefined) {
      warnings.push({ path: 'generic', message: 'adapter 不是 generic，这份声明不会被用到（应为 null）。' });
    }
  }
  if (isObject(value.generic)) verdict(value.generic, 'generic');
  return { ok: errors.length === 0, kind: 'export', errors, warnings };
}

// 读文件再校验：读不到、不是 JSON 也按"不通过"返回，不抛错。file 相对 cwd。
export function validateAgentFile(file, { cwd = process.cwd() } = {}) {
  let value;
  try { value = parseJson(readFileSync(path.resolve(cwd, file), 'utf8')); }
  catch (error) {
    const message = error instanceof SyntaxError ? `不是有效的 JSON：${error.message}` : `读不到文件：${error.code ?? error.message}`;
    return { ok: false, kind: null, errors: [{ path: '(文件)', message }], warnings: [], value: null };
  }
  return { ...checkAgentFile(value), value };
}

const problemLines = list => list.map(item => `${item.path}：${item.message}`);

// 导出：{ v, kind, name, profile, generic }。profile 去掉本机状态；声明有问题或 secrets 像密钥时拒绝。
export function exportAgent(home, name) {
  const state = readConfig(home);
  if (state.reason) throw configInvalid(state, '这次没有导出');
  const config = state.exists ? state.config : state.legacy?.config ?? builtinConfig();
  const source = config.profiles?.[name];
  if (!source) throw new Error(`找不到执行者：${name}`);
  const profile = structuredClone(source);
  for (const key of LOCAL_FIELDS) delete profile[key];
  let generic = null;
  if (profile.adapter === 'generic') {
    const ref = profile.generic;
    generic = structuredClone(isObject(ref) ? ref : typeof ref === 'string' ? config.generics?.[ref] : undefined);
    if (generic === undefined) throw new Error(`找不到通用适配器声明：config.json 的 generics.${typeof ref === 'string' ? ref : '(未写)'}，没有导出`);
    if (isObject(ref)) profile.generic = name;
  }
  const bundle = { v: 1, kind: BUNDLE_KIND, name, profile, generic };
  const checked = checkAgentFile(bundle);
  if (!checked.ok) throw new Error(`执行者 ${name} 现在不能导出：\n${problemLines(checked.errors).join('\n')}`);
  return { bundle, warnings: checked.warnings };
}

// 导入：先按 validate 的规则校验（不通过什么都不写），再原子写入配置。返回 { ok: true, … } 或 { ok: false, errors, warnings }。
export function importAgent(home, value, { name, force = false } = {}) {
  const checked = checkAgentFile(value);
  const lone = checked.ok && checked.kind === 'declaration';
  if (lone && name === undefined) {
    return { ok: false, errors: [{ path: '(文件)', message: '这是一份单独的通用适配器声明，没有执行者配置；导入需要 ar agents export 导出的文件。单独的声明请加 --name <名>。' }], warnings: checked.warnings };
  }
  if (!checked.ok) return { ok: false, errors: checked.errors, warnings: checked.warnings };
  const target = name ?? value.name;
  if (!validProfileName(target)) throw new Error(`执行者名无效：${String(target).slice(0, 40)}（小写字母、数字、连字符）`);
  const profile = lone ? genericProfile(target, value) : structuredClone(value.profile);
  for (const key of LOCAL_FIELDS) delete profile[key];
  profile.enabled = true;
  const declaration = lone ? structuredClone(value) : profile.adapter === 'generic' ? structuredClone(value.generic) : null;
  if (declaration) profile.generic = target;
  let madeDefault = false, overwritten = false;
  updateConfig(home, config => {
    config.profiles ??= {};
    overwritten = config.profiles[target] !== undefined;
    if (overwritten && !force) throw new Error(`已有执行者 ${target}；换个名字（--name），或加 --force 覆盖`);
    if (declaration) {
      config.generics ??= {};
      if (config.generics[target] !== undefined && !force) throw new Error(`config.json 的 generics 里已有同名声明 ${target}；换个名字（--name），或加 --force 覆盖`);
      const holder = Object.entries(config.profiles).find(([other, p]) => other !== target && p.generic === target);
      if (holder) throw new Error(`声明 ${target} 还被执行者 ${holder[0]} 引用，不能覆盖；换个名字（--name）`);
    }
    const previous = config.profiles[target];
    config.profiles[target] = profile;
    if (declaration) config.generics[target] = declaration;
    // 覆盖掉的旧执行者如果引用了别的声明，没人再用就清理。
    if (previous?.adapter === 'generic') pruneGeneric(config, previous.generic);
    if (shouldBecomeDefault(config, profile.adapter)) { config.defaultProfile = target; madeDefault = true; }
  });
  return { ok: true, name: target, adapter: profile.adapter, madeDefault, overwritten, secrets: Object.values(Object.keys(profile.secrets ?? {}).length ? profile.secrets : declaration?.secrets ?? {}), warnings: checked.warnings };
}

// 在临时公共目录的 runs.jsonl 里找最近一条 start 事件，取执行者版本与模型。
function readStartLine(home) {
  try {
    const text = readFileSync(path.join(home, 'runs.jsonl'), 'utf8');
    for (const line of text.split('\n').reverse()) {
      if (!line.trim()) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event?.event === 'start') return event;
    }
  } catch { /* 没有清单文件。 */ }
  return null;
}

function readTestResults(home) {
  try {
    const value = readJson(path.join(home, 'agent-tests.json'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeAtomicJson(home, file, value) {
  mkdirSync(home, { recursive: true });
  const temp = path.join(home, `.agent-tests-${randomUUID()}.tmp`);
  try { writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}

// 把一次测试的结果按执行者名写进 agent-tests.json（供 list 的 lastTest 读取）。
function writeTestResult(home, name, entry) {
  const file = path.join(home, 'agent-tests.json');
  const current = readTestResults(home);
  current[name] = entry;
  writeAtomicJson(home, file, current);
}

// 用子进程跑一次派发（真实调用执行者），超时后 killProcessTree 结束整棵进程树。
// 各阶段只写追踪（AR_CORE_TRACE=1 时）；不改变结束方式与返回值。
function runOnce({ scriptPath, repo, testHome, env, timeoutMs }) {
  return new Promise(resolve => {
    let settled = false;
    let closeSeen = false;
    let waitTimer = null;
    let waitLines = 0;
    let stdoutEnded = false, stderrEnded = false;
    let timedOutAt = 0;
    let child;
    const started = Date.now();
    const elapsed = () => Date.now() - started;
    // 记下实际结算的时刻与原因：close 先到就不必再等；超时后 killProcessTree 返回也按原样结算。
    const done = (value, reason) => {
      if (settled) return;
      settled = true;
      trace(`agents test 结算：${reason}（${elapsed()}ms）`);
      resolve(value);
    };
    // 超时结算后若子进程还没关闭：每秒记一行，说明进程是否还活着、管道是否已结束。不阻止进程退出。
    const watchClose = () => {
      if (!tracing || closeSeen || waitTimer) return;
      waitTimer = setInterval(() => {
        if (closeSeen) { clearInterval(waitTimer); waitTimer = null; return; }
        waitLines += 1;
        trace(`agents test 等待子进程关闭：pid=${child.pid} pidAlive=${pidAlive(child.pid) ? '是' : '否'} stdout已结束=${stdoutEnded ? '是' : '否'} stderr已结束=${stderrEnded ? '是' : '否'} 距超时已过 ${Date.now() - timedOutAt}ms`);
        if (waitLines >= 60) { clearInterval(waitTimer); waitTimer = null; }
      }, 1000);
      waitTimer.unref();
    };
    try {
      child = spawn(process.execPath, [scriptPath, 'dispatch', '只回复 OK，不要修改任何文件', '--name', 'agent-test'],
        { cwd: repo, env: { ...env, AGENT_ROUTER_HOME: testHome, AR_NO_WATCH: '1' }, shell: false, windowsHide: true });
    } catch (error) {
      trace(`agents test 等待结束：启动失败（${elapsed()}ms）：${error.message}`);
      done({ exit: null, timedOut: false, spawnError: error.message }, '启动失败');
      return;
    }
    trace(`agents test 派发子进程已启动 pid=${child.pid ?? '（无）'}（${redactPaths(scriptPath)}）`);
    let timedOut = false;
    // 排空输出，避免子进程因管道缓冲区写满而卡住。
    child.stdout.setEncoding('utf8'); child.stdout.on('data', () => {});
    child.stderr.setEncoding('utf8'); child.stderr.on('data', () => {});
    // 单独记 exit 事件与两条管道的 end / close：区分"进程已退出但管道没关"。
    child.on('exit', (code, signal) => trace(`agents test 子进程 exit 事件 exit=${code} signal=${signal ?? '（无）'}（${elapsed()}ms）`));
    child.stdout.on('end', () => { stdoutEnded = true; trace(`agents test 子进程 stdout end（${elapsed()}ms）`); });
    child.stdout.on('close', () => trace(`agents test 子进程 stdout close（${elapsed()}ms）`));
    child.stderr.on('end', () => { stderrEnded = true; trace(`agents test 子进程 stderr end（${elapsed()}ms）`); });
    child.stderr.on('close', () => trace(`agents test 子进程 stderr close（${elapsed()}ms）`));
    const timer = setTimeout(() => {
      timedOut = true;
      timedOutAt = Date.now();
      trace(`agents test 等待结束：超时（${elapsed()}ms，上限 ${timeoutMs}ms），开始结束进程树 pid=${child.pid}`);
      killProcessTree(child.pid)
        .then(() => trace(`agents test 结束进程树完成 pid=${child.pid}（${elapsed()}ms）`))
        // 结束失败由 close 兜底；不退就按超时结算。
        .catch(error => trace(`agents test 结束进程树失败 pid=${child.pid}：${error.message}`))
        .finally(() => {
          done({ exit: null, timedOut: true }, '超时后 killProcessTree 返回');
          watchClose();
        });
    }, timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
      trace(`agents test 等待结束：启动失败（${elapsed()}ms）：${error.message}`);
      done({ exit: null, timedOut, spawnError: error.message }, '启动失败');
    });
    child.on('close', code => {
      closeSeen = true;
      clearTimeout(timer);
      if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
      trace(`agents test 等待结束：${timedOut ? '超时后子进程关闭' : '正常退出'} exit=${code}（${elapsed()}ms）`);
      done({ exit: code, timedOut }, timedOut ? '超时后子进程 close' : '正常 close');
    });
  });
}

// 测试连接：在临时 git 仓库与临时公共目录里、以子进程派发"只回复 OK"（会真实调用执行者；不写入你的任务清单）。
// 超时后用 killProcessTree 结束整棵进程树；结果写进 <home>/agent-tests.json 供 list 读取。
export async function testAgent(home, name, { env = process.env, scriptPath, timeoutSeconds = 180 } = {}) {
  const state = readConfig(home);
  // 测试连接会真实派发一次：配置无效时拒绝（063），不写测试结果、不启动任何进程。
  if (state.reason) throw configInvalid(state);
  const config = state.exists ? state.config : builtinConfig();
  const profile = config.profiles?.[name];
  if (!profile) throw new Error(`找不到执行者：${name}`);
  trace(`agents test ${name} 开始（超时 ${timeoutSeconds} 秒）`);
  const base = traced('agents test 创建临时目录', () => mkdtempSync(path.join(tmpdir(), 'ar-agent-test-')));
  trace(`agents test 临时目录：${redactPaths(base, [base])}`);
  const started = Date.now();
  try {
    const repo = path.join(base, 'repo'), testHome = path.join(base, 'home');
    traced('agents test 创建临时仓库与公共目录', () => { mkdirSync(repo); mkdirSync(testHome); });
    const git = (label, args) => traced(`agents test 临时仓库 ${label}`, () => execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true }));
    git('git init', ['init', '-q']);
    traced('agents test 临时仓库写 README.md', () => writeFileSync(path.join(repo, 'README.md'), '# test\n'));
    git('git add', ['add', 'README.md']);
    git('git commit', ['-c', 'user.name=agent-router', '-c', 'user.email=agent-router@example.invalid', 'commit', '-q', '-m', 'init']);
    // 临时配置只带这一个执行者；升级目标不在里面，去掉 escalate。通用适配器执行者引用的声明一并带上（引用不存在时照派发的规则报错）。
    const { escalate: _escalate, ...testProfile } = profile;
    const testConfig = { v: 2, defaultProfile: name, profiles: { [name]: { ...testProfile, enabled: true } }, managed: false, watchWindow: 'never' };
    if (profile.adapter === 'generic' && typeof profile.generic === 'string') {
      if (config.generics?.[profile.generic] === undefined) throw new Error(`找不到通用适配器声明：config.json 的 generics.${profile.generic}`);
      testConfig.generics = { [profile.generic]: config.generics[profile.generic] };
    }
    traced('agents test 临时公共目录写 config.json', () => writeFileSync(path.join(testHome, 'config.json'), JSON.stringify(testConfig)));
    const child = await runOnce({ scriptPath, repo, testHome, env, timeoutMs: timeoutSeconds * 1000 });
    const dir = path.join(repo, '.agent-runs', 'agent-test');
    const report = existsSync(path.join(dir, 'report.md')) ? readFileSync(path.join(dir, 'report.md'), 'utf8').trim() : null;
    const events = existsSync(path.join(dir, 'events.jsonl')) ? readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const turns = events.filter(e => e.kind === 'turn');
    const errors = events.filter(e => e.kind === 'error').map(e => e.text);
    const startLine = readStartLine(testHome);
    const ok = !child.timedOut && child.exit === 0 && /\bOK\b/i.test(report ?? '');
    const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    const error = child.spawnError ? `无法启动派发进程：${child.spawnError}` : child.timedOut ? `超过 ${timeoutSeconds} 秒没有结束，测试已停止`
      : ok ? null : errors.at(-1) ?? `测试未通过（exit=${child.exit}）`;
    const result = { name, ok, exit: child.exit, timedOut: child.timedOut, seconds, version: startLine?.agentVersion ?? null, model: startLine?.model ?? null,
      report: report?.slice(0, 200) ?? null, usage: turns.at(-1)?.usage ?? null, errors: errors.slice(-3), error };
    writeTestResult(home, name, { at: Date.now(), ok, seconds, version: result.version, error });
    return result;
  } finally {
    // Windows 上刚结束的子进程（软件里用 Electron 运行时还有它的崩溃报告进程）可能还占着目录（EPERM）：短暂重试；仍删不掉就留在系统临时目录，不影响测试结果。
    const removing = Date.now();
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
      trace(`agents test 临时目录删除成功（${Date.now() - removing}ms）`);
    } catch (error) {
      // 原行为不变：留给系统清理临时目录；这里只把错误码与剩余文件记下来。
      trace(`agents test 临时目录删除失败 code=${error.code ?? '（无）'}：${redactPaths(error.message, [base])}`);
      let remaining = [];
      try { remaining = readdirSync(base, { recursive: true }).map(String).slice(0, 20); }
      catch (readError) { trace(`agents test 临时目录剩余文件读取失败：${readError.code ?? readError.message}`); }
      trace(`agents test 临时目录剩余文件（最多 20 项，相对路径）：${remaining.join('、') || '（无）'}`);
    }
  }
}

const parseMaxTurns = value => {
  if (value === '-') return null;
  if (!/^\d+$/.test(value)) throw new Error('--max-turns 必须为正整数或 -');
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error('--max-turns 必须为正整数或 -');
  return n;
};
const parseTimeout = value => { const n = Number(value); if (!Number.isFinite(n) || n <= 0) throw new Error('--timeout 必须为正的秒数'); return n; };

const usageAgents = 'ar agents list [--detect] | add --preset <预设> [--name <名>] [--label <显示名>] [--model <模型>] [--effort <级别>] [--base-url <地址>] [--secret-var <变量名>] [--auth login|token] | add --generic <声明JSON> --name <名> [--label <显示名>] | update <名> [--label <显示名>] [--model <模型>] [--effort <级别>|""] [--base-url <地址>] [--secret-var <变量名>] [--max-turns <正整数>|-] [--escalate <名>|""] | default <名> | remove <名> | enable <名> | disable <名> | test <名> [--timeout <秒>] | test --decl <声明JSON> [--timeout <秒>] | detect --decl <声明JSON> | presets | models <名> | validate <文件> | validate --decl <声明JSON> | export <名> [--out <文件>] [--force] | import <文件> [--name <名>] [--force]（单独的声明必须加 --name）';

// --decl / --generic 的值：解析声明 JSON；不是 JSON 或不是对象时抛出带原因的错误。
function parseDecl(text) {
  let value;
  try { value = parseJson(String(text)); } catch (error) { throw new Error(`声明不是有效的 JSON：${error.message}`); }
  if (!isObject(value)) throw new Error('声明必须是一个 JSON 对象');
  return value;
}
export async function agentsCommand(rest, { home, env = process.env, scriptPath, cwd = process.cwd() }) {
  const [sub, ...args] = rest;
  const one = () => { if (args.length !== 1 || !args[0] || args[0].startsWith('--')) throw new Error(`用法：${usageAgents}`); return args[0]; };
  // --key 值 形式的选项解析；未知选项 / 缺值 / 值又是 -- 开头都算用法错误。flags：不带值的开关（出现即为 true）。
  const parseOptions = (keys, flags = []) => {
    const opts = {}, positional = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--')) {
        const key = a.slice(2);
        if (flags.includes(key)) { opts[key] = true; continue; }
        if (!keys.includes(key) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`用法：${usageAgents}`);
        opts[key] = args[++i];
      } else positional.push(a);
    }
    return { opts, positional };
  };
  // 密钥变量是否已设置：返回 { status, line }，line 是给文字输出的那一行（没有密钥时为 null）。
  const secretLines = names => {
    const status = secretStatus(names, { env });
    const missing = Object.entries(status).filter(([, s]) => s === 'missing').map(([n]) => n);
    return { status, line: missing.length ? `还没有设置密钥：${missing.join('、')}。运行 ar secrets set ${missing[0]}，或设置同名的 Windows 用户环境变量` : names.length ? `密钥已设置：${names.join('、')}` : null };
  };
  switch (sub) {
    case 'list': {
      const detect = args.includes('--detect');
      if (args.length !== (detect ? 1 : 0)) throw new Error(`用法：${usageAgents}`);
      const agents = listAgents(home, { env, detect, traceSteps: true });
      return { result: { ok: true, agents }, text: formatList(agents) };
    }
    case 'presets': {
      if (args.length) throw new Error(`用法：${usageAgents}`);
      const objects = presetObjects();
      checkPresetCards(objects);
      const presets = objects.map(presetSummary);
      return { result: { ok: true, presets }, text: `可用预设：${listPresets().join('、')}` };
    }
    case 'add': {
      const { opts, positional } = parseOptions(['preset', 'name', 'label', 'model', 'effort', 'base-url', 'secret-var', 'auth', 'generic']);
      if (opts.generic !== undefined) {
        // 自定义 CLI：声明直接来自表单，不经预设。
        if (positional.length || opts.preset || !opts.name) throw new Error(`用法：${usageAgents}`);
        const added = addGenericAgent(home, { name: opts.name, decl: parseDecl(opts.generic), label: opts.label });
        const { status, line } = secretLines(added.secrets);
        return { result: { ok: true, ...added, secretStatus: status }, text: [`已加入执行者 ${added.name}（自定义 CLI）`, added.madeDefault ? `默认执行者改为 ${added.name}（Codex 保持启用，只在显式指定或审查时使用）` : null, ...(added.warnings ?? []), line].filter(Boolean).join('\n') };
      }
      if (positional.length || !opts.preset) throw new Error(`用法：${usageAgents}`);
      const added = addAgent(home, { preset: opts.preset, name: opts.name, label: opts.label, model: opts.model, effort: opts.effort, baseUrl: opts['base-url'], secretVar: opts['secret-var'], auth: opts.auth });
      const { status, line } = secretLines(added.secrets);
      return { result: { ok: true, ...added, secretStatus: status }, text: [`已加入执行者 ${added.name}（预设 ${opts.preset}）`, added.madeDefault ? `默认执行者改为 ${added.name}（Codex 保持启用，只在显式指定或审查时使用）` : null,
        ...(added.warnings ?? []), line].filter(Boolean).join('\n') };
    }
    case 'update': {
      const { opts, positional } = parseOptions(['label', 'model', 'effort', 'base-url', 'secret-var', 'max-turns', 'escalate']);
      if (positional.length !== 1 || !positional[0] || positional[0].startsWith('--')) throw new Error(`用法：${usageAgents}`);
      if (!['label', 'model', 'effort', 'base-url', 'secret-var', 'max-turns', 'escalate'].some(k => opts[k] !== undefined)) throw new Error(`用法：${usageAgents}`);
      const r = updateAgent(home, positional[0], { label: opts.label, model: opts.model, effort: opts.effort, escalate: opts.escalate, baseUrl: opts['base-url'], secretVar: opts['secret-var'], maxTurns: opts['max-turns'] === undefined ? undefined : parseMaxTurns(opts['max-turns']) });
      return { result: { ok: true, name: r.name, profile: r.profile, ...(r.warnings ? { warnings: r.warnings } : {}) }, text: [`已更新执行者 ${r.name}`, ...(r.warnings ?? [])].join('\n') };
    }
    case 'models': {
      const r = await listAgentModels(home, one(), { env });
      const text = r.ok ? (r.models.length ? [r.source === 'cli' ? '模型（来自程序的列表）：' : '模型（预设的可选值）：', ...r.models.map(m => `  ${m}`)].join('\n') : '没有可选的模型列表')
        : [`列出模型失败：${r.error}`, ...(r.models.length ? ['预设的可选值：', ...r.models.map(m => `  ${m}`)] : [])].join('\n');
      return { result: r, text, code: r.ok ? 0 : 1 };
    }
    case 'detect': {
      // 只检测、不写配置：表单里的"程序"一栏用。
      const { opts, positional } = parseOptions(['decl']);
      if (positional.length || opts.decl === undefined) throw new Error(`用法：${usageAgents}`);
      const r = detectDeclaration(parseDecl(opts.decl), { env });
      return { result: r, text: r.installed ? `已找到 · ${r.version ?? '（没有版本输出）'}` : `找不到这个程序${r.error ? `：${r.error}` : ''}` };
    }
    case 'validate': {
      if (args[0] === '--decl') {
        // 表单每次改动都校验当前声明：不读不写文件。
        const { opts, positional } = parseOptions(['decl']);
        if (positional.length || opts.decl === undefined) throw new Error(`用法：${usageAgents}`);
        let r;
        try { r = checkAgentFile(parseDecl(opts.decl)); }
        catch (error) { r = { ok: false, errors: [{ path: '(声明)', message: error.message }], warnings: [] }; }
        const lines = problemLines(r.warnings).map(line => `警告 ${line}`);
        return { result: { ok: r.ok, errors: r.errors, warnings: r.warnings }, code: r.ok ? 0 : 2, text: r.ok ? ['声明有效', ...lines].join('\n') : [...problemLines(r.errors), ...lines].join('\n') };
      }
      const r = validateAgentFile(one(), { cwd });
      const warnings = problemLines(r.warnings).map(line => `警告 ${line}`);
      return { result: { ok: r.ok, errors: r.errors, warnings: r.warnings }, code: r.ok ? 0 : 2, text: r.ok ? ['声明有效', ...warnings].join('\n') : [...problemLines(r.errors), ...warnings].join('\n') };
    }
    case 'export': {
      const { opts, positional } = parseOptions(['out'], ['force']);
      if (positional.length !== 1 || !positional[0]) throw new Error(`用法：${usageAgents}`);
      if (opts.force && opts.out === undefined) throw new Error(`用法：${usageAgents}`);
      const { bundle, warnings } = exportAgent(home, positional[0]);
      const warningLines = problemLines(warnings).map(line => `警告 ${line}`);
      const body = `${JSON.stringify(bundle, null, 2)}\n`;
      if (opts.out === undefined) return { result: { ok: true, name: bundle.name, file: null, bundle, warnings }, text: [body.trimEnd(), ...warningLines].join('\n') };
      const file = path.resolve(cwd, opts.out);
      // 不带 --force 时用 wx：文件已存在就拒绝，不覆盖。UTF-8 无 BOM。
      try { writeFileSync(file, body, { encoding: 'utf8', flag: opts.force ? 'w' : 'wx' }); }
      catch (error) { throw new Error(error.code === 'EEXIST' ? `文件已存在：${opts.out}；换个文件名，或加 --force 覆盖` : `写不了文件 ${opts.out}：${error.code ?? error.message}`); }
      return { result: { ok: true, name: bundle.name, file: opts.out, warnings }, text: [`已导出执行者 ${bundle.name} → ${opts.out}`, ...warningLines].join('\n') };
    }
    case 'import': {
      const { opts, positional } = parseOptions(['name'], ['force']);
      if (positional.length !== 1 || !positional[0]) throw new Error(`用法：${usageAgents}`);
      const checked = validateAgentFile(positional[0], { cwd });
      const refuse = problems => ({ result: { ok: false, error: '文件不合法，没有导入', errors: problems.errors, warnings: problems.warnings }, code: 2,
        text: ['文件不合法，没有导入：', ...problemLines(problems.errors)].join('\n') });
      if (!checked.ok) return refuse(checked);
      const imported = importAgent(home, checked.value, { name: opts.name, force: opts.force === true });
      if (!imported.ok) return refuse(imported);
      const { status, line } = secretLines(imported.secrets);
      const { ok, ...fields } = imported;
      return { result: { ok: true, ...fields, secretStatus: status }, text: [`已导入执行者 ${imported.name}${imported.overwritten ? '（覆盖了同名执行者）' : ''}`, imported.madeDefault ? `默认执行者改为 ${imported.name}（Codex 保持启用，只在显式指定或审查时使用）` : null,
        ...problemLines(imported.warnings).map(w => `警告 ${w}`), line].filter(Boolean).join('\n') };
    }
    case 'default': { const r = setDefault(home, one()); return { result: { ok: true, ...r }, text: `默认执行者：${r.defaultProfile}` }; }
    case 'remove': { const r = removeAgent(home, one()); return { result: { ok: true, ...r }, text: `已删除执行者 ${r.name}${r.defaultProfile ? `；默认执行者：${r.defaultProfile}` : '；现在没有默认执行者'}` }; }
    case 'enable': case 'disable': { const r = setEnabled(home, one(), sub === 'enable'); return { result: { ok: true, ...r }, text: `执行者 ${r.name} ${r.enabled ? '已启用' : '已停用'}` }; }
    case 'test': {
      const { opts, positional } = parseOptions(['timeout', 'decl']);
      if (opts.decl !== undefined) {
        // 声明预览：不写配置、不建仓库，返回原始输出与映射出的事件。
        if (positional.length) throw new Error(`用法：${usageAgents}`);
        const r = await previewDeclaration(parseDecl(opts.decl), { env, timeoutSeconds: opts.timeout === undefined ? 60 : parseTimeout(opts.timeout) });
        if (!r.valid) return { result: { ok: false, error: '声明不合法，没有运行', errors: r.errors, warnings: r.warnings }, code: 2, text: ['声明不合法，没有运行：', ...problemLines(r.errors)].join('\n') };
        return { result: r, code: r.ok ? 0 : 1, text: `${r.ok ? '测试通过' : '测试未通过'}：exit=${r.exit}，用时 ${r.seconds} 秒${r.report ? `；汇报：${r.report}` : ''}${r.error ? `\n${r.error}` : ''}` };
      }
      if (positional.length !== 1 || !positional[0] || positional[0].startsWith('--')) throw new Error(`用法：${usageAgents}`);
      const timeoutSeconds = opts.timeout === undefined ? 180 : parseTimeout(opts.timeout);
      const r = await testAgent(home, positional[0], { env, scriptPath, timeoutSeconds });
      const { ok, error, ...fields } = r;
      return { result: { ok, ...fields, ...(ok ? {} : { error }) }, code: ok ? 0 : 1,
        text: r.timedOut ? `测试超时：${r.name}，超过 ${timeoutSeconds} 秒没有结束，已停止`
          : `${r.ok ? '连接正常' : '测试未通过'}：${r.name}，exit=${r.exit}，用时 ${r.seconds} 秒${r.usage ? `，输入 ${r.usage.input ?? '?'} / 输出 ${r.usage.output ?? '?'} tokens` : ''}${r.ok || !r.errors.length ? '' : `\n${r.errors.join('\n')}`}` };
    }
    default: throw new Error(`用法：${usageAgents}`);
  }
}

function formatList(agents) {
  if (!agents.length) return '还没有执行者：运行 ar agents add --preset <预设>（ar agents presets 查看可用预设）';
  const auth = a => a.auth === 'login' ? `订阅登录${a.login === 'in' ? '（已登录）' : a.login === 'out' ? '（未登录）' : ''}` : `密钥 ${Object.entries(a.secrets).map(([n, s]) => `${n}：${s === 'set' ? '已设置' : '未设置'}`).join('、')}`;
  return ['执行者：', ...agents.map(a => `  ${a.name}  ${a.label}（${a.adapter}）  ${a.enabled ? '已启用' : '已停用'}${a.supported ? '' : '  不支持的类型'}${a.default ? '  默认' : ''}  ${auth(a)}`)].join('\n');
}

// ar secrets status [名…] / ar secrets set <名>：值只从标准输入读（不进命令行参数、不回显），写入 Windows 用户环境变量。
const usageSecrets = 'ar secrets status [变量名 …] | ar secrets set <变量名>（值从标准输入读入）';
export async function secretsCommand(rest, { home, env = process.env, readValue, setSecret = setUserSecret }) {
  const [sub, ...args] = rest;
  if (sub === 'status') {
    if (args.some(a => a.startsWith('--'))) throw new Error(`用法：${usageSecrets}`);
    // 不指定时列出所有执行者引用到的变量名。
    const names = args.length ? args : [...new Set(listAgents(home, { env }).flatMap(a => a.auth === 'token' ? Object.keys(a.secrets) : []))];
    const status = secretStatus(names, { env });
    return { result: { ok: true, secrets: status }, text: names.length ? names.map(n => `${n}：${status[n] === 'set' ? '已设置' : '未设置'}`).join('\n') : '没有执行者需要密钥' };
  }
  if (sub === 'set') {
    if (args.length !== 1 || args[0].startsWith('--')) throw new Error(`用法：${usageSecrets}`);
    const name = args[0];
    // 先校验变量名，名字不对就不必让用户输入密钥。
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`变量名无效：${name.slice(0, 64)}`);
    const value = await readValue(name);
    setSecret(name, value);
    return { result: { ok: true, name, status: 'set' }, text: `已写入用户环境变量 ${name}（新打开的程序会读到；AgentRouter 也能直接读到）` };
  }
  throw new Error(`用法：${usageSecrets}`);
}
