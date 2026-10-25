// 网络代理：config.json 的 proxy 决定执行者进程与"在此项目打开 Claude Code"的代理环境变量。
// Clash 等"系统代理"模式只改 Windows 的代理设置、不设环境变量，而 Claude Code 这类 Node 程序只认环境变量，所以要由这里读出来再注入。
// 地址里绝不允许带用户名或密码（D17：凭据不进配置文件）；本文件不记录、不打印任何地址以外的东西。
import { spawnSync } from 'node:child_process';

export const PROXY_MODES = ['off', 'system', 'manual'];
export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const HOST = '(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9._-]+)';
const ADDRESS = new RegExp(`^(https?|socks5)://(${HOST}):(\\d{1,5})$`, 'i');
const BARE = new RegExp(`^${HOST}:\\d{1,5}$`);

const messages = {
  PROXY_EMPTY: '代理地址不能为空',
  PROXY_CREDENTIALS: '代理地址里不能带用户名和密码（凭据不写进配置文件）；这类代理请自己设环境变量',
  PROXY_FORMAT: '代理地址格式不对：只支持 http://、https://、socks5:// 加主机和端口（端口 1～65535），例如 http://127.0.0.1:7890',
};

// 校验手动填写的代理地址。ok 时 url 是规范化后的地址（去掉首尾空白与末尾的 /，协议小写）；不 ok 时 code 取 PROXY_EMPTY / PROXY_CREDENTIALS / PROXY_FORMAT，error 是中文原因。
export function validateProxyUrl(url) {
  const fail = code => ({ ok: false, url: null, code, error: messages[code] });
  if (typeof url !== 'string' || !url.trim()) return fail('PROXY_EMPTY');
  const text = url.trim().replace(/\/+$/, '');
  // 凭据先于格式判断：带 @ 的一律按凭据拒绝，免得错误提示把用户引到别处。
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/.test(text)) return fail('PROXY_CREDENTIALS');
  const match = ADDRESS.exec(text);
  if (!match) return fail('PROXY_FORMAT');
  const port = Number(match[3]);
  if (!(port >= 1 && port <= 65535)) return fail('PROXY_FORMAT');
  return { ok: true, url: `${match[1].toLowerCase()}://${match[2]}:${match[3]}`, code: null, error: null };
}

// Windows 注册表 ProxyServer 的两种写法：host:port；或按协议分写 http=h1:p1;https=h2:p2;socks=h3:p3
//（取 https，没有取 http，再没有取 socks 并写成 socks5://）。认不出返回 null。
export function parseProxyServer(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const value = text.trim();
  const candidate = (address, scheme) => {
    const bare = address.trim();
    if (BARE.test(bare)) return validateProxyUrl(`${scheme}://${bare}`).url;
    return /^(https?|socks5):\/\//i.test(bare) ? validateProxyUrl(bare).url : null;
  };
  if (!value.includes('=')) return candidate(value, 'http');
  const parts = {};
  for (const item of value.split(';')) {
    const at = item.indexOf('=');
    if (at > 0) parts[item.slice(0, at).trim().toLowerCase()] = item.slice(at + 1);
  }
  for (const [name, scheme] of [['https', 'http'], ['http', 'http'], ['socks', 'socks5']]) {
    const url = parts[name] === undefined ? null : candidate(parts[name], scheme);
    if (url) return url;
  }
  return null;
}

// 默认的注册表查询：reg.exe 以参数数组启动，不经过 shell，超时 5 秒。
// 测试专用：设置了 AR_TEST_PROXY_REG 时，把它的内容当作 reg query 的标准输出，不碰注册表。
function runReg(env) {
  if (typeof env?.AR_TEST_PROXY_REG === 'string') return { status: 0, stdout: env.AR_TEST_PROXY_REG };
  return spawnSync('reg.exe', ['query', KEY], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000 });
}

// 读当前用户的 Windows 系统代理。返回 { url | null, reason }：
// found（读到）、disabled（ProxyEnable 不是 1）、pac（只配了 PAC）、unreadable（读取失败或写法认不出）、unsupported（不是 Windows）。
// run 可注入（测试不读真实注册表），无参调用，返回 { status, stdout }。这些情况都不抛错。
export function readSystemProxy({ platform = process.platform, env = process.env, run = () => runReg(env) } = {}) {
  if (platform !== 'win32') return { url: null, reason: 'unsupported' };
  let result;
  try { result = run(); } catch { return { url: null, reason: 'unreadable' }; }
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') return { url: null, reason: 'unreadable' };
  const value = name => new RegExp(`^[ \\t]*${name}[ \\t]+REG_\\w+[ \\t]+(.*?)[ \\t]*$`, 'mi').exec(result.stdout)?.[1];
  const enable = value('ProxyEnable'), server = value('ProxyServer'), pac = value('AutoConfigURL');
  const enabled = enable !== undefined && Number(enable) === 1;
  if (!enabled || !server) return { url: null, reason: pac ? 'pac' : 'disabled' };
  const url = parseProxyServer(server);
  return url ? { url, reason: 'found' } : { url: null, reason: 'unreadable' };
}

// 这一刻的代理：{ mode, url | null, source: 'system' | 'manual' | null, reason, env }。
// reason：off；system 时是 readSystemProxy 的原因；manual 时是 manual（地址不合法为 invalid）。env 是要设置的变量（没得到地址时为空对象）。
export function resolveProxy(config, { readSystem = () => readSystemProxy() } = {}) {
  const setting = config?.proxy;
  const mode = PROXY_MODES.includes(setting?.mode) ? setting.mode : 'off';
  if (mode === 'off') return { mode, url: null, source: null, reason: 'off', env: {} };
  let url = null, reason;
  if (mode === 'system') ({ url, reason } = readSystem());
  else { const checked = validateProxyUrl(setting.url); url = checked.url; reason = checked.ok ? 'manual' : 'invalid'; }
  if (!url) return { mode, url: null, source: null, reason, env: {} };
  return { mode, url, source: mode, reason, env: { HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: DEFAULT_NO_PROXY } };
}

// 把代理变量写进环境（返回新对象，不改传入的）：
// - 没得到地址：原样返回传入的对象（与不用代理时逐字相同）；
// - HTTP_PROXY / HTTPS_PROXY 覆盖继承来的值，同名的其他大小写写法一并去掉（Windows 变量名不区分大小写，免得出现两份）；
// - NO_PROXY 没设（或为空）时设为 localhost,127.0.0.1,::1，已有的不改。
export function applyProxyEnv(env, resolved) {
  if (!resolved?.url) return env;
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) if (!/^(?:http_proxy|https_proxy)$/i.test(key)) out[key] = value;
  const noProxy = Object.keys(out).find(key => key.toLowerCase() === 'no_proxy');
  if (noProxy !== undefined && !out[noProxy]) delete out[noProxy];
  out.HTTP_PROXY = resolved.url;
  out.HTTPS_PROXY = resolved.url;
  if (!Object.keys(out).some(key => key.toLowerCase() === 'no_proxy')) out.NO_PROXY = resolved.env?.NO_PROXY ?? DEFAULT_NO_PROXY;
  return out;
}

// dispatch.json 里的记录：只有模式与是否生效，不记地址（地址可能含内网信息）。
export const proxyRecord = resolved => ({ mode: resolved.mode, applied: !!resolved.url });

// 文字输出里的一句话（ar config / ar proxy resolve 共用）。
export function proxyText(resolved) {
  if (resolved.mode === 'off') return 'off（不设置也不清除代理变量）';
  if (resolved.mode === 'manual') return resolved.url ? `manual ${resolved.url}` : 'manual（地址不合法，不使用代理）';
  if (resolved.url) return `system 当前读到 ${resolved.url}（Windows 系统代理）`;
  const why = { disabled: '系统代理未开启', pac: '只配置了 PAC 脚本，不支持', unreadable: '读不到系统代理设置', unsupported: '这个平台不支持读取系统代理' }[resolved.reason] ?? '没有读到';
  return `system 当前：${why}，不使用代理`;
}
