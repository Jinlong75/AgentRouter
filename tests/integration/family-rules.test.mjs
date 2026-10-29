import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateV2 } from '../../core/lib/config.mjs';
import { familyNames, familyTable, pickReviewer } from '../../core/lib/roles.mjs';

// Stage07c 154（D88）：config.json 的 familyRules 补充或覆盖 core/templates/model-families.json；ar roles family set|clear|list；
// ar roles --json 的 families；ar roles set modelFamilies= 只接受合并后的家族。隔离的 AGENT_ROUTER_HOME，不派发、不启动任何执行者。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const config = () => ({
  v: 2, managed: false, watchWindow: 'never', defaultProfile: 'ds',
  profiles: {
    ds: { adapter: 'claude-code', label: 'DeepSeek', enabled: true, model: 'deepseek-v4-flash' },
    acme: { adapter: 'claude-code', label: 'Acme', enabled: true, model: 'Acme-Pro-1' },
    plain: { adapter: 'claude-code', label: 'Plain', enabled: true, model: 'Auto' },
  },
  routing: { rules: [], fallback: null, reviewer: { profiles: ['acme', 'ds'], mustDiffer: true } },
});

function fixture(t, cfg = config()) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-family-rules-'));
  t.after(() => { rmSync(base, { recursive: true, force: true }); });
  const home = path.join(base, 'home');
  mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_PROFILE']) delete env[key];
  assert.equal(path.dirname(env.AGENT_ROUTER_HOME), base, '隔离目录在临时目录里');
  const file = path.join(home, 'config.json');
  writeFileSync(file, JSON.stringify(cfg));
  const f = { home, file };
  f.ar = args => spawnSync(process.execPath, [script, ...args], { cwd: base, env, encoding: 'utf8', windowsHide: true, shell: false });
  f.json = args => { const r = f.ar([...args, '--json']); return { status: r.status, stderr: r.stderr, json: JSON.parse(r.stdout) }; };
  f.read = () => JSON.parse(readFileSync(file, 'utf8'));
  f.bytes = () => readFileSync(file, 'utf8');
  return f;
}

const template = ['claude', 'deepseek', 'glm', 'gpt', 'kimi', 'mimo', 'minimax', 'qwen'];

test('合并规则：familyRules 在前，同一前缀（不分大小写）以它为准；没有 familyRules 时与模板完全相同', () => {
  const plain = familyTable({});
  assert.ok(plain.every(item => item.source === 'template'));
  assert.deepEqual(familyNames({}), template);
  assert.deepEqual(familyNames({ familyRules: [] }), template);

  const merged = familyTable({ familyRules: [{ prefix: 'Acme', family: 'acme' }, { prefix: 'DeepSeek', family: 'ds-custom' }, { prefix: 'acme', family: 'ignored' }] });
  assert.deepEqual(merged.slice(0, 2).map(item => [item.prefix, item.family, item.source]), [['acme', 'acme', 'familyRules'], ['deepseek', 'ds-custom', 'familyRules']], '前缀小写化，同一前缀第一条为准');
  assert.equal(merged.filter(item => item.prefix === 'deepseek').length, 1, '模板里同一前缀的条目被覆盖掉');
  assert.equal(merged.find(item => item.prefix === 'deepseek').host, true, '覆盖不丢模板的 host 标记');
  assert.equal(merged.length, plain.length + 1);
  assert.deepEqual(familyNames({ familyRules: [{ prefix: 'Acme', family: 'acme' }, { prefix: 'DeepSeek', family: 'ds-custom' }] }), ['acme', 'claude', 'ds-custom', 'glm', 'gpt', 'kimi', 'mimo', 'minimax', 'qwen'], '去重、按名字排序；被覆盖掉的 deepseek 不在了');
  // 形状不对的条目（config 校验会先拒绝，这里只防手写绕过）忽略。
  assert.deepEqual(familyNames({ familyRules: [null, { prefix: '', family: 'x' }, { prefix: 'a', family: 'Bad Name' }, { prefix: 'b' }] }), template);
});

test('familyRules 参与审查者挑选：补充的前缀让原本"家族未知"的候选可用，覆盖的前缀改变同家族判断', () => {
  const cfg = config();
  const without = pickReviewer({ config: cfg, executor: 'ds' });
  assert.equal(without.ok, false, 'Acme 的模型认不出家族，deepseek 与执行者同家族');
  assert.ok(without.reasons.some(item => item.profile === 'acme' && /家族未知/.test(item.why)));
  const supplemented = pickReviewer({ config: { ...cfg, familyRules: [{ prefix: 'acme', family: 'acme' }] }, executor: 'ds' });
  assert.equal(supplemented.ok, true);
  assert.deepEqual([supplemented.profile, supplemented.families], ['acme', ['acme']]);
  // 覆盖：把 acme- 归到 deepseek 家族，就和 DeepSeek 执行者同家族了。
  const overridden = pickReviewer({ config: { ...cfg, familyRules: [{ prefix: 'acme', family: 'deepseek' }] }, executor: 'ds' });
  assert.equal(overridden.ok, false);
  assert.ok(overridden.reasons.some(item => item.profile === 'acme' && /同家族（deepseek）/.test(item.why)));
});

test('config 校验：familyRules 必须是 { prefix, family } 数组，family 只能是小写字母、数字、连字符', () => {
  const make = familyRules => ({ ...config(), familyRules });
  validateV2(make([{ prefix: 'acme', family: 'acme-2' }]));
  validateV2(make(undefined));
  assert.throws(() => validateV2(make('x')), /familyRules 必须为数组/);
  assert.throws(() => validateV2(make(['x'])), /familyRules\[0\] 必须为对象/);
  for (const prefix of ['', '  ', 5, undefined]) assert.throws(() => validateV2(make([{ prefix, family: 'a' }])), /prefix 必须为非空字符串/, String(prefix));
  for (const family of ['', 'Acme', 'a b', 'a_b', 5, undefined]) assert.throws(() => validateV2(make([{ prefix: 'a', family }])), /family 必须是由小写字母、数字、连字符组成的非空字符串/, String(family));
});

test('ar roles --json：families 是模板与 familyRules 合并后的列表；profiles 的家族按合并后的表算', t => {
  const f = fixture(t);
  let { json } = f.json(['roles']);
  assert.deepEqual(json.families, template);
  assert.deepEqual(json.profiles.find(p => p.name === 'acme').familiesUnknown, true);

  f.ar(['roles', 'family', 'set', 'Acme-', 'acme']);
  ({ json } = f.json(['roles']));
  assert.deepEqual(json.families, ['acme', ...template]);
  const acme = json.profiles.find(p => p.name === 'acme');
  assert.deepEqual([acme.families, acme.familiesUnknown, acme.familiesSource], [['acme'], false, 'model']);
});

test('ar roles family set|clear|list：写 familyRules（原子写入），列出合并后的整张表并标出来源', t => {
  const f = fixture(t);
  const before = f.read();

  const set = f.json(['roles', 'family', 'set', 'Acme', 'acme']);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.json.ok, true);
  assert.equal(set.json.updated, 'acme');
  assert.deepEqual(f.read().familyRules, [{ prefix: 'acme', family: 'acme' }], '前缀小写化后写入');
  assert.deepEqual({ ...f.read(), familyRules: undefined }, { ...before, familyRules: undefined }, '其余字段原样保留');

  f.ar(['roles', 'family', 'set', 'deepseek', 'ds-custom']);
  f.ar(['roles', 'family', 'set', 'zeta', 'zeta']);
  // 同一前缀再设一次：原地替换，不重复。
  const again = f.json(['roles', 'family', 'set', 'ACME', 'acme-2']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(f.read().familyRules, [{ prefix: 'acme', family: 'acme-2' }, { prefix: 'deepseek', family: 'ds-custom' }, { prefix: 'zeta', family: 'zeta' }]);

  const list = f.json(['roles', 'family', 'list']);
  assert.equal(list.status, 0);
  assert.deepEqual(list.json.table.slice(0, 3), [
    { prefix: 'acme', family: 'acme-2', source: 'familyRules' }, { prefix: 'deepseek', family: 'ds-custom', source: 'familyRules' }, { prefix: 'zeta', family: 'zeta', source: 'familyRules' },
  ]);
  assert.ok(list.json.table.slice(3).every(item => item.source === 'template'));
  assert.equal(list.json.table.filter(item => item.prefix === 'deepseek').length, 1, '被覆盖的模板项不重复列出');
  assert.deepEqual(list.json.familyRules.map(item => item.prefix), ['acme', 'deepseek', 'zeta']);
  assert.ok(list.json.families.includes('ds-custom') && !list.json.families.includes('deepseek'));
  const text = f.ar(['roles', 'family', 'list']).stdout;
  assert.match(text, /acme → acme-2（familyRules）/);
  assert.match(text, /qwen → qwen（内置）/);

  const cleared = f.json(['roles', 'family', 'clear', 'DeepSeek']);
  assert.equal(cleared.status, 0);
  assert.equal(cleared.json.cleared, true);
  assert.deepEqual(f.read().familyRules.map(item => item.prefix), ['acme', 'zeta']);
  assert.ok(f.json(['roles', 'family', 'list']).json.families.includes('deepseek'), '清除后模板里的 deepseek 又回来了');
  // 没有这个前缀：不报错、不改文件。
  const bytes = f.bytes();
  const none = f.json(['roles', 'family', 'clear', 'nothing']);
  assert.equal(none.status, 0);
  assert.equal(none.json.cleared, false);
  assert.equal(f.bytes(), bytes);
  // 清空后 familyRules 键也删掉。
  f.ar(['roles', 'family', 'clear', 'acme']);
  f.ar(['roles', 'family', 'clear', 'zeta']);
  assert.equal(Object.hasOwn(f.read(), 'familyRules'), false);
});

test('ar roles family：参数不对或家族名不合法时报错（退出码 2），config.json 一个字节都不动', t => {
  const f = fixture(t);
  const bytes = f.bytes();
  for (const args of [['set'], ['set', 'acme'], ['set', 'acme', 'a', 'b'], ['clear'], ['clear', 'a', 'b'], ['list', 'x'], ['wipe'], []]) {
    const r = f.json(['roles', 'family', ...args]);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.json.error, /ar roles family set/);
  }
  for (const family of ['Acme', 'a b', 'a_b']) {
    const r = f.json(['roles', 'family', 'set', 'acme', family]);
    assert.equal(r.status, 2, family);
    assert.match(r.json.error, /家族名只能由小写字母、数字、连字符组成/);
  }
  assert.equal(f.bytes(), bytes);

  // 手写坏了的 familyRules：整份配置无效，命令拒绝，文件不动。
  const broken = fixture(t, { ...config(), familyRules: [{ prefix: 'a', family: 'Bad' }] });
  const brokenBytes = broken.bytes();
  assert.equal(broken.json(['roles', 'family', 'set', 'b', 'b']).status, 2);
  assert.equal(broken.bytes(), brokenBytes);
});

test('ar roles set modelFamilies=：只接受合并后的家族；不在列表里报错并列出可选值，校验失败不写文件', t => {
  const f = fixture(t);
  const bytes = f.bytes();
  const refused = f.json(['roles', 'set', 'plain', 'modelFamilies=acme,qwen']);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.json.error, /不认识的模型家族：acme。可选值：claude、deepseek、glm、gpt、kimi、mimo、minimax、qwen/);
  assert.equal(f.bytes(), bytes, '失败时 config.json 一个字节都没动');
  // 大小写不敏感，模板里有的照常通过。
  const ok = f.json(['roles', 'set', 'plain', 'modelFamilies=Qwen,GLM']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(f.read().profiles.plain.modelFamilies, ['qwen', 'glm']);
  // 先补充家族，再设就可以了；roles 的结果里带合并后的 families。
  assert.equal(f.json(['roles', 'family', 'set', 'acme', 'acme']).status, 0);
  const after = f.json(['roles', 'set', 'plain', 'modelFamilies=acme']);
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(f.read().profiles.plain.modelFamilies, ['acme']);
  assert.ok(after.json.families.includes('acme'));
  // 清除（值为空）不需要校验。
  assert.equal(f.json(['roles', 'set', 'plain', 'modelFamilies=']).status, 0);
  assert.equal(Object.hasOwn(f.read().profiles.plain, 'modelFamilies'), false);
  // 清掉家族之后，已经写进 profile 的名字不再合法，但读取不受影响（只在写入时校验）。
  assert.equal(f.json(['roles', 'set', 'plain', 'modelFamilies=acme']).status, 0);
  assert.equal(f.json(['roles', 'family', 'clear', 'acme']).status, 0);
  assert.equal(f.json(['roles']).status, 0);
  assert.equal(f.json(['roles', 'set', 'plain', 'modelFamilies=acme']).status, 2);
});
