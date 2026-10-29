// 审查接入流水线与 ar review 的集成测试夹具（Stage08 T3、T4）：每个用例在系统临时目录里建一个名字含中文与空格的真实 git 仓库，
// AGENT_ROUTER_HOME、AR_WORKTREE_ROOT、USERPROFILE / HOME、CLAUDE_CONFIG_DIR 都指向用例自己的临时目录；
// 执行者是 fake，审查者是 reviewer-seq.mjs 经通用适配器接入的假命令行；不碰真实安装、配置与进程。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupProcesses, recordedStarts } from '../identity.mjs';

export const script = fileURLToPath(new URL('../../../core/ar.mjs', import.meta.url));
const sequence = fileURLToPath(new URL('./reviewer-seq.mjs', import.meta.url));

export const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
export const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
};
export const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function until(fn, label, timeout = 60000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = fn();
    if (value) return value;
    await delay(25);
  }
  throw Error(`等待超时：${label}`);
}

// 任务说明 frontmatter：只写关心的字段。verify 默认一条一定通过的命令，让门禁（gate 事件）总会运行。
export function specText({ title = '审查接入测试', type = 'code', verify = ['node -e "process.exit(0)"'], maxRetries, review, reviewBlock, reviewer } = {}) {
  const lines = ['---', 'id: 901', `title: ${title}`, `type: ${type}`, 'expect_commit: false'];
  if (verify.length) { lines.push('verify:'); for (const line of verify) lines.push(`  - ${line}`); }
  if (maxRetries !== undefined) lines.push(`max_retries: ${maxRetries}`);
  if (review !== undefined) lines.push(`review: ${review}`);
  if (reviewBlock !== undefined) lines.push(`review_block: ${reviewBlock}`);
  if (reviewer !== undefined) lines.push(`reviewer: ${reviewer}`);
  lines.push('---', '', '把 src/a.js 改一下。', '');
  return lines.join('\n');
}

// reviewers：[{ name, modes, model?, pidFile? }]，顺序就是 routing.reviewer.profiles 的顺序；modes 见 reviewer-seq.mjs。
// executor：覆盖 fake 执行者的回放字段（writes / commit / attempts / exit …）。global：config.json 的 review。project：覆盖 project.json 的字段。
export function fixture(t, { reviewers = [], executor = {}, global = null, project = {} } = {}) {
  const since = Date.now();
  const base = mkdtempSync(path.join(os.tmpdir(), 'ar 审查接入 '));
  const repo = path.join(base, '项目 仓库');
  const home = path.join(base, '隔离 公共目录');
  const wtRoot = path.join(base, 'wt 根');
  // 186：子进程的临时目录也在 base 里（被 ar stop 结束的派发进程来不及删自己的 {promptFile}，随 base 一起删）。
  const temp = path.join(base, '临时目录');
  mkdirSync(repo);
  mkdirSync(home);
  mkdirSync(temp);
  const env = {
    ...process.env, AGENT_ROUTER_HOME: home, AR_WORKTREE_ROOT: wtRoot, AR_NO_WATCH: '1', USERPROFILE: base, HOME: base, APPDATA: base,
    TEMP: temp, TMP: temp, TMPDIR: temp,
    CLAUDE_CONFIG_DIR: path.join(base, 'claude'), CODEX_HOME: path.join(base, 'codex'),
  };
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'AR_TEST_AGENT', 'CODEX_DISPATCH_TEST_AGENT', 'AR_PROFILE', 'CLAUDECODE']) delete env[key];
  git(repo, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [['user.name', '审查接入测试'], ['user.email', 'review-pipeline@example.test'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(repo, ['config', key, value]);
  write(path.join(repo, '.gitignore'), '.agent-runs/\nnode_modules/\n');
  write(path.join(repo, 'src/a.js'), '初始\n');
  write(path.join(repo, 'README.md'), '# 说明\n');
  // 验收脚本：src/ok.txt 存在才通过（让第 1 次门禁失败、之后通过）。
  write(path.join(repo, 'scripts/check.mjs'), "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('src/ok.txt') ? 0 : 1);\n");
  const projectConfig = { v: 1, name: '项目', baseBranch: 'main', specsDir: 'docs/specs', setup: [], verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true, ...project };
  write(path.join(repo, '.agent-router/project.json'), JSON.stringify(projectConfig, null, 2));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', '初始提交']);

  const f = { base, repo, home, wtRoot, env, project: projectConfig, executor: { writes: [{ path: 'src/a.js', content: '改过\n' }], commit: '假执行者：改 src/a.js', ...executor } };
  // 给了 pidFile: true 的假审查者（hang 模式）把自己的 pid 写进这个文件。
  f.pidFile = path.join(base, '审查者 pid.txt');
  f.writeConfig = () => {
    const generics = {}, profiles = {
      worker: { adapter: 'fake', label: '假执行者', model: 'deepseek-v4-flash', enabled: true, events: [], report: '假汇报\n', exit: 0, ...f.executor },
    };
    for (const { name, modes, model = 'kimi-k3', pidFile } of reviewers) {
      const state = path.join(base, `审查者计数 ${name}.txt`);
      const pid = pidFile ? ['--pid-file', f.pidFile] : [];
      generics[name] = {
        label: `审查 ${name}`, executable: process.execPath, detect: [sequence, '--version'],
        args: [sequence, state, modes, '{promptFile}'], readOnlyArgs: [sequence, state, modes, '--read-only', ...pid, '{promptFile}'],
        output: { format: 'text' },
      };
      profiles[name] = { adapter: 'generic', generic: name, label: `审查 ${name}`, model, enabled: true };
    }
    write(path.join(home, 'config.json'), JSON.stringify({
      v: 2, managed: false, watchWindow: 'never', defaultProfile: 'worker', profiles, generics,
      routing: { rules: [], fallback: null, reviewer: { profiles: reviewers.map(item => item.name), mustDiffer: true, differFromLead: true } },
      ...(global ? { review: global } : {}),
    }));
  };
  f.writeConfig();
  f.setProject = value => {
    Object.assign(projectConfig, value);
    write(path.join(repo, '.agent-router/project.json'), JSON.stringify(projectConfig, null, 2));
    git(repo, ['add', '--', '.agent-router/project.json']);
    git(repo, ['commit', '-q', '-m', '项目配置', '--', '.agent-router/project.json']);
  };
  // 写任务说明并提交到 main。
  f.spec = (rel, fields = {}) => {
    write(path.join(repo, rel), specText(fields));
    git(repo, ['add', '--', rel]);
    git(repo, ['commit', '-q', '-m', `任务说明 ${path.basename(rel)}`, '--', rel]);
    return rel;
  };
  f.ar = (args, { timeout = 120000, env: extra = {} } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(Error(`ar ${args.join(' ')} 超时`)); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  // ar <args> --json：返回退出码与解析后的输出。
  f.json = async (args, options) => {
    const result = await f.ar([...args, '--json'], options);
    return { code: result.code, value: JSON.parse(result.stdout), stderr: result.stderr };
  };
  f.dispatch = async (specRel, name) => {
    const result = await f.json(['dispatch', specRel, '--name', name]);
    return result;
  };
  f.rows = () => {
    try { return readFileSync(path.join(home, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
  };
  f.startOf = name => f.rows().find(row => row.event === 'start' && row.name === name);
  f.events = name => { const id = f.startOf(name).id; return f.rows().filter(row => row.id === id); };
  // 事件名列表；overlap-note 是别的任务待验收时的提示，与审查无关，不列。
  f.names = name => f.events(name).map(row => row.event).filter(event => event !== 'overlap-note');
  f.dir = name => path.join(repo, '.agent-runs', name);
  f.progress = name => readFileSync(path.join(f.dir(name), 'progress.log'), 'utf8');
  f.prompt = (name, n) => readFileSync(path.join(f.dir(name), 'attempts', String(n), 'prompt.md'), 'utf8');
  f.review = name => readJson(path.join(f.dir(name), 'review.json'));
  f.attemptFiles = (name, n) => readdirSync(path.join(f.dir(name), 'attempts', String(n)));
  f.exists = (...parts) => existsSync(path.join(...parts));
  t.after(async () => {
    // 只结束本夹具清单里记录的派发进程及其子孙，按身份（PID + 创建时间）逐个结束，绝不按进程名终止。
    await cleanupProcesses(base, { recorded: recordedStarts(f.rows(), script, since), diagnostic: message => t.diagnostic(message) });
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return f;
}
