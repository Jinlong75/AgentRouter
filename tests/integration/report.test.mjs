import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// 089：ar report 的集成测试。真实 git 临时仓库、隔离的 AGENT_ROUTER_HOME / USERPROFILE / HOME / CLAUDE_CONFIG_DIR、fake 执行者，
// 通过子进程跑 core/ar.mjs；不碰真实安装、配置与真实进程，也不手动派发。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const commitAll = (root, message) => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
};

function fixture(t) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-report-089-'));
  const repo = path.join(base, 'repo 089'), home = path.join(base, 'home 089'), user = path.join(base, 'user 089');
  for (const dir of [repo, home, user]) mkdirSync(dir);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', USERPROFILE: user, HOME: user, CLAUDE_CONFIG_DIR: path.join(user, '.claude') };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '链路报告测试']);
  git(repo, ['config', 'user.email', 'report-089@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  commitAll(repo, '初始提交');
  const f = { base, repo, home, env };
  f.setProfile = profile => {
    write(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
      profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...profile } },
    }));
  };
  f.spec = (rel, allowed) => {
    write(path.join(repo, rel), ['---', 'id: 089', 'title: 链路报告测试', 'type: code', 'allowed_paths:', ...allowed.map(item => `  - ${item}`), '---', '', '链路报告测试正文。', ''].join('\n'));
    commitAll(repo, `任务说明 ${path.basename(rel)}`);
    return rel;
  };
  f.ar = (args, { timeout = 120000 } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  f.marks = name => JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'marks.json'), 'utf8'));
  t.after(async () => {
    // 只结束命令行里带着本临时目录的进程，绝不按进程名终止。
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}
const find = (role, key) => role.items.find(item => item.key === key);

test('门禁第 1 次越界失败、第 2 次通过：执行者 75 分；归因到任务说明后执行者 90、主导 85；文字输出两节；对通过的尝试归因退出码 2', async t => {
  const f = fixture(t);
  f.setProfile({
    // 第 1 次改了范围外的 README.md；第 2 次把它改回去，只留范围内的改动。
    writes: [{ path: 'README.md', content: '# 越界的改动\n' }], commit: '假执行者：改了范围外的文件',
    attempts: { 2: { writes: [{ path: 'README.md', content: '# 说明\n' }, { path: 'src/b.js', content: '范围内\n' }], commit: '假执行者：改回去并写范围内的文件' } },
  });
  const spec = f.spec('docs/specs/001-链路报告.md', ['src/**']);
  const dispatched = await f.ar(['dispatch', spec, '--name', '链路', '--json']);
  assert.equal(dispatched.code, 0, dispatched.stderr + dispatched.stdout);

  const first = await f.ar(['report', '链路', '--json']);
  assert.equal(first.code, 0, first.stderr + first.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.name, '链路');
  assert.equal(report.state, 'done');
  assert.equal(report.executor.score, 75);
  assert.equal(report.executor.cap, null);
  assert.deepEqual([find(report.executor, 'attemptGate').count, find(report.executor, 'attemptGate').points], [1, -15]);
  assert.deepEqual([find(report.executor, 'outsideFile').count, find(report.executor, 'outsideFile').points, find(report.executor, 'outsideFile').detail], [1, -10, 'README.md']);
  assert.equal(report.lead.score, 100);
  assert.deepEqual(report.attempts.map(a => [a.n, a.reason, a.profile, a.exit, a.gate, a.blame]), [[1, 'first', 'fake', 0, false, 'worker'], [2, 'gate', 'fake', 0, true, null]]);
  assert.match(report.attempts[0].summary, /改动超出范围：README\.md/);
  assert.equal(report.lead.perf.usageState, 'off');
  assert.equal(report.executor.perf.cost, null, '没有价格');
  assert.deepEqual(report.executor.perf.profiles, ['fake']);

  // 归因到任务说明：越界文件仍算执行者的，多一次尝试的扣分移到主导。
  const blamed = await f.ar(['report', '链路', '--blame', '1=spec', '--json']);
  assert.equal(blamed.code, 0, blamed.stderr + blamed.stdout);
  const after = JSON.parse(blamed.stdout);
  assert.equal(after.executor.score, 90);
  assert.equal(after.lead.score, 85);
  assert.deepEqual([find(after.lead, 'specBlame').count, find(after.lead, 'specBlame').points], [1, -15]);
  assert.equal(after.attempts[0].blame, 'spec');
  assert.deepEqual(f.marks('链路'), { v: 1, blame: { 1: 'spec' } });

  // 之后不带 --blame 读到的也是新归因；改回 worker 恢复。
  assert.equal(JSON.parse((await f.ar(['report', '链路', '--json'])).stdout).executor.score, 90);
  const restored = JSON.parse((await f.ar(['report', '链路', '--blame', '1=worker', '--json'])).stdout);
  assert.equal(restored.executor.score, 75);
  assert.deepEqual(f.marks('链路'), { v: 1, blame: {} }, 'worker 是默认，写 worker 删掉这个键');
  await f.ar(['report', '链路', '--blame', '1=spec']);

  // 对门禁通过的尝试归因 → 退出码 2，标记不变。
  const refused = await f.ar(['report', '链路', '--blame', '2=spec']);
  assert.equal(refused.code, 2, refused.stderr + refused.stdout);
  assert.match(refused.stderr, /第 2 次尝试的门禁没有失败/);
  const refusedJson = await f.ar(['report', '链路', '--blame', '2=spec', '--json']);
  assert.equal(refusedJson.code, 2);
  assert.equal(JSON.parse(refusedJson.stdout).ok, false);
  assert.deepEqual(f.marks('链路'), { v: 1, blame: { 1: 'spec' } });
  // 用法错误同样退出码 2。
  for (const bad of ['1', '0=spec', '1=lead', 'x=spec']) assert.equal((await f.ar(['report', '链路', '--blame', bad])).code, 2, bad);
  assert.equal((await f.ar(['report', '没有这个任务'])).code, 2);

  // 归因到环境：执行者不扣多一次尝试（越界文件仍扣），主导不扣；marks.json 写 environment；改回 worker 删掉这一键。
  const env = await f.ar(['report', '链路', '--blame', '1=environment', '--json']);
  assert.equal(env.code, 0, env.stderr + env.stdout);
  const envReport = JSON.parse(env.stdout);
  assert.equal(envReport.executor.score, 90);
  assert.equal(envReport.lead.score, 100);
  assert.deepEqual(find(envReport.executor, 'envBlame'), { key: 'envBlame', count: 1, points: 0, detail: null });
  assert.deepEqual(find(envReport.lead, 'envBlame'), { key: 'envBlame', count: 1, points: 0, detail: null });
  assert.equal(find(envReport.lead, 'specBlame').count, 0);
  assert.equal(envReport.attempts[0].blame, 'environment');
  assert.deepEqual(f.marks('链路'), { v: 1, blame: { 1: 'environment' } });
  t.diagnostic(`--json 环境归因样例：${JSON.stringify({ envBlame: find(envReport.lead, 'envBlame'), blame: envReport.attempts.map(a => a.blame) })}`);
  const envText = await f.ar(['report', '链路']);
  assert.ok(envText.stdout.split(/\r?\n/).filter(line => line === '  环境原因：1 次（0）').length === 2, envText.stdout);
  const envBack = JSON.parse((await f.ar(['report', '链路', '--blame', '1=worker', '--json'])).stdout);
  assert.equal(envBack.executor.score, 75);
  assert.equal(find(envBack.lead, 'envBlame').count, 0);
  assert.deepEqual(f.marks('链路'), { v: 1, blame: {} });
  // 非法值：退出码 2，中文原因列出三种取值，标记不变。
  const illegal = await f.ar(['report', '链路', '--blame', '1=lead']);
  assert.equal(illegal.code, 2);
  assert.match(illegal.stderr, /spec\|worker\|environment/);
  assert.match(illegal.stderr, /spec、worker 或 environment/);
  assert.deepEqual(f.marks('链路'), { v: 1, blame: {} });
  await f.ar(['report', '链路', '--blame', '1=spec']);

  // 不加 --json：两节文字。
  const text = await f.ar(['report', '链路']);
  assert.equal(text.code, 0, text.stderr + text.stdout);
  t.diagnostic(`文字输出样例：\n${text.stdout}`);
  t.diagnostic(`--json 样例：${blamed.stdout}`);
  const lines = text.stdout.split(/\r?\n/);
  assert.ok(lines.includes('执行者 90/100'), text.stdout);
  assert.ok(lines.includes('主导 85/100'), text.stdout);
  assert.ok(lines.includes('  越界文件：1 个：README.md（−10）'), text.stdout);
  assert.ok(lines.includes('  门禁失败归因到任务说明：1 次（−15）'), text.stdout);
  assert.equal(lines.filter(line => line.startsWith('  性能：')).length, 2, '每节一行性能');
});

test('ar config 显示链路报告的三项设置；任务还在进行 / 不是用任务说明派发的拒绝原文', async t => {
  const f = fixture(t);
  f.setProfile({ events: [{ kind: 'say', text: '直接写任务文字' }] });
  const config = await f.ar(['config']);
  assert.equal(config.code, 0, config.stderr);
  assert.match(config.stdout, /^reportWeights\s+默认\s+内置默认$/m);
  assert.match(config.stdout, /^leadUsage\s+false\s+内置默认$/m);

  // 直接写任务文字派发：没有 gate 字段，不评分。
  const typed = await f.ar(['dispatch', '随便做点什么', '--name', '文字任务', '--json']);
  assert.equal(typed.code, 0, typed.stderr + typed.stdout);
  const refused = await f.ar(['report', '文字任务']);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /这个任务不是用任务说明派发的，没有评分/);
  const refusedJson = await f.ar(['report', '文字任务', '--json']);
  assert.equal(refusedJson.code, 2);
  assert.deepEqual(JSON.parse(refusedJson.stdout), { ok: false, error: '这个任务不是用任务说明派发的，没有评分' });
});
