// 推送与快进拉取（Stage07b 128）：ar push / ar pull。零依赖。
// 安全约束（每条都有测试，源码扫描测试会检查本文件的字样）：
// - 凭据只用本机 git 已有的登录；联网操作的环境见 env.mjs 的 gitNetworkEnv（不交互），超时 120 秒；
// - 远程地址带用户名密码 / 令牌时拒绝；显示一律去掉用户名与密码；push.jsonl 不记地址、不记 git 原始输出；
// - 只做普通推送（一个明确的 refs/heads 对 refs/heads），拉取只快进；
// - 主导（lead）推送需要项目配置 push.allowLead 为 true。
// 函数不为"预期内的失败"抛异常，而是返回 { ok: false, code, error }；调用方（cli.mjs、accept.mjs）决定怎么呈现。
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gitNetworkEnv } from './env.mjs';
import { git } from './git.mjs';
import { parseJson } from './json.mjs';

export const NET_TIMEOUT = 120000;
export const BYS = ['human', 'lead', 'cli'];
const MAX_BUFFER = 8 * 1024 * 1024;

// 联网 git 的默认执行函数：返回 { status, stdout, stderr, timedOut }。测试可以注入别的执行函数来断言环境。
export function runNetworkGit(root, args, { env, timeout = NET_TIMEOUT } = {}) {
  const child = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER, shell: false, windowsHide: true });
  if (child.error) return { status: null, stdout: '', stderr: child.error.message, timedOut: child.error.code === 'ETIMEDOUT' };
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '', timedOut: false };
}

// 谁在推送（by）：明确给了就用；没给时环境里 CLAUDECODE=1 算主导（lead），其余算 cli——和 accept 的事件一致。
export function pushActor({ by = null, env = process.env } = {}) {
  if (by !== null && by !== undefined) {
    if (!BYS.includes(by)) throw new Error(`--by 只接受 human、lead、cli：${by}`);
    return by;
  }
  return env.CLAUDECODE === '1' ? 'lead' : 'cli';
}

// ---------- 远程地址：识别凭据、去掉用户名密码 ----------

// 带 scheme 的地址（https://…、ssh://…）的授权部分：返回 { scheme, userinfo, rest }，没有用户信息时 userinfo 为 null。
function parseSchemeUrl(url) {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(String(url ?? ''));
  if (!match) return null;
  const at = match[2].lastIndexOf('@');
  return { scheme: match[1].toLowerCase(), userinfo: at < 0 ? null : match[2].slice(0, at), host: at < 0 ? match[2] : match[2].slice(at + 1), rest: match[3] };
}

// 地址里是否带凭据：https://x:y@…、https://令牌@… 都算；ssh 的 ssh://git@host/… 与 git@host:… 这类 SSH 写法不算（除非 ssh:// 里带了 :密码）。
export function urlHasCredential(url) {
  const parsed = parseSchemeUrl(url);
  if (!parsed || parsed.userinfo === null) return false;
  if (['ssh', 'git+ssh', 'ssh+git'].includes(parsed.scheme)) return parsed.userinfo.includes(':');
  return parsed.scheme !== 'file';
}

// 显示用地址：去掉用户名和密码（即使只有 user@ 也去掉）。scp 写法 git@host:路径 去掉 git@。
export function displayUrl(url) {
  const text = String(url ?? '').trim();
  const parsed = parseSchemeUrl(text);
  if (parsed) return `${parsed.scheme}://${parsed.host}${parsed.rest}`;
  return text.replace(/^[^@/\\:]+@(?=[^/\\]*:)/, '');
}

// 清掉文字里所有 scheme://用户信息@ 的用户信息（git 的报错里可能带地址）。
export const scrubUrls = text => String(text ?? '').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1');

// ---------- 失败原因归类 ----------

const AUTH = /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Invalid username or password|returned error: 40[13]|Host key verification failed|HTTP 40[13]|Support for password authentication was removed|Access denied/i;
const NETWORK = /Could not resolve host|unable to access|Failed to connect|Connection (refused|timed out|reset|closed)|Network is unreachable|Could not connect|Operation timed out|Timed out|SSL |TLS |proxy|Unable to connect|early EOF|RPC failed|unexpected disconnect/i;
const tailText = (text, count = 3) => scrubUrls(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-count).join('；');

const EMAIL_PRIVACY = /\bGH007\b/;

// 要推送的提交里的作者邮箱：远程跟踪分支..分支 的提交（没有跟踪分支时取分支最近一个提交）。
// 取第一个不是 noreply 的邮箱（被拒的一定是私人邮箱）；全是 noreply 时取第一个；读不到返回 null。
function pushedAuthorEmail(root, branch, tracking) {
  // 用 rev-list --format 取（推送只用到几种 git 子命令，源码扫描测试限定了清单）；输出里每个提交前有一行 "commit <哈希>"。
  const log = tracking ? git(root, ['rev-list', '--format=%ae', `${tracking}..refs/heads/${branch}`]) : git(root, ['rev-list', '-1', '--format=%ae', `refs/heads/${branch}`]);
  const emails = log.status === 0 ? log.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^commit [0-9a-f]+$/.test(line)) : [];
  return emails.find(email => !/noreply\.github\.com$/i.test(email)) ?? emails[0] ?? null;
}

export const NO_CREDENTIAL_TEXT = 'git 没有拿到可用的登录：在终端里手动 git push 一次完成登录，之后就能推送';

// 把 git 的失败输出归类为 { cause, error }：NO_CREDENTIAL（没有可用登录）、NETWORK（网络不通 / 超时）、OTHER（原样转述最后几行）。
export function classifyFailure(result) {
  if (result.timedOut) return { cause: 'NETWORK', error: `连接远程超过 ${NET_TIMEOUT / 1000} 秒没有响应` };
  const text = `${result.stderr}\n${result.stdout}`;
  if (AUTH.test(text)) return { cause: 'NO_CREDENTIAL', error: NO_CREDENTIAL_TEXT };
  if (NETWORK.test(text)) return { cause: 'NETWORK', error: `连不上远程：${tailText(text) || '网络不通'}` };
  return { cause: 'OTHER', error: tailText(text) || (result.status === null ? '无法运行 git' : `git 退出码 ${result.status}`) };
}

// ---------- 项目、远程与本机状态 ----------

const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
const same = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const revParse = (root, ref) => {
  const found = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return found.status === 0 ? found.stdout.trim() : null;
};

// 读项目配置里和推送有关的部分。返回 { ok: true, baseBranch, remote, afterAccept, allowLead } 或失败对象。
function readPushConfig(root) {
  let raw;
  try { raw = readFileSync(join(root, '.agent-router', 'project.json'), 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? fail('NOT_INITIALIZED', '项目还没有初始化：先运行 ar init') : fail('BAD_CONFIG', `project.json 无法读取：${error.message}`); }
  let config;
  try { config = parseJson(raw); } catch (error) { return fail('BAD_CONFIG', `project.json 无法解析：${error.message}`); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return fail('BAD_CONFIG', 'project.json 不是对象');
  const baseBranch = config.baseBranch;
  if (typeof baseBranch !== 'string' || baseBranch === '' || baseBranch.startsWith('-') || git(root, ['check-ref-format', '--branch', baseBranch]).status !== 0) {
    return fail('BAD_CONFIG', '项目配置里的 baseBranch 缺失或无效，不知道该推送哪个分支');
  }
  const push = config.push && typeof config.push === 'object' && !Array.isArray(config.push) ? config.push : {};
  const remote = push.remote === undefined ? 'origin' : push.remote;
  if (!remoteNameValid(root, remote)) return fail('BAD_CONFIG', `项目配置里的 push.remote 无效：${typeof remote === 'string' ? remote : '不是字符串'}`);
  return { ok: true, baseBranch, remote, afterAccept: push.afterAccept === true, allowLead: push.allowLead === true };
}

// 远程名：非空、不以 - 开头、git check-ref-format --allow-onelevel 能通过。
export function remoteNameValid(root, name) {
  return typeof name === 'string' && name !== '' && !name.startsWith('-') && git(root, ['check-ref-format', '--allow-onelevel', name]).status === 0;
}

// 本机分支和远程跟踪分支的关系。tracking 为 null（远程没有这个分支或还没取过）时是 noUpstream，领先数 = 本机该分支的全部提交。
function compare(root, branch, tracking) {
  const local = revParse(root, `refs/heads/${branch}`);
  if (!local) return { local: null, tracking: null, ahead: 0, behind: 0, state: null };
  if (!tracking) {
    const count = git(root, ['rev-list', '--count', local]);
    return { local, tracking: null, ahead: count.status === 0 ? Number(count.stdout.trim()) || 0 : 0, behind: 0, state: 'noUpstream' };
  }
  const counted = git(root, ['rev-list', '--left-right', '--count', `${local}...${tracking}`]);
  const [ahead, behind] = counted.status === 0 ? counted.stdout.trim().split(/\s+/).map(Number) : [0, 0];
  const state = ahead > 0 && behind > 0 ? 'diverged' : ahead > 0 ? 'ahead' : behind > 0 ? 'behind' : 'same';
  return { local, tracking, ahead, behind, state };
}

// 前置检查：项目已初始化、远程存在、地址不带凭据、主导推送要项目允许。通过时返回 { ok: true, root, branch, remote, url, safeUrl, by, config }。
function prepare({ root, by, env }) {
  root = resolve(root);
  let actor;
  try { actor = pushActor({ by, env }); } catch (error) { return fail('BAD_ARGS', error.message); }
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return fail('NOT_GIT', `这个文件夹不是 git 仓库：${root}`);
  const config = readPushConfig(root);
  if (!config.ok) return config;
  const { baseBranch: branch, remote } = config;
  const got = git(root, ['remote', 'get-url', remote]);
  if (got.status !== 0) return fail('NO_REMOTE', `项目没有叫 ${remote} 的远程：先在终端里 git remote add ${remote} <地址>，或在项目配置里改 push.remote`);
  const url = got.stdout.trim();
  if (urlHasCredential(url)) return fail('CREDENTIAL_IN_URL', `远程 ${remote} 的地址里带了用户名或密码 / 令牌，已拒绝：改成不带凭据的地址，改用 Git Credential Manager 等凭据助手登录`, { remote, url: displayUrl(url) });
  if (actor === 'lead' && !config.allowLead) return fail('LEAD_NOT_ALLOWED', '项目没有开启允许主导推送：在项目配置里打开 push.allowLead，或由用户在软件里推送', { remote, url: displayUrl(url) });
  return { ok: true, root, branch, remote, url, safeUrl: displayUrl(url), by: actor, config };
}

// 取远程的主分支。返回 { ok: true, missing } 或失败对象；远程没有这个分支（couldn't find remote ref）不算失败，missing 为 true。
function fetchBranch(ctx, { env, home, exec }) {
  const result = exec(ctx.root, ['fetch', '--no-tags', ctx.remote, ctx.branch], { env: gitNetworkEnv(env, home), timeout: NET_TIMEOUT });
  if (result.status === 0) return { ok: true, missing: false };
  if (!result.timedOut && /couldn't find remote ref/i.test(result.stderr)) return { ok: true, missing: true };
  const { cause, error } = classifyFailure(result);
  return fail('FETCH_FAILED', `取远程状态失败：${error}`, { cause, remote: ctx.remote, url: ctx.safeUrl });
}

// ---------- push.jsonl ----------

const logFile = home => join(home, 'push.jsonl');
// 每次真正联网的推送 / 拉取追加一行（不含 --dry-run）。只记远程名，不记地址和 git 原始输出；写失败不影响操作。
function logOperation(home, op, ctx, { from, to, ok, code }) {
  try {
    mkdirSync(home, { recursive: true });
    appendFileSync(logFile(home), `${JSON.stringify({ v: 1, at: Date.now(), op, project: ctx.root, branch: ctx.branch, remote: ctx.remote, from: from ?? null, to: to ?? null, ok, by: ctx.by, ...(code ? { code } : {}) })}\n`);
  } catch { /* 记录写不了不影响推送本身。 */ }
}

// 这个项目最近一次成功推送的时间（毫秒时间戳）；没有或读不了返回 null。
export function lastPush(home, root) {
  try {
    let found = null;
    for (const line of readFileSync(logFile(home), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row?.op === 'push' && row.ok === true && typeof row.project === 'string' && same(row.project, root) && Number.isFinite(row.at)) found = row.at;
    }
    return found;
  } catch { return null; }
}

// ---------- ar push ----------

// 推送 baseBranch 到项目配置的远程。dryRun 只报告状态；noFetch 不联网，只读本地已有的远程跟踪分支。
export function pushBranch({ root, home, by = null, dryRun = false, noFetch = false, env = process.env, exec = runNetworkGit } = {}) {
  const ctx = prepare({ root, by, env });
  if (!ctx.ok) return ctx;
  const info = { remote: ctx.remote, url: ctx.safeUrl, branch: ctx.branch };
  let missing = false;
  if (!noFetch) {
    const fetched = fetchBranch(ctx, { env, home, exec });
    if (!fetched.ok) {
      if (!dryRun) logOperation(home, 'push', ctx, { ok: false, code: fetched.code });
      return fetched;
    }
    missing = fetched.missing;
  }
  const status = compare(ctx.root, ctx.branch, missing ? null : revParse(ctx.root, `refs/remotes/${ctx.remote}/${ctx.branch}`));
  if (!status.local) return fail('NO_BRANCH', `本机没有 ${ctx.branch} 分支，没有可推送的内容`, info);
  if (dryRun) return { ok: true, ...info, ahead: status.ahead, behind: status.behind, state: status.state, lastPush: lastPush(home, ctx.root) };
  const record = { from: status.tracking, to: status.local };
  if (status.behind > 0) {
    const code = 'BEHIND';
    logOperation(home, 'push', ctx, { ...record, ok: false, code });
    return fail(code, status.state === 'diverged' ? '本机和远程各有新提交，需要在终端里合并或 rebase' : `远程有本机没有的 ${status.behind} 个提交：先拉取`, { ...info, ahead: status.ahead, behind: status.behind, state: status.state });
  }
  if (status.state === 'same') return { ok: true, pushed: false, ...info };
  const refspec = `refs/heads/${ctx.branch}:refs/heads/${ctx.branch}`;
  const result = exec(ctx.root, ['push', '--no-follow-tags', ctx.remote, refspec], { env: gitNetworkEnv(env, home), timeout: NET_TIMEOUT });
  if (result.status !== 0) {
    // GitHub 的邮箱隐私保护（GH007）：提交里有账号不允许公开的邮箱。不改已有提交，只告诉用户该怎么办。
    if (EMAIL_PRIVACY.test(`${result.stderr}\n${result.stdout}`)) {
      const email = pushedAuthorEmail(ctx.root, ctx.branch, status.tracking);
      logOperation(home, 'push', ctx, { ...record, ok: false, code: 'EMAIL_PRIVACY' });
      return fail('EMAIL_PRIVACY', `GitHub 拒绝了这次推送：账号开了邮箱隐私保护，提交用的邮箱是 ${email ?? '（读不到）'}；把提交身份的邮箱换成 GitHub 的 noreply 地址后重新提交、推送`, { ...info, email });
    }
    let { cause, error } = classifyFailure(result);
    let code = cause === 'OTHER' ? 'PUSH_FAILED' : cause;
    if (cause === 'OTHER' && /non-fast-forward|fetch first|\[rejected\]/i.test(`${result.stderr}`)) { code = 'BEHIND'; error = '远程刚刚有了新提交，推送被拒绝：先拉取'; }
    logOperation(home, 'push', ctx, { ...record, ok: false, code });
    return fail(code, error, info);
  }
  logOperation(home, 'push', ctx, { ...record, ok: true });
  return { ok: true, pushed: true, ...info, from: record.from, to: record.to };
}

// ---------- ar pull（只快进）----------

export function pullBranch({ root, home, by = null, env = process.env, exec = runNetworkGit } = {}) {
  const ctx = prepare({ root, by, env });
  if (!ctx.ok) return ctx;
  const info = { remote: ctx.remote, url: ctx.safeUrl, branch: ctx.branch };
  const current = git(ctx.root, ['symbolic-ref', '--short', 'HEAD']);
  if (current.status !== 0 || current.stdout.trim() !== ctx.branch) {
    return fail('NOT_ON_BASE', `主工作区当前不在 ${ctx.branch} 上（${current.status === 0 ? current.stdout.trim() : '没有分支'}）：先 git switch ${ctx.branch}`, info);
  }
  const finish = (result, record) => { logOperation(home, 'pull', ctx, { ...record, ok: result.ok, code: result.code }); return result; };
  const fetched = fetchBranch(ctx, { env, home, exec });
  if (!fetched.ok) return finish(fetched, {});
  if (fetched.missing) return finish(fail('NO_UPSTREAM', `远程 ${ctx.remote} 还没有 ${ctx.branch} 分支，没有可拉取的内容`, info), {});
  const status = compare(ctx.root, ctx.branch, revParse(ctx.root, `refs/remotes/${ctx.remote}/${ctx.branch}`));
  const record = { from: status.local, to: status.tracking };
  if (!status.local) return fail('NO_BRANCH', `本机还没有 ${ctx.branch} 的提交，没有可快进的内容`, info);
  if (status.state === 'same') return { ok: true, pulled: false, ...info };
  if (status.state === 'diverged') return finish(fail('DIVERGED', '本机和远程各有新提交，需要在终端里合并或 rebase', { ...info, ahead: status.ahead, behind: status.behind }), record);
  if (status.state === 'ahead') return finish(fail('AHEAD', '本机有还没推送的提交，先推送', { ...info, ahead: status.ahead, behind: status.behind }), record);
  // 本地合并不联网；环境用 LC_ALL=C 让报错是英文，"会覆盖未提交的文件"才能稳定识别。
  const merged = exec(ctx.root, ['merge', '--ff-only', status.tracking], { env: { ...env, LC_ALL: 'C' }, timeout: NET_TIMEOUT });
  if (merged.status !== 0) {
    const text = `${merged.stderr}\n${merged.stdout}`;
    const overwrite = /would be overwritten|overwritten by merge/i.test(text);
    return finish(fail(overwrite ? 'WOULD_OVERWRITE' : 'MERGE_FAILED', tailText(text, 8) || '快进失败', info), record);
  }
  return finish({ ok: true, pulled: true, ...info, from: status.local, to: status.tracking }, record);
}

// ---------- ar projects show 的 remote 字段 ----------

// 只读本地已有的远程跟踪分支，不联网。没有远程时是 { name, exists: false }。
export function remoteSummary(root) {
  root = resolve(root);
  const config = readPushConfig(root);
  // 没有初始化 / 配置有问题时也尽量给出默认远程的信息（领先落后因不知道主分支而留空）。
  const name = config.ok ? config.remote : 'origin';
  const got = git(root, ['remote', 'get-url', name]);
  if (got.status !== 0) return { name, exists: false };
  const url = got.stdout.trim();
  const summary = { name, url: displayUrl(url), exists: true, ahead: null, behind: null, state: null };
  if (urlHasCredential(url)) summary.credentialInUrl = true;
  if (!config.ok) return summary;
  const status = compare(root, config.baseBranch, revParse(root, `refs/remotes/${name}/${config.baseBranch}`));
  return { ...summary, ahead: status.local ? status.ahead : null, behind: status.local ? status.behind : null, state: status.state };
}

// ---------- 文字输出 ----------

const range = (from, to) => `${from ? from.slice(0, 7) : '（新分支）'}..${to.slice(0, 7)}`;

export function pushLines(result) {
  if (result.state !== undefined && result.pushed === undefined) {
    const parts = { same: '和远程一样', ahead: `领先 ${result.ahead} 个提交`, behind: `落后 ${result.behind} 个提交`, diverged: `领先 ${result.ahead}、落后 ${result.behind} 个提交（分叉）`, noUpstream: `远程还没有这个分支（本机共 ${result.ahead} 个提交）` };
    return [`${result.branch} ${parts[result.state]}（远程 ${result.remote}，${result.url}）`, result.lastPush ? `最后推送：${new Date(result.lastPush).toLocaleString('zh-CN')}` : '还没有推送记录'];
  }
  if (result.pushed === false) return [`${result.branch} 和 ${result.remote} 一样，没有需要推送的提交`];
  return [`已推送 ${result.branch} 到 ${result.remote}（${range(result.from, result.to)}）`];
}

export function pullLines(result) {
  if (result.pulled === false) return [`${result.branch} 和 ${result.remote} 一样，没有需要拉取的提交`];
  return [`已快进 ${result.branch}（${range(result.from, result.to)}，来自 ${result.remote}）`];
}
