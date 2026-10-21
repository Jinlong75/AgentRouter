// 门禁：执行者结束后检查未提交、是否提交、改动范围，逐条运行验收命令，写 gate.json（文件协议第 12 节）。
// 本模块只负责"跑门禁并写结果"；派发前检查、gating / gate / end 事件与退出码由派发流程（T6）接入。
// 零依赖。
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './command.mjs';
import { homeEnv } from './compat.mjs';
import { matchesAny } from './glob.mjs';
import { changedFiles, headSha, uncommittedFiles } from './git.mjs';

// summary 里文件最多列 5 个，多了加"等"（协议 12.3）。
const MAX_SUMMARY_FILES = 5;
// verify_timeout_min 缺省时与 mergeSpec 的默认值一致（协议 11.3）。
const DEFAULT_VERIFY_TIMEOUT_MIN = 10;

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
  const scope = { allowed, changed: [], outside: [] };
  let commands = [];
  let failure = null;

  try {
    head = headSha(root);
    // 顺序照协议 12.1：未提交检查 → 提交检查 → 范围检查 → 验收命令。
    uncommitted = uncommittedFiles(root);
    if (required && head === base) commit.ok = false;
    const changed = changedFiles(root, base, head);
    scope.changed = changed;
    scope.outside = changed.filter(file => !matchesAny(file, allowed));
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
