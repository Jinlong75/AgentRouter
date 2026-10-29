// lint:tree R9 控制字符规则的测试：在临时目录里的 git 仓库上运行 tools/lint-tree.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const lintTree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/lint-tree.mjs');

// 建一个只含给定文件的临时仓库并运行检查
function lint(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ar-lint-tree-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
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
