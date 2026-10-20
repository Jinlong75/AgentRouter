// 手动真实验收：用真实 Claude Code + DeepSeek 跑两个小任务（会产生少量费用）。
// 不改动真实配置与清单：临时公共目录 + 临时 git 仓库（路径含中文与空格）。不打印任何环境变量或密钥。
// 用法：node tools/verify-real-claude-code.mjs [--preset deepseek]   需要：claude CLI、DEEPSEEK_API_KEY（进程或用户环境变量）
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../core/lib/agents.mjs';
import { resolveSecret } from '../core/lib/secrets.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const presetName = process.argv.includes('--preset') ? process.argv[process.argv.indexOf('--preset') + 1] : 'deepseek';
const { profile } = loadPreset(presetName);
const base = mkdtempSync(path.join(tmpdir(), 'ar 真实验收 '));
const repo = path.join(base, '示例 仓库'), home = path.join(base, 'home');
mkdirSync(repo); mkdirSync(home);
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'ar-real-test']); git(['config', 'user.email', 'ar-real-test@example.invalid']);
writeFileSync(path.join(repo, 'README.md'), '# demo\n'); writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
git(['add', 'README.md', '.gitignore']); git(['commit', '-q', '-m', 'init']);
writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: presetName, profiles: { [presetName]: profile }, managed: false, watchWindow: 'never' }));
const env = { ...process.env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' };
for (const key of ['AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_DRY_RUN', 'CODEX_DRY_RUN']) delete env[key];

const jsonl = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
function dispatch(name, task) {
  const r = spawnSync(process.execPath, [path.join(project, 'core/ar.mjs'), 'dispatch', task, '--name', name], { cwd: repo, env, encoding: 'utf8', timeout: 600000, windowsHide: true, shell: false });
  const dir = path.join(repo, '.agent-runs', name);
  const events = jsonl(path.join(dir, 'events.jsonl'));
  const rows = jsonl(path.join(home, 'runs.jsonl'));
  const start = rows.find(x => x.event === 'start' && x.name === name), end = rows.find(x => x.event === 'end' && x.id === start?.id);
  const counts = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const report = existsSync(path.join(dir, 'report.md')) ? readFileSync(path.join(dir, 'report.md'), 'utf8').trim() : null;
  return { name, exit: r.status, seconds: start && end ? Number(((end.at - start.started) / 1000).toFixed(1)) : null, model: start?.model ?? null,
    usage: events.filter(e => e.kind === 'turn').at(-1)?.usage ?? null, events: counts, report, errors: events.filter(e => e.kind === 'error').map(e => e.text.slice(0, 160)) };
}

const results = [], checks = [];
const check = (label, fn) => { try { fn(); checks.push({ label, ok: true }); } catch (error) { checks.push({ label, ok: false, error: error.message.split('\n')[0] }); } };

// 任务 1：只回复 OK，不改文件
const t1 = dispatch('只回复OK', '只回复 OK，不要修改任何文件');
results.push(t1);
check('任务 1 退出码 0', () => assert.equal(t1.exit, 0));
check('任务 1 汇报含 OK', () => assert.match(t1.report ?? '', /\bOK\b/i));
check('任务 1 没有改动文件', () => assert.equal(git(['status', '--porcelain']), ''));

// 任务 2：创建 hello.txt 并提交
const t2 = dispatch('添加hello', '创建 hello.txt，内容为一行"你好"，然后 git add hello.txt 并提交，提交信息"[执行] 添加 hello"');
results.push(t2);
check('任务 2 退出码 0', () => assert.equal(t2.exit, 0));
check('任务 2 hello.txt 内容为"你好"', () => assert.equal(readFileSync(path.join(repo, 'hello.txt'), 'utf8').trim(), '你好'));
check('任务 2 已提交，提交信息含"添加 hello"', () => assert.match(git(['log', '-1', '--format=%s']), /添加 hello/));
check('任务 2 有命令与文件事件', () => { assert.ok((t2.events.cmd ?? 0) >= 2); assert.ok((t2.events.file ?? 0) >= 1); });
check('执行者使用隔离的配置目录', () => assert.ok(statSync(path.join(home, 'workers', presetName, 'claude')).isDirectory()));

// 证据扫描：密钥值只在内存里比对，只打印是否出现。
const secretNames = Object.values(profile.secrets ?? {});
const files = [];
const walk = d => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) { if (n !== 'claude') walk(p); } else files.push(p); } };
walk(path.join(repo, '.agent-runs')); walk(home);
check('任务记录与公共目录里没有密钥值', () => {
  for (const name of secretNames) { const value = resolveSecret(name); for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes(value), `密钥 ${name} 出现在 ${path.relative(base, f)}`); }
});

console.log(JSON.stringify({ preset: presetName, results, checks }, null, 1));
const ok = checks.every(c => c.ok);
console.log(`${ok ? '真实验收通过' : '真实验收未通过'}（${checks.filter(c => c.ok).length}/${checks.length}）；证据保留在：${base}`);
process.exitCode = ok ? 0 : 1;
