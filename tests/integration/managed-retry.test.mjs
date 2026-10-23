import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createManaged } from '../../app/src/main/managed.mjs';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// 071：软件托管扫描器对带 retry 的请求文件，只在"这一次尝试"结束后才删除（协议 14.3、14.4）。
// 隔离的 AGENT_ROUTER_HOME、手写清单与请求文件、fake 执行者；不碰真实安装与真实进程，不手动派发。
const root = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(root, 'core/ar.mjs');
const tmp = realpathSync.native(os.tmpdir());

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
async function until(fn, label, timeout = 30000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}
const rowsOf = home => {
  try { return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
};

function sandbox(t) {
  const base = mkdtempSync(path.join(tmp, 'ar-managed-retry-071-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo');
  mkdirSync(path.join(home, 'managed'), { recursive: true });
  mkdirSync(repo);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  const f = { base, home, repo, env, managedDir: path.join(home, 'managed'), services: [], errors: [] };
  f.service = async () => {
    const s = await createManaged(root, env, e => f.errors.push(e), () => {});
    f.services.push(s);
    return s;
  };
  f.events = events => writeFileSync(path.join(home, 'runs.jsonl'), events.map(e => JSON.stringify({ v: 2, ...e })).join('\n') + '\n');
  f.request = (id, suffix, body) => {
    const file = path.join(f.managedDir, `${id}.${suffix}.json`);
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    return file;
  };
  t.after(async () => {
    f.services.forEach(s => s.close());
    // 只结束命令行里带着本临时目录的进程，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(tmp, base).startsWith('ar-managed-retry-071-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

const start = id => ({ event: 'start', id, name: 'n', at: 1 });
const end = id => ({ event: 'end', id, exit: 1, at: 2 });
const resume = (id, n) => ({ event: 'resume', id, n, at: 3 });
const interrupted = id => ({ event: 'interrupted', id, at: 4 });

// 扫描一次并返回请求文件是否还在。
async function scanned(f, file) {
  const s = await f.service();
  s.scan();
  return existsSync(file);
}

test('带 retry 的 claimed：清单只有上一次的 start … end → 不删', async t => {
  const f = sandbox(t);
  f.events([start('a'), end('a')]);
  const file = f.request('a', 'claimed', { retry: { n: 2, note: null, profile: 'fake' } });
  assert.equal(await scanned(f, file), true);
});

test('带 retry 的 claimed：已有 resume n=2 但还没结束 → 不删', async t => {
  const f = sandbox(t);
  f.events([start('a'), end('a'), resume('a', 2)]);
  const file = f.request('a', 'running', { retry: { n: 2 } });
  assert.equal(await scanned(f, file), true);
});

test('带 retry 的请求：resume n=2 之后有 end → 删', async t => {
  const f = sandbox(t);
  f.events([start('a'), end('a'), resume('a', 2), end('a')]);
  const file = f.request('a', 'running', { retry: { n: 2 } });
  assert.equal(await scanned(f, file), false);
});

test('带 retry 的请求：resume n=2 之后有 interrupted → 删', async t => {
  const f = sandbox(t);
  f.events([start('a'), end('a'), resume('a', 2), interrupted('a')]);
  const file = f.request('a', 'running', { retry: { n: 2 } });
  assert.equal(await scanned(f, file), false);
});

test('带 retry 的请求：清单只有 resume n=3 之后的 end（编号不同）→ 不删', async t => {
  const f = sandbox(t);
  f.events([start('a'), end('a'), resume('a', 3), end('a')]);
  const file = f.request('a', 'claimed', { retry: { n: 2 } });
  assert.equal(await scanned(f, file), true);
});

test('带 retry 的请求：别的任务 id 的 resume / end 不算', async t => {
  const f = sandbox(t);
  f.events([start('a'), end('a'), start('b'), resume('b', 2), end('b')]);
  const file = f.request('a', 'claimed', { retry: { n: 2 } });
  assert.equal(await scanned(f, file), true);
});

test('retry.n 不是正整数：按没有 retry 处理（已有 end 就删）', async t => {
  const f = sandbox(t);
  f.events([start('a'), end('a')]);
  const file = f.request('a', 'claimed', { retry: { n: 0 } });
  assert.equal(await scanned(f, file), false);
});

test('没有 retry 的请求文件：已有 end → 删，没有 → 不删（与改动前相同）', async t => {
  const f = sandbox(t);
  f.events([start('a'), end('a'), start('b')]);
  const done = f.request('a', 'claimed', { v: 1 });
  const going = f.request('b', 'running', { v: 1 });
  const s = await f.service();
  s.scan();
  assert.equal(existsSync(done), false);
  assert.equal(existsSync(going), true);
});

test('请求文件读不出 JSON：按没有 retry 处理（已有 end 就删，没有就留）', async t => {
  const f = sandbox(t);
  f.events([start('a'), end('a'), start('b')]);
  const done = f.request('a', 'rejected', '不是 JSON');
  const going = f.request('b', 'rejected', '{半截');
  const s = await f.service();
  s.scan();
  assert.equal(existsSync(done), false);
  assert.equal(existsSync(going), true);
});

test('同一个扫描器：resume + end 随后追加到清单时，下一轮扫描才删除', async t => {
  const f = sandbox(t);
  f.events([start('a'), end('a')]);
  const file = f.request('a', 'claimed', { retry: { n: 2 } });
  const s = await f.service();
  s.scan();
  assert.equal(existsSync(file), true);
  const lines = [resume('a', 2), end('a')].map(e => JSON.stringify({ v: 2, ...e })).join('\n') + '\n';
  writeFileSync(path.join(f.home, 'runs.jsonl'), readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8') + lines);
  s.scan();
  assert.equal(existsSync(file), false);
});

// 端到端：软件开着时，对已结束的任务做 ar retry --detach 必须真正启动，且这一次结束后请求文件才被删。
test('端到端：软件开着时 ar retry --detach 真正启动（resume n=2、之后 end），请求文件在这一次结束后才删', async t => {
  const f = sandbox(t);
  git(f.repo, ['init', '-q']);
  git(f.repo, ['config', 'user.name', '托管重试测试']);
  git(f.repo, ['config', 'user.email', 'managed-retry-071@example.test']);
  git(f.repo, ['config', 'commit.gpgsign', 'false']);
  git(f.repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(path.join(f.repo, '.gitignore'), '.agent-runs/\n');
  writeFileSync(path.join(f.repo, 'README.md'), '# 说明\n');
  git(f.repo, ['add', '.gitignore', 'README.md']);
  git(f.repo, ['commit', '-q', '-m', '初始提交']);
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'say', text: '第一次尝试' }], report: '假汇报\n', exit: 0,
    attempts: { 2: { events: [{ kind: 'say', text: '重试完成' }], delayMs: 600 } } };
  writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile } }));

  const ar = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: f.repo, env: f.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, 90000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });

  const s = await f.service();
  s.start();
  const dispatched = await ar(['dispatch', '第一次任务', '--name', '托管重试', '--json']);
  assert.equal(dispatched.code, 0, dispatched.stderr + dispatched.stdout);
  const first = rowsOf(f.home).find(r => r.event === 'start');
  assert.ok(first, '清单里有 start');
  const id = first.id;
  await until(() => rowsOf(f.home).some(r => r.id === id && r.event === 'end'), '第一次 end');

  const retried = await ar(['retry', '托管重试', '--note', '再试一次', '--detach', '--json']);
  assert.equal(retried.code, 0, retried.stderr + retried.stdout);
  assert.equal(JSON.parse(retried.stdout).n, 2);

  const resumed = await until(() => rowsOf(f.home).find(r => r.id === id && r.event === 'resume'), 'resume 记录（软件不能把请求文件提前删掉）');
  assert.equal(resumed.n, 2);
  await until(() => {
    const events = rowsOf(f.home).filter(r => r.id === id).map(r => r.event);
    return events.lastIndexOf('end') > events.lastIndexOf('resume');
  }, '这一次的 end');
  // 这一次结束后，扫描器把请求文件删掉。
  await until(() => !readdirSync(f.managedDir).length, '请求文件被扫描器删除');
  assert.deepEqual(f.errors, []);
});
