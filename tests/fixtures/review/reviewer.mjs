// 假审查者（审查核心测试用，通用适配器的文本型命令行执行者）。
// 用法：reviewer.mjs --version
//       reviewer.mjs <模式> [--read-only] [--pid-file <文件>] <指令文件>
// 模式：
//   ok        正常结论 concerns：两条问题（一条 severity 非法）、reviewed 两个文件
//   pass      正常结论 pass，没有问题，reviewed 一个文件
//   nocode    只有分析文字，没有 json 代码块
//   badjson   json 代码块里不是合法 JSON
//   blocked   只说"被阻塞：无法读取文件"，没有结论
//   noreviewed  verdict 是 pass、issues 为空、reviewed 为空
//   modify    在当前目录改已跟踪的文件、新建文件（不提交），然后给出正常结论
//   commit    在当前目录提交一个新文件（HEAD 变了），然后给出正常结论
//   crash     以 3 退出
//   hang      把自己的 pid 写进 --pid-file，然后睡 60 秒
// 输出第一行写明是只读还是可写（看有没有 --read-only），第二行写模式名，指令的字数也打出来（指令来自 {promptFile}）。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('review-fixture 1.0.0'); process.exit(0); }
const mode = args[0];
const pidFile = args.includes('--pid-file') ? args[args.indexOf('--pid-file') + 1] : null;
const promptFile = args.filter(arg => !arg.startsWith('--')).at(-1);
const prompt = readFileSync(promptFile, 'utf8');

console.log(`读写模式：${args.includes('--read-only') ? 'readonly' : 'readwrite'}`);
console.log(`模式：${mode}`);
console.log(`指令字数：${prompt.length}`);

const json = value => console.log(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
const concerns = {
  verdict: 'concerns', summary: '功能完成，但缺少空输入处理',
  reviewed: ['src\\sum.js', 'tests/sum.test.js'],
  issues: [
    { severity: 'high', file: 'src\\sum.js', line: 3, title: '未处理非数字输入', detail: '传入字符串时返回 NaN。' },
    { severity: 'catastrophic', file: 'tests/sum.test.js', line: null, title: '测试没有覆盖空数组', detail: '建议补一条。' },
  ],
};

if (mode === 'ok') { console.log('先分析……'); json(concerns); }
else if (mode === 'pass') { console.log('没有发现问题。'); json({ verdict: 'pass', summary: '没有发现问题', reviewed: ['src/sum.js'], issues: [] }); }
else if (mode === 'nocode') console.log('我看过了，整体不错，没有给出 json 结论。');
else if (mode === 'badjson') console.log('```json\n{"verdict": "pass", \n```');
else if (mode === 'blocked') console.log('被阻塞：无法读取文件，沙箱拒绝访问。');
else if (mode === 'noreviewed') json({ verdict: 'pass', summary: '没有发现问题', reviewed: [], issues: [] });
else if (mode === 'modify') {
  writeFileSync('a.txt', '审查者偷偷改的\n');
  writeFileSync('evil.txt', '审查者新建的\n');
  json(concerns);
} else if (mode === 'commit') {
  writeFileSync('evil.txt', '审查者提交的\n');
  const run = argv => execFileSync('git', argv, { stdio: 'ignore' });
  run(['add', 'evil.txt']);
  run(['-c', 'user.name=审查者', '-c', 'user.email=reviewer@example.test', 'commit', '-q', '-m', '审查者的提交']);
  json(concerns);
} else if (mode === 'crash') { console.error('审查者崩溃'); process.exit(3); }
else if (mode === 'hang') {
  if (pidFile) writeFileSync(pidFile, String(process.pid));
  setTimeout(() => {}, 60000);
  await new Promise(() => {});
}
