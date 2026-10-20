import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
