import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('经验清单命令与缺失文件', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-practices-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, AGENT_ROUTER_HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: join(dir, 'claude') };
  const run = (core, ...args) => spawnSync(process.execPath, [join(core, 'ar.mjs'), 'lead', 'practices', ...args], { cwd: dir, env, encoding: 'utf8' });
  const core = resolve('core');
  const all = run(core); assert.equal(all.status, 0); assert.match(all.stdout, /# 主导经验清单/);
  assert.ok(all.stdout.trimEnd().endsWith(`原因与例子：${join(core, 'templates/lead-practices/examples.md')}；收尾核对表：${join(core, 'templates/lead-practices/closeout.md')}`));
  const section = run(core, '3'); assert.equal(section.status, 0); assert.match(section.stdout, /到了下面某个时刻/); assert.match(section.stdout, /## 3\. 等待与后台进程/); assert.doesNotMatch(section.stdout, /## 4\./);
  const missing = run(core, '99'); assert.equal(missing.status, 2); assert.match(missing.stderr + missing.stdout, /没有第 99 节；可选：1,2,3,4,5,6,7,8,9,10,11/);
  const json = run(core, '3', '--json'); assert.equal(json.status, 0); const result = JSON.parse(json.stdout);
  assert.equal(result.ok, true); assert.equal(result.section, 3); assert.match(result.text, /## 3\./); assert.equal(result.examples, join(core, 'templates/lead-practices/examples.md')); assert.equal(result.closeout, join(core, 'templates/lead-practices/closeout.md'));
  assert.equal(JSON.parse(run(core, '--json').stdout).section, null);
  const copied = join(dir, 'core'); cpSync(core, copied, { recursive: true }); rmSync(join(copied, 'templates/lead-practices/checklist.md'));
  const absent = run(copied); assert.equal(absent.status, 2); assert.match(absent.stdout + absent.stderr, /核心里没有经验清单：/);
});
