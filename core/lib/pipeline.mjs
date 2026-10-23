// 派发流程的编排：多次尝试的循环（每次 runner.runOnce → 门禁 → attempt-end），最后收尾一次
// （汇报、进度页脚、gate / end 事件、退出码）。规则见文件协议第 14 节（14.1、14.2）。
// 停止信号放在这里：它要同时覆盖执行者运行与门禁验收命令，从第一次启动执行者起一直有效到任务结束。
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clip, formatProgress, progressFooter } from './progress.mjs';
import { killProcessTree } from './process.mjs';
import { runGate } from './gate.mjs';
import { openWatch, shouldWatch, viewerTakesOver } from './watch.mjs';
import { runOnce } from './runner.mjs';
import { attemptPaths } from './records.mjs';
import { buildPrompt } from './retry-prompt.mjs';
import { adapterFor } from '../adapters/index.mjs';
import { buildEnv, ensureSandboxHome } from './env.mjs';
import { reverseRows } from './wait.mjs';

// 进度分隔行里失败原因的写法（协议 14.2 第 2 条）。
const reasonText = (reason, failure) => (reason === 'gate' ? '门禁未通过'
  : reason === 'agent' ? `执行者异常退出（exit ${failure?.exit ?? '?'}）`
    : '手动重试');

// ctx：run.mjs 准备好的一切——记录路径与清单、进度写入、执行者与配置快照、合并后的门禁信息，
// 以及重试次数（maxRetries）与升级目标（escalate：{ name, profile }，profile 为 null 表示不可升级）。
// 手动重试（协议 14.3，任务 059）：retry = { n, note, failure } 时从第 n 次起只跑这一次
// （total 为 null、不再自动重试、不升级）；prompt 仍是原始指令，由这里按失败与补充说明加段落。
// 返回退出码（0 通过 / 1 执行者失败或被停止 / 3 门禁未通过；其他为执行者退出码原样透传）。
export async function pipeline(ctx) {
  const {
    root, paths, id, registry, progress, started, interactive, home,
    adapter, label, profile, profileName, settings, detection, childEnv, env, envError,
    prompt, gateInfo, onGate,
    maxRetries = 0, escalate = null, sources = [], retry = null,
  } = ctx;
  // 手动重试：从第 retry.n 次开始、只跑这一次；正常派发从第 1 次开始，
  // 这一轮自动执行允许的总次数 1 + max_retries（协议 14.1；直接任务文字派发的 maxRetries 为 0）。
  const firstN = retry?.n ?? 1;
  const total = retry ? null : 1 + maxRetries;
  const lastN = retry ? firstN : total;
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

  // 当前执行者：最后一次自动重试可以换成 escalate（协议 14.1）；每次尝试用它构造命令与环境。
  let run = { adapter, label, profile, profileName, settings, detection, childEnv, envError };
  let stopping = false;
  let agentPid = null;
  // 门禁进行中当前验收命令的 pid；没有门禁命令在跑时是 null（回调见 runGate 的 onSpawn）。
  let gatePid = null;
  let signalsInstalled = false;
  const handlers = [];
  const stopped = () => stopping;
  // 装停止信号：执行者启动成功后由 runner 回调进来（此时 agentPid 才有值）。只装一次，跨尝试一直有效（协议 14.1）。
  const installSignals = pid => {
    agentPid = pid;
    if (signalsInstalled) return;
    signalsInstalled = true;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
      const handler = async () => {
        if (stopping) return;
        stopping = true;
        // 门禁进行中要结束的是当前验收命令的进程树，不是已经结束的执行者（协议 12.1 第 8 条约定）。
        const target = gatePid ?? agentPid;
        try { if (target) await killProcessTree(target); }
        catch { /* 结束失败仍记录中断并退出，平台函数有总时限。 */ }
        finally {
          try { appendFileSync(paths.progress, `\n=== 派发脚本收到 ${signal}，被外部中断 ===\n`); } catch { /* 不阻塞退出。 */ }
          registry({ event: 'interrupted', id, signal, at: Date.now() });
          process.exit(1);
        }
      };
      process.on(signal, handler);
      handlers.push([signal, handler]);
    }
  };

  let ranGate = false;   // 整个任务是否跑过门禁（跑过的 end 另有 agentExit，协议第 2 节）
  let lastGate = null;   // 最后一次尝试的门禁结果（收尾打印与 onGate 用；没跑为 null）
  let lastRun = null;    // 最后一次尝试的运行结果
  let exitCode = 1;
  let failure = retry ? retry.failure : null;    // 上一次的失败（下一次的重试段落与原因用；手动重试从任务里带入）
  for (let n = firstN; n <= lastN; n++) {
    currentAttempt = n;
    attemptErrors = [];
    usage = { input: 0, output: 0, sawInput: false, sawOutput: false };
    // 手动重试的这一次是 manual；其余仍是 first / gate / agent（协议 14.2 第 1 条）。
    const reason = retry && n === firstN ? 'manual' : n === 1 ? 'first' : failure?.kind === 'gate' ? 'gate' : 'agent';

    // 升级：只在最后一次自动重试换用 escalate（协议 14.1）；手动重试不升级。
    // 换执行者失败的其他原因（适配器不支持、缺密钥、检测出错）与"目标不存在或未启用"
    // 用同一行进度文案，不另写（协议 14.1）。
    if (!retry && n > 1 && n === total && escalate?.name) {
      const upgraded = await tryEscalate(escalate, { run, env, home, settings, sources });
      if (upgraded) run = upgraded;
      else progress(`升级：${escalate.name} 没有启用，继续用 ${run.label}`);
    }

    // attempt 事件（协议 14.2 第 1 条）：第 1 次也写（reason: "first"），在 spawned 之前；
    // 手动重试写 reason: "manual"、total: null（协议 14.3 第 7 条）。
    registry({ event: 'attempt', id, n, total, profile: run.profileName, reason, at: Date.now() });
    // 第 2 次起写进度分隔行（协议 14.2 第 2 条）；第 1 次不写，单次运行的进度格式不变。
    if (n > 1) progress(`=== 第 ${n} 次尝试（执行者：${run.label}；原因：${reasonText(reason, failure)}）===`);

    // attempts/<n>/：prompt.md 先写好，raw.log 边跑边追加（协议 14.2 第 3 条）。
    const attempt = attemptPaths(paths, n);
    mkdirSync(attempt.dir, { recursive: true });
    // 手动重试（协议 14.3 第 5 条）：拿原始指令重新加段落——上一次的失败（如有）与 --note 都写进去；
    // 没有 note 时 buildPrompt 不写补充说明段。
    const attemptPrompt = retry && n === firstN ? buildPrompt(prompt, { n, total: null, failure: retry.failure, note: retry.note })
      : n === 1 ? prompt : buildPrompt(prompt, { n, total, failure, note: null });
    writeFileSync(attempt.prompt, attemptPrompt);

    // 有状态映射（如 Claude Code 要靠 id 配对命令开始与结果）每次尝试新建一个：
    // 上一次被停止时可能留下配对一半的命令或 lastResult，不该漏进这次。只弹一次进度窗口（第 1 次尝试）。
    const mapLine = run.adapter.createMapper ? run.adapter.createMapper() : run.adapter.mapLine;
    const attemptStarted = Date.now();
    lastRun = await runOnce({
      adapter: run.adapter, label: run.label, profile: run.profile, settings: run.settings, detection: run.detection,
      root, childEnv: run.childEnv, paths, registry, id,
      prompt: attemptPrompt, envError: run.envError, emit, errors: attemptErrors, mapLine, stopped,
      attempt: n, attemptFiles: attempt,
      onSpawn: installSignals,
      // 只弹一次进度窗口（本进程的第一次尝试；手动重试是新进程，从第 firstN 次起弹一次）。
      beforeSpawn: n === firstN ? () => {
        if (shouldWatch({ platform: process.platform, interactive, policy: settings.watchWindow, takeover: viewerTakesOver(home) })) openWatch(paths.name, paths.progress, label);
      } : null,
    });
    // 被停止：信号处理器写 interrupted 后以 1 退出；不写这次的 attempt-end，也不写 end（协议 14.1）。
    if (stopping) return new Promise(() => {});

    // 门禁（协议第 12 节）：执行者以 0 结束且启用门禁时跑，dir 指这次的 attempts/<n>/。
    let gate = null;
    if (lastRun.exit === 0 && gateInfo?.enabled) {
      gatePid = null;
      registry({ event: 'gating', id, at: Date.now() });
      progress(`门禁开始：检查提交与改动范围，运行 ${gateInfo.merged.verify.length} 条验收命令`);
      try {
        gate = await runGate({
          root, base: gateInfo.base, spec: gateInfo.merged, env,
          // 去掉当前执行者配置 secrets 里的键与来源变量名（协议 12.2）。
          dropEnv: Object.entries(run.profile.secrets ?? {}).flatMap(([key, value]) => [key, value]),
          dir: attempt.dir, attempt: n,
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
      if (existsSync(attempt.gate)) copyFileSync(attempt.gate, join(paths.dir, 'gate.json'));
      ranGate = true;
    }
    // 门禁进行中收到停止信号：信号处理器写 interrupted 并以 1 退出，这里不再写 attempt-end / end。
    if (stopping) return new Promise(() => {});

    // 这次的汇报写到 attempts/<n>/report.md，顶层 report.md 保持"最新"（协议 14.2 第 3、4 条）：
    // 不自己写汇报的执行者由核心写（同样写这里）；这次没有汇报就保留上一次的。
    if (!run.adapter.writesReport) {
      const text = run.adapter.finish ? run.adapter.finish({ lastSay: lastRun.lastSay, result: lastRun.result }) : lastRun.lastSay;
      if (text != null) writeFileSync(attempt.report, text);
    }
    if (existsSync(attempt.report)) copyFileSync(attempt.report, paths.report);

    // attempt-end（协议 14.2 第 6 条）：被停止的尝试不写（上面已经按停止返回）。
    lastGate = gate;
    registry({
      event: 'attempt-end', id, n,
      ok: lastRun.exit === 0 && (gate == null || gate.ok === true),
      exit: lastRun.exit,
      gate: gate ? gate.ok : null,
      usage: { input: usage.sawInput ? usage.input : null, output: usage.sawOutput ? usage.output : null },
      ms: Date.now() - attemptStarted, at: Date.now(),
    });

    // 失败分类（协议 14.1）：可重试的是门禁未通过（gate）与执行者非 0 退出（agent）；
    // 执行者没能启动（缺密钥、command 出错、spawn 失败）不重试——重试也不会好。
    if (lastRun.exit === 0 && (gate == null || gate.ok === true)) { exitCode = 0; break; }
    if (lastRun.startFailed) { exitCode = 1; failure = { kind: 'start' }; break; }
    if (gate != null && gate.ok !== true) {
      failure = { kind: 'gate', gate };
      exitCode = 3;
    } else {
      failure = { kind: 'agent', exit: lastRun.exit, errors: attemptErrors, stderrTail: lastRun.stderrTail };
      exitCode = lastRun.exit;
    }
    // 手动重试只跑这一次，跑完就收尾（协议 14.3 第 7 条）；正常派发跑到这一轮允许的总次数为止。
    if (retry || n >= total) break;
  }

  // 两次尝试之间收到停止同样立即结束：信号处理器写 interrupted 后以 1 退出，不写 end。
  if (stopping) return new Promise(() => {});
  for (const [signal, handler] of handlers) process.off(signal, handler);
  // 收尾只写一次 end（协议 14.2 第 7 条）：进度页脚也只写一次。
  return finish({
    exitCode,
    // end.agentExit：跑过门禁的任务才有（协议第 2 节），值为最后一次尝试执行者的退出码。
    gate: lastGate, agentExit: lastRun.exit, ranGate,
    attempts: currentAttempt, label: run.label,
  });

  function finish({ exitCode: code, gate = null, agentExit, ranGate: ran, attempts, label: endLabel }) {
    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    appendFileSync(paths.progress, progressFooter(code, minutes, paths.report, endLabel));
    // gate 事件已在每次门禁跑完后立刻写过；这里只写 end（在最后一个 attempt-end 之后）。
    registry({ event: 'end', id, exit: code, at: Date.now(), minutes: Number(minutes), attempts, ...(ran ? { agentExit } : {}) });
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
async function tryEscalate(escalate, { run, env, home, settings, sources }) {
  try {
    const target = escalate.profile;
    if (!target || typeof target !== 'object') return null;
    const adapter = adapterFor(target);
    const childEnv = buildEnv({ base: env, profile: target, adapter, home, profileName: escalate.name, sources });
    ensureSandboxHome(childEnv, { home, profileName: escalate.name });
    const detection = await adapter.detect({ env: childEnv, settings, profile: target });
    return {
      adapter,
      label: target.label ?? adapter.label ?? adapter.id,
      profile: target,
      profileName: escalate.name,
      settings: run.settings,
      detection,
      childEnv,
      envError: null,
    };
  } catch {
    return null;
  }
}
