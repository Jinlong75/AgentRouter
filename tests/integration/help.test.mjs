import test from 'node:test';
import assert from 'node:assert/strict';
test('ar help：列出全量验收的两种用法', () => {
  assert.ok(usage.includes('  ar verify [--project <路径>] [--detach] [--timeout-min <n>] [--json]'));
  assert.ok(usage.includes('  ar verify --last [--project <路径>] [--json]'));
});
import { commands, usage } from '../../core/lib/cli.mjs';

// ar help 按用途分组（v0.7.5 走查：用户反馈 ar help 难读）：每个子命令一行、说明另起缩进一行，行宽尽量不超过 100 个字符。
const lines = usage.split('\n');

test('ar help：accept 列出确认和强制验收参数', () => {
  assert.ok(lines.includes('  ar accept <记录名> [--ack "<说明>"] [--force --reason "<原因>"]'));
});

test('ar help：init 展示可选目标模板', () => {
  assert.ok(lines.includes('  ar init [项目路径] [--dry-run] [--target]'));
  assert.ok(lines.includes('  ar init --upgrade [项目路径] [--dry-run] [--target] [--replace-role <角色,…>] [--add-field <键,…>]'));
});

test('ar help：wait 支持超时', () => {
  assert.ok(lines.includes('  ar wait [记录名] [--timeout <秒>]'));
});

test('ar help：config 说明支持设置并发上限', () => {
  const index = lines.findIndex(line => line.startsWith('  ar config '));
  assert.match(lines[index + 1], /并发上限/);
});

test('ar help：retry 说明包含重跑门禁', () => {
  assert.ok(lines.some(line => line.includes('--regate') && line.includes('门禁')));
  assert.ok(lines.includes('      待验收、门禁未通过或门禁阶段被停止的任务改码后可用 --regate 重跑门禁与必要的审查。'));
});

test('ar help：列出越界批准命令', () => {
  assert.ok(lines.includes('  ar scope approve <记录名> [--paths <路径…>] [--dry-run] [--detach] [--json]'));
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

test('ar help：agents update 支持设置代提交', () => {
  assert.ok(lines.some(line => line.includes('--auto-commit on|off')));
});

test('ar help：agents update 支持设置和清除价格', () => {
  assert.ok(lines.some(line => line.includes('[--price <输入>/<输出>/<CNY|USD>|""]')));
});

test('ar help：agents update 支持覆盖擅长和避免', () => {
  assert.ok(lines.includes('      [--good "<…>"|""|-] [--avoid "<…>"|""|-]'));
  assert.ok(lines.includes('      --avoid/--good 覆盖预设的擅长/避免，"" 清空，- 回到预设'));
});

test('ar help：提供 DeepSeek Harness 部署和清理命令', () => {
  // 改写（主导，304）：原断言部署与卸载在同一行 → 分两行（加了 --check、--version 后超过每行 100 字符）。
  assert.ok(lines.includes('  ar agents deploy deepseek-harness [--check | --version <版本> | --cleanup]'));
  assert.ok(lines.includes('  ar agents undeploy deepseek-harness'));
});

test('ar help：next 支持查看全部说明', () => {
  assert.ok(lines.includes('  ar next [--project <路径>] [--all] [--dispatch]'));
});

test('ar help：列出主导开工包与启动钩子', () => {
  assert.ok(lines.includes('  ar lead brief [--json] [--hook]'));
  assert.ok(lines.includes('      主导开工包：交接文件、经验清单、角色文档、当前任务；--hook 供会话启动钩子使用'));
});

test('ar help：列出任务说明影响检查', () => {
  assert.ok(lines.includes('  ar spec impact <任务说明> [--docs] [--limit <n>] [--json]'));
  assert.ok(lines.includes('      列出可能受这份说明影响的已有测试与界面检查，只读'));
});


test('ar help：列出随核心分发的经验清单', () => {
  const index = lines.indexOf('  ar lead brief [--json] [--hook]');
  assert.equal(lines[index + 2], '  ar lead practices [<节号>] [--json]');
  assert.equal(lines[index + 3], '      主导经验清单（随核心分发，不依赖某个工具）；带节号只看那一节');
});

test('ar help：列出主导确认用法', () => { assert.ok(lines.includes('  ar lead ack <确认码>')); });

test('ar help：列出任务说明检查用法', () => {
  assert.ok(usage.includes('ar spec check <任务说明> [--project <路径>] [--base <分支>]'));
});

test('ar help：列出分批调研用法', () => {
  assert.ok(lines.includes('  ar research "<问题>" --files <glob…> [--batch <n>] [--budget-min <n>] [--profile <名>] [--json]'));
  assert.ok(lines.includes('  ar research collect <调研名> [--json]'));
});
