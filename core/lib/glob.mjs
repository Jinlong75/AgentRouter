// 允许路径的 glob 匹配（文件协议 11.5）。核心保持零依赖。
// 语义：** 后跟 / 时匹配零个或多个目录层；单独或不跟 / 的 ** 匹配任意字符（含 /）；
// * 匹配不含 / 的任意字符（含空）；? 匹配一个非 / 字符；其余字符一律按字面（不支持字符类与花括号展开）。
// 整串匹配（^…$），不做路径规范化（\ 与 ./ 都按字面处理）；glob 的写法校验在解析器里做，这里不重复。

const cache = new Map();

// 正则元字符逐字转义，其余字符（含 \ 本身）按字面进入正则。
function escapeLiteral(char) {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

export function globToRegExp(glob, { caseInsensitive = process.platform === 'win32' } = {}) {
  const key = `${caseInsensitive ? 'i' : 's'}\0${glob}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let body = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] !== '*') { body += '[^/]*'; continue; }
      if (glob[i + 2] === '/') { body += '(?:[\\s\\S]*/)?'; i += 2; } // **/：零个或多个目录层
      else { body += '[\\s\\S]*'; i += 1; } // **：任意字符，含 /
    } else if (char === '?') {
      body += '[^/]';
    } else {
      body += escapeLiteral(char);
    }
  }
  const regex = new RegExp(`^${body}$`, caseInsensitive ? 'i' : '');
  cache.set(key, regex);
  return regex;
}

// file 匹配 globs 中任一项即为真；同一（glob 文本，大小写选项）只编译一次（缓存在 globToRegExp 里）。
export function matchesAny(file, globs, options) {
  for (const glob of globs) {
    if (globToRegExp(glob, options).test(file)) return true;
  }
  return false;
}
