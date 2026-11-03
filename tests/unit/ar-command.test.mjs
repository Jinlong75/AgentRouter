import test from 'node:test';
import assert from 'node:assert/strict';
import { AR_MARKER, whichCommand, isOurs, coreCommand } from '../../core/lib/ar-command.mjs';

// 用内存里的文件代替真实 PATH，测试不依赖测试机的真实目录。
function fakeFs(entries) {
  const files = new Map(entries.map(([file, content]) => [file.toLowerCase(), content]));
  return {
    exists: async file => files.has(file.toLowerCase()),
    readFile: async file => {
      const content = files.get(file.toLowerCase());
      if (content === undefined) throw new Error(`读不到：${file}`);
      return content;
    },
  };
}

test('Windows：msys64 的 ar.exe 在前时改用 agr', async () => {
  const msys = 'C:\\msys64\\ucrt64\\bin', bin = 'C:\\Users\\<用户名>\\AppData\\Local\\AgentRouter\\bin';
  const present = fakeFs([
    [`${msys}\\ar.exe`, 'MZ 不是我们的 ar'],
    [`${bin}\\ar.cmd`, `${AR_MARKER}\r\n@echo off\r\n`],
    [`${bin}\\agr.cmd`, `${AR_MARKER}\r\n@echo off\r\n`],
  ]);
  const result = await coreCommand({ env: { PATH: `${msys};${bin}` }, platform: 'win32', coreDir: 'C:\\Users\\<用户名>\\AgentRouter\\core', ...present });
  assert.deepEqual(result, { command: 'agr', shadowedBy: 'C:\\msys64\\ucrt64\\bin\\ar.exe' });
});

test('Windows：只有我们的 ar.cmd 时用 ar', async () => {
  const bin = 'C:\\Users\\<用户名>\\AppData\\Local\\AgentRouter\\bin';
  const present = fakeFs([[`${bin}\\ar.cmd`, `${AR_MARKER}\r\n@echo off\r\n`]]);
  const result = await coreCommand({ env: { PATH: bin }, platform: 'win32', coreDir: 'C:\\Users\\<用户名>\\AgentRouter\\core', ...present });
  assert.deepEqual(result, { command: 'ar' });
});

test('macOS：/usr/bin/ar 在前且没有 agr 时用 node，并说明被谁挡住', async () => {
  const coreDir = '/Users/<用户名>/AgentRouter/core', linkDir = '/Users/<用户名>/.local/bin', link = `${linkDir}/ar`;
  const present = fakeFs([
    ['/usr/bin/ar', 'Apple 自带的 ar'],
    [`${coreDir}/ar.mjs`, '// AgentRouter 核心入口'],
    [link, `#!/bin/sh\nnode "${coreDir}/ar.mjs" "$@"\n`],
  ]);
  const realpath = async file => (file === link ? `${coreDir}/ar.mjs` : file);
  const result = await coreCommand({ env: { PATH: `/usr/bin:${linkDir}:/bin` }, platform: 'darwin', coreDir, ...present, realpath });
  assert.deepEqual(result, { command: `node "${coreDir}/ar.mjs"`, shadowedBy: '/usr/bin/ar' });
});

test('什么都没有时用 node，没有遮挡', async () => {
  const coreDir = '/opt/agent-router/core';
  const result = await coreCommand({ env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux', coreDir, ...fakeFs([]) });
  assert.deepEqual(result, { command: `node "${coreDir}/ar.mjs"`, shadowedBy: null });
});

test('isOurs：读不了文件时是假', async () => {
  const readFile = async () => { throw new Error('EACCES'); };
  assert.equal(await isOurs('/home/<用户名>/.local/bin/ar', { readFile, realpath: async file => file }), false);
});

test('isOurs：符号链接指向 core/ar.mjs，或文本里同时含两个标记', async () => {
  const readFile = async () => '// AgentRouter 核心入口';
  assert.equal(await isOurs('/home/<用户名>/.local/bin/ar', { readFile, realpath: async () => '/opt/agent-router/core/ar.mjs' }), true);
  assert.equal(await isOurs('/home/<用户名>/.local/bin/ar', { readFile: async () => `#!/bin/sh\nnode "/opt/agent-router/core/ar.mjs" # AgentRouter\n`, realpath: async file => file }), true);
  assert.equal(await isOurs('/home/<用户名>/.local/bin/ar', { readFile, realpath: async file => file }), false);
  assert.equal(await isOurs('C:\\bin\\ar.cmd', { readFile: async () => `${AR_MARKER}\r\n@echo off\r\n`, realpath: async file => file }), true);
});

test('PATH 有空项和带引号的目录时不报错', async () => {
  const dir = 'C:\\Program Files\\ar kit';
  const present = fakeFs([[`${dir}\\ar.exe`, 'MZ']]);
  const result = await coreCommand({ env: { PATH: `;"${dir}";;C:\\Windows` }, platform: 'win32', coreDir: 'C:\\AgentRouter\\core', ...present });
  assert.deepEqual(result, { command: 'node "C:\\AgentRouter\\core\\ar.mjs"', shadowedBy: `${dir}\\ar.exe` });
});

test('核心目录带中文和空格时 node 的引号正确', async () => {
  const win = await coreCommand({ env: { PATH: '' }, platform: 'win32', coreDir: 'C:\\程序 目录\\AgentRouter\\core', ...fakeFs([]) });
  assert.equal(win.command, 'node "C:\\程序 目录\\AgentRouter\\core\\ar.mjs"');
  const posix = await coreCommand({ env: { PATH: '' }, platform: 'linux', coreDir: '/opt/程序 目录/AgentRouter/core', ...fakeFs([]) });
  assert.equal(posix.command, 'node "/opt/程序 目录/AgentRouter/core/ar.mjs"');
});

test('whichCommand 按 PATHEXT 找文件且返回小写扩展名', async () => {
  const dir = 'C:\\工具';
  const present = fakeFs([[`${dir}\\ar.cmd`, 'x']]);
  assert.equal(await whichCommand('ar', { env: { PATH: `;${dir};`, PATHEXT: 'COM;EXE;CMD' }, platform: 'win32', exists: present.exists }), `${dir}\\ar.cmd`);
  assert.equal(await whichCommand('nope', { env: { PATH: dir }, platform: 'win32', exists: present.exists }), null);
});
