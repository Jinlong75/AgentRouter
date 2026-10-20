// 假执行者（测试与演示）：按 profile 回放统一事件、写汇报、按指定退出码结束，不访问任何真实 Agent。
// profile 字段（都可选）：events（统一事件数组）、report（汇报正文）、exit（退出码）、delayMs（每条事件之间的间隔）、version。
const kinds = ['say', 'think', 'cmd', 'file', 'plan', 'tool', 'turn', 'error', 'text'];
const defaults = { events: [{ kind: 'say', text: '假执行者已完成。' }], report: 'OK\n', exit: 0, delayMs: 0, version: 'fake-agent 1.0' };

// 子进程里运行：argv[1] 是回放说明（JSON），argv[2] 是汇报路径；先读完 stdin（任务指令）再输出。
const runner = `const fs=require('node:fs');const spec=JSON.parse(process.argv[1]);const report=process.argv[2];
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',async()=>{
for(const e of spec.events){process.stdout.write(JSON.stringify(e)+'\\n');if(spec.delayMs>0)await new Promise(r=>setTimeout(r,spec.delayMs));}
fs.writeFileSync(report,spec.report);process.exitCode=spec.exit;});`;

const spec = profile => {
  const merged = { ...defaults, ...Object.fromEntries(Object.entries(profile ?? {}).filter(([key]) => key in defaults)) };
  if (!Array.isArray(merged.events) || typeof merged.report !== 'string' || !Number.isInteger(merged.exit) || !(merged.delayMs >= 0)) throw new Error('fake 执行者的 events / report / exit / delayMs 无效');
  return merged;
};

export function mapLine(line) {
  let e;
  try { e = JSON.parse(line); } catch { return line.trim() ? [{ kind: 'text', text: line }] : []; }
  return e && typeof e === 'object' && !Array.isArray(e) && kinds.includes(e.kind) ? [e] : [];
}

export const fake = {
  id: 'fake',
  label: '假执行者',
  writesReport: true,
  // 托管 / 脱离派发时，回放说明随请求的执行者快照一起带给执行者进程（见 run.mjs 的 profileConfig）。
  snapshotKeys: Object.keys(defaults),
  detect({ profile } = {}) {
    try { return { installed: true, version: spec(profile).version }; }
    catch (error) { return { installed: false, version: null, error: error.message }; }
  },
  command({ report, prompt, profile }) {
    const { events, report: text, exit, delayMs } = spec(profile);
    return { executable: process.execPath, args: ['-e', runner, JSON.stringify({ events, report: text, exit, delayMs }), report], stdin: prompt };
  },
  mapLine,
};
