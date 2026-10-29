// 假的 Claude Code（测试用，经 AR_TEST_AGENT 指定）：输出 stream-json 的结果事件之后按模式挂住 / 多开一轮 / 退出，用来测"执行者不自行退出"的兜底。
// 环境变量：
//   AR_TEST_NOEXIT_MODE  quick（结果后立刻退出）、hang（成功结果后挂住，进程树里只有自己）、hang-error（错误结果后挂住）、
//                        bg-child（起一个跑 BG 毫秒的子进程，立刻给出成功结果后挂住）、
//                        more（结果后过 GAP 毫秒再输出一轮并再给一条更长的结果，再过 GAP 毫秒退出）、silent（没有结果事件，挂 HOLD 毫秒后正常退出）
//   AR_TEST_NOEXIT_GAP_MS / AR_TEST_NOEXIT_HOLD_MS / AR_TEST_NOEXIT_BG_MS  more / silent / bg-child 模式的时间
//   AR_TEST_PID_FILE     hang 类模式把自己和子进程（没有就是 null）的 pid 写到这个文件（JSON），并带上各自的创建时间 agentCreated / childCreated（毫秒，查不到为 null）
// 挂住的模式有 60 秒的保险：即使兜底没有生效，进程也会自己退出，不会留下孤儿。
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { processCreated } from '../../../core/lib/process.mjs';

if (process.argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }
const env = process.env;
const mode = env.AR_TEST_NOEXIT_MODE ?? 'quick';
const gap = Number(env.AR_TEST_NOEXIT_GAP_MS ?? 1000), hold = Number(env.AR_TEST_NOEXIT_HOLD_MS ?? 4000);
const out = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const say = text => out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = (text, error = false) => out({ type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: error, result: text, usage: { input_tokens: 10, output_tokens: 5 } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SAFETY_MS = 60000;

process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', async () => {
  out({ type: 'system', subtype: 'init', model: 'fake-no-exit' });
  say('开始');
  // 退出都靠事件循环排空自然结束（不调 process.exit），免得管道里的输出没写完就被截断。
  if (mode === 'silent') {
    await wait(hold);
    return;
  }
  if (mode === 'quick') { result('完成'); return; }
  if (mode === 'more') {
    result('等通知');
    await wait(gap);
    say('收到后台任务的通知');
    result('最终汇报：后台任务也完成了');
    await wait(gap);
    return;
  }
  // bg-child：模拟"把长命令放后台、说一句等通知"：起一个跑 BG 毫秒的子进程，立刻给出结果，然后挂住（子进程退出后仍不退出）。
  // hang / hang-error：进程树里只有自己，给出结果后挂住。
  const bg = mode === 'bg-child' ? spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${Number(env.AR_TEST_NOEXIT_BG_MS ?? 4000)})`], { stdio: 'ignore', windowsHide: true, shell: false }) : null;
  // 同时写下创建时间（进程身份 = PID + 创建时间，协议第 9 节）：负载高时 PID 会被复用，测试只看 PID 会把别的新进程当成它。
  if (env.AR_TEST_PID_FILE) {
    const created = async pid => (pid == null ? null : await processCreated(pid).catch(() => null));
    writeFileSync(env.AR_TEST_PID_FILE, JSON.stringify({ agent: process.pid, child: bg?.pid ?? null, agentCreated: await created(process.pid), childCreated: await created(bg?.pid) }));
  }
  if (mode === 'hang-error') result('执行失败：出错了', true); else result('完成');
  setTimeout(() => {}, SAFETY_MS);
});
