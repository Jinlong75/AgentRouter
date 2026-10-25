import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main } from '../../core/lib/cli.mjs';
import { runGate } from '../../core/lib/gate.mjs';
import { matchesAny } from '../../core/lib/glob.mjs';

const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

// 临时仓库：git 的全局 / 系统配置隔离到临时目录，测试不读写用户真实的 git 配置。
function fixture(t, { git = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar check-paths 测试 '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repo = path.join(base, '仓库'), home = path.join(base, 'home'), user = path.join(base, 'user'), gitconfig = path.join(base, 'gitconfig');
  for (const dir of [repo, home, user]) fs.mkdirSync(dir);
  fs.writeFileSync(gitconfig, '');
  const gitEnv = { HOME: user, USERPROFILE: user, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  const saved = {};
  for (const [key, value] of Object.entries(gitEnv)) { saved[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const key of Object.keys(gitEnv)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  const env = { ...process.env, AGENT_ROUTER_HOME: home };
  const gitCmd = args => {
    const r = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', windowsHide: true, shell: false });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel, text = `${rel}\n`) => {
    const file = path.join(repo, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  if (git) {
    gitCmd(['init', '-q']);
    gitCmd(['config', 'user.name', '测试']);
    gitCmd(['config', 'user.email', 'test@example.invalid']);
  }
  const call = async (argv, cwd = repo) => {
    const out = [];
    const code = await main(argv, { scriptPath: entry, env, cwd, out: s => out.push(s) });
    return { code, out, json: argv.includes('--json') ? JSON.parse(out.at(-1)) : null };
  };
  const check = (paths, ...extra) => call(['spec', 'check-paths', '--project', repo, '--paths', JSON.stringify(paths), ...extra, '--json']);
  return { base, repo, home, gitCmd, write, call, check };
}

// 已跟踪、未跟踪、被忽略、.agent-runs 四种文件。
function populate({ gitCmd, write }) {
  write('.gitignore', 'build/\n*.log\n');
  write('README.md');
  write('src/a.ts');
  write('src/b.ts');
  write('src/deep/c.ts');
  write('tests/a.test.ts');
  gitCmd(['add', '.gitignore', 'README.md', 'src', 'tests']);
  gitCmd(['commit', '-q', '-m', 'init']);
  write('src/untracked.ts');        // 未跟踪、没被忽略：算
  write('docs/new.md');             // 未跟踪的新目录：算
  write('build/out.js');            // 被忽略：不算
  write('src/debug.log');           // 被忽略：不算
  write('.agent-runs/t1/progress.log'); // 任务记录：不算
  write('.agent-runs/notes.md');       // 任务记录里的非 .log 文件也不算
}

test('check-paths：已跟踪、未跟踪都算，被忽略的和 .agent-runs 不算；每个通配符各自计数', async t => {
  const fx = fixture(t);
  populate(fx);
  const { code, json } = await fx.check(['src/*.ts', 'src/**', 'docs/*', 'build/**', 'nothing/**']);
  assert.equal(code, 0);
  assert.equal(json.ok, true);
  // src/*.ts：a、b、untracked（src/deep/c.ts 不在这一层）；src/**：再加 deep/c.ts；docs/*：new.md。
  assert.deepEqual(json.files.slice().sort(), ['docs/new.md', 'src/a.ts', 'src/b.ts', 'src/deep/c.ts', 'src/untracked.ts']);
  assert.equal(json.total, 5);
  assert.equal(json.truncated, false);
  assert.deepEqual(json.patterns, [
    { pattern: 'src/*.ts', count: 3 }, { pattern: 'src/**', count: 4 }, { pattern: 'docs/*', count: 1 },
    { pattern: 'build/**', count: 0 }, { pattern: 'nothing/**', count: 0 },
  ]);
  // 项目文件总数：.gitignore、README.md、src 里 4 个、tests 里 1 个、docs/new.md = 8。
  assert.equal(json.fileCount, 8);
  assert.equal(json.all, false);
  const everything = (await fx.check(['**', '.agent-runs/**'], '--limit', '100')).json;
  for (const hidden of ['build/out.js', 'src/debug.log', '.agent-runs/t1/progress.log', '.agent-runs/notes.md']) {
    assert.ok(!everything.files.includes(hidden), `${hidden} 不该被算作现有文件`);
  }
  assert.equal(everything.total, 8);
  assert.deepEqual(everything.patterns.map(p => p.count), [8, 0]);
});

test('check-paths：--limit 截断只影响列出的文件，total 与计数不变', async t => {
  const fx = fixture(t);
  populate(fx);
  const { json } = await fx.check(['src/**'], '--limit', '2');
  assert.equal(json.total, 4);
  assert.equal(json.files.length, 2);
  assert.equal(json.truncated, true);
  assert.deepEqual(json.patterns, [{ pattern: 'src/**', count: 4 }]);
  const exact = (await fx.check(['src/**'], '--limit', '4')).json;
  assert.equal(exact.files.length, 4);
  assert.equal(exact.truncated, false);
  // 默认最多列 20 个。
  for (let i = 0; i < 25; i++) fx.write(`many/f${String(i).padStart(2, '0')}.txt`);
  const many = (await fx.check(['many/**'])).json;
  assert.equal(many.total, 25);
  assert.equal(many.files.length, 20);
  assert.equal(many.truncated, true);
  const zero = (await fx.check(['many/**'], '--limit', '0')).json;
  assert.deepEqual([zero.total, zero.files.length, zero.truncated], [25, 0, true]);
});

test('check-paths：匹配全部文件时 all 为真（不含被忽略的和 .agent-runs）', async t => {
  const fx = fixture(t);
  populate(fx);
  const everything = (await fx.check(['**'])).json;
  assert.equal(everything.all, true);
  assert.equal(everything.total, everything.fileCount);
  assert.equal(everything.fileCount, 8);
  const partial = (await fx.check(['src/**', 'README.md'])).json;
  assert.equal(partial.all, false);
  // 两项合起来盖住全部文件也算全部。
  const union = (await fx.check(['src/**', 'tests/**', 'docs/**', '.gitignore', 'README.md'])).json;
  assert.equal(union.all, true);
  // 空数组：什么都没匹配到，不算全部。
  const empty = (await fx.check([])).json;
  assert.deepEqual([empty.ok, empty.total, empty.all, empty.fileCount], [true, 0, false, 8]);
});

test('check-paths：非法通配符 ok:false 且写清是哪一项，退出码 2', async t => {
  const fx = fixture(t);
  populate(fx);
  const cases = [
    [['src/**', 'C:/x/**'], /第 2 项不能带盘符.*C:\/x\/\*\*/],
    [['../secret'], /第 1 项不能包含 \. 或 \.\. 段/],
    [['/etc/**'], /第 1 项必须是相对路径/],
    [['src\\a.ts'], /第 1 项不能包含反斜杠/],
    [['src/**', '  '], /第 2 项不能为空/],
  ];
  for (const [paths, pattern] of cases) {
    const { code, json } = await fx.check(paths);
    assert.equal(code, 2, JSON.stringify(paths));
    assert.equal(json.ok, false);
    assert.match(json.error, pattern);
  }
  // --paths 不是 JSON 字符串数组。
  for (const raw of ['not json', '{"a":1}', '[1]', '"src/**"']) {
    const { code, json } = await fx.call(['spec', 'check-paths', '--project', fx.repo, '--paths', raw, '--json']);
    assert.equal(code, 2, raw);
    assert.equal(json.ok, false);
    assert.match(json.error, /--paths/);
  }
  // --limit 不是非负整数；缺参数、多余参数给用法。
  for (const bad of ['-1', 'x', '1.5', '']) {
    const { code, json } = await fx.check(['src/**'], '--limit', bad);
    assert.equal(code, 2, `--limit ${bad}`);
    assert.match(json.error, /--limit/);
  }
  for (const argv of [['spec', 'check-paths'], ['spec', 'check-paths', '--project', fx.repo], ['spec', 'check-paths', '--paths', '[]'], ['spec', 'check-paths', '--project', fx.repo, '--paths', '[]', '--bogus', '1']]) {
    const { code, json } = await fx.call([...argv, '--json']);
    assert.equal(code, 2, argv.join(' '));
    assert.match(json.error, /用法：ar spec check-paths/);
  }
});

test('check-paths：项目不是 git 仓库时 ok:false，退出码 2', async t => {
  const fx = fixture(t, { git: false });
  fx.write('README.md');
  const { code, json } = await fx.check(['**']);
  assert.equal(code, 2);
  assert.equal(json.ok, false);
  assert.match(json.error, /不是 git 仓库/);
  // 不存在的目录同样 ok:false。
  const missing = await fx.call(['spec', 'check-paths', '--project', path.join(fx.base, '不存在'), '--paths', '["**"]', '--json']);
  assert.equal(missing.code, 2);
  assert.equal(missing.json.ok, false);
});

test('check-paths：只读，不写任何文件，也不改 git 状态', async t => {
  const fx = fixture(t);
  populate(fx);
  const snapshot = () => ({
    status: fx.gitCmd(['status', '--porcelain', '--untracked-files=all', '--ignored']),
    files: fs.readdirSync(fx.repo, { recursive: true }).sort(),
    home: fs.readdirSync(fx.home, { recursive: true }).sort(),
  });
  const before = snapshot();
  await fx.check(['src/**', 'docs/**']);
  assert.deepEqual(snapshot(), before);
});

test('check-paths：不带 --json 时输出可读文字', async t => {
  const fx = fixture(t);
  populate(fx);
  const some = await fx.call(['spec', 'check-paths', '--project', fx.repo, '--paths', '["src/*.ts","nothing"]', '--limit', '1']);
  assert.equal(some.code, 0);
  const text = some.out.join('\n');
  assert.match(text, /匹配到 3 个现有文件/);
  assert.match(text, /还有 2 个/);
  assert.match(text, /nothing：0 个/);
  const all = await fx.call(['spec', 'check-paths', '--project', fx.repo, '--paths', '["**"]']);
  assert.match(all.out.join('\n'), /匹配项目里全部 8 个文件/);
});

test('check-paths：与门禁判断一致——门禁判为"在范围内"的文件集合与这里匹配到的相同', async t => {
  const fx = fixture(t);
  fx.write('README.md');
  fx.gitCmd(['add', 'README.md']);
  fx.gitCmd(['commit', '-q', '-m', 'base']);
  const base = fx.gitCmd(['rev-parse', 'HEAD']);
  const files = [
    'src/a.ts', 'src/b.js', 'src/deep/c.ts', 'src/deep/er/d.ts', 'lib/x.ts', 'a.ts', 'docs/guide.md', 'docs/api/ref.md',
    'Src/Upper.ts', 'file.test.ts', 'test/file.test.ts', 'data/q1.json', 'data/q12.json', 'data/q.json', 'tool?.cmd', 'x/y/z/w.txt',
  ].filter(file => {
    // 文件名里有 ? 在 Windows 上建不了，跳过它。
    try { fx.write(file); return true; } catch { return false; }
  });
  fx.gitCmd(['add', '--', ...files]);
  fx.gitCmd(['commit', '-q', '-m', 'work']);
  const groups = [
    ['**'], ['src/**'], ['src/*.ts'], ['**/*.ts'], ['**/d.ts', 'docs/*.md'], ['src/**/c.ts'], ['**/test/**'], ['*.ts'], ['*.test.ts', '**/*.test.ts'],
    ['data/q?.json'], ['data/q*.json'], ['x/**/w.txt'], ['nothing/**'], ['src/deep/'], ['docs/api/ref.md', 'README.md'],
  ];
  for (const allowed of groups) {
    const gate = await runGate({
      root: fx.repo, base, dir: path.join(fx.base, 'gate-out'),
      spec: { allowed_paths: allowed, verify: [], expect_commit: false },
    });
    const changed = gate.scope.changed;
    assert.ok(changed.length >= files.length - 1, `门禁应看到这次提交的文件：${changed.join('、')}`);
    const inScope = changed.filter(file => !gate.scope.outside.includes(file)).sort();
    const { json } = await fx.check(allowed, '--limit', '1000');
    assert.equal(json.ok, true);
    const previewed = json.files.filter(file => changed.includes(file)).sort();
    assert.deepEqual(previewed, inScope, `允许路径 ${JSON.stringify(allowed)}：预览与门禁对同一批文件的判断不一致`);
    // 预览列出的每个文件都满足 glob.mjs 的 matchesAny（门禁用的函数）。
    assert.ok(json.files.every(file => matchesAny(file, allowed)));
  }
});
