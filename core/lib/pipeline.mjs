// 派发流程的编排：多次尝试的循环（每次 runner.runOnce → 门禁 → attempt-end），最后收尾一次
// （汇报、进度页脚、gate / end 事件、退出码）。规则见文件协议第 14 节（14.1、14.2）。
// 停止信号放在这里：它要同时覆盖执行者运行与门禁验收命令，从第一次启动执行者起一直有效到任务结束。
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clip, formatProgress, progressFooter } from './progress.mjs';
import { killProcessTree } from './process.mjs';
import { runGate } from './gate.mjs';
import { openWatch, shouldWatch, viewerTakesOver } from './watch.mjs';
import { noExitGrace, runOnce } from './runner.mjs';
import { attemptPaths } from './records.mjs';
import { buildPrompt } from './retry-prompt.mjs';
import { adapterFor, resolveProfile } from '../adapters/index.mjs';
import { effortOptionsFor, effortStep, route, supportsEffort, supportsReadOnly } from './router.mjs';
import { buildEnv, ensureSandboxHome, withProxy } from './env.mjs';
import { reverseRows } from './wait.mjs';
import { needsScopeLine, parseNeedsScope } from './needs-scope.mjs';
import { readConfig, readEffectiveConfig, resolveSettings, slotLimits } from './config.mjs';
import { classifyFailure, clockText, recordLimit } from './limits-state.mjs';
import { markEnvironment } from './report.mjs';
import { parseSpec, validateSpec } from './spec.mjs';
import { acquireSlot } from './slots.mjs';
import { awaitingOverlaps, createOverlapWatcher, createTaskLimit, enterGate, exclusiveCommandOf, overlapLine, overlapNoteLine, readProject, waitForOverlap } from './schedule.mjs';
import { readDispatch } from './records.mjs';
import { taskBaseBranch } from './status.mjs';
import { createWorktree, mergeInto, requireSpecAt, resolveBase, runSetup } from './worktree.mjs';
import { OUTSIDE_NOTE, diffRoots, outsideField, outsideLine, outsideRecord, snapshotRoots, uncheckedLine, userTempLine } from './outside-writes.mjs';
import { homedir } from 'node:os';
import { git } from './git.mjs';
import { chooseReviewer, markNeedsHuman, reviewApplies, reviewDecision, reviewSettings, reviewSpecOf, runReview } from './review.mjs';

// 排队时每轮重读 config.json 里的名额上限；配置读不了（正在写、坏了）时抛错，由 acquireSlot 沿用上一轮的值。
function slotLimitNow(home, key) {
  const state = readConfig(home);
  if (state.reason) throw new Error(state.reason);
  return slotLimits(state.config).limits[key];
}
// 同上，返回整个结果（自动档要看 mode / estimate / max）。
function slotInfoNow(home) {
  const state = readConfig(home);
  if (state.reason) throw new Error(state.reason);
  return slotLimits(state.config);
}

// 自动重试都没通过时，进度与汇报末尾的提示（end 事件另有 handBack: true）。
const HAND_BACK_LINE = '自动重试都没通过，建议主导接手';

// 限流 / 额度用完 / 服务不可用时自动换执行者（Stage07c T7，任务 148）：一个任务最多换这么多次（防止循环），换人不计自动重试次数。
const MAX_SWITCHES = 5;
const NO_ONE_LEFT = '所有可用执行者都被限流或不可用';
const environmentWhy = kind => (kind === 'limit' ? '额度用完或被限流' : '服务不可用或网络中断');

// 路由用的任务说明字段（type / worker / read_only）；读不了或解析不过就当没有。run.mjs 里有同样的函数，那里导入 pipeline，这里不能反向导入。
function routeSpecOf(root, specPath) {
  if (!specPath) return null;
  try {
    const spec = validateSpec(parseSpec(readFileSync(resolve(root, specPath), 'utf8'), specPath), specPath);
    return { type: spec.type, worker: spec.worker, read_only: spec.read_only };
  } catch { return null; }
}

// 进度分隔行里失败原因的写法（协议 14.2 第 2 条）。
const reasonText = (reason, failure) => (reason === 'gate' ? '门禁未通过'
  : reason === 'agent' ? `执行者异常退出（exit ${failure?.exit ?? '?'}）`
    : reason === 'review' ? '审查发现问题，返工'
    : reason === 'rebase' ? '合并主分支的新提交后重跑门禁'
      : reason === 'conflict' ? '解决合并冲突'
        : '手动重试');

// ctx：run.mjs 准备好的一切——记录路径与清单、进度写入、执行者与配置快照、合并后的门禁信息，
// 以及重试次数（maxRetries）与升级目标（escalate：{ name, profile }，profile 为 null 表示不可升级）。
// 默认升级链（Stage07c T8）：strong = { name, profile, why }（全局强执行者，null 表示没设；profile 为 null 表示不可用，why 是原因），
// effortOptions = 这个执行者可选的推理强度（按档位从低到高，null 表示不知道），settingSources = 派发时记的 model / effort 来源。
// 每次自动重试用谁、什么强度，见下面循环开头的"默认升级链"一段。
// 手动重试（协议 14.3，任务 059）：retry = { n, note, failure } 时从第 n 次起只跑这一次
// （total 为 null、不再自动重试、不升级）；prompt 仍是原始指令，由这里按失败与补充说明加段落。
// worktree 模式（协议 15）：worktree = { base, setup, dir }，其中 dir 为 null 表示新建（排队 → 建 worktree → 准备命令），
// 有值表示沿用原 worktree（手动重试，只占任务名额）。执行者与门禁都在工作目录 workdir 里运行：
// 非 worktree 模式它就是项目根 root，worktree 模式是任务自己的 worktree；root 始终是项目根（记录目录在它下面）。
// 返回退出码（0 通过 / 1 执行者失败或被停止 / 3 门禁未通过；其他为执行者退出码原样透传）。
export async function pipeline(ctx) {
  const {
    root, paths, id, registry, progress, started, interactive, home,
    adapter, label, profile, profileName, settings, detection, childEnv, env, envError,
    // 派发 / 手动重试启动前算出的网络代理（Stage07 099）；没传时按"没有代理"。
    proxy = null,
    prompt, gateInfo, onGate,
    maxRetries = 0, escalate = null, strong = null, effortOptions: initialEffortOptions = null, effortSupported: initialEffortSupported = true, settingSources = null, sources = [], retry = null, worktree = null,
    // 工作区外写入检查列的用户目录根：核心进程的 os.homedir()（不是交给执行者的沙箱目录），ctx 里可替换（测试用）。
    userHome = homedir(),
  } = ctx;
  // 手动重试：从第 retry.n 次开始、只跑这一次；正常派发从第 1 次开始，
  // 这一轮自动执行允许的总次数 1 + max_retries（协议 14.1；直接任务文字派发的 maxRetries 为 0）。
  const firstN = retry?.n ?? 1;
  const total = retry ? null : 1 + maxRetries;
  // 因限流 / 服务不可用而换人的次数（Stage07c T7）：换人的那次尝试不消耗重试次数，所以循环的上限随它增加，
  // 而升级链、重试指令、"最后一次"的判断都按 n - switches（不含换人的尝试）算。
  let switches = 0;
  // 由审查触发的自动返工次数（Stage08 T3）：同样不消耗重试次数，所以循环的上限随它增加，升级链、重试指令、最后一次的判断按 n - switches - reworks 算。
  let reworks = 0;
  let lastN = retry ? firstN : total;
  // 推理强度档位跟着当前执行者走（换人后换成新执行者的）。
  let effortOptions = initialEffortOptions;
  // 这个执行者是否支持推理强度（预设 supportsEffort: false 的不支持，升级链不升档，Stage07c 154）。
  let effortSupported = initialEffortSupported;
  // seq 跨尝试连续（协议 14.2 第 4 条）：events.jsonl 是同一文件接着追加，手动重试换了进程，
  // 先从尾部读出最后一个 seq 再继续。
  let seq = 0;
  if (retry) {
    for (const row of reverseRows(paths.events)) { seq = Number.isFinite(row.seq) ? row.seq : 0; break; }
  }
  // errors：整个任务的出错事件文字（收尾时后台打印）；attemptErrors：这次尝试的（重试段落与失败原因用）。
  const errors = [];
  let attemptErrors = [];
  // 这次尝试各 turn 事件的 token 合计；一个数字都没取到的字段写 null（协议 14.2 第 6 条）。
  let usage = { input: 0, output: 0, sawInput: false, sawOutput: false };
  let currentAttempt = 0;
  const emit = (event, at = Date.now()) => {
    const unified = { ...event, v: 1, seq: ++seq, at, attempt: currentAttempt };
    appendFileSync(paths.events, `${JSON.stringify(unified)}\n`);
    if (event.kind === 'error') { errors.push(event.text); attemptErrors.push(event.text); }
    if (event.kind === 'turn' && event.usage && typeof event.usage === 'object') {
      if (Number.isFinite(event.usage.input)) { usage.input += event.usage.input; usage.sawInput = true; }
      if (Number.isFinite(event.usage.output)) { usage.output += event.usage.output; usage.sawOutput = true; }
    }
    for (const line of formatProgress(unified)) progress(line, at);
  };

  // 调研 / 审查类任务（Stage07 105）：以只读模式运行，门禁不允许任何改动。信息来自门禁信息的 readOnly 字段（派发时算好，重试沿用）。
  const readOnly = gateInfo?.readOnly === true;

  // 当前执行者：最后一次自动重试可以换成 escalate（协议 14.1）；每次尝试用它构造命令与环境。
  let run = { adapter, label, profile, profileName, settings, detection, childEnv, envError };
  // 上一次启动执行者用的代理变量（比较用）：变了才重建环境，所以不用代理（off）时环境永远是原来那份。
  let lastProxyEnv = proxy?.env ?? {};
  let stopping = false;
  let agentPid = null;
  // 门禁进行中当前验收命令的 pid；没有门禁命令在跑时是 null（回调见 runGate 的 onSpawn）。
  let gatePid = null;
  // 占着的门禁名额的释放函数（协议 15.5）；没占时是 null。停止信号处理里也要释放。
  let releaseGate = null;
  // 占着的任务名额的释放函数（worktree 模式，协议 15.5）；没占时是 null。
  let releaseTask = null;
  // 准备命令进行中当前命令的 pid；没有在跑时是 null。
  let setupPid = null;
  let signalsInstalled = false;
  const handlers = [];
  const stopped = () => stopping;
  // 装停止信号：执行者启动成功后由 runner 回调进来（此时 agentPid 才有值）。只装一次，跨尝试一直有效（协议 14.1）。
  // worktree 模式在排队之前就装（armSignals），这样排队与准备命令期间收到信号也会写 interrupted。
  const installSignals = pid => {
    agentPid = pid;
    armSignals();
  };
  const armSignals = () => {
    if (signalsInstalled) return;
    signalsInstalled = true;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
      const handler = async () => {
        if (stopping) return;
        stopping = true;
        // 门禁进行中要结束的是当前验收命令的进程树，不是已经结束的执行者（协议 12.1 第 8 条约定）；准备命令同理。
        const target = gatePid ?? setupPid ?? agentPid;
        try { if (target) await killProcessTree(target); }
        catch { /* 结束失败仍记录中断并退出，平台函数有总时限。 */ }
        finally {
          try { releaseGate?.(); } catch { /* 名额文件删不掉时由下一个占用者按孤立回收。 */ }
          try { releaseTask?.(); } catch { /* 同上。 */ }
          try { appendFileSync(paths.progress, `\n=== 派发脚本收到 ${signal}，被外部中断 ===\n`); } catch { /* 不阻塞退出。 */ }
          registry({ event: 'interrupted', id, signal, at: Date.now() });
          process.exit(1);
        }
      };
      process.on(signal, handler);
      handlers.push([signal, handler]);
    }
  };

  // 准备命令与验收命令的额外环境变量（只在 worktree 模式）：主工作区（项目根）与这个任务的 worktree 的绝对路径。
  const worktreeEnv = dir => (worktree ? { AR_BASE_REPO: resolve(root), AR_WORKTREE: resolve(dir) } : undefined);

  // 工作目录：非 worktree 模式就是项目根；worktree 模式先排队占任务名额，建 worktree、跑准备命令，之后换成 worktree 目录（协议 15.2、15.4、15.5）。
  let workdir = root;
  if (worktree) {
    armSignals();
    const prepared = await prepareWork();
    if (prepared.stopped) return new Promise(() => {});
    if (prepared.failed) {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      return finish({ exitCode: 1, attempts: 0, label: run.label, reason: 'setup' });
    }
    workdir = prepared.dir;
  }

  // 冲突后的 ar retry --rebase（协议 15.8）：在原 worktree 里把主分支的新提交合并进来。
  // 没有冲突 → 提交这次合并，这一次只跑门禁（reason: rebase，不启动执行者）；
  // 有冲突 → 合并停在冲突状态，派执行者解决（reason: conflict）。null 表示不是 --rebase。
  let rebased = null;
  if (retry?.rebase) {
    const { base: newBase, baseBranch, afterMerge } = retry.rebase;
    // 合并后的自动重跑门禁（Stage07c 154，D86）：批准了改动范围重叠的任务之后，这个待验收任务自动按新基线重跑。
    if (afterMerge) progress(`${afterMerge.name} 已合并，与它的改动范围重叠：按新基线重跑门禁`);
    const merged = mergeInto({ dir: workdir, revision: newBase, message: `合并 ${baseBranch}（${newBase.slice(0, 7)}）` });
    if (merged.error) {
      // 合并本身没能进行（不是冲突）：任务以失败结束，但仍是冲突状态（conflict 事件写在 end 之后，协议 15.3），可以再试。
      for (const [signal, handler] of handlers) process.off(signal, handler);
      emit({ kind: 'error', text: `合并 ${baseBranch} 失败：${merged.error}` });
      const code = finish({ exitCode: 1, attempts: 0, label: run.label });
      // 失败 / 已中断的任务（不是从冲突来的）不补 conflict 事件：它们以这次失败结束，状态仍是失败。
      if (retry.rebase.fromConflict !== false) registry({ event: 'conflict', id, files: retry.rebase.files ?? [], at: Date.now() });
      return code;
    }
    rebased = merged.conflicts;
    // 自动重跑遇到冲突：不派执行者（没人要求），撤销这次合并，任务进"冲突"状态（和 ar accept 冲突后一样），要解决时再手动 ar retry --rebase。
    if (afterMerge && rebased.length) {
      git(workdir, ['merge', '--abort']);
      for (const [signal, handler] of handlers) process.off(signal, handler);
      progress(`合并 ${baseBranch}（${newBase.slice(0, 7)}）：${rebased.length} 个文件有冲突（${rebased.slice(0, 5).join('、')}），已撤销这次合并，任务进入冲突状态；解决冲突用 ar retry ${paths.name} --rebase`);
      const code = finish({ exitCode: 1, attempts: 0, label: run.label });
      registry({ event: 'conflict', id, files: rebased, at: Date.now() });
      return code;
    }
    progress(rebased.length
      ? `合并 ${baseBranch}（${newBase.slice(0, 7)}）：${rebased.length} 个文件有冲突（${rebased.slice(0, 5).join('、')}），交给执行者解决`
      : retry.rebase.fromConflict === false
        ? `合并 ${baseBranch}（${newBase.slice(0, 7)}）后重跑门禁`
        : `合并 ${baseBranch}（${newBase.slice(0, 7)}）：没有冲突，只重跑门禁`);
  }

  let ranGate = false;   // 整个任务是否跑过门禁（跑过的 end 另有 agentExit，协议第 2 节）
  let lastGate = null;   // 最后一次尝试的门禁结果（收尾打印与 onGate 用；没跑为 null）
  let lastRun = null;    // 最后一次尝试的运行结果
  let lastNeedsScope = [];   // 最后一次尝试汇报里的"需要越界"（end 事件用）
  let exitCode = 1;
  let failure = retry ? retry.failure : null;    // 上一次的失败（下一次的重试段落与原因用；手动重试从任务里带入）
  let raisedEffort = null;   // 升级链把推理强度提高到了什么（没提高过为 null）
  // 限流换人（Stage07c T7）：failedProfiles 是这个任务里已因限流 / 服务不可用换掉的执行者（路由时跳过）；
  // takeover 是上一次尝试失败后选好的下一个执行者（下一次尝试开头套用）；streak 是同一执行者连续"服务不可用"的尝试数。
  const failedProfiles = new Set();
  let takeover = null;
  let streak = { profile: null, count: 0 };
  for (let n = firstN; n <= lastN; n++) {
    currentAttempt = n;
    attemptErrors = [];
    usage = { input: 0, output: 0, sawInput: false, sawOutput: false };
    // 第几次"计入重试"的尝试：换人的那次与被换掉的那次是同一步，升级链、重试指令、最后一次的判断都按它。
    const step = n - switches - reworks;
    const taken = takeover;
    takeover = null;
    if (taken) { run = taken.run; effortOptions = taken.effortOptions; effortSupported = taken.effortSupported; raisedEffort = null; }
    // 手动重试的这一次是 manual；其余仍是 first / gate / agent（协议 14.2 第 1 条）。
    // ar retry --rebase 的这一次是 rebase（没有冲突，不启动执行者）或 conflict（有冲突，执行者解决）。
    // 换人的那次的上一次是执行者异常退出（限流 / 不可用），reason 记 agent；评分里它被"环境"归因免掉（report.mjs）。
    const rebaseOnly = !!rebased && rebased.length === 0 && n === firstN;
    const reason = rebased && n === firstN ? (rebased.length ? 'conflict' : 'rebase')
      : retry && n === firstN ? 'manual' : n === 1 ? 'first' : taken ? 'agent' : failure?.kind === 'review' ? 'review' : failure?.kind === 'gate' ? 'gate' : 'agent';

    // 网络代理（Stage07 099）：这个进程里的第 2 次起的每次尝试都重新读一次（system 模式下系统代理可能已经变了）。
    // 第一次尝试用启动前算好的环境；之后算出的代理变量和上一次不同才重建环境（没变就沿用，off 时永远不重建）。
    const fresh = n > firstN ? withProxy(env, home) : null;
    const proxyChanged = !!fresh && JSON.stringify(fresh.proxy.env) !== JSON.stringify(lastProxyEnv);
    if (fresh) lastProxyEnv = fresh.proxy.env;
    // 换人时新执行者的环境刚用新读的代理变量建好，这一次不再按"代理变了"重建。
    let upgradedNow = !!taken;

    // 默认升级链（Stage07c T8）：自动重试（第 2 次尝试起）才走，手动重试不走。每次在进度里写一行。
    //  0. 第 1 次重试（第 2 次尝试）：同一执行者、同样强度，不升档（maxRetries 为 1 时它同时是最后一次，按第 1 条换人）。
    //  1. 最后一次自动重试换人：执行者配置 / 路由规则写了 escalate 的以它为准（不再用强执行者），
    //     否则换全局强执行者 routing.strongExecutor（没设、就是任务自己的执行者、已停用，都不换人，进度写明）。
    //     换执行者失败的其他原因（适配器不支持、缺密钥、检测出错）与"目标不存在或未启用"用同一行进度文案，不另写（协议 14.1）。
    //  2. 没有换人的那几次（含最后一次没能换人时）：推理强度升一档，按预设 effortOptions 的顺序，每次从当前值再升；
    //     已是最高档、没有明确强度、不知道档位，都跳过并写明原因。换人的那一次沿用当时的设置，不再升。
    let escalation = null;   // 重试指令里补的一句
    // 审查触发的返工（failure.kind 是 review）不走升级链：它不是重试，和前一次尝试是同一步。
    if (!retry && step > 1 && !taken && failure?.kind !== 'review') {
      const last = step === total;
      const swapTo = async (target, line) => {
        const upgraded = await tryEscalate(target, { run, env: fresh.base, home, settings, sources, readOnly });
        if (upgraded) { run = upgraded; upgradedNow = true; progress(line); escalation = `这一次换成了另一个执行者（${run.label}）接手。`; }
        return !!upgraded;
      };
      let swapped = false;
      if (last && escalate?.name) {
        swapped = await swapTo(escalate, `最后一次重试：换升级目标 ${escalate.name}`);
        if (!swapped) progress(`升级：${escalate.name} 没有启用，继续用 ${run.label}`);
      } else if (last) {
        if (!strong?.name) progress(`没有设强执行者，最后一次仍用 ${run.profileName}`);
        else if (strong.name === run.profileName) progress(`最后一次重试：本任务的执行者就是强执行者 ${strong.name}，不换人`);
        else if (!strong.profile) progress(`强执行者 ${strong.name} ${strong.why ?? '不可用'}，按没有强执行者处理，最后一次仍用 ${run.profileName}`);
        else {
          swapped = await swapTo({ name: strong.name, profile: strong.profile }, `最后一次重试：换强执行者 ${strong.name}`);
          if (!swapped) progress(`强执行者 ${strong.name} 没能启动，最后一次仍用 ${run.profileName}`);
        }
      }
      // 第 2 次尝试（第 1 次重试）同一执行者、同样强度，不升档；第 3 次尝试起才升（进度里的"第 N 次重试"= 尝试序号 - 1）。
      if (!swapped && step >= 3) {
        // 执行者不支持推理强度（D87）：不升档，写明原因。
        const next = effortSupported ? effortStep(effortOptions, run.settings.effort) : { skip: '这个执行者不支持推理强度，不提高' };
        if (next.next) {
          progress(`第 ${step - 1} 次重试：提高推理强度 ${run.settings.effort} → ${next.next}`);
          escalation = `这一次已把推理强度从 ${run.settings.effort} 提高到 ${next.next}。`;
          run = { ...run, settings: { ...run.settings, effort: next.next } };
          raisedEffort = next.next;
        } else progress(`第 ${step - 1} 次重试：${next.skip}`);
      }
    }
    if (proxyChanged && !upgradedNow && !run.envError) {
      try {
        const rebuilt = buildEnv({ base: fresh.base, profile: run.profile, adapter: run.adapter, home, profileName: run.profileName, sources });
        ensureSandboxHome(rebuilt, { home, profileName: run.profileName });
        run = { ...run, childEnv: rebuilt };
      } catch { /* 重建失败（例如密钥后来被删了）：沿用上一次的环境。 */ }
    }

    // attempt 事件（协议 14.2 第 1 条）：第 1 次也写（reason: "first"），在 spawned 之前；
    // 手动重试写 reason: "manual"、total: null（协议 14.3 第 7 条）。
    // 重新基线之后（协议 15.8）这次门禁的基线写在 attempt 事件的 base 字段：--rebase 的这一次，以及之后沿用新基线的重试。
    const attemptBase = n === firstN ? (retry?.rebase?.base ?? worktree?.attemptBase ?? null) : null;
    // 升级链提高过推理强度的，这一次和之后的 attempt 事件多记生效的 effort 和来源（"升级链"）；其余任务没有这两个字段。
    // total 含换人多出来的尝试，保证 n 不超过 total。
    registry({ event: 'attempt', id, n, total: total === null ? null : total + switches + reworks, profile: run.profileName, reason, ...(attemptBase ? { base: attemptBase } : {}),
      ...(raisedEffort ? { effort: run.settings.effort, settingSources: { model: settingSources?.model ?? null, effort: '升级链' } } : {}), at: Date.now() });
    // 第 2 次起写进度分隔行（协议 14.2 第 2 条）；第 1 次不写，单次运行的进度格式不变。
    if (n > 1) progress(`=== 第 ${n} 次尝试（执行者：${run.label}；原因：${taken ? `换执行者（${taken.fromLabel}${environmentWhy(taken.kind)}）` : reasonText(reason, failure)}）===`);

    // attempts/<n>/：prompt.md 先写好，raw.log 边跑边追加（协议 14.2 第 3 条）。
    const attempt = attemptPaths(paths, n);
    mkdirSync(attempt.dir, { recursive: true });
    // 手动重试（协议 14.3 第 5 条）：拿原始指令重新加段落——上一次的失败（如有）与 --note 都写进去；
    // 没有 note 时 buildPrompt 不写补充说明段。
    const attemptFailure = rebased?.length && n === firstN ? { kind: 'conflict', files: rebased, baseBranch: retry.rebase.baseBranch } : retry?.failure;
    // 换人的那次与被换掉的那次是同一步（step），指令也一样；上一个执行者可能已经改了一部分，另加一段接手说明。
    const stepPrompt = step === 1 && failure?.kind !== 'review' ? prompt : buildPrompt(prompt, { n: step, total, failure, note: null, escalation });
    const attemptPrompt = retry && n === firstN ? buildPrompt(prompt, { n, total: null, failure: attemptFailure, note: retry.note })
      : taken ? `${stepPrompt}\n\n## 接手说明\n\n上一个执行者（${taken.fromLabel}）因${environmentWhy(taken.kind)}中断了任务，工作区里可能已有它的部分改动。请在现有改动的基础上继续，不要推倒重来。`
        : stepPrompt;
    if (!rebaseOnly) writeFileSync(attempt.prompt, attemptPrompt);

    // 有状态映射（如 Claude Code 要靠 id 配对命令开始与结果）每次尝试新建一个：
    // 上一次被停止时可能留下配对一半的命令或 lastResult，不该漏进这次。只弹一次进度窗口（第 1 次尝试）。
    const mapLine = run.adapter.createMapper ? run.adapter.createMapper() : run.adapter.mapLine;
    const attemptStarted = Date.now();
    // 工作区外写入检查（协议 12.4）：启动执行者之前先列一遍用户目录根与公共目录根的第一层。
    const rootsBefore = snapshotRoots({ userHome, home });
    lastRun = rebaseOnly ? { exit: 0, lastSay: null, result: null, stderrTail: '', startFailed: false } : await runOnce({
      adapter: run.adapter, label: run.label, profile: run.profile, profileName: run.profileName, settings: run.settings, detection: run.detection,
      workdir, childEnv: run.childEnv, paths, registry, id, progress,
      prompt: attemptPrompt, envError: run.envError, emit, errors: attemptErrors, mapLine, stopped,
      attempt: n, attemptFiles: attempt, readOnly, noExitGraceMs: noExitGrace(env),
      onSpawn: installSignals,
      // 只弹一次进度窗口（本进程的第一次尝试；手动重试是新进程，从第 firstN 次起弹一次）。
      beforeSpawn: n === firstN ? () => {
        if (shouldWatch({ platform: process.platform, interactive, policy: settings.watchWindow, takeover: viewerTakesOver(home) })) openWatch(paths.name, paths.progress, label);
      } : null,
    });
    // 被停止：信号处理器写 interrupted 后以 1 退出；不写这次的 attempt-end，也不写 end（协议 14.1）。
    if (stopping) return new Promise(() => {});

    // 执行者退出后、门禁之前再列一遍并比较；没能核对只写一行原因，不影响门禁结果与重试。
    const outside = diffRoots(rootsBefore, snapshotRoots({ userHome, home }));
    if (!outside.checked) progress(uncheckedLine(outside.error));
    else if (outside.userTemp?.length) progress(userTempLine(outside.userTemp));

    // 门禁（协议第 12 节）：执行者以 0 结束且启用门禁时跑，dir 指这次的 attempts/<n>/。
    let gate = null;
    if (lastRun.exit === 0 && gateInfo?.enabled) {
      gatePid = null;
      // 门禁名额（协议 15.5）：写 gating 之前取；等待期间执行者已经退出，停止信号不该再去结束它的旧 pid。
      agentPid = null;
      try {
        // 独占门禁（并行调度 140）：验收命令和项目配置 exclusiveCommands 里某条完全相同时，拿到名额后建独占标记；
        // 别人的独占门禁在跑时，普通门禁也在这里等。release 一次放掉标记和名额。
        const signal = { get stopped() { return stopping; } };
        const entered = await enterGate({
          home, id, name: paths.name, signal, progress,
          command: exclusiveCommandOf({ root, verify: gateInfo.merged?.verify }),
          acquire: () => acquireSlot({
            home, kind: 'gate', id, limit: () => slotLimitNow(home, 'gateConcurrency'), signal,
            onWait: ({ held }) => progress(`等门禁名额：已有 ${held} 个门禁在运行`),
            onLimit: (now, old) => progress(`排队：并发上限改为 ${now}（原来 ${old}）`),
          }),
        });
        releaseGate = entered.release;
      } catch (error) {
        // 等待时被停止：信号处理器写 interrupted 并退出，这里不再往下走。名额出错（目录写不进去等）时不排队，直接跑门禁。
        if (error?.stopped) return new Promise(() => {});
        progress(`等门禁名额出错（${error.message}），不排队直接运行门禁`);
      }
      if (stopping) { releaseGate?.(); return new Promise(() => {}); }
      try {
        registry({ event: 'gating', id, at: Date.now() });
        progress(`门禁开始：检查提交与改动范围，运行 ${gateInfo.merged.verify.length} 条验收命令`);
        try {
          gate = await runGate({
            root: workdir, base: gateInfo.base, spec: gateInfo.merged, env,
            // 去掉当前执行者配置 secrets 里的键与来源变量名（协议 12.2）。
            dropEnv: Object.entries(run.profile.secrets ?? {}).flatMap(([key, value]) => [key, value]),
            dir: attempt.dir, attempt: n, outsideWrites: outsideField(outside), extraEnv: worktreeEnv(workdir), readOnly,
            onSpawn: pid => {
              gatePid = pid;
              // 停止信号已经到达时，刚启动的命令立即结束（门禁循环随后由进程退出结束）。
              if (stopping && pid) killProcessTree(pid).catch(() => {});
            },
          });
        } catch (error) {
          // 门禁自身出错（如 gate.json 写不进去）：按未通过处理，仍写 gate 事件。
          gate = { ok: false, attempt: n, at: Date.now(), summary: `门禁运行失败：${error.message}` };
          emit({ kind: 'error', text: gate.summary });
        }
        gatePid = null;
        for (const item of gate.commands ?? []) {
          const status = item.timedOut ? '超时'
            : item.error != null ? item.error
              : item.exit === 0 ? '通过' : `exit ${item.exit}`;
          progress(`门禁命令：${item.line} → ${status}（${(item.ms / 1000).toFixed(1)} 秒）`);
        }
        progress(gate.summary);
        // 立刻写这次的 gate 事件（协议 14.2 第 5 条），再把 gate.json 复制到顶层（第 4 条）。
        registry({ event: 'gate', id, ok: gate.ok, attempt: n, at: gate.at, summary: gate.summary });
      } finally {
        // gate 事件写完后释放名额；门禁自身出错也释放。
        try { releaseGate?.(); } catch { /* 名额文件删不掉时由下一个占用者按孤立回收。 */ }
        releaseGate = null;
      }
      if (existsSync(attempt.gate)) copyFileSync(attempt.gate, join(paths.dir, 'gate.json'));
      ranGate = true;
    }
    // 门禁进行中收到停止信号：信号处理器写 interrupted 并以 1 退出，这里不再写 attempt-end / end。
    if (stopping) return new Promise(() => {});

    // 这次的汇报写到 attempts/<n>/report.md，顶层 report.md 保持"最新"（协议 14.2 第 3、4 条）：
    // 不自己写汇报的执行者由核心写（同样写这里）；这次没有汇报就保留上一次的。
    if (!run.adapter.writesReport && !rebaseOnly) {
      const text = run.adapter.finish ? run.adapter.finish({ lastSay: lastRun.lastSay, result: lastRun.result, stdoutText: lastRun.stdoutText }) : lastRun.lastSay;
      if (text != null) writeFileSync(attempt.report, text);
    }
    if (existsSync(attempt.report)) copyFileSync(attempt.report, paths.report);

    // 执行者需要越界（协议 14.5）：只看这次尝试的汇报；有就不再自动重试。
    let needsScope = [];
    if (existsSync(attempt.report)) {
      try { needsScope = parseNeedsScope(readFileSync(attempt.report, 'utf8')); } catch { /* 读不了就当没有。 */ }
    }
    lastNeedsScope = needsScope;

    // attempt-end（协议 14.2 第 6 条）：被停止的尝试不写（上面已经按停止返回）。
    lastGate = gate;
    registry({
      event: 'attempt-end', id, n,
      ok: lastRun.exit === 0 && (gate == null || gate.ok === true),
      exit: lastRun.exit,
      gate: gate ? gate.ok : null,
      usage: { input: usage.sawInput ? usage.input : null, output: usage.sawOutput ? usage.output : null },
      ms: Date.now() - attemptStarted, at: Date.now(),
      ...(needsScope.length ? { needsScope } : {}),
      ...(outsideRecord(outside) ? { outsideWrites: outsideRecord(outside) } : {}),
    });
    if (needsScope.length) progress(needsScopeLine(needsScope));
    // 工作区外出现新文件（协议 12.4）：进度提醒，并和"需要越界"并列地不再自动重试。
    const outsideAdded = outside.added.length > 0;
    if (outsideAdded) { progress(outsideLine(outside.added)); progress(OUTSIDE_NOTE); }

    // 失败分类（协议 14.1）：可重试的是门禁未通过（gate）与执行者非 0 退出（agent）；
    // 执行者没能启动（缺密钥、command 出错、spawn 失败）不重试——重试也不会好。
    if (lastRun.exit === 0 && (gate == null || gate.ok === true)) {
      // 审查（Stage08 T3）：门禁通过之后、进入待验收之前。只合并主分支后只重跑门禁的那一次（rebaseOnly）不审查。
      const reviewed = rebaseOnly ? null : await reviewStage({ n, gate, attempt, mayRework: !retry && needsScope.length === 0 && !outsideAdded });
      if (stopping) return new Promise(() => {});
      if (reviewed?.rework) {
        reworks++;
        lastN = total + switches + reworks;
        failure = { kind: 'review', issues: reviewed.review.issues };
        continue;
      }
      exitCode = 0;
      break;
    }
    if (lastRun.startFailed) { exitCode = 1; failure = { kind: 'start' }; break; }

    // 环境原因（Stage07c T7，任务 148）：执行者非 0 退出，原因是额度用完 / 限流（limit）或服务不可用 / 网络中断（unavailable）。
    // 这次失败归"环境"（marks.json）、不计重试、不扣分；limit 记恢复时间（limits.json），按路由链换下一个可用执行者；
    // unavailable 要同一执行者连续两次才算（第一次按普通失败走重试），不记恢复时间。先于下面的普通失败处理，也先于升级链（下一次尝试开头才走升级链）。
    const environment = lastRun.exit !== 0 && !rebaseOnly ? classifyFailure({
      adapter: run.adapter.id,
      events: [...attemptErrors.map(text => ({ kind: 'error', text })),
        ...(mapLine.rateLimit ? [{ type: 'rate_limit_event', rate_limit_info: mapLine.rateLimit }] : [])],
      stderr: lastRun.stderrTail,
      // 通用适配器的程序有的把失败原因写在标准输出里（汇报取标准输出全文的才保留了它）。
      stdout: run.adapter.id === 'generic' ? String(lastRun.stdoutText ?? '').slice(-4096) : '',
      hints: run.adapter.limitHints ?? [],
    }) : { kind: null };
    const sameProfile = streak.profile === run.profileName;
    streak = environment.kind === 'unavailable' ? { profile: run.profileName, count: sameProfile ? streak.count + 1 : 1 } : { profile: null, count: 0 };
    if (environment.kind === 'limit' || (environment.kind === 'unavailable' && streak.count >= 2)) {
      const failed = run;
      const nowMs = Date.now();
      let until = null;
      try { if (environment.kind === 'limit') until = recordLimit(home, failed.profileName, environment, nowMs).until; }
      catch { until = environment.resetsAt ?? null; /* limits.json 写不进去不影响任务，只是别的任务不知道它被限流了。 */ }
      try {
        markEnvironment(paths.dir, n);
        // 服务不可用要连续两次才算：前一次也一并归到环境。
        if (environment.kind === 'unavailable' && n - 1 >= firstN) markEnvironment(paths.dir, n - 1);
      } catch { /* 归因标记写不进去不影响任务。 */ }
      const what = environment.kind === 'limit'
        ? `${failed.label} 被限流（${until ? `额度到 ${clockText(until, nowMs)} 恢复` : '稍后再试'}）`
        : `${failed.label} 连续两次服务不可用`;
      // 能不能换人：手动重试、执行者列了需要越界、工作区外出现新文件、用命令行或任务说明明确指定了执行者、没有路由记录（直接写任务文字派发）、换人次数到上限，都不换。
      const record = !retry ? readDispatch(root, paths.name) : null;
      const pinned = /^(命令行指定|任务说明指定)：/.test(String(record?.route?.trace?.at(-1) ?? ''));
      let why = null;
      if (retry) why = '手动重试不换人';
      else if (needsScope.length || outsideAdded) why = '执行者写了需要越界或工作区外有新文件，不再自动处理';
      else if (!record?.route || !record.spec) why = '这个任务没有路由记录（不是用任务说明派发的）';
      else if (pinned) why = '这个任务明确指定了执行者';
      else if (switches >= MAX_SWITCHES) why = `换执行者已到 ${MAX_SWITCHES} 次的上限`;
      let next = null;
      if (!why) {
        failedProfiles.add(failed.profileName);
        next = await pickNext({ record, failed });
        if (!next) why = NO_ONE_LEFT;
      }
      if (next) {
        progress(`${what}，换 ${next.run.profileName}，这次不计重试`);
        switches++;
        lastN = total + switches + reworks;
        takeover = { ...next, fromLabel: failed.label, kind: environment.kind };
        streak = { profile: null, count: 0 };
        exitCode = lastRun.exit;
        continue;
      }
      // 不换人：这次失败仍归环境，但换人走不通，再试同一个被限流 / 不可用的执行者没有意义，直接按失败结束。
      progress(`${what}，不换执行者：${why}`);
      if (why === NO_ONE_LEFT) emit({ kind: 'error', text: NO_ONE_LEFT });
      failure = { kind: 'agent', exit: lastRun.exit, errors: attemptErrors, stderrTail: lastRun.stderrTail };
      exitCode = lastRun.exit;
      break;
    }

    if (gate != null && gate.ok !== true) {
      failure = { kind: 'gate', gate };
      exitCode = 3;
    } else {
      failure = { kind: 'agent', exit: lastRun.exit, errors: attemptErrors, stderrTail: lastRun.stderrTail };
      exitCode = lastRun.exit;
    }
    // 手动重试只跑这一次，跑完就收尾（协议 14.3 第 7 条）；正常派发跑到这一轮允许的总次数为止（不含换人多出来的尝试）；
    // 执行者列出了需要越界的路径、或工作区外出现了新文件时不再自动重试（协议 14.1、14.5、12.4）。
    if (retry || needsScope.length || outsideAdded || step >= total) break;
  }

  // 两次尝试之间收到停止同样立即结束：信号处理器写 interrupted 后以 1 退出，不写 end。
  if (stopping) return new Promise(() => {});
  for (const [signal, handler] of handlers) process.off(signal, handler);
  // 收尾只写一次 end（协议 14.2 第 7 条）：进度页脚也只写一次。
  return finish({
    exitCode,
    // end.agentExit：跑过门禁的任务才有（协议第 2 节），值为最后一次尝试执行者的退出码。
    gate: lastGate, agentExit: lastRun.exit, ranGate,
    attempts: currentAttempt, label: run.label, needsScope: lastNeedsScope,
    // 自动重试的次数全用完了还是没通过（至少重试过一次；手动重试、提前停下的不算）：提示主导接手。
    // 换人多出来的尝试不算（currentAttempt - switches 才是"计入重试"的次数）；因为所有执行者都被限流而停下的不提示（重试次数没用完）。
    handBack: !retry && exitCode !== 0 && total > 1 && currentAttempt - switches - reworks >= total,
  });

  // 审查阶段（Stage08 T3）：门禁通过之后（没有门禁的任务是执行者正常退出之后）、写待验收之前。
  // 返回 null（没有审查：没启用、只读类型、不用 worktree、读不到配置）或 { review, rework }：
  // rework 为 true 表示审查发现了需要拦截的问题，应该自动返工；审查失败（unknown / invalid）不阻断，进度写明原因。
  async function reviewStage({ n, gate, attempt, mayRework }) {
    let config = null;
    try { config = readEffectiveConfig(home); } catch { /* 配置读不了：只能按任务说明和项目配置判断是否启用，启用了也审查不了。 */ }
    const { spec, text: specSource } = reviewSpecOf(root, paths.name);
    const setting = reviewSettings({ spec, project: readProject(root), global: config });
    if (!setting.enabled || !reviewApplies({ spec, readOnly })) return null;
    if (!worktree) { progress('审查：不用 worktree 的任务无法安全恢复，不审查'); return null; }
    if (!config) { progress('审查：读不到全局配置，不审查'); return null; }
    let report = '';
    try { report = readFileSync(attempt.report, 'utf8'); } catch { /* 这次没有汇报：审查指令里就没有汇报。 */ }
    const executor = run.profileName, model = run.settings?.model ?? run.profile?.model ?? null;
    const picked = chooseReviewer({ config, spec, executor, model, home });
    registry({ event: 'reviewing', id, attempt: n, at: Date.now() });
    if (picked.ok) progress(`审查：交给 ${picked.profile}`);
    // 审查者进程启动后，停止信号要结束的是它（不是已经退出的执行者，也不是门禁命令）。
    agentPid = null; gatePid = null;
    const review = await runReview({
      root, paths, id, worktree: workdir, executor, model, attempt: n,
      spec, specText: specSource ?? prompt, report, gate, base: gateInfo?.base ?? worktree.base ?? null,
      config, home, env, registry, progress,
      signal: { get stopped() { return stopping; } },
      onSpawn: pid => { agentPid = pid; },
    });
    if (stopping) return { review, rework: false };
    if (review.verdict === 'unknown' || review.verdict === 'invalid') progress(`审查没有完成，不阻断：${review.summary}`);
    const decision = reviewDecision({ review, block: setting.block, maxReworks: setting.maxReworks, reworks });
    if (decision.action === 'rework' && mayRework) {
      progress(`审查发现 ${decision.blocking.length} 个高严重度问题，自动返工（第 ${reworks + 1}/${setting.maxReworks} 次）`);
      return { review, rework: true };
    }
    if (decision.action === 'accept') return { review, rework: false };
    // 返工次数用完，或这次不能自动返工（手动重试、执行者列了需要越界、工作区外有新文件）：进入待验收，要人工处理。
    const marked = markNeedsHuman(paths, review);
    registry({ event: 'review-needs-human', id, attempt: n, at: Date.now() });
    progress('审查问题未解决，需人工处理');
    return { review: marked, rework: false };
  }

  // 限流 / 服务不可用后选下一个执行者（Stage07c T7）：按路由链（规则里的下一条 → 兜底 → 默认）取下一个可用的，
  // 跳过这个任务里已经换掉的和 limits.json 里仍被限流的；选中的这一个若启动不了（缺密钥等）再取下一个。
  // 新执行者用自己配置的 model / effort（不沿用被换掉的执行者的）。没有可用的返回 null；返回 { run, effortOptions }。
  async function pickNext({ record, failed }) {
    let config;
    try { config = readEffectiveConfig(home); } catch { return null; }
    const spec = routeSpecOf(root, record.spec);
    const projectConfig = readProject(root);
    for (let tries = 0; tries <= MAX_SWITCHES; tries++) {
      let routed;
      try { routed = route({ spec, projectConfig, config, home, skip: [...failedProfiles] }); } catch { return null; }
      const name = routed.profile;
      // 任务说明指定了具体执行者时路由会原样返回它：已经换掉的不再用。
      if (failedProfiles.has(name) || !config.profiles?.[name]) return null;
      try {
        const profile = resolveProfile(config.profiles[name], config);
        const nextSettings = resolveSettings(config, {}, env, name).settings;
        const built = await tryEscalate({ name, profile }, { run: failed, env: withProxy(env, home).base, home, settings: nextSettings, sources, readOnly });
        if (built) return { run: { ...built, settings: nextSettings }, effortOptions: effortOptionsFor(name, profile, config), effortSupported: supportsEffort(name, profile, config) };
      } catch { /* 这个执行者配置有问题：当作启动不了，换下一个。 */ }
      progress(`${name} 没能启动，找下一个可用的执行者`);
      failedProfiles.add(name);
    }
    return null;
  }

  // worktree 模式的准备（协议 15.2、15.4、15.5）：占任务名额（拿不到先写 queued）→ preparing → 建 worktree（worktree 事件）
  // → 准备命令（setup 事件，日志 attempts/0/setup.log）。返回 { dir } / { failed: true }（已写 setup 与出错事件，由 finish 写 end）/ { stopped: true }。
  // worktree.dir 有值（手动重试）时只占名额，沿用原 worktree，不再写 preparing / worktree / setup；
  // 准备失败过的任务（worktree.rerunSetup）例外：写 preparing，在原 worktree 里重跑准备命令，写 setup（协议 15.4）。
  async function prepareWork() {
    const signal = { get stopped() { return stopping; } };
    // 改动范围重叠（并行调度 140）：可写任务先等改动范围重叠的、还没结束的任务结束，再去占名额。
    // 新派发只等先派发的；手动重试（沿用原 worktree，Stage07c 152）等准备 / 运行 / 门禁中的任务和先进入排队的任务，规则见 createOverlapWatcher。
    // 只读任务不查。查不了（清单读不了等）时不排队，直接往下走。
    let waitedOverlap = false;
    if (!readOnly) {
      // 与待验收的任务改动范围重叠（D86、154）：待验收不挡人，只提示一次（事件 overlap-note + 每个对方一行进度）。
      try {
        const notes = awaitingOverlaps({ home, root, id, patterns: gateInfo?.merged?.allowed_paths });
        if (notes.length) {
          registry({ event: 'overlap-note', id, with: notes, at: Date.now() });
          for (const note of notes) progress(overlapNoteLine(note));
        }
      } catch { /* 查不了就不提示，不影响排队与运行。 */ }
      try {
        const watcher = createOverlapWatcher({ home, root, id, started, patterns: gateInfo?.merged?.allowed_paths, retrying: !!worktree.dir });
        waitedOverlap = await waitForOverlap({
          watcher, signal,
          onChange: blockers => {
            registry({ event: 'queued', id, reason: 'overlap', blockers, at: Date.now() });
            progress(overlapLine(blockers));
          },
        });
      } catch (error) {
        if (error?.stopped) return { stopped: true };
        progress(`检查改动范围重叠出错（${error.message}），不排队直接运行`);
      }
      if (stopping) return { stopped: true };
    }
    let waitLimit = null;
    try {
      // 上限函数：固定档读 concurrency，自动档按估算值；别人的独占门禁在跑、自动档下机器正忙时返回 0（这一轮暂停）。
      const taskLimit = createTaskLimit({
        home, env, progress, registry, id,
        readLimits: () => { const info = slotInfoNow(home); waitLimit = info.limits.concurrency; return info; },
      });
      releaseTask = await acquireSlot({
        home, kind: 'task', id, limit: taskLimit, signal,
        onWait: () => {
          // 独占 / 机器正忙造成的暂停已经写过带原因的 queued 事件（schedule.mjs），不再补一条没有原因的。
          if (!taskLimit.paused()) registry({ event: 'queued', id, at: Date.now() });
          progress(`排队：同时最多 ${waitLimit} 个任务，等前面的任务结束`);
        },
        onLimit: (now, old) => progress(`排队：并发上限改为 ${now}（原来 ${old}）`),
      });
    } catch (error) {
      // 排队时被停止：信号处理器写 interrupted 并退出（没有名额要释放）。名额出错（目录写不进去等）时不排队，直接往下走。
      if (error?.stopped) return { stopped: true };
      progress(`排队出错（${error.message}），不排队直接运行`);
    }
    if (stopping) { releaseTask?.(); return { stopped: true }; }
    // 沿用原 worktree 的手动重试：准备没失败过的任务不再准备；准备失败的任务（rerunSetup）在原 worktree 里重跑全部准备命令（协议 15.4）。
    if (worktree.dir && !worktree.rerunSetup) return { dir: worktree.dir };
    registry({ event: 'preparing', id, at: Date.now() });
    const failed = (summary, ms) => {
      registry({ event: 'setup', id, ok: false, ms, at: Date.now(), summary });
      emit({ kind: 'error', text: summary });
      return { failed: true };
    };
    // 因为重叠等过：先合入的改动已经在主分支里，基线重新取成任务基线分支现在指向的提交，任务说明必须仍在新基线里。
    // 新基线写进 worktree 事件、第一次 attempt 事件（之后门禁、验收都从那里取）和门禁基线。
    if (waitedOverlap && !worktree.dir) {
      try {
        const record = readDispatch(root, paths.name);
        const baseBranch = taskBaseBranch(record, readProject(root).baseBranch);
        const fresh = resolveBase(root, baseBranch);
        if (record?.spec) requireSpecAt(root, fresh, baseBranch, record.spec);
        if (fresh !== worktree.base) {
          progress(`基线更新：${baseBranch} 从 ${worktree.base.slice(0, 7)} 前进到 ${fresh.slice(0, 7)}`);
          worktree.base = fresh;
          worktree.attemptBase = fresh;
          if (gateInfo?.base) gateInfo.base = fresh;
        }
      } catch (error) { return failed(`重新取基线失败：${error.message}`, 0); }
    }
    let created = worktree.dir ? { dir: worktree.dir } : null;
    if (!created) {
      try { created = createWorktree({ root, name: paths.name, base: worktree.base, env }); }
      catch (error) { return failed(error.message, 0); }
      registry({ event: 'worktree', id, dir: created.dir, branch: created.branch, base: worktree.base, at: Date.now() });
      progress(`worktree：${created.dir}（分支 ${created.branch}）`);
    }
    // 日志在这次尝试的目录里：第一次准备是 attempts/0/，准备失败后的重试是 attempts/<n>/（重跑时从头写）。
    const logFile = join(attemptPaths(paths, worktree.dir ? firstN : 0).dir, 'setup.log');
    if (worktree.dir) rmSync(logFile, { force: true });
    const result = await runSetup({
      dir: created.dir, commands: worktree.setup, env,
      // 去掉当前执行者配置 secrets 里的键与来源变量名（同门禁，协议 15.4）。
      dropEnv: Object.entries(run.profile.secrets ?? {}).flatMap(([key, value]) => [key, value]),
      logFile, extraEnv: worktreeEnv(created.dir),
      onSpawn: pid => {
        setupPid = pid;
        // 停止信号已经到达时，刚启动的命令立即结束。
        if (stopping && pid) killProcessTree(pid).catch(() => {});
      },
    });
    setupPid = null;
    if (stopping) return { stopped: true };
    if (!result.ok) return failed(result.summary, result.ms);
    registry({ event: 'setup', id, ok: true, ms: result.ms, at: Date.now(), summary: result.summary });
    if (worktree.setup?.length) progress(`准备命令：${result.summary}（${(result.ms / 1000).toFixed(1)} 秒）`);
    return { dir: created.dir };
  }

  function finish({ exitCode: code, gate = null, agentExit, ranGate: ran = false, attempts, label: endLabel, needsScope = [], reason = null, handBack = false }) {
    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    // 自动重试都没通过：进度（页脚之前）与汇报的末尾各写一句，提示主导接手。
    if (handBack) {
      progress(HAND_BACK_LINE);
      try { appendFileSync(paths.report, `\n${HAND_BACK_LINE}\n`); } catch { /* 汇报写不进去不影响收尾。 */ }
    }
    appendFileSync(paths.progress, progressFooter(code, minutes, paths.report, endLabel));
    // gate 事件已在每次门禁跑完后立刻写过；这里只写 end（在最后一个 attempt-end 之后）。
    registry({ event: 'end', id, exit: code, at: Date.now(), minutes: Number(minutes), attempts, ...(reason ? { reason } : {}), ...(ran ? { agentExit } : {}), ...(needsScope.length ? { needsScope } : {}), ...(handBack ? { handBack: true } : {}) });
    // 任务名额在写完 end 之后释放（协议 15.5：离开 preparing / running / gating）。
    try { releaseTask?.(); } catch { /* 名额文件删不掉时由下一个占用者按孤立回收。 */ }
    releaseTask = null;
    // 后台派发时进度不打印到标准输出；失败原因放在退出码前面，派活方不用翻日志就能看到。
    if (code !== 0 && !interactive) for (const text of errors) console.log(`出错：${clip(text)}`);
    // 门禁结果放在结果行前面（协议 13）；--json 时由调用方收集进 JSON。只报最后一次尝试的门禁。
    if (gate) {
      onGate?.({ ok: gate.ok === true, summary: gate.summary });
      console.log(gate.ok ? '门禁通过' : `门禁未通过：${gate.summary}`);
    }
    console.log(`exit=${code} report=${paths.report}`);
    return code ?? 1;
  }
}

// 升级（协议 14.1）：换成 escalate 指向的执行者配置，重新构建它的环境（密钥由它自己的 secrets 解析，
// 064 起随后调用 ensureSandboxHome，用户目录是沙箱）、适配器与 detect。失败返回 null（不升级）。
async function tryEscalate(escalate, { run, env, home, settings, sources, readOnly = false }) {
  try {
    const target = escalate.profile;
    if (!target || typeof target !== 'object') return null;
    // 只读任务不能升级到不支持只读的执行者（与派发前的检查同一规则）。
    if (readOnly && !supportsReadOnly(target)) return null;
    const adapter = adapterFor(target);
    // 升级目标是 generic 时，声明已由派发进程解析进 target.genericDecl（见 run.mjs 的 resolveProfile）。
    const childEnv = buildEnv({ base: env, profile: target, adapter, home, profileName: escalate.name, sources });
    ensureSandboxHome(childEnv, { home, profileName: escalate.name });
    const detection = await adapter.detect({ env: childEnv, settings, profile: target });
    return {
      adapter,
      label: target.label ?? adapter.label ?? adapter.id,
      profile: target,
      profileName: escalate.name,
      // 目标执行者不支持推理强度（预设 supportsEffort: false）时不把上一个执行者的强度带过去。
      settings: supportsEffort(escalate.name, target) ? run.settings : { ...run.settings, effort: null },
      detection,
      childEnv,
      envError: null,
    };
  } catch {
    return null;
  }
}
