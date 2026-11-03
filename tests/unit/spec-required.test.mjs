import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, missingSpecRequired, validateRequiredConfig } from '../../core/lib/spec.mjs';

test('必填字段、小节和类型过滤', () => {
  const rule = { fields: ['model', 'effort', 'verify'], sections: ['已有测试'], types: ['code'] };
  const parsed = parseSpec('---\ntype: code\nmodel: ""\neffort: []\n---\n### 受影响的已有测试\n');
  assert.deepEqual(missingSpecRequired(parsed, rule), { fields: ['model', 'effort', 'verify'], sections: [] });
  assert.deepEqual(missingSpecRequired(parsed, { ...rule, types: ['fix'] }), { fields: [], sections: [] });
  assert.deepEqual(missingSpecRequired(parsed), { fields: [], sections: [] });
  assert.deepEqual(missingSpecRequired(parseSpec('正文'), { sections: ['已有测试'] }).sections, ['已有测试']);
  assert.throws(() => validateRequiredConfig({ specRequired: { fields: 'model' } }), /项目配置无效/);
});
