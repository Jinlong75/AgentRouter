import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import electron from 'electron';
import { preferenceFixture } from './preferences.mjs';
import { demo } from './index.mjs';
import { tasks, reportRich } from './data.mjs';
import { isolatedEnvKey, isolationOverrides } from '../../app/src/main/app-env.mjs';
const fixture=await demo();
try {
  // 演示汇报正文（任务 011）：index.mjs 写的是默认汇报，这里用 data.mjs 的 reportRich 覆盖，演示里能看到完整排版。
  const t3=tasks.find(t=>t.id==='t3');
  await writeFile(path.join(fixture.home,'projects',t3.project,'.agent-runs',t3.record??t3.name,'report.md'),reportRich);
  // 隔离环境只交给软件内部使用（AR_ISOLATED_ENV，见 app/src/main/app-env.mjs）；Electron 进程本身拿用户真实环境，
  // 这样软件打开的外部程序（编辑器等）不会带走演示的假 USERPROFILE / APPDATA / LOCALAPPDATA。
  const real={...process.env};delete real.ELECTRON_RUN_AS_NODE;
  const isolated={...await preferenceFixture(fixture.home),AGENT_ROUTER_HOME:fixture.home};delete isolated.ELECTRON_RUN_AS_NODE;
  const env={...real,[isolatedEnvKey]:JSON.stringify(isolationOverrides(real,isolated))};
  // 演示默认关闭硬件加速：针对当前观察到的 NVIDIA 驱动路径删除目录行为的临时规避措施，后续重新评估。
  // 调查 GPU 问题时显式设 AR_DISABLE_GPU=0 开启。它只是本项目的开关，软件打开的外部程序（如 Typora）不会识别它。
  if(env.AR_DISABLE_GPU===undefined)env.AR_DISABLE_GPU='1';
  console.log(`演示：硬件加速${env.AR_DISABLE_GPU==='1'?'已关闭（AR_DISABLE_GPU=1）':'已开启'}；临时目录 ${fixture.home}`);
  // 不能设 windowsHide：Windows 会把"隐藏"传给软件第一次 ShowWindow，演示窗口就一直不显示。
  const child=spawn(electron,['.'],{env,stdio:'inherit',windowsHide:false});
  // Ctrl+C 同时发给 Electron：这里不直接退出，等 Electron 自己关闭（3 秒不退再结束它），之后照常清理临时目录。
  process.on('SIGINT',()=>{setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();},3000).unref();});
  const [code,signal]=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(c,s)=>resolve([c,s]));});
  // viewer.json 只在软件正常退出时由软件自己删除；还在说明软件的退出清理没有完成。
  const viewer=path.join(fixture.home,'viewer.json');
  console.log(`演示：Electron 主进程 ${child.pid} 已退出（code=${code}，signal=${signal}）；软件退出清理${existsSync(viewer)?`未完成（viewer.json 仍在，pid=${JSON.parse(readFileSync(viewer,'utf8')).pid}）`:'已完成'}`);
  process.exitCode=Number(code)||0;
} finally {
  await fixture.close();
  console.log('演示：启动器结束。');
}
