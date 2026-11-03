import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, renameSync, readFileSync, writeFileSync, readdirSync, createWriteStream } from 'node:fs';
import { readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { userDirectory } from './compat.mjs';
import { findOnPath, launcherFor } from './launcher.mjs';
import { planCommand, systemNodeSearch } from './command.mjs';
import { readConfig, updateConfig, configInvalid } from './config.mjs';
import { deployPreset, lastTestResult } from './agents.mjs';
import { allowedEnv } from './env.mjs';
import { killProcessTree } from './process.mjs';

const verified = '0.2.1-rc.2';

// 安装依赖的预计字节（界面引导文案写的"约 830 MB"是同一个数）：上次成功安装记下的值优先，没有就用它。
export const DSH_APPROX_MB = 830;
export const DSH_APPROX_BYTES = DSH_APPROX_MB * 1024 * 1024;
const { name: presetName, title, package: packageName } = deployPreset();
const unsafe = `无法安全清理 ${title} 目录`;

// 去掉版本号后比较两次测试失败的原因（D176）：换了版本仍然同一项失败，说明问题不在版本。
const versionInText = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g;
const sameReason = (a, b) => {
  const normalize = text => String(text ?? '').replace(versionInText, '').replace(/\s+/g, ' ').trim();
  const left = normalize(a), right = normalize(b);
  return left !== '' && left === right;
};

function locations(env) {
  const base = env.LOCALAPPDATA || (process.platform === 'win32'
    ? path.join(userDirectory(env), 'AppData', 'Local') : path.join(userDirectory(env), '.local', 'share'));
  const root = path.resolve(base, 'agent-router', 'tools');
  return { root, target: path.join(root, 'dsh') };
}

// 不穿过目录链接，包括工具根目录的祖先；不存在的部分不需要检查。
function assertSafe(root, target) {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(unsafe);
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(unsafe); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(unsafe); }
  }
}

const stateName = 'dsh.transaction.json';
function identity(file) {
  try {
    const st = lstatSync(file, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(unsafe);
    return { dev: String(st.dev), ino: String(st.ino) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error(unsafe); }
}
function same(a, b) { return !!a && !!b && a.dev === b.dev && a.ino === b.ino; }
function readTransaction(root, target) {
  assertSafe(root, target);
  if (!existsSync(root)) return null;
  const entries = readdirSync(root).filter(name => name.startsWith('dsh.transaction'));
  if (!entries.length) return null;
  if (entries.length !== 1 || entries[0] !== stateName) throw new Error(unsafe);
  const file = path.join(root, stateName);
  assertSafe(root, file);
  let state;
  try { if (!lstatSync(file).isFile()) throw new Error(); state = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(unsafe); }
  const validId = value => value === null || (value && /^\d+$/.test(value.dev) && /^\d+$/.test(value.ino));
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.pid) || state.pid < 1 || !Number.isSafeInteger(state.started) ||
      !/^dsh\.backup-\d+-[0-9a-f]+$/.test(state.backup) || !/^dsh\.staging-[0-9a-f]+$/.test(state.staging) ||
      !validId(state.old) || !validId(state.created) || (state.phase !== undefined && state.phase !== 'committed')) throw new Error(unsafe);
  for (const name of [state.backup, state.staging]) assertSafe(root, path.join(root, name));
  return state;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function recover(root, target, state) {
  const backup = path.join(root, state.backup), staging = path.join(root, state.staging);
  const temp = path.join(root, `dsh.state-${state.staging.slice('dsh.staging-'.length)}`);
  assertSafe(root, temp);
  let tempExists = false;
  try { if (!lstatSync(temp).isFile()) throw new Error(unsafe); tempExists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(unsafe); }
  const old = identity(backup), current = identity(target), staged = identity(staging);
  if ((old && !same(old, state.old)) || (staged && state.created && !same(staged, state.created))) throw new Error(unsafe);
  if (state.phase === 'committed') {
    if (!same(current, state.created) || staged) throw new Error(unsafe);
    if (old) rmSync(backup, { recursive: true });
    if (tempExists) rmSync(temp);
    rmSync(path.join(root, stateName));
    return;
  }
  if (state.old) {
    if (old) {
      if (current && !same(current, state.created)) throw new Error(unsafe);
    } else if (!same(current, state.old)) throw new Error(unsafe);
  } else if (old || (current && !same(current, state.created))) throw new Error(unsafe);
  if (current && same(current, state.created)) rmSync(target, { recursive: true });
  if (staged) rmSync(staging, { recursive: true });
  if (old) renameSync(backup, target);
  if (tempExists) rmSync(temp);
  rmSync(path.join(root, stateName));
}
function writeTransaction(root, state) {
  const file = path.join(root, stateName);
  const temp = path.join(root, `dsh.state-${state.staging.slice('dsh.staging-'.length)}`);
  assertSafe(root, temp);
  writeFileSync(temp, JSON.stringify(state), { flag: 'wx' });
  renameSync(temp, file);
}
function commitTransaction(root, target, state) {
  state.phase = 'committed';
  writeTransaction(root, state);
  recover(root, target, state);
}
export function cleanupDsh({ env = process.env, undeploy = false } = {}) {
  const { root, target } = locations(env);
  try {
    const state = readTransaction(root, target);
    if (state) {
      if (alive(state.pid)) throw new Error(unsafe);
      recover(root, target, state);
    }
    if (undeploy) rmSync(target, { recursive: true, force: true });
  } catch { throw new Error(unsafe); }
  return { ok: true };
}

// npm 安装约 830 MB，界面写的预计用时是 3～10 分钟：npm 给 30 分钟上限（取消由软件结束进程树完成），其余调用（--version 等）仍是 2 分钟（280 执行者发现）。
const NPM_TIMEOUT_MS = 30 * 60000, PROGRAM_TIMEOUT_MS = 120000;
// launcherFor 把 Node 入口（npm 包装里的 .js）交给系统 Node（430 D176）；软件里找不到系统 Node 时它退回自带的
// Electron 运行时，但 dsh 检查运行时指纹、一定失败，所以这里直接报"装 Node.js"并列出找过的位置。
function launch(file, args, env, npm = false) {
  const launcher = npm ? planCommand([file, ...args], { env })
    : launcherFor(file, { missing: '程序不存在', unwrapError: () => '无法解析程序启动包装', env });
  if (!npm && launcher.runtime === 'bundled') {
    const { searched } = systemNodeSearch({ wrapperDir: path.dirname(file), env });
    const shown = [...new Set(searched)].slice(0, 6).join('、');
    throw new Error(`找不到 Node.js：${title} 需要系统里装有 Node.js（用 npm 安装它时就需要）${shown ? `；已找过：${shown}` : ''}`);
  }
  return spawnSync(launcher.executable, npm ? launcher.args : [...launcher.args, ...args], { env, encoding: 'utf8', shell: false, windowsHide: true, timeout: npm ? NPM_TIMEOUT_MS : PROGRAM_TIMEOUT_MS, windowsVerbatimArguments: launcher.verbatim });
}

// 下载在子进程里发（与 probe.mjs 同一做法）：Node 24 的 fetch 只有启动前设了 NODE_USE_ENV_PROXY=1 才认 HTTP(S)_PROXY，
// 子进程的环境带上代理变量与这个开关；请求本身用 Node 自带的 fetch，不引入依赖。进度按行写回标准输出。
const DOWNLOAD_CHILD = `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const { url, file, idleMs } = JSON.parse(input);
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  const controller = new AbortController();
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), idleMs); };
  const stop = () => { clearTimeout(timer); };
  let bytes = 0;
  try {
    arm();
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) { stop(); send({ error: 'status', status: response.status }); return; }
    const total = Number(response.headers.get('content-length')) || null;
    send({ total });
    const out = fs.createWriteStream(file);
    try {
      for await (const chunk of response.body) {
        arm();
        bytes += chunk.length;
        if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
        send({ bytes });
      }
    } finally { await new Promise(resolve => out.end(resolve)); }
    stop();
    send({ done: true, bytes });
  } catch (error) {
    stop();
    send({ error: controller.signal.aborted ? 'timeout' : 'fetch', message: String(error && (error.cause && (error.cause.code || error.cause.message) || error.message) || error).slice(0, 200) });
  }
});
`;

function downloadInChild({ url, file, env, onProgress, idleMs = 60000 }) {
  return new Promise(resolve => {
    let child, settled = false, buffer = '', total = null, bytes = 0, final = null;
    const done = value => { if (settled) return; settled = true; resolve(value); };
    try {
      child = spawn(process.execPath, ['-e', DOWNLOAD_CHILD], {
        env: { ...allowedEnv({ base: env }), NODE_USE_ENV_PROXY: '1', ELECTRON_RUN_AS_NODE: '1' },
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (error) { done({ ok: false, message: `下载失败：${error.message}` }); return; }
    const handle = line => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (typeof value.total === 'number' && value.total > 0) total = value.total;
      if (typeof value.bytes === 'number') { bytes = value.bytes; onProgress({ bytes, total }); }
      if (value.done) final = { ok: true, bytes, total };
      if (value.error) final = value.error === 'status' ? { ok: false, message: `HTTP ${value.status}` }
        : value.error === 'timeout' ? { ok: false, message: '60 秒没有收到数据' } : { ok: false, message: `下载失败：${value.message ?? '网络错误'}` };
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
    });
    child.on('error', error => { final ??= { ok: false, message: `下载失败：${error.message}` }; });
    child.on('close', () => { if (buffer) handle(buffer); done(final ?? { ok: false, message: '下载没有返回结果' }); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ url, file, idleMs }), 'utf8');
  });
}

// 测试注入的 fetch：返回带 ok / status / headers / body 的对象即可（与标准 Response 一致）。
async function downloadWithFetch({ url, file, fetchImpl, onProgress }) {
  let response;
  try { response = await fetchImpl(url, { redirect: 'follow' }); }
  catch (error) { return { ok: false, message: `下载失败：${error?.message ?? error}` }; }
  if (!response || !response.ok) return { ok: false, message: `HTTP ${response?.status ?? '未知'}` };
  const header = response.headers?.get?.('content-length');
  const total = header === null || header === undefined || header === '' ? null : Number(header) || null;
  const out = createWriteStream(file);
  let bytes = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        const data = Buffer.from(chunk);
        bytes += data.length;
        if (!out.write(data)) await new Promise(resolve => out.once('drain', resolve));
        onProgress({ bytes, total });
      }
    }
  } catch (error) {
    out.destroy();
    return { ok: false, message: `下载失败：${error?.message ?? error}` };
  } finally {
    await new Promise(resolve => out.end(resolve));
  }
  return { ok: true, bytes, total };
}

// 取安装包：先 npm view 拿包地址，再下载；任何一步不通就换 npm pack（npm 自己处理镜像、私有源登录、代理、证书）。
// 两条路都失败才算失败，原因写两条路各自的错误。
async function fetchPackage({ npm, spec, staging, env, step, fetchImpl, idleMs }) {
  const message = '正在下载安装包';
  let viewError = null, url = null;
  try {
    const r = launch(npm, ['view', spec, 'dist.tarball', 'dist.unpackedSize', '--json'], env, true);
    if (r.error || r.status !== 0) throw new Error(r.error?.code ?? `退出码 ${r.status}`);
    const data = JSON.parse(r.stdout);
    url = typeof data?.['dist.tarball'] === 'string' && data['dist.tarball'] ? data['dist.tarball'] : null;
    if (!url) throw new Error('没有返回包地址');
  } catch (error) { viewError = error.message; }
  if (url) {
    step('download', message, { percent: 0 });
    const file = path.join(staging, 'package.tgz');
    let lastAt = 0;
    const onProgress = value => {
      const now = Date.now();
      if (now - lastAt < 300) return;
      lastAt = now;
      if (value.total) step('download', message, { percent: Math.min(99, Math.round(value.bytes / value.total * 100)), bytes: value.bytes, total: value.total });
      else step('download', message, { bytes: value.bytes });
    };
    const result = fetchImpl ? await downloadWithFetch({ url, file, fetchImpl, onProgress }) : await downloadInChild({ url, file, env, onProgress, idleMs });
    if (result.ok) {
      // 没有 Content-Length 时中途只报字节；结束时同样报一次 100，界面靠它画满格。
      if (result.total) step('download', message, { percent: 100, bytes: result.bytes, total: result.total });
      else step('download', message, { percent: 100, bytes: result.bytes });
      return file;
    }
    rmSync(file, { force: true });
    viewError = result.message;
  }
  step('download', message, { fallback: true });
  let packError = null;
  try {
    const r = launch(npm, ['pack', spec, '--pack-destination', staging], env, true);
    if (r.error || r.status !== 0) throw new Error(r.error?.code ?? `退出码 ${r.status}`);
    const printed = String(r.stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => /\.tgz$/i.test(line)).at(-1);
    if (!printed || !existsSync(path.join(staging, printed))) {
      if (!readdirSync(staging).some(entry => /\.tgz$/i.test(entry))) throw new Error('没有生成安装包');
    }
  } catch (error) { packError = error.message; }
  if (packError) throw new Error(`${url ? '下载安装包失败' : '查不到安装包地址'}：${viewError ?? '未知原因'}；改用 npm pack 也失败：${packError}`);
  const found = readdirSync(staging).find(entry => /\.tgz$/i.test(entry));
  step('download', message, { percent: 100 });
  return path.join(staging, found);
}

// 目录总字节数：自己遍历（不调 du / PowerShell），不跟随目录链接；读不到的文件跳过。
export async function directorySize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += (await lstat(full)).size; } catch { /* 读不到的文件不计数 */ }
      }
    }
  }
  return total;
}

// 安装依赖：npm install 期间每秒统计一次目标目录大小，按预计字节折算成大致百分比（最多 99，结束才报 100）。
function installDeps({ npm, target, tarball, env, step, dirSize, expected }) {
  const message = '正在安装依赖';
  step('deps', message, { percent: 0, approx: true });
  return new Promise(resolve => {
    let child, settled = false, sampling = false, sampler = null, timer = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearInterval(sampler);
      clearTimeout(timer);
      resolve(value);
    };
    try {
      const launcher = planCommand([npm, 'install', '--prefix', target, tarball], { env });
      child = spawn(launcher.executable, launcher.args, { env, shell: false, windowsHide: true, windowsVerbatimArguments: launcher.verbatim });
    } catch (error) { resolve({ error: error.message }); return; }
    const sample = async () => {
      if (sampling || settled) return;
      sampling = true;
      try {
        const bytes = await dirSize(path.join(target, 'node_modules'));
        // 统计目录要几秒：期间安装可能已结束并报过 100，这时不再补发旧百分比（423 审查 R3-1）。
        if (settled) return;
        // 拿不到字节数就不报这一步的进度（不报空对象）；有字节但算不出百分比时只报字节。
        if (!Number.isFinite(bytes)) return;
        const percent = Math.min(99, Math.round(bytes / expected * 100));
        step('deps', message, Number.isFinite(percent) ? { percent, approx: true, bytes } : { bytes });
      } catch { /* 统计目录出错：这一步不报进度 */ }
      finally { sampling = false; }
    };
    sampler = setInterval(sample, 1000);
    timer = setTimeout(async () => {
      try { if (child.pid) await killProcessTree(child.pid); } catch { /* 进程可能已经结束 */ }
      finish({ error: '超过 30 分钟没有结束，已结束进程树' });
    }, NPM_TIMEOUT_MS);
    child.on('error', error => finish({ error: error.code ?? error.message }));
    child.on('close', code => finish({ error: null, code }));
  });
}

function detect(file, env) {
  if (!file || !existsSync(file)) return null;
  try {
    const r = launch(file, ['--version'], env);
    const version = String(r.stdout ?? '').match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/)?.[0];
    return !r.error && r.status === 0 && version ? { path: file, version } : null;
  } catch { return null; }
}

function queryVersions(npm, env) {
  let tags = {}, versions = [], warning;
  try {
    const r = launch(npm, ['view', packageName, 'dist-tags', 'versions', '--json'], env, true);
    if (r.error || r.status !== 0) throw new Error(r.error?.code ?? `退出码 ${r.status}`);
    const data = JSON.parse(r.stdout);
    if (!data || !data['dist-tags'] || typeof data['dist-tags'] !== 'object' || !Array.isArray(data.versions)) throw new Error('返回数据无效');
    tags = Object.fromEntries(Object.entries(data['dist-tags']).filter(([, value]) => typeof value === 'string'));
    versions = data.versions.filter(value => typeof value === 'string').slice(-10).reverse();
  } catch (error) { warning = `查不到最新版本（${error.message}）`; }
  return { tags, recommended: tags.next ?? tags.latest ?? verified, versions, ...(warning ? { warning } : {}) };
}

export function checkDsh({ env = process.env } = {}) {
  const { target } = locations(env);
  const names = process.platform === 'win32' ? ['dsh.exe', 'dsh.cmd'] : ['dsh'];
  const managed = path.join(target, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  const found = detect(managed, env) ?? detect(findOnPath(names, env), env);
  const npm = findOnPath(process.platform === 'win32' ? ['npm.cmd'] : ['npm'], env);
  if (!npm) throw new Error('没有找到 npm，请先安装 Node.js 后重试');
  const info = queryVersions(npm, env);
  return { ok: true, verified, ...info, installed: found?.version ?? null, path: found?.path ?? null,
    updateAvailable: !!found && info.recommended !== found.version };
}

function snapshotAgent(home) {
  const state = readConfig(home);
  if (state.reason) throw configInvalid(state);
  const config = state.exists ? state.config : state.legacy?.config ?? {};
  const profile = structuredClone(config.profiles?.[presetName]);
  const ref = typeof profile?.generic === 'string' ? profile.generic : null;
  return { profile, ref, declaration: ref ? structuredClone(config.generics?.[ref]) : undefined, defaultProfile: config.defaultProfile };
}

function restoreAgent(home, snapshot) {
  updateConfig(home, config => {
    const current = config.profiles?.[presetName];
    const newRef = typeof current?.generic === 'string' ? current.generic : null;
    if (newRef && newRef !== snapshot.ref && !Object.entries(config.profiles ?? {}).some(([name, profile]) => name !== presetName && profile.generic === newRef)) delete config.generics?.[newRef];
    config.profiles ??= {};
    if (snapshot.profile === undefined) delete config.profiles[presetName];
    else config.profiles[presetName] = snapshot.profile;
    if (snapshot.ref) {
      config.generics ??= {};
      if (snapshot.declaration === undefined) delete config.generics[snapshot.ref];
      else config.generics[snapshot.ref] = snapshot.declaration;
    }
    if (snapshot.profile === undefined && config.defaultProfile === presetName) {
      if (snapshot.defaultProfile === undefined) delete config.defaultProfile;
      else config.defaultProfile = snapshot.defaultProfile;
    }
  });
}

export async function deployDsh({ env = process.env, home = env.AGENT_ROUTER_HOME, step, importAgent, test, version, fetch: fetchImpl, dirSize = directorySize, idleMs }) {
  const { root, target } = locations(env);
  if (readTransaction(root, target)) throw new Error(unsafe);
  const names = process.platform === 'win32' ? ['dsh.exe', 'dsh.cmd'] : ['dsh'];
  const managed = path.join(target, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  step('download', `正在检测 ${title}`, { percent: 0 });
  const oldManaged = detect(managed, env);
  let markedVersion, markedBytes;
  try {
    const marker = JSON.parse(readFileSync(path.join(target, '.agent-router-dsh.json'), 'utf8'));
    if (typeof marker.version === 'string' && marker.version) markedVersion = marker.version;
    if (Number.isSafeInteger(marker.bytes) && marker.bytes > 0) markedBytes = marker.bytes;
  } catch {}
  const oldVersion = oldManaged?.version ?? markedVersion;
  let found = oldManaged ?? detect(findOnPath(names, env), env);
  let backup, transaction;
  if (!found || (version !== undefined && found.version !== version)) {
    step('download', '正在检测 npm', { percent: 0 });
    const npm = findOnPath(process.platform === 'win32' ? ['npm.cmd'] : ['npm'], env);
    if (!npm) throw new Error('没有找到 npm，请先安装 Node.js 后重试');
    const requested = version ?? queryVersions(npm, env).recommended;
    let packageDir;
    try {
      assertSafe(root, target);
      mkdirSync(root, { recursive: true });
      // 先下载到系统临时目录：下载失败或取消时不用回退已经动过的安装目录。
      packageDir = mkdtempSync(path.join(tmpdir(), 'ar-dsh-download-'));
      const tarball = await fetchPackage({ npm, spec: `${packageName}@${requested}`, staging: packageDir, env, step, fetchImpl, idleMs });
      const nonce = `${process.pid.toString(16)}${Math.random().toString(16).slice(2)}`;
      const pending = { version: 1, pid: process.pid, started: Date.now(), backup: `dsh.backup-${Date.now()}-${nonce}`, staging: `dsh.staging-${nonce}`, old: identity(target), created: null };
      const stateFile = path.join(root, stateName), staging = path.join(root, pending.staging);
      assertSafe(root, stateFile); assertSafe(root, staging);
      try { writeFileSync(stateFile, JSON.stringify(pending), { flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') throw new Error(unsafe); throw error; }
      transaction = pending;
      mkdirSync(staging);
      transaction.created = identity(staging);
      writeTransaction(root, transaction);
      if (transaction.old) {
        const candidate = path.join(root, transaction.backup);
        assertSafe(root, candidate);
        if (existsSync(candidate)) throw new Error('备份目录已存在');
        renameSync(target, candidate);
        backup = candidate;
      }
      renameSync(staging, target);
      const r = await installDeps({ npm, target, tarball, env, step, dirSize, expected: markedBytes ?? DSH_APPROX_BYTES });
      if (r.error || r.code !== 0) throw new Error(r.error ?? `退出码 ${r.code}`);
      step('deps', '正在安装依赖', { percent: 100 });
      found = detect(managed, env);
      if (!found || found.version !== requested) throw new Error('安装后无法验证程序或版本');
    } catch (error) {
      if (transaction) recover(root, target, transaction);
      if (error.message === unsafe) throw error;
      if (backup && oldVersion) throw new Error(`安装 ${title} 失败：${error.message}，已退回 ${oldVersion}`);
      throw new Error(`安装 ${title} 失败：${error.message}`);
    } finally {
      if (packageDir) rmSync(packageDir, { recursive: true, force: true });
    }
  }
  let snapshot;
  try {
    if (backup && home) snapshot = snapshotAgent(home);
    step('config', '正在导入执行者', { percent: 0 });
    await importAgent(found.path);
    step('config', '正在导入执行者', { percent: 50 });
  } catch (error) {
    if (backup && oldVersion) {
      recover(root, target, transaction);
      if (snapshot) restoreAgent(home, snapshot);
      throw new Error(`导入失败，已退回 ${oldVersion}：${error.message}`);
    }
    if (transaction) commitTransaction(root, target, transaction);
    throw error;
  }
  // 上一次测试的记录要在 test() 覆盖它之前读出来（test 内部会把本次结果写回 agent-tests.json）。
  let previous = null;
  try { if (home) previous = lastTestResult(home, presetName); } catch { previous = null; }
  let result, testError;
  try { step('test', '正在测试连接'); result = await test(); }
  catch (error) { testError = error; }
  if (testError || !result?.ok) {
    const reason = testError ? `连接测试失败（${testError.message}）`
      : result?.timedOut ? '连接测试超时' : `连接测试失败（退出码 ${result?.exit ?? '未知'}）`;
    const cause = testError ? testError.message : result?.error ?? null;
    const repeated = previous?.ok === false && sameReason(previous.error, cause);
    const bothFailed = `两个版本都没通过同一项测试：${reason}；问题不在版本，先按原因处理`;
    if (backup && oldVersion) {
      recover(root, target, transaction);
      if (snapshot) restoreAgent(home, snapshot);
      throw new Error(repeated ? bothFailed : `新版本测试失败（${reason}），已退回 ${oldVersion}`);
    }
    if (transaction) commitTransaction(root, target, transaction);
    if (repeated) throw new Error(bothFailed);
    if (found.version !== verified) return { ok: false, error: `这个版本（${found.version}）和 AgentRouter 不兼容：${reason}`, incompatible: true, fallback: verified };
    throw new Error(reason);
  }
  if (found.path === managed) {
    assertSafe(root, target);
    let bytes = null;
    try { bytes = await dirSize(path.join(target, 'node_modules')); } catch { bytes = null; }
    writeFileSync(path.join(target, '.agent-router-dsh.json'), JSON.stringify(Number.isSafeInteger(bytes) && bytes >= 0 ? { version: found.version, bytes } : { version: found.version }));
  }
  if (transaction) commitTransaction(root, target, transaction);
  step('config', '配置完成', { percent: 100 });
  return { ok: true, path: found.path, version: found.version, imported: true, verified: found.version === verified, unverified: found.version !== verified };
}
