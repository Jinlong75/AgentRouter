import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 069：requireGateBase 的"任务说明还没有提交"失败路径在标准错误另写一行核对明细（git ls-files / git status 的退出码、
// 信号、标准错误与输出的前 300 字符，路径脱敏）；返回给调用方的错误文字与退出码不变。
// 隔离：系统临时目录里的临时仓库、隔离的 AGENT_ROUTER_HOME、fake 执行者；不派发（说明未提交，派发前就失败）。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, 'utf8'); };

function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-gate-diag-'));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home');
  mkdirSync(repo); mkdirSync(home);
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '门禁诊断测试']);
  git(repo, ['config', 'user.email', 'gate-diag@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  write(path.join(home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
    profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 } },
  }));
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_CORE_TRACE']) delete env[key];
  const ar = (args, extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  return { base, repo, home, ar, git: args => git(repo, args) };
}
const specText = ['---', 'id: 901', 'title: 门禁诊断', 'type: code', 'allowed_paths:', '  - src/**', '---', '', '测试说明正文。', ''].join('\n');

test('任务说明未提交（ls-files 失败）：标准错误有一行核对明细，错误文字与退出码不变', async t => {
  const f = fixture(t);
  write(path.join(f.repo, 'docs/specs/901-未提交.md'), specText); // 未跟踪
  const result = await f.ar(['dispatch', 'docs/specs/901-未提交.md', '--name', '未提交', '--json']);
  assert.equal(result.code, 2, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.error, '任务说明还没有提交：docs/specs/901-未提交.md。启用门禁的任务要先提交任务说明，再派发。', '返回给调用方的错误文字不变');
  const lines = result.stderr.split('\n').filter(line => line.startsWith('[ar-gate 核对]'));
  assert.equal(lines.length, 1, `标准错误里恰有一行核对明细：${result.stderr}`);
  const line = lines[0];
  assert.match(line, /任务说明还没有提交：docs\/specs\/901-未提交\.md/);
  assert.match(line, /git ls-files --error-unmatch：退出码=1/);
  assert.match(line, /git status --porcelain：退出码=0/);
  assert.match(line, /标准错误前 300 字符="[^"]*(did not match|pathspec)/i, 'ls-files 的标准错误前 300 字符');
  assert.match(line, /输出前 300 字符="\?\? docs\/specs\/901-未提交\.md␀"/, 'status 的输出（NUL 换成 ␀）');
  assert.ok(!line.includes(f.base) && !line.includes(os.homedir()), '路径经过脱敏，不含临时目录或用户目录');
});

test('任务说明已提交：平时不写核对明细；AR_CORE_TRACE=1 时才写一行', async t => {
  const f = fixture(t);
  write(path.join(f.repo, 'docs/specs/902-已提交.md'), specText.replace('id: 901', 'id: 902'));
  f.git(['add', '-A']);
  f.git(['commit', '-q', '-m', '任务说明']);
  // 派发会真正启动 fake 执行者，这里只关心派发前检查：用 --dry-run 之类的开关不可靠，所以用任务说明之外的失败收尾——
  // 工作区有未提交改动，让第 3 项检查失败（说明检查已通过）。
  write(path.join(f.repo, '草稿.txt'), '未提交\n');
  const plain = await f.ar(['dispatch', 'docs/specs/902-已提交.md', '--name', '已提交', '--json']);
  assert.equal(plain.code, 2, plain.stderr + plain.stdout);
  assert.match(JSON.parse(plain.stdout).error, /工作区有没提交的改动/);
  assert.ok(!plain.stderr.includes('[ar-gate 核对]'), `平时不写核对明细：${plain.stderr}`);
  const traced = await f.ar(['dispatch', 'docs/specs/902-已提交.md', '--name', '已提交', '--json'], { AR_CORE_TRACE: '1' });
  assert.equal(traced.code, 2, traced.stderr + traced.stdout);
  const lines = traced.stderr.split('\n').filter(line => line.startsWith('[ar-gate 核对]'));
  assert.equal(lines.length, 1, traced.stderr);
  assert.match(lines[0], /任务说明已提交（AR_CORE_TRACE=1）/);
  assert.match(lines[0], /git ls-files --error-unmatch：退出码=0/);
});
