import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runVerify } from '../../tools/verify-tests.mjs';

test('Windows 经 PATH 直接调用两个哨兵', { skip: process.platform !== 'win32' }, async t => {
  const base = mkdtempSync(path.join(tmpdir(), 'ar-sentinel-cmd-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sample = path.join(base, 'sample.test.mjs');
  writeFileSync(sample, `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process';
test('call', () => { for (const name of ['claude', 'codex']) { const run = arg => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', name + ' ' + arg], { encoding: 'utf8', shell: false }); const version = run('--version'); assert.equal(version.status, 0); assert.match(version.stdout, /verify-sentinel/); assert.equal(run('probe-sentinel').status, 1); } });\n`);
  const env = { ...process.env, AR_VERIFY_LOG_DIR: path.join(base, 'logs') };
  delete env.NODE_TEST_CONTEXT;
  const lines = [];
  const code = await runVerify({ argv: [sample], env, write: () => {}, print: line => lines.push(line), printError: line => lines.push(line) });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /PATH 里的 claude（1 次）/);
  assert.match(lines.join('\n'), /PATH 里的 codex（2 次）/);
  assert.match(lines.join('\n'), /probe-sentinel/);
});

test('PATH 中的 claude 非版本调用使 verify 失败并列出调用', async t => {
  const base = mkdtempSync(path.join(tmpdir(), 'ar-claude-sentinel-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const sample = path.join(base, 'sample.test.mjs');
  const adapter = pathToFileURL(path.resolve('core/adapters/claude-code.mjs')).href;
  writeFileSync(sample, `import { test } from 'node:test'; import { spawnSync } from 'node:child_process'; import { resolveLauncher } from ${JSON.stringify(adapter)};
test('调用', () => { const launcher = resolveLauncher(process.env); const result = spawnSync(launcher.executable, [...launcher.args, 'probe-sentinel'], { encoding: 'utf8' }); if (result.status !== 1) throw Error('哨兵未生效'); });\n`);
  const env = { ...process.env, AR_VERIFY_LOG_DIR: path.join(base, 'logs') };
  delete env.NODE_TEST_CONTEXT;
  const lines = [];
  const code = await runVerify({ argv: [sample], env, write: () => {}, print: line => lines.push(line), printError: line => lines.push(line) });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /PATH 里的 claude（1 次）/);
  assert.match(lines.join('\n'), /probe-sentinel/);
});
