// 假的 DeepSeek Harness（dsh）命令行（通用适配器测试用）。
// 用法：dsh-cli.mjs --version | headless --json -（任务文字从标准输入读）。
// DSH_PERMISSION_MODE=read-only 时，写文件请求得到 status: "error" 的 tool_result；否则真的写文件。
// 另把收到的 DSH_PERMISSION_MODE 与 DEEPSEEK_API_KEY 是否存在写进 final 文本之外的 session 事件（不输出密钥值）。
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('dsh 0.2.1-rc.2'); process.exit(0); }

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
await new Promise(resolve => process.stdin.on('end', resolve));

const mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write';
const emit = event => console.log(JSON.stringify(event));
const target = path.join(process.cwd(), 'a.txt');

emit({ type: 'session', sessionId: 'fake-session', permissionMode: mode, hasKey: Boolean(process.env.DEEPSEEK_API_KEY) });
emit({ type: 'thinking', text: '先看看目录' });
emit({ type: 'tool_call', callId: 'call_1', tool: 'pwsh', input: { command: 'git status --short', description: '看状态' } });
emit({ type: 'tool_result', callId: 'call_1', status: 'completed', result: '' });
emit({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 373, outputTokens: 190, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 563 } });
emit({ type: 'tool_call', callId: 'call_2', tool: 'write', input: { file_path: target, content: `${prompt.length}\n` } });
if (mode === 'read-only') {
  emit({ type: 'tool_result', callId: 'call_2', status: 'error', result: 'sandbox: write denied in read-only mode' });
} else {
  fs.writeFileSync(target, `${prompt.length}\n`);
  emit({ type: 'tool_result', callId: 'call_2', status: 'completed', result: 'ok' });
}
emit({ type: 'tool_call', callId: 'call_3', tool: 'bash', input: { command: 'ls', description: '列目录' } });
emit({ type: 'tool_result', callId: 'call_3', status: 'completed', result: 'a.txt' });
emit({ type: 'text', text: '中间说明' });
emit({ type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 400, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 420 } });
emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
emit({ type: 'final', text: mode === 'read-only' ? '只读完成' : '完成' });
