import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, writeFileSync, readFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { basename, isAbsolute, relative, join, resolve as resolvePath } from 'node:path';
import { homeDirectory, loadConfig, resolveSettings, selectProfile, settingSourcesOf } from './config.mjs';
import { READ_ONLY_TYPES, effortOptionsFor, effortRefusal, route, strongStatus, supportsEffort, supportsReadOnly } from './router.mjs';
import { dispatcher, parseArgs, taskDetails } from './options.mjs';
import { recordPaths, registryWriter, writeDispatch, readDispatch, taskPaths, attemptPaths, explicitOptions, retryOptions, SHARED_OPTIONS, DISPATCH_OPTIONS } from './records.mjs';
import { progressHeader } from './progress.mjs';
import { acceptsManaged, viewerApp, managedEnvironment, validRequest, existingPaths, handoff, fallbackMessage, managedMessage } from './managed.mjs';
import { printCompletion } from './completion.mjs';
import { dryRun as dryRunEnv, testStartTimeout, homeEnv, unsafeHome, legacyHomeDirectory } from './compat.mjs';
import { locateStart, findTerminal, reverseRows, worktreeOutcome } from './wait.mjs';
import { adapterFor, resolveProfile } from '../adapters/index.mjs';
import { buildEnv, allowedEnv, secretSources, ensureSandboxHome, withProxy } from './env.mjs';
import { proxyRecord } from './proxy.mjs';
import { parseSpec, validateSpec, mergeSpec } from './spec.mjs';
import { git, headSha, parseStatusPorcelainZ, uncommittedFiles, requireModernGit } from './git.mjs';
import { pipeline } from './pipeline.mjs';
import { taskBaseBranch } from './status.mjs';
import { requireSpecAt, resolveBase, specRelative, worktreeEnabled } from './worktree.mjs';
import { readJson } from './json.mjs';
import { redactPaths } from './process.mjs';
import { tracing } from './trace.mjs';
import { checkDispatch, recordProcessGone } from './stop.mjs';

// 托管执行者进程脱离启动、标准错误没人看：认领请求文件失败时留一行痕迹（只记文件名）。写日志失败一律吞掉。
function claimFailure(env, reason, requestFile) {
  try {
    const dir = join(homeDirectory(env), 'managed');
    mkdirSync(dir, { recursive: true });
    const d = new Date(), p = (n, w = 2) => String(n).padStart(w, '0');
    const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    appendFileSync(join(dir, 'claim-failures.log'), `${time}\t${reason}\t${basename(String(requestFile))}\n`);
  } catch { /* 留痕失败不影响返回值 */ }
}

export async function run({ adapter: adapterOverride, scriptPath, args = process.argv.slice(2), env = process.env, root = process.cwd(), onDetach, onGate, onRetry, retry = null, inheritRoute = null } = {}) {
  // 公共目录保护（协议第 1 节）：必须在改名请求文件、读写公共目录、启动进程之前检查。
  // 只检查显式设置的新名 / 旧名环境变量；--run-request 执行者进程也走这里。
  if (homeEnv.some(key => env[key])) {
    const reason = unsafeHome(homeDirectory(env), { env });
    if (reason) throw Object.assign(new Error(reason), { arCode: 'UNSAFE_HOME' });
  }
  // 只负责派发与托管执行者入口；wait / stop / config 等子命令在 cli.mjs。
  let requestFile = args[0] === '--run-request' ? args[1] : null;
  if (requestFile) {
    if (!requestFile.endsWith('.claimed.json')) { claimFailure(env, '不是 .claimed.json', requestFile); return 0; }
    const running = requestFile.replace(/\.claimed\.json$/, '.running.json');
    try { renameSync(requestFile, running); } catch (error) { claimFailure(env, `改名失败：${error?.code ?? 'UNKNOWN'}`, requestFile); return 0; }
    requestFile = running;
  }
  const request = requestFile ? readJson(requestFile) : null;
  if (request && !validRequest(request)) throw Error('请求文件无效');
  if (request) root = request.repo;
  // 手动重试（协议 14.3，任务 059）：前台由 cli.mjs 传进 retry；--detach 的执行者进程
  //（--run-request）从请求里的 retry 字段认出后继续。只有前台与脱离两种走法（不做托管交接），
  // 提前分流，下面的派发流程不受影响。不通过时 prepareRetry 抛错，按派发错误退出码 2 处理。
  const retryOpts = retry
    ? { name: retry.name, profile: retry.profile ?? null, note: retry.note ?? null, detach: retry.detach === true, host: retry.host ?? null, n: Number.isSafeInteger(retry.n) ? retry.n : null, rebase: retry.rebase === true, rebaseBase: null, afterMerge: afterMergeOf(retry.afterMerge) }
    : request?.retry
      ? { name: request.name, profile: request.retry.profile ?? request.profile ?? null, note: request.retry.note ?? null, detach: false, host: null, n: Number.isSafeInteger(request.retry.n) ? request.retry.n : null,
        rebase: request.retry.rebase === true, rebaseBase: /^[0-9a-f]{40,64}$/.test(request.retry.rebaseBase ?? '') ? request.retry.rebaseBase : null, afterMerge: afterMergeOf(request.retry.afterMerge) }
      : null;
  if (retryOpts) return runRetry({ adapterOverride, scriptPath, env, root, request, opts: retryOpts, onDetach, onGate, onRetry });
  // --no-worktree（协议 15.1）只在派发命令行上出现；先取走，parseArgs 不认识它。
  // --base <分支>（Stage07c 136）同样只在派发命令行上出现：这一次派发的基线分支，不改项目配置。
  const { args: noWorktreeArgs, noWorktree } = takeNoWorktree(args);
  const { args: dispatchArgs, baseBranch: baseArg } = takeBase(noWorktreeArgs);
  const parsed = request ? { task: request.args.task, extra: request.args.extra, opts: { name: request.name, ...(request.args.role ? { role: request.args.role } : {}) } } : parseArgs(dispatchArgs);
  const details = taskDetails(root, parsed);
  // 实际用的角色（默认加上的也记；--role none 记 none），供 dispatch.json 与托管请求。
  const roleRecord = details.roleKey ?? (details.roleNone ? 'none' : null);
  const dryRun = !request && dryRunEnv(env);
  const started = Date.now();
  // dry-run 在读取配置、检测 agent、创建目录之前返回。
  if (dryRun) {
    console.log(`记录名：${recordPaths(root, details.name, '', true).name}\n----\n${details.prompt}`);
    return 0;
  }
  // 这次派发指定的基线分支：前台 / 脱离派发的派发进程取命令行的；托管 / 脱离的执行者进程取派发进程写好的 dispatch.json。
  const savedBase = request ? readDispatch(root, request.name)?.baseBranch : null;
  const baseOverride = request ? (typeof savedBase === 'string' && savedBase !== '' ? savedBase : null) : baseArg;
  if (!request && baseOverride !== null && !worktreeEnabled({ spec: details.spec, projectConfig: readProjectConfig(root), noWorktree })) {
    throw new Error('--base 只用于 worktree 模式的任务（用任务说明派发、项目开启 worktree）');
  }
  const home = homeDirectory(env);
  const registry = registryWriter(home);
  // 先选执行者再占记录名：进度首行写执行者名；配置出错时不留下空记录。托管执行者用请求里的快照。
  // 前台 / 脱离派发的派发进程经路由器选执行者（--profile 与 AR_PROFILE 最先生效）；ar retry / ar redispatch 沿用原任务的执行者（redispatch 带 --profile），不重新路由。
  const loaded = request
    ? { settings: { ...request.settings, watchWindow: 'never' }, warning: null, config: {}, profileName: request.profile ?? 'codex', profile: { adapter: request.adapter ?? 'codex', ...(request.profileConfig ?? {}) } }
    : loadConfig(home, parsed.opts, env, { choose: routeChooser({ root, home, details, opts: parsed.opts, env }) });
  const { warning, config, profileName, route: routed } = loaded;
  // settings 在读完任务说明后可能被任务说明 / 路由规则的 model、effort 改写（见下面的 layerSettings），所以是 let。
  let settings = loaded.settings;
  // 网络代理（Stage07 099）：派发进程在这里读一次（dispatch.json 要记模式与是否生效，也给下面的执行者环境用）；
  // 托管 / 脱离的执行者进程在启动执行者前自己读（那时才是启动的这一刻）。
  const proxyNow = request ? null : withProxy(env, home);
  // generic 执行者：声明在这里解析进执行者配置（之后随 profileConfig 进托管 / 脱离请求）；声明有问题时适配器的 command 失败，不启动、不重试。
  const profile = resolveProfile(loaded.profile, config);
  const adapter = adapterOverride ?? adapterFor(profile, { config, tolerant: true });
  const label = profile.label ?? adapter.label ?? adapter.id;
  // 写进 dispatch.json 与进度的路由记录。ar redispatch 沿用原任务的记录（执行者没有重新路由），其余用这次路由的结果。
  const inherited = inheritRoute && inheritRoute.profile === profileName && Array.isArray(inheritRoute.trace) && inheritRoute.trace.length ? inheritRoute : null;
  // 命中的规则写了 effort 才多一个 effort 键（没写时与以前逐字相同）。
  const routeRecord = !request && details.spec ? (inherited ?? { profile: profileName, rule: routed.rule, trace: routed.trace, ...(routed.effort ? { effort: routed.effort } : {}) }) : null;
  // 升级目标（协议 14.1）：执行者配置的 escalate 指向另一个配置名，只在最后一次自动重试换用它。
  // 前台派发从 config.profiles 找目标（缺失或未启用记 null，进度行由 pipeline 写）；
  // 托管 / 脱离执行者进程用请求里的快照（非密钥部分，同 profileConfig；shape: { profile, config }）。
  const escalateName = request
    ? (request.escalate && typeof request.escalate === 'object' && typeof request.escalate.profile === 'string' && request.escalate.profile !== '' ? request.escalate.profile : null)
    : (routed?.escalate ?? null);
  const escalateTarget = request
    ? (request.escalate?.config && typeof request.escalate.config === 'object'
      ? { adapter: request.escalate.config.adapter ?? request.adapter ?? 'codex', ...request.escalate.config } : null)
    : (config.profiles?.[escalateName] && config.profiles[escalateName].enabled !== false ? resolveProfile(config.profiles[escalateName], config) : null);
  const escalate = escalateName ? { name: escalateName, profile: escalateTarget } : null;
  // 请求里的升级快照：形状同 profileConfig（非密钥部分）；目标缺失 / 未启用 / 取不出快照时 config 为 null，
  // 执行者进程据此同样不升级。不含任何密钥值。
  const escalateRequest = escalate
    ? { profile: escalate.name, config: (() => { try { return escalate.profile ? profileConfig(escalate.profile, adapterFor(escalate.profile, { config, tolerant: true })) : null; } catch { return null; } })() }
    : null;
  // 默认升级链（Stage07c T8）：强执行者（全局 routing.strongExecutor）与这个执行者的推理强度档位，只在自动重试里用。
  // 前台派发从配置取；托管 / 脱离的执行者进程用请求里的快照（形状同 escalate，目标不存在 / 已停用时 config 为 null、why 写原因）。
  const strong = request ? strongFromRequest(request) : strongTarget(config);
  const strongRequest = strong
    ? { profile: strong.name, config: (() => { try { return strong.profile ? profileConfig(strong.profile, adapterFor(strong.profile, { config, tolerant: true })) : null; } catch { return null; } })(), ...(strong.why ? { why: strong.why } : {}) }
    : null;
  const effortOptions = request
    ? (Array.isArray(request.effortOptions) ? request.effortOptions.filter(item => typeof item === 'string') : null)
    : effortOptionsFor(profileName, profile, config);
  // 用任务说明派发：解析 frontmatter、合并项目配置；启用门禁时先做派发前检查（协议 11.1～11.4）。
  // 全部在占记录名之前完成，失败时不留下空记录；托管 / 脱离派发的执行者进程直接用请求里的快照。
  // worktree 模式（协议 15.1）：{ base }，非 worktree 模式为 null。前台 / 脱离派发的派发进程算好基线并检查任务说明已提交在基线里；
  // 托管 / 脱离的执行者进程直接用请求里的 worktree.base，不再读项目配置判断。
  let wt = null;
  if (request) wt = request.worktree ? { base: request.worktree.base } : null;
  else if (worktreeEnabled({ spec: details.spec, projectConfig: readProjectConfig(root), noWorktree })) { requireModernGit('worktree'); wt = prepareWorktreeBase(root, details.spec, baseOverride); }
  let gateInfo = null, specWarnings = [], specSettings = null;
  if (request) gateInfo = request.args.gate ?? null;
  else if (details.spec) ({ gate: gateInfo, warnings: specWarnings, specSettings } = prepareSpecGate(root, details.spec, wt));
  // model / effort 的生效顺序（Stage07c T6）：命令行 > 环境变量 CODEX_* > 任务说明 > 命中的路由规则 > 执行者配置 > 内置默认。
  // 任务说明读完才知道它写了什么，所以在这里重新合并一次（命令行、环境变量、配置与 loadConfig 里那次完全相同）。
  // 每次派发都记 settingSources：model、effort 各自的来源（写进 dispatch.json 与 start，Stage07c 154、D81）；托管 / 脱离的执行者进程取派发进程写好的。
  // 所选执行者不支持推理强度（预设 supportsEffort: false，D87）：给出的强度一律忽略，来源记"已忽略"，进度写一行说明。
  let settingSources = null, effortNote = null;
  const effortSupported = request ? request.supportsEffort !== false : supportsEffort(profileName, profile, config);
  if (request) settingSources = readDispatch(root, request.name)?.settingSources ?? null;
  else {
    const layers = { spec: specSettings, rule: { effort: routeRecord?.effort } };
    const layered = resolveSettings(config, parsed.opts, env, profileName, layers);
    // 任务说明或路由规则给的推理强度不在执行者支持的范围里：派发前拒绝（命令行给的不校验）。
    const fromLayer = ['任务说明', '路由规则'].includes(layered.sources.effort) ? layered.sources.effort : null;
    const refusal = fromLayer && effortRefusal({ effort: layered.settings.effort, from: fromLayer, name: profileName, profile, config });
    if (refusal) throw new Error(refusal);
    const settled = settleEffort({ layered, supported: effortSupported, config, opts: parsed.opts, env, profileName, layers });
    settings = settled.settings;
    settingSources = settingSourcesOf(settled.sources);
    effortNote = settled.note;
  }
  // 调研 / 审查类任务只读运行（Stage07 105）：路由器会避开不支持只读的执行者，这里给 --profile 显式指定的情况兜底，派发前就拒绝。
  // 托管 / 脱离的执行者进程用请求里的快照，前台已经检查过。
  if (!request && gateInfo?.readOnly === true && !supportsReadOnly(profile, config)) throw new Error(`${label} 不支持只读任务`);
  // 自动重试次数（协议 14.1）：只有用任务说明派发的任务（gateInfo 非空）重试，总次数 1 + max_retries；
  // 直接写任务文字派发的任务 maxRetries 为 0（总次数 1）。任务说明与项目配置的合并已在 merged.max_retries 里。
  const mergedRetries = Number.isSafeInteger(gateInfo?.merged?.max_retries) && gateInfo.merged.max_retries >= 0
    ? gateInfo.merged.max_retries : undefined;
  const maxRetries = gateInfo ? (mergedRetries ?? 2) : 0;
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
    role: roleRecord,
    ...(details.roleDefault ? { roleDefault: true } : {}),
    spec: details.spec ? relative(root, resolvePath(root, details.spec)).replaceAll('\\', '/') : null,
    profile: profileName,
    name: paths.name,
    // 路由结果：选了谁、命中哪条规则、为什么（trace 每行一句中文）。只有用任务说明派发的任务记；直接写任务文字的没有这个字段。
    ...(routeRecord ? { route: routeRecord } : {}),
    // 命令行明确给出的 model / effort / tier / sandbox / watchWindow（067），一个都没给就没有这个字段。
    ...(explicitOptions(parsed.opts) ? { options: explicitOptions(parsed.opts) } : {}),
    // 每次派发都记 model / effort 各自的来源（Stage07c T6、D81），命令行 / 环境变量 / 配置来源也照记。
    ...(settingSources ? { settingSources } : {}),
    // 用任务说明派发的另记门禁设置与基线（协议第 3 节，Stage05），供 ar retry；直接任务文字派发没有这个字段。
    ...(gateInfo ? { gate: gateInfo } : {}),
    // 只读运行（调研 / 审查类任务）才记 readOnly: true；可写任务没有这个字段。
    ...(gateInfo?.readOnly === true ? { readOnly: true } : {}),
    // worktree 模式与 --no-worktree 各记一笔，供 ar redispatch 沿用原任务的模式（协议 15.1）；其余任务没有这两个字段。
    ...(wt ? { worktree: true } : {}),
    ...(noWorktree ? { noWorktree: true } : {}),
    // 这次派发用 --base 指定的基线分支（136）；放在顶层、不放进 options，没指定就没有这个字段。
    ...(baseOverride ? { baseBranch: baseOverride } : {}),
    // 网络代理只记模式与是否生效，不记地址（地址可能含内网信息）；没用代理（off）的任务没有这个字段。
    ...(proxyNow && proxyNow.proxy.mode !== 'off' ? { proxy: proxyRecord(proxyNow.proxy) } : {}),
  });
  const interactive = !!process.stdout.isTTY;
  const progress = (text, at = Date.now()) => {
    const line = `[${new Date(at).toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`;
    appendFileSync(paths.progress, `${line}\n`);
    if (interactive) console.log(line);
  };
  if (warning) { progress(warning); if (!interactive) console.log(warning); }
  if (routeRecord) progress(`路由：${routeRecord.trace.at(-1)}`);
  if (effortNote) { progress(effortNote); if (!interactive) console.log(effortNote); }
  // 适配器不支持的设置（claude-code 的 tier）只在前台派发时提示一次；托管 / 脱离的执行者进程不重复，自动重试在 pipeline 里也不重复。
  if (!request) for (const key of adapter.unsupportedSettings ?? []) if (settings[key] != null) {
    const line = `配置：${adapter.id} 执行者不支持 ${key}，已忽略`;
    progress(line);
    if (!interactive) console.log(line);
  }
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
      args: { task: parsed.task, extra: parsed.extra, role: roleRecord, spec: details.spec, ...(gateInfo ? { gate: gateInfo } : {}) },
      settings: Object.fromEntries(['model','effort','tier','sandbox','path'].map(key => [key, settings[key]])), dispatcher: source, env: managedEnvironment(env),
      profileConfig: profileConfig(profile, adapter), ...(escalateRequest ? { escalate: escalateRequest } : {}), ...(strongRequest ? { strong: strongRequest } : {}), ...(effortOptions ? { effortOptions } : {}), ...(effortSupported ? {} : { supportsEffort: false }), ...(wt ? { worktree: { base: wt.base } } : {}), detached: true };
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
      args: { task: parsed.task, extra: parsed.extra, role: roleRecord, spec: details.spec, ...(gateInfo ? { gate: gateInfo } : {}) },
      settings: Object.fromEntries(['model','effort','tier','sandbox','path'].map(key => [key, settings[key]])), dispatcher: source, env: managedEnvironment(env),
      // 执行者配置快照：只有非密钥部分（secrets 只是变量名），密钥由托管执行者启动时自己解析。
      profileConfig: profileConfig(profile, adapter), ...(escalateRequest ? { escalate: escalateRequest } : {}), ...(strongRequest ? { strong: strongRequest } : {}), ...(effortOptions ? { effortOptions } : {}), ...(effortSupported ? {} : { supportsEffort: false }), ...(wt ? { worktree: { base: wt.base } } : {}) }, announce,
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
  // 064：执行者的用户目录是沙箱（协议第 7 节）；启动前建好目录（建不了就用系统临时目录里的一次性目录）。
  // 099：基础环境先加上网络代理变量，再经过白名单。
  const { base: envBase, proxy } = proxyNow ?? withProxy(env, home);
  try { childEnv = buildEnv({ base: envBase, profile, adapter, home, profileName, sources }); ensureSandboxHome(childEnv, { home, profileName }); }
  catch (error) { envError = error; childEnv = allowedEnv({ base: envBase, adapter, home, profileName, sources }); }
  const detection = await adapter.detect({ env: childEnv, settings, profile });
  // 路由说明（trace 最后一句）也记进 start，界面的进展 / 参数标签读它。托管 / 脱离的执行者进程自己没有路由结果，从派发进程写好的 dispatch.json 取。
  const savedRoute = request ? readDispatch(root, paths.name)?.route : routeRecord;
  const routeLine = Array.isArray(savedRoute?.trace) && typeof savedRoute.trace.at(-1) === 'string' ? savedRoute.trace.at(-1) : null;
  registry({ event: 'start', v: 2, id, repo: root, name: paths.name, dir: paths.dir, project: basename(root), profile: profileName, adapter: adapter.id, label, spec: details.spec ? relative(root, resolvePath(root, details.spec)).replaceAll('\\', '/') : null,
    title: details.title, role: details.role?.name ?? null, pid: process.pid, started,
    progress: paths.progress, report: paths.report, raw: paths.raw, model: settings.model ?? adapter.modelName?.({ settings, profile }) ?? null, effort: settings.effort, tier: settings.tier,
    agent: adapter.id, agentVersion: detection.version, sandbox: settings.sandbox, events: paths.events,
    dispatcher: source, ...(request ? { managed: true } : {}),
    // 用任务说明派发的任务记是否启用门禁；启用时记派发时的 HEAD（协议第 2 节、11.4）。其他任务没有这两个字段。
    ...(gateInfo ? { gate: gateInfo.enabled, ...(gateInfo.enabled ? { base: gateInfo.base } : {}) } : {}),
    ...(gateInfo?.readOnly === true ? { readOnly: true } : {}),
    ...(routeLine ? { route: routeLine } : {}),
    ...(settingSources ? { settingSources } : {}),
    // worktree 模式另记 worktree: true 与基线（没启用门禁时基线也记，协议 15.1、15.2）。
    ...(wt ? { worktree: true, base: wt.base } : {}),
    // 用 --base 指定了基线分支才记；验收、撤销、重新基线、链路报告、ar status 都从这里取（136）。
    ...(baseOverride ? { baseBranch: baseOverride } : {}),
  });
  // 一次运行的编排（多次尝试的循环 → 门禁 → 收尾）在 pipeline.mjs，单次执行在 runner.mjs。
  return pipeline({
    root, paths, id, registry, progress, started, interactive, home,
    adapter, label, profile, settings, detection, childEnv, envError, env, proxy,
    prompt: details.prompt, gateInfo, onGate, taskTitle: details.title, taskSpec: details.spec,
    profileName, maxRetries, escalate, strong, effortOptions, effortSupported, settingSources, sources,
    ...(wt ? { worktree: { base: wt.base, setup: setupCommands(root), dir: null } } : {}),
  });
}

// 合并后的自动重跑门禁（Stage07c 154，D86）：{ id, name } 是刚合并的那个任务；只有 --rebase 的重试才带，形状不对当没有。
function afterMergeOf(value) {
  return value && typeof value === 'object' && typeof value.id === 'string' && value.id !== '' && typeof value.name === 'string' && value.name !== ''
    ? { id: value.id, name: value.name } : null;
}

// 所选执行者不支持推理强度（预设 supportsEffort: false，Stage07c 154、D87）：命令行、环境变量、任务说明、路由规则给的强度都不传给执行者，
// 退回没有这些层时的取值（执行者配置 / 内置默认），来源记"已忽略"。不拒绝派发。
// layered：resolveSettings 带上各层的结果；返回 { settings, sources, note }，note 是进度里的一行（没有忽略任何值时为 null）。
function settleEffort({ layered, supported, config, opts, env, profileName, layers }) {
  const from = layered.sources.effort;
  const given = from === '命令行' || from === '任务说明' || from === '路由规则' || String(from).startsWith('环境变量');
  if (supported || !given) return { settings: layered.settings, sources: layered.sources, note: null };
  const base = resolveSettings(config, { ...opts, effort: undefined }, { ...env, CODEX_EFFORT: undefined }, profileName,
    { spec: layers?.spec ? { ...layers.spec, effort: undefined } : undefined, rule: {} });
  return {
    settings: { ...layered.settings, effort: base.settings.effort },
    sources: { ...layered.sources, effort: '已忽略' },
    note: `这个执行者不支持推理强度，已忽略（${layered.settings.effort}，来自${from}）`,
  };
}

// 强执行者（默认升级链）：从配置取。没设返回 null；设了但不存在 / 已停用返回 { name, profile: null, why }。
function strongTarget(config) {
  const status = strongStatus(config);
  if (!status.name) return null;
  if (status.why) return { name: status.name, profile: null, why: status.why };
  try { return { name: status.name, profile: resolveProfile(config.profiles[status.name], config), why: null }; }
  catch { return { name: status.name, profile: null, why: '配置有误' }; }
}

// 托管 / 脱离的执行者进程：从请求里的快照还原强执行者（请求里没有 strong 就是没设）。
function strongFromRequest(request) {
  const snapshot = request.strong;
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.profile !== 'string' || snapshot.profile === '') return null;
  const target = snapshot.config && typeof snapshot.config === 'object' ? { adapter: snapshot.config.adapter ?? request.adapter ?? 'codex', ...snapshot.config } : null;
  return { name: snapshot.profile, profile: target, why: target ? null : (typeof snapshot.why === 'string' && snapshot.why ? snapshot.why : '不可用') };
}

// --no-worktree 开关（协议 15.1）：取走 `--` 之前的 --no-worktree，返回剩下的参数。
function takeNoWorktree(args) {
  const stop = args.indexOf('--');
  const head = stop === -1 ? args : args.slice(0, stop);
  if (!head.includes('--no-worktree')) return { args, noWorktree: false };
  return { args: [...head.filter(arg => arg !== '--no-worktree'), ...(stop === -1 ? [] : args.slice(stop))], noWorktree: true };
}

// 准备命令（协议 15.4）：项目配置 setup，只认字符串项；没有或不是数组时为空。
function setupCommands(root) {
  const list = readProjectConfig(root).setup;
  return Array.isArray(list) ? list.filter(item => typeof item === 'string' && item.trim() !== '') : [];
}

// worktree 模式的派发前检查（协议 15.2）：基线 = 项目配置主分支当前指向的提交；任务说明必须已提交在基线里，
// 否则拒绝（退出码 2）。不要求主工作区干净，也不看主工作区检出的是哪个分支。
// override：这次派发用 --base 指定的分支（136），给了就以它为基线，必须是本地分支；不给用项目配置的 baseBranch。
function prepareWorktreeBase(root, specPath, override = null) {
  const baseBranch = taskBaseBranch({ baseBranch: override }, readProjectConfig(root).baseBranch);
  if (override !== null) {
    const checked = override.startsWith('-') ? null : git(root, ['check-ref-format', '--branch', override]);
    if (!checked || checked.status !== 0 || checked.stdout.trim() !== override) throw new Error(`--base 的分支名无效：${override}`);
  }
  const base = resolveBase(root, baseBranch);
  if (override !== null && git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${override}`]).status !== 0) throw new Error(`--base 要写本地分支名：找不到本地分支 ${override}`);
  requireSpecAt(root, base, baseBranch, specPath);
  return { base, baseBranch };
}

// --base <分支> 开关（136）：取走 `--` 之前的 --base 和它的值，返回剩下的参数；值缺失、为空或以 - 开头报用法错误。
function takeBase(args) {
  const stop = args.indexOf('--');
  const head = stop === -1 ? args : args.slice(0, stop);
  const at = head.indexOf('--base');
  if (at === -1) return { args, baseBranch: null };
  const value = head[at + 1];
  if (value === undefined || value === '' || value.startsWith('-')) throw new Error('--base 后面要写分支名（不能为空，也不能以 - 开头）：--base <分支>');
  return { args: [...head.slice(0, at), ...head.slice(at + 2), ...(stop === -1 ? [] : args.slice(stop))], baseBranch: value };
}

// 路由用的任务说明字段（type / worker / read_only）；读不了或解析不过就当没有（真正的错误由后面的派发前检查报出）。
export function readRouteSpec(root, specPath) {
  if (!specPath) return null;
  try {
    const spec = validateSpec(parseSpec(readFileSync(resolvePath(root, specPath), 'utf8'), specPath), specPath);
    return { type: spec.type, worker: spec.worker, read_only: spec.read_only };
  } catch { return null; }
}

// 派发时给 loadConfig 的选择函数：调用路由器，失败时补上 trace。
// 没有类型（直接写任务文字）且不是因为每日上限、只读限制而落空时，保留旧的选择错误文案（多个可用的执行者、没有可用的执行者等）。
function routeChooser({ root, home, details, opts, env }) {
  return config => {
    const spec = readRouteSpec(root, details.spec);
    try {
      const result = route({ spec, projectConfig: readProjectConfig(root), config, explicit: opts.profile ?? (env.AR_PROFILE || undefined), home });
      return { profileName: result.profile, profile: config.profiles[result.profile], route: result };
    } catch (error) {
      if (error.code === 'NO_PROFILE') {
        if (!spec?.type && !error.trace.some(line => /每日上限|不支持只读/.test(line))) selectProfile(config, {}, {});
        error.message = `${error.message}\n${error.trace.map(line => `  ${line}`).join('\n')}`;
      }
      throw error;
    }
  };
}

// 项目配置：<项目根>/.agent-router/project.json；不存在、读不了或不是对象都当 {}（协议 11.3）。
export function readProjectConfig(root) {
  try {
    const value = readJson(join(root, '.agent-router', 'project.json'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// 用任务说明派发时的派发前准备（协议 11.1～11.4）：
// 解析 frontmatter → 校验 → 与项目配置合并；启用门禁时再做检查并取 base。不通过时抛出，调用方按派发错误（退出码 2）处理。
// 返回 { warnings, gate: { enabled, base, merged } }；merged 只含门禁用到的字段，随托管 / 脱离请求带给执行者进程。
// 派发与手动重试的重新准备共用 readAndMergeSpec / gateFields（任务 059）。
// worktree 模式（wt = { base }）：任务说明取基线提交里的版本（执行者看到的就是它），基线就是门禁的 base，
// 不再检查主工作区的 HEAD 与是否干净（协议 15.2；第 11.4 节第 2、3 条只对非 worktree 模式）。
// 调研 / 审查类任务（readOnly）总是启用门禁（Stage07 105），好让它走完门禁和待验收；gate 里多记 readOnly: true，其余任务没有这个字段。
function prepareSpecGate(root, specPath, wt = null) {
  const { parsed, spec, merged } = readAndMergeSpec(root, specPath, wt?.base ?? null);
  const fields = gateFields(merged);
  const readOnly = needsReadOnly(spec);
  const specSettings = specLayer(spec);
  if (!merged.gate && !readOnly) return { warnings: parsed.warnings, specSettings, gate: { enabled: false, base: null, merged: fields } };
  return { warnings: parsed.warnings, specSettings, gate: { enabled: true, base: wt ? wt.base : requireGateBase(root, specPath), merged: fields, ...(readOnly ? { readOnly: true } : {}) } };
}

// 任务说明里的 model / effort（resolveSettings 的 spec 层）；都没写返回 null。
function specLayer(spec) {
  const layer = {};
  for (const key of ['model', 'effort']) if (typeof spec?.[key] === 'string' && spec[key] !== '') layer[key] = spec[key];
  return Object.keys(layer).length ? layer : null;
}

// 任务是否以只读模式运行：任务说明的 type 是 research / review，或写了 read_only: true。
// 与路由器的 needsReadOnly 同一条规则（router.mjs 的 route() 里是行内表达式，没有单独导出，这里复用它的 READ_ONLY_TYPES）。
export function needsReadOnly(spec) {
  return READ_ONLY_TYPES.includes(spec?.type) || spec?.read_only === true;
}

// 读取 → 解析 → 校验 → 与项目配置合并任务说明（协议 11.1～11.3；派发与手动重试共用）。
// revision 给了就读那个提交里的版本（worktree 模式），否则读工作区里的文件。
function readAndMergeSpec(root, specPath, revision = null) {
  let text;
  if (revision) {
    const rel = specRelative(root, specPath);
    const shown = rel ? git(root, ['show', `${revision}:${rel}`]) : null;
    if (!shown || shown.status !== 0) throw new Error(`读不到任务说明 ${specPath}：${shown?.stderr.trim() || '不在项目里'}`);
    text = shown.stdout;
  } else {
    try { text = readFileSync(resolvePath(root, specPath), 'utf8'); }
    catch (error) { throw new Error(`读不到任务说明 ${specPath}：${error.message}`); }
  }
  const parsed = parseSpec(text, specPath);
  const spec = validateSpec(parsed, specPath);
  return { parsed, spec, merged: mergeSpec(spec, readProjectConfig(root)) };
}

// 门禁交给执行流程 / 请求快照的字段（协议 11.3）。
function gateFields(merged) {
  return {
    allowed_paths: merged.allowed_paths,
    verify: merged.verify,
    expect_commit: merged.expect_commit,
    verify_timeout_min: merged.verify_timeout_min,
    // max_retries：随 merged 一起交给执行流程与托管 / 脱离请求（协议 14.1）。
    max_retries: merged.max_retries,
  };
}

// 与 git() 相同的调用，另外带回信号（git() 丢掉了它）；只给 requireGateBase 的失败明细用。
function gitWithSignal(root, args) {
  try {
    const child = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false, windowsHide: true });
    if (child.error) return { status: null, signal: null, stdout: '', stderr: child.error.message };
    return { status: child.status, signal: child.signal ?? null, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
  } catch (error) {
    return { status: null, signal: null, stdout: '', stderr: error.message };
  }
}

// 任务说明已提交（不是未跟踪、也没有未提交的修改）；不通过时抛出中文原因，返回相对项目根的路径。
// action 是被拒绝的动作（派发 / 重试），只用在错误文字里。派发前检查与手动重试共用。
function requireCommittedSpec(root, specPath, action) {
  const rel = relative(root, resolvePath(root, specPath)).replaceAll('\\', '/');
  const inside = !!rel && !rel.startsWith('../') && !isAbsolute(rel);
  const shown = inside ? rel : specPath;
  const notCommitted = () => new Error(`任务说明还没有提交：${shown}。启用门禁的任务要先提交任务说明，再${action}。`);
  if (!inside) {
    process.stderr.write(`[ar-gate 核对] 任务说明还没有提交：${redactPaths(shown)}；任务说明路径在仓库之外，没有运行 git 检查\n`);
    throw notCommitted();
  }
  const tracked = gitWithSignal(root, ['ls-files', '--error-unmatch', '--', rel]);
  if (tracked.status === null) throw new Error(`无法检查任务说明是否已提交：${tracked.stderr.trim() || 'git 无法运行'}`);
  const status = gitWithSignal(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', rel]);
  if (status.status !== 0) throw new Error(`无法检查任务说明是否已提交：${status.stderr.trim() || `git status 退出码 ${status.status}`}`);
  const dirty = tracked.status !== 0 || parseStatusPorcelainZ(status.stdout).length > 0;
  // 069 诊断（偶发的"任务说明还没有提交"没有现场）：失败路径（以及 AR_CORE_TRACE=1）在标准错误另写一行核对明细，返回给调用方的错误文字不变。
  if (dirty || tracing) {
    const part = (label, r) => {
      const clip = text => redactPaths(String(text ?? '').slice(0, 300)).replace(/\r?\n/g, '⏎').replace(/\0/g, '␀');
      return `${label}：退出码=${r.status}${r.signal ? ` 信号=${r.signal}` : ''} 标准错误前 300 字符="${clip(r.stderr)}" 输出前 300 字符="${clip(r.stdout)}"`;
    };
    process.stderr.write(`[ar-gate 核对] 任务说明${dirty ? '还没有提交' : '已提交（AR_CORE_TRACE=1）'}：${redactPaths(shown)}；${part('git ls-files --error-unmatch', tracked)}；${part('git status --porcelain', status)}\n`);
  }
  if (dirty) throw notCommitted();
  return rel;
}

// 启用门禁时的派发前检查（协议 11.4），返回 base。检查顺序与协议一致；任何一项不通过都抛出中文原因。
function requireGateBase(root, specPath) {
  // 1. 项目是 git 仓库且至少有一个提交。
  let base;
  try { base = headSha(root); }
  catch (error) { throw new Error(`启用门禁的任务需要 git 仓库：${error.message}`); }
  //（协议 11.4 第 1 条）
  if (!base) throw new Error('启用门禁的任务需要项目至少有一个提交：先提交一次再派发。');
  // 2. 任务说明已提交（不是未跟踪、也没有未提交的修改）。
  requireCommittedSpec(root, specPath, '派发');
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
    adapter: profile.adapter ?? adapter?.id ?? null, path: profile.path ?? null, ...(profile.autoCommit === true ? { autoCommit: true } : {}), ...extra };
}

// ===== 手动重试（协议 14.3，任务 059）=====
// 前台：cli.mjs 解析 --profile / --note / --detach / --host 后传进 run({ retry })；
// --detach：与 ar dispatch --detach 相同（协议第 7 节第 8 条），请求里多 retry: { n, note, profile }，
// 执行者进程（--run-request）认出后自己写 resume（pid 是执行者进程）再继续。
// 与派发的差别：不占新记录名、不截断 raw.log / events.jsonl、不写 dispatch.json、
// 写 resume 而不是 start、不做托管交接——同一工作区、同一 id 接着跑第 n 次尝试，只跑这一次。
async function runRetry({ adapterOverride, scriptPath, env, root, request, opts, onDetach, onGate, onRetry }) {
  const home = homeDirectory(env);
  const registry = registryWriter(home);
  const started = Date.now();
  // 定位任务、状态判断、选执行者、取原始指令与门禁、算新编号与上一次的失败（只读；
  // 不通过时抛错，调用方按派发错误退出码 2 处理）。脱离派发的执行者进程不再读配置（按快照运行）。
  //（任务 102）清单里没有结束记录的任务：先核对原派发进程还在不在。核对是异步的，所以放在同步的 prepareRetry 之前，
  // 结果交给它参考；prepareRetry 与这一步都只读，补写 interrupted 要等所有检查通过、真的要重试时（下面）才做。
  const unfinished = await checkUnfinished({ root, env, name: opts.name });
  const plan = prepareRetry({ root, env, name: opts.name, profileOpt: opts.profile, note: opts.note, nOverride: opts.n, skipProfile: !!request, gateSnapshot: request?.args?.gate ?? null,
    rebase: opts.rebase, rebaseBase: opts.rebaseBase, afterMerge: opts.afterMerge, unfinished });
  const { paths, id, n, saved, prompt, gateInfo, warnings, baseNote, specNote, optionsNote, effortNote, failure, rebase } = plan;
  // 脱离重试的执行者进程沿用前台算好的来源（请求里带着）。
  const settingSources = request ? (request.settingSources ?? null) : plan.settingSources;
  // 执行者配置：执行者进程用请求里的快照（同派发），前台重新读配置（顺便校验 --profile 存在且启用）。
  const loaded = request
    ? { settings: { ...request.settings, watchWindow: 'never' }, warning: null, config: {}, profile: { adapter: request.adapter ?? 'codex', ...(request.profileConfig ?? {}) } }
    : plan.loaded;
  const { settings, warning, config } = loaded;
  // generic 执行者的声明解析进执行者配置（同派发）；脱离重试的执行者进程用请求里带着的声明。
  const profile = resolveProfile(loaded.profile, config);
  const profileName = plan.profileName;
  const adapter = adapterOverride ?? adapterFor(profile, { config, tolerant: true });
  const label = profile.label ?? adapter.label ?? adapter.id;
  // 只读任务重试时换了不支持只读的执行者（--profile）：同派发，在启动前拒绝。
  if (!request && gateInfo?.readOnly === true && !supportsReadOnly(profile, config)) throw new Error(`${label} 不支持只读任务`);
  mkdirSync(paths.dir, { recursive: true });
  const interactive = !!process.stdout.isTTY;
  const progress = (text, at = Date.now()) => {
    const line = `[${new Date(at).toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`;
    appendFileSync(paths.progress, `${line}\n`);
    if (interactive) console.log(line);
  };
  console.log(`记录名：${paths.name}\n进度：${paths.progress}`);
  // 原派发进程已经不在了、也没有结束记录（任务 102）：所有检查都通过、真的要重试了，补写 interrupted 再往下走（与 ar stop 同一个函数）。
  if (plan.processGone) {
    recordProcessGone(plan.processGone.home, plan.start);
    const line = '重试：上一次的派发进程意外退出，已记为中断';
    progress(line);
    if (!interactive) console.log(line);
  }
  if (warning) { progress(warning); if (!interactive) console.log(warning); }
  if (!request) for (const key of adapter.unsupportedSettings ?? []) if (settings[key] != null) {
    const line = `配置：${adapter.id} 执行者不支持 ${key}，已忽略`;
    progress(line);
    if (!interactive) console.log(line);
  }
  // 不认识的字段只警告（同派发，协议 11.2）；重新准备门禁时才会拿到新警告。
  for (const text of warnings) {
    const line = `任务说明警告：${text}`;
    progress(line);
    if (!interactive) console.log(line);
  }
  // start 没记基线时按当前 HEAD 重新取，原因写进进度（协议 14.3 第 5 条）。
  if (baseNote) progress(baseNote);
  // 任务说明已改：新的门禁设置写回 dispatch.json（gate.merged），进度记一行；执行者进程沿用前台已经写好的。
  // 冲突后的 --rebase（协议 15.8）：门禁基线换成合并进来的主分支提交，同样写回 dispatch.json，之后的重试沿用它。
  if (!request && (specNote || (rebase && gateInfo?.enabled))) {
    writeDispatch(paths, { ...saved, gate: gateInfo });
    if (specNote) {
      progress(specNote);
      if (!interactive) console.log(specNote);
    }
  }
  if (optionsNote && !request) { progress(optionsNote); if (!interactive) console.log(optionsNote); }
  if (effortNote && !request) { progress(effortNote); if (!interactive) console.log(effortNote); }
  if (request) progress(managedMessage(request.app));
  onRetry?.({ id, name: paths.name, n });
  // ——脱离重试——只写"已认领"请求并交给独立进程，不握手、不等待、不弹进度窗口（同 dispatch --detach）。
  if (opts.detach && !request) {
    const detachRequest = { v: 1, id, app: 'AgentRouter', at: started, script: scriptPath, node: process.execPath, repo: root, name: paths.name,
      profile: profileName, adapter: adapter.id,
      args: { task: saved.task, extra: saved.extra, role: saved.role ?? null, spec: saved.spec ?? null, ...(gateInfo ? { gate: gateInfo } : {}) },
      settings: Object.fromEntries(['model', 'effort', 'tier', 'sandbox', 'path'].map(key => [key, settings[key]])),
      dispatcher: dispatcher(opts.host, env), env: managedEnvironment(env),
      profileConfig: profileConfig(profile, adapter),
      // 手动重试的三件信息（协议 14.3 第 8 条）：执行者进程写 resume 时用请求里的 n / profile。
      retry: { n, note: opts.note, profile: profileName, ...(rebase ? { rebase: true, rebaseBase: rebase.base, ...(rebase.afterMerge ? { afterMerge: rebase.afterMerge } : {}) } : {}) }, ...(settingSources ? { settingSources } : {}), detached: true };
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
  // 执行者环境：与派发相同的白名单、密钥、沙箱用户目录（env.mjs）。
  const sources = secretSources(config);
  let childEnv, envError = null;
  // 099：手动重试这一次重新读代理（同派发：先加代理变量，再经过白名单）。
  const { base: envBase, proxy } = withProxy(env, home);
  try { childEnv = buildEnv({ base: envBase, profile, adapter, home, profileName, sources }); ensureSandboxHome(childEnv, { home, profileName }); }
  catch (error) { envError = error; childEnv = allowedEnv({ base: envBase, adapter, home, profileName, sources }); }
  const detection = await adapter.detect({ env: childEnv, settings, profile });
  // 开始前追加 resume（协议 14.3 第 7 条）：pid 是这次运行重试的进程
  //（脱离派发时是执行者进程自己，在上面的 --run-request 里走同一条分支）。
  // 这次重试多记生效值与来源（新任务总有来源，154 起），ar status 优先读它；旧任务（没有来源）的 resume 与以前逐字相同。
  const resumeSettings = settingSources || plan.start.settingSources
    ? { model: settings.model ?? adapter.modelName?.({ settings, profile }) ?? null, effort: settings.effort, settingSources } : {};
  // 合并后的自动重跑门禁（154）：resume 另记原因 after-merge 和刚合并的任务 id。
  registry({ event: 'resume', id, pid: process.pid, n, at: Date.now(), ...resumeSettings, ...(rebase?.afterMerge ? { reason: 'after-merge', after: rebase.afterMerge.id } : {}) });
  // 之后与协议 14.2 相同，只是只跑这一次（retry），收尾写 attempt-end 与 end（end.attempts === n）。
  return pipeline({
    root, paths, id, registry, progress, started, interactive, home,
    adapter, label, profile, profileName, settings, detection, childEnv, env, envError, proxy,
    prompt, gateInfo, onGate, taskTitle: plan.start.title, taskSpec: saved.spec,
    maxRetries: 0, escalate: null, sources,
    retry: { n, note: opts.note, failure, ...(rebase ? { rebase } : {}) },
    // worktree 任务在原 worktree 里继续，也要占任务名额（协议 15.2、15.5）。
    ...(plan.worktree ? { worktree: plan.worktree } : {}),
  });
}

// 清单里这个任务还没有结束记录时，核对原派发进程还在不在（任务 102，与 ar stop 共用 checkDispatch；只读）。
// 任务找不到或已经结束返回 null（由 prepareRetry 照常处理）。
async function checkUnfinished({ root, env, name }) {
  const found = locateStart([homeDirectory(env), legacyHomeDirectory(env)], root, name);
  if (!found || findTerminal(found.file, found.start.id)) return null;
  return { id: found.start.id, check: await checkDispatch(found.start) };
}

// 手动重试的准备（协议 14.3 第 1～6 条）：定位任务 → 状态判断 → 执行者 → 编号 n →
// 原始指令 → 门禁与基线 → 上一次的失败。只读，不写清单、不启动进程；
// 不通过时抛出中文原因，调用方按派发错误（退出码 2）处理。
// skipProfile：脱离派发的执行者进程不读配置（协议：执行者按快照运行），执行者由请求里的快照给出。
// unfinished：checkUnfinished 的结果。原派发进程已经不在了的任务按"中断"往下判断，并在返回值里带 processGone，
// 由调用方在真正开始重试时补写 interrupted（这里不写）。
function prepareRetry({ root, env, name, profileOpt = null, note = null, nOverride = null, skipProfile = false, gateSnapshot = null, rebase = false, rebaseBase = null, afterMerge = null, unfinished = null }) {
  const home = homeDirectory(env);
  // 1. 找任务（协议 14.3 第 1 条，同 ar wait 的规则：新旧公共目录里最近开始的那条）。
  const found = locateStart([home, legacyHomeDirectory(env)], root, name);
  if (!found) throw new Error(`重试：在当前仓库找不到记录 ${name}`);
  const { file, start } = found;
  const paths = taskPaths(root, start.name);
  // 2. 状态（协议 14.4：最近一条 start / resume 之后有没有 end / interrupted）。
  let terminal = findTerminal(file, start.id), processGone = null;
  if (!terminal) {
    const check = unfinished?.id === start.id ? unfinished.check : null;
    if (check?.state === 'failed') throw new Error(`无法核对派发进程（${check.reason}），稍后再试`);
    if (check?.state !== 'gone') throw new Error('任务还在进行，先停止');
    terminal = { event: 'interrupted', id: start.id, signal: 'process-gone' };
    processGone = { home: found.home };
  }
  // 2.0 合并冲突的任务只能用 --rebase 继续（协议 15.8）；--rebase 还可以用在失败（门禁未通过、执行者异常退出）和已中断的 worktree 任务上。
  //     原派发进程已经不在的任务（processGone）按已中断算（这时清单里还没有 interrupted）。
  const outcome = start.worktree === true ? (processGone ? 'stopped' : worktreeOutcome(file, start.id)) : null;
  if (outcome === 'conflict' && !rebase) throw new Error(`任务处于合并冲突状态：用 ar retry ${start.name} --rebase 解决冲突`);
  //     合并后的自动重跑门禁（Stage07c 154，afterMerge）是例外：它专门作用在待验收的任务上。
  if (rebase && !['conflict', 'failed', 'stopped'].includes(outcome) && !(afterMerge && outcome === 'awaiting')) throw new Error(rebaseRefusal(start, outcome));
  // 准备命令失败的任务（协议 15.4）：重试时在原 worktree 里重跑准备命令，执行者还没跑过，所以也没有上一次的失败。
  const setupRetry = terminal.event === 'end' && terminal.reason === 'setup';
  // 2.1 worktree 任务（协议 15.2）在原 worktree 里继续：取最近一条 worktree 事件的 dir，目录已经不在了就拒绝。
  //     先于 --note、执行者配置等其他判断：没有 worktree 可以继续时，别的问题都不用谈。
  let worktree = null;
  if (start.worktree === true) {
    const dir = latestRow(file, start.id, 'worktree')?.dir;
    if (typeof dir !== 'string' || !existsSync(dir)) throw new Error(`worktree 已经不在了：${typeof dir === 'string' ? dir : '（清单里没有记录）'}，用 ar redispatch 重新派发`);
    worktree = { dir, base: start.base ?? null, setup: setupRetry ? setupCommands(root) : [], ...(setupRetry ? { rerunSetup: true } : {}), attemptBase: latestAttemptBase(file, start.id) };
  }
  // 3. 执行者：--profile 指定的必须存在且启用（报错文案就是 profile 选择的现有文案，loadConfig 抛出）；
  //    不给就用最后一次尝试的 attempt.profile，没有 attempt 事件的旧任务用 start.profile。
  //    配置读不了（协议第 4 节 CONFIG_INVALID）也在这一步拒绝：retry 属于"需要选执行者"的命令，
  //    先于 --note / 旧任务判断，任何不合法的 retry 都统一拒绝、不派发（已有测试 config-invalid 覆盖）。
  const lastAttempt = latestRow(file, start.id, 'attempt');
  const wanted = profileOpt ?? lastAttempt?.profile ?? start.profile ?? undefined;
  //    派发时命令行给的选项（dispatch.json 的 options，067）照用；换了执行者配置只沿用 sandbox / watchWindow。
  const saved = readDispatch(root, start.name);
  const savedOptions = saved?.options ?? {};
  const switched = !!saved && !!wanted && wanted !== saved.profile;
  const kept = retryOptions(savedOptions, switched);
  const loadOpts = { profile: wanted, ...Object.fromEntries(Object.entries(kept).map(([key, value]) => [DISPATCH_OPTIONS[key], value])) };
  let loaded = skipProfile ? null : loadConfig(home, loadOpts, env);
  // 4. 完成（exit 0）的任务必须写 --note；没有 dispatch.json 的旧任务与 ar redispatch 同一句话。
  //    中断、失败、完成后再改一轮则继续（协议 14.3 的表）。
  if (!rebase && terminal.event === 'end' && (terminal.exit ?? 1) === 0 && note == null) throw new Error('已完成的任务重试时必须写补充说明（--note）');
  if (!saved) throw new Error('这个任务是旧版本派发的，没有保存派发参数，不能再派一次');
  // 5. 新尝试编号：最后一个 attempt.n + 1；Stage04 没有 attempt 事件按已有 1 次算（n = 2）；
  //    准备命令失败的任务一次尝试都没有开始过，从 1 起。
  //    脱离派发时前台算好放进请求，执行者进程沿用，不重算。
  //    编号不能和已经写过的 resume 重复：合并后自动重跑遇到冲突不写 attempt（只有 resume、end、conflict），
  //    之后点"解决冲突并重试"按 attempt 算会又得到同一个 n；软件按（任务 id，n）判断请求文件对应的那次尝试已经结束，
  //    会在执行者进程改名认领之前把请求文件删掉，重试悄悄没有发生。所以不小于最近一条 resume 的 n + 1。
  //    准备命令失败后的重试从 1 起重新编号（没有 attempt、日志在 attempts/1/，已有测试逐条核对），不受这条约束。
  const lastResumeN = latestRow(file, start.id, 'resume')?.n;
  const counted = (Number.isSafeInteger(lastAttempt?.n) ? lastAttempt.n : setupRetry ? 0 : 1) + 1;
  const n = Number.isSafeInteger(nOverride) && nOverride >= (setupRetry ? 1 : 2) ? nOverride
    : setupRetry || !Number.isSafeInteger(lastResumeN) ? counted : Math.max(counted, lastResumeN + 1);
  // 6. 原始指令与门禁（不检查工作区是否干净：同一工作区继续）。
  const prompt = originalPrompt(root, paths, saved);
  const gate = retryGate(root, saved, start, gateSnapshot);
  // model / effort 的任务说明层与路由规则层（Stage07c T6）。同一执行者配置：任务说明重新读（新写的值照新值生效），
  // 路由规则的 effort 沿用第一次派发时记在 dispatch.json 里的；换了执行者配置：这两层都不沿用（和命令行给的 model / effort 一样，是上一个配置的）。
  // 脱离重试的执行者进程（skipProfile）按请求里的快照运行，不在这里重算。
  // 每次重试都有来源（Stage07c 154）：同一执行者按各层重新算，换了配置按这个配置自己的值算。不支持推理强度的执行者同样忽略给出的强度（D87）。
  let settingSources = null, effortNote = null;
  if (loaded && !switched) {
    const layers = { spec: gate.specSettings, rule: { effort: saved.route?.effort } };
    const layered = resolveSettings(loaded.config, loadOpts, env, loaded.profileName, layers);
    const fromLayer = ['任务说明', '路由规则'].includes(layered.sources.effort) ? layered.sources.effort : null;
    const refusal = fromLayer && effortRefusal({ effort: layered.settings.effort, from: fromLayer, name: loaded.profileName, profile: loaded.profile, config: loaded.config });
    if (refusal) throw new Error(refusal);
    const settled = settleEffort({ layered, supported: supportsEffort(loaded.profileName, loaded.profile, loaded.config), config: loaded.config, opts: loadOpts, env, profileName: loaded.profileName, layers });
    loaded = { ...loaded, settings: settled.settings };
    settingSources = settingSourcesOf(settled.sources);
    effortNote = settled.note;
  } else if (loaded) settingSources = settingSourcesOf(loaded.sources);
  // 进度说明行只在确实丢掉了 model / effort / tier 时才写（协议 14.3）；任务说明、路由规则里的 model / effort 被丢掉时也写。
  // 154 起每个任务都有 settingSources，所以这里只看有没有哪一项来自任务说明 / 路由规则。
  const savedLayered = Object.values(saved.settingSources ?? {}).some(source => source === '任务说明' || source === '路由规则');
  const optionsNote = switched && (Object.keys(savedOptions).some(key => !SHARED_OPTIONS.includes(key)) || savedLayered || gate.specSettings)
    ? `手动重试：换了执行者配置（${saved.profile} → ${wanted}），不沿用 model / effort / tier` : null;
  // 冲突后的 --rebase（协议 15.8）：新基线 = 主分支现在指向的提交（脱离派发时用前台算好的那个），门禁的基线换成它。
  let rebaseInfo = null, gateInfo = gate.gateInfo;
  if (rebase) {
    const baseBranch = taskBaseBranch(saved, readProjectConfig(root).baseBranch);
    const fromConflict = outcome === 'conflict';
    rebaseInfo = { base: rebaseBase ?? resolveBase(root, baseBranch), baseBranch, fromConflict, files: fromConflict ? latestRow(file, start.id, 'conflict')?.files ?? [] : [], ...(afterMerge ? { afterMerge } : {}) };
    if (gateInfo?.enabled) gateInfo = { ...gateInfo, base: rebaseInfo.base };
  } else if (worktree?.attemptBase && gateInfo?.enabled && !gateSnapshot) {
    // 普通手动重试（164）：门禁基线取最近一次尝试的基线（排队出队时更新过、或做过 --rebase），与 accept / diff 一致。
    // 脱离重试的执行者进程用前台算好、写进请求的快照（gateSnapshot），这里不重算。
    gateInfo = { ...gateInfo, base: worktree.attemptBase };
  }
  // 7. 上一次的失败（中断、完成后再改一轮没有失败段落，只有补充说明）。
  const failure = setupRetry ? null : previousFailure(file, paths, start.id, n, terminal);
  return { start, paths, id: start.id, n, saved, prompt, gateInfo, warnings: gate.warnings,
    baseNote: gate.baseNote, specNote: gate.specNote, gateChanged: gate.gateChanged, optionsNote, effortNote, settingSources, failure, loaded, profileName: loaded ? loaded.profileName : wanted, worktree, rebase: rebaseInfo, processGone };
}

// --rebase 被拒绝的中文原因（协议 15.8）：非 worktree 任务、待验收、已合并、已驳回。
// 待验收沿用最初的"任务不在冲突状态"原文（已有测试逐字核对）。
function rebaseRefusal(start, outcome) {
  if (start.worktree !== true) return `不是 worktree 任务，不能用 --rebase：${start.name}`;
  if (outcome === 'accepted') return `任务已合并，不能用 --rebase：${start.name}`;
  if (outcome === 'rejected') return `任务已驳回，不能用 --rebase：${start.name}`;
  return `任务不在冲突状态，不能用 --rebase：${start.name}`;
}

// 最近一次尝试里记录的门禁基线（重新基线之后的 attempt 事件才有 base 字段，协议 15.8）；没有为 null。
function latestAttemptBase(file, id) {
  for (const row of reverseRows(file)) {
    if (row.id !== id) continue;
    if (row.event === 'attempt' && typeof row.base === 'string' && row.base) return row.base;
    if (row.event === 'start') break;
  }
  return null;
}

// 同一任务最近一条指定事件（清单从尾部往前找，协议 14.4 的读取方向）。
function latestRow(file, id, event) {
  for (const row of reverseRows(file)) if (row.id === id && row.event === event) return row;
  return null;
}

// 原始指令（协议 14.3 第 5 条）：attempts/1/prompt.md 是派发时发出去的原文；
// 没有它（Stage04 旧任务没有 attempts/）就按 dispatch.json 重新生成（与 dispatch 同一个 taskDetails）。
function originalPrompt(root, paths, saved) {
  try { return readFileSync(attemptPaths(paths, 1).prompt, 'utf8'); }
  catch { /* 旧任务：按派发参数重新生成。 */ }
  return taskDetails(root, { opts: { ...(saved.role && !saved.roleDefault ? { role: saved.role } : {}), name: saved.name }, task: saved.task, extra: saved.extra }).prompt;
}

// 门禁与基线（协议 14.3 第 5 条）：dispatch.json 里的直接用；缺了按派发规则重新准备
//（重新解析任务说明、重新取基线），但**不检查工作区是否干净**——手动重试在同一工作区继续。
// start.base 也没记（当时门禁没启用、这次改启用了）时按当前 HEAD，并在进度里说明（协议 14.3）。
//
// 启用了门禁的任务重新读取任务说明（协议 14.5 末条）：新的 allowed_paths / verify / verify_timeout_min 用于这次门禁，
// 基线与其余字段不变。snapshot 是脱离重试的请求里前台已经准备好的门禁信息，执行者进程直接用它，不再重读。
// 返回值另带 specSettings：重新读到的任务说明里的 model / effort（resolveSettings 的 spec 层，Stage07c T6）；
// 没读任务说明（脱离重试的执行者进程）或没写时为 null。没启用门禁的任务也重新读一次（读不了就当没有），因为推理强度不属于门禁。
function retryGate(root, saved, start, snapshot = null) {
  if (snapshot && typeof snapshot === 'object' && typeof snapshot.enabled === 'boolean') {
    return { gateInfo: snapshot, warnings: [], baseNote: null, specNote: null, gateChanged: false, specSettings: null };
  }
  if (saved.gate && typeof saved.gate === 'object' && typeof saved.gate.enabled === 'boolean') {
    if (saved.gate.enabled === true && typeof saved.spec === 'string' && saved.spec !== '') {
      return respecGate(root, saved, start.worktree === true);
    }
    return { gateInfo: saved.gate, warnings: [], baseNote: null, specNote: null, gateChanged: false, specSettings: tolerantSpecLayer(root, saved.spec) };
  }
  // 没有门禁字段：旧任务或直接任务文字派发。有任务说明就重新准备；没有就没有门禁。
  if (saved.spec) {
    const { parsed, spec, merged } = readAndMergeSpec(root, saved.spec);
    const fields = gateFields(merged);
    const readOnly = needsReadOnly(spec);
    if (merged.gate || readOnly) {
      const hasBase = typeof start.base === 'string' && start.base;
      const base = hasBase ? start.base : headSha(root);
      const baseNote = hasBase ? null : `手动重试：任务开始时没有记录基线，按当前 HEAD ${String(base).slice(0, 7)} 作为门禁基线`;
      return { gateInfo: { enabled: true, base, merged: fields, ...(readOnly ? { readOnly: true } : {}) }, warnings: parsed.warnings, baseNote, specNote: null, gateChanged: false, specSettings: specLayer(spec) };
    }
    return { gateInfo: { enabled: false, base: null, merged: fields }, warnings: parsed.warnings, baseNote: null, specNote: null, gateChanged: false, specSettings: specLayer(spec) };
  }
  return { gateInfo: null, warnings: [], baseNote: null, specNote: null, gateChanged: false, specSettings: null };
}

// 工作区里的任务说明的 model / effort；没有任务说明、读不了或解析不过都当没有（真正的错误不在这里报）。
function tolerantSpecLayer(root, specPath) {
  if (typeof specPath !== 'string' || specPath === '') return null;
  try { return specLayer(validateSpec(parseSpec(readFileSync(resolvePath(root, specPath), 'utf8'), specPath), specPath)); }
  catch { return null; }
}

// 手动重试重新读取任务说明（协议 14.5 末条）：必须已提交，否则抛错（退出码 2）。
// 非 worktree 模式取主工作区 HEAD 里的版本（要求已提交、没有未提交的修改）；
// worktree 模式取 baseBranch 最新提交里的版本，不看主工作区干净与否（执行者的 worktree 里有它自己的改动，主工作区的改动与它无关）。
// 只换 allowed_paths / verify / verify_timeout_min，基线与 expect_commit、max_retries 沿用派发时的值。
function respecGate(root, saved, worktree = false) {
  let rel, revision, shown;
  if (worktree) {
    const baseBranch = taskBaseBranch(saved, readProjectConfig(root).baseBranch);
    revision = baseBranch;
    rel = requireSpecAt(root, resolveBase(root, baseBranch), baseBranch, saved.spec);
  } else {
    rel = requireCommittedSpec(root, saved.spec, '重试');
    revision = 'HEAD';
  }
  shown = git(root, ['show', `${revision}:${rel}`]);
  if (shown.status !== 0) throw new Error(`读不到 ${revision} 里的任务说明 ${rel}：${shown.stderr.trim() || `git show 退出码 ${shown.status}`}`);
  const parsed = parseSpec(shown.stdout, saved.spec);
  const spec = validateSpec(parsed, saved.spec);
  const merged = mergeSpec(spec, readProjectConfig(root));
  const old = saved.gate.merged && typeof saved.gate.merged === 'object' ? saved.gate.merged : {};
  const next = { ...old, allowed_paths: merged.allowed_paths, verify: merged.verify, verify_timeout_min: merged.verify_timeout_min };
  const changed = ['allowed_paths', 'verify', 'verify_timeout_min'].some(key => JSON.stringify(old[key]) !== JSON.stringify(next[key]));
  return {
    gateInfo: changed ? { ...saved.gate, merged: next } : saved.gate, warnings: parsed.warnings, baseNote: null,
    specNote: changed ? '手动重试：任务说明已改，按新的允许范围与验收命令' : null, gateChanged: changed, specSettings: specLayer(spec),
  };
}

// 上一次的失败（协议 14.3 第 6 条），供这次的 prompt 加失败段落：
// - 门禁未通过（attempt-end.gate === false）→ { kind: 'gate', gate }：gate.json 取 attempts/<n-1>/，
//   缺了退回顶层 gate.json；两处都没有就没有失败段落（只有补充说明）。
// - 执行者异常退出 → { kind: 'agent', exit, errors, stderrTail }：errors 只收 events.jsonl 里
//   attempt === n-1 的出错事件文字（Stage04 的事件没有 attempt 字段，收不到）；
//   stderrTail 取 attempts/<n-1>/raw.log 末尾 4096 字符，缺 attempts/ 时用顶层 raw.log。
// - 中断（interrupted）、完成后再改一轮（end.exit === 0）→ null：只有补充说明，没有失败段落。
// 两处 gate.json 都缺时按"没有失败段落"处理（协议 14.3）。
function previousFailure(file, paths, id, n, terminal) {
  if (terminal.event !== 'end' || (terminal.exit ?? 1) === 0) return null;
  const previous = attemptPaths(paths, n - 1);
  const attemptEnd = latestRow(file, id, 'attempt-end');
  const mine = attemptEnd?.n === n - 1;
  if (mine && attemptEnd.gate === false) {
    const gate = readGateJson(previous.gate) ?? readGateJson(join(paths.dir, 'gate.json'));
    if (gate) return { kind: 'gate', gate };
    return null;
  }
  const errors = [];
  for (const row of reverseRows(paths.events)) {
    if (row.kind === 'error' && row.attempt === n - 1 && typeof row.text === 'string') errors.push(row.text);
  }
  errors.reverse();
  const exit = mine ? (attemptEnd.exit ?? 1) : (terminal.exit ?? terminal.agentExit ?? 1);
  return { kind: 'agent', exit, errors, stderrTail: tailText(existsSync(previous.raw) ? previous.raw : paths.raw, 4096) };
}

// 读一次门禁结果文件；不存在或不是带 summary 的对象都当没有（由上一层回退）。
function readGateJson(file) {
  try { const value = readJson(file); return value && typeof value === 'object' && typeof value.summary === 'string' ? value : null; }
  catch { return null; }
}

// 文件末尾 maxChars 个字符：先读末尾 4 倍字节（UTF-8 最长 4 字节/字符），去掉开头的半行再按字符截取。
function tailText(file, maxChars) {
  let fd;
  try { fd = openSync(file, 'r'); }
  catch { return ''; }
  try {
    const size = fstatSync(fd).size, from = Math.max(0, size - maxChars * 4);
    const buffer = Buffer.alloc(size - from);
    const read = readSync(fd, buffer, 0, buffer.length, from);
    let text = buffer.subarray(0, read).toString('utf8');
    if (from > 0) { const newline = text.indexOf('\n'); if (newline !== -1) text = text.slice(newline + 1); }
    return text.slice(-maxChars);
  } finally { closeSync(fd); }
}
