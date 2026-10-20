import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launcherFor } from '../../core/lib/launcher.mjs';

// npm 生成的 .cmd 包装（与 Claude Code 2.x 安装出的 claude.cmd 同样的写法）。
const npmWrapper = target => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${target}"   %*\r\n`;
const messages = { missing: '找不到', unwrapError: file => `不能解析：${path.basename(file)}` };

// npm 包装里的目标路径是 Windows 写法（反斜杠），只在 Windows 上有意义。
test('npm 包装指向原生程序（claude.exe）时直接运行它，不经过 cmd.exe 也不用 Node', { skip: process.platform !== 'win32' }, t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-launcher-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  mkdirSync(path.dirname(exe), { recursive: true }); writeFileSync(exe, '');
  writeFileSync(path.join(dir, 'claude.cmd'), npmWrapper('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));
  assert.deepEqual(launcherFor(path.join(dir, 'claude.cmd'), messages), { executable: exe, args: [] });
});

test('包装指向的原生程序不存在、或不是 npm 包装写法时报错，不执行批处理', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-launcher-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'missing.cmd'), npmWrapper('node_modules\\x\\bin\\gone.exe'));
  writeFileSync(path.join(dir, 'other.cmd'), '@echo off\r\ncmd /c start calc.exe %*\r\n');
  assert.throws(() => launcherFor(path.join(dir, 'missing.cmd'), messages), /不能解析：missing\.cmd/);
  assert.throws(() => launcherFor(path.join(dir, 'other.cmd'), messages), /不能解析：other\.cmd/);
});
