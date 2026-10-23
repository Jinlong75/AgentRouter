// 测试专用：在一个临时目录里放一个假的 codex（Windows 是 npm 写法的 codex.cmd + codex.js，其他平台是可执行的 codex），
// 返回这个目录，调用方把它放在 PATH 最前面。Stage05：有测试从继承的 PATH 里找到了真实 codex，
// 在用户真实的 ~/.codex 里跑了 --version 与 login status。假 codex 的行为与 tools/verify-tests.mjs 的哨兵一致：
// --version 回一个版本，其他调用以 1 结束（登录状态因此是"未知"）。不记日志、不碰任何真实目录。
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function fakeCodexDir(base) {
  const dir = path.join(base, '假 codex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'codex.js'), "if (process.argv.includes('--version')) console.log('codex-cli test-fake'); else process.exitCode = 1;\n");
  if (process.platform === 'win32') writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\n"%_prog%" "%dp0%\\codex.js" %*\r\n');
  else {
    writeFileSync(path.join(dir, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'codex.js')}" "$@"\n`);
    chmodSync(path.join(dir, 'codex'), 0o755);
  }
  return dir;
}

// 把假 codex 目录放在 PATH 最前面（Windows 上环境变量名不区分大小写，沿用已有的那个键）。
export function withFakeCodex(env, base) {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  return { ...env, [key]: `${fakeCodexDir(base)}${path.delimiter}${env[key] ?? ''}` };
}
