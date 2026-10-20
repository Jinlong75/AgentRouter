// AgentRouter 核心唯一入口；在目标仓库运行。核心目录可整体复制，不需要安装依赖。子命令见 lib/cli.mjs。
// trace.mjs 放在最前面导入：它最先求值，记下"进程启动到开始执行我们的代码"用了多久。
import { trace } from './lib/trace.mjs';
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
