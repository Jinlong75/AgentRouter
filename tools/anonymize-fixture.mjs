// 把真实的 stream-json 输出匿名化成测试样例：路径、会话与消息 ID、签名、token 数、耗时、费用都换成示例值。
// 在解析后的 JSON 值上替换（不是在原始文本上），反斜杠转义不会出错。
// ID 只按原始值映射：同一个原始值总是换成同一个占位符，tool_use 的 id 与 tool_result 的 tool_use_id 因此仍能配对。
// 用法：node tools/anonymize-fixture.mjs <原始输出.jsonl> <样例.jsonl> [--keep-thinking-tokens 3] [--root <工作目录>]
// --root：没有 init 事件的输出（如 Codex）用它指定工作目录；raw.log 里软件加的 _at 时间戳会去掉。
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SAMPLE_ROOT = 'D:\\demo\\repo';
const realOr = p => { try { return realpathSync.native(p); } catch { return p; } };
const ID_KEYS = new Set(['session_id', 'uuid', 'id', 'tool_use_id', 'parent_tool_use_id', 'request_id', 'thread_id']);
const DROP_KEYS = new Set(['_at']);
const HIDE_KEYS = new Set(['signature', 'messaging_socket_path', 'powershell_path', 'memory_paths']);
const TIME_OR_COST = /^(total_cost_usd|costUSD|.*_ms|.*Ms)$/;

export function anonymize(lines, { keepThinkingTokens = 3, temp = os.tmpdir(), home = os.homedir(), roots = [] } = {}) {
  const events = lines.map(line => { try { return JSON.parse(line); } catch { return line; } });
  const init = events.find(e => e && e.type === 'system' && e.subtype === 'init');
  // 替换表：工作目录（长路径、8.3 短路径都可能出现）→ 示例根目录；临时目录、用户目录 → 中性路径。长的先换。
  // 每个路径还有 / 写法与把空格写成 %20 的写法（Markdown 链接里常见）。
  const pairs = [...new Set([init?.cwd, init?.original_cwd, ...roots].filter(Boolean))].map(p => [p, SAMPLE_ROOT])
    .concat([temp, realOr(temp)].map(t => [t, 'D:\\demo\\tmp']), [home, realOr(home)].map(h => [h, 'D:\\demo\\home']))
    .flatMap(([from, to]) => { const slash = from.replaceAll('\\', '/'), to2 = to.replaceAll('\\', '/'); return [[from, to], [slash, to2], [slash.replaceAll(' ', '%20'), to2]]; })
    .sort((a, b) => b[0].length - a[0].length);
  const scrub = text => {
    let out = text;
    for (const [from, to] of pairs) out = out.split(from).join(to);
    // 兜底：任何剩下的用户目录与 Claude Code 的项目目录名（C--Users-…）都换掉。
    return out.replace(/[A-Za-z]:\\Users\\[^\\\s"'<>]+/gi, 'D:\\demo\\home').replace(/[A-Za-z]:\/Users\/[^/\s"'<>]+/gi, 'D:/demo/home')
      .replace(/C--Users-[A-Za-z0-9_~-]+/g, 'D--demo-repo');
  };
  const ids = new Map(), counters = {};
  const placeholder = (key, value) => {
    if (!ids.has(value)) {
      const kind = /^(call_|toolu_)/.test(value) || key === 'tool_use_id' ? 'toolu' : key === 'session_id' ? 'session' : key === 'uuid' ? 'uuid' : 'msg';
      counters[kind] = (counters[kind] ?? 0) + 1;
      ids.set(value, `${kind}_${String(counters[kind]).padStart(3, '0')}`);
    }
    return ids.get(value);
  };
  const walk = (value, key) => {
    if (typeof value === 'string') return ID_KEYS.has(key) && value ? placeholder(key, value) : scrub(value);
    if (typeof value === 'number') {
      if (/tokens/i.test(key ?? '')) return /^estimated_tokens_delta$/.test(key) ? 1 : /^estimated/.test(key) ? 10 : /cache/i.test(key) ? 0 : /output/i.test(key) ? 300 : 1200;
      return TIME_OR_COST.test(key ?? '') ? 0 : value;
    }
    if (Array.isArray(value)) return value.map(v => walk(v, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !DROP_KEYS.has(k)).map(([k, v]) => [k, HIDE_KEYS.has(k) && v !== null ? '<已匿名>' : walk(v, k)]));
    return value;
  };
  let thinking = 0;
  const out = [];
  for (const e of events) {
    if (e && e.type === 'system' && e.subtype === 'thinking_tokens' && ++thinking > keepThinkingTokens) continue;
    out.push(typeof e === 'string' ? scrub(e) : JSON.stringify(walk(e)));
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, ...rest] = process.argv.slice(2);
  if (!input || !output) { console.error('用法：node tools/anonymize-fixture.mjs <原始输出.jsonl> <样例.jsonl> [--keep-thinking-tokens 3]'); process.exit(2); }
  const i = rest.indexOf('--keep-thinking-tokens'), r = rest.indexOf('--root');
  const root = r >= 0 ? rest[r + 1] : null;
  const real = p => { try { return realpathSync.native(p); } catch { return p; } };
  const lines = readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean);
  const result = anonymize(lines, { keepThinkingTokens: i >= 0 ? Number(rest[i + 1]) : 3, roots: root ? [path.resolve(root), real(path.resolve(root))] : [], temp: os.tmpdir(), home: os.homedir() });
  writeFileSync(output, result.join('\n') + '\n');
  console.log(`已写出 ${result.length} 行（原始 ${lines.length} 行）：${output}`);
}
