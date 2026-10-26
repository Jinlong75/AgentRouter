import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// 125：不用命令行的提交（ar projects changes / commit / commit-init --with-existing，show 的 globalIdentity）。
// 临时仓库；git 的全局与系统配置隔离到临时目录（GIT_CONFIG_GLOBAL），绝不读写用户真实的 ~/.gitconfig。
const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const initFiles = ['.agent-router/project.json', 'AGENTS.md', 'CLAUDE.md', 'docs/roles/lead.md', 'docs/roles/worker.md', 'docs/roles/reviewer.md', 'docs/specs/README.md', '.gitignore'];

function fixture(t, { identity = true } = {}) {
  const base = fs.mkdtempSync(path.join(tmpdir(), '提交 测试 '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repo = path.join(base, '仓库 一'), home = path.join(base, 'home'), user = path.join(base, 'user'), gitconfig = path.join(base, 'gitconfig');
  fs.mkdirSync(repo);
  fs.mkdirSync(user);
  fs.writeFileSync(gitconfig, '');
  const env = { ...process.env, AGENT_ROUTER_HOME: home, HOME: user, USERPROFILE: user, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  const ar = (args, { cwd = repo, input } = {}) => spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false, input });
  // 测试自己读 git 输出时关掉路径转义，便于直接比较中文路径（被测的核心用 -z，不受这个配置影响）。
  const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { env, encoding: 'utf8', windowsHide: true, shell: false });
  const write = (rel, text = `${rel}\n`) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const f = { base, repo, home, gitconfig, env, ar, git, write };
  f.json = (args, options) => { const r = ar([...args, '--json'], options); return { status: r.status, json: JSON.parse(r.stdout), stderr: r.stderr }; };
  f.setup = () => {
    assert.equal(git('init', '-q', '-b', 'main').status, 0);
    if (identity) {
      assert.equal(git('config', 'user.name', '测试').status, 0);
      assert.equal(git('config', 'user.email', 'test@example.invalid').status, 0);
    }
    assert.equal(git('config', 'commit.gpgsign', 'false').status, 0);
    return f;
  };
  // 建一个已有提交的仓库：跟踪 a.txt、b.txt、中文 文件.txt、要删的.txt。
  f.withHistory = () => {
    f.setup();
    for (const rel of ['a.txt', 'b.txt', '中文 文件.txt', '要删的.txt', '要改名.txt']) f.write(rel);
    assert.equal(git('add', '--', 'a.txt', 'b.txt', '中文 文件.txt', '要删的.txt', '要改名.txt').status, 0);
    assert.equal(git('commit', '-q', '-m', '初始').status, 0);
    return f;
  };
  f.status = () => git('status', '--porcelain=v1', '-z', '-uall').stdout.split('\0').filter(Boolean);
  f.committed = rev => git('show', '--name-only', '--format=', rev ?? 'HEAD').stdout.split('\n').map(s => s.trim()).filter(Boolean);
  return f;
}
const byPath = files => Object.fromEntries(files.map(file => [file.path, file.kind]));

test('changes：新增、修改、删除、未跟踪、重命名、中文和空格路径都列出且 kind 正确；.gitignore 与 .agent-runs/ 不列', t => {
  const f = fixture(t).withHistory();
  f.write('.gitignore', '被忽略.log\n');
  assert.equal(f.git('add', '--', '.gitignore').status, 0);
  assert.equal(f.git('commit', '-q', '-m', '忽略').status, 0);
  f.write('a.txt', '改过\n');                   // 修改
  fs.rmSync(path.join(f.repo, '要删的.txt'));     // 删除
  f.write('新增 文件.txt');                        // 未跟踪，带空格
  f.write('子目录/中文 路径/里面.txt');             // 未跟踪，中文 + 空格 + 嵌套
  f.write('已暂存.txt');
  assert.equal(f.git('add', '--', '已暂存.txt').status, 0);   // 新增（已暂存）
  assert.equal(f.git('mv', '要改名.txt', '改了名.txt').status, 0);  // 重命名（已暂存）
  f.write('被忽略.log');                           // 被 .gitignore 忽略
  f.write('.agent-runs/任务/progress.log');        // 任务记录
  const r = f.json(['projects', 'changes', f.repo]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(byPath(r.json.files), {
    'a.txt': 'update',
    '要删的.txt': 'delete',
    '新增 文件.txt': 'add',
    '子目录/中文 路径/里面.txt': 'add',
    '已暂存.txt': 'add',
    '改了名.txt': 'rename',
  });
  assert.equal(r.json.files.find(file => file.path === '改了名.txt').from, '要改名.txt');
  // 文字输出也能用；干净的仓库为空列表。
  assert.match(f.ar(['projects', 'changes', f.repo]).stdout, /update\s+a\.txt/);
  const clean = fixture(t).withHistory();
  assert.deepEqual(clean.json(['projects', 'changes', clean.repo]).json, { ok: true, files: [] });
  // 不是 git 仓库报错。
  const notRepo = path.join(f.base, '不是仓库');
  fs.mkdirSync(notRepo);
  const bad = f.json(['projects', 'changes', notRepo]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.json.error, /不是 git 仓库/);
});

test('changes：core.quotePath 打开时中文路径照样原样返回', t => {
  const f = fixture(t).withHistory();
  assert.equal(f.git('config', 'core.quotePath', 'true').status, 0);
  f.write('中文 名字/说明 文档.md');
  assert.deepEqual(f.json(['projects', 'changes', f.repo]).json.files, [{ path: '中文 名字/说明 文档.md', kind: 'add' }]);
});

test('commit：只提交勾选的，未勾选的仍未提交；返回短 SHA 和文件', t => {
  const f = fixture(t).withHistory();
  f.write('a.txt', '改过\n');
  f.write('b.txt', '也改过\n');
  f.write('新 文件.txt');
  const r = f.json(['projects', 'commit', f.repo], { input: JSON.stringify({ message: '  只提交两个  ', files: ['a.txt', '新 文件.txt'] }) });
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.match(r.json.commit, /^[0-9a-f]{7,}$/);
  assert.deepEqual(r.json.files, ['a.txt', '新 文件.txt']);
  assert.deepEqual(f.committed().sort(), ['a.txt', '新 文件.txt']);
  assert.equal(f.git('log', '-1', '--format=%s').stdout.trim(), '只提交两个', '说明去掉首尾空白');
  assert.deepEqual(f.status(), [' M b.txt'], '没勾选的 b.txt 仍未提交');
});

test('commit：删除的文件能提交；已暂存的重命名新旧路径一起提交', t => {
  const f = fixture(t).withHistory();
  fs.rmSync(path.join(f.repo, '要删的.txt'));
  assert.equal(f.git('mv', '要改名.txt', '改了名.txt').status, 0);
  f.write('b.txt', '留着\n');
  const r = f.json(['projects', 'commit', f.repo], { input: JSON.stringify({ message: '删除与改名', files: ['要删的.txt', '改了名.txt'] }) });
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(f.git('ls-files', '--', '要删的.txt', '要改名.txt').stdout.trim(), '', '删除与旧路径都已提交');
  assert.equal(f.git('ls-files', '--', '改了名.txt').stdout.trim(), '改了名.txt');
  assert.deepEqual(f.status(), [' M b.txt']);
  // 已用 git rm 暂存的删除也能提交（不需要再 git add）。
  assert.equal(f.git('rm', '-q', '--', 'a.txt').status, 0);
  const rm = f.json(['projects', 'commit', f.repo], { input: JSON.stringify({ message: '已暂存的删除', files: ['a.txt'] }) });
  assert.equal(rm.status, 0, JSON.stringify(rm.json));
  assert.deepEqual(f.committed(), ['a.txt']);
});

test('commit：事先 git add 了另一个文件，提交后它仍在暂存区、不进这个提交', t => {
  const f = fixture(t).withHistory();
  f.write('a.txt', '改过\n');
  f.write('预先暂存.txt');
  f.write('b.txt', '预先暂存的修改\n');
  assert.equal(f.git('add', '--', '预先暂存.txt', 'b.txt').status, 0);
  const r = f.json(['projects', 'commit', f.repo], { input: JSON.stringify({ message: '只提交 a', files: ['a.txt'] }) });
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.deepEqual(f.committed(), ['a.txt'], '提交只含 a.txt');
  assert.deepEqual(f.status().sort(), ['A  预先暂存.txt', 'M  b.txt'].sort(), '预先暂存的文件仍在暂存区');
});

test('commit：项目外、.agent-runs/、没有改动的路径、空说明、空列表都拒绝，什么都不改', t => {
  const f = fixture(t).withHistory();
  f.write('a.txt', '改过\n');
  f.write('.agent-runs/任务/x.log');
  fs.writeFileSync(path.join(f.base, '外面.txt'), '外面\n');
  const head = f.git('rev-parse', 'HEAD').stdout;
  const status = f.status();
  const cases = [
    [{ message: '说明', files: ['../外面.txt'] }, /项目外/],
    [{ message: '说明', files: [path.join(f.base, '外面.txt')] }, /项目外/],
    [{ message: '说明', files: ['.agent-runs/任务/x.log'] }, /\.agent-runs/],
    [{ message: '说明', files: ['a.txt', '.agent-runs/任务/x.log'] }, /\.agent-runs/],
    [{ message: '说明', files: ['b.txt'] }, /没有未提交的改动.*b\.txt/],
    [{ message: '说明', files: ['a.txt', 'b.txt', '不存在.txt'] }, /b\.txt、不存在\.txt/],
    [{ message: '   ', files: ['a.txt'] }, /说明不能为空/],
    [{ message: '', files: ['a.txt'] }, /说明不能为空/],
    [{ message: '说明', files: [] }, /没有选中/],
    [{ message: '说明' }, /没有选中/],
  ];
  for (const [form, pattern] of cases) {
    const r = f.json(['projects', 'commit', f.repo], { input: JSON.stringify(form) });
    assert.notEqual(r.status, 0, JSON.stringify(form));
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, pattern, JSON.stringify(form));
    assert.equal(f.git('rev-parse', 'HEAD').stdout, head, '没有产生提交');
    assert.deepEqual(f.status(), status, '什么都没改（没有暂存）');
  }
  const badJson = f.json(['projects', 'commit', f.repo], { input: '不是 json' });
  assert.notEqual(badJson.status, 0);
  assert.match(badJson.json.error, /JSON/);
});

test('commit：缺提交身份报 NEED_GIT_IDENTITY，什么都不做', t => {
  const f = fixture(t, { identity: false }).setup();
  // 没有身份时无法造初始提交：先临时给仓库身份，造好历史后再取消。
  f.git('config', 'user.name', '临时'); f.git('config', 'user.email', 'tmp@example.invalid');
  f.write('a.txt');
  f.git('add', '--', 'a.txt'); f.git('commit', '-q', '-m', '初始');
  f.git('config', '--unset', 'user.name'); f.git('config', '--unset', 'user.email');
  f.write('a.txt', '改过\n');
  const r = f.json(['projects', 'commit', f.repo], { input: JSON.stringify({ message: '说明', files: ['a.txt'] }) });
  assert.notEqual(r.status, 0);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'NEED_GIT_IDENTITY');
  assert.deepEqual(f.status(), [' M a.txt'], '没有暂存');
});

test('commit：标准输入的 JSON 与 --message --files 两种写法结果相同', t => {
  const a = fixture(t).withHistory(), b = fixture(t).withHistory();
  for (const f of [a, b]) { f.write('a.txt', '改过\n'); f.write('新 文件.txt', '新\n'); f.write('b.txt', '留着\n'); }
  const viaStdin = a.json(['projects', 'commit', a.repo], { input: JSON.stringify({ message: '同一个说明', files: ['a.txt', '新 文件.txt'] }) });
  const viaArgs = b.json(['projects', 'commit', b.repo, '--message', '同一个说明', '--files', 'a.txt', '新 文件.txt']);
  assert.equal(viaStdin.status, 0, JSON.stringify(viaStdin.json));
  assert.equal(viaArgs.status, 0, JSON.stringify(viaArgs.json));
  assert.deepEqual(viaStdin.json.files, viaArgs.json.files);
  assert.deepEqual(a.committed().sort(), b.committed().sort());
  assert.deepEqual(a.status(), b.status());
  assert.equal(a.git('log', '-1', '--format=%s').stdout, b.git('log', '-1', '--format=%s').stdout);
  // 命令行写法的缺项同样拒绝。
  assert.notEqual(b.json(['projects', 'commit', b.repo, '--message', '说明']).status, 0);
});

test('init --dry-run：没有任何提交的文件夹带 existingFiles（遵守 .gitignore，排除 init 文件与 .agent-runs/）；已有提交时没有这个字段', t => {
  const f = fixture(t).setup();
  f.write('README.md');
  f.write('src/主程序 一.js');
  f.write('AGENTS.md', '# 已有的说明\n');
  f.write('.gitignore', 'dist/\n');
  f.write('dist/out.js');
  f.write('.agent-runs/任务/x.log');
  const r = f.json(['init', '--dry-run'], { cwd: f.repo });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([...r.json.existingFiles].sort(), ['README.md', 'src/主程序 一.js']);
  // 已有提交：没有字段。
  const h = fixture(t).withHistory();
  assert.equal('existingFiles' in h.json(['init', '--dry-run'], { cwd: h.repo }).json, false);
  // 不带 --dry-run 的输出也没有。
  assert.equal('existingFiles' in h.json(['init'], { cwd: h.repo }).json, false);
});

test('commit-init --with-existing：第一个提交含已有文件和 init 文件，status 干净（.gitignore 里的除外）', t => {
  const f = fixture(t).setup();
  f.write('README.md');
  f.write('src/主程序 一.js');
  f.write('.gitignore', 'dist/\n');
  f.write('dist/out.js');
  assert.equal(f.ar(['init'], { cwd: f.repo }).status, 0);
  const r = f.json(['projects', 'commit-init', f.repo, '--with-existing']);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.withExisting, true);
  const committed = f.committed();
  for (const rel of ['README.md', 'src/主程序 一.js', ...initFiles]) assert.ok(committed.includes(rel), `${rel} 在第一个提交里`);
  assert.ok(!committed.includes('dist/out.js'), '被忽略的不提交');
  assert.equal(f.git('rev-list', '--count', 'HEAD').stdout.trim(), '1');
  assert.deepEqual(f.status(), [], 'git status 干净');
});

test('commit-init：不带 --with-existing 与现在相同（只提交 init 文件，已有文件不动）', t => {
  const f = fixture(t).setup();
  f.write('README.md');
  assert.equal(f.ar(['init'], { cwd: f.repo }).status, 0);
  const r = f.json(['projects', 'commit-init', f.repo]);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal('withExisting' in r.json, false);
  assert.deepEqual([...r.json.files].sort(), [...initFiles].sort());
  assert.deepEqual(f.status(), ['?? README.md']);
});

test('commit-init --with-existing：已有提交的项目里被忽略，withExisting: false', t => {
  const f = fixture(t).withHistory();
  f.write('无关.txt');
  assert.equal(f.ar(['init'], { cwd: f.repo }).status, 0);
  const r = f.json(['projects', 'commit-init', f.repo, '--with-existing']);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.withExisting, false);
  assert.deepEqual([...r.json.files].sort(), [...initFiles].sort());
  assert.deepEqual(f.status(), ['?? 无关.txt'], '已有的未跟踪文件不带走');
});

test('projects show --json：globalIdentity 随隔离的全局配置变化', t => {
  const f = fixture(t, { identity: false }).setup();
  assert.equal(f.ar(['projects', 'add', f.repo]).status, 0);
  assert.equal(f.json(['projects', 'show', f.repo]).json.project.globalIdentity, false);
  // 只有名字还不算。
  assert.equal(spawnSync('git', ['config', '--global', 'user.name', '全局用户'], { env: f.env }).status, 0);
  assert.equal(f.json(['projects', 'show', f.repo]).json.project.globalIdentity, false);
  assert.equal(spawnSync('git', ['config', '--global', 'user.email', 'global@example.invalid'], { env: f.env }).status, 0);
  assert.equal(f.json(['projects', 'show', f.repo]).json.project.globalIdentity, true);
});
