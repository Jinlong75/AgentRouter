// 假执行者（限流测试用，经 AR_TEST_AGENT 指定，claude-code 与 codex 适配器都会用它）：按环境变量 AR_LIMIT_MODE 输出限流 / 成功的样例，不访问任何服务。
// AR_LIMIT_MODE：
//   ok            成功（claude-code：init、allowed 的 rate_limit_event、一句话、result；codex：agent_message、turn.completed 并写汇报），退出码 0
//   rejected      claude-code：rate_limit_event 的 status 是 rejected（resetsAt 取 AR_LIMIT_RESETS，unix 秒），result 是不含任何限流字样的出错，退出码 1
//   allowed-fail  claude-code：rate_limit_event 是 allowed，result 是普通出错，退出码 1（用来确认 allowed 不算限流）
//   codex-limit   回放 AR_LIMIT_FIXTURE 指向的文件（codex-usage-limit.jsonl，原文来自 Codex 源码），退出码 1
// 从不写任何环境变量的值。
import { readFileSync, writeFileSync } from 'node:fs';

if (process.argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const mode = process.env.AR_LIMIT_MODE ?? 'ok';
  const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const codex = process.argv.includes('exec');
  const usage = { input_tokens: 10, output_tokens: 5 };
  if (mode === 'codex-limit') {
    process.stdout.write(readFileSync(process.env.AR_LIMIT_FIXTURE, 'utf8'));
    process.exitCode = 1;
    return;
  }
  if (codex) {
    out({ type: 'item.completed', item: { type: 'agent_message', text: '完成' } });
    out({ type: 'turn.completed', usage });
    const at = process.argv.indexOf('-o');
    if (at !== -1) writeFileSync(process.argv[at + 1], 'OK\n');
    return;
  }
  out({ type: 'system', subtype: 'init', model: 'fake-model' });
  if (mode === 'ok') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: '完成' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: '完成', usage });
    return;
  }
  const rejected = mode === 'rejected';
  out({ type: 'rate_limit_event', rate_limit_info: { status: rejected ? 'rejected' : 'allowed', resetsAt: rejected ? Number(process.env.AR_LIMIT_RESETS) : Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' } });
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Execution error', usage });
  process.exitCode = 1;
});
