import { spawn, execFileSync } from 'node:child_process';
import electron from 'electron';
import { preferenceFixture } from './demo/preferences.mjs';
import path from 'node:path';
import { demo } from './demo/index.mjs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { isolatedEnvKey, isolationOverrides } from '../app/src/main/app-env.mjs';
const fixture=await demo();
try {
  const out=path.resolve('app/dist/shots');
  // 与 npm run demo 相同：隔离环境只经 AR_ISOLATED_ENV 交给软件内部，Electron 进程本身拿用户真实环境（见 app/src/main/app-env.mjs）。
  const real={...process.env};delete real.ELECTRON_RUN_AS_NODE;
  const isolated={...await preferenceFixture(fixture.home,{install:['agent-router']}),AGENT_ROUTER_HOME:fixture.home};delete isolated.ELECTRON_RUN_AS_NODE;
  // AR_QUIT_TRACE=1：软件退出的各阶段（窗口关闭、before-quit、各清理步骤）带时刻打到标准错误，退出后实测失败时用来对时间线。
  const env={...real,AR_SHOTS:out,AR_TEST_NODE:process.execPath,AR_SHOTS_AGENT_TIMEOUT:"8",AR_QUIT_TRACE:"1",[isolatedEnvKey]:JSON.stringify(isolationOverrides(real,isolated))};
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
    const who=pid=>{if(process.platform!=='win32')return '（非 Windows，不查）';try{return execFileSync('powershell.exe',['-NoProfile','-Command',`[Console]::OutputEncoding=[Text.Encoding]::UTF8;$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if($p){"$($p.Name) 创建于 $($p.CreationDate.ToUniversalTime().ToString('o'))"}else{'不存在'}`],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();}catch(e){return `查询失败（${e.code??e.message}）`;}};
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
      // 托管任务的假 agent 等到这里才被放行：上面的存活断言之后、等 end 之前写出放行文件（顺序与上限都不变）。
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
    await writeFile(path.join(out,'managed-exit.json'),JSON.stringify({platform:process.platform,appExit:0,tasks:results},null,2));
    await unlink(path.join(out,'exit-pending.json'));
    // 重置前等这些进程真的退出：它们的工作目录与打开的文件都在公共目录里，Windows 上会挡住删除。
    // 不这样等，重置验收就会去删一个"任务已经结束但进程还在收尾"的目录，和用户实际能点重置的时机不一致。
    for(const item of pending) for(const [kind,pid] of [['执行者',item.executor],['假 agent',item.agent]]) {
      let waited=0;
      while(alive(pid)&&waited<20000) { await delay(100);waited+=100; }
      if(alive(pid)) console.log(`注意：${item.label}的${kind}（pid=${pid}）在重置前仍未退出`);
    }

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
    const resetIsolated={...isolated,USERPROFILE:fixture.home+'-user',HOME:fixture.home+'-user'};
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
      const leftover=path.join(fixture.home,'tmp','agent-router-reset-leftover.json');
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
} finally {await fixture.close();}
