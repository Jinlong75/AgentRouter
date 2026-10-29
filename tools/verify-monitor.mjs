import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createTempRoot, finishTempRoot, tempImportArg, withTempRoot } from './verify-tests.mjs';
await build({entryPoints:['tests/gui/monitor.ts'],outfile:'app/dist/monitor-check.cjs',bundle:true,platform:'node',format:'cjs',target:'node24'});
// 186：和 verify-tests 一样，测试进程用这次专用的临时目录，结束后检查遗留的临时目录与进程。
const tempRoot=createTempRoot('ar-verify-monitor-tmp-');
const child=spawn(process.execPath,['--test',tempImportArg(tempRoot),'app/dist/monitor-check.cjs'],{stdio:'inherit',env:withTempRoot(process.env,tempRoot)});
const status=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve(signal?1:code??1)));
const clean=await finishTempRoot(tempRoot);
process.exitCode=status||(clean?0:1);
