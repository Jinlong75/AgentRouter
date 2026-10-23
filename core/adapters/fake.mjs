// 假执行者（测试与演示）：按 profile 回放统一事件、按需写文件并提交、写汇报、按指定退出码结束，不访问任何真实 Agent。
// profile 字段（都可选）：events（统一事件数组）、report（汇报正文）、exit（退出码）、delayMs（每条事件之间的间隔）、version、
// releaseFile（只用于测试与演示：等这个文件出现再写汇报）、releaseTimeoutMs（等放行文件的上限，默认 120000）、
// writes（写完事件后按顺序写入的文件，相对项目根）、commit（写完后提交这些文件的提交信息，null 表示不提交）、
// attempts（Stage05 058：按第几次尝试改写上面的回放字段，键是 1 起的尝试次数，值是局部覆盖；测试重试流程用）。
import { isAbsolute } from 'node:path';

const kinds = ['say', 'think', 'cmd', 'file', 'plan', 'tool', 'turn', 'error', 'text'];
// 回放字段：进子进程回放说明的字段。attempts 是它们的按次覆盖，本身不进回放说明。
const playbackKeys = ['events', 'report', 'exit', 'delayMs', 'releaseFile', 'releaseTimeoutMs', 'writes', 'commit'];
const defaults = {
  events: [{ kind: 'say', text: '假执行者已完成。' }], report: 'OK\n', exit: 0, delayMs: 0, version: 'fake-agent 1.0',
  releaseFile: null, releaseTimeoutMs: 120000, writes: [], commit: null, attempts: {},
};

// 子进程里运行：argv[1] 是回放说明（JSON），argv[2] 是汇报路径；先读完 stdin（任务指令）再输出。
// 设置了 releaseFile 时，回放完事件后按短间隔等它出现；超时写一行 stderr、以非 0 退出且不写汇报，不会无限挂着。
// writes 在回放（与放行）之后、写汇报之前按顺序写入；commit 非 null 时只把 writes 里的路径放进这次提交（参数数组、不经 shell）。
// TODO(lead): 协议没写提交失败时假执行者该怎么做；暂时写一行 stderr、以 1 退出且不写汇报（与放行超时一致）。
const runner = `const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const spec=JSON.parse(process.argv[1]);const report=process.argv[2];
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',async()=>{
for(const e of spec.events){process.stdout.write(JSON.stringify(e)+'\\n');if(spec.delayMs>0)await new Promise(r=>setTimeout(r,spec.delayMs));}
if(spec.releaseFile){const started=Date.now();while(!fs.existsSync(spec.releaseFile)){if(Date.now()-started>=spec.releaseTimeoutMs){process.stderr.write('假执行者等待放行文件超时（'+spec.releaseTimeoutMs+' 毫秒），没有写汇报\\n');process.exitCode=2;return;}await new Promise(r=>setTimeout(r,100));}}
for(const w of spec.writes??[]){const file=path.resolve(process.cwd(),w.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,w.content);}
if(spec.commit!=null){const paths=spec.writes.map(w=>w.path);const run=(args)=>cp.spawnSync('git',args,{cwd:process.cwd(),windowsHide:true,shell:false,encoding:'utf8'});const add=run(['add','--',...paths]);const commit=add.status===0?run(['commit','-m',spec.commit,'--',...paths]):null;if(add.status!==0||!commit||commit.status!==0){const reason=((add.stderr||'')+((commit&&commit.stderr)||'')).trim()||'git 返回非 0';process.stderr.write('假执行者提交失败：'+reason+'\\n');process.exitCode=1;return;}}
fs.writeFileSync(report,spec.report);process.exitCode=spec.exit;});`;

// 写入路径必须是相对项目根、用 / 分隔，且不含 .. 段。
const validWritePath = value => typeof value === 'string' && value.trim() !== '' && !value.includes('\\') && !isAbsolute(value)
  && !value.split('/').some(segment => segment === '..');

// 回放字段的取值校验（基础与每次尝试的覆盖合并后都要过）。
function checkPlayback(value) {
  if (!Array.isArray(value.events) || typeof value.report !== 'string' || !Number.isInteger(value.exit) || !(value.delayMs >= 0)) throw new Error('fake 执行者的 events / report / exit / delayMs 无效');
  if (!(value.releaseFile === null || (typeof value.releaseFile === 'string' && value.releaseFile.trim()))) throw new Error('fake 执行者的 releaseFile 无效');
  if (!(Number.isInteger(value.releaseTimeoutMs) && value.releaseTimeoutMs > 0)) throw new Error('fake 执行者的 releaseTimeoutMs 无效');
  if (!Array.isArray(value.writes) || value.writes.some(item => !item || typeof item !== 'object' || Array.isArray(item)
    || !validWritePath(item.path) || typeof item.content !== 'string')) throw new Error('fake 执行者的 writes 无效');
  if (!(value.commit === null || (typeof value.commit === 'string' && value.commit.trim() !== ''))) throw new Error('fake 执行者的 commit 无效');
}

// 第 attempt 次的回放说明：基础字段先合并，再用 attempts[attempt] 覆盖。attempts 的形状每次都说清楚，
// 顺带把声明了的每次覆盖都校验一遍（别等到那次尝试才炸）。
const spec = (profile, attempt = 1) => {
  const merged = { ...defaults, ...Object.fromEntries(Object.entries(profile ?? {}).filter(([key]) => key in defaults)) };
  const attempts = merged.attempts;
  if (!attempts || typeof attempts !== 'object' || Array.isArray(attempts)) throw new Error('fake 执行者的 attempts 无效');
  for (const [key, value] of Object.entries(attempts)) {
    if (!/^[1-9][0-9]*$/.test(key)) throw new Error('fake 执行者的 attempts 键必须是 1 起的尝试次数');
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(item => !playbackKeys.includes(item))) {
      throw new Error('fake 执行者的 attempts 覆盖只能改回放字段');
    }
    checkPlayback({ ...merged, ...value });
  }
  const effective = { ...merged, ...(attempts[String(attempt)] ?? {}) };
  checkPlayback(effective);
  return effective;
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
  // 托管 / 脱离派发时，回放说明（含 attempts 的按次覆盖）随请求的执行者快照一起带给执行者进程（见 run.mjs 的 profileConfig）。
  snapshotKeys: Object.keys(defaults),
  detect({ profile } = {}) {
    try { return { installed: true, version: spec(profile).version }; }
    catch (error) { return { installed: false, version: null, error: error.message }; }
  },
  command({ report, prompt, profile, attempt = 1 }) {
    const { events, report: text, exit, delayMs, releaseFile, releaseTimeoutMs, writes, commit } = spec(profile, attempt);
    // 没有设置放行文件 / 写入 / 提交时，回放说明与原来逐字节一致（不带这些字段；attempts 也不进回放说明）。
    const playback = {
      events, report: text, exit, delayMs,
      ...(releaseFile === null ? {} : { releaseFile, releaseTimeoutMs }),
      ...(writes.length ? { writes } : {}),
      ...(commit === null ? {} : { commit }),
    };
    return { executable: process.execPath, args: ['-e', runner, JSON.stringify(playback), report], stdin: prompt };
  },
  mapLine,
};
