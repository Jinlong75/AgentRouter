import { parentPort, workerData } from 'node:worker_threads';
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export function loginState(result) {
  if (result.error || result.signal) return 'unknown';
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status === 0 && /^Logged in\b/im.test(text)) return 'in';
  if (result.status === 1 && /^Not logged in\b/im.test(text)) return 'out';
  return 'unknown';
}
export function skillState(entry, version) {
  if (entry.state === 'missing') return 'missing';
  if (entry.state !== 'owned') return 'custom';
  const a = entry.version.split('.').map(Number), b = version.split('.').map(Number);
  const different = a.findIndex((n, i) => n !== b[i]);
  return different < 0 ? 'latest' : a[different] < b[different] ? 'update' : 'newer';
}
export function hostActions(skills, backup) {
  return [...(skills.some(s => s.state === 'missing') ? ['install'] : []),
    ...(skills.some(s => s.state === 'update') ? ['update'] : []),
    ...(skills.every(s => s.state === 'latest') ? ['reinstall'] : []),
    ...(backup ? ['rollback'] : []), ...(skills.some(s => s.state === 'custom') ? ['replace'] : [])];
}
export const defaultChecked = state => state === 'missing' || state === 'update';
export async function createPreferences(root, data, env = process.env) {
  const module = file => import(pathToFileURL(join(root, file)).href);
  const [install, config, adapter, codexConfig, json, proxy] = await Promise.all([
    module('installer/lib/install.mjs'), module('core/lib/config.mjs'),
    module('core/adapters/codex.mjs'), module('installer/lib/codex-config.mjs'), module('core/lib/json.mjs'), module('core/lib/proxy.mjs')]);
  const home = config.homeDirectory(env), ownFile = join(data, 'preferences.json');
  let own = { notifications: true, theme: 'system', wizardDone: false, closeAction: 'ask', trayHintShown: false };
  try { own = { ...own, ...json.parseJson(readFileSync(ownFile, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const saveOwn = patch => {
    const next = { ...own, ...patch }; mkdirSync(data, { recursive: true });
    writeFileSync(ownFile + '.tmp', JSON.stringify(next)); renameSync(ownFile + '.tmp', ownFile); own = next;
  };
  const shorten = file => {
    if (!file) return '';
    for (const [base, label] of [...(process.platform === 'win32' ? [[env.APPDATA, '%APPDATA%']] : []), [config.userDirectory(env), '~']]) {
      if (!base) continue;
      const rel = relative(base, file);
      if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) return label + (rel ? (label === '%APPDATA%' ? '\\' + rel : '/' + rel.replaceAll('\\', '/')) : '');
    }
    return file;
  };
  // 重置失败留下的标记（系统临时目录）。主进程与这里各自读取，避免把 reset.mjs 复制成运行期依赖。
  const leftoverFile = join(tmpdir(), 'agent-router-reset-leftover.json');
  const leftover = () => {
    try {
      const value = json.parseJson(readFileSync(leftoverFile, 'utf8'));
      return value && typeof value.home === 'string' ? value : null;
    } catch { return null; }
  };
  function settings() {
    let state;
    try { state = config.loadConfig(home, {}, {}); }
    // reason 给 copy.ts 的 configError 拼句：用读取层的短原因（"不是有效的 JSON"等），
    // 错误对象里完整的协议行不重复拼进去（063：loadConfig 对无效配置直接拒绝）。
    catch (e) { const disk = config.readConfig(home); state = { ...disk, reason: disk.reason ?? e.message, settings: config.defaults }; }
    // 设置页这一节是 Codex 执行者的设置：取 codex profile 的值（与 writeConfig 写入的位置一致），不取默认执行者的。
    if (!state.reason && state.config?.v === 2) try { state.settings = config.resolveSettings(state.config, {}, {}, 'codex').settings; } catch { /* 保留上面的值。 */ }
    const current = codexConfig.readCodexConfig(env)?.values || {};
    const overrides = {};
    for (const [key, name] of Object.entries({ model: 'CODEX_MODEL', effort: 'CODEX_EFFORT', tier: 'CODEX_TIER', sandbox: 'CODEX_SANDBOX', watchWindow: env.AR_NO_WATCH ? 'AR_NO_WATCH' : 'CODEX_NO_WATCH' }))
      if (env[name]) overrides[key] = { name, value: env[name] };
    // profiles：执行者配置原样交给 Agent 页（编辑 claude-code 执行者需要 env / maxTurns / secrets 等预填值）。
    const profiles = state.reason || !state.config?.profiles ? {} : state.config.profiles;
    // 并行上限与会话保留天数：按核心的口径取生效值（没写或不合法按默认），手写的越界值（如 7）原样给界面显示。
    // 网络代理（099）：config.json 的 proxy（没写按 off）；system 模式再读一次系统代理，界面据此说明"这一刻读到了什么"。
    const saved = state.config?.proxy, mode = proxy.PROXY_MODES.includes(saved?.mode) ? saved.mode : 'off';
    const networkProxy = { mode, url: typeof saved?.url === 'string' ? saved.url : '', system: mode === 'system' && !state.reason ? proxy.readSystemProxy({ env }) : null };
    return { managed: state.config?.managed === true, leadUsage: state.config?.leadUsage === true, proxy: networkProxy, concurrency: config.slotLimits(state.config).limits.concurrency, retentionDays: config.sessionRetention(state.config).days,
      values: state.settings, profiles, exists: state.exists, reason: state.reason, file: shorten(state.file),
      home, leftover: leftover(),
      current: { model: current.model, effort: current.model_reasoning_effort, tier: current.service_tier }, overrides, own };
  }
  let connections;
  function detect() {
    const state = settings();
    const hosts = install.getStatus({ env }).map(h => {
      const skills = h.skills.map(s => ({ skill: s.skill, version: s.version, state: skillState(s, install.version), checked: defaultChecked(skillState(s, install.version)) }));
      let installedAt = 0;
      for (const s of h.skills.filter(s => s.state === 'owned')) {
        try { const record = json.parseJson(readFileSync(join(s.target,'.agent-router.json'),'utf8')); if(Number.isFinite(record.installedAt)) installedAt=Math.max(installedAt,record.installedAt); }
        catch { /* 检测期间记录消失时不显示时间。 */ }
      }
      let backup = false;
      try { backup = install.rollbackPlan({ env, host: h.host }).items.length > 0; } catch { /* 损坏的备份不提供回退按钮。 */ }
      return { host: h.host, detected: h.detected, root: shorten(h.root), installedAt, skills, legacy: (h.legacy ?? []).map(l => l.skill), actions: hostActions(skills, backup) };
    });
    const detected = adapter.codex.detect({ env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, settings: { path: state.values.path } });
    const version = detected.version;
    let login = 'unknown';
    if (detected.installed && detected.launcher) {
      const result = spawnSync(detected.launcher.executable, [...detected.launcher.args, 'login', 'status'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
      // 只保留状态，账号和原始输出不跨线程、不落盘。
      login = loginState(result);
    }
    if (version && version !== own.lastVersion) saveOwn({ lastVersion: version, ...(own.lastVersion ? { versionChange: { old: own.lastVersion, next: version } } : {}) });
    connections = { hosts, availableVersion: install.version, codex: { version, installed: !!version && detected.installed, login, path: state.values.path ? shorten(state.values.path) : null, change: own.versionChange } };
    return connections;
  }
  return {
    async run(action, payload = {}) {
      if (action === 'settings') return settings();
      if (action === 'detect') return detect();
      if (action === 'save') {
        if (payload.key === 'managed') { if (typeof payload.value !== 'boolean') throw Error('Invalid value'); config.writeConfig(home, { managed: payload.value }); return settings(); }
        // 同时运行的任务数：config.json 的 concurrency，界面只让选 1～4；writeConfig 不认这个键，走 updateConfig（保留其余字段）。
        if (payload.key === 'concurrency') { if (!Number.isInteger(payload.value) || payload.value < 1 || payload.value > 4) throw Error('Invalid value'); config.updateConfig(home, cfg => { cfg.concurrency = payload.value; }); return settings(); }
        // 统计主导的 token 与用时：config.json 的 leadUsage，只认布尔值；走 updateConfig 保留其余字段。
        if (payload.key === 'leadUsage') { if (typeof payload.value !== 'boolean') throw Error('Invalid value'); config.updateConfig(home, cfg => { cfg.leadUsage = payload.value; }); return settings(); }
        // 网络代理：{ mode, url? }。manual 先用核心的 validateProxyUrl 校验，不合法抛出错误码（PROXY_EMPTY / PROXY_FORMAT / PROXY_CREDENTIALS，
        // 界面按它显示对应的说明），不写配置；合法才走 updateConfig 保留其余字段。其他模式保留已保存的地址（切回 manual 时还在），但地址里带凭据一律不留。
        if (payload.key === 'proxy') {
          const value = payload.value;
          if (!value || typeof value !== 'object' || !proxy.PROXY_MODES.includes(value.mode)) throw Error('Invalid value');
          if (value.mode === 'manual') {
            if (typeof value.url !== 'string') throw Error('Invalid value');
            const checked = proxy.validateProxyUrl(value.url);
            if (!checked.ok) throw Error(checked.code);
            config.updateConfig(home, cfg => { cfg.proxy = { mode: 'manual', url: checked.url }; });
          } else config.updateConfig(home, cfg => { cfg.proxy = { ...(typeof cfg.proxy?.url === 'string' && cfg.proxy.url && proxy.validateProxyUrl(cfg.proxy.url).ok ? { url: cfg.proxy.url } : {}), mode: value.mode }; });
          return settings();
        }
        if (!['model', 'effort', 'tier', 'sandbox', 'watchWindow', 'path'].includes(payload.key)) throw Error('Invalid setting');
        if (payload.value !== null && typeof payload.value !== 'string') throw Error('Invalid value');
        const choices = { effort: ['minimal','low','medium','high','xhigh'], tier: ['default','priority','flex'], sandbox: ['workspace-write','read-only'], watchWindow: ['auto','always','never'] };
        if (payload.value !== null && choices[payload.key] && !choices[payload.key].includes(payload.value)) throw Error('Invalid value');
        config.writeConfig(home, { [payload.key]: payload.value }); return settings();
      }
      if (action === 'own') {
        if (payload.key === 'theme' && ['system','light','dark'].includes(payload.value)
          || payload.key === 'notifications' && typeof payload.value === 'boolean'
          || payload.key === 'closeAction' && ['ask','tray','quit'].includes(payload.value)
          || payload.key === 'taskSort' && ['time','state','project'].includes(payload.value)
          || payload.key === 'trayHintShown' && typeof payload.value === 'boolean') saveOwn({ [payload.key]: payload.value });
        else throw Error('Invalid preference');
        return settings();
      }
      if (action === 'ackLeftover') { rmSync(leftoverFile, { force: true }); return settings(); }
      if (action === 'finish') { if (payload.configure && !existsSync(join(home,'config.json'))) config.writeConfig(home); saveOwn({ wizardDone: true }); return settings(); }
      if (action === 'ack') { saveOwn({ versionChange: null }); return detect(); }
      if (action === 'install') {
        if (!install.hosts.includes(payload.host) || !['install','update','reinstall','replace','rollback','selected'].includes(payload.operation)) throw Error('Invalid operation');
        if (payload.operation === 'rollback') return install.rollback({ env, host: payload.host });
        const plan = install.createPlan({ env, host: payload.host, sourceRoot: join(root,'skills'), replaceExisting: ['replace','selected'].includes(payload.operation) });
        if (!plan.statuses[0]?.detected) throw Error('Host no longer detected');
        const allowed = { install: ['missing'], update: ['update'], reinstall: ['latest'], replace: ['custom'], selected: ['missing','update','latest','custom'] }[payload.operation];
        if (['selected','replace'].includes(payload.operation) && (!Array.isArray(payload.skills) || payload.skills.some(s => !install.skills.includes(s)))) throw Error('Invalid skills');
        plan.items = plan.items.filter(i => allowed.includes(skillState(i, install.version)) && (!payload.skills || payload.skills.includes(i.skill)));
        return install.executePlan(plan, { env });
      }
      throw Error('Invalid operation');
    }
  };
}
if (parentPort) {
  const service = await createPreferences(workerData.root, workerData.data);
  parentPort.on('message', async ({ id, action, payload }) => {
    try { parentPort.postMessage({ id, value: await service.run(action, payload) }); }
    catch (e) { parentPort.postMessage({ id, error: e.message }); }
  });
}
