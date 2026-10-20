// H1 最小子进程脚本：只记时刻，不导入任何项目代码；独立 Node 与 Electron-as-Node 共用这一份。
// 首个标记（第一行）：进程时间原点、自身单调时钟、墙上时间，立即写到标准输出。
const firstMark = {
  kind: 'first',
  perfNow: performance.now(),
  dateNow: Date.now(),
  timeOrigin: performance.timeOrigin,
};
process.stdout.write(JSON.stringify(firstMark) + '\n');

// 退出标记：写到标准错误，与首个标记分开走不同管道，供父进程算 D 段。
process.on('exit', () => {
  process.stderr.write(JSON.stringify({ kind: 'exit', dateNow: Date.now() }) + '\n');
});
