import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 039：门禁接入派发的集成测试。每个用例在系统临时目录里建一个名字含中文与空格的仓库，
// 用隔离的 AGENT_ROUTER_HOME 与 fake 执行者，通过子进程跑 core/ar.mjs；不碰真实安装、配置与进程。
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
    const text = readFileSync(path.join(home, 'runs.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};
const startOf = (home, name) => rows(home).find(row => row.event === 'start' && row.name === name);
const eventsOf = (home, id) => rows(home).filter(row => row.id === id).map(row => row.event);
async function until(fn, label, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

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
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '门禁派发测试']);
  git(repo, ['config', 'user.email', 'gate-dispatch@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  commitAll(repo, '初始提交');
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 };
  const f = { base, repo, home, env, profile, since };
  f.setProfile = value => {
    Object.assign(profile, value);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile },
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

test('全部通过：范围内改动已提交、验收命令通过 → 0，start 有 gate / base，事件顺序完整', async t => {
  const f = fixture(t);
  f.setProfile({ writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改 src/a.js' });
  const spec = f.spec('docs/specs/001-全部 通过.md', { allowed: ['src/**'], verify: ['node -e "process.exit(0)"'] });

  const result = await f.ar(['dispatch', spec, '--name', '全部通过', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.exit, 0);
  assert.deepEqual(value.gate, { ok: true, summary: '门禁通过' });

  const start = startOf(f.home, '全部通过');
  assert.equal(start.gate, true);
  assert.match(start.base, /^[0-9a-f]{40,64}$/, 'base 是完整 SHA');
  const list = rows(f.home).filter(row => row.id === start.id);
  assert.deepEqual(list.map(row => row.event), ['start', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end']);
  const gate = list.find(row => row.event === 'gate');
  assert.equal(gate.ok, true);
  assert.equal(gate.attempt, 1);
  assert.equal(gate.summary, '门禁通过');
  const end = list.at(-1);
  assert.equal(end.exit, 0);
  assert.equal(end.agentExit, 0);

  const saved = f.gateJson(start);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.scope.changed, ['src/a.js']);
  assert.match(f.progress('全部通过'), /门禁开始：检查提交与改动范围，运行 1 条验收命令/);
  assert.match(f.progress('全部通过'), /门禁命令：node -e "process.exit\(0\)" → 通过（[0-9.]+ 秒）/);
  assert.match(value.lines.join('\n'), /^门禁通过$/m);
});

test('越界：改动超出 allowed_paths → 3，gate.json 记 outside，标准输出有原因', async t => {
  const f = fixture(t);
  f.setProfile({ writes: [{ path: 'src/a.js', content: '改过\n' }, { path: 'README.md', content: '# 说明改过\n' }], commit: '假执行者：两处' });
  const spec = f.spec('docs/specs/002-越界.md', { allowed: ['src/**'], expectCommit: true, maxRetries: 0 });

  const result = await f.ar(['dispatch', spec, '--name', '越界任务']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  assert.match(result.stdout, /^门禁未通过：改动超出范围：README\.md$/m);
  assert.match(result.stdout, /^exit=3 report=/m);

  const start = startOf(f.home, '越界任务');
  const saved = f.gateJson(start);
  assert.equal(saved.ok, false);
  assert.deepEqual(saved.scope.outside, ['README.md']);
  assert.equal(saved.summary, '改动超出范围：README.md');
  assert.match(f.progress('越界任务'), /^\[[^\]]+\] 改动超出范围：README\.md$/m);
});

test('未提交：执行者写了文件没提交 → 3，uncommitted 非空', async t => {
  const f = fixture(t);
  f.setProfile({ writes: [{ path: 'src/a.js', content: '没提交\n' }] });
  const spec = f.spec('docs/specs/003-未提交.md', { allowed: ['src/**'], maxRetries: 0 });

  const result = await f.ar(['dispatch', spec, '--name', '未提交任务', '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  const start = startOf(f.home, '未提交任务');
  const saved = f.gateJson(start);
  assert.equal(saved.ok, false);
  assert.ok(saved.uncommitted.includes('src/a.js'), saved.uncommitted.join('、'));
  assert.match(saved.summary, /有未提交的文件/);
});

test('没提交：type code 且执行者什么都不写 → 3，"没有提交任何改动"', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/004-没提交.md', { type: 'code', allowed: ['src/**'], maxRetries: 0 });

  const result = await f.ar(['dispatch', spec, '--name', '没提交任务', '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  const saved = f.gateJson(startOf(f.home, '没提交任务'));
  assert.deepEqual(saved.commit, { required: true, ok: false });
  assert.equal(saved.summary, '没有提交任何改动');
});

test('验收失败：一条失败一条通过，两条都跑了 → 3', async t => {
  const f = fixture(t);
  f.setProfile({ writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改过' });
  const spec = f.spec('docs/specs/005-验收失败.md', {
    allowed: ['src/**'],
    expectCommit: false,
    maxRetries: 0,
    verify: [
      `node -e "require('fs').writeFileSync('first.txt','1');process.exit(1)"`,
      `node -e "require('fs').writeFileSync('second.txt','2')"`,
    ],
  });

  const result = await f.ar(['dispatch', spec, '--name', '验收失败任务', '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  const saved = f.gateJson(startOf(f.home, '验收失败任务'));
  assert.equal(saved.commands.length, 2);
  assert.equal(saved.commands[0].exit, 1);
  assert.equal(saved.commands[1].exit, 0, saved.commands[1].error ?? saved.commands[1].output);
  assert.ok(existsSync(path.join(f.repo, 'first.txt')), '失败的命令确实跑过');
  assert.ok(existsSync(path.join(f.repo, 'second.txt')), '失败之后仍继续跑后面的命令');
  assert.match(saved.summary, /验收命令失败：node -e "require\('fs'\).*exit 1）/);
  assert.equal(JSON.parse(result.stdout).gate.ok, false);
});

test('研究类：只读任务总是启用门禁（gate: true），没有改动时门禁通过，0', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/006-研究.md', { type: 'research', allowed: null, verify: [], expectCommit: false });

  const result = await f.ar(['dispatch', spec, '--name', '研究任务', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const start = startOf(f.home, '研究任务');
  assert.equal(start.gate, true);
  assert.equal(start.readOnly, true);
  assert.match(start.base, /^[0-9a-f]{40,64}$/, 'base 是完整 SHA');
  assert.deepEqual(eventsOf(f.home, start.id), ['start', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end']);
  const end = rows(f.home).find(row => row.event === 'end' && row.id === start.id);
  assert.equal(end.exit, 0);
  assert.equal(end.agentExit, 0);
  assert.equal(JSON.parse(result.stdout).gate.ok, true);
  assert.equal(f.gateJson(start).ok, true);
});

test('直接任务文字：不读说明、start 没有 gate 字段，事件与原来一致', async t => {
  const f = fixture(t);
  const result = await f.ar(['dispatch', '直接写的 任务文字', '--name', '直接任务', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const start = startOf(f.home, '直接任务');
  assert.equal(Object.hasOwn(start, 'gate'), false);
  assert.equal(Object.hasOwn(start, 'base'), false);
  assert.deepEqual(eventsOf(f.home, start.id), ['start', 'attempt', 'spawned', 'attempt-end', 'end']);
  assert.equal(JSON.parse(result.stdout).gate, undefined);
});

test('执行者失败：exit 5 → 5，不跑门禁、end 没有 agentExit', async t => {
  const f = fixture(t);
  f.setProfile({ exit: 5 });
  const spec = f.spec('docs/specs/007-执行者失败.md', { allowed: ['src/**'], maxRetries: 0 });

  const result = await f.ar(['dispatch', spec, '--name', '执行者失败任务', '--json']);
  assert.equal(result.code, 5, result.stderr + result.stdout);
  const start = startOf(f.home, '执行者失败任务');
  assert.equal(start.gate, true);
  assert.deepEqual(eventsOf(f.home, start.id), ['start', 'attempt', 'spawned', 'attempt-end', 'end']);
  const end = rows(f.home).find(row => row.event === 'end' && row.id === start.id);
  assert.equal(end.exit, 5);
  assert.equal(Object.hasOwn(end, 'agentExit'), false);
  assert.equal(existsSync(path.join(start.dir, 'gate.json')), false);
  assert.equal(JSON.parse(result.stdout).gate, undefined);
});

test('派发时工作区不干净：→ 2，原因含文件名，没有 start 记录与任务目录', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/008-脏工作区.md', { allowed: ['src/**'] });
  write(path.join(f.repo, '未提交 草稿.txt'), '草稿\n');

  const result = await f.ar(['dispatch', spec, '--name', '脏工作区任务', '--json']);
  assert.equal(result.code, 2, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, false);
  assert.match(value.error, /工作区有没提交的改动：未提交 草稿\.txt/);
  assert.equal(startOf(f.home, '脏工作区任务'), undefined);
  assert.deepEqual(rows(f.home), []);
  assert.equal(existsSync(path.join(f.repo, '.agent-runs')), false);
});

test('任务说明未提交：→ 2，原因含"任务说明还没有提交"', async t => {
  const f = fixture(t);
  const spec = f.spec('docs/specs/009-说明未提交.md', { allowed: ['src/**'] }, { commit: false });

  const result = await f.ar(['dispatch', spec, '--name', '说明未提交任务', '--json']);
  assert.equal(result.code, 2, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.match(value.error, /任务说明还没有提交：docs\/specs\/009-说明未提交\.md/);
  assert.deepEqual(rows(f.home), []);
  assert.equal(existsSync(path.join(f.repo, '.agent-runs')), false);
});

test('frontmatter 写错：type banana → 2，原因含行号，占记录名之前失败', async t => {
  const f = fixture(t);
  const file = path.join(f.repo, 'docs/specs/010-写错.md');
  write(file, '---\nid: 900\ntitle: 写错\ntype: banana\n---\n正文\n');

  const result = await f.ar(['dispatch', 'docs/specs/010-写错.md', '--name', '写错任务', '--json']);
  assert.equal(result.code, 2, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.match(value.error, /第 4 行：type 只能是/);
  assert.deepEqual(rows(f.home), []);
  assert.equal(existsSync(path.join(f.repo, '.agent-runs')), false);
});

test('--detach：启用门禁的说明脱离派发，ar wait 等结束并拿到 gate', async t => {
  const f = fixture(t);
  f.setProfile({ writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改过' });
  const spec = f.spec('docs/specs/011-脱离.md', { allowed: ['src/**'], verify: ['node -e "process.exit(0)"'] });

  const detached = await f.ar(['dispatch', spec, '--name', '脱离任务', '--detach', '--json']);
  assert.equal(detached.code, 0, detached.stderr + detached.stdout);
  const value = JSON.parse(detached.stdout);
  assert.equal(value.detached, true);
  await until(() => startOf(f.home, '脱离任务'), '脱离派发的 start 记录');

  const waited = await f.ar(['wait', '脱离任务', '--json'], { timeout: 90000 });
  assert.equal(waited.code, 0, waited.stderr + waited.stdout);
  const result = JSON.parse(waited.stdout);
  assert.equal(result.exit, 0);
  assert.deepEqual(result.gate, { ok: true, summary: '门禁通过' });
  const start = startOf(f.home, '脱离任务');
  assert.equal(start.gate, true);
  assert.deepEqual(eventsOf(f.home, start.id), ['start', 'attempt', 'spawned', 'gating', 'gate', 'attempt-end', 'end']);
  assert.equal(rows(f.home).find(row => row.event === 'end' && row.id === start.id).exit, 0);
});

test('ar wait --json：门禁未通过的任务 exit 3、gate.ok 为假、summary 与 gate.json 一致', async t => {
  const f = fixture(t);
  f.setProfile({ writes: [{ path: 'README.md', content: '# 越界\n' }], commit: '假执行者：只改 README' });
  const spec = f.spec('docs/specs/012-等待失败.md', { allowed: ['src/**'], maxRetries: 0 });

  const result = await f.ar(['dispatch', spec, '--name', '等待失败任务', '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  const started = startOf(f.home, '等待失败任务');

  const waited = await f.ar(['wait', '等待失败任务', '--json']);
  assert.equal(waited.code, 3, waited.stderr + waited.stdout);
  const value = JSON.parse(waited.stdout);
  assert.equal(value.exit, 3);
  assert.equal(value.gate.ok, false);
  assert.equal(value.gate.summary, f.gateJson(started).summary);
  assert.match(value.gate.summary, /^改动超出范围：README\.md$/);
  assert.match(value.lines.join('\n'), /^门禁未通过：改动超出范围：README\.md$/m);
});

test('项目配置兜底：说明没写 verify，project.json 的失败命令仍会跑 → 3', async t => {
  const f = fixture(t);
  f.setProfile({ writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改过' });
  write(path.join(f.repo, '.agent-router/project.json'), `${JSON.stringify({ verify: ['node -e "process.exit(1)"'] })}\n`);
  const spec = f.spec('docs/specs/013-项目兜底.md', { type: 'code', allowed: null, verify: [], maxRetries: 0 });

  const result = await f.ar(['dispatch', spec, '--name', '项目兜底任务', '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  const saved = f.gateJson(startOf(f.home, '项目兜底任务'));
  assert.equal(saved.commands.length, 1);
  assert.equal(saved.commands[0].line, 'node -e "process.exit(1)"');
  assert.equal(saved.commands[0].exit, 1);
  assert.match(saved.summary, /^验收命令失败：node -e "process\.exit\(1\)"（exit 1）$/);
});

// 055：项目配置的 verifyTimeoutMin 作为任务说明没写超时时的默认值，随脱离派发的请求快照
// 传到执行者进程（args.gate.merged.verify_timeout_min）；任务说明写了就用任务说明的值。
test('项目级 verifyTimeoutMin：随脱离派发传到执行者请求，任务说明写了就用', async t => {
  const f = fixture(t);
  // 假执行者带一个事件与长延时：读取请求快照时任务一定还在跑。
  f.setProfile({ events: [{ kind: 'say', text: '正在做' }], delayMs: 60000 });
  write(path.join(f.repo, '.agent-router/project.json'), `${JSON.stringify({ verifyTimeoutMin: 7 })}\n`);
  const specA = f.spec('docs/specs/014-项目级超时.md', { allowed: ['src/**'] });

  // 派发一次并读公共目录 managed 里这次派发的请求文件（.claimed.json，或执行者已改名的 .running.json）；
  // 读到快照、等到 start 记录后停止任务，返回请求对象。
  const dispatchAndRead = async (spec, name) => {
    const dispatched = await f.ar(['dispatch', spec, '--name', name, '--detach', '--json']);
    assert.equal(dispatched.code, 0, dispatched.stderr + dispatched.stdout);
    const id = JSON.parse(dispatched.stdout).id;
    const readRequest = () => {
      for (const suffix of ['.running.json', '.claimed.json']) {
        const file = path.join(f.home, 'managed', `${id}${suffix}`);
        if (!existsSync(file)) continue;
        try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* 正好在改名，下一轮再读。 */ }
      }
      return null;
    };
    const request = await until(readRequest, `${name} 的请求文件`);
    await until(() => startOf(f.home, name), `${name} 的 start 记录`);
    const stopped = await f.ar(['stop', name]);
    assert.equal(stopped.code, 0, stopped.stderr + stopped.stdout);
    return request;
  };

  const fromProject = await dispatchAndRead(specA, '项目级超时任务');
  assert.equal(fromProject.args.gate.merged.verify_timeout_min, 7, '任务说明没写超时，取项目配置 verifyTimeoutMin: 7');

  // 任务说明写了 verify_timeout_min: 3 → 3（压过项目配置的 7）。
  const specB = 'docs/specs/015-说明级超时.md';
  write(path.join(f.repo, specB), [
    '---', 'id: 900', 'title: 门禁派发测试', 'type: code',
    'allowed_paths:', '  - src/**', 'verify_timeout_min: 3',
    '---', '', '测试说明正文。', '',
  ].join('\n'));
  commitAll(f.repo, `任务说明 ${path.basename(specB)}`);
  const fromSpec = await dispatchAndRead(specB, '说明级超时任务');
  assert.equal(fromSpec.args.gate.merged.verify_timeout_min, 3, '任务说明写了 verify_timeout_min: 3');

  // 清理：只结束命令行带本测试临时路径的进程，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
  await cleanupProcesses(f.base, { recorded: recordedStarts(rows(f.home), script, f.since), diagnostic: message => t.diagnostic(message) });
});
