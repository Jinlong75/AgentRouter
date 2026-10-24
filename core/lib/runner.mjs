// 一次执行者运行：构造命令、启动子进程、写 spawned、把原始输出与统一事件落盘、收集失败信息。
// 门禁、汇报、清单收尾与信号处理由 pipeline.mjs 负责；本模块不写 gate / end / attempt-end，也不结束进程树。
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// runOnce(ctx) 返回 Promise<{ exit, lastSay, result, stderrTail, startFailed }>：
// - exit：执行者退出码；启动失败与 child.on('error') 一律按 1。
// - startFailed：执行者没能启动（缺密钥、adapter.command 出错、spawn 失败）；pipeline 不重试这种情况（协议 14.1）。
// - lastSay：最后一条说话事件（没有就是 null），适配器不写汇报时由 pipeline 用作汇报正文。
// - result：有状态映射（createMapper）留下的最后结果，交给 adapter.finish。
// - stderrTail：最多 4096 字符的 stderr 尾部（失败原因常只出现在这里）。
// workdir 是执行者的工作目录：非 worktree 模式就是项目根，worktree 模式是任务自己的 worktree（协议 15.2）；
// 记录目录（paths）不受影响，始终在项目主工作区。
// attemptFiles 是这次尝试的目录（attempts/<n>/，prompt.md 已由 pipeline 写好）：
// 原始输出同时追加到顶层 raw.log 与它下面的 raw.log，汇报路径（command 的 report）指到它下面的 report.md。
// onSpawn(pid) 在 spawn 成功之后、写 stdin 之前调用（pipeline 在这里装停止信号）；
// stopped() 为真时（已被外部停止）不再补出错事件，直接交出退出码。
export async function runOnce({
  adapter, label, profile, settings, detection, workdir, childEnv, paths, registry, id,
  prompt, envError, emit, errors, mapLine, onSpawn, beforeSpawn, stopped,
  attempt = 1, attemptFiles = null,
}) {
  const rawFiles = attemptFiles ? [paths.raw, attemptFiles.raw] : [paths.raw];
  const reportPath = attemptFiles ? attemptFiles.report : paths.report;
  // 原始输出两份都追加（协议 14.2 第 3、4 条）：顶层跨尝试连续，attempts/<n>/ 只有这次。
  const appendRaw = data => { for (const file of rawFiles) appendFileSync(file, data); };
  let command;
  try {
    if (envError) throw envError;
    // report 指到这次的 attempts/<n>/report.md（协议 14.2 第 3 条）；attempt 供假执行者按次回放。
    command = adapter.command({ root: workdir, report: reportPath, prompt, settings, detection, env: childEnv, profile, attempt });
  } catch (error) {
    emit({ kind: 'error', text: `启动 ${label} 失败：${error.message}` });
    return { exit: 1, lastSay: null, result: null, stderrTail: '', startFailed: true };
  }
  // 进度窗口在命令构造成功之后、启动之前打开（与拆分前一致）。
  beforeSpawn?.();
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command.executable, command.args, { cwd: workdir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch (error) {
      emit({ kind: 'error', text: `启动 ${label} 失败：${error.message}` });
      resolve({ exit: 1, lastSay: null, result: null, stderrTail: '', startFailed: true });
      return;
    }
    registry({ event: 'spawned', id, codexPid: child.pid ?? null, agentPid: child.pid ?? null, at: Date.now() });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let lastSay = null;
    createInterface({ input: child.stdout }).on('line', line => {
      const at = Date.now();
      let event;
      try { event = JSON.parse(line); } catch { /* 非 JSON 行仍保留原文。 */ }
      appendRaw(`${event && typeof event === 'object' && !Array.isArray(event) ? JSON.stringify({ ...event, _at: at }) : line}\n`);
      for (const mapped of mapLine(line, { root: workdir })) {
        if (mapped.kind === 'say') lastSay = mapped.text;
        emit(mapped, at);
      }
    });
    // 保留旧行为：stderr 原样存入 raw，不当成 stdout 的事件流。
    let stderr = '';
    child.stderr.on('data', chunk => { appendRaw(chunk); stderr = (stderr + chunk).slice(-4096); });
    let failed = false;
    child.on('error', error => { failed = true; emit({ kind: 'error', text: `启动 ${label} 失败：${error.message}` }); });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') emit({ kind: 'error', text: error.message });
    });
    // 安装时机与拆分前一致：spawn 成功之后、写 stdin 之前。
    onSpawn(child.pid ?? null);
    child.stdin.end(command.stdin, 'utf8');
    // close 在 stdout/stderr 完全排空后触发，避免 exit 提前丢掉最后的汇报事件。
    child.on('close', code => {
      // 被外部停止：信号处理器会写 interrupted 并以 1 退出；这里不再补出错事件。
      if (stopped()) { resolve({ exit: failed ? 1 : code, lastSay, result: mapLine.lastResult ?? null, stderrTail: stderr, startFailed: failed }); return; }
      // 干活方启动即退出时，原因往往只在 stderr 里（例如 Codex 拒绝在非 git 目录运行），补成出错事件。
      if (!failed && code !== 0) {
        const tail = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-5).join('\n');
        if (tail) emit({ kind: 'error', text: tail });
        // 失败原因可能只在 stderr，也可能在执行者自己的出错事件里（如接口返回 401）：两处一起交给适配器判断。
        const hint = adapter.failureHint?.([stderr, ...errors].join('\n'), { profile });
        if (hint) emit({ kind: 'error', text: hint });
      }
      resolve({ exit: failed ? 1 : code, lastSay, result: mapLine.lastResult ?? null, stderrTail: stderr, startFailed: failed });
    });
  });
}
