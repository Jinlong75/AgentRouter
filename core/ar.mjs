// AgentRouter 核心唯一入口；在目标仓库运行。核心目录可整体复制，不需要安装依赖。子命令见 lib/cli.mjs。
// trace.mjs 放在最前面导入：它最先求值，记下"进程启动到开始执行我们的代码"用了多久。
import { trace, tracing } from './lib/trace.mjs';
import { fileURLToPath } from 'node:url';
import { main } from './lib/cli.mjs';

trace(`模块加载完成：ar ${process.argv.slice(2, 4).join(' ')}`);
try {
  process.exitCode = await main(process.argv.slice(2), { scriptPath: fileURLToPath(import.meta.url) });
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
trace(`命令结束 exit=${process.exitCode ?? 0}`);
// 命令结束后还有什么让进程活着：按类型计数，每秒一次（最多 60 次）；定时器必须 unref，不能让进程多活。
// 追踪关闭时完全不注册，标准输出、标准错误与行为不变。
if (tracing) {
  const ended = Date.now();
  const activeCounts = () => {
    const counts = new Map();
    for (const name of process.getActiveResourcesInfo()) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].map(([name, count]) => `${name}×${count}`).join(' ') || '（无）';
  };
  trace(`命令结束后活动资源：${activeCounts()}`);
  let lines = 0;
  const timer = setInterval(() => {
    lines += 1;
    trace(`命令结束后活动资源（第 ${lines} 次，距命令结束 ${Date.now() - ended}ms）：${activeCounts()}`);
    if (lines >= 60) clearInterval(timer);
  }, 1000);
  timer.unref();
  process.on('exit', code => trace(`进程退出 code=${code} 距命令结束 ${Date.now() - ended}ms`));
}
