// 运行 node --test，并在 PATH 最前面放一个"哨兵" codex（Stage05：哨兵查出 agents-cli 与 home-guard 的测试
// 从继承的 PATH 找到了真实 codex，在用户真实的 ~/.codex 里运行了 --version 与 login status）。任何测试从继承的 PATH 里找到 codex 都会拿到哨兵而不是真程序；哨兵把每次调用
// 记进日志，测试结束后日志非空就让 verify 失败并列出调用。测试自己用夹具（自己的 PATH 或 settings.path）
// 提供的假 codex 不受影响。零依赖。
// 065：node --test 的完整输出在照常写到终端的同时，另落一份到系统临时目录的 agent-router-verify
// （AR_VERIFY_LOG_DIR 可注入目录，测试用），只保留最近 20 份，最后一行打印日志路径。
// 不改退出码与哨兵行为。
// 069：同时让 node --test 另写一份同名 .tap（TAP 里整个测试文件失败时带 exitCode / signal 等细节），同样只保留 20 份。
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const childEnv = { ...env };
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
  const child = spawn(process.execPath, ['--test', ...reporters, ...argv], { env: childEnv, shell: false });
  // 终端照常输出的同时收下完整输出（065：偶发失败要有现场可查）。
  let output = '';
  const capture = chunk => { output += chunk; write(chunk); };
  child.stdout.setEncoding('utf8'); child.stdout.on('data', capture);
  child.stderr.setEncoding('utf8'); child.stderr.on('data', capture);
  const code = await new Promise(resolve => child.on('exit', (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1)));
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  rmSync(dir, { recursive: true, force: true });
  let finalCode = code;
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
