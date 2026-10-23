// 门禁：执行者结束后检查未提交、是否提交、改动范围，逐条运行验收命令，写 gate.json（文件协议第 12 节）。
// 本模块只负责"跑门禁并写结果"；派发前检查、gating / gate / end 事件与退出码由派发流程（T6）接入。
// 零依赖。
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { runCommand } from './command.mjs';
import { homeEnv } from './compat.mjs';
import { globToRegExp, matchesAny } from './glob.mjs';
import { baseProjectConfig, changedFiles, deletedFiles, headSha, uncommittedFiles } from './git.mjs';

// summary 里文件最多列 5 个，多了加"等"（协议 12.3）。
const MAX_SUMMARY_FILES = 5;
// verify_timeout_min 缺省时与 mergeSpec 的默认值一致（协议 11.3）。
const DEFAULT_VERIFY_TIMEOUT_MIN = 10;
// 基线项目配置没写 specsDir（或值不可用）时的任务说明目录（协议 12.1 第 4 步）。
const DEFAULT_SPECS_DIR = 'docs/specs';
// specsDir 为项目根本身（协议 12.1 第 4 步，065）：规范化结果记作 '.'，受保护的不是整个仓库。
export const ROOT_SPECS_DIR = '.';
// 项目根目录下符合任务说明命名的文件（三位编号加连字符开头、.md 结尾，如 065-修复.md；编号后的部分可为空）。
const ROOT_SPEC_FILE = /^\d{3}-.*\.md$/;

// 规范化基线项目配置里的 specsDir：\ 换 /、去掉开头 ./ 与末尾 /；
// '.' 与 './'（含尾部 /）规范化后为项目根（'.'）；其余不是字符串、空、绝对路径、含 .. 段时回退 docs/specs。
export function normalizeSpecsDir(value) {
  if (typeof value !== 'string') return DEFAULT_SPECS_DIR;
  const slashed = value.replace(/\\/g, '/');
  const dir = slashed.replace(/^\.\//, '').replace(/\/+$/, '');
  if (win32.isAbsolute(dir) || posix.isAbsolute(dir)) return DEFAULT_SPECS_DIR;
  if (dir.split('/').includes('..')) return DEFAULT_SPECS_DIR;
  if (dir === ROOT_SPECS_DIR) return ROOT_SPECS_DIR;
  // 空串要区分来源：'./'、'.\'（去掉 ./ 与末尾 / 后为空）是项目根；真没写（''）回退默认目录。
  if (!dir) return slashed.replace(/\/+$/, '') === ROOT_SPECS_DIR ? ROOT_SPECS_DIR : DEFAULT_SPECS_DIR;
  return dir;
}

// 项目根目录下是否是任务说明命名的文件（协议 12.1 第 4 步，065）：路径不含目录、三位编号加连字符开头、.md 结尾。
// 大小写规则与 glob.mjs 一致（Windows 上 .MD 也算）。
export function isRootSpecFile(file, options) {
  const caseInsensitive = options?.caseInsensitive ?? process.platform === 'win32';
  if (file.includes('/') || file.includes('\\')) return false;
  return (caseInsensitive ? file.toLowerCase() : file).match(ROOT_SPEC_FILE) !== null;
}

// 模式里第一个通配符（*、?）之前的字面前缀；没有通配符时是整个模式。
export function literalPrefixOf(pattern) {
  const index = pattern.search(/[*?]/);
  return index < 0 ? pattern : pattern.slice(0, index);
}

// 文件是否在目录下（目录无末尾 /）；大小写规则与 glob.mjs 一致（Windows 不区分大小写）。
function isUnderDir(file, dir, caseInsensitive) {
  const f = caseInsensitive ? file.toLowerCase() : file;
  const d = caseInsensitive ? dir.toLowerCase() : dir;
  return f === d || f.startsWith(`${d}/`);
}

// 受保护目录下的文件是否被 allowed_paths 明确写出（协议 12.1 第 4 步）：
// 某个模式在第一个通配符之前的字面前缀以该受保护目录开头，并且这个模式匹配该文件。
// options.caseInsensitive 缺省按平台（Windows 不区分大小写）；给定时供单元测试两个方向都验证。
export function explicitlyAllowed(file, allowed, protectedDirs, options) {
  const caseInsensitive = options?.caseInsensitive ?? process.platform === 'win32';
  const lower = value => (caseInsensitive ? value.toLowerCase() : value);
  for (const dir of protectedDirs) {
    if (!isUnderDir(file, dir, caseInsensitive)) continue;
    for (const pattern of allowed) {
      if (!lower(literalPrefixOf(pattern)).startsWith(lower(dir))) continue;
      if (globToRegExp(pattern, { caseInsensitive }).test(file)) return true;
    }
  }
  return false;
}

// specsDir 为项目根时（协议 12.1 第 4 步，065）：放行的模式要明确写到编号——
// 第一个通配符之前的字面前缀以这个文件的 NNN- 开头（例如 065-*.md），且模式匹配该文件。
export function explicitlyAllowedRootSpec(file, allowed, options) {
  const caseInsensitive = options?.caseInsensitive ?? process.platform === 'win32';
  const lower = value => (caseInsensitive ? value.toLowerCase() : value);
  const nnn = file.slice(0, 4); // 'NNN-'
  for (const pattern of allowed) {
    if (!lower(literalPrefixOf(pattern)).startsWith(lower(nnn))) continue;
    if (globToRegExp(pattern, { caseInsensitive }).test(file)) return true;
  }
  return false;
}

// 命令失败的原因写法：超时 →（超时）；启动失败 →（<error>）；否则 →（exit N）。
function commandFailureReason(command) {
  if (command.timedOut) return '（超时）';
  if (command.error != null) return `（${command.error}）`;
  return `（exit ${command.exit}）`;
}

// 由门禁各部分拼 summary（协议 12.3）：通过时为"门禁通过"；
// 否则按"没有提交任何改动 → 有未提交的文件 → 改动超出范围 → 验收命令失败"的顺序用"；"连接。
// parts 可以是 gate 对象本身（T6 / Stage05 直接用），也可以只给需要的字段。
export function summarizeGate(parts = {}) {
  const commit = parts.commit ?? {};
  const uncommitted = Array.isArray(parts.uncommitted) ? parts.uncommitted : [];
  const scope = parts.scope ?? {};
  const outside = Array.isArray(scope.outside) ? scope.outside : [];
  const commands = Array.isArray(parts.commands) ? parts.commands : [];

  const reasons = [];
  if (commit.required === true && commit.ok === false) reasons.push('没有提交任何改动');
  if (uncommitted.length) reasons.push('有未提交的文件');
  if (outside.length) {
    // 超过 5 个时写成 "a、b、c、d、e 等"（协议 12.3：等前面一个空格）。
    const shown = outside.slice(0, MAX_SUMMARY_FILES).join('、');
    reasons.push(`改动超出范围：${shown}${outside.length > MAX_SUMMARY_FILES ? ' 等' : ''}`);
  }
  const failed = commands.filter(command => command.timedOut
    || command.error != null
    || (typeof command.exit === 'number' && command.exit !== 0));
  // 每条失败的命令各占一段，与其他段一样用"；"连接（协议 12.3）。
  for (const command of failed) {
    reasons.push(`验收命令失败：${command.line}${commandFailureReason(command)}`);
  }
  return reasons.length ? reasons.join('；') : '门禁通过';
}

// 去掉 dropEnv 列出的变量名和 AgentRouter 自己的变量（公共目录的新旧名、AR_*）；
// Windows 上变量名不区分大小写（协议 12.2）。派发进程的公共目录等设置不能漏进项目自己的测试。
function removeEnv(env, names) {
  const caseInsensitive = process.platform === 'win32';
  const normalize = name => (caseInsensitive ? String(name).toLowerCase() : String(name));
  const dropped = new Set([...(names ?? []), ...homeEnv].map(normalize));
  const prefix = normalize('AR_');
  const result = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    const name = normalize(key);
    if (dropped.has(name) || name.startsWith(prefix)) continue;
    result[key] = value;
  }
  return result;
}

// 原子写 gate.json：先写同目录临时文件，再改名（同名覆盖由 rename 完成）。
function writeGateJson(dir, gate) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'gate.json');
  const tmp = join(dir, `.gate.json.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(gate, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败不覆盖原始错误。 */ }
    throw error;
  }
}

// 跑一次门禁并写 <dir>/gate.json，返回 gate 对象（协议 12.3 的全部字段）。
// spec 是 mergeSpec 的结果（allowed_paths、verify、expect_commit、verify_timeout_min）。
// 检查步骤里的意外错误（如 git 不可用）不抛出：记成门禁失败，summary 写明原因，照样写 gate.json。
// verifyTimeoutMs 只供测试：给定时代替 verify_timeout_min * 60000（单位是分钟，测试无法表达 1.5 秒）。
// dir 缺省时写到 <root>/.agent-runs（T6 应显式传本次任务的记录目录）。
// onSpawn(pid) 可选：每条验收命令启动后拿到子进程 pid，结束时收到 null（T6 停止信号用）；不加时行为不变。
// TODO(lead): 协议没写 git 出错时是否还要继续跑验收命令；暂时整段中止、commands 记空，summary 只写原因。
export async function runGate({
  root, base, spec = {}, env = process.env, dropEnv = [], dir = join(root, '.agent-runs'),
  attempt = 1, now = Date.now, verifyTimeoutMs, onSpawn,
} = {}) {
  const started = now();
  const merged = spec ?? {};
  const allowed = Array.isArray(merged.allowed_paths) ? merged.allowed_paths.slice() : ['**'];
  const verify = Array.isArray(merged.verify) ? merged.verify.slice() : [];
  const required = merged.expect_commit === true;
  const timeoutMs = Number.isFinite(verifyTimeoutMs)
    ? verifyTimeoutMs
    : (Number.isFinite(merged.verify_timeout_min) ? merged.verify_timeout_min : DEFAULT_VERIFY_TIMEOUT_MIN) * 60000;

  const commit = { required, ok: true };
  let head = null;
  let uncommitted = [];
  const scope = { allowed, changed: [], outside: [], protected: [], deleted: [] };
  let commands = [];
  let failure = null;

  try {
    head = headSha(root);
    // 顺序照协议 12.1：未提交检查 → 提交检查 → 范围检查 → 验收命令。
    uncommitted = uncommittedFiles(root);
    if (required && head === base) commit.ok = false;
    // 受保护的路径（协议 12.1 第 4 步）：.agent-router/ 与基线项目配置的 specsDir；
    // 匹配 allowed_paths 但没被"明确写了这个目录"的模式放行时，照样算越界，另记入 protected。
    // specsDir 为项目根本身（'.'，065）时受保护的只有根目录下 NNN-*.md 的文件，不是整个仓库。
    const specsDir = normalizeSpecsDir(baseProjectConfig(root, base)?.specsDir);
    const rootSpecs = specsDir === ROOT_SPECS_DIR;
    const changed = changedFiles(root, base, head);
    scope.changed = changed;
    for (const file of changed) {
      const underAgentRouter = isUnderDir(file, '.agent-router', process.platform === 'win32');
      const underSpecsDir = rootSpecs ? isRootSpecFile(file) : isUnderDir(file, specsDir, process.platform === 'win32');
      const underProtected = underAgentRouter || underSpecsDir;
      let allowedOk = matchesAny(file, allowed);
      // 明确写出才放行：.agent-router/ 的模式以目录开头；specsDir 为项目根时以该文件的 NNN- 开头；否则以目录开头。
      if (allowedOk && underAgentRouter) allowedOk = explicitlyAllowed(file, allowed, ['.agent-router']);
      else if (allowedOk && underSpecsDir) allowedOk = rootSpecs
        ? explicitlyAllowedRootSpec(file, allowed)
        : explicitlyAllowed(file, allowed, [specsDir]);
      if (!allowedOk) {
        scope.outside.push(file);
        if (underProtected) scope.protected.push(file);
      }
    }
    // 删除的文件（协议 12.1 第 4 步）：只记录，不单独让门禁失败；超出范围的删除照常留在 outside 里。
    scope.deleted = deletedFiles(root, base, head);
    const commandEnv = removeEnv(env, dropEnv);
    for (const line of verify) {
      const result = await runCommand(line, { cwd: root, env: commandEnv, timeoutMs, onSpawn });
      commands.push({
        line: result.line, argv: result.argv, exit: result.exit, ms: result.ms,
        timedOut: result.timedOut, output: result.output, truncated: result.truncated, error: result.error,
      });
    }
  } catch (error) {
    failure = error;
    // TODO(lead): git 状态读不到时 commit.ok 该写什么协议没说；暂时按"要提交且没能核对"记失败（保守）。
    if (required) commit.ok = false;
    commands = [];
  }

  const ok = !failure
    && uncommitted.length === 0
    && commit.ok === true
    && scope.outside.length === 0
    && commands.every(command => !command.timedOut && command.error == null && command.exit === 0);
  const at = now();
  const gate = {
    v: 1,
    attempt,
    at,
    ms: at - started,
    ok,
    base: base ?? null,
    head,
    commit,
    uncommitted,
    scope,
    commands,
    summary: failure ? `无法读取 git 状态：${failure.message}` : summarizeGate({ commit, uncommitted, scope, commands }),
  };
  writeGateJson(dir, gate);
  return gate;
}
