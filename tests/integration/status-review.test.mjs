import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

test('status 汇报计数与既有审查摘要', t => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar-status-report-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home'), dir = path.join(base, 'record');
  for (const p of [repo, home, dir]) mkdirSync(p);
  const git = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', shell: false });
  assert.equal(git.status, 0, git.stderr);
  const start = { v: 2, event: 'start', id: 'test-status', repo, name: '任务', dir, pid: process.pid, started: Date.now(), profile: 'fake', adapter: 'fake', at: Date.now() };
  writeFileSync(path.join(home, 'runs.jsonl'), `${JSON.stringify(start)}\n`);
  const call = (...args) => {
    const result = spawnSync(process.execPath, [script, 'status', '任务', ...args], { cwd: repo, env: { ...process.env, AGENT_ROUTER_HOME: home }, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const json = () => JSON.parse(call('--json'));
  assert.ok(!Object.hasOwn(json(), 'report'));
  assert.ok(!Object.hasOwn(json(), 'review'));
  assert.doesNotMatch(call(), /^审查：/m);

  writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ verdict: 'concerns', reviewer: 'fake-reviewer', crossed: true, issues: [{ severity: 'high' }, { severity: 'low' }] }));
  writeFileSync(path.join(dir, 'report.md'), 'TODO(lead)：一\nTODO(lead)：二\n## 4. 推断清单\n- 一\n- 二\n## 需要越界\n- a：原因\n## 已知问题\n无\n');
  assert.deepEqual(json().report, { todoLead: 2, inferences: 2, needsScope: 1 });
  // 审查 R3-1：编号、加粗、带冒号的标题（## 4. **推断清单**：）也要认出来。
  writeFileSync(path.join(dir, 'report.md'), '## 4. **推断清单**：\n- 一\n- 二\n- 三\n## 已知问题\n无\n');
  assert.equal(json().report.inferences, 3);
  assert.deepEqual(json().review, { verdict: 'concerns', reviewer: 'fake-reviewer', crossed: true, issues: 2, high: 1, needsHuman: false });
  assert.match(call(), /^审查：concerns（fake-reviewer，2 个问题，其中高 1）$/m);

  writeFileSync(path.join(dir, 'report.md'), '## 推断清单\n无\n## 需要越界\n- 无\n');
  assert.deepEqual(json().report, { todoLead: 0, inferences: 0, needsScope: 0 });
  writeFileSync(path.join(dir, 'report.md'), '普通汇报\n');
  assert.deepEqual(json().report, { todoLead: 0, inferences: null, needsScope: null });
  writeFileSync(path.join(dir, 'report.md'), '## 推断清单\n无法判断\n## 需要越界\n\n');
  // 需要越界节为空：与门禁的 parseNeedsScope 一致，记 0（不是 null）。
  assert.deepEqual(json().report, { todoLead: 0, inferences: null, needsScope: 0 });

  writeFileSync(path.join(dir, 'report.md'), [
    '1. 完成了什么：实现功能。',
    '2. 改动了哪些文件：两处。',
    '3. TODO(lead) 清单：无。',
    '4. **推断清单**：按既有格式处理。',
    '   - 第一项推断。',
    '   - 第二项含 TODO(lead)。',
    '5. 【核实】各项的结论和证据：通过。',
    '6. 协议修改建议：无。',
  ].join('\n'));
  // 审查 R4-1：冒号后的文字后面跟着子条目时只是引言，只数子条目。
  assert.deepEqual(json().report, { todoLead: 2, inferences: 2, needsScope: null });
  // 冒号后的文字后面没有子条目时，它就是唯一一条推断。
  writeFileSync(path.join(dir, 'report.md'), '4. **推断清单**：把 a 当成 b 处理。\n5. 核实：通过\n');
  assert.deepEqual(json().report, { todoLead: 0, inferences: 1, needsScope: null });
  // 审查 R4-2：需要越界节里的说明行不算路径，也不让计数作废。
  writeFileSync(path.join(dir, 'report.md'), '## 需要越界\n以下文件需要修改\n- docs/example.md：原因\n');
  assert.equal(json().report.needsScope, 1);
  // 审查 R5-1：下级标题下的列表项也算，与 parseNeedsScope 一致。
  writeFileSync(path.join(dir, 'report.md'), '## 需要越界\n### 核心\n- core/lib/example.mjs：原因\n');
  assert.equal(json().report.needsScope, 1);
  writeFileSync(path.join(dir, 'report.md'), '4. **推断清单**：\n   - 一\n   - 二\n5. 核实：通过\n');
  assert.deepEqual(json().report, { todoLead: 0, inferences: 2, needsScope: null });
  writeFileSync(path.join(dir, 'report.md'), '4. **推断清单**：无。\n5. 核实：通过\n');
  assert.deepEqual(json().report, { todoLead: 0, inferences: 0, needsScope: null });

  for (const heading of ['### 第 10 节 **需要越界**：', '## `10. 需要越界`', '### **(10) 需要越界：**']) {
    writeFileSync(path.join(dir, 'report.md'), `1. 完成了什么：部分完成。\n${heading}\n- \`docs/example.md\`：需要修改\n- tests/example.test.mjs：需要测试\n## 已知问题\n无\n`);
    assert.deepEqual(json().report, { todoLead: 0, inferences: null, needsScope: 2 }, heading);
  }
});
