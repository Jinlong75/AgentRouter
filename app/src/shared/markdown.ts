export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]!));
export const commitFrom = (text: string) => text.match(/`([a-f\d]{7,12})`/i)?.[1];
// 强调只认成对的 ** **、* *、~~ ~~；下划线不做强调，词内星号（a*b*c、snake_case）不误判：开标记前不能是字母数字或标记字符。
const emph = (s: string) => s
    .replace(/(?<![A-Za-z0-9*_~])\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![A-Za-z0-9*_~])~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '<del>$1</del>')
    .replace(/(?<![A-Za-z0-9*_~])\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '<em>$1</em>');
// 占位符：私有区字符 U+E000…U+E001 夹十进制序号。正文（含代码、链接）里不会出现私有区字符，
// esc() 也不会生成它们，所以占位符能安全穿过转义与强调配对，最后按序号换回 HTML 槽位。
const slot = (slots: string[], html: string) => `\uE000${slots.push(html) - 1}\uE001`;
const SLOT = /\uE000(\d+)\uE001/g;
export function inline(text: string): string {
    // 先把行内代码与链接换成占位符，对整行做强调配对，再换回转义好的代码 / 链接 HTML。
    // 这样粗体里含行内代码（如 **…`x`…**）也能配对：** 不再被代码隔在两段里。
    // 任何 HTML 都只作为文字显示；强调的边界规则不变（词内星号、下划线不误判）。
    const slots: string[] = [];
    const masked = String(text ?? '').replace(/`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)/g, s => {
        if (s.startsWith('`') && s.endsWith('`'))
            return slot(slots, `<code>${esc(s.slice(1, -1))}</code>`);
        const link = s.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link && /^https?:\/\//i.test(link[2]))
            return slot(slots, `<a href="${esc(link[2])}">${esc(link[1])}</a>`);
        return s;
    });
    return emph(esc(masked)).replace(SLOT, (_, i) => slots[Number(i)] ?? '');
}
// 列表行：缩进（2 个空格或 1 个 Tab 为一级）+ 无序标记或序号 + 可选的不可点任务标记。
const ITEM = /^([ \t]*)(?:([-*])|(\d+)[.)])[ \t]+(?:\[([ xX])\][ \t]+)?(.+)$/;
const isPipe = (line: string) => /(?<!\\)\|/.test(line);
const rowCells = (line: string) => {
    const parts: string[] = [];
    let cur = '';
    const text = line.trim();
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\' && text[i + 1] === '|') {
            cur += '|';
            i++;
            continue;
        }
        if (text[i] === '|') {
            parts.push(cur);
            cur = '';
            continue;
        }
        cur += text[i];
    }
    parts.push(cur);
    if (parts.length && parts[0].trim() === '')
        parts.shift();
    if (parts.length && parts[parts.length - 1].trim() === '')
        parts.pop();
    return parts.map(c => c.trim());
};
const isDelimRow = (cells: string[]) => cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
const alignOf = (cell: string) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left';
type ListTag = 'ul' | 'ol';
interface RawItem {
    level: number;
    tag: ListTag;
    start: number;
    task: 0 | 1 | 2;
    html: string;
}
interface LNode {
    tag: ListTag;
    start: number;
    items: { html: string; task: 0 | 1 | 2; sub: LNode | null }[];
}
const makeItem = (m: RegExpMatchArray): RawItem => {
    const task: 0 | 1 | 2 = m[4] ? (/[xX]/.test(m[4]) ? 2 : 1) : 0;
    const mark = task ? `<span class="md-check${task === 2 ? ' on' : ''}">${task === 2 ? '☑' : '☐'}</span> ` : '';
    let spaces = 0;
    for (const ch of m[1])
        spaces += ch === '\t' ? 2 : 1;
    return { level: Math.floor(spaces / 2), tag: m[2] ? 'ul' : 'ol', start: m[3] ? Number(m[3]) : 1, task, html: mark + inline(m[5]) };
};
const renderNode = (n: LNode): string =>
    (n.tag === 'ol' && n.start !== 1 ? `<ol start="${n.start}">` : `<${n.tag}>`) +
    n.items.map(it => `<li${it.task ? ' class="task"' : ''}>${it.html}${it.sub ? renderNode(it.sub) : ''}</li>`).join('') +
    `</${n.tag}>`;
// 同层列表：缩进更深的挂在上一条下面；同层换标记（ul/ol）时断开成相邻的兄弟列表。
const listNode = (items: RawItem[], from: number, level: number): { node: LNode; next: number } => {
    const node: LNode = { tag: items[from].tag, start: items[from].start, items: [] };
    let i = from;
    while (i < items.length) {
        const it = items[i];
        if (it.level < level)
            break;
        if (it.level === level) {
            if (it.tag !== node.tag && node.items.length)
                break;
            if (!node.items.length) {
                node.tag = it.tag;
                node.start = it.start;
            }
            node.items.push({ html: it.html, task: it.task, sub: null });
            i++;
            continue;
        }
        const last = node.items[node.items.length - 1];
        if (!last) {
            node.items.push({ html: it.html, task: it.task, sub: null });
            i++;
            continue;
        }
        const sub = listNode(items, i, it.level);
        if (last.sub && last.sub.tag === sub.node.tag)
            last.sub.items.push(...sub.node.items);
        else
            last.sub = sub.node;
        i = sub.next;
    }
    return { node, next: i };
};
const renderLists = (items: RawItem[]) => {
    let html = '';
    for (let i = 0; i < items.length;) {
        const { node, next } = listNode(items, i, items[i].level);
        html += renderNode(node);
        i = next;
    }
    return html;
};
const renderTable = (head: string[], aligns: string[], rows: string[][]) => {
    // 对齐用 class 而不是内联 style：界面 CSP 是 style-src 'self'，内联 style 属性会被拦下（CSP 下不生效）。
    const tr = (cells: string[], tag: 'th' | 'td') =>
        `<tr>${head.map((_, i) => `<${tag}${aligns[i] === 'center' ? ' class="al-c"' : aligns[i] === 'right' ? ' class="al-r"' : ''}>${inline(cells[i] ?? '')}</${tag}>`).join('')}</tr>`;
    return `<div class="md-table"><table><thead>${tr(head, 'th')}</thead><tbody>${rows.map(r => tr(r, 'td')).join('')}</tbody></table></div>`;
};
// 高亮一节（TODO / 推断清单）没有实际内容时不高亮（018）：正文到下一个同级或更高级标题为止，
// 去掉空白后为空，或只是"无 / None / N/A"（不区分大小写、可带句号）时照常排版但不包高亮节。
const emptySectionBody = (lines: string[], from: number, level: number) => {
    const body: string[] = [];
    let fence = false;
    for (let i = from; i < lines.length; i++) {
        const line = lines[i];
        if (/^```/.test(line)) {
            fence = !fence;
            body.push(line);
            continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (!fence && heading && heading[1].length <= level)
            break;
        body.push(line);
    }
    const text = body.join('\n').replace(/\s+/g, '');
    return !text || /^(?:无|none|n\/a)[。.]?$/i.test(text);
};
const renderBlocks = (lines: string[], withHighlight: boolean): string => {
    let html = '', code: string[] | null = null, highlight = 0, items: RawItem[] = [], para: string[] = [];
    const flushPara = () => {
        if (para.length) {
            html += `<p>${para.map(inline).join('<br>')}</p>`;
            para = [];
        }
    };
    const flushList = () => {
        if (items.length) {
            html += renderLists(items);
            items = [];
        }
    };
    const flush = () => {
        flushPara();
        flushList();
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^```/.test(line)) {
            flush();
            if (code) {
                html += `<pre class="out scroll">${esc(code.join('\n'))}</pre>`;
                code = null;
            }
            else
                code = [];
            continue;
        }
        if (code) {
            code.push(line);
            continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            flush();
            if (withHighlight && highlight && heading[1].length <= highlight) {
                html += '</section>';
                highlight = 0;
            }
            if (withHighlight && !highlight && /^(?:\d+[.、)\s]+)?(?:TODO\((?:design|lead)\)|推断清单)/.test(heading[2]) && !emptySectionBody(lines, i + 1, heading[1].length)) {
                highlight = heading[1].length;
                html += '<section class="hl brand">';
            }
            const level = heading[1].length;
            html += `<${level <= 2 ? 'h2' : level === 3 ? 'h3' : 'h4'}>${inline(heading[2])}</${level <= 2 ? 'h2' : level === 3 ? 'h3' : 'h4'}>`;
            continue;
        }
        // 表格：表头行 + 分隔行 + 数据行；没有分隔行的竖线行按普通段落处理。
        if (isPipe(line)) {
            const head = rowCells(line);
            const next = lines[i + 1];
            if (next !== undefined && isPipe(next) && isDelimRow(rowCells(next)) && rowCells(next).length === head.length) {
                flush();
                const aligns = rowCells(next).map(alignOf);
                const rows: string[][] = [];
                let j = i + 2;
                while (j < lines.length && isPipe(lines[j]) && !ITEM.test(lines[j])) {
                    rows.push(rowCells(lines[j]));
                    j++;
                }
                html += renderTable(head, aligns, rows);
                i = j - 1;
                continue;
            }
        }
        // 分隔线：单独一行的 --- / *** / ___（表格分隔行一定带竖线，不会走到这里）。
        if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line)) {
            flush();
            html += '<hr>';
            continue;
        }
        if (/^ {0,3}>/.test(line)) {
            flush();
            const quote: string[] = [];
            let j = i;
            while (j < lines.length && /^ {0,3}>/.test(lines[j])) {
                quote.push(lines[j].replace(/^ {0,3}>[ \t]?/, ''));
                j++;
            }
            html += `<blockquote>${renderBlocks(quote, false)}</blockquote>`;
            i = j - 1;
            continue;
        }
        if (ITEM.test(line)) {
            flushPara();
            let j = i;
            while (j < lines.length) {
                const m = lines[j].match(ITEM);
                if (m) {
                    items.push(makeItem(m));
                    j++;
                    continue;
                }
                // 列表中间的空行：后面还是列表项就继续，否则列表结束。
                if (!lines[j].trim()) {
                    let k = j + 1;
                    while (k < lines.length && !lines[k].trim())
                        k++;
                    if (k < lines.length && ITEM.test(lines[k])) {
                        j = k;
                        continue;
                    }
                }
                break;
            }
            i = j - 1;
            continue;
        }
        if (!line.trim()) {
            flush();
            continue;
        }
        flushList();
        para.push(line);
    }
    flush();
    if (code)
        html += `<pre class="out scroll">${esc(code.join('\n'))}</pre>`;
    if (withHighlight && highlight)
        html += '</section>';
    return html;
};
export function markdown(text: string): string {
    const lines = String(text ?? '').split(/\r?\n/);
    // 任务说明开头的 YAML 头（--- … ---）原样显示成代码块，不当分隔线和段落排。
    if (lines[0]?.trim() === '---') {
        const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
        if (end > 0)
            return `<pre class="out scroll md-front">${esc(lines.slice(1, end).join('\n'))}</pre>` + renderBlocks(lines.slice(end + 1), true);
    }
    return renderBlocks(lines, true);
}
