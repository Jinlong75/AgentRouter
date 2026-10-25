// 假的"列出模型"命令行（ar agents models 的测试用）。
// 用法：models-cli.mjs --version | --list-models
// 环境变量 MODELS_CLI_MODE（由声明的 env 给出）：fail——往标准错误打印 not logged in 并以 3 退出；hang——一直不退出；其余——正常列出。
// 正常列出时先打印表头 MODEL 和两个模型名，再按收到的环境打印两个标记行，让测试确认"带上了密钥、用户目录是沙箱"（不打印任何值）：
// token-ok：令牌变量非空；sandbox-ok：USERPROFILE 在 workers 沙箱目录里。
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('models-cli 1.0.0'); process.exit(0); }

const mode = process.env.MODELS_CLI_MODE;
if (mode === 'fail') { console.error('not logged in'); process.exit(3); }
if (mode === 'hang') setInterval(() => {}, 1000);
else if (args.includes('--list-models')) {
  console.log('MODEL');
  console.log('A');
  console.log('');
  console.log('B');
  if (process.env.QODERCN_PERSONAL_ACCESS_TOKEN) console.log('token-ok');
  if (/[\\/]workers[\\/][^\\/]+[\\/]home$/.test(process.env.USERPROFILE ?? '')) console.log('sandbox-ok');
  console.log(`args:${args.join(' ')}`);
} else {
  console.error('用法：models-cli.mjs --version | --list-models');
  process.exit(2);
}
