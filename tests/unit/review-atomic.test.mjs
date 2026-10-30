import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { reviewCommand } from '../../core/lib/review.mjs';

// 240：Windows 上 review.json 的原子替换可能收到 EPERM / EBUSY（192 同类问题，占用来源尚未确认）。
// 用 syncBuiltinESMExports 把替换过的 fs.renameSync 同步到 review.mjs 的具名导入（不新增产品接口）；
// 每个用例结束都恢复，node --test 每个文件一个进程，不会污染其他测试文件。
const realRename = fs.renameSync;
const restoreRename = () => { fs.renameSync = realRename; syncBuiltinESMExports(); };
function mockRename(t, handler) {
  const state = { calls: 0 };
  fs.renameSync = (from, to) => { state.calls += 1; return handler(from, to, state.calls); };
  syncBuiltinESMExports();
  t.after(restoreRename);
  return state;
}
// 记录 Atomics.wait 的间隔参数，同时真实等待，墙钟断言仍然有效；用例结束恢复。
const realWait = Atomics.wait;
function mockWait(t) {
  const timeouts = [];
  Atomics.wait = (typedArray, index, value, timeout) => { timeouts.push(timeout); return realWait(typedArray, index, value, timeout); };
  t.after(() => { Atomics.wait = realWait; });
  return timeouts;
}
// rm 失败注入：临时文件删不掉；返回恢复函数，用例结束前显式恢复，t.after 再兜底一次（恢复是幂等的）。
const realRm = fs.rmSync;
function mockRmFailure(t, code) {
  fs.rmSync = () => { throw Object.assign(new Error(`模拟 ${code}`), { code }); };
  syncBuiltinESMExports();
  const restore = () => { fs.rmSync = realRm; syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}
const failWith = code => () => { throw Object.assign(new Error(`模拟 ${code}`), { code }); };
const windowsOnly = { skip: process.platform !== 'win32' ? '重试只在 Windows 上生效' : false };

const oldReview = {
  v: 1,
  reviewer: 'rev-x',
  verdict: 'concerns',
  summary: '摘要',
  issues: [
    { id: 'R1-1', severity: 'high', file: 'src/a.js', line: 3, title: '问题一', detail: '细节', confirmation: null },
    { id: 'R1-2', severity: 'low', file: 'src/b.js', line: 9, title: '问题二', detail: '', confirmation: null },
  ],
};

// 独立临时目录里的最小任务现场：清单里一条 start，任务目录里一份 review.json；不碰真实 HOME / 配置 / 执行者。
function makeTask(t) {
  const base = mkdtempSync(join(tmpdir(), 'ar-review-atomic-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const dir = join(repo, '.agent-runs', '任务 一');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  const file = join(dir, 'review.json');
  writeFileSync(file, `${JSON.stringify(oldReview, null, 2)}\n`);
  writeFileSync(join(home, 'runs.jsonl'), `${JSON.stringify({ v: 2, event: 'start', repo, name: '任务 一', id: 'id-1', dir, started: Date.now() })}\n`);
  return { base, repo, home, dir, file };
}
const temps = dir => readdirSync(dir).filter(name => /^review\.json\.\d+\.tmp$/.test(name));
const events = home => {
  try { return readFileSync(join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.event === 'review-confirm'); } catch { return []; }
};
const confirm = (task, extra = ['--by', 'lead', '--note', '已复核']) => reviewCommand(['confirm', '任务 一', 'R1-1', 'valid', ...extra], { homes: [task.home], root: task.repo, env: {} });

test('首次就成功：只调用一次 rename，经 review confirm 写入正确 note/by，追加一条确认事件，不留下临时文件', async t => {
  const task = makeTask(t);
  const renames = mockRename(t, (from, to) => realRename(from, to));
  const result = await confirm(task);
  assert.equal(renames.calls, 1);
  assert.deepEqual([result.result.ok, result.result.issue, result.result.result, result.result.by, result.result.note], [true, 'R1-1', 'valid', 'lead', '已复核']);
  const written = JSON.parse(readFileSync(task.file, 'utf8'));
  assert.deepEqual({ ...written.issues[0], confirmation: undefined }, { ...oldReview.issues[0], confirmation: undefined }, '其他字段原样保留');
  assert.deepEqual(written.issues[1], oldReview.issues[1], '未确认的问题不变');
  assert.deepEqual(
    { result: written.issues[0].confirmation.result, by: written.issues[0].confirmation.by, note: written.issues[0].confirmation.note },
    { result: 'valid', by: 'lead', note: '已复核' },
  );
  assert.ok(Number.isSafeInteger(written.issues[0].confirmation.at), '确认时间存在');
  const rows = events(task.home);
  assert.equal(rows.length, 1, '成功时只追加一条 review-confirm');
  assert.deepEqual(
    { issue: rows[0].issue, severity: rows[0].severity, result: rows[0].result, by: rows[0].by, reviewer: rows[0].reviewer },
    { issue: 'R1-1', severity: 'high', result: 'valid', by: 'lead', reviewer: 'rev-x' },
  );
  assert.deepEqual(temps(task.dir), []);
});

test('首次 EPERM、之后可成功：等待 50ms 后重试，旧文件完整换成含确认的新 JSON，无临时文件', windowsOnly, async t => {
  const task = makeTask(t);
  const before = readFileSync(task.file);
  const waits = mockWait(t);
  const renames = mockRename(t, (from, to, calls) => {
    if (calls === 1) failWith('EPERM')();
    return realRename(from, to);
  });
  const started = Date.now();
  const result = await confirm(task);
  const elapsed = Date.now() - started;
  assert.equal(result.result.ok, true);
  assert.equal(renames.calls, 2);
  assert.ok(elapsed >= 40, `两次尝试之间应等待约 50ms（实际 ${elapsed}ms）`);
  assert.deepEqual(waits, [50], '重试间隔应精确为 50ms');
  const written = JSON.parse(readFileSync(task.file, 'utf8'));
  assert.equal(written.issues[0].confirmation.result, 'valid');
  assert.equal(written.issues[0].confirmation.by, 'lead');
  assert.deepEqual(written.issues[1], oldReview.issues[1]);
  assert.notDeepEqual(readFileSync(task.file), before, '旧内容已被完整的新内容替换');
  assert.equal(events(task.home).length, 1, '重试成功时确认事件只追加一条');
  assert.deepEqual(temps(task.dir), []);
});

test('EBUSY 短暂占用同样有界重试', windowsOnly, async t => {
  const task = makeTask(t);
  const waits = mockWait(t);
  const renames = mockRename(t, (from, to, calls) => {
    if (calls <= 2) failWith('EBUSY')();
    return realRename(from, to);
  });
  await confirm(task);
  assert.equal(renames.calls, 3);
  assert.deepEqual(waits, [50, 50], '每次重试间隔应精确为 50ms');
  assert.equal(JSON.parse(readFileSync(task.file, 'utf8')).issues[0].confirmation.result, 'valid');
  assert.equal(events(task.home).length, 1);
  assert.deepEqual(temps(task.dir), []);
});

test('持续 EPERM：最多 5 次调用、四次 50ms 等待，抛出原错误，旧字节不变，不追加确认事件，临时文件清理', windowsOnly, async t => {
  const task = makeTask(t);
  const before = readFileSync(task.file);
  const waits = mockWait(t);
  const renames = mockRename(t, failWith('EPERM'));
  const started = Date.now();
  await assert.rejects(confirm(task), error => error.code === 'EPERM' && error.message === '模拟 EPERM');
  const elapsed = Date.now() - started;
  assert.equal(renames.calls, 5);
  assert.ok(elapsed >= 150 && elapsed < 3000, `额外等待应有界（实际 ${elapsed}ms）`);
  assert.deepEqual(waits, [50, 50, 50, 50], '最多重试 4 次，每次间隔精确为 50ms');
  assert.deepEqual(readFileSync(task.file), before, '持续失败时旧文件字节不变');
  assert.deepEqual(events(task.home), [], '持续失败不得追加确认事件');
  assert.deepEqual(temps(task.dir), [], '可清理的临时文件应清理');
});

test('rename 持续失败且临时文件也删不掉：保留原 EPERM，临时文件如实留在原处', async t => {
  const task = makeTask(t);
  const before = readFileSync(task.file);
  const restore = mockRmFailure(t, 'EACCES');
  mockRename(t, failWith('EPERM'));
  try {
    await assert.rejects(
      confirm(task),
      error => error.code === 'EPERM' && error.message === '模拟 EPERM',
      '清理失败不能盖过 rename 的原错误',
    );
  } finally { restore(); }
  assert.deepEqual(readFileSync(task.file), before, '旧文件保持原样');
  assert.deepEqual(events(task.home), []);
  const left = temps(task.dir);
  assert.equal(left.length, 1, '删不掉的临时文件应如实保留');
  assert.equal(JSON.parse(readFileSync(join(task.dir, left[0]), 'utf8')).issues[0].confirmation.result, 'valid');
});

test('其他错误码（EACCES、ENOENT、EXDEV）不重试，立即抛出，旧文件不变', async t => {
  for (const code of ['EACCES', 'ENOENT', 'EXDEV']) {
    const task = makeTask(t);
    const before = readFileSync(task.file);
    const renames = mockRename(t, failWith(code));
    await assert.rejects(confirm(task), error => error.code === code, code);
    assert.equal(renames.calls, 1, code);
    assert.deepEqual(readFileSync(task.file), before, code);
    assert.deepEqual(events(task.home), [], code);
    assert.deepEqual(temps(task.dir), [], code);
  }
});

// 非 Windows 路径：不能在当前进程里改 process.platform（会影响并行测试），放到子进程里做。
test('非 Windows 路径保持原行为：EPERM 不重试，只调用一次', t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-review-atomic-linux-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  const script = `
import fs from 'node:fs';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'linux' });
const home = process.env.AR_REVIEW_ATOMIC_HOME, repo = process.env.AR_REVIEW_ATOMIC_REPO;
const dir = join(repo, '.agent-runs', '任务 一');
mkdirSync(dir, { recursive: true });
mkdirSync(home, { recursive: true });
const review = { v: 1, reviewer: 'rev-x', verdict: 'concerns', summary: '摘要', issues: [{ id: 'R1-1', severity: 'high', file: 'src/a.js', line: 3, title: '问题一', detail: '', confirmation: null }] };
const before = JSON.stringify(review, null, 2) + '\\n';
writeFileSync(join(dir, 'review.json'), before);
writeFileSync(join(home, 'runs.jsonl'), JSON.stringify({ v: 2, event: 'start', repo, name: '任务 一', id: 'id-1', dir, started: Date.now() }) + '\\n');
const { reviewCommand } = await import(process.env.AR_REVIEW_ATOMIC_MODULE);
let calls = 0;
const real = fs.renameSync;
fs.renameSync = () => { calls += 1; throw Object.assign(new Error('模拟 EPERM'), { code: 'EPERM' }); };
syncBuiltinESMExports();
let code = null;
try { await reviewCommand(['confirm', '任务 一', 'R1-1', 'valid'], { homes: [home], root: repo, env: {} }); } catch (error) { code = error.code; }
fs.renameSync = real;
syncBuiltinESMExports();
console.log(JSON.stringify({ platform: process.platform, calls, code, left: readdirSync(dir), text: readFileSync(join(dir, 'review.json'), 'utf8') }));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, AR_REVIEW_ATOMIC_HOME: home, AR_REVIEW_ATOMIC_REPO: repo, AR_REVIEW_ATOMIC_MODULE: new URL('../../core/lib/review.mjs', import.meta.url).href },
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.platform, 'linux');
  assert.equal(out.calls, 1);
  assert.equal(out.code, 'EPERM');
  assert.deepEqual(out.left, ['review.json']);
  assert.equal(out.text, JSON.stringify({ v: 1, reviewer: 'rev-x', verdict: 'concerns', summary: '摘要', issues: [{ id: 'R1-1', severity: 'high', file: 'src/a.js', line: 3, title: '问题一', detail: '', confirmation: null }] }, null, 2) + '\n');
});
