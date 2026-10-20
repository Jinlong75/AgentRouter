import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 导出工具的 CLI 行为：在临时 git 仓库里造文件并提交，再跑真实的 tools/public-snapshot.mjs。不碰本仓库。
const tool = fileURLToPath(new URL('../../tools/public-snapshot.mjs', import.meta.url));
const temps = [];
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const run = (cwd, target, ...args) => {
  try {
    const out = execFileSync(process.execPath, [tool, target, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};
const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);

// 覆盖允许清单每一项（含 README.public.md）+ 内部文件 + 二进制文件；core.autocrlf 关掉，字节原样进出。
const committed = {
  'app/src/x.ts': 'export const x = 1;\n',
  'app/design/tokens.css': ':root { --bg: #0D0E10; }\n',
  'app/design/icons/app.svg': '<svg></svg>\n',
  'app/design/icons/app.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff, 0x80, 0x7f, 0x00]),
  'core/ar.mjs': 'export const dispatch = () => {};\n',
  'skills/demo/SKILL.md': '# 技能\n',
  'installer/install.mjs': 'export const install = () => {};\n',
  'tools/hello.mjs': 'console.log("hello");\n',
  'tests/smoke.test.mjs': 'import test from "node:test";\ntest("占位", () => {});\n',
  '.github/workflows/verify.yml': 'name: verify\n',
  'package.json': '{ "name": "snap-test", "private": true, "type": "module" }\n',
  'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n',
  'tsconfig.json': '{ "compilerOptions": { "strict": true } }\n',
  'electron-builder.config.cjs': 'module.exports = {};\n',
  '.gitattributes': '* text=auto\n',
  '.gitignore': 'node_modules/\n',
  'LICENSE': 'MIT\n',
  'THIRD_PARTY_NOTICES.md': '# 第三方声明\n',
  'README.public.md': '# 公开 README\n见 [core/ar.mjs](core/ar.mjs)。\n',
  'README.md': '# 内部 README（不导出）\n',
  'docs/plan/VisualSpec.md': '# VisualSpec\n内部文档。\n',
  'CHECKPOINT.md': '内部交接记录。\n',
  'AGENTS.md': '内部共同规则。\n',
  'app/design/preview.html': '<!doctype html><title>界面稿</title>\n',
};
const expectedExported = Object.keys(committed)
  .filter(f => f !== 'README.md' && f !== 'README.public.md' && !f.startsWith('docs/') && f !== 'CHECKPOINT.md'
    && f !== 'AGENTS.md' && f !== 'app/design/preview.html')
  .concat('README.md').sort();

const makeRepo = (files = committed) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ar-public-snapshot-'));
  temps.push(root);
  const repo = path.join(root, 'repo');
  git(root, ['init', repo]);
  git(repo, ['config', 'user.name', '快照测试']);
  git(repo, ['config', 'user.email', 'snap-test@example.invalid']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', '初始提交']);
  return { root, repo, target: path.join(root, 'snap') };
};

test.after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

test('导出只含允许清单内的文件；README.md 来自 README.public.md；未提交的改动与内部文件不出现；二进制逐字节相同', () => {
  const { repo, target } = makeRepo();
  writeFileSync(path.join(repo, 'app/src/x.ts'), 'export const x = 2; // 工作区未提交\n');
  const sha = git(repo, ['rev-parse', 'HEAD']).trim();
  const { status, out } = run(repo, target, '--ref', 'HEAD');
  assert.equal(status, 0, out);
  assert.ok(out.includes(`来源提交：${sha}`), '打印完整来源提交');
  assert.ok(out.includes(`导出文件数：${expectedExported.length}`));
  assert.ok(out.includes(`排除文件数：5`));
  assert.deepEqual(walk(target).sort(), expectedExported, '快照里只有允许清单内的文件');
  assert.equal(readFileSync(path.join(target, 'README.md'), 'utf8'), committed['README.public.md'], 'README.md 来自 README.public.md');
  assert.equal(readFileSync(path.join(target, 'app/src/x.ts'), 'utf8'), committed['app/src/x.ts'], '未提交的改动不出现');
  assert.deepEqual(
    [...readFileSync(path.join(target, 'app/design/icons/app.png'))],
    [...committed['app/design/icons/app.png']], '二进制文件逐字节相同');
});

test('目标目录非空时报错，且不写任何文件', () => {
  const { repo, target } = makeRepo();
  mkdirSync(target);
  writeFileSync(path.join(target, 'keep.txt'), '原有文件\n');
  const { status, out } = run(repo, target);
  assert.notEqual(status, 0);
  assert.match(out, /非空/);
  assert.deepEqual(readdirSync(target), ['keep.txt']);
  assert.equal(readFileSync(path.join(target, 'keep.txt'), 'utf8'), '原有文件\n');
});

test('允许清单项匹配不到文件时报错且不创建目标目录；--ref 指定提交', () => {
  const files = { ...committed };
  delete files.LICENSE;
  const { repo, target } = makeRepo(files);
  const first = git(repo, ['rev-parse', 'HEAD']).trim();
  const bad = run(repo, target, '--ref', first);
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /LICENSE/, '报错指出匹配不到的清单项');
  assert.equal(existsSync(target), false, '报错时不创建目标目录');
  writeFileSync(path.join(repo, 'LICENSE'), 'MIT\n');
  git(repo, ['add', 'LICENSE']);
  git(repo, ['commit', '-m', '补上 LICENSE']);
  const good = run(repo, target);
  assert.equal(good.status, 0, good.out);
  assert.equal(readFileSync(path.join(target, 'LICENSE'), 'utf8'), 'MIT\n');
});

test('.gitattributes 标 eol=crlf 的导出为 CRLF、默认文本为 LF、二进制逐字节不变；与同一提交 git 检出的目录逐字节一致', () => {
  const files = {
    ...committed,
    // 显式声明默认换行：git 对未声明 eol 的文本按 core.eol 处理，这里让默认规则固定为 LF。
    '.gitattributes': '* text=auto eol=lf\n*.cmd text eol=crlf\n*.png binary\n',
    'installer/run.cmd': '@echo off\r\nrem 演示\r\n',
    // 含 NUL 的文件：text=auto 判为二进制，且不依赖 *.png 那条规则也能原样导出。
    'core/data.bin': Buffer.from([0x01, 0x0d, 0x0a, 0x02, 0x00, 0x0a, 0xff]),
  };
  const { root, repo, target } = makeRepo(files);
  const { status, out } = run(repo, target, '--ref', 'HEAD');
  assert.equal(status, 0, out);
  assert.equal(readFileSync(path.join(target, 'installer/run.cmd'), 'utf8'), '@echo off\r\nrem 演示\r\n', 'eol=crlf 导出为 CRLF');
  assert.equal(readFileSync(path.join(target, 'app/src/x.ts'), 'utf8'), committed['app/src/x.ts'], '默认文本导出为 LF');
  assert.deepEqual([...readFileSync(path.join(target, 'core/data.bin'))], [...files['core/data.bin']], '含 NUL 的文件逐字节不变');
  assert.deepEqual([...readFileSync(path.join(target, 'app/design/icons/app.png'))], [...committed['app/design/icons/app.png']], '二进制文件逐字节不变');
  // 同一提交检出到临时目录（worktree 共用本临时仓库的配置），快照里每个文件都与检出字节一致。
  const checkout = path.join(root, 'checkout');
  git(repo, ['worktree', 'add', '--detach', checkout, 'HEAD']);
  for (const rel of walk(target)) {
    const inWorktree = rel === 'README.md' ? 'README.public.md' : rel;
    assert.deepEqual(
      readFileSync(path.join(target, ...rel.split('/'))),
      readFileSync(path.join(checkout, ...inWorktree.split('/'))),
      `与 git 检出字节不一致：${rel}`);
  }
});
