import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commands, usage } from '../../core/lib/cli.mjs';
import { DEFAULT_FILES, extractCommands, checkCommands } from '../../tools/verify-skill-commands.mjs';

test('从行内代码和代码块提取命令并保留行号', () => {
  const text = [
    '散文 ar wait x 和 `bar wait`，以及 `ar wait x --timeout 3`。',
    '```sh',
    'node "<技能目录>/core/ar.mjs" retry x --note "补充说明"',
    'cd "项目" && node "路径/core/ar.mjs" wait x',
    'ar agents list --json',
    'var wait',
    '```',
  ].join('\n');
  assert.deepEqual(extractCommands(text, '示例.md'), [
    { file: '示例.md', line: 1, sub: 'wait', args: ['x', '--timeout', '3'], raw: 'ar wait x --timeout 3' },
    { file: '示例.md', line: 3, sub: 'retry', args: ['x', '--note', '"补充说明"'], raw: 'node "<技能目录>/core/ar.mjs" retry x --note "补充说明"' },
    { file: '示例.md', line: 4, sub: 'wait', args: ['x'], raw: 'cd "项目" && node "路径/core/ar.mjs" wait x' },
    { file: '示例.md', line: 5, sub: 'agents', args: ['list', '--json'], raw: 'ar agents list --json' },
  ]);
});

test('核对子命令及选项，包括二级命令、全局选项和占位符', () => {
  const found = extractCommands([
    '`ar nope x`', '`ar wait x --missing=1`', '`ar agents list --timeout=1 --json`',
    '`ar <子命令> --missing`', '`ar … --missing`', '`ar wait x --timeout=1`',
  ].join('\n'), '示例.md');
  assert.deepEqual(checkCommands(found, { commands, usage }).map(p => [p.line, p.problem]), [
    [1, '未知子命令：nope'], [2, 'wait 没有选项：--missing'],
  ]);
});

test('真实仓库的技能与模板命令全部有效', () => {
  const found = DEFAULT_FILES.flatMap(file => extractCommands(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), file));
  const problems = checkCommands(found, { commands, usage });
  assert.deepEqual(problems, [], problems.map(p => `${p.file}:${p.line}  ${p.problem}  ${p.raw}`).join('\n'));
});
