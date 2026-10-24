import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tasks, gates, attemptSets, plan1, ev1, ev5, ev6, files3, wtReport, wtMerged } from './data.mjs';
import { legacyRunsDir } from '../../core/lib/compat.mjs';
export async function demo(){
  const home=await mkdtemp(path.join(os.tmpdir(),'agentrouter-demo-'));const children=[];
  // 087：AR_DEMO_SHOW_WORKTREE=1 时多拉起两个假派发进程，给排队中、准备中的 worktree 演示任务用；平时只有两个。
  const showWorktree=process.env.AR_DEMO_SHOW_WORKTREE==='1';
  for(let i=0;i<(showWorktree?4:2);i++){const child=fork(fileURLToPath(new URL('./ar.mjs',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});children.push(child);}
  // AR_DEMO_NOW（毫秒，界面验收时由 tools/shots.mjs 设）：演示数据的"今天 / 昨天"时间戳按它算，
  // 与软件渲染时用的"现在"一致（037 第 2 项，跨午夜不串组）；没有就用真实当前时间。
  const demoNow=Number(process.env.AR_DEMO_NOW)||Date.now();
  const rows=[],now=demoNow;let active=0;
  for(const t of tasks){
    // 演示：除 t4 外都是协议 v2 记录（.agent-runs/<名>/）；t4 保留 v1 旧布局，界面显示"旧任务"标签。
    const repo=path.join(home,'projects',t.project),name=t.record??t.name,legacy=t.id==='t4';
    // 执行者：默认 Codex；data.mjs 里写了 executor 的任务（如 DeepSeek）用它自己的。
    const x={profile:'codex',adapter:'codex',label:'Codex',model:null,agentVersion:'codex-cli 0.156.1',...t.executor};
    const dir=legacy?legacyRunsDir(repo):path.join(repo,'.agent-runs',name);await mkdir(dir,{recursive:true});
    const file=legacy?{progress:name+'.progress.log',report:name+'.md',events:name+'.events.jsonl',raw:name+'.log'}:{progress:'progress.log',report:'report.md',events:'events.jsonl',raw:'raw.log'};
    // 演示进程创建时间必须与 started 接近，不能伪造身份时间；同时进程创建时间必须 ≤ started（registry 的 dispatchMatches）。
    // AR_DEMO_NOW 在派发演示子进程之前取得，可能比子进程创建时间早几毫秒，进行中的任务取两者的较大者。
    const started=t.state==='run'?Math.max(now,Date.now()):new Date(new Date(demoNow).setHours(...t.start.split(':').map(Number),0,0)).getTime()-(t.day==='yesterday'?86400000:0);
    const entry={v:legacy?1:2,event:'start',id:t.id,repo,name,...(legacy?{}:{dir,project:t.project,profile:x.profile,adapter:x.adapter,label:x.label}),title:t.name,spec:t.record?null:`docs/specs/${t.name}.md`,role:t.role,pid:t.state==='run'||(showWorktree&&['queued','preparing'].includes(t.wt?.phase))?children[active++].pid:0,started,progress:path.join(dir,file.progress),report:path.join(dir,file.report),events:path.join(dir,file.events),raw:path.join(dir,file.raw),model:x.model,effort:null,tier:null,sandbox:t.sandbox,managed:t.id==='t1',agent:x.adapter,agentVersion:x.agentVersion,dispatcher:{host:t.dispatcher??'claude-code',session:null},...(t.gate!==undefined?{gate:t.gate,base:t.base??'main'}:{}),...(t.wt?{worktree:true,base:(t.base??'a1b2c3d').padEnd(40,'0')}:{})};
    rows.push(entry);
    // Stage05 多次尝试（061，协议 14.2）：每次尝试 attempt →（门禁 gating / gate）→ attempt-end；最后一次进行中的只有 attempt；
    // 整个任务结束才写一次 end（带 attempts）。运行中的 t25 没有存活的派发进程，不写 end 也不写 interrupted。
    const A=attemptSets[t.id];
    if(A){
      let lastEnd=started;
      for(const a of A){
        rows.push({v:1,event:'attempt',id:t.id,n:a.n,total:a.total,profile:a.profile,reason:a.reason,at:started+a.offset});
        if(a.ms===undefined)continue;
        const endAt=started+a.offset+a.ms;lastEnd=endAt;
        rows.push({v:1,event:'gating',id:t.id,at:endAt-a.gate.ms});
        rows.push({v:1,event:'gate',id:t.id,ok:a.gate.ok,attempt:a.n,at:endAt-100,summary:a.gate.summary});
        rows.push({v:1,event:'attempt-end',id:t.id,n:a.n,ok:a.gateOk===true&&a.exit===0,exit:a.exit,gate:a.gateOk,usage:a.usage,ms:a.ms,at:endAt});
      }
      if(t.state==='done')rows.push({v:1,event:'end',id:t.id,exit:0,at:lastEnd,minutes:Math.round((lastEnd-started)/6000)/10,agentExit:0,attempts:A.length});
    }
    // 门禁事件按核心的顺序：gating → gate → end（协议第 2 节、12.1）。只有真跑过门禁的 end 带 agentExit。
    if(!A&&(t.state==='done'||t.state==='fail')){
      const endedAt=started+60000*parseFloat(t.dur),g=gates[t.id];
      if(g)rows.push({v:1,event:'gating',id:t.id,at:endedAt});
      if(g)rows.push({v:1,event:'gate',id:t.id,ok:g.ok,attempt:g.attempt,at:endedAt+g.ms,summary:g.summary});
      rows.push({v:1,event:'end',id:t.id,exit:t.exit??0,at:endedAt,minutes:parseFloat(t.dur),...(g?{agentExit:t.agentExit??0}:{})});
    }
    // 087 worktree 演示任务：事件序列按 wt.phase 生成（协议 15.3 / 15.6 / 15.7）。
    if(t.wt)rows.push(...wtEvents(t,started,home,showWorktree));
    // t25（state retrying）演示里没有存活的派发进程：写 interrupted，UI23 检查时的 resume 让它回到进行中。
    if(t.state==='stop'||t.state==='retrying')rows.push({v:1,event:'interrupted',id:t.id,at:started+(A?A.at(-1).offset+60000:192000),signal:t.signal??'session-closed'});
    const events=[];let seq=0;const add=e=>events.push({v:1,seq:++seq,at:started+seq*1000,...e});
    if(t.id==='t1')add({kind:'plan',items:plan1.map(([text,status])=>({text,done:status==='done'}))});
    if(t.id==='t2')add({kind:'plan',items:[{text:'读任务说明',done:true},{text:'分页组件',done:false},{text:'接口参数',done:false},{text:'验证、提交、汇报',done:false}]});
    const source=A?[]:t.id==='t1'?ev1:t.id==='t5'?ev5:t.state==='stop'?ev6:t.id==='t2'?[['15:36','say','先读任务说明和现有的搜索结果列表。'],['15:39','file',[['update','src/search/Results.tsx']]]]:[[t.start,'say','已完成，见汇报。']];
    for(const [,kind,value,exit,output] of source){if(kind==='cmd'){const id=`cmd-${seq}`;add({kind,id,phase:'start',command:value});if(exit!==null)add({kind,id,phase:'end',command:value,exit,output,truncated:false});}else if(kind==='file')add({kind,files:value.map(([kind,path])=>({kind,path}))});else if(kind==='turn')add({kind:'turn',usage:t.id==='t5'?{input:64000,output:2100}:{input:182000,output:6400}});else add({kind:kind==='err'?'error':kind,text:String(value).replace(/<code>(.*?)<\/code>/g,'`$1`')});}
    if(t.id==='t3')add({kind:'file',files:files3.map(([kind,path])=>({kind,path}))});
    // 每个事件带 attempt（协议 14.2 第 4 条），时刻落在各自尝试的时间段里；seq 跨尝试连续。
    if(A)for(const a of A){let k=0;const stamp=()=>({at:started+a.offset+(++k)*1000,attempt:a.n});
      for(const [kind,value,exit,output] of a.events){
        if(kind==='cmd'){const id=`cmd-${a.n}-${seq}`;add({kind,id,phase:'start',command:value,...stamp()});if(exit!==null)add({kind,id,phase:'end',command:value,exit,output,truncated:false,...stamp()});}
        else if(kind==='file')add({kind,files:value.map(([kind,path])=>({kind,path})),...stamp()});
        else add({kind,text:value,...stamp()});}}
    await writeFile(entry.events,events.map(e=>JSON.stringify(e)).join('\n')+'\n');await writeFile(entry.raw,'??????\n');
    await writeFile(entry.progress,`=== Codex 开始：${t.name}  ${new Date(started).toLocaleString('zh-CN',{hour12:false})} ===\n[15:39:00] ${t.last??'说：已完成，见汇报。'}\n`+(A?A.filter(a=>a.n>1).map(a=>`=== 第 ${a.n} 次尝试（执行者：${a.profile}；原因：门禁未通过）===\n`).join(''):''));
    // 多次尝试演示任务不写任务说明文件：reader-app 的"已有任务说明"列表保持原样（新建任务页的检查用这个项目）。
    if(entry.spec&&!A){await mkdir(path.join(repo,'docs/specs'),{recursive:true});await writeFile(path.join(repo,entry.spec??'docs/specs/demo.md'),t.goal?`# ${t.name}\n\n## 目标\n\n${t.goal}\n`:`# ${t.name}\n`);}
    for(const e of events)for(const f of e.files??[]){const file=path.join(repo,f.path);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'// 演示文件\n');}
    // 门禁结果文件（协议 12.3）：只给真跑过门禁的任务写；结果原样供软件只读展示。
    if(gates[t.id])await writeFile(path.join(dir,'gate.json'),JSON.stringify({...gates[t.id],at:started+60000*parseFloat(t.dur)},null,2)+'\n');
    if(t.state==='done')await writeFile(entry.report,t.id==='t3'?['# 完成了什么','存档加了版本号，读取时按 v1 → v2 → v3 逐级迁移；旧存档读取后自动写回新格式，并保留一份 `.bak`。','提交：`4f2a9c1`','## 验证','- `npm test` 46/46 通过，新增迁移测试 9 条。','- 用 3 份旧存档样例实际读取，背包、地图、设置都对得上。','## TODO(lead) 2 条','1. 迁移失败时给玩家看的提示文案，现在是占位“【文案待定：存档无法升级】”。','2. 是否在读取旧存档时提示“已升级”。','## 推断清单 3 条','1. 备份文件名用 `<存档名>.bak`，只保留最近一份。','2. 未知字段原样保留，不删除。','3. 版本号写在存档顶层 `v` 字段。','## 已知问题','无。'].join('\n'):t.id==='t4'?'# 完成了什么\n排查结果：白屏是因为首次启动时读取空的设置文件抛错。只读任务，没有改动文件。':`# 完成了什么\n已完成。\n提交：\`${t.commit}\`\n`);
    // 087：已经进入待验收之后的 worktree 演示任务有汇报与派发参数（概览标签读 dispatch.json 的 gate.merged）。
    if(t.wt&&['awaiting','conflict','accepted','rejected'].includes(t.wt.phase)){
      await writeFile(entry.report,t.id==='t32'?wtReport:`# 完成了什么\n已完成。\n提交：\`${t.commit}\`\n`);
      await writeFile(path.join(dir,'dispatch.json'),JSON.stringify({v:1,task:entry.spec,extra:'',role:null,spec:entry.spec,profile:x.profile,name,gate:{enabled:true,base:entry.base,merged:wtMerged}}));
    }
    // 每次尝试的指令、汇报与门禁（attempts/<n>/，协议 14.2 第 3 条）；顶层 report.md / gate.json 保持"最新"（这次没有就保留上一次的）。
    if(A){
      for(const a of A){
        const ad=path.join(dir,'attempts',String(a.n));await mkdir(ad,{recursive:true});
        await writeFile(path.join(ad,'prompt.md'),a.n===1?`# ${t.name}\n\n演示任务说明（第 1 次尝试）。\n`:`# ${t.name}\n\n演示任务说明。\n\n## 上一次尝试没有通过验收（第 ${a.n-1} 次）\n\n失败原因见上一次的 gate.json。\n`);
        if(a.report)await writeFile(path.join(ad,'report.md'),a.report);
        if(a.gate)await writeFile(path.join(ad,'gate.json'),JSON.stringify({...a.gate,at:started+a.offset+a.ms},null,2)+'\n');
      }
      const newest=[...A].reverse(),lastReport=newest.find(a=>a.report),lastGate=newest.find(a=>a.gate);
      if(lastReport)await writeFile(entry.report,lastReport.report);
      if(lastGate)await writeFile(path.join(dir,'gate.json'),JSON.stringify({...lastGate.gate,at:started+lastGate.offset+lastGate.ms},null,2)+'\n');
    }
  }
  await writeFile(path.join(home,'runs.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  // 项目页演示数据：演示仓库登记进隔离的 projects.json；pixel-garden 预置项目配置，notes-web 保持未初始化。
  // reader-app 是 Stage04 门禁演示项目（没有验收命令、允许全部文件），原来的 13 个任务与计数不变。
  // 这里只 git init，不提交，项目页会显示"未提交的改动"，正好演示状态行。
  const projectRows=[];
  for(const name of ['pixel-garden','notes-web','reader-app']){
    const repo=path.join(home,'projects',name);
    spawnSync('git',['init','-b','main'],{cwd:repo,stdio:'ignore',shell:false,windowsHide:true});
    projectRows.push({path:repo,name,addedAt:now,lastUsed:now});
  }
  await writeFile(path.join(home,'projects.json'),JSON.stringify({v:1,projects:projectRows},null,2)+'\n');
  const pixelGarden=path.join(home,'projects','pixel-garden');
  await mkdir(path.join(pixelGarden,'.agent-router'),{recursive:true});
  await writeFile(path.join(pixelGarden,'.agent-router','project.json'),JSON.stringify({v:1,name:'pixel-garden',baseBranch:'main',specsDir:'docs/specs',setup:['npm ci'],verify:['npm test','npm run lint'],allowedPaths:['**'],routing:{rules:[]},worktree:true},null,2)+'\n');
  // 门禁演示项目：没有验收命令、允许全部文件。新建任务页用它演示"类型要求提交时才跑门禁"与可以取消勾选。
  const readerApp=path.join(home,'projects','reader-app');
  await mkdir(path.join(readerApp,'.agent-router'),{recursive:true});
  await writeFile(path.join(readerApp,'.agent-router','project.json'),JSON.stringify({v:1,name:'reader-app',baseBranch:'main',specsDir:'docs/specs',setup:[],verify:[],allowedPaths:['**'],routing:{rules:[]},worktree:true},null,2)+'\n');
  // 验收 / 演示默认把门禁演示任务隐藏（AR_DEMO_HIDDEN_IDS），原有任务数量与列表断言的计数不变；
  // UI22 检查时再由验收代码临时显示它们，结束后恢复。
  // 056：验收模式（设了 AR_DEMO_HIDDEN_IDS）下再并进 t24（受保护路径 / 删除文件的演示任务；
  // tools/shots.mjs 的默认清单还没包含它）；普通演示不隐藏，正好能看到新界面。
  const envIds=String(process.env.AR_DEMO_HIDDEN_IDS??'').split(',').map(id=>id.trim()).filter(Boolean);
  // 061：多次尝试演示任务 t25 / t26 在任何模式下默认隐藏（任务数量与打包验收的 16 行都不变）；
  // 想在 npm run demo 里看它们，设 AR_DEMO_SHOW_ATTEMPTS=1（t25 在演示里没有存活的派发进程，显示为中断）。
  // Stage06 评分演示任务 t27 同样默认隐藏（UI26 检查时临时显示、检查完恢复）。
  const attemptIds=process.env.AR_DEMO_SHOW_ATTEMPTS==='1'?[]:['t25','t26','t27'];
  // 087：worktree 演示任务 t30～t35 同样在任何模式下默认隐藏（任务数量与打包验收的 16 行不变）；想在 npm run demo 里看它们，设 AR_DEMO_SHOW_WORKTREE=1。
  const wtIds=showWorktree?[]:tasks.filter(t=>t.wt).map(t=>t.id);
  const hiddenIds=[...(envIds.length?[...envIds,'t24']:[]),...attemptIds,...wtIds];
  if(hiddenIds.length){
    const keys=rows.filter(r=>r.event==='start'&&hiddenIds.includes(r.id)).map(r=>`${r.id}:${r.started}`);
    await mkdir(path.join(home,'monitor'),{recursive:true});
    await writeFile(path.join(home,'monitor','tasks.json'),JSON.stringify({imports:[],hidden:keys})+'\n');
  }
  // 调用方必须先等 Electron 退出再 close：先结束演示进程（我们自己的假派发进程，5 秒不退再结束），再删除临时目录。
  // 删除失败只警告并给出残留，不覆盖调用方真正的结果。
  return {home,children,async close({limitMs=15000}={}){
    await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',resolve);
      if(child.connected)child.send('exit');setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();},5000).unref();})));
    console.log(`演示：正在删除临时目录……${home}`);
    const result=await removeTemp(home,limitMs);
    if(result.ok)console.log(`演示：临时目录已删除：${home}`);
    else console.warn([`警告：演示临时目录在约 ${Math.round(limitMs/1000)} 秒内没有删完，已停止删除，请关闭占用这些文件的程序后手动删除：${home}`,
      ...result.residue.map(p=>`  残留：${p}`),...result.errors.map(e=>`  错误：${e}`)].join('\n'));
    return result;}};
}

// 087：worktree 演示任务的事件（协议 15.3 / 15.6 / 15.7）：queued → preparing → worktree → setup → attempt → gating → gate → attempt-end → end，
// 之后按阶段补 conflict / accepted / rejected。排队与准备中的任务只写到各自的阶段；没有存活的派发进程时再补一行 interrupted（它们才会被隐藏）。
function wtEvents(t,started,home,live){
  const w=t.wt,id=t.id,dir=path.join(home,'wt',`${t.project}-${id}`),base=(t.base??'a1b2c3d').padEnd(40,'0');
  const rows=[{v:1,event:'queued',id,at:started+300}];
  const stop=()=>live?[]:[{v:1,event:'interrupted',id,at:started+2000,signal:'session-closed'}];
  if(w.phase==='queued')return [...rows,...stop()];
  rows.push({v:1,event:'preparing',id,at:started+1000},{v:1,event:'worktree',id,dir,branch:w.branch,base,at:started+1500});
  if(w.phase==='preparing')return [...rows,...stop()];
  const endedAt=started+60000*parseFloat(t.dur),g=gates[id];
  rows.push({v:1,event:'setup',id,ok:true,ms:18000,at:started+20000,summary:'准备命令通过'},{v:1,event:'attempt',id,n:1,total:3,profile:(t.executor?.profile??'codex'),reason:'first',at:started+21000});
  rows.push({v:1,event:'gating',id,at:endedAt-g.ms},{v:1,event:'gate',id,ok:true,attempt:1,at:endedAt-100,summary:g.summary},{v:1,event:'attempt-end',id,n:1,ok:true,exit:0,gate:true,usage:{input:null,output:null},ms:endedAt-started-21000,at:endedAt-50});
  rows.push({v:1,event:'end',id,exit:0,at:endedAt,minutes:parseFloat(t.dur),agentExit:0,attempts:1});
  if(w.phase==='conflict')rows.push({v:1,event:'conflict',id,files:w.files,at:endedAt+60000});
  if(w.phase==='accepted')rows.push({v:1,event:'accepted',id,merge:w.merge.padEnd(40,'0'),mode:'no-ff',by:w.by,at:endedAt+120000});
  if(w.phase==='rejected')rows.push({v:1,event:'rejected',id,reason:w.reason,keptBranch:false,by:w.by,at:endedAt+120000});
  return rows;
}

// 删除临时目录：总时限 limitMs。每一轮用同步调用把能删的都删掉（遇到被占用的文件跳过、记下原因），
// 删不完就等 0.5 秒再来一轮；到时限就停。同步调用返回时删除已经结束，不会在后台继续删除。
export async function removeTemp(dir,limitMs=15000){
  const deadline=Date.now()+limitMs;let errors=new Map();
  for(;;){
    errors=new Map();sweep(dir,errors);
    if(!existsSync(dir))return {ok:true,residue:[],errors:[]};
    if(Date.now()>=deadline)break;
    await delay(Math.min(500,Math.max(0,deadline-Date.now())));
  }
  return {ok:false,residue:residue(dir),errors:[...errors.values()].slice(0,5)};
}
function sweep(dir,errors){
  let entries;
  try{entries=readdirSync(dir,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')errors.set(dir,`${e.code} ${dir}`);return;}
  for(const entry of entries){
    const p=path.join(dir,entry.name);
    if(entry.isDirectory()&&!entry.isSymbolicLink())sweep(p,errors);
    else try{rmSync(p,{force:true});}catch(e){errors.set(p,`${e.code} ${p}`);}
  }
  try{rmdirSync(dir);}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTEMPTY')errors.set(dir,`${e.code} ${dir}`);}
}
// 残留：最多列 10 个最深一层的路径（文件或空不掉的目录）。
function residue(dir,list=[]){
  let entries;try{entries=readdirSync(dir,{withFileTypes:true});}catch{return list;}
  if(!entries.length&&list.length<10)list.push(dir);
  for(const entry of entries){if(list.length>=10)break;const p=path.join(dir,entry.name);if(entry.isDirectory()&&!entry.isSymbolicLink())residue(p,list);else list.push(p);}
  return list;
}
