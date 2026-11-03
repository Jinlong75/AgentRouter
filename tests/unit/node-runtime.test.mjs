import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { systemNode, systemNodeSearch } from '../../core/lib/command.mjs';
import { launcherFor } from '../../core/lib/launcher.mjs';
import { makeGeneric } from '../../core/adapters/generic.mjs';
import { builtinConfig, readEffectiveConfig } from '../../core/lib/config.mjs';
import { loadPreset } from '../../core/lib/agents.mjs';

test('旧版改名声明按程序匹配补系统 Node 要求，仅在内存生效并尊重显式 false', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-node-default-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { requiresSystemNode, ...oldDecl } = loadPreset('deepseek-harness').profile.generic;
  const config = { ...builtinConfig(), generics: { 'my-dsh': oldDecl, explicit: { ...oldDecl, requiresSystemNode: false } } };
  const file = path.join(dir, 'config.json'), original = JSON.stringify(config);
  writeFileSync(file, original);
  const result = readEffectiveConfig(dir);
  assert.equal(result.generics['my-dsh'].requiresSystemNode, true);
  assert.equal(result.generics.explicit.requiresSystemNode, false);
  assert.equal(readFileSync(file, 'utf8'), original);
});

// 430 D176：找 Node 的顺序与兜底。平台、存在判断与目录列表都可注入，不依赖测试机真的装了 nvm / volta / Homebrew。
const W = path.win32, P = path.posix;
const electron = W.join('C:', 'Program Files', 'AgentRouter', 'AgentRouter.exe');
const apps = W.join('C:', 'Program Files');
const home = W.join('C:', 'Users', '张 三');

test('不在 Electron 里：直接返回 process.execPath，不扫盘', () => {
  let calls = 0;
  const found = systemNode({ inElectron: false, platform: 'win32', env: { PATH: W.join('C:', 'empty-430-1') }, exists: () => { calls++; return false; } });
  assert.equal(found, process.execPath);
  assert.equal(calls, 0, '不在 Electron 里不调用 exists');
});

test('在 Electron 里：包装同目录的 node.exe 优先，其次 PATH 里的 node', t => {
  const wrapper = W.join(home, 'AppData', 'Roaming', 'npm');
  const pathDir = W.join('C:', 'Program Files', '节点 工具', 'bin');
  const wrapperNode = W.join(wrapper, 'node.exe'), pathNode = W.join(pathDir, 'node.exe');
  assert.equal(systemNode({ inElectron: true, execPath: electron, platform: 'win32', wrapperDir: wrapper, env: { PATH: pathDir },
    exists: file => file === wrapperNode || file === pathNode, readdir: () => [] }), wrapperNode);
  assert.equal(systemNode({ inElectron: true, execPath: electron, platform: 'win32', wrapperDir: wrapper, env: { PATH: `${W.join('C:', 'empty-430-2')};${pathDir}` },
    exists: file => file === pathNode, readdir: () => [] }), pathNode);

  // launcherFor 的 .js 入口走同一套查找：包装同目录的 node 优先，并标出 runtime: 'system'。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-node-430-2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const entry = path.join(dir, 'agent.js');
  writeFileSync(entry, "console.log('ok');\n");
  const nativeNode = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  const injected = { inElectron: true, execPath: path.join(dir, 'AgentRouter.exe'), platform: process.platform, homedir: () => dir, readdir: () => [] };
  assert.deepEqual(
    launcherFor(entry, { missing: '缺', unwrapError: () => '包装', ...injected, env: { PATH: path.join(dir, 'empty-430-2') }, exists: file => file === nativeNode }),
    { executable: nativeNode, args: [entry], runtime: 'system' },
  );
});

test('在 Electron 里：PATH 没有时找常见位置，nvm 版本号按数字取最高', () => {
  const appData = W.join(home, 'AppData', 'Roaming'), nvm = W.join(appData, 'nvm');
  const versions = ['v18.20.0', 'v20.3.1', 'v9.11.2'];
  const files = new Set(versions.map(version => W.join(nvm, version, 'node.exe')));
  assert.equal(systemNode({ inElectron: true, execPath: electron, platform: 'win32', env: { PATH: W.join('C:', 'empty-430-3'), APPDATA: appData },
    exists: file => files.has(file), readdir: dir => dir === nvm ? versions : [], homedir: () => home }), W.join(nvm, 'v20.3.1', 'node.exe'));
  const programNode = W.join(apps, 'nodejs', 'node.exe');
  assert.equal(systemNode({ inElectron: true, execPath: electron, platform: 'win32', env: { PATH: W.join('C:', 'empty-430-3b'), ProgramFiles: apps },
    exists: file => file === programNode, readdir: () => [], homedir: () => home }), programNode);
});

test('在 Electron 里：macOS 的常见位置，Homebrew 在 nvm 前面，nvm 取最高版本', () => {
  const userHome = P.join('/', 'Users', '张 三');
  const nvm = P.join(userHome, '.nvm', 'versions', 'node'), versions = ['v9.11.2', 'v18.20.0', 'v20.1.0'];
  const nvmNode = P.join(nvm, 'v20.1.0', 'bin', 'node');
  const base = { inElectron: true, execPath: P.join('/', 'Applications', 'AgentRouter.app'), platform: 'darwin', homedir: () => userHome, readdir: dir => dir === nvm ? versions : [] };
  assert.equal(systemNode({ ...base, env: { PATH: P.join('/', 'empty-430-4') }, exists: file => file === '/opt/homebrew/bin/node' || file === nvmNode }), '/opt/homebrew/bin/node');
  assert.equal(systemNode({ ...base, env: { PATH: P.join('/', 'empty-430-4b') }, exists: file => file === nvmNode }), nvmNode);
});

test('在 Electron 里：Linux 的 fnm 目录取版本号最高的，用户名带中文和空格', () => {
  const userHome = P.join('/', 'home', '张 三');
  const fnm = P.join(userHome, '.local', 'share', 'fnm', 'node-versions'), versions = ['v18.20.0', 'v20.11.1', 'v9.11.2'];
  const highest = P.join(fnm, 'v20.11.1', 'installation', 'bin', 'node');
  const base = { inElectron: true, execPath: P.join('/', 'opt', 'AgentRouter', 'agentrouter'), platform: 'linux', homedir: () => userHome,
    readdir: dir => dir === fnm ? versions : [] };
  assert.equal(systemNode({ ...base, env: { PATH: P.join('/', 'empty-430-4c') }, exists: file => file === highest }), highest);
  // 最高版本没装好时用存在的那一个，不猜路径。
  const fallback = P.join(fnm, 'v18.20.0', 'installation', 'bin', 'node');
  assert.equal(systemNode({ ...base, env: { PATH: P.join('/', 'empty-430-4d') }, exists: file => file === fallback }), fallback);
});

test('找不到 Node：systemNode 返回 null；launcherFor 对 .js 入口退回自带运行时并标 bundled', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-node-430-5-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const entry = path.join(dir, 'agent.js'), empty = path.join(dir, 'empty');
  mkdirSync(empty);
  writeFileSync(entry, "console.log('ok');\n");
  const injected = { inElectron: true, execPath: path.join(dir, 'AgentRouter.exe'), platform: process.platform, env: { PATH: empty }, exists: () => false, readdir: () => [], homedir: () => dir };
  const result = systemNodeSearch(injected);
  assert.equal(result.path, null);
  assert.ok(result.searched.length > 0, '记下找过的位置');
  assert.deepEqual(launcherFor(entry, { missing: '缺', unwrapError: () => '包装', ...injected }),
    { executable: path.join(dir, 'AgentRouter.exe'), args: [entry], runtime: 'bundled' });
});

test('按声明字段识别：自带运行时下报错并列出找过的位置，改 label 仍识别', t => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-node-430-6-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const empty = path.join(base, 'empty'), missingHome = path.join(base, 'home');
  mkdirSync(empty); mkdirSync(missingHome);
  const entry = path.join(base, 'dsh.js');
  writeFileSync(entry, 'void 0;\n');
  const saved = { had: Object.prototype.hasOwnProperty.call(process.versions, 'electron'), electron: process.versions.electron };
  process.versions.electron = '43.7.5';
  t.after(() => {
    if (saved.had) process.versions.electron = saved.electron;
    else delete process.versions.electron;
  });
  const env = { ...process.env, PATH: empty, Path: empty };
  // 预填缓存：同一 PATH 下常见位置一律当作不存在，测试机真的装了 Node（nvm / Homebrew 等）也不影响结果。
  const warmed = systemNodeSearch({ inElectron: true, platform: process.platform, env, exists: () => false, readdir: () => [], homedir: () => missingHome });
  assert.equal(warmed.path, null);
  const decl = { label: 'DeepSeek Harness', executable: entry, detect: ['--version'], args: ['headless'], stdin: '{prompt}', requiresSystemNode: true };
  const run = (d, name) => makeGeneric(d, { name }).command({ root: base, report: path.join(base, 'report.md'), prompt: '只回复 OK', env });
  assert.throws(() => run(decl, 'deepseek-harness'),
    error => /^找不到 Node\.js：DeepSeek Harness 需要系统里装有 Node\.js（用 npm 安装它时就需要）；已找过：/.test(error.message));
  // 显示名称和声明名可以改，字段仍生效。
  assert.throws(() => run({ ...decl, label: '我的 DSH' }, 'my-agent'),
    error => /^找不到 Node\.js：我的 DSH 需要系统里装有 Node\.js（用 npm 安装它时就需要）；已找过：/.test(error.message));
  // 未声明该字段时退回软件自带的运行时。
  const { requiresSystemNode, ...withoutNodeRequirement } = decl;
  const other = run({ ...withoutNodeRequirement, label: '我的 DSH' }, 'my-agent');
  assert.equal(other.executable, process.execPath);
  assert.deepEqual(other.args, [entry, 'headless']);
});

test('找 Node 的结果按 PATH 缓存：同一 PATH 第二次不再扫盘', () => {
  const pathDir = W.join('C:', 'Users', '李 四', 'Tools', 'node'), node = W.join(pathDir, 'node.exe');
  const env = { PATH: pathDir };
  let calls = 0;
  const exists = file => { calls++; return file === node; };
  const first = systemNode({ inElectron: true, execPath: electron, platform: 'win32', env, exists, readdir: () => [] });
  assert.equal(first, node);
  const afterFirst = calls;
  assert.equal(systemNode({ inElectron: true, execPath: electron, platform: 'win32', env, exists, readdir: () => [] }), node);
  assert.equal(calls, afterFirst, '第二次没有再调用注入的 exists');
});
