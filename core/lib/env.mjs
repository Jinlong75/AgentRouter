// 组装执行者环境（白名单，O7）：只从基础环境里挑系统必需变量、代理变量、适配器声明要保留的变量，
// 再写入 profile.env、解析后的 secrets、隔离项（隔离项最后写，profile 不能改掉它）。
// 其他变量（别的密钥、令牌、个人配置）一律不传；任何 profile 的密钥来源变量都不原样传下去。
// 返回的对象只交给 spawn，调用方绝不打印或写盘。
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve as resolvePath } from 'node:path';
import { resolveSecret } from './secrets.mjs';
import { testAgent, testAgentEnv } from './compat.mjs';
import { readConfig } from './config.mjs';
import { applyProxyEnv, readSystemProxy, resolveProxy } from './proxy.mjs';

// 网络代理（Stage07 099）：按全局 config.json 的 proxy 算出这一刻的代理，并把代理变量写进基础环境。
// 每次启动执行者前都要调用（每次尝试、自动重试、手动重试各算一次），然后把返回的 base 交给 buildEnv——
// 先覆盖代理变量，再经过白名单（白名单本来就放行代理变量）。proxy 不用时（off 或没得到地址）base 就是传入的 env 本身。
// 配置读不了（无效的配置在派发入口就已拒绝）按不使用处理。readSystem 可注入（测试不读真实注册表）。
export function withProxy(env, home, { readSystem = () => readSystemProxy({ env }) } = {}) {
  let proxy;
  try { proxy = resolveProxy(readConfig(home).config, { readSystem }); }
  catch { proxy = resolveProxy({}); }
  return { base: applyProxyEnv(env, proxy), proxy };
}

// 联网 git 操作（ar push / ar pull 的 fetch、push，Stage07b 128）的子进程环境：继承调用方环境（git 要用本机已有的登录：
// 凭据助手、SSH 代理等，所以不走执行者白名单），加上 D33 的代理变量，并关掉所有交互：
// GIT_TERMINAL_PROMPT=0 与 GCM_INTERACTIVE=never 让没有凭据时直接失败；GIT_ASKPASS / SSH_ASKPASS 置空，不弹图形登录窗口；
// LC_ALL=C 让 git 的报错是英文，失败原因才能稳定归类。返回的对象只交给 spawn，不含也不打印任何密钥。
export function gitNetworkEnv(env, home) {
  return { ...withProxy(env, home).base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C' };
}

// 064：执行者进程的用户目录指向沙箱 <公共目录>/workers/<profile>/home（协议第 7 节"执行者的用户目录"）。
// 原因：执行者在 PowerShell 里给只读的 $home 赋值失败后，$home 仍是真实用户目录根，脚本随后把文件直接写进去
//（Stage04 041、Stage05 058、063）；文字规则拦不住。PowerShell 的 $HOME 与 Node 的 os.homedir() 都跟随 USERPROFILE / HOME，
// 指向沙箱后，这类误写只会落进沙箱。核心自己的进程不受影响。
export const sandboxHome = (home, profileName) => join(home, 'workers', profileName, 'home');

// 认证方式（D18）：login 沿用 CLI 自己的登录，不注入任何凭据；token 从 secrets 指向的环境变量注入。
// 没写 auth 时：有 secrets 就是 token，否则 login（旧配置里的 codex 就是 login）。
export const authOf = profile => profile?.auth ?? (Object.keys(profile?.secrets ?? {}).length ? 'token' : 'login');

// 系统必需变量：Windows 进程、命令行、git、PowerShell 正常运行需要的；POSIX 上的对应项一并列出（不写死只有 Windows）。
const SYSTEM = [
  'SystemRoot', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'SystemDrive', 'NUMBER_OF_PROCESSORS', 'OS', 'LANG',
  /^ProgramFiles/i, /^ProgramW6432$/i, /^CommonProgramFiles/i, /^PROCESSOR_/i, /^LC_/i,
  // Node（libuv）在 Windows 上启动子进程时总会补上 USERNAME、USERDOMAIN、LOGONSERVER 等几个必需变量，这里如实列出。
  'PSModulePath', 'PSModuleAnalysisCachePath', 'USERNAME', 'USERDOMAIN', 'LOGONSERVER', 'COMPUTERNAME',
  'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TZ',
  // 软件里核心用 Electron 自带的 Node 运行（process.execPath 是 AgentRouter.exe / electron.exe）：执行者若是 Node 脚本
  //（npm 装的 CLI、fake 执行者）也用它启动，必须保留这个开关，否则会被当成图形程序打开而一直不结束。
  'ELECTRON_RUN_AS_NODE',
];
// 网络：代理与证书（大小写都认）。
const NETWORK = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
// 测试专用：设置了测试执行者（AR_TEST_AGENT 或旧名）时，把它与测试控制变量传给假执行者。真实使用时不会设置它。
const TEST = [...testAgentEnv, /^AR_TEST_/i, /^FAKE_/i];
export const ALLOWED = [...SYSTEM, ...NETWORK];

const matches = (pattern, key) => pattern instanceof RegExp ? pattern.test(key) : key.toLowerCase() === String(pattern).toLowerCase();

// 只按白名单挑选，不含任何密钥。缺密钥导致 buildEnv 失败时，检测执行者版本也用它。
export function allowedEnv({ base = process.env, adapter, home, profileName, profile, sources = [] } = {}) {
  const keep = [...ALLOWED, ...(adapter?.isolate?.({ home, profileName, profile })?.keep ?? []), ...(testAgent(base) ? TEST : [])];
  const env = Object.fromEntries(Object.entries(base).filter(([k, v]) => typeof v === 'string' && keep.some(p => matches(p, k))));
  for (const name of sources) for (const k of Object.keys(env)) if (matches(name, k)) delete env[k];
  return env;
}

// sources：配置里所有 profile 的密钥来源变量名，即使撞上白名单也不传。
export function buildEnv({ base = process.env, profile = {}, adapter, home, profileName, resolve, sources = [] }) {
  // 密钥先从原始环境里取：白名单与清除项都不含它的来源变量。
  const lookup = resolve ?? (name => resolveSecret(name, { env: base }));
  const pairs = authOf(profile) === 'token' ? Object.entries(profile.secrets ?? {}) : [];
  const secrets = pairs.map(([key, from]) => [key, lookup(from)]);
  const iso = adapter?.isolate?.({ home, profileName, profile }) ?? {};
  const env = allowedEnv({ base, adapter, home, profileName, profile, sources: [...sources, ...pairs.map(([, from]) => from)] });
  const del = pattern => { for (const k of Object.keys(env)) if (matches(pattern, k)) delete env[k]; };
  for (const pattern of iso.clear ?? []) del(pattern);
  for (const [k, v] of Object.entries(profile.env ?? {})) { del(k); env[k] = String(v); }
  for (const [k, v] of secrets) { del(k); env[k] = v; }
  for (const [k, v] of Object.entries(iso.set ?? {})) { del(k); env[k] = String(v); }
  if (home && profileName) applySandboxHome(env, { base, home, profileName, realHomeDefaults: iso.realHomeDefaults, del });
  return env;
}

// 用户目录换成沙箱（最后做，profile.env 与适配器都改不掉它）：
// - USERPROFILE、HOME 指向沙箱；Windows 上 HOMEDRIVE / HOMEPATH 按沙箱路径拆开。
// - git 仍用用户真实的全局配置（提交身份）：GIT_CONFIG_GLOBAL 指向真实的 ~/.gitconfig（或 ~/.config/git/config），
//   调用方环境已经设了 GIT_CONFIG_GLOBAL 时沿用；都没有就不设。
// - 适配器可以用 realHomeDefaults 声明"没设时指向真实用户目录下某处"的变量（codex 的 CODEX_HOME：Codex 执行者要用用户自己的登录）。
function applySandboxHome(env, { base, home, profileName, realHomeDefaults = {}, del }) {
  const sandbox = sandboxHome(home, profileName);
  const pick = name => Object.entries(base).find(([k, v]) => matches(name, k) && typeof v === 'string' && v)?.[1];
  const real = pick('USERPROFILE') ?? pick('HOME') ?? null;
  for (const [key, relative] of Object.entries(realHomeDefaults)) {
    if (real && !Object.keys(env).some(k => matches(key, k))) env[key] = join(real, relative);
  }
  const gitGlobal = pick('GIT_CONFIG_GLOBAL') ?? (real ? [join(real, '.gitconfig'), join(real, '.config', 'git', 'config')].find(file => existsSync(file)) : undefined);
  for (const key of ['USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'GIT_CONFIG_GLOBAL']) del(key);
  pointHome(env, sandbox);
  if (gitGlobal) env.GIT_CONFIG_GLOBAL = gitGlobal;
  // Windows：调用方（或 profile.env）没设 PSModuleAnalysisCachePath 时指向沙箱里的位置。用户目录换成沙箱后 PowerShell
  // 有时解析不出本地应用数据目录，会把模块分析缓存写进当前目录（Stage07 097 实测：工作区根多出 Microsoft/Windows/PowerShell/ModuleAnalysisCache）。
  if (process.platform === 'win32' && !Object.keys(env).some(k => matches('PSModuleAnalysisCachePath', k))) env.PSModuleAnalysisCachePath = psCachePath(sandbox);
}

const psCachePath = dir => join(dir, 'AppData', 'Local', 'Microsoft', 'Windows', 'PowerShell', 'ModuleAnalysisCache');

function pointHome(env, dir) {
  env.USERPROFILE = dir;
  env.HOME = dir;
  if (process.platform === 'win32') {
    env.HOMEDRIVE = parse(dir).root.replace(/[\\/]+$/, '');
    env.HOMEPATH = dir.slice(env.HOMEDRIVE.length) || '\\';
  }
}

// 启动执行者之前建好沙箱目录（buildEnv 本身只算环境、不碰文件系统）。公共目录下建不了（例如公共目录不可写）时，
// 改用系统临时目录里新建的一次性目录——**绝不回落到真实用户目录**。返回实际使用的目录。
export function ensureSandboxHome(env, { home, profileName } = {}) {
  if (!home || !profileName || env.USERPROFILE !== sandboxHome(home, profileName)) return env.USERPROFILE ?? null;
  try { makeSandbox(env.USERPROFILE); return env.USERPROFILE; }
  catch {
    const dir = mkdtempSync(join(tmpdir(), `ar-sandbox-${String(profileName).replace(/[^\w.-]/g, '_')}-`));
    registerOneShotSandbox(dir);
    // 缓存位置是核心按沙箱算出来的（不是调用方指定的）时，跟着换到一次性目录。
    const derived = env.PSModuleAnalysisCachePath === psCachePath(env.USERPROFILE);
    pointHome(env, dir);
    if (derived) env.PSModuleAnalysisCachePath = psCachePath(dir);
    makeSandbox(dir);
    return dir;
  }
}

// 一次性沙箱目录（上面的临时目录退回）：只有这里登记过的才会被删，公共目录下的正常沙箱一律不碰（D121）。
// 执行者结束后由 runner.mjs 删（removeOneShotSandbox）；没走到那里的（检测、被停止等）在进程退出时兜底删。
const oneShotSandboxes = new Set();
let oneShotHookInstalled = false;
const sameDir = (a, b) => resolvePath(a) === resolvePath(b);
function registerOneShotSandbox(dir) {
  oneShotSandboxes.add(resolvePath(dir));
  if (oneShotHookInstalled) return;
  oneShotHookInstalled = true;
  process.on('exit', () => { for (const one of oneShotSandboxes) try { rmSync(one, { recursive: true, force: true }); } catch { /* 退出时删不掉就算了。 */ } });
}

// 环境的用户目录是登记过的一次性目录时删掉它（被子进程占用就重试几次，仍不行就忽略）；返回是否删了。
export function removeOneShotSandbox(env) {
  const dir = env?.USERPROFILE;
  if (!dir || ![...oneShotSandboxes].some(one => sameDir(one, dir))) return false;
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { return false; }
  // 登记保留：同一个环境再启动时 reviveOneShotSandbox 要认得它，进程退出时的兜底对不存在的目录无害。
  return true;
}

// 同一个环境再启动一次执行者（自动重试等）前：它的一次性目录已被上一次收尾删掉时重新建好。
export function reviveOneShotSandbox(env) {
  const dir = env?.USERPROFILE;
  if (!dir || ![...oneShotSandboxes].some(one => sameDir(one, dir)) || existsSync(dir)) return;
  try { makeSandbox(dir); } catch { /* 建不了就让执行者按原样启动。 */ }
}

// Windows 上查"本机应用数据 / 漫游应用数据"这类已知文件夹时，按注册表里的 %USERPROFILE%\AppData\… 展开；
// 沙箱里没有这两个目录时 .NET 的 GetFolderPath 返回空串，PowerShell 随后把模块分析缓存写成相对路径，
// 落进执行者的工作目录（Stage05 058 第 4 次派发：仓库根多出 Microsoft/Windows/PowerShell/ModuleAnalysisCache）。
// 所以建沙箱时一并建好这两个目录，这类缓存留在沙箱里。
function makeSandbox(dir) {
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    for (const sub of ['Local', 'Roaming']) mkdirSync(join(dir, 'AppData', sub), { recursive: true });
    mkdirSync(dirname(psCachePath(dir)), { recursive: true });
  }
}

// 配置里所有 profile 的密钥来源变量名。
export const secretSources = config => Object.values(config?.profiles ?? {}).flatMap(p => Object.values(p?.secrets ?? {})).filter(v => typeof v === 'string');
