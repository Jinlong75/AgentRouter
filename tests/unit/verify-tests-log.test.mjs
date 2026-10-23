import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEEP_LOGS, logFileName, pruneVerifyLogs, saveVerifyLog, verifyLogDir } from '../../tools/verify-tests.mjs';

// 065：verify 全量日志落盘的目录注入、文件生成与只保留最近 20 份。
// 全部写在测试自己的临时目录里，不往真实 %TEMP%\agent-router-verify 写测试数据。

test('verify 日志目录：AR_VERIFY_LOG_DIR 注入优先，缺省是系统临时目录下的 agent-router-verify', () => {
  assert.equal(verifyLogDir({ AR_VERIFY_LOG_DIR: join(tmpdir(), '注入的目录') }), join(tmpdir(), '注入的目录'));
  assert.equal(verifyLogDir({}), join(tmpdir(), 'agent-router-verify'));
  assert.equal(verifyLogDir(), join(tmpdir(), 'agent-router-verify'));
});

test('日志文件名按时间可排序、带 .log 结尾', () => {
  const early = logFileName(new Date(2026, 9, 22, 8, 5, 9, 7));
  const late = logFileName(new Date(2026, 9, 22, 8, 5, 9, 8));
  assert.equal(early, '20261022-080509-007.log');
  assert.ok(late > early, '同一秒内按毫秒继续排序');
  assert.ok(logFileName(new Date(2026, 9, 22, 9, 0, 0, 0)) > late);
});

test('saveVerifyLog 写出完整内容并返回路径；pruneVerifyLogs 只保留最近 20 份', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-verify-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = saveVerifyLog(dir, '完整输出\n第二行\n', new Date(2026, 9, 22, 8, 0, 0, 0));
  assert.equal(file, join(dir, '20261022-080000-000.log'));
  assert.equal(readFileSync(file, 'utf8'), '完整输出\n第二行\n');
  // 再造 24 份（共 25 份）后清理：最早的 5 份被删，保留最近 20 份。
  for (let i = 1; i <= 24; i++)
    writeFileSync(join(dir, logFileName(new Date(2026, 9, 22, 8, 0, i, 0))), `第 ${i} 份\n`, 'utf8');
  const removed = pruneVerifyLogs(dir);
  assert.equal(removed.length, 5);
  const left = readdirSync(dir).filter(name => name.endsWith('.log')).sort();
  assert.equal(left.length, KEEP_LOGS);
  assert.equal(left[0], '20261022-080005-000.log', '最旧的保留下来的是第 5 秒那份');
  assert.equal(left.at(-1), '20261022-080024-000.log');
});

test('saveVerifyLog 每次写完都顺手清理：写第 21 份时删掉最旧的一份', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ar-verify-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (let i = 0; i < KEEP_LOGS; i++)
    saveVerifyLog(dir, `第 ${i} 份\n`, new Date(2026, 9, 22, 9, 0, i, 0));
  const before = readdirSync(dir).length;
  assert.equal(before, KEEP_LOGS);
  const file = saveVerifyLog(dir, '第 20 份\n', new Date(2026, 9, 22, 9, 0, 20, 0));
  const left = readdirSync(dir).filter(name => name.endsWith('.log')).sort();
  assert.equal(left.length, KEEP_LOGS, '总数不超过 20');
  assert.ok(!left.includes('20261022-090000-000.log'), '最旧的一份被清理');
  assert.equal(readFileSync(file, 'utf8'), '第 20 份\n');
});

test('目录还不存在时 saveVerifyLog 会先建目录；pruneVerifyLogs 对不存在的目录不报错', t => {
  const base = mkdtempSync(join(tmpdir(), 'ar-verify-log-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dir = join(base, '还没建的目录');
  const file = saveVerifyLog(dir, 'x\n', new Date(2026, 9, 22, 10, 0, 0, 0));
  assert.equal(readFileSync(file, 'utf8'), 'x\n');
  assert.deepEqual(pruneVerifyLogs(join(base, '不存在的目录')), []);
});
