import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLine, readableError } from '../../core/adapters/codex.mjs';

// Stage02 T8b：Codex CLI 0.163.0（ChatGPT 订阅登录）真实输出，已匿名化。
const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
const expected = JSON.parse(readFileSync(path.join(fixtures, 'expected-codex-real-events.json'), 'utf8'));
const replay = name => {
  const lines = readFileSync(path.join(fixtures, name), 'utf8').split('\n'); if (lines.at(-1) === '') lines.pop();
  const events = [];
  lines.forEach((line, i) => { const ev = mapLine(line, { root: 'D:\\demo\\repo' }); if (ev.length) events.push({ line: i + 1, events: ev }); });
  return events;
};

for (const name of ['codex-real-sample.jsonl', 'codex-real-error.jsonl']) {
  test(`${name}（真实输出）逐行映射为期望的统一事件`, () => assert.deepEqual(replay(name), expected[name]));
}

test('真实样例：命令开始与结束同一 id、PowerShell 包装被去掉、退出码原样、最后一轮有用量', () => {
  const all = expected['codex-real-sample.jsonl'].flatMap(x => x.events);
  const cmds = all.filter(e => e.kind === 'cmd');
  assert.equal(cmds.length, 8);
  for (let i = 0; i < cmds.length; i += 2) { assert.equal(cmds[i].phase, 'start'); assert.equal(cmds[i + 1].phase, 'end'); assert.equal(cmds[i].id, cmds[i + 1].id); }
  assert.ok(cmds.every(c => !/powershell\.exe/i.test(c.command)));
  assert.deepEqual(cmds.filter(c => c.phase === 'end').map(c => c.exit), [1, 0, 0, 0]);
  assert.deepEqual(all.at(-1), { kind: 'turn', usage: { input: 1200, output: 300 } });
});

test('接口错误：从 Codex 转出的整段 JSON 里取状态码与说明；不是 JSON 原样返回', () => {
  assert.equal(readableError('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"bad model"}}'), '400 bad model');
  assert.equal(readableError('{"error":{"message":"no status"}}'), 'no status');
  assert.equal(readableError('普通错误'), '普通错误');
  assert.equal(readableError('{"other":1}'), '{"other":1}');
});

test('真实样例已匿名化：没有用户目录、临时目录名或时间戳', () => {
  for (const name of ['codex-real-sample.jsonl', 'codex-real-error.jsonl']) {
    assert.doesNotMatch(readFileSync(path.join(fixtures, name), 'utf8'), /[A-Za-z]:\\\\Users\\\\|~1|AppData|codex 验收 |"_at"/i, name);
  }
});
