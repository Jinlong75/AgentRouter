import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { main } from '../../core/lib/cli.mjs';

const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

function fixture(t, { git = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar spec 测试 '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repo = path.join(base, '仓库'), home = path.join(base, 'home'), user = path.join(base, 'user'), gitconfig = path.join(base, 'gitconfig');
  fs.mkdirSync(repo); fs.mkdirSync(home); fs.mkdirSync(user); fs.writeFileSync(gitconfig, '');
  // git 的全局/系统配置也隔离到临时目录：测试绝不读写用户真实的 ~/.gitconfig，"没有身份"能稳定复现。
  // main() 在进程内运行，spec-new/project 里的 git 子进程继承 process.env，所以这里也临时改 process.env，结束后还原。
  const gitEnv = { HOME: user, USERPROFILE: user, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  const saved = {};
  for (const [key, value] of Object.entries(gitEnv)) { saved[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const key of Object.keys(gitEnv)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  const env = { ...process.env, AGENT_ROUTER_HOME: home };
  const gitCmd = args => spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', windowsHide: true, shell: false });
  if (git) {
    assert.equal(gitCmd(['init', '-q']).status, 0);
    assert.equal(gitCmd(['config', 'user.name', '测试']).status, 0);
    assert.equal(gitCmd(['config', 'user.email', '测试@example.invalid']).status, 0);
    fs.writeFileSync(path.join(repo, 'README.md'), '# 仓库\n');
    assert.equal(gitCmd(['add', 'README.md']).status, 0);
    assert.equal(gitCmd(['commit', '-q', '-m', 'init']).status, 0);
  }
  const call = async (argv, { form } = {}) => {
    const out = [];
    const code = await main(argv, { scriptPath: entry, env, cwd: repo, out: s => out.push(s), readForm: async () => form });
    return { code, out, json: argv.includes('--json') ? JSON.parse(out.at(-1)) : null };
  };
  return { base, repo, home, env, call, gitCmd };
}

// 测试里的临时小解析器：读回 frontmatter 与正文小节，只覆盖本任务生成的样子。
function parseYamlScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"')) return JSON.parse(s);
  if (s === '[]') return [];
  return s;
}
function parseSpec(text) {
  assert.match(text, /^---\n/, '以 frontmatter 开头');
  const rest = text.replace(/^---\n/, '');
  const end = rest.indexOf('\n---\n');
  assert.ok(end >= 0, '有 frontmatter 结束标记');
  const fmText = rest.slice(0, end);
  const body = rest.slice(end + 5);
  const fm = {};
  let listKey = null;
  for (const line of fmText.split('\n')) {
    if (line.startsWith('  - ')) {
      assert.ok(listKey, `列表项有归属键：${line}`);
      (fm[listKey] ??= []).push(parseYamlScalar(line.slice(4)));
    } else {
      const m = /^(\w+):(.*)$/.exec(line);
      assert.ok(m, `frontmatter 行可解析：${line}`);
      listKey = m[1];
      const value = m[2].trim();
      fm[listKey] = value === '' ? null : parseYamlScalar(value);
    }
  }
  return { fm, body };
}

test('spec new：编号递增、返回字段齐全；--dry-run 不写文件', async t => {
  const f = fixture(t);
  const dir = path.join(f.repo, 'docs/specs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '001-已有.md'), '---\ntitle: 一\n---\n');
  fs.writeFileSync(path.join(dir, '003-已有.md'), '---\ntitle: 三\n---\n');

  const form = JSON.stringify({ title: '新任务说明', goal: '做一个东西', type: 'code', allowedPaths: ['core/**'], verify: ['npm test'] });
  const r = await f.call(['spec', 'new', f.repo, '--json'], { form });
  assert.equal(r.code, 0, r.out.join('\n'));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.id, '004', '取已有最大编号 + 1');
  assert.equal(r.json.rel, 'docs/specs/004-新任务说明.md');
  assert.ok(fs.existsSync(path.join(f.repo, r.json.rel)), '文件已写入');
  assert.match(r.json.content, /^---\nid: 004\n/);

  const dry = await f.call(['spec', 'new', f.repo, '--dry-run', '--json'], { form: JSON.stringify({ title: '预演', goal: '不写盘' }) });
  assert.equal(dry.code, 0);
  assert.equal(dry.json.ok, true);
  assert.equal(dry.json.id, '005');
  assert.ok(!fs.existsSync(path.join(f.repo, dry.json.rel)), '--dry-run 不写文件');
  assert.match(dry.json.content, /## 目标\n\n不写盘/);
});

test('spec new：slug 清理非法字符、空白、超长与全是非法字符', async t => {
  const f = fixture(t);
  const cases = [
    ['测试:任务 "A"/B\\C?*<> 结束', '测试-任务-A-B-C-结束'],
    ['  前后有空白  ', '前后有空白'],
    ['超'.repeat(60), '超'.repeat(40)],
    ['<>:"/\\|?*', 'task'],
  ];
  for (const [title, expectedSlug] of cases) {
    const r = await f.call(['spec', 'new', f.repo, '--json'], { form: JSON.stringify({ title, goal: '目标' }) });
    assert.equal(r.code, 0, title);
    assert.equal(path.basename(r.json.file), `${r.json.id}-${expectedSlug}.md`, title);
  }
});

test('spec new：两个同时运行的进程不撞号', async t => {
  const f = fixture(t);
  const form = JSON.stringify({ title: '并发任务', goal: '同时创建' });
  const run = () => new Promise(resolve => {
    const child = spawn(process.execPath, [entry, 'spec', 'new', f.repo], { env: { ...process.env, AGENT_ROUTER_HOME: f.home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(form);
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
  const files = fs.readdirSync(path.join(f.repo, 'docs/specs')).filter(n => n.endsWith('.md'));
  assert.equal(files.length, 2, '两个文件都写成功');
  const ids = files.map(n => n.slice(0, 3));
  assert.notEqual(ids[0], ids[1], '两个进程拿到不同编号');
});

test('spec new：frontmatter 可读回（冒号、引号、中文、列表），空小节不写', async t => {
  const f = fixture(t);
  const title = '带:冒号 和 "引号" 的中文标题';
  const r = await f.call(['spec', 'new', f.repo, '--json'], { form: JSON.stringify({
    title, goal: '只写目标', type: 'test', worker: 'deepseek',
    allowedPaths: ['core/**', ' 带空格 ', 'a:b'], verify: ['npm test', 'echo "hi"'],
    nonGoals: '', refs: '', acceptance: '', questions: '',
  }) });
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  const { fm, body } = parseSpec(r.json.content);
  assert.equal(fm.id, r.json.id);
  assert.equal(fm.title, title);
  assert.equal(fm.type, 'test');
  assert.equal(fm.worker, 'deepseek');
  assert.deepEqual(fm.allowed_paths, ['core/**', ' 带空格 ', 'a:b']);
  assert.deepEqual(fm.verify, ['npm test', 'echo "hi"']);
  assert.match(body, /## 目标\n\n只写目标/);
  assert.doesNotMatch(body, /## 不做什么|## 参照|## 验收标准|## 汇报要回答的问题/, '空小节不写');
});

test('spec list：按修改时间排序、title 取值、dispatched 计数；目录不存在返回空', async t => {
  const f = fixture(t);
  const dir = path.join(f.repo, 'docs/specs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '001-甲.md'), '---\ntitle: 来自 frontmatter\n---\n');
  fs.writeFileSync(path.join(dir, '002-乙.md'), '# 来自标题\n\n正文\n');
  fs.writeFileSync(path.join(dir, '003-丙.md'), '没有标题\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '不算\n');
  fs.writeFileSync(path.join(dir, '004-丁.txt'), '不算\n');
  fs.utimesSync(path.join(dir, '001-甲.md'), new Date(0), new Date(0));
  fs.utimesSync(path.join(dir, '002-乙.md'), new Date(1000), new Date(1000));
  fs.utimesSync(path.join(dir, '003-丙.md'), new Date(2000), new Date(2000));
  fs.writeFileSync(path.join(f.home, 'runs.jsonl'), [
    JSON.stringify({ event: 'start', repo: f.repo, name: 'a', spec: 'docs/specs/001-甲.md', started: 1 }),
    JSON.stringify({ event: 'start', repo: f.repo, name: 'b', spec: 'docs/specs/001-甲.md', started: 2 }),
    JSON.stringify({ event: 'start', repo: '别的仓库', name: 'c', spec: 'docs/specs/001-甲.md', started: 3 }),
    JSON.stringify({ event: 'start', repo: f.repo, name: 'd', spec: 'docs/specs/002-乙.md', started: 4 }),
  ].join('\n') + '\n');

  const r = await f.call(['spec', 'list', f.repo, '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.dir, dir);
  assert.deepEqual(r.json.specs.map(s => s.rel), ['docs/specs/003-丙.md', 'docs/specs/002-乙.md', 'docs/specs/001-甲.md'], '按修改时间从新到旧');
  assert.deepEqual(r.json.specs.map(s => s.title), ['003-丙.md', '来自标题', '来自 frontmatter']);
  assert.deepEqual(r.json.specs.map(s => s.id), ['003', '002', '001']);
  assert.equal(r.json.specs[2].dispatched, 2, '只看本仓库、spec 等于 rel 的 start 行');

  const empty = await f.call(['spec', 'list', path.join(f.base, '空仓库'), '--json']);
  assert.equal(empty.code, 0);
  assert.deepEqual(empty.json.specs, [], '目录不存在返回空列表');
});

test('spec read：读成功、拒绝根目录外路径、拒绝非 .md、拒绝超 256 KB', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.repo, 'docs/specs'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'docs/specs/001-甲.md'), '内容甲\n');
  fs.writeFileSync(path.join(f.base, '外面.md'), '外面\n');

  const ok = await f.call(['spec', 'read', f.repo, 'docs/specs/001-甲.md', '--json']);
  assert.equal(ok.code, 0);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.rel, 'docs/specs/001-甲.md');
  assert.equal(ok.json.content, '内容甲\n');

  const outside = await f.call(['spec', 'read', f.repo, '../外面.md', '--json']);
  assert.notEqual(outside.code, 0);
  assert.match(outside.json.error, /项目内/);

  const absOutside = await f.call(['spec', 'read', f.repo, path.join(f.base, '外面.md'), '--json']);
  assert.notEqual(absOutside.code, 0);
  assert.match(absOutside.json.error, /项目内/);

  const notMd = await f.call(['spec', 'read', f.repo, 'docs/specs/001-甲', '--json']);
  assert.notEqual(notMd.code, 0);
  assert.match(notMd.json.error, /\.md/);

  fs.writeFileSync(path.join(f.repo, 'docs/specs', '大文件.md'), '大'.repeat(256 * 1024 + 1));
  const big = await f.call(['spec', 'read', f.repo, 'docs/specs/大文件.md', '--json']);
  assert.notEqual(big.code, 0);
  assert.match(big.json.error, /256 KB/);
});

test('spec new --commit：只提交这一个文件；校验错误不写文件', async t => {
  const f = fixture(t, { git: true });
  fs.writeFileSync(path.join(f.repo, '无关.txt'), '不该被提交\n');
  const r = await f.call(['spec', 'new', f.repo, '--commit', '--json'], { form: JSON.stringify({ title: '要提交的任务', goal: '目标' }) });
  assert.equal(r.code, 0, r.out.join('\n'));
  assert.equal(r.json.ok, true);
  assert.match(r.json.commit, /^[0-9a-f]{7,}$/);
  assert.notEqual(f.gitCmd(['ls-files', '--', r.json.rel]).stdout.trim(), '', '任务说明已被提交');
  assert.equal(f.gitCmd(['ls-files', '--', '无关.txt']).stdout.trim(), '', '无关文件没有被 git add');
  assert.match(f.gitCmd(['status', '--porcelain', '--', '无关.txt']).stdout, /^\?\?/, '无关文件仍未被跟踪');

  // 校验错误不写文件
  const before = fs.readdirSync(path.join(f.repo, 'docs/specs')).length;
  for (const [form, pattern] of [
    [{ goal: '没有标题' }, /请填写标题/],
    [{ title: '没有目标' }, /请填写目标/],
    [{ title: '类型错', goal: '目标', type: 'bad' }, /类型只能是 code、test、fix、research、docs/],
    [{ title: '数组错', goal: '目标', allowedPaths: [''] }, /数组项必须是非空单行字符串/],
    [{ title: '数组换行', goal: '目标', verify: ['a\nb'] }, /数组项必须是非空单行字符串/],
  ]) {
    const bad = await f.call(['spec', 'new', f.repo, '--json'], { form: JSON.stringify(form) });
    assert.notEqual(bad.code, 0, JSON.stringify(form));
    assert.match(bad.json.error, pattern);
  }
  assert.equal(fs.readdirSync(path.join(f.repo, 'docs/specs')).length, before, '校验失败不写文件');
});

test('spec new --commit：没有提交身份时文件写好但不提交，返回 NEED_GIT_IDENTITY', async t => {
  const f = fixture(t);
  assert.equal(f.gitCmd(['init', '-q']).status, 0);
  const r = await f.call(['spec', 'new', f.repo, '--commit', '--json'], { form: JSON.stringify({ title: '没有身份的任务', goal: '目标' }) });
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, 'NEED_GIT_IDENTITY');
  assert.match(r.json.error, /还没有设置 git 提交身份/);
  assert.ok(fs.existsSync(path.join(f.repo, r.json.rel)), '文件照样写好');
  assert.notEqual(f.gitCmd(['rev-parse', '--verify', 'HEAD']).status, 0, '没有产生提交');
  assert.match(f.gitCmd(['status', '--porcelain', '--', r.json.rel]).stdout, /^\?\?/, '文件仍是未跟踪状态');
});
