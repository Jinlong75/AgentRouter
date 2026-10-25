import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCode, createMapper, failureHint, READONLY_TOOLS } from '../../core/adapters/claude-code.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixtures = path.join(repo, 'tests', 'fixtures');
const expected = JSON.parse(readFileSync(path.join(fixtures, 'expected-claude-code-events.json'), 'utf8'));
const ROOT = 'D:\\demo\\repo';
const lines = name => { const all = readFileSync(path.join(fixtures, name), 'utf8').split('\n'); if (all.at(-1) === '') all.pop(); return all; };
const replay = name => {
  const mapper = createMapper(), events = [];
  lines(name).forEach((line, i) => { const ev = mapper(line, { root: ROOT }); if (ev.length) events.push({ line: i + 1, events: ev }); });
  return { lastResult: mapper.lastResult, events };
};

for (const name of ['claude-code-sample.jsonl', 'claude-code-extra.jsonl']) {
  // 样例里的文件路径是 Windows 写法（相对 D:\demo\repo 计算），只在 Windows 上比较。
  test(`${name} 逐行映射为期望的统一事件`, { skip: process.platform !== 'win32' }, () => assert.deepEqual(replay(name), expected[name]));
}

test('真实样例：命令开始与结束用同一个 id，结果文本作为汇报，文件路径相对项目根', () => {
  const all = expected['claude-code-sample.jsonl'].events.flatMap(x => x.events);
  const cmds = all.filter(e => e.kind === 'cmd');
  assert.deepEqual(cmds.map(c => c.phase), ['start', 'end']);
  assert.equal(cmds[0].id, cmds[1].id);
  assert.deepEqual(all.filter(e => e.kind === 'file').map(e => e.files[0]), [{ kind: 'add', path: 'hello.txt' }, { kind: 'update', path: 'hello.txt' }]);
  assert.equal(replay('claude-code-sample.jsonl').lastResult, '完成');
});

test('多条 result：汇报取最长的一条，一样长取靠后的', () => {
  const full = replay('claude-code-multi-result.jsonl').lastResult;
  assert.match(full, /^## 1\. 完成了什么/);
  assert.match(full, /## 3\. 验证/);
  const mapper = createMapper();
  for (const text of ['第一条', '第二条', '短']) mapper(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }), { root: ROOT });
  assert.equal(mapper.lastResult, '第二条');
  const err = createMapper()(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: '出错了' }), { root: ROOT });
  assert.ok(err.some(e => e.kind === 'error' && e.text === '出错了'));
});

test('样例匿名化：没有真实路径、用户名、真实 ID 或消息通道', () => {
  for (const name of ['claude-code-sample.jsonl', 'claude-code-extra.jsonl', 'claude-code-multi-result.jsonl']) {
    const text = readFileSync(path.join(fixtures, name), 'utf8');
    assert.doesNotMatch(text, /[A-Za-z]:\\\\Users\\\\|~1|AppData|cc-msg-|call_\d\d_/i, name);
  }
});

test('汇报：有 result 文本用它，没有用最后一条说话，都没有就不写', () => {
  assert.equal(claudeCode.finish({ lastSay: '说', result: '结果' }), '结果');
  assert.equal(claudeCode.finish({ lastSay: '说', result: null }), '说');
  assert.equal(claudeCode.finish({ lastSay: null, result: null }), null);
  assert.equal(claudeCode.writesReport, false);
});

test('隔离：按前缀清除主导的 Claude Code / Anthropic 变量，执行者有自己的配置目录', () => {
  const iso = claudeCode.isolate({ home: 'D:\\ar-home', profileName: 'deepseek' });
  for (const name of ['ANTHROPIC_API_KEY', 'anthropic_base_url', 'CLAUDECODE', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PID'])
    assert.ok(iso.clear.some(p => p.test(name)), name);
  for (const name of ['PATH', 'USERPROFILE', 'DEEPSEEK_API_KEY', 'MY_CLAUDECODE_NOTE']) assert.ok(!iso.clear.some(p => p.test(name)), name);
  assert.deepEqual(iso.set, { CLAUDE_CONFIG_DIR: path.join('D:\\ar-home', 'workers', 'deepseek', 'claude'), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
});

test('命令：写任务用 bypassPermissions；只读用 dontAsk + 工具白名单；最大轮数来自配置', () => {
  const detection = { launcher: { executable: 'C:\\x\\claude.exe', args: [] } };
  const write = claudeCode.command({ prompt: '任务', settings: {}, detection });
  assert.deepEqual(write, { executable: 'C:\\x\\claude.exe', args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'], stdin: '任务' });
  const ro = claudeCode.command({ prompt: '任务', settings: { maxTurns: 8 }, detection, readOnly: true });
  assert.deepEqual(ro.args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--tools', READONLY_TOOLS, '--allowedTools', READONLY_TOOLS, '--max-turns', '8']);
  assert.ok(!ro.args.includes('bypassPermissions'));
  for (const tool of ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task']) assert.ok(!READONLY_TOOLS.split(',').includes(tool), tool);
  assert.ok(!JSON.stringify(write).includes('任务') || write.stdin === '任务', '任务只经 stdin 传入');
});

test('失败提示通用：变量名与模型名从配置里取，不写死服务商', () => {
  const profile = { env: { ANTHROPIC_MODEL: 'example-model' }, secrets: { ANTHROPIC_AUTH_TOKEN: 'EXAMPLE_API_KEY' } };
  assert.equal(failureHint('API Error: 401 authentication_error', { profile }), '密钥无效或未设置：检查用户环境变量 EXAMPLE_API_KEY');
  assert.match(failureHint('API Error: 401', { profile: {} }), /没有可用的登录或密钥/);
  assert.equal(failureHint('402 Insufficient Balance', { profile }), '账户余额或额度不足');
  assert.equal(failureHint('404 model not found', { profile }), '模型名不对：检查执行者配置里的 ANTHROPIC_MODEL（当前 example-model）');
  assert.match(failureHint('429 Too Many Requests', { profile }), /限流/);
  assert.match(failureHint('getaddrinfo ENOTFOUND api.example.org', { profile }), /连不上模型服务/);
  assert.equal(failureHint('一切正常', { profile }), null);
  assert.equal(claudeCode.modelName({ profile }), 'example-model');
  assert.equal(claudeCode.modelName({ profile: {} }), null);
});

// O10 / D17：适配器、核心与软件代码里不出现具体服务商或模型名（预设模板 core/templates/agents 除外）。
test('核心与软件代码不写死服务商或模型名（预设模板除外）', () => {
  const files = [];
  const walk = dir => { for (const name of readdirSync(dir)) { const p = path.join(dir, name); if (statSync(p).isDirectory()) { if (p !== path.join(repo, 'core', 'templates', 'agents')) walk(p); } else if (/\.(mjs|ts|js)$/.test(name)) files.push(p); } };
  walk(path.join(repo, 'core')); walk(path.join(repo, 'app', 'src'));
  const bad = /deepseek|claude-(?:opus|sonnet|haiku)|gpt-\d|\bqwen|\bkimi\b/i;
  const hits = files.filter(f => !/shots/.test(f)).filter(f => bad.test(readFileSync(f, 'utf8'))).map(f => path.relative(repo, f));
  assert.deepEqual(hits, []);
});
