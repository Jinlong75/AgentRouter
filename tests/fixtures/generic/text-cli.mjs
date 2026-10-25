// 假的文本型命令行执行者（通用适配器测试用）。
// 用法：text-cli.mjs --version | [run] [<指令文件>] [--fail]
// 给了指令文件就读它，否则读标准输入；逐行打印几行文字，最后一行是 OK。--fail 时往标准错误打印 not logged in 并以 1 退出。
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('text-cli 1.2.3'); process.exit(0); }
if (args.includes('--fail')) { console.error('not logged in'); process.exit(1); }

const file = args.find(arg => arg !== 'run' && !arg.startsWith('--'));
const readStdin = () => new Promise(resolve => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; });
  process.stdin.on('end', () => resolve(text));
});
const prompt = file ? readFileSync(file, 'utf8') : await readStdin();

console.log(`来源：${file ? `文件 ${file}` : '标准输入'}`);
console.log(`BOM：${prompt.charCodeAt(0) === 0xFEFF}`);
for (const line of prompt.split(/\r?\n/)) console.log(`> ${line}`);
console.log('OK');
