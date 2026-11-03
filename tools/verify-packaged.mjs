import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { demo } from './demo/index.mjs';
import { preferenceFixture } from './demo/preferences.mjs';
import { fontHash } from './fonts.mjs';

// NSIS 安装目录参数必须放在最后。
export function setupFilename(version) { return `AgentRouter-Setup-${version}-x64.exe`; }
export function nsisInstallArgs(directory) { return ['/S', `/D=${directory}`]; }
export function findUninstaller(names) {
  const matches = names.filter(name => /^uninstall.*\.exe$/i.test(name));
  assert.equal(matches.length, 1, `需要恰好一个卸载程序，找到 ${matches.length} 个`);
  return matches[0];
}

// 连接测试使用独立临时仓库，假执行者提交时仍需隔离的全局身份。
export function prepareUi34Agent(home, env) {
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = 验收测试\n\temail = packaged@example.test\n');
  const file = path.join(home, 'ui34-agent.json');
  writeFileSync(file, JSON.stringify({ v: 1, kind: 'agentrouter-agent', name: 'fake', generic: null, profile: {
    adapter: 'fake', label: '假执行者', events: [], report: 'OK\n## 完成了什么\n完成\n## 改动了哪些文件\nresult.txt\n## 推断清单\n无\n## TODO(lead) 清单\n无\n## 已知问题\n无\n',
    writes: [{ path: 'result.txt', content: '已完成\n' }], commit: '假执行者提交',
  } }));
  return file;
}

async function main() {
let stage = '准备演示数据', fixture, success = false;
const base = mkdtempSync(path.join(os.tmpdir(), 'agentrouter-packaged-'));
const logs = [];
try {
fixture = await demo();
stage = 'win-unpacked 界面检查';
try {
  const out = path.resolve('app/dist/shots');
  for (const filename of ['packaged.json', 'packaged.png']) await unlink(path.join(out, filename)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const env = { ...await preferenceFixture(fixture.home, { install: false }), AR_SHOTS: out, AR_PACKAGED_VERIFY: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.resolve('release/win-unpacked/AgentRouter.exe'), [], { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    logs.push(JSON.stringify({ stage, status: code, stdout, stderr }));
    assert.equal(code, 0, '打包程序验收成功退出');
    const evidence = JSON.parse(await readFile(path.join(out, 'packaged.json'), 'utf8'));
    assert.equal(evidence.fontHash, fontHash);
    console.log(`打包程序实测通过：${evidence.tasks} 个演示任务、首次引导安装、Agent 页重装、实际 MiSans 绘制；软件内 coreRun 使用内置 Node ${evidence.coreNode}（Electron ${evidence.coreElectron}）。`);
  } finally { clearTimeout(timer); }
} finally { /* 全部阶段结束后统一清理。 */ }

stage = '打包代码测试注入点扫描';
// 打包后的软件代码里不能有测试注入点（153）：asar 关闭，软件自己的代码是 resources/app 顶层的 .cjs / .js / .mjs（core、installer、skills 不查：
// 核心的 AR_TEST_* 钩子是协议里写明的，门禁与准备命令的环境里会被去掉）。
//  - 所有软件代码：不能出现 test-load.json（负载注入文件名只应由 tools/shots.mjs 经环境给出）；
//  - 界面（renderer.js、preload.cjs）与设置 / 托管线程（preferences.mjs、managed.mjs）：不能出现 AR_TEST_*，
//    只有 preferences.mjs 允许读核心已有的 AR_TEST_LOAD_FILE（设置页要和核心排队时的忙闲判断一致）。
// main.cjs 里打进了 shots 代码，AR_SHOTS_* 等验收开关本来就在，不查。
{
  const appDir = path.resolve('release/win-unpacked/resources/app');
  const files = readdirSync(appDir).filter(name => /\.(c|m)?js$/.test(name));
  assert.ok(files.includes('main.cjs'), `${appDir} 里找不到 main.cjs，无法检查测试注入点`);
  const problems = [];
  for (const name of files) {
    const text = readFileSync(path.join(appDir, name), 'utf8');
    if (text.includes('test-load.json')) problems.push(`${name}：出现 test-load.json`);
    if (name !== 'main.cjs') {
      const found = [...new Set(text.match(/\bAR_TEST_[A-Z_]+/g) ?? [])].filter(hook => !(name === 'preferences.mjs' && hook === 'AR_TEST_LOAD_FILE'));
      if (found.length) problems.push(`${name}：出现测试钩子 ${found.join('、')}`);
    }
  }
  assert.deepEqual(problems, [], `打包后的软件代码里不应有测试注入点：\n${problems.join('\n')}`);
  console.log(`打包检查：${files.join('、')} 里没有 test-load.json，界面与设置 / 托管线程里没有 AR_TEST_* 钩子（preferences.mjs 只读 AR_TEST_LOAD_FILE）。`);
}

stage = 'win-unpacked 内置 Node 版本检查';
// 安装后的 AgentRouter.exe 直接运行核心：PATH 里去掉 Node，证明不依赖系统 Node。
const exe = path.resolve('release/win-unpacked/AgentRouter.exe'), script = path.resolve('release/win-unpacked/resources/app/core/ar.mjs');
const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
const withoutNode = (process.env[pathKey] ?? '').split(path.delimiter).filter(dir => !existsSync(path.join(dir, 'node.exe'))).join(path.delimiter);
const result = spawnSync(exe, [script, 'version', '--json'], { env: { ...process.env, [pathKey]: withoutNode, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000 });
logs.push(JSON.stringify({ stage, status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }));
assert.equal(result.status, 0, result.stderr);
const info = JSON.parse(result.stdout.trim());
assert.equal(info.ok, true); assert.ok(Number(info.node.split('.')[0]) >= 24, `内置 Node ${info.node} 低于 24`);
assert.equal(info.version, JSON.parse(await readFile('package.json', 'utf8')).version);
console.log(`AgentRouter.exe 运行 ar version（PATH 中无 Node）：核心 ${info.version}，内置 Node ${info.node}，Electron ${info.electron}`);

stage = 'win-unpacked 执行者运行时检查';
// 430 D176：入口是 .js 的执行者在软件里跑在系统 Node 上（不是 Electron 的 Node）；PATH 里没有 Node 时退回自带的运行时，任务仍能完成。
{
  const probeBase = path.join(base, 'node-runtime'), probeRepo = path.join(probeBase, '项目 仓库'), probeHome = path.join(probeBase, '公共 目录');
  mkdirSync(probeRepo, { recursive: true }); mkdirSync(probeHome);
  const probe = path.join(probeBase, 'runtime-probe.js');
  writeFileSync(probe, "process.stdout.write(`${process.versions.electron ? `electron:${process.versions.electron}` : 'none'}\\n`);\n");
  writeFileSync(path.join(probeHome, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'probe', profiles: {
    probe: { adapter: 'generic', label: 'Node 探针', enabled: true, generic: 'probe', auth: 'login' },
  }, generics: { probe: { label: 'Node 探针', executable: probe, detect: ['--version'], args: [], stdin: '{prompt}', output: { format: 'text' }, report: 'stdout' } } }));
  const probeEnv = { ...process.env, AGENT_ROUTER_HOME: probeHome, AR_WORKTREE_ROOT: path.join(probeBase, 'worktrees'), AR_NO_WATCH: '1', ELECTRON_RUN_AS_NODE: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE']) delete probeEnv[key];
  const probeGit = args => spawnSync('git', args, { cwd: probeRepo, env: probeEnv, encoding: 'utf8', shell: false, windowsHide: true });
  probeGit(['init', '-q', '-b', 'main']);
  probeGit(['config', 'user.name', '验收测试']); probeGit(['config', 'user.email', 'packaged@example.test']);
  probeGit(['config', 'core.autocrlf', 'false']); probeGit(['config', 'commit.gpgsign', 'false']);
  const spec = 'docs/specs/950-node-runtime.md';
  mkdirSync(path.join(probeRepo, '.agent-router'), { recursive: true }); mkdirSync(path.join(probeRepo, path.dirname(spec)), { recursive: true });
  writeFileSync(path.join(probeRepo, '.gitignore'), '.agent-runs/\n');
  writeFileSync(path.join(probeRepo, '.agent-router', 'project.json'), JSON.stringify({ v: 1, name: '运行时探针', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: false }));
  writeFileSync(path.join(probeRepo, spec), '---\nid: 950\ntitle: Node 运行时探针\ntype: docs\nexpect_commit: false\n---\n\n只打印运行时。\n');
  probeGit(['add', '.gitignore', '.agent-router/project.json', spec]);
  probeGit(['commit', '-q', '-m', '运行时探针']);
  // 只替换 PATH（Windows 上环境变量名不分大小写，先删掉所有写法）。
  const withPath = value => {
    const env = { ...probeEnv };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env[pathKey] = value;
    return env;
  };
  const dispatchProbe = (name, env) => {
    const r = spawnSync(exe, [script, 'dispatch', spec, '--name', name, '--profile', 'probe', '--json'], { cwd: probeRepo, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 120000 });
    logs.push(JSON.stringify({ stage, name, status: r.status, error: r.error?.message, stdout: r.stdout, stderr: r.stderr }));
    assert.equal(r.status, 0, `${stage}：${r.error?.message ?? r.stderr ?? ''}`);
    return readFileSync(path.join(probeRepo, '.agent-runs', name, 'report.md'), 'utf8').trim();
  };
  const systemReport = dispatchProbe('system-node', withPath(process.env[pathKey] ?? ''));
  assert.equal(systemReport, 'none', `入口是 .js 的执行者应跑在系统 Node 上，实际：${systemReport}`);
  const bundledReport = dispatchProbe('bundled-node', withPath(withoutNode));
  assert.match(bundledReport, /^(none|electron:)/, `PATH 里没有 Node 时任务仍应完成，实际：${bundledReport}`);
  console.log(`执行者运行时检查：PATH 有系统 Node 时执行者跑在系统 Node（${systemReport}），PATH 无 Node 时任务仍完成（${bundledReport}）。`);
}


const run = (program, args, options = {}) => {
  const r = spawnSync(program, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 180000, ...options });
  logs.push(JSON.stringify({ stage, program, args, status: r.status, error: r.error?.message, stdout: r.stdout, stderr: r.stderr }));
  assert.equal(r.status, 0, `${stage}：${r.error?.message ?? r.stderr ?? ''}`);
  return r.stdout.trim();
};
// R3-1（主导）：安装包与正式产品共用注册表标识，静默安装会先卸载本机已安装的 AgentRouter。
// 安装、核心派发合并、卸载阶段只在隔离的 Windows 环境（Windows Sandbox 或虚拟机）里显式设 AR_VERIFY_INSTALL=1 时执行。
if (process.env.AR_VERIFY_INSTALL !== '1') {
  console.log('跳过安装阶段：静默安装会卸载本机已安装的 AgentRouter；只在隔离的 Windows 环境（Windows Sandbox 或虚拟机）里设 AR_VERIFY_INSTALL=1 运行');
  success = true;
  return;
}
stage = '静默安装';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const setup = path.resolve('release', setupFilename(version)), installed = path.join(base, '安装目录');
assert.ok(existsSync(setup), `找不到安装包：${setup}`);
// R3-2（主导）：NSIS 要求 /D= 放最后且不加引号；原样传参，避免路径含空格时 Node 自动加引号。
run(setup, nsisInstallArgs(installed), { windowsVerbatimArguments: true });
const installedExe = path.join(installed, 'AgentRouter.exe');
assert.ok(existsSync(installedExe), '安装后找不到 AgentRouter.exe');
const installedCore = path.join(installed, 'resources', 'app', 'core', 'ar.mjs');
const isolatedHome = path.join(base, '公共目录'), repo = path.join(base, '项目');
mkdirSync(isolatedHome); mkdirSync(repo);
const childEnv = { ...process.env, AGENT_ROUTER_HOME: isolatedHome, AR_WORKTREE_ROOT: path.join(base, 'worktrees'), AR_NO_WATCH: '1', ELECTRON_RUN_AS_NODE: '1' };
for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE']) delete childEnv[key];
const ar = args => JSON.parse(run(installedExe, [installedCore, ...args, '--json'], { cwd: repo, env: childEnv }));
const git = args => run('git', args, { cwd: repo, env: childEnv });
stage = '安装后版本和内置 Node';
const installedInfo = JSON.parse(run(installedExe, [installedCore, 'version', '--json'], { env: { ...childEnv, [pathKey]: withoutNode } }));
assert.equal(installedInfo.ok, true); assert.equal(installedInfo.version, version);
assert.ok(Number(installedInfo.node.split('.')[0]) >= 24); assert.ok(installedInfo.electron);
stage = '准备隔离项目和 fake 执行者';
writeFileSync(path.join(isolatedHome, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: {
  fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '## 完成了什么\n完成\n## 改动了哪些文件\nresult.txt\n## TODO(lead) 清单\n无\n',
    writes: [{ path: 'result.txt', content: '已完成\n' }], commit: '假执行者提交' },
} }));
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', '验收测试']); git(['config', 'user.email', 'packaged@example.test']); git(['config', 'core.autocrlf', 'false']); // R4-1：不继承系统的换行转换，合并结果按 LF 断言。
git(['config', 'commit.gpgsign', 'false']);
const init = ar(['init']);
assert.equal(init.ok, true);
const spec = 'docs/specs/900-packaged.md';
mkdirSync(path.dirname(path.join(repo, spec)), { recursive: true });
writeFileSync(path.join(repo, spec), '---\nid: 900\ntitle: 打包验收\ntype: docs\nexpect_commit: true\nallowed_paths:\n  - result.txt\nverify:\n  - git --version\n---\n\n验证安装后的核心。\n');
git(['add', '--', ...init.changes.map(change => change.path), spec]);
git(['commit', '-m', 'prepare packaged smoke test']);
stage = '安装后核心派发与待验收';
const agents = ar(['agents', 'list']);
assert.equal(agents.ok, true);
assert.ok(agents.agents.some(agent => agent.name === 'fake' && agent.adapter === 'fake' && agent.enabled && agent.default));
const dispatch = ar(['dispatch', spec, '--name', 'packaged-smoke', '--profile', 'fake']);
assert.equal(dispatch.ok, true);
const status = ar(['status', 'packaged-smoke']);
assert.equal(status.state, 'awaiting');
const registry = path.join(isolatedHome, 'runs.jsonl');
assert.ok(existsSync(registry)); assert.ok(readFileSync(registry, 'utf8').includes(status.id));
stage = '验收合并';
const accepted = ar(['accept', 'packaged-smoke']);
assert.equal(accepted.ok, true); assert.ok(accepted.merge);
assert.equal(git(['rev-parse', 'HEAD']), accepted.merge);
assert.equal(git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3);
assert.equal(readFileSync(path.join(repo, 'result.txt'), 'utf8'), '已完成\n');
stage = '准备 UI34 隔离数据';
const uiHome = path.join(base, 'ui34-home'), uiRepo = path.join(uiHome, 'ui34-project');
mkdirSync(uiHome); mkdirSync(uiRepo);
const uiEnv = { ...await preferenceFixture(uiHome, { install: false }), AR_SHOTS: path.resolve('app/dist/shots'), AR_PACKAGED_VERIFY: 'ui34' };
prepareUi34Agent(uiHome, uiEnv);
delete uiEnv.ELECTRON_RUN_AS_NODE;
const uiCoreEnv = { ...uiEnv, ELECTRON_RUN_AS_NODE: '1', AR_NO_WATCH: '1' };
const uiGit = args => run('git', args, { cwd: uiRepo, env: uiCoreEnv });
uiGit(['init', '-q', '-b', 'main']);
uiGit(['config', 'user.name', '验收测试']); uiGit(['config', 'user.email', 'packaged@example.test']);
uiGit(['config', 'core.autocrlf', 'false']); uiGit(['config', 'commit.gpgsign', 'false']);
const uiInit = JSON.parse(run(installedExe, [installedCore, 'init', '--json'], { cwd: uiRepo, env: uiCoreEnv }));
assert.equal(uiInit.ok, true);
const uiSpec = 'docs/specs/901-ui34.md';
mkdirSync(path.dirname(path.join(uiRepo, uiSpec)), { recursive: true });
writeFileSync(path.join(uiRepo, uiSpec), '---\nid: 901\ntitle: 界面全流程\ntype: docs\nexpect_commit: true\nallowed_paths:\n  - result.txt\nverify:\n  - git --version\n---\n\n验证界面全流程。\n');
uiGit(['add', '--', ...uiInit.changes.map(change => change.path), uiSpec]);
uiGit(['commit', '-m', 'prepare ui34']);
stage = '安装后 UI34 全流程';
for (const name of ['ui34-tasks.png', 'ui34-accept.png', 'ui34-stats.png', 'ui34.json']) await unlink(path.join(uiEnv.AR_SHOTS, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
const uiChild = spawn(installedExe, [], { env: uiEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
let uiStdout = '', uiStderr = '';
uiChild.stdout.on('data', chunk => { uiStdout += chunk; }); uiChild.stderr.on('data', chunk => { uiStderr += chunk; });
const uiTimer = setTimeout(() => uiChild.kill(), 300000);
try {
  const code = await new Promise((resolve, reject) => { uiChild.once('error', reject); uiChild.once('close', resolve); });
  logs.push(JSON.stringify({ stage, status: code, stdout: uiStdout, stderr: uiStderr }));
  assert.equal(code, 0, 'UI34 验收成功退出');
  for (const name of ['ui34-tasks.png', 'ui34-accept.png', 'ui34-stats.png']) assert.ok((await readFile(path.join(uiEnv.AR_SHOTS, name))).length > 0, `缺少截图 ${name}`);
  const evidence = JSON.parse(await readFile(path.join(uiEnv.AR_SHOTS, 'ui34.json'), 'utf8'));
  assert.equal(evidence.tasks, 1); assert.equal(evidence.accepted, true);
  assert.equal(uiGit(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3);
  assert.equal(readFileSync(path.join(uiRepo, 'result.txt'), 'utf8'), '已完成\n');
} finally { clearTimeout(uiTimer); }
stage = '静默卸载与数据保留';
const uninstaller = findUninstaller(readdirSync(installed));
run(path.join(installed, uninstaller), ['/S']);
assert.ok(!existsSync(installed) || readdirSync(installed).length === 0, '安装目录没有清空');
assert.ok(existsSync(isolatedHome) && existsSync(registry));
assert.ok(readFileSync(registry, 'utf8').includes(status.id));
assert.ok(existsSync(path.join(repo, '.agent-runs', 'packaged-smoke', 'report.md')));
assert.equal(git(['rev-parse', 'HEAD']), accepted.merge);
console.log(`安装验收通过：版本 ${installedInfo.version}，Node ${installedInfo.node}，Electron ${installedInfo.electron}，记录 ${status.name}，合并 ${accepted.merge}，卸载程序 ${uninstaller}。`);
success = true;
} catch (error) {
  console.error(`打包验收失败：${stage}：${error.stack ?? error}`);
  try {
    const failure = path.resolve('app/dist/shots/packaged-failures', `${Date.now()}-${process.pid}`);
    mkdirSync(failure, { recursive: true });
    const list = (dir, prefix = '') => {
      if (!existsSync(dir)) return [`${prefix}（不存在）`];
      return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const name = path.join(prefix, entry.name);
        return entry.isDirectory() ? [name + '/', ...list(path.join(dir, entry.name), name)] : [name];
      });
    };
    writeFileSync(path.join(failure, 'failure.log'), [`阶段：${stage}`, `临时目录：${base}`, `演示目录：${fixture?.home ?? '未创建'}`, String(error.stack ?? error), ...logs].join('\n'));
    writeFileSync(path.join(failure, 'directories.txt'), [`临时目录：${base}`, ...list(base), `演示目录：${fixture?.home ?? '未创建'}`, ...(fixture ? list(fixture.home) : [])].join('\n'));
    console.error(`失败现场：${failure}；临时目录保留：${base}`);
  } catch (saveError) { console.error(`保存失败现场失败：${saveError}`); }
  process.exitCode = 1;
} finally {
  if (fixture) {
    if (success) await fixture.close();
    else for (const child of fixture.children) if (child.connected) child.send('exit');
  }
  if (success) rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
