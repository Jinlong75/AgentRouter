import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presetObjects, loadPreset } from '../../core/lib/agents.mjs';
import { suggestRules } from '../../core/lib/suggest.mjs';

// Stage07c T5：路由规则建议的纯函数。输入是配置、预设和测试记录，不读写任何文件。
const presets = presetObjects();
const AT = new Date(2026, 9, 26, 10, 42).getTime();
const passed = { at: AT, ok: true };

const claude = (extra = {}) => ({ adapter: 'claude-code', enabled: true, env: {}, secrets: { ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' }, ...extra });
const deepseek = (extra = {}) => ({ adapter: 'claude-code', label: 'DeepSeek V4 Pro', enabled: true, env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, secrets: { ANTHROPIC_AUTH_TOKEN: 'DEEPSEEK_API_KEY' }, ...extra });
const qoder = (extra = {}) => ({ adapter: 'generic', label: 'Qoder（国内版）', enabled: true, generic: 'qoder-cn', ...extra });
const base = (profiles, routing = {}) => ({ v: 2, profiles, generics: { 'qoder-cn': loadPreset('qoder-cn').profile.generic }, routing: { rules: [], fallback: null, reviewer: null, ...routing } });

test('只有一个默认执行者（DeepSeek）：test、docs 合成一条，why 带预设类型与测试时间', () => {
  const r = suggestRules({ config: base({ deepseek: deepseek() }), presets, tests: { deepseek: passed } });
  assert.deepEqual(r.rules, [{ types: ['test', 'docs'], profile: 'deepseek', why: 'DeepSeek V4 Pro 的预设建议用于测试、文档；测试连接 10-26 10:42 通过' }]);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.write, `ar route rules set '${JSON.stringify([{ types: ['test', 'docs'], profile: 'deepseek' }])}'`);
});

test('审查类型不出现在建议里，但 why 里仍写预设的全部用途；调研交给支持只读的 Qoder', () => {
  const r = suggestRules({ config: base({ qoder: qoder() }), presets, tests: { qoder: passed } });
  assert.deepEqual(r.rules.map(({ types, profile }) => ({ types, profile })), [{ types: ['research', 'docs'], profile: 'qoder' }]);
  assert.ok(!r.rules.some(rule => rule.types.includes('review')));
  assert.match(r.rules[0].why, /预设建议用于调研、文档、审查；测试连接 10-26 10:42 通过/);
});

test('多个同类执行者：按 profiles 的顺序取靠前的，后面的类型写进 skipped', () => {
  const profiles = { ds2: deepseek(), ds1: deepseek(), cc: claude() };
  const r = suggestRules({ config: base(profiles), presets, tests: { ds1: passed, ds2: passed, cc: passed } });
  assert.deepEqual(r.rules.map(({ types, profile }) => ({ types, profile })), [{ types: ['test', 'docs'], profile: 'ds2' }, { types: ['code', 'fix', 'refactor'], profile: 'cc' }]);
  assert.deepEqual(r.skipped, [{ profile: 'ds1', types: ['test'], why: '测试已建议给排在前面的 ds2' }, { profile: 'ds1', types: ['docs'], why: '文档已建议给排在前面的 ds2' }]);
});

test('测试没通过、没测过、停用、没设为可担任执行者的不参与，并说明原因', () => {
  const profiles = { failed: claude(), untested: claude(), off: claude({ enabled: false }), reviewerOnly: claude({ roles: ['reviewer'] }), good: claude() };
  const r = suggestRules({ config: base(profiles), presets, tests: { failed: { at: AT, ok: false }, off: passed, reviewerOnly: passed, good: passed } });
  assert.deepEqual(r.rules.map(rule => rule.profile), ['good']);
  assert.deepEqual(r.skipped, [
    { profile: 'failed', why: '测试连接没有通过' },
    { profile: 'untested', why: '还没有测试连接' },
    { profile: 'off', why: '已停用' },
    { profile: 'reviewerOnly', why: '没有设为可担任执行者' },
  ]);
});

test('兼容后端、OpenAI 兼容接口、自定义 CLI 不参与', () => {
  const profiles = {
    compat: claude({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic' } }),
    oai: { adapter: 'codex', enabled: true, provider: { baseUrl: 'https://example.invalid/v1' } },
    custom: { adapter: 'generic', enabled: true, generic: 'mine' },
  };
  const config = base(profiles);
  config.generics.mine = { ...loadPreset('qoder-cn').profile.generic, executable: 'my-cli' };
  const r = suggestRules({ config, presets, tests: { compat: passed, oai: passed, custom: passed } });
  assert.deepEqual(r.rules, []);
  assert.deepEqual(r.skipped.map(item => item.profile), ['compat', 'oai', 'custom']);
  assert.ok(r.skipped.every(item => item.why.includes('预设的任务类型')));
});

test('Codex 参与建议（code、fix、refactor）', () => {
  const r = suggestRules({ config: base({ codex: { adapter: 'codex', enabled: true } }), presets, tests: { codex: passed } });
  assert.deepEqual(r.rules.map(({ types, profile }) => ({ types, profile })), [{ types: ['code', 'fix', 'refactor'], profile: 'codex' }]);
});

test('调研给了不支持只读的执行者 → 跳过该类型并说明，其余类型照常', () => {
  const config = base({ qoder: qoder() });
  delete config.generics['qoder-cn'].readOnlyArgs;
  const r = suggestRules({ config, presets, tests: { qoder: passed } });
  assert.deepEqual(r.rules.map(({ types, profile }) => ({ types, profile })), [{ types: ['docs'], profile: 'qoder' }]);
  assert.deepEqual(r.skipped, [{ profile: 'qoder', types: ['research'], why: '调研需要只读，这个执行者不支持' }]);
});

test('已有规则覆盖部分类型：只建议不冲突的，被去掉的写进 skipped；已有规则在 write 里排前面', () => {
  const existing = [{ types: ['docs', 'research'], profile: 'qoder', escalate: 'cc' }];
  const r = suggestRules({ config: base({ ds: deepseek(), qoder: qoder(), cc: claude() }, { rules: existing }), presets, tests: { ds: passed, qoder: passed, cc: passed } });
  assert.deepEqual(r.rules.map(({ types, profile }) => ({ types, profile })), [{ types: ['test'], profile: 'ds' }, { types: ['code', 'fix', 'refactor'], profile: 'cc' }]);
  assert.deepEqual(r.skipped, [
    { types: ['docs'], why: '已有规则 1 覆盖文档' },
    { types: ['research'], why: '已有规则 1 覆盖调研' },
    { types: ['docs'], why: '已有规则 1 覆盖文档' },
  ]);
  assert.deepEqual(JSON.parse(r.write.slice(r.write.indexOf("'") + 1, -1)), [...existing, { types: ['test'], profile: 'ds' }, { types: ['code', 'fix', 'refactor'], profile: 'cc' }]);
});

test('已有规则覆盖全部类型：整条建议去掉，没有规则', () => {
  const existing = [{ types: ['test', 'docs'], profile: 'x' }];
  const r = suggestRules({ config: { ...base({ ds: deepseek(), x: claude() }, { rules: existing }) }, presets, tests: { ds: passed } });
  assert.deepEqual(r.rules, []);
  assert.deepEqual(r.skipped, [{ types: ['test'], why: '已有规则 1 覆盖测试' }, { types: ['docs'], why: '已有规则 1 覆盖文档' }, { profile: 'x', why: '还没有测试连接' }]);
  assert.equal(r.candidates, 1);
});

test('没有任何执行者 / 测试记录：没有建议，candidates 为 0', () => {
  const r = suggestRules({ config: base({}), presets, tests: {} });
  assert.deepEqual([r.rules, r.skipped, r.candidates], [[], [], 0]);
  assert.equal(r.write, "ar route rules set '[]'");
});
