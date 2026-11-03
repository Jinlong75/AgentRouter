import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { git, headSha } from './git.mjs';
import { readProject, enterGate, exclusiveCommandOf } from './schedule.mjs';
import { acquireSlot } from './slots.mjs';
import { readConfig, slotLimits } from './config.mjs';
import { taskAlive, killProcessTree, processCreated } from './process.mjs';
import { registryWriter } from './records.mjs';
import { splitArgs, planCommand } from './command.mjs';

const same = (a, b) => typeof a === 'string' && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const lockPath = root => join(root, '.agent-runs', '_verify', 'running.json');
const rowsOf = home => { try { return readFileSync(join(home, 'runs.jsonl'), 'utf8').split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); } catch { return []; } };
export async function fullVerifyStatus({ home, root, branch, alive = taskAlive }) {
  const project = readProject(root), every = project.fullVerifyEvery === undefined ? 5 : project.fullVerifyEvery;
  if (!Number.isSafeInteger(every) || every < 1) throw new Error('项目配置无效：fullVerifyEvery');
  const rows = rowsOf(home), checks = rows.filter(r => r.event === 'full-verify' && same(r.repo, root) && r.branch === branch);
  const last = checks.at(-1) ?? null, lastPass = checks.filter(r => r.ok === true).at(-1) ?? null;
  const starts = new Map(rows.filter(r => r.event === 'start').map(r => [r.id, r]));
  const mergedSince = rows.filter(r => { const s = starts.get(r.id); return r.event === 'accepted' && r.mode !== 'confirm' && r.merge && s && same(s.repo, root) && (s.baseBranch ?? project.baseBranch) === branch && (!lastPass || r.at > lastPass.at); }).length;
  let running = null;
  try { const info = JSON.parse(readFileSync(lockPath(root), 'utf8')); if (await alive({ pid: info.pid, started: info.started })) running = info.log; } catch { /* 没有运行中的验收。 */ }
  return { last, running, mergedSince, every };
}
export const dateText = at => { const d = new Date(at); const p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
export function statusLine(s) { if (s.running) return `全量验收：正在运行（日志 ${s.running}）`; const tail = s.mergedSince >= s.every ? '；建议 ar verify --detach' : ''; return s.last ? `全量验收：上次 ${dateText(s.last.at)} ${s.last.ok ? '通过' : '失败'}（${s.last.head.slice(0, 7)}），之后已合入 ${s.mergedSince} 个任务${tail}` : `全量验收：还没有记录，已合入 ${s.mergedSince} 个任务${tail}`; }
export function fullVerifyConfig(project) {
  if (project.fullVerify !== undefined && (!Array.isArray(project.fullVerify) || !project.fullVerify.length || project.fullVerify.some(x => typeof x !== 'string' || !x.trim()))) throw new Error('project.json 的 fullVerify 必须是非空的命令数组');
  if (project.fullVerifyTimeoutMin !== undefined && (!Number.isSafeInteger(project.fullVerifyTimeoutMin) || project.fullVerifyTimeoutMin < 1)) throw new Error('project.json 的 fullVerifyTimeoutMin 必须是正整数');
  const source = project.fullVerify !== undefined ? 'fullVerify' : 'verify', commands = project[source];
  if (!Array.isArray(commands) || !commands.length) throw new Error('项目配置没有全量验收命令（project.json 的 fullVerify 或 verify），无法做全量验收');
  return { commands, source };
}
export async function requireFullVerify({ root, home }) {
  const head = headSha(root), branch = git(root, ['branch', '--show-current']).stdout.trim();
  const { last, running } = await fullVerifyStatus({ home, root, branch });
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty.status !== 0) throw new Error(dirty.stderr.trim());
  const reasons = [];
  if (!last) reasons.push('还没有全量验收记录');
  else {
    if (!last.ok) reasons.push(`最近一次全量验收没有通过（${dateText(last.at)}）`);
    if (last.head !== head) reasons.push(`最近一次全量验收对应 ${last.head.slice(0, 7)}，当前是 ${head.slice(0, 7)}`);
  }
  if (dirty.stdout.trim()) reasons.push('工作区有未提交的改动');
  if (running) reasons.push('全量验收正在运行');
  return { ok: !reasons.length, head, last, reasons };
}
export async function verifyFull({ root, home, scriptPath, env, detach = false, timeoutMin, out = console.log, created = processCreated, alive = taskAlive }) {
  root = resolve(root);
  const project = readProject(root), { commands, source } = fullVerifyConfig(project);
  timeoutMin ??= project.fullVerifyTimeoutMin ?? 60;
  const branch = git(root, ['branch', '--show-current']).stdout.trim(), head = headSha(root);
  const status = await fullVerifyStatus({ home, root, branch, alive });
  if (status.running) throw new Error(`全量验收正在运行：日志 ${status.running}`);
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty.status !== 0) throw new Error(dirty.stderr.trim());
  if (dirty.stdout.trim()) throw new Error('主工作区有未提交的改动，全量验收要对应一个提交：先提交或暂存后再运行');
  const startedAt = Date.now(), d = new Date(startedAt), p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const dir = join(root, '.agent-runs', '_verify', stamp), log = join(dir, 'output.log'), lock = lockPath(root);
  mkdirSync(dir, { recursive: true });
  if (!status.running) { try { const old = JSON.parse(readFileSync(lock, 'utf8')); if (!(await alive({ pid: old.pid, started: old.started }))) rmSync(lock); } catch { /* 无法确认时保留记录。 */ } }
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, started: startedAt, log }), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; throw new Error(`全量验收正在运行：日志 ${status.running ?? lock}`); }
  if (detach) {
    const child = spawn(process.execPath, [scriptPath, 'verify', '--project', root, '--timeout-min', String(timeoutMin), '--internal', dir], { cwd: root, env, detached: true, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const started = await created(child.pid);
    writeFileSync(lock, JSON.stringify({ pid: child.pid, started: started ?? Number.MAX_SAFE_INTEGER, log }));
    child.send('verify-lock-ready'); child.disconnect(); child.unref();
    out(`全量验收已在后台开始：日志 ${log}；结束后运行 ar verify --last 查看结果`); return { detached: true, log };
  }
  return executeVerify({ root, home, env, commands, source, branch, head, startedAt, dir, timeoutMin, out });
}
// 全量日志在命令运行期间持续写入。
async function runLogged(line, { root, env, log, timeoutMs }) {
  let plan;
  try { plan = planCommand(splitArgs(line), { cwd: root, env, line }); }
  catch (error) { return { exit: null, error: error.message }; }
  return new Promise(done => {
    let child, timer, grace, settled = false, timedOut = false, timeoutError = null;
    const finish = (exit, error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace);
      done({ exit, error, timedOut });
    };
    try { child = spawn(plan.executable, plan.args, { cwd: root, env, shell: false, windowsHide: true, windowsVerbatimArguments: plan.verbatim, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { finish(null, `启动失败：${error.message}`); return; }
    const collect = chunk => appendFileSync(log, chunk);
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', error => finish(null, `启动失败：${error.message}`));
    child.on('close', code => finish(timedOut ? null : code, timeoutError));
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(async () => {
      timedOut = true; timeoutError = `超过 ${timeoutMs / 1000} 秒没有结束，已结束进程树`;
      try { await killProcessTree(child.pid); } catch (error) { timeoutError += `：${error.message}`; }
      if (!settled) grace = setTimeout(() => finish(null, `${timeoutError}；进程树没能结束`), 15000);
    }, timeoutMs);
  });
}
export async function executeVerify({ root, home, env, commands, source = 'verify', branch, head, startedAt, dir, timeoutMin, timeoutMs = timeoutMin * 60000, out = console.log }) {
  const log = join(dir, 'output.log'), id = randomUUID(), command = exclusiveCommandOf({ root, verify: commands });
  const configured = readProject(root).exclusiveCommands, scope = Array.isArray(configured) && configured.some(x => typeof x === 'string' && x.trim() === command) ? 'full' : 'focus';
  let release;
  try {
    const entered = await enterGate({ home, id, name: '全量验收', command, scope, progress: () => out('等待门禁名额…'), acquire: () => acquireSlot({ home, kind: 'gate', id, limit: () => slotLimits(readConfig(home).config).limits.gateConcurrency, onWait: () => out('等待门禁名额…') }) });
    release = entered.release;
    branch = git(root, ['branch', '--show-current']).stdout.trim(); head = headSha(root);
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']);
    const refused = dirty.status !== 0 ? dirty.stderr.trim() : dirty.stdout.trim() ? '主工作区有未提交的改动，全量验收要对应一个提交：先提交或暂存后再运行' : null;
    if (refused) {
      // 336c R3-1（主导）：取得名额后的前置检查拒绝也留记录（后台运行时这是唯一能看到原因的地方），ar verify --last 显示失败，原因在 result.json 与 --json。
      const endedAt = Date.now(), result = { v: 1, root, branch, head, ok: false, failed: refused, exitCode: 2, startedAt, endedAt, log, commands, source };
      writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
      registryWriter(home)({ event: 'full-verify', repo: root, branch, head, ok: false, failed: refused, startedAt, at: endedAt, log, commands, source });
      throw new Error(refused);
    }
    let failed = null, exitCode = 0;
    for (const line of commands) { appendFileSync(log, `$ ${line}\n`); const result = await runLogged(line, { root, env: { ...env, AR_FULL_VERIFY: '1' }, log, timeoutMs }); appendFileSync(log, `${result.error ? `\n${result.error}` : ''}\n`); if (result.exit !== 0 || result.error || result.timedOut) { failed = line; exitCode = result.exit ?? 1; break; } }
    const endBranch = git(root, ['branch', '--show-current']).stdout.trim(), endHead = headSha(root);
    const invalid = branch !== endBranch || head !== endHead;
    if (invalid) { failed = `验收期间分支或提交变了：${head.slice(0, 7)} → ${endHead.slice(0, 7)}`; exitCode = 3; }
    const endedAt = Date.now(), ok = failed === null, result = { v: 1, root, branch, head, ok, failed, exitCode, startedAt, endedAt, log, commands, source };
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    registryWriter(home)({ event: 'full-verify', repo: root, branch, head, ok, failed, startedAt, at: endedAt, log, commands, source });
    out(invalid ? `全量验收作废：验收期间分支或提交变了（${head.slice(0, 7)} → ${endHead.slice(0, 7)}），请在不提交、不合入时重跑` : ok ? `全量验收通过：${branch} ${head.slice(0, 7)}（用时 ${Math.round((endedAt-startedAt)/60000)} 分）` : `全量验收失败：${branch} ${head.slice(0, 7)}，失败命令：${failed}；日志：${log}`);
    return result;
  } finally { release?.(); rmSync(lockPath(root), { force: true }); }
}
