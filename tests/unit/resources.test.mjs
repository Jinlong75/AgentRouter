import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleResources, recordSample, recentSamples, startSample, finishSample, recordEndSample, adjustConcurrency, effectiveConcurrency } from '../../core/lib/resources.mjs';
import { pipeline } from '../../core/lib/pipeline.mjs';
import { taskPaths } from '../../core/lib/records.mjs';

test('采样范围、追加、截断和写入失败', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ar-resources-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sample = await sampleResources({ intervalMs: 20 });
  assert.ok(Number.isInteger(sample.cpu) && sample.cpu >= 0 && sample.cpu <= 100);
  assert.ok(sample.freeGb >= 0);
  recordSample(home, { event: 'end', ...sample });
  assert.equal(recentSamples(home, 1)[0].event, 'end');
  const file = join(home, 'resources.jsonl');
  writeFileSync(file, Array.from({ length: 2000 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n');
  recordSample(home, { event: 'end', ...sample });
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1000);
  assert.equal(recentSamples(home, 1000)[0].i, 1001);
  assert.doesNotThrow(() => recordSample(file, { event: 'end', ...sample }));
});

test('慢采样最多让 pipeline 在 end 之后多等 1 秒', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-slow-resource-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), paths = taskPaths(root, 'test');
  mkdirSync(home); mkdirSync(paths.dir, { recursive: true });
  const file = join(home, 'resources.jsonl');
  let ended;
  const code = await pipeline({ root, home, paths, id: 'test', started: Date.now(), interactive: false,
    registry: row => {
      if (row.event === 'end') {
        ended = performance.now();
        assert.ok(!existsSync(file) || !readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse).some(sample => sample.id === 'test'));
      }
    }, progress: () => {},
    adapter: {}, label: 'fake', profile: {}, profileName: 'fake', settings: {}, childEnv: {}, env: {},
    envError: new Error('test'), prompt: 'test', resourceSampleIntervalMs: 5000, userHome: root });
  assert.equal(code, 1);
  assert.ok(ended !== undefined);
  assert.ok(performance.now() - ended < 1200);
  assert.ok(!existsSync(file) || !readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse).some(sample => sample.id === 'test'));
});

test('结束采样复用快照，缺少快照时等待，并容忍写入失败', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ar-end-sample-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const mark = startSample();
  // 快照已经旧了 10 秒、只要求 5 秒：应立刻返回。误等就要 5 秒，阈值留足余量，机器忙时也不误报。
  mark.at -= 10000;
  let started = performance.now();
  const sample = await finishSample(mark, { minMs: 5000 });
  assert.ok(performance.now() - started < 1000);
  assert.ok(sample.cpu >= 0 && sample.cpu <= 100);
  started = performance.now();
  await finishSample(null, { minMs: 20 });
  assert.ok(performance.now() - started >= 20);
  await recordEndSample({ home, id: 'test', name: '示例', mark, minMs: 20 });
  const file = join(home, 'resources.jsonl');
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'end');
  await assert.doesNotReject(recordEndSample({ home: file, id: 'test', name: '示例', mark, minMs: 20 }));
});

test('结束采样快速统计存活名额，不查询进程创建时间', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ar-end-slots-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'slots'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ v: 2, managed: false }));
  writeFileSync(join(home, 'slots', 'slot-1.json'), JSON.stringify({ id: 'other', pid: process.pid, created: 1, at: 1 }));
  const mark = startSample();
  const started = performance.now();
  await recordEndSample({ home, id: 'test', name: '示例', mark, minMs: 0 });
  assert.ok(performance.now() - started < 200);
  const row = JSON.parse(readFileSync(join(home, 'resources.jsonl'), 'utf8').trim());
  assert.equal(row.running, 1);
});


test('自动并发窗口、去重与恢复', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ar-adjust-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = { concurrency: 'auto', concurrencyMax: 3, autoAdjustSamples: 2 };
  const options = { probe: { cores: 4, freeMemBytes: 4 * 1024 ** 3 }, totalBytes: 8 * 1024 ** 3 };
  const info = (await import('../../core/lib/config.mjs')).slotLimits(config, options.probe);
  const sample = (at, freeGb = 5, cpu = 10) => ({ event: 'end', at, freeGb, cpu });
  assert.equal(await adjustConcurrency(home, config, sample(1), options), null);
  assert.equal(await adjustConcurrency(home, config, sample(1), options), null);
  assert.equal((await adjustConcurrency(home, config, sample(2), options)).new, 2);
  await Promise.all([adjustConcurrency(home, config, sample(3), options), adjustConcurrency(home, config, sample(3), options)]);
  assert.equal((await adjustConcurrency(home, config, sample(4), options)).new, 3);
  assert.equal(await adjustConcurrency(home, config, sample(5), options), null);
  assert.equal(await adjustConcurrency(home, config, sample(6), options), null);
  assert.equal((await adjustConcurrency(home, config, sample(7, 1), options)).new, 2);
  assert.equal((await adjustConcurrency(home, config, sample(8, 1), options)).new, 1);
  assert.equal(await adjustConcurrency(home, config, sample(9, 1), options), null);
  assert.equal(await adjustConcurrency(home, { ...config, concurrency: 2 }, sample(10), options), null);
  assert.equal(await adjustConcurrency(home, config, sample(11, 5, null), options), null);
  assert.equal(await adjustConcurrency(home, config, sample(12), options), null);
  assert.equal(readFileSync(join(home, 'runs.jsonl'), 'utf8').trim().split('\n').length, 4);
  writeFileSync(join(home, 'concurrency-state.json'), '{');
  assert.equal(effectiveConcurrency(home, info).limits.concurrency, 1);
  assert.match(effectiveConcurrency(home, info).warnings[0], /损坏/);
});


test('configuration and lock contention', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ar-adjust-lock-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { slotLimits } = await import('../../core/lib/config.mjs');
  const config = { concurrency: 'auto', autoAdjustSamples: 1, autoAdjustCpuPercent: 60, autoAdjustMemoryMarginGb: 1 };
  const options = { probe: { cores: 4, freeMemBytes: 4 * 1024 ** 3 }, totalBytes: 8 * 1024 ** 3 };
  const invalid = slotLimits({ ...config, autoAdjustSamples: 0, autoAdjustCpuPercent: 101, autoAdjustMemoryMarginGb: -1 }, options.probe);
  assert.equal(invalid.warnings.length, 3);
  assert.equal(invalid.autoAdjustSamples, 3);
  const row = { event: 'end', at: 100, cpu: 10, freeGb: 5 };
  assert.equal(await adjustConcurrency(home, config, { ...row, event: 'queued' }, options), null);
  writeFileSync(join(home, 'concurrency-state.json.lock'), '{}');
  assert.equal(await adjustConcurrency(home, config, row, options), null);
  assert.equal(existsSync(join(home, 'concurrency-state.json')), false);
});

test('同毫秒乱序采样按标识各消费一次，内存阈值不舍入', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ar-adjust-identity-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = { concurrency: 'auto', concurrencyMax: 4, autoAdjustSamples: 2 };
  const options = { probe: { cores: 8, freeMemBytes: 4 * 1024 ** 3 }, totalBytes: 8 * 1024 ** 3 };
  const older = { event: 'end', id: 'older', name: 'older', at: 100, freeGb: 5, cpu: 10 };
  const newer = { ...older, id: 'newer', name: 'newer' };
  assert.equal(await adjustConcurrency(home, config, newer, options), null);
  assert.equal((await adjustConcurrency(home, config, older, options)).new, 3);
  assert.equal(await adjustConcurrency(home, config, newer, options), null);
  assert.equal(await adjustConcurrency(home, config, older, options), null);
  const state = JSON.parse(readFileSync(join(home, 'concurrency-state.json'), 'utf8'));
  assert.equal(state.consumed.length, 2);
  assert.deepEqual(state.window, []);
  assert.equal((await adjustConcurrency(home, config, { ...older, id: 'low', at: 101, freeGb: 1.46 }, options)).new, 2);
});
