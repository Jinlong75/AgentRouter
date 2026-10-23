import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { legacyRunsName } from './compat.mjs';
import { readJson } from './json.mjs';

export function viewerTakesOver(home, alive = pid => process.kill(pid, 0)) {
  try {
    const viewer = readJson(join(home, 'viewer.json'));
    if (!viewer.suppressWatchWindow || !Number.isSafeInteger(viewer.pid) || viewer.pid <= 0) return false;
    alive(viewer.pid);
    return true;
  } catch { return false; }
}

export function shouldWatch({ platform, interactive, policy, takeover }) {
  return platform === 'win32' && !interactive && policy !== 'never' && (policy === 'always' || !takeover);
}

export function watchCommand(name, progress, label = 'Codex') {
  const quote = value => `'${value.replace(/'/g, "''")}'`;
  return `$host.UI.RawUI.WindowTitle=${quote(`${label} ${name}（只看）`)}; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content -LiteralPath ${quote(progress)} -Encoding UTF8 -Wait -Tail 200`;
}

// codex-watch.cmd 的脚本原文。cmd 按控制台代码页（如 936）读批处理，任何非 ASCII 字符（含 rem 注释）都可能被解坏，
// 所以 .cmd 整份只用 ASCII，脚本以 UTF-16LE Base64（-EncodedCommand）传入；改这里后要同步重新编码，测试会核对。
// 先找 v2 记录（.agent-runs\<名>\progress.log），也兼容 v1 旧记录目录（compat.legacyRunsName），取最近写入的一个。
export const latestWatchScript = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $f = @(Get-ChildItem .agent-runs\\*\\progress.log -ErrorAction SilentlyContinue) + @(Get-ChildItem " + legacyRunsName + "\\*.progress.log -ErrorAction SilentlyContinue) | Sort-Object LastWriteTime | Select-Object -Last 1; if (-not $f) { '还没有任务进度'; return }; $name = if ($f.Name -eq 'progress.log') { $f.Directory.Name } else { $f.Name -replace '\\.progress\\.log$', '' }; $host.UI.RawUI.WindowTitle = 'AgentRouter 进度（只看）：' + $name; Get-Content -LiteralPath $f.FullName -Encoding UTF8 -Wait -Tail 200";

export function openWatch(name, progress, label) {
  // 编码 PowerShell 脚本避免路径经 cmd 二次解释；只读窗口仍然独立于任务。
  const encoded = Buffer.from(watchCommand(name, progress, label), 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NoExit', '-EncodedCommand', encoded], {
    detached: true, stdio: 'ignore', windowsHide: false, shell: false,
  });
  child.on('error', () => {});
  child.unref();
}
