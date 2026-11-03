import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { filterGitEnvironment, generateFixture, median, summarize, waitForDispatch } from '../../tools/perf.mjs';

test('子进程环境过滤 Git 仓库定位变量且不修改原环境', () => {
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES'];
  const env = Object.fromEntries(names.map(name => [name, 'fixture']));
  env.git_dir = 'fixture'; env.PATH = 'fixture-path';
  assert.deepEqual(filterGitEnvironment(env), { PATH: 'fixture-path' });
  assert.equal(env.GIT_DIR, 'fixture');
});

test('派发等待超时只结束指定进程并报错，正常退出不结束进程', async () => {
  const killed = [];
  const kill = async pid => { killed.push(pid); };
  await assert.rejects(waitForDispatch(new Promise(() => {}), 123, { timeoutMs: 1, kill }), /派发等待超时/);
  assert.deepEqual(killed, [123]);
  await waitForDispatch(Promise.resolve(), 456, { timeoutMs: 100, kill });
  assert.deepEqual(killed, [123]);
});

test('合成清单和事件的数量、唯一编号与归属', () => {
  const data = generateFixture(3, 8, path.resolve('fixture'));
  assert.equal(data.tasks.length, 3);
  assert.equal(new Set(data.tasks.map(task => task.start.id)).size, 3);
  assert.equal(data.events.flat().length, 8);
  for (const [i, task] of data.tasks.entries()) {
    assert.equal(task.start.id, task.end.id);
    assert.deepEqual(data.events[i].map(event => event.seq), data.events[i].map((_, n) => n + 1));
    assert.equal(path.basename(path.dirname(task.start.events)), task.start.name);
  }
  assert.equal(generateFixture(2, 0, path.resolve('fixture')).events.flat().length, 0);
  assert.throws(() => generateFixture(0, 1, path.resolve('fixture')));
  assert.throws(() => generateFixture(1, -1, path.resolve('fixture')));
});

test('中位数排序不改变样本，正确判断边界、超限和缺省上限', () => {
  const values = [9, 1, 5];
  assert.equal(median(values), 5);
  assert.deepEqual(values, [9, 1, 5]);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([-3]), -3);
  assert.throws(() => median([]));
  assert.throws(() => median([NaN]));
  assert.equal(summarize('a', values, 5).ok, true);
  assert.equal(summarize('a', values, 4).ok, false);
  assert.equal(summarize('a', values).limit, null);
  assert.equal(summarize('a', values).ok, true);
  assert.throws(() => summarize('a', values, -1));
});

test('未知参数直接报错并退出 2', () => {
  const script = fileURLToPath(new URL('../../tools/perf.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--unknown'], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^性能基准失败：参数错误/);
  assert.equal(result.stdout, '');
});
