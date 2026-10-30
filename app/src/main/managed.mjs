import { parentPort, workerData } from 'node:worker_threads';
import { watch, existsSync, mkdirSync, readdirSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

function completeRejection(file, readJson) {
  try { return typeof readJson(file)?.reason === 'string'; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

export function rejectManaged(file, reason, readJson, onError, io = { writeFileSync, renameSync, unlinkSync }) {
  const target = file.replace(/\.(request|claimed)\.json$/, '.rejected.json');
  try {
    if (!completeRejection(target, readJson)) {
      let value;
      try { value = readJson(file); } catch (e) { if (e.code === 'ENOENT') return; if (!(e instanceof SyntaxError)) throw e; value = {}; }
      io.writeFileSync(target + '.tmp', JSON.stringify({ ...value, reason }), { mode: 0o600 });
      io.renameSync(target + '.tmp', target);
    }
    try { io.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  } catch (e) { onError(e); }
}

// 执行者可以用系统 Node，也可以用软件自带的 Node（AgentRouter.exe / 开发时 electron.exe，需 ELECTRON_RUN_AS_NODE=1）。
const runtimes = ['node', 'node.exe', 'agentrouter.exe', 'electron.exe'];
const embedded = node => !['node', 'node.exe'].includes(basename(node).toLowerCase());
// onWarn：已经自动恢复、不影响使用的情况，只打一行说明（不带堆栈），避免看起来像崩溃。
// spawnProcess：启动执行者的函数，默认 child_process.spawn，可注入以模拟启动失败（Linux 上无执行权限是 'error' 事件，Windows 上多为同步抛出）。
export async function createManaged(root, env = process.env, onError = console.error, onWarn = message => console.warn(message), spawnProcess = spawn) {
  const load = file => import(pathToFileURL(join(root, file)).href);
  const [install, config, common, options, json] = await Promise.all([
    load('installer/lib/install.mjs'), load('core/lib/config.mjs'), load('core/lib/managed.mjs'),
    load('core/lib/options.mjs'), load('core/lib/json.mjs')]);
  const home = config.homeDirectory(env), dir = join(home, 'managed');
  const terminal = new Map(), preflightErrors = new Map();
  let watcher, timer, closed = false;
  const remove = file => { try { unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') onError(e); } };
  const reject = (file, reason) => rejectManaged(file, reason, json.readJson, onError);
  function verify(r, file) {
    if (!common.validRequest(r) || basename(file) !== r.id + '.request.json') return '请求文件无效';
    try {
      if (!statSync(common.existingPaths(r.repo, r.name).progress).isFile()) return '请求文件无效';
      const details = options.taskDetails(r.repo, { task: r.args.task, extra: r.args.extra, opts: { name: r.name, role: r.args.role } });
      if (details.spec !== r.args.spec) return '请求文件无效';
    } catch { return '请求文件无效'; }
    let owned = false;
    try {
      // 技能布局：<技能目录>/core/ar.mjs，安装记录在 <技能目录>/.agent-router.json。
      const skillDir = dirname(dirname(r.script));
      const marker = json.readJson(join(skillDir, '.agent-router.json'));
      owned = basename(r.script) === 'ar.mjs' && basename(dirname(r.script)) === 'core' && install.hosts.includes(marker.host)
        && install.installationStatus(skillDir, marker.host, 'agent-router').state === 'owned';
    } catch { /* 没有有效安装记录就不能执行。 */ }
    if (!owned) return '派发脚本不是由 AgentRouter 安装的，或者被改过';
    try { if (!runtimes.includes(basename(r.node).toLowerCase()) || !statSync(r.node).isFile()) return 'node 路径无效'; }
    catch { return 'node 路径无效'; }
    return null;
  }
  function launch(r, claimed) {
    const failed = error => reject(claimed, `启动 Codex 失败：${error.message}`);
    // 继承软件环境，请求只覆盖协议白名单；Windows 环境变量名不区分大小写。
    const childEnv = { ...env };
    for (const [key, value] of Object.entries(r.env)) {
      if (process.platform === 'win32') {
        for (const existing of Object.keys(childEnv)) if (existing.toLowerCase() === key.toLowerCase()) delete childEnv[existing];
      }
      childEnv[key] = value;
    }
    childEnv.AGENT_ROUTER_HOME = home;
    if (embedded(r.node)) childEnv.ELECTRON_RUN_AS_NODE = '1';
    try {
      const child = spawnProcess(r.node, [r.script, '--run-request', claimed], { cwd: r.repo, env: childEnv, detached: true, stdio: 'ignore', shell: false, windowsHide: true });
      child.on('error', failed); child.unref();
    } catch (error) { failed(error); }
  }
  function scan() {
    if (closed) return;
    const names = readdirSync(dir), present = new Set(names);
    for (const name of preflightErrors.keys()) if (!present.has(name)) preflightErrors.delete(name);
    for (const name of names) {
      const file = join(dir, name);
      if (name.endsWith('.request.json')) {
        const rejected = file.replace(/\.request\.json$/, '.rejected.json');
        // 清理源失败后，已发布的回执优先，不能再次启动执行者。
        let complete;
        try { complete = completeRejection(rejected, json.readJson); preflightErrors.delete(name); }
        catch (e) {
          // 回执无法读取时不能确定是否已经拒绝，跳过本请求并继续扫描其他请求。
          const key = `${e.code ?? ''}:${e.message}`;
          if (preflightErrors.get(name) !== key) { preflightErrors.set(name, key); onError(e); }
          continue;
        }
        if (complete) { remove(file); continue; }
        let r; try { r = json.readJson(file); } catch { reject(file, '请求文件无效'); continue; }
        const reason = verify(r, file); if (reason) { reject(file, reason); continue; }
        const claimed = file.replace(/\.request\.json$/, '.claimed.json');
        try { renameSync(file, claimed); } catch (e) { if (e.code !== 'ENOENT') onError(e); continue; }
        launch(r, claimed);
      }
      if (/\.(claimed|running|rejected|withdrawn)\.json$/.test(name)) {
        const id = name.replace(/\.(claimed|running|rejected|withdrawn)\.json$/, '');
        let read = terminal.get(id);
        if (!read) {
          // 带 retry 的请求（协议 14.3 / 14.4）：只认本次尝试（同编号 resume 之后）的终结事件。
          // 读不出 JSON 按没有 retry 处理（与改动前一致）；文件刚好被改名读不到就留到下一轮。
          let n = null;
          try {
            const retry = json.readJson(file)?.retry;
            if (Number.isSafeInteger(retry?.n) && retry.n > 0) n = retry.n;
          } catch (e) { if (e.code === 'ENOENT') continue; }
          read = common.terminalReader(home, id, undefined, n); terminal.set(id, read);
        }
        if (read()) { remove(file); terminal.delete(id); }
      }
    }
  }
  // 同一个错误连续出现只报一次（轮询每 200ms 一次），扫描成功后清除；不同的错误照常报告。
  let lastError = '', missing = false;
  const report = e => { const key = `${e.code ?? ''}:${e.path ?? ''}:${e.message}`; if (key !== lastError) { lastError = key; onError(e); } };
  function listen() {
    watcher?.close();
    watcher = watch(dir, safeScan);
    watcher.on('error', e => { if (closed) return; if (existsSync(dir)) report(e); else lost(); });
  }
  // 运行中托管目录被删除（演示中实测为 Electron GPU 子进程经 NVIDIA 驱动组件删除空目录，原因待查）：报告一次；公共目录还在就只重建 managed 这一层并重新监听，
  // 公共目录也没了就不重建整条路径，暂停接收，之后轮询发现公共目录回来再恢复。退出阶段（closed）不会走到这里。
  function lost() {
    if (closed) return;
    // 旧监听句柄先释放：Windows 上目录句柄未关时删除会停在"删除挂起"，新建同名目录会失败。
    watcher?.close(); watcher = undefined;
    let created = true;
    try { mkdirSync(dir); }
    catch (e) {
      if (e.code === 'ENOENT') {
        if (!missing) { missing = true; onError(Error(`托管请求目录和公共目录都不存在，暂停接收托管请求：${dir}`, { cause: e })); }
        return;
      }
      if (e.code !== 'EEXIST') { report(e); return; }
      created = false;   // 派活方写请求时已经建回来了，只需重新监听。
    }
    onWarn(`警告：托管请求目录在运行中被删除，${created ? '已重新创建' : '已被派活方重建'}，继续监听：${dir}`);
    missing = false; lastError = '';
    listen();
  }
  function safeScan() {
    if (closed) return;
    try { scan(); lastError = ''; }
    catch (e) {
      if (closed) return;
      if (e.code === 'ENOENT' && e.path === dir) lost(); else report(e);
    }
  }
  return {
    // 初始化失败（目录建不出来、读不了、监听不了）直接抛出，由主进程报告并退出，不进入轮询。
    start() {
      try {
        mkdirSync(dir, { recursive: true });
        for (const name of readdirSync(dir)) {
          const file = join(dir, name);
          try { const info = statSync(file); if (info.isFile() && info.mtimeMs < Date.now() - 86400000) remove(file); }
          catch (e) { if (e.code !== 'ENOENT') onError(e); }
        }
        listen();
      } catch (e) { throw Error(`托管请求目录初始化失败：${dir}：${e.message}`, { cause: e }); }
      timer = setInterval(safeScan, 200); safeScan();
    },
    scan,
    close() { closed = true; watcher?.close(); clearInterval(timer); }
  };
}
if (parentPort) {
  const service = await createManaged(workerData.root);
  service.start(); parentPort.postMessage('ready');
  parentPort.on('message', () => { service.close(); parentPort.close(); });
}
