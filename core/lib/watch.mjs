import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { legacyRunsName } from './compat.mjs';
import { readJson } from './json.mjs';

// 软件心跳（428）：viewer.json 的 updated 超过这个时长没更新，就当作软件已经不在运行。
// 软件被强制结束时文件会留下，旧进程号可能被别的进程复用，只看进程会误判。
export const VIEWER_STALE_MS = 90000;

// 读 viewer.json 判断软件是否接管进度窗口，返回 { takeover, pid }。
// 有数字 updated 且 now - updated 超过 VIEWER_STALE_MS 时不接管（心跳过期，不再核对进程号）；
// 没有 updated 的旧格式照旧只看进程是否存活（已有测试与旧版软件兼容）。
export function viewerState(home, alive = pid => process.kill(pid, 0), now = Date.now()) {
  try {
    const viewer = readJson(join(home, 'viewer.json'));
    if (!viewer.suppressWatchWindow || !Number.isSafeInteger(viewer.pid) || viewer.pid <= 0) return { takeover: false, pid: null };
    if (typeof viewer.updated === 'number' && Number.isFinite(viewer.updated) && now - viewer.updated > VIEWER_STALE_MS) return { takeover: false, pid: null };
    alive(viewer.pid);
    return { takeover: true, pid: viewer.pid };
  } catch { return { takeover: false, pid: null }; }
}

export function viewerTakesOver(home, alive = pid => process.kill(pid, 0), now = Date.now()) {
  return viewerState(home, alive, now).takeover;
}

// 会弹出只读进度窗口的平台（Windows 控制台窗口、macOS Terminal）；其余平台本来就不弹窗。
const watchesWindow = platform => platform === 'win32' || platform === 'darwin';

export function shouldWatch({ platform, interactive, policy, takeover }) {
  return watchesWindow(platform) && !interactive && policy !== 'never' && (policy === 'always' || !takeover);
}

// 前台打印原因与后台弹窗共用同一份判断（428）：opened 为真才弹窗；
// 不弹窗时说明原因——策略 never、软件接管（进度在软件里），其余情况没有原因。
// 平台判断与 shouldWatch 用同一处：这个平台本来会弹窗、非交互、策略不是 never、且软件接管。
export function watchPlan({ platform, interactive, policy, viewer }) {
  const takeover = viewer?.takeover === true;
  if (shouldWatch({ platform, interactive, policy, takeover })) return { opened: true };
  if (policy === 'never') return { opened: false, reason: 'never' };
  if (watchesWindow(platform) && !interactive && takeover) return { opened: false, reason: 'viewer', pid: viewer.pid };
  return { opened: false };
}

export function watchCommand(name, progress, label = 'Codex') {
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  return `$host.UI.RawUI.WindowTitle=${quote(`${label} ${name}（只看）`)}; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content -LiteralPath ${quote(progress)} -Encoding UTF8 -Wait -Tail 200`;
}

// codex-watch.cmd 的脚本原文。cmd 按控制台代码页（如 936）读批处理，任何非 ASCII 字符（含 rem 注释）都可能被解坏，
// 所以 .cmd 整份只用 ASCII，脚本以 UTF-16LE Base64（-EncodedCommand）传入；改这里后要同步重新编码，测试会核对。
// 先找 v2 记录（.agent-runs\<名>\progress.log），也兼容 v1 旧记录目录（compat.legacyRunsName），取最近写入的一个。
export const latestWatchScript = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $f = @(Get-ChildItem .agent-runs\\*\\progress.log -ErrorAction SilentlyContinue) + @(Get-ChildItem " + legacyRunsName + "\\*.progress.log -ErrorAction SilentlyContinue) | Sort-Object LastWriteTime | Select-Object -Last 1; if (-not $f) { '还没有任务进度'; return }; $name = if ($f.Name -eq 'progress.log') { $f.Directory.Name } else { $f.Name -replace '\\.progress\\.log$', '' }; $host.UI.RawUI.WindowTitle = 'AgentRouter 进度（只看）：' + $name; Get-Content -LiteralPath $f.FullName -Encoding UTF8 -Wait -Tail 200";

export function openWatch(name, progress, label, env = process.env) {
  if (env.AR_TEST_WATCH_LOG) {
    appendFileSync(env.AR_TEST_WATCH_LOG, `${JSON.stringify({ name, progress, label })}\n`);
    return;
  }
  // 编码 PowerShell 脚本避免路径经 cmd 二次解释；只读窗口仍然独立于任务。
  const encoded = Buffer.from(watchCommand(name, progress, label), 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NoExit', '-EncodedCommand', encoded], {
    detached: true, stdio: 'ignore', windowsHide: false, shell: false,
  });
  child.on('error', () => {});
  child.unref();
}
