import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { mapLine, limitOutput, shortCommand } from '../../core/adapters/codex.mjs';
import { homeDirectory } from '../../core/lib/config.mjs';
import { parseArgs, taskDetails } from '../../core/lib/options.mjs';
import { formatProgress } from '../../core/lib/progress.mjs';
import { viewerTakesOver, shouldWatch, watchCommand } from '../../core/lib/watch.mjs';

// 纯函数用例只需要隔离的仓库目录和公共目录，不启动任何进程。
function setup(t) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'dispatch 测试 '));
  t.after(() => {
    // 仅清理由本测试创建、位于系统临时目录中的目录。
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const root = path.join(base, '示例 仓库'), home = path.join(base, '公共 配置');
  fs.mkdirSync(root); fs.mkdirSync(home);
  return { base, root, home };
}

test('公共目录隔离及 Windows / XDG 回退', t => {
  const s = setup(t);
  assert.equal(homeDirectory({ CODEX_DISPATCH_HOME: s.home, APPDATA: s.root }, 'win32'), s.home);
  assert.equal(homeDirectory({ APPDATA: s.home }, 'win32'), path.join(s.home, 'agent-router'));
  assert.equal(homeDirectory({ XDG_CONFIG_HOME: s.home }, 'linux'), path.join(s.home, 'agent-router'));
  assert.equal(homeDirectory({ HOME: s.home }, 'linux'), path.join(s.home, '.config/agent-router'));
});

test('角色、共同规则、说明文件、补充说明的指令拼装保持原样', t => {
  const s = setup(t);
  fs.mkdirSync(path.join(s.root, 'docs/roles'), { recursive: true });
  fs.writeFileSync(path.join(s.root, 'AGENTS.md'), '共同规则');
  fs.writeFileSync(path.join(s.root, 'docs/roles/engineering.md'), '# 角色：工程负责人\n职责');
  fs.writeFileSync(path.join(s.root, '任务 说明.md'), '任务');
  const result = taskDetails(s.root, parseArgs(['任务 说明.md', '补充内容', '--role', 'engineering']));
  assert.equal(result.name, '任务 说明');
  assert.equal(result.prompt, '你在本项目中的角色是「工程负责人」。\n请先阅读仓库根目录的 AGENTS.md（共同规则）。\n再阅读你的角色文档 docs/roles/engineering.md，严格遵守其中的职责、硬规则、完成标准和汇报格式。\n然后完成任务说明 任务 说明.md 中的全部内容，按要求验证、提交，最后给出汇报。\n补充内容');
  assert.throws(() => taskDetails(s.root, parseArgs(['task', '--role', 'missing'])));
  for (const name of ['../outside', 'CON', 'bad/name', 'trailing.']) assert.throws(() => taskDetails(s.root, parseArgs(['task', '--name', name])));
});

test('输出按 200 行 / 16KB 截断，UTF-8 不出现半字；命令去 shell 外壳', () => {
  assert.equal(limitOutput(Array(201).fill('行').join('\n')).output.split('\n').length, 200);
  const limited = limitOutput('汉'.repeat(6000));
  assert.ok(Buffer.byteLength(limited.output) <= 16384); assert.ok(limited.truncated); assert.doesNotMatch(limited.output, /�/);
  assert.deepEqual(limitOutput('OK\n'), { output: 'OK\n', truncated: false });
  assert.equal(shortCommand("powershell.exe -NoProfile -Command 'Write-Output ''hello'''"), "Write-Output 'hello'");
  assert.equal(shortCommand('node script.mjs -Command arg'), 'node script.mjs -Command arg');
});

test('文件转相对路径；完整文本、计划替换、未知事件和错误处理', t => {
  const s = setup(t), map = e => mapLine(JSON.stringify(e), { root: s.root });
  assert.deepEqual(map({ type: 'item.completed', item: { type: 'file_change', changes: [{ kind: 'add', path: path.join(s.root, 'src/a.ts') }] } }),
    [{ kind: 'file', files: [{ kind: 'add', path: 'src/a.ts' }] }]);
  assert.deepEqual(map({ type: 'future', item: { type: 'agent_message', text: 'ignored' } }), []);
  assert.deepEqual(mapLine(' ', { root: s.root }), []);
  assert.deepEqual(mapLine('null', { root: s.root }), []);
  assert.deepEqual(map({ type: 'item.completed', item: { type: 'todo_list', items: [] } }), [{ kind: 'plan', items: [] }]);
  assert.deepEqual(map({ type: 'item.completed', item: { type: 'error', message: '测试错误' } }), [{ kind: 'error', text: '测试错误' }]);
  assert.deepEqual(formatProgress({ kind: 'error', text: '测试错误' }), ['出错：测试错误']);
});

test('窗口策略及 viewer 存活检查，路径引号正确处理', t => {
  const s = setup(t);
  assert.equal(viewerTakesOver(s.home), false);
  fs.writeFileSync(path.join(s.home, 'viewer.json'), JSON.stringify({ pid: process.pid, suppressWatchWindow: true }));
  assert.equal(viewerTakesOver(s.home), true);
  assert.equal(viewerTakesOver(s.home, () => { throw new Error('进程已退出'); }), false);
  for (const [policy, takeover, expected] of [['auto', true, false], ['auto', false, true], ['always', true, true], ['never', false, false]]) {
    assert.equal(shouldWatch({ platform: 'win32', interactive: false, policy, takeover }), expected);
  }
  assert.equal(shouldWatch({ platform: 'win32', interactive: true, policy: 'always', takeover: false }), false);
  assert.equal(shouldWatch({ platform: 'linux', interactive: false, policy: 'always', takeover: false }), false);
  assert.ok(watchCommand("中文 '记录", "C:\\示例 路径\\a'b.log").includes("a''b.log"));
});
