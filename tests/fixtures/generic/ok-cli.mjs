// 假的 JSONL 型命令行执行者（界面验收 UI28 的"自定义 CLI"表单用）：只回复 OK。
// 用法：ok-cli.mjs --version | run <指令文件>
// 指令文件必须存在（证明 {promptFile} 真的传到了），否则退出码 2。输出四行 JSON：start（表单里不写它的映射，预览里显示"没有符合的规则"）、
// message（说话：OK）、exec（命令：git status → exit 0）、usage（同样没有映射）。
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('ok-cli 1.4.0'); process.exit(0); }

const file = args.find(arg => arg !== 'run' && !arg.startsWith('--'));
if (!file || !existsSync(file)) { console.error('缺少指令文件'); process.exit(2); }

for (const line of [
  { type: 'start', model: 'm-1' },
  { type: 'message', content: 'OK' },
  { type: 'exec', cmd: 'git status', code: 0 },
  { type: 'usage', in: 812, out: 3 },
]) console.log(JSON.stringify(line));
