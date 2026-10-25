// 假的 JSONL 型命令行执行者（通用适配器测试用）。
// 用法：jsonl-cli.mjs --version | run（任务指令从标准输入读，读完丢弃）。
// 输出覆盖：message、thought、exec（start / end）、usage、plan、file、tool，一行不认识的 JSON，一行非 JSON，最后一句 message。
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('jsonl-cli 0.9.0'); process.exit(0); }

await new Promise(resolve => { process.stdin.resume(); process.stdin.on('end', resolve); });

const lines = [
  { type: 'message', role: 'assistant', content: '开始处理' },
  { type: 'thought', text: '先看看目录' },
  { type: 'exec', id: 'c1', command: 'git status --short' },
  { type: 'exec', id: 'c1', command: 'git status --short', exit_code: 0, output: '?? src/a.txt' },
  { type: 'usage', input_tokens: 120, output_tokens: 30 },
  { type: 'plan', items: [{ title: '写文件', done: true }, { title: '汇报', done: false }] },
  { type: 'file', op: 'add', path: path.join(process.cwd(), 'src', 'a.txt') },
  { type: 'tool', tool: 'search', args: { q: 'x' } },
  { mystery: true },
];
for (const line of lines) console.log(JSON.stringify(line));
console.log('this line is not json');
console.log(JSON.stringify({ type: 'message', role: 'assistant', content: '完成' }));
