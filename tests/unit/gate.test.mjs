import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explicitlyAllowed, explicitlyAllowedRootSpec, isRootSpecFile, literalPrefixOf, normalizeSpecsDir, runGate, summarizeGate } from '../../core/lib/gate.mjs';
import { parseNameStatusZ, parseStatusPorcelainZ } from '../../core/lib/git.mjs';

// 构造 summarizeGate 的输入；没给的字段按"这一项没问题"处理。
const parts = ({ commit, uncommitted = [], outside = [], commands = [] } = {}) => ({
  commit: commit ?? { required: true, ok: true },
  uncommitted,
  scope: { allowed: ['src/**'], changed: [], outside },
  commands,
});
const command = (overrides = {}) => ({ line: 'npm test', exit: 0, timedOut: false, error: null, ...overrides });

test('summarizeGate：全部通过给出"门禁通过"', () => {
  assert.equal(summarizeGate(parts({ commands: [command()] })), '门禁通过');
  // 没有验收命令、不要求提交、没有改动也是通过。
  assert.equal(summarizeGate(parts({ commit: { required: false, ok: true } })), '门禁通过');
});

test('summarizeGate：只缺提交', () => {
  const text = summarizeGate(parts({ commit: { required: true, ok: false } }));
  assert.equal(text, '没有提交任何改动');
});

test('summarizeGate：只有未提交的文件', () => {
  assert.equal(summarizeGate(parts({ uncommitted: ['src/a.js'] })), '有未提交的文件');
});

test('summarizeGate：只有越界', () => {
  assert.equal(summarizeGate(parts({ outside: ['README.md'] })), '改动超出范围：README.md');
});

test('summarizeGate：只命令失败（exit）', () => {
  const text = summarizeGate(parts({ commands: [command({ exit: 1 })] }));
  assert.equal(text, '验收命令失败：npm test（exit 1）');
});

test('summarizeGate：超时写"（超时）"，启动失败写原因', () => {
  assert.equal(
    summarizeGate(parts({ commands: [command({ line: 'slow', exit: null, timedOut: true, error: '超过 1.5 秒没有结束，已结束进程树' })] })),
    '验收命令失败：slow（超时）',
  );
  assert.equal(
    summarizeGate(parts({ commands: [command({ line: 'missing', exit: null, error: '找不到命令：missing' })] })),
    '验收命令失败：missing（找不到命令：missing）',
  );
});

test('summarizeGate：多项失败按协议顺序，多条失败命令各占一段', () => {
  const text = summarizeGate(parts({
    commit: { required: true, ok: false },
    uncommitted: ['src/a.js'],
    outside: ['README.md', 'docs/x.md'],
    commands: [command({ line: 'npm test', exit: 2 }), command({ line: 'slow', exit: null, timedOut: true })],
  }));
  assert.equal(text, '没有提交任何改动；有未提交的文件；改动超出范围：README.md、docs/x.md；验收命令失败：npm test（exit 2）；验收命令失败：slow（超时）');
});

test('summarizeGate：文件超过 5 个只列前 5 个并加"等"', () => {
  const outside = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assert.equal(summarizeGate(parts({ outside })), '改动超出范围：a、b、c、d、e 等');
  // 正好 5 个不加"等"。
  assert.equal(summarizeGate(parts({ outside: outside.slice(0, 5) })), '改动超出范围：a、b、c、d、e');
});

test('summarizeGate：不要求提交时 commit.ok 为假不算失败', () => {
  assert.equal(summarizeGate(parts({ commit: { required: false, ok: false } })), '门禁通过');
});

test('summarizeGate：工作区外的新文件放在最后一段，最多列 5 个；没有或 added 为空时输出一字不变', () => {
  const added = (...names) => ({ checked: true, added: names.map(name => ({ root: 'user', name, type: 'file' })) });
  assert.equal(summarizeGate({ ...parts(), outsideWrites: added('config.json') }), '工作区外出现新文件：user/config.json');
  assert.equal(
    summarizeGate({ ...parts({ outside: ['README.md'], commands: [command({ exit: 1 })] }), outsideWrites: { checked: true, added: [{ root: 'home', name: 'x.txt', type: 'dir' }] } }),
    '改动超出范围：README.md；验收命令失败：npm test（exit 1）；工作区外出现新文件：home/x.txt',
  );
  assert.equal(summarizeGate({ ...parts(), outsideWrites: added('a', 'b', 'c', 'd', 'e', 'f') }), '工作区外出现新文件：user/a、user/b、user/c、user/d、user/e 等');
  for (const outsideWrites of [undefined, { checked: true, added: [] }, { checked: false, error: '读不了' }]) {
    assert.equal(summarizeGate({ ...parts(), outsideWrites }), '门禁通过');
    assert.equal(summarizeGate({ ...parts({ outside: ['README.md'] }), outsideWrites }), '改动超出范围：README.md');
  }
});

test('parseStatusPorcelainZ：普通项、未跟踪项；重命名的新旧路径都列出', () => {
  // -z 下每条是 "<XY> <路径>"，重命名后面紧跟旧路径。
  const text = ' M src/中文 文件.js\0?? notes/a b.txt\0R  lib/a.js\0src/a.js\0C  copy/b.js\0src/b.js\0';
  assert.deepEqual(parseStatusPorcelainZ(text), [
    'src/中文 文件.js', 'notes/a b.txt', 'lib/a.js', 'src/a.js', 'copy/b.js', 'src/b.js',
  ]);
});

test('parseStatusPorcelainZ：排除 .agent-runs/ 下的文件（含重命名的旧路径）', () => {
  const text = '?? .agent-runs/x/progress.log\0?? .agent-runs/gate.json\0 M src/a.js\0'
    + 'R  src/b.js\0.agent-runs/y/old.log\0';
  assert.deepEqual(parseStatusPorcelainZ(text), ['src/a.js', 'src/b.js']);
});

test('parseNameStatusZ：重命名 / 复制按旧路径、新路径的顺序；去重保持出现顺序', () => {
  const text = 'M\0src/a.js\0A\0README.md\0R100\0src/旧 名.js\0lib/新 名.js\0C075\0src/c.js\0lib/c.js\0'
    + 'M\0src/a.js\0';
  assert.deepEqual(parseNameStatusZ(text), [
    'src/a.js', 'README.md', 'src/旧 名.js', 'lib/新 名.js', 'src/c.js', 'lib/c.js',
  ]);
});

test('parseNameStatusZ：空输入返回空数组', () => {
  assert.deepEqual(parseNameStatusZ(''), []);
  assert.deepEqual(parseStatusPorcelainZ(''), []);
});

// ---- 056：受保护路径的判断与 specsDir 规范化（协议 12.1 第 4 步） ----

// 受保护目录：基线项目配置里的 specsDir（这里直接给规范化后的值）与 .agent-router。
const PROTECTED = ['.agent-router', 'docs/specs'];

test('literalPrefixOf：第一个通配符之前的字面部分', () => {
  assert.equal(literalPrefixOf('**'), '');
  assert.equal(literalPrefixOf('docs/**'), 'docs/');
  assert.equal(literalPrefixOf('**/*.md'), '');
  assert.equal(literalPrefixOf('docs/specs/*.md'), 'docs/specs/');
  assert.equal(literalPrefixOf('docs/specs/012-*.md'), 'docs/specs/012-');
  assert.equal(literalPrefixOf('docs/specs/012-a?.md'), 'docs/specs/012-a');
  assert.equal(literalPrefixOf('.agent-router/project.json'), '.agent-router/project.json');
});

test('explicitlyAllowed：**、docs/**、**/*.md 不算"明确写了这个目录"，不放行', () => {
  assert.equal(explicitlyAllowed('docs/specs/012-x.md', ['**'], PROTECTED), false);
  assert.equal(explicitlyAllowed('docs/specs/012-x.md', ['docs/**'], PROTECTED), false);
  assert.equal(explicitlyAllowed('docs/specs/012-x.md', ['**/*.md'], PROTECTED), false);
  assert.equal(explicitlyAllowed('.agent-router/project.json', ['**'], PROTECTED), false);
  assert.equal(explicitlyAllowed('.agent-router/project.json', ['src/**', 'docs/**'], PROTECTED), false);
});

test('explicitlyAllowed：明确写了目录的模式放行', () => {
  assert.equal(explicitlyAllowed('docs/specs/012-x.md', ['src/**', 'docs/specs/**'], PROTECTED), true);
  assert.equal(explicitlyAllowed('docs/specs/012-x.md', ['docs/specs/012-*.md'], PROTECTED), true);
  assert.equal(explicitlyAllowed('.agent-router/project.json', ['.agent-router/project.json'], PROTECTED), true);
  assert.equal(explicitlyAllowed('.agent-router/project.json', ['.agent-router/**'], PROTECTED), true);
  // 模式放行但文件不在受保护目录下时不需要"明确写出"（调用方只对受保护文件问这个问题）。
  assert.equal(explicitlyAllowed('src/a.js', ['src/**'], PROTECTED), false);
});

test('explicitlyAllowed：大小写按 glob.mjs 的规则（注入选项，两个方向都验证）', () => {
  assert.equal(explicitlyAllowed('docs/specs/a.md', ['DOCS/SPECS/**'], PROTECTED, { caseInsensitive: true }), true);
  assert.equal(explicitlyAllowed('docs/specs/a.md', ['DOCS/SPECS/**'], PROTECTED, { caseInsensitive: false }), false);
  assert.equal(explicitlyAllowed('DOCS/SPECS/a.md', ['docs/specs/**'], PROTECTED, { caseInsensitive: true }), true);
});

test('explicitlyAllowed：Windows 上默认不区分大小写', { skip: process.platform !== 'win32' }, () => {
  assert.equal(explicitlyAllowed('DOCS/SPECS/A.MD', ['docs/specs/**'], PROTECTED), true);
});

test('normalizeSpecsDir：反斜杠、./ 与末尾 / 都规范化', () => {
  assert.equal(normalizeSpecsDir('docs/specs'), 'docs/specs');
  assert.equal(normalizeSpecsDir('specs/'), 'specs');
  assert.equal(normalizeSpecsDir('./docs/specs/'), 'docs/specs');
  assert.equal(normalizeSpecsDir('docs\\specs'), 'docs/specs');
  assert.equal(normalizeSpecsDir('.\\specs\\'), 'specs');
  assert.equal(normalizeSpecsDir('specs//'), 'specs');
});

test('normalizeSpecsDir：没写、不是字符串、空、绝对路径、含 .. 时回退 docs/specs', () => {
  assert.equal(normalizeSpecsDir(undefined), 'docs/specs');
  assert.equal(normalizeSpecsDir(null), 'docs/specs');
  assert.equal(normalizeSpecsDir(42), 'docs/specs');
  assert.equal(normalizeSpecsDir({}), 'docs/specs');
  assert.equal(normalizeSpecsDir(''), 'docs/specs');
  // 065 改写（协议 12.1 第 4 步：'.' / './' 是项目根本身）：
  // 原断言 assert.equal(normalizeSpecsDir('./'), 'docs/specs') → './' 规范化后为项目根 '.'。
  assert.equal(normalizeSpecsDir('./'), '.');
  assert.equal(normalizeSpecsDir('/abs/specs'), 'docs/specs');
  assert.equal(normalizeSpecsDir('C:\\abs\\specs'), 'docs/specs');
  assert.equal(normalizeSpecsDir('..'), 'docs/specs');
  assert.equal(normalizeSpecsDir('docs/../specs'), 'docs/specs');
  assert.equal(normalizeSpecsDir('docs/specs/../x'), 'docs/specs');
});

// ---- 065：specsDir 为项目根（协议 12.1 第 4 步）时的规范化、命名与放行 ----

test('normalizeSpecsDir：. 与 ./（含尾部 /、反斜杠）规范化后为项目根（.）', () => {
  assert.equal(normalizeSpecsDir('.'), '.');
  assert.equal(normalizeSpecsDir('./'), '.');
  assert.equal(normalizeSpecsDir('.\\'), '.');
  assert.equal(normalizeSpecsDir('.//'), '.');
  // 真没写（空串）仍是回退默认目录，不与 './' 混淆。
  assert.equal(normalizeSpecsDir(''), 'docs/specs');
});

test('isRootSpecFile：根目录下三位编号加连字符、.md 结尾才算；子目录、其他扩展名不算', () => {
  assert.equal(isRootSpecFile('065-x.md'), true);
  assert.equal(isRootSpecFile('065-修复.md'), true);
  assert.equal(isRootSpecFile('065-.md'), true);
  assert.equal(isRootSpecFile('999-a.md'), true);
  assert.equal(isRootSpecFile('065-x.MD', { caseInsensitive: true }), true, 'Windows 上不区分大小写');
  assert.equal(isRootSpecFile('065-x.MD', { caseInsensitive: false }), false, '非 Windows 上区分大小写');
  assert.equal(isRootSpecFile('065-x.md', { caseInsensitive: false }), true);
  assert.equal(isRootSpecFile('65-x.md'), false, '两位编号不算');
  assert.equal(isRootSpecFile('06-5x.md'), false);
  assert.equal(isRootSpecFile('1234-x.md'), false, '四位不算三位');
  assert.equal(isRootSpecFile('065-x.txt'), false);
  assert.equal(isRootSpecFile('065x.md'), false, '缺连字符不算');
  assert.equal(isRootSpecFile('README.md'), false);
  assert.equal(isRootSpecFile('docs/065-x.md'), false, '不在根目录不算');
  assert.equal(isRootSpecFile('065-x.MD', { caseInsensitive: false }), false, '注入选项时按给定大小写规则');
});

test('explicitlyAllowedRootSpec：放行的模式要明确写到编号（字面前缀以该文件的 NNN- 开头）', () => {
  assert.equal(explicitlyAllowedRootSpec('065-x.md', ['**']), false);
  assert.equal(explicitlyAllowedRootSpec('065-x.md', ['docs/**']), false);
  assert.equal(explicitlyAllowedRootSpec('065-x.md', ['*.md']), false);
  assert.equal(explicitlyAllowedRootSpec('065-x.md', ['065-*.md']), true);
  assert.equal(explicitlyAllowedRootSpec('065-x.md', ['065-x.md']), true);
  assert.equal(explicitlyAllowedRootSpec('065-x.md', ['065-*']), true);
  assert.equal(explicitlyAllowedRootSpec('066-x.md', ['065-*.md']), false, '编号不同不放行');
  assert.equal(explicitlyAllowedRootSpec('065-x.md', ['065-*.md', 'src/**']), true, '任一模式明确写出即可');
  // 大小写：注入选项两个方向都验证。
  assert.equal(explicitlyAllowedRootSpec('065-x.md', ['065-*.MD'], { caseInsensitive: false }), false);
  assert.equal(explicitlyAllowedRootSpec('065-x.MD', ['065-*.md'], { caseInsensitive: false }), false);
  assert.equal(explicitlyAllowedRootSpec('065-x.md', ['065-*.MD'], { caseInsensitive: true }), true);
});

// 093：runGate 的 extraEnv 在 removeEnv 之后合并；不传时验收命令的环境与原来相同。
function gateRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ar-093-gate-'));
  const run = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.name', 'gate 测试']);
  run(['config', 'user.email', 'gate@example.test']);
  run(['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'a.txt'), '初始\n');
  run(['add', 'a.txt']);
  run(['commit', '-q', '-m', '初始']);
  return { dir, base: run(['rev-parse', 'HEAD']) };
}
const dumpGateEnv = `node -e "console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(AR_|FOO_093)/i.test(k)))))"`;

test('runGate：extraEnv 在去掉 AR_ 变量之后合并，同名的父进程变量被它覆盖，其余 AR_ 变量照旧被去掉', async () => {
  const { dir, base } = gateRepo();
  try {
    const env = { ...process.env, AR_BASE_REPO: '父进程的值', AR_OTHER: '别的', FOO_093: '保留' };
    const gate = await runGate({ root: dir, base, spec: { verify: [dumpGateEnv] }, env, dir: path.join(dir, '.agent-runs'), extraEnv: { AR_BASE_REPO: '/主工作区', AR_WORKTREE: '/worktree' } });
    assert.equal(gate.ok, true, gate.summary);
    assert.deepEqual(JSON.parse(gate.commands[0].output.trim()), { FOO_093: '保留', AR_BASE_REPO: '/主工作区', AR_WORKTREE: '/worktree' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runGate：不传 extraEnv 时去掉全部 AR_ 变量，与原来相同', async () => {
  const { dir, base } = gateRepo();
  try {
    const env = { ...process.env, AR_BASE_REPO: '父进程的值', AR_WORKTREE: '父进程的值', FOO_093: '保留' };
    const gate = await runGate({ root: dir, base, spec: { verify: [dumpGateEnv] }, env, dir: path.join(dir, '.agent-runs') });
    assert.equal(gate.ok, true, gate.summary);
    assert.deepEqual(JSON.parse(gate.commands[0].output.trim()), { FOO_093: '保留' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
// 105：只读任务（调研 / 审查）的门禁——允许路径视为空、不要求提交，base..HEAD 与工作区里任何改动的文件都算越界。
test('summarizeGate：只读任务把越界与未提交合成"只读任务改动了文件"，不单列"有未提交的文件"；不只读时写法不变', () => {
  const only = { ...parts({ commit: { required: false, ok: true }, outside: ['a.js', 'b.js'], uncommitted: ['b.js'] }), readOnly: true };
  assert.equal(summarizeGate(only), '只读任务改动了文件：a.js、b.js');
  assert.equal(summarizeGate({ ...only, readOnly: undefined }), '有未提交的文件；改动超出范围：a.js、b.js', '没有 readOnly 时与原来一致');
  const many = { ...only, scope: { ...only.scope, outside: ['a', 'b', 'c', 'd', 'e', 'f'] }, uncommitted: [] };
  assert.equal(summarizeGate(many), '只读任务改动了文件：a、b、c、d、e 等');
  // 验收命令失败照常追加在后面。
  assert.equal(summarizeGate({ ...only, commands: [command({ exit: 2 })] }), '只读任务改动了文件：a.js、b.js；验收命令失败：npm test（exit 2）');
});

test('runGate readOnly：没有任何改动时通过，允许路径记空数组、不要求提交（即使说明写了 expect_commit 和 allowed_paths）', async () => {
  const { dir, base } = gateRepo();
  try {
    const gate = await runGate({ root: dir, base, readOnly: true, spec: { allowed_paths: ['src/**'], expect_commit: true, verify: [] }, dir: path.join(dir, '.agent-runs') });
    assert.equal(gate.ok, true, gate.summary);
    assert.equal(gate.summary, '门禁通过');
    assert.deepEqual(gate.scope.allowed, []);
    assert.deepEqual(gate.commit, { required: false, ok: true });
    assert.deepEqual(gate.scope.outside, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runGate readOnly：已提交的改动、没提交的改动、未跟踪的新文件都算越界；就算在 allowed_paths 里也一样', async () => {
  const { dir, base } = gateRepo();
  const run = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    writeFileSync(path.join(dir, 'a.txt'), '改过\n');
    run(['commit', '-q', '-am', '偷偷提交']);
    writeFileSync(path.join(dir, 'new.txt'), '新文件\n');
    const gate = await runGate({ root: dir, base, readOnly: true, spec: { allowed_paths: ['**'] }, dir: path.join(dir, '.agent-runs') });
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.scope.changed, ['a.txt']);
    assert.deepEqual(gate.uncommitted, ['new.txt']);
    assert.deepEqual(gate.scope.outside, ['a.txt', 'new.txt']);
    assert.equal(gate.summary, '只读任务改动了文件：a.txt、new.txt');
    // 同样的改动、不只读、允许 **：通过（对照）。
    const writable = await runGate({ root: dir, base, spec: { allowed_paths: ['**'] }, dir: path.join(dir, '.agent-runs') });
    assert.deepEqual(writable.scope.outside, []);
    assert.equal(writable.summary, '有未提交的文件');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runGate readOnly：.agent-runs 里的文件不算改动；受保护目录的改动记入 protected；验收命令照常运行', async () => {
  const { dir, base } = gateRepo();
  const run = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  try {
    mkdirSync(path.join(dir, '.agent-runs/x'), { recursive: true });
    writeFileSync(path.join(dir, '.agent-runs/x/progress.log'), '进度\n');
    const clean = await runGate({ root: dir, base, readOnly: true, spec: { verify: ['node -e "process.exit(0)"'] }, dir: path.join(dir, '.agent-runs', 'g1') });
    assert.equal(clean.ok, true, clean.summary);
    assert.equal(clean.commands.length, 1, '验收命令照常运行');
    mkdirSync(path.join(dir, 'docs/specs'), { recursive: true });
    writeFileSync(path.join(dir, 'docs/specs/001-x.md'), '改了任务说明\n');
    run(['add', 'docs/specs/001-x.md']);
    run(['commit', '-q', '-m', '改任务说明']);
    const protectedChange = await runGate({ root: dir, base, readOnly: true, spec: { verify: ['node -e "process.exit(3)"'] }, dir: path.join(dir, '.agent-runs', 'g2') });
    assert.equal(protectedChange.ok, false);
    assert.deepEqual(protectedChange.scope.protected, ['docs/specs/001-x.md']);
    assert.match(protectedChange.summary, /^只读任务改动了文件：docs\/specs\/001-x\.md；验收命令失败：/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});