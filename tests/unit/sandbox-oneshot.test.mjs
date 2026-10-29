import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSandboxHome, removeOneShotSandbox, sandboxHome } from '../../core/lib/env.mjs';
import { runOnce } from '../../core/lib/runner.mjs';

// 186（D121）：沙箱退回的一次性目录（公共目录建不了时在系统临时目录里新建）在执行者结束后删掉；
// 公共目录下的正常沙箱、别的目录一律不碰。

function dirs(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-sandbox-oneshot-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const blocked = path.join(base, '是个文件');
  fs.writeFileSync(blocked, '占位');
  return { base, blocked, home: path.join(base, '公共目录') };
}

// 执行者环境：沿用当前环境（要能启动 node），用户目录指向 home 下 profile 的沙箱，再让 ensureSandboxHome 建好。
function sandboxEnv(home, profileName = 'mimo') {
  const env = { ...process.env, USERPROFILE: sandboxHome(home, profileName), HOME: sandboxHome(home, profileName) };
  const used = ensureSandboxHome(env, { home, profileName });
  return { env, used };
}

// 起一个把标记文件写进用户目录的执行者：证明目录在执行者运行时存在、可用。
async function run(t, env) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-sandbox-oneshot-work-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const adapter = {
    command: () => ({ executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync(require('node:path').join(process.env.USERPROFILE, 'marker.txt'), 'x')"], stdin: null }),
  };
  return runOnce({
    adapter, label: '测试', profile: {}, profileName: 'mimo', settings: {}, detection: null, workdir: work, childEnv: env,
    paths: { raw: path.join(work, 'raw.log'), report: path.join(work, 'report.md') }, registry: () => {}, id: 'r1', prompt: 'p', envError: null,
    emit: () => {}, errors: [], mapLine: () => [], onSpawn: () => {}, beforeSpawn: null, stopped: () => false,
  });
}

test('沙箱退回的一次性目录：执行者结束后删掉（执行者运行时它是存在的）', async t => {
  const { blocked } = dirs(t);
  const { env, used } = sandboxEnv(blocked);
  t.after(() => fs.rmSync(used, { recursive: true, force: true }));
  assert.equal(path.dirname(used), path.resolve(os.tmpdir()), '建在系统临时目录里');
  const result = await run(t, env);
  assert.equal(result.exit, 0, '执行者写得进一次性目录里的标记文件');
  assert.ok(!fs.existsSync(used), '执行者结束后一次性目录被删掉');
});

test('同一个环境再启动一次执行者（自动重试）：一次性目录补建好，结束后再删', async t => {
  const { blocked } = dirs(t);
  const { env, used } = sandboxEnv(blocked);
  t.after(() => fs.rmSync(used, { recursive: true, force: true }));
  assert.equal((await run(t, env)).exit, 0);
  assert.ok(!fs.existsSync(used));
  assert.equal((await run(t, env)).exit, 0, '第二次启动时目录已补建，执行者照常写标记文件');
  assert.ok(!fs.existsSync(used));
});

test('公共目录下的正常沙箱不删，没登记过的目录也不删', async t => {
  const { base, home } = dirs(t);
  const { env, used } = sandboxEnv(home);
  assert.equal(used, sandboxHome(home, 'mimo'), '公共目录可写时用正常沙箱');
  assert.equal((await run(t, env)).exit, 0);
  assert.ok(fs.existsSync(path.join(used, 'marker.txt')), '正常沙箱原样保留');
  assert.equal(removeOneShotSandbox(env), false);

  const stray = path.join(base, '别的目录');
  fs.mkdirSync(stray);
  assert.equal(removeOneShotSandbox({ USERPROFILE: stray }), false);
  assert.equal(removeOneShotSandbox({}), false);
  assert.ok(fs.existsSync(stray));
});

test('命令构造失败（执行者没能启动）时也删掉一次性目录', async t => {
  const { blocked } = dirs(t);
  const { env, used } = sandboxEnv(blocked);
  t.after(() => fs.rmSync(used, { recursive: true, force: true }));
  const result = await runOnce({
    adapter: { command: () => { throw new Error('缺密钥'); } }, label: '测试', profile: {}, profileName: 'mimo', settings: {}, detection: null, workdir: os.tmpdir(), childEnv: env,
    paths: { raw: path.join(used, 'raw.log') }, registry: () => {}, id: 'r1', prompt: 'p', envError: null,
    emit: () => {}, errors: [], mapLine: () => [], onSpawn: () => {}, beforeSpawn: null, stopped: () => false,
  });
  assert.equal(result.startFailed, true);
  assert.ok(!fs.existsSync(used));
});
