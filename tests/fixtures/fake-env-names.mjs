// 假执行者（测试用，经 AR_TEST_AGENT 指定）：只把自己看到的环境变量名写进 AR_TEST_ENV_NAMES 指定的文件，从不写任何值。
// 同时冒充 codex（-o 写汇报）与 claude-code（stream-json 的 result 行），任务内容不重要。
import { writeFileSync } from 'node:fs';

if (process.argv.includes('--version')) { console.log('fake-env 1.0'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  writeFileSync(process.env.AR_TEST_ENV_NAMES, JSON.stringify(Object.keys(process.env).sort()));
  const out = process.argv.indexOf('-o');
  if (out >= 0) writeFileSync(process.argv[out + 1], 'OK');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }));
});
