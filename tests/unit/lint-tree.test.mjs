// lint:tree R9 控制字符规则的测试：在临时目录里的 git 仓库上运行 tools/lint-tree.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lintTree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/lint-tree.mjs');

// 建一个只含给定文件的临时仓库并运行检查
function lint(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ar-lint-tree-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), content);
    }
    execFileSync('git', ['add', '--', ...Object.keys(files)], { cwd: dir });
    const r = spawnSync(process.execPath, [lintTree], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, AGENT_ROUTER_HOME: path.join(dir, '.home') },
    });
    return { code: r.status, out: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('R2 报告截断的 UTF-8 中文所在行', () => {
  const r = lint({ 'broken.md': Buffer.concat([
    Buffer.from('第一行\n第二行\n半个'), Buffer.from('中').subarray(0, 2), Buffer.from('\n'),
  ]) });
  assert.equal(r.code, 1);
  assert.match(r.out, /R2 非 UTF-8  broken\.md  第 3 行/);
});

test('R2 对同一文件的多处非法字节只报告第一处', () => {
  const r = lint({ 'broken.md': Buffer.from([0x61, 0x0a, 0xff, 0x0a, 0xfe, 0x0a]) });
  assert.equal(r.code, 1);
  assert.equal((r.out.match(/R2 非 UTF-8/g) || []).length, 1);
  assert.match(r.out, /R2 非 UTF-8  broken\.md  第 2 行/);
});

test('R2 接受合法中文并跳过含 NUL 的二进制文件', () => {
  const r = lint({ 'valid.md': '合法中文\n', blob: Buffer.from([0x00, 0xff]) });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /R2 非 UTF-8/);
});

test('响铃字符 U+0007 报错，写出行、列和编码', () => {
  const r = lint({ 'a.md': '第一行\nab\u0007cd\n' });
  assert.equal(r.code, 1);
  assert.match(r.out, /R9 控制字符  a\.md  第 2 行第 3 列：U\+0007/);
});

test('ESC U+001B 报错，位置正确', () => {
  const r = lint({ 'b.txt': '\u001bx\n' });
  assert.equal(r.code, 1);
  assert.match(r.out, /R9 控制字符  b\.txt  第 1 行第 1 列：U\+001B/);
});

test('制表、换行、回车不报', () => {
  const r = lint({ 'c.txt': 'a\tb\nc\r\nd\n' });
  assert.doesNotMatch(r.out, /R9/);
  assert.doesNotMatch(r.out, /R2 BOM/);
});

test('二进制文件（含 NUL 的无扩展名文件）不报', () => {
  const r = lint({ blob: Buffer.from([0x41, 0x00, 0x07, 0x1b, 0x42]) });
  assert.doesNotMatch(r.out, /R9/);
});

test('R10 对代码和数据文件报告连续四个问号的位置', () => {
  for (const ext of ['mjs', 'js', 'cjs', 'ts', 'json', 'css', 'html', 'ps1', 'cmd']) {
    const newline = ['ps1', 'cmd'].includes(ext) ? '\r\n' : '\n';
    const r = lint({ [`sample.${ext}`]: `第一行${newline}${'?'.repeat(4)}${newline}` });
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`R10 问号串  sample\\.${ext}  第 2 行`));
  }
});

test('R10 不报告较短问号、可选链和 Markdown', () => {
  const r = lint({ 'sample.json': ['???***', 'a ?? b', 'x?.y'].join('\n') + '\n',
    'sample.md': '?'.repeat(4) + '\n' });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /R10/);
});

test('R11 对代码和数据文件报告问号紧挨中文的位置', () => {
  for (const ext of ['mjs', 'js', 'cjs', 'ts', 'json', 'css', 'html', 'ps1', 'cmd']) {
    const newline = ['ps1', 'cmd'].includes(ext) ? '\r\n' : '\n';
    const r = lint({ [`sample.${ext}`]: `第一行${newline}${'检查' + '?' + '结果'}${newline}` });
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`R11 问号紧挨中文  sample\\.${ext}  第 2 行`));
  }
});

test('R11 报告问号在中文前后，同一行只报告一次', () => {
  const r = lint({ 'sample.json': ['?' + '检查', '检查' + '?', '检查' + '?' + '结果'].join('\n') + '\n' });
  assert.equal(r.code, 1);
  for (let line = 1; line <= 3; line++) {
    assert.equal(r.out.split(`R11 问号紧挨中文  sample.json  第 ${line} 行`).length - 1, 1);
  }
});

test('R11 跳过非相邻问号、Markdown 和真实输出样例', () => {
  const r = lint({
    'sample.json': ['检查？结果', 'a ? b : c', 'x?.y', '检查 ? 结果'].join('\n') + '\n',
    'sample.md': '检查' + '?' + '结果\n',
    'tests/fixtures/x.json': '检查' + '?' + '结果\n',
  });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /R11/);
});
