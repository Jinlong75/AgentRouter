import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp as makeTemp,rm,writeFile,readFile,appendFile,mkdir,symlink,readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// 186：本文件建的临时目录都登记下来，所有测试跑完后统一删掉（被占用删不掉就重试几次，仍不行就忽略）。
const madeTemp:string[]=[];
const mkdtemp=async(prefix:string)=>{const dir=await makeTemp(prefix);madeTemp.push(dir);return dir;};
after(async()=>{for(const dir of madeTemp)await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});});
import { parseRegistry, RegistryReader, statusOf, Registry, importTasks, validRecordName, matchTime } from '../../app/src/main/registry';
import { dispatchMatches } from '../../app/src/main/platform';
import { parseEvent,readEvents,PAGE_BYTES } from '../../app/src/main/events';
import { commitFrom,markdown } from '../../app/src/shared/markdown';
import { combine } from '../../app/src/renderer/timeline';
import { appDataDir, migrateAppData } from '../../app/src/main/app-data';
import { executorTag, executorLabel, isCodexTask } from '../../app/src/shared/executor';
import { worktreeState, type Task } from '../../app/src/shared/types';
const row=(extra={})=>({v:1,event:'start',id:'sample',repo:path.resolve('/demo/project'),name:'task',title:'演示',spec:null,role:null,pid:42,started:100000,progress:path.resolve('/demo/project/task.progress.log'),report:path.resolve('/demo/project/task.md'),model:null,effort:null,tier:null,...extra});
const lines=(...rows:unknown[])=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
const ps={pid:42,name:'node.exe',command:'node "C:\\demo\\codex-task.mjs"',created:99000};
const fixture=async()=>{const home=await mkdtemp(path.join(os.tmpdir(),'dispatchdock-test-'));await mkdir(path.join(home,'monitor'));const entry=row({repo:home,progress:path.join(home,'task.progress.log'),report:path.join(home,'task.md'),events:path.join(home,'task.events.jsonl')});await writeFile(path.join(home,'runs.jsonl'),lines(entry));return {home,entry,task:parseRegistry(lines(entry))[0]};};
test('清单合并、半行、坏行、未知字段，end 始终优先于 interrupted',()=>{
  const end={v:1,event:'end',id:'sample',exit:0,at:110000,minutes:1},stop={v:1,event:'interrupted',id:'sample',at:105000,signal:'stopped-by-app'};
  for(const middle of [[stop,end],[end,stop]]){const parsed=parseRegistry(lines(row({future:'ignore'}))+'broken\n'+lines(...middle)+JSON.stringify(row({id:'half'})));assert.equal(parsed.length,1);assert.equal(parsed[0].status,'done');assert.equal('future' in parsed[0],false);}
  assert.equal(parseRegistry(lines(row(),stop))[0].status,'stop');assert.equal(parseRegistry(lines(row(),{...end,exit:null}))[0].status,'fail');
});
test('进程核对拒绝复用 PID、错误进程、未来创建时间与超过 60 秒',()=>{const t=parseRegistry(lines(row()))[0];assert.equal(statusOf(t,[ps]),'run');for(const p of [{...ps,name:'cmd.exe'},{...ps,command:'node unrelated.mjs'},{...ps,created:100001},{...ps,created:40000},{...ps,pid:43}])assert.equal(statusOf(t,[p]),'stop');assert.equal(dispatchMatches(ps,100000),true);});
test('清单增量与截断恢复',async()=>{const {home,entry}=await fixture(),file=path.join(home,'runs.jsonl'),reader=new RegistryReader();assert.equal((await reader.read(file)).length,1);await appendFile(file,JSON.stringify({v:1,event:'end',id:'sample',exit:0,at:2}));assert.equal((await reader.read(file))[0].status,'run');await appendFile(file,'\n');assert.equal((await reader.read(file))[0].status,'done');await writeFile(file,lines({...entry,id:'new'}));assert.equal((await reader.read(file))[0].id,'new');});
test('事件尾页、增量半行与前向翻页按字节限制，未知事件忽略',async()=>{const {task}=await fixture();const make=(seq:number)=>({v:1,seq,at:seq,kind:'say',text:'中文'.repeat(60)});const source=Array.from({length:9000},(_,i)=>make(i+1));await writeFile(task.events!,lines(...source));const page=await readEvents(task);assert.ok(page.cursor.start>0);assert.ok(page.cursor.end-page.cursor.start<=PAGE_BYTES);assert.equal(page.events.at(-1)?.seq,9000);const before=await readEvents(task,page.cursor,true);assert.ok(before.events.length>0);assert.ok(before.events.at(-1)!.seq<page.events[0].seq);assert.equal(before.cursor.end,page.cursor.end);const next=make(9001);await appendFile(task.events!,JSON.stringify(next));assert.equal((await readEvents(task,page.cursor)).events.length,0);await appendFile(task.events!,'\n'+lines({v:1,seq:9002,at:0,kind:'future'}));const update=await readEvents(task,page.cursor);assert.equal(update.events.length,1);assert.equal(update.events[0].text,next.text);await writeFile(task.events!,lines(make(1)));assert.equal((await readEvents(task,update.cursor)).reset,true);});
test('旧进度解析包括错误、计划、命令失败与统一文件事件；不读取原始 log',async()=>{assert.equal(parseEvent('[12:00:00] 错误：失败',0,true)?.kind,'error');assert.equal(parseEvent('[12:00:00] 出错：失败',0,true)?.kind,'error');assert.deepEqual(parseEvent('[12:00:00] 计划：[x] 第一步 [ ] 第二步',0,true)?.items,[{text:'第一步',done:true},{text:'第二步',done:false}]);assert.equal(parseEvent('[12:00:00]   命令失败（exit 1）：npm test',0,true)?.exit,1);assert.equal(parseEvent('[12:00:00] 新增文件：src/demo.ts',0,true)?.files?.[0].kind,'add');const {task}=await fixture();task.raw=task.progress.replace('.progress.log','.log');await writeFile(task.raw,'private raw');await writeFile(task.progress,'[12:00:00] 说：进度\n');assert.equal((await readEvents(task)).events[0].text,'进度');});
test('提交号与安全 Markdown，只允许 http(s) 链接，无 HTML 执行',()=>{assert.equal(commitFrom('`123456` `4f2a9c1` `b81e0d2`'),'4f2a9c1');assert.equal(commitFrom('`1234567890123`'),undefined);const html=markdown('# 汇报\n<script>alert(1)</script>\n[bad](javascript:alert)\n[ok](https://example.org/)\n## TODO(design) 1 条\n- 待定\n## 推断清单\n1. 一项\n```html\n<img src=x onerror=alert(1)>\n```');assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes('href="https://example.org/"'));assert.equal((html.match(/class="hl brand"/g)??[]).length,2);assert.equal((markdown('## TODO(lead) 1 条\n- 待定').match(/class="hl brand"/g)??[]).length,1);});
test('parseEvent 保留合法的 attempt，其余取值不写这个字段',()=>{const raw={v:1,seq:3,at:5,kind:'say',text:'hi'};const parse=(extra:object)=>parseEvent(JSON.stringify({...raw,...extra}),7)!;const plain=parse({});assert.equal('attempt' in plain,false);for(const attempt of [2,1,9007199254740991]){const e=parse({attempt});assert.equal(e.attempt,attempt);assert.deepEqual({...e,attempt:undefined},{...plain,attempt:undefined});}for(const attempt of [0,-1,1.5,'2',null,NaN,9007199254740992]){const e=parse({attempt});assert.equal('attempt' in e,false,String(attempt));assert.deepEqual(e,plain);}assert.equal('attempt' in parseEvent('[10:00:00] 说：hi',0,true)!,false);});
test('命令开始和结束按 id 合并，跨页保留顺序',()=>{const start=parseEvent(JSON.stringify({v:1,seq:1,at:1,kind:'cmd',id:'c',phase:'start',command:'npm test'}),10)!,end=parseEvent(JSON.stringify({v:1,seq:2,at:2,kind:'cmd',id:'c',phase:'end',command:'npm test',exit:1,output:'failed'}),200)!;const combined=combine([end,start]);assert.equal(combined.length,1);assert.equal(combined[0].offset,10);assert.equal(combined[0].exit,1);});
test('停止核对后调用假的 kill，半行隔开、通知只在状态转换时发送、隐藏不改清单',async()=>{const {home}=await fixture();let alive=true,killed=0,finished=0;const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>alive?[ps]:[],killTree:async()=>{killed++;alive=false;},open:async()=>{}},()=>{},()=>finished++,e=>{throw e;});try{await registry.start();assert.equal(finished,0);await assert.rejects(registry.hide('sample'));await appendFile(registry.file,'broken half');await registry.stop('sample');assert.equal(killed,1);assert.equal(finished,1);const text=await readFile(registry.file,'utf8');assert.ok(text.includes('broken half\n{"v":1,"event":"interrupted"'));assert.equal(registry.tasks[0].signal,'stopped-by-app');await registry.hide('sample');assert.equal(registry.tasks.length,0);assert.equal(await readFile(registry.file,'utf8'),text);}finally{await registry.close();}});
test('确认后身份变化时不 kill、不写 interrupted',async()=>{const {home}=await fixture();let calls=0,killed=0;const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>++calls<=2?[ps]:[{...ps,created:101000}],killTree:async()=>{killed++;},open:async()=>{}},()=>{},()=>{},()=>{});try{await registry.start();await assert.rejects(registry.stop('sample'),/任务状态已经变了/);assert.equal(killed,0);assert.ok(!(await readFile(registry.file,'utf8')).includes('interrupted'));}finally{await registry.close();}});
test('导入旧任务只在本地存储；viewer 退出只删除自己的 pid',async()=>{const {home}=await fixture();const dir=path.join(home,'.codex-runs');await mkdir(dir);await writeFile(path.join(dir,'old.progress.log'),'=== Codex 开始：旧任务（角色：工程负责人）  2026/10/8 10:05:00 ===\n[10:06:00] 说：完成\n=== Codex 结束：exit=0，用时 1.0 分钟，汇报在 demo.md ===\n');const imported=await importTasks(home);assert.equal(imported[0].title,'旧任务');assert.equal(imported[0].status,'done');assert.equal(imported[0].imported,true);const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>[],killTree:async()=>assert.fail(),open:async()=>{}},()=>{},()=>{},()=>{});await registry.start();const original=await readFile(registry.file,'utf8');await registry.import(home);assert.equal(await readFile(registry.file,'utf8'),original);const viewer=JSON.parse(await readFile(path.join(home,'viewer.json'),'utf8'));assert.equal(viewer.suppressWatchWindow,true);assert.equal(viewer.acceptsManaged,true);await writeFile(path.join(home,'viewer.json'),JSON.stringify({pid:99999}));await registry.close();assert.equal(JSON.parse(await readFile(path.join(home,'viewer.json'),'utf8')).pid,99999);});
test('无效日期与数值不进入渲染 DTO，持久化导入记录重新验证',async()=>{assert.equal(parseRegistry(lines(row({started:1e100}))).length,0);const parsed=parseRegistry(lines(row(),{v:1,event:'end',id:'sample',exit:0,minutes:'<img src=x>',at:'bad'}))[0];assert.equal(parsed.minutes,undefined);assert.equal(parsed.ended,undefined);assert.equal(parseEvent(JSON.stringify({v:1,seq:1,at:1e100,kind:'say',text:'bad'}),0),null);const {home,task}=await fixture();await writeFile(path.join(home,'monitor','tasks.json'),JSON.stringify({imports:[{...task,id:'import-safe',imported:true,status:'done',minutes:'<img src=x>'},{id:'invalid',imported:true,status:'done'}],hidden:[{},1]}));const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>[],killTree:async()=>assert.fail(),open:async()=>{}},()=>{},()=>{},()=>{});try{await registry.start();assert.ok(!registry.tasks.some(t=>t.id==='invalid'));assert.equal(registry.tasks.find(t=>t.id==='import-safe')?.minutes,undefined);}finally{await registry.close();}});

// ---- 096 任务名：title 与 spec 相同（任务说明路径）时显示文件名，记录里的 title / spec 不改 ----
test('任务名：title 等于 spec 时取文件名并去掉 .md，其余原样',()=>{
  const title=(extra:object)=>parseRegistry(lines(row(extra)))[0].title;
  assert.equal(title({title:'docs/specs/002-001-改第二行.md',spec:'docs/specs/002-001-改第二行.md'}),'002-001-改第二行');
  assert.equal(title({title:'docs\\specs\\003-反斜杠.MD',spec:'docs\\specs\\003-反斜杠.MD'}),'003-反斜杠');
  assert.equal(title({title:'004-无目录.md',spec:'004-无目录.md'}),'004-无目录');
  assert.equal(title({title:'修一下登录页',spec:null}),'修一下登录页');
  assert.equal(title({title:'修一下登录页',spec:'docs/specs/005-登录.md'}),'修一下登录页');
  assert.equal(title({title:'docs/specs/006-空说明.md',spec:null}),'docs/specs/006-空说明.md');
  assert.equal(title({title:'docs/specs/007-空串.md',spec:''}),'docs/specs/007-空串.md');
  assert.equal(parseRegistry(lines(row({title:'docs/specs/008-记录.md',spec:'docs/specs/008-记录.md'})))[0].spec,'docs/specs/008-记录.md','spec 字段不改');
});

// ---- 060 跨尝试读取（协议 14.4）：attempt / attempt-end / resume 的清单解析 ----
test('自动重试三次：尝试列表 3 项、total 正确，状态与最后一个 end 一致',()=>{
  const attempt=(n:number,at:number)=>({v:1,event:'attempt',id:'sample',n,total:3,profile:'fake',reason:n===1?'first':'gate',at});
  const attemptEnd=(n:number,ok:boolean,exit:number,at:number)=>({v:1,event:'attempt-end',id:'sample',n,ok,exit,gate:ok?true:null,usage:{input:100,output:50},ms:900,at});
  const parsed=parseRegistry(lines(row(),attempt(1,101000),attemptEnd(1,false,3,102000),attempt(2,103000),attemptEnd(2,false,3,104000),attempt(3,105000),attemptEnd(3,true,0,106000),{v:1,event:'end',id:'sample',exit:0,at:140000,minutes:2,attempts:3}))[0];
  assert.equal(parsed.attempts?.length,3);
  assert.deepEqual(parsed.attempts?.map(a=>[a.n,a.total,a.profile,a.reason,a.ok,a.exit,a.gate,a.usage?.input,a.usage?.output,a.ms]),
    [[1,3,'fake','first',false,3,null,100,50,900],[2,3,'fake','gate',false,3,null,100,50,900],[3,3,'fake','gate',true,0,true,100,50,900]]);
  assert.equal(parsed.attempt?.n,3,'当前尝试 = 最后一个 attempt');
  assert.equal(parsed.status,'done');
  assert.equal(parsed.exit,0);
});
test('失败 → resume → 进行中 → 新 end 完成：pid 与核对时刻换成 resume 的，旧结果清掉',()=>{
  const first=[
    {v:1,event:'attempt',id:'sample',n:1,total:3,profile:'fake',reason:'first',at:101000},
    {v:1,event:'gate',id:'sample',ok:false,attempt:1,at:105000,summary:'第一次没通过'},
    {v:1,event:'attempt-end',id:'sample',n:1,ok:false,exit:0,gate:false,usage:{input:null,output:null},ms:700,at:106000},
    {v:1,event:'end',id:'sample',exit:3,at:110000,minutes:1,attempts:1},
  ];
  const failed=parseRegistry(lines(row(),...first))[0];
  assert.equal(failed.status,'fail');
  assert.equal(failed.exit,3);
  assert.equal(failed.gateOk,false);
  const resume={v:1,event:'resume',id:'sample',pid:43,at:120000,n:2};
  const attempt2={v:1,event:'attempt',id:'sample',n:2,total:null,profile:'strong',reason:'manual',at:121000};
  const running=parseRegistry(lines(row(),...first,resume,attempt2))[0];
  assert.equal(running.status,'run','resume 后回到进行中');
  assert.equal(running.exit,undefined);
  assert.equal(running.ended,undefined);
  assert.equal(running.gateOk,undefined,'上一次的门禁结果不再算最终');
  assert.equal(running.gateSummary,undefined);
  assert.equal(running.pid,43,'停止按钮与进程核对用 resume.pid');
  // 065 改写（任务说明第 7 条：resume 不改任务开始时间）：
  // 原断言 assert.equal(running.started,120000,'身份核对时刻是 resume.at') →
  // started 保持最初的派发时刻 100000，核对时刻改用 pidSince（= resume.at）。
  assert.equal(running.started,100000,'resume 不改开始时间');
  assert.equal(running.pidSince,120000,'身份核对时刻是 resume.at（pidSince）');
  assert.deepEqual(running.attempt&&[running.attempt.n,running.attempt.total,running.attempt.profile,running.attempt.reason],[2,null,'strong','manual']);
  const done=parseRegistry(lines(row(),...first,resume,attempt2,
    {v:1,event:'gate',id:'sample',ok:true,attempt:2,at:125000,summary:'门禁通过'},
    {v:1,event:'attempt-end',id:'sample',n:2,ok:true,exit:0,gate:true,usage:{input:null,output:null},ms:800,at:126000},
    {v:1,event:'end',id:'sample',exit:0,at:127000,minutes:1,attempts:2}))[0];
  assert.equal(done.status,'done');
  assert.equal(done.exit,0);
  assert.equal(done.gateOk,true,'resume 之后的 gate 才算');
  assert.equal(done.gateSummary,'门禁通过');
  assert.deepEqual(done.attempts?.map(a=>[a.n,a.total,a.ok,a.exit]),[[1,3,false,0],[2,null,true,0]],'尝试列表保留两次');
});
test('resume 后被停止：中断（stop），resume 之前的 end 不算',()=>{
  const parsed=parseRegistry(lines(row(),
    {v:1,event:'end',id:'sample',exit:1,at:110000,minutes:1},
    {v:1,event:'resume',id:'sample',pid:43,at:120000,n:2},
    {v:1,event:'interrupted',id:'sample',at:130000,signal:'stopped-by-command'}))[0];
  assert.equal(parsed.status,'stop');
  assert.equal(parsed.exit,undefined,'resume 之前的 end 不参与状态');
  assert.equal(parsed.signal,'stopped-by-command');
  assert.equal(parsed.pid,43);
  // 065 改写（任务说明第 7 条）：原断言 assert.equal(parsed.started,120000) → started 保持 100000，核对时刻在 pidSince。
  assert.equal(parsed.started,100000);
  assert.equal(parsed.pidSince,120000);
});
test('多条 gate 事件：门禁结果取最后一条',()=>{
  const parsed=parseRegistry(lines(row(),
    {v:1,event:'gate',id:'sample',ok:false,attempt:1,at:105000,summary:'第一次没通过'},
    {v:1,event:'gate',id:'sample',ok:true,attempt:2,at:125000,summary:'门禁通过'},
    {v:1,event:'end',id:'sample',exit:0,at:130000,minutes:1}))[0];
  assert.equal(parsed.gateOk,true);
  assert.equal(parsed.gateSummary,'门禁通过');
});
test('Stage04 旧清单（没有 attempt / resume）解析结果不变：与现有用例同一组数据，整个任务对象一致',()=>{
  const end={v:1,event:'end',id:'sample',exit:0,at:110000,minutes:1},stop={v:1,event:'interrupted',id:'sample',at:105000,signal:'stopped-by-app'};
  const parsed=parseRegistry(lines(row({future:'ignore'}))+'broken\n'+lines(stop,end)+JSON.stringify(row({id:'half'})));
  const {v,event,...fields}=row();
  assert.deepEqual(parsed,[{...fields,status:'done',last:'',managed:false,legacy:true,exit:0,ended:110000,minutes:1,signal:'stopped-by-app'}]);
  assert.equal('attempts' in parsed[0],false);
  assert.equal('attempt' in parsed[0],false);
  assert.equal('future' in parsed[0],false);
});

// 018 清空任务列表：一次把所有已结束任务的键加入 hidden 并保存一次；进行中的与派发进程仍存活的不动；不改 runs.jsonl。
test('清空任务列表一次隐藏全部已结束任务（含导入的旧任务），进行中的与派发进程仍存活的不动，不改清单文件',async()=>{
  const {home,entry}=await fixture(),file=path.join(home,'runs.jsonl');
  const done=row({id:'done',pid:43,repo:home,progress:path.join(home,'done.progress.log'),report:path.join(home,'done.md')});
  const live=row({id:'live',pid:44,repo:home,progress:path.join(home,'live.progress.log'),report:path.join(home,'live.md')});
  await appendFile(file,lines(done,{v:1,event:'end',id:'done',exit:0,at:110000,minutes:1},live,{v:1,event:'interrupted',id:'live',at:105000,signal:'stopped-by-command'}));
  const base=parseRegistry(lines(entry))[0];
  await writeFile(path.join(home,'monitor','tasks.json'),JSON.stringify({imports:[{...base,id:'import-old',name:'旧任务',imported:true,status:'done'}],hidden:[]}));
  const platform={processes:async(pids:number[])=>pids.filter(pid=>pid===42||pid===44).map(pid=>({pid,name:'node.exe',command:'node "C:\\demo\\codex-task.mjs"',created:99000})),killTree:async()=>assert.fail('清空任务列表不该杀进程'),open:async()=>{}};
  const registry=new Registry(home,path.join(home,'monitor'),platform,()=>{},()=>{},e=>{throw e;});
  try{
    await registry.start();
    assert.deepEqual(registry.tasks.map(t=>[t.id,t.status]).sort(),[['done','done'],['import-old','done'],['live','stop'],['sample','run']]);
    const before=await readFile(registry.file,'utf8');
    const result=await registry.hideFinished();
    assert.equal(result.removed,2);
    assert.deepEqual(registry.tasks.map(t=>t.id).sort(),['live','sample']);
    const saved=JSON.parse(await readFile(path.join(home,'monitor','tasks.json'),'utf8'));
    assert.deepEqual([...saved.hidden].sort(),['done:100000','import-old:100000']);
    assert.equal(await readFile(registry.file,'utf8'),before);
    // 再清一次：没有可清的，保存的 hidden 不变。
    assert.equal((await registry.hideFinished()).removed,0);
    assert.deepEqual(JSON.parse(await readFile(path.join(home,'monitor','tasks.json'),'utf8')).hidden.sort(),['done:100000','import-old:100000']);
  }finally{await registry.close();}
});

test('进程消失先宽限三秒并重读命令停止记录，不提前通知',async()=>{
  const {home}=await fixture();let present=true,finished=0;
  const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>present?[ps]:[],killTree:async()=>{},open:async()=>{}},()=>{},()=>finished++,e=>{throw e;});
  try {
    await registry.start();present=false;await registry.refresh();assert.equal(registry.tasks[0].status,'run');assert.equal(finished,0);
    await appendFile(registry.file,lines({v:1,event:'interrupted',id:'sample',signal:'stopped-by-command',at:Date.now()}));
    await registry.refresh();assert.equal(registry.tasks[0].signal,'stopped-by-command');assert.equal(finished,1);
  } finally {await registry.close();}
});
test('消失超过三秒仍无结束记录才判为中断',async()=>{
  const {home}=await fixture();
  const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>[],killTree:async()=>{},open:async()=>{}},()=>{},()=>{},e=>{throw e;});
  try {await registry.start();assert.equal(registry.tasks[0].status,'run');await new Promise(r=>setTimeout(r,3100));await registry.refresh();assert.equal(registry.tasks[0].status,'stop');}
  finally {await registry.close();}
});
test('进程核对：新入口 ar.mjs、软件内置 Node（AgentRouter.exe / 开发时 electron.exe）都算派发进程',()=>{
  for(const p of [{...ps,command:'node "C:\\技能\\agent-router\\core\\ar.mjs" dispatch 任务'},{...ps,name:'AgentRouter.exe',command:'"C:\\Program Files\\AgentRouter\\AgentRouter.exe" "C:\\Program Files\\AgentRouter\\resources\\app\\core\\ar.mjs" dispatch'},{...ps,name:'electron.exe',command:'electron.exe C:\\repo\\core\\ar.mjs'}])assert.equal(dispatchMatches(p,100000),true,p.command);
  for(const p of [{...ps,command:'node far.mjs'},{...ps,command:'node ar.mjs.bak'},{...ps,name:'notepad.exe',command:'notepad ar.mjs'}])assert.equal(dispatchMatches(p,100000),false,p.command);
});
test('看板同时读新旧两份清单：v2 新任务与 v1 旧任务都显示，旧任务带 legacy 标记；停止旧任务写回旧清单',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'agentrouter-test-')),home=path.join(base,'agent-router'),legacy=path.join(base,'codex-dispatch');await mkdir(home);await mkdir(legacy);
  const dir=path.join(base,'.agent-runs','新任务');
  const fresh=row({v:2,id:'new',repo:base,name:'新任务',dir,progress:path.join(dir,'progress.log'),report:path.join(dir,'report.md'),profile:'codex',started:200000,pid:0});
  const old=row({id:'old',repo:base,progress:path.join(base,'old.progress.log'),report:path.join(base,'old.md'),started:100000});
  await writeFile(path.join(home,'runs.jsonl'),lines(fresh,{v:1,event:'end',id:'new',exit:0,at:210000,minutes:1}));
  await writeFile(path.join(legacy,'runs.jsonl'),lines(old));
  let alive=true;const killed:number[]=[];
  const platform={processes:async(pids:number[])=>alive?pids.filter(p=>p===42).map(()=>ps):[],killTree:async(pid:number)=>{killed.push(pid);alive=false;},open:async()=>{}};
  const registry=new Registry(home,path.join(base,'monitor'),platform,()=>{},()=>{},e=>{throw e;},legacy);
  await registry.start();
  try{
    assert.deepEqual(registry.tasks.map(t=>[t.id,t.status,!!t.legacy,t.profile??null]),[['new','done',false,'codex'],['old','run',true,null]]);
    await registry.stop('old');assert.deepEqual(killed,[42]);
    assert.match(await readFile(path.join(legacy,'runs.jsonl'),'utf8'),/"event":"interrupted","id":"old","signal":"stopped-by-app"/);
    assert.doesNotMatch(await readFile(path.join(home,'runs.jsonl'),'utf8'),/interrupted/);
    assert.equal(registry.tasks.find(t=>t.id==='old')!.status,'stop');
    assert.equal(JSON.parse(await readFile(path.join(home,'viewer.json'),'utf8')).app,'AgentRouter');
  }finally{await registry.close();}
});
test('刷新进行中再次请求刷新：排一次后续读取，调用之后写入的结束行一定会被读到',async()=>{const {home}=await fixture();let hold:Promise<void>|undefined,release:(()=>void)|undefined,finished=0;const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>{if(hold)await hold;return [ps];},killTree:async()=>{},open:async()=>{}},()=>{},()=>finished++,e=>{throw e;});try{await registry.start();hold=new Promise<void>(r=>{release=r;});const first=registry.refresh();await new Promise(r=>setTimeout(r,20));await appendFile(registry.file,lines({v:1,event:'end',id:'sample',exit:0,at:2}));const second=registry.refresh();assert.notEqual(second,first);hold=undefined;release();await second;assert.equal(registry.tasks[0].status,'done');assert.equal(finished,1);}finally{hold=undefined;release?.();await registry.close();}});
test('汇报是否存在按文件实际存在判断：进行中没有汇报时为 false，写出后为 true',async()=>{const {home,entry}=await fixture();const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>[ps],killTree:async()=>{},open:async()=>{}},()=>{},()=>{},e=>{throw e;});try{await registry.start();assert.equal(registry.tasks[0].status,'run');assert.equal(registry.tasks[0].hasReport,false);await writeFile(entry.report,'# 汇报');await registry.refresh();assert.equal(registry.tasks[0].hasReport,true);}finally{await registry.close();}});
test('软件数据放在公共目录下的 monitor：旧位置的三份文件只复制不删除，新位置已有的不覆盖',async()=>{const home=await mkdtemp(path.join(os.tmpdir(),'dispatchdock-test-'));assert.equal(appDataDir(home),path.join(home,'monitor'));assert.deepEqual(migrateAppData(home),[]);await writeFile(path.join(home,'preferences.json'),'{"old":1}');await writeFile(path.join(home,'window.json'),'{"w":1}');await mkdir(path.join(home,'monitor'));await writeFile(path.join(home,'monitor','window.json'),'{"w":2}');assert.deepEqual(migrateAppData(home),['preferences.json']);assert.equal(await readFile(path.join(home,'monitor','preferences.json'),'utf8'),'{"old":1}');assert.equal(await readFile(path.join(home,'monitor','window.json'),'utf8'),'{"w":2}','新位置已有的不覆盖');assert.equal(await readFile(path.join(home,'preferences.json'),'utf8'),'{"old":1}','旧文件不删除');assert.deepEqual(migrateAppData(home),[],'再次启动不重复复制');});
test('执行者显示：清单读出 adapter 与 label；标签取名字首词的大写字母，旧任务按 Codex',()=>{const [t]=parseRegistry(lines(row({v:2,adapter:'claude-code',label:'ExampleAgent Pro',profile:'example'})));assert.equal(t.adapter,'claude-code');assert.equal(t.label,'ExampleAgent Pro');assert.equal(executorLabel(t),'ExampleAgent Pro');assert.equal(isCodexTask(t),false);const [old]=parseRegistry(lines(row()));assert.equal(executorLabel(old),'Codex');assert.equal(isCodexTask(old),true);assert.equal(executorTag('ExampleAgent Pro'),'EA');assert.equal(executorTag('Codex'),'CO');assert.equal(executorTag('Claude（API Key）'),'CL');assert.equal(executorTag('ABCD Agent'),'ABC');});

// ---- 017 批量删除（全部在临时目录里做，绝不碰真实项目的 .agent-runs） ----
// 两个已结束任务，各有一个真实记录目录；仓库根上另有一个文件，用来确认只删目标目录。
const deleteFixture=async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'agentrouter-delete-'));
  const repo=path.join(base,'repo'),home=path.join(base,'home'),data=path.join(base,'data');
  await mkdir(path.join(repo,'.agent-runs'),{recursive:true});await mkdir(home);await mkdir(data);
  await writeFile(path.join(repo,'keep.txt'),'keep');
  const entries:any[]=[];
  for(const [id,name,started] of [['del-a','task-a',100000],['del-b','task-b',200000]] as const){
    const dir=path.join(repo,'.agent-runs',name);await mkdir(dir);await writeFile(path.join(dir,'progress.log'),'x');
    entries.push(row({v:2,id,repo,name,started,pid:0,progress:path.join(dir,'progress.log'),report:path.join(dir,'report.md'),events:path.join(dir,'events.jsonl')}));
  }
  await writeFile(path.join(home,'runs.jsonl'),lines(...entries,...entries.map(e=>({v:2,event:'end',id:e.id,exit:0,at:e.started+1000,minutes:1}))));
  return {base,repo,home,data,entries};
};
const deleteRegistry=(home:string,data:string,processes:(pids:number[])=>Promise<any[]>)=>new Registry(home,data,{processes,killTree:async()=>assert.fail('删除不应结束进程'),open:async()=>{}},()=>{},()=>{},e=>{throw e;});
test('017 批量删除：记录名校验，目录穿越、绝对路径与无效名字全部拒绝',async()=>{
  assert.equal(validRecordName('task-a'),true);
  for(const name of ['','.','..','.agent-runs','..\\outside','../outside','sub/name','sub\\name','C:\\evil','\\\\server\\share','a..b'])
    assert.equal(validRecordName(name),false,name);
  const base=await mkdtemp(path.join(os.tmpdir(),'agentrouter-delete-')),repo=path.join(base,'repo'),home=path.join(base,'home'),data=path.join(base,'data');
  await mkdir(path.join(repo,'.agent-runs'),{recursive:true});await mkdir(home);await mkdir(data);
  const outside=path.join(base,'outside');await mkdir(outside);await writeFile(path.join(outside,'keep.txt'),'keep');
  const names=['','.','..','.agent-runs','..\\outside','../outside','sub/name','C:\\evil'];
  const rows=names.map((name,i)=>row({v:2,id:`bad-${i}`,repo,name,started:100000+i*1000,pid:0,progress:path.join(repo,'p.log'),report:path.join(repo,'r.md')}));
  await writeFile(path.join(home,'runs.jsonl'),lines(...rows,...rows.map(r=>({v:2,event:'end',id:r.id,exit:0,at:r.started+1}))));
  const registry=deleteRegistry(home,data,async()=>[]);
  try{
    await registry.start();
    const result=await registry.deleteTasks(rows.map(r=>r.id),true);
    assert.deepEqual(result,{deleted:names.length,failed:0,filesLeft:names.length});
    assert.equal(await readFile(path.join(outside,'keep.txt'),'utf8'),'keep');
    assert.deepEqual(await readdir(path.join(repo,'.agent-runs')),[]);
  }finally{await registry.close();}
});
test('017 批量删除：记录目录或 .agent-runs 本身是指向仓库外的链接时拒绝',async t=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'agentrouter-delete-')),repo=path.join(base,'repo'),repo2=path.join(base,'repo2'),home=path.join(base,'home'),data=path.join(base,'data');
  await mkdir(path.join(repo,'.agent-runs'),{recursive:true});await mkdir(repo2);await mkdir(home);await mkdir(data);
  const outside=path.join(base,'outside');await mkdir(outside);await writeFile(path.join(outside,'keep.txt'),'keep');
  const stolen=path.join(base,'stolen');await mkdir(path.join(stolen,'stolen-task'),{recursive:true});await writeFile(path.join(stolen,'stolen-task','keep.txt'),'keep');
  try{
    await symlink(outside,path.join(repo,'.agent-runs','linked-task'),'junction');
    await symlink(stolen,path.join(repo2,'.agent-runs'),'junction');
  }catch(e){t.skip('当前环境不能创建目录链接');return;}
  const rows=[
    row({v:2,id:'linked',repo,name:'linked-task',started:100000,pid:0,progress:path.join(repo,'p.log'),report:path.join(repo,'r.md')}),
    row({v:2,id:'stolen',repo:repo2,name:'stolen-task',started:200000,pid:0,progress:path.join(repo2,'p.log'),report:path.join(repo2,'r.md')}),
  ];
  await writeFile(path.join(home,'runs.jsonl'),lines(...rows,...rows.map(r=>({v:2,event:'end',id:r.id,exit:0,at:r.started+1}))));
  const registry=deleteRegistry(home,data,async()=>[]);
  try{
    await registry.start();
    const result=await registry.deleteTasks(rows.map(r=>r.id),true);
    assert.deepEqual(result,{deleted:2,failed:0,filesLeft:2});
    assert.equal(await readFile(path.join(outside,'keep.txt'),'utf8'),'keep');
    assert.equal(await readFile(path.join(stolen,'stolen-task','keep.txt'),'utf8'),'keep');
  }finally{await registry.close();}
});
test('017 批量删除：files=false 只从列表移除；files=true 只删目标目录，hidden 一次写入',async()=>{
  const f=await deleteFixture();
  const registry=deleteRegistry(f.home,f.data,async()=>[]);
  try{
    await registry.start();
    const before=await readFile(path.join(f.home,'runs.jsonl'),'utf8');
    let saves=0;const original=(registry as any).save.bind(registry);(registry as any).save=async()=>{saves++;await original();};
    const result=await registry.deleteTasks(['del-a','del-b'],false);
    assert.deepEqual(result,{deleted:2,failed:0,filesLeft:0});
    assert.equal(saves,1,'两条任务只保存一次');
    for(const name of ['task-a','task-b'])assert.equal(await readFile(path.join(f.repo,'.agent-runs',name,'progress.log'),'utf8'),'x');
    assert.equal(await readFile(path.join(f.home,'runs.jsonl'),'utf8'),before,'runs.jsonl 不改');
    assert.deepEqual(JSON.parse(await readFile(path.join(f.data,'tasks.json'),'utf8')).hidden.sort(),['del-a:100000','del-b:200000']);
    assert.equal(registry.tasks.length,0);
  }finally{await registry.close();}
  const g=await deleteFixture();
  const two=deleteRegistry(g.home,g.data,async()=>[]);
  try{
    await two.start();
    const result=await two.deleteTasks(['del-a'],true);
    assert.deepEqual(result,{deleted:1,failed:0,filesLeft:0});
    await assert.rejects(readFile(path.join(g.repo,'.agent-runs','task-a','progress.log')),{code:'ENOENT'});
    assert.equal(await readFile(path.join(g.repo,'.agent-runs','task-b','progress.log'),'utf8'),'x');
    assert.equal(await readFile(path.join(g.repo,'keep.txt'),'utf8'),'keep');
    assert.ok(!two.tasks.some(t=>t.id==='del-a'));
    assert.ok(two.tasks.some(t=>t.id==='del-b'));
  }finally{await two.close();}
});
test('017 批量删除：进行中或派发进程仍存活的任务跳过并计入失败',async()=>{
  const {home}=await fixture();
  const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>[ps],killTree:async()=>assert.fail(),open:async()=>{}},()=>{},()=>{},e=>{throw e;});
  try{
    await registry.start();
    assert.equal(registry.tasks[0].status,'run');
    const result=await registry.deleteTasks(['sample'],false);
    assert.deepEqual(result,{deleted:0,failed:1,filesLeft:0});
    assert.ok(registry.tasks.some(t=>t.id==='sample'));
    assert.equal(await readFile(path.join(home,'monitor','tasks.json'),'utf8').catch(()=>''),'');
  }finally{await registry.close();}
});
test('017 批量删除：导入的旧任务只从列表移除，不删目录也不算失败',async()=>{
  const {home,task}=await fixture();
  await mkdir(path.join(home,'.agent-runs','old'),{recursive:true});
  await writeFile(path.join(home,'.agent-runs','old','progress.log'),'x');
  await writeFile(path.join(home,'monitor','tasks.json'),JSON.stringify({imports:[{...task,id:'import-safe',name:'old',started:90000,imported:true,status:'done',exit:0}],hidden:[]}));
  const registry=deleteRegistry(home,path.join(home,'monitor'),async()=>[]);
  try{
    await registry.start();
    assert.ok(registry.tasks.some(t=>t.id==='import-safe'));
    const result=await registry.deleteTasks(['import-safe'],true);
    assert.deepEqual(result,{deleted:1,failed:0,filesLeft:0});
    assert.equal(await readFile(path.join(home,'.agent-runs','old','progress.log'),'utf8'),'x');
    assert.ok(!registry.tasks.some(t=>t.id==='import-safe'));
  }finally{await registry.close();}
});
test('进程查询失败：启动不抛出，进行中任务标未知、不推断结束，保留错误与首次失败时刻；每次刷新最多试 3 次；恢复后清除',async()=>{
  const {home}=await fixture();let calls=0,fail=true,finished=0;
  const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>{calls++;if(fail)throw Error('WMI 暂时不可用');return [ps];},killTree:async()=>{throw Error('不该结束进程');},open:async()=>{}},()=>{},()=>finished++,e=>{throw e;});
  try {
    await registry.start();
    assert.equal(calls,3,'一次刷新最多试 3 次');
    assert.equal(registry.tasks[0].status,'run');assert.equal(registry.tasks[0].processState,'unknown');
    assert.equal(registry.processCheck.ok,false);assert.equal(registry.processCheck.failures,1);assert.match(registry.processCheck.error!,/WMI 暂时不可用/);
    const since=registry.processCheck.since;assert.ok(Number.isFinite(since));
    await new Promise(resolve=>setTimeout(resolve,3200));await registry.refresh();
    assert.equal(registry.tasks[0].status,'run','查询失败期间即使超过 3 秒宽限也不推断结束');assert.equal(registry.tasks[0].processState,'unknown');
    assert.ok(registry.processCheck.failures>=2,'连续失败次数累加');assert.equal(registry.processCheck.since,since,'首次失败时刻保留');assert.equal(finished,0,'不发结束通知');
    fail=false;await registry.refresh();
    assert.deepEqual(registry.processCheck,{ok:true,failures:0});assert.equal(registry.tasks[0].processState,undefined);assert.equal(registry.tasks[0].status,'run');
  } finally {await registry.close();}
});
test('进程查询失败：之前已确认停止的任务保留最后已知状态，不改回进行中',async()=>{
  const {home}=await fixture();let fail=false;
  const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>{if(fail)throw Error('查询失败');return [];},killTree:async()=>{},open:async()=>{}},()=>{},()=>{},e=>{throw e;});
  try {
    await registry.start();await new Promise(resolve=>setTimeout(resolve,3200));await registry.refresh();
    assert.equal(registry.tasks[0].status,'stop','进程消失超过宽限期判为中断');
    fail=true;await registry.refresh();
    assert.equal(registry.tasks[0].status,'stop','查询失败时保留最后已知的"已中断"');assert.equal(registry.tasks[0].processState,undefined);assert.equal(registry.processCheck.ok,false);
  } finally {await registry.close();}
});
test('进程查询失败时依赖进程状态的操作受保护：停止不结束进程，隐藏 / 删除 / 清空任务列表都拒绝且不改列表',async()=>{
  const {home}=await fixture();let killed=0;
  await appendFile(path.join(home,'runs.jsonl'),lines(row({id:'done1',name:'task2',repo:home,pid:43,started:200000}),{v:1,event:'end',id:'done1',exit:0,at:210000,minutes:1}));
  const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>{throw Error('查询失败');},killTree:async()=>{killed++;},open:async()=>{}},()=>{},()=>{},e=>{throw e;});
  try {
    await registry.start();
    const before=registry.tasks.map(t=>t.id).sort();
    await assert.rejects(registry.stop('sample'));assert.equal(killed,0,'查询失败时不结束进程树');
    await assert.rejects(registry.hide('sample'),'进行中（状态未知）的任务不能隐藏');
    await assert.rejects(registry.deleteTasks(['done1'],false),'已结束但需要核对进程的任务，查询失败时拒绝删除');
    await assert.rejects(registry.hideFinished(),'清空任务列表在查询失败时拒绝');
    await registry.refresh();assert.deepEqual(registry.tasks.map(t=>t.id).sort(),before,'列表没有变化');
  } finally {await registry.close();}
});

// ---- 065：软件的停止与 ar stop 同规则（协议第 9 节）；resume 之后核对用 pidSince ----
test('停止：进程查询前两次抛错、第三次成功 → 正常结束进程树并写 interrupted',async()=>{
  const {home}=await fixture();let calls=0,killed=0;
  // 调用顺序：start 的刷新 3 次（都失败）→ stop 的刷新 3 次（都失败）→ 停止核对第 1、2 次失败、第 3 次成功。
  const platform={processes:async(pids:number[])=>{calls++;if(calls<=8)throw Error('PowerShell 查询失败（偶发）');if(killed)return [];return pids.map(pid=>({pid,name:'node.exe',command:'node "C:\\demo\\codex-task.mjs"',created:99000}));},killTree:async()=>{killed++;},alive:()=>killed===0,open:async()=>{}};
  const registry=new Registry(home,path.join(home,'monitor'),platform,()=>{},()=>{},e=>{throw e;});
  try {
    await registry.start();
    await registry.stop('sample');
    assert.equal(killed,1,'第三次查询成功后结束进程树');
    assert.ok(calls>=9,'停止核对查询了 3 次（前两次失败）');
    assert.match(await readFile(registry.file,'utf8'),/"event":"interrupted"/);
    assert.equal(registry.tasks[0].status,'stop');
  } finally {await registry.close();}
});
test('停止：进程查询三次都失败 → 拒绝、不结束进程树、不写 interrupted、报"无法核对进程"',async()=>{
  const {home}=await fixture();let killed=0;
  const registry=new Registry(home,path.join(home,'monitor'),{processes:async()=>{throw Error('PowerShell 查询失败（偶发）');},killTree:async()=>{killed++;},alive:()=>true,open:async()=>{}},()=>{},()=>{},e=>{throw e;});
  try {
    await registry.start();
    await assert.rejects(registry.stop('sample'),/无法核对进程（进程查询失败：PowerShell 查询失败（偶发））/);
    assert.equal(killed,0,'不结束进程树');
    assert.ok(!(await readFile(registry.file,'utf8')).includes('interrupted'),'不写 interrupted');
  } finally {await registry.close();}
});
test('resume 之后停止核对用 pidSince（resume.at），开始时间不变',()=>{
  const parsed=parseRegistry(lines(row(),
    {v:1,event:'end',id:'sample',exit:1,at:110000,minutes:1},
    {v:1,event:'resume',id:'sample',pid:43,at:120000,n:2}))[0];
  assert.equal(parsed.started,100000,'开始时间保持最初的派发时刻');
  assert.equal(parsed.pidSince,120000,'核对时刻是 resume.at');
  // 进程在 started 之后、resume.at 之前创建：按 started 判会把它当成"已经不在"，按 pidSince 判仍是进行中。
  const resumePs={pid:43,name:'node.exe',command:'node "C:\\demo\\core\\ar.mjs" dispatch',created:115000};
  assert.equal(dispatchMatches(resumePs,matchTime(parsed)),true,'停止核对用 pidSince ?? started');
  assert.equal(statusOf(parsed,[resumePs]),'run');
  assert.equal(statusOf({...parsed,pidSince:undefined},[{...resumePs,created:101000}]),'stop','没有 pidSince 时仍按 started 核对');
});

// ---- 078 执行者需要越界（协议 14.5）：end / attempt-end 的 needsScope ----
test('needsScope：end 与 attempt-end 带合法列表时进任务与尝试；不合法或没有就当没有；resume 清掉',()=>{
  const list=[{path:'core/lib/gate.mjs',reason:'要加参数'},{path:'tests/unit/gate.test.mjs',reason:null}];
  const attempt={v:1,event:'attempt',id:'sample',n:1,total:3,profile:'fake',reason:'first',at:101000};
  const attemptEnd=(extra={})=>({v:1,event:'attempt-end',id:'sample',n:1,ok:false,exit:0,gate:false,usage:{input:1,output:2},ms:900,at:102000,...extra});
  const end=(extra={})=>({v:1,event:'end',id:'sample',exit:3,at:103000,minutes:1,attempts:1,agentExit:0,...extra});
  const ok=parseRegistry(lines(row(),attempt,attemptEnd({needsScope:list}),end({needsScope:list})))[0];
  assert.deepEqual(ok.needsScope,list);
  assert.deepEqual(ok.attempts?.[0].needsScope,list);
  assert.equal(ok.status,'fail');
  const none=parseRegistry(lines(row(),attempt,attemptEnd(),end()))[0];
  assert.equal(none.needsScope,undefined);
  assert.equal(none.attempts?.[0].needsScope,undefined);
  const tooMany=Array.from({length:51},(_,i)=>({path:`f${i}`,reason:null}));
  for(const bad of ['x',{},[],[{path:'',reason:null}],[{path:'a.js'}],[{path:1,reason:null}],[{path:'a.js',reason:3}],[null],tooMany]){
    const parsed=parseRegistry(lines(row(),attempt,attemptEnd({needsScope:bad}),end({needsScope:bad})))[0];
    assert.equal(parsed.needsScope,undefined,JSON.stringify(bad)?.slice(0,40));
    assert.equal(parsed.attempts?.[0].needsScope,undefined);
    assert.equal(parsed.status,'fail','不合法的字段不影响状态');
  }
  const max=Array.from({length:50},(_,i)=>({path:`f${i}`,reason:null}));
  assert.equal(parseRegistry(lines(row(),end({needsScope:max})))[0].needsScope?.length,50);
  // 手动重试的 resume 之后，上一轮的 needsScope 不再算；新的 end 没有就是没有。
  const resumed=parseRegistry(lines(row(),attempt,attemptEnd({needsScope:list}),end({needsScope:list}),{v:1,event:'resume',id:'sample',pid:43,n:2,at:104000}))[0];
  assert.equal(resumed.status,'run');
  assert.equal(resumed.needsScope,undefined);
  const after=parseRegistry(lines(row(),end({needsScope:list}),{v:1,event:'resume',id:'sample',pid:43,n:2,at:104000},end({exit:0,at:105000})))[0];
  assert.equal(after.needsScope,undefined);
});

// ---- 079 工作区外写入（协议 12.4）：attempt-end 的 outsideWrites ----
test('outsideWrites：attempt-end 带合法值时进任务与尝试，取最后一次尝试的；不合法或没有就当没有；resume 清掉',()=>{
  const added=[{root:'user',name:'config.json',type:'file'},{root:'home',name:'stray',type:'dir'}];
  const value={checked:true,added};
  const attempt=(n:number)=>({v:1,event:'attempt',id:'sample',n,total:3,profile:'fake',reason:n===1?'first':'gate',at:101000+n});
  const attemptEnd=(n:number,extra:Record<string,unknown>={})=>({v:1,event:'attempt-end',id:'sample',n,ok:false,exit:0,gate:false,usage:{input:1,output:2},ms:900,at:102000+n,...extra});
  const end=(extra:Record<string,unknown>={})=>({v:1,event:'end',id:'sample',exit:3,at:103000,minutes:1,attempts:1,agentExit:0,...extra});
  const ok=parseRegistry(lines(row(),attempt(1),attemptEnd(1,{outsideWrites:value}),end()))[0];
  assert.deepEqual(ok.outsideWrites,value);
  assert.deepEqual(ok.attempts?.[0].outsideWrites,value);
  assert.equal(ok.status,'fail');
  const none=parseRegistry(lines(row(),attempt(1),attemptEnd(1),end()))[0];
  assert.equal(none.outsideWrites,undefined);
  assert.equal(none.attempts?.[0].outsideWrites,undefined);
  // 没能核对：{ checked:false, error } 也进任务（界面只在有新文件时画横幅）。
  const unchecked=parseRegistry(lines(row(),attempt(1),attemptEnd(1,{outsideWrites:{checked:false,error:'用户目录前读取失败（ENOENT）'}}),end()))[0];
  assert.deepEqual(unchecked.outsideWrites,{checked:false,added:[],error:'用户目录前读取失败（ENOENT）'});
  for(const bad of ['x',1,{},{checked:true},{checked:'yes',added},{checked:true,added:'x'},{checked:true,added:[null]},
    {checked:true,added:[{root:'etc',name:'a',type:'file'}]},{checked:true,added:[{root:'user',name:'',type:'file'}]},
    {checked:true,added:[{root:'user',name:3,type:'file'}]},{checked:true,added:[{root:'user',name:'a',type:'socket'}]}]){
    const parsed=parseRegistry(lines(row(),attempt(1),attemptEnd(1,{outsideWrites:bad}),end()))[0];
    assert.equal(parsed.outsideWrites,undefined,JSON.stringify(bad));
    assert.equal(parsed.attempts?.[0].outsideWrites,undefined);
    assert.equal(parsed.status,'fail','不合法的字段不影响状态');
  }
  // 任务上的值取最后一次尝试的：后一次没有就清掉前一次的；每次尝试自己的值各自保留。
  const second=parseRegistry(lines(row(),attempt(1),attemptEnd(1,{outsideWrites:value}),attempt(2),attemptEnd(2),end({attempts:2})))[0];
  assert.equal(second.outsideWrites,undefined);
  assert.deepEqual(second.attempts?.[0].outsideWrites,value);
  assert.equal(second.attempts?.[1].outsideWrites,undefined);
  // 手动重试的 resume 之后，上一轮的值不再算。
  const resumed=parseRegistry(lines(row(),attempt(1),attemptEnd(1,{outsideWrites:value}),end(),{v:1,event:'resume',id:'sample',pid:43,n:2,at:104000}))[0];
  assert.equal(resumed.status,'run');
  assert.equal(resumed.outsideWrites,undefined);
});

// ---- 087 worktree 任务的十种状态（协议 15.3 / 15.6 / 15.7 / 15.8）----
const wtRow=(extra={})=>row({v:2,worktree:true,base:'a'.repeat(40),gate:true,...extra});
const wtState=(...events:unknown[])=>{const t=parseRegistry(lines(wtRow(),...events))[0];return [worktreeState(t),t] as const;};
const E={
  queued:(at=100500)=>({v:1,event:'queued',id:'sample',at}),preparing:(at=101000)=>({v:1,event:'preparing',id:'sample',at}),
  worktree:(at=101500)=>({v:1,event:'worktree',id:'sample',dir:path.resolve('/wt/demo'),branch:'ar/task',base:'b'.repeat(40),at}),
  setup:(ok=true,at=102000)=>({v:1,event:'setup',id:'sample',ok,ms:900,at,summary:ok?'准备命令通过':'准备命令失败：npm ci（exit 1）'}),
  attempt:(at=103000)=>({v:1,event:'attempt',id:'sample',n:1,total:3,profile:'fake',reason:'first',at}),
  gating:(at=104000)=>({v:1,event:'gating',id:'sample',at}),gate:(at=105000)=>({v:1,event:'gate',id:'sample',ok:true,attempt:1,at,summary:'门禁通过'}),
  end:(extra={})=>({v:1,event:'end',id:'sample',exit:0,at:106000,minutes:1,...extra}),
  accepted:(extra={})=>({v:1,event:'accepted',id:'sample',merge:'c'.repeat(40),mode:'no-ff',by:'human',at:107000,...extra}),
  rejected:(extra={})=>({v:1,event:'rejected',id:'sample',reason:'方向不对',keptBranch:true,by:'lead',at:107000,...extra}),
  conflict:(files=['src/a.ts','src/b.ts'])=>({v:1,event:'conflict',id:'sample',files,at:107000}),
  cleanup:(ok=false)=>({v:1,event:'cleanup',id:'sample',ok,error:'目录被占用',at:108000}),
  resume:(at=120000)=>({v:1,event:'resume',id:'sample',pid:43,n:2,at}),
};
test('087 worktree 任务十种状态：排队、准备、进行中、门禁中、待验收、已合并、已驳回、冲突、失败、已中断各一例',()=>{
  assert.equal(wtState()[0],'queued','只有 start 就是排队');
  const [queued,qt]=wtState(E.queued());assert.equal(queued,'queued');assert.equal(qt.wt?.queuedAt,100500,'进入排队的时刻取 queued 事件');
  assert.equal(wtState()[1].wt?.queuedAt,100000,'只有 start 时取开始时刻');
  assert.equal(wtState(E.queued(),E.preparing())[0],'preparing');
  const [prep,pt]=wtState(E.queued(),E.preparing(),E.worktree());assert.equal(prep,'preparing','worktree 事件之后仍是准备中');
  assert.deepEqual([pt.wt?.branch,pt.wt?.dir,pt.wt?.base],['ar/task',path.resolve('/wt/demo'),'b'.repeat(40)]);
  assert.equal(wtState(E.queued(),E.preparing(),E.worktree(),E.setup(true))[0],'preparing','成功的 setup 之后仍是准备中');
  assert.equal(wtState(E.preparing(),E.worktree(),E.setup(),E.attempt())[0],'running');
  assert.equal(wtState(E.preparing(),E.worktree(),E.setup(),E.attempt(),E.gating())[0],'gating');
  const [awaiting,at]=wtState(E.attempt(),E.gating(),E.gate(),E.end());assert.equal(awaiting,'awaiting');assert.equal(at.status,'done');assert.equal(at.wt?.awaitingAt,106000,'进入待验收的时刻取 end.at');
  const [accepted,ac]=wtState(E.attempt(),E.end(),E.accepted());assert.equal(accepted,'accepted');
  assert.deepEqual(ac.wt?.accepted,{merge:'c'.repeat(40),mode:'no-ff',by:'human',at:107000});
  assert.equal(wtState(E.attempt(),E.end(),E.accepted({mode:'squash',by:'lead'}))[1].wt?.accepted?.mode,'squash');
  const [rejected,rj]=wtState(E.attempt(),E.end(),E.rejected());assert.equal(rejected,'rejected');
  assert.deepEqual(rj.wt?.rejected,{reason:'方向不对',keptBranch:true,by:'lead',at:107000});
  const [conflict,cf]=wtState(E.attempt(),E.end(),E.conflict());assert.equal(conflict,'conflict');assert.deepEqual(cf.wt?.conflictFiles,['src/a.ts','src/b.ts']);
  assert.deepEqual(wtState(E.attempt(),E.end(),E.conflict(['x']),E.resume(),E.attempt(121000),E.end({at:130000}),E.conflict(['y','z']))[1].wt?.conflictFiles,['y','z'],'files 取最近一条 conflict');
  const [failed,fl]=wtState(E.attempt(),E.gating(),E.end({exit:3}));assert.equal(failed,'failed');assert.equal(fl.status,'fail');
  assert.equal(wtState(E.queued(),{v:1,event:'interrupted',id:'sample',signal:'stopped-by-app',at:101000})[0],'stopped','排队中被停止');
  assert.equal(wtState(E.attempt(),{v:1,event:'interrupted',id:'sample',signal:'session-closed',at:104000})[0],'stopped');
});
test('087 worktree：resume 之后回到进行中（冲突、失败、准备失败都一样），再次 end 又进入待验收',()=>{
  const [after,t]=wtState(E.attempt(),E.end(),E.conflict(),E.resume());
  assert.equal(after,'running');assert.equal(t.status,'run');assert.equal(t.wt?.conflictFiles,undefined,'冲突标记不再算');
  assert.equal(wtState(E.attempt(),E.end({exit:3}),E.resume())[0],'running');
  const [again,t2]=wtState(E.attempt(),E.end(),E.conflict(),E.resume(),E.attempt(121000),E.gating(122000),E.gate(123000),E.end({at:124000}));
  assert.equal(again,'awaiting');assert.equal(t2.wt?.awaitingAt,124000);
  assert.equal(wtState(E.attempt(),E.end(),E.conflict(),E.resume(),E.preparing(121000))[0],'preparing','重试先写 preparing（准备失败后重跑准备命令）');
  assert.equal(wtState(E.attempt(),E.end({exit:1}),E.conflict(),E.resume(),E.attempt(121000),E.end({exit:1,at:122000}),E.conflict(['a']))[0],'conflict','git merge 失败：end 之后再写 conflict，仍是冲突');
});
test('087 worktree：cleanup 不改变状态，accepted / rejected 之后 ok:false 的 cleanup 记 cleanupFailed',()=>{
  const [state,t]=wtState(E.attempt(),E.end(),E.accepted(),E.cleanup(false));assert.equal(state,'accepted');assert.equal(t.wt?.cleanupFailed,true);
  const [state2,t2]=wtState(E.attempt(),E.end(),E.rejected(),E.cleanup(true));assert.equal(state2,'rejected');assert.equal(t2.wt?.cleanupFailed,undefined,'ok:true 的 cleanup 不算失败');
  assert.equal(wtState(E.attempt(),E.end(),E.rejected(),E.cleanup(false))[1].wt?.cleanupFailed,true);
  assert.equal(wtState(E.attempt(),E.end(),E.cleanup(false))[0],'awaiting','没有验收事件时 cleanup 不影响待验收');
  assert.equal(wtState(E.attempt(),E.end(),E.cleanup(false))[1].wt?.cleanupFailed,undefined);
});
test('087 worktree：准备失败（setup ok:false + end reason:"setup"）是失败，能认出 setup；驳回它合法',()=>{
  const failedEnd=E.end({exit:1,reason:'setup',attempts:0});
  const [state,t]=wtState(E.queued(),E.preparing(),E.worktree(),E.setup(false),failedEnd);
  assert.equal(state,'failed');assert.equal(t.status,'fail');assert.equal(t.wt?.setupFailed,true);
  assert.deepEqual(t.wt?.setup,{ok:false,summary:'准备命令失败：npm ci（exit 1）'});
  assert.equal(wtState(E.attempt(),E.end({exit:3}))[1].wt?.setupFailed,false,'普通失败不是准备失败');
  const [rejected,r]=wtState(E.preparing(),E.worktree(),E.setup(false),failedEnd,E.rejected({keptBranch:false}));
  assert.equal(rejected,'rejected');assert.equal(r.wt?.rejected?.keptBranch,false);
});
test('087 旧读取方与不合法的事件：非 worktree 任务忽略这些事件，四态一行不变；字段不合法时取保守值',()=>{
  const plain=parseRegistry(lines(row(),{v:1,event:'end',id:'sample',exit:0,at:110000,minutes:1}));
  const noisy=parseRegistry(lines(row(),E.queued(),E.preparing(),E.worktree(),E.setup(),{v:1,event:'future-event',id:'sample'},{v:1,event:'end',id:'sample',exit:0,at:110000,minutes:1},E.accepted(),E.conflict(),E.cleanup()));
  assert.deepEqual(noisy,plain);assert.equal('wt' in noisy[0],false);assert.equal('worktree' in noisy[0],false);assert.equal(worktreeState(noisy[0]),null);
  const [,t]=wtState(E.worktree(),{v:1,event:'worktree',id:'sample',dir:3,branch:null,base:undefined,at:1},E.attempt(),E.end(),E.accepted({merge:7,mode:'weird',by:9,at:'x'}));
  assert.deepEqual(t.wt?.accepted,{merge:null,mode:'no-ff',by:'cli',at:0});assert.equal(t.wt?.branch,'ar/task','不合法的字段保留上一个值');
  assert.equal(wtState(E.attempt(),E.end(),E.accepted(),E.accepted({merge:'d'.repeat(40)}))[1].wt?.accepted?.merge,'c'.repeat(40),'已经合并后重复的 accepted 不改结果');
  assert.equal(wtState(E.attempt(),E.end({exit:3}),E.accepted())[0],'failed','失败的任务收到 accepted 不算数');
});
test('087 Registry：排在前面的任务数、项目配置里的主分支与合并方式、并发上限、进入冲突回调、待验收走 finished',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'agentrouter-wt-')),home=path.join(base,'home'),repo=path.join(base,'repo');
  await mkdir(home);await mkdir(path.join(repo,'.agent-router'),{recursive:true});
  await writeFile(path.join(repo,'.agent-router','project.json'),JSON.stringify({v:1,baseBranch:'trunk',mergeMode:'squash'}));
  const mk=(id:string,started:number,pid:number)=>row({v:2,worktree:true,id,repo,name:id,started,pid,progress:path.join(repo,id+'.log'),report:path.join(repo,id+'.md')});
  const file=path.join(home,'runs.jsonl'),ev=(id:string,event:string,extra={})=>({v:1,event,id,at:1,...extra});
  // a 先排队、b 后排队、c 的 start 最早但 queued 事件最晚；d 已进入准备，不算排队。
  await writeFile(file,lines(mk('a',100000,42),ev('a','queued',{at:100100}),mk('b',101000,43),ev('b','queued',{at:101100}),mk('c',99000,44),ev('c','queued',{at:102000}),mk('d',99100,45),ev('d','preparing',{at:99200})));
  await writeFile(path.join(home,'config.json'),JSON.stringify({v:2,concurrency:3}));
  let finished:Task[]=[],conflicts:Task[]=[];
  const registry=new Registry(home,path.join(home,'monitor'),{processes:async(pids:number[])=>pids.map(pid=>({...ps,pid})),killTree:async()=>{},open:async()=>{}},()=>{},t=>finished.push(t),e=>{throw e;},home,t=>conflicts.push(t));
  try{
    await registry.start();
    const by=(id:string)=>registry.tasks.find(t=>t.id===id)!;
    assert.deepEqual(['a','b','c','d'].map(id=>[worktreeState(by(id)),by(id).wt?.ahead]),[['queued',0],['queued',1],['queued',2],['preparing',undefined]]);
    assert.deepEqual([by('a').wt?.baseBranch,by('a').wt?.mergeMode],['trunk','squash']);
    assert.equal(registry.concurrency,3);
    // a 开始准备：排在后面的前移；b、c 仍排队。
    await appendFile(file,lines(ev('a','preparing',{at:103000})));await registry.refresh();
    assert.deepEqual(['b','c'].map(id=>by(id).wt?.ahead),[0,1]);assert.equal(by('a').wt?.ahead,undefined,'不在排队时没有 ahead');
    // 门禁通过进入待验收：走 finished（由 index 发"待验收"通知）；批准时冲突：不经 finished，走 conflicted。
    assert.equal(finished.length,0);
    await appendFile(file,lines(ev('a','attempt',{n:1,total:1,at:104000}),ev('a','end',{exit:0,at:105000,minutes:1})));await registry.refresh();
    assert.deepEqual(finished.map(t=>[t.id,worktreeState(t)]),[['a','awaiting']]);assert.equal(conflicts.length,0);
    await appendFile(file,lines(ev('a','conflict',{files:['x.ts'],at:106000})));await registry.refresh();
    assert.equal(finished.length,1);assert.deepEqual(conflicts.map(t=>[t.id,t.wt?.conflictFiles]),[['a',['x.ts']]]);
    await registry.refresh();assert.equal(conflicts.length,1,'同一次冲突只回调一次');
  }finally{await registry.close();}
});
test('088 Registry：只改了同时运行的任务数上限（任务没变）也推送一次，侧栏底部的上限靠它跟着变；不合法的值按默认 2',async()=>{
  const base=await mkdtemp(path.join(os.tmpdir(),'agentrouter-limit-')),home=path.join(base,'home');
  await mkdir(home);
  const file=path.join(home,'runs.jsonl'),config=path.join(home,'config.json');
  await writeFile(file,'');await writeFile(config,JSON.stringify({v:2,concurrency:2}));
  let pushes=0;
  const registry=new Registry(home,path.join(home,'monitor'),{processes:async(pids:number[])=>pids.map(pid=>({...ps,pid})),killTree:async()=>{},open:async()=>{}},()=>{pushes++;},()=>{},e=>{throw e;},home);
  try{
    await registry.start();assert.equal(registry.concurrency,2);
    await registry.refresh();const settled=pushes;
    await registry.refresh();assert.equal(pushes,settled,'什么都没变不推送');
    await writeFile(config,JSON.stringify({v:2,concurrency:4,extra:true}));await registry.refresh();
    assert.equal(registry.concurrency,4);assert.equal(pushes,settled+1,'上限变了推送一次');
    await registry.refresh();assert.equal(pushes,settled+1,'没再变就不再推送');
    await writeFile(config,JSON.stringify({v:2,concurrency:'x',extra:true}));await registry.refresh();
    assert.equal(registry.concurrency,2);assert.equal(pushes,settled+2);
  }finally{await registry.close();}
});