import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, limitOutput, matchedTests, repeatTest, testCount } from '../../tools/repeat-test.mjs';

const file = CASES['agents-test-timeout'].file;
const passOutput = '✔ agents test：超时 --timeout 2 结束进程树，临时目录删除 (2834ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0';
const failOutput = '✖ agents test：超时 --timeout 2 结束进程树，临时目录删除 (30772ms)\nℹ tests 1\nℹ pass 0\nℹ fail 1';
// 匹配 0 个用例时 node:test 把文件本身算作一条，汇总仍是 tests 1。
const noneOutput = '✔ tests\\integration\\agents-test.test.mjs (65ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0';

const collect = () => {
  const lines = [];
  return { lines, log: line => lines.push(line) };
};

test('repeat-test：全部通过时退出码 0，逐次输出通过', async () => {
  const { lines, log } = collect();
  let calls = 0;
  const code = await repeatTest({ key: 'agents-test-timeout', count: 3, log, env: {},
    run: async () => { calls += 1; return { code: 0, stdout: passOutput, stderr: '', ms: 2834 }; } });
  assert.equal(code, 0);
  assert.equal(calls, 3);
  assert.deepEqual(lines.filter(line => /^第 /.test(line)),
    ['第 1/3 次：通过，用时 2.8 秒', '第 2/3 次：通过，用时 2.8 秒', '第 3/3 次：通过，用时 2.8 秒']);
  assert.ok(!lines.some(line => line.includes('::group::')), '没有失败现场');
  assert.match(lines.at(-1), /^通过 3 \/ 3（通过率 100\.0%）；失败的序号：（无）；出错的序号：（无）$/);
  assert.match(lines[0], /^运行器：ImageOS=（未设置） ImageVersion=（未设置） 逻辑处理器=\d+$/);
  assert.match(lines[1], /^用例：agents-test-timeout（tests\/integration\/agents-test\.test\.mjs/);
});

test('repeat-test：某次失败也继续跑完，序号正确，退出码 1，并打印失败现场', async () => {
  const { lines, log } = collect();
  const outputs = [passOutput, failOutput, passOutput];
  let calls = 0;
  const code = await repeatTest({ key: 'agents-test-timeout', count: 3, log, env: {},
    run: async () => { const index = calls++; return { code: index === 1 ? 1 : 0, stdout: outputs[index], stderr: '', ms: 1000 }; } });
  assert.equal(code, 1);
  assert.equal(calls, 3, '失败后仍跑完剩余次数');
  assert.deepEqual(lines.filter(line => /^第 /.test(line)),
    ['第 1/3 次：通过，用时 1.0 秒', '第 2/3 次：失败，用时 1.0 秒', '第 3/3 次：通过，用时 1.0 秒']);
  const groupAt = lines.indexOf('::group::第 2 次失败现场');
  assert.ok(groupAt >= 0, '打印第 2 次失败现场');
  assert.equal(lines[groupAt + 2], '::endgroup::');
  assert.ok(lines[groupAt + 1].includes('✖ agents test：超时'), '现场里有原始输出');
  assert.match(lines.at(-1), /失败的序号：2；出错的序号：（无）$/);
});

test('repeat-test：匹配 0 个用例算该次出错，不能当通过', async () => {
  const { lines, log } = collect();
  const code = await repeatTest({ key: 'agents-test-timeout', count: 2, log, env: {},
    run: async () => ({ code: 0, stdout: noneOutput, stderr: '', ms: 65 }) });
  assert.equal(code, 1);
  assert.deepEqual(lines.filter(line => /^第 /.test(line)),
    ['第 1/2 次：出错，用时 0.1 秒（匹配到 0 个用例，汇总 tests=1）',
      '第 2/2 次：出错，用时 0.1 秒（匹配到 0 个用例，汇总 tests=1）']);
  assert.match(lines.at(-1), /通过 0 \/ 2（通过率 0\.0%）；失败的序号：（无）；出错的序号：1、2$/);
  assert.equal(lines.filter(line => line === '::group::第 1 次失败现场').length, 1);
  assert.equal(lines.filter(line => line === '::group::第 2 次失败现场').length, 1);
});

test('repeat-test：汇总 tests 不是 1（多于 1 个）也算出错；没有汇总也算出错', async () => {
  const many = '✔ 用例一 (1ms)\n✔ 用例二 (1ms)\nℹ tests 2\nℹ pass 2';
  const { lines, log } = collect();
  const code = await repeatTest({ key: 'agents-test-timeout', count: 2, log, env: {},
    run: async () => ({ code: 0, stdout: many, stderr: '', ms: 10 }) });
  assert.equal(code, 1);
  assert.match(lines.at(-1), /出错的序号：1、2$/);

  const empty = collect();
  const noSummary = await repeatTest({ key: 'agents-test-timeout', count: 1, log: empty.log, env: {},
    run: async () => ({ code: 0, stdout: '', stderr: '启动失败', ms: 10 }) });
  assert.equal(noSummary, 1);
  assert.match(empty.lines[2], /出错，用时 0\.0 秒（匹配到 0 个用例，汇总 tests=（没有））/);
  assert.ok(empty.lines.includes('启动失败'), '现场的完整输出原样打印');
});

test('repeat-test：未知键与非法次数报错，不启动任何运行', async () => {
  let calls = 0;
  const run = async () => { calls += 1; return { code: 0, stdout: passOutput, stderr: '', ms: 1 }; };
  await assert.rejects(repeatTest({ key: '不存在的键', count: 1, run, log: () => {}, env: {} }), /未知的用例键：不存在的键/);
  await assert.rejects(repeatTest({ key: 'agents-test-timeout', count: 0, run, log: () => {}, env: {} }), /次数必须为正整数：0/);
  await assert.rejects(repeatTest({ key: 'agents-test-timeout', count: 1.5, run, log: () => {}, env: {} }), /次数必须为正整数/);
  assert.equal(calls, 0);
});

test('repeat-test：长输出超过 600 行时保留开头 100 行与结尾 500 行', async () => {
  const long = Array.from({ length: 700 }, (_, index) => `行${index + 1}`).join('\n');
  const lines = limitOutput(long).split('\n');
  assert.equal(lines.length, 601);
  assert.equal(lines[0], '行1');
  assert.equal(lines[99], '行100');
  assert.equal(lines[100], '（省略 100 行）');
  assert.equal(lines[101], '行201');
  assert.equal(lines.at(-1), '行700');
  assert.ok(!lines.includes('行150'), '中间的行被省略');

  // 恰好 600 行不截断；601 行只省略中间 1 行。
  const exact = Array.from({ length: 600 }, (_, index) => `行${index + 1}`).join('\n');
  assert.equal(limitOutput(exact), exact);
  const over = limitOutput(Array.from({ length: 601 }, (_, index) => `行${index + 1}`).join('\n'));
  assert.match(over, /（省略 1 行）/);

  // 失败现场的日志同样按这个规则截断。
  const many = Array.from({ length: 700 }, (_, index) => `输出行${index + 1}`).join('\n');
  const { lines: logs, log } = collect();
  const code = await repeatTest({ key: 'agents-test-timeout', count: 1, log, env: {},
    run: async () => ({ code: 1, stdout: many, stderr: '', ms: 100 }) });
  assert.equal(code, 1);
  const groupAt = logs.indexOf('::group::第 1 次失败现场');
  const body = logs[groupAt + 1].split('\n');
  assert.equal(body.length, 601);
  assert.equal(body[0], '输出行1');
  assert.equal(body[100], '（省略 100 行）');
  assert.equal(body.at(-1), '输出行700');
});

test('repeat-test：解析 spec 与 TAP 两种汇总，文件本身那条不算匹配到的用例', () => {
  assert.equal(testCount('ℹ tests 1\nℹ pass 1'), 1);
  assert.equal(testCount('# tests 2\n# pass 2'), 2);
  assert.equal(testCount('没有汇总'), null);
  assert.equal(matchedTests('✔ 用例名称 (12ms)\nℹ tests 1', file), 1);
  assert.equal(matchedTests('ok 1 - 用例名称\n# tests 1', file), 1);
  assert.equal(matchedTests(noneOutput, file), 0);
  assert.equal(matchedTests('ok 1 - tests\\integration\\agents-test.test.mjs\n# tests 1', file), 0);
});
