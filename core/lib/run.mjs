import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, readFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { basename, relative, join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline';
import { homeDirectory, loadConfig } from './config.mjs';
import { dispatcher, parseArgs, taskDetails } from './options.mjs';
import { recordPaths, registryWriter, writeDispatch } from './records.mjs';
import { clip, formatProgress, progressFooter, progressHeader } from './progress.mjs';
import { openWatch, shouldWatch, viewerTakesOver } from './watch.mjs';
import { acceptsManaged, viewerApp, managedEnvironment, validRequest, existingPaths, handoff, fallbackMessage, managedMessage } from './managed.mjs';
import { printCompletion } from './completion.mjs';
import { killProcessTree } from './process.mjs';
import { dryRun as dryRunEnv, testStartTimeout } from './compat.mjs';
import { adapterFor } from '../adapters/index.mjs';
import { buildEnv, allowedEnv, secretSources } from './env.mjs';

export async function run({ adapter: adapterOverride, scriptPath, args = process.argv.slice(2), env = process.env, root = process.cwd(), onDetach } = {}) {
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
  if (request) progress(managedMessage(request.app));
  const id = request?.id ?? `${paths.name}-${started}-${process.pid}`;
  const source = request?.dispatcher ?? dispatcher(parsed.opts.host, env);
  if (!request && parsed.opts.detach) {
    // 脱离派发：占好记录名、选好执行者之后，直接写成"已认领"请求并交给独立进程运行，不握手、不等待、不弹进度窗口。
    // 执行者进程沿用 --run-request 流程，所以停止、等待、看板显示与托管任务完全一致。
    const detachRequest = { v: 1, id, app: 'AgentRouter', at: started, script: scriptPath, node: process.execPath, repo: root, name: paths.name, profile: profileName, adapter: adapter.id,
      args: { task: parsed.task, extra: parsed.extra, role: parsed.opts.role ?? null, spec: details.spec },
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
      args: { task: parsed.task, extra: parsed.extra, role: parsed.opts.role ?? null, spec: details.spec },
      settings: Object.fromEntries(['model','effort','tier','sandbox','path'].map(key => [key, settings[key]])), dispatcher: source, env: managedEnvironment(env),
      // 执行者配置快照：只有非密钥部分（secrets 只是变量名），密钥由托管执行者启动时自己解析。
      profileConfig: profileConfig(profile, adapter) }, announce,
      { startTimeout: testStartTimeout(env) ?? 15000 });
    if ('exit' in result) {
      return printCompletion(result.exit, paths);
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
  const finish = code => {
    // 不自己写汇报文件的执行者：由适配器决定汇报正文（如 Claude Code 的 result），默认最后一条说话；都没有就不写。
    if (!adapter.writesReport) {
      const text = adapter.finish ? adapter.finish({ lastSay, result: mapLine.lastResult ?? null }) : lastSay;
      if (text != null) writeFileSync(paths.report, text);
    }
    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    appendFileSync(paths.progress, progressFooter(code, minutes, paths.report, label));
    registry({ event: 'end', id, exit: code, at: Date.now(), minutes: Number(minutes) });
    // 后台派发时进度不打印到标准输出；失败原因放在退出码前面，派活方不用翻日志就能看到。
    if (code !== 0 && !interactive) for (const text of errors) console.log(`出错：${clip(text)}`);
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
    const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];
    const handlers = signals.map(signal => {
      const handler = async () => {
        if (stopping) return;
        stopping = true;
        try { if (child.pid) await killProcessTree(child.pid); }
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
    child.on('close', code => {
      if (stopping) return;
      for (const [signal, handler] of handlers) process.off(signal, handler);
      // 干活方启动即退出时，原因往往只在 stderr 里（例如 Codex 拒绝在非 git 目录运行），补成出错事件。
      if (!failed && code !== 0) {
        const tail = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-5).join('\n');
        if (tail) emit({ kind: 'error', text: tail });
        // 失败原因可能只在 stderr，也可能在执行者自己的出错事件里（如接口返回 401）：两处一起交给适配器判断。
        const hint = adapter.failureHint?.([stderr, ...errors].join('\n'), { profile });
        if (hint) emit({ kind: 'error', text: hint });
      }
      resolve(finish(failed ? 1 : code));
    });
  });
}

// 托管/脱离请求里的执行者配置快照：只带列出的非密钥字段（secrets 只有变量名），执行者进程据此重现派发时的 profile。
// 公共字段之外，适配器可以用 snapshotKeys 声明还要带哪些字段（例如 fake 的回放说明）；price、enabled 等无关字段不带。
export function profileConfig(profile = {}, adapter = null) {
  const extra = Object.fromEntries((adapter?.snapshotKeys ?? []).filter(key => profile[key] !== undefined).map(key => [key, profile[key]]));
  return { env: profile.env ?? {}, secrets: profile.secrets ?? {}, auth: profile.auth ?? null, maxTurns: profile.maxTurns ?? null, label: profile.label ?? null,
    adapter: profile.adapter ?? adapter?.id ?? null, path: profile.path ?? null, ...extra };
}
