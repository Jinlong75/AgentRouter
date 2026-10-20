import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymize, SAMPLE_ROOT } from '../../tools/anonymize-fixture.mjs';

// 用户目录在运行时拼出来（源码里不出现形似真实用户目录的字面量，lint R5）。
const USERS = 'C:' + String.fromCharCode(92) + 'Users' + String.fromCharCode(92);
// 构造一段"真实输出"：长路径与 8.3 短路径混用、真实 ID、签名、token 数、耗时与费用。
const temp = `${USERS}ABCDEF~1\\AppData\\Local\\Temp`, home = `${USERS}RealName`;
const cwd = `${temp}\\ar-t2-x\\repo`;
const raw = [
  { type: 'system', subtype: 'init', cwd, session_id: 'real-session-1', uuid: 'u-1', model: 'm', messaging_socket_path: '\\\\.\\pipe\\cc-msg-abc' },
  { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 77, estimated_tokens_delta: 3, session_id: 'real-session-1' },
  { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 78, estimated_tokens_delta: 1, session_id: 'real-session-1' },
  { type: 'assistant', message: { id: 'msg-real-1', content: [{ type: 'thinking', thinking: '想一想', signature: 'sig-real' }, { type: 'tool_use', id: 'call_00_Real', name: 'Write', input: { file_path: `${cwd}\\a.txt` } }] }, session_id: 'real-session-1' },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_00_Real', content: `写入 ${USERS}OtherName\\AppData\\x 与 ${cwd.replaceAll('\\', '/')}/a.txt` }] }, session_id: 'real-session-1' },
  { type: 'result', subtype: 'success', usage: { input_tokens: 19241, output_tokens: 808, cache_read_input_tokens: 5 }, duration_ms: 54321, total_cost_usd: 0.12, session_id: 'real-session-1' },
].map(e => JSON.stringify(e)).concat([`not json ${USERS}OtherName\\file`]);

test('匿名化：路径、ID、签名、token、耗时、费用都换成示例值，配对关系保留', () => {
  const out = anonymize(raw, { keepThinkingTokens: 1, temp, home });
  const text = out.join('\n');
  assert.doesNotMatch(text, /ABCDEF|RealName|OtherName|real-session|msg-real|call_00_Real|sig-real|cc-msg-|19241|54321|0\.12/);
  const events = out.filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  assert.equal(events.filter(e => e.subtype === 'thinking_tokens').length, 1, '只保留指定条数的 thinking_tokens');
  assert.equal(events[0].cwd, SAMPLE_ROOT);
  const use = events[2].message.content[1], result = events[3].message.content[0];
  assert.equal(use.id, 'toolu_001'); assert.equal(result.tool_use_id, use.id, 'tool_use 与 tool_result 仍能配对');
  assert.equal(use.input.file_path, `${SAMPLE_ROOT}\\a.txt`);
  assert.match(result.content, /D:\/demo\/repo\/a\.txt/);
  assert.match(result.content, /D:\\demo\\home\\AppData/, '兜底：其他用户目录也被换掉');
  assert.equal(events[2].message.content[0].signature, '<已匿名>');
  assert.deepEqual(events[4].usage, { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 });
  assert.equal(events[4].duration_ms, 0); assert.equal(events[4].total_cost_usd, 0);
  assert.equal(new Set(events.map(e => e.session_id)).size, 1, '同一个会话 ID 换成同一个占位符');
  assert.equal(out.at(-1), 'not json D:\\demo\\home\\file');
});
