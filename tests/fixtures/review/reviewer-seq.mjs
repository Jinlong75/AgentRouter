// 假审查者（按次数换结论，流水线与 ar review 的测试用，通用适配器的文本型命令行执行者）。
// 用法：reviewer-seq.mjs --version
//       reviewer-seq.mjs <计数文件> <模式,模式,…> [--read-only] [--pid-file <文件>] <指令文件>
// 每运行一次，计数文件里的数字加 1；第 n 次运行取模式列表的第 n 个（不够就一直取最后一个）。
// 模式：
//   high    concerns：一条 high、一条 medium、一条 low 问题
//   medium  concerns：只有一条 medium 问题
//   pass    pass，没有问题，reviewed 一个文件
//   nocode  只有分析文字，没有 json 代码块
//   hang    把自己的 pid 写进 --pid-file，然后睡 60 秒
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('review-seq-fixture 1.0.0'); process.exit(0); }
const [stateFile, list] = args;
const pidFile = args.includes('--pid-file') ? args[args.indexOf('--pid-file') + 1] : null;
let count = 0;
try { count = Number(readFileSync(stateFile, 'utf8')) || 0; } catch { /* 第一次运行没有计数文件。 */ }
writeFileSync(stateFile, String(count + 1));
const modes = list.split(',');
const mode = modes[Math.min(count, modes.length - 1)];

console.log(`读写模式：${args.includes('--read-only') ? 'readonly' : 'readwrite'}`);
console.log(`模式：${mode}（第 ${count + 1} 次运行）`);

const json = value => console.log(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
const issues = {
  high: { severity: 'high', file: 'src/a.js', line: 1, title: '示例高严重度问题', detail: '传入空值时会抛错。' },
  medium: { severity: 'medium', file: 'src/a.js', line: 2, title: '示例中严重度问题', detail: '建议补一个测试。' },
  low: { severity: 'low', file: 'README.md', line: null, title: '示例低严重度问题', detail: '措辞可以更清楚。' },
};

if (mode === 'high') json({ verdict: 'concerns', summary: '有一个必须处理的问题', reviewed: ['src/a.js'], issues: [issues.high, issues.medium, issues.low] });
else if (mode === 'medium') json({ verdict: 'concerns', summary: '只有建议', reviewed: ['src/a.js'], issues: [issues.medium] });
else if (mode === 'pass') json({ verdict: 'pass', summary: '没有发现问题', reviewed: ['src/a.js'], issues: [] });
else if (mode === 'nocode') console.log('我看过了，整体不错，没有给出 json 结论。');
else if (mode === 'hang') {
  if (pidFile) writeFileSync(pidFile, String(process.pid));
  setTimeout(() => {}, 60000);
  await new Promise(() => {});
}
