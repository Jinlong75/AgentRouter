import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// 执行者需要越界（协议 14.5）的集成测试：隔离的 AGENT_ROUTER_HOME、系统临时目录里的仓库、fake 执行者，
// max_retries 为 2；子进程跑 core/ar.mjs，不碰真实安装、配置与进程，也不手动派发。
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
const DONE_WRITE = { writes: [{ path: 'src/done.txt', content: '任务完成\n' }], commit: '假执行者：写入完成标记' };

const SCOPE_REPORT = [
  '# 汇报', '', '做到一半。', '',
  '## 需要越界',
  '- `core/lib/gate.mjs`：要在这里加一个参数，否则测试没法注入',
  '- tests/unit/gate.test.mjs', '',
  '## 已知问题', '无', '',
].join('\n');
const SCOPE_LIST = [
  { path: 'core/lib/gate.mjs', reason: '要在这里加一个参数，否则测试没法注入' },
  { path: 'tests/unit/gate.test.mjs', reason: null },
];

function fixture(t, profileExtra) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-scope-078-'));
  const repo = path.join(base, 'repo 078'), home = path.join(base, 'home 078');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '越界测试']);
  git(repo, ['config', 'user.email', 'scope-078@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  commitAll(repo, '初始提交');
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...profileExtra };
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile } }));
  write(path.join(repo, 'docs/specs/001-越界.md'), [
    '---', 'id: 978', 'title: 越界测试', 'type: code', 'allowed_paths:', '  - src/**', 'verify:', `  - ${DONE_CHECK}`, 'max_retries: 2', '---', '', '越界测试正文。', '',
  ].join('\n'));
  commitAll(repo, '任务说明');
  const f = { base, repo, home, env };
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
  f.list = name => {
    const start = rows(home).find(row => row.event === 'start' && row.name === name);
    return rows(home).filter(row => row.id === start.id);
  };
  f.progress = name => readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  t.after(async () => {
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(realpathSync.native(os.tmpdir()), base).startsWith('ar-scope-078-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('门禁失败且汇报有"需要越界"：只跑 1 次，字段、--json、进度、退出码 3', async t => {
  const f = fixture(t, { report: SCOPE_REPORT });
  const result = await f.ar(['dispatch', 'docs/specs/001-越界.md', '--name', '越界一', '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  const json = JSON.parse(result.stdout);
  assert.equal(json.exit, 3);
  assert.deepEqual(json.needsScope, SCOPE_LIST, '--json 带 needsScope');
  assert.equal(json.gate.ok, false);

  const list = f.list('越界一');
  assert.equal(list.filter(row => row.event === 'attempt').length, 1, '只有 1 次尝试');
  const attemptEnd = list.filter(row => row.event === 'attempt-end');
  assert.equal(attemptEnd.length, 1);
  assert.deepEqual(attemptEnd[0].needsScope, SCOPE_LIST);
  assert.equal(attemptEnd[0].gate, false);
  const end = list.at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.exit, 3);
  assert.equal(end.attempts, 1);
  assert.deepEqual(end.needsScope, SCOPE_LIST);
  assert.ok(f.progress('越界一').includes('需要越界：执行者列出 2 个路径（core/lib/gate.mjs、tests/unit/gate.test.mjs），不再自动重试，等主导决定'));

  // ar wait 的 --json 同样带上。
  const waited = await f.ar(['wait', '越界一', '--json']);
  assert.deepEqual(JSON.parse(waited.stdout).needsScope, SCOPE_LIST);
});

test('门禁失败但汇报没有这一节：照常 3 次尝试，不带 needsScope', async t => {
  const f = fixture(t, { report: '# 汇报\n\n没做完。\n' });
  const result = await f.ar(['dispatch', 'docs/specs/001-越界.md', '--name', '越界二', '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  const json = JSON.parse(result.stdout);
  assert.ok(!('needsScope' in json));
  const list = f.list('越界二');
  assert.equal(list.filter(row => row.event === 'attempt').length, 3);
  assert.ok(list.filter(row => row.event === 'attempt-end').every(row => !('needsScope' in row)));
  assert.ok(!('needsScope' in list.at(-1)));
  assert.ok(!f.progress('越界二').includes('需要越界'));
});

test('汇报有这一节但门禁通过：照常完成，end 带 needsScope，只 1 次', async t => {
  const f = fixture(t, { report: SCOPE_REPORT, ...DONE_WRITE });
  const result = await f.ar(['dispatch', 'docs/specs/001-越界.md', '--name', '越界三', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const json = JSON.parse(result.stdout);
  assert.equal(json.exit, 0);
  assert.deepEqual(json.needsScope, SCOPE_LIST);
  const list = f.list('越界三');
  assert.equal(list.filter(row => row.event === 'attempt').length, 1);
  const end = list.at(-1);
  assert.equal(end.exit, 0);
  assert.deepEqual(end.needsScope, SCOPE_LIST);
});

test('这一节只出现在代码块里：当作没有，照常重试', async t => {
  const fenced = ['# 汇报', '', '格式示例：', '', '```markdown', '## 需要越界', '- `core/lib/gate.mjs`：示例', '```', ''].join('\n');
  const f = fixture(t, { report: fenced });
  const result = await f.ar(['dispatch', 'docs/specs/001-越界.md', '--name', '越界四', '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  assert.ok(!('needsScope' in JSON.parse(result.stdout)));
  const list = f.list('越界四');
  assert.equal(list.filter(row => row.event === 'attempt').length, 3);
  assert.ok(!('needsScope' in list.at(-1)));
});
