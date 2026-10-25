import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BEGIN, END } from '../../core/lib/project.mjs';

const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const created = ['.agent-router/project.json', 'AGENTS.md', 'CLAUDE.md', 'docs/roles/lead.md', 'docs/roles/worker.md', 'docs/roles/reviewer.md', 'docs/specs/README.md', '.gitignore'];

function fixture(t) {
  const base = fs.mkdtempSync(join(tmpdir(), '初始化 测试 '));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }); });
  const repo = join(base, '我的 项目'), home = join(base, 'home');
  fs.mkdirSync(repo);
  const env = { ...process.env, AGENT_ROUTER_HOME: home };
  const ar = (args, cwd = repo) => spawnSync(process.execPath, [entry, ...args], { cwd, env, encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false });
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const read = rel => fs.readFileSync(join(repo, rel), 'utf8');
  const snapshot = () => Object.fromEntries(fs.readdirSync(repo, { recursive: true }).filter(n => !n.startsWith('.git' + (process.platform === 'win32' ? '\\' : '/')) && n !== '.git')
    .filter(n => fs.statSync(join(repo, n)).isFile()).map(n => [n.replaceAll('\\', '/'), fs.readFileSync(join(repo, n), 'utf8')]));
  return { base, repo, home, env, ar, git, read, snapshot };
}

test('空仓库：--dry-run 只列计划不写文件；init 生成 8 个文件并登记项目；不自动提交', t => {
  const f = fixture(t); f.git('init', '-q');
  const dry = f.ar(['init', '--dry-run', '--json']);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.ok, true); assert.equal(plan.dryRun, true); assert.equal(plan.registered, false);
  assert.deepEqual(plan.changes.map(c => c.path).sort(), [...created].sort());
  assert.ok(plan.changes.every(c => c.action === 'create'));
  assert.ok(plan.changes.every(c => typeof c.content === 'string' && c.content.length > 0), 'dry-run JSON 每项带完整 content');
  assert.ok(plan.changes.every(c => c.preview === c.content), '新建文件的 preview 是完整内容');
  assert.deepEqual(f.snapshot(), {}); assert.ok(!fs.existsSync(join(f.home, 'projects.json')));
  const result = f.ar(['init']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已改动/); assert.match(result.stdout, /已登记项目/); assert.match(result.stdout, /git commit -m "\[主导\] 接入 AgentRouter" --/);
  assert.deepEqual(Object.keys(f.snapshot()).sort(), [...created].sort());
  const project = JSON.parse(f.read('.agent-router/project.json'));
  assert.deepEqual(project, { v: 1, name: '我的 项目', baseBranch: f.git('symbolic-ref', '--short', 'HEAD'), specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true });
  assert.ok(f.read('AGENTS.md').startsWith(`# 我的 项目\n\n${BEGIN}\n## AgentRouter 协作`)); assert.ok(f.read('AGENTS.md').trimEnd().endsWith(END));
  assert.equal(f.read('CLAUDE.md'), '@AGENTS.md\n'); assert.equal(f.read('.gitignore'), '.agent-runs/\n');
  assert.match(f.read('docs/roles/worker.md'), /^# 角色：执行者/); assert.match(f.read('docs/roles/reviewer.md'), /^# 角色：审查者/);
  assert.equal(f.git('status', '--porcelain').split('\n').filter(l => l.startsWith('A ')).length, 0, '没有暂存任何文件');
  const projects = JSON.parse(fs.readFileSync(join(f.home, 'projects.json'), 'utf8'));
  assert.equal(projects.v, 1); assert.equal(projects.projects.length, 1); assert.equal(projects.projects[0].name, '我的 项目');
});

test('--dry-run --json：更新文件的 preview 是相对现有内容新增的部分', t => {
  const f = fixture(t); f.git('init', '-q');
  fs.writeFileSync(join(f.repo, 'AGENTS.md'), '# 原有规则\n\n- 用中文\n');
  fs.writeFileSync(join(f.repo, 'CLAUDE.md'), '项目说明\n');
  const plan = JSON.parse(f.ar(['init', '--dry-run', '--json']).stdout);
  assert.equal(plan.ok, true);
  const agents = plan.changes.find(c => c.path === 'AGENTS.md');
  assert.equal(agents.action, 'update');
  assert.ok(agents.content.startsWith('# 原有规则\n\n- 用中文\n\n' + BEGIN), '新内容以现有内容开头');
  assert.ok(agents.preview.startsWith(BEGIN) && agents.preview.trimEnd().endsWith(END), 'preview 是新增的 AgentRouter 段落');
  assert.ok(!agents.preview.includes('# 原有规则'), 'preview 不含原有内容');
  const claude = plan.changes.find(c => c.path === 'CLAUDE.md');
  assert.equal(claude.action, 'update');
  assert.equal(claude.preview, '@AGENTS.md');
  const created = plan.changes.find(c => c.path === '.agent-router/project.json');
  assert.equal(created.preview, created.content);
  assert.ok(!fs.existsSync(join(f.repo, '.agent-router/project.json')), 'dry-run 不写文件');
});

test('已有 AGENTS.md / CLAUDE.md / .gitignore：只追加，不覆盖原内容', t => {
  const f = fixture(t); f.git('init', '-q');
  fs.writeFileSync(join(f.repo, 'AGENTS.md'), '# 原有规则\n\n- 用中文\n');
  fs.writeFileSync(join(f.repo, 'CLAUDE.md'), '项目说明\n');
  fs.writeFileSync(join(f.repo, '.gitignore'), 'node_modules/\r\ndist/\n');
  fs.mkdirSync(join(f.repo, 'docs/roles'), { recursive: true }); fs.writeFileSync(join(f.repo, 'docs/roles/lead.md'), '# 我的主导\n');
  const result = JSON.parse(f.ar(['init', '--json']).stdout);
  assert.deepEqual(result.changes.filter(c => c.action === 'update').map(c => c.path).sort(), ['.gitignore', 'AGENTS.md', 'CLAUDE.md']);
  assert.ok(!result.changes.some(c => c.path === 'docs/roles/lead.md'));
  assert.ok(f.read('AGENTS.md').startsWith('# 原有规则\n\n- 用中文\n\n' + BEGIN));
  assert.equal(f.read('CLAUDE.md'), '项目说明\n\n@AGENTS.md\n');
  assert.equal(f.read('.gitignore'), 'node_modules/\r\ndist/\n.agent-runs/\n');
  assert.equal(f.read('docs/roles/lead.md'), '# 我的主导\n');
});

test('重复运行没有改动；标记段落被改过时只替换该段，其余不变', t => {
  const f = fixture(t); f.git('init', '-q');
  fs.writeFileSync(join(f.repo, 'AGENTS.md'), '# 前言\n');
  assert.equal(f.ar(['init']).status, 0);
  const before = f.snapshot();
  const again = f.ar(['init']);
  assert.equal(again.status, 0); assert.match(again.stdout, /没有需要改动的文件/); assert.doesNotMatch(again.stdout, /git add/);
  assert.deepEqual(f.snapshot(), before);
  const agents = f.read('AGENTS.md');
  fs.writeFileSync(join(f.repo, 'AGENTS.md'), agents.replace('## AgentRouter 协作', '## 被改过的旧段落') + '\n## 后面的内容\n');
  const third = JSON.parse(f.ar(['init', '--json']).stdout);
  assert.deepEqual(third.changes, [{ path: 'AGENTS.md', action: 'update' }]);
  assert.equal(f.read('AGENTS.md'), agents + '\n## 后面的内容\n');
  assert.equal((f.read('AGENTS.md').match(new RegExp(BEGIN, 'g')) ?? []).length, 1);
});

test('不是 git 仓库或不在仓库根目录：报错且不写任何文件', t => {
  const f = fixture(t);
  let result = f.ar(['init']);
  assert.equal(result.status, 2); assert.match(result.stderr, /不是 git 仓库.*git init/);
  result = f.ar(['init', '--json']); assert.notEqual(result.status, 0); assert.match(JSON.parse(result.stdout).error, /不是 git 仓库/);
  f.git('init', '-q'); fs.mkdirSync(join(f.repo, '子目录'));
  result = f.ar(['init'], join(f.repo, '子目录'));
  assert.equal(result.status, 2); assert.match(result.stderr, /请在仓库根目录运行/);
  assert.deepEqual(f.snapshot(), {}); assert.ok(!fs.existsSync(join(f.home, 'projects.json')));
  assert.equal(f.ar(['init', '多余', '参数']).status, 2);
});

test('projects：list / add / remove，重复添加只更新最近使用，路径不区分大小写（Windows）', t => {
  const f = fixture(t); f.git('init', '-q');
  assert.match(f.ar(['projects', 'list']).stdout, /还没有添加项目/);
  assert.equal(f.ar(['projects', 'add', f.repo]).status, 0);
  assert.equal(f.ar(['projects', 'add', '.']).status, 0);
  let list = JSON.parse(f.ar(['projects', 'list', '--json']).stdout).projects;
  assert.equal(list.length, 1); assert.equal(list[0].path, f.repo);
  if (process.platform === 'win32') assert.equal(f.ar(['projects', 'remove', f.repo.toUpperCase()]).status, 0);
  else assert.equal(f.ar(['projects', 'remove', f.repo]).status, 0);
  list = JSON.parse(f.ar(['projects', 'list', '--json']).stdout).projects; assert.deepEqual(list, []);
  assert.equal(f.ar(['projects', 'remove', f.repo]).status, 2);
  const notRepo = join(f.base, '不是仓库'); fs.mkdirSync(notRepo);
  const bad = f.ar(['projects', 'add', notRepo, '--json']); assert.notEqual(bad.status, 0); assert.match(JSON.parse(bad.stdout).error, /不是 git 仓库/);
  assert.equal(f.ar(['projects', 'what']).status, 2);
});

test('git 低于 2.40（095，AR_TEST_GIT_VERSION）：ar init 退出码 2、GIT_TOO_OLD、说明里有当前版本，没有写任何文件也没有登记项目', t => {
  const f = fixture(t); f.git('init', '-q');
  f.env.AR_TEST_GIT_VERSION = 'git version 2.39.1.windows.1';
  const json = f.ar(['init', '--json']);
  assert.equal(json.status, 2, json.stderr + json.stdout);
  assert.deepEqual(JSON.parse(json.stdout), { ok: false, code: 'GIT_TOO_OLD', error: 'git 版本太旧：当前 2.39.1，ar init 需要 2.40 或更新。到 https://git-scm.com/downloads 下载新版，装好后重试。' });
  assert.ok(!JSON.parse(json.stdout).error.includes('--no-worktree'), 'ar init 的说明不提 --no-worktree');
  const dry = f.ar(['init', '--dry-run', '--json']);
  assert.equal(dry.status, 2); assert.equal(JSON.parse(dry.stdout).code, 'GIT_TOO_OLD');
  const plain = f.ar(['init']);
  assert.equal(plain.status, 2); assert.match(plain.stderr, /当前 2\.39\.1/);
  assert.deepEqual(f.snapshot(), {}, '没有写任何文件');
  assert.ok(!fs.existsSync(join(f.home, 'projects.json')), '没有登记项目');
  // 版本未知不拦；恢复后照常。
  f.env.AR_TEST_GIT_VERSION = '这不是 git 的输出';
  assert.equal(f.ar(['init', '--dry-run']).status, 0);
  delete f.env.AR_TEST_GIT_VERSION;
  assert.equal(f.ar(['init']).status, 0);
});