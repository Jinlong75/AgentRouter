import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEEP_LOGS, logFileName, pruneVerifyLogs, runVerify, tapFileName } from '../../tools/verify-tests.mjs';

// 069：verify 另落一份 TAP（带整个测试文件失败时的 exitCode / signal 等细节），与 .log 同名不同扩展名，各保留 20 份。
// 全部用测试自己的临时目录（AR_VERIFY_LOG_DIR 注入），不往真实 %TEMP%\agent-router-verify 写数据。

test('TAP 文件名与 .log 同名、扩展名 .tap', () => {
  const now = new Date(2026, 9, 22, 8, 5, 9, 7);
  assert.equal(tapFileName(now), '20261022-080509-007.tap');
  assert.equal(tapFileName(now).replace(/\.tap$/, ''), logFileName(now).replace(/\.log$/, ''));
});

test('pruneVerifyLogs：.log 与 .tap 各自只保留最近 20 份', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-verify-tap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (let i = 0; i < 25; i++) {
    const at = new Date(2026, 9, 22, 8, 0, i, 0);
    writeFileSync(join(dir, logFileName(at)), `log ${i}\n`, 'utf8');
    writeFileSync(join(dir, tapFileName(at)), `tap ${i}\n`, 'utf8');
  }
  const removed = pruneVerifyLogs(dir);
  assert.equal(removed.length, 10);
  for (const extension of ['.log', '.tap']) {
    const left = readdirSync(dir).filter(name => name.endsWith(extension)).sort();
    assert.equal(left.length, KEEP_LOGS, `${extension} 保留 20 份`);
    assert.equal(left[0], `20261022-080005-000${extension}`);
  }
});

test('runVerify：用注入的日志目录生成 .log 与 .tap，旧文件只保留 20 份，最后一行带 TAP 路径，退出码照旧', async t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-verify-tap-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const logs = join(base, '日志目录');
  mkdirSync(logs);
  for (let i = 0; i < 25; i++) {
    const at = new Date(2026, 9, 21, 8, 0, i, 0);
    writeFileSync(join(logs, logFileName(at)), `log ${i}\n`, 'utf8');
    writeFileSync(join(logs, tapFileName(at)), `tap ${i}\n`, 'utf8');
  }
  const sample = join(base, 'sample.test.mjs');
  writeFileSync(sample, "import { test } from 'node:test'; test('通过', () => {}); test('失败', () => { throw new Error('故意失败'); });\n", 'utf8');
  // 嵌套的 node --test 不能继承外层测试进程的 NODE_TEST_CONTEXT。
  const env = { ...process.env, AR_VERIFY_LOG_DIR: logs };
  delete env.NODE_TEST_CONTEXT;
  const printed = [], terminal = [];
  const code = await runVerify({ argv: [sample], env, write: chunk => terminal.push(chunk), print: line => printed.push(line), printError: line => printed.push(line) });
  assert.equal(code, 1, '样例里有失败的用例，退出码为 1（哨兵没触发）');
  assert.match(terminal.join(''), /✔ 通过/, '终端仍是原来的 spec 输出');
  assert.match(terminal.join(''), /✖ 失败/);
  const files = readdirSync(logs);
  assert.equal(files.filter(name => name.endsWith('.log')).length, KEEP_LOGS, '.log 保留 20 份');
  assert.equal(files.filter(name => name.endsWith('.tap')).length, KEEP_LOGS, '.tap 保留 20 份');
  const last = printed.at(-1);
  const match = last.match(/^verify 日志：(.+\.log)；TAP：(.+\.tap)$/);
  assert.ok(match, `最后一行同时打印日志与 TAP 路径：${last}`);
  assert.equal(match[1].replace(/\.log$/, ''), match[2].replace(/\.tap$/, ''), '两个文件同名不同扩展名');
  const tap = readFileSync(match[2], 'utf8');
  assert.match(tap, /^TAP version 13/m);
  assert.match(tap, /not ok \d+ - 失败/);
  assert.match(tap, /ok \d+ - 通过/);
  assert.match(readFileSync(match[1], 'utf8'), /✖ 失败/, '.log 仍是终端输出的完整副本');
});
