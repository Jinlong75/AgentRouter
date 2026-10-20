// 手动真实验收：用真实 Codex CLI（ChatGPT 订阅登录，auth: login）跑一个极小任务。会消耗 Codex 额度，每次只跑一个任务。
// 不改动真实配置与清单：临时公共目录 + 临时 git 仓库（路径含中文与空格）。不注入任何凭据，不打印任何环境变量。
// 用法：node tools/verify-real-codex.mjs ok|readme [--model <模型名>]
//   --model：只写进验收用的临时配置（经 -m 传给 Codex），不改用户自己的 ~/.codex/config.toml
//   ok     ：只回复 OK，不改文件
//   readme ：在 README.md 末尾加一行"由 Codex 添加"，不提交
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codex } from '../core/adapters/codex.mjs';

const tasks = {
  ok: { name: '只回复OK', text: '只回复 OK，不要修改任何文件' },
  readme: { name: '改README', text: '在 README.md 末尾加一行"由 Codex 添加"，只改这一个文件，不要提交' },
};
const which = process.argv[2];
const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : null;
if (!tasks[which] || (process.argv.includes('--model') && !model)) { console.error('用法：node tools/verify-real-codex.mjs ok|readme [--model <模型名>]'); process.exit(2); }

const project = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env };
for (const key of ['AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_DRY_RUN', 'CODEX_DRY_RUN']) delete env[key];
const login = codex.loginStatus({ env, detection: codex.detect({ env }) });
if (login !== 'in') { console.error(`Codex 没有登录（状态：${login}）：先运行 codex login，再重试`); process.exit(1); }

const base = mkdtempSync(path.join(tmpdir(), 'ar codex 验收 '));
const repo = path.join(base, '示例 仓库'), home = path.join(base, 'home');
mkdirSync(repo); mkdirSync(home);
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'ar-real-test']); git(['config', 'user.email', 'ar-real-test@example.invalid']);
writeFileSync(path.join(repo, 'README.md'), '# demo\n'); writeFileSync(path.join(repo, '.gitignore'), '.agent-runs/\n');
git(['add', 'README.md', '.gitignore']); git(['commit', '-q', '-m', 'init']);
const head = git(['rev-parse', 'HEAD']);
writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'codex', profiles: { codex: { adapter: 'codex', label: 'Codex', enabled: true, auth: 'login', sandbox: 'workspace-write', model } }, managed: false, watchWindow: 'never' }));

const { name, text } = tasks[which];
const r = spawnSync(process.execPath, [path.join(project, 'core/ar.mjs'), 'dispatch', text, '--name', name], { cwd: repo, env: { ...env, AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1' }, encoding: 'utf8', timeout: 600000, windowsHide: true, shell: false });
const dir = path.join(repo, '.agent-runs', name);
const jsonl = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const events = jsonl(path.join(dir, 'events.jsonl')), rows = jsonl(path.join(home, 'runs.jsonl'));
const start = rows.find(x => x.event === 'start'), end = rows.find(x => x.event === 'end');
const counts = {};
for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
const report = existsSync(path.join(dir, 'report.md')) ? readFileSync(path.join(dir, 'report.md'), 'utf8').trim() : null;

const checks = [];
const check = (label, fn) => { try { fn(); checks.push({ label, ok: true }); } catch (error) { checks.push({ label, ok: false, error: error.message.split('\n')[0] }); } };
check('退出码 0', () => assert.equal(r.status, 0));
check('有一轮结束事件（含 token 用量）', () => assert.ok(events.some(e => e.kind === 'turn')));
if (which === 'ok') {
  check('汇报含 OK', () => assert.match(report ?? '', /\bOK\b/i));
  check('没有改动文件', () => assert.equal(git(['status', '--porcelain']), ''));
} else {
  check('README.md 末尾是"由 Codex 添加"', () => assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8').trim().split(/\r?\n/).at(-1).trim(), '由 Codex 添加'));
  check('只改了 README.md', () => assert.equal(git(['status', '--porcelain']), 'M README.md'));
  check('没有提交', () => assert.equal(git(['rev-parse', 'HEAD']), head));
}

console.log(JSON.stringify({ task: which, model: model ?? '跟随 Codex 配置', exit: r.status, seconds: start && end ? Number(((end.at - start.started) / 1000).toFixed(1)) : null,
  agentVersion: start?.agentVersion ?? null, usage: events.filter(e => e.kind === 'turn').at(-1)?.usage ?? null, events: counts,
  report: report?.slice(0, 200) ?? null, errors: events.filter(e => e.kind === 'error').map(e => e.text.slice(0, 160)), checks }, null, 1));
const ok = checks.every(c => c.ok);
console.log(`${ok ? 'Codex 真实验收通过' : 'Codex 真实验收未通过'}（${which}，${checks.filter(c => c.ok).length}/${checks.length}）；原始输出：${path.join(dir, 'raw.log')}`);
process.exitCode = ok ? 0 : 1;
