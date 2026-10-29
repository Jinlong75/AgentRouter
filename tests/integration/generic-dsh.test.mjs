import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../../core/lib/agents.mjs';
import { validateGeneric } from '../../core/lib/generic-schema.mjs';
import { makeGeneric } from '../../core/adapters/generic.mjs';

// 143：DeepSeek Harness 预设（dsh headless，只读靠 DSH_PERMISSION_MODE）。执行者是假的 dsh（tests/fixtures/generic/dsh-cli.mjs），
// 不联网、不碰真实 dsh；AR_WORKTREE_ROOT、AGENT_ROUTER_HOME、USERPROFILE / HOME 都指向用例自己的临时目录。
const script = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const dshCli = fileURLToPath(new URL('../fixtures/generic/dsh-cli.mjs', import.meta.url));
const SECRET = 'sk-test-dsh-secret-7b3d';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); };
const jsonl = file => fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);

// 预设声明里的 executable 换成 node、参数前面加假 dsh 的路径（不依赖 PATH）。
function localProfile() {
  const { profile } = loadPreset('deepseek-harness');
  const { modelOptions, effortOptions, types, ...written } = profile;
  const generic = { ...written.generic, executable: process.execPath, detect: [dshCli, '--version'], args: [dshCli, ...written.generic.args] };
  return { ...written, generic };
}

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar dsh 测试 '));
  t.after(() => {
    assert.ok(path.relative(os.tmpdir(), base).startsWith('ar dsh 测试 '));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const repo = path.join(base, '项目 仓库'), home = path.join(base, '公共 目录');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: path.join(base, 'wt 根'), AR_NO_WATCH: '1', USERPROFILE: base, HOME: base, APPDATA: base, CLAUDE_CONFIG_DIR: path.join(base, 'claude'), CODEX_HOME: path.join(base, 'codex'), DEEPSEEK_API_KEY: SECRET };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'CODEX_DISPATCH_TEST_AGENT', 'AR_TEST_AGENT', 'CLAUDECODE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'dsh 测试']);
  git(repo, ['config', 'user.email', 'dsh@example.test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'README.md'), '初始\n');
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify({ v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true }, null, 2));
  git(repo, ['add', '.gitignore', 'README.md', '.agent-router/project.json']);
  git(repo, ['commit', '-q', '-m', '初始提交']);
  const s = { base, repo, home, env };
  s.writeConfig = profile => write(path.join(home, 'config.json'), JSON.stringify({ v: 2, managed: false, watchWindow: 'never', defaultProfile: 'dsh', profiles: { dsh: profile } }));
  s.ar = (args, cwd = repo) => spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', timeout: 90000, windowsHide: true, shell: false });
  s.dispatch = (name, type, extra = []) => {
    const rel = `docs/specs/${name}.md`;
    write(path.join(repo, rel), ['---', 'id: 960', `title: dsh ${name}`, `type: ${type}`, 'max_retries: 0', ...extra, '---', '', '测试说明正文。', ''].join('\n'));
    git(repo, ['add', rel]);
    git(repo, ['commit', '-q', '-m', `任务说明 ${name}`, '--', rel]);
    return s.ar(['dispatch', rel, '--name', name, '--profile', 'dsh', '--json']);
  };
  s.dir = name => path.join(repo, '.agent-runs', name);
  return s;
}

test('预设能加进配置：generic 声明合法，readOnlyEnv 随声明写入，只读能力由 readOnlyEnv 提供', t => {
  const s = setup(t);
  const added = s.ar(['agents', 'add', '--preset', 'deepseek-harness', '--json'], s.base);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.deepEqual(JSON.parse(added.stdout), { ok: true, name: 'deepseek-harness', preset: 'deepseek-harness', madeDefault: true, secrets: ['DEEPSEEK_API_KEY'], secretStatus: { DEEPSEEK_API_KEY: 'set' } });
  const config = JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8'));
  const profile = config.profiles['deepseek-harness'], decl = config.generics[profile.generic];
  assert.equal(profile.adapter, 'generic'); assert.equal(profile.auth, 'token');
  assert.deepEqual(profile.secrets, { DEEPSEEK_API_KEY: 'DEEPSEEK_API_KEY' });
  assert.deepEqual(decl.readOnlyEnv, { DSH_PERMISSION_MODE: 'read-only' });
  assert.equal(decl.env, undefined, '可写任务不设权限变量，用 dsh 默认的 workspace-write');
  assert.equal(validateGeneric(decl).ok, true);
  assert.equal(makeGeneric(decl).capabilities.readOnly, true, '没有 readOnlyArgs，只靠 readOnlyEnv 也算支持只读');
  assert.ok(!('modelOptions' in profile) && !('types' in profile));
  const preset = loadPreset('deepseek-harness').profile;
  assert.deepEqual(preset.types, ['docs', 'test', 'research']);
  assert.equal(preset.recommended, false); assert.equal(preset.card, undefined, '独立一张卡片');
});

test('假 dsh 派一个可写任务：进度里有命令与 token，汇报是 final 的文本，权限变量没有设置', t => {
  const s = setup(t);
  s.writeConfig(localProfile());
  const result = s.dispatch('可写任务', 'docs', ['expect_commit: false']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const events = jsonl(path.join(s.dir('可写任务'), 'events.jsonl'));
  assert.deepEqual(events.filter(e => e.kind === 'cmd').map(e => [e.id, e.command]), [['call_1', 'git status --short'], ['call_3', 'ls']], 'pwsh 与 bash 的 tool_call 都映射成命令；write 不映射');
  assert.deepEqual(events.filter(e => e.kind === 'turn').map(e => e.usage), [{ input: 373, output: 190 }, { input: 400, output: 20 }]);
  const progress = fs.readFileSync(path.join(s.dir('可写任务'), 'progress.log'), 'utf8');
  for (const line of ['运行：git status --short', '一轮结束（输入 373，输出 190 tokens）']) assert.ok(progress.includes(line), `进度缺少：${line}`);
  assert.equal(fs.readFileSync(path.join(s.dir('可写任务'), 'report.md'), 'utf8'), '完成', '汇报是 final 的文本');
  const session = jsonl(path.join(s.dir('可写任务'), 'raw.log')).find(e => e.type === 'session');
  assert.equal(session.permissionMode, 'workspace-write', '可写任务的子进程环境里没有 DSH_PERMISSION_MODE（假 dsh 取默认值）');
  assert.equal(session.hasKey, true, '密钥经 secrets 注入');
});

test('假 dsh 派一个只读任务：子进程环境里有 DSH_PERMISSION_MODE=read-only，写文件被拒绝', t => {
  const s = setup(t);
  s.writeConfig(localProfile());
  const result = s.dispatch('只读任务', 'research');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const raw = jsonl(path.join(s.dir('只读任务'), 'raw.log'));
  assert.equal(raw.find(e => e.type === 'session').permissionMode, 'read-only');
  assert.equal(raw.find(e => e.type === 'tool_result' && e.callId === 'call_2').status, 'error', '只读下写文件得到 error 的 tool_result');
  assert.equal(fs.readFileSync(path.join(s.dir('只读任务'), 'report.md'), 'utf8'), '只读完成');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir('只读任务'), 'dispatch.json'), 'utf8')).readOnly, true);
});

test('readOnlyEnv：合并在 env 之后且不改 process.env；非只读不用；密钥名与非字符串值被校验拒绝', () => {
  const decl = { ...loadPreset('deepseek-harness').profile.generic, env: { DSH_PERMISSION_MODE: 'workspace-write', KEEP: '1' } };
  const adapter = makeGeneric({ ...decl, executable: process.execPath });
  const before = process.env.DSH_PERMISSION_MODE;
  const childEnv = { dsh_permission_mode: 'workspace-write', KEEP: '1', Path: process.env.PATH ?? '' };
  adapter.command({ root: process.cwd(), report: 'r.md', prompt: 'x', env: childEnv, readOnly: true });
  assert.deepEqual({ mode: childEnv.DSH_PERMISSION_MODE, keep: childEnv.KEEP, lower: childEnv.dsh_permission_mode }, { mode: 'read-only', keep: '1', lower: undefined }, '只读：先有 env，再由 readOnlyEnv 覆盖（变量名不分大小写）');
  const writable = { DSH_PERMISSION_MODE: 'workspace-write', Path: process.env.PATH ?? '' };
  adapter.command({ root: process.cwd(), report: 'r.md', prompt: 'x', env: writable });
  assert.equal(writable.DSH_PERMISSION_MODE, 'workspace-write', '非只读不用 readOnlyEnv');
  assert.equal(process.env.DSH_PERMISSION_MODE, before, '不改核心自己的 process.env');
  assert.throws(() => makeGeneric({ ...decl, readOnlyEnv: undefined, executable: process.execPath }).command({ root: process.cwd(), report: 'r.md', prompt: 'x', env: {}, readOnly: true }), /不支持只读任务/);

  const bad = validateGeneric({ ...decl, readOnlyEnv: { DSH_API_KEY: 'x', TOKEN_X: 'y', '1BAD': 'z', GOOD: 1 } });
  assert.equal(bad.ok, false);
  const paths = bad.errors.map(e => e.path);
  for (const p of ['generic.readOnlyEnv.DSH_API_KEY', 'generic.readOnlyEnv.1BAD', 'generic.readOnlyEnv.GOOD']) assert.ok(paths.includes(p), `缺少错误：${p}`);
  assert.ok(!paths.includes('generic.readOnlyEnv.TOKEN_X'), 'TOKEN_X 不以 _TOKEN 结尾，不算密钥名');
  assert.match(bad.errors.find(e => e.path === 'generic.readOnlyEnv.DSH_API_KEY').message, /secrets/);
  assert.equal(validateGeneric({ ...decl, readOnlyEnv: 'x' }).errors[0].path, 'generic.readOnlyEnv');
});

test('环境变量里的密钥不出现在任何记录里（任务目录、公共目录）', t => {
  const s = setup(t);
  s.writeConfig(localProfile());
  assert.equal(s.dispatch('记录检查', 'research').status, 0);
  assert.equal(s.dispatch('记录检查可写', 'docs', ['expect_commit: false']).status, 0);
  const scan = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? scan(file) : [file];
  });
  const files = [...scan(s.dir('记录检查')), ...scan(s.dir('记录检查可写')), ...scan(s.home)];
  assert.ok(files.length > 10);
  for (const file of files) assert.ok(!fs.readFileSync(file).includes(SECRET), `${path.relative(s.base, file)} 里出现了密钥值`);
});
