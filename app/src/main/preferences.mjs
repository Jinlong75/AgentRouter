import { parentPort, workerData } from 'node:worker_threads';
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, freemem, totalmem } from 'node:os';
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
  const [install, config, adapter, codexConfig, json, proxy, schedule] = await Promise.all([
    module('installer/lib/install.mjs'), module('core/lib/config.mjs'),
    module('core/adapters/codex.mjs'), module('installer/lib/codex-config.mjs'), module('core/lib/json.mjs'), module('core/lib/proxy.mjs'), module('core/lib/schedule.mjs')]);
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
  // 并行一节的估算信息全部取自核心（slotLimits 的估算值、schedule 的核数与忙闲判断），界面不自己算。
  // 机器正忙：真实采样只在可用内存不够时才算（CPU 要连续 1 分钟超过 85% 才暂停，瞬时值判断不了）；
  // 测试用 AR_TEST_LOAD_FILE（与核心排队时的注入同一格式 { busy, cpu }，这里另认可选的 memLow: true 与 freeMemGb，模拟"可用内存不够"）：由测试工具在启动前经隔离环境设置，产品代码不自己造路径。
  // 返回忙的原因：memory（可用内存不够，带可用内存 GB 一位小数）或 cpu；不忙时 reason 为 null。
  const loadFile = env.AR_TEST_LOAD_FILE || '';
  const gb = bytes => (bytes / 1024 ** 3).toFixed(1);
  const machineLoad = percent => {
    if (loadFile) try {
      const injected = json.parseJson(readFileSync(loadFile, 'utf8')), busy = injected.busy === true, memory = busy && injected.memLow === true;
      return { busy, cpu: Number.isFinite(injected.cpu) ? injected.cpu : null, reason: memory ? 'memory' : busy ? 'cpu' : null, freeGb: memory && Number.isFinite(injected.freeMemGb) ? injected.freeMemGb.toFixed(1) : gb(freemem()) };
    } catch { /* 没有注入文件就按真实采样。 */ }
    const load = schedule.currentLoad({ memLowPercent: percent });
    return { busy: load.memLow, cpu: load.cpu, reason: load.memLow ? 'memory' : null, freeGb: gb(load.freeMemBytes) };
  };
  // "内存不够时暂停"的阈值（GB，一位小数）：与核心排队时同一个函数 memLowThreshold；
  // 测试注入文件可另带 totalMemGb（固定总内存，免得读这台电脑的真实内存）。
  const totalMemory = () => {
    if (loadFile) try { const injected = json.parseJson(readFileSync(loadFile, 'utf8')); if (Number.isFinite(injected.totalMemGb) && injected.totalMemGb > 0) return injected.totalMemGb * 1024 ** 3; } catch { /* 没有注入文件就读真实总内存。 */ }
    return totalmem();
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
    // concurrency：auto 原样给 'auto'；写了正整数的（含手写的越界值）原样给；其余按核心的口径取生效值。
    const slots = config.slotLimits(state.config), raw = state.config?.concurrency;
    const concurrency = raw === 'auto' ? 'auto' : Number.isSafeInteger(raw) && raw > 0 ? raw : slots.limits.concurrency;
    const load = slots.mode === 'auto' ? machineLoad(slots.memLowPercent) : { busy: false, cpu: null, reason: null, freeGb: null };
    // busyReason / busyFreeGb：机器正忙的原因（memory = 可用内存不够，cpu）与忙时的可用内存（GB，一位小数）；不忙时为 null。
    const parallel = { estimate: slots.estimate, cores: schedule.machineCores(), freeGb: (freemem() / 1024 ** 3).toFixed(1), cpu: load.cpu, busy: load.busy, busyReason: load.busy ? load.reason : null, busyFreeGb: load.busy ? load.freeGb : null,
      memLowGb: gb(schedule.memLowThreshold(totalMemory(), slots.memLowPercent)) };
    // codexProfiles：每个 Codex 适配器的执行者（含改过名的，如 codex-pro）各自的值，给 Codex 编辑预填用；解析与上面的 resolveSettings(…, '<名>') 相同。
    const codexProfiles = {};
    if (!state.reason && state.config?.v === 2) for (const [name, profile] of Object.entries(state.config.profiles ?? {})) {
      if (profile?.adapter !== 'codex') continue;
      try { const { model, effort, tier, sandbox, path } = config.resolveSettings(state.config, {}, {}, name).settings; codexProfiles[name] = { model, effort, tier, sandbox, path }; } catch { /* 这一个读不了就让界面回退到 values。 */ }
    }
    return { codexProfiles, managed: state.config?.managed === true, leadUsage: state.config?.leadUsage === true, proxy: networkProxy, concurrency, concurrencyMax: slots.max, memLowPercent: slots.memLowPercent, parallel, retentionDays: config.sessionRetention(state.config).days,
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
      return { host: h.host, detected: h.detected, root: shorten(h.root), installedAt, skills, legacy: (h.legacy ?? []).map(({ skill, link }) => ({ skill, link })), actions: hostActions(skills, backup) };
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
        // 同时运行的任务数：config.json 的 concurrency，收 1～8 的整数或 "auto"（D59）；自动档的上限 concurrencyMax 收 1～8 的整数。
        // writeConfig 不认这两个键，走 updateConfig（保留其余字段）；被拒绝的值不写文件。
        const slotValue = value => Number.isInteger(value) && value >= 1 && value <= schedule.concurrencyCap;
        if (payload.key === 'concurrency') { if (payload.value !== 'auto' && !slotValue(payload.value)) throw Error('Invalid value'); config.updateConfig(home, cfg => { cfg.concurrency = payload.value; }); return settings(); }
        if (payload.key === 'concurrencyMax') { if (!slotValue(payload.value)) throw Error('Invalid value'); config.updateConfig(home, cfg => { cfg.concurrencyMax = payload.value; }); return settings(); }
        // 内存不够时暂停的比例（D114，182）：config.json 的 memLowPercent，只收 1～50 的整数；被拒绝的值不写文件。
        if (payload.key === 'memLowPercent') { if (!schedule.validMemLowPercent(payload.value)) throw Error('Invalid value'); config.updateConfig(home, cfg => { cfg.memLowPercent = payload.value; }); return settings(); }
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
        const choices = { effort: ['minimal','low','medium','high','xhigh'], tier: ['default','priority','flex'], sandbox: ['workspace-write','read-only'], watchWindow: ['auto','always','never'] };
        // Codex 的编辑是表单式（144）：点"保存"时模型、推理强度、服务档位、沙箱、位置一次写入（同一次 writeConfig，要么全写要么都不写）。
        // value 是 { model?, effort?, tier?, sandbox?, path? }，值为字符串或 null（null = 跟随 Codex / 自动查找）。
        // 推理强度不再限定那五个值：探针查到的可选值可能更多（如 max），原样写入、不替用户改。
        if (payload.key === 'codex') {
          const value = payload.value;
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid value');
          const changes = {};
          for (const [key, item] of Object.entries(value)) {
            if (!['model', 'effort', 'tier', 'sandbox', 'path'].includes(key)) throw Error('Invalid setting');
            if (item !== null && typeof item !== 'string') throw Error('Invalid value');
            if (item !== null && key !== 'effort' && choices[key] && !choices[key].includes(item)) throw Error('Invalid value');
            changes[key] = item;
          }
          if (!Object.keys(changes).length) throw Error('Invalid value');
          // profile（可选）：改过名的 Codex 执行者的名字；不给时写 codex，和以前一样。是否存在、是否 Codex 适配器由 writeConfig 校验。
          if (payload.profile !== undefined && !(typeof payload.profile === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(payload.profile))) throw Error('Invalid value');
          config.writeConfig(home, changes, payload.profile === undefined ? {} : { profile: payload.profile }); return settings();
        }
        if (!['model', 'effort', 'tier', 'sandbox', 'watchWindow', 'path'].includes(payload.key)) throw Error('Invalid setting');
        if (payload.value !== null && typeof payload.value !== 'string') throw Error('Invalid value');
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
        if (!install.hosts.includes(payload.host) || !['install','update','reinstall','replace','rollback','selected','removeLegacy'].includes(payload.operation)) throw Error('Invalid operation');
        if (payload.operation === 'rollback') return install.rollback({ env, host: payload.host });
        if (payload.operation === 'removeLegacy') return install.removeLegacy({ env, host: payload.host });
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
