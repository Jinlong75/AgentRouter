import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { route, usageToday, supportsReadOnly, reviewerOf, routeConfigView, routeConfigCommand } from '../../core/lib/router.mjs';
import { validateSpec, parseSpec } from '../../core/lib/spec.mjs';
import { loadConfig, readEffectiveConfig } from '../../core/lib/config.mjs';

// 路由器的单元测试：配置、清单都在系统临时目录里，不碰真实目录。
function home(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), '路由 '));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const rows = (dir, list) => fs.writeFileSync(path.join(dir, 'runs.jsonl'), list.map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
const noon = new Date(2026, 9, 24, 12, 0, 0).getTime();
const DAY = 86400000;

// 一组常用执行者：claude-code / codex / fake 支持只读，没有 readOnlyArgs 声明的 generic（plain）不支持。
const profile = (extra = {}) => ({ adapter: 'claude-code', label: '执行者', enabled: true, ...extra });
const base = (extra = {}) => ({
  v: 2, defaultProfile: 'deepseek',
  profiles: { deepseek: profile({ label: 'DeepSeek', escalate: 'sonnet' }), sonnet: profile({ label: 'Sonnet' }), qoder: profile({ label: 'Qoder' }), plain: { adapter: 'generic', generic: 'plain', enabled: true } },
  routing: { rules: [], fallback: null, reviewer: null },
  ...extra,
});

test('优先级：命令行 > 任务说明 > 项目规则 > 全局规则 > fallback > defaultProfile', t => {
  const h = home(t);
  const config = base({ routing: { rules: [{ types: ['code'], profile: 'sonnet' }], fallback: 'qoder', reviewer: null } });
  const projectConfig = { routing: { rules: [{ types: ['code'], profile: 'qoder' }] } };
  const spec = { type: 'code', worker: 'plain' };
  assert.equal(route({ spec, projectConfig, config, explicit: 'deepseek', home: h }).profile, 'deepseek', '命令行');
  assert.equal(route({ spec, projectConfig, config, home: h }).profile, 'plain', '任务说明');
  assert.equal(route({ spec: { type: 'code', worker: 'auto' }, projectConfig, config, home: h }).profile, 'qoder', '项目规则');
  assert.equal(route({ spec: { type: 'code' }, config, home: h }).profile, 'sonnet', '全局规则');
  assert.equal(route({ spec: { type: 'docs' }, config, home: h }).profile, 'qoder', 'fallback');
  assert.equal(route({ spec: { type: 'docs' }, config: base(), home: h }).profile, 'deepseek', 'defaultProfile');
});

test('trace 文案：命令行、任务说明、规则编号从 1 开始、兜底', t => {
  const h = home(t);
  const config = base({ routing: { rules: [{ types: ['docs'], profile: 'qoder' }, { types: ['code', 'test', 'fix'], profile: 'sonnet' }], fallback: null, reviewer: null } });
  assert.deepEqual(route({ spec: { type: 'code' }, config, explicit: 'qoder', home: h }).trace, ['命令行指定：qoder']);
  assert.deepEqual(route({ spec: { type: 'code', worker: 'qoder' }, config, home: h }).trace, ['任务说明指定：qoder']);
  const hit = route({ spec: { type: 'test' }, config, home: h });
  assert.deepEqual(hit.trace, ['全局规则 2：[code, test, fix] → sonnet']);
  assert.deepEqual(hit.rule, { scope: 'global', index: 2 });
  const project = route({ spec: { type: 'docs' }, projectConfig: { routing: { rules: [{ types: ['docs'], profile: 'sonnet' }] } }, config, home: h });
  assert.deepEqual(project.trace, ['项目规则 1：[docs] → sonnet']);
  assert.deepEqual(project.rule, { scope: 'project', index: 1 });
  const fallback = route({ spec: { type: 'research' }, config, home: h });
  assert.deepEqual(fallback.trace, ['兜底：deepseek']);
  assert.equal(fallback.rule, null);
});

test('停用与不存在：规则里的执行者跳过并记原因，继续往下找', t => {
  const h = home(t);
  const config = base({ routing: { rules: [{ types: ['research'], profile: 'ghost' }, { types: ['research'], profile: 'qoder' }], fallback: null, reviewer: null } });
  config.profiles.qoder.enabled = false;
  const result = route({ spec: { type: 'research' }, config, home: h });
  assert.equal(result.profile, 'deepseek');
  assert.deepEqual(result.trace, [
    '全局规则 1：[research] → ghost：不存在，跳过',
    '全局规则 2：[research] → qoder：已停用，跳过',
    '兜底：deepseek',
  ]);
  // 项目规则先于全局规则；项目规则里停用的跳过后落到全局规则。
  const both = route({ spec: { type: 'research' }, projectConfig: { routing: { rules: [{ types: ['research'], profile: 'qoder' }] } }, config: base({ routing: { rules: [{ types: ['research'], profile: 'sonnet' }], fallback: null, reviewer: null } }), home: h });
  assert.equal(both.profile, 'qoder', '项目规则先于全局规则');
  assert.equal(both.trace.length, 1);
  // 项目规则里的执行者停用：跳过后落到全局规则。
  const skipped = route({ spec: { type: 'research' }, projectConfig: { routing: { rules: [{ types: ['research'], profile: 'qoder' }] } }, config: { ...config, routing: { rules: [{ types: ['research'], profile: 'sonnet' }], fallback: null, reviewer: null } }, home: h });
  assert.deepEqual(skipped.trace, ['项目规则 1：[research] → qoder：已停用，跳过', '全局规则 1：[research] → sonnet']);
});

test('规则类型不含任务类型、写法不对的规则不参与，也不进 trace', t => {
  const h = home(t);
  const config = base({ routing: { rules: [{ types: ['docs'], profile: 'qoder' }, null, { types: 'code', profile: 'qoder' }], fallback: null, reviewer: null } });
  assert.deepEqual(route({ spec: { type: 'code' }, config, home: h }).trace, ['兜底：deepseek']);
});

test('命令行指定：不存在或已停用报错，不换别人；文案同旧的选择', t => {
  const h = home(t);
  const config = base();
  config.profiles.qoder.enabled = false;
  assert.throws(() => route({ config, explicit: 'ghost', home: h }), error => error.code === 'PROFILE_UNAVAILABLE' && error.message === '找不到执行者：ghost' && error.trace[0] === '命令行指定：ghost：不存在');
  assert.throws(() => route({ config, explicit: 'qoder', home: h }), error => error.message === '执行者 qoder 已停用');
});

test('只读约束：research / review 跳过不支持只读的执行者，docs 不要求，read_only: true 要求', t => {
  const h = home(t);
  const config = base({ defaultProfile: 'plain', routing: { rules: [{ types: ['research', 'docs'], profile: 'plain' }], fallback: 'sonnet', reviewer: null } });
  const research = route({ spec: { type: 'research' }, config, home: h });
  assert.equal(research.profile, 'sonnet');
  assert.equal(research.needsReadOnly, true);
  assert.deepEqual(research.trace, ['全局规则 1：[research, docs] → plain：不支持只读任务，跳过', '兜底：sonnet']);
  assert.equal(route({ spec: { type: 'review' }, config, home: h }).profile, 'sonnet');
  const docs = route({ spec: { type: 'docs' }, config, home: h });
  assert.equal(docs.profile, 'plain');
  assert.equal(docs.needsReadOnly, false);
  const flagged = route({ spec: { type: 'docs', read_only: true }, config, home: h });
  assert.equal(flagged.profile, 'sonnet');
  assert.equal(flagged.needsReadOnly, true);
  assert.equal(route({ spec: { type: 'code', read_only: false }, config, home: h }).needsReadOnly, false);
});

test('supportsReadOnly：claude-code / codex / fake 支持，未知适配器不支持，generic 看声明里有没有 readOnlyArgs', () => {
  assert.equal(supportsReadOnly({ adapter: 'claude-code' }), true);
  assert.equal(supportsReadOnly({ adapter: 'codex' }), true);
  assert.equal(supportsReadOnly({ adapter: 'fake' }), true);
  assert.equal(supportsReadOnly({ adapter: 'nope' }), false);
  const config = { generics: { a: { executable: 'x', readOnlyArgs: ['{prompt}'] }, b: { executable: 'x' } } };
  assert.equal(supportsReadOnly({ adapter: 'generic', generic: 'a' }, config), true);
  assert.equal(supportsReadOnly({ adapter: 'generic', generic: 'b' }, config), false);
  assert.equal(supportsReadOnly({ adapter: 'generic', generic: 'missing' }, config), false);
  assert.equal(supportsReadOnly({ adapter: 'generic', generic: { readOnlyArgs: [] } }, {}), true, '内嵌的声明');
  assert.equal(supportsReadOnly({ adapter: 'generic' }, config), false, '没有声明');
});

test('任务说明指定的执行者不可用：报错并说明原因，不悄悄换人', t => {
  const h = home(t);
  const config = base();
  config.profiles.qoder.enabled = false;
  const fails = (spec, reason) => assert.throws(() => route({ spec, config, home: h }),
    error => error.code === 'PROFILE_UNAVAILABLE' && error.message === `任务说明指定的执行者 ${spec.worker} 不可用：${reason}` && error.trace.at(-1) === `任务说明指定：${spec.worker}：${reason}`);
  fails({ type: 'code', worker: 'ghost' }, '不存在');
  fails({ type: 'code', worker: 'qoder' }, '已停用');
  fails({ type: 'research', worker: 'plain' }, '不支持只读任务');
  // worker 为 auto 或不写：当作没指定。
  assert.equal(route({ spec: { type: 'code', worker: 'auto' }, config, home: h }).profile, 'deepseek');
  assert.equal(route({ spec: { type: 'code', worker: '' }, config, home: h }).profile, 'deepseek');
});

test('每日上限：任务数达到 → 不可用，trace 写今天 3/3；没到 3 还可用；留空或 null 不限', t => {
  const h = home(t);
  const config = base({ routing: { rules: [{ types: ['code'], profile: 'deepseek' }], fallback: 'sonnet', reviewer: null } });
  config.profiles.deepseek.limits = { maxTasksPerDay: 3 };
  const started = n => rows(h, Array.from({ length: n }, (_, i) => ({ event: 'start', id: `a${i}`, profile: 'deepseek', started: noon - i * 1000 })));
  started(2);
  assert.equal(route({ spec: { type: 'code' }, config, home: h, now: noon }).profile, 'deepseek', '2/3 还可用');
  started(3);
  const result = route({ spec: { type: 'code' }, config, home: h, now: noon });
  assert.equal(result.profile, 'sonnet');
  assert.deepEqual(result.trace, ['全局规则 1：[code] → deepseek：已达每日上限（今天 3/3 个任务），跳过', '兜底：sonnet']);
  // 留空与 null 都是不限。
  for (const limits of [undefined, {}, { maxTasksPerDay: null, maxTokensPerDay: null }]) {
    config.profiles.deepseek.limits = limits;
    assert.equal(route({ spec: { type: 'code' }, config, home: h, now: noon }).profile, 'deepseek');
  }
});

test('每日上限：token 达到、只统计自己这个执行者、跨天恢复', t => {
  const h = home(t);
  const config = base({ routing: { rules: [{ types: ['code'], profile: 'deepseek' }], fallback: 'sonnet', reviewer: null } });
  config.profiles.deepseek.limits = { maxTokensPerDay: 1000000 };
  rows(h, [
    { event: 'start', id: 'a', profile: 'deepseek', started: noon },
    { event: 'attempt-end', id: 'a', n: 1, usage: { input: 700000, output: 100000 } },
    { event: 'attempt-end', id: 'a', n: 2, usage: { input: 300000, output: null } },
    // 别的执行者的用量不算。
    { event: 'start', id: 'b', profile: 'sonnet', started: noon },
    { event: 'attempt-end', id: 'b', n: 1, usage: { input: 9000000, output: 9000000 } },
    // 昨天开始的任务不算。
    { event: 'start', id: 'c', profile: 'deepseek', started: noon - DAY },
    { event: 'attempt-end', id: 'c', n: 1, usage: { input: 5000000, output: 0 } },
  ]);
  assert.deepEqual(usageToday({ home: h, profile: 'deepseek', now: noon }), { tasks: 1, tokens: 1100000 });
  assert.deepEqual(usageToday({ home: h, profile: 'sonnet', now: noon }), { tasks: 1, tokens: 18000000 });
  const result = route({ spec: { type: 'code' }, config, home: h, now: noon });
  assert.equal(result.profile, 'sonnet');
  assert.match(result.trace[0], /已达每日上限（今天 1\.1M\/1M token），跳过/);
  // 第二天 0 点之后：今天的统计重新开始，deepseek 恢复。
  const next = route({ spec: { type: 'code' }, config, home: h, now: noon + DAY });
  assert.equal(next.profile, 'deepseek');
  assert.deepEqual(usageToday({ home: h, profile: 'deepseek', now: noon + DAY }), { tasks: 0, tokens: 0 });
  // 没有清单、没有 usage 的 attempt-end：当 0。
  assert.deepEqual(usageToday({ home: path.join(h, '不存在'), profile: 'deepseek', now: noon }), { tasks: 0, tokens: 0 });
});

test('全部不可用：报错 NO_PROFILE 并带上 trace', t => {
  const h = home(t);
  const config = base({ defaultProfile: 'deepseek', routing: { rules: [{ types: ['research'], profile: 'plain' }], fallback: 'plain', reviewer: null } });
  config.profiles.deepseek.enabled = false;
  assert.throws(() => route({ spec: { type: 'research' }, config, home: h }), error => {
    assert.equal(error.code, 'NO_PROFILE');
    assert.equal(error.message, '没有可用的执行者处理「research」类任务');
    assert.deepEqual(error.trace, [
      '全局规则 1：[research] → plain：不支持只读任务，跳过',
      '兜底：plain：不支持只读任务，跳过',
      '兜底：deepseek：已停用，跳过',
    ]);
    return true;
  });
  // 没有任何配置的执行者也是 NO_PROFILE（trace 为空）。
  assert.throws(() => route({ spec: null, config: { v: 2 }, home: h }), error => error.code === 'NO_PROFILE' && error.message === '没有可用的执行者处理这个任务' && error.trace.length === 0);
});

test('escalate 的取值：规则的优先，规则没写用执行者自己的；命令行、任务说明、兜底都用执行者自己的', t => {
  const h = home(t);
  const config = base({ routing: { rules: [
    { types: ['code'], profile: 'deepseek', escalate: 'qoder' },
    { types: ['fix'], profile: 'deepseek', escalate: null },
    { types: ['test'], profile: 'deepseek' },
    { types: ['docs'], profile: 'sonnet' },
  ], fallback: null, reviewer: null } });
  const escalate = spec => route({ spec, config, home: h }).escalate;
  assert.equal(escalate({ type: 'code' }), 'qoder', '规则写了');
  assert.equal(escalate({ type: 'fix' }), 'sonnet', 'null → 执行者自己的');
  assert.equal(escalate({ type: 'test' }), 'sonnet', '没写 → 执行者自己的');
  assert.equal(escalate({ type: 'docs' }), null, '执行者自己也没有');
  assert.equal(escalate({ type: 'refactor' }), 'sonnet', '兜底');
  assert.equal(route({ spec: { type: 'code', worker: 'deepseek' }, config, home: h }).escalate, 'sonnet', '任务说明指定');
  assert.equal(route({ spec: { type: 'code' }, config, explicit: 'deepseek', home: h }).escalate, 'sonnet', '命令行指定');
});

test('没有任务说明（直接写任务文字）：跳过规则，从兜底开始；没有默认执行者时取唯一启用的', t => {
  const h = home(t);
  const config = base({ routing: { rules: [{ types: ['code'], profile: 'sonnet' }], fallback: null, reviewer: null } });
  const direct = route({ spec: null, config, home: h });
  assert.equal(direct.profile, 'deepseek');
  assert.deepEqual(direct.trace, ['兜底：deepseek']);
  assert.equal(direct.needsReadOnly, false);
  // 没有 defaultProfile：唯一启用的执行者（与旧的选择一致）；有多个则落空。
  const sole = { v: 2, profiles: { only: profile(), off: profile({ enabled: false }) } };
  assert.equal(route({ spec: null, config: sole, home: h }).profile, 'only');
  assert.throws(() => route({ spec: null, config: { v: 2, profiles: { a: profile(), b: profile() } }, home: h }), error => error.code === 'NO_PROFILE');
});

test('任务说明的 read_only：布尔值，类型不对报错', () => {
  const spec = text => validateSpec(parseSpec(text, 's.md'), 's.md');
  assert.equal(spec('---\ntype: docs\nread_only: true\n---\n').read_only, true);
  assert.equal(spec('---\nread_only: false\n---\n').read_only, false);
  assert.equal(spec('---\ntype: docs\n---\n').read_only, undefined);
  assert.throws(() => spec('---\nread_only: yes\n---\n'), /s\.md 第 2 行：read_only 必须是 true 或 false/);
  assert.deepEqual(parseSpec('---\nread_only: true\n---\n', 's.md').warnings, [], '是认识的字段，没有警告');
});

test('loadConfig 的 choose：用路由器的选择，附带信息带回；limits / routing 写法不对被拒绝', t => {
  const h = home(t);
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(base()));
  const loaded = loadConfig(h, {}, {}, { choose: config => ({ profileName: 'sonnet', profile: config.profiles.sonnet, route: { marker: 1 } }) });
  assert.equal(loaded.profileName, 'sonnet');
  assert.deepEqual(loaded.route, { marker: 1 });
  const write = patch => fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(patch(base())));
  write(config => { config.profiles.deepseek.limits = { maxTasksPerDay: 0 }; return config; });
  assert.throws(() => readEffectiveConfig(h), /limits\.maxTasksPerDay 必须为正整数或 null/);
  write(config => { config.profiles.deepseek.limits = 3; return config; });
  assert.throws(() => readEffectiveConfig(h), /limits 必须为对象/);
  write(config => { config.routing.rules = [{ types: 'code', profile: 'x' }]; return config; });
  assert.throws(() => readEffectiveConfig(h), /routing\.rules\[0\]\.types 必须为字符串数组/);
  write(config => { config.profiles.deepseek.limits = { maxTasksPerDay: 5, maxTokensPerDay: null }; config.routing.rules = [{ types: ['code'], profile: 'sonnet', escalate: null }]; return config; });
  assert.equal(readEffectiveConfig(h).profiles.deepseek.limits.maxTasksPerDay, 5);
});

// Stage07 T8：路由配置的读写（命令行层的完整覆盖在 tests/integration/route-cli.test.mjs）。
test('reviewerOf：没有 / null 按空处理，旧的单值写法读成 profiles；三个开关的默认值', () => {
  assert.deepEqual(reviewerOf(undefined), { profiles: [], mustDiffer: true, differFamily: true, differFromLead: true });
  assert.deepEqual(reviewerOf({ reviewer: null }), { profiles: [], mustDiffer: true, differFamily: true, differFromLead: true });
  assert.deepEqual(reviewerOf({ reviewer: { profile: 'a' } }), { profiles: ['a'], mustDiffer: true, differFamily: true, differFromLead: true });
  assert.deepEqual(reviewerOf({ reviewer: 'a' }), { profiles: ['a'], mustDiffer: true, differFamily: true, differFromLead: true });
  assert.deepEqual(reviewerOf({ reviewer: { profiles: ['a', 'b', 5, ''], mustDiffer: false } }), { profiles: ['a', 'b'], mustDiffer: false, differFamily: false, differFromLead: true }, '没写 differFamily 时随 mustDiffer');
  assert.deepEqual(reviewerOf({ reviewer: { profiles: ['a'], mustDiffer: true, differFamily: false, differFromLead: false } }), { profiles: ['a'], mustDiffer: true, differFamily: false, differFromLead: false });
  assert.deepEqual(reviewerOf({ reviewer: { profiles: ['a'], profile: 'z' } }), { profiles: ['a'], mustDiffer: true, differFamily: true, differFromLead: true }, 'profiles 优先于旧的 profile');
});

test('routeConfigView：按路由器同一份判断给出只读能力、上限与今天用量；没有项目登记表时没有项目规则', t => {
  const h = home(t);
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify(base({ routing: { rules: [{ types: ['docs'], profile: 'qoder' }], fallback: 'sonnet', reviewer: { profile: 'qoder' } } })));
  rows(h, [{ event: 'start', id: 'a', profile: 'qoder', started: noon }, { event: 'attempt-end', id: 'a', usage: { input: 10, output: 5 } }]);
  const view = routeConfigView(h, { now: noon });
  assert.deepEqual(view.rules, [{ types: ['docs'], profile: 'qoder' }]);
  assert.equal(view.fallback, 'sonnet');
  assert.deepEqual(view.reviewer, { profiles: ['qoder'], mustDiffer: true, differFamily: true, differFromLead: true });
  assert.equal(view.defaultProfile, 'deepseek');
  assert.deepEqual(view.profiles.map(p => [p.name, p.readOnly]), [['deepseek', true], ['sonnet', true], ['qoder', true], ['plain', false]]);
  assert.deepEqual(view.profiles.find(p => p.name === 'qoder').usage, { tasks: 1, tokens: 15 });
  assert.deepEqual(view.projectRules, []);
});

test('routeConfigCommand：写入前校验，被拒绝时配置文件不变；写入后返回整份视图', t => {
  const h = home(t);
  const file = path.join(h, 'config.json');
  fs.writeFileSync(file, JSON.stringify(base()));
  const original = fs.readFileSync(file, 'utf8');
  assert.throws(() => routeConfigCommand(['rules', 'set', JSON.stringify([{ types: ['code'], profile: 'ghost' }])], { home: h }), /执行者 ghost 不存在/);
  assert.throws(() => routeConfigCommand(['limit', 'set', 'sonnet', '--tasks', '0'], { home: h }), /必须是正整数/);
  assert.throws(() => routeConfigCommand(['bogus'], { home: h }), /用法：ar route config/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const { result } = routeConfigCommand(['rules', 'set', JSON.stringify([{ types: ['code'], profile: 'sonnet' }])], { home: h });
  assert.deepEqual(result.rules, [{ types: ['code'], profile: 'sonnet' }]);
  assert.equal(route({ spec: { type: 'code' }, config: readEffectiveConfig(h), home: h }).profile, 'sonnet');
});