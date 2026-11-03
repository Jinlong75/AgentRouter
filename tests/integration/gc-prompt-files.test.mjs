import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

test('gc 只清理超过一小时的任务文字临时普通文件', t => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-prompt-gc-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const tmp = path.join(base, 'tmp'), home = path.join(base, 'home');
  mkdirSync(tmp); mkdirSync(home);
  const env = { ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp, AGENT_ROUTER_HOME: home,
    AR_WORKTREE_ROOT: path.join(base, 'worktrees'), HOME: base, USERPROFILE: base };
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT']) delete env[key];
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'fake', profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true } } }));
  const actualTmp = execFileSync(process.execPath, ['-e', "process.stdout.write(require('node:os').tmpdir())"], { env, encoding: 'utf8' });
  assert.equal(path.resolve(actualTmp), path.resolve(tmp), '子进程的系统临时目录必须隔离');
  const old = path.join(tmp, 'ar-prompt-0123456789abcdef.txt');
  const recent = path.join(tmp, 'ar-prompt-fedcba9876543210.txt');
  const similar = [path.join(tmp, 'ar-prompt-xyz.txt'), path.join(tmp, 'ar-prompt-0123456789abcdef.txt.bak')];
  const directory = path.join(tmp, 'ar-prompt-1111111111111111.txt');
  for (const file of [old, recent, ...similar]) writeFileSync(file, '测试');
  mkdirSync(directory);
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const file of [old, ...similar, directory]) utimesSync(file, past, past);
  const run = args => execFileSync(process.execPath, [script, 'gc', ...args], { cwd: base, env, encoding: 'utf8' });
  const dry = JSON.parse(run(['--dry-run', '--json']));
  assert.deepEqual(dry.promptFiles, [{ file: old }]);
  assert.ok(existsSync(old));
  const text = run(['--dry-run']);
  assert.match(text, /残留的任务文字临时文件（1 个）/);
  assert.ok(text.includes(old));
  assert.ok(existsSync(old));
  const result = JSON.parse(run(['--json']));
  assert.deepEqual(result.promptFiles, [{ file: old }]);
  assert.deepEqual(result.errors, []);
  assert.equal(existsSync(old), false);
  for (const file of [recent, ...similar, directory]) assert.ok(existsSync(file));
});
