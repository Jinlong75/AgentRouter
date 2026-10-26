import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { longPath } from '../../core/lib/paths.mjs';

// 124：交给执行者的工作目录统一成长路径。这里只测 longPath；runner 的接线由 claude-code-dispatch 集成测试覆盖。
function tempDir(t, prefix = 'ar 长路径 ') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

test('longPath：本来就是长路径的目录原样返回', t => {
  const dir = realpathSync.native(tempDir(t));
  assert.equal(longPath(dir), dir);
});

test('longPath：不存在的目录原样返回，不抛错', t => {
  const missing = path.join(tempDir(t), '不存在', '子目录');
  assert.equal(longPath(missing), missing);
});

test('longPath：Windows 上 8.3 短路径转成长路径', { skip: process.platform !== 'win32' && '只有 Windows 有 8.3 短路径' }, t => {
  // cmd 输出用系统代码页，中文会乱码，所以这个用例的目录名只用 ASCII。
  const base = realpathSync.native(tempDir(t, 'ar-longpath-'));
  // 目录名超过 8 个字符且含空格，系统一般会生成 8.3 短名；用 cmd 取短名。
  const dir = path.join(base, 'long directory name');
  mkdirSync(dir);
  const out = spawnSync('cmd', ['/d', '/c', `for %I in ("${dir}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, shell: false, windowsVerbatimArguments: true });
  const short = String(out.stdout ?? '').trim().split(/\r?\n/).pop();
  if (!short || !/~\d/.test(short)) { t.skip(`取不到 8.3 短名（该卷可能关闭了短名生成）：${short || out.stderr}`); return; }
  assert.notEqual(short, dir);
  assert.equal(longPath(short), dir);
});
