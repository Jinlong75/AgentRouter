import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Stage07 T4：ar route 与派发接入。隔离的 AGENT_ROUTER_HOME、临时仓库、fake 执行者；
// 路由只读配置，claude-code 配置的执行者在这里只被"选中"，从不启动。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

const config = (extra = {}) => ({
  v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake',
  profiles: {
    fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [], report: '假汇报\n', exit: 0 },
    reader: { adapter: 'claude-code', label: '只读阅读者', enabled: true },
    scribe: { adapter: 'fake', label: '写文档的', enabled: true, events: [], report: '文档汇报\n', exit: 0, escalate: 'fake' },
    // 没有 readOnlyArgs 声明的通用执行者：不支持只读，只会被"选中"，从不启动。
    plain: { adapter: 'generic', generic: 'plain', label: '不能只读的', enabled: true },
  },
  routing: { rules: [{ types: ['research', 'review'], profile: 'reader' }, { types: ['docs'], profile: 'scribe', escalate: 'reader' }], fallback: null, reviewer: null },
  ...extra,
});

function fixture(t, cfg = config()) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 路由 '));
  t.after(() => { rmSync(base, { recursive: true, force: true }); });
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  mkdirSync(repo);
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_PROFILE']) delete env[key];
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '路由测试']);
  git(repo, ['config', 'user.email', 'route-cli@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
  writeFileSync(path.join(repo, 'README.md'), '# 说明\n');
  git(repo, ['add', '.gitignore', 'README.md']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  // 配置用 Node 写（无 BOM）。
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  const f = { repo, home, env };
  f.spec = (rel, fields) => {
    writeFileSync(path.join(repo, rel), `---\n${fields.join('\n')}\n---\n\n正文。\n`);
    return rel;
  };
  f.ar = (args, { env: extra = {} } = {}) => spawnSync(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8' });
  f.json = (args, options) => { const r = f.ar([...args, '--json'], options); return { status: r.status, stderr: r.stderr, json: JSON.parse(r.stdout) }; };
  return f;
}
const listing = dir => readdirSync(dir, { recursive: true }).sort();

test('ar route --type research --json：命中全局规则，输出路由器的返回值；不写任何文件', t => {
  const f = fixture(t);
  const before = [listing(f.home), listing(f.repo)];
  const r = f.json(['route', '--type', 'research']);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.profile, 'reader');
  assert.equal(r.json.label, '只读阅读者');
  assert.deepEqual(r.json.rule, { scope: 'global', index: 1 });
  assert.equal(r.json.needsReadOnly, true);
  assert.equal(r.json.escalate, null);
  assert.deepEqual(r.json.trace, ['全局规则 1：[research, review] → reader']);
  assert.deepEqual([listing(f.home), listing(f.repo)], before, 'route 不写文件');
  // 只按类型：docs 规则带自己的 escalate。
  const docs = f.json(['route', '--type', 'docs']);
  assert.equal(docs.json.profile, 'scribe');
  assert.equal(docs.json.escalate, 'reader');
  assert.equal(docs.json.needsReadOnly, false);
});

test('ar route 文字输出：将派给 <显示名>（规则说明）；--explain 逐行打印 trace', t => {
  const f = fixture(t);
  const plain = f.ar(['route', '--type', 'review']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.trim(), '将派给 只读阅读者（全局规则 1：[research, review] → reader）');
  // 项目规则先于全局规则；停用的执行者在 trace 里写明原因。
  writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(config({ defaultProfile: 'plain', profiles: { ...config().profiles, reader: { adapter: 'claude-code', label: '只读阅读者', enabled: false } } })));
  mkdirSync(path.join(f.repo, '.agent-router'));
  writeFileSync(path.join(f.repo, '.agent-router', 'project.json'), JSON.stringify({ v: 1, routing: { rules: [{ types: ['research'], profile: 'reader' }] } }));
  const explain = f.ar(['route', '--type', 'research', '--explain']);
  assert.equal(explain.status, 2, '读者停用，默认执行者不支持只读，没有可用的');
  assert.match(explain.stderr, /没有可用的执行者处理「research」类任务/);
  assert.match(explain.stderr, /项目规则 1：\[research\] → reader：已停用，跳过/);
  const ok = f.ar(['route', '--type', 'docs', '--explain']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.stdout.trim().split('\n'), ['将派给 写文档的（全局规则 2：[docs] → scribe）', '路由过程：', '  全局规则 2：[docs] → scribe']);
});

test('ar route --spec：从任务说明读 type / worker / read_only', t => {
  const f = fixture(t);
  const byType = f.json(['route', '--spec', f.spec('a.md', ['type: research', 'worker: auto'])]);
  assert.equal(byType.json.profile, 'reader');
  // worker 指定具体的执行者：优先于规则。
  const pinned = f.json(['route', '--spec', f.spec('b.md', ['type: research', 'worker: plain'])]);
  assert.equal(pinned.status, 2, 'plain 不支持只读');
  assert.equal(pinned.json.code, 'PROFILE_UNAVAILABLE');
  assert.match(pinned.json.error, /任务说明指定的执行者 plain 不可用：不支持只读任务/);
  const named = f.json(['route', '--spec', f.spec('c.md', ['type: code', 'worker: scribe'])]);
  assert.equal(named.json.profile, 'scribe');
  assert.deepEqual(named.json.trace, ['任务说明指定：scribe']);
  // read_only: true：docs 任务也要求只读；--project 指定项目路径。
  const readOnly = f.json(['route', '--project', f.repo, '--spec', f.spec('d.md', ['type: docs', 'read_only: true'])]);
  assert.equal(readOnly.json.profile, 'scribe');
  assert.equal(readOnly.json.needsReadOnly, true);
  // 规则里的执行者不支持只读时被跳过，落到兜底。
  writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(config({ routing: { rules: [{ types: ['docs'], profile: 'plain' }], fallback: null, reviewer: null } })));
  const skipped = f.json(['route', '--spec', 'd.md']);
  assert.equal(skipped.json.profile, 'fake');
  assert.deepEqual(skipped.json.trace, ['全局规则 1：[docs] → plain：不支持只读任务，跳过', '兜底：fake']);
});

test('ar route 失败：退出码 2；--json 带 code / error / trace', t => {
  const f = fixture(t, config({ defaultProfile: 'plain', routing: { rules: [], fallback: null, reviewer: null } }));
  const none = f.json(['route', '--type', 'research']);
  assert.equal(none.status, 2);
  assert.deepEqual(none.json, { ok: false, code: 'NO_PROFILE', error: '没有可用的执行者处理「research」类任务', trace: ['兜底：plain：不支持只读任务，跳过'] });
  const missing = f.json(['route', '--type', 'code', '--profile', 'ghost']);
  assert.equal(missing.status, 2);
  assert.equal(missing.json.code, 'PROFILE_UNAVAILABLE');
  assert.equal(missing.json.error, '找不到执行者：ghost');
  // AR_PROFILE 与 --profile 同级；命令行成功时 trace 写命令行指定。
  const viaEnv = f.json(['route', '--type', 'code'], { env: { AR_PROFILE: 'scribe' } });
  assert.deepEqual(viaEnv.json.trace, ['命令行指定：scribe']);
  const badType = f.json(['route', '--type', 'nope']);
  assert.equal(badType.status, 2);
  assert.equal(badType.json.ok, false);
  const usage = f.json(['route', '--bogus']);
  assert.equal(usage.status, 2);
  assert.match(usage.json.error, /用法：ar route/);
});

test('每日上限：今天已派满的执行者被规则跳过（用 runs.jsonl 里今天的任务）', t => {
  const f = fixture(t, config({ profiles: { ...config().profiles, scribe: { ...config().profiles.scribe, limits: { maxTasksPerDay: 2, maxTokensPerDay: null } } } }));
  const now = Date.now();
  writeFileSync(path.join(f.home, 'runs.jsonl'), [1, 2].map(i => JSON.stringify({ v: 1, event: 'start', id: `x${i}`, profile: 'scribe', started: now })).join('\n') + '\n');
  const r = f.json(['route', '--type', 'docs']);
  assert.equal(r.json.profile, 'fake');
  assert.deepEqual(r.json.trace, ['全局规则 2：[docs] → scribe：已达每日上限（今天 2/2 个任务），跳过', '兜底：fake']);
});

test('用任务说明派发：dispatch.json 有 route，进度有"路由："一行，实际用了规则选的执行者', t => {
  const f = fixture(t);
  const spec = f.spec('docs-task.md', ['id: 900', 'title: 路由派发', 'type: docs']);
  const r = f.json(['dispatch', spec]);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  const dir = path.join(f.repo, '.agent-runs', r.json.name);
  const saved = JSON.parse(readFileSync(path.join(dir, 'dispatch.json'), 'utf8'));
  assert.equal(saved.profile, 'scribe');
  assert.deepEqual(saved.route, { profile: 'scribe', rule: { scope: 'global', index: 2 }, trace: ['全局规则 2：[docs] → scribe'] });
  assert.match(readFileSync(path.join(dir, 'progress.log'), 'utf8'), /路由：全局规则 2：\[docs\] → scribe/);
  const start = readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(row => row.event === 'start');
  assert.equal(start.profile, 'scribe');
  // 111：start 行的 route 是路由说明那一句，和 dispatch.json 的 route.trace 最后一句、进度里的那一行一致。
  assert.equal(start.route, saved.route.trace.at(-1));
  assert.equal(start.route, '全局规则 2：[docs] → scribe');
  // ar retry 沿用原任务的执行者，不重新路由（dispatch.json 不变）。
  const retried = f.json(['retry', r.json.name, '--note', '再来一次']);
  assert.equal(retried.status, 0, JSON.stringify(retried.json));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'dispatch.json'), 'utf8')), saved);
});

test('直接写任务文字、--profile：结果与以前相同，dispatch.json 与进度没有 route；任务说明 + --profile 记命令行指定，redispatch 沿用原记录', t => {
  const f = fixture(t);
  const saved = name => JSON.parse(readFileSync(path.join(f.repo, '.agent-runs', name, 'dispatch.json'), 'utf8'));
  const start = name => readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(row => row.event === 'start' && row.name === name);
  const direct = f.json(['dispatch', '随便做点什么']);
  assert.equal(direct.status, 0, JSON.stringify(direct.json));
  assert.equal('route' in saved(direct.json.name), false);
  assert.equal('route' in start(direct.json.name), false, '直接写任务文字：start 行没有 route');
  assert.doesNotMatch(readFileSync(path.join(f.repo, '.agent-runs', direct.json.name, 'progress.log'), 'utf8'), /路由：/);
  const explicit = f.json(['dispatch', '再做一件事', '--profile', 'scribe']);
  assert.equal(explicit.status, 0, JSON.stringify(explicit.json));
  assert.equal(saved(explicit.json.name).profile, 'scribe');
  assert.equal('route' in start(explicit.json.name), false, '任务文字 + --profile：没有路由记录，start 行没有 route');
  const pinned = f.json(['dispatch', f.spec('pinned.md', ['type: docs']), '--profile', 'fake']);
  assert.equal(pinned.status, 0, JSON.stringify(pinned.json));
  assert.deepEqual(saved(pinned.json.name).route, { profile: 'fake', rule: null, trace: ['命令行指定：fake'] });
  // 任务说明 + --profile 有路由记录（命令行指定），start 行照写。
  assert.equal(start(pinned.json.name).route, '命令行指定：fake');
  // 规则选出来的任务再派发一次：沿用原任务的 route（redispatch 带 --profile，不重新路由）。
  const ruled = f.json(['dispatch', f.spec('ruled.md', ['type: docs'])]);
  assert.equal(ruled.status, 0, JSON.stringify(ruled.json));
  const again = f.json(['redispatch', ruled.json.name]);
  assert.equal(again.status, 0, JSON.stringify(again.json));
  assert.deepEqual(saved(again.json.name).route, saved(ruled.json.name).route);
  assert.deepEqual(saved(again.json.name).route.trace, ['全局规则 2：[docs] → scribe']);
  assert.equal(start(again.json.name).route, '全局规则 2：[docs] → scribe');
  // 任务说明的 type 命中的规则不可用、没有别的执行者：派发失败，不留下记录。
  const spec = f.spec('research-task.md', ['type: research', 'worker: plain']);
  const failed = f.json(['dispatch', spec]);
  assert.equal(failed.status, 2);
  assert.match(failed.json.error, /任务说明指定的执行者 plain 不可用：不支持只读任务/);
  assert.equal(readdirSync(path.join(f.repo, '.agent-runs')).includes('research-task'), false, '失败时不占记录名');
});

// ---- Stage07 T8：路由配置的读写命令（软件"路由"页走同一条路径） ----
const readConfig = f => JSON.parse(readFileSync(path.join(f.home, 'config.json'), 'utf8'));
// config.json 去掉 routing 与指定执行者的 limits 之后的其余部分，用来断言"其余字段不变"。
const rest = (cfg, name = null) => { const { routing, ...others } = cfg; const profiles = Object.fromEntries(Object.entries(others.profiles).map(([key, value]) => { const { limits, ...more } = value; return [key, key === name ? more : value]; })); return { ...others, profiles }; };

test('ar route config --json：规则、兜底、审查者、默认执行者、每个执行者的只读能力 / 上限 / 今天用量、项目规则条数；只读不写文件', t => {
  const cfg = config({ routing: { rules: [{ types: ['research'], profile: 'reader' }, { types: ['docs'], profile: 'scribe', escalate: 'reader' }], fallback: 'scribe', reviewer: { profiles: ['reader', 'fake'], mustDiffer: false } } });
  cfg.profiles.scribe.limits = { maxTasksPerDay: 2, maxTokensPerDay: 1500000 };
  const f = fixture(t, cfg);
  const now = Date.now();
  writeFileSync(path.join(f.home, 'runs.jsonl'), [
    { v: 1, event: 'start', id: 'a', profile: 'scribe', started: now },
    { v: 1, event: 'attempt-end', id: 'a', usage: { input: 1000, output: 234 } },
    { v: 1, event: 'start', id: 'old', profile: 'scribe', started: now - 3 * 86400000 },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  // 项目规则：登记的项目里有 2 条规则；另一个登记的项目没有规则，不出现在 projectRules 里。
  mkdirSync(path.join(f.repo, '.agent-router'));
  writeFileSync(path.join(f.repo, '.agent-router', 'project.json'), JSON.stringify({ v: 1, routing: { rules: [{ types: ['docs'], profile: 'reader' }, { types: ['code'], profile: 'fake' }] } }));
  assert.equal(f.json(['projects', 'add', f.repo]).status, 0);
  const before = [listing(f.home), listing(f.repo), readFileSync(path.join(f.home, 'config.json'), 'utf8')];
  const r = f.json(['route', 'config']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.rules, cfg.routing.rules);
  assert.equal(r.json.fallback, 'scribe');
  assert.deepEqual(r.json.reviewer, { profiles: ['reader', 'fake'], mustDiffer: false, differFamily: false, differFromLead: true });
  assert.equal(r.json.defaultProfile, 'fake');
  assert.deepEqual(r.json.profiles.map(p => p.name), ['fake', 'reader', 'scribe', 'plain']);
  const byName = Object.fromEntries(r.json.profiles.map(p => [p.name, p]));
  assert.deepEqual(byName.fake, { name: 'fake', label: '假执行者', enabled: true, readOnly: true, limits: { maxTasksPerDay: null, maxTokensPerDay: null }, usage: { tasks: 0, tokens: 0 } });
  assert.equal(byName.reader.readOnly, true);
  assert.equal(byName.plain.readOnly, false, 'readOnly 与路由器是同一个判断：没有 readOnlyArgs 声明的通用执行者不支持只读');
  assert.equal(byName.plain.label, '不能只读的');
  assert.deepEqual(byName.scribe.limits, { maxTasksPerDay: 2, maxTokensPerDay: 1500000 });
  assert.deepEqual(byName.scribe.usage, { tasks: 1, tokens: 1234 }, '今天已用：只算今天开始的任务及其 token');
  assert.deepEqual(r.json.projectRules, [{ project: path.basename(f.repo), path: f.repo, count: 2 }]);
  assert.deepEqual([listing(f.home), listing(f.repo), readFileSync(path.join(f.home, 'config.json'), 'utf8')], before, 'route config 只读');
  // 文字输出也能用。
  const text = f.ar(['route', 'config']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /规则：2 条/);
  assert.match(text.stdout, /兜底：scribe/);
});

test('ar route config：没有 routing / reviewer 为 null 按空处理；旧的单值写法读成 profiles', t => {
  const cfg = config();
  delete cfg.routing;
  const f = fixture(t, cfg);
  const empty = f.json(['route', 'config']).json;
  assert.deepEqual([empty.rules, empty.fallback, empty.reviewer, empty.projectRules], [[], null, { profiles: [], mustDiffer: true, differFamily: true, differFromLead: true }, []]);
  const write = routing => writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(config({ routing })));
  write({ rules: [], fallback: null, reviewer: null });
  assert.deepEqual(f.json(['route', 'config']).json.reviewer, { profiles: [], mustDiffer: true, differFamily: true, differFromLead: true });
  write({ rules: [], fallback: null, reviewer: { profile: 'reader' } });
  assert.deepEqual(f.json(['route', 'config']).json.reviewer, { profiles: ['reader'], mustDiffer: true, differFamily: true, differFromLead: true }, '旧写法 { profile } 读成 profiles');
  write({ rules: [], fallback: null, reviewer: 'reader' });
  assert.deepEqual(f.json(['route', 'config']).json.reviewer, { profiles: ['reader'], mustDiffer: true, differFamily: true, differFromLead: true }, '旧的字符串写法也能读');
  write({ rules: [], fallback: null, reviewer: { profiles: ['reader'], mustDiffer: false } });
  assert.deepEqual(f.json(['route', 'config']).json.reviewer, { profiles: ['reader'], mustDiffer: false, differFamily: false, differFromLead: true });
  // 只有一个启用的执行者又没有 defaultProfile 时，默认执行者就是它（与路由器的兜底一致）。
  writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ v: 2, profiles: { solo: { adapter: 'fake', enabled: true }, off: { adapter: 'fake', enabled: false } } }));
  assert.equal(f.json(['route', 'config']).json.defaultProfile, 'solo');
});

test('ar route rules set：整体替换 routing.rules，其余字段原样保留；返回写入后的整份视图', t => {
  const f = fixture(t);
  const before = readConfig(f);
  const rules = [{ types: ['code', 'test'], profile: 'scribe', escalate: 'reader' }, { types: ['research'], profile: 'reader', escalate: null }, { types: ['docs'], profile: 'fake' }];
  const r = f.json(['route', 'rules', 'set', JSON.stringify(rules)]);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.deepEqual(r.json.rules, rules);
  const after = readConfig(f);
  assert.deepEqual(after.routing.rules, rules);
  assert.deepEqual(after.routing.fallback, before.routing.fallback);
  assert.deepEqual(after.routing.reviewer, before.routing.reviewer);
  assert.deepEqual(rest(after), rest(before), '其余字段不变');
  assert.equal(readFileSync(path.join(f.home, 'config.json'), 'utf8').endsWith('}\n'), true);
  // 新规则马上生效：路由用它。
  assert.equal(f.json(['route', '--type', 'test']).json.profile, 'scribe');
  // 清空。
  assert.deepEqual(f.json(['route', 'rules', 'set', '[]']).json.rules, []);
  assert.deepEqual(readConfig(f).routing.rules, []);
  // 文字输出。
  assert.match(f.ar(['route', 'rules', 'set', '[]']).stdout, /已更新路由规则/);
});

test('ar route rules set 校验：退出码 2、中文原因、config.json 一个字节都不变', t => {
  const f = fixture(t);
  const file = path.join(f.home, 'config.json');
  const original = readFileSync(file, 'utf8');
  const reject = (value, pattern) => {
    const r = f.json(['route', 'rules', 'set', typeof value === 'string' ? value : JSON.stringify(value)]);
    assert.equal(r.status, 2, JSON.stringify(value));
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, pattern, JSON.stringify(value));
    assert.equal(readFileSync(file, 'utf8'), original, `被拒绝后配置不变：${JSON.stringify(value)}`);
  };
  reject('不是 JSON', /不是有效的 JSON/);
  reject({ types: ['code'], profile: 'fake' }, /规则必须是数组/);
  reject([null], /第 1 条规则必须是对象/);
  reject([{ types: [], profile: 'fake' }], /types 至少要有一个任务类型/);
  reject([{ profile: 'fake' }], /types 至少要有一个任务类型/);
  reject([{ types: ['code', 'nope'], profile: 'fake' }], /任务类型只能是 code、test、fix、refactor、research、docs、review（当前：nope）/);
  reject([{ types: ['code'], profile: 'ghost' }], /执行者 ghost 不存在/);
  reject([{ types: ['code'] }], /执行者 undefined 不存在/);
  reject([{ types: ['code'], profile: 'fake', escalate: 'ghost' }], /升级执行者 ghost 不存在/);
  reject([{ types: ['code'], profile: 'fake', extra: 1 }], /不能有这些字段：extra/);
  reject([{ types: ['code'], profile: 'fake' }, { types: ['docs'], profile: 'ghost' }], /第 2 条规则的执行者 ghost 不存在/);
  const usage = f.json(['route', 'rules', 'set']);
  assert.equal(usage.status, 2);
  const stderr = f.ar(['route', 'rules', 'set', '[{"types":[],"profile":"fake"}]']);
  assert.equal(stderr.status, 2);
  assert.match(stderr.stderr, /types 至少要有一个任务类型/);
});

test('ar route fallback set / clear：写 routing.fallback，其余字段不变；不存在的执行者被拒绝', t => {
  const f = fixture(t);
  const before = readConfig(f);
  const set = f.json(['route', 'fallback', 'set', 'scribe']);
  assert.equal(set.status, 0, JSON.stringify(set.json));
  assert.equal(set.json.fallback, 'scribe');
  const after = readConfig(f);
  assert.equal(after.routing.fallback, 'scribe');
  assert.deepEqual(after.routing.rules, before.routing.rules);
  assert.deepEqual(rest(after), rest(before));
  assert.equal(f.json(['route', '--type', 'code']).json.profile, 'scribe', '没有规则符合时用兜底');
  const cleared = f.json(['route', 'fallback', 'clear']);
  assert.equal(cleared.status, 0);
  assert.equal(cleared.json.fallback, null);
  assert.equal(readConfig(f).routing.fallback, null);
  assert.deepEqual(rest(readConfig(f)), rest(before));
  const file = path.join(f.home, 'config.json'), original = readFileSync(file, 'utf8');
  const bad = f.json(['route', 'fallback', 'set', 'ghost']);
  assert.equal(bad.status, 2);
  assert.match(bad.json.error, /找不到执行者：ghost/);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(f.json(['route', 'fallback', 'set']).status, 2);
  assert.equal(f.json(['route', 'fallback', 'clear', 'extra']).status, 2);
});

test('ar route reviewer set：写 { profiles, mustDiffer }；旧的 { profile } 写法转成 profiles；校验失败不写', t => {
  const f = fixture(t);
  const before = readConfig(f);
  const set = f.json(['route', 'reviewer', 'set', JSON.stringify({ profiles: ['reader', 'fake'], mustDiffer: false })]);
  assert.equal(set.status, 0, JSON.stringify(set.json));
  assert.deepEqual(set.json.reviewer, { profiles: ['reader', 'fake'], mustDiffer: false, differFamily: false, differFromLead: true });
  assert.deepEqual(readConfig(f).routing.reviewer, { profiles: ['reader', 'fake'], mustDiffer: false });
  assert.deepEqual(rest(readConfig(f)), rest(before));
  assert.deepEqual(readConfig(f).routing.rules, before.routing.rules);
  // mustDiffer 不写时是 true；旧的单值写法转成 profiles。
  const legacy = f.json(['route', 'reviewer', 'set', JSON.stringify({ profile: 'scribe' })]);
  assert.equal(legacy.status, 0, JSON.stringify(legacy.json));
  assert.deepEqual(readConfig(f).routing.reviewer, { profiles: ['scribe'], mustDiffer: true });
  assert.equal(f.json(['route', 'reviewer', 'set', JSON.stringify({ profiles: [] })]).status, 0, '清空候选是允许的');
  assert.deepEqual(readConfig(f).routing.reviewer, { profiles: [], mustDiffer: true });
  // differFamily（190 D128）：可以单独写；这次没写时保留已有的值。
  const familyOff = f.json(['route', 'reviewer', 'set', JSON.stringify({ profiles: ['scribe'], mustDiffer: true, differFamily: false })]);
  assert.equal(familyOff.status, 0, JSON.stringify(familyOff.json));
  assert.deepEqual(readConfig(f).routing.reviewer, { profiles: ['scribe'], mustDiffer: true, differFamily: false });
  assert.deepEqual(f.json(['route', 'config']).json.reviewer, { profiles: ['scribe'], mustDiffer: true, differFamily: false, differFromLead: true });
  assert.equal(f.json(['route', 'reviewer', 'set', JSON.stringify({ profiles: ['scribe'] })]).status, 0);
  assert.deepEqual(readConfig(f).routing.reviewer, { profiles: ['scribe'], mustDiffer: true, differFamily: false }, '没写 differFamily 时保留已有的值');
  const file = path.join(f.home, 'config.json'), original = readFileSync(file, 'utf8');
  for (const [value, pattern] of [
    ['不是 JSON', /不是有效的 JSON/], [[], /审查者设置必须是对象/], [{}, /要写 profiles/], [{ profiles: 'reader' }, /profiles 必须是数组/],
    [{ profiles: ['ghost'] }, /审查者候选里的执行者不存在：ghost/], [{ profile: 'ghost' }, /不存在：ghost/], [{ profiles: ['reader'], mustDiffer: 'yes' }, /mustDiffer 必须是布尔值/], [{ profiles: ['reader'], differFamily: 'yes' }, /differFamily 必须是布尔值/], [{ profiles: ['reader'], extra: 1 }, /不能有这些字段：extra/],
  ]) {
    const r = f.json(['route', 'reviewer', 'set', typeof value === 'string' ? value : JSON.stringify(value)]);
    assert.equal(r.status, 2, JSON.stringify(value));
    assert.match(r.json.error, pattern);
    assert.equal(readFileSync(file, 'utf8'), original);
  }
});

test('ar route limit set：写执行者的 limits；空串删除这一项，两项都删掉就去掉 limits；其余字段不变', t => {
  const f = fixture(t);
  const before = readConfig(f);
  const both = f.json(['route', 'limit', 'set', 'scribe', '--tasks', '3', '--tokens', '2000000']);
  assert.equal(both.status, 0, JSON.stringify(both.json));
  assert.deepEqual(readConfig(f).profiles.scribe.limits, { maxTasksPerDay: 3, maxTokensPerDay: 2000000 });
  assert.deepEqual(both.json.profiles.find(p => p.name === 'scribe').limits, { maxTasksPerDay: 3, maxTokensPerDay: 2000000 });
  assert.deepEqual(rest(readConfig(f), 'scribe'), rest(before, 'scribe'), '其余字段不变');
  assert.deepEqual(readConfig(f).routing, before.routing);
  // 只改一项：另一项保留。
  f.json(['route', 'limit', 'set', 'scribe', '--tasks', '5']);
  assert.deepEqual(readConfig(f).profiles.scribe.limits, { maxTasksPerDay: 5, maxTokensPerDay: 2000000 });
  // 空串删除这一项。
  const dropped = f.json(['route', 'limit', 'set', 'scribe', '--tokens', '']);
  assert.equal(dropped.status, 0, JSON.stringify(dropped.json));
  assert.deepEqual(readConfig(f).profiles.scribe.limits, { maxTasksPerDay: 5 });
  assert.deepEqual(dropped.json.profiles.find(p => p.name === 'scribe').limits, { maxTasksPerDay: 5, maxTokensPerDay: null });
  f.json(['route', 'limit', 'set', 'scribe', '--tasks', '']);
  assert.equal('limits' in readConfig(f).profiles.scribe, false);
  assert.deepEqual(rest(readConfig(f), 'scribe'), rest(before, 'scribe'));
  // 路由真的按上限跳过：写入上限 1，再放一条今天的任务。
  f.json(['route', 'limit', 'set', 'scribe', '--tasks', '1']);
  writeFileSync(path.join(f.home, 'runs.jsonl'), JSON.stringify({ v: 1, event: 'start', id: 'x', profile: 'scribe', started: Date.now() }) + '\n');
  assert.equal(f.json(['route', '--type', 'docs']).json.profile, 'fake');
  assert.equal(f.json(['route', 'config']).json.profiles.find(p => p.name === 'scribe').usage.tasks, 1);
  // 校验：正整数或删除；执行者要存在；至少给一项；不写。
  const file = path.join(f.home, 'config.json'), original = readFileSync(file, 'utf8');
  for (const [args, pattern] of [
    [['scribe', '--tasks', '0'], /必须是正整数/], [['scribe', '--tasks', '-1'], /必须是正整数/], [['scribe', '--tasks', '1.5'], /必须是正整数/], [['scribe', '--tokens', 'abc'], /必须是正整数/],
    [['scribe', '--tasks', '9007199254740993'], /必须是正整数/], [['ghost', '--tasks', '1'], /找不到执行者：ghost/], [['scribe'], /用法：ar route/], [['scribe', '--tasks'], /用法：ar route/],
    [['scribe', '--bogus', '1'], /用法：ar route/], [['scribe', '--tasks', '1', '--tasks', '2'], /用法：ar route/], [[], /用法：ar route/],
  ]) {
    const r = f.json(['route', 'limit', 'set', ...args]);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.json.error, pattern, args.join(' '));
    assert.equal(readFileSync(file, 'utf8'), original, `被拒绝后配置不变：${args.join(' ')}`);
  }
});

test('路由配置命令：配置文件无效时拒绝，不写入；路由命令的旧用法照常', t => {
  const f = fixture(t);
  const file = path.join(f.home, 'config.json');
  writeFileSync(file, '{ "v": 2, ');
  for (const args of [['route', 'config'], ['route', 'rules', 'set', '[]'], ['route', 'fallback', 'clear'], ['route', 'limit', 'set', 'fake', '--tasks', '1']]) {
    const r = f.json(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.json.error, /config\.json 无法读取/);
  }
  assert.equal(readFileSync(file, 'utf8'), '{ "v": 2, ', '坏文件一个字节都不动');
  writeFileSync(file, JSON.stringify(config()));
  assert.equal(f.json(['route', '--type', 'docs']).json.profile, 'scribe');
});