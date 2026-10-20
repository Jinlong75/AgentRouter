// 诊断追踪：只在环境变量 AR_CORE_TRACE=1 时向标准错误写阶段时刻（自进程启动起的毫秒数），平时什么都不做。
// 软件的界面验收会打开它，用来定位核心进程卡在哪一步（Node 启动、加载模块、某条 git 子进程……）。标准输出的 JSON 不受影响。
import { performance } from 'node:perf_hooks';

const on = process.env.AR_CORE_TRACE === '1';
export const tracing = on;
export function trace(label) {
  // +ms：自进程启动起；@ms：墙上时间（与软件主进程的 Date.now() 同一时钟，可直接对齐）。
  if (on) process.stderr.write(`[ar-trace] +${Math.round(performance.now())}ms @${Date.now()} ${label}\n`);
}
// 同步调用计时：开始与结束各记一行，卡住时能看到"开始了但没结束"的那一步。
export function traced(label, run) {
  if (!on) return run();
  const started = performance.now();
  trace(`${label} 开始`);
  try { return run(); }
  finally { trace(`${label} 结束 ${Math.round(performance.now() - started)}ms`); }
}
// 异步调用计时：文字与 traced 相同；多个调用并发时，这两行会按各自开始/结束的时刻交错。
export async function tracedAsync(label, run) {
  if (!on) return run();
  const started = performance.now();
  trace(`${label} 开始`);
  try { return await run(); }
  finally { trace(`${label} 结束 ${Math.round(performance.now() - started)}ms`); }
}
trace('追踪模块已加载');
