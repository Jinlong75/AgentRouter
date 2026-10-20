#!/usr/bin/env node
// 公开仓库单项连续重复运行：诊断用，只手动触发，不替代三连续完整回归。零依赖。
// 用法：node tools/repeat-test.mjs <用例键> <次数>
//   用例键只能取内置映射表（目前只有 agents-test-timeout）；其他值报错退出，工作流只传键。
//   每次都核对 node:test 汇总里 tests 1，且确实匹配到一个用例：匹配到 0 个或多于 1 个都算出错。
//   退出码：0 = 全部通过；1 = 有失败或出错；2 = 用法或参数错误。
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CASES = {
  'agents-test-timeout': { file: 'tests/integration/agents-test.test.mjs', pattern: '^agents test：超时 --timeout 2' },
};
export const USAGE = `用法：node tools/repeat-test.mjs <用例键> <次数>（可用键：${Object.keys(CASES).join('、')}）`;
// 失败现场输出超过 600 行时，保留开头 100 行与结尾 500 行，中间注明省略数。
const MAX_LINES = 600, HEAD_LINES = 100, TAIL_LINES = 500;

export function limitOutput(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '');
  const lines = normalized ? normalized.split('\n') : [];
  if (lines.length <= MAX_LINES) return normalized;
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  return [...lines.slice(0, HEAD_LINES), `（省略 ${omitted} 行）`, ...lines.slice(-TAIL_LINES)].join('\n');
}

// node:test 汇总里的用例数：spec 报告是"ℹ tests 1"，TAP 是"# tests 1"；没有汇总就返回 null。
export function testCount(output) {
  const matches = [...String(output ?? '').matchAll(/^\s*(?:ℹ|#)\s+tests\s+(\d+)\s*$/gm)];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

// 实际跑到的用例条数：spec 的"✔ / ✖ 名称 (用时)"与 TAP 的"ok / not ok N - 名称"。
// 匹配到 0 个时 node:test 会把文件本身算作一条（名称是文件路径），要排除掉。
export function matchedTests(output, file) {
  const normalize = value => String(value).replace(/\\/g, '/').trim();
  const target = normalize(file);
  const names = [];
  for (const line of String(output ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const spec = line.match(/^\s*[✔✖]\s+(.*?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/);
    if (spec) { names.push(spec[1]); continue; }
    const tap = line.match(/^(?:not ok|ok)\s+\d+\s+-\s+(.*)$/);
    if (tap) names.push(tap[1]);
  }
  return names.filter(name => normalize(name) !== target).length;
}

// 每次一个独立的 node --test 子进程；参数用数组传，不拼 shell 命令。
export function spawnNodeTest({ file, pattern, cwd = process.cwd(), env = process.env }) {
  return new Promise(resolve => {
    const started = performance.now();
    const child = spawn(process.execPath, ['--test', `--test-name-pattern=${pattern}`, file],
      { cwd, env, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
    const finish = (code, spawnError) => resolve({ code, stdout, stderr, spawnError, ms: performance.now() - started });
    child.on('error', error => finish(null, error.message));
    child.on('close', code => finish(code));
  });
}

// run 可注入（单元测试用假运行函数，不真的启动 node --test）。
export async function repeatTest({ key, count, run = spawnNodeTest, log = console.log, env = process.env }) {
  const testCase = CASES[key];
  if (!testCase) throw new Error(`未知的用例键：${key}（可用：${Object.keys(CASES).join('、')}）`);
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`次数必须为正整数：${count}`);
  log(`运行器：ImageOS=${env.ImageOS ?? '（未设置）'} ImageVersion=${env.ImageVersion ?? '（未设置）'} 逻辑处理器=${cpus().length}`);
  log(`用例：${key}（${testCase.file}，名称模式 ${testCase.pattern}）`);
  const results = [];
  for (let index = 1; index <= count; index++) {
    const result = await run({ file: testCase.file, pattern: testCase.pattern });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const summary = testCount(output), matched = matchedTests(output, testCase.file);
    const spawnError = result.spawnError ? `启动失败：${result.spawnError}` : null;
    // 汇总 tests 不是 1、或实际没匹配到一个（0 个 / 多于 1 个）都算出错，不能把"没跑到"当通过。
    const error = spawnError != null || summary !== 1 || matched !== 1;
    const passed = !error && result.code === 0;
    const status = error ? 'error' : passed ? 'pass' : 'fail';
    results.push({ index, status });
    const seconds = Number.isFinite(result.ms) ? (result.ms / 1000).toFixed(1) : '（未知）';
    const detail = error ? `（匹配到 ${matched} 个用例，汇总 tests=${summary ?? '（没有）'}${spawnError ? `，${spawnError}` : ''}）` : '';
    log(`第 ${index}/${count} 次：${error ? '出错' : passed ? '通过' : '失败'}，用时 ${seconds} 秒${detail}`);
    if (status !== 'pass') {
      log(`::group::第 ${index} 次失败现场`);
      log(limitOutput(output || '（没有输出）'));
      log('::endgroup::');
    }
  }
  const passedCount = results.filter(r => r.status === 'pass').length;
  const failures = results.filter(r => r.status === 'fail').map(r => r.index);
  const errors = results.filter(r => r.status === 'error').map(r => r.index);
  log(`通过 ${passedCount} / ${count}（通过率 ${(passedCount / count * 100).toFixed(1)}%）；`
    + `失败的序号：${failures.join('、') || '（无）'}；出错的序号：${errors.join('、') || '（无）'}`);
  return failures.length || errors.length ? 1 : 0;
}

export function parseArgs(argv) {
  if (argv.length !== 2) throw new Error(USAGE);
  const [key, countText] = argv;
  if (!CASES[key]) throw new Error(`未知的用例键：${key}（可用：${Object.keys(CASES).join('、')}）`);
  if (!/^\d+$/.test(countText) || !Number.isSafeInteger(Number(countText)) || Number(countText) <= 0) throw new Error(`次数必须为正整数：${countText}`);
  return { key, count: Number(countText) };
}

// 文件名带 -test，会被 node --test 的自动发现当成用例文件执行；在测试子进程里只当模块导入、不跑命令行。
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (!process.env.NODE_TEST_CONTEXT && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    repeatTest(args).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 2; });
  } catch (error) {
    console.error(`${error.message}${error.message === USAGE ? '' : `\n${USAGE}`}`);
    process.exitCode = 2;
  }
}
