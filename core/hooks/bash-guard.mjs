import { pathToFileURL } from 'node:url';

const reason = '不要在会话命令里用 & 把 ar wait 挂到后台：会随会话结束被停掉，也容易堆积。改用工具自带的后台运行（Bash 的 run_in_background）执行 ar wait <记录名> --timeout <秒>，或在前台运行。';

const longReason = '不要在会话前台运行 ar dispatch / retry / scope approve：执行者要跑几十分钟，命令挂在会话里会随会话结束被停掉。加 --detach 后台派发，再用 ar wait <记录名> --timeout <秒> 等结果。';

function tokenize(command) {
  if (typeof command !== 'string') return { tokens: [], background: false };
  const tokens = [];
  let word = '', active = false, background = false;
  const flush = () => { if (active) tokens.push(word); word = ''; active = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" || c === '"') {
      active = true;
      const quote = c;
      while (++i < command.length && command[i] !== quote) {
        if (quote === '"' && command[i] === '\\' && /[\"\\$`]/.test(command[i + 1] || '')) i++;
        word += command[i];
      }
    } else if (c === '\\' && i + 1 < command.length) {
      active = true; word += command[++i];
    } else if (/\s/.test(c)) {
      flush();
    } else if (';&|<>()'.includes(c)) {
      flush();
      const pair = command.slice(i, i + 2);
      if (['&&', '|&', '&>', '>&', '<&', '||', '>>', '<<'].includes(pair)) {
        tokens.push(pair); i++;
      } else {
        tokens.push(c);
        if (c === '&') background = true;
      }
    } else {
      active = true; word += c;
    }
  }
  flush();
  return { tokens, background };
}
const boundary = /^(?:;|&|&&|\||\|&|\|\||\(|\)|<|>|>>|<<|&>|>&|<&)$/;
function calls(tokens) {
  const result = [];
  for (let start = 0; start < tokens.length; start++) {
    if (start > 0 && !boundary.test(tokens[start - 1])) continue;
    let i = start;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] || '')) i++;
    if (tokens[i] === 'nohup') i++;
    if (/^node(?:\.exe)?$/.test(tokens[i] || '')) {
      i++;
      while (tokens[i]?.startsWith('-')) i++;
    }
    if (!/^(?:ar|ar\.cmd)$/.test(tokens[i] || '') && !/(?:^|[\\/])ar\.mjs$/.test(tokens[i] || '')) continue;
    let j = i + 1;
    while (j < tokens.length && !boundary.test(tokens[j]) && tokens[j].startsWith('-')) j++;
    const args = [];
    while (j < tokens.length && !boundary.test(tokens[j])) args.push(tokens[j++]);
    result.push(args);
  }
  return result;
}
export function shouldBlock(command) {
  const { tokens, background } = tokenize(command);
  return background && calls(tokens).some(args => args[0] === 'wait');
}
export function blockReason(command, { runInBackground } = {}) {
  if (shouldBlock(command)) return reason;
  if (runInBackground === true) return null;
  const { tokens } = tokenize(command);
  return calls(tokens).some(args => (['dispatch', 'retry'].includes(args[0]) || (args[0] === 'scope' && args[1] === 'approve'))
    && !args.some(arg => ['--detach', '--dry-run', '--help'].includes(arg))) ? longReason : null;
}

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const data = JSON.parse(input);
    const denial = data?.tool_name === 'Bash' ? blockReason(data.tool_input?.command, { runInBackground: data.tool_input?.run_in_background }) : null;
    if (denial) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denial } }) + '\n');
    }
  } catch {
    // 钩子出错时放行。
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
