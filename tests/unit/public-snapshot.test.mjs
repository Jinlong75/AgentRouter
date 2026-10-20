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

// 扫描器自测需要构造命中样例，所以运行时拼接：本测试文件也在导出集合里，源码里出现连续的内部文档名会让开发仓库的扫描常亮。
const INTERNAL_HANDOFF = 'CHECK' + 'POINT';
const INTERNAL_PLAN_DOC = 'docs' + '/plan/' + 'Visual' + 'Spec.md';

// 覆盖允许清单每一项（含 README.public.md）+ 内部文件 + 二进制文件；core.autocrlf 关掉，字节原样进出。
const committed = {
  'app/src/x.ts': 'export const x = 1;\n',
  'app/design/tokens.css': ':root { --bg: #0D0E10; }\n',
  'app/design/icons/app.svg': '<svg></svg>\n',
  'app/design/icons/app.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff, 0x80, 0x7f, 0x00]),
  'core/ar.mjs': 'export const dispatch = () => {};\n',
  'skills/agent-router/SKILL.md': '# 技能\n',
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
  [INTERNAL_PLAN_DOC]: '# ' + 'Visual' + 'Spec\n内部文档。\n',
  [`${INTERNAL_HANDOFF}.md`]: '内部交接记录。\n',
  'AGENTS.md': '内部共同规则。\n',
  'app/design/preview.html': '<!doctype html><title>界面稿</title>\n',
};
const expectedExported = Object.keys(committed)
  .filter(f => f !== 'README.md' && f !== 'README.public.md' && !f.startsWith('docs/') && f !== `${INTERNAL_HANDOFF}.md`
    && f !== 'AGENTS.md' && f !== 'app/design/preview.html')
  .concat('README.md').sort();

// 临时仓库用的假词表（不对应任何真实信息）；真词表在开发仓库的 .agent-router/ 下，测试绝不读写。
const fakeWordlist = {
  v: 1,
  note: '临时仓库的假词表，只用于测试',
  personal: ['FakeLeakName42'],
  localPaths: ['temp-secret-path'],
};
const makeRepo = (files = committed, { wordlist = true } = {}) => {
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
  // 词表提交之后再写、且保持未跟踪：它只在工作区被工具读取，不进 ls-tree、不影响排除计数。
  if (wordlist) {
    mkdirSync(path.join(repo, '.agent-router'), { recursive: true });
    writeFileSync(path.join(repo, '.agent-router', 'public-scan.json'), `${JSON.stringify(fakeWordlist, null, 2)}\n`);
  }
  return { root, repo, target: path.join(root, 'snap') };
};

// 第二次提交：只把指定路径交给 git add，未跟踪的假词表 / 同步记录不会被带进提交。
const commitChange = (repo, { write = {}, remove = [], msg = '更新' }) => {
  const paths = [];
  for (const [rel, content] of Object.entries(write)) {
    const abs = path.join(repo, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    paths.push(rel);
  }
  for (const rel of remove) {
    rmSync(path.join(repo, ...rel.split('/')), { force: true });
    paths.push(rel);
  }
  git(repo, ['add', '-A', '--', ...paths]);
  git(repo, ['commit', '-m', msg]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
};

// 模拟主导维护的同步记录：最后一行的 private 指向"上一公开版本"的私有提交（同样保持未跟踪）。
const writeSync = (repo, prevSha) => {
  mkdirSync(path.join(repo, '.agent-router'), { recursive: true });
  writeFileSync(path.join(repo, '.agent-router', 'public-sync.jsonl'),
    `${JSON.stringify({ v: 1, public: 'a'.repeat(40), private: prevSha, at: '2026-01-01T00:00:00Z', note: '测试记录' })}\n`);
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

// —— 025：内容扫描（命中即失败）、差异清单与 --allow-new、文档逐个白名单 ——
// 命中串在运行时拼接：本测试文件本身也在导出集合里，源码里出现连续的命中串会让开发仓库的扫描常亮。
test('四类内容扫描：任何命中都失败（退出码 1、不写快照），私有词与密钥遮成 ***', () => {
  const cases = [
    {
      name: '个人信息（词表词，不区分大小写）',
      fixture: '// 见 FAKELEAKNAME42\n',
      counts: '扫描结果：个人信息 1、本机路径 0、密钥格式 0、内部文档引用 0',
      re: /core\/ar\.mjs:\d+ 个人信息 \*\*\*/,
      absent: 'FAKELEAKNAME42',
    },
    {
      name: '个人信息（个人邮箱域；保留域与 noreply 不算）',
      fixture: '// 联系 ' + 'qa' + '@gmail.com\n',
      counts: '扫描结果：个人信息 1、本机路径 0、密钥格式 0、内部文档引用 0',
      re: /core\/ar\.mjs:\d+ 个人信息 \*\*\*@gmail\.com/,
      absent: 'qa' + '@gmail.com',
    },
    {
      name: '本机路径（词表词）',
      fixture: '// 见 temp-secret-path/x\n',
      counts: '扫描结果：个人信息 0、本机路径 1、密钥格式 0、内部文档引用 0',
      re: /core\/ar\.mjs:\d+ 本机路径 \*\*\*/,
      absent: 'temp-secret-path',
    },
    {
      name: '密钥格式',
      fixture: '// ' + 'sk-' + 'a'.repeat(24) + '\n',
      counts: '扫描结果：个人信息 0、本机路径 0、密钥格式 1、内部文档引用 0',
      re: /core\/ar\.mjs:\d+ 密钥格式 \*\*\*/,
      absent: 'sk-' + 'a'.repeat(24),
    },
    {
      name: '内部文档引用（交接文档）',
      fixture: '// 见 ' + 'CHECK' + 'POINT' + ' 交接\n',
      counts: '扫描结果：个人信息 0、本机路径 0、密钥格式 0、内部文档引用 1',
      // 断言同样拼接，测试文件里不留下可命中的连续字面量。
      re: new RegExp('core/ar\\.mjs:\\d+ 内部文档引用 ' + 'CHECK' + 'POINT'),
    },
    {
      name: '内部文档引用（任务说明编号写法）',
      fixture: '// 见 ' + '任务说明 0' + '99 的进展\n',
      counts: '扫描结果：个人信息 0、本机路径 0、密钥格式 0、内部文档引用 1',
      // 断言里也用 \d\d，避免源码出现"任务说明 + 空格 + 三位数字"的连续字面量。
      re: /core\/ar\.mjs:\d+ 内部文档引用 任务说明 0\d\d/,
    },
    {
      name: '内部文档引用（本仓库实际存在的任务说明文件名）',
      files: {
        ...committed,
        'docs/specs/002-示例任务.md': '# 示例任务\n',
        'core/ar.mjs': 'export const dispatch = () => {};\n// 见 002-示例任务 的说明\n',
      },
      counts: '扫描结果：个人信息 0、本机路径 0、密钥格式 0、内部文档引用 1',
      re: /core\/ar\.mjs:\d+ 内部文档引用 002-示例任务/,
    },
  ];
  for (const c of cases) {
    const files = c.files ?? { ...committed, 'core/ar.mjs': `export const dispatch = () => {};\n${c.fixture}` };
    const { repo, target } = makeRepo(files);
    const { status, out } = run(repo, target);
    assert.equal(status, 1, `${c.name}：${out}`);
    assert.match(out, c.re, c.name);
    assert.ok(out.includes(c.counts), `${c.name}：${out}`);
    assert.ok(out.includes('最终结论：失败'), c.name);
    if (c.absent) assert.ok(!out.includes(c.absent), `${c.name}：命中片段已遮住：${out}`);
    assert.equal(existsSync(target), false, `${c.name}：失败时不写快照`);
  }
});

test('真实用户目录与 8.3 短名命中本机路径；占位与系统账户例外不误报', () => {
  // 反斜杠在运行时拼出来，避免测试文件本身被开发仓库的扫描与 lint 命中。
  const sep = String.fromCharCode(92);
  const hits = [
    { p: `C:${sep}Users${sep}FakeTestuser${sep}a.txt`, absent: 'FakeTestuser' },
    { p: ['C:', 'Users', 'FakeTestuser', 'a.txt'].join('/'), absent: 'FakeTestuser' },
    { p: '/Users/' + 'FakeTestuser' + '/', absent: 'FakeTestuser' },
    { p: '/home/' + 'FakeTestuser' + '/', absent: 'FakeTestuser' },
    { p: ['Users/', 'FakeUser~1'].join('') + 'x', absent: 'FakeUser~1' },
  ];
  for (const { p, absent } of hits) {
    const { repo, target } = makeRepo({ ...committed, 'core/ar.mjs': `export const dispatch = () => {};\n// ${p}\n` });
    const { status, out } = run(repo, target);
    assert.equal(status, 1, `应命中：${p}：${out}`);
    assert.match(out, /core\/ar\.mjs:\d+ 本机路径 /, p);
    assert.ok(!out.includes(absent), `用户名遮住：${out}`);
  }
  const misses = [
    `C:${sep}Users${sep}Public${sep}a.txt`,
    `C:${sep}Users${sep}<name>${sep}a.txt`,
    `C:${sep}Users${sep}runner${sep}a.txt`,
    `C:${sep}Users${sep}runneradmin${sep}a.txt`,
    '/home/' + 'runner' + '/',
  ];
  for (const p of misses) {
    const { repo, target } = makeRepo({ ...committed, 'core/ar.mjs': `export const dispatch = () => {};\n// ${p}\n` });
    const { status, out } = run(repo, target);
    assert.equal(status, 0, `不应命中：${p}：${out}`);
  }
});

test('产品通用名字与示例路径、保留域与 noreply 邮箱都不误报', () => {
  const files = {
    ...committed,
    'core/ar.mjs': 'export const dispatch = () => {};\n'
      + '// 产品会在用户项目里生成 AGENTS.md、CLAUDE.md、docs/roles/lead.md、docs/specs/ 目录；\n'
      + '// 示例路径 docs/specs/001-已有说明.md 不是本仓库的任务说明。\n'
      + '// 邮箱：qa@example.com、' + 'nore' + 'ply' + '@gmail.com 不算个人信息。\n',
  };
  const { repo, target } = makeRepo(files);
  const { status, out } = run(repo, target);
  assert.equal(status, 0, out);
  assert.ok(out.includes('扫描结果：个人信息 0、本机路径 0、密钥格式 0、内部文档引用 0'), out);
  assert.ok(out.includes('最终结论：可推送'), out);
});

test('私有词表缺失时导出失败（不静默跳过）', () => {
  const { repo, target } = makeRepo(committed, { wordlist: false });
  const { status, out } = run(repo, target);
  assert.equal(status, 1, out);
  assert.match(out, /词表/);
  assert.equal(existsSync(target), false, '词表缺失时不写快照');
});

test('差异清单：新增 / 删除 / 修改逐个列出', () => {
  const { repo, target } = makeRepo({ ...committed, 'core/ar2.mjs': 'export const two = 2;\n' });
  const first = git(repo, ['rev-parse', 'HEAD']).trim();
  const second = commitChange(repo, {
    write: { 'core/extra.mjs': 'export const extra = 1;\n', 'tools/hello.mjs': 'console.log("hello v2");\n' },
    remove: ['core/ar2.mjs'],
    msg: '第二版',
  });
  writeSync(repo, first);
  const { status, out } = run(repo, target);
  assert.equal(status, 0, out);
  assert.ok(out.includes(`来源提交：${second}`), out);
  assert.ok(out.includes(`上一公开版本：${first}`), out);
  assert.ok(out.includes('差异清单：新增 1、删除 1、修改 1'), out);
  assert.ok(out.includes('新增：\n  core/extra.mjs'), out);
  assert.ok(out.includes('删除：\n  core/ar2.mjs'), out);
  assert.ok(out.includes('修改：\n  tools/hello.mjs'), out);
  assert.ok(out.includes('最终结论：可推送'), out);
});

test('差异里出现新增目录：需要用户批准（退出码 3），快照仍写出', () => {
  const { repo, target } = makeRepo(
    Object.fromEntries(Object.entries(committed).filter(([k]) => k !== 'installer/install.mjs')));
  const first = git(repo, ['rev-parse', 'HEAD']).trim();
  commitChange(repo, { write: { 'installer/install.mjs': committed['installer/install.mjs'] }, msg: '补上安装器' });
  writeSync(repo, first);
  const { status, out } = run(repo, target);
  assert.equal(status, 3, out);
  assert.ok(out.includes('需要用户批准的新增项（尚需用户批准）：'), out);
  assert.ok(/\n {2}installer\/\n/.test(out), `新增目录列出：${out}`);
  assert.ok(out.includes('最终结论：需要用户批准'), out);
  assert.ok(existsSync(path.join(target, 'package.json')), '快照仍写出供主导查看');
});

test('差异里出现新增文件类型：只有新扩展名这一项', () => {
  const { repo, target } = makeRepo(
    Object.fromEntries(Object.entries(committed).filter(([k]) => k !== 'app/design/icons/app.svg')));
  const first = git(repo, ['rev-parse', 'HEAD']).trim();
  commitChange(repo, { write: { 'app/design/icons/app.svg': committed['app/design/icons/app.svg'] }, msg: '补图标' });
  writeSync(repo, first);
  const { status, out } = run(repo, target);
  assert.equal(status, 3, out);
  const section = out.slice(out.indexOf('需要用户批准的新增项'), out.indexOf('最终结论'));
  const items = section.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
  assert.deepEqual(items, ['.svg'], out);
});

test('差异里出现新增文档类文件：--allow-new 必须逐项对应才放行', () => {
  const { repo, target } = makeRepo(committed);
  const first = git(repo, ['rev-parse', 'HEAD']).trim();
  commitChange(repo, { write: { 'core/adapters/README.md': '# 适配器\n' }, msg: '补文档' });
  writeSync(repo, first);
  // 新文档所在的 core/adapters/ 目录也是新目录，两项都要列进 --allow-new。
  const denied = run(repo, target, '--allow-new', 'core/adapters/');
  assert.equal(denied.status, 1, denied.out);
  assert.match(denied.out, /不一一对应/, denied.out);
  assert.match(denied.out, /缺少 core\/adapters\/README\.md/, denied.out);
  assert.equal(existsSync(target), false, '对不上时不写快照');
  const ok = run(repo, target, '--allow-new', 'core/adapters/,core/adapters/README.md');
  assert.equal(ok.status, 0, ok.out);
  assert.ok(ok.out.includes('已经用户批准放行'), ok.out);
  assert.ok(ok.out.includes('最终结论：可推送'), ok.out);
  assert.ok(existsSync(path.join(target, 'core', 'adapters', 'README.md')), '放行后快照写出');
});

test('--allow-new 多一项或没有可批准项时报错', () => {
  const { repo, target } = makeRepo(
    Object.fromEntries(Object.entries(committed).filter(([k]) => k !== 'installer/install.mjs')));
  const first = git(repo, ['rev-parse', 'HEAD']).trim();
  commitChange(repo, { write: { 'installer/install.mjs': committed['installer/install.mjs'] }, msg: '补上安装器' });
  writeSync(repo, first);
  // 少列目录项、多列文件项都算不对应。
  const wrong = run(repo, target, '--allow-new', 'installer/install.mjs');
  assert.equal(wrong.status, 1, wrong.out);
  assert.match(wrong.out, /不一一对应/, wrong.out);
  assert.match(wrong.out, /缺少 installer\/；多出 installer\/install\.mjs/, wrong.out);
  // 没有需要批准的项（首次导出）时，给 --allow-new 也算多出。
  const { repo: fresh, target: freshTarget } = makeRepo();
  const extra = run(fresh, freshTarget, '--allow-new', 'core/');
  assert.equal(extra.status, 1, extra.out);
  assert.match(extra.out, /多出 core\//, extra.out);
});

test('允许目录里未列入白名单的文档导致失败并列出', () => {
  const { repo, target } = makeRepo({ ...committed, 'core/new-guide.md': '# 新文档\n' });
  const { status, out } = run(repo, target);
  assert.equal(status, 1, out);
  assert.ok(out.includes('文档白名单外（导出失败）：core/new-guide.md'), out);
  assert.ok(out.includes('最终结论：失败'), out);
  assert.equal(existsSync(target), false, '文档白名单外时不写快照');
});

