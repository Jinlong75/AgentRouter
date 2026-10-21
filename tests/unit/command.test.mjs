import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandError, limitOutput, planCommand, resolveExecutable, runCommand, splitArgs } from '../../core/lib/command.mjs';

// 所有用例都不依赖真实 PATH：临时目录里现造假的 PATH、假的包装与假的 node.exe。
const tempDir = (t, prefix = 'ar-command-') => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};
const touch = (file, text = '') => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};
const quoteIfSpace = file => /\s/.test(file) ? `"${file}"` : file;
// Windows 文件系统不区分大小写，补出来的扩展名可能不是文件的实际大小写；路径比较按平台规则。
const assertPath = (actual, expected, message) => {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  assert.equal(normalize(actual), normalize(expected), message);
};
const winEnv = extra => ({ PATHEXT: '.COM;.EXE;.BAT;.CMD', ...extra });

test('splitArgs：空白分隔，双引号与单引号内的空白保留、引号去掉，相邻段拼接', () => {
  const cases = [
    ['git status --short', ['git', 'status', '--short']],
    ['  git   status\t--short  ', ['git', 'status', '--short']],
    ['"a b" c', ['a b', 'c']],
    ["'a b' c", ['a b', 'c']],
    ['a "" b', ['a', '', 'b']],
    ['""', ['']],
    ['a"b c"d', ['ab cd']],
    ['echo 你好 世界', ['echo', '你好', '世界']],
    ['a"it\'s"', ["ait's"]],
    ['"a\'b" c', ["a'b", 'c']],
    ['', []],
    ['\t', []],
    ['a\nb', ['a', 'b']],
  ];
  for (const [line, expected] of cases) assert.deepEqual(splitArgs(line), expected, JSON.stringify(line));
});

test('splitArgs：引号没闭合抛 CommandError，消息带原命令', () => {
  for (const line of ['npm test "a b', "echo 'x", '"']) {
    assert.throws(() => splitArgs(line), error => error instanceof CommandError && error.message === `引号没有闭合：${line}`, line);
  }
});

test('resolveExecutable：Windows 上按 PATH 目录顺序查找，并认 env.Path', t => {
  const root = tempDir(t);
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  const a = touch(path.join(first, 'tool.cmd'));
  const b = touch(path.join(second, 'tool.cmd'));
  const env = winEnv({ PATH: `${first};${second}` });
  assertPath(resolveExecutable('tool', { cwd: root, env, platform: 'win32' }), a);
  assertPath(resolveExecutable('tool', { cwd: root, env: { ...winEnv(), Path: `${second};${first}` }, platform: 'win32' }), b, '没有 PATH 时认 env.Path');
});

test('resolveExecutable：Windows 上按 PATHEXT 顺序补扩展名，自带扩展名先试原名', t => {
  const root = tempDir(t);
  const bat = touch(path.join(root, 'tool.bat'));
  const exe = touch(path.join(root, 'tool.exe'));
  const explicit = touch(path.join(root, 'only.cmd'));
  const env = winEnv({ PATH: root });
  assertPath(resolveExecutable('tool', { cwd: root, env: { ...env, PATHEXT: '.EXE;.BAT' }, platform: 'win32' }), exe);
  assertPath(resolveExecutable('tool', { cwd: root, env: { ...env, PATHEXT: '.BAT;.EXE' }, platform: 'win32' }), bat);
  assertPath(resolveExecutable('only.cmd', { cwd: root, env: { ...env, PATHEXT: '.EXE' }, platform: 'win32' }), explicit, '自带扩展名时不必补');
});

test('resolveExecutable：含路径分隔符时相对 cwd 解析，Windows 上无扩展名按 PATHEXT 补', t => {
  const root = tempDir(t);
  const exe = touch(path.join(root, 'bin', 'tool.exe'));
  const env = winEnv({ PATH: '' });
  assertPath(resolveExecutable('bin/tool.exe', { cwd: root, env, platform: 'win32' }), exe);
  assertPath(resolveExecutable('bin\\tool', { cwd: root, env: { ...env, PATHEXT: '.EXE' }, platform: 'win32' }), exe);
});

test('resolveExecutable：找不到命令抛 CommandError', t => {
  const root = tempDir(t);
  const env = winEnv({ PATH: root });
  for (const name of ['nope', 'bin/nope.exe']) {
    assert.throws(() => resolveExecutable(name, { cwd: root, env, platform: 'win32' }), error => error instanceof CommandError && error.message === `找不到命令：${name}`);
  }
});

test('resolveExecutable：非 Windows 用冒号分隔 PATH、不补 PATHEXT', { skip: process.platform === 'win32' ? 'Windows 路径含盘符冒号，无法在这里模拟冒号分隔的 PATH' : false }, t => {
  const root = tempDir(t);
  const empty = path.join(root, 'empty'), bin = path.join(root, 'bin');
  const tool = touch(path.join(bin, 'tool'));
  const env = { PATH: `${empty}:${bin}` };
  assert.equal(resolveExecutable('tool', { cwd: root, env, platform: 'linux' }), tool);
});

test('planCommand：.exe 直接运行，参数原样', t => {
  const root = tempDir(t);
  const exe = touch(path.join(root, 'tool.exe'));
  assert.deepEqual(planCommand([exe, 'a b', '--x'], { cwd: root, env: {}, platform: 'win32' }),
    { executable: exe, args: ['a b', '--x'], verbatim: false });
});

test('planCommand：普通 .cmd 经 cmd.exe 运行，行内空格项加双引号', t => {
  const root = tempDir(t);
  const cmd = touch(path.join(root, 'plain.cmd'), '@echo off\r\necho hi %1\r\n');
  const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const plan = planCommand([cmd, 'a b', 'c'], { cwd: root, env, platform: 'win32', line: '原命令' });
  assert.equal(plan.executable, env.ComSpec);
  assert.deepEqual(plan.args, ['/d', '/s', '/c', `"${quoteIfSpace(cmd)} "a b" c"`]);
  assert.equal(plan.verbatim, true);
});

test('planCommand：解析不了的 .cmd 中任一参数含 cmd 特殊字符就拒绝运行', t => {
  const root = tempDir(t);
  const cmd = touch(path.join(root, 'plain.cmd'), '@echo off\r\n');
  const env = { ComSpec: 'cmd.exe' };
  for (const char of ['"', '%', '^', '&', '|', '<', '>', '!', '\r', '\n']) {
    const line = `plain.cmd a${char}b`;
    assert.throws(() => planCommand([cmd, `a${char}b`], { cwd: root, env, platform: 'win32', line }),
      error => error instanceof CommandError && error.message === `参数含 cmd 特殊字符，拒绝运行：${line}`, JSON.stringify(char));
  }
});

test('planCommand：Node 自带的 npm / npx 包装解析成同目录 node.exe + 对应 cli.js', t => {
  const root = tempDir(t);
  const nodeExe = touch(path.join(root, 'node.exe'));
  const npmCli = touch(path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const npxCli = touch(path.join(root, 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  const npmCmd = touch(path.join(root, 'npm.cmd'),
    '@ECHO off\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n');
  const npxCmd = touch(path.join(root, 'npx.cmd'),
    '@ECHO off\r\nSET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"\r\n"%NODE_EXE%" "%NPX_CLI_JS%" %*\r\n');
  const env = { PATH: '' };
  assert.deepEqual(planCommand([npmCmd, '--version'], { cwd: root, env, platform: 'win32' }),
    { executable: nodeExe, args: [npmCli, '--version'], verbatim: false });
  assert.deepEqual(planCommand([npxCmd, 'foo'], { cwd: root, env, platform: 'win32' }),
    { executable: nodeExe, args: [npxCli, 'foo'], verbatim: false });
});

test('planCommand：npm 全局包包装解析成 node.exe + JS 入口；入口是 .exe 时直接运行', t => {
  const root = tempDir(t);
  const nodeExe = touch(path.join(root, 'node.exe'));
  const js = touch(path.join(root, 'node_modules', 'tool', 'bin', 'tool.js'));
  const jsCmd = touch(path.join(root, 'tool.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\tool\\bin\\tool.js" %*\r\n');
  const exe = touch(path.join(root, 'native.exe'));
  const exeCmd = touch(path.join(root, 'native.cmd'), '@ECHO off\r\n"%dp0%\\native.exe" %*\r\n');
  const env = { PATH: '' };
  assert.deepEqual(planCommand([jsCmd, 'run'], { cwd: root, env, platform: 'win32' }),
    { executable: nodeExe, args: [js, 'run'], verbatim: false });
  assert.deepEqual(planCommand([exeCmd, 'x'], { cwd: root, env, platform: 'win32' }),
    { executable: exe, args: ['x'], verbatim: false });
});

test('planCommand：包装能解析但同目录与 PATH 都没有 node 时报错，退回 cmd.exe 也不发生', t => {
  const root = tempDir(t);
  const npmCmd = touch(path.join(root, 'npm.cmd'),
    '@ECHO off\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\n');
  touch(path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  assert.throws(() => planCommand([npmCmd], { cwd: root, env: { PATH: '' }, platform: 'win32' }),
    error => error instanceof CommandError && error.message === `找不到 node，无法运行 ${npmCmd}`);
});

test('limitOutput：未超出时原样返回', () => {
  for (const text of ['', '第一行\n第二行', Array.from({ length: 200 }, (_, i) => `第 ${i} 行`).join('\n')]) {
    assert.deepEqual(limitOutput(text), { output: text, truncated: false });
  }
});

test('limitOutput：超过 200 行只保留最后 200 行', () => {
  const text = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
  const { output, truncated } = limitOutput(text);
  assert.equal(truncated, true);
  const lines = output.split('\n');
  assert.equal(lines.length, 200);
  assert.equal(lines[0], 'line 50');
  assert.equal(lines.at(-1), 'line 249');
});

test('limitOutput：按字节截断时切点不在行首，丢掉被切开的那一行', () => {
  const tailLine = 'B'.repeat(100);
  const { output, truncated } = limitOutput(`${'A'.repeat(17000)}\n${tailLine}`); // 17101 字节
  assert.equal(truncated, true);
  assert.equal(output, tailLine, '被切开的首行整行丢掉，只留完整的最后一行');
  assert.ok(!output.includes('A'));
});

test('limitOutput：全文没有换行的超长单行按字节保留末尾', () => {
  const text = 'x'.repeat(20000);
  const { output, truncated } = limitOutput(text);
  assert.equal(truncated, true);
  assert.equal(Buffer.byteLength(output), 16 * 1024);
  assert.equal(output, text.slice(-output.length), '没有整行可留，保留末尾字节');
});

test('limitOutput：超过 16 KB 保留末尾且不切断多字节字符', () => {
  const text = '字'.repeat(6000); // 18000 字节
  const { output, truncated } = limitOutput(text);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(output) <= 16 * 1024, '不超过 16 KB');
  assert.ok(Buffer.byteLength(output) > 16 * 1024 - 3, '尽量用满');
  assert.equal(output, text.slice(-output.length), '保留的是末尾');
  assert.equal(Buffer.byteLength(output), output.length * 3, '每个汉字仍是完整的三字节');
  assert.ok(!output.includes('\uFFFD'), '没有替换字符');
});

test('runCommand：拆分失败时返回错误对象，不抛错也不启动进程', async () => {
  const result = await runCommand('echo "未闭合', { cwd: os.tmpdir(), env: process.env });
  assert.equal(result.line, 'echo "未闭合');
  assert.equal(result.pid, null, '没启动进程就没有 pid');
  assert.equal(result.exit, null);
  assert.equal(result.error, '引号没有闭合：echo "未闭合');
  assert.equal(result.output, '');
  assert.equal(result.truncated, false);
  assert.equal(result.timedOut, false);
  assert.equal(typeof result.ms, 'number');
});
