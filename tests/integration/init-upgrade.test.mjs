import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadTemplates, lineDiff, diffSummary } from '../../core/lib/project.mjs';

const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const OLD_WORKER = '# 角色：执行者\n\n旧版本的说明\n\n## 硬规则\n\n- 旧规则一\n';
const OLD_CONFIG = '{\n  "v": 1,\n  "name": "旧项目",\n  "baseBranch": "main",\n  "specsDir": "docs/specs",\n  "verify": [],\n  "allowedPaths": ["**"],\n  "routing": { "rules": [] }\n}\n';

function fixture(t, { legacy = true } = {}) {
  const base = fs.mkdtempSync(join(tmpdir(), '升级 测试 '));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 }); });
  const repo = join(base, '旧 项目'), home = join(base, 'home');
  fs.mkdirSync(repo);
  const env = { ...process.env, AGENT_ROUTER_HOME: home };
  const ar = args => spawnSync(process.execPath, [entry, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false });
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const read = rel => fs.readFileSync(join(repo, rel), 'utf8');
  const write = (rel, text) => { fs.mkdirSync(dirname(join(repo, rel)), { recursive: true }); fs.writeFileSync(join(repo, rel), text); };
  const snapshot = () => Object.fromEntries(fs.readdirSync(repo, { recursive: true }).filter(n => !/^\.git([\\/]|$)/.test(n))
    .filter(n => fs.statSync(join(repo, n)).isFile()).map(n => [n.replaceAll('\\', '/'), fs.readFileSync(join(repo, n), 'utf8')]));
  git('init', '-q');
  if (legacy) {
    const templates = loadTemplates();
    write('.agent-router/project.json', OLD_CONFIG);
    write('AGENTS.md', '# 旧 项目\n');
    write('CLAUDE.md', '@AGENTS.md\n');
    write('docs/roles/lead.md', templates.role('lead'));
    write('docs/roles/worker.md', OLD_WORKER);
    write('docs/specs/README.md', templates.specsReadme);
    write('.gitignore', '.agent-runs/\n');
    git('add', '--', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  }
  return { base, repo, home, env, ar, git, read, write, snapshot };
}
const run = (f, args) => { const r = f.ar(args); assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout); };

test('--upgrade --dry-run：列出新建、角色差异、配置新字段，什么都不写', t => {
  const f = fixture(t), before = f.snapshot();
  const plan = run(f, ['init', '--upgrade', '--dry-run', '--json']);
  assert.equal(plan.dryRun, true);
  assert.ok(plan.changes.some(c => c.action === 'create' && c.path === 'docs/roles/reviewer.md'));
  assert.ok(plan.changes.some(c => c.action === 'update' && c.path === 'AGENTS.md'));
  const diff = plan.changes.find(c => c.action === 'roleDiff' && c.path === 'docs/roles/worker.md');
  assert.ok(diff);
  assert.ok(!plan.changes.some(c => c.action === 'roleDiff' && c.path === 'docs/roles/lead.md'), '和模板相同的不列');
  const template = loadTemplates().role('worker');
  const added = template.split('\n').length - 1, expected = diffSummary(OLD_WORKER, template);
  assert.equal(diff.added, expected.added); assert.equal(diff.removed, expected.removed);
  assert.ok(diff.added > 0 && diff.removed >= 1 && diff.added <= added);
  assert.ok(diff.diff.some(l => l.op === '-' && l.text === '- 旧规则一'));
  assert.ok(diff.diff.some(l => l.op === '+') && diff.diff.every(l => ['+', '-', ' '].includes(l.op)));
  assert.equal(diff.truncated, false);
  assert.deepEqual(plan.changes.filter(c => c.action === 'configField').map(c => [c.key, c.value]).sort(), [['setup', []], ['worktree', true]]);
  assert.deepEqual(f.snapshot(), before);
  assert.match(f.ar(['init', '--upgrade', '--dry-run']).stdout, /和最新模板不同/);
});

test('--upgrade 把旧项目 AGENTS 段落更新成含"交互会话里的你默认是主导"的新模板', t => {
  const f = fixture(t);
  f.write('AGENTS.md', '# 旧 项目\n\n<!-- agent-router:begin -->\n## AgentRouter 协作\n\n- 开工前你会被告知自己的角色，然后读对应的角色文档。\n<!-- agent-router:end -->\n');
  run(f, ['init', '--upgrade', '--json']);
  const text = f.read('AGENTS.md');
  assert.match(text, /交互会话里的你默认是主导；由 AgentRouter 派发启动、指令开头写明角色的才是执行者或审查者。/);
  assert.match(text, /指令开头写明了角色时，读对应的角色文档/);
  assert.doesNotMatch(text, /开工前你会被告知/);
  assert.ok(text.startsWith('# 旧 项目\n'));
});

test('不选任何角色和字段应用：只补文件，结果与普通 ar init 相同', t => {
  const f = fixture(t), plain = fixture(t);
  const result = run(f, ['init', '--upgrade', '--json']);
  assert.deepEqual(result.backups, []);
  run(plain, ['init', '--json']);
  assert.deepEqual(f.snapshot(), plain.snapshot());
  assert.equal(f.read('docs/roles/worker.md'), OLD_WORKER);
  assert.equal(f.read('.agent-router/project.json'), OLD_CONFIG);
  assert.ok(fs.existsSync(join(f.repo, 'docs/roles/reviewer.md')));
  assert.ok(f.read('AGENTS.md').includes('<!-- agent-router:begin -->'));
  assert.ok(!fs.existsSync(join(f.repo, '.agent-router/backup')));
});

test('--replace-role worker：备份后替换，.gitignore 加备份目录，备份不进 git status；再 --dry-run 不再有 worker 差异', t => {
  const f = fixture(t);
  const result = run(f, ['init', '--upgrade', '--replace-role', 'worker', '--json']);
  assert.equal(f.read('docs/roles/worker.md'), loadTemplates().role('worker'));
  assert.equal(result.backups.length, 1);
  assert.match(result.backups[0], /^\.agent-router\/backup\/worker\.md-\d{8}-\d{6}$/);
  assert.equal(f.read(result.backups[0]), OLD_WORKER);
  assert.ok(f.read('.gitignore').split('\n').includes('.agent-router/backup/'));
  assert.ok(result.changes.some(c => c.path === '.gitignore'));
  assert.ok(!f.git('status', '--porcelain', '-uall').includes('backup'), 'git status 看不到备份文件');
  const again = run(f, ['init', '--upgrade', '--dry-run', '--json']);
  assert.ok(!again.changes.some(c => c.action === 'roleDiff'));
});

test('--add-field worktree：只多一个键，其余字节不变', t => {
  const f = fixture(t);
  run(f, ['init', '--upgrade', '--add-field', 'worktree', '--json']);
  const text = f.read('.agent-router/project.json');
  assert.deepEqual(JSON.parse(text), { ...JSON.parse(OLD_CONFIG), worktree: true });
  assert.ok(text.startsWith(OLD_CONFIG.slice(0, OLD_CONFIG.lastIndexOf('\n}'))), '原有内容一个字节不变');
  assert.ok(text.endsWith('\n}\n'));
  assert.equal(f.ar(['init', '--upgrade', '--add-field', 'worktree']).status, 2, '已经有的字段不能再加');
  assert.equal(f.ar(['init', '--upgrade', '--add-field', 'nonsense']).status, 2);
});

test('未初始化项目用 --upgrade 拒绝；参数错误退出码 2', t => {
  const f = fixture(t, { legacy: false });
  const r = f.ar(['init', '--upgrade', '--json']);
  assert.equal(r.status, 2); assert.match(JSON.parse(r.stdout).error, /还没有初始化.*ar init/);
  assert.deepEqual(f.snapshot(), {});
  assert.equal(f.ar(['init', '--replace-role', 'worker']).status, 2, '不带 --upgrade 不能用 --replace-role');
  assert.equal(fixture(t).ar(['init', '--upgrade', '--replace-role', 'boss']).status, 2);
});

test('备份失败：什么都不写（备份目录位置被文件占住）', t => {
  const f = fixture(t);
  f.write('.agent-router/backup', '我是个文件');
  const before = f.snapshot();
  const r = f.ar(['init', '--upgrade', '--replace-role', 'worker', '--json']);
  assert.equal(r.status, 2); assert.match(JSON.parse(r.stdout).error, /备份角色文档失败/);
  assert.deepEqual(f.snapshot(), before);
});

test('差异截断：不超过 200 行并标 truncated；行差异基本性质', () => {
  const big = Array.from({ length: 500 }, (_, i) => `旧行 ${i}`).join('\n') + '\n';
  const other = Array.from({ length: 500 }, (_, i) => `新行 ${i}`).join('\n') + '\n';
  const d = diffSummary(big, other);
  assert.equal(d.diff.length, 200); assert.equal(d.truncated, true);
  assert.equal(d.added, 500); assert.equal(d.removed, 500);
  const small = diffSummary('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nX\ne\nf\ng\nh\n');
  assert.deepEqual(small.diff.map(l => l.op + l.text), [' b', ' c', '-d', '+X', ' e', ' f']);
  assert.equal(small.truncated, false);
  assert.deepEqual(lineDiff('x\n', 'x\n'), [{ op: ' ', text: 'x' }]);
  assert.equal(diffSummary('a\r\nb\r\n', 'a\nb\n').added, 0, '换行风格不算差异');
});
