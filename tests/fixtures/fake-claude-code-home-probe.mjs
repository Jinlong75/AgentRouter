// 测试用（064）：假的 Claude Code，在正式回放输出之前按"事故写法"往用户目录写探针文件：
// ① Node 的 os.homedir()；② Windows 上用 PowerShell 给只读的 $home 赋值（会失败），再写 (Join-Path $home …)——
// 与 Stage05 058 / 063 事故里执行者的写法一样。之后交给 fake-claude-code.mjs 正常回放。只写用户目录，不碰别处。
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (!process.argv.includes('--version')) {
  writeFileSync(path.join(homedir(), 'probe-node.txt'), 'node\n');
  if (process.platform === 'win32') {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$home = 'C:\\不应生效'; Set-Content -Path (Join-Path $home 'probe-ps.txt') -Value 'ps' -Encoding ascii"],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000 });
    // ③ PowerShell 眼里的"本机应用数据"目录（.NET GetFolderPath）：沙箱缺 AppData\Local 时是空串，缓存会落进工作目录。
    // 路径可能含中文，用 UTF-16 写（Windows PowerShell 5.1 的 ascii / 控制台输出会把中文弄乱）。
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Set-Content -Path (Join-Path $HOME 'probe-localappdata.txt') -Value ('[' + [Environment]::GetFolderPath('LocalApplicationData') + ']') -Encoding unicode"],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000 });
  }
}
await import('./fake-claude-code.mjs');
