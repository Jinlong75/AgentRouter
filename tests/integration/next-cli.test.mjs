import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../core/lib/cli.mjs';
import { nextTasks } from '../../core/lib/next.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function commitSpecs(root) {
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); assert.equal(result.status, 0, result.stderr); };
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('add', 'docs/specs'); git('commit', '-qm', 'fixtures');
}

test('next 恢复损坏状态后仅提示一次', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-recovery-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(root); mkdirSync(home);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, shell: false }).status, 0);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 'auto' }));
  writeFileSync(join(home, 'concurrency-state.json'), '{');
  const call = async () => { const out = []; assert.equal(await main(['next', '--json'], { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude') }, out: line => out.push(line) }), 0); return JSON.parse(out[0]); };
  assert.match((await call()).warnings.join(' '), /损坏/);
  assert.doesNotMatch((await call()).warnings.join(' '), /损坏/);
});

test('next 列出本项目待验收和冲突，结束及其他项目任务不显示', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-awaiting-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(home);
  writeFileSync(join(root, 'docs', 'specs', '100-test.md'), '---\ntitle: 候选\n---\n');
  commitSpecs(root);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 2 }));
  const call = async args => { const out = []; const code = await main(['next', ...args], { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude') }, out: line => out.push(line) }); assert.equal(code, 0, out.join('\n')); return out; };
  assert.deepEqual(JSON.parse((await call(['--json']))[0]).awaiting, []);
  assert.doesNotMatch((await call([])).join('\n'), /待验收/);
  const row = (event, id, extra = {}) => ({ v: 2, event, id, ...extra });
  const rows = [
    row('start', 'a', { repo: root, name: '任务甲', worktree: true }), row('review', 'a', { verdict: 'pass' }), row('review', 'a', { verdict: 'concerns' }), row('end', 'a', { exit: 0, at: 100 }),
    row('start', 'b', { repo: root, name: '任务乙', worktree: true }), row('review', 'b', { verdict: 'fail' }), row('end', 'b', { exit: 0, at: 200 }), row('conflict', 'b', { at: 300 }),
    row('start', 'c', { repo: root, name: '任务丙', worktree: true }), row('review', 'c', { verdict: 'unknown' }), row('end', 'c', { exit: 0, at: 400 }),
    row('start', 'd', { repo: root, name: '已验收', worktree: true }), row('end', 'd', { exit: 0, at: 500 }), row('accepted', 'd'),
    row('start', 'e', { repo: join(dir, 'other'), name: '其他项目', worktree: true }), row('end', 'e', { exit: 0, at: 600 }),
    row('start', 'f', { repo: root, name: '无工作区' }), row('end', 'f', { exit: 0, at: 700 })
  ];
  writeFileSync(join(home, 'runs.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual(JSON.parse((await call(['--json']))[0]).awaiting, [
    { name: '任务丙', state: 'awaiting', reviewVerdict: null, since: 400 },
    { name: '任务乙', state: 'conflict', reviewVerdict: 'fail', since: 300 },
    { name: '任务甲', state: 'awaiting', reviewVerdict: 'concerns', since: 100 }
  ]);
  const text = (await call([])).join('\n');
  assert.match(text, /待验收（3）：\n  任务丙：审查 无\n  任务乙：冲突，需要 ar retry --rebase\n  任务甲：审查 concerns/);
  // 待验收的 worktree 任务占着改动范围（夹具没有说明文件，范围按全仓库算），候选排进"范围重叠"；待验收一组排在候选各组前面。
  assert.match(text, /范围重叠（1）：\n  100 候选：和 任务丙、任务甲 重叠/);
  assert.ok(text.indexOf('待验收') < text.indexOf('范围重叠'));
  assert.doesNotMatch(text, /已验收|其他项目|无工作区/);
});

 test('next 输出候选及重叠、依赖，wait 在结束时提示', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 2 }));
  const spec = (id, path, depends = '') => writeFileSync(join(root, 'docs', 'specs', `${id}-test.md`), `---\ntitle: 任务${id}\nallowed_paths:\n  - ${path}\n${depends}---\n`);
  spec('100', 'src/a'); spec('101', 'src/a'); spec('102', 'src/b', 'depends:\n  - "099"\n');
  commitSpecs(root);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude') };
  const call = async args => { const out = []; const code = await main(args, { cwd: root, env, scriptPath: join(root, 'ar.mjs'), out: line => out.push(line) }); return { code, out }; };
  const result = JSON.parse((await call(['next', '--json'])).out[0]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.slots.free, 2); assert.deepEqual(result.candidates.map(c => c.ready), [true, false, false]);
  assert.deepEqual(result.candidates[1].overlapsWith, ['100（候选）']); assert.deepEqual(result.candidates[2].blockedBy, ['099']);
  const start = { v: 2, event: 'start', id: 'run', repo: root, name: '示例', pid: 2147483647, started: Date.now(), report: join(root, 'report') };
  writeFileSync(join(home, 'runs.jsonl'), [start, { v: 2, event: 'end', id: 'run', exit: 0 }].map(JSON.stringify).join('\n') + '\n');
  const wait = await call(['wait', '示例', '--json']);
  assert.deepEqual(JSON.parse(wait.out[0]).next, { free: 2, ready: ['100'] });
  const text = await call(['wait', '示例']);
  assert.equal(text.out.length, 4);
  assert.match(text.out[2], /^资源：CPU \d+%，可用内存 [\d.]+ GB（运行 \d+ \/ 上限 \d+）$/);
  assert.deepEqual([text.out[0], text.out[1], text.out[3]], ['等待：示例（已结束）', `exit=0 report=${start.report}`, '空闲名额 2，可以并行派发：100（ar next --dispatch）']);
});

test('运行中任务和只读候选的范围判断，以及自动档繁忙和独占暂停', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-scope-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(join(home, 'slots'), { recursive: true });
  const spec = (id, type, path) => writeFileSync(join(root, 'docs', 'specs', `${id}-test.md`), `---\ntitle: 任务${id}\ntype: ${type}\nallowed_paths:\n  - ${path}\n---\n`);
  spec('100', 'research', 'src/a'); spec('101', 'code', 'src/a'); spec('102', 'review', 'src/a'); spec('103', 'code', 'src/b');
  commitSpecs(root);
  const taskDir = join(dir, 'task'); mkdirSync(taskDir);
  writeFileSync(join(taskDir, 'dispatch.json'), JSON.stringify({ gate: { enabled: true, merged: { allowed_paths: ['src/a'] } } }));
  const started = Date.now() - Math.floor(process.uptime() * 500);
  writeFileSync(join(home, 'runs.jsonl'), JSON.stringify({ v: 2, event: 'start', id: 'active', name: '运行任务', repo: root, dir: taskDir, worktree: true, pid: process.pid, started }) + '\n');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 'auto' }));
  const loadFile = join(dir, 'load.json'); writeFileSync(loadFile, JSON.stringify({ busy: true, cpu: 92 }));
  const env = { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude'), AR_TEST_LOAD_FILE: loadFile };
  const call = async args => { const out = []; const code = await main(args, { cwd: root, env, scriptPath: fileURLToPath(new URL('../../core/ar.mjs', import.meta.url)), out: line => out.push(line) }); assert.equal(code, 0, out.join('\n')); return out; };
  const result = JSON.parse((await call(['next', '--json']))[0]);
  assert.equal(result.slots.free, 0); assert.deepEqual(result.candidates.map(c => c.ready), [true, false, true, true]);
  assert.deepEqual(result.candidates[1].overlapsWith, ['运行任务']);
  assert.match((await call(['next'])).join('\n'), /机器正忙（CPU 92%）.*先等/);
  assert.deepEqual(JSON.parse((await call(['next', '--dispatch', '--json']))[0]).dispatched, []);
  writeFileSync(join(home, 'slots', 'exclusive.json'), JSON.stringify({ id: 'exclusive', pid: process.pid, name: '独占任务', command: 'test' }));
  const exclusive = JSON.parse((await call(['next', '--json']))[0]);
  assert.equal(exclusive.slots.free, 0); assert.match(exclusive.slots.pauseReason, /独占/);
});

test('next --dispatch 只派 ready 候选且不超过空闲名额', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-dispatch-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(join(root, '.agent-router')); mkdirSync(home);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ v: 1, baseBranch: 'main', specsDir: 'docs/specs', worktree: true }));
  writeFileSync(join(root, '.gitignore'), '.agent-runs/\n');
  for (const [id, path, depends] of [['100', 'src/a', ''], ['101', 'src/b', 'depends:\n  - "099"\n'], ['102', 'src/c', '']]) writeFileSync(join(root, 'docs', 'specs', `${id}-test.md`), `---\ntitle: 任务${id}\ntype: code\nexpect_commit: false\nallowed_paths:\n  - ${path}\n${depends}---\n测试\n`);
  writeFileSync(join(root, 'docs/specs/099-dep.md'), '---\ntitle: dependency\n---\n');
  git('add', 'docs/specs/099-dep.md');
  const old = spawnSync('git', ['commit', '-qm', 'dependency'], { cwd: root, encoding: 'utf8', shell: false, env: { ...process.env, GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' } }); assert.equal(old.status, 0, old.stderr);
  git('add', '.gitignore', '.agent-router/project.json', 'docs/specs'); git('commit', '-qm', 'fixtures');
  git('checkout', '-qb', 'stage/test');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 1, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true, events: [], report: '完成', exit: 0 } } }));
  const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
  const env = { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude'), AR_WORKTREE_ROOT: join(dir, 'worktrees'), AR_NO_WATCH: '1' };
  const out = []; const code = await main(['next', '--dispatch', '--json'], { cwd: root, env, scriptPath: script, out: line => out.push(line) });
  assert.equal(code, 0, out.join('\n')); const result = JSON.parse(out[0]);
  assert.equal(result.slots.free, 1); assert.deepEqual(result.candidates.map(c => c.ready), [true, false, true]); assert.equal(result.dispatched.length, 1);
  const waited = spawnSync(process.execPath, [script, 'wait', result.dispatched[0], '--timeout', '60', '--json'], { cwd: root, env, encoding: 'utf8', shell: false, timeout: 70000 });
  assert.equal(waited.status, 0, waited.stderr || waited.stdout);
  const records = readFileSync(join(home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.find(row => row.event === 'start').baseBranch, 'stage/test');
});

test('next 只预检名额内的就绪任务，文本显示拆分建议', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-ready-check-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(join(root, 'docs/specs'), { recursive: true }); mkdirSync(home);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'docs/specs/100-ready.md'), '---\ntitle: 就绪\nallowed_paths:\n  - core/**\n  - app/src/main/shots*.ts\n---\n');
  writeFileSync(join(root, 'docs/specs/101-blocked.md'), '---\ntitle: 非就绪 # 问题\ndepends: ["999"]\nallowed_paths:\n  - other/**\n---\n');
  writeFileSync(join(root, 'docs/specs/102-extra.md'), '---\ntitle: 超出名额 # 问题\nallowed_paths:\n  - extra/**\n---\n');
  git('add', 'docs/specs'); git('commit', '-qm', 'fixtures');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 1, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true, events: [], report: '完成', exit: 0 } } }));
  const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
  const env = { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude'), AR_NO_WATCH: '1' };
  const out = [], code = await main(['next', '--dispatch'], { cwd: root, env, scriptPath: script, out: line => out.push(line) });
  assert.equal(code, 0, out.join('\n')); assert.match(out.join('\n'), /建议拆成核心与界面两份/); assert.match(out.join('\n'), /已派发：/);
  const name = out.find(line => line.startsWith('已派发：')).slice(4).split('（')[0];
  const waited = spawnSync(process.execPath, [script, 'wait', name, '--timeout', '60', '--json'], { cwd: root, env, encoding: 'utf8', shell: false, timeout: 70000 });
  assert.equal(waited.status, 0, waited.stderr || waited.stdout);
});

test('依赖合并提交属于基线时解锁，活着的名额占满时不可派发', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-git-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(join(root, '.agent-router')); mkdirSync(join(home, 'slots'), { recursive: true });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'file'), 'initial'); git('add', 'file'); git('commit', '-qm', '[执行] 合并 099-test：完成');
  const branch = git('branch', '--show-current');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ baseBranch: branch }));
  writeFileSync(join(root, 'docs', 'specs', '102-test.md'), '---\ntitle: 任务\ndepends:\n  - "099"\n---\n');
  git('add', 'docs/specs'); git('commit', '-qm', 'spec');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 1 }));
  writeFileSync(join(home, 'slots', 'slot-0.json'), JSON.stringify({ id: 'busy', pid: process.pid }));
  writeFileSync(join(root, 'docs', 'specs', '099-test.md'), '---\ntitle: merged\n---\n');
  const out = [], code = await main(['next', '--json'], { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude') }, scriptPath: join(root, 'ar.mjs'), out: line => out.push(line) });
  assert.equal(code, 0, out.join('\n'));
  const result = JSON.parse(out[0]); assert.equal(result.candidates[0].ready, true); assert.equal(result.slots.running, 1); assert.equal(result.slots.free, 0);
});


test('recent commits and --all', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-recent-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(home);
  const git = (args, extra = {}) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, env: { ...process.env, ...extra } }); assert.equal(r.status, 0, r.stderr); };
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(root, 'docs', 'specs', '100-old.md'), '---\ntitle: old\n---\n');
  git(['add', 'docs/specs']); git(['commit', '-qm', 'old'], { GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' });
  writeFileSync(join(root, 'docs', 'specs', '101-recent.md'), '---\ntitle: recent\n---\n');
  git(['add', 'docs/specs']); git(['commit', '-qm', 'recent']);
  writeFileSync(join(root, 'docs', 'specs', '102-uncommitted.md'), '---\ntitle: uncommitted\n---\n');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 2 }));
  const call = async args => { const out = []; const code = await main(args, { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude') }, out: line => out.push(line) }); assert.equal(code, 0, out.join('\n')); return out; };
  assert.deepEqual(JSON.parse((await call(['next', '--json']))[0]).candidates.map(c => c.id), ['101']);
  assert.deepEqual(JSON.parse((await call(['next', '--all', '--json']))[0]).candidates.map(c => c.id), ['100', '101', '102']);
  assert.match((await call(['next'])).join('\n'), /--all/);
});


test('empty repository', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-empty-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(home);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, shell: false }).status, 0);
  writeFileSync(join(root, 'docs', 'specs', '100-test.md'), '---\ntitle: test\n---\n');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 1 }));
  for (const args of [['next'], ['next', '--all'], ['next', '--dispatch']]) {
    const out = [], code = await main(args, { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude') }, out: line => out.push(line) });
    assert.equal(code, 0); assert.match(out.join('\n'), /\u4ed3\u5e93\u8fd8\u6ca1\u6709\u63d0\u4ea4/);
  }
});

test('stage branch uses HEAD', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-stage-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(join(root, '.agent-router')); mkdirSync(home);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ baseBranch: 'main' }));
  git('add', '.agent-router/project.json'); git('commit', '-qm', 'initial'); git('checkout', '-qb', 'stage/test');
  for (const id of ['100', '101']) writeFileSync(join(root, 'docs', 'specs', `${id}-test.md`), `---\ntitle: test${id}\n${id === '101' ? 'depends: ["100"]\n' : ''}---\n`);
  git('add', 'docs/specs'); git('commit', '-qm', '[执行] 合并 100-test：完成');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 1 }));
  for (const flag of [[], ['--all']]) {
    const out = [], code = await main(['next', ...flag, '--json'], { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude') }, out: line => out.push(line) });
    assert.equal(code, 0, out.join('\n')); const result = JSON.parse(out[0]);
    assert.deepEqual(result.candidates.map(c => c.id), ['101'], JSON.stringify({ flag, result, log: spawnSync('git', ['log', 'HEAD', '--since=14.days', '--name-only', '--format=', '-z', '--', 'docs/specs'], { cwd: root, encoding: 'utf8', shell: false }).stdout })); assert.equal(result.candidates[0].ready, true);
  }
});

test('自定义记录名合入后解除依赖，非基线祖先不解除依赖', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-accepted-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(join(root, '.agent-router')); mkdirSync(home);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.agent-runs/\n');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ v: 1, baseBranch: 'main', worktree: true }));
  writeFileSync(join(root, 'docs', 'specs', '100-test.md'), '---\ntitle: test100\ntype: code\nexpect_commit: true\nallowed_paths:\n  - src/**\n---\n');
  writeFileSync(join(root, 'docs', 'specs', '101-test.md'), '---\ntitle: test101\ndepends: ["100"]\n---\n');
  git('add', '.gitignore', '.agent-router/project.json', 'docs/specs'); git('commit', '-qm', 'fixtures');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', enabled: true, events: [], report: '完成\n## 已知问题\n无\n## 需要越界\n无\n', exit: 0, writes: [{ path: 'src/a', content: 'changed' }], commit: 'change' } } }));
  const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
  const env = { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude'), AR_WORKTREE_ROOT: join(dir, 'worktrees'), AR_NO_WATCH: '1' };
  const call = args => { const r = spawnSync(process.execPath, [script, ...args, '--json'], { cwd: root, env, encoding: 'utf8', shell: false, timeout: 90000 }); assert.equal(r.status, 0, r.stderr || r.stdout); return JSON.parse(r.stdout); };
  call(['dispatch', 'docs/specs/100-test.md', '--name', 'custom']);
  assert.deepEqual(call(['next', '--all']).candidates.find(c => c.id === '101').blockedBy, ['100']);
  const oldHead = git('rev-parse', 'HEAD');
  const accepted = call(['accept', 'custom']);
  const after = call(['next', '--all']);
  assert.deepEqual(after.candidates.map(c => c.id), ['101']);
  assert.deepEqual(after.candidates[0].blockedBy, []);
  git('checkout', '-qb', 'before-merge', oldHead);
  const before = call(['next', '--all']);
  assert.deepEqual(before.candidates.find(c => c.id === '101').blockedBy, ['100']);
  assert.ok(accepted.merge);
});

test('带字母后缀的编号列出并在合并后解除依赖', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-suffix-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/specs'), { recursive: true }); mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 2 }));
  writeFileSync(join(root, 'docs/specs/100b-test.md'), '---\ntitle: 前置\nallowed_paths:\n  - a/**\n---\n');
  writeFileSync(join(root, 'docs/specs/101-test.md'), '---\ntitle: 后续\ndepends: ["100b"]\nallowed_paths:\n  - b/**\n---\n');
  commitSpecs(root);
  const call = async () => { const out = []; const code = await main(['next', '--all', '--json'], { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude') }, out: line => out.push(line) }); assert.equal(code, 0); return JSON.parse(out[0]); };
  let result = await call();
  assert.equal(result.candidates.find(c => c.id === '100b').ready, true);
  assert.deepEqual(result.candidates.find(c => c.id === '101').blockedBy, ['100b']);
  const commit = spawnSync('git', ['commit', '--allow-empty', '-qm', '[执行] 合并 100b-test'], { cwd: root, encoding: 'utf8' }); assert.equal(commit.status, 0, commit.stderr);
  result = await call(); assert.equal(result.candidates.find(c => c.id === '101').ready, true);
});

test('next recent adjustment expires', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-adjust-age-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(root); mkdirSync(home);
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, shell: false }).status, 0);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 'auto' }));
  const at = 10000000, event = { event: 'concurrency-adjust', old: 1, new: 2, reason: 'ample resources', at, task: 'A' };
  writeFileSync(join(home, 'concurrency-state.json'), JSON.stringify({ limit: 2, consumed: [], window: [], event }));
  const call = minutes => nextTasks({ root, home, env: { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude') }, clock: () => at + minutes * 60000 });
  assert.deepEqual((await call(29)).concurrencyAdjust, event);
  assert.equal((await call(31)).concurrencyAdjust, null);
});
