import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeVerify, fullVerifyStatus, verifyFull } from '../../core/lib/verify-full.mjs';
import { taskAlive } from '../../core/lib/process.mjs';
test('按分支、成功验收和合并类型统计', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ar-full-')), home = join(root, 'home'); mkdirSync(home); mkdirSync(join(root, '.agent-router'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const rows = [{ event:'start', id:'a', repo:root, baseBranch:'main' }, { event:'start', id:'b', repo:root, baseBranch:'other' }, { event:'accepted', id:'a', merge:'one', at:1 }, { event:'full-verify', repo:root, branch:'main', ok:true, at:2 }, { event:'accepted', id:'a', merge:'two', at:3 }, { event:'accepted', id:'a', mode:'confirm', merge:null, at:4 }, { event:'accepted', id:'b', merge:'three', at:5 }, { event:'full-verify', repo:root, branch:'main', ok:false, at:6 }];
  writeFileSync(join(home, 'runs.jsonl'), rows.map(x => JSON.stringify(x)).join('\n')+'\n');
  const value = await fullVerifyStatus({ home, root, branch:'main' }); assert.equal(value.mergedSince, 1); assert.equal(value.last.ok, false); assert.equal(value.every, 5);
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ fullVerifyEvery:0 })); await assert.rejects(fullVerifyStatus({home, root, branch:'main'}), /项目配置无效：fullVerifyEvery/);
});

test('后台锁使用真实创建时间，查询失败时保守保留', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-lock-')), home = join(root, 'home');
  mkdirSync(home); mkdirSync(join(root, '.agent-router'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ verify: ['node -e "process.exit(0)"'] }));
  git('add', '.agent-router/project.json'); git('commit', '-m', 'init');
  const script = join(root, 'child.cjs');
  writeFileSync(script, "process.on('message', () => setTimeout(() => process.exit(), 1500));");
  const branch = git('branch', '--show-current').stdout.trim(), lock = join(root, '.agent-runs', '_verify', 'running.json');
  for (const unavailable of [false, true]) {
    const future = Date.now() + 5000;
    const alive = start => taskAlive(start, { alive: () => true, created: async () => unavailable ? null : future });
    const args = { root, home, scriptPath: script, env: process.env, detach: true, out: () => {}, created: async () => unavailable ? null : future, alive };
    await verifyFull(args);
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).started, unavailable ? Number.MAX_SAFE_INTEGER : future);
    assert.ok((await fullVerifyStatus({ root, home, branch, alive })).running);
    await assert.rejects(verifyFull(args), /正在运行/);
    await new Promise(resolve => setTimeout(resolve, 1800));
    rmSync(lock);
  }
});


test('additional verification coverage', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ar-full-empty-')), home = join(root, 'home'); mkdirSync(home); mkdirSync(join(root, '.agent-router'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.deepEqual(await fullVerifyStatus({ home, root, branch: 'main' }), { last: null, running: null, mergedSince: 0, every: 5 });
  const rows = [{ event: 'start', id: 'a', repo: root, baseBranch: 'main' }, { event: 'accepted', id: 'a', merge: 'abc', at: 1 }, { event: 'full-verify', repo: root, branch: 'main', ok: false, at: 2 }];
  writeFileSync(join(home, 'runs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ fullVerifyEvery: 2 }));
  const value = await fullVerifyStatus({ home, root, branch: 'main' }); assert.equal(value.mergedSince, 1); assert.equal(value.every, 2);
  for (const invalid of [-1, 1.5, '5', null]) { writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ fullVerifyEvery: invalid })); await assert.rejects(fullVerifyStatus({ home, root, branch: 'main' }), /fullVerifyEvery/); }
});


test('注入短超时后记录失败', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ar-full-timeout-')), home = join(root, 'home'), dir = join(root, '.agent-runs', '_verify', 'test');
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(home); mkdirSync(join(root, '.agent-router')); mkdirSync(dir, { recursive: true });
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(root, '.agent-router', 'project.json'), JSON.stringify({ verify: ['node -e "setTimeout(()=>{},10000)"'] }));
  git('add', '.agent-router/project.json'); git('commit', '-m', 'init');
  const messages = [], line = 'node -e "setTimeout(()=>{},10000)"';
  const result = await executeVerify({ root, home, env: process.env, commands: [line], startedAt: Date.now(), dir, timeoutMs: 200, out: x => messages.push(x) });
  assert.equal(result.ok, false); assert.equal(result.exitCode, 1); assert.equal(result.failed, line);
  assert.match(messages.at(-1), /全量验收失败/); assert.match(readFileSync(result.log, 'utf8'), /已结束进程树/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).failed, line);
  const row = JSON.parse(readFileSync(join(home, 'runs.jsonl'), 'utf8').trim().split('\n').at(-1)); assert.equal(row.ok, false); assert.equal(row.failed, line);
});
