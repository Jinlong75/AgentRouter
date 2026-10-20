// 执行者管理：预设（core/templates/agents/*.json）与 ar agents / ar secrets 命令。
// 预设是唯一允许写具体服务商与模型的地方（D17、O10）。所有输出只含密钥的变量名与 set / missing，从不含值。
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig, builtinConfig, loadConfig, updateConfig } from './config.mjs';
import { secretStatus, setUserSecret } from './secrets.mjs';
import { authOf } from './env.mjs';
import { adapters } from '../adapters/index.mjs';
import { killProcessTree } from './process.mjs';

const presetDir = fileURLToPath(new URL('../templates/agents/', import.meta.url));
const validProfileName = name => typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(name);
const AUTH_VALUES = ['login', 'token'];
const validEnvName = name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

// 全部预设对象，按 order 升序（没有 order 的按 0 排在最前）。
export function presetObjects() {
  return readdirSync(presetDir).filter(f => f.endsWith('.json')).map(f => loadPreset(f.slice(0, -5)))
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
      try { return JSON.parse(readFileSync(path.join(presetDir, f), 'utf8')).name === name; } catch { return false; }
    });
    if (!match) throw new Error(`没有预设 ${name}（可用：${listPresets().join('、')}）`);
    text = readFileSync(path.join(presetDir, match), 'utf8');
  }
  const { name: presetName, ...profile } = JSON.parse(text);
  return { name: presetName ?? name, profile };
}

// --json 的预设摘要：只暴露 name/title/description/recommended/adapter/label/auth/env/secrets。
function presetSummary({ name, profile }) {
  return { name, title: profile.title ?? name, description: profile.description ?? '', recommended: profile.recommended === true,
    adapter: profile.adapter, label: profile.label ?? profile.adapter, auth: authOf(profile), env: profile.env ?? {}, secrets: profile.secrets ?? {} };
}

// 每项的模型名：适配器能算就由适配器算（Claude Code 读 env.ANTHROPIC_MODEL），否则取配置里的 model 字段。
function modelOf(adapter, profile) {
  if (adapter?.modelName) return adapter.modelName({ profile }) ?? null;
  if (profile.adapter === 'codex') return profile.model ?? null;
  return null;
}

// 只读：不触发迁移写入；没有配置或配置损坏时显示内置默认。--detect 时才给每项补 installed / version。
export function listAgents(home, { env = process.env, query, detect = false } = {}) {
  const state = readConfig(home);
  const config = state.exists && !state.reason ? state.config : state.legacy?.config ?? builtinConfig();
  let selected = null;
  try { selected = loadConfig(home, {}, {}).profileName; } catch { /* 没有可用执行者时不标默认。 */ }
  const lastTests = readTestResults(home);
  return Object.entries(config.profiles ?? {}).map(([name, p]) => {
    const adapter = adapters[p.adapter], auth = authOf(p);
    const row = { name, adapter: p.adapter, label: p.label ?? adapter?.label ?? p.adapter, enabled: p.enabled !== false, supported: !!adapter, default: name === selected, auth,
      model: modelOf(adapter, p), lastTest: lastTests[name] ?? null };
    const detection = detect && adapter?.detect ? adapter.detect({ env, settings: p, profile: p }) : null;
    // token：各个密钥变量是否已设置（只有 set / missing）；login：适配器能检测时显示是否已登录。
    row.secrets = auth === 'token' ? secretStatus(Object.values(p.secrets ?? {}), { env, ...(query ? { query } : {}) }) : {};
    row.login = auth === 'login' && adapter?.loginStatus ? adapter.loginStatus({ env, detection: detection ?? adapter.detect({ env, settings: p, profile: p }) }) : null;
    if (detect) { row.installed = detection?.installed ?? false; row.version = detection?.version ?? null; }
    return row;
  });
}

// D2（修订）：Codex 不当默认执行者。加入别的执行者时，如果当前默认是 Codex 或没有默认，就改用新加入的。
function shouldBecomeDefault(config, adapter) {
  return adapter !== 'codex' && (config.defaultProfile == null || config.profiles?.[config.defaultProfile]?.adapter === 'codex');
}

// add / update 共用的覆盖参数（原地修改）。校验失败直接抛错，调用方在写文件前就不会写入。
function applyProfileOptions(profile, { label, model, baseUrl, secretVar, maxTurns }) {
  if (label !== undefined) profile.label = label;
  if (maxTurns !== undefined) profile.maxTurns = maxTurns;
  if (model !== undefined) {
    if (profile.adapter !== 'claude-code') throw new Error('--model 只对 Claude Code 适配器有效');
    profile.env = { ...profile.env, ANTHROPIC_MODEL: model };
  }
  if (baseUrl !== undefined) {
    if (profile.adapter !== 'claude-code') throw new Error('--base-url 只对 Claude Code 适配器有效');
    profile.env = { ...profile.env, ANTHROPIC_BASE_URL: baseUrl };
  }
  if (secretVar !== undefined) {
    if (!validEnvName(secretVar)) throw new Error(`变量名无效：${String(secretVar).slice(0, 64)}`);
    if (!Object.keys(profile.secrets ?? {}).length) throw new Error('--secret-var 需要该执行者有密钥（token 认证）');
    profile.secrets = Object.fromEntries(Object.entries(profile.secrets).map(([k]) => [k, secretVar]));
  }
  // 兼容后端等预设把地址 / 模型留空，必须补齐后才能用（避免把空值写进配置）。
  if (profile.adapter === 'claude-code') {
    if (profile.env?.ANTHROPIC_BASE_URL === '') throw new Error('缺少接口地址：用 --base-url 指定');
    if (profile.env?.ANTHROPIC_MODEL === '') throw new Error('缺少模型：用 --model 指定');
  }
}

export function addAgent(home, { preset, name, label, model, baseUrl, secretVar, auth }) {
  const { name: presetName, profile } = loadPreset(preset);
  const target = name ?? presetName;
  if (!validProfileName(target)) throw new Error(`执行者名无效：${String(target).slice(0, 40)}（小写字母、数字、连字符）`);
  const p = structuredClone(profile);
  if (auth !== undefined) {
    if (!AUTH_VALUES.includes(auth)) throw new Error('--auth 必须为 login 或 token');
    p.auth = auth;
    // Codex 从登录改 token 时没有密钥来源：补默认变量名 OPENAI_API_KEY（可用 --secret-var 覆盖）。
    if (auth === 'token' && p.adapter === 'codex') p.secrets = { OPENAI_API_KEY: 'OPENAI_API_KEY' };
  }
  applyProfileOptions(p, { label, model, baseUrl, secretVar, maxTurns: undefined });
  let madeDefault = false;
  updateConfig(home, config => {
    config.profiles ??= {};
    if (config.profiles[target]) throw new Error(`已有执行者 ${target}；换个名字（--name）或先 ar agents remove ${target}`);
    config.profiles[target] = p;
    if (shouldBecomeDefault(config, p.adapter)) { config.defaultProfile = target; madeDefault = true; }
  });
  return { name: target, preset, madeDefault, secrets: Object.values(p.secrets ?? {}) };
}

export function updateAgent(home, name, opts) {
  const config = updateConfig(home, config => {
    const profile = config.profiles?.[name];
    if (!profile) throw new Error(`找不到执行者：${name}`);
    applyProfileOptions(profile, opts);
  });
  return { name, profile: config.profiles[name] };
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

export function removeAgent(home, name) {
  let defaultProfile;
  updateConfig(home, config => {
    if (!config.profiles?.[name]) throw new Error(`找不到执行者：${name}`);
    delete config.profiles[name];
    if (config.defaultProfile === name) {
      // 默认执行者被删：有别的非 Codex 启用执行者就用它，否则用 Codex，都没有则不设默认。
      const enabled = Object.entries(config.profiles).filter(([, p]) => p.enabled !== false);
      config.defaultProfile = enabled.find(([, p]) => p.adapter !== 'codex')?.[0] ?? enabled[0]?.[0] ?? null;
    }
    defaultProfile = config.defaultProfile ?? null;
  });
  return { name, defaultProfile };
}

export function setEnabled(home, name, enabled) {
  updateConfig(home, config => {
    if (!config.profiles?.[name]) throw new Error(`找不到执行者：${name}`);
    config.profiles[name].enabled = enabled;
  });
  return { name, enabled };
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
    const value = JSON.parse(readFileSync(path.join(home, 'agent-tests.json'), 'utf8'));
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
function runOnce({ scriptPath, repo, testHome, env, timeoutMs }) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn(process.execPath, [scriptPath, 'dispatch', '只回复 OK，不要修改任何文件', '--name', 'agent-test'],
        { cwd: repo, env: { ...env, AGENT_ROUTER_HOME: testHome, AR_NO_WATCH: '1' }, shell: false, windowsHide: true });
    } catch (error) { done({ exit: null, timedOut: false, spawnError: error.message }); return; }
    let timedOut = false;
    // 排空输出，避免子进程因管道缓冲区写满而卡住。
    child.stdout.setEncoding('utf8'); child.stdout.on('data', () => {});
    child.stderr.setEncoding('utf8'); child.stderr.on('data', () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid).catch(() => { /* 结束失败由 close 兜底；不退就按超时结算。 */ }).finally(() => done({ exit: null, timedOut: true }));
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); done({ exit: null, timedOut, spawnError: error.message }); });
    child.on('close', code => { clearTimeout(timer); done({ exit: code, timedOut }); });
  });
}

// 测试连接：在临时 git 仓库与临时公共目录里、以子进程派发"只回复 OK"（会真实调用执行者；不写入你的任务清单）。
// 超时后用 killProcessTree 结束整棵进程树；结果写进 <home>/agent-tests.json 供 list 读取。
export async function testAgent(home, name, { env = process.env, scriptPath, timeoutSeconds = 180 } = {}) {
  const state = readConfig(home);
  const config = state.exists && !state.reason ? state.config : builtinConfig();
  const profile = config.profiles?.[name];
  if (!profile) throw new Error(`找不到执行者：${name}`);
  const base = mkdtempSync(path.join(tmpdir(), 'ar-agent-test-'));
  const started = Date.now();
  try {
    const repo = path.join(base, 'repo'), testHome = path.join(base, 'home');
    mkdirSync(repo); mkdirSync(testHome);
    const git = args => execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
    git(['init', '-q']); writeFileSync(path.join(repo, 'README.md'), '# test\n'); git(['add', 'README.md']);
    git(['-c', 'user.name=agent-router', '-c', 'user.email=agent-router@example.invalid', 'commit', '-q', '-m', 'init']);
    writeFileSync(path.join(testHome, 'config.json'), JSON.stringify({ v: 2, defaultProfile: name, profiles: { [name]: { ...profile, enabled: true } }, managed: false, watchWindow: 'never' }));
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
    try { rmSync(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); } catch { /* 留给系统清理临时目录 */ }
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

const usageAgents = 'ar agents list [--detect] | add --preset <预设> [--name <名>] [--label <显示名>] [--model <模型>] [--base-url <地址>] [--secret-var <变量名>] [--auth login|token] | update <名> [--label <显示名>] [--model <模型>] [--base-url <地址>] [--secret-var <变量名>] [--max-turns <正整数>|-] | default <名> | remove <名> | enable <名> | disable <名> | test <名> [--timeout <秒>] | presets';
export async function agentsCommand(rest, { home, env = process.env, scriptPath }) {
  const [sub, ...args] = rest;
  const one = () => { if (args.length !== 1 || !args[0] || args[0].startsWith('--')) throw new Error(`用法：${usageAgents}`); return args[0]; };
  // --key 值 形式的选项解析；未知选项 / 缺值 / 值又是 -- 开头都算用法错误。
  const parseOptions = keys => {
    const opts = {}, positional = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--')) {
        const key = a.slice(2);
        if (!keys.includes(key) || i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`用法：${usageAgents}`);
        opts[key] = args[++i];
      } else positional.push(a);
    }
    return { opts, positional };
  };
  switch (sub) {
    case 'list': {
      const detect = args.includes('--detect');
      if (args.length !== (detect ? 1 : 0)) throw new Error(`用法：${usageAgents}`);
      const agents = listAgents(home, { env, detect });
      return { result: { ok: true, agents }, text: formatList(agents) };
    }
    case 'presets': {
      if (args.length) throw new Error(`用法：${usageAgents}`);
      const presets = presetObjects().map(presetSummary);
      return { result: { ok: true, presets }, text: `可用预设：${listPresets().join('、')}` };
    }
    case 'add': {
      const { opts, positional } = parseOptions(['preset', 'name', 'label', 'model', 'base-url', 'secret-var', 'auth']);
      if (positional.length || !opts.preset) throw new Error(`用法：${usageAgents}`);
      const added = addAgent(home, { preset: opts.preset, name: opts.name, label: opts.label, model: opts.model, baseUrl: opts['base-url'], secretVar: opts['secret-var'], auth: opts.auth });
      const status = secretStatus(added.secrets, { env });
      const missing = Object.entries(status).filter(([, s]) => s === 'missing').map(([n]) => n);
      return { result: { ok: true, ...added, secretStatus: status }, text: [`已加入执行者 ${added.name}（预设 ${opts.preset}）`, added.madeDefault ? `默认执行者改为 ${added.name}（Codex 保持启用，只在显式指定或审查时使用）` : null,
        missing.length ? `还没有设置密钥：${missing.join('、')}。运行 ar secrets set ${missing[0]}，或设置同名的 Windows 用户环境变量` : added.secrets.length ? `密钥已设置：${added.secrets.join('、')}` : null].filter(Boolean).join('\n') };
    }
    case 'update': {
      const { opts, positional } = parseOptions(['label', 'model', 'base-url', 'secret-var', 'max-turns']);
      if (positional.length !== 1 || !positional[0] || positional[0].startsWith('--')) throw new Error(`用法：${usageAgents}`);
      if (!['label', 'model', 'base-url', 'secret-var', 'max-turns'].some(k => opts[k] !== undefined)) throw new Error(`用法：${usageAgents}`);
      const r = updateAgent(home, positional[0], { label: opts.label, model: opts.model, baseUrl: opts['base-url'], secretVar: opts['secret-var'], maxTurns: opts['max-turns'] === undefined ? undefined : parseMaxTurns(opts['max-turns']) });
      return { result: { ok: true, name: r.name, profile: r.profile }, text: `已更新执行者 ${r.name}` };
    }
    case 'default': { const r = setDefault(home, one()); return { result: { ok: true, ...r }, text: `默认执行者：${r.defaultProfile}` }; }
    case 'remove': { const r = removeAgent(home, one()); return { result: { ok: true, ...r }, text: `已删除执行者 ${r.name}${r.defaultProfile ? `；默认执行者：${r.defaultProfile}` : '；现在没有默认执行者'}` }; }
    case 'enable': case 'disable': { const r = setEnabled(home, one(), sub === 'enable'); return { result: { ok: true, ...r }, text: `执行者 ${r.name} ${r.enabled ? '已启用' : '已停用'}` }; }
    case 'test': {
      const { opts, positional } = parseOptions(['timeout']);
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
