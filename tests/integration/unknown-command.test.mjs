import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 不认识的子命令（Stage07c 152）：提示后退出码 2，不派发、不建任何记录；其余旧写法照旧派发。
// 临时仓库与隔离的公共目录都在系统临时目录里；预演（AR_DRY_RUN）不启动执行者。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-unknown-command-'));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home');
  mkdirSync(path.join(repo, 'docs/specs'), { recursive: true });
  mkdirSync(home);
  const git = args => assert.equal(spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).status, 0);
  git(['init', '-q']);
  writeFileSync(path.join(repo, 'docs/specs/x.md'), '---\nid: 1\ntitle: 测试\ntype: code\nallowed_paths:\n  - docs/**\nmax_retries: 0\n---\n\n# 测试\n');
  writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
  git(['add', '--', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init']);
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 } } }));
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'wt'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), AR_NO_WATCH: '1', AR_DRY_RUN: '1' };
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT']) delete env[key];
  t.after(() => {
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar-unknown-command-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const ar = args => spawnSync(process.execPath, [script, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
  // 公共目录与任务记录目录的内容快照（用来证明没有新记录）。
  const snapshot = () => JSON.stringify([readdirSync(home).sort(), existsSync(path.join(repo, '.agent-runs')) ? readdirSync(path.join(repo, '.agent-runs')).sort() : null]);
  return { repo, home, ar, snapshot };
}

const message = word => `不认识的子命令：${word}。可用的子命令见 ar help；要把这段文字当任务派发，写成 ar dispatch "${word}"`;

test('ar list 与 ar lsit --json 被拒：退出码 2，打印提示，没有新记录', t => {
  const f = fixture(t);
  const before = f.snapshot();
  const plain = f.ar(['list']);
  assert.equal(plain.status, 2, plain.stdout + plain.stderr);
  assert.equal(plain.stderr.trim(), message('list'));
  assert.equal(plain.stdout, '');
  const json = f.ar(['lsit', '--json']);
  assert.equal(json.status, 2, json.stdout + json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { ok: false, code: 'UNKNOWN_COMMAND', error: message('lsit'), command: 'lsit' });
  assert.equal(f.snapshot(), before, 'runs.jsonl 与任务记录目录都没有变化');
});

// 预演（AR_DRY_RUN=1）只打印记录名和任务指令：能看到指令就说明走到了派发。
test('旧写法照旧派发：任务文字、存在的任务说明文件、带 dispatch 的单个词', t => {
  const f = fixture(t);
  for (const [args, name, prompt] of [
    [['只回复 OK', '--name', 'text'], 'text', '任务：\n只回复 OK'],
    [['docs/specs/x.md', '--name', 'spec'], 'spec', '然后完成任务说明 docs/specs/x.md'],
    [['dispatch', 'list', '--name', 'word'], 'word', '任务：\nlist'],
  ]) {
    const r = f.ar(args);
    assert.equal(r.status, 0, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.startsWith(`记录名：${name}\n`), r.stdout);
    assert.ok(r.stdout.includes(prompt), r.stdout);
  }
});
