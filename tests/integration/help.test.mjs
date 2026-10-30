import test from 'node:test';
import assert from 'node:assert/strict';
import { commands, usage } from '../../core/lib/cli.mjs';

// ar help 按用途分组（v0.7.5 走查：用户反馈 ar help 难读）：每个子命令一行、说明另起缩进一行，行宽尽量不超过 100 个字符。
const lines = usage.split('\n');

test('ar help：config 说明支持设置并发上限', () => {
  const index = lines.findIndex(line => line.startsWith('  ar config '));
  assert.match(lines[index + 1], /并发上限/);
});

test('ar help：分组标题都在，且按固定顺序出现', () => {
  const titles = ['【派发与查看】', '【验收与 git】', '【执行者与路由】', '【审查】', '【项目与任务说明】', '【其他】'];
  const at = titles.map(title => lines.indexOf(title));
  assert.ok(at.every(index => index >= 0), `分组标题缺失：${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, '分组按用途顺序排列');
  assert.match(lines[0], /^用法：/);
});

test('ar help：每个已知子命令都出现在以 "  ar <子命令>" 开头的行里', () => {
  const entries = commands.filter(name => name !== '--run-request' && name !== 'help');
  for (const name of entries) {
    assert.ok(lines.some(line => line.startsWith(`  ar ${name}`)), `帮助里缺子命令 ${name}`);
  }
  assert.ok(lines.some(line => /^ {2}ar version \| ar help$/.test(line)), 'version 与 help 在同一行');
});

test('ar help：每行不超过 100 个字符；说明行缩进在命令行之后', () => {
  for (const line of lines) assert.ok([...line].length <= 100, `超过 100 个字符：${line.slice(0, 40)}…`);
  const rows = lines.filter(line => line !== '' && !line.startsWith('【') && !line.startsWith('用法：'));
  assert.ok(rows.every(line => line.startsWith('  ar ') || line.startsWith('      ')), '每行要么是命令行（两格缩进）要么是说明行（六格缩进）');
  assert.ok(rows.some(line => line.startsWith('      ')), '有说明行');
});

test('ar help：roles 与 reviewer 的用法补上 lead 与 differFamily（190 D128）', () => {
  assert.ok(lines.some(line => line.startsWith('  ar roles set ') && line.includes('roles=executor,reviewer,lead')), 'roles 可写 lead');
  assert.ok(lines.some(line => line.includes('differFamily')), 'reviewer set 的开关里有 differFamily');
});
