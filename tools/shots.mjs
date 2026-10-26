import { spawn, execFileSync } from 'node:child_process';
import electron from 'electron';
import { preferenceFixture } from './demo/preferences.mjs';
import path from 'node:path';
import { demo } from './demo/index.mjs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { isolatedEnvKey, isolationOverrides } from '../app/src/main/app-env.mjs';
import { unsafeHomeReason } from '../core/lib/compat.mjs';
// 界面验收可能跨午夜（037 第 2 项）：演示数据生成与软件里的"今天 / 昨天"分组用同一个"现在"——
// AR_DEMO_NOW（毫秒时间戳）。这里在生成演示数据之前设好；外部已设时沿用不覆盖（负向验证要指定时刻）。
process.env.AR_DEMO_NOW ||= String(Date.now());
// Stage04 门禁演示任务（reader-app 的 t20～t22）默认隐藏：原有列表计数与检查不变，
// UI22 在验收里临时显示它们，检查完再恢复 hidden。
process.env.AR_DEMO_HIDDEN_IDS ||= 't20,t21,t22';

// 启动前检查（052）：假用户目录的整棵目录快照（相对路径 → 目录 / 文件的大小与修改时间），
// 用来断言主进程拒绝时不在这棵目录里写任何东西。
async function snapshotTree(root) {
  const entries=new Map();
  const walk=async dir=>{
    for(const item of await readdir(dir,{withFileTypes:true})) {
      const full=path.join(dir,item.name),rel=path.relative(root,full);
      if(item.isDirectory()) { entries.set(rel,'dir'); await walk(full); }
      else { const info=await stat(full); entries.set(rel,`${info.size}:${info.mtimeMs}`); }
    }
  };
  await walk(root);
  return entries;
}
// 超时后结束整棵进程树（Electron 会带出子进程）；已经退出时忽略。
function killTree(pid) {
  try {
    if(process.platform==='win32') execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    else process.kill(pid,'SIGKILL');
  } catch { /* 已经退出 */ }
}
// 启动前检查（052）：公共目录指向假用户目录时，主进程必须在设置数据目录、取锁、迁移之前拒绝并以退出码 2 退出；
// 假用户目录整棵前后完全相同。盘符根不做实测（防护失效会写进真实的盘符根），由 047 的单元测试覆盖。
async function unsafeHomeStartupCheck(out,real,isolated) {
  const fakeUser=await mkdtemp(path.join(tmpdir(),'agent-router-shots-user-'));
  await writeFile(path.join(fakeUser,'known-file.txt'),'已知文件：用来核对整棵目录前后是否相同\n');
  const before=await snapshotTree(fakeUser);
  // 隔离覆盖与正式验收同一个机制：公共目录、用户目录都指向假用户目录；AR_SHOTS 直接设在 Electron 进程环境里（不弹框）。
  const guardIsolated={...isolated,AGENT_ROUTER_HOME:fakeUser,USERPROFILE:fakeUser,HOME:fakeUser};
  const guardEnv={...real,AR_SHOTS:out,[isolatedEnvKey]:JSON.stringify(isolationOverrides(real,guardIsolated))};
  const started=Date.now();
  const child=spawn(electron,['.'],{env:guardEnv,stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});
  let stderr='',timedOut=false;
  child.stdout.resume();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const timer=setTimeout(()=>{timedOut=true;killTree(child.pid);},20000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  clearTimeout(timer);
  const elapsed=Date.now()-started,after=await snapshotTree(fakeUser);
  assert.equal(timedOut,false,'主进程应在 20 秒内拒绝不安全的公共目录并退出');
  assert.equal(code,2,`主进程应以退出码 2 拒绝不安全的公共目录（实际 ${code}）`);
  const reason=unsafeHomeReason(path.resolve(fakeUser));
  assert.ok(stderr.includes(reason),`标准错误应包含原因原文（实际：${stderr.trim()||'（空）'}）`);
  assert.equal(after.size,before.size,'假用户目录的文件数量不应变化');
  for(const [rel,stamp] of before) assert.equal(after.get(rel),stamp,`假用户目录中的 ${rel} 不应被修改`);
  console.log(`启动前检查：主进程拒绝把公共目录设为用户目录（退出码 2，用时 ${elapsed} ms，假用户目录没有任何改动）`);
}

// 066：失败现场目录（任何检查失败时由软件写入截图与焦点 JSON）。每次验收开始时清空，只清这一个目录。
const failuresDir=path.resolve('app/dist/shots','failures');
async function announceFailures() {
  const files=await readdir(failuresDir).catch(()=>[]);
  if(files.length) console.log('失败现场目录：'+path.relative(process.cwd(),failuresDir)+'（'+files.join('、')+'）');
}

const fixture=await demo();
let reposAside='',resetTemp='';
try {
  const out=path.resolve('app/dist/shots');
  await rm(failuresDir,{recursive:true,force:true});
  // 与 npm run demo 相同：隔离环境只经 AR_ISOLATED_ENV 交给软件内部，Electron 进程本身拿用户真实环境（见 app/src/main/app-env.mjs）。
  const real={...process.env};delete real.ELECTRON_RUN_AS_NODE;
  const isolated={...await preferenceFixture(fixture.home,{install:['agent-router']}),AGENT_ROUTER_HOME:fixture.home};delete isolated.ELECTRON_RUN_AS_NODE;
  // AR_QUIT_TRACE=1：软件退出的各阶段（窗口关闭、before-quit、各清理步骤）带时刻打到标准错误，退出后实测失败时用来对时间线。
  const env={...real,AR_SHOTS:out,AR_TEST_NODE:process.execPath,AR_SHOTS_AGENT_TIMEOUT:"8",AR_QUIT_TRACE:"1",[isolatedEnvKey]:JSON.stringify(isolationOverrides(real,isolated))};
  // 052：正式验收启动之前先做一次启动前检查（公共目录保护），失败时整个验收以非 0 退出。
  await unsafeHomeStartupCheck(out,real,isolated);
  await unlink(path.join(out,'exit-pending.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});
  const child=spawn(electron,['.'],{env,stdio:'inherit',windowsHide:true,shell:false});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  const appExitAt=Date.now();
  if(code) process.exitCode=Number(code);
  // 单独复现某项检查（AR_SHOTS_FOCUS，PR #5 CI）时软件只跑那一项就退出，没有退出后待查任务，也不做重置的第二次启动。
  else if(process.env.AR_SHOTS_FOCUS) console.log(`单独复现 ${process.env.AR_SHOTS_FOCUS}：跳过退出后检查与重置。`);
  else {
    // 退出前准备的任务：托管任务（技能派发、真实 Electron 认领）与脱离任务（再派一次派发）。
    const pending=JSON.parse(await readFile(path.join(out,'exit-pending.json'),'utf8'));
    assert.equal(Array.isArray(pending),true,'退出前待查任务应为数组');
    assert.equal(pending.length,2,'应该同时检查托管任务与脱离任务');
    const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
    const results=[];
    // 诊断（PR #5 CI）：每项都打印时间线（就绪 → 写出待查 → Electron 退出 → 检查，以及记录里的事件时刻）；
    // 进程不在时再核对 PID 现在是谁（是否被复用）并附等待者日志尾部。只打印，不改判断、不加等待。
    const rowsOf=async id=>{const text=await readFile(path.join(fixture.home,'runs.jsonl'),'utf8');return text.slice(0,text.lastIndexOf('\n')).split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(r=>r&&r.id===id);};
    // 中文输出不依赖控制台代码页：命令里先把输出编码固定为 UTF-8，Node 再按 UTF-8 读。
    // 024：进程身份（名字 + 创建时间）——PID 可能被复用，退出后要与就绪时记下的一致才算"同一个进程"。
    // 用与软件进程查询（app/src/main/platform.ts）相同的 API 和毫秒单位，便于直接比较。
    const identity=pid=>{if(process.platform!=='win32')return null;const text=execFileSync('powershell.exe',['-NoProfile','-Command',`[Console]::OutputEncoding=[Text.Encoding]::UTF8;$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}";if($p){@{name=$p.Name;created=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress}`],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();return text?JSON.parse(text):null;};
    const describe=p=>p?`${p.name} 创建于 ${new Date(p.created).toISOString()}`:'（查不到）';
    const who=pid=>{if(process.platform!=='win32')return '（非 Windows，不查）';try{const p=identity(pid);return p?describe(p):'不存在';}catch(e){return `查询失败（${e.code??e.message}）`;}};
    // 就绪时记下的身份与现在的身份比对；查不到或对不上都按"不是同一个进程"处理（断言失败）。
    const sameProcess=(item,pid)=>{const before=(item.processes??[]).find(x=>x.pid===pid);if(!before)return {same:false,before:null,now:null};try{const now=identity(pid);return {same:!!now&&now.name===before.name&&now.created===before.created,before,now};}catch{return {same:false,before,now:null};}};
    // 失败时也要等进程退出（放行后它们会在正常清理里结束）；与成功路径共用。
    const waitExit=async()=>{for(const item of pending) for(const [kind,pid] of [['执行者',item.executor],['假 agent',item.agent]]) {
      let waited=0;
      while(alive(pid)&&waited<20000) { await delay(100);waited+=100; }
      if(alive(pid)) console.log(`注意：${item.label}的${kind}（pid=${pid}）在重置前仍未退出`);
    }};
    let failure=null;
    try {
      for(const item of pending) {
        const t0=item.readyAt,rel=at=>Number.isFinite(at)?`+${at-t0}ms`:'—';
        const events=(await rowsOf(item.id)).map(r=>`${r.event}${r.exit!==undefined?' exit='+r.exit:''} ${rel(r.at??r.started)}`).join('、')||'（没有记录）';
        const ex=alive(item.executor),ag=alive(item.agent);
        console.log(`退出后实测时间线（${item.label}，就绪 ${new Date(t0).toISOString()}）：写出待查 ${rel(item.pendingAt)}，Electron 退出 ${rel(appExitAt)}，检查 ${rel(Date.now())}；记录事件 ${events}；执行者 ${item.executor} ${ex?'存活':'不在'}，假 agent ${item.agent} ${ag?'存活':'不在'}`);
        if(!ex||!ag) {
          const before=pid=>{const p=(item.processes??[]).find(x=>x.pid===pid);return p?`${p.name} 创建于 ${new Date(p.created).toISOString()}`:'（就绪时没查到）';};
          const log=await readFile(path.join(fixture.home,item.waiterLog),'utf8').then(t=>t.trimEnd().split(/\r?\n/).slice(-5).join(' | '),()=>'（读不到）');
          console.log(`退出后实测进程核对（${item.label}）：执行者 ${item.executor} 就绪时 ${before(item.executor)}，现在 ${who(item.executor)}；假 agent ${item.agent} 就绪时 ${before(item.agent)}，现在 ${who(item.agent)}；等待者日志尾部 ${log}`);
        }
        assert.equal(alive(item.executor),true,`真实 Electron 退出后${item.label}的执行者仍存活`);
        assert.equal(alive(item.agent),true,`真实 Electron 退出后${item.label}的假 agent 仍存活`);
        // 024：仍是就绪时的同一个进程（PID 存活且创建时间一致）。托管与脱离两项都查；查不到或对不上都按"不是同一个进程"让断言失败。
        for(const [kind,pid] of [['执行者',item.executor],['假 agent',item.agent]]) {
          if(process.platform!=='win32') { console.log(`退出后实测进程身份（${item.label}的${kind}）：非 Windows，不查创建时间`);continue; }
          const same=sameProcess(item,pid);
          console.log(`退出后实测进程身份（${item.label}的${kind}）：${same.same?'与就绪时是同一个进程':'不是同一个进程'}；就绪时 ${describe(same.before)}，现在 ${describe(same.now)}`);
          assert.equal(same.same,true,`真实 Electron 退出后${item.label}的${kind}仍是就绪时的同一个进程`);
        }
        // 托管与脱离任务的假 agent 都等到这里才被放行：上面的存活与身份断言之后、等 end 之前写出放行文件（顺序与上限都不变）。
        if(item.release) { await writeFile(item.release,'1'); console.log(`退出后实测：已放行${item.label}的假 agent`); }
        let end;
        // 单调时钟真实截止（原来按 150 次 × 100 ms 轮询计）：上限 15 秒。
        for(const until=performance.now()+15000;performance.now()<until;) {
          const text=await readFile(path.join(fixture.home,'runs.jsonl'),'utf8');
          const rows=text.slice(0,text.lastIndexOf('\n')).split('\n').filter(Boolean).map(JSON.parse);
          end=rows.find(r=>r.id===item.id&&r.event==='end');
          if(end) { assert.equal(rows.filter(r=>r.id===item.id&&r.event==='start').length,1,`${item.label}的 start 应该只有一条`);break; }
          await delay(100);
        }
        assert.equal(end?.exit,0,`真实软件退出后${item.label}正常结束`);
        let waiterFinished=false;
        // 上限 2.5 秒（原来按 50 次 × 50 ms 轮询计）。
        for(const until=performance.now()+2500;!waiterFinished;) {
          const output=await readFile(path.join(fixture.home,item.waiterLog),'utf8');
          if(output.includes('exit=0 report=')&&performance.now()<=until) { waiterFinished=true;break; }
          assert.ok(performance.now()<until,`${item.label}的等待者没有正常打印结束行`);await delay(50);
        }
        results.push({label:item.label,id:item.id,executorAliveAfterAppExit:true,agentAliveAfterAppExit:true,taskExit:end.exit,waiterFinished});
        console.log(`Windows 实测：真实 Electron 退出后，${item.label}的执行者与假 agent 仍存活，任务 end.exit=0，等待者正常结束。`);
      }
    } catch(error) { failure=error; }
    finally {
      // 024：无论检查通过还是失败，都放行所有项的假 agent，失败时不能留下一直在等放行的进程
      //（它们最多等到 releaseTimeoutMs 就会以非 0 退出，正常清理应当在这之前放行）。
      for(const item of pending) if(item.release) await writeFile(item.release,'1').catch(error=>console.log(`注意：放行${item.label}的假 agent 失败：${error.message}`));
    }
    // 失败时也等它们退出（放行后会在正常清理里结束），再把原来的断言错误抛出去。
    if(failure) { await waitExit();throw failure; }
    await writeFile(path.join(out,'managed-exit.json'),JSON.stringify({platform:process.platform,appExit:0,tasks:results},null,2));
    await unlink(path.join(out,'exit-pending.json'));
    // 重置前等这些进程真的退出：它们的工作目录与打开的文件都在公共目录里，Windows 上会挡住删除。
    // 不这样等，重置验收就会去删一个"任务已经结束但进程还在收尾"的目录，和用户实际能点重置的时机不一致。
    await waitExit();

    // 第二轮（012 B）：在隔离公共目录上真实重置一次。第一轮会改写配置、切换技能版本，所以这里重新准备一份
    // 带密钥来源的配置与测试密钥文件；重置的密钥来自测试文件，绝不会碰本机真实的用户环境变量。
    const configFile=path.join(fixture.home,'config.json');
    await writeFile(configFile,JSON.stringify({v:2,defaultProfile:'deepseek',managed:false,watchWindow:'never',profiles:{
      deepseek:{adapter:'claude-code',label:'DeepSeek 演示',enabled:true,auth:'token',secrets:{ANTHROPIC_AUTH_TOKEN:'DEEPSEEK_API_KEY'}},
    }},null,2)+'\n');
    const secretsFile=isolated.AR_TEST_SECRETS_FILE;
    await writeFile(secretsFile,JSON.stringify({DEEPSEEK_API_KEY:'sk-reset-fixture-not-real',OTHER_UNUSED_KEY:'keep-me'},null,2)+'\n');
    const skillDir=path.join(isolated.CLAUDE_CONFIG_DIR,'skills','agent-router');
    assert.ok(existsSync(skillDir),'重置前隔离目录里应该装有 agent-router 技能');
    await unlink(path.join(out,'reset-evidence.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});
    // 清理进程拒绝删除"包含用户主目录"的路径；隔离夹具默认把 USERPROFILE 放在公共目录里，
    // 所以这一轮把用户主目录挪到公共目录旁边（其他隔离项不变），让重置走与真实安装相同的形状。
    // 135：公共目录里界面检查自己建的测试仓库（shots-*）在真实安装里不存在，且 git 对象文件只读、几千个文件
    // 逐个删会超过清理进程的 30 秒预算。重置前把它们同盘 rename 到公共目录旁边，让重置走与真实安装相同的形状。
    const countFiles=async dir=>{
      let n=0;
      for(const item of await readdir(dir,{withFileTypes:true})) n+=item.isDirectory()?await countFiles(path.join(dir,item.name)):1;
      return n;
    };
    const reportHome=async label=>{
      const rows=[];
      for(const item of await readdir(fixture.home,{withFileTypes:true})) rows.push([item.name,item.isDirectory()?await countFiles(path.join(fixture.home,item.name)):1]);
      rows.sort((a,b)=>b[1]-a[1]);
      console.log(`公共目录文件数（${label}）：共 ${rows.reduce((s,r)=>s+r[1],0)}；顶层前 10：${rows.slice(0,10).map(r=>`${r[0]}=${r[1]}`).join(', ')}`);
    };
    reposAside=fixture.home+'-repos';
    resetTemp=fixture.home+'-tmp';
    await reportHome('移出前');
    await mkdir(reposAside,{recursive:true});
    const moved=[];
    for(const item of await readdir(fixture.home,{withFileTypes:true})) {
      if(!item.isDirectory()||!item.name.startsWith('shots-')) continue;
      await rename(path.join(fixture.home,item.name),path.join(reposAside,item.name));
      moved.push(item.name);
    }
    console.log(`重置前移出界面检查自建的测试仓库目录：${moved.join(', ')||'（无）'}`);
    await reportHome('移出后');
    // 重置这次启动的临时目录放在公共目录外面：清理进程的残留标记写在它自己的 os.tmpdir() 里，
    // 放在被删的目录下就看不到（或被一起删掉）。
    await mkdir(resetTemp,{recursive:true});
    const resetIsolated={...isolated,USERPROFILE:fixture.home+'-user',HOME:fixture.home+'-user',TEMP:resetTemp,TMP:resetTemp};
    if('TMPDIR' in isolated) resetIsolated.TMPDIR=resetTemp;
    const resetEnv={...env,AR_SHOTS_RESET:'1',[isolatedEnvKey]:JSON.stringify(isolationOverrides(real,resetIsolated))};
    delete resetEnv.AR_PACKAGED_VERIFY;
    const resetChild=spawn(electron,['.'],{env:resetEnv,stdio:'inherit',windowsHide:true,shell:false});
    const resetCode=await new Promise((resolve,reject)=>{resetChild.on('error',reject);resetChild.on('exit',resolve);});
    assert.equal(resetCode,0,'隔离重置的第二次启动应该正常退出');
    const evidence=JSON.parse(await readFile(path.join(out,'reset-evidence.json'),'utf8'));
    assert.equal(evidence.secretsRequested,true,'应该勾选删除密钥');
    assert.equal(evidence.skillsRequested,true,'应该勾选卸载技能');
    assert.deepEqual(evidence.secretNames,['DEEPSEEK_API_KEY'],'重置范围应只包括配置里用到的密钥变量');
    assert.deepEqual(evidence.removedSecrets,['DEEPSEEK_API_KEY'],'勾选的密钥变量应被删除');
    assert.deepEqual(evidence.remainingSecrets,['OTHER_UNUSED_KEY'],'未在配置里用到的密钥变量不应被动');
    assert.ok(evidence.skillsRemoved>=1,'勾选的技能应被卸载');
    assert.equal(existsSync(skillDir),false,'技能目录应该已经被卸载');
    // 清理进程等软件退出后才动手；最多等 40 秒，失败会留下残留标记而不是静默装作成功。
    // 上限 40 秒（原来按 400 次 × 100 ms 轮询计）。
    for(const until=performance.now()+40000;existsSync(fixture.home)&&performance.now()<until;) await delay(100);
    if(existsSync(fixture.home)) {
      // 失败时把清理进程留下的诊断（原因、尝试次数、仍未删掉的路径）打出来，方便定位被谁占着。
      const leftover=path.join(resetTemp,'agent-router-reset-leftover.json');
      console.log(`诊断：公共目录仍在。残留标记：${existsSync(leftover)?await readFile(leftover,'utf8'):'（没有）'}`);
    }
    assert.equal(existsSync(fixture.home),false,'软件退出后隔离公共目录应被删除');
    await writeFile(path.join(out,'reset-check.json'),JSON.stringify({
      platform:process.platform,appExit:resetCode,homeRemoved:true,
      secretNames:evidence.secretNames,removedSecrets:evidence.removedSecrets,remainingSecrets:evidence.remainingSecrets,
      skillsRemoved:evidence.skillsRemoved,
    },null,2));
    console.log('Windows 实测：软件退出后在隔离公共目录上完成真实重置——公共目录删除、勾选的密钥与技能删除、未勾选的不动。');
  }
} finally {
  await fixture.close();
  // 135：旁边的两个目录不管成功失败都删掉，不留在系统临时目录里。
  for(const dir of [reposAside,resetTemp]) if(dir) await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(error=>console.log(`注意：删除 ${dir} 失败：${error.message}`));
  await announceFailures();
}
