// 旧名称集中在这里：新代码只调用本文件导出的函数，不直接读旧环境变量。
// 每一项都是"新名优先，旧名兜底"；删除兼容时只改这一个文件。
import { homedir as systemHomedir } from 'node:os';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';

// 返回第一个有值的环境变量名，没有则 undefined。
export const pickName = (env, ...keys) => keys.find(key => env[key]);
const pick = (env, ...keys) => { const key = pickName(env, ...keys); return key && env[key]; };

export const homeEnv = ['AGENT_ROUTER_HOME', 'CODEX_DISPATCH_HOME'];
export const noWatchEnv = ['AR_NO_WATCH', 'CODEX_NO_WATCH'];

export function userDirectory(env = process.env, platform = process.platform) {
  return (platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME || env.USERPROFILE) || systemHomedir();
}
function configBase(env, platform) {
  return platform === 'win32'
    ? env.APPDATA || join(userDirectory(env, platform), 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME || join(userDirectory(env, platform), '.config');
}
// 公共目录：%APPDATA%\agent-router（AGENT_ROUTER_HOME 覆盖，旧变量 CODEX_DISPATCH_HOME 仍有效）。
export function homeDirectory(env = process.env, platform = process.platform) {
  const explicit = pick(env, ...homeEnv);
  return explicit ? resolve(explicit) : join(configBase(env, platform), 'agent-router');
}
// 公共目录不能设为用户目录或磁盘根目录（协议第 1 节"保护"）。
// 纯函数：只读参数，不访问文件；不安全时返回中文原因，安全时返回 null。
// 语义按传入的 platform 选择路径规则（win32 / posix），Windows 上比较不区分大小写。
export function unsafeHome(dir, { env = process.env, platform = process.platform, homedir = systemHomedir() } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const compare = value => platform === 'win32' ? value.toLowerCase() : value;
  const home = paths.resolve(dir);
  // resolve 已去掉末尾分隔符；空值的来源跳过。
  const users = [env.USERPROFILE, env.HOME, homedir].filter(Boolean).map(value => compare(paths.resolve(value)));
  if (users.includes(compare(home))) return unsafeHomeReason(home);
  // path.parse().root === 自身：盘符根、UNC 共享根、posix 的 /。
  if (paths.parse(home).root === home) return unsafeHomeReason(home);
  return null;
}
// 原因文字按协议第 1 节原文；<路径> 用规范化后的公共目录。
export const unsafeHomeReason = home => `公共目录不能设为用户目录或磁盘根目录：${home}。请把 AGENT_ROUTER_HOME 设为一个专用的文件夹（例如临时目录下新建的文件夹），或者删掉这个变量。`;
// v1 读取兼容：显式指定公共目录（测试隔离）时旧目录与新目录相同，避免读到真实的旧目录。
export function legacyHomeDirectory(env = process.env, platform = process.platform) {
  const explicit = pick(env, ...homeEnv);
  return explicit ? resolve(explicit) : join(configBase(env, platform), 'codex-dispatch');
}
// 只凭公共目录本身推出旧目录：默认的 …/agent-router 对应同级 …/codex-dispatch；其他（显式指定、测试隔离）没有旧目录。
// 不读环境变量，所以调用方不传 env 时也不会碰到真实的旧目录。
export const legacyHomeFor = home => basename(home) === 'agent-router' ? join(dirname(home), 'codex-dispatch') : home;
export const dryRun = env => !!pick(env, 'AR_DRY_RUN', 'CODEX_DRY_RUN');
export const noWatch = env => !!pick(env, ...noWatchEnv);
export const testAgent = env => pick(env, ...testAgentEnv);
export function testStartTimeout(env) {
  const value = Number(pick(env, 'AR_TEST_START_TIMEOUT_MS', 'CODEX_DISPATCH_TEST_START_TIMEOUT_MS'));
  return value > 0 ? value : null;
}
export const legacyRunsName = '.codex-runs';
export const legacyRunsDir = root => join(root, legacyRunsName);
export const testAgentEnv = ['AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT'];
// 停止与托管核对命令行时接受的派发入口。
export const scriptNames = ['ar.mjs', 'codex-task.mjs'];
export const installMarkers = ['.agent-router.json', '.dispatchdock.json'];
