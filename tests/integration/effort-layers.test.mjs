import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../../core/lib/agents.mjs';
import { resolveSettings, settingSourcesOf } from '../../core/lib/config.mjs';
import { route } from '../../core/lib/router.mjs';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// Stage07c T6：任务说明 frontmatter 的 effort / model 与路由规则的 effort——
// 命令行 > 环境变量（codex）> 任务说明 > 路由规则 > 执行者配置 > 内置默认，来源记在 dispatch.json / start / resume，ar status 显示。
// 隔离的 AGENT_ROUTER_HOME、USERPROFILE / HOME、CLAUDE_CONFIG_DIR，系统临时目录里的仓库，假的 Claude Code（AR_TEST_AGENT）与 fake 适配器。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const fixtureAgent = fileURLToPath(new URL('../fixtures/fake-claude-code.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, 'utf8'); };
const jsonl = file => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

function fixture(t) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-effort-146-'));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home'), user = path.join(base, 'user');
  for (const dir of [repo, home, user]) mkdirSync(dir);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_)/i.test(key)) delete env[key];
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'HOMEDRIVE', 'HOMEPATH']) delete env[key];
  Object.assign(env, {
    AGENT_ROUTER_HOME: home, USERPROFILE: user, HOME: user, APPDATA: user, CLAUDE_CONFIG_DIR: path.join(user, 'claude'), AR_NO_WATCH: '1',
    AR_TEST_AGENT: fixtureAgent, AR_TEST_ENV_REPORT: path.join(base, 'report.json'), DEEPSEEK_API_KEY: 'sk-test-146', MIMO_API_KEY: 'sk-test-146',
  });
  assert.equal(path.dirname(env.AGENT_ROUTER_HOME), base, '隔离目录在临时目录里');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '强度测试']);
  git(repo, ['config', 'user.email', 'effort-146@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'a.txt'), '初始\n');
  git(repo, ['add', '.gitignore', 'a.txt']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  const f = { base, repo, home, env };
  f.config = patch => {
    const config = { v: 2, managed: false, watchWindow: 'never', defaultProfile: 'deepseek',
      profiles: { deepseek: loadPreset('deepseek').profile, mimo: loadPreset('mimo').profile, plain: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '汇报\n', exit: 0 } } };
    patch?.(config);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  };
  f.ar = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extra.env }, input: extra.input, encoding: 'utf8', timeout: 60000, windowsHide: true, shell: false });
  // 任务说明：type 为 docs（不启用门禁，不需要提交），lines 是额外的 frontmatter 行。
  f.spec = (name, lines = []) => {
    const rel = `docs/specs/${name}.md`;
    write(path.join(repo, rel), ['---', 'id: 146', 'title: 强度测试', 'type: docs', ...lines, '---', '', '正文', ''].join('\n'));
    return rel;
  };
  f.dispatch = (name, rel, extra = [], expect = 0) => {
    const r = f.ar(['dispatch', rel, '--name', name, ...extra]);
    assert.equal(r.status, expect, `${r.stdout}\n${r.stderr}`);
    return r;
  };
  f.agentArgs = () => JSON.parse(readFileSync(env.AR_TEST_ENV_REPORT, 'utf8')).args;
  f.start = name => jsonl(path.join(home, 'runs.jsonl')).find(row => row.event === 'start' && row.name === name);
  f.rows = name => { const id = f.start(name).id; return jsonl(path.join(home, 'runs.jsonl')).filter(row => row.id === id); };
  f.dispatchJson = name => JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'dispatch.json'), 'utf8'));
  f.progress = name => readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  f.status = name => {
    const r = f.ar(['status', name, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const text = f.ar(['status', name]);
    return { json: JSON.parse(r.stdout), lines: text.stdout.trimEnd().split(/\r?\n/) };
  };
  f.routeConfig = () => JSON.parse(f.ar(['route', 'config', '--json']).stdout);
  t.after(async () => {
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(realpathSync.native(os.tmpdir()), base).startsWith('ar-effort-146-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  f.config();
  return f;
}

const withRule = (effort, profile = 'deepseek') => config => {
  config.routing = { rules: [{ types: ['docs'], profile, ...(effort === undefined ? {} : { effort }) }], fallback: null, reviewer: null };
};

test('1 resolveSettings：命令行 > 环境变量（codex）> 任务说明 > 路由规则 > 执行者配置 > 内置默认，两层同时给时高的生效', () => {
  const config = { v: 2, defaultProfile: 'cx', profiles: { cx: { adapter: 'codex', model: 'm-file', effort: 'e-file' }, cc: { adapter: 'claude-code', effort: 'e-file' }, bare: { adapter: 'claude-code' } } };
  const spec = { model: 'm-spec', effort: 'e-spec' }, rule = { effort: 'e-rule' };
  const pick = (opts, env, profile, layers) => { const r = resolveSettings(config, opts, env, profile, layers); return [r.settings.effort, r.sources.effort, r.settings.model, r.sources.model]; };
  // 每层单独给值。
  assert.deepEqual(pick({}, {}, 'bare', undefined), [null, '内置默认', null, '内置默认']);
  assert.deepEqual(pick({}, {}, 'cc', {}), ['e-file', 'config.json', null, '内置默认']);
  assert.deepEqual(pick({}, {}, 'bare', { rule }), ['e-rule', '路由规则', null, '内置默认']);
  assert.deepEqual(pick({}, {}, 'bare', { spec }), ['e-spec', '任务说明', 'm-spec', '任务说明']);
  assert.deepEqual(pick({ effort: 'e-cli', model: 'm-cli' }, {}, 'bare', {}), ['e-cli', '命令行', 'm-cli', '命令行']);
  assert.deepEqual(pick({}, { CODEX_EFFORT: 'e-env', CODEX_MODEL: 'm-env' }, 'cx', {}), ['e-env', '环境变量 CODEX_EFFORT', 'm-env', '环境变量 CODEX_MODEL']);
  // 两层同时给：高的生效。
  assert.deepEqual(pick({}, {}, 'cc', { spec, rule }), ['e-spec', '任务说明', 'm-spec', '任务说明'], '任务说明 > 路由规则 > 配置');
  assert.deepEqual(pick({}, {}, 'cc', { rule }), ['e-rule', '路由规则', null, '内置默认'], '路由规则 > 配置');
  assert.deepEqual(pick({ effort: 'e-cli' }, {}, 'cc', { spec, rule }), ['e-cli', '命令行', 'm-spec', '任务说明'], '命令行 > 任务说明（model 仍取任务说明）');
  assert.deepEqual(pick({}, { CODEX_EFFORT: 'e-env' }, 'cx', { spec, rule }), ['e-env', '环境变量 CODEX_EFFORT', 'm-spec', '任务说明'], '环境变量 > 任务说明（主导决定 D81），只对 codex');
  assert.deepEqual(pick({}, { CODEX_EFFORT: 'e-env' }, 'cc', { spec, rule }), ['e-spec', '任务说明', 'm-spec', '任务说明'], 'CODEX_* 不作用于 claude-code 的执行者');
  assert.deepEqual(pick({}, {}, 'cx', { spec, rule }), ['e-spec', '任务说明', 'm-spec', '任务说明']);
  // 规则层只管 effort，不影响 model。
  assert.equal(resolveSettings(config, {}, {}, 'cx', { rule: { effort: 'e-rule', model: 'x' } }).settings.model, 'm-file');
  // 来源每次都有值（154、D81：每个值都写明来源）。
  assert.deepEqual(settingSourcesOf(resolveSettings(config, {}, {}, 'cc').sources), { model: '内置默认', effort: 'config.json' });
  assert.deepEqual(settingSourcesOf(resolveSettings(config, { effort: 'x' }, {}, 'cc', {}).sources), { model: '内置默认', effort: '命令行' });
  assert.deepEqual(settingSourcesOf(resolveSettings(config, {}, {}, 'cc', { rule }).sources), { model: '内置默认', effort: '路由规则' });
  assert.deepEqual(settingSourcesOf(resolveSettings(config, {}, {}, 'cx', { spec }).sources), { model: '任务说明', effort: '任务说明' });
});

test('1 路由结果：命中的规则写了 effort 才多 effort 键；没写时结果与以前相同', t => {
  const f = fixture(t);
  const profiles = { a: { adapter: 'fake' } };
  const noEffort = route({ spec: { type: 'docs' }, config: { profiles, routing: { rules: [{ types: ['docs'], profile: 'a' }] } }, home: f.home });
  assert.equal(Object.hasOwn(noEffort, 'effort'), false);
  assert.deepEqual(noEffort.rule, { scope: 'global', index: 1 });
  const withEffort = route({ spec: { type: 'docs' }, config: { profiles, routing: { rules: [{ types: ['docs'], profile: 'a', effort: 'low' }] } }, home: f.home });
  assert.equal(withEffort.effort, 'low');
  assert.deepEqual(withEffort.rule, { scope: 'global', index: 1 }, '规则对象本身不变');
  assert.equal(Object.hasOwn(route({ spec: { type: 'docs', worker: 'a' }, config: { profiles, routing: { rules: [{ types: ['docs'], profile: 'a', effort: 'low' }] } }, home: f.home }), 'effort'), false, '任务说明指定了执行者，不走规则');
});

test('1 五层优先级（派发）：每层单独给值时生效值与 settingSources 正确，两层同时给时高的生效', t => {
  const f = fixture(t);
  // 配置层：执行者配置的 effort。
  f.config(config => { config.profiles.deepseek.effort = 'low'; });
  f.dispatch('cfg', f.spec('c1'));
  assert.deepEqual(f.agentArgs().slice(-2), ['--effort', 'low']);
  assert.equal(f.start('cfg').effort, 'low');
  // 154（D81）：每次派发都记来源，来源是配置时也记。
  assert.deepEqual(f.start('cfg').settingSources, { model: '内置默认', effort: 'config.json' });
  assert.deepEqual(f.dispatchJson('cfg').settingSources, { model: '内置默认', effort: 'config.json' });
  assert.equal(Object.hasOwn(f.dispatchJson('cfg').route, 'effort'), false, '规则没写 effort：route 记录不多键');
  assert.deepEqual(Object.keys(f.dispatchJson('cfg').route), ['profile', 'rule', 'trace']);

  // 路由规则层 > 配置层。
  f.config(config => { config.profiles.deepseek.effort = 'low'; withRule('medium')(config); });
  f.dispatch('rule', f.spec('c2'));
  assert.deepEqual(f.agentArgs().slice(-2), ['--effort', 'medium']);
  assert.equal(f.start('rule').effort, 'medium');
  assert.deepEqual(f.start('rule').settingSources, { model: '内置默认', effort: '路由规则' });
  assert.deepEqual(f.dispatchJson('rule').settingSources, { model: '内置默认', effort: '路由规则' });
  assert.equal(f.dispatchJson('rule').route.effort, 'medium', 'route 记录带上命中规则的 effort');

  // 任务说明层 > 路由规则层 > 配置层；任务说明的 model 也生效。
  f.dispatch('spec', f.spec('c3', ['effort: high', 'model: m-spec']));
  assert.deepEqual(f.agentArgs().slice(-4), ['--model', 'm-spec', '--effort', 'high']);
  assert.equal(f.start('spec').effort, 'high'); assert.equal(f.start('spec').model, 'm-spec');
  assert.deepEqual(f.start('spec').settingSources, { model: '任务说明', effort: '任务说明' });
  assert.equal(f.dispatchJson('spec').route.effort, 'medium', '规则的 effort 仍记在 route 里');

  // 命令行 > 任务说明；命令行给了 effort 但 model 仍取任务说明。
  f.dispatch('cli', f.spec('c4', ['effort: high', 'model: m-spec']), ['--effort', 'max']);
  assert.deepEqual(f.agentArgs().slice(-4), ['--model', 'm-spec', '--effort', 'max']);
  assert.deepEqual(f.start('cli').settingSources, { model: '任务说明', effort: '命令行' });
  f.dispatch('cli2', f.spec('c5', ['effort: high', 'model: m-spec']), ['--effort', 'max', '--model', 'm-cli']);
  assert.deepEqual(f.agentArgs().slice(-4), ['--model', 'm-cli', '--effort', 'max']);
  assert.deepEqual(f.start('cli2').settingSources, { model: '命令行', effort: '命令行' }, '两项都来自命令行：来源也记（154）');
  assert.deepEqual(f.dispatchJson('cli2').options, { model: 'm-cli', effort: 'max' });

  // 任务说明指定了执行者（不走规则）：规则的 effort 不生效，退回配置层。
  f.dispatch('worker', f.spec('c6', ['worker: deepseek']));
  assert.deepEqual(f.agentArgs().slice(-2), ['--effort', 'low']);
  assert.deepEqual(f.start('worker').settingSources, { model: '内置默认', effort: 'config.json' });
});

test('2 ar status：来自任务说明 / 路由规则时加说明；来源是配置时输出与以前相同', t => {
  const f = fixture(t);
  f.config(config => { config.profiles.deepseek.effort = 'low'; });
  f.dispatch('cfg', f.spec('s1'));
  const plain = f.status('cfg');
  assert.deepEqual(plain.lines, ['状态：cfg（done）', '尝试次数：1'], '来源是配置：文字输出没有参数行（146 的规则不变）');
  // 154（D81）：--json 的 params 总是有，每个值都带来源。
  assert.deepEqual(plain.json.params, { model: 'deepseek-v4-pro', effort: 'low', sources: { model: '内置默认', effort: 'config.json' } });
  assert.deepEqual(Object.keys(plain.json), ['ok', 'id', 'name', 'state', 'attempts', 'gate', 'needsScope', 'outsideWrites', 'worktree', 'merge', 'conflict', 'params']);

  f.config(config => { config.profiles.deepseek.effort = 'low'; withRule('medium')(config); });
  f.dispatch('rule', f.spec('s2'));
  assert.deepEqual(f.status('rule').lines, ['状态：rule（done）', '尝试次数：1', '参数：模型 deepseek-v4-pro，推理强度 medium（来自路由规则）']);

  f.dispatch('spec', f.spec('s3', ['effort: high', 'model: m-spec']));
  const spec = f.status('spec');
  assert.deepEqual(spec.lines, ['状态：spec（done）', '尝试次数：1', '参数：模型 m-spec（来自任务说明），推理强度 high（来自任务说明）']);
  assert.deepEqual(spec.json.params, { model: 'm-spec', effort: 'high', sources: { model: '任务说明', effort: '任务说明' } });

  // 只有 effort 来自任务说明：model 照常显示、不加说明。
  f.dispatch('mixed', f.spec('s4', ['effort: high']));
  assert.deepEqual(f.status('mixed').lines.at(-1), '参数：模型 deepseek-v4-pro，推理强度 high（来自任务说明）');
});

test('3 推理强度不在预设的 effortOptions 里：任务说明与路由规则都拒绝派发（退出码 2），列出可选值；没有 effortOptions 不拦，命令行不校验', t => {
  const f = fixture(t);
  const options = 'low、medium、high、xhigh、max';
  // 任务说明。
  const bad = f.dispatch('bad', f.spec('r1', ['effort: ultra']), [], 2);
  assert.match(bad.stderr + bad.stdout, new RegExp(`任务说明里的推理强度 ultra 不在执行者 deepseek 支持的范围里。可选值：${options}`));
  assert.match(bad.stderr + bad.stdout, /ar agents models deepseek --probe/);
  assert.equal(jsonl(path.join(f.home, 'runs.jsonl')).length, 0, '拒绝时不写任何事件');
  assert.throws(() => readFileSync(path.join(f.repo, '.agent-runs', 'bad', 'dispatch.json')), '拒绝时不留下记录');
  const asJson = JSON.parse(f.ar(['dispatch', f.spec('r1', ['effort: ultra']), '--name', 'bad-json', '--json']).stdout);
  assert.equal(asJson.ok, false);
  assert.match(asJson.error, /可选值：low、medium/);
  // 合法的值照常派发。
  f.dispatch('ok', f.spec('r2', ['effort: xhigh']));
  assert.equal(f.start('ok').effort, 'xhigh');

  // 路由规则（规则本身写进配置不校验取值，派发时才查）。
  f.config(withRule('ultra'));
  const badRule = f.dispatch('bad-rule', f.spec('r3'), [], 2);
  assert.match(badRule.stderr + badRule.stdout, new RegExp(`路由规则里的推理强度 ultra 不在执行者 deepseek 支持的范围里。可选值：${options}`));
  // 命令行给的不校验。
  f.dispatch('cli', f.spec('r4'), ['--effort', 'ultra']);
  assert.equal(f.start('cli').effort, 'ultra');
  assert.deepEqual(f.start('cli').settingSources, { model: '内置默认', effort: '命令行' });
  // 命令行压过了任务说明里的错值：不算任务说明的错。
  f.dispatch('cli-over', f.spec('r5', ['effort: ultra']), ['--effort', 'low']);
  assert.equal(f.start('cli-over').effort, 'low');

  // 预设没有 effortOptions（假执行者）：不拦。
  f.config(config => { config.defaultProfile = 'plain'; });
  f.dispatch('plain', f.spec('r6', ['effort: ultra']));
  assert.equal(f.start('plain').effort, 'ultra');
  assert.deepEqual(f.start('plain').settingSources, { model: '内置默认', effort: '任务说明' });
});

test('3 ar spec new：表单带 effort / model 写进 frontmatter；指定了执行者时同样校验可选值', t => {
  const f = fixture(t);
  const make = (form, ...flags) => f.ar(['spec', 'new', f.repo, '--dry-run', ...flags, '--json'], { input: JSON.stringify(form) });
  const ok = make({ title: '带强度', goal: '目标', worker: 'deepseek', effort: 'high', model: 'm-x' });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const content = JSON.parse(ok.stdout).content;
  assert.match(content, /\nworker: deepseek\neffort: high\nmodel: m-x\n/);
  const refused = make({ title: '带强度', goal: '目标', worker: 'deepseek', effort: 'ultra' });
  assert.equal(refused.status, 2, refused.stderr + refused.stdout);
  assert.match(JSON.parse(refused.stdout).error, /任务说明里的推理强度 ultra 不在执行者 deepseek 支持的范围里。可选值：low、medium、high、xhigh、max/);
  assert.equal(make({ title: '带强度', goal: '目标', effort: 'ultra' }).status, 0, '没写 worker（auto）：确定不了执行者，不校验');
  assert.equal(make({ title: '带强度', goal: '目标', worker: 'plain', effort: 'ultra' }).status, 0, '预设没有 effortOptions：不拦');
  assert.equal(make({ title: '带强度', goal: '目标', worker: 'nobody', effort: 'ultra' }).status, 0, '执行者不在配置里：不校验');
  assert.equal(make({ title: '带强度', goal: '目标', effort: 5 }).status, 2, '类型不对：拒绝');
  // 没写 effort / model：frontmatter 与以前相同。
  const none = JSON.parse(make({ title: '无强度', goal: '目标' }).stdout).content;
  assert.doesNotMatch(none, /effort|model/);
});

test('4 ar route rules set：规则的 effort 不是字符串就拒绝（config.json 不变）；合法的写进去并显示', t => {
  const f = fixture(t);
  f.config(withRule(undefined));
  const before = readFileSync(path.join(f.home, 'config.json'), 'utf8');
  for (const bad of [5, true, ['low'], '', '  ']) {
    const r = f.ar(['route', 'rules', 'set', JSON.stringify([{ types: ['docs'], profile: 'deepseek', effort: bad }]), '--json']);
    assert.equal(r.status, 2, `${JSON.stringify(bad)}：${r.stdout}${r.stderr}`);
    assert.match(JSON.parse(r.stdout).error, /effort 必须是非空字符串/);
  }
  const extra = f.ar(['route', 'rules', 'set', JSON.stringify([{ types: ['docs'], profile: 'deepseek', extra: 1 }]), '--json']);
  assert.equal(extra.status, 2);
  assert.match(JSON.parse(extra.stdout).error, /不能有这些字段：extra/, '加了 effort 之后其他字段照样被拒');
  assert.equal(readFileSync(path.join(f.home, 'config.json'), 'utf8'), before, '拒绝时 config.json 一个字节都没动');

  const ok = f.ar(['route', 'rules', 'set', JSON.stringify([{ types: ['docs'], profile: 'deepseek', effort: ' low ' }, { types: ['code'], profile: 'mimo', effort: null }]), '--json']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(f.routeConfig().rules, [{ types: ['docs'], profile: 'deepseek', effort: 'low' }, { types: ['code'], profile: 'mimo', effort: null }]);
  assert.match(f.ar(['route', 'config']).stdout, /1\. \[docs\] → deepseek，推理强度 low\n/);
  // 不写 effort 的规则写回时不多键。
  f.ar(['route', 'rules', 'set', JSON.stringify([{ types: ['docs'], profile: 'deepseek' }]), '--json']);
  assert.deepEqual(f.routeConfig().rules, [{ types: ['docs'], profile: 'deepseek' }]);
  // 手写进 config.json 的坏值：整份配置无效，拒绝派发。
  f.config(config => { config.routing = { rules: [{ types: ['docs'], profile: 'deepseek', effort: 5 }] }; });
  assert.match(f.ar(['route', 'config']).stderr + f.ar(['route', 'config']).stdout, /effort 必须为非空字符串或 null/);
});

test('5 ar retry：同一执行者沿用规则的 effort 与来源；任务说明重新读，新写的 effort 照新值生效；换执行者不沿用', t => {
  const f = fixture(t);
  f.config(config => { config.profiles.deepseek.effort = 'low'; withRule('medium')(config); });
  const rel = f.spec('t1');
  f.dispatch('job', rel);
  assert.deepEqual(f.agentArgs().slice(-2), ['--effort', 'medium']);
  const resumes = () => f.rows('job').filter(row => row.event === 'resume');

  // 同一执行者：沿用第一次的生效值与来源（规则层）。
  const same = f.ar(['retry', 'job', '--note', '再来一次']);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.deepEqual(f.agentArgs().slice(-2), ['--effort', 'medium']);
  assert.deepEqual(resumes().at(-1).settingSources, { model: '内置默认', effort: '路由规则' });
  assert.equal(resumes().at(-1).effort, 'medium');
  assert.deepEqual(f.status('job').lines.at(-1), '参数：模型 deepseek-v4-pro，推理强度 medium（来自路由规则）');

  // 手动重试重新读任务说明：新写的 effort / model 照新值生效，来源变成任务说明；dispatch.json 里第一次的记录不变。
  f.spec('t1', ['effort: high', 'model: m-new']);
  const reread = f.ar(['retry', 'job', '--note', '任务说明改了']);
  assert.equal(reread.status, 0, reread.stdout + reread.stderr);
  assert.deepEqual(f.agentArgs().slice(-4), ['--model', 'm-new', '--effort', 'high']);
  assert.deepEqual(resumes().at(-1).settingSources, { model: '任务说明', effort: '任务说明' });
  assert.equal(resumes().at(-1).effort, 'high'); assert.equal(resumes().at(-1).model, 'm-new');
  assert.deepEqual(f.status('job').lines.at(-1), '参数：模型 m-new（来自任务说明），推理强度 high（来自任务说明）');
  assert.deepEqual(f.dispatchJson('job').settingSources, { model: '内置默认', effort: '路由规则' }, 'dispatch.json 仍是第一次派发的记录');

  // 任务说明里新写的 effort 不在可选值里：重试也拒绝（退出码 2），不写 resume。
  f.spec('t1', ['effort: ultra']);
  const before = resumes().length;
  const refused = f.ar(['retry', 'job', '--note', '写错了']);
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.match(refused.stderr + refused.stdout, /任务说明里的推理强度 ultra 不在执行者 deepseek 支持的范围里/);
  assert.equal(resumes().length, before);

  // 换了执行者配置：model / effort（任务说明、规则的也算）都不沿用，进度写一行说明。
  f.spec('t1', ['effort: high', 'model: m-new']);
  const switched = f.ar(['retry', 'job', '--profile', 'mimo', '--note', '换人']);
  assert.equal(switched.status, 0, switched.stdout + switched.stderr);
  const args = f.agentArgs();
  assert.ok(!args.includes('--effort') && !args.includes('--model'), `换配置后不带 model / effort：${args.join(' ')}`);
  assert.match(f.progress('job'), /手动重试：换了执行者配置（deepseek → mimo），不沿用 model \/ effort \/ tier/);
  assert.deepEqual(resumes().at(-1).settingSources, { model: '内置默认', effort: '内置默认' }, 'resume 记换后这个执行者自己的来源（154）：没有任何一项来自任务说明 / 规则');
  assert.equal(f.status('job').json.params.sources.effort, '内置默认');
  assert.ok(!f.status('job').lines.some(line => line.startsWith('参数：')), '来源都不是任务说明 / 规则：文字输出没有参数行');
});

test('5 ar retry：没有用到任务说明 / 规则 effort 的任务，resume 多记生效值与来源（154）', t => {
  const f = fixture(t);
  f.config(config => { config.profiles.deepseek.effort = 'low'; });
  f.dispatch('plain', f.spec('p1'));
  const r = f.ar(['retry', 'plain', '--note', '再来']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const resume = f.rows('plain').find(row => row.event === 'resume');
  assert.deepEqual(Object.keys(resume), ['v', 'event', 'id', 'pid', 'n', 'at', 'model', 'effort', 'settingSources']);
  assert.deepEqual(resume.settingSources, { model: '内置默认', effort: 'config.json' });
  assert.deepEqual(f.agentArgs().slice(-2), ['--effort', 'low']);
  // 换执行者配置：没有任何一项来自任务说明 / 路由规则 / 命令行，没有丢掉什么，进度里不写"不沿用"那一行（来源现在每个任务都有，不能因此多写）。
  const switched = f.ar(['retry', 'plain', '--profile', 'mimo', '--note', '换人']);
  assert.equal(switched.status, 0, switched.stdout + switched.stderr);
  assert.doesNotMatch(f.progress('plain'), /不沿用 model/);
});
