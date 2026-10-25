import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelList, checkAgentFile, loadPreset, presetObjects } from '../../core/lib/agents.mjs';

test('parseModelList：跳过空行和表头 MODEL（大小写不敏感），其余每行一个模型名', () => {
  assert.deepEqual(parseModelList('MODEL\nA\n\n  B  \r\nC\r\n'), ['A', 'B', 'C']);
  assert.deepEqual(parseModelList('model\nQwen3.8-Max\nModel\nFast'), ['Qwen3.8-Max', 'Fast']);
  assert.deepEqual(parseModelList(''), []);
  assert.deepEqual(parseModelList(undefined), []);
  assert.deepEqual(parseModelList('\n\n'), []);
});

test('checkAgentFile：单独声明与导出文件分别校验；kind 不对、不是对象直接不通过', () => {
  const declaration = loadPreset('qoder').profile.generic;
  assert.deepEqual(checkAgentFile(declaration), { ok: true, kind: 'declaration', errors: [], warnings: [] });
  const bundle = { v: 1, kind: 'agentrouter-agent', name: 'qoder', profile: { ...loadPreset('qoder').profile, generic: 'qoder' }, generic: declaration };
  assert.equal(checkAgentFile(bundle).kind, 'export');
  assert.equal(checkAgentFile(bundle).ok, true);
  assert.equal(checkAgentFile(null).ok, false);
  assert.equal(checkAgentFile([1]).ok, false);
  assert.equal(checkAgentFile({ kind: 'x' }).errors[0].path, 'kind');
  assert.equal(checkAgentFile({ ...declaration, executable: '' }).errors[0].path, 'generic.executable');
});

test('预设：每个预设的下拉说明字段形状正确；Qoder 两个版本只在程序、令牌变量、显示名、说明和版本选项上不同', () => {
  for (const { name, profile } of presetObjects()) {
    for (const key of ['modelOptions', 'effortOptions', 'listModels', 'types', 'baseUrlOptions']) {
      if (profile[key] !== undefined) assert.ok(Array.isArray(profile[key]) && profile[key].every(item => typeof item === 'string' && item), `${name}.${key}`);
    }
    assert.ok(Array.isArray(profile.effortOptions) && profile.effortOptions.length > 0, `${name} 有 effortOptions`);
  }
  const cn = loadPreset('qoder-cn').profile, intl = loadPreset('qoder').profile;
  const strip = p => ({ ...p, label: '', title: '', description: '', secrets: {}, model: null, effort: null, variant: { ...p.variant, option: '', help: '' }, generic: { ...p.generic, label: '', executable: '', failureHints: [] } });
  assert.deepEqual(strip(cn), strip(intl));
  assert.equal(intl.generic.executable, 'qodercli');
  assert.deepEqual(Object.values(intl.secrets), ['QODER_PERSONAL_ACCESS_TOKEN']);
});
