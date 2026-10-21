// 假执行者（测试与演示）：按 profile 回放统一事件、按需写文件并提交、写汇报、按指定退出码结束，不访问任何真实 Agent。
// profile 字段（都可选）：events（统一事件数组）、report（汇报正文）、exit（退出码）、delayMs（每条事件之间的间隔）、version、
// releaseFile（只用于测试与演示：等这个文件出现再写汇报）、releaseTimeoutMs（等放行文件的上限，默认 120000）、
// writes（写完事件后按顺序写入的文件，相对项目根）、commit（写完后提交这些文件的提交信息，null 表示不提交）。
import { isAbsolute } from 'node:path';

const kinds = ['say', 'think', 'cmd', 'file', 'plan', 'tool', 'turn', 'error', 'text'];
const defaults = {
  events: [{ kind: 'say', text: '假执行者已完成。' }], report: 'OK\n', exit: 0, delayMs: 0, version: 'fake-agent 1.0',
  releaseFile: null, releaseTimeoutMs: 120000, writes: [], commit: null,
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

const spec = profile => {
  const merged = { ...defaults, ...Object.fromEntries(Object.entries(profile ?? {}).filter(([key]) => key in defaults)) };
  if (!Array.isArray(merged.events) || typeof merged.report !== 'string' || !Number.isInteger(merged.exit) || !(merged.delayMs >= 0)) throw new Error('fake 执行者的 events / report / exit / delayMs 无效');
  if (!(merged.releaseFile === null || (typeof merged.releaseFile === 'string' && merged.releaseFile.trim()))) throw new Error('fake 执行者的 releaseFile 无效');
  if (!(Number.isInteger(merged.releaseTimeoutMs) && merged.releaseTimeoutMs > 0)) throw new Error('fake 执行者的 releaseTimeoutMs 无效');
  if (!Array.isArray(merged.writes) || merged.writes.some(item => !item || typeof item !== 'object' || Array.isArray(item)
    || !validWritePath(item.path) || typeof item.content !== 'string')) throw new Error('fake 执行者的 writes 无效');
  if (!(merged.commit === null || (typeof merged.commit === 'string' && merged.commit.trim() !== ''))) throw new Error('fake 执行者的 commit 无效');
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
    const { events, report: text, exit, delayMs, releaseFile, releaseTimeoutMs, writes, commit } = spec(profile);
    // 没有设置放行文件 / 写入 / 提交时，回放说明与原来逐字节一致（不带这些字段）。
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
