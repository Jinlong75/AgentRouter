import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, validateSpec } from '../../core/lib/spec.mjs';

test('depends 校验列表与内联数组', () => {
  for (const value of ['depends:\n  - "263"\n  - "273"', 'depends: ["263", "273"]']) {
    assert.deepEqual(validateSpec(parseSpec(`---\n${value}\n---`)).depends, ['263', '273']);
  }
  for (const value of ['depends: []', 'depends: abc', 'depends: [1]', 'depends: [""]']) {
    assert.throws(() => validateSpec(parseSpec(`---\n${value}\n---`)), /depends 必须是任务编号的字符串数组/);
  }
});


test('300 份说明和一万行记录只读取一次，五秒内完成', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { nextTasks } = await import('../../core/lib/next.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ar-next-perf-')), root = join(dir, 'repo'), home = join(dir, 'home');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true }); mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, concurrency: 2 }));
  for (let i = 0; i < 300; i++) writeFileSync(join(root, 'docs', 'specs', `${String(i).padStart(3, '0')}-test.md`), `---\ntitle: test\nallowed_paths:\n  - src/${i}\n---\n`);
  writeFileSync(join(home, 'runs.jsonl'), Array.from({ length: 10000 }, (_, i) => JSON.stringify({ v: 2, event: 'end', id: `run-${i}`, exit: 1 })).join('\n') + '\n');
  const { spawnSync } = await import('node:child_process');
  for (const args of [['init', '-q'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['commit', '--allow-empty', '-qm', 'initial']]) {
    const git = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(git.status, 0, git.stderr);
  }
  let reads = 0; const start = performance.now();
  const result = await nextTasks({ root, home, env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'claude') }, all: true, readRuns: file => { reads++; return readFileSync(file, 'utf8'); } });
  assert.equal(result.candidates.length, 300); assert.equal(reads, 1); assert.ok(performance.now() - start < 5000);
  const { fileURLToPath } = await import('node:url');
  const cliStart = performance.now();
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../../core/ar.mjs', import.meta.url)), 'next', '--json', '--all'], { cwd: root, env: { ...process.env, AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude') }, encoding: 'utf8', shell: false, timeout: 5000 });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).candidates.length, 300); assert.ok(performance.now() - cliStart < 5000);
});

test('等待提示超时后放弃', async () => {
  const { nextWithTimeout } = await import('../../core/lib/next.mjs');
  assert.equal(await nextWithTimeout({ root: '.', home: '.', env: { ...process.env, CLAUDE_CONFIG_DIR: (await import('node:path')).join((await import('node:os')).tmpdir(), 'ar-next-absent-claude') } }, 1), null);
});
