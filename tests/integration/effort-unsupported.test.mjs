import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../../core/lib/agents.mjs';
import { effortOptionsFor, supportsEffort } from '../../core/lib/router.mjs';
import { cleanupProcesses } from '../fixtures/identity.mjs';

// Stage07c 154（D87）：预设写 supportsEffort: false 的执行者不支持推理强度——任务说明 / 路由规则 / 命令行给的强度一律忽略（不拒绝派发），
// 不传给执行者，进度写一行，settingSources.effort 记"已忽略"；升级链不升档。
// 执行者是系统临时目录里的一个小脚本（把收到的参数当 final 汇报打印出来）；AGENT_ROUTER_HOME、USERPROFILE / HOME、CLAUDE_CONFIG_DIR 都指向用例自己的临时目录。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, 'utf8'); };
const jsonl = file => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

// 假的 dsh：--version 打印版本；否则把自己收到的参数当 final 汇报打印；参数里有 fail 就以 1 退出。
const agentSource = `const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('echo-args 1.0'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'final', text: JSON.stringify(args) }));
  process.exit(args.includes('fail') ? 1 : 0);
});
`;

function fixture(t) {
  const base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'ar-effort-154-'));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home'), user = path.join(base, 'user');
  for (const dir of [repo, home, user]) mkdirSync(dir);
  const agent = path.join(base, 'echo-args.mjs');
  writeFileSync(agent, agentSource);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_)/i.test(key)) delete env[key];
  for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'HOMEDRIVE', 'HOMEPATH']) delete env[key];
  Object.assign(env, {
    AGENT_ROUTER_HOME: home, USERPROFILE: user, HOME: user, APPDATA: user, CLAUDE_CONFIG_DIR: path.join(user, 'claude'), AR_NO_WATCH: '1',
    AR_WORKTREE_ROOT: path.join(base, 'wt'), DEEPSEEK_API_KEY: 'sk-test-154',
  });
  assert.equal(path.dirname(env.AGENT_ROUTER_HOME), base, '隔离目录在临时目录里');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', '强度测试']);
  git(repo, ['config', 'user.email', 'effort-154@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\n');
  write(path.join(repo, 'a.txt'), '初始\n');
  git(repo, ['add', '.gitignore', 'a.txt']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  const f = { base, repo, home, env };
  // 预设的 generic 声明里程序换成 node + 假 dsh，参数里加上 --effort {effort}（没设置强度时整项去掉），extra 是附加的参数（如 fail）。
  const localProfile = (extra = []) => {
    const { profile } = loadPreset('deepseek-harness');
    const { modelOptions, effortOptions, types, ...written } = profile;
    const args = [agent, '--effort', '{effort}', ...extra, ...written.generic.args];
    return { ...written, generic: { ...written.generic, executable: process.execPath, detect: [agent, '--version'], args } };
  };
  // 名字是 deepseek-harness 的才对应上预设（声明不支持推理强度）；other 是同样的程序但名字、程序名都对不上预设。
  f.config = ({ extra = [], rules, defaultProfile = 'deepseek-harness' } = {}) => {
    const config = { v: 2, managed: false, watchWindow: 'never', defaultProfile,
      profiles: { 'deepseek-harness': localProfile(extra), other: { ...localProfile(extra), label: '别的 Agent' } },
      routing: { rules: rules ?? [], fallback: null, reviewer: null } };
    write(path.join(home, 'config.json'), JSON.stringify(config));
  };
  f.ar = args => spawnSync(process.execPath, [script, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 90000, windowsHide: true, shell: false });
  f.spec = (name, lines = []) => {
    const rel = `docs/specs/${name}.md`;
    write(path.join(repo, rel), ['---', 'id: 154', 'title: 强度测试', 'type: docs', ...lines, '---', '', '正文', ''].join('\n'));
    return rel;
  };
  f.dispatch = (name, rel, extra = [], expect = 0) => {
    const r = f.ar(['dispatch', rel, '--name', name, ...extra]);
    assert.equal(r.status, expect, `${r.stdout}\n${r.stderr}`);
    return r;
  };
  f.start = name => jsonl(path.join(home, 'runs.jsonl')).find(row => row.event === 'start' && row.name === name);
  f.dispatchJson = name => JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'dispatch.json'), 'utf8'));
  f.progress = name => readFileSync(path.join(repo, '.agent-runs', name, 'progress.log'), 'utf8');
  // 执行者收到的参数（假 dsh 把它们当 final 汇报，report.md 就是 JSON 数组）。
  f.agentArgs = (name, attempt = 1) => JSON.parse(readFileSync(path.join(repo, '.agent-runs', name, 'attempts', String(attempt), 'report.md'), 'utf8'));
  f.status = name => {
    const json = JSON.parse(f.ar(['status', name, '--json']).stdout);
    return { json, lines: f.ar(['status', name]).stdout.trimEnd().split(/\r?\n/) };
  };
  t.after(async () => {
    await cleanupProcesses(base, { diagnostic: message => t.diagnostic(message) });
    assert.ok(path.relative(realpathSync.native(os.tmpdir()), base).startsWith('ar-effort-154-'));
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  f.config();
  return f;
}

test('0 预设声明：deepseek-harness 写 supportsEffort: false 且没有 effortOptions；presets --json 的摘要带 supportsEffort（没写为 true）；add 不把它写进 config.json', t => {
  const f = fixture(t);
  assert.equal(loadPreset('deepseek-harness').profile.supportsEffort, false);
  assert.equal(loadPreset('deepseek-harness').profile.effortOptions, undefined);
  const presets = JSON.parse(f.ar(['agents', 'presets', '--json']).stdout).presets;
  assert.equal(presets.find(p => p.name === 'deepseek-harness').supportsEffort, false);
  for (const preset of presets.filter(p => p.name !== 'deepseek-harness')) assert.equal(preset.supportsEffort, true, preset.name);
  // 路由器的判断：按名字对上预设的不支持；名字、程序名都对不上的、别的预设都支持。
  const config = JSON.parse(readFileSync(path.join(f.home, 'config.json'), 'utf8'));
  assert.equal(supportsEffort('deepseek-harness', config.profiles['deepseek-harness'], config), false);
  assert.equal(supportsEffort('other', config.profiles.other, config), true);
  assert.equal(supportsEffort('deepseek', { adapter: 'claude-code' }, {}), true);
  assert.equal(effortOptionsFor('deepseek-harness', config.profiles['deepseek-harness'], config), null);
  // 导入预设：supportsEffort 是只给界面和核心看的声明，不进 config.json。
  const added = f.ar(['agents', 'add', '--preset', 'deepseek-harness', '--name', 'dsh2', '--json']);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.ok(!('supportsEffort' in JSON.parse(readFileSync(path.join(f.home, 'config.json'), 'utf8')).profiles.dsh2));
});

test('1 任务说明写了 effort: high、执行者不支持：派发成功，执行者没拿到推理强度，进度有"已忽略"，settingSources.effort 是"已忽略"', t => {
  const f = fixture(t);
  f.dispatch('spec', f.spec('u1', ['effort: high']));
  assert.ok(!f.agentArgs('spec').includes('--effort') && !f.agentArgs('spec').includes('high'), `执行者参数：${f.agentArgs('spec').join(' ')}`);
  assert.match(f.progress('spec'), /这个执行者不支持推理强度，已忽略（high，来自任务说明）/);
  assert.deepEqual(f.start('spec').settingSources, { model: 'config.json', effort: '已忽略' });
  assert.deepEqual(f.dispatchJson('spec').settingSources, { model: 'config.json', effort: '已忽略' });
  assert.equal(f.start('spec').effort, null, 'start 记的是实际生效的值：没有');
  // ar status：--json 的 params 带来源"已忽略"；文字输出没有参数行（没有来自任务说明的有效值）。
  const status = f.status('spec');
  assert.deepEqual(status.json.params, { model: null, effort: null, sources: { model: 'config.json', effort: '已忽略' } });
  assert.ok(!status.lines.some(line => line.startsWith('参数：')), status.lines.join('\n'));

  // 对照：同样的程序、名字对不上预设的执行者照常收到强度。
  f.dispatch('control', f.spec('u1c', ['effort: high']), ['--profile', 'other']);
  assert.deepEqual(f.agentArgs('control').slice(0, 2), ['--effort', 'high']);
  assert.doesNotMatch(f.progress('control'), /已忽略/);
  assert.deepEqual(f.start('control').settingSources, { model: 'config.json', effort: '任务说明' });
});

test('2 路由规则写了 effort、执行者不支持：同样忽略，来自路由规则；任务说明和路由规则都没写强度时没有这一行', t => {
  const f = fixture(t);
  f.config({ rules: [{ types: ['docs'], profile: 'deepseek-harness', effort: 'max' }] });
  f.dispatch('rule', f.spec('u2'));
  assert.ok(!f.agentArgs('rule').includes('--effort'), f.agentArgs('rule').join(' '));
  assert.match(f.progress('rule'), /这个执行者不支持推理强度，已忽略（max，来自路由规则）/);
  assert.deepEqual(f.start('rule').settingSources, { model: 'config.json', effort: '已忽略' });
  assert.equal(f.dispatchJson('rule').route.effort, 'max', 'route 记录仍带规则的 effort');
  // 任务说明比路由规则优先：来自任务说明。
  f.dispatch('both', f.spec('u2b', ['effort: low']));
  assert.match(f.progress('both'), /已忽略（low，来自任务说明）/);
  // 规则没写 effort，任务说明也没写：没有忽略，来源是内置默认。
  f.config();
  f.dispatch('none', f.spec('u2c'));
  assert.doesNotMatch(f.progress('none'), /不支持推理强度/);
  assert.deepEqual(f.start('none').settingSources, { model: 'config.json', effort: 'config.json' });
});

test('3 命令行 --effort、执行者不支持：同样忽略并写这一行（原来给通用适配器传 --effort 只是没有 {effort} 占位符时被丢掉，不报错）', t => {
  const f = fixture(t);
  f.dispatch('cli', f.spec('u3'), ['--effort', 'low']);
  assert.ok(!f.agentArgs('cli').includes('--effort'), f.agentArgs('cli').join(' '));
  assert.match(f.progress('cli'), /这个执行者不支持推理强度，已忽略（low，来自命令行）/);
  assert.deepEqual(f.start('cli').settingSources, { model: 'config.json', effort: '已忽略' });
  // 命令行压过了任务说明：忽略的是命令行的值，来源写命令行；任务说明的值同样不会冒出来。
  f.dispatch('cli2', f.spec('u3b', ['effort: high']), ['--effort', 'low']);
  assert.ok(!f.agentArgs('cli2').includes('--effort'), f.agentArgs('cli2').join(' '));
  assert.match(f.progress('cli2'), /已忽略（low，来自命令行）/);
  // 不支持推理强度的执行者也照样能用 model。
  f.dispatch('model', f.spec('u3c', ['model: m-x']));
  assert.deepEqual(f.start('model').settingSources, { model: '任务说明', effort: 'config.json' });
});

test('4 手动重试：任务说明里的强度同样忽略并写一行；resume 带"已忽略"', t => {
  const f = fixture(t);
  f.dispatch('job', f.spec('u4', ['effort: high']));
  const r = f.ar(['retry', 'job', '--note', '再来一次']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!f.agentArgs('job', 2).includes('--effort'), f.agentArgs('job', 2).join(' '));
  assert.equal([...f.progress('job').matchAll(/这个执行者不支持推理强度，已忽略（high，来自任务说明）/g)].length, 2, '派发与重试各写一行');
  const resume = jsonl(path.join(f.home, 'runs.jsonl')).find(row => row.event === 'resume');
  assert.deepEqual(resume.settingSources, { model: 'config.json', effort: '已忽略' });
});

test('5 升级链遇到不支持推理强度的执行者：不升档，进度写明原因', t => {
  const f = fixture(t);
  f.config({ extra: ['fail'] });
  f.dispatch('chain', f.spec('u5', ['max_retries: 3']), [], 1);
  const progress = f.progress('chain');
  assert.match(progress, /第 2 次重试：这个执行者不支持推理强度，不提高/);
  assert.doesNotMatch(progress, /提高推理强度/);
  assert.ok(!f.agentArgs('chain', 3).includes('--effort'), '第 3 次尝试也没有强度');
});
