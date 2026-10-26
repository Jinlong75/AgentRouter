import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main } from '../../core/lib/cli.mjs';

const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const SPECS = 'docs/specs';

// 临时仓库 + 隔离的 git 全局配置；identity 为 false 时仓库里不设提交身份。
function fixture(t, { identity = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar archive 测试 '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repo = path.join(base, '仓库'), home = path.join(base, 'home'), user = path.join(base, 'user'), gitconfig = path.join(base, 'gitconfig');
  for (const dir of [repo, home, user]) fs.mkdirSync(dir);
  fs.writeFileSync(gitconfig, '');
  const gitEnv = { HOME: user, USERPROFILE: user, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  const saved = {};
  for (const [key, value] of Object.entries(gitEnv)) { saved[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const key of Object.keys(gitEnv)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  const env = { ...process.env, AGENT_ROUTER_HOME: home };
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', windowsHide: true, shell: false });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q');
  // 初始提交用一次性身份；仓库配置里的身份按需再写。
  fs.mkdirSync(path.join(repo, SPECS), { recursive: true });
  const write = (rel, text = `# ${rel}\n`) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  const commitAll = (message, files) => {
    git('add', '--', ...files);
    git('-c', 'user.name=初始', '-c', 'user.email=init@example.invalid', 'commit', '-q', '-m', message, '--', ...files);
  };
  write('README.md');
  write(`${SPECS}/README.md`);
  write(`${SPECS}/002-a.md`);
  write(`${SPECS}/003-b.md`);
  write(`${SPECS}/004-c.md`);
  commitAll('init', ['README.md', `${SPECS}/README.md`, `${SPECS}/002-a.md`, `${SPECS}/003-b.md`, `${SPECS}/004-c.md`]);
  if (identity) { git('config', 'user.name', '测试'); git('config', 'user.email', '测试@example.invalid'); }
  const call = async (argv, { form } = {}) => {
    const out = [];
    const code = await main(argv, { scriptPath: entry, env, cwd: repo, out: s => out.push(s), readForm: async () => form });
    return { code, out, json: argv.includes('--json') ? JSON.parse(out.at(-1)) : null };
  };
  const exists = rel => fs.existsSync(path.join(repo, rel));
  const status = () => git('status', '--porcelain', '--untracked-files=all');
  return { base, repo, git, call, write, exists, status, commitAll };
}

test('归档并提交：文件移到 archive/，只多一个提交且只含这四个路径，事先暂存的别的文件不进提交', async t => {
  const f = fixture(t);
  f.write('other.txt', '别的文件\n');
  f.git('add', '--', 'other.txt');
  const before = f.git('rev-parse', 'HEAD');
  const r = await f.call(['spec', 'archive', f.repo, `${SPECS}/002-a.md`, `${SPECS}/003-b.md`, '--commit', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.moved, [
    { from: `${SPECS}/002-a.md`, to: `${SPECS}/archive/002-a.md` },
    { from: `${SPECS}/003-b.md`, to: `${SPECS}/archive/003-b.md` },
  ]);
  assert.match(r.json.commit, /^[0-9a-f]{7,}$/);
  for (const name of ['002-a.md', '003-b.md']) {
    assert.ok(f.exists(`${SPECS}/archive/${name}`), `${name} 应在 archive/ 里`);
    assert.equal(f.exists(`${SPECS}/${name}`), false, `${name} 不应还在原位置`);
  }
  assert.ok(f.exists(`${SPECS}/004-c.md`), '没点名的说明不动');
  assert.equal(f.git('rev-parse', 'HEAD~1'), before, '只多一个提交');
  assert.equal(f.git('log', '-1', '--pretty=%s'), ['[主导] 归档任务说明', '002～003'].join(' '));
  const changed = f.git('show', '--name-status', '--no-renames', '--pretty=format:', 'HEAD').split('\n').map(l => l.replace(/\t/g, ' ')).sort();
  assert.deepEqual(changed, [
    `A ${SPECS}/archive/002-a.md`, `A ${SPECS}/archive/003-b.md`, `D ${SPECS}/002-a.md`, `D ${SPECS}/003-b.md`,
  ]);
  assert.equal(f.status(), 'A  other.txt', '事先暂存的文件仍在暂存区、没进提交');
});

test('不带 --commit：只 git mv，不提交', async t => {
  const f = fixture(t);
  const before = f.git('rev-parse', 'HEAD');
  const r = await f.call(['spec', 'archive', f.repo, `${SPECS}/004-c.md`, '--json']);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.commit, undefined);
  assert.ok(f.exists(`${SPECS}/archive/004-c.md`));
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.match(f.status(), /^R {2}docs\/specs\/004-c\.md -> docs\/specs\/archive\/004-c\.md$/);
});

test('归档后新建任务说明：编号接着归档里最大的继续', async t => {
  const f = fixture(t);
  // 归档 004（顶层最大），再新建：下一个必须是 005 之后，不能回到 004。
  f.write(`${SPECS}/005-d.md`);
  f.commitAll('d', [`${SPECS}/005-d.md`]);
  await f.call(['spec', 'archive', f.repo, `${SPECS}/005-d.md`, '--commit', '--json']);
  assert.equal(f.exists(`${SPECS}/005-d.md`), false);
  const created = await f.call(['spec', 'new', f.repo, '--dry-run', '--json'], { form: JSON.stringify({ title: '新说明', goal: '目标' }) });
  assert.equal(created.json.id, '006');
  assert.equal(created.json.rel, `${SPECS}/006-新说明.md`);
  // 顶层没有任何说明编号、只有归档里有时同样按归档算。
  const g = fixture(t);
  for (const name of ['002-a.md', '003-b.md', '004-c.md']) g.git('rm', '-q', '--', `${SPECS}/${name}`);
  g.write(`${SPECS}/archive/009-z.md`);
  const next = await g.call(['spec', 'new', g.repo, '--dry-run', '--json'], { form: JSON.stringify({ title: 'x', goal: 'y' }) });
  assert.equal(next.json.id, '010');
});

test('spec list：默认不含归档，archivedCount 正确；--include-archived 含归档且 archived: true', async t => {
  const f = fixture(t);
  await f.call(['spec', 'archive', f.repo, `${SPECS}/002-a.md`, `${SPECS}/003-b.md`, '--commit', '--json']);
  const plain = await f.call(['spec', 'list', f.repo, '--json']);
  assert.deepEqual(plain.json.specs.map(s => s.rel), [`${SPECS}/004-c.md`]);
  assert.equal(plain.json.specs[0].archived, undefined);
  assert.equal(plain.json.archivedCount, 2);
  const all = await f.call(['spec', 'list', f.repo, '--include-archived', '--json']);
  assert.equal(all.json.archivedCount, 2);
  assert.deepEqual(all.json.specs.map(s => [s.rel, s.archived === true]).sort(), [
    [`${SPECS}/004-c.md`, false], [`${SPECS}/archive/002-a.md`, true], [`${SPECS}/archive/003-b.md`, true],
  ]);
  assert.equal(all.json.specs.at(-1).archived, true, '归档的排在未归档的后面');
  const none = fixture(t);
  assert.equal((await none.call(['spec', 'list', none.repo, '--json'])).json.archivedCount, 0);
});

test('拒绝的情况：README、已在 archive/、未跟踪、项目外、目标已存在、重复路径，什么都不改', async t => {
  const f = fixture(t);
  f.write(`${SPECS}/archive/001-old.md`);
  f.commitAll('old', [`${SPECS}/archive/001-old.md`]);
  f.write(`${SPECS}/005-untracked.md`);
  f.write(`${SPECS}/006-clash.md`);
  f.commitAll('clash', [`${SPECS}/006-clash.md`]);
  f.write(`${SPECS}/archive/006-clash.md`, '归档里同名的另一份\n');
  const outside = path.join(f.base, '项目外.md');
  fs.writeFileSync(outside, '# 外面\n');
  f.write('notes/x.md');
  f.commitAll('notes', ['notes/x.md']);
  const head = f.git('rev-parse', 'HEAD');
  const snapshot = f.status();
  const cases = [
    [[`${SPECS}/README.md`], /README/],
    [[`${SPECS}/archive/001-old.md`], /已经在归档里/],
    [[`${SPECS}/005-untracked.md`], /没有被 git 跟踪/],
    [[outside], /项目内/],
    [['../项目外.md'], /项目内/],
    [['notes/x.md'], /顶层/],
    [[`${SPECS}/004-c.md`, `${SPECS}/006-clash.md`], /已经有同名/],
    [[`${SPECS}/004-c.md`, `${SPECS}/004-c.md`], /重复/],
    [[`${SPECS}/004-c.txt`], /\.md/],
  ];
  for (const [paths, pattern] of cases) {
    const r = await f.call(['spec', 'archive', f.repo, ...paths, '--commit', '--json']);
    assert.equal(r.json.ok, false, paths.join(' '));
    assert.match(r.json.error, pattern, paths.join(' '));
    assert.equal(f.git('rev-parse', 'HEAD'), head, `${paths.join(' ')}：不应有新提交`);
    assert.equal(f.status(), snapshot, `${paths.join(' ')}：工作区与暂存区都不应改变`);
    assert.ok(f.exists(`${SPECS}/004-c.md`), '合法的那份也没有被移动');
  }
  assert.equal(fs.readFileSync(path.join(f.repo, SPECS, 'archive', '006-clash.md'), 'utf8'), '归档里同名的另一份\n');
  assert.equal((await f.call(['spec', 'archive', f.repo, '--json'])).json.ok, false, '没给路径是用法错误');
});

test('缺提交身份：NEED_GIT_IDENTITY，文件没有被移动', async t => {
  const f = fixture(t, { identity: false });
  const head = f.git('rev-parse', 'HEAD');
  const r = await f.call(['spec', 'archive', f.repo, `${SPECS}/002-a.md`, '--commit', '--json']);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'NEED_GIT_IDENTITY');
  assert.ok(f.exists(`${SPECS}/002-a.md`));
  assert.equal(f.exists(`${SPECS}/archive/002-a.md`), false);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.status(), '');
});

test('归档代码路径上没有删除文件的调用', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../core/lib/spec-new.mjs', import.meta.url)), 'utf8');
  const from = source.indexOf('function archiveSpecs'), to = source.indexOf('function specIdentity');
  assert.ok(from > 0 && to > from);
  const body = source.slice(from, to);
  assert.doesNotMatch(body, /rmSync|unlinkSync|rmdirSync|\bunlink\b|'rm'|"rm"/);
  assert.doesNotMatch(source, /rmSync|unlinkSync/);
});
