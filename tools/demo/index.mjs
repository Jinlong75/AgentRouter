import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tasks, plan1, ev1, ev5, ev6, files3 } from './data.mjs';
import { legacyRunsDir } from '../../core/lib/compat.mjs';
export async function demo(){
  const home=await mkdtemp(path.join(os.tmpdir(),'agentrouter-demo-'));const children=[];
  for(let i=0;i<2;i++){const child=fork(fileURLToPath(new URL('./ar.mjs',import.meta.url)),[],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});children.push(child);}
  const rows=[],now=Date.now();let active=0;
  for(const t of tasks){
    // 演示：除 t4 外都是协议 v2 记录（.agent-runs/<名>/）；t4 保留 v1 旧布局，界面显示"旧任务"标签。
    const repo=path.join(home,'projects',t.project),name=t.record??t.name,legacy=t.id==='t4';
    // 执行者：默认 Codex；data.mjs 里写了 executor 的任务（如 DeepSeek）用它自己的。
    const x={profile:'codex',adapter:'codex',label:'Codex',model:null,agentVersion:'codex-cli 0.156.1',...t.executor};
    const dir=legacy?legacyRunsDir(repo):path.join(repo,'.agent-runs',name);await mkdir(dir,{recursive:true});
    const file=legacy?{progress:name+'.progress.log',report:name+'.md',events:name+'.events.jsonl',raw:name+'.log'}:{progress:'progress.log',report:'report.md',events:'events.jsonl',raw:'raw.log'};
    // 演示进程创建时间必须与 started 接近，不能伪造身份时间。
    const started=t.state==='run'?now:new Date(new Date().setHours(...t.start.split(':').map(Number),0,0)).getTime()-(t.day==='yesterday'?86400000:0);
    const entry={v:legacy?1:2,event:'start',id:t.id,repo,name,...(legacy?{}:{dir,project:t.project,profile:x.profile,adapter:x.adapter,label:x.label}),title:t.name,spec:t.record?null:`docs/specs/${t.name}.md`,role:t.role,pid:t.state==='run'?children[active++].pid:0,started,progress:path.join(dir,file.progress),report:path.join(dir,file.report),events:path.join(dir,file.events),raw:path.join(dir,file.raw),model:x.model,effort:null,tier:null,sandbox:t.sandbox,managed:t.id==='t1',agent:x.adapter,agentVersion:x.agentVersion,dispatcher:{host:t.dispatcher??'claude-code',session:null}};
    rows.push(entry);if(t.state==='done'||t.state==='fail')rows.push({v:1,event:'end',id:t.id,exit:t.exit??0,at:started+60000*parseFloat(t.dur),minutes:parseFloat(t.dur)});if(t.state==='stop')rows.push({v:1,event:'interrupted',id:t.id,at:started+192000,signal:t.signal??'session-closed'});
    const events=[];let seq=0;const add=e=>events.push({v:1,seq:++seq,at:started+seq*1000,...e});
    if(t.id==='t1')add({kind:'plan',items:plan1.map(([text,status])=>({text,done:status==='done'}))});
    if(t.id==='t2')add({kind:'plan',items:[{text:'读任务说明',done:true},{text:'分页组件',done:false},{text:'接口参数',done:false},{text:'验证、提交、汇报',done:false}]});
    const source=t.id==='t1'?ev1:t.id==='t5'?ev5:t.state==='stop'?ev6:t.id==='t2'?[['15:36','say','先读任务说明和现有的搜索结果列表。'],['15:39','file',[['update','src/search/Results.tsx']]]]:[[t.start,'say','已完成，见汇报。']];
    for(const [,kind,value,exit,output] of source){if(kind==='cmd'){const id=`cmd-${seq}`;add({kind,id,phase:'start',command:value});if(exit!==null)add({kind,id,phase:'end',command:value,exit,output,truncated:false});}else if(kind==='file')add({kind,files:value.map(([kind,path])=>({kind,path}))});else if(kind==='turn')add({kind:'turn',usage:t.id==='t5'?{input:64000,output:2100}:{input:182000,output:6400}});else add({kind:kind==='err'?'error':kind,text:String(value).replace(/<code>(.*?)<\/code>/g,'`$1`')});}
    if(t.id==='t3')add({kind:'file',files:files3.map(([kind,path])=>({kind,path}))});
    await writeFile(entry.events,events.map(e=>JSON.stringify(e)).join('\n')+'\n');await writeFile(entry.raw,'??????\n');
    await writeFile(entry.progress,`=== Codex 开始：${t.name}  ${new Date(started).toLocaleString('zh-CN',{hour12:false})} ===\n[15:39:00] ${t.last??'说：已完成，见汇报。'}\n`);
    if(entry.spec){await mkdir(path.join(repo,'docs/specs'),{recursive:true});await writeFile(path.join(repo,entry.spec??'docs/specs/demo.md'),`# ${t.name}\n`);}
    for(const e of events)for(const f of e.files??[]){const file=path.join(repo,f.path);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'// 演示文件\n');}
    if(t.state==='done')await writeFile(entry.report,t.id==='t3'?['# 完成了什么','存档加了版本号，读取时按 v1 → v2 → v3 逐级迁移；旧存档读取后自动写回新格式，并保留一份 `.bak`。','提交：`4f2a9c1`','## 验证','- `npm test` 46/46 通过，新增迁移测试 9 条。','- 用 3 份旧存档样例实际读取，背包、地图、设置都对得上。','## TODO(lead) 2 条','1. 迁移失败时给玩家看的提示文案，现在是占位“【文案待定：存档无法升级】”。','2. 是否在读取旧存档时提示“已升级”。','## 推断清单 3 条','1. 备份文件名用 `<存档名>.bak`，只保留最近一份。','2. 未知字段原样保留，不删除。','3. 版本号写在存档顶层 `v` 字段。','## 已知问题','无。'].join('\n'):t.id==='t4'?'# 完成了什么\n排查结果：白屏是因为首次启动时读取空的设置文件抛错。只读任务，没有改动文件。':`# 完成了什么\n已完成。\n提交：\`${t.commit}\`\n`);
  }
  await writeFile(path.join(home,'runs.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  // 项目页演示数据：两个演示仓库登记进隔离的 projects.json；pixel-garden 预置项目配置，notes-web 保持未初始化。
  // 这里只 git init，不提交，项目页会显示"未提交的改动"，正好演示状态行。
  const projectRows=[];
  for(const name of ['pixel-garden','notes-web']){
    const repo=path.join(home,'projects',name);
    spawnSync('git',['init','-b','main'],{cwd:repo,stdio:'ignore',shell:false,windowsHide:true});
    projectRows.push({path:repo,name,addedAt:now,lastUsed:now});
  }
  await writeFile(path.join(home,'projects.json'),JSON.stringify({v:1,projects:projectRows},null,2)+'\n');
  const pixelGarden=path.join(home,'projects','pixel-garden');
  await mkdir(path.join(pixelGarden,'.agent-router'),{recursive:true});
  await writeFile(path.join(pixelGarden,'.agent-router','project.json'),JSON.stringify({v:1,name:'pixel-garden',baseBranch:'main',specsDir:'docs/specs',setup:['npm ci'],verify:['npm test','npm run lint'],allowedPaths:['**'],routing:{rules:[]},worktree:true},null,2)+'\n');
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
