import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGate } from '../../core/lib/gate.mjs';
import { headSha } from '../../core/lib/git.mjs';
import { pidAlive, processList } from '../../core/lib/process.mjs';

// 每个用例在系统临时目录里建一个名字含中文与空格的仓库；不碰真实安装与真实进程。
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
const tempDir = (t, prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};
const fixture = t => {
  const root = tempDir(t, 'ar 门禁 测试 ');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', '门禁测试']);
  git(root, ['config', 'user.email', 'gate@example.test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']); // 不按本机全局设置转换换行，避免测试输出被警告刷屏。
  write(path.join(root, 'src/a.js'), '初始\n');
  write(path.join(root, 'README.md'), '# 说明\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', '初始提交']);
  return { root, base: headSha(root), dir: path.join(root, '.agent-runs', 'run-1') };
};
const commitAll = (root, message) => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message]);
};
// mergeSpec 会对这些字段给出同样的默认值；用例只写关心的项。
const specOf = (overrides = {}) => ({
  allowed_paths: ['**'], verify: [], expect_commit: false, verify_timeout_min: 10, ...overrides,
});

test('全部通过：改动在范围内并已提交，验收命令退出 0', async t => {
  const { root, base, dir } = fixture(t);
  write(path.join(root, 'src/a.js'), '改过\n');
  commitAll(root, '改 src/a.js');

  const gate = await runGate({
    root, base, dir,
    spec: specOf({ allowed_paths: ['src/**'], expect_commit: true, verify: ['node -e "process.exit(0)"'] }),
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.summary, '门禁通过');
  assert.deepEqual(gate.commit, { required: true, ok: true });
  assert.deepEqual(gate.uncommitted, []);
  assert.deepEqual(gate.scope, { allowed: ['src/**'], changed: ['src/a.js'], outside: [] });
  assert.equal(gate.commands.length, 1);
  assert.equal(gate.commands[0].exit, 0);
  assert.equal(gate.commands[0].error, null);
  assert.equal(gate.commands[0].timedOut, false);
  assert.equal(gate.commands[0].argv[0], 'node');

  // gate.json 是合法 JSON，字段与协议 12.3 一致。
  const saved = JSON.parse(readFileSync(path.join(dir, 'gate.json'), 'utf8'));
  assert.deepEqual(saved, gate);
  assert.equal(saved.v, 1);
  assert.equal(saved.attempt, 1);
  assert.equal(typeof saved.at, 'number');
  assert.equal(typeof saved.ms, 'number');
  assert.equal(typeof saved.ok, 'boolean');
  assert.match(saved.base, /^[0-9a-f]{40,64}$/);
  assert.match(saved.head, /^[0-9a-f]{40,64}$/);
  assert.equal(typeof saved.commit.required, 'boolean');
  assert.equal(typeof saved.commit.ok, 'boolean');
  assert.ok(Array.isArray(saved.uncommitted));
  assert.ok(Array.isArray(saved.scope.allowed));
  assert.ok(Array.isArray(saved.scope.changed));
  assert.ok(Array.isArray(saved.scope.outside));
  assert.equal(typeof saved.summary, 'string');
  assert.ok(Array.isArray(saved.commands));
  for (const command of saved.commands) {
    assert.equal(typeof command.line, 'string');
    assert.ok(Array.isArray(command.argv) && command.argv.every(item => typeof item === 'string'));
    assert.equal(typeof command.exit, 'number');
    assert.equal(typeof command.ms, 'number');
    assert.equal(typeof command.timedOut, 'boolean');
    assert.equal(typeof command.output, 'string');
    assert.equal(typeof command.truncated, 'boolean');
    assert.equal(command.error, null);
    // pid 不写进 gate.json。
    assert.equal(Object.hasOwn(command, 'pid'), false);
  }
});

test('越界：允许范围外的改动记进 outside', async t => {
  const { root, base, dir } = fixture(t);
  write(path.join(root, 'src/a.js'), '改过\n');
  write(path.join(root, 'README.md'), '# 说明改过\n');
  commitAll(root, '改两处');

  const gate = await runGate({ root, base, dir, spec: specOf({ allowed_paths: ['src/**'], expect_commit: true }) });
  assert.deepEqual([...gate.scope.outside].sort(), ['README.md']);
  assert.deepEqual([...gate.scope.changed].sort(), ['README.md', 'src/a.js']);
  assert.equal(gate.ok, false);
  assert.equal(gate.summary, '改动超出范围：README.md');
});

test('重命名：新旧路径都算改动，只有新路径参与范围判断', async t => {
  const { root, base, dir } = fixture(t);
  mkdirSync(path.join(root, 'lib'));
  git(root, ['mv', 'src/a.js', 'lib/a.js']);
  commitAll(root, '重命名');

  const gate = await runGate({ root, base, dir, spec: specOf({ allowed_paths: ['src/**'], expect_commit: true }) });
  assert.ok(gate.scope.changed.includes('src/a.js'), gate.scope.changed.join('、'));
  assert.ok(gate.scope.changed.includes('lib/a.js'), gate.scope.changed.join('、'));
  assert.ok(gate.scope.outside.includes('lib/a.js'), gate.scope.outside.join('、'));
  assert.ok(!gate.scope.outside.includes('src/a.js'), gate.scope.outside.join('、'));
  assert.equal(gate.ok, false);
});

test('未提交：没提交的改动算失败，.agent-runs/ 里的文件不算', async t => {
  const { root, base, dir } = fixture(t);
  write(path.join(root, 'src/a.js'), '没提交\n');
  write(path.join(root, '.agent-runs/x/progress.log'), '进度\n');

  const gate = await runGate({ root, base, dir, spec: specOf() });
  assert.ok(gate.uncommitted.includes('src/a.js'), gate.uncommitted.join('、'));
  assert.ok(!gate.uncommitted.some(file => file.startsWith('.agent-runs/')), gate.uncommitted.join('、'));
  assert.equal(gate.ok, false);
  assert.equal(gate.summary, '有未提交的文件');
});

test('没提交：expect_commit 为真且 HEAD 等于 base 时失败', async t => {
  const { root, base, dir } = fixture(t);

  const gate = await runGate({ root, base, dir, spec: specOf({ expect_commit: true }) });
  assert.equal(gate.head, base);
  assert.deepEqual(gate.commit, { required: true, ok: false });
  assert.deepEqual(gate.scope.changed, []);
  assert.equal(gate.ok, false);
  assert.equal(gate.summary, '没有提交任何改动');
});

test('研究类：不要求提交、不改文件、没有验收命令时通过', async t => {
  const { root, base, dir } = fixture(t);

  const gate = await runGate({ root, base, dir, spec: specOf() });
  assert.deepEqual(gate.commit, { required: false, ok: true });
  assert.deepEqual(gate.uncommitted, []);
  assert.deepEqual(gate.commands, []);
  assert.equal(gate.ok, true);
  assert.equal(gate.summary, '门禁通过');
});

test('验收失败：一条失败不中断后续命令', async t => {
  const { root, base, dir } = fixture(t);
  const gate = await runGate({
    root, base, dir,
    spec: specOf({
      verify: [`node -e "console.log('x'); process.exit(1)"`, `node -e "console.log('second')"`],
    }),
  });
  assert.equal(gate.commands.length, 2);
  assert.equal(gate.commands[0].exit, 1);
  assert.match(gate.commands[0].output, /x/);
  assert.equal(gate.commands[1].exit, 0, gate.commands[1].error ?? gate.commands[1].output);
  assert.match(gate.commands[1].output, /second/);
  assert.equal(gate.ok, false);
  assert.equal(gate.summary, `验收命令失败：node -e "console.log('x'); process.exit(1)"（exit 1）`);
});

test('验收超时：结束进程树，结算后没有残留进程', { timeout: 60000 }, async t => {
  const { root, base, dir } = fixture(t);
  // 标记写进命令行，结算后按它找残留进程（不依赖子进程自己写 pid 文件）。
  const marker = `ar-gate-timeout-${process.pid}-${Date.now().toString(36)}`;
  const line = `node -e "console.log('started'); setInterval(() => {}, 1000); /* ${marker} */"`;

  const gate = await runGate({ root, base, dir, spec: specOf({ verify: [line] }), verifyTimeoutMs: 1500 });
  const command = gate.commands[0];
  assert.equal(command.timedOut, true);
  assert.equal(command.exit, null);
  assert.match(command.error, /超过 1\.5 秒没有结束，已结束进程树/);
  // 输出里有 started 说明命令确实跑过；结算后进程不该还在。
  assert.match(command.output, /started/);
  assert.equal(gate.ok, false);
  assert.ok(gate.ms < 15000, `门禁用时 ${gate.ms} ms`);

  const survivors = (await processList()).filter(entry => (entry.command ?? '').includes(marker));
  for (const entry of survivors) assert.equal(pidAlive(entry.pid), false, `进程 ${entry.pid} 仍在运行`);
  assert.equal(survivors.length, 0, `仍有 ${survivors.length} 个带标记的进程在运行`);
});

const windowsOnly = process.platform === 'win32' ? false : '需要 Windows 的 cmd.exe / .cmd';

test('.cmd 参数含 cmd 元字符：拒绝运行，记为启动失败', { skip: windowsOnly }, async t => {
  const { root, base, dir } = fixture(t);
  const cmdDir = tempDir(t, 'ar 门禁 cmd ');
  const cmd = path.join(cmdDir, 'echo 你好.cmd');
  write(cmd, '@echo off\r\necho hi %1\r\n');

  const gate = await runGate({ root, base, dir, spec: specOf({ verify: [`"${cmd}" a&b`] }) });
  assert.equal(gate.commands.length, 1);
  assert.equal(gate.commands[0].exit, null);
  assert.match(gate.commands[0].error, /参数含 cmd 特殊字符/);
  assert.equal(gate.commands[0].timedOut, false);
  assert.equal(gate.ok, false);
});

test('git 出错时不抛出：记成门禁失败，照样写 gate.json', async t => {
  const { root, dir } = fixture(t);
  // base 指向一个不存在的对象：范围检查时 git diff 会报错。
  const gate = await runGate({ root, base: '0'.repeat(40), dir, spec: specOf({ expect_commit: true }) });
  assert.equal(gate.ok, false);
  assert.match(gate.summary, /^无法读取 git 状态：/);
  assert.equal(gate.commit.ok, false);
  assert.deepEqual(gate.commands, []);
  const saved = JSON.parse(readFileSync(path.join(dir, 'gate.json'), 'utf8'));
  assert.equal(saved.ok, false);
  assert.equal(saved.summary, gate.summary);
});

test('去掉密钥变量：验收命令的环境里没有 dropEnv 列出的变量', async t => {
  const { root, base, dir } = fixture(t);
  const line = `node -e "console.log('secret:' + (process.env.AR_TEST_SECRET_X === undefined ? 'absent' : 'present'))"`;
  const gate = await runGate({
    root, base, dir,
    spec: specOf({ verify: [line] }),
    env: { ...process.env, AR_TEST_SECRET_X: '不该传下去' },
    dropEnv: ['AR_TEST_SECRET_X'],
  });
  assert.equal(gate.commands[0].exit, 0, gate.commands[0].error ?? gate.commands[0].output);
  assert.match(gate.commands[0].output, /secret:absent/);
  assert.ok(!gate.commands[0].output.includes('不该传下去'));
  assert.equal(gate.ok, true);
});

test('去掉 AgentRouter 自己的变量：验收命令只看到普通变量', async t => {
  const { root, base, dir } = fixture(t);
  const line = `node -e "console.log(['AGENT_ROUTER_HOME','CODEX_DISPATCH_HOME','AR_CORE_TRACE','Ar_Mixed','GATE_TEST_KEEP'].map(k => k + '=' + (process.env[k] === undefined ? 'absent' : 'present')).join(','))"`;
  const gate = await runGate({
    root, base, dir,
    spec: specOf({ verify: [line] }),
    env: {
      ...process.env,
      AGENT_ROUTER_HOME: '不该传下去', CODEX_DISPATCH_HOME: '不该传下去',
      AR_CORE_TRACE: '不该传下去', Ar_Mixed: '不该传下去', GATE_TEST_KEEP: '要传下去',
    },
  });
  assert.equal(gate.commands[0].exit, 0, gate.commands[0].error ?? gate.commands[0].output);
  // Windows 上变量名不区分大小写，Ar_Mixed 也去掉；其他平台按大小写区分，它不算 AR_ 前缀。
  const mixed = process.platform === 'win32' ? 'Ar_Mixed=absent' : 'Ar_Mixed=present';
  assert.equal(gate.commands[0].output.trim(), [
    'AGENT_ROUTER_HOME=absent', 'CODEX_DISPATCH_HOME=absent', 'AR_CORE_TRACE=absent', mixed, 'GATE_TEST_KEEP=present',
  ].join(','));
  assert.equal(gate.ok, true);
});
