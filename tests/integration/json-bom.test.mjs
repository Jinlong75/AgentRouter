import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupProcesses, recordedStarts } from '../fixtures/identity.mjs';

// 062：核心读取的 JSON 文件开头的 UTF-8 BOM 一律忽略。每个用例在系统临时目录里建隔离公共目录与 git 仓库，
// 用 fake 执行者、子进程跑 core/ar.mjs；不碰真实安装、配置与进程（docs/roles/worker.md 的隔离规则）。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const BOM = '\uFEFF';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
// 配置与项目配置一律用 Node 写（writeFileSync，不经 PowerShell）；带 BOM 的内容在 JSON 文本开头拼一个 U+FEFF。
const writeJson = (file, value, { bom = false } = {}) => write(file, `${bom ? BOM : ''}${JSON.stringify(value, null, 2)}\n`);
const commitAll = (root, message) => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
};
const rows = home => {
  try {
    return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
};

function fixture(t) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar BOM 读取 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  mkdirSync(repo);
  mkdirSync(home);
  // 隔离确认：公共目录与仓库都必须在系统临时目录里，才允许跑任何 ar 命令。
  for (const dir of [base, repo, home]) {
    const rel = path.relative(path.resolve(os.tmpdir()), dir);
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `隔离目录必须在系统临时目录里：${dir}`);
  }
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  // 派发用的环境变量按不区分大小写清掉，避免开发终端里的设置漏进来。
  const drop = new Set(['ar_dry_run', 'codex_dry_run', 'node_options', 'electron_run_as_node', 'ar_test_agent', 'codex_dispatch_test_agent']);
  for (const key of Object.keys(env)) if (drop.has(key.toLowerCase())) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'BOM 读取测试']);
  git(repo, ['config', 'user.email', 'json-bom@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  commitAll(repo, '初始提交');
  const profile = { adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'say', text: '假执行者已完成。' }], report: 'OK\n', exit: 0 };
  const f = { base, repo, home, env, profile };
  f.setProfile = value => {
    Object.assign(profile, value);
    // config.json 带 BOM（058 事故里 PowerShell 写出来的形态），默认执行者 fake。
    writeJson(path.join(home, 'config.json'), {
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: profile },
    }, { bom: true });
  };
  f.setProfile({});
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
  // 派发前确认（worker.md "手动跑 ar 的三条硬规则"第 2 条同样用在自动测试里）：默认执行者是 fake，没有回退到内置默认。
  f.assertFakeDefault = async () => {
    const listed = await f.ar(['agents', 'list', '--json']);
    assert.equal(listed.code, 0, listed.stderr + listed.stdout);
    const value = JSON.parse(listed.stdout);
    const row = value.agents.find(a => a.name === 'fake');
    assert.ok(row, `agents list 没认出 fake：${listed.stdout}`);
    assert.equal(row.default, true);
    assert.equal(row.adapter, 'fake');
    assert.doesNotMatch(listed.stdout + listed.stderr, /无法读取|按内置默认/);
    return value;
  };
  f.gateJson = name => JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'gate.json'), 'utf8'));
  t.after(async () => {
    // 只结束本 fixture 清单里记录的派发进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { recorded: recordedStarts(rows(home), script, since), diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar BOM 读取 '));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return f;
}

test('config.json 带 BOM：ar agents list 认出 fake，没有"无法读取"提示', async t => {
  const f = fixture(t);
  await f.assertFakeDefault();
  const text = await f.ar(['agents', 'list']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /fake/);
  assert.match(text.stdout, /默认/);
  assert.doesNotMatch(text.stdout + text.stderr, /无法读取|按内置默认/);
});

test('config.json 带 BOM：fake 派发正常，不回退到内置默认', async t => {
  const f = fixture(t);
  await f.assertFakeDefault();
  const result = await f.ar(['dispatch', '只回复 OK', '--name', 'BOM 派发', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /无法读取|按内置默认/);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.exit, 0);
  assert.doesNotMatch(value.lines.join('\n'), /无法读取|按内置默认/);
  const start = rows(f.home).find(row => row.event === 'start' && row.name === 'BOM 派发');
  assert.equal(start.profile, 'fake');
  assert.equal(start.adapter, 'fake');
  assert.equal(readFileSync(path.join(f.repo, '.agent-runs', 'BOM 派发', 'report.md'), 'utf8'), 'OK\n');
});

test('project.json 带 BOM：verify 生效（门禁运行了那条命令）', async t => {
  const f = fixture(t);
  // 项目配置带 BOM：verify 写一个标记文件，证明命令真的跑过；allowedPaths 只放行 src/**。
  writeJson(path.join(f.repo, '.agent-router', 'project.json'), {
    name: 'BOM 项目', baseBranch: 'main', allowedPaths: ['src/**'],
    verify: ['node -e "require(\'fs\').writeFileSync(\'verify-ran.marker\',\'ok\')"'],
  }, { bom: true });
  write(path.join(f.repo, 'docs/specs/001-BOM 门禁.md'), ['---', 'id: 001', 'title: BOM 门禁测试', 'type: code', '---', '', '测试说明正文。', ''].join('\n'));
  commitAll(f.repo, '提交 BOM 门禁说明');
  f.setProfile({ writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改 src/a.js' });
  await f.assertFakeDefault();

  const result = await f.ar(['dispatch', 'docs/specs/001-BOM 门禁.md', '--name', 'BOM 门禁', '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.deepEqual(value.gate, { ok: true, summary: '门禁通过' });

  // 项目配置里的验收命令真的运行了（不是"列入命令表就算数"）。
  assert.equal(readFileSync(path.join(f.repo, 'verify-ran.marker'), 'utf8'), 'ok');
  const saved = f.gateJson('BOM 门禁');
  assert.equal(saved.ok, true);
  assert.equal(saved.commands.length, 1);
  assert.match(saved.commands[0].line, /verify-ran\.marker/);
  assert.equal(saved.commands[0].exit, 0);
  const progress = readFileSync(path.join(f.repo, '.agent-runs', 'BOM 门禁', 'progress.log'), 'utf8');
  assert.match(progress, /门禁命令：.*verify-ran\.marker.* → 通过/);
});
