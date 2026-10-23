// 密钥：配置里只写"从哪个环境变量读"，值只在启动执行者时解析并传给子进程。
// 解析顺序：进程环境变量 → Windows 用户环境变量（注册表 HKCU\Environment，解决"刚设置、已打开的程序读不到"）→ 报错。
// 任何返回值、错误信息、日志都只含变量名，不含值。
import { spawnSync } from 'node:child_process';
import { writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { trace, traced } from './trace.mjs';
import { readJson } from './json.mjs';

// 追踪里子进程的结束状态：区分正常结束、被超时上限截断（ETIMEDOUT）与启动失败（只在 ar agents list 传入 tracePrefix 时使用）。
const subprocessOutcome = r => !r
  ? 'status=unknown'
  : r.error ? (r.error.code === 'ETIMEDOUT' ? 'timeout' : `error=${r.error.code ?? 'unknown'}`)
    : r.signal ? `signal=${r.signal}` : `status=${r.status}`;

const validName = name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
const checkName = name => { if (!validName(name)) throw Error(`变量名无效：${String(name).slice(0, 64)}`); };

// 隔离的密钥文件（仅测试 / 界面验收）：AR_TEST_SECRETS_FILE 指向 JSON 时，读写在它上面进行，完全跳过注册表。
function readTestSecrets(file) {
  try {
    const value = readJson(file);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function readTestSecret(file, name, platform) {
  const data = readTestSecrets(file);
  if (Object.hasOwn(data, name)) return typeof data[name] === 'string' ? data[name] : undefined;
  if (platform !== 'win32') return undefined;
  const key = Object.keys(data).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined || typeof data[key] !== 'string' ? undefined : data[key];
}

function writeTestSecrets(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.secrets-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

function writeTestSecret(file, name, value) {
  const data = readTestSecrets(file);
  data[name] = value;
  writeTestSecrets(file, data);
}

// 隔离模式里按 Windows 的规则删除（变量名不区分大小写）；文件里本来没有这个变量也算成功。
function deleteTestSecret(file, name, platform) {
  const data = readTestSecrets(file);
  const keys = Object.keys(data).filter(k => k === name || (platform === 'win32' && k.toLowerCase() === name.toLowerCase()));
  if (!keys.length) return;
  for (const key of keys) delete data[key];
  writeTestSecrets(file, data);
}

// 环境对象里按名字取值；Windows 变量名不区分大小写（测试与软件传入的是普通对象，不是 process.env 代理）。
export function lookup(env, name, platform = process.platform) {
  if (Object.hasOwn(env, name)) return env[name];
  if (platform !== 'win32') return undefined;
  const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

// 默认的注册表查询：reg.exe 以参数数组启动，不经过 shell。
const runReg = name => spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000 });

// 读 Windows 用户环境变量；不是 Windows、没有这个变量或读失败都返回 undefined。
// tracePrefix：ar agents list 的阶段追踪前缀（每次查询只查一个变量，标签里标出个数；不含变量值）。
export function queryUserEnv(name, { platform = process.platform, env = process.env, run = runReg, tracePrefix } = {}) {
  checkName(name);
  // 隔离模式：只读测试密钥文件，不碰注册表（没有子进程，不记追踪）。
  if (env.AR_TEST_SECRETS_FILE) return readTestSecret(env.AR_TEST_SECRETS_FILE, name, platform);
  if (platform !== 'win32') return undefined;
  const label = tracePrefix ? `${tracePrefix} secretStatus reg query ${name}（1 个变量）` : null;
  // 其他命令不传 tracePrefix，行为与原来一致。
  const r = label ? traced(label, () => run(name)) : run(name);
  if (label) trace(`${label} 子进程 ${subprocessOutcome(r)}`);
  if (!r || r.status !== 0 || typeof r.stdout !== 'string') return undefined;
  const m = r.stdout.match(new RegExp(`^\\s*${name}\\s+(REG_SZ|REG_EXPAND_SZ)\\s+(.*?)\\s*$`, 'mi'));
  if (!m) return undefined;
  if (m[1] !== 'REG_EXPAND_SZ') return m[2];
  return m[2].replace(/%([^%]+)%/g, (all, v) => lookup(env, v, platform) ?? all);
}

export function resolveSecret(name, { env = process.env, platform = process.platform, tracePrefix, query = n => queryUserEnv(n, { platform, env, tracePrefix }) } = {}) {
  checkName(name);
  const value = (lookup(env, name, platform) || query(name) || '').trim();
  if (!value) throw Error(`未设置密钥 ${name}：在软件的 Agent 页设置，或设置 Windows 用户环境变量 ${name}`);
  return value;
}

// 只报告 set / missing，从不带值。
export function secretStatus(names, opts) {
  return Object.fromEntries(names.map(n => { try { resolveSecret(n, opts); return [n, 'set']; } catch { return [n, 'missing']; } }));
}

// 默认的写入方式：值经 stdin 传给 PowerShell，不出现在任何进程的命令行里；
// [Environment]::SetEnvironmentVariable(…, 'User') 会通知系统环境变量已变化。
const runPowerShell = (script, input) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
  { input, encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000 });

export function setUserSecret(name, value, { platform = process.platform, env = process.env, run = runPowerShell } = {}) {
  checkName(name);
  if (typeof value !== 'string' || !value.trim()) throw Error(`密钥 ${name} 不能为空`);
  if (/[\r\n]/.test(value.trim())) throw Error(`密钥 ${name} 不能包含换行`);
  // 隔离模式：只写测试密钥文件（原子写入），不调用 PowerShell、不碰注册表。
  if (env.AR_TEST_SECRETS_FILE) { writeTestSecret(env.AR_TEST_SECRETS_FILE, name, value.trim()); return; }
  if (platform !== 'win32') throw Error('只有 Windows 支持写入用户环境变量；其他平台请在 shell 配置里设置');
  // 标准输入按 UTF-8 读（默认是控制台代码页，非 ASCII 字符会被读坏；Stage02 实测）。
  const script = `[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $v=[Console]::In.ReadToEnd().TrimEnd([char]13,[char]10); [Environment]::SetEnvironmentVariable('${name}',$v,'User')`;
  const r = run(script, value.trim());
  // 失败原因只取状态码，不转出 stderr（以防其中回显了输入）。
  if (!r || r.status !== 0) throw Error(`写入用户环境变量 ${name} 失败（退出码 ${r?.status ?? '无'}）`);
}

// 删除 Windows 用户环境变量（值设为 $null）。变量名经过同一套校验；不存在的变量也算成功。
// 隔离模式只改测试密钥文件。脚本里只有变量名，值不经过命令行。
export function unsetUserSecret(name, { platform = process.platform, env = process.env, run = runPowerShell } = {}) {
  checkName(name);
  if (env.AR_TEST_SECRETS_FILE) { deleteTestSecret(env.AR_TEST_SECRETS_FILE, name, platform); return; }
  if (platform !== 'win32') throw Error('只有 Windows 支持删除用户环境变量；其他平台请在 shell 配置里删除');
  const script = `[Environment]::SetEnvironmentVariable('${name}',$null,'User')`;
  const r = run(script);
  if (!r || r.status !== 0) throw Error(`删除用户环境变量 ${name} 失败（退出码 ${r?.status ?? '无'}）`);
}
