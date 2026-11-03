import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 039：门禁接入派发的集成测试。每个用例在系统临时目录里建一个名字含中文与空格的仓库，
// 用隔离的 AGENT_ROUTER_HOME 与 fake 执行者，通过子进程跑 core/ar.mjs；不碰真实安装、配置与进程。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const note = '本次由 AgentRouter 在门禁前代为提交：git add / git commit 失败（例如沙箱写不了版本库）不算阻塞，不要因此停下；完成全部改动并跑完自测后正常结束，汇报里照常列出改动的文件。';
const promptOf = (f, n) => readFileSync(path.join(f.repo, '.agent-runs', '代提交测试', 'attempts', String(n), 'prompt.md'), 'utf8');

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
    const text = readFileSync(path.join(home, 'runs.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};
const startOf = (home, name) => rows(home).find(row => row.event === 'start' && row.name === name);
const eventsOf = (home, id) => rows(home).filter(row => row.id === id).map(row => row.event);
// 任务说明 frontmatter：只写关心的字段；maxRetries 映射成 max_retries（058 起会失败的用例固定为 0，保持原来的单次行为）。
function specText({ type = 'code', allowed = ['src/**'], verify = [], expectCommit, maxRetries } = {}) {
  const lines = ['---', 'id: 900', 'title: 门禁派发测试', `type: ${type}`];
  if (allowed !== null) {
    lines.push('allowed_paths:');
    for (const item of allowed) lines.push(`  - ${item}`);
  }
  if (verify.length) {
    lines.push('verify:');
    for (const line of verify) lines.push(`  - ${line}`);
  }
  if (expectCommit !== undefined) lines.push(`expect_commit: ${expectCommit}`);
  if (maxRetries !== undefined) lines.push(`max_retries: ${maxRetries}`);
  lines.push('---', '', '测试说明正文。', '');
  return lines.join('\n');
}

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 门禁派发 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'worktrees'), AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', '门禁派发测试']);
  git(repo, ['config', 'user.email', 'gate-dispatch@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ worktree: true, baseBranch: 'main' }));
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  commitAll(repo, '初始提交');
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 };
  const f = { base, repo, home, env, profile, since };
  f.setProfile = value => {
    Object.assign(profile, value);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', review: { default: false }, profiles: { fake: profile },
    }));
  };
  f.setProfile({});
  // 写任务说明；默认随初始提交一起提交（启用门禁时派发前要求说明已提交且工作区干净）。
  f.spec = (rel, fields = {}, { commit = true } = {}) => {
    write(path.join(repo, rel), specText(fields));
    if (commit) commitAll(repo, `任务说明 ${path.basename(rel)}`);
    return rel;
  };
  f.ar = (args, { timeout = 60000 } = {}) => new Promise((resolve, reject) => {
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
  f.progress = name => readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  f.gateJson = start => JSON.parse(readFileSync(path.join(start.dir, 'gate.json'), 'utf8'));
  t.after(async () => {
    // 只结束本 fixture 清单里记录的派发进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar 门禁派发 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

async function runCase(t, { enabled = true, type = 'code', writes = [{ path: 'src/a.js', content: '新内容\n' }], commit = null, hook = false, detach = false } = {}) {
  const f = fixture(t);
  f.setProfile({ autoCommit: enabled, writes, commit });
  const spec = f.spec('docs/specs/252-测试.md', { type, allowed: ['src/**'], expectCommit: true, maxRetries: 0 });
  if (hook) {
    const hooks = path.join(f.base, 'hooks');
    mkdirSync(hooks);
    write(path.join(hooks, 'post-commit'), '#!/bin/sh\nprintf dirty > src/dirty.js\n');
    git(f.repo, ['config', 'core.hooksPath', hooks]);
  }
  const result = await f.ar(['dispatch', spec, '--name', '代提交测试', ...(detach ? ['--detach'] : []), '--json']);
  const actual = detach && result.code === 0 ? await f.ar(['wait', '代提交测试', '--json'], { timeout: 90000 }) : result;
  const start = startOf(f.home, '代提交测试');
  const list = rows(f.home).filter(row => row.id === start.id);
  const worktree = list.find(row => row.event === 'worktree');
  assert.ok(worktree, `${actual.stdout}\n${actual.stderr}\n${JSON.stringify(list)}`);
  const dir = worktree.dir;
  return { f, actual, start, dir, end: list.find(row => row.event === 'attempt-end') };
}

test('开启代提交：脱离派发快照、提交和记录', async t => {
  const x = await runCase(t, { detach: true, writes: [{ path: 'src/a.js', content: '改过\n' }, { path: 'src/新增 文件.js', content: '新增\n' }] });
  assert.equal(x.actual.code, 0, x.actual.stderr + x.actual.stdout);
  assert.ok(promptOf(x.f, 1).endsWith(`\n${note}`));
  assert.equal(x.f.gateJson(x.start).ok, true);
  const sha = git(x.dir, ['rev-parse', 'HEAD']).trim();
  assert.equal(x.end.autoCommit.sha, sha);
  assert.deepEqual(x.end.autoCommit.files, ['src/a.js', 'src/新增 文件.js']);
  assert.equal(git(x.dir, ['log', '-1', '--format=%s']).trim(), '[执行] 门禁派发测试（执行者没能提交，由 AgentRouter 代提交）');
  assert.match(x.f.progress('代提交测试'), new RegExp(`AgentRouter 代提交了 2 个文件：${sha.slice(0, 7)}`));
});

test('关闭代提交，门禁拒绝未提交文件', async t => {
  const x = await runCase(t, { enabled: false });
  assert.equal(x.actual.code, 3, x.actual.stderr + x.actual.stdout);
  assert.ok(!promptOf(x.f, 1).includes(note));
  assert.match(x.f.gateJson(x.start).summary, /有未提交的文件|没有提交任何改动/);
  assert.equal(x.end.autoCommit, undefined);
});

test('执行者已提交又留下未提交文件，不代提交', async t => {
  const x = await runCase(t, { commit: '执行者提交', hook: true });
  assert.equal(x.actual.code, 3, x.actual.stderr + x.actual.stdout);
  assert.match(x.f.gateJson(x.start).summary, /有未提交的文件/);
  assert.equal(x.end.autoCommit, undefined);
  assert.equal(git(x.dir, ['log', '-1', '--format=%s']).trim(), '执行者提交');
});

test('只读任务不代提交', async t => {
  const x = await runCase(t, { type: 'research' });
  assert.equal(x.actual.code, 3, x.actual.stderr + x.actual.stdout);
  assert.equal(x.end.autoCommit, undefined);
  assert.ok(!promptOf(x.f, 1).includes(note));
  assert.ok(x.f.gateJson(x.start).uncommitted.includes('src/a.js'));
});

test('不使用 worktree 时不提示代提交', async t => {
  const f = fixture(t);
  f.setProfile({ autoCommit: true, writes: [] });
  const spec = f.spec('docs/specs/252-测试.md', { expectCommit: true, maxRetries: 0 });
  await f.ar(['dispatch', spec, '--name', '代提交测试', '--no-worktree', '--json']);
  assert.ok(!promptOf(f, 1).includes(note));
});

test('自动重试和手动重试按本次配置提示代提交', async t => {
  const f = fixture(t);
  f.setProfile({ autoCommit: true, writes: [], exit: 1 });
  const spec = f.spec('docs/specs/252-测试.md', { expectCommit: true, maxRetries: 1 });
  await f.ar(['dispatch', spec, '--name', '代提交测试', '--json']);
  assert.ok(promptOf(f, 2).endsWith(String.fromCharCode(10) + note));
  await f.ar(['retry', '代提交测试', '--json']);
  assert.equal(promptOf(f, 3).split(note).length - 1, 1);
  assert.ok(promptOf(f, 3).endsWith(String.fromCharCode(10) + note));
  f.setProfile({ autoCommit: false });
  await f.ar(['retry', '代提交测试', '--json']);
  assert.ok(!promptOf(f, 4).includes(note));
});

test('越界文件代提交后由门禁拦截', async t => {
  const x = await runCase(t, { writes: [{ path: 'README.md', content: '越界\n' }] });
  assert.equal(x.actual.code, 3, x.actual.stderr + x.actual.stdout);
  assert.deepEqual(x.end.autoCommit.files, ['README.md']);
  assert.deepEqual(x.f.gateJson(x.start).scope.outside, ['README.md']);
});

async function retryConflict(t, content, { baselineFile = false, deleted = false, binary = false, attrs = false } = {}) {
  const f = fixture(t);
  if (attrs) {
    write(path.join(f.repo, '.gitattributes'), 'src/a.js -diff\n');
    commitAll(f.repo, '按属性标为二进制');
  }
  if (binary) {
    write(path.join(f.repo, 'src/a.js'), '初始\0内容\n');
    commitAll(f.repo, '二进制基线');
  }
  const spec = f.spec('docs/specs/329-测试.md', { expectCommit: true, maxRetries: 0 });
  f.setProfile({ autoCommit: true, writes: [{ path: 'src/a.js', content: binary ? '任务\0改动\n' : '任务改动\n' }], commit: '任务提交', exit: 1 });
  const first = await f.ar(['dispatch', spec, '--name', '代提交测试', '--json']);
  assert.notEqual(first.code, 0);
  const start = startOf(f.home, '代提交测试');
  const dir = rows(f.home).find(row => row.id === start.id && row.event === 'worktree').dir;
  if (deleted) rmSync(path.join(f.repo, 'src/a.js'));
  else write(path.join(f.repo, 'src/a.js'), binary ? '基线\0改动\n' : '基线改动\n');
  if (baselineFile) write(path.join(f.repo, 'src/基线新增.js'), '基线新增\n');
  commitAll(f.repo, '基线提交');
  f.setProfile({ autoCommit: true, writes: [{ path: 'src/a.js', content }], commit: null, exit: 0 });
  const result = await f.ar(['retry', '代提交测试', '--rebase', '--profile', 'fake', '--json']);
  return { f, start, dir, result, end: rows(f.home).filter(row => row.id === start.id && row.event === 'attempt-end').at(-1) };
}

test('冲突解决后代提交合并，门禁通过', async t => {
  const x = await retryConflict(t, '双方的改动\n');
  assert.equal(x.result.code, 0, x.result.stderr + x.result.stdout);
  assert.equal(x.f.gateJson(x.start).ok, true);
  const sha = git(x.dir, ['rev-parse', 'HEAD']).trim();
  assert.equal(git(x.dir, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length, 3);
  assert.deepEqual(x.end.autoCommit, { sha, files: ['src/a.js'] });
  assert.match(git(x.dir, ['log', '-1', '--format=%s']), /^合并 main（[0-9a-f]{7}）（冲突由执行者解决，AgentRouter 代提交）/);
  const line = x.f.progress('代提交测试').split('\n').find(item => item.includes('AgentRouter 代提交了合并：'));
  assert.ok(line?.includes(sha.slice(0, 7)));
  t.diagnostic(line);
});

test('冲突标记仍在时不代提交，门禁失败', async t => {
  const x = await retryConflict(t, '<<<<<<< 任务\n内容\n=======\n基线\n>>>>>>> main\n');
  assert.equal(x.result.code, 3, x.result.stderr + x.result.stdout);
  assert.equal(x.end.autoCommit, undefined);
  assert.equal(x.f.gateJson(x.start).ok, false);
  const line = x.f.progress('代提交测试').split('\n').find(item => item.includes('还有未解决的冲突'));
  assert.match(line, /AgentRouter 没有代提交：还有未解决的冲突（src\/a\.js）/);
  assert.equal(git(x.dir, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length, 2);
  t.diagnostic(line);
});

test('合并时不把基线新增文件记为执行者改动', async t => {
  const x = await retryConflict(t, '双方的改动\n', { baselineFile: true });
  assert.equal(x.result.code, 0, x.result.stderr + x.result.stdout);
  assert.equal(x.f.gateJson(x.start).ok, true);
  assert.deepEqual(x.end.autoCommit.files, ['src/a.js']);
  assert.equal(git(x.dir, ['show', 'HEAD:src/基线新增.js']), '基线新增\n');
});

for (const [label, options, reason] of [
  ['一方删除一方修改', { deleted: true }, '一方删除'],
  ['二进制文件双方修改', { binary: true }, '二进制'],
  // 329 审查 R3-1：工作区留着本方版本时与索引没有差异，也要按二进制交人工确认。
  ['二进制冲突工作区保留本方版本', { binary: true, keep: true }, '二进制'],
  // 329 审查 R4-1：没有 NUL、但 .gitattributes 标为二进制。
  ['按属性标为二进制的文本冲突', { attrs: true }, '二进制'],
]) {
  test(`${label}时不代提交，门禁失败`, async t => {
    const x = await retryConflict(t, options.keep ? '任务\0改动\n' : options.binary ? '解决\0内容\n' : '解决后的内容\n', options);
    assert.equal(x.result.code, 3, x.result.stderr + x.result.stdout);
    assert.equal(x.end.autoCommit, undefined);
    assert.equal(x.f.gateJson(x.start).ok, false);
    const line = x.f.progress('代提交测试').split('\n').find(item => item.includes('有需要人工确认的冲突'));
    assert.ok(line?.includes(`AgentRouter 没有代提交：有需要人工确认的冲突（src/a.js：${reason}）`), line);
    assert.equal(git(x.dir, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length, 2);
    t.diagnostic(line);
  });
}
