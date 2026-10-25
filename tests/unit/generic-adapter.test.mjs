import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGeneric, brokenGeneric } from '../../core/adapters/generic.mjs';
import { adapterFor, resolveProfile, genericDeclaration } from '../../core/adapters/index.mjs';
import { profileConfig } from '../../core/lib/run.mjs';
import { validRequest } from '../../core/lib/managed.mjs';
import { buildEnv, authOf } from '../../core/lib/env.mjs';
import { supportsReadOnly } from '../../core/lib/router.mjs';

const fixture = name => fileURLToPath(new URL(`../fixtures/generic/${name}`, import.meta.url));
const root = path.join(os.tmpdir(), 'ar-generic-root');
const report = path.join(root, 'report.md');
// 可执行文件用 node 的绝对路径（不依赖 PATH）；模板里的 @SCRIPT@ 换成假 CLI 的路径。
const decl = (extra = {}) => ({ label: 'Demo CLI', executable: process.execPath, args: ['run', '{prompt}'], output: { format: 'text' }, ...extra });
const command = (d, input = {}) => makeGeneric(d).command({ root, report, prompt: '任务：创建 a.txt', env: process.env, settings: {}, profile: {}, ...input });
const cleanTemp = (t, result) => t.after(() => { for (const file of result.cleanup ?? []) fs.rmSync(file, { force: true }); });

test('占位符：prompt / worktree / report / model / effort 原样替换，一项里可以有多个', t => {
  const result = command(decl({ args: ['run', '-C', '{worktree}', '--out={report}', '--cfg={model}:{effort}', '{prompt}'] }), { settings: { model: 'm1', effort: 'high' } });
  cleanTemp(t, result);
  assert.equal(result.executable, process.execPath);
  assert.deepEqual(result.args, ['run', '-C', root, `--out=${report}`, '--cfg=m1:high', '任务：创建 a.txt']);
  assert.equal(result.stdin, undefined, '没有 stdin 模板就不写标准输入');
  assert.deepEqual(result.cleanup, []);
});

test('model / effort 取自 settings，没有时取执行者配置（profile）', t => {
  const d = decl({ args: ['--model', '{model}', '--effort', '{effort}', '{prompt}'] });
  const fromProfile = command(d, { profile: { model: 'pm', effort: 'low' } });
  assert.deepEqual(fromProfile.args.slice(0, 4), ['--model', 'pm', '--effort', 'low']);
  const override = command(d, { settings: { model: 'sm' }, profile: { model: 'pm', effort: 'low' } });
  assert.deepEqual(override.args.slice(0, 4), ['--model', 'sm', '--effort', 'low']);
  cleanTemp(t, fromProfile);
});

test('{model} 没设置：含它的那项去掉，前面紧挨的 --model / -m 一起去掉；前面不是选项就只去那一项', () => {
  const run = (args, settings = {}) => command(decl({ args }), { settings }).args;
  assert.deepEqual(run(['run', '--model', '{model}', '{prompt}']), ['run', '任务：创建 a.txt']);
  assert.deepEqual(run(['run', '-m', '{model}', '{prompt}']), ['run', '任务：创建 a.txt']);
  assert.deepEqual(run(['run', '--model={model}', '{prompt}']), ['run', '任务：创建 a.txt'], '写成一项的选项整项去掉');
  assert.deepEqual(run(['run', '--keep', '--model', '{model}', '{prompt}']), ['run', '--keep', '任务：创建 a.txt'], '更前面的选项不动');
  assert.deepEqual(run(['run', '{model}', '{prompt}']), ['run', '任务：创建 a.txt'], '前面是普通参数不去');
  assert.deepEqual(run(['run', '--model', '{model}', '{prompt}'], { model: '' }), ['run', '任务：创建 a.txt'], '空字符串也算没设置');
  assert.deepEqual(run(['run', '--model', '{model}', '{prompt}'], { model: 'x' }), ['run', '--model', 'x', '任务：创建 a.txt']);
});

test('{effort}：替换与去除（规则同 {model}）', () => {
  const d = decl({ args: ['run', '--effort', '{effort}', '--tag=e-{effort}', '{prompt}'] });
  assert.deepEqual(command(d, { settings: { effort: 'high' } }).args, ['run', '--effort', 'high', '--tag=e-high', '任务：创建 a.txt']);
  assert.deepEqual(command(d).args, ['run', '任务：创建 a.txt']);
  assert.deepEqual(command(d, { settings: { model: 'm' } }).args, ['run', '任务：创建 a.txt']);
});

test('{promptFile}：内容等于指令、UTF-8 无 BOM、路径出现在参数和 cleanup 里，只有用到才写', t => {
  const result = command(decl({ args: ['run', '{promptFile}'] }));
  cleanTemp(t, result);
  assert.equal(result.cleanup.length, 1);
  const file = result.args[1];
  assert.equal(file, result.cleanup[0]);
  assert.ok(path.resolve(file).startsWith(path.resolve(os.tmpdir())), '写在系统临时目录');
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString('utf8'), '任务：创建 a.txt');
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], '无 BOM');
  const other = command(decl());
  assert.deepEqual(other.cleanup, [], '模板里没用到就不写文件');
});

test('{promptFile} 也可以出现在 stdin 模板里；stdin 做同样的占位符替换', t => {
  const result = command(decl({ args: ['run'], stdin: 'read:{promptFile}|{prompt}|{model}' }), { settings: { model: 'z' } });
  cleanTemp(t, result);
  assert.equal(result.cleanup.length, 1);
  assert.equal(result.stdin, `read:${result.cleanup[0]}|任务：创建 a.txt|z`);
  const plain = command(decl({ args: ['run'], stdin: '{prompt}' }));
  assert.equal(plain.stdin, '任务：创建 a.txt');
  assert.deepEqual(plain.args, ['run']);
});

test('不支持只读：没有 readOnlyArgs 时 readOnly 任务报错；有则用它，capabilities.readOnly 跟随', () => {
  assert.throws(() => command(decl(), { readOnly: true }), /Demo CLI 不支持只读任务/);
  const ro = decl({ readOnlyArgs: ['run', '--read-only', '{prompt}'] });
  assert.deepEqual(command(ro, { readOnly: true }).args, ['run', '--read-only', '任务：创建 a.txt']);
  assert.deepEqual(command(ro).args, ['run', '任务：创建 a.txt']);
  assert.equal(makeGeneric(ro).capabilities.readOnly, true);
  assert.equal(makeGeneric(decl()).capabilities.readOnly, false);
});

test('参数过长：{prompt} 作参数且总长超过 28000 字符报错；用 promptFile 或 stdin 不受限', t => {
  const long = 'x'.repeat(30000);
  assert.throws(() => command(decl(), { prompt: long }), /^Error: 任务指令太长，无法通过命令行参数传递，请改用 stdin 或 \{promptFile\}$/);
  assert.equal(command(decl(), { prompt: 'x'.repeat(27000) }).args[1].length, 27000);
  const file = command(decl({ args: ['run', '{promptFile}'] }), { prompt: long });
  cleanTemp(t, file);
  assert.equal(fs.readFileSync(file.cleanup[0], 'utf8').length, 30000);
  assert.equal(command(decl({ args: ['run'], stdin: '{prompt}' }), { prompt: long }).stdin.length, 30000);
});

test('出错时不留临时文件：先校验后写文件', () => {
  const before = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('ar-prompt-')).length;
  assert.throws(() => command(decl({ args: ['{promptFile}', '{prompt}'] }), { prompt: 'x'.repeat(30000) }), /任务指令太长/);
  assert.equal(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('ar-prompt-')).length, before);
});

// ---- .cmd / .bat ----
function batchDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-generic-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('.cmd 不是 npm 包装：{prompt} 报错；其他情况经 cmd.exe，每个参数加引号，spawn 用 verbatim', t => {
  const dir = batchDir(t);
  const file = path.join(dir, '带 空格.cmd');
  fs.writeFileSync(file, '@echo off\r\necho hi\r\n');
  const d = decl({ executable: file });
  assert.throws(() => command(d), /^Error: Demo CLI 是批处理程序，任务文字不能通过参数传递，请改用 stdin 或 \{promptFile\}$/);
  const result = command(decl({ executable: file, args: ['run', '--out', '{report}', '{promptFile}'] }), { env: { ...process.env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
  cleanTemp(t, result);
  assert.equal(result.executable, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(result.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(result.verbatim, true);
  assert.equal(result.args.length, 4);
  assert.equal(result.args[3], `"${[file, 'run', '--out', report, result.cleanup[0]].map(a => `"${a}"`).join(' ')}"`);
  const viaStdin = command(decl({ executable: file, args: ['run'], stdin: '{prompt}' }));
  assert.equal(viaStdin.stdin, '任务：创建 a.txt');
});

test('.cmd：参数里有双引号、百分号、换行时拒绝（无法安全转义）；以反斜杠结尾的参数加倍', t => {
  const dir = batchDir(t);
  const file = path.join(dir, 'tool.bat');
  fs.writeFileSync(file, '@echo off\r\n');
  const d = args => decl({ executable: file, args, stdin: '{prompt}' });
  assert.throws(() => command(d(['a"b'])), /无法安全传递/);
  assert.throws(() => command(d(['100%'])), /无法安全传递/);
  assert.throws(() => command(d(['{worktree}']), { root: 'C:\\x\\%PATH%' }), /无法安全传递/);
  const slash = command(d(['{worktree}']), { root: 'C:\\工作 目录\\' });
  assert.ok(slash.args[3].includes('"C:\\工作 目录\\\\"'), slash.args[3]);
});

test('.cmd 是 npm 的包装：解析成 Node 入口直接运行，不经过 cmd.exe，{prompt} 照常可用', t => {
  const dir = batchDir(t);
  fs.writeFileSync(path.join(dir, 'entry.js'), '// 入口\n');
  const file = path.join(dir, 'npmtool.cmd');
  fs.writeFileSync(file, '@ECHO off\r\nendLocal & "%_prog%"  "%dp0%\\entry.js" %*\r\n');
  const result = command(decl({ executable: file }));
  assert.equal(result.executable, process.execPath);
  assert.deepEqual(result.args, [path.join(dir, 'entry.js'), 'run', '任务：创建 a.txt']);
  assert.equal(result.verbatim, undefined);
});

test('找不到程序：中文说明，带 executable', () => {
  assert.throws(() => command(decl({ executable: 'definitely-not-installed-cli-7q' }), { env: { PATH: os.tmpdir() } }), /找不到 Demo CLI 的程序：definitely-not-installed-cli-7q/);
  assert.throws(() => command(decl({ executable: path.join(os.tmpdir(), '不存在的程序.exe') })), /找不到 Demo CLI 的程序/);
});

test('.mjs 脚本作 executable：用 Node 运行它', () => {
  const result = command(decl({ executable: fixture('text-cli.mjs'), args: ['run', '{prompt}'] }));
  assert.equal(result.executable, process.execPath);
  assert.deepEqual(result.args, [fixture('text-cli.mjs'), 'run', '任务：创建 a.txt']);
});

// ---- detect ----
test('detect：运行 detect 参数（默认 --version），退出码 0 为已安装，第一行输出是版本', () => {
  const adapter = makeGeneric(decl({ executable: process.execPath, detect: [fixture('text-cli.mjs'), '--version'] }));
  assert.deepEqual({ ...adapter.detect({ env: process.env }), launcher: undefined }, { installed: true, version: 'text-cli 1.2.3', launcher: undefined });
  const byDefault = makeGeneric(decl({ executable: fixture('text-cli.mjs') })).detect({ env: process.env });
  assert.equal(byDefault.installed, true, '默认 detect 是 --version');
  assert.equal(byDefault.version, 'text-cli 1.2.3');
  const failing = makeGeneric(decl({ executable: process.execPath, detect: [fixture('text-cli.mjs'), '--fail'] })).detect({ env: process.env });
  assert.equal(failing.installed, false);
  assert.equal(failing.version, null);
  const missing = makeGeneric(decl({ executable: 'definitely-not-installed-cli-7q' })).detect({ env: { PATH: os.tmpdir() } });
  assert.equal(missing.installed, false);
  assert.match(missing.error, /找不到 Demo CLI 的程序/);
});

test('登录状态：声明里没有登录检测，永远是 unknown', () => {
  assert.equal(makeGeneric(decl()).loginStatus(), 'unknown');
  assert.equal(brokenGeneric({}, '原因').loginStatus(), 'unknown');
});

// ---- failureHint / modelName ----
test('failureHint：按声明顺序，第一个匹配（不分大小写）的返回它的 text；都不匹配为 null', () => {
  const adapter = makeGeneric(decl({ failureHints: [{ match: 'not logged in', text: '请先登录。' }, { match: 'logged', text: '第二条' }, { match: '^limit \\d+$', text: '限流' }] }));
  assert.equal(adapter.failureHint('Error: NOT LOGGED IN'), '请先登录。');
  assert.equal(adapter.failureHint('already logged'), '第二条');
  assert.equal(adapter.failureHint('LIMIT 5'), '限流');
  assert.equal(adapter.failureHint('其他错误'), null);
  assert.equal(makeGeneric(decl()).failureHint('anything'), null);
  assert.equal(adapter.failureHint(undefined), null);
});

test('modelName：执行者配置的 model，没有为 null', () => {
  const adapter = makeGeneric(decl());
  assert.equal(adapter.modelName({ profile: { model: 'm1' } }), 'm1');
  assert.equal(adapter.modelName({ profile: {} }), null);
  assert.equal(adapter.modelName(), null);
});

// ---- finish / 汇报来源 ----
test('finish：stdout 取标准输出全文，lastSay 取最后一句说话，file 由执行者自己写文件', () => {
  const input = { lastSay: '最后一句', result: '结果行', stdoutText: '行1\n行2\n' };
  const stdout = makeGeneric(decl({ report: 'stdout' }));
  assert.equal(stdout.finish(input), '行1\n行2\n');
  assert.equal(stdout.finish({ lastSay: 'x', stdoutText: '' }), null, '没有标准输出就没有汇报');
  assert.equal(stdout.keepStdout, true);
  assert.equal(stdout.writesReport, false);
  const lastSay = makeGeneric(decl({ report: 'lastSay' }));
  assert.equal(lastSay.finish(input), '最后一句');
  assert.equal(lastSay.finish({}), null);
  assert.equal(lastSay.keepStdout, false);
  const file = makeGeneric(decl({ report: 'file', args: ['run', '--out', '{report}', '{prompt}'] }));
  assert.equal(file.writesReport, true, '沿用 writesReport：核心不再写汇报');
  assert.equal(file.capabilities.reportFile, true);
});

test('finish 默认：text 格式默认 stdout，jsonl 默认 lastSay，stream-json 默认 lastSay 且先取 result', () => {
  const input = { lastSay: '最后一句', result: '结果行', stdoutText: '全文\n' };
  const text = makeGeneric(decl());
  assert.equal(text.finish(input), '全文\n');
  assert.equal(text.keepStdout, true);
  const jsonl = makeGeneric(decl({ output: { format: 'jsonl', map: [{ kind: 'say', text: 'm' }] } }));
  assert.equal(jsonl.finish(input), '最后一句');
  assert.equal(jsonl.keepStdout, false);
  const stream = makeGeneric(decl({ output: { format: 'stream-json' } }));
  assert.equal(stream.finish(input), '结果行');
  assert.equal(stream.finish({ lastSay: '最后一句', result: null }), '最后一句', '没有 result 时取最后一句话');
  assert.equal(stream.finish({}), null);
});

// ---- stream-json ----
test('stream-json：回放 Qoder 样例得到 tool(init) / think / say / turn，汇报取 result', () => {
  const adapter = makeGeneric(decl({ output: { format: 'stream-json' } }));
  const map = adapter.createMapper();
  const events = fs.readFileSync(fixture('qoder-stream.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap(line => map(line, { root }));
  assert.deepEqual(events.map(e => e.kind), ['tool', 'think', 'say', 'turn']);
  assert.deepEqual(events[0], { kind: 'tool', name: 'init', detail: 'example-model' });
  assert.deepEqual(events[1], { kind: 'think', text: '用户要求只回复 OK。' });
  assert.deepEqual(events[2], { kind: 'say', text: 'OK' });
  assert.deepEqual(events[3], { kind: 'turn', usage: { input: 0, output: 0 } });
  assert.equal(map.lastResult, 'OK');
  assert.equal(adapter.finish({ lastSay: 'OK', result: map.lastResult }), 'OK');
  assert.notEqual(adapter.createMapper(), map, '每次尝试新建映射');
});

// ---- 注册表 / 声明解析 ----
test('adapterFor：generic 按 config.generics 里的声明现做适配器，其他适配器不变', () => {
  const config = { generics: { demo: decl({ label: '示例' }) } };
  const profile = { adapter: 'generic', generic: 'demo', label: 'My Demo' };
  const adapter = adapterFor(profile, { config });
  assert.equal(adapter.id, 'generic');
  assert.equal(adapter.label, '示例');
  assert.equal(adapter.declarationName, 'demo');
  assert.equal(adapterFor({ adapter: 'fake' }).id, 'fake');
});

test('adapterFor：声明不存在 / 缺 generic 字段 / 不合法时抛中文原因（前 3 条错误，带路径）；tolerant 时换成必然失败的适配器', () => {
  const config = { generics: { bad: { label: '', executable: 7, args: 'x', output: { format: 'xml' }, extra: 1 } } };
  assert.throws(() => adapterFor({ adapter: 'generic', generic: 'nope' }, { config }), /^Error: 找不到通用适配器声明：config\.json 的 generics\.nope$/);
  assert.throws(() => adapterFor({ adapter: 'generic' }, { config }), /缺少 generic 字段/);
  assert.throws(() => adapterFor({ adapter: 'generic', generic: 'x' }), /找不到通用适配器声明/, '没有 config');
  let message = '';
  try { adapterFor({ adapter: 'generic', generic: 'bad' }, { config }); } catch (error) { message = error.message; }
  assert.match(message, /^通用适配器声明不合法：\n/);
  const lines = message.split('\n').slice(1);
  assert.equal(lines.length, 4, '前 3 条错误加一行“另有 N 条”');
  assert.ok(lines.slice(0, 3).every(line => line.startsWith('generics.bad')), lines.join('\n'));
  assert.match(lines[3], /^（另有 \d+ 条错误）$/);
  const broken = adapterFor({ adapter: 'generic', generic: 'nope', label: '我的 CLI' }, { config, tolerant: true });
  assert.equal(broken.label, '我的 CLI');
  assert.throws(() => broken.command({}), /找不到通用适配器声明/);
  assert.equal(broken.detect().installed, false);
  assert.throws(() => adapterFor({ adapter: 'qoder' }, { config, tolerant: true }), /不支持的执行者类型：qoder/, '未知类型仍然抛错');
});

test('resolveProfile：声明解析进执行者配置——genericDecl、env 默认值、secrets（执行者配置自己写了就以它为准）', () => {
  const d = decl({ env: { MODE: 'batch', LANG_X: 'a' }, secrets: { DEMO_API_KEY: 'DEMO_SOURCE' } });
  const config = { generics: { demo: d } };
  const plain = { adapter: 'generic', generic: 'demo', env: { LANG_X: 'override' } };
  const resolved = resolveProfile(plain, config);
  assert.deepEqual(resolved.genericDecl, d);
  assert.deepEqual(resolved.env, { MODE: 'batch', LANG_X: 'override' }, '执行者配置的 env 覆盖声明的');
  assert.deepEqual(resolved.secrets, { DEMO_API_KEY: 'DEMO_SOURCE' }, '只写在声明里也注入');
  assert.equal(authOf(resolved), 'token');
  const own = resolveProfile({ ...plain, secrets: { OTHER_KEY: 'OTHER_SOURCE' } }, config);
  assert.deepEqual(own.secrets, { OTHER_KEY: 'OTHER_SOURCE' }, '执行者配置自己写了 secrets 时以它为准');
  assert.equal(resolveProfile(resolved, {}), resolved, '已解析的不重做');
  const fake = { adapter: 'fake' };
  assert.equal(resolveProfile(fake, config), fake);
  const missing = resolveProfile({ adapter: 'generic', generic: 'nope' }, config);
  assert.match(missing.genericError, /找不到通用适配器声明/);
  assert.throws(() => adapterFor(missing), /找不到通用适配器声明/);
  // 走现有 buildEnv：声明的密钥从来源变量注入，来源变量名本身不传。
  const env = buildEnv({ base: { PATH: 'p', DEMO_SOURCE: 'sk-test-demo' }, profile: resolved, adapter: adapterFor(resolved), resolve: name => name === 'DEMO_SOURCE' ? 'sk-test-demo' : undefined });
  assert.equal(env.DEMO_API_KEY, 'sk-test-demo');
  assert.equal(env.MODE, 'batch');
  assert.ok(!('DEMO_SOURCE' in env));
});

test('托管 / 脱离请求的执行者配置快照带上声明，请求校验接受它；声明不合法的请求被拒绝', () => {
  const config = { generics: { demo: decl({ env: { MODE: 'batch' } }) } };
  const resolved = resolveProfile({ adapter: 'generic', generic: 'demo', label: 'Demo' }, config);
  const adapter = adapterFor(resolved);
  const snapshot = profileConfig(resolved, adapter);
  assert.equal(snapshot.generic, 'demo');
  assert.deepEqual(snapshot.genericDecl, config.generics.demo);
  assert.equal(snapshot.adapter, 'generic');
  const request = { v: 1, id: 'id-1', at: 1, script: path.resolve('ar.mjs'), node: process.execPath, repo: path.resolve('repo'), name: 'n',
    args: { task: 't', extra: '', role: null, spec: null }, settings: { model: null, effort: null, tier: null, path: null, sandbox: 'workspace-write' },
    dispatcher: { host: 'unknown', session: null }, env: {}, profile: 'demo', adapter: 'generic' };
  assert.equal(validRequest({ ...request, profileConfig: snapshot }), true);
  assert.equal(validRequest({ ...request, profileConfig: { ...snapshot, genericDecl: { label: 'x' } } }), false);
  assert.equal(validRequest({ ...request, profileConfig: { ...snapshot, genericDecl: [] } }), false);
  // 执行者进程按快照重建 profile，不再读配置，仍能做出同一个适配器。
  const rebuilt = adapterFor({ adapter: 'generic', ...snapshot });
  assert.equal(rebuilt.label, adapter.label);
  // 解析失败的原因也随快照走，执行者进程里 command 同样失败。
  const failed = profileConfig(resolveProfile({ adapter: 'generic', generic: 'nope' }, config), adapterFor({ adapter: 'generic', generic: 'nope' }, { config, tolerant: true }));
  assert.match(failed.genericError, /找不到通用适配器声明/);
  assert.equal(validRequest({ ...request, profileConfig: failed }), true);
  assert.throws(() => adapterFor({ adapter: 'generic', ...failed }, { tolerant: true }).command({}), /找不到通用适配器声明/);
});

test('路由：generic 是否支持只读以 makeGeneric(声明).capabilities.readOnly 为准（含派发时解析好的 genericDecl）', () => {
  const ro = decl({ readOnlyArgs: ['run', '{prompt}'] });
  assert.equal(supportsReadOnly({ adapter: 'generic', generic: 'ro' }, { generics: { ro } }), true);
  assert.equal(supportsReadOnly({ adapter: 'generic', generic: 'plain' }, { generics: { plain: decl() } }), false);
  assert.equal(supportsReadOnly({ adapter: 'generic', generic: 'ro', genericDecl: ro }, {}), true);
});

// ---- runner：cleanup、标准输出全文、profileName ----
async function runWith(t, adapter, { stopped = () => false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-generic-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { runOnce } = await import('../../core/lib/runner.mjs');
  const events = [], progress = [], registry = [];
  const paths = { raw: path.join(dir, 'raw.log'), report: path.join(dir, 'report.md') };
  const result = await runOnce({
    adapter, label: 'Runner CLI', profile: { x: 1 }, profileName: 'my-name', settings: {}, detection: null, workdir: dir, childEnv: process.env, paths,
    registry: row => registry.push(row), id: 'r1', prompt: 'p', envError: null, emit: event => events.push(event), errors: [], mapLine: Object.assign(adapter.createMapper(), {}),
    onSpawn: () => {}, beforeSpawn: null, stopped, progress: text => progress.push(text),
  });
  return { result, events, progress, registry, dir };
}

test('runner：命令返回的 cleanup 文件在进程结束后删除；profileName 传给 command；保留标准输出全文（keepStdout）', async t => {
  const temp = path.join(os.tmpdir(), `ar-prompt-test-${process.pid}.txt`);
  fs.writeFileSync(temp, 'x');
  let seen = null;
  const adapter = { ...makeGeneric(decl()), command(input) { seen = input; return { executable: process.execPath, args: ['-e', 'console.log("甲");console.log("乙")'], cleanup: [temp] }; } };
  const { result } = await runWith(t, adapter);
  assert.equal(seen.profileName, 'my-name');
  assert.equal(result.exit, 0);
  assert.equal(result.stdoutText, '甲\n乙\n');
  assert.equal(fs.existsSync(temp), false, 'cleanup 文件已删除');
});

test('runner：失败（非 0 退出、启动失败）和被停止时也删除 cleanup 文件；其他适配器没有 stdoutText', async t => {
  const make = (args, extra = {}) => {
    const temp = path.join(os.tmpdir(), `ar-prompt-test-${process.pid}-${Math.random().toString(16).slice(2)}.txt`);
    fs.writeFileSync(temp, 'x');
    return { temp, adapter: { ...makeGeneric(decl({ report: 'lastSay' })), command: () => ({ executable: process.execPath, args, cleanup: [temp] }), ...extra } };
  };
  const failing = make(['-e', 'process.exit(3)']);
  const failed = await runWith(t, failing.adapter);
  assert.equal(failed.result.exit, 3);
  assert.equal(failed.result.stdoutText, null, '汇报不取标准输出的适配器不保留它');
  assert.equal(fs.existsSync(failing.temp), false);
  const missing = make([]);
  missing.adapter.command = () => ({ executable: path.join(os.tmpdir(), '不存在的程序.exe'), args: [], cleanup: [missing.temp] });
  const notStarted = await runWith(t, missing.adapter);
  assert.equal(notStarted.result.startFailed, true);
  assert.equal(fs.existsSync(missing.temp), false);
  const stoppedRun = make(['-e', 'console.log(1)']);
  await runWith(t, stoppedRun.adapter, { stopped: () => true });
  assert.equal(fs.existsSync(stoppedRun.temp), false, '被停止的尝试也删');
});

test('runner：标准输出全文最多保留 256KB；多行的启动失败原因逐行成出错事件', async t => {
  const adapter = { ...makeGeneric(decl()), command: () => ({ executable: process.execPath, args: ['-e', 'for (let i = 0; i < 20000; i++) console.log("x".repeat(60))'], cleanup: [] }) };
  const { result } = await runWith(t, adapter);
  assert.equal(result.stdoutText.length, 256 * 1024);
  const bad = { ...makeGeneric(decl()), command() { throw new Error('头一行\n第二行\n第三行'); } };
  const { events, result: failed } = await runWith(t, bad);
  assert.equal(failed.startFailed, true);
  assert.deepEqual(events.map(e => e.text), ['启动 Runner CLI 失败：头一行', '第二行', '第三行']);
});

test('ar agents list：generic 执行者显示检测结果、版本、login 状态（无法确定）；声明有问题的显示未安装', async t => {
  const { listAgents } = await import('../../core/lib/agents.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-generic-list-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const good = decl({ label: 'Text CLI', detect: [fixture('text-cli.mjs'), '--version'] });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'good', generics: { good }, profiles: {
    good: { adapter: 'generic', generic: 'good', label: '好的', model: 'm1', enabled: true },
    gone: { adapter: 'generic', generic: 'gone', enabled: true },
    token: { adapter: 'generic', generic: 'good', auth: 'token', secrets: { DEMO_API_KEY: 'DEMO_SOURCE' }, enabled: true },
  } }));
  const rows = Object.fromEntries(listAgents(home, { env: process.env, detect: true }).map(row => [row.name, row]));
  assert.deepEqual([rows.good.supported, rows.good.installed, rows.good.version, rows.good.login, rows.good.model, rows.good.label], [true, true, 'text-cli 1.2.3', 'unknown', 'm1', '好的']);
  assert.deepEqual([rows.gone.supported, rows.gone.installed, rows.gone.version, rows.gone.login], [true, false, null, 'unknown']);
  assert.equal(rows.token.login, null, 'token 认证不显示登录状态');
  const quick = Object.fromEntries(listAgents(home, { env: process.env }).map(row => [row.name, row]));
  assert.equal(quick.good.login, 'unknown');
  assert.equal(quick.good.installed, undefined, '不带 --detect 时不检测');
});

test('genericDeclaration：来源优先级——已解析的 genericDecl，其次内嵌声明，最后 config.generics', () => {
  const a = decl({ label: 'A' }), b = decl({ label: 'B' }), c = decl({ label: 'C' });
  const profile = { adapter: 'generic', generic: 'x', genericDecl: a };
  assert.equal(genericDeclaration(profile, { generics: { x: c } }).decl.label, 'A');
  assert.equal(genericDeclaration({ adapter: 'generic', generic: b }, {}).decl.label, 'B');
  assert.equal(genericDeclaration({ adapter: 'generic', generic: 'x' }, { generics: { x: c } }).decl.label, 'C');
});
