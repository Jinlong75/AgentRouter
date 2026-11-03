import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shouldBlock, blockReason } from '../../core/hooks/bash-guard.mjs';

const blocked = [
  'node core/ar.mjs wait 339-x --timeout 3600 &',
  '(node core/ar.mjs wait 339-x) &',
  'export AGENT_ROUTER_HOME=/tmp/h; node "C:/a b/core/ar.mjs" wait x > out.txt 2>&1 &',
  'ar wait x &',
  'nohup ar wait x >/dev/null 2>&1 & disown',
  'ar wait --json x &',
  'ar.cmd wait x &',
  'AGENT_ROUTER_HOME=/tmp/h ar wait x &',
  'A=1 B=2 node core/ar.mjs wait x &',
  'node --no-warnings core/ar.mjs wait x &',
  'node --max-old-space-size=4096 "C:/a b/core/ar.mjs" wait x &',
];
const allowed = [
  'node core/ar.mjs wait x --timeout 3600',
  'node core/ar.mjs wait x && echo done',
  'node core/ar.mjs wait x 2>&1 | tail -40',
  'npm run build &',
  'ar dispatch "wait & see" --detach',
  'grep -n "ar wait" handoff.md &',
  'echo wait & node core/ar.mjs status x',
  'node core/ar.mjs status wait-x &',
  'echo ar wait x &',
];
const script = fileURLToPath(new URL('../../core/hooks/bash-guard.mjs', import.meta.url));
const invoke = input => spawnSync(process.execPath, [script], { input, encoding: 'utf8' });
test('识别后台 wait 并放行其他命令', () => {
  for (const command of blocked) assert.equal(shouldBlock(command), true, command);
  for (const command of allowed) assert.equal(shouldBlock(command), false, command);
});
test('真实钩子进程拦截和放行', () => {
  const denied = invoke(JSON.stringify({ tool_name: 'Bash', tool_input: { command: blocked[0] } }));
  assert.equal(denied.status, 0);
  assert.deepEqual(JSON.parse(denied.stdout).hookSpecificOutput, {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: '不要在会话命令里用 & 把 ar wait 挂到后台：会随会话结束被停掉，也容易堆积。改用工具自带的后台运行（Bash 的 run_in_background）执行 ar wait <记录名> --timeout <秒>，或在前台运行。',
  });
  for (const input of [JSON.stringify({ tool_name: 'Bash', tool_input: { command: allowed[0] } }), JSON.stringify({ tool_name: 'Bash', tool_input: { command: allowed[0], run_in_background: true } }), JSON.stringify({ tool_name: 'Read', tool_input: { command: blocked[0] } }), '{broken', '']) {
    const result = invoke(input);
    assert.equal(result.status, 0); assert.equal(result.stdout, '');
  }
});

test('前台长命令按每次调用检查选项', () => {
  const commands = [
    'node core/ar.mjs dispatch docs/specs/1-x.md --base main',
    'node core/ar.mjs retry x --note "再来"',
    'node core/ar.mjs scope approve x',
    'AGENT_ROUTER_HOME=/tmp/h node "C:/a b/core/ar.mjs" retry "任务 一"',
  ];
  for (const command of commands) {
    assert.match(blockReason(command), /不要在会话前台运行/);
    assert.equal(blockReason(`${command} --detach`), null);
  }
  for (const command of ['node core/ar.mjs scope approve x --dry-run', 'node core/ar.mjs dispatch --help',
    'node core/ar.mjs status x', 'grep "ar retry" handoff.md',
    'node core/ar.mjs review confirm x R1-1 valid --note "以后再 retry"']) assert.equal(blockReason(command), null, command);
  assert.equal(blockReason(commands[1], { runInBackground: true }), null);
  assert.match(blockReason('ar retry x; ar wait x &'), /不要在会话命令里用 &/);
  assert.match(blockReason('ar retry x; ar dispatch x --detach'), /不要在会话前台运行/);
  const denied = invoke(JSON.stringify({ tool_name: 'Bash', tool_input: { command: commands[1] } }));
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, '不要在会话前台运行 ar dispatch / retry / scope approve：执行者要跑几十分钟，命令挂在会话里会随会话结束被停掉。加 --detach 后台派发，再用 ar wait <记录名> --timeout <秒> 等结果。');
  const allowed = invoke(JSON.stringify({ tool_name: 'Bash', tool_input: { command: commands[1], run_in_background: true } }));
  assert.equal(allowed.status, 0); assert.equal(allowed.stdout, '');
});
