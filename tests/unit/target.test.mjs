import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTarget, validateTarget } from '../../core/lib/target.mjs';

const template = readFileSync(new URL('../../core/templates/target.md', import.meta.url), 'utf8');
const expected = {
  goal: '待填写', milestones: [{ title: '待填写', commands: ['待填写'], manualChecks: ['待填写'] }],
  exclusions: ['待填写'], budget: '待填写', deadline: '待填写',
};
const error = (text, message) => assert.throws(() => parseTarget(text), { message });

test('模板原样解析，兼容空行、空白和 CRLF', () => {
  assert.deepEqual(parseTarget(template), expected);
  const spaced = template.split('\n').map(line => line ? `  ${line}  ` : line).join('\r\n');
  assert.deepEqual(parseTarget(`\r\n${spaced}\r\n`), expected);
});

test('多个里程碑及重复的命令和人工验证项保留顺序', () => {
  const text = template.replace('- 人工验证项：待填写', '- 完成条件命令： 命令二 \n- 人工验证项：检查一\n- 人工验证项：检查二\n### 第二项\n- 人工验证项：人工\n- 完成条件命令：命令');
  assert.deepEqual(parseTarget(text).milestones, [
    { title: '待填写', commands: ['待填写', '命令二'], manualChecks: ['检查一', '检查二'] },
    { title: '第二项', commands: ['命令'], manualChecks: ['人工'] },
  ]);
});

test('多行目标与混写的不做什么', () => {
  const text = template.replace('待填写\n## 里程碑', '第一行\n\n 第二行 \n## 里程碑')
    .replace('- 待填写\n## 预算', '- 不做甲\n 不做乙 \n## 预算');
  const parsed = parseTarget(text);
  assert.equal(parsed.goal, '第一行\n第二行');
  assert.deepEqual(parsed.exclusions, ['不做甲', '不做乙']);
  assert.deepEqual(validateTarget(parsed), { valid: true, errors: [] });
  error(template.replace('- 待填写\n## 预算', '## 预算'), '目标格式无效：第 9 行');
  for (const exclusions of [[], '文本', null]) {
    assert.deepEqual(validateTarget({ ...expected, exclusions }).errors, ['目标字段无效：exclusions']);
  }
  assert.deepEqual(validateTarget({ ...expected, exclusions: ['有效', 1, '多\n行'] }).errors,
    ['目标字段无效：exclusions[1]', '目标字段无效：exclusions[2]']);
});

test('缺失或空值、重复及未知行按出错行报错', () => {
  const lines = template.trimEnd().split('\n');
  for (const [index, replacement, line] of [
    [0, '', 2], [1, '', 3], [2, '', 4], [3, '', 5], [4, '', 6],
    [5, '', 8], [6, '', 8], [7, '', 9], [8, '', 10],
    [9, '', 12], [10, '', 12], [11, '', 13], [12, '', 14],
    [4, '### ', 5], [5, '- 完成条件命令：  ', 6], [6, '- 人工验证项：', 7],
    [3, '## 未知', 4], [7, '## 里程碑', 8], [2, '## 未知', 3],
  ]) {
    const input = [...lines]; input[index] = replacement;
    error(input.join('\n'), `目标格式无效：第 ${line} 行`);
  }
  error(lines.slice(0, -1).join('\n'), '目标格式无效：第 13 行');
  error(`${lines.join('\n')}\n未知`, '目标格式无效：第 14 行');
  error(`${lines.join('\n')}\n## 预算`, '目标格式无效：第 14 行');
});

test('非字符串输入逐字报错', () => {
  for (const input of [null, undefined, 1, {}, []]) error(input, '目标内容必须是字符串');
});

test('校验字段类型、空值及错误顺序', () => {
  assert.deepEqual(validateTarget(expected), { valid: true, errors: [] });
  assert.deepEqual(validateTarget(null), { valid: false, errors: [
    '目标字段无效：goal', '目标字段无效：milestones', '目标字段无效：exclusions',
    '目标字段无效：budget', '目标字段无效：deadline',
  ] });
  assert.deepEqual(validateTarget({ goal: ' ', milestones: [null, { title: 4, commands: ['好', ''], manualChecks: 'x' }, []], exclusions: 1, budget: '\n', deadline: null }), {
    valid: false, errors: [
      '目标字段无效：goal', '目标字段无效：milestones[0]', '目标字段无效：milestones[1].title',
      '目标字段无效：milestones[1].commands', '目标字段无效：milestones[1].manualChecks',
      '目标字段无效：milestones[2]', '目标字段无效：exclusions', '目标字段无效：budget', '目标字段无效：deadline',
    ],
  });
  for (const milestones of [null, {}, [], 'x']) {
    assert.deepEqual(validateTarget({ ...expected, milestones }).errors, ['目标字段无效：milestones']);
  }
  for (const key of ['commands', 'manualChecks']) {
    for (const bad of [[], [null], [1], ['多\n行'], new Array(1), {}]) {
      assert.deepEqual(validateTarget({ ...expected, milestones: [{ ...expected.milestones[0], [key]: bad }] }).errors,
        [`目标字段无效：milestones[0].${key}`]);
    }
  }
  assert.deepEqual(validateTarget({ ...expected, milestones: new Array(1) }).errors, ['目标字段无效：milestones[0]']);
});
