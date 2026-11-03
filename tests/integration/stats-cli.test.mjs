import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, usage } from '../../core/lib/cli.mjs';

test('stats 的空结果、帮助和参数错误', async (testContext) => {
  const home = mkdtempSync(path.join(tmpdir(), 'ar-stats-cli-'));
  testContext.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { AGENT_ROUTER_HOME: home };
  const run = async args => {
    const output = [];
    try { return { code: await main(args, { env, cwd: home, out: s => output.push(s) }), output }; }
    catch (error) { return { code: 2, error: error.message }; }
  };
  assert.match(usage, /ar stats \[--range 7d\|30d\|all\]/);
  assert.match((await run(['stats'])).output.join('\n'), /暂无统计数据/);
  const json = await run(['stats', '--range', 'all', '--json']);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.output[0]).totals.tasks, 0);
  for (const args of [['stats', '--range'], ['stats', '--range', 'bad'], ['stats', 'x'], ['stats', '--json', '--json'], ['stats', '--project', 'a', '--project', 'b']]) {
    const result = await run(args);
    assert.equal(result.code, 2);
    assert.equal(result.error ?? JSON.parse(result.output[0]).error, '用法：ar stats [--json] [--range 7d|30d|all] [--project <路径>]');
  }
});


test('pending and unknown first pass', async (testContext) => {
  const home = mkdtempSync(path.join(tmpdir(), 'ar-stats-cli-state-'));
  testContext.after(() => rmSync(home, { recursive: true, force: true }));
  const start = { event: 'start', v: 2, id: 'a', repo: home, started: 1, profile: 'fake', worktree: true };
  const file = path.join(home, 'runs.jsonl');
  const run = async () => { const output = []; const code = await main(['stats'], { env: { AGENT_ROUTER_HOME: home }, cwd: home, out: s => output.push(s) }); return { code, text: output.join('\n') }; };
  writeFileSync(file, JSON.stringify(start) + '\n');
  assert.match((await run()).text, /\u6682\u65e0\u7edf\u8ba1\u6570\u636e/);
  writeFileSync(file, [start, { event: 'attempt', id: 'a', n: 1 }, { event: 'end', id: 'a', exit: 0 }, { event: 'accepted', id: 'a', at: 2 }].map(row => JSON.stringify({ v: 1, ...row })).join('\n') + '\n');
  const result = await run();
  assert.equal(result.code, 0);
  assert.match(result.text, /\u4e00\u6b21\u901a\u8fc7\u7387 \u2014/);
});

// 427：额外的统计数据目录（statsSources）只读并入统计，同一任务 id 以公共目录为准。
const taskRows = (id, repo) => [
  { v: 2, event: 'start', id, repo, started: 1, profile: 'fake', type: 'code', effort: 'high', worktree: true },
  { v: 2, event: 'accepted', id, at: 2 },
];
const writeRuns = (directory, rows) => {
  const file = path.join(directory, 'runs.jsonl');
  writeFileSync(file, rows.flat().map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
};
const runJson = async (home, args) => {
  const output = [];
  const code = await main([...args, '--json'], { env: { AGENT_ROUTER_HOME: home }, cwd: home, out: s => output.push(s) });
  return { code, json: JSON.parse(output.at(-1)) };
};

test('statsSources：并入额外目录、同一 id 只算一次、不存在列进 skippedSources、只读', async (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-sources-'));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), extra = path.join(root, 'extra');
  mkdirSync(home); mkdirSync(extra);
  writeRuns(home, [taskRows('a1', home), taskRows('a2', home)]);
  // B 里有一个与公共目录同 id 的任务：只算一次。
  const extraFile = writeRuns(extra, [taskRows('b1', extra), taskRows('a1', extra)]);
  const before = readFileSync(extraFile), listing = readdirSync(extra).sort();
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, statsSources: [extra] }));

  const { code, json } = await runJson(home, ['stats']);
  assert.equal(code, 0);
  assert.equal(json.totals.tasks, 3);
  assert.equal(json.strata.reduce((sum, s) => sum + s.sampleSize, 0), 3);
  assert.deepEqual(json.sources, [path.resolve(home), path.resolve(extra)]);
  assert.deepEqual(json.skippedSources, []);
  assert.deepEqual(readFileSync(extraFile).equals(before), true);
  assert.deepEqual(readdirSync(extra).sort(), listing);

  // 额外目录不存在：跳过并列出，样本数不变。
  const missing = path.join(root, 'missing');
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, statsSources: [extra, missing] }));
  const skipped = await runJson(home, ['stats']);
  assert.equal(skipped.json.totals.tasks, 3);
  assert.deepEqual(skipped.json.skippedSources, [path.resolve(missing)]);

  // 额外目录存在但读不到 runs.jsonl：同样归入 skippedSources，不进 sources。
  const unreadable = path.join(root, 'unreadable');
  mkdirSync(unreadable);
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, statsSources: [extra, unreadable] }));
  const unreadableResult = await runJson(home, ['stats']);
  assert.equal(unreadableResult.json.totals.tasks, 3);
  assert.deepEqual(unreadableResult.json.sources, [path.resolve(home), path.resolve(extra)]);
  assert.deepEqual(unreadableResult.json.skippedSources, [path.resolve(unreadable)]);
});

test('stats sources：查看、增删、重复添加不重复写、没有 runs.jsonl 的原文', async (testContext) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ar-stats-sources-cli-'));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), extra = path.join(root, 'extra'), empty = path.join(root, 'empty');
  mkdirSync(home); mkdirSync(extra); mkdirSync(empty);
  writeRuns(extra, taskRows('b1', extra));
  const run = async args => {
    const output = [];
    try { return { code: await main(args, { env: { AGENT_ROUTER_HOME: home }, cwd: home, out: s => output.push(s) }), output }; }
    catch (error) { return { code: 2, error: error.message }; }
  };
  assert.match(usage, /ar stats sources/);
  assert.equal(JSON.parse((await run(['stats', 'sources', '--json'])).output[0]).sources.length, 0);
  const added = await run(['stats', 'sources', 'add', extra, '--json']);
  assert.equal(added.code, 0);
  assert.deepEqual(JSON.parse(added.output[0]).sources, [path.resolve(extra)]);
  assert.equal(JSON.parse((await run(['stats', '--json'])).output[0]).totals.tasks, 1);
  // 重复添加：不报错，也不重复写。
  const again = await run(['stats', 'sources', 'add', extra, '--json']);
  assert.equal(again.code, 0);
  assert.deepEqual(JSON.parse(again.output[0]).sources, [path.resolve(extra)]);
  const missing = await run(['stats', 'sources', 'add', empty]);
  assert.equal(missing.code, 2);
  assert.equal(missing.error, `这个目录里没有 runs.jsonl：${path.resolve(empty)}`);
  const removed = await run(['stats', 'sources', 'remove', extra, '--json']);
  assert.equal(removed.code, 0);
  assert.deepEqual(JSON.parse(removed.output[0]).sources, []);
});
