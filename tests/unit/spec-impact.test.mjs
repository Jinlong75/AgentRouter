import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { specImpact } from '../../core/lib/spec-impact.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'impact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false }); assert.equal(r.status, 0, r.stderr); };
  run('init', '-q');
  for (const dir of ['src', 'tests', 'checks-extra']) mkdirSync(path.join(root, dir));
  const put = (file, text) => writeFileSync(path.join(root, file), text);
  put('src/project.mjs', 'export function planInit() {}\n');
  put('task.md', '---\nid: 321\ntitle: 测试\ntype: code\nallowed_paths:\n  - src/project.mjs\n---\n`ar init` 和“新建 8”\n');
  put('tests/init.test.mjs', 'planInit();\nassert.equal(items.length === 8, true);\n');
  put('tests/untracked.test.mjs', 'planInit();\n');
  put('checks-extra/ui.ts', 'ar init\n新建 8 个文件\n');
  run('add', 'src/project.mjs', 'task.md', 'tests/init.test.mjs', 'checks-extra/ui.ts');
  return root;
}

test('提取线索、扩展检查范围、标记数量，并忽略未跟踪文件', t => {
  const root = fixture(t);
  const result = specImpact({ root, specFile: 'task.md', project: { impactPaths: ['checks-extra/**'] } });
  assert.ok(result.clues.some(c => c.text === 'planInit' && c.from.includes('export:src/project.mjs')));
  assert.ok(result.clues.some(c => c.text === '新建 8'));
  assert.deepEqual(new Set(result.groups.map(g => g.file)), new Set(['tests/init.test.mjs', 'checks-extra/ui.ts']));
  assert.ok(result.groups.every(g => g.hits.some(h => h.fixedCount)));
  const limited = specImpact({ root, specFile: 'task.md', project: { impactPaths: ['checks-extra/**'] }, limit: 1 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.total, result.total);
  assert.equal(limited.groups.flatMap(g => g.hits).length, 1);
});

test('相邻数量行独立列出，多处命中带出同一行时去重并计入截断', t => {
  const root = fixture(t);
  const lines = Array(13).fill('无关');
  lines[9] = 'planInit();';
  lines[10] = 'planInit();';
  lines[11] = 'assert.equal(items.length === 8, true);';
  writeFileSync(path.join(root, 'tests/init.test.mjs'), lines.join('\n'));
  const result = specImpact({ root, specFile: 'task.md', project: {} });
  const hits = result.groups.find(g => g.file === 'tests/init.test.mjs').hits;
  assert.deepEqual(hits.map(h => h.line), [10, 11, 12]);
  assert.equal(hits[0].fixedCount, false);
  assert.deepEqual(hits[2], { line: 12, text: lines[11], clues: [], fixedCount: true, nearHit: 10 });
  const limited = specImpact({ root, specFile: 'task.md', project: {}, limit: 2 });
  assert.equal(limited.total, 3);
  assert.equal(limited.truncated, true);
});

test('用户 git 配置打开颜色与列号时仍能解析命中（321 审查 R4-1）', t => {
  const root = fixture(t);
  const plain = specImpact({ root, specFile: 'task.md', project: { impactPaths: ['checks-extra/**'] } });
  for (const [key, value] of [['color.grep', 'always'], ['grep.column', 'true']]) {
    const r = spawnSync('git', ['config', key, value], { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(r.status, 0, r.stderr);
  }
  const configured = specImpact({ root, specFile: 'task.md', project: { impactPaths: ['checks-extra/**'] } });
  assert.ok(plain.total > 0);
  assert.deepEqual(configured.groups, plain.groups);
});


test('文档模式只搜索指定文档并保留参数线索', t => {
  const root = fixture(t);
  for (const dir of ['docs/roles', 'docs/specs', 'docs/autonomy', 'skills/x', 'extra']) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, 'docs/specs/task.md'), '---\nid: 321\ntitle: 测试\ntype: code\nallowed_paths:\n  - src/project.mjs\n---\n`--focus` 和“文档短语”\n');
  for (const [file, content] of [['docs/roles/lead.md', '--focus\n数量 8 个\n'], ['skills/x/SKILL.md', '文档短语\n'], ['docs/specs/001-x.md', '--focus\n'], ['docs/autonomy/log.md', '文档短语\n'], ['extra/notes.txt', '--focus\n'], ['CHANGELOG.md', '--focus\n']]) writeFileSync(path.join(root, file), content);
  const added = spawnSync('git', ['add', 'docs', 'skills', 'extra', 'CHANGELOG.md'], { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(added.status, 0, added.stderr);
  const result = specImpact({ root, specFile: 'docs/specs/task.md', project: {}, docs: true });
  assert.equal(result.mode, 'docs');
  assert.deepEqual(new Set(result.groups.map(g => g.file)), new Set(['docs/roles/lead.md', 'skills/x/SKILL.md']));
  assert.ok(result.clues.some(c => c.text === '--focus'));
  assert.ok(!result.clues.some(c => ['project.mjs', 'planInit'].includes(c.text)));
  assert.deepEqual(result.groups.find(g => g.file === 'docs/roles/lead.md').hits, [{ line: 1, text: '--focus', clues: ['--focus'] }]);
  assert.ok(specImpact({ root, specFile: 'docs/specs/task.md', project: { impactDocPaths: ['extra/**'] }, docs: true }).groups.some(g => g.file === 'extra/notes.txt'));
  assert.throws(() => specImpact({ root, specFile: 'docs/specs/task.md', project: { impactDocPaths: 'extra/**' }, docs: true }), /impactDocPaths 必须是字符串数组/);
  assert.equal(specImpact({ root, specFile: 'docs/specs/task.md', project: {}, docs: false }).mode, 'tests');
});
