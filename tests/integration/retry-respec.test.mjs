import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// 手动重试重新读取任务说明（协议 14.5 末条）的集成测试：隔离的 AGENT_ROUTER_HOME、隔离的 USERPROFILE / HOME、
// 系统临时目录里的仓库、fake 执行者；子进程跑 core/ar.mjs，不碰真实安装、配置、用户目录与进程，也不手动派发。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const commitAll = (root, message) => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
};
const rows = home => {
  try {
    return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};

// 验收命令：src/done.txt 里出现"完成"才通过。
const DONE_CHECK = `node -e "const fs=require('fs');let s='';try{s=fs.readFileSync('src/done.txt','utf8')}catch(e){};if(!s.includes('完成')){console.log('src/done.txt 还没有 完成 标记，门禁不予通过');process.exit(1)}"`;
const SPEC = 'docs/specs/001-重读.md';

const specText = (allowed, verify = [DONE_CHECK]) => [
  '---', 'id: 984', 'title: 重读任务说明', 'type: code', 'allowed_paths:', ...allowed.map(item => `  - ${item}`),
  'verify:', ...verify.map(line => `  - ${line}`), 'max_retries: 0', '---', '', '重读任务说明测试正文。', '',
].join('\n');

function fixture(t) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-respec-084-'));
  const repo = path.join(base, 'repo 084'), home = path.join(base, 'home 084'), user = path.join(base, 'user 084');
  mkdirSync(repo);
  mkdirSync(home);
  mkdirSync(user);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, USERPROFILE: user, HOME: user, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'HOMEDRIVE', 'HOMEPATH']) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '重读任务说明测试']);
  git(repo, ['config', 'user.email', 'respec-084@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  commitAll(repo, '初始提交');
  // 第 1 次尝试：写完成标记，同时多写了允许范围外的 lib/extra.js，一起提交；第 2 次起什么都不写（改动已在 HEAD 里）。
  const profile = {
    adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0,
    attempts: { 1: { writes: [{ path: 'src/done.txt', content: '任务完成\n' }, { path: 'lib/extra.js', content: '越界的文件\n' }], commit: '假执行者：完成标记与越界文件' } },
  };
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile } }));
  write(path.join(repo, SPEC), specText(['src/**']));
  commitAll(repo, '任务说明');
  const f = { base, repo, home, user, env };
  f.ar = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, 120000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  f.dir = name => path.join(repo, '.agent-runs', name);
  f.list = name => {
    const start = rows(home).find(row => row.event === 'start' && row.name === name);
    return rows(home).filter(row => row.id === start.id);
  };
  f.progress = name => readFileSync(path.join(f.dir(name), 'progress.log'), 'utf8');
  f.dispatchJson = name => JSON.parse(readFileSync(path.join(f.dir(name), 'dispatch.json'), 'utf8'));
  f.gateJson = (name, n) => JSON.parse(readFileSync(path.join(f.dir(name), 'attempts', String(n), 'gate.json'), 'utf8'));
  t.after(async () => {
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(realpathSync.native(os.tmpdir()), base).startsWith('ar-respec-084-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

const LINE = '手动重试：任务说明已改，按新的允许范围与验收命令';

test('越界失败 → 主导把文件加进任务说明并提交 → ar retry：用新的允许范围通过，进度有那一行，dispatch.json 更新，基线不变；没提交则退出码 2', async t => {
  const f = fixture(t);
  const first = await f.ar(['dispatch', SPEC, '--name', '重读', '--json']);
  assert.equal(first.code, 3, first.stderr + first.stdout);
  assert.deepEqual(f.gateJson('重读', 1).scope.outside, ['lib/extra.js'], '第 1 次因改了允许范围外的文件失败');
  const before = f.dispatchJson('重读');
  assert.deepEqual(before.gate.merged.allowed_paths, ['src/**']);
  const eventsBefore = f.list('重读').map(row => row.event);

  // 任务说明改了但没提交：退出码 2，不写 resume，dispatch.json 不变。
  // 受保护目录里的任务说明要在 allowed_paths 里明确写出，所以把它自己也列进去。
  const wider = specText(['src/**', 'lib/**', 'docs/specs/001-*.md']);
  write(path.join(f.repo, SPEC), wider);
  const rejected = await f.ar(['retry', '重读', '--note', '范围已放宽', '--json']);
  assert.equal(rejected.code, 2, rejected.stderr + rejected.stdout);
  const error = JSON.parse(rejected.stdout);
  assert.equal(error.ok, false);
  assert.match(error.error, /任务说明还没有提交：docs\/specs\/001-重读\.md/);
  assert.deepEqual(f.list('重读').map(row => row.event), eventsBefore, '拒绝时不写任何事件');
  assert.deepEqual(f.dispatchJson('重读'), before, '拒绝时 dispatch.json 不变');
  assert.ok(!f.progress('重读').includes(LINE));

  // 提交之后重试：门禁用新的允许范围，通过。
  commitAll(f.repo, '任务说明：放宽允许范围');
  const retried = await f.ar(['retry', '重读', '--note', '范围已放宽', '--json']);
  assert.equal(retried.code, 0, retried.stderr + retried.stdout);
  const json = JSON.parse(retried.stdout);
  assert.equal(json.ok, true);
  assert.equal(json.n, 2);
  assert.equal(json.gate.ok, true, json.gate?.summary);
  const gate2 = f.gateJson('重读', 2);
  assert.equal(gate2.ok, true);
  assert.deepEqual(gate2.scope.allowed, ['src/**', 'lib/**', 'docs/specs/001-*.md']);
  assert.ok(gate2.scope.changed.includes('lib/extra.js'));
  assert.deepEqual(gate2.scope.outside, []);
  assert.equal(gate2.base, before.gate.base, '基线不变');

  const after = f.dispatchJson('重读');
  assert.deepEqual(after.gate.merged.allowed_paths, ['src/**', 'lib/**', 'docs/specs/001-*.md'], 'dispatch.json 的 gate.merged 同步更新');
  assert.equal(after.gate.base, before.gate.base);
  assert.equal(after.gate.enabled, true);
  assert.deepEqual(after.gate.merged.verify, before.gate.merged.verify);
  assert.equal(after.gate.merged.expect_commit, before.gate.merged.expect_commit);
  const progress = f.progress('重读');
  assert.equal(progress.split(LINE).length - 1, 1, '进度里恰好一行');
  assert.ok(json.lines.some(line => line === LINE), '--json 的 lines 里也有');
  assert.equal(f.list('重读').at(-1).exit, 0);

  // 任务说明没有再改：再重试一次，不再写那一行。
  const again = await f.ar(['retry', '重读', '--note', '再来一轮', '--json']);
  assert.equal(again.code, 0, again.stderr + again.stdout);
  assert.equal(f.progress('重读').split(LINE).length - 1, 1, '没有变化时不再写');
  assert.deepEqual(f.dispatchJson('重读'), after);
});

test('验收命令也跟着新的任务说明走（verify、verify_timeout_min 变了同样算已改）', async t => {
  const f = fixture(t);
  const first = await f.ar(['dispatch', SPEC, '--name', '重读验收', '--json']);
  assert.equal(first.code, 3, first.stderr + first.stdout);
  // 允许范围放宽的同时，把验收命令换成一条永远失败的：重试用新的命令，所以门禁仍然失败。
  write(path.join(f.repo, SPEC), specText(['src/**', 'lib/**', 'docs/specs/001-*.md'], ['node -e "process.exit(7)"']).replace('max_retries: 0', 'verify_timeout_min: 3\nmax_retries: 0'));
  commitAll(f.repo, '任务说明：换验收命令');
  const retried = await f.ar(['retry', '重读验收', '--note', '换了验收命令', '--json']);
  assert.equal(retried.code, 3, retried.stderr + retried.stdout);
  const gate2 = f.gateJson('重读验收', 2);
  assert.equal(gate2.ok, false);
  assert.deepEqual(gate2.commands.map(command => [command.line, command.exit]), [['node -e "process.exit(7)"', 7]]);
  const saved = f.dispatchJson('重读验收').gate.merged;
  assert.deepEqual(saved.verify, ['node -e "process.exit(7)"']);
  assert.equal(saved.verify_timeout_min, 3);
  assert.ok(f.progress('重读验收').includes(LINE));
});
