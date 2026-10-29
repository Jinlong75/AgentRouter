// 运行 node --test，并在 PATH 最前面放一个"哨兵" codex（Stage05：哨兵查出 agents-cli 与 home-guard 的测试
// 从继承的 PATH 找到了真实 codex，在用户真实的 ~/.codex 里运行了 --version 与 login status）。任何测试从继承的 PATH 里找到 codex 都会拿到哨兵而不是真程序；哨兵把每次调用
// 记进日志，测试结束后日志非空就让 verify 失败并列出调用。测试自己用夹具（自己的 PATH 或 settings.path）
// 提供的假 codex 不受影响。零依赖。
// 065：node --test 的完整输出在照常写到终端的同时，另落一份到系统临时目录的 agent-router-verify
// （AR_VERIFY_LOG_DIR 可注入目录，测试用），只保留最近 20 份，最后一行打印日志路径。
// 不改退出码与哨兵行为。
// 069：同时让 node --test 另写一份同名 .tap（TAP 里整个测试文件失败时带 exitCode / signal 等细节），同样只保留 20 份。
// 186（D121）：测试进程的 TEMP / TMP / TMPDIR 指向这次 verify 专用的临时目录，里面每个测试文件一个子目录；
// 测试结束后还剩东西（临时目录、还在运行的进程）就让 verify 失败并按测试文件列出，最后整个专用目录删掉。
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree, processList } from '../core/lib/process.mjs';

// 保留的日志份数（协议外的工程约定）。
export const KEEP_LOGS = 20;

// 日志目录：优先 AR_VERIFY_LOG_DIR（单元测试注入自己的临时目录，不写真实位置），否则系统临时目录下的 agent-router-verify。
export function verifyLogDir(env = process.env) {
  return env.AR_VERIFY_LOG_DIR || path.join(tmpdir(), 'agent-router-verify');
}

// 文件名带时间戳、按字典序即时间序：yyyyMMdd-HHmmss-SSS.log。
export function logFileName(now = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}.log`;
}

// 069：同一时刻另有一份 node:test 的 TAP 输出（带每个失败测试文件的 exitCode / signal 等细节），文件名同 .log，扩展名 .tap。
export function tapFileName(now = new Date()) {
  return logFileName(now).replace(/\.log$/, '.tap');
}

// 只保留最近 keep 份（按文件名时间序，.log 与 .tap 各自计数），旧的删除；删除失败不挡本次 verify。
export function pruneVerifyLogs(dir, keep = KEEP_LOGS) {
  let all;
  try { all = readdirSync(dir); }
  catch { return []; }
  const removed = [];
  for (const extension of ['.log', '.tap']) {
    const files = all.filter(name => name.endsWith(extension)).sort();
    for (const name of files.slice(0, Math.max(0, files.length - keep))) {
      try { rmSync(path.join(dir, name), { force: true }); removed.push(name); }
      catch { /* 删不掉的留给下次。 */ }
    }
  }
  return removed;
}

// 写一份日志并顺手清理旧的；返回日志文件路径。
export function saveVerifyLog(dir, content, now = new Date()) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, logFileName(now));
  writeFileSync(file, content, 'utf8');
  pruneVerifyLogs(dir);
  return file;
}

// 186：这次 verify 专用的临时目录。建在系统临时目录下，TEMP / TMP / TMPDIR 指向它的是测试进程，不影响同时在跑的别的任务。
export function createTempRoot(prefix = 'ar-verify-tmp-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// 测试进程的预加载（node --import 的 data: 地址，不需要额外文件）：每个测试文件的进程把自己的 TEMP / TMP / TMPDIR
// 换成专用目录下以测试文件名命名的子目录，它起的子进程继承这个环境，遗留物就能按测试文件分开。
export function tempImportArg(root) {
  // 子目录名是测试文件相对当前目录的路径（分隔符换成 __），不同目录下的同名文件（unit/ 与 integration/ 的 command.test.mjs）不混。
  const source = `import { mkdirSync } from 'node:fs'; import { basename, isAbsolute, join, relative, sep } from 'node:path';
const rel = process.argv[1] ? relative(process.cwd(), process.argv[1]) : '';
const file = rel ? (rel.startsWith('..') || isAbsolute(rel) ? basename(rel) : rel).split(sep).join('__').replace(/[^\\w.-]/g, '_') : '';
if (file) {
  const dir = join(${JSON.stringify(root)}, file);
  mkdirSync(dir, { recursive: true });
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = dir;
}
`;
  return `--import=data:text/javascript,${encodeURIComponent(source)}`;
}

// 测试进程（node --test 本身）的环境：TEMP 等也指向专用目录。
export function withTempRoot(env, root) {
  return { ...env, TEMP: root, TMP: root, TMPDIR: root };
}

const TEST_FILE_DIR = /\.(?:mjs|cjs|js|ts)$/;
// 子目录名还原成测试文件路径（tests__unit__a.test.mjs → tests/unit/a.test.mjs）；不属于任何测试文件的是 null。
const fileLabel = name => name === null ? '（不属于任何测试文件）' : name.replaceAll('__', '/');

// 列出专用目录里还剩的东西：[{ file, entries }]，file 是测试文件名（不属于任何测试文件的是 null）。空的子目录不算。
export function scanTempLeftovers(root) {
  let top;
  try { top = readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  const found = [];
  for (const entry of top) {
    if (entry.isDirectory() && TEST_FILE_DIR.test(entry.name)) {
      let inside = [];
      try { inside = readdirSync(path.join(root, entry.name)); } catch { /* 读不了就当没有。 */ }
      if (inside.length) found.push({ file: entry.name, entries: inside });
    } else {
      const other = found.find(item => item.file === null) ?? (found.push({ file: null, entries: [] }), found.at(-1));
      other.entries.push(entry.name);
    }
  }
  return found;
}

// 命令行里带着专用目录路径的进程（测试留下的、还在运行的进程）：[{ pid, name, file }]；file 是它所在的测试文件子目录名。
// 查询失败返回 null。
export async function findLeftoverProcesses(root, list = processList) {
  let rows;
  try { rows = await list(); }
  catch { return null; }
  const norm = text => String(text ?? '').toLowerCase().replaceAll('/', '\\');
  const needle = `${norm(root)}\\`;
  return rows
    .filter(row => row.pid !== process.pid && row.parent !== process.pid && norm(row.command).includes(needle))
    .map(row => {
      const rest = norm(row.command).split(needle)[1] ?? '';
      const first = rest.split(/[\\"'\s]/)[0];
      return { pid: row.pid, name: row.name ?? '', file: TEST_FILE_DIR.test(first) ? first : null };
    });
}

// 测试结束后的检查与收尾：有遗留的临时目录或进程时按测试文件打印并返回 false；最后把专用目录整个删掉（先结束遗留进程）。
export async function finishTempRoot(root, { print = line => console.log(line), printError = line => console.error(line), list = processList, kill = pid => killProcessTree(pid) } = {}) {
  let ok = true;
  const leftovers = scanTempLeftovers(root);
  if (leftovers.length) {
    ok = false;
    const total = leftovers.reduce((sum, item) => sum + item.entries.length, 0);
    printError(`\nverify 遗留检查：测试结束后临时目录里还剩 ${total} 项（测试必须在结束时删掉自己建的临时目录）：`);
    for (const item of leftovers) {
      const shown = item.entries.slice(0, 8).join('、');
      printError(`  ${fileLabel(item.file)}：${item.entries.length} 项：${shown}${item.entries.length > 8 ? ' …' : ''}`);
    }
  }
  const processes = await findLeftoverProcesses(root, list);
  if (processes === null) {
    printError('verify 遗留检查：查询进程列表失败，没能检查遗留进程');
  } else if (processes.length) {
    ok = false;
    printError(`\nverify 遗留检查：测试结束后还有 ${processes.length} 个进程在运行（测试必须结束自己起的进程），已结束：`);
    for (const item of processes) printError(`  ${item.file === null ? '（无法判断测试文件）' : fileLabel(item.file)}：pid ${item.pid} ${item.name}`);
    for (const item of processes) { try { await kill(item.pid); } catch { /* 结束不了的留给人看。 */ } }
  }
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch { printError(`verify 遗留检查：专用临时目录没能删掉：${root}`); }
  if (ok) print('verify 遗留检查：测试没有留下临时目录和进程');
  return ok;
}

// write / print 可由测试替换，避免把嵌套 verify 的输出写进外层测试的标准输出。
export async function runVerify({ argv = [], env = process.env, write = chunk => process.stdout.write(chunk), print = line => console.log(line), printError = line => console.error(line) } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ar-codex-sentinel-'));
  const log = path.join(dir, 'calls.jsonl');
  // 哨兵：记一行调用，--version 照常回一个版本（不改变调用方的行为），其他调用以 1 结束。
  writeFileSync(path.join(dir, 'codex.js'), `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), at: Date.now() }) + '\\n');
if (process.argv.includes('--version')) console.log('codex-cli verify-sentinel');
else { process.stderr.write('verify 哨兵：测试调用了 PATH 里的 codex（不是自己的夹具）\\n'); process.exitCode = 1; }
`);
  if (process.platform === 'win32') {
    // 与 npm 生成的包装同一写法，核心的 resolveLauncher 能解析出 Node 入口（见 core/adapters/codex.mjs）。
    writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\n"%_prog%" "%dp0%\\codex.js" %*\r\n');
  } else {
    writeFileSync(path.join(dir, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'codex.js')}" "$@"\n`);
    chmodSync(path.join(dir, 'codex'), 0o755);
  }

  // 186：测试进程用这次专用的临时目录（哨兵目录与日志目录建在它外面，不算遗留）。
  const tempRoot = createTempRoot();
  const childEnv = withTempRoot(env, tempRoot);
  const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  childEnv[pathKey] = `${dir}${path.delimiter}${childEnv[pathKey] ?? ''}`;
  // 069：终端仍是原来的 spec 输出；另让 node --test 同时写一份 TAP（失败的测试文件带 exitCode / signal 等细节）。
  // 调用方自己给了 --test-reporter 时不再添加，保持它的选择。
  const now = new Date();
  const logDir = verifyLogDir(env);
  const tapFile = path.join(logDir, tapFileName(now));
  const reporters = argv.some(arg => arg.startsWith('--test-reporter'))
    ? []
    : ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${tapFile}`];
  if (reporters.length) mkdirSync(logDir, { recursive: true });
  const child = spawn(process.execPath, ['--test', tempImportArg(tempRoot), ...reporters, ...argv], { env: childEnv, shell: false });
  // 终端照常输出的同时收下完整输出（065：偶发失败要有现场可查）。
  let output = '';
  const capture = chunk => { output += chunk; write(chunk); };
  child.stdout.setEncoding('utf8'); child.stdout.on('data', capture);
  child.stderr.setEncoding('utf8'); child.stderr.on('data', capture);
  const code = await new Promise(resolve => child.on('exit', (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1)));
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  rmSync(dir, { recursive: true, force: true });
  let finalCode = code;
  if (!await finishTempRoot(tempRoot, { print, printError })) finalCode = 1;
  if (calls.length) {
    printError(`\nverify 哨兵：有测试调用了 PATH 里的 codex（${calls.length} 次）。测试必须用自己的假 codex，不能碰真实 Codex 与 ~/.codex：`);
    for (const line of calls) printError(`  ${line}`);
    finalCode = 1;
  } else {
    print('verify 哨兵：没有测试调用 PATH 里的 codex');
  }
  const file = saveVerifyLog(logDir, output.endsWith('\n') || !output ? output : `${output}\n`, now);
  print(`verify 日志：${file}${reporters.length ? `；TAP：${existsSync(tapFile) ? tapFile : '（没有生成）'}` : ''}`);
  return finalCode;
}

// 文件名带 -test，会被 node --test 的自动发现当成用例文件执行；在测试子进程里只当模块导入、不跑命令行。
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (!process.env.NODE_TEST_CONTEXT && invokedPath === fileURLToPath(import.meta.url)) {
  runVerify({ argv: process.argv.slice(2) })
    .then(code => { process.exitCode = code; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
