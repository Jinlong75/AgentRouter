import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeGeneric } from '../../core/adapters/generic.mjs';
import { resolveExecutable } from '../../core/lib/command.mjs';

// 422 D176：软件里核心跑在 Electron 自带的 Node 里（ELECTRON_RUN_AS_NODE=1，process.execPath 是 AgentRouter.exe），
// 托管安装的 dsh 是 npm 的 .cmd 包装，入口是 node_modules\@deepseek-ai\dsh\lib\bin.js。
// 这里造一个同结构的假包装（不装 dsh、不联网），并用 core 真实启动执行者的 generic 适配器算命令。
const realNode = process.execPath;
const nodeDir = path.dirname(realNode);

function setup(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-dsh-runtime-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const bin = path.join(base, 'node_modules', '.bin');
  const entry = path.join(base, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, "console.log(JSON.stringify({ electron: process.versions.electron ?? null, execPath: process.execPath }));\n");
  // npm cmd-shim 的真实写法：入口带 ..\，"%_prog%" 与入口之间是两个空格。
  const cmd = path.join(bin, 'dsh.cmd');
  writeFileSync(cmd, [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\@deepseek-ai\\dsh\\lib\\bin.js" %*',
    '',
  ].join('\r\n'));
  return { base, bin, entry, cmd, report: path.join(base, 'report.md') };
}

// 模拟核心运行在 Electron 里：process.execPath 指向不是 Node 的程序，process.versions.electron 有值。
function asElectron(t, base) {
  const saved = { execPath: process.execPath, electron: process.versions.electron, had: Object.prototype.hasOwnProperty.call(process.versions, 'electron') };
  const stub = path.join(base, 'AgentRouter.exe');
  process.execPath = stub;
  process.versions.electron = '43.7.5';
  t.after(() => {
    process.execPath = saved.execPath;
    if (saved.had) process.versions.electron = saved.electron;
    else delete process.versions.electron;
  });
  return stub;
}

const declare = ({ cmd }) => ({ label: 'DeepSeek Harness', executable: cmd, detect: ['--version'], args: ['headless', '--json', '-'], stdin: '{prompt}', requiresSystemNode: true });
// 是否要求系统 Node 由声明字段决定。
const harness = decl => makeGeneric(decl, { name: 'deepseek-harness' });

test('D176：Electron 里运行核心时，dsh 用系统 Node 启动，不在 Electron 的 Node 里跑', { skip: process.platform !== 'win32' ? '只测 Windows 的 npm 包装' : false }, t => {
  const { base, entry, cmd, report } = setup(t);
  const stub = asElectron(t, base);
  const env = { ...process.env, PATH: nodeDir, Path: nodeDir, ELECTRON_RUN_AS_NODE: '1' };
  const spec = harness(declare({ cmd })).command({ root: base, report, prompt: '只回复 OK', env });
  const expected = resolveExecutable('node', { env, platform: process.platform });
  assert.equal(spec.executable.toLowerCase(), expected.toLowerCase(), '用 PATH 里的系统 Node');
  assert.notEqual(spec.executable.toLowerCase(), stub.toLowerCase(), '不是注入的 Electron 路径');
  assert.equal(path.resolve(spec.args[0]), entry, '入口仍是 npm 包装里的 bin.js');
  const run = spawnSync(spec.executable, spec.args, { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim());
  assert.equal(out.electron, null, '子进程不是 Electron 的 Node');
  assert.equal(out.execPath.toLowerCase(), expected.toLowerCase());
});

test('D176：找不到系统 Node 时说明要装 Node.js，不用 Electron 顶替', { skip: process.platform !== 'win32' ? '只测 Windows 的 npm 包装' : false }, t => {
  const { base, cmd, report } = setup(t);
  asElectron(t, base);
  const empty = path.join(base, 'empty');
  mkdirSync(empty);
  // 常见安装位置也指向空目录：本机真的装了 Node 时，这条用例仍只测"哪里都没有"。
  const env = { ...process.env, PATH: empty, Path: empty, ELECTRON_RUN_AS_NODE: '1', APPDATA: empty, LOCALAPPDATA: empty,
    ProgramFiles: empty, 'ProgramFiles(x86)': empty, NVM_SYMLINK: empty, USERPROFILE: empty, HOME: empty };
  assert.throws(
    () => harness(declare({ cmd })).command({ root: base, report, prompt: '只回复 OK', env }),
    error => /^找不到 Node\.js：DeepSeek Harness 需要系统里装有 Node\.js（用 npm 安装它时就需要）；已找过：/.test(error.message),
  );
});
