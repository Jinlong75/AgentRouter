import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// 工作区外写入检查（协议 12.4）的集成测试：隔离的 AGENT_ROUTER_HOME、隔离的 USERPROFILE / HOME
// （os.homedir() 跟着变）、系统临时目录里的仓库、fake 执行者，max_retries 为 2；
// 子进程跑 core/ar.mjs，不碰真实安装、配置、用户目录与进程，也不手动派发。
// 新文件由测试自己在执行者运行期间（fake 的 releaseFile 等待时）写进隔离的用户目录。
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

function fixture(t, profileExtra = {}, { userHome, wait = false } = {}) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-outside-079-'));
  const repo = path.join(base, 'repo 079'), home = path.join(base, 'home 079');
  // userHome 为 'missing' 时用一个不存在的目录（隔离在 base 里，由 base 一并清理）。
  const user = path.join(base, userHome === 'missing' ? 'user missing' : 'user 079');
  const release = path.join(base, 'release');
  mkdirSync(repo);
  mkdirSync(home);
  if (userHome !== 'missing') mkdirSync(user);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, USERPROFILE: user, HOME: user, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'HOMEDRIVE', 'HOMEPATH']) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '工作区外测试']);
  git(repo, ['config', 'user.email', 'outside-079@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  commitAll(repo, '初始提交');
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0, ...(wait ? { releaseFile: release, releaseTimeoutMs: 30000 } : {}), ...profileExtra };
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile } }));
  write(path.join(repo, 'docs/specs/001-外写.md'), [
    '---', 'id: 979', 'title: 工作区外写入', 'type: code', 'allowed_paths:', '  - src/**', 'verify:', `  - ${DONE_CHECK}`, 'max_retries: 2', '---', '', '工作区外写入测试正文。', '',
  ].join('\n'));
  commitAll(repo, '任务说明');
  const f = { base, repo, home, user, release, env };
  // during：核心启动执行者之后（清单里出现 spawned，此时"之前"的那次列目录已经做完）、放行执行者之前调用。
  // 无论 during 是否出错都要放行，免得假执行者一直等。
  f.ar = (args, during) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '', done = false, hookError = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, 120000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { done = true; clearTimeout(timer); hookError ? reject(hookError) : resolve({ code, stdout, stderr }); });
    if (during) {
      (async () => {
        const started = Date.now();
        while (!done && !rows(home).some(row => row.event === 'spawned')) {
          if (Date.now() - started > 60000) throw Error('等不到执行者启动');
          await delay(50);
        }
        try { await during(); } finally { writeFileSync(release, 'go'); }
      })().catch(error => { hookError = error; writeFileSync(release, 'go'); });
    }
  });
  f.list = name => {
    const start = rows(home).find(row => row.event === 'start' && row.name === name);
    return rows(home).filter(row => row.id === start.id);
  };
  f.progress = name => readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  f.gateJson = (name, n) => JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'attempts', String(n), 'gate.json'), 'utf8'));
  t.after(async () => {
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(realpathSync.native(os.tmpdir()), base).startsWith('ar-outside-079-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}
test('执行者运行期间用户目录根出现新文件：门禁未通过、只 1 次尝试、退出码 3、进度有那一行、--json 带 outsideWrites', async t => {
  const f = fixture(t, DONE_WRITE, { wait: true });
  const result = await f.ar(['dispatch', 'docs/specs/001-外写.md', '--name', '外写一', '--json'], () => write(path.join(f.user, 'stray-config.json'), '{}'));
  assert.equal(result.code, 3, result.stderr + result.stdout);
  const json = JSON.parse(result.stdout);
  assert.equal(json.exit, 3);
  assert.equal(json.gate.ok, false);
  assert.deepEqual(json.outsideWrites, { added: [{ root: 'user', name: 'stray-config.json', type: 'file' }] });

  const list = f.list('外写一');
  assert.equal(list.filter(row => row.event === 'attempt').length, 1, '清单里只有 1 个 attempt');
  const gateJson = f.gateJson('外写一', 1);
  assert.equal(gateJson.ok, false);
  assert.deepEqual(gateJson.outsideWrites, { checked: true, added: [{ root: 'user', name: 'stray-config.json', type: 'file' }] });
  assert.equal(gateJson.summary, '工作区外出现新文件：user/stray-config.json');
  assert.deepEqual(gateJson.scope.outside, [], '工作区内的改动没有越界，失败只因为工作区外写入');
  assert.ok(gateJson.commands.every(command => command.exit === 0), '验收命令本身是通过的');
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.repo, '.agent-runs', '外写一', 'gate.json'), 'utf8')).outsideWrites, gateJson.outsideWrites, '顶层 gate.json 是最新一次');

  const attemptEnd = list.filter(row => row.event === 'attempt-end');
  assert.equal(attemptEnd.length, 1);
  assert.equal(attemptEnd[0].gate, false);
  assert.deepEqual(attemptEnd[0].outsideWrites, gateJson.outsideWrites, '跑了门禁时 attempt-end 带同样的字段');
  const end = list.at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.exit, 3);
  assert.equal(end.attempts, 1);
  const progress = f.progress('外写一');
  assert.ok(progress.includes('工作区外出现新文件：user/stray-config.json；不再自动重试，请核对这些文件是谁写的'), progress);
  assert.ok(progress.includes('可能是同时进行的其他任务或其他程序'));
  assert.ok(!progress.includes('=== 第 2 次尝试'));

  // ar wait 的 --json 同样带上。
  const waited = await f.ar(['wait', '外写一', '--json']);
  assert.deepEqual(JSON.parse(waited.stdout).outsideWrites, json.outsideWrites);
  // 检查只提醒，不删除、不移动。
  assert.ok(existsSync(path.join(f.user, 'stray-config.json')));
});

test('没有新文件：门禁照常通过，gate.json 有 outsideWrites: { checked: true, added: [] }，attempt-end 与 --json 不带', async t => {
  const f = fixture(t, DONE_WRITE);
  write(path.join(f.user, 'already-here.txt'), '一开始就有');
  const result = await f.ar(['dispatch', 'docs/specs/001-外写.md', '--name', '外写二', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const json = JSON.parse(result.stdout);
  assert.equal(json.gate.ok, true);
  assert.ok(!('outsideWrites' in json));
  const gateJson = f.gateJson('外写二', 1);
  assert.equal(gateJson.ok, true);
  assert.deepEqual(gateJson.outsideWrites, { checked: true, added: [] });
  assert.equal(gateJson.summary, '门禁通过');
  const list = f.list('外写二');
  assert.ok(list.filter(row => row.event === 'attempt-end').every(row => !('outsideWrites' in row)));
  assert.ok(!f.progress('外写二').includes('工作区外'));
});

test('公共目录根出现 slots、config.json 的临时文件这类排除项：不算', async t => {
  const f = fixture(t, DONE_WRITE, { wait: true });
  const result = await f.ar(['dispatch', 'docs/specs/001-外写.md', '--name', '外写三', '--json'], () => {
    mkdirSync(path.join(f.home, 'slots'), { recursive: true });
    write(path.join(f.home, '.config-7f3a9c2e.tmp'), '{}');
    write(path.join(f.home, '.agent-tests-7f3a9c2e.tmp'), '{}');
    write(path.join(f.home, 'projects.json.9999.tmp'), '[]');
    mkdirSync(path.join(f.home, 'monitor'), { recursive: true });
  });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.ok(!('outsideWrites' in JSON.parse(result.stdout)));
  assert.deepEqual(f.gateJson('外写三', 1).outsideWrites, { checked: true, added: [] });
  assert.equal(f.list('外写三').filter(row => row.event === 'attempt').length, 1);
});

test('用户目录根出现 .tmp 临时文件：不标红、不挡重试，进度写一行"已忽略"，不带 outsideWrites', async t => {
  const f = fixture(t, DONE_WRITE, { wait: true });
  const result = await f.ar(['dispatch', 'docs/specs/001-外写.md', '--name', '外写临时', '--json'], () => {
    write(path.join(f.user, 'state.tmp.4242'), '{}');
    write(path.join(f.user, 'settings.json.tmp'), '{}');
  });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const json = JSON.parse(result.stdout);
  assert.equal(json.gate.ok, true);
  assert.ok(!('outsideWrites' in json));
  const gateJson = f.gateJson('外写临时', 1);
  assert.equal(gateJson.ok, true);
  assert.deepEqual(gateJson.outsideWrites, { checked: true, added: [] });
  assert.equal(gateJson.summary, '门禁通过');
  const list = f.list('外写临时');
  assert.equal(list.filter(row => row.event === 'attempt').length, 1);
  assert.ok(list.filter(row => row.event === 'attempt-end').every(row => !('outsideWrites' in row)));
  const progress = f.progress('外写临时');
  assert.ok(progress.includes('用户目录根出现临时文件（已忽略）：settings.json.tmp、state.tmp.4242'), progress);
  assert.ok(!progress.includes('工作区外出现新文件'));
  // 同时还有普通新文件时：普通文件照旧标红，临时文件仍只提一句。
  const g = fixture(t, DONE_WRITE, { wait: true });
  const mixed = await g.ar(['dispatch', 'docs/specs/001-外写.md', '--name', '外写混合', '--json'], () => {
    write(path.join(g.user, 'state.tmp.4242'), '{}');
    write(path.join(g.user, 'stray.txt'), 'x');
  });
  assert.equal(mixed.code, 3, mixed.stderr + mixed.stdout);
  assert.deepEqual(JSON.parse(mixed.stdout).outsideWrites, { added: [{ root: 'user', name: 'stray.txt', type: 'file' }] });
  assert.ok(g.progress('外写混合').includes('用户目录根出现临时文件（已忽略）：state.tmp.4242'));
  assert.ok(g.progress('外写混合').includes('工作区外出现新文件：user/stray.txt；不再自动重试'));
});

test('公共目录根出现不在名单里的新文件：算 home/<名字>', async t => {
  const f = fixture(t, DONE_WRITE, { wait: true });
  const result = await f.ar(['dispatch', 'docs/specs/001-外写.md', '--name', '外写四', '--json'], () => mkdirSync(path.join(f.home, 'stray-dir')));
  assert.equal(result.code, 3, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).outsideWrites, { added: [{ root: 'home', name: 'stray-dir', type: 'dir' }] });
  assert.equal(f.gateJson('外写四', 1).summary, '工作区外出现新文件：home/stray-dir');
});

test('没启用门禁的任务（任务文字派发）期间出现新文件：退出码不变、attempt-end.outsideWrites 有值', async t => {
  const f = fixture(t, {}, { wait: true });
  const result = await f.ar(['dispatch', '随便写点什么', '--name', '外写五', '--json'], () => write(path.join(f.user, 'text-task.txt'), 'x'));
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const json = JSON.parse(result.stdout);
  assert.equal(json.exit, 0);
  assert.deepEqual(json.outsideWrites, { added: [{ root: 'user', name: 'text-task.txt', type: 'file' }] });
  const list = f.list('外写五');
  assert.ok(!list.some(row => row.event === 'gating' || row.event === 'gate'), '没有跑门禁');
  const attemptEnd = list.filter(row => row.event === 'attempt-end');
  assert.equal(attemptEnd.length, 1);
  assert.equal(attemptEnd[0].ok, true);
  assert.deepEqual(attemptEnd[0].outsideWrites, { checked: true, added: [{ root: 'user', name: 'text-task.txt', type: 'file' }] });
  assert.equal(list.at(-1).exit, 0);
  assert.ok(f.progress('外写五').includes('工作区外出现新文件：user/text-task.txt；不再自动重试'));
});

test('执行者以非 0 退出（不跑门禁）期间出现新文件：退出码原样透传、不再重试、attempt-end 有值', async t => {
  const f = fixture(t, { exit: 5 }, { wait: true });
  const result = await f.ar(['dispatch', 'docs/specs/001-外写.md', '--name', '外写六', '--json'], () => write(path.join(f.user, 'crashed.txt'), 'x'));
  assert.equal(result.code, 5, result.stderr + result.stdout);
  const list = f.list('外写六');
  assert.equal(list.filter(row => row.event === 'attempt').length, 1, 'max_retries 为 2 也只跑 1 次');
  assert.ok(!list.some(row => row.event === 'gating'));
  const attemptEnd = list.filter(row => row.event === 'attempt-end');
  assert.equal(attemptEnd[0].exit, 5);
  assert.deepEqual(attemptEnd[0].outsideWrites, { checked: true, added: [{ root: 'user', name: 'crashed.txt', type: 'file' }] });
  assert.equal(list.at(-1).exit, 5);
});

test('没有新文件时执行者以非 0 退出：照常重试 3 次，attempt-end 不带 outsideWrites', async t => {
  const f = fixture(t, { exit: 5 });
  const result = await f.ar(['dispatch', 'docs/specs/001-外写.md', '--name', '外写七', '--json']);
  assert.equal(result.code, 5, result.stderr + result.stdout);
  const list = f.list('外写七');
  assert.equal(list.filter(row => row.event === 'attempt').length, 3);
  assert.ok(list.filter(row => row.event === 'attempt-end').every(row => !('outsideWrites' in row)));
});

test('用户目录读不了：没能核对，进度写一行原因，不影响门禁结果与重试', async t => {
  const f = fixture(t, DONE_WRITE, { userHome: 'missing' });
  const result = await f.ar(['dispatch', 'docs/specs/001-外写.md', '--name', '外写八', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const gateJson = f.gateJson('外写八', 1);
  assert.equal(gateJson.ok, true);
  assert.equal(gateJson.outsideWrites.checked, false);
  assert.match(gateJson.outsideWrites.error, /用户目录/);
  assert.ok(!('added' in gateJson.outsideWrites));
  const attemptEnd = f.list('外写八').filter(row => row.event === 'attempt-end');
  assert.deepEqual(attemptEnd[0].outsideWrites, gateJson.outsideWrites);
  assert.match(f.progress('外写八'), /工作区外写入没能核对：.*用户目录/);
  assert.ok(!('outsideWrites' in JSON.parse(result.stdout)));
});

test('没能核对不挡重试：门禁没过照常 3 次尝试', async t => {
  const f = fixture(t, {}, { userHome: 'missing' });
  const result = await f.ar(['dispatch', 'docs/specs/001-外写.md', '--name', '外写九', '--json']);
  assert.equal(result.code, 3, result.stderr + result.stdout);
  assert.equal(f.list('外写九').filter(row => row.event === 'attempt').length, 3);
});
