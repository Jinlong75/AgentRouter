import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { demo } from './demo/index.mjs';
import { preferenceFixture } from './demo/preferences.mjs';
import { fontHash } from './fonts.mjs';

const fixture = await demo();
try {
  const out = path.resolve('app/dist/shots');
  for (const filename of ['packaged.json', 'packaged.png']) await unlink(path.join(out, filename)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const env = { ...await preferenceFixture(fixture.home, { install: false }), AR_SHOTS: out, AR_PACKAGED_VERIFY: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.resolve('release/win-unpacked/AgentRouter.exe'), [], { env, stdio: 'inherit', shell: false, windowsHide: true });
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, '打包程序验收成功退出');
    const evidence = JSON.parse(await readFile(path.join(out, 'packaged.json'), 'utf8'));
    assert.equal(evidence.fontHash, fontHash);
    console.log(`打包程序实测通过：${evidence.tasks} 个演示任务、首次引导安装、Agent 页重装、实际 MiSans 绘制；软件内 coreRun 使用内置 Node ${evidence.coreNode}（Electron ${evidence.coreElectron}）。`);
  } finally { clearTimeout(timer); }
} finally { await fixture.close(); }

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

// 安装后的 AgentRouter.exe 直接运行核心：PATH 里去掉 Node，证明不依赖系统 Node。
const exe = path.resolve('release/win-unpacked/AgentRouter.exe'), script = path.resolve('release/win-unpacked/resources/app/core/ar.mjs');
const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
const withoutNode = (process.env[pathKey] ?? '').split(path.delimiter).filter(dir => !existsSync(path.join(dir, 'node.exe'))).join(path.delimiter);
const result = spawnSync(exe, [script, 'version', '--json'], { env: { ...process.env, [pathKey]: withoutNode, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000 });
assert.equal(result.status, 0, result.stderr);
const info = JSON.parse(result.stdout.trim());
assert.equal(info.ok, true); assert.ok(Number(info.node.split('.')[0]) >= 24, `内置 Node ${info.node} 低于 24`);
assert.equal(info.version, JSON.parse(await readFile('package.json', 'utf8')).version);
console.log(`AgentRouter.exe 运行 ar version（PATH 中无 Node）：核心 ${info.version}，内置 Node ${info.node}，Electron ${info.electron}`);
