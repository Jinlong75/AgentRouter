import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkSpec } from '../../core/lib/spec-check.mjs';

test('检查注释、依赖、循环、范围和独占时限', t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-spec-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/specs'), { recursive: true });
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0);
  git('init', '-q', '-b', 'main');
  const file = 'docs/specs/100-main.md';
  const write = (name, text) => writeFileSync(join(root, 'docs/specs', name), text);
  const check = project => checkSpec({ root, specPath: file, project: { baseBranch: 'main', ...project } });
  write('101a-dep.md', '---\ntitle: dep\n---\n');
  write('100-main.md', '---\n# 注释\ntitle: "引用 # 值" # 注释\ndepends: ["101a"]\nverify:\n  - npm run shots # 截断\nallowed_paths:\n  - core/**\n  - app/src/main/shots*.ts\n---\n');
  let result = check({ exclusiveCommands: ['npm run shots'] });
  assert.deepEqual(result.errors.map(e => [e.code, e.line]), [['SPEC_COMMENT', 6], ['SPEC_EXCLUSIVE_TIMEOUT', null]]);
  assert.equal(result.warnings[0].code, 'SPEC_SPLIT');
  assert.deepEqual(check({ exclusiveCommands: ['npm run shots --focus'], specSplitWarning: false }).warnings, []);
  write('100-main.md', '---\ntitle: 正常\ndepends: ["101a", "102"]\nverify_timeout_min: 60\nverify:\n  - npm run shots\nallowed_paths:\n  - core/**\n  - app/src/main/other*.ts\n---\n');
  result = check({ exclusiveCommands: ['npm run shots'] });
  assert.deepEqual(result.errors.map(e => e.code), ['SPEC_DEPENDS']); assert.deepEqual(result.warnings, []);
  write('101a-dep.md', '---\ndepends: ["100"]\n---\n');
  assert.deepEqual(check({}).errors.map(e => e.code), ['SPEC_DEPENDS', 'SPEC_DEPENDS_CYCLE']);
  assert.match(check({ fullExclusiveTimeoutMin: 0 }).errors.at(-1).message, /项目配置无效：fullExclusiveTimeoutMin/);
  assert.match(check({ specSplitWarning: 'false' }).errors.at(-1).message, /项目配置无效：specSplitWarning/);
});

test('依赖图独立检查其他字段，依赖本身无法解析时拒绝', t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-dep-graph-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/specs'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  const file = 'docs/specs/100-a.md', other = join(root, 'docs/specs/101-b.md');
  writeFileSync(join(root, file), '---\ntitle: A\ndepends: ["101"]\n---\n');
  writeFileSync(other, '---\ntype: invalid\ndepends: ["100"]\n---\n');
  const check = () => checkSpec({ root, specPath: file });
  assert.match(check().errors.find(e => e.code === 'SPEC_DEPENDS_CYCLE').message, /100 → 101 → 100/);
  writeFileSync(other, '---\ntype: invalid\ndepends: [bad]\n---\n');
  assert.equal(check().errors[0].code, 'SPEC_DEPENDS');
});

test('不同分支与所选提交读取对应版本及依赖', t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-check-base-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/specs'), { recursive: true });
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const file = 'docs/specs/100-main.md';
  writeFileSync(join(root, file), '---\ntitle: 基线\ndepends: ["101b"]\n---\n');
  writeFileSync(join(root, 'docs/specs/101b-dep.md'), '---\ntitle: 基线依赖\n---\n');
  git('add', 'docs/specs'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'stage');
  writeFileSync(join(root, file), '---\ntitle: 工作区 # 截断\ndepends: ["102"]\n---\n');
  const project = { baseBranch: 'main', specSplitWarning: false };
  const committed = checkSpec({ root, specPath: file, revision: base, project });
  assert.deepEqual(committed.errors.map(e => e.code), ['SPEC_BASE']);
  assert.equal(checkSpec({ root, specPath: file, revision: base, project, baseOverride: 'main' }).ok, true);
  assert.deepEqual(checkSpec({ root, specPath: file, project, baseOverride: 'stage' }).errors.map(e => e.code), ['SPEC_COMMENT', 'SPEC_DEPENDS']);
});

test('独占阈值边界、自依赖与广义 glob', t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-check-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/specs'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  const file = 'docs/specs/100-one.md';
  const write = (timeout, command, depends = '') => writeFileSync(join(root, file), `---\ntitle: 测试\n${depends}verify_timeout_min: ${timeout}\nverify:\n  - ${command}\nallowed_paths:\n  - **\n---\n`);
  const check = () => checkSpec({ root, specPath: file, project: { exclusiveCommands: ['npm run shots'] } });
  write(59, 'npm run shots'); assert.deepEqual(check().errors.map(e => e.code), ['SPEC_EXCLUSIVE_TIMEOUT']);
  write(60, 'npm run shots'); assert.equal(check().ok, true); assert.equal(check().warnings[0].code, 'SPEC_SPLIT');
  write(1, 'npm run shots --focus'); assert.equal(check().ok, true);
  write(60, 'npm run shots', 'depends: ["100"]\n'); assert.match(check().errors[0].message, /100 → 100/);
});
