// 执行者需要越界（协议 14.5）：从汇报里解析 "## 需要越界" 一节，得到执行者列出的路径与原因。
const TITLE = '需要越界';
const MAX_ITEMS = 50;
// "无"这类表示没有内容的写法（整行只有它时不算一条）。
const NONE = new Set(['无', '无。', '没有', '没有。']);

// 围栏代码块：三个及以上的反引号或波浪线开始，同种符号、不短于开头的行（后面不带内容）结束。
const fenceOpen = line => /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
const fenceCloses = (line, open) => {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return !!match && match[1][0] === open[0] && match[1].length >= open.length;
};

// ATX 标题（1～6 个 #，后面是空白或行尾）→ { level, title } 或 null。结尾的 # 也一并去掉。
function parseHeading(text) {
  const match = /^(#{1,6})(?:\s+(.*))?$/.exec(text);
  if (!match) return null;
  return { level: match[1].length, title: (match[2] ?? '').replace(/\s+#+\s*$/, '').trim() };
}

// 标题文字去掉编号（10. / 10、 / 10) / (10) / 第 10 节）、包住文字的反引号与 **、结尾冒号之后，正好是"需要越界"才算这一节。
// 执行者照着汇报模板给各节编了号，也有人给标题加反引号；这些写法都认。
const NUMBER_PREFIX = /^(?:第\s*\d+\s*[节章部分]?|[(（]\s*\d+\s*[)）]|\d+\s*[.、)）])\s*/;
function isNeedsScopeTitle(title) {
  let text = title;
  for (let round = 0; round < 4; round++) {
    const before = text;
    text = text.trim()
      .replace(/\s*[:：]+$/, '')
      .replace(NUMBER_PREFIX, '')
      .replace(/^(`+|\*\*)([\s\S]*?)\1$/, '$2')
      .replace(/^#+\s*/, ''); // 反引号里又写了一遍 "## 需要越界"（090 的写法）
    if (text === before) break;
  }
  return text.trim() === TITLE;
}

// 列表项：以 -、*、+、1.、1) 开头（后面跟空白），允许缩进；其他行是说明，不算路径。
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

// 一行内容 → { path, reason } 或 null。
function parseItem(raw) {
  if (!LIST_ITEM.test(raw)) return null;
  const item = raw.replace(LIST_ITEM, '').trim();
  if (!item || NONE.has(item)) return null;
  // Windows 盘符路径（可带一个开头的反引号）：盘符后的冒号不是分隔符。
  const drive = /^(`?)[A-Za-z]:[\\/]/.exec(item);
  const from = drive ? drive[1].length + 2 : 0;
  const rest = item.slice(from);
  const cut = rest.search(/[：:]/);
  const head = cut < 0 ? item : item.slice(0, from + cut);
  const tail = cut < 0 ? '' : rest.slice(cut + 1).trim();
  const path = head.trim().replace(/^`+|`+$/g, '').trim();
  if (!path) return null;
  return { path, reason: tail || null };
}

// parseNeedsScope(markdown) → [{ path, reason }]（同一路径保留第一条，最多 50 条）。
export function parseNeedsScope(markdown) {
  if (typeof markdown !== 'string') return [];
  const found = [];
  let fence = null;
  let sectionLevel = 0; // 0 = 不在这一节里；否则是这一节标题的层级（1～6）
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      if (fenceCloses(line, fence)) fence = null;
      continue;
    }
    const opened = fenceOpen(line);
    if (opened) { fence = opened; continue; }
    const text = line.trim();
    const heading = parseHeading(text);
    if (heading) {
      // 层级不深于这一节的标题结束这一节（它自己又是"需要越界"则开始新的一节）；更深的标题属于这一节但不当作路径。
      if (sectionLevel && heading.level > sectionLevel) continue;
      sectionLevel = isNeedsScopeTitle(heading.title) ? heading.level : 0;
      continue;
    }
    if (!sectionLevel || !text) continue;
    const item = parseItem(line);
    if (item && !found.some(other => other.path === item.path)) {
      found.push(item);
      if (found.length >= MAX_ITEMS) break;
    }
  }
  return found;
}

// 读取方校验（清单里的 needsScope）：数组、每项 path 是非空字符串、reason 是字符串或 null、最多 50 条；
// 不合法就当没有。
export function readNeedsScope(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) return null;
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || item.path === ''
      || !(item.reason === null || typeof item.reason === 'string')) return null;
  }
  return value.map(item => ({ path: item.path, reason: item.reason }));
}

// 进度里的一行（协议 14.5）：前 5 个路径用"、"连接。
export function needsScopeLine(list) {
  return `需要越界：执行者列出 ${list.length} 个路径（${list.slice(0, 5).map(item => item.path).join('、')}），不再自动重试，等主导决定`;
}
