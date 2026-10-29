// 一次执行者运行：构造命令、启动子进程、写 spawned、把原始输出与统一事件落盘、收集失败信息。
// 门禁、汇报、清单收尾与信号处理由 pipeline.mjs 负责；本模块不写 gate / end / attempt-end，
// 只在"执行者给出最后结果却不退出"时结束它的进程树（见下面的 NO_EXIT_GRACE_MS）。
import { spawn } from 'node:child_process';
import { appendFileSync, rmSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { failureReason } from './progress.mjs';
import { longPath } from './paths.mjs';
import { busyDescendants, killProcessTree } from './process.mjs';
import { removeOneShotSandbox, reviveOneShotSandbox } from './env.mjs';

// 汇报取标准输出全文的适配器（adapter.keepStdout）：最多保留这么多字节。
const STDOUT_LIMIT = 256 * 1024;

// 执行者不自行退出的兜底（D115）：适配器的 finalResult 在一行输出里认出"最后的结果事件"后开始计时，
// 这么久没有任何新输出（stdout / stderr）、进程仍不退出，且汇报已经有了、进程树里也没有还在运行的子进程（控制台宿主不算），
// 就结束它的进程树，按结果判定；还有子进程在跑（执行者在等后台命令）或进程查询失败，就重新计时。
export const NO_EXIT_GRACE_MS = 2 * 60 * 1000;
// 测试缩短等待时间：环境变量 AR_TEST_NO_EXIT_GRACE_MS（毫秒，正数才生效），与 AR_TEST_START_TIMEOUT_MS 同类；runOnce 的 noExitGraceMs 参数同样可注入。
export function noExitGrace(env = process.env) {
  const value = Number(env?.AR_TEST_NO_EXIT_GRACE_MS);
  return value > 0 ? value : NO_EXIT_GRACE_MS;
}
const graceText = ms => (ms % 60000 === 0 ? `${ms / 60000} 分钟` : `${Math.round(ms / 100) / 10} 秒`);
const reportExists = file => { try { return statSync(file).size > 0; } catch { return false; } };

// 适配器命令返回的临时文件（command.cleanup，如 {promptFile}）：执行者进程结束后删除。
// 被停止时派发进程直接退出，来不及走到 close，所以进程退出时再兜底删一遍。
const pendingCleanup = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => { for (const file of pendingCleanup) try { rmSync(file, { force: true }); } catch { /* 退出时删不掉就算了。 */ } });
}
function removeFiles(files, progress) {
  for (const file of files) {
    try { rmSync(file, { force: true, maxRetries: 3, retryDelay: 100 }); pendingCleanup.delete(file); }
    catch (error) { progress?.(`清理临时文件失败：${error.code ?? error.message}`); }
  }
}

// runOnce(ctx) 返回 Promise<{ exit, lastSay, result, stdoutText, stderrTail, startFailed }>：
// - stdoutText：标准输出全文（最多 256KB），只有适配器声明 keepStdout 时才有，否则为 null。
// - exit：执行者退出码；启动失败与 child.on('error') 一律按 1。被"不自行退出"兜底结束的，成功结果按 0、错误结果按 1。
// - noExit：被兜底结束了为 true（否则没有这个字段）。
// - startFailed：执行者没能启动（缺密钥、adapter.command 出错、spawn 失败）；pipeline 不重试这种情况（协议 14.1）。
// - lastSay：最后一条说话事件（没有就是 null），适配器不写汇报时由 pipeline 用作汇报正文。
// - result：有状态映射（createMapper）留下的最后结果，交给 adapter.finish。
// - stderrTail：最多 4096 字符的 stderr 尾部（失败原因常只出现在这里）。
// workdir 是执行者的工作目录：非 worktree 模式就是项目根，worktree 模式是任务自己的 worktree（协议 15.2）；
// 记录目录（paths）不受影响，始终在项目主工作区。
// 交给执行者的工作目录（cwd、命令里的 root、事件里绝对路径转相对的 root）统一用长路径（execDir）；存下来的路径不动（124）。
// attemptFiles 是这次尝试的目录（attempts/<n>/，prompt.md 已由 pipeline 写好）：
// 原始输出同时追加到顶层 raw.log 与它下面的 raw.log，汇报路径（command 的 report）指到它下面的 report.md。
// readOnly 为真时（调研 / 审查类任务）以只读模式构造命令（adapter.command 的 readOnly 参数）。
// onSpawn(pid) 在 spawn 成功之后、写 stdin 之前调用（pipeline 在这里装停止信号）；
// stopped() 为真时（已被外部停止）不再补出错事件，直接交出退出码。
export async function runOnce({
  adapter, label, profile, profileName, settings, detection, workdir, childEnv, paths, registry, id,
  prompt, envError, emit, errors, mapLine, onSpawn, beforeSpawn, stopped,
  attempt = 1, attemptFiles = null, progress = null, readOnly = false, noExitGraceMs = NO_EXIT_GRACE_MS, processTree = busyDescendants,
}) {
  const execDir = longPath(workdir);
  const rawFiles = attemptFiles ? [paths.raw, attemptFiles.raw] : [paths.raw];
  const reportPath = attemptFiles ? attemptFiles.report : paths.report;
  // 原始输出两份都追加（协议 14.2 第 3、4 条）：顶层跨尝试连续，attempts/<n>/ 只有这次。
  const appendRaw = data => { for (const file of rawFiles) appendFileSync(file, data); };
  let command;
  try {
    if (envError) throw envError;
    // report 指到这次的 attempts/<n>/report.md（协议 14.2 第 3 条）；attempt 供假执行者按次回放。
    // readOnly（调研 / 审查类任务）只在为真时传，其余任务的调用参数与原来逐项相同。
    command = adapter.command({ root: execDir, report: reportPath, prompt, settings, detection, env: childEnv, profile, profileName, attempt, ...(readOnly ? { readOnly: true } : {}) });
  } catch (error) {
    // 多行原因（如通用适配器声明的前 3 条校验错误）逐行成事件，进度里每行都看得见。
    const [first, ...rest] = String(error.message).split('\n').filter(line => line.trim());
    emit({ kind: 'error', text: `启动 ${label} 失败：${first ?? ''}` });
    for (const line of rest) emit({ kind: 'error', text: line });
    removeOneShotSandbox(childEnv);
    return { exit: 1, lastSay: null, result: null, stderrTail: '', startFailed: true };
  }
  // 临时文件（{promptFile} 等）：命令构造成功就登记，进程结束（包括失败、被停止）后删除。
  const cleanup = Array.isArray(command.cleanup) ? command.cleanup : [];
  for (const file of cleanup) pendingCleanup.add(file);
  if (cleanup.length) installExitHook();
  // 进度窗口在命令构造成功之后、启动之前打开（与拆分前一致）。
  beforeSpawn?.();
  // 同一个环境上一次尝试的收尾可能已经删掉了一次性目录，再启动前补建。
  reviveOneShotSandbox(childEnv);
  return new Promise(resolveRun => {
    // 执行者结束后顺手删掉环境里的一次性沙箱目录（公共目录建不了时退回的临时目录，D121）；正常的沙箱不动。
    const resolve = value => { removeFiles(cleanup, progress); removeOneShotSandbox(childEnv); resolveRun(value); };
    let child;
    try {
      child = spawn(command.executable, command.args, { cwd: execDir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, windowsVerbatimArguments: command.verbatim === true });
    } catch (error) {
      emit({ kind: 'error', text: `启动 ${label} 失败：${error.message}` });
      resolve({ exit: 1, lastSay: null, result: null, stderrTail: '', startFailed: true });
      return;
    }
    registry({ event: 'spawned', id, codexPid: child.pid ?? null, agentPid: child.pid ?? null, at: Date.now() });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let lastSay = null;
    // 汇报取标准输出全文的适配器才保留：按行拼回，最多 STDOUT_LIMIT 字节，超出的丢弃。
    let stdoutText = adapter.keepStdout === true ? '' : null;
    // 不自行退出的兜底：适配器没有 finalResult（没有结束条件）就不启用。
    // finalResult：看到过的最后一个结果事件 { ok }；timer：距离兜底还有多久的计时；killed：结束进程树的 Promise（只在兜底触发后有）。
    const watchExit = typeof adapter.finalResult === 'function';
    let finalResult = null, timer = null, closed = false, killed = null;
    const reportReady = () => (adapter.writesReport
      ? reportExists(reportPath)
      : adapter.finish?.({ lastSay, result: mapLine.lastResult ?? null, stdoutText }) != null);
    // 到时：汇报已经有了、进程树里也没有还在运行的子进程才动手（执行者把长命令放后台、自己等通知时，也会先给出一条结果）；
    // 有子进程在跑、或查询失败（不能当成"没有子进程"），就重新计时。进程树结束成功后才记"没有自行退出"（close 里等 killed）。
    let outputs = 0;
    const giveUp = async () => {
      timer = null;
      if (closed || stopped() || !finalResult || !child.pid || !reportReady()) return;
      const seen = outputs;
      let busy = true;
      try { busy = (await processTree(child.pid)).length > 0; } catch { /* 查询失败：不结束，重新计时。 */ }
      // 查询期间执行者又有输出（rearm 已重新计时）或已经退出：这一次作废。
      if (closed || stopped() || seen !== outputs || killed) return;
      if (busy) { timer = setTimeout(giveUp, noExitGraceMs); return; }
      killed = killProcessTree(child.pid).then(() => true, error => { progress?.(`结束没有自行退出的执行者失败：${error.message}`); return false; });
    };
    // 任何输出都重新计时（后台任务的通知会让执行者多开几轮，每轮都有一条结果）。
    const rearm = () => {
      outputs++;
      if (!watchExit || !finalResult || closed || killed) return;
      clearTimeout(timer);
      timer = setTimeout(giveUp, noExitGraceMs);
    };
    createInterface({ input: child.stdout }).on('line', line => {
      const at = Date.now();
      if (stdoutText !== null && stdoutText.length < STDOUT_LIMIT) stdoutText = (stdoutText + line + '\n').slice(0, STDOUT_LIMIT);
      let event;
      try { event = JSON.parse(line); } catch { /* 非 JSON 行仍保留原文。 */ }
      appendRaw(`${event && typeof event === 'object' && !Array.isArray(event) ? JSON.stringify({ ...event, _at: at }) : line}\n`);
      const batch = mapLine(line, { root: execDir });
      for (const mapped of batch) {
        if (mapped.kind === 'say') lastSay = mapped.text;
        emit(mapped, at);
      }
      if (watchExit) { finalResult = adapter.finalResult(batch) ?? finalResult; rearm(); }
    });
    // 保留旧行为：stderr 原样存入 raw，不当成 stdout 的事件流。
    let stderr = '';
    child.stderr.on('data', chunk => { appendRaw(chunk); stderr = (stderr + chunk).slice(-4096); rearm(); });
    let failed = false;
    child.on('error', error => { failed = true; emit({ kind: 'error', text: `启动 ${label} 失败：${error.message}` }); });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') emit({ kind: 'error', text: error.message });
    });
    // 安装时机与拆分前一致：spawn 成功之后、写 stdin 之前。
    onSpawn(child.pid ?? null);
    // 没有标准输入内容（通用适配器的 stdin 为 null）时直接关闭。
    if (command.stdin == null) child.stdin.end(); else child.stdin.end(command.stdin, 'utf8');
    // close 在 stdout/stderr 完全排空后触发，避免 exit 提前丢掉最后的汇报事件。
    child.on('close', async exitCode => {
      closed = true;
      clearTimeout(timer);
      // 兜底触发了：等进程树结束的结果；结束成功就按最后的结果事件判定（成功按 0，错误按 1），并记一条"没有自行退出"。
      const noExit = killed && !stopped() && await killed;
      let code = exitCode;
      if (noExit) {
        code = finalResult.ok ? 0 : 1;
        emit({ kind: 'text', text: `执行者没有自行退出：看到结果后 ${graceText(noExitGraceMs)}仍在运行，已结束它的进程（按结果判定）`, noExit: true, result: finalResult.ok ? 'success' : 'error' });
      }
      // 被外部停止：信号处理器会写 interrupted 并以 1 退出；这里不再补出错事件。
      if (stopped()) { resolve({ exit: failed ? 1 : code, lastSay, result: mapLine.lastResult ?? null, stdoutText, stderrTail: stderr, startFailed: failed }); return; }
      // 干活方启动即退出时，原因往往只在 stderr 里（例如 Codex 拒绝在非 git 目录运行），补成出错事件。
      if (!failed && code !== 0) {
        const tail = failureReason(stderr);
        if (tail) emit({ kind: 'error', text: tail });
        // 失败原因可能只在 stderr，也可能在执行者自己的出错事件里（如接口返回 401）：两处一起交给适配器判断。
        const hint = adapter.failureHint?.([stderr, ...errors].join('\n'), { profile });
        if (hint) emit({ kind: 'error', text: hint });
      }
      resolve({ exit: failed ? 1 : code, lastSay, result: mapLine.lastResult ?? null, stdoutText, stderrTail: stderr, startFailed: failed });
    });
  });
}
