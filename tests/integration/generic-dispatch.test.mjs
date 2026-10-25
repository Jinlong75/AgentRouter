import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(project, 'core/ar.mjs');
const fixture = name => fileURLToPath(new URL(`../fixtures/generic/${name}`, import.meta.url));
const textCli = fixture('text-cli.mjs'), jsonlCli = fixture('jsonl-cli.mjs');
const jsonl = file => fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);

// jsonl-decl.json 里的 @SCRIPT@ 换成假 CLI 的路径，executable 换成 node 的绝对路径（不依赖 PATH）。
const jsonlDecl = () => {
  const text = fs.readFileSync(fixture('jsonl-decl.json'), 'utf8').replaceAll('@SCRIPT@', jsonlCli.replaceAll('\\', '\\\\'));
  return { ...JSON.parse(text), executable: process.execPath };
};
const textDecl = (extra = {}) => ({
  label: 'Text CLI', executable: process.execPath, detect: [textCli, '--version'], args: [textCli, 'run', '{promptFile}'], output: { format: 'text' },
  failureHints: [{ match: 'not logged in', text: '请先登录 Text CLI。' }], ...extra,
});

function setup(t, { generics, profiles }) {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'generic 派发测试 '));
  t.after(() => { assert.equal(path.dirname(base), path.resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const root = path.join(base, '示例 仓库'), home = path.join(base, '公共 配置');
  fs.mkdirSync(root); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: Object.keys(profiles)[0], profiles, generics, managed: false, watchWindow: 'never' }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_)/i.test(k)) delete env[k];
  Object.assign(env, { AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', USERPROFILE: base, HOME: base, APPDATA: base, AR_WORKTREE_ROOT: path.join(base, 'wt 根'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), CODEX_HOME: path.join(base, 'codex') });
  const ar = (args, overrides = {}) => spawnSync(process.execPath, [entry, ...args], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false });
  const dispatch = (name, profile, extra = []) => ar(['dispatch', '创建 a.txt 并汇报', '--name', name, '--profile', profile, ...extra]);
  const dir = name => path.join(root, '.agent-runs', name);
  const runs = () => { try { return jsonl(path.join(home, 'runs.jsonl')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return { base, root, home, ar, dispatch, dir, runs, env };
}

test('文本型：events 逐行 text，汇报是标准输出，{promptFile} 内容正确且任务结束后已删除', t => {
  const s = setup(t, { generics: { text: textDecl() }, profiles: { text: { adapter: 'generic', generic: 'text', label: 'Text CLI', enabled: true } } });
  const result = s.dispatch('文本 任务', 'text');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const events = jsonl(path.join(s.dir('文本 任务'), 'events.jsonl'));
  assert.ok(events.length >= 5 && events.every(e => e.kind === 'text'), '全是 text 事件');
  assert.deepEqual(events.map(e => e.text).slice(-1), ['OK']);
  const report = fs.readFileSync(path.join(s.dir('文本 任务'), 'report.md'), 'utf8');
  assert.equal(report, events.map(e => e.text).join('\n') + '\n', '汇报是标准输出全文');
  assert.match(report, /^来源：文件 .+\nBOM：false\n> /, '指令来自 {promptFile}，无 BOM');
  assert.match(report, /> 创建 a\.txt 并汇报/, '指令内容原样送达');
  const promptFile = report.match(/^来源：文件 (.+)$/m)[1];
  assert.ok(path.basename(promptFile).startsWith('ar-prompt-'));
  assert.equal(fs.existsSync(promptFile), false, '任务结束后临时文件已删除');
  const start = s.runs().find(r => r.event === 'start');
  assert.equal(start.adapter, 'generic'); assert.equal(start.profile, 'text'); assert.equal(start.agentVersion, 'text-cli 1.2.3');
  assert.equal(s.runs().find(r => r.event === 'end').exit, 0);
  const progress = fs.readFileSync(path.join(s.dir('文本 任务'), 'progress.log'), 'utf8');
  assert.match(progress, /=== Text CLI 结束：exit=0/);
});

test('JSONL 型：say / think / cmd / turn / plan / file / tool 事件，汇报是最后一句话，progress.log 有对应的行', t => {
  const s = setup(t, { generics: { jl: jsonlDecl() }, profiles: { jl: { adapter: 'generic', generic: 'jl', label: 'JSONL CLI', enabled: true, model: 'demo-model' } } });
  const result = s.dispatch('json 任务', 'jl');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const events = jsonl(path.join(s.dir('json 任务'), 'events.jsonl'));
  assert.deepEqual(events.map(e => e.kind), ['say', 'think', 'cmd', 'cmd', 'turn', 'plan', 'file', 'tool', 'text', 'say']);
  assert.deepEqual(events[2].phase, 'start'); assert.deepEqual(events[3].phase, 'end');
  assert.equal(events[3].exit, 0); assert.equal(events[3].output, '?? src/a.txt');
  assert.deepEqual(events[4].usage, { input: 120, output: 30 });
  assert.deepEqual(events[5].items, [{ text: '写文件', done: true }, { text: '汇报', done: false }]);
  assert.deepEqual(events[6].files, [{ kind: 'add', path: 'src/a.txt' }]);
  assert.equal(events[7].detail, '{"q":"x"}');
  assert.equal(events[8].text, 'this line is not json', '非 JSON 行变成 text，不认识的 JSON 被丢弃');
  assert.equal(fs.readFileSync(path.join(s.dir('json 任务'), 'report.md'), 'utf8'), '完成', '汇报是最后一句 say');
  const raw = fs.readFileSync(path.join(s.dir('json 任务'), 'raw.log'), 'utf8').trimEnd().split('\n');
  assert.equal(raw.length, 11, 'raw.log 原样保存每一行（含被丢弃的）');
  assert.ok(raw.some(line => line.includes('mystery')) && raw.includes('this line is not json'));
  const progress = fs.readFileSync(path.join(s.dir('json 任务'), 'progress.log'), 'utf8');
  for (const line of ['说：开始处理', '运行：git status --short', '新增文件：src/a.txt', '一轮结束（输入 120，输出 30 tokens）', '说：完成', '=== JSONL CLI 结束：exit=0'])
    assert.ok(progress.includes(line), `进度缺少：${line}`);
  const start = s.runs().find(r => r.event === 'start');
  assert.equal(start.agentVersion, 'jsonl-cli 0.9.0'); assert.equal(start.model, 'demo-model');
});

test('声明引用不存在 / 声明不合法：不启动程序，退出码 1，中文原因（前 3 条错误带路径），不重试', t => {
  const bad = { label: 'Bad CLI', executable: process.execPath, args: ['run'], output: { format: 'xml' }, extra: 1, timeoutMin: 0 };
  const s = setup(t, { generics: { bad }, profiles: {
    gone: { adapter: 'generic', generic: 'nowhere', label: '没有声明', enabled: true },
    bad: { adapter: 'generic', generic: 'bad', label: 'Bad CLI', enabled: true },
    nogeneric: { adapter: 'generic', label: '没写 generic', enabled: true },
  } });
  const gone = s.dispatch('缺声明', 'gone');
  assert.equal(gone.status, 1, gone.stdout + gone.stderr);
  assert.match(fs.readFileSync(path.join(s.dir('缺声明'), 'progress.log'), 'utf8'), /出错：启动 没有声明 失败：找不到通用适配器声明：config\.json 的 generics\.nowhere/);
  const invalid = s.dispatch('坏声明', 'bad');
  assert.equal(invalid.status, 1);
  const progress = fs.readFileSync(path.join(s.dir('坏声明'), 'progress.log'), 'utf8');
  assert.match(progress, /启动 Bad CLI 失败：通用适配器声明不合法：/);
  assert.equal(progress.split('\n').filter(line => /出错：generics\.bad\.\w+/.test(line)).length, 3, '前 3 条错误各一行，带路径');
  assert.match(progress, /出错：（另有 \d+ 条错误）/, '只列前 3 条');
  const noField = s.dispatch('缺字段', 'nogeneric');
  assert.equal(noField.status, 1);
  assert.match(fs.readFileSync(path.join(s.dir('缺字段'), 'progress.log'), 'utf8'), /缺少 generic 字段/);
  for (const name of ['缺声明', '坏声明', '缺字段']) assert.ok(!fs.existsSync(path.join(s.dir(name), 'attempts', '2')), '启动失败不重试');
  const events = s.runs().map(r => r.event);
  assert.equal(events.filter(e => e === 'spawned').length, 0, '一个程序都没有启动');
  assert.equal(events.filter(e => e === 'end').length, 3);
});

test('执行者失败：退出码传递，stderr 进出错事件，failureHints 的提示进进度；失败后手动重试走同一条解析路径', t => {
  const decl = textDecl({ args: [textCli, 'run', '--fail', '{promptFile}'] });
  const s = setup(t, { generics: { text: decl }, profiles: { text: { adapter: 'generic', generic: 'text', label: 'Text CLI', enabled: true } } });
  const result = s.dispatch('失败 任务', 'text');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const progress = () => fs.readFileSync(path.join(s.dir('失败 任务'), 'progress.log'), 'utf8');
  assert.match(progress(), /出错：not logged in/);
  assert.match(progress(), /出错：请先登录 Text CLI。/);
  assert.match(result.stdout, /出错：请先登录 Text CLI。/);
  const retry = s.ar(['retry', '失败 任务']);
  assert.equal(retry.status, 1, retry.stdout + retry.stderr);
  assert.equal(progress().match(/出错：请先登录 Text CLI。/g).length, 2, '重试同样用声明里的提示');
  assert.ok(s.runs().some(r => r.event === 'resume'), '重试写 resume');
  assert.equal(s.runs().filter(r => r.event === 'spawned').length, 2);
});

test('--detach：声明随请求快照带给执行者进程，执行者进程不再读配置也能完成', async t => {
  const s = setup(t, { generics: { text: textDecl() }, profiles: { text: { adapter: 'generic', generic: 'text', label: 'Text CLI', enabled: true } } });
  const result = s.dispatch('脱离 任务', 'text', ['--detach', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const id = JSON.parse(result.stdout).id;
  const deadline = Date.now() + 20000;
  let end;
  while (!end && Date.now() < deadline) { end = s.runs().find(r => r.event === 'end' && r.id === id); if (!end) await delay(50); }
  assert.ok(end, '脱离的执行者进程应当结束任务');
  assert.equal(end.exit, 0);
  assert.match(fs.readFileSync(path.join(s.dir('脱离 任务'), 'report.md'), 'utf8'), /\nOK\n$/);
  // 请求文件在执行者进程认领后改名保留：里面带着声明快照，而且不含密钥。
  const request = ['.claimed.json', '.running.json'].map(suffix => path.join(s.home, 'managed', `${id}${suffix}`)).find(file => fs.existsSync(file));
  assert.ok(request, '请求文件保留在 managed 目录');
  const body = JSON.parse(fs.readFileSync(request, 'utf8'));
  assert.equal(body.adapter, 'generic');
  assert.equal(body.profileConfig.generic, 'text');
  assert.equal(body.profileConfig.genericDecl.label, 'Text CLI');
});
