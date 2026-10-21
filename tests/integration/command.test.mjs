import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCommand, runCommand } from '../../core/lib/command.mjs';

const windowsOnly = process.platform === 'win32' ? false : '需要 Windows 的 cmd.exe / .cmd 或 npm.cmd 包装';
const fixture = (t, prefix = 'ar-command-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};
// 按 pid 核对进程是否还在；EPERM 说明进程还在，只是不能发信号。
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};

test('真跑 npm --version：计划不经 cmd.exe，退出 0 且输出版本号', { skip: windowsOnly, timeout: 120000 }, async t => {
  const dir = fixture(t);
  const plan = planCommand(['npm', '--version'], { cwd: dir, env: process.env });
  assert.equal(plan.verbatim, false);
  assert.ok(!/cmd(\.exe)?$/i.test(plan.executable), `不应经 cmd.exe：${plan.executable}`);
  assert.match(plan.executable, /node(\.exe)?$/i);
  assert.match(plan.args[0], /npm-cli\.js$/i);

  const result = await runCommand('npm --version', { cwd: dir, env: process.env, timeoutMs: 120000 });
  assert.equal(result.exit, 0, result.error ?? result.output);
  assert.equal(result.timedOut, false);
  assert.match(result.output.trim(), /^\d+\.\d+\.\d+/);
});

test('真跑 node -e "process.exit(3)"：退出码原样返回', { timeout: 60000 }, async t => {
  const dir = fixture(t);
  const result = await runCommand('node -e "process.exit(3)"', { cwd: dir, env: process.env, timeoutMs: 60000 });
  assert.equal(result.exit, 3, result.error ?? result.output);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
  assert.deepEqual(result.argv, ['node', '-e', 'process.exit(3)']);
});

test('含空格与中文目录里的普通 .cmd：按路径调用成功；参数含 a&b 被拒绝', { skip: windowsOnly, timeout: 60000 }, async t => {
  const dir = fixture(t, 'ar 命令 测试 ');
  const cmd = path.join(dir, 'echo 你好.cmd');
  fs.writeFileSync(cmd, '@echo off\r\necho hi %1\r\n');
  const ok = await runCommand(`"${cmd}" abc`, { cwd: dir, env: process.env, timeoutMs: 60000 });
  assert.equal(ok.exit, 0, ok.error ?? ok.output);
  assert.ok(ok.output.includes('hi abc'), ok.output);

  const bad = await runCommand(`"${cmd}" a&b`, { cwd: dir, env: process.env, timeoutMs: 60000 });
  assert.equal(bad.exit, null);
  assert.match(bad.error, /参数含 cmd 特殊字符/);
  assert.equal(bad.output, '');
  assert.equal(bad.truncated, false);
});

test('超时：结束整棵进程树，15 秒内结算，子进程与孙进程都已不存在', { timeout: 60000 }, async t => {
  const dir = fixture(t);
  // 命令自己再派生一个孙进程，验证结束的是整棵树。
  // 启动慢的机器上 1.5 秒内可能还没写出 pid 文件，所以按 result.pid 判断子进程，孙进程只在写出 pid 文件时核对。
  const script = "const { spawn } = require('child_process'); const fs = require('fs');"
    + " const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });"
    + " fs.writeFileSync('grandchild.pid', String(grandchild.pid));"
    + " setInterval(() => {}, 1000)";
  const result = await runCommand(`node -e "${script}"`, { cwd: dir, env: process.env, timeoutMs: 1500 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exit, null);
  assert.match(result.error, /超过 1\.5 秒没有结束，已结束进程树/);
  assert.ok(result.ms < 15000, `结算用时 ${result.ms} ms`);
  assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0, `result.pid：${result.pid}`);
  assert.equal(alive(result.pid), false, `子进程 ${result.pid} 仍在运行`);
  const pidFile = path.join(dir, 'grandchild.pid');
  if (fs.existsSync(pidFile)) {
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(grandchild) && grandchild > 0, `孙进程 pid：${grandchild}`);
    assert.equal(alive(grandchild), false, `孙进程 ${grandchild} 仍在运行`);
  }
});

test('输出超过 200 行：truncated 为 true，保留最后 200 行', { timeout: 60000 }, async t => {
  const dir = fixture(t);
  const result = await runCommand('node -e "for (let i = 0; i < 1000; i++) console.log(\'line \' + i)"',
    { cwd: dir, env: process.env, timeoutMs: 60000 });
  assert.equal(result.exit, 0, result.error ?? result.output);
  assert.equal(result.truncated, true);
  const lines = result.output.split('\n');
  assert.equal(lines.length, 200);
  assert.equal(lines[0], 'line 801');
  assert.equal(lines.at(-2), 'line 999');
  assert.equal(lines.at(-1), '', '输出以换行结尾，末尾是空串');
  assert.ok(!result.output.includes('line 0\n'), '最前面的行已丢弃');
  assert.ok(Buffer.byteLength(result.output) <= 16 * 1024);
});

test('找不到命令：不启动进程，error 说明原因', { timeout: 60000 }, async t => {
  const dir = fixture(t);
  const result = await runCommand('ar-command-does-not-exist --version', { cwd: dir, env: process.env, timeoutMs: 60000 });
  assert.equal(result.exit, null);
  assert.match(result.error, /^找不到命令：/);
  assert.equal(result.output, '');
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.argv, ['ar-command-does-not-exist', '--version']);
});
