import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText, EMPTY_WORDS, maskWords, loadWordlist, exportPathOf } from '../../tools/public-scan.mjs';

// lint-tree R8 与共用扫描模块：在系统临时目录的临时 git 仓库里跑真实的 tools/lint-tree.mjs，不碰本仓库。
const lintTool = fileURLToPath(new URL('../../tools/lint-tree.mjs', import.meta.url));
const temps = [];
test.after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });

// 命中样例运行时拼接：本测试文件也在导出集合里，源码里出现连续的命中串会让扫描常亮。
const INTERNAL_DOC = 'Visual' + 'Spec';
const USER_PATH = 'C:' + '\\Users\\' + 'someone';
const FAKE_KEY = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
const PERSONAL_EMAIL = 'someone@' + 'gmail.com';
const SECRET_WORD = 'FakeLeakName42';
const SECRET_PATH_WORD = 'temp-secret-path';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function makeRepo(files) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ar-public-scan-'));
  temps.push(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  for (const [file, content] of Object.entries(files)) {
    const dest = path.join(repo, ...file.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  git(repo, ['add', ...Object.keys(files)]);
  return repo;
}
const lint = repo => {
  try {
    return { status: 0, out: execFileSync(process.execPath, [lintTool], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};
const r8Lines = out => out.split('\n').filter(l => l.startsWith('R8 公开内容'));
const SKIP_NOTE = 'R8：没有私有词表，个人词与本机路径词表的扫描跳过';
const fakeWordlist = JSON.stringify({ personal: [SECRET_WORD], localPaths: [SECRET_PATH_WORD] });

test('scanText：四类内容各有一个命中', () => {
  const words = { personal: [SECRET_WORD], localPaths: [SECRET_PATH_WORD], all: [SECRET_WORD, SECRET_PATH_WORD] };
  const cats = (text, w = words) => scanText('tools/x.mjs', text, w, []).map(h => h.category);
  assert.deepEqual(cats(`// ${PERSONAL_EMAIL}`), ['个人信息']);
  assert.deepEqual(cats(`// ${SECRET_WORD}`), ['个人信息']);
  assert.deepEqual(cats(`// ${USER_PATH}\\x`), ['本机路径']);
  assert.deepEqual(cats(`// ${SECRET_PATH_WORD}`), ['本机路径']);
  assert.deepEqual(cats(`const k = '${FAKE_KEY}';`), ['密钥格式']);
  assert.deepEqual(cats(`// 见 ${INTERNAL_DOC} 4.5`), ['内部文档引用']);
  assert.deepEqual(cats('// 见任务说明 ' + '012'), ['内部文档引用']);
  assert.deepEqual(scanText('tools/x.mjs', '// 见 012-demo', EMPTY_WORDS, ['012-demo']).map(h => h.category), ['内部文档引用']);
});

test('maskWords 与 scanText：词表里的词不会出现在命中里', () => {
  assert.equal(maskWords(`a ${SECRET_WORD} b`, [SECRET_WORD]), 'a *** b');
  const words = { personal: [SECRET_WORD], localPaths: [], all: [SECRET_WORD] };
  const hits = scanText('tools/x.mjs', `// ${SECRET_WORD}`, words, []);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].masked, '***');
});

test('exportPathOf：允许清单与改名', () => {
  assert.equal(exportPathOf('core/ar.mjs'), 'core/ar.mjs');
  assert.equal(exportPathOf('README.public.md'), 'README.md');
  assert.equal(exportPathOf('docs/a.md'), null);
  assert.equal(exportPathOf('README.md'), null);
});

test('R8：四类命中都报出，词表词被遮成 ***，输出里没有词表内容', () => {
  const repo = makeRepo({
    '.agent-router/public-scan.json': fakeWordlist,
    'tools/a.mjs': `// ${PERSONAL_EMAIL}\n// ${USER_PATH}\\x\n// ${INTERNAL_DOC} 4.5\nconst k = '${FAKE_KEY}';\n`,
    'tools/b.mjs': `// ${SECRET_WORD}\n// ${SECRET_PATH_WORD}\n`,
  });
  const { status, out } = lint(repo);
  const lines = r8Lines(out);
  assert.equal(status, 1);
  assert.ok(lines.some(l => l.includes('tools/a.mjs') && l.includes('第 1 行：个人信息 ***@gmail.com')), out);
  assert.ok(lines.some(l => l.includes('tools/a.mjs') && l.includes('第 2 行：本机路径')), out);
  assert.ok(lines.some(l => l.includes('tools/a.mjs') && l.includes(`第 3 行：内部文档引用 ${INTERNAL_DOC}`)), out);
  assert.ok(lines.some(l => l.includes('tools/a.mjs') && l.includes('第 4 行：密钥格式 ***')), out);
  assert.ok(lines.some(l => l.includes('tools/b.mjs') && l.includes('第 1 行：个人信息 ***')), out);
  assert.ok(lines.some(l => l.includes('tools/b.mjs') && l.includes('第 2 行：本机路径 ***')), out);
  assert.ok(!out.includes(SECRET_WORD) && !out.includes(SECRET_PATH_WORD), '输出里不得出现词表内容');
  assert.ok(!out.includes(FAKE_KEY) && !out.includes('someone'), '输出里不得出现密钥与用户名');
  assert.ok(!out.includes(SKIP_NOTE), '有词表时不打印跳过说明');
});

test('R8：没有词表时只跑不依赖词表的扫描，打印跳过说明，不算问题', () => {
  const clean = makeRepo({ 'tools/a.mjs': `// ${SECRET_WORD}\n// ${SECRET_PATH_WORD}\n` });
  const first = lint(clean);
  assert.equal(r8Lines(first.out).length, 0, first.out);
  assert.ok(first.out.includes(SKIP_NOTE), first.out);
  const dirty = makeRepo({
    'tools/a.mjs': `// ${PERSONAL_EMAIL}\n// ${USER_PATH}\\x\n// ${INTERNAL_DOC} 4.5\nconst k = '${FAKE_KEY}';\n`,
  });
  const second = lint(dirty);
  assert.equal(r8Lines(second.out).length, 4, second.out);
  assert.ok(second.out.includes(SKIP_NOTE), second.out);
});

test('R8：词表不是合法 JSON 或缺字段时算问题，且不静默跳过', () => {
  for (const bad of ['{ 不是 json', JSON.stringify({ personal: [] })]) {
    const repo = makeRepo({ '.agent-router/public-scan.json': bad, 'tools/a.mjs': 'export const a = 1;\n' });
    const { status, out } = lint(repo);
    assert.equal(status, 1, out);
    assert.ok(r8Lines(out).some(l => l.includes('读取私有词表失败')), out);
    assert.ok(!out.includes(SKIP_NOTE), out);
  }
  assert.throws(() => loadWordlist(makeRepo({ 'tools/a.mjs': 'x\n' })), /不存在/);
  assert.equal(loadWordlist(makeRepo({ 'tools/a.mjs': 'x\n' }), { optional: true }), null);
});

test('R8：不会导出的文件有命中也不报，白名单外的文档不扫', () => {
  const repo = makeRepo({
    'docs/notes.md': `见 ${INTERNAL_DOC}，${PERSONAL_EMAIL}\n`,
    'AGENTS.md': `${INTERNAL_DOC}\n`,
    'core/templates/extra.md': `见 ${INTERNAL_DOC}\n`,
    'tools/ok.mjs': 'export const ok = 1;\n',
  });
  const { out } = lint(repo);
  assert.equal(r8Lines(out).length, 0, out);
});

test('R8：README.public.md 按源路径扫描，二进制按 .gitattributes 跳过', () => {
  const repo = makeRepo({
    'README.public.md': `# 公开 README\n见 ${INTERNAL_DOC}\n`,
    '.gitattributes': '* text=auto\n*.bin binary\n',
    'tools/data.bin': Buffer.from(`${INTERNAL_DOC}\n`),
  });
  const { out } = lint(repo);
  const lines = r8Lines(out);
  assert.equal(lines.length, 1, out);
  assert.ok(lines[0].includes('README.public.md') && lines[0].includes('第 2 行'), out);
});
