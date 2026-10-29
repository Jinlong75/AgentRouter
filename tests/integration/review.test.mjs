import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readEffectiveConfig } from '../../core/lib/config.mjs';
import { recordLimit } from '../../core/lib/limits-state.mjs';
import { registryWriter, taskPaths } from '../../core/lib/records.mjs';
import { chooseReviewer, runReview } from '../../core/lib/review.mjs';

// Stage08 156：审查核心。每个用例在系统临时目录里建真实 git 仓库与任务专属 worktree，公共目录（AGENT_ROUTER_HOME 的位置）是用例自己的临时目录，
// 审查者是 tests/fixtures/review/reviewer.mjs 经通用适配器接入的假命令行；不碰真实安装、配置与进程。
const reviewer = fileURLToPath(new URL('../fixtures/review/reviewer.mjs', import.meta.url));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, 'utf8'); };
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// reviewers：[{ name, mode, model?, extra? }]，顺序就是 routing.reviewer.profiles 的顺序。
function fixture(t, { reviewers, order = null, mustDiffer = true, differFromLead = true, executorModel = 'deepseek-v4-flash', bigDiff = false, profileExtra = {} } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 审查 '));
  t.after(() => { rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const repo = path.join(base, '项目 仓库'), home = path.join(base, '隔离 公共目录'), wt = path.join(base, 'wt 根', 'task');
  mkdirSync(repo); mkdirSync(home);
  git(repo, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.name', '审查测试'], ['user.email', 'review@example.test'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(repo, ['config', key, value]);
  write(path.join(repo, 'a.txt'), '原始内容\n');
  write(path.join(repo, 'src/sum.js'), 'export const sum = list => list.reduce((a, b) => a + b);\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', '初始']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['worktree', 'add', '-q', '-b', 'ar/task', wt, 'main']);
  write(path.join(wt, 'src/sum.js'), 'export const sum = list => list.reduce((a, b) => a + b, 0);\n');
  if (bigDiff) write(path.join(wt, 'big.txt'), Array.from({ length: 4000 }, (_, i) => `第 ${i} 行 大文件的内容内容内容`).join('\n') + '\n');
  git(wt, ['add', '-A']); git(wt, ['commit', '-q', '-m', '任务的提交']);

  const generics = {}, profiles = {
    worker: { adapter: 'fake', label: '假执行者', model: executorModel, enabled: true, events: [], report: 'x\n', exit: 0 },
  };
  for (const { name, mode, model = 'kimi-k3', extra = {}, decl = {} } of reviewers) {
    generics[name] = {
      label: `审查 ${name}`, executable: process.execPath, detect: [reviewer, '--version'],
      args: [reviewer, mode, '{promptFile}'], readOnlyArgs: [reviewer, mode, '--read-only', ...(extra.pidFile ? ['--pid-file', extra.pidFile] : []), '{promptFile}'],
      output: { format: 'text' }, ...decl,
    };
    profiles[name] = { adapter: 'generic', generic: name, label: `审查 ${name}`, model, enabled: true, ...(profileExtra[name] ?? {}) };
  }
  write(path.join(home, 'config.json'), JSON.stringify({
    v: 2, managed: false, watchWindow: 'never', defaultProfile: 'worker', profiles, generics,
    routing: { rules: [], fallback: null, reviewer: { profiles: order ?? reviewers.map(r => r.name), mustDiffer, differFromLead } },
  }));
  const paths = taskPaths(repo, 'task-1');
  mkdirSync(paths.dir, { recursive: true });
  write(paths.raw, '执行者的原始输出\n');
  const progress = [];
  const env = { ...process.env, AGENT_ROUTER_HOME: home, USERPROFILE: base, HOME: base, APPDATA: base, AR_WORKTREE_ROOT: path.join(base, 'wt 根'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), CODEX_HOME: path.join(base, 'codex') };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_PROFILE']) delete env[key];
  const f = {
    base, repo, home, wt, paths, baseSha, progress,
    config: () => readEffectiveConfig(home),
    ctx: (overrides = {}) => ({
      root: repo, paths, id: 'id-1', worktree: wt, executor: 'worker', attempt: 2, spec: {}, specText: '# 任务\n把 sum 的初值改成 0。',
      report: '执行者汇报：完成，推断：空数组返回 0。', gate: { ok: true, summary: '门禁通过：1 条验收命令全部通过', commands: [{ line: 'npm test', exit: 0, ms: 5 }] },
      base: baseSha, config: readEffectiveConfig(home), home, env, registry: registryWriter(home), progress: line => progress.push(line), ...overrides,
    }),
    events: () => { try { return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } },
    attemptFile: (...parts) => path.join(paths.dir, 'attempts', '2', ...parts),
  };
  return f;
}

const state = dir => ({ head: git(dir, ['rev-parse', 'HEAD']), status: git(dir, ['status', '--porcelain']), branch: git(dir, ['branch', '--show-current']) });

test('正常审查：review.json 字段、问题编号、review 事件；审查者以只读方式在 worktree 里运行；文件在 attempts/2/review/，不动执行者的文件', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-ok', mode: 'ok' }] });
  const before = { wt: state(f.wt), repo: state(f.repo) };
  const result = await runReview(f.ctx());
  assert.equal(result.v, 1);
  assert.equal(result.attempt, 2);
  assert.equal(result.reviewer, 'rev-ok');
  assert.equal(result.crossed, true);
  assert.equal(result.base, f.baseSha);
  assert.equal(result.head, before.wt.head);
  assert.equal(result.verdict, 'concerns');
  assert.equal(result.summary, '功能完成，但缺少空输入处理');
  assert.deepEqual(result.reviewed, ['src/sum.js', 'tests/sum.test.js']);
  assert.deepEqual(result.issues, [
    { id: 'R2-1', severity: 'high', file: 'src/sum.js', line: 3, title: '未处理非数字输入', detail: '传入字符串时返回 NaN。', confirmation: null },
    { id: 'R2-2', severity: 'medium', file: 'tests/sum.test.js', line: null, title: '测试没有覆盖空数组', detail: '建议补一条。', confirmation: null },
  ]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /severity 非法/);
  assert.equal(result.tries.length, 1);
  assert.deepEqual([result.tries[0].reviewer, result.tries[0].ok], ['rev-ok', true]);
  assert.ok(Number.isFinite(result.tries[0].ms) && Number.isFinite(result.ms));
  assert.deepEqual(result.usage, { input: null, output: null });
  assert.equal(result.raw, 'attempts/2/review/report.md');

  // review.json：这次尝试一份、顶层一份，内容相同。
  assert.deepEqual(readJson(f.attemptFile('review.json')), result);
  assert.deepEqual(readJson(path.join(f.paths.dir, 'review.json')), result);
  // 清单：一条 review 事件，没有状态事件，也没有 spawned（它会把任务状态改回 running）。
  const events = f.events();
  assert.deepEqual(events.map(e => e.event), ['review']);
  assert.deepEqual({ ...events[0], at: 0, v: 0 }, { v: 0, event: 'review', id: 'id-1', attempt: 2, reviewer: 'rev-ok', crossed: true, verdict: 'concerns', issues: 2, high: 1, at: 0 });
  // 只读：假审查者看到了 --read-only 标记；汇报、原始输出在 review/ 下，任务顶层的 raw.log 没有被追加。
  const report = readFileSync(f.attemptFile('review', 'report.md'), 'utf8');
  assert.match(report, /读写模式：readonly/);
  assert.match(readFileSync(f.attemptFile('review', 'raw.log'), 'utf8'), /读写模式：readonly/);
  assert.equal(readFileSync(f.paths.raw, 'utf8'), '执行者的原始输出\n');
  assert.ok(!existsSync(f.attemptFile('report.md')) && !existsSync(f.attemptFile('raw.log')), '执行者那次的文件位置没有被动');
  // 没动 worktree 与主工作区。
  assert.deepEqual(state(f.wt), before.wt);
  assert.deepEqual(state(f.repo), before.repo);
  assert.ok(f.progress.some(line => /审查：rev-ok 的结论是 concerns，2 条问题/.test(line)));
});

test('指令里有任务说明、汇报、差异、门禁；差异超过 60KB 时换成文件清单', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-ok', mode: 'ok' }] });
  await runReview(f.ctx());
  const prompt = readFileSync(f.attemptFile('review', 'prompt.md'), 'utf8');
  assert.ok(prompt.includes('把 sum 的初值改成 0。'), '任务说明');
  assert.ok(prompt.includes('执行者汇报：完成，推断：空数组返回 0。'), '汇报');
  assert.ok(prompt.includes(`git diff ${f.baseSha}..${git(f.wt, ['rev-parse', 'HEAD'])}`), '基线与提交');
  assert.ok(prompt.includes('+export const sum = list => list.reduce((a, b) => a + b, 0);'), '差异');
  assert.ok(prompt.includes('门禁通过：1 条验收命令全部通过') && prompt.includes('- npm test → 通过'), '门禁');

  const big = fixture(t, { reviewers: [{ name: 'rev-ok', mode: 'ok' }], bigDiff: true });
  const result = await runReview(big.ctx());
  assert.equal(result.verdict, 'concerns');
  const bigPrompt = readFileSync(big.attemptFile('review', 'prompt.md'), 'utf8');
  assert.ok(bigPrompt.includes('改动太大') && bigPrompt.includes('只列文件清单'));
  assert.match(bigPrompt, /- big\.txt（\+4000 −0）/);
  assert.match(bigPrompt, /- src\/sum\.js（\+1 −1）/);
  assert.ok(!bigPrompt.includes('大文件的内容内容内容'), '原差异没有放进指令');
});

test('第一个审查者没有 json 代码块 → 换第二个 → 成功；tries 两条，后一次的文件在 review/try-2/', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-nocode', mode: 'nocode' }, { name: 'rev-pass', mode: 'pass' }] });
  const result = await runReview(f.ctx());
  assert.equal(result.verdict, 'pass');
  assert.equal(result.reviewer, 'rev-pass');
  assert.equal(result.tries.length, 2);
  assert.deepEqual([result.tries[0].reviewer, result.tries[0].ok, result.tries[0].kind], ['rev-nocode', false, 'parse']);
  assert.match(result.tries[0].why, /没有 json 代码块/);
  assert.deepEqual([result.tries[1].reviewer, result.tries[1].ok], ['rev-pass', true]);
  assert.equal(result.raw, 'attempts/2/review/try-2/report.md');
  assert.ok(f.progress.some(line => /^审查：rev-nocode 汇报里没有 json 代码块，没有给出结论，换 rev-pass$/.test(line)), f.progress.join('\n'));
  assert.match(readFileSync(f.attemptFile('review', 'report.md'), 'utf8'), /模式：nocode/);
  assert.match(readFileSync(f.attemptFile('review', 'try-2', 'report.md'), 'utf8'), /模式：pass/);
  assert.equal(f.events().filter(e => e.event === 'review').length, 1, '换人不多写事件');
});

test('审查者改了文件（含提交）→ worktree 恢复到审查前（HEAD、分支、工作区）、主工作区不受影响 → 换下一个', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-modify', mode: 'modify' }, { name: 'rev-commit', mode: 'commit' }, { name: 'rev-pass', mode: 'pass' }] });
  const before = { wt: state(f.wt), repo: state(f.repo) };
  const logBefore = git(f.wt, ['log', '--oneline']);
  const result = await runReview(f.ctx());
  assert.equal(result.verdict, 'pass');
  assert.equal(result.reviewer, 'rev-pass');
  assert.deepEqual(result.tries.map(item => [item.reviewer, item.ok, item.kind]), [['rev-modify', false, 'invalid'], ['rev-commit', false, 'invalid'], ['rev-pass', true, undefined]]);
  assert.deepEqual(state(f.wt), before.wt, 'HEAD、分支、工作区都恢复');
  assert.equal(git(f.wt, ['log', '--oneline']), logBefore, '审查者的提交不见了');
  assert.equal(readFileSync(path.join(f.wt, 'src/sum.js'), 'utf8'), 'export const sum = list => list.reduce((a, b) => a + b, 0);\n');
  assert.equal(readFileSync(path.join(f.wt, 'a.txt'), 'utf8'), '原始内容\n', '被改的已跟踪文件恢复');
  assert.ok(!existsSync(path.join(f.wt, 'evil.txt')), '新建的文件被清掉');
  assert.deepEqual(state(f.repo), before.repo, '主工作区不受影响');
  assert.equal(readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), '原始内容\n');
  assert.ok(!existsSync(path.join(f.repo, 'evil.txt')));
  assert.ok(f.progress.includes('审查：rev-modify 试图修改文件，已恢复，这次审查无效'));
  assert.ok(f.progress.includes('审查：rev-commit 试图修改文件，已恢复，这次审查无效'));
  assert.ok(f.progress.some(line => /^审查：rev-modify 试图修改文件，已恢复，这次审查无效，换 rev-commit$/.test(line)), f.progress.join('\n'));
});

test('三个都失败 → verdict unknown（最后一次是改文件则 invalid），不抛错，不试第四个', async t => {
  const f = fixture(t, { reviewers: [{ name: 'a', mode: 'nocode' }, { name: 'b', mode: 'blocked' }, { name: 'c', mode: 'badjson' }, { name: 'd', mode: 'pass' }] });
  const result = await runReview(f.ctx());
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.reviewer, 'c', '最后试的那个');
  assert.deepEqual(result.tries.map(item => [item.reviewer, item.ok]), [['a', false], ['b', false], ['c', false]]);
  assert.match(result.tries[1].why, /被阻塞或无法读取/);
  assert.match(result.tries[2].why, /无法解析/);
  assert.match(result.summary, /审查没有完成：c .*无法解析.*共试了 3 个审查者/);
  assert.deepEqual(result.issues, []);
  assert.equal(readJson(f.attemptFile('review.json')).verdict, 'unknown');
  assert.ok(!existsSync(f.attemptFile('review', 'try-4')), '没有第四个');
  assert.ok(f.progress.includes('审查：c 结论的 json 无法解析：' + result.tries[2].why.replace('结论的 json 无法解析：', '') + '，已试满 3 个审查者'), f.progress.join('\n'));
  const events = f.events().filter(e => e.event === 'review');
  assert.equal(events.length, 1);
  assert.equal(events[0].verdict, 'unknown');
  assert.equal(events[0].issues, 0);

  const g = fixture(t, { reviewers: [{ name: 'a', mode: 'noreviewed' }, { name: 'b', mode: 'crash' }, { name: 'c', mode: 'modify' }] });
  const invalid = await runReview(g.ctx());
  assert.equal(invalid.verdict, 'invalid');
  assert.equal(invalid.reviewer, 'c');
  assert.match(invalid.tries[0].why, /reviewed 为空/);
  assert.match(invalid.tries[1].why, /异常退出（exit 3）/);
  assert.ok(!existsSync(path.join(g.wt, 'evil.txt')));
});

test('没有审查者候选 / 只有执行者本人且 mustDiffer → unknown，带原因，也写 review.json 与事件', async t => {
  const none = fixture(t, { reviewers: [{ name: 'rev-ok', mode: 'ok' }], order: [] });
  const r1 = await runReview(none.ctx());
  assert.equal(r1.verdict, 'unknown');
  assert.equal(r1.summary, '没有可用的审查者');
  assert.equal(r1.reviewer, null);
  assert.match(r1.reasons[0].why, /没有设置审查者候选/);
  assert.deepEqual(readJson(none.attemptFile('review.json')).verdict, 'unknown');
  assert.equal(none.events().filter(e => e.event === 'review')[0].reviewer, null);

  const self = fixture(t, { reviewers: [{ name: 'rev-ok', mode: 'ok' }], order: ['worker'] });
  const r2 = await runReview(self.ctx());
  assert.equal(r2.verdict, 'unknown');
  assert.deepEqual(r2.reasons, [{ profile: 'worker', why: '就是执行者本人' }]);
  assert.ok(!existsSync(self.attemptFile('review')), '一个审查者都没启动');
});

test('任务说明 reviewer 指定 → 用它（不套家族规则）；指定的不可用 → 原因清楚，不悄悄换人；指定的失败了也不换', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-ok', mode: 'ok' }, { name: 'rev-same', mode: 'pass', model: 'deepseek-v4-flash' }, { name: 'rev-off', mode: 'pass' }, { name: 'rev-nocode', mode: 'nocode' }], profileExtra: { 'rev-off': { enabled: false } } });
  const same = await runReview(f.ctx({ spec: { reviewer: 'rev-same' } }));
  assert.equal(same.reviewer, 'rev-same', '与执行者同家族也照用');
  assert.equal(same.crossed, true);
  assert.equal(same.verdict, 'pass');

  const missing = await runReview(f.ctx({ spec: { reviewer: 'nope' } }));
  assert.equal(missing.verdict, 'unknown');
  assert.deepEqual(missing.reasons, [{ profile: 'nope', why: '任务说明指定的审查者 nope 不可用：不存在' }]);
  const off = chooseReviewer({ config: f.config(), spec: { reviewer: 'rev-off' }, executor: 'worker' });
  assert.equal(off.ok, false);
  assert.match(off.reasons[0].why, /任务说明指定的审查者 rev-off 不可用：已停用/);
  const worker = chooseReviewer({ config: f.config(), spec: { reviewer: 'worker' }, executor: 'worker' });
  assert.deepEqual([worker.ok, worker.profile, worker.crossed], [true, 'worker', false], '指定执行者本人也可以，只是不算交叉');
  const excluded = chooseReviewer({ config: f.config(), spec: { reviewer: 'rev-ok' }, executor: 'worker', exclude: ['rev-ok'] });
  assert.equal(excluded.ok, false);
  assert.match(excluded.reasons[0].why, /这次审查已经失败过/);

  const failing = await runReview(f.ctx({ spec: { reviewer: 'rev-nocode' } }));
  assert.equal(failing.verdict, 'unknown');
  assert.equal(failing.tries.length, 1, '指定的失败后不换别人');
  assert.equal(failing.reviewer, 'rev-nocode');
  assert.ok(f.progress.some(line => /^审查：rev-nocode .*没有别的审查者可换$/.test(line)), f.progress.join('\n'));
});

test('选审查者：与主导同家族、与执行者同家族的被跳过；被限流、已达每日上限的被跳过；exclude 的被跳过', t => {
  const f = fixture(t, {
    reviewers: [
      { name: 'rev-ds', mode: 'pass', model: 'deepseek-v4-flash' }, { name: 'rev-claude', mode: 'pass', model: 'claude-sonnet-5-5' },
      { name: 'rev-limited', mode: 'pass', model: 'glm-5' }, { name: 'rev-daily', mode: 'pass', model: 'qwen3-coder' }, { name: 'rev-ok', mode: 'ok', model: 'kimi-k3' },
    ],
    profileExtra: { 'rev-daily': { limits: { maxTasksPerDay: 1 } } },
  });
  recordLimit(f.home, 'rev-limited', { kind: 'limit', resetsAt: Date.now() + 3600000 });
  writeFileSync(path.join(f.home, 'runs.jsonl'), `${JSON.stringify({ v: 1, event: 'start', id: 'x-1', profile: 'rev-daily', started: Date.now() })}\n`);
  const pick = chooseReviewer({ config: f.config(), spec: {}, executor: 'worker', home: f.home });
  assert.equal(pick.ok, true);
  assert.equal(pick.profile, 'rev-ok');
  assert.equal(pick.crossed, true);
  const why = Object.fromEntries(pick.reasons.map(item => [item.profile, item.why]));
  assert.match(why['rev-ds'], /同家族（deepseek）/);
  assert.equal(why['rev-claude'], '与主导同家族（claude）');
  assert.match(why['rev-limited'], /^被限流（额度到 .+ 恢复）$/);
  assert.match(why['rev-daily'], /^已达每日上限（今天 1\/1 个任务）$/);
  const next = chooseReviewer({ config: f.config(), spec: {}, executor: 'worker', home: f.home, exclude: ['rev-ok'] });
  assert.equal(next.ok, false);
  assert.equal(next.reasons.find(item => item.profile === 'rev-ok').why, '这次审查已经失败过');
  // differFromLead 关掉后主导同家族的可以选。
  const config = f.config();
  config.routing.reviewer.differFromLead = false;
  assert.equal(chooseReviewer({ config, spec: {}, executor: 'worker', home: f.home }).profile, 'rev-claude');
});

test('三个开关都关（190 D128）：执行者本人也能当审查者，crossed 为 false', t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-ok', mode: 'ok' }], order: [] });
  const config = f.config();
  config.routing.reviewer = { profiles: ['worker'], mustDiffer: false, differFamily: false, differFromLead: false };
  const pick = chooseReviewer({ config, spec: {}, executor: 'worker', home: f.home });
  assert.deepEqual([pick.ok, pick.profile, pick.crossed], [true, 'worker', false]);
  // 只打开 mustDiffer：执行者本人还是被跳过。
  config.routing.reviewer = { profiles: ['worker'], mustDiffer: true, differFamily: false, differFromLead: false };
  const blocked = chooseReviewer({ config, spec: {}, executor: 'worker', home: f.home });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.reasons, [{ profile: 'worker', why: '就是执行者本人' }]);
});

test('不用 worktree → skipped：不审查，不写 review.json 和事件；目录不是任务专属 worktree（主工作区）同样不审查', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-ok', mode: 'ok' }] });
  for (const worktree of [null, undefined, f.repo, path.join(f.base, '不存在')]) {
    const result = await runReview(f.ctx({ worktree }));
    assert.equal(result.verdict, 'skipped', String(worktree));
    assert.equal(result.summary, '不用 worktree 的任务无法安全恢复，不审查');
  }
  assert.ok(!existsSync(path.join(f.paths.dir, 'review.json')));
  assert.ok(!existsSync(f.attemptFile('review')));
  assert.deepEqual(f.events(), []);
  assert.equal(readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), '原始内容\n');
});

test('审查前 worktree 里有未提交的改动 → 不审查（unknown，说明原因），改动原样保留', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-ok', mode: 'ok' }] });
  write(path.join(f.wt, 'wip.txt'), '执行者没提交的文件\n');
  const result = await runReview(f.ctx());
  assert.equal(result.verdict, 'unknown');
  assert.match(result.summary, /未提交的改动.*wip\.txt/);
  assert.equal(readFileSync(path.join(f.wt, 'wip.txt'), 'utf8'), '执行者没提交的文件\n', '没有审查者运行，也就不会被恢复');
  assert.ok(!existsSync(f.attemptFile('review')));
});

test('审查超时 → 结束进程树、算失败、换人', async t => {
  const f = fixture(t, { reviewers: [{ name: 'rev-hang', mode: 'hang', extra: { pidFile: null } }, { name: 'rev-pass', mode: 'pass' }] });
  const pidFile = path.join(f.base, 'hang.pid');
  // pid 文件路径要进 readOnlyArgs：重写 generics 里这一项（pid 文件放在 worktree 之外）。
  const file = path.join(f.home, 'config.json');
  const config = readJson(file);
  config.generics['rev-hang'].readOnlyArgs = [reviewer, 'hang', '--read-only', '--pid-file', pidFile, '{promptFile}'];
  write(file, JSON.stringify(config));
  const result = await runReview(f.ctx({ timeoutMs: 4000 }));
  assert.equal(result.verdict, 'pass');
  assert.equal(result.reviewer, 'rev-pass');
  assert.deepEqual([result.tries[0].reviewer, result.tries[0].ok, result.tries[0].kind], ['rev-hang', false, 'timeout']);
  assert.match(result.tries[0].why, /超过 4 秒没结束，已结束进程/);
  assert.ok(result.tries[0].ms >= 3500 && result.tries[0].ms < 20000, `用时 ${result.tries[0].ms}`);
  assert.ok(existsSync(pidFile), '假审查者启动了');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 50 && alive(pid); i++) await delay(100);
  assert.equal(alive(pid), false, '超时后审查者进程已被结束');
  assert.ok(f.progress.some(line => /^审查：rev-hang 超过 4 秒没结束，已结束进程，换 rev-pass$/.test(line)), f.progress.join('\n'));
});
