import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, readFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { basename, isAbsolute, relative, join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { homeDirectory, loadConfig } from './config.mjs';
import { dispatcher, parseArgs, taskDetails } from './options.mjs';
import { recordPaths, registryWriter, writeDispatch } from './records.mjs';
import { clip, formatProgress, progressFooter, progressHeader } from './progress.mjs';
import { openWatch, shouldWatch, viewerTakesOver } from './watch.mjs';
import { acceptsManaged, viewerApp, managedEnvironment, validRequest, existingPaths, handoff, fallbackMessage, managedMessage } from './managed.mjs';
import { printCompletion } from './completion.mjs';
import { killProcessTree } from './process.mjs';
import { dryRun as dryRunEnv, testStartTimeout, homeEnv, unsafeHome } from './compat.mjs';
import { adapterFor } from '../adapters/index.mjs';
import { buildEnv, allowedEnv, secretSources } from './env.mjs';
import { parseSpec, validateSpec, mergeSpec } from './spec.mjs';
import { git, headSha, parseStatusPorcelainZ, uncommittedFiles } from './git.mjs';
import { runGate } from './gate.mjs';

export async function run({ adapter: adapterOverride, scriptPath, args = process.argv.slice(2), env = process.env, root = process.cwd(), onDetach, onGate } = {}) {
  // 公共目录保护（协议第 1 节）：必须在改名请求文件、读写公共目录、启动进程之前检查。
  // 只检查显式设置的新名 / 旧名环境变量；--run-request 执行者进程也走这里。
  if (homeEnv.some(key => env[key])) {
    const reason = unsafeHome(homeDirectory(env), { env });
    if (reason) throw Object.assign(new Error(reason), { arCode: 'UNSAFE_HOME' });
  }
  // 只负责派发与托管执行者入口；wait / stop / config 等子命令在 cli.mjs。
  let requestFile = args[0] === '--run-request' ? args[1] : null;
  if (requestFile) {
    if (!requestFile.endsWith('.claimed.json')) return 0;
    const running = requestFile.replace(/\.claimed\.json$/, '.running.json');
    try { renameSync(requestFile, running); } catch { return 0; }
    requestFile = running;
  }
  const request = requestFile ? JSON.parse(readFileSync(requestFile, 'utf8')) : null;
  if (request && !validRequest(request)) throw Error('请求文件无效');
  if (request) root = request.repo;
  const parsed = request ? { task: request.args.task, extra: request.args.extra, opts: { name: request.name, ...(request.args.role ? { role: request.args.role } : {}) } } : parseArgs(args);
  const details = taskDetails(root, parsed);
  const dryRun = !request && dryRunEnv(env);
  const started = Date.now();
  // dry-run 在读取配置、检测 agent、创建目录之前返回。
  if (dryRun) {
    console.log(`记录名：${recordPaths(root, details.name, '', true).name}\n----\n${details.prompt}`);
    return 0;
  }
  const home = homeDirectory(env);
  const registry = registryWriter(home);
  // 先选执行者再占记录名：进度首行写执行者名；配置出错时不留下空记录。托管执行者用请求里的快照。
  const { settings, warning, config, profileName, profile } = request
    ? { settings: { ...request.settings, watchWindow: 'never' }, warning: null, config: {}, profileName: request.profile ?? 'codex', profile: { adapter: request.adapter ?? 'codex', ...(request.profileConfig ?? {}) } }
    : loadConfig(home, parsed.opts, env);
  const adapter = adapterOverride ?? adapterFor(profile);
  const label = profile.label ?? adapter.label ?? adapter.id;
  // 用任务说明派发：解析 frontmatter、合并项目配置；启用门禁时先做派发前检查（协议 11.1～11.4）。
  // 全部在占记录名之前完成，失败时不留下空记录；托管 / 脱离派发的执行者进程直接用请求里的快照。
  let gateInfo = null, specWarnings = [];
  if (request) gateInfo = request.args.gate ?? null;
  else if (details.spec) ({ gate: gateInfo, warnings: specWarnings } = prepareSpecGate(root, details.spec));
  const paths = request ? existingPaths(root, request.name) : recordPaths(root, details.name, progressHeader(details.title, details.role?.name, started, label));
  console.log(`记录名：${paths.name}\n进度：${paths.progress}`);
  writeFileSync(paths.raw, '');
  writeFileSync(paths.events, '');
  // 保存原始派发参数，供 ar redispatch / 界面"再派一次"使用。只在真正派发时写：
  // 执行者进程（request）沿用记录目录里已有的那一份，不覆盖成快照里的字段。spec 只存相对项目根的路径。
  // 这里只有用户输入与执行者名，密钥来源与值都不会写进来。
  if (!request) writeDispatch(paths, {
    task: parsed.task,
    extra: parsed.extra,
    role: parsed.opts.role ?? null,
    spec: details.spec ? relative(root, resolvePath(root, details.spec)).replaceAll('\\', '/') : null,
    profile: profileName,
    name: paths.name,
  });
  const interactive = !!process.stdout.isTTY;
  const progress = (text, at = Date.now()) => {
    const line = `[${new Date(at).toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`;
    appendFileSync(paths.progress, `${line}\n`);
    if (interactive) console.log(line);
  };
  if (warning) { progress(warning); if (!interactive) console.log(warning); }
  // 不认识的字段只警告、不报错（协议 11.2）；进度里记一行，标准输出照常打印（--json 时由调用方收集）。
  for (const text of specWarnings) {
    const line = `任务说明警告：${text}`;
    progress(line);
    if (!interactive) console.log(line);
  }
  if (request) progress(managedMessage(request.app));
  const id = request?.id ?? `${paths.name}-${started}-${process.pid}`;
  const source = request?.dispatcher ?? dispatcher(parsed.opts.host, env);
  if (!request && parsed.opts.detach) {
    // 脱离派发：占好记录名、选好执行者之后，直接写成"已认领"请求并交给独立进程运行，不握手、不等待、不弹进度窗口。
    // 执行者进程沿用 --run-request 流程，所以停止、等待、看板显示与托管任务完全一致。
    const detachRequest = { v: 1, id, app: 'AgentRouter', at: started, script: scriptPath, node: process.execPath, repo: root, name: paths.name, profile: profileName, adapter: adapter.id,
      args: { task: parsed.task, extra: parsed.extra, role: parsed.opts.role ?? null, spec: details.spec, ...(gateInfo ? { gate: gateInfo } : {}) },
      settings: Object.fromEntries(['model','effort','tier','sandbox','path'].map(key => [key, settings[key]])), dispatcher: source, env: managedEnvironment(env),
      profileConfig: profileConfig(profile, adapter), detached: true };
    const claimed = join(home, 'managed', `${id}.claimed.json`);
    mkdirSync(join(home, 'managed'), { recursive: true });
    const temp = `${claimed}.tmp`;
    try { writeFileSync(temp, JSON.stringify(detachRequest), { flag: 'wx', mode: 0o600 }); renameSync(temp, claimed); }
    catch (error) { rmSync(temp, { force: true }); throw error; }
    // 执行者进程用调用者的完整环境启动（密钥在它自己解析 profile 时由 buildEnv 注入），请求文件里不含任何密钥值。
    const childEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env;
    const child = spawn(process.execPath, [scriptPath, '--run-request', claimed], { cwd: root, env: childEnv, detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    onDetach?.(id);
    return 0;
  }
  if (!request && acceptsManaged(home, config.managed === true)) {
    const app = viewerApp(home);
    const announce = text => { if (text === managedMessage(app)) console.log(text); else { progress(text); if (!interactive) console.log(text); } };
    const result = await handoff(home, { v: 1, id, app, at: started, script: scriptPath, node: process.execPath, repo: root, name: paths.name, profile: profileName, adapter: adapter.id,
      args: { task: parsed.task, extra: parsed.extra, role: parsed.opts.role ?? null, spec: details.spec, ...(gateInfo ? { gate: gateInfo } : {}) },
      settings: Object.fromEntries(['model','effort','tier','sandbox','path'].map(key => [key, settings[key]])), dispatcher: source, env: managedEnvironment(env),
      // 执行者配置快照：只有非密钥部分（secrets 只是变量名），密钥由托管执行者启动时自己解析。
      profileConfig: profileConfig(profile, adapter) }, announce,
      { startTimeout: testStartTimeout(env) ?? 15000 });
    if ('exit' in result) {
      // 托管执行者把门禁结果写在自己的清单里；等待方从 end 行之前的 gate 事件取（协议 13）。
      if (result.gate) onGate?.(result.gate);
      return printCompletion(result.exit, paths, console.log, result.gate ?? null);
    }
    announce(fallbackMessage(result.reason, app));
  }
  // 执行者环境：白名单、profile.env、密钥、隔离项（见 env.mjs）。缺密钥等问题在下面记为启动失败，检测版本也只用白名单环境。
  const sources = secretSources(config);
  let childEnv, envError = null;
  try { childEnv = buildEnv({ base: env, profile, adapter, home, profileName, sources }); }
  catch (error) { envError = error; childEnv = allowedEnv({ base: env, adapter, home, profileName, sources }); }
  const detection = await adapter.detect({ env: childEnv, settings, profile });
  registry({ event: 'start', v: 2, id, repo: root, name: paths.name, dir: paths.dir, project: basename(root), profile: profileName, adapter: adapter.id, label, spec: details.spec ? relative(root, resolvePath(root, details.spec)).replaceAll('\\', '/') : null,
    title: details.title, role: details.role?.name ?? null, pid: process.pid, started,
    progress: paths.progress, report: paths.report, raw: paths.raw, model: settings.model ?? adapter.modelName?.({ settings, profile }) ?? null, effort: settings.effort, tier: settings.tier,
    agent: adapter.id, agentVersion: detection.version, sandbox: settings.sandbox, events: paths.events,
    dispatcher: source, ...(request ? { managed: true } : {}),
    // 用任务说明派发的任务记是否启用门禁；启用时记派发时的 HEAD（协议第 2 节、11.4）。其他任务没有这两个字段。
    ...(gateInfo ? { gate: gateInfo.enabled, ...(gateInfo.enabled ? { base: gateInfo.base } : {}) } : {}),
  });
  let seq = 0, lastSay = null;
  // 有状态映射（如 Claude Code 要靠 id 配对命令开始与结果）用 createMapper，否则用无状态的 mapLine。
  const mapLine = adapter.createMapper ? adapter.createMapper() : adapter.mapLine;
  const errors = [];
  const emit = (event, at = Date.now()) => {
    const unified = { ...event, v: 1, seq: ++seq, at };
    appendFileSync(paths.events, `${JSON.stringify(unified)}\n`);
    if (event.kind === 'say') lastSay = event.text;
    if (event.kind === 'error') errors.push(event.text);
    for (const line of formatProgress(unified)) progress(line, at);
  };
  const finish = (code, { gate = null, agentExit } = {}) => {
    // 不自己写汇报文件的执行者：由适配器决定汇报正文（如 Claude Code 的 result），默认最后一条说话；都没有就不写。
    if (!adapter.writesReport) {
      const text = adapter.finish ? adapter.finish({ lastSay, result: mapLine.lastResult ?? null }) : lastSay;
      if (text != null) writeFileSync(paths.report, text);
    }
    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    appendFileSync(paths.progress, progressFooter(code, minutes, paths.report, label));
    // 先写 gate 事件再写 end（协议第 2 节、12.1）；跑过门禁的 end 另有 agentExit。
    if (gate) registry({ event: 'gate', id, ok: gate.ok, attempt: gate.attempt, at: gate.at, summary: gate.summary });
    registry({ event: 'end', id, exit: code, at: Date.now(), minutes: Number(minutes), ...(gate ? { agentExit } : {}) });
    // 后台派发时进度不打印到标准输出；失败原因放在退出码前面，派活方不用翻日志就能看到。
    if (code !== 0 && !interactive) for (const text of errors) console.log(`出错：${clip(text)}`);
    // 门禁结果放在结果行前面（协议 13）；--json 时由调用方收集进 JSON。
    if (gate) {
      onGate?.({ ok: gate.ok === true, summary: gate.summary });
      console.log(gate.ok ? '门禁通过' : `门禁未通过：${gate.summary}`);
    }
    console.log(`exit=${code} report=${paths.report}`);
    return code ?? 1;
  };
  let command;
  try {
    if (envError) throw envError;
    command = adapter.command({ root, report: paths.report, prompt: details.prompt, settings, detection, env: childEnv, profile });
  }
  catch (error) { emit({ kind: 'error', text: `启动 ${label} 失败：${error.message}` }); return finish(1); }
  if (shouldWatch({ platform: process.platform, interactive, policy: settings.watchWindow, takeover: viewerTakesOver(home) })) openWatch(paths.name, paths.progress, label);
  return await new Promise(resolve => {
    let child;
    try {
      child = spawn(command.executable, command.args, { cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch (error) { emit({ kind: 'error', text: `启动 ${label} 失败：${error.message}` }); resolve(finish(1)); return; }
    registry({ event: 'spawned', id, codexPid: child.pid ?? null, agentPid: child.pid ?? null, at: Date.now() });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    createInterface({ input: child.stdout }).on('line', line => {
      const at = Date.now();
      let event;
      try { event = JSON.parse(line); } catch { /* 非 JSON 行仍保留原文。 */ }
      appendFileSync(paths.raw, `${event && typeof event === 'object' && !Array.isArray(event) ? JSON.stringify({ ...event, _at: at }) : line}\n`);
      for (const mapped of mapLine(line, { root })) emit(mapped, at);
    });
    // 保留旧行为：stderr 原样存入 raw，不当成 stdout 的事件流。
    let stderr = '';
    child.stderr.on('data', chunk => { appendFileSync(paths.raw, chunk); stderr = (stderr + chunk).slice(-4096); });
    let failed = false;
    child.on('error', error => { failed = true; emit({ kind: 'error', text: `启动 ${label} 失败：${error.message}` }); });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') emit({ kind: 'error', text: error.message });
    });
    let stopping = false;
    // 门禁进行中当前验收命令的 pid；没有门禁命令在跑时是 null（回调见 runCommand / runGate 的 onSpawn）。
    let gatePid = null;
    const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];
    const handlers = signals.map(signal => {
      const handler = async () => {
        if (stopping) return;
        stopping = true;
        // 门禁进行中要结束的是当前验收命令的进程树，不是已经结束的执行者（协议 12.1 第 8 条约定）。
        const target = gatePid ?? child.pid;
        try { if (target) await killProcessTree(target); }
        catch { /* 结束失败仍记录中断并退出，平台函数有总时限。 */ }
        finally {
          try { appendFileSync(paths.progress, `\n=== 派发脚本收到 ${signal}，被外部中断 ===\n`); } catch { /* 不阻塞退出。 */ }
          registry({ event: 'interrupted', id, signal, at: Date.now() });
          process.exit(1);
        }
      };
      process.on(signal, handler);
      return [signal, handler];
    });
    child.stdin.end(command.stdin, 'utf8');
    // close 在 stdout/stderr 完全排空后触发，避免 exit 提前丢掉最后的汇报事件。
    child.on('close', async code => {
      if (stopping) return;
      // 干活方启动即退出时，原因往往只在 stderr 里（例如 Codex 拒绝在非 git 目录运行），补成出错事件。
      if (!failed && code !== 0) {
        const tail = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-5).join('\n');
        if (tail) emit({ kind: 'error', text: tail });
        // 失败原因可能只在 stderr，也可能在执行者自己的出错事件里（如接口返回 401）：两处一起交给适配器判断。
        const hint = adapter.failureHint?.([stderr, ...errors].join('\n'), { profile });
        if (hint) emit({ kind: 'error', text: hint });
      }
      const agentCode = failed ? 1 : code;
      let exitCode = agentCode, gate = null;
      // 执行者以 0 结束且启用门禁：跑门禁，end.exit 由门禁结果决定（协议 12.1、13）。
      if (!failed && agentCode === 0 && gateInfo?.enabled) {
        registry({ event: 'gating', id, at: Date.now() });
        progress(`门禁开始：检查提交与改动范围，运行 ${gateInfo.merged.verify.length} 条验收命令`);
        try {
          gate = await runGate({
            root, base: gateInfo.base, spec: gateInfo.merged, env,
            // 去掉当前执行者配置 secrets 里的键与来源变量名（协议 12.2）。
            dropEnv: Object.entries(profile.secrets ?? {}).flatMap(([key, value]) => [key, value]),
            dir: paths.dir, attempt: 1,
            onSpawn: pid => {
              gatePid = pid;
              // 停止信号已经到达时，刚启动的命令立即结束（门禁循环随后由进程退出结束）。
              if (stopping && pid) killProcessTree(pid).catch(() => {});
            },
          });
        } catch (error) {
          // 门禁自身出错（如 gate.json 写不进去）：按未通过处理，仍写 gate 事件与 end。
          gate = { ok: false, attempt: 1, at: Date.now(), summary: `门禁运行失败：${error.message}` };
          emit({ kind: 'error', text: gate.summary });
        }
        for (const item of gate.commands ?? []) {
          const status = item.timedOut ? '超时'
            : item.error != null ? item.error
              : item.exit === 0 ? '通过' : `exit ${item.exit}`;
          progress(`门禁命令：${item.line} → ${status}（${(item.ms / 1000).toFixed(1)} 秒）`);
        }
        progress(gate.summary);
        exitCode = gate.ok ? 0 : 3;
      }
      // 门禁进行中收到停止信号：信号处理器会写 interrupted 并以 1 退出，这里不再写 end。
      if (stopping) return;
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(finish(exitCode, { gate, agentExit: agentCode }));
    });
  });
}

// 项目配置：<项目根>/.agent-router/project.json；不存在、读不了或不是对象都当 {}（协议 11.3）。
function readProjectConfig(root) {
  try {
    const value = JSON.parse(readFileSync(join(root, '.agent-router', 'project.json'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// 用任务说明派发时的派发前准备（协议 11.1～11.4）：
// 解析 frontmatter → 校验 → 与项目配置合并；启用门禁时再做检查并取 base。不通过时抛出，调用方按派发错误（退出码 2）处理。
// 返回 { warnings, gate: { enabled, base, merged } }；merged 只含门禁用到的字段，随托管 / 脱离请求带给执行者进程。
function prepareSpecGate(root, specPath) {
  let text;
  try { text = readFileSync(resolvePath(root, specPath), 'utf8'); }
  catch (error) { throw new Error(`读不到任务说明 ${specPath}：${error.message}`); }
  const parsed = parseSpec(text, specPath);
  const spec = validateSpec(parsed, specPath);
  const merged = mergeSpec(spec, readProjectConfig(root));
  const fields = {
    allowed_paths: merged.allowed_paths,
    verify: merged.verify,
    expect_commit: merged.expect_commit,
    verify_timeout_min: merged.verify_timeout_min,
  };
  if (!merged.gate) return { warnings: parsed.warnings, gate: { enabled: false, base: null, merged: fields } };
  return { warnings: parsed.warnings, gate: { enabled: true, base: requireGateBase(root, specPath), merged: fields } };
}

// 启用门禁时的派发前检查（协议 11.4），返回 base。检查顺序与协议一致；任何一项不通过都抛出中文原因。
function requireGateBase(root, specPath) {
  // 1. 项目是 git 仓库且至少有一个提交。
  let base;
  try { base = headSha(root); }
  catch (error) { throw new Error(`启用门禁的任务需要 git 仓库：${error.message}`); }
  // TODO(lead): 协议 11.4 第 1 条没给固定文案，暂时用这句话。
  if (!base) throw new Error('启用门禁的任务需要项目至少有一个提交：先提交一次再派发。');
  // 2. 任务说明已提交（不是未跟踪、也没有未提交的修改）。
  const rel = relative(root, resolvePath(root, specPath)).replaceAll('\\', '/');
  const inside = !!rel && !rel.startsWith('../') && !isAbsolute(rel);
  const shown = inside ? rel : specPath;
  const notCommitted = () => new Error(`任务说明还没有提交：${shown}。启用门禁的任务要先提交任务说明，再派发。`);
  if (!inside) throw notCommitted();
  const tracked = git(root, ['ls-files', '--error-unmatch', '--', rel]);
  if (tracked.status === null) throw new Error(`无法检查任务说明是否已提交：${tracked.stderr.trim() || 'git 无法运行'}`);
  const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', rel]);
  if (status.status !== 0) throw new Error(`无法检查任务说明是否已提交：${status.stderr.trim() || `git status 退出码 ${status.status}`}`);
  if (tracked.status !== 0 || parseStatusPorcelainZ(status.stdout).length) throw notCommitted();
  // 3. 工作区干净（.agent-runs/ 除外），列出前 5 个文件。
  let uncommitted;
  try { uncommitted = uncommittedFiles(root); }
  catch (error) { throw new Error(`无法检查工作区是否干净：${error.message}`); }
  if (uncommitted.length) {
    throw new Error(`工作区有没提交的改动：${uncommitted.slice(0, 5).join('、')}。启用门禁的任务要从干净的基线开始：先提交或暂存这些改动，再派发。`);
  }
  return base;
}

// 托管/脱离请求里的执行者配置快照：只带列出的非密钥字段（secrets 只有变量名），执行者进程据此重现派发时的 profile。
// 公共字段之外，适配器可以用 snapshotKeys 声明还要带哪些字段（例如 fake 的回放说明）；price、enabled 等无关字段不带。
export function profileConfig(profile = {}, adapter = null) {
  const extra = Object.fromEntries((adapter?.snapshotKeys ?? []).filter(key => profile[key] !== undefined).map(key => [key, profile[key]]));
  return { env: profile.env ?? {}, secrets: profile.secrets ?? {}, auth: profile.auth ?? null, maxTurns: profile.maxTurns ?? null, label: profile.label ?? null,
    adapter: profile.adapter ?? adapter?.id ?? null, path: profile.path ?? null, ...extra };
}
