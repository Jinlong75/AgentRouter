import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stopTask } from '../../core/lib/stop.mjs';
import { registryWriter } from '../../core/lib/records.mjs';
import { killProcessTree } from '../../core/lib/process.mjs';
const script = new URL('../../core/ar.mjs', import.meta.url);
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dispatchdock-stop-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const record = registryWriter(home), file = join(home, 'runs.jsonl');
  return { home, file, record, start: { event:'start', id:'sample', repo:home, name:'中文 空格', pid:process.pid, started:Date.now() } };
}
test('停止参数必须有且只有一个记录名', t => {
  const f = fixture(t);
  const env = { ...process.env, CODEX_DISPATCH_HOME: f.home };
  // 本用例只设旧名；终端里设着新名时新名优先（协议 1），会盖掉隔离目录。
  // 复制出来的是普通对象，Windows 上要自己按不区分大小写删。
  for (const key of Object.keys(env)) if (process.platform === 'win32' ? key.toLowerCase() === 'agent_router_home' : key === 'AGENT_ROUTER_HOME') delete env[key];
  for (const args of [[], ['--name'], ['a','b'], ['']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(script), '--stop', ...args], { env, encoding:'utf8',windowsHide:true });
    assert.equal(result.status,2); assert.equal(result.stderr.trim(),'用法：ar stop <记录名>');
  }
});
test('找不到、已经结束和身份不符不结束进程', async t => {
  const f = fixture(t), output = [], options = { log:s=>output.push(s), killTree:()=>assert.fail('不应结束进程') };
  assert.equal(await stopTask(f.home,f.home,'中文 空格',options),2);
  assert.equal(output.pop(),'停止：在当前仓库找不到记录 中文 空格');
  f.record(f.start);
  // 102 改写：下面两种"查不出来 / 说不准"的情形仍然不结束进程、不写记录，退出码 1（原断言不变）。
  for (const info of [null, {created:null,command:'codex-task.mjs'}]) {
    assert.equal(await stopTask(f.home,f.home,'中文 空格',{...options,info:async()=>info}),1);
  }
  assert.equal(readFileSync(f.file,'utf8').trim().split('\n').length,1,'没有追加任何记录');
  // 102 改写：本测试进程命令行不包含派发入口，实际查询认定它不是原派发进程（PID 已被复用）。
  // 原断言 退出码 1、输出 '停止：中文 空格 的进程已经不在了' → 新断言 退出码 0、输出 '…，已记为中断（派发进程意外退出）'，清单多一条 process-gone；
  // 原因：任务说明 102——确认原派发进程已经不在时补写 interrupted。创建时间晚于 started 的那一条同理，单独用一个新任务测。
  assert.equal(await stopTask(f.home,f.home,'中文 空格',options),0);
  assert.equal(output.pop(),'停止：中文 空格 的进程已经不在了，已记为中断（派发进程意外退出）');
  assert.equal(JSON.parse(readFileSync(f.file,'utf8').trim().split('\n').at(-1)).signal,'process-gone');
  const later = fixture(t); later.record(later.start);
  assert.equal(await stopTask(later.home,later.home,'中文 空格',{...options,info:async()=>({created:Date.now()+10000,command:'node codex-task.mjs'})}),0);
  assert.equal(output.pop(),'停止：中文 空格 的进程已经不在了，已记为中断（派发进程意外退出）');
  f.record({event:'end',id:'sample',exit:0});
  assert.equal(await stopTask(f.home,f.home,'中文 空格',options),0);
  assert.equal(output.pop(),'停止：中文 空格（已经结束）');
});
test('停止成功隔开尾部半行，失败不追加记录', async t => {
  const f=fixture(t); f.record(f.start); appendFileSync(f.file,'broken half');
  const before=readFileSync(f.file,'utf8'), output=[];
  const options={info:async()=>({created:0,command:'node codex-task.mjs'}),alive:async()=>true,log:s=>output.push(s)};
  assert.equal(await stopTask(f.home,f.home,'中文 空格',{...options,killTree:async()=>{throw Error('测试超时');}}),1);
  assert.equal(readFileSync(f.file,'utf8'),before);assert.equal(output.pop(),'停止：中文 空格 没能停下（测试超时）');
  assert.equal(await stopTask(f.home,f.home,'中文 空格',{...options,killTree:async()=>{}}),0);
  assert.match(readFileSync(f.file,'utf8'),/broken half\n\{"v":1,"event":"interrupted"/);
});
test('新入口 ar.mjs 派发的任务同样能停止，其他脚本不行', async t => {
  // 102 改写：其他脚本（PID 已被复用）原断言 退出码 1 → 新断言 退出码 0 且补写 process-gone；仍然不结束进程（killed 为 false）。
  // 原因：任务说明 102——确认原派发进程已经不在时补写 interrupted；真正的 ar.mjs 派发进程仍被结束，signal 为 stopped-by-command。
  for (const [command, killedExpected, signal] of [['node "C:\\示例\\core\\ar.mjs" 只回复 OK',true,'stopped-by-command'],['node other.mjs',false,'process-gone']]) {
    const f=fixture(t); f.record(f.start); let killed=false;
    const code=await stopTask(f.home,f.home,'中文 空格',{info:async()=>({created:0,command}),alive:async()=>true,killTree:async()=>{killed=true;},log:()=>{}});
    assert.equal(code,0); assert.equal(killed,killedExpected);
    assert.equal(JSON.parse(readFileSync(f.file,'utf8').trim().split('\n').at(-1)).signal,signal);
  }
});

// 060 跨尝试读取（协议 14.4）：resume 之后按 resume.pid 与 resume.at 核对与结束。
test('resume 之后用 resume.pid 核对与结束，写 interrupted；resume 之前的 end 不算数', async t => {
  const f = fixture(t);
  f.record(f.start);
  f.record({ event: 'end', id: 'sample', exit: 1 });
  f.record({ event: 'resume', id: 'sample', pid: 424242, n: 2, at: Date.now() });
  const queried = [];
  let killed = null;
  const code = await stopTask(f.home, f.home, '中文 空格', {
    info: async pid => { queried.push(pid); return { created: 0, command: 'node "C:\\示例\\core\\ar.mjs" dispatch 任务' }; },
    alive: async () => true,
    killTree: async pid => { killed = pid; },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.deepEqual(queried, [424242], '进程身份核对用 resume.pid，不是最初的 start.pid');
  assert.equal(killed, 424242, '结束的是 resume 的进程');
  const last = JSON.parse(readFileSync(f.file, 'utf8').trim().split('\n').at(-1));
  assert.equal(last.event, 'interrupted');
  assert.equal(last.id, 'sample');
  assert.equal(last.signal, 'stopped-by-command');
});

test('resume 之后已经有新的 end：按"已经结束"处理，不结束进程', async t => {
  const f = fixture(t);
  const output = [];
  const options = { log: s => output.push(s), killTree: () => assert.fail('不应结束进程') };
  f.record(f.start);
  f.record({ event: 'end', id: 'sample', exit: 1 });
  f.record({ event: 'resume', id: 'sample', pid: 424242, n: 2, at: Date.now() });
  f.record({ event: 'end', id: 'sample', exit: 0, at: Date.now() });
  assert.equal(await stopTask(f.home, f.home, '中文 空格', options), 0);
  assert.equal(output.pop(), '停止：中文 空格（已经结束）');
});
// 102：真实启动一个假派发进程，结束它但不写任何结束记录（模拟意外退出），再运行真实的 ar stop。
test('派发进程意外退出、没写结束记录：ar stop 补写 interrupted（process-gone）并如实报告，再停一次是"已经结束"', async t => {
  const f = fixture(t);
  const env = { ...process.env, AGENT_ROUTER_HOME: f.home, AR_NO_WATCH: '1' };
  for (const key of ['CODEX_DISPATCH_HOME', 'AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  const fake = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true, shell: false });
  t.after(() => { try { fake.kill(); } catch { /* 已经退出。 */ } });
  const closed = new Promise(resolve => fake.on('close', resolve));
  assert.ok(Number.isSafeInteger(fake.pid));
  f.record({ ...f.start, pid: fake.pid, started: Date.now() });
  fake.kill(); // 只结束自己启动的这一个进程；没有信号处理的机会，也就没有结束记录
  await closed;
  const before = readFileSync(f.file, 'utf8');
  const run = () => spawnSync(process.execPath, [fileURLToPath(script), 'stop', '中文 空格'], { cwd: f.home, env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const first = run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(first.stdout.trim(), '停止：中文 空格 的进程已经不在了，已记为中断（派发进程意外退出）');
  const after = readFileSync(f.file, 'utf8');
  assert.ok(after.startsWith(before), '原有记录原样保留');
  const added = after.slice(before.length).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(added.length, 1, '只多一条');
  assert.equal(added[0].event, 'interrupted');
  assert.equal(added[0].id, 'sample');
  assert.equal(added[0].signal, 'process-gone');
  assert.ok(Number.isFinite(added[0].at));
  const second = run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(second.stdout.trim(), '停止：中文 空格（已经结束）');
  assert.equal(readFileSync(f.file, 'utf8'), after, '第二次不重复写');
});
test('平台树结束必须等待子孙退出，超时失败', async () => {
  const calls=[];
  await assert.rejects(killProcessTree(123456,{platform:'win32',timeout:30,list:async()=>[{pid:123456,parent:0,created:1},{pid:123457,parent:123456,created:2}],executeFile:async(...args)=>calls.push(args),alive:pid=>pid===123457}),/超时/);
  // 049：先结束根、再结束其余子孙；这里根已不在，第一次结束调用针对仅存的子孙，且不带 /T。
  assert.deepEqual(calls[0].slice(0,2),['taskkill.exe',['/PID','123457','/F']]);
});
test('平台树结束：根存活时第一次结束调用针对根且不带 /T，子孙不退出仍按时限失败', async () => {
  // 049 用户要求补充：上一条用例的根已不在，这里根存活，核对原断言里"首次调用针对根"的意图。
  const calls=[], live=new Set([123456,123457]);
  await assert.rejects(killProcessTree(123456,{platform:'win32',timeout:30,list:async()=>[{pid:123456,parent:0,created:1},{pid:123457,parent:123456,created:2}],executeFile:async(...args)=>{calls.push(args); if(args[1].includes('123456')) live.delete(123456);},alive:pid=>live.has(pid)}),/超时/);
  assert.deepEqual(calls[0].slice(0,2),['taskkill.exe',['/PID','123456','/F']]);
  assert.ok(calls.every(call=>!call[1].includes('/T')));
});
test('进程树快照发现 PID 已复用时拒绝结束', async () => {
  await assert.rejects(killProcessTree(123456, { expectedCreated:1, list:async()=>[{pid:123456,parent:0,created:2}], executeFile:()=>assert.fail('不应结束进程') }), /身份已经变化/);
});
