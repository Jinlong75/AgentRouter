export function clip(s, n = 140) {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

// 失败原因：stderr 里第一条像错误的行；找不到时取最后 5 行合起来。命令行与软件共用这一条规则。
const ERROR_LINE = /^\w*Error\b|^error:|^Error:|错误|失败/;
export function failureReason(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.find(line => ERROR_LINE.test(line)) ?? (lines.slice(-5).join('\n') || null);
}

// 名字只是类别、detail 里已经是"服务名 工具名"的工具事件（Codex 的 MCP 调用）。
const CATEGORY_TOOL_NAMES = new Set(['mcp_tool_call']);
function toolLine(e) {
  const name = String(e.name ?? ''), detail = String(e.detail ?? '');
  if (!name || CATEGORY_TOOL_NAMES.has(name) || (detail && detail.startsWith(name))) return `工具：${detail}`;
  return detail ? `工具：${name} ${detail}` : `工具：${name}`;
}

export function formatProgress(e) {
  switch (e.kind) {
    case 'say': return [`说：${clip(e.text, 200)}`];
    case 'think': return e.text ? [`思考：${clip(e.text, 160)}`] : [];
    case 'cmd': return e.phase === 'start' ? [`运行：${clip(e.command, 120)}`]
      : e.exit !== 0 ? [`  命令失败（exit ${e.exit}）：${clip(e.command, 120)}`] : [];
    case 'file': return e.files.map(f => `${{ add: '新增', update: '修改', delete: '删除' }[f.kind]}文件：${f.path}`);
    case 'plan': return [`计划：${e.items.map(t => `${t.done ? '[x]' : '[ ]'} ${clip(t.text, 40)}`).join('  ')}`];
    case 'tool': return [e.name === 'web_search' ? `搜索：${clip(e.detail)}` : e.name === 'init' ? `模型：${e.detail}` : toolLine(e)];
    case 'turn': return [`一轮结束（输入 ${e.usage.input ?? '?'}，输出 ${e.usage.output ?? '?'} tokens）`];
    case 'error': return [`出错：${clip(e.text)}`];
    case 'text': return [clip(e.text)];
    default: return [];
  }
}

export function progressHeader(title, role, started, label = 'Codex') {
  return `=== ${label} 开始：${title}${role ? `（角色：${role}）` : ''}  ${new Date(started).toLocaleString('zh-CN')} ===\n`;
}
export function progressFooter(code, minutes, report, label = 'Codex') {
  return `\n=== ${label} 结束：exit=${code}，用时 ${minutes} 分钟，汇报在 ${report} ===\n`;
}
