import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

test('impact 命令输出 Markdown、JSON 和说明错误', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'impact-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, AGENT_ROUTER_HOME: path.join(root, 'home') };
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q');
  mkdirSync(path.join(root, 'tests'));
  writeFileSync(path.join(root, 'task.md'), '---\nid: 321\ntitle: 测试\ntype: code\nallowed_paths: []\n---\n`ar init`\n');
  writeFileSync(path.join(root, 'tests', 'init.test.mjs'), 'ar init\n');
  git('add', 'task.md', 'tests/init.test.mjs');
  const call = (...args) => spawnSync(process.execPath, [cli, 'spec', 'impact', ...args], { cwd: root, env, encoding: 'utf8', shell: false });
  const plain = call('task.md');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /## 受影响的已有测试/);
  assert.match(plain.stdout, /tests\/init.test.mjs:1:ar init/);
  const json = call('task.md', '--json');
  assert.equal(json.status, 0, json.stderr);
  const result = JSON.parse(json.stdout);
  assert.equal(result.ok, true);
  assert.deepEqual(result.groups[0].hits[0], { line: 1, text: 'ar init', clues: ['ar init'], fixedCount: false });
  assert.equal(result.total, 1);
  assert.equal(result.truncated, false);
  writeFileSync(path.join(root, 'tests', 'init.test.mjs'), 'ar init\nassert.equal(items.length === 8, true);\n');
  const countText = call('task.md');
  assert.match(countText.stdout, /tests\/init.test.mjs:1:ar init\r?\n/);
  assert.match(countText.stdout, /tests\/init.test.mjs:2:assert.equal\(items.length === 8, true\);（写死的数量，确认是否要改）/);
  const countJson = JSON.parse(call('task.md', '--json').stdout);
  assert.deepEqual(countJson.groups[0].hits[1], { line: 2, text: 'assert.equal(items.length === 8, true);', clues: [], fixedCount: true, nearHit: 1 });
  for (const name of ['missing.md', 'bad.md']) {
    if (name === 'bad.md') writeFileSync(path.join(root, name), '---\ninvalid\n---\n');
    const bad = call(name, '--json');
    assert.equal(bad.status, 2);
    assert.equal(JSON.parse(bad.stdout).ok, false);
  }
});


test('impact --docs 输出、截断和参数校验', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'impact-docs-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, AGENT_ROUTER_HOME: path.join(root, 'home') };
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q');
  mkdirSync(path.join(root, 'docs/specs'), { recursive: true });
  writeFileSync(path.join(root, 'docs/specs/task.md'), '---\nid: 321\ntitle: 测试\ntype: code\nallowed_paths: []\n---\n`--focus`\n');
  writeFileSync(path.join(root, 'README.md'), '--focus\n--focus 再次出现\n');
  git('add', 'docs/specs/task.md', 'README.md');
  const call = (...args) => spawnSync(process.execPath, [cli, 'spec', 'impact', 'docs/specs/task.md', ...args], { cwd: root, env, encoding: 'utf8', shell: false });
  const plain = call('--docs');
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(plain.stdout.includes('## 受影响的文档（ar spec impact --docs 生成，主导逐条核对是否要改）'));
  const limited = call('--docs', '--limit', '1');
  assert.equal(limited.status, 0, limited.stderr);
  assert.match(limited.stdout, /结果已截断，共 2 行/);
  const json = JSON.parse(call('--limit', '1', '--docs', '--json').stdout);
  assert.equal(json.mode, 'docs');
  assert.equal(json.truncated, true);
  const duplicate = call('--docs', '--docs', '--json');
  assert.equal(duplicate.status, 2);
  assert.match(JSON.parse(duplicate.stdout).error, /用法：ar spec impact/);
});
