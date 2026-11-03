import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, git, readJson, until, write } from '../fixtures/review/pipeline-fixture.mjs';
import { AUTO_COMMIT_NOTE, willAutoCommit } from '../../core/lib/pipeline.mjs';
import { codex } from '../../core/adapters/codex.mjs';
import { withFakeCodex } from '../fixtures/fake-codex-path.mjs';

// 429：Codex 当主导时暴露的四处核心问题。假执行者 + 临时仓库 + 临时公共目录 + worktree 模式。

// 往夹具的隔离配置里加一个执行者（按配置顺序排在已有执行者后面）。
function addProfile(f, name, profile) {
  const file = path.join(f.home, 'config.json');
  const config = readJson(file);
  config.profiles[name] = profile;
  writeFileSync(file, JSON.stringify(config));
}

test('1 没有审查者候选：摘要带原因，review show / wait / accept 给出补审提示', async t => {
  const f = fixture(t, { reviewers: [] });
  const spec = f.spec('docs/specs/101-没有审查者.md', { review: true, maxRetries: 0 });
  const result = await f.dispatch(spec, '无审查者');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.review('无审查者').verdict, 'unknown');

  // 摘要与进度都带原因（不再只是一句"没有可用的审查者"）。
  assert.match(f.progress('无审查者'), /审查：没有可用的审查者：没有设置审查者候选/);
  const shown = await f.ar(['review', 'show', '无审查者']);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /摘要：没有可用的审查者：没有设置审查者候选/);
  // 没有可用的其他执行者时留占位符。
  assert.match(shown.stdout, /补审：ar review 无审查者 --profile <执行者名>（换一个和执行者不同的）/);

  // 有另一个已启用的执行者时，按配置顺序填第一个、排除本任务执行者。
  addProfile(f, 'helper', { adapter: 'fake', label: '备用执行者', enabled: true, events: [], report: 'OK\n', exit: 0 });
  const again = await f.ar(['review', 'show', '无审查者']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /补审：ar review 无审查者 --profile helper（换一个和执行者不同的）/);

  // ar wait 结束时同样给出补审办法。
  const waited = await f.ar(['wait', '无审查者']);
  assert.equal(waited.code, 0, waited.stderr);
  assert.match(waited.stdout, /补审：ar review 无审查者 --profile helper/);

  // ar accept 因为缺少有效审查而拒绝，拒绝前先给出补审办法。
  const accepted = await f.ar(['accept', '无审查者']);
  assert.equal(accepted.code, 2, accepted.stderr);
  assert.match(accepted.stdout, /补审：ar review 无审查者 --profile helper/);
  assert.match(accepted.stderr, /缺少有效审查/);
});

test('2 regate 只在任务说明真的改了时提示"任务说明已改"', async t => {
  const f = fixture(t, {
    reviewers: [],
    executor: {
      // 第 2、3 次尝试换文件提交，避免在工作区里重复提交同一个版本导致执行者退出。
      attempts: {
        2: { writes: [{ path: 'src/b.js', content: '第二次\n' }], commit: '假执行者：第二次' },
        3: { writes: [{ path: 'src/c.js', content: '第三次\n' }], commit: '假执行者：第三次' },
      },
    },
  });
  const spec = f.spec('docs/specs/102-重跑门禁.md', { maxRetries: 0 });
  assert.equal((await f.dispatch(spec, '重跑门禁')).code, 0);

  // 说明没改：旧快照里没有 mutations_required 不算"改了"。
  const unchanged = await f.ar(['retry', '重跑门禁', '--regate']);
  assert.equal(unchanged.code, 0, unchanged.stderr + unchanged.stdout);
  assert.doesNotMatch(unchanged.stdout, /任务说明已改/);
  assert.doesNotMatch(f.progress('重跑门禁'), /任务说明已改/);

  // 说明真的改了（verify 多一条）并提交：才提示。
  f.spec(spec, { maxRetries: 0, verify: ['node -e "process.exit(0)"', 'node -e "process.exit(0)"'] });
  const changed = await f.ar(['retry', '重跑门禁', '--regate']);
  assert.equal(changed.code, 0, changed.stderr + changed.stdout);
  assert.match(changed.stdout, /手动重试：任务说明已改，按新的允许范围与验收命令/);
});

test('3 diff 显示 worktree 里还没提交的文件，提交后不再显示', async t => {
  const f = fixture(t, { reviewers: [], executor: { writes: [{ path: 'src/a.js', content: '未提交\n' }], commit: null } });
  const spec = f.spec('docs/specs/103-未提交.md', { maxRetries: 0 });
  // 门禁只看提交：有未提交的文件时门禁不通过（任务失败），但 worktree 还在，diff 仍可查看。
  const dispatched = await f.dispatch(spec, '未提交');
  assert.equal(dispatched.code, 3, dispatched.stderr);

  const text = await f.ar(['diff', '未提交']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /共 0 个文件/);
  assert.match(text.stdout, /另有 1 个未提交的文件：src\/a\.js（门禁只看提交，要先提交）/);

  const json = await f.json(['diff', '未提交']);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(json.value.uncommitted, ['src/a.js']);

  // 在 worktree 里补提交之后，这一行与 uncommitted 都消失，改动进入提交范围。
  const worktree = f.events('未提交').find(row => row.event === 'worktree').dir;
  git(worktree, ['add', 'src/a.js']);
  git(worktree, ['commit', '-qm', '补提交']);
  const after = await f.ar(['diff', '未提交']);
  assert.equal(after.code, 0, after.stderr);
  assert.doesNotMatch(after.stdout, /另有 \d+ 个未提交的文件/);
  const afterJson = await f.json(['diff', '未提交']);
  assert.equal(afterJson.code, 0, afterJson.stderr);
  assert.deepEqual(afterJson.value.uncommitted, []);
  assert.equal(afterJson.value.files.length, 1);
});

test('4 Codex 默认代提交：判断、列表显示与 --auto-commit off 写 false', async t => {
  const gate = { enabled: true, merged: { expect_commit: true } };
  // 没写 autoCommit：用适配器默认（开）。
  assert.equal(willAutoCommit({ adapter: 'codex' }, codex, { dir: 'worktree' }, gate, false), true);
  // 显式关；没有 worktree、门禁不要求提交或只重跑门禁时都不代提交。
  assert.equal(willAutoCommit({ adapter: 'codex', autoCommit: false }, codex, { dir: 'worktree' }, gate, false), false);
  assert.equal(willAutoCommit({ adapter: 'codex' }, codex, null, gate, false), false);
  assert.equal(willAutoCommit({ adapter: 'codex' }, codex, { dir: 'worktree' }, gate, true), false);
  assert.equal(willAutoCommit({ adapter: 'codex' }, codex, { dir: 'worktree' }, { enabled: true, merged: { expect_commit: false } }, false), false);

  const f = fixture(t, { reviewers: [] });
  addProfile(f, 'codex', { adapter: 'codex', label: 'Codex', enabled: true });
  // 列表会检测登录状态：PATH 最前面放测试自己的假 codex，不碰真实 Codex。
  // 夹具里 f.ar / f.json 用的是建夹具时的 env，改 f.env 不生效，必须每次调用都传进去。
  const fakeEnv = withFakeCodex(f.env, f.base);

  const list = await f.ar(['agents', 'list'], { env: fakeEnv });
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /codex\s+Codex（codex）[^\n]*代提交：开（默认）/);
  // 证明检测用的是假 codex：版本号来自假 codex 的 --version 输出。
  const detected = await f.json(['agents', 'list', '--detect'], { env: fakeEnv });
  assert.equal(detected.value.agents.find(item => item.name === 'codex').version, 'codex-cli test-fake');
  // 默认只影响文字输出，list --json 的行形状不变。
  const before = await f.json(['agents', 'list'], { env: fakeEnv });
  const row = before.value.agents.find(item => item.name === 'codex');
  assert.equal('autoCommit' in row, false);
  assert.ok(!('autoCommitDefault' in row));

  const updated = await f.json(['agents', 'update', 'codex', '--auto-commit', 'off'], { env: fakeEnv });
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(readJson(path.join(f.home, 'config.json')).profiles.codex.autoCommit, false);

  const after = await f.ar(['agents', 'list'], { env: fakeEnv });
  assert.equal(after.code, 0, after.stderr);
  assert.doesNotMatch(after.stdout, /代提交/);
  const afterJson = await f.json(['agents', 'list'], { env: fakeEnv });
  const afterRow = afterJson.value.agents.find(item => item.name === 'codex');
  assert.equal(afterRow.autoCommit, false);
});

test('5 显式 autoCommit: false 随脱离请求快照带给执行者进程', async t => {
  const f = fixture(t, { reviewers: [] });
  addProfile(f, 'codex', { adapter: 'codex', label: 'Codex', enabled: true, autoCommit: false });
  const fakeEnv = withFakeCodex(f.env, f.base);
  // 假 codex 启动后挂住，好在请求文件被收尾删掉之前读到它，同时确认执行者进程拿到的指令里没有代提交提示。
  const release = path.join(f.base, '假 codex 放行');
  const agent = path.join(f.base, '挂住的 codex.mjs');
  writeFileSync(agent, [
    "import { existsSync } from 'node:fs';",
    "if (process.argv.includes('--version')) { console.log('codex-cli test-fake'); process.exit(0); }",
    'const deadline = Date.now() + 20000;',
    'while (!existsSync(process.env.AR_TEST_HOLD_RELEASE) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));',
    'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }));',
    '',
  ].join('\n'));
  const env = { ...fakeEnv, AR_TEST_AGENT: agent, AR_TEST_HOLD_RELEASE: release };
  const rel = 'docs/specs/104-显式关掉代提交.md';
  // expect_commit: true，否则代提交本来就不开，快照丢了也看不出来。
  write(path.join(f.repo, rel), ['---', 'id: 104', 'title: 显式关掉代提交', 'type: code', 'expect_commit: true', 'max_retries: 0', 'verify:', '  - node -e "process.exit(0)"', '---', '', '改 src/a.js。', ''].join('\n'));
  git(f.repo, ['add', '--', rel]);
  git(f.repo, ['commit', '-qm', '任务说明 104', '--', rel]);

  const dispatched = await f.ar(['dispatch', rel, '--name', '显式关掉', '--profile', 'codex', '--detach', '--json'], { env });
  assert.equal(dispatched.code, 0, dispatched.stderr + dispatched.stdout);
  const managed = path.join(f.home, 'managed');
  const request = await until(() => {
    const file = readdirSync(managed).find(name => /\.(claimed|running)\.json$/.test(name));
    return file ? readJson(path.join(managed, file)) : null;
  }, '脱离请求文件');
  assert.equal(request.profileConfig.autoCommit, false);
  const promptFile = path.join(f.dir('显式关掉'), 'attempts', '1', 'prompt.md');
  const prompt = await until(() => existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : null, '第 1 次尝试的 prompt');
  assert.ok(!prompt.includes(AUTO_COMMIT_NOTE), '执行者进程按请求快照关掉代提交');

  writeFileSync(release, '');
  await f.ar(['wait', '显式关掉'], { env, timeout: 120000 });
});
