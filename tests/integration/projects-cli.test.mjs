import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const initFiles = ['.agent-router/project.json', 'AGENTS.md', 'CLAUDE.md', 'docs/roles/lead.md', 'docs/roles/worker.md', 'docs/roles/reviewer.md', 'docs/specs/README.md', '.gitignore'];

function fixture(t) {
  const base = fs.mkdtempSync(path.join(tmpdir(), '项目命令 测试 '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repo = path.join(base, '仓库'), home = path.join(base, 'home'), user = path.join(base, 'user'), gitconfig = path.join(base, 'gitconfig');
  fs.mkdirSync(repo);
  fs.mkdirSync(user);
  fs.writeFileSync(gitconfig, '');
  // git 的全局/系统配置也隔离到临时目录：测试绝不读写用户真实的 ~/.gitconfig，"没有身份"能稳定复现。
  const env = { ...process.env, AGENT_ROUTER_HOME: home, HOME: user, USERPROFILE: user, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  const ar = (args, cwd = repo) => spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', windowsHide: true, shell: false });
  const gitGlobal = (...args) => spawnSync('git', ['config', '--global', ...args], { env, encoding: 'utf8', windowsHide: true, shell: false });
  const read = rel => fs.readFileSync(path.join(repo, rel), 'utf8');
  return { base, repo, home, user, gitconfig, env, ar, git, gitGlobal, read };
}

test('projects：add --allow-non-git 登记非 git 目录；list --json 带 exists/git/initialized', t => {
  const f = fixture(t);
  const notRepo = path.join(f.base, '不是仓库');
  fs.mkdirSync(notRepo);
  const normal = f.ar(['projects', 'add', notRepo, '--json'], f.base);
  assert.notEqual(normal.status, 0);
  assert.match(JSON.parse(normal.stdout).error, /不是 git 仓库/);

  const added = f.ar(['projects', 'add', notRepo, '--allow-non-git', '--json'], f.base);
  assert.equal(added.status, 0, added.stderr);

  const repo2 = path.join(f.base, '另一个仓库');
  fs.mkdirSync(repo2);
  assert.equal(spawnSync('git', ['-C', repo2, 'init', '-q'], { env: f.env, encoding: 'utf8' }).status, 0);
  assert.equal(f.ar(['init'], repo2).status, 0);

  const list = JSON.parse(f.ar(['projects', 'list', '--json'], f.base).stdout).projects;
  const byName = Object.fromEntries(list.map(p => [path.basename(p.path), p]));
  assert.deepEqual({ exists: byName['不是仓库'].exists, git: byName['不是仓库'].git, initialized: byName['不是仓库'].initialized }, { exists: true, git: false, initialized: false });
  assert.deepEqual({ exists: byName['另一个仓库'].exists, git: byName['另一个仓库'].git, initialized: byName['另一个仓库'].initialized }, { exists: true, git: true, initialized: true });
});

test('projects show：exists/git/branch/initialized/config/lastTask；未登记报错', t => {
  const f = fixture(t); assert.equal(f.git('init', '-q').status, 0);
  assert.equal(f.ar(['init']).status, 0);
  // 假 runs.jsonl：只取这个仓库最近一条 start。
  fs.writeFileSync(path.join(f.home, 'runs.jsonl'), [
    JSON.stringify({ event: 'start', repo: f.repo, name: '任务A', started: 1000 }),
    JSON.stringify({ event: 'start', repo: '别的仓库', name: '任务B', started: 2000 }),
    JSON.stringify({ event: 'start', repo: f.repo, name: '任务C', started: 3000 }),
    JSON.stringify({ event: 'end', id: 'x', exit: 0, at: 4000 }),
  ].join('\n') + '\n');
  const show = JSON.parse(f.ar(['projects', 'show', f.repo, '--json']).stdout).project;
  assert.equal(show.path, f.repo);
  assert.equal(show.exists, true);
  assert.equal(show.git, true);
  assert.equal(show.branch, f.git('symbolic-ref', '--short', 'HEAD').stdout.trim());
  assert.equal(show.initialized, true);
  assert.equal(show.config.v, 1);
  assert.equal(show.config.name, '仓库');
  assert.equal(show.configError, null);
  assert.deepEqual(show.lastTask, { name: '任务C', started: 3000 });
  // 隔离环境里没有任何提交身份：读不到就都是 null。
  assert.deepEqual(show.identity, { name: null, email: null });

  const notGit = path.join(f.base, '非 git 目录');
  fs.mkdirSync(notGit);
  assert.equal(f.ar(['projects', 'add', notGit, '--allow-non-git'], f.base).status, 0);
  const plain = JSON.parse(f.ar(['projects', 'show', notGit, '--json'], f.base).stdout).project;
  assert.equal(plain.git, false);
  assert.equal(plain.identity, null);

  const unregistered = f.ar(['projects', 'show', path.join(f.base, '未登记'), '--json'], f.base);
  assert.notEqual(unregistered.status, 0);
  assert.match(JSON.parse(unregistered.stdout).error, /没有登记这个项目/);
});

test('projects show：dirty 忽略 .agent-runs/', t => {
  const f = fixture(t); assert.equal(f.git('init', '-q').status, 0);
  assert.equal(f.ar(['projects', 'add', f.repo]).status, 0);
  fs.writeFileSync(path.join(f.repo, 'README.md'), '# 改动\n');
  fs.mkdirSync(path.join(f.repo, '.agent-runs'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.agent-runs', 'x.txt'), 'x\n');
  const show = JSON.parse(f.ar(['projects', 'show', f.repo, '--json']).stdout).project;
  assert.equal(show.git, true); assert.equal(show.initialized, false);
  assert.equal(show.dirty, 1, '.agent-runs/ 不算 dirty');
});

// Stage07b 126：高级四项。类型正确、其余字段不变、非法值一个字节不改、留空删键。
test('projects config 高级四项：合法值类型、非法值不改文件、留空删键', t => {
  const f = fixture(t); assert.equal(f.git('init', '-q').status, 0);
  assert.equal(f.ar(['init']).status, 0);
  const before = JSON.parse(f.read('.agent-router/project.json'));
  const wrote = JSON.parse(f.ar(['projects', 'config', f.repo, 'maxRetries=3', 'mergeMode=squash', 'verifyTimeoutMin=30', 'worktree=false', '--json']).stdout);
  assert.equal(wrote.ok, true);
  assert.deepEqual({ r: wrote.config.maxRetries, m: wrote.config.mergeMode, t: wrote.config.verifyTimeoutMin, w: wrote.config.worktree }, { r: 3, m: 'squash', t: 30, w: false });
  const onDisk = JSON.parse(f.read('.agent-router/project.json'));
  assert.equal(typeof onDisk.maxRetries, 'number'); assert.equal(typeof onDisk.verifyTimeoutMin, 'number'); assert.equal(onDisk.worktree, false);
  // 模板里可能已有这四个键中的某个；其余字段必须不变。
  const adv = ['maxRetries', 'mergeMode', 'verifyTimeoutMin', 'worktree'];
  for (const k of Object.keys(before).filter(k => !adv.includes(k))) assert.deepEqual(onDisk[k], before[k], `${k} 不变`);
  // 边界值
  const edge = JSON.parse(f.ar(['projects', 'config', f.repo, 'maxRetries=0', 'verifyTimeoutMin=240', 'mergeMode=no-ff', 'worktree=true', '--json']).stdout);
  assert.deepEqual({ r: edge.config.maxRetries, t: edge.config.verifyTimeoutMin, m: edge.config.mergeMode, w: edge.config.worktree }, { r: 0, t: 240, m: 'no-ff', w: true });
  const snapshot = f.read('.agent-router/project.json');
  for (const bad of ['maxRetries=6', 'maxRetries=-1', 'maxRetries=1.5', 'maxRetries=abc', 'mergeMode=rebase', 'verifyTimeoutMin=0', 'verifyTimeoutMin=241', 'worktree=yes']) {
    const r = f.ar(['projects', 'config', f.repo, 'baseBranch=other', bad, '--json']);
    assert.notEqual(r.status, 0, bad);
    assert.ok(JSON.parse(r.stdout).error.length > 0, bad);
    assert.equal(f.read('.agent-router/project.json'), snapshot, `${bad} 不修改文件`);
  }
  const cleared = JSON.parse(f.ar(['projects', 'config', f.repo, 'maxRetries=', 'mergeMode=', 'verifyTimeoutMin=', 'worktree=', '--json']).stdout);
  for (const k of ['maxRetries', 'mergeMode', 'verifyTimeoutMin', 'worktree']) assert.equal(k in cleared.config, false, `${k} 已删掉`);
  const rest = Object.fromEntries(Object.entries(before).filter(([k]) => !adv.includes(k)));
  assert.deepEqual(JSON.parse(f.read('.agent-router/project.json')), rest, '只删了这四个键，其余字段不变');
});

test('projects config：读、合法写入、各种非法值不改文件；未初始化报错', t => {
  const f = fixture(t); assert.equal(f.git('init', '-q').status, 0);
  assert.equal(f.ar(['init']).status, 0);
  const read = JSON.parse(f.ar(['projects', 'config', f.repo, '--json']).stdout);
  assert.equal(read.ok, true); assert.equal(read.config.v, 1);

  const wrote = JSON.parse(f.ar(['projects', 'config', f.repo, 'verify=["npm test","npm run lint"]', 'baseBranch=main', 'specsDir=docs/spec', 'allowedPaths=["core/**"]', '--json']).stdout);
  assert.equal(wrote.ok, true);
  assert.deepEqual(wrote.config.verify, ['npm test', 'npm run lint']);
  assert.equal(wrote.config.baseBranch, 'main');
  assert.equal(wrote.config.specsDir, 'docs/spec');
  assert.deepEqual(wrote.config.allowedPaths, ['core/**']);
  const fileAfterWrite = f.read('.agent-router/project.json');
  assert.equal(fileAfterWrite, JSON.stringify(wrote.config, null, 2) + '\n', '已原子写入');

  const invalid = [
    ['projects', 'config', f.repo, 'unknown=1', '--json'],
    ['projects', 'config', f.repo, 'verify=不是json', '--json'],
    ['projects', 'config', f.repo, 'verify=[""]', '--json'],
    ['projects', 'config', f.repo, 'allowedPaths=[]', '--json'],
    ['projects', 'config', f.repo, 'specsDir=/abs/path', '--json'],
    ['projects', 'config', f.repo, 'specsDir=../x', '--json'],
    ['projects', 'config', f.repo, 'specsDir=a\\b', '--json'],
    ['projects', 'config', f.repo, 'baseBranch=bad branch', '--json'],
  ];
  for (const args of invalid) {
    const r = f.ar(args);
    assert.notEqual(r.status, 0, args.join(' '));
    const error = JSON.parse(r.stdout).error;
    assert.ok(typeof error === 'string' && error.length > 0, args.join(' '));
  }
  assert.equal(f.read('.agent-router/project.json'), fileAfterWrite, '非法值不修改文件');

  const fresh = fixture(t); assert.equal(fresh.git('init', '-q').status, 0);
  assert.equal(fresh.ar(['projects', 'add', fresh.repo]).status, 0);
  const notInit = fresh.ar(['projects', 'config', fresh.repo, 'baseBranch=main', '--json']);
  assert.notEqual(notInit.status, 0);
  assert.match(JSON.parse(notInit.stdout).error, /项目还没有初始化：先运行 ar init/);
});

test('projects git-init：成功与已是仓库', t => {
  const f = fixture(t);
  const dir = path.join(f.base, '新仓库');
  fs.mkdirSync(dir);
  const r = JSON.parse(f.ar(['projects', 'git-init', dir, '--json'], f.base).stdout);
  assert.equal(r.ok, true); assert.equal(r.branch, 'main');
  assert.equal(spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env: f.env, encoding: 'utf8' }).status, 0);
  const again = f.ar(['projects', 'git-init', dir, '--json'], f.base);
  assert.notEqual(again.status, 0);
  assert.match(JSON.parse(again.stdout).error, /已经是 git 仓库/);
  const missing = f.ar(['projects', 'git-init', path.join(f.base, '不存在'), '--json'], f.base);
  assert.notEqual(missing.status, 0);
  assert.match(JSON.parse(missing.stdout).error, /文件夹不存在/);
});

test('projects commit-init：只提交初始化文件，无关改动不提交；无改动报错', t => {
  const f = fixture(t); assert.equal(f.git('init', '-q').status, 0);
  assert.equal(f.git('config', 'user.name', '测试').status, 0);
  assert.equal(f.git('config', 'user.email', '测试@example.invalid').status, 0);
  assert.equal(f.ar(['init']).status, 0);
  fs.writeFileSync(path.join(f.repo, '无关.txt'), '不该被提交\n');
  const r = JSON.parse(f.ar(['projects', 'commit-init', f.repo, '--json']).stdout);
  assert.equal(r.ok, true);
  assert.match(r.commit, /^[0-9a-f]{7,}$/);
  assert.deepEqual([...r.files].sort(), [...initFiles].sort());
  assert.equal(f.git('ls-files', '--', '无关.txt').stdout.trim(), '', '无关文件没有被 git add');
  assert.match(f.git('status', '--porcelain', '--', '无关.txt').stdout, /^\?\?/, '无关文件仍未被跟踪');

  const again = f.ar(['projects', 'commit-init', f.repo, '--json']);
  assert.notEqual(again.status, 0);
  assert.match(JSON.parse(again.stdout).error, /没有需要提交的初始化文件/);
});

test('projects commit-init：没有提交身份时不提交，返回 NEED_GIT_IDENTITY', t => {
  const f = fixture(t); assert.equal(f.git('init', '-q').status, 0);
  assert.equal(f.ar(['init']).status, 0);
  const r = f.ar(['projects', 'commit-init', f.repo, '--json']);
  assert.notEqual(r.status, 0);
  const json = JSON.parse(r.stdout);
  assert.equal(json.ok, false);
  assert.equal(json.code, 'NEED_GIT_IDENTITY');
  assert.match(json.error, /还没有设置 git 提交身份/);
  assert.notEqual(f.git('rev-parse', '--verify', 'HEAD').status, 0, '没有产生提交');
});

test('projects clear：清空登记表、不动项目文件夹与其中文件，--json 返回 removed；空表时 removed: 0', t => {
  const f = fixture(t);
  // 一个 git 仓库（初始化过、带自己的文件）和一个非 git 目录，都登记进去。
  assert.equal(f.git('init', '-q').status, 0);
  assert.equal(f.ar(['init']).status, 0);
  fs.writeFileSync(path.join(f.repo, '保留.txt'), '清空项目列表不能动这个文件\n');
  const notRepo = path.join(f.base, '不是仓库');
  fs.mkdirSync(notRepo);
  fs.writeFileSync(path.join(notRepo, '里面.txt'), '这个文件也要在\n');
  assert.equal(f.ar(['projects', 'add', notRepo, '--allow-non-git'], f.base).status, 0);
  assert.equal(JSON.parse(f.ar(['projects', 'list', '--json'], f.base).stdout).projects.length, 2);

  const cleared = JSON.parse(f.ar(['projects', 'clear', '--json'], f.base).stdout);
  assert.deepEqual(cleared, { ok: true, removed: 2 });
  assert.deepEqual(JSON.parse(f.ar(['projects', 'list', '--json'], f.base).stdout).projects, [], '登记表已清空');
  // 项目文件夹与其中文件都在：初始化写的文件、自己的文件、非 git 目录里的文件。
  for (const rel of [...initFiles, '保留.txt']) assert.ok(fs.existsSync(path.join(f.repo, rel)), `${rel} 应该还在`);
  assert.ok(fs.existsSync(path.join(notRepo, '里面.txt')), '非 git 目录里的文件应该还在');
  assert.ok(fs.existsSync(path.join(f.repo, '.git')), 'git 仓库本身应该还在');
  // 项目文件夹里的任务记录不动。
  fs.mkdirSync(path.join(f.repo, '.agent-runs', '任务A'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.agent-runs', '任务A', 'progress.log'), 'x\n');
  // 空表再清一次：removed: 0，不报错。
  const again = JSON.parse(f.ar(['projects', 'clear', '--json'], f.base).stdout);
  assert.deepEqual(again, { ok: true, removed: 0 });
  assert.ok(fs.existsSync(path.join(f.repo, '.agent-runs', '任务A', 'progress.log')), '任务记录文件应该还在');
  // 不带 --json 的文本输出说清数量；带多余参数报用法错误。
  assert.equal(f.ar(['projects', 'clear'], f.base).stdout.trim(), '已取消登记 0 个项目');
  assert.notEqual(f.ar(['projects', 'clear', '多余参数'], f.base).status, 0);
});

test('projects git-identity：默认写仓库、--global 写隔离的全局配置、非法值不写', t => {
  const f = fixture(t); assert.equal(f.git('init', '-q').status, 0);
  assert.equal(f.ar(['projects', 'add', f.repo]).status, 0);

  const repoSet = JSON.parse(f.ar(['projects', 'git-identity', f.repo, '--name', '测试用户', '--email', 'test@example.invalid', '--json']).stdout);
  assert.deepEqual(repoSet, { ok: true, identity: { name: '测试用户', email: 'test@example.invalid' }, scope: 'repo' });
  assert.equal(f.git('config', '--local', '--get', 'user.name').stdout.trim(), '测试用户');
  assert.equal(f.git('config', '--local', '--get', 'user.email').stdout.trim(), 'test@example.invalid');
  assert.equal(fs.readFileSync(f.gitconfig, 'utf8'), '', '默认不写全局配置');
  assert.deepEqual(JSON.parse(f.ar(['projects', 'show', f.repo, '--json']).stdout).project.identity, { name: '测试用户', email: 'test@example.invalid' });

  const before = fs.readFileSync(f.gitconfig, 'utf8');
  for (const args of [
    ['--name', '', '--email', 'a@b'],
    ['--name', '名'.repeat(101), '--email', 'a@b'],
    ['--name', '甲', '--email', '没有-at'],
    ['--name', '甲', '--email', 'a b@c'],
    ['--name', '甲', '--email', `${'x'.repeat(201)}@example.invalid`],
  ]) {
    const r = f.ar(['projects', 'git-identity', f.repo, ...args, '--json']);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.equal(JSON.parse(r.stdout).ok, false, args.join(' '));
    assert.equal(typeof JSON.parse(r.stdout).error, 'string', args.join(' '));
  }
  assert.equal(f.git('config', '--local', '--get', 'user.name').stdout.trim(), '测试用户', '非法值不覆盖已有配置');
  assert.equal(fs.readFileSync(f.gitconfig, 'utf8'), before, '非法值不写全局配置');

  const globalSet = JSON.parse(f.ar(['projects', 'git-identity', f.repo, '--name', '全局用户', '--email', 'global@example.invalid', '--global', '--json']).stdout);
  assert.deepEqual(globalSet, { ok: true, identity: { name: '全局用户', email: 'global@example.invalid' }, scope: 'global' });
  assert.match(fs.readFileSync(f.gitconfig, 'utf8'), /global@example\.invalid/);
  assert.equal(f.git('config', '--local', '--get', 'user.name').stdout.trim(), '测试用户', '--global 不改仓库配置');
  assert.equal(f.git('config', '--local', '--get', 'user.email').stdout.trim(), 'test@example.invalid');

  const unregistered = f.ar(['projects', 'git-identity', path.join(f.base, '未登记'), '--name', '甲', '--email', 'a@b', '--json'], f.base);
  assert.notEqual(unregistered.status, 0);
  assert.match(JSON.parse(unregistered.stdout).error, /没有登记这个项目/);
  const notGit = path.join(f.base, '普通文件夹');
  fs.mkdirSync(notGit);
  assert.equal(f.ar(['projects', 'add', notGit, '--allow-non-git'], f.base).status, 0);
  const nonGit = f.ar(['projects', 'git-identity', notGit, '--name', '甲', '--email', 'a@b', '--json'], f.base);
  assert.notEqual(nonGit.status, 0);
  assert.match(JSON.parse(nonGit.stdout).error, /不是 git 仓库/);
});

test('projects list --json：8 个项目覆盖各类路径，与串行参考实现逐项精确相等、顺序一致', t => {
  const f = fixture(t);
  const initRepo = dir => {
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync('git', ['-C', dir, 'init', '-q'], { env: f.env, encoding: 'utf8', windowsHide: true, shell: false });
    assert.equal(r.status, 0, r.stderr);
  };
  const add = (dir, extra = []) => {
    const r = f.ar(['projects', 'add', dir, ...extra], f.base);
    assert.equal(r.status, 0, r.stderr || r.stdout);
  };

  // 按登记顺序准备 8 个项目。
  const rootRepo = path.join(f.base, '仓库根'); initRepo(rootRepo); add(rootRepo); // git 仓库根目录
  const sub = path.join(rootRepo, '子目录'); fs.mkdirSync(sub); add(sub, ['--allow-non-git']); // git 仓库的子目录（不是根）
  const plain = path.join(f.base, '非 git 目录'); fs.mkdirSync(plain); add(plain, ['--allow-non-git']); // 非 git 目录
  const gone = path.join(f.base, '已删除的目录'); fs.mkdirSync(gone); add(gone, ['--allow-non-git']); fs.rmSync(gone, { recursive: true, force: true }); // 不存在的目录
  const initialized = path.join(f.base, '已初始化仓库'); initRepo(initialized);
  assert.equal(f.ar(['init'], initialized).status, 0); // 已初始化的仓库（ar init 自动登记）
  const spaced = path.join(f.base, '含 空格 与 中文 的仓库'); initRepo(spaced); add(spaced); // 路径含空格与中文
  const secondRepo = path.join(f.base, '第二个仓库'); initRepo(secondRepo); add(secondRepo);
  const thirdRepo = path.join(f.base, '第三个仓库'); initRepo(thirdRepo); add(thirdRepo);

  const registry = JSON.parse(f.ar(['projects', 'list', '--registry-only', '--json'], f.base).stdout).projects;
  assert.equal(registry.length, 8, '登记了 8 个项目');

  // 串行参考实现：逐个 spawnSync 同一条 git 命令，再按同样的真实路径比较与 initialized 判断算出期望。
  const real = file => { try { return fs.realpathSync.native(file); } catch { return path.resolve(file); } };
  const same = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  const expected = registry.map(p => {
    const root = path.resolve(p.path);
    const exists = fs.existsSync(root);
    let isGit = false;
    if (exists) {
      const top = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { env: f.env, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
      if (top.status === 0) { try { isGit = same(real(top.stdout.trim()), real(root)); } catch { isGit = false; } }
    }
    return { ...p, exists, git: isGit, initialized: exists && fs.existsSync(path.join(root, '.agent-router/project.json')) };
  });

  const listed = f.ar(['projects', 'list', '--json'], f.base);
  assert.equal(listed.status, 0, listed.stderr);
  const actual = JSON.parse(listed.stdout);
  assert.equal(actual.ok, true);
  assert.deepEqual(actual.projects, expected, '逐项精确相等且顺序与登记顺序一致');

  // 各覆盖项的实际结果。
  const byName = Object.fromEntries(actual.projects.map(p => [p.name, p]));
  assert.deepEqual([byName['仓库根'].exists, byName['仓库根'].git], [true, true]);
  assert.deepEqual([byName['子目录'].exists, byName['子目录'].git], [true, false], '子目录不是 git 根');
  assert.deepEqual([byName['非 git 目录'].exists, byName['非 git 目录'].git], [true, false]);
  assert.deepEqual([byName['已删除的目录'].exists, byName['已删除的目录'].git], [false, false], '目录不存在时不跑 git');
  assert.deepEqual([byName['已初始化仓库'].git, byName['已初始化仓库'].initialized], [true, true]);
  assert.deepEqual([byName['含 空格 与 中文 的仓库'].exists, byName['含 空格 与 中文 的仓库'].git], [true, true]);
});

test('projects list --registry-only：只读登记表（路径与名称），不查状态；目录不在也照样列出；其他参数仍报用法错误', t => {
  const f = fixture(t); assert.equal(f.git('init', '-q').status, 0);
  assert.equal(f.ar(['init']).status, 0);
  const gone = path.join(f.base, '已删除的目录');
  fs.mkdirSync(gone);
  assert.equal(f.ar(['projects', 'add', gone, '--allow-non-git'], f.base).status, 0);
  fs.rmSync(gone, { recursive: true, force: true });
  const full = JSON.parse(f.ar(['projects', 'list', '--json'], f.base).stdout).projects;
  const light = JSON.parse(f.ar(['projects', 'list', '--registry-only', '--json'], f.base).stdout);
  assert.equal(light.ok, true);
  // 与完整列表是同一批登记、同样的顺序；轻量查询不带 exists / git / initialized 这些需要探测的字段。
  assert.deepEqual(light.projects.map(p => p.path), full.map(p => p.path));
  for (const p of light.projects) for (const key of ['exists', 'git', 'initialized']) assert.ok(!(key in p), `轻量查询不应有 ${key}`);
  assert.ok(light.projects.some(p => p.path === gone), '目录已删除的登记项照样列出');
  const bad = f.ar(['projects', 'list', '--registry-only', '--bogus', '--json'], f.base);
  assert.notEqual(bad.status, 0);
  assert.match(JSON.parse(bad.stdout).error, /用法：ar projects list \[--registry-only\]/);
});

test('projects list / show --json（095）：顶层有 git 字段；AR_TEST_GIT_VERSION 报告旧版本时 ok 为 false，文字输出多一句提示；add 等其他命令不拦', t => {
  const f = fixture(t);
  assert.equal(spawnSync('git', ['-C', f.repo, 'init', '-q'], { env: f.env, encoding: 'utf8' }).status, 0);
  assert.equal(f.ar(['init']).status, 0);

  f.env.AR_TEST_GIT_VERSION = 'git version 2.45.2 (Apple Git-152)';
  let list = JSON.parse(f.ar(['projects', 'list', '--json'], f.base).stdout);
  assert.deepEqual(list.git, { version: '2.45.2', ok: true });
  assert.ok(list.projects.every(p => typeof p.git === 'boolean'), '每个项目里的 git 仍是"是否 git 仓库"，不重复版本对象');
  let show = JSON.parse(f.ar(['projects', 'show', '--json']).stdout);
  assert.deepEqual(show.git, { version: '2.45.2', ok: true });
  assert.ok(!/git 版本太旧/.test(f.ar(['projects', 'list'], f.base).stdout));

  f.env.AR_TEST_GIT_VERSION = 'git version 2.39.1.windows.1';
  list = JSON.parse(f.ar(['projects', 'list', '--json'], f.base).stdout);
  assert.deepEqual(list.git, { version: '2.39.1', ok: false });
  show = JSON.parse(f.ar(['projects', 'show', '--json']).stdout);
  assert.deepEqual(show.git, { version: '2.39.1', ok: false });
  assert.equal(show.project.initialized, true);
  const text = f.ar(['projects', 'list'], f.base);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /git 版本太旧：当前 2\.39\.1，worktree 模式需要 2\.40 或更新/);
  assert.match(f.ar(['projects', 'show']).stdout, /git 版本太旧：当前 2\.39\.1/);
  // --registry-only 与其他命令不受影响。
  assert.equal(f.ar(['projects', 'list', '--registry-only', '--json'], f.base).status, 0);
  const repo2 = path.join(f.base, '另一个仓库');
  fs.mkdirSync(repo2);
  assert.equal(spawnSync('git', ['-C', repo2, 'init', '-q'], { env: f.env, encoding: 'utf8' }).status, 0);
  assert.equal(f.ar(['projects', 'add', repo2, '--json'], f.base).status, 0, 'projects add 不拦');

  f.env.AR_TEST_GIT_VERSION = '乱码';
  assert.deepEqual(JSON.parse(f.ar(['projects', 'list', '--json'], f.base).stdout).git, { version: null, ok: null });
});