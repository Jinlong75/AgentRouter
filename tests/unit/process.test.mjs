import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KILL_TREE_TIMEOUT_MS, PROCESS_LIST_TIMEOUT_MS, STOP_WAIT_TIMEOUT_MS, TERMINATE_TIMEOUT_MS, killProcessTree, processList, terminateByIdentity } from '../../core/lib/process.mjs';

// 049：结束顺序的确定性测试。list / executeFile / alive 全部注入，不碰真实进程。
// 固定进程表：根 100 → 执行者 200 → 孙进程 300；可选的 late 是"初次快照之后才出现"的进程。
function fixture({ stubbornRoot = false, late = null } = {}) {
  const table = new Map([
    [100, { pid: 100, parent: 1, created: 1000, name: 'node.exe', command: '根' }],
    [200, { pid: 200, parent: 100, created: 2000, name: 'node.exe', command: '执行者' }],
    [300, { pid: 300, parent: 200, created: 3000, name: 'node.exe', command: '孙进程' }],
  ]);
  const live = new Set([100, 200, 300]);
  const calls = [];
  let lists = 0;
  const list = async () => {
    lists += 1;
    // late 只在初次快照之后的查询里出现。
    if (lists > 1 && late) table.set(late.pid, late);
    return [...table.values()];
  };
  const executeFile = async (name, args) => {
    const pids = args.flatMap((arg, index) => arg === '/PID' ? [Number(args[index + 1])] : []);
    // 记录调用发生时的存活情况，用来断言"根先退出、再结束子孙"。
    calls.push({ name, args: [...args], rootAlive: live.has(100), live: [...live] });
    for (const pid of pids) if (!(stubbornRoot && pid === 100)) live.delete(pid);
  };
  const alive = pid => live.has(pid);
  return { list, executeFile, alive, calls, live };
}

test('win32：第一次只结束根且不带 /T，根退出后结束其余子孙，补充轮结束新出现的进程', async () => {
  const f = fixture({ late: { pid: 400, parent: 200, created: 4000, name: 'node.exe', command: '晚出现的孙进程' } });
  await killProcessTree(100, { platform: 'win32', list: f.list, executeFile: f.executeFile, alive: f.alive, timeout: 5000 });

  assert.equal(f.calls[0].name, 'taskkill.exe');
  assert.deepEqual(f.calls[0].args, ['/PID', '100', '/F'], '第一次结束调用只针对根');
  assert.ok(!f.calls.some(call => call.args.includes('/T')), '任何一次结束调用都不带 /T');
  assert.deepEqual(f.calls[0].live, [100, 200, 300], '结束根时子孙还都活着');

  const descendants = f.calls.find(call => call.args.includes('200'));
  assert.ok(descendants, '有结束子孙的调用');
  assert.equal(descendants.rootAlive, false, '针对子孙的调用发生在根退出之后');
  assert.deepEqual(descendants.args, ['/PID', '200', '/PID', '300', '/F']);

  const supplement = f.calls.find(call => call.args.includes('400'));
  assert.ok(supplement, '初次快照之后才出现的子进程在补充轮被结束');
  assert.deepEqual(supplement.args, ['/PID', '400', '/F']);
  assert.deepEqual([...f.live], [], '根、执行者、孙进程和补充结束的进程都不在了');
});

test('win32：根结束不了时按时限抛错，子孙仍被尝试结束', async () => {
  const f = fixture({ stubbornRoot: true });
  await assert.rejects(
    killProcessTree(100, { platform: 'win32', list: f.list, executeFile: f.executeFile, alive: f.alive, timeout: 60 }),
    /等待进程退出超时/,
  );
  assert.deepEqual(f.calls[0].args, ['/PID', '100', '/F'], '第一次仍然只结束根');
  const descendants = f.calls.find(call => call.args.includes('200'));
  assert.ok(descendants, '根结束不了也仍尝试结束子孙');
  assert.deepEqual(descendants.args, ['/PID', '200', '/PID', '300', '/F']);
  assert.equal(f.alive(100), true, '根确实没被结束');
  assert.equal(f.alive(200), false, '子孙已经被结束');
});

// 非 Windows 分支：追踪只在 AR_CORE_TRACE=1 时输出，且开关在模块加载时读取，所以在子进程里跑。
// 子进程里把 process.kill 换成桩、list 换成固定进程表（根 → 执行者 → 孙进程），不碰真实进程。
const POSIX_SCRIPT = `
import { killProcessTree } from ${JSON.stringify(new URL('../../core/lib/process.mjs', import.meta.url).href)};
const stubbornRoot = process.argv[1] === 'stubborn';
const ROOT = 9000001, MID = 9000002, LEAF = 9000003;
const table = [
  { pid: ROOT, parent: 1, created: 1000, name: 'node', command: 'root' },
  { pid: MID, parent: ROOT, created: 2000, name: 'node', command: 'mid' },
  { pid: LEAF, parent: MID, created: 3000, name: 'node', command: 'leaf' },
];
const live = new Set([ROOT, MID, LEAF]);
const signals = [];
process.kill = (pid, signal) => {
  signals.push(signal + ':' + pid);
  if (signal === 'SIGKILL' && !(stubbornRoot && pid === ROOT)) live.delete(pid);
};
const list = async () => table.filter(p => live.has(p.pid));
let error = null;
try { await killProcessTree(ROOT, { platform: 'linux', list, alive: pid => live.has(pid), timeout: stubbornRoot ? 300 : 5000 }); }
catch (e) { error = e.message; }
console.log(JSON.stringify({ signals, error, live: [...live] }));
`;
async function runPosix(mode) {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', POSIX_SCRIPT, mode], { env: { ...process.env, AR_CORE_TRACE: '1' }, windowsHide: true, shell: false });
  const trace = stderr.split('\n').filter(line => line.includes('[ar-trace]') && line.includes('进程树结束'));
  return { ...JSON.parse(stdout.trim()), trace };
}
const sequence = (trace, texts) => texts.map(text => trace.findIndex(line => line.includes(text)));

test('linux：追踪里依次是结束根、根已结束、结束子孙，SIGKILL 先根后叶，结束前先暂停整棵树', async () => {
  const { signals, error, live, trace } = await runPosix('normal');
  assert.equal(error, null);
  assert.deepEqual(live, []);
  assert.deepEqual(signals.filter(s => s.startsWith('SIGSTOP')), ['SIGSTOP:9000001', 'SIGSTOP:9000002', 'SIGSTOP:9000003'], '先逐层暂停整棵树');
  assert.deepEqual(signals.filter(s => s.startsWith('SIGKILL')), ['SIGKILL:9000001', 'SIGKILL:9000003', 'SIGKILL:9000002'], '先结束根，再按叶到根结束其余子孙');
  assert.ok(signals.indexOf('SIGSTOP:9000003') < signals.indexOf('SIGKILL:9000001'), '暂停全部完成后才开始结束');
  const [root, gone, descendants] = sequence(trace, [' 结束根 ', ' 根已结束', ' 结束子孙 ']);
  assert.ok(root >= 0 && gone > root && descendants > gone, `追踪顺序：\n${trace.join('\n')}`);
  // 追踪行的位置也和实际结束顺序一致：根的 SIGKILL 在"根已结束"之前，子孙的在其之后。
  assert.ok(trace.findIndex(line => line.includes('SIGKILL') && line.includes('pid=9000001 parent=1')) < gone);
  assert.ok(trace.findIndex(line => line.includes('SIGKILL') && line.includes('pid=9000003 parent=9000002')) > gone);
  assert.ok(!trace.some(line => line.includes('/T')), '追踪里没有 /T');
});

test('linux：根在时限内不退出时仍结束子孙，并按时限报错', async () => {
  const { signals, error, live, trace } = await runPosix('stubborn');
  assert.match(error, /等待进程退出超时/);
  assert.deepEqual(live, [9000001], '只有根没被结束');
  assert.deepEqual(signals.filter(s => s.startsWith('SIGKILL')), ['SIGKILL:9000001', 'SIGKILL:9000003', 'SIGKILL:9000002']);
  const [root, stays, descendants] = sequence(trace, [' 结束根 ', ' 根在时限内没有退出，继续结束子孙', ' 结束子孙 ']);
  assert.ok(root >= 0 && stays > root && descendants > stays, `追踪顺序：\n${trace.join('\n')}`);
  assert.equal(trace.findIndex(line => line.includes(' 根已结束')), -1, '根没退出就不写"根已结束"');
});

// ---- 101：默认超时集中成常量；进程查询超时与普通失败的消息 ----

test('默认超时常量与各处默认值', async () => {
  assert.equal(PROCESS_LIST_TIMEOUT_MS, 20000);
  assert.equal(KILL_TREE_TIMEOUT_MS, 30000);
  assert.equal(TERMINATE_TIMEOUT_MS, 20000);
  assert.equal(STOP_WAIT_TIMEOUT_MS, 30000);
  // processList 默认把 PROCESS_LIST_TIMEOUT_MS 交给 execFile；显式传入的 timeout 不变。
  const seen = [];
  const executeFile = async (file, args, options) => { seen.push(options.timeout); return { stdout: '[]' }; };
  await processList(undefined, 'win32', undefined, executeFile);
  await processList(undefined, 'win32', 1234, executeFile);
  assert.deepEqual(seen, [PROCESS_LIST_TIMEOUT_MS, 1234]);
  // terminateByIdentity 默认 20 秒、显式值照旧。
  const killSeen = [];
  const kill = async (file, args, options) => { killSeen.push(options.timeout); return { stdout: '[]' }; };
  await terminateByIdentity([{ pid: 123, created: 1000 }], { executeFile: kill });
  await terminateByIdentity([{ pid: 123, created: 1000 }], { executeFile: kill, timeout: 777 });
  assert.deepEqual(killSeen, [TERMINATE_TIMEOUT_MS, 777]);
});

test('killProcessTree 默认总时限是 KILL_TREE_TIMEOUT_MS，并把剩余时间交给查询与句柄方式', async () => {
  const f = fixture();
  const listTimeouts = [], terminateTimeouts = [];
  await killProcessTree(100, {
    platform: 'win32', alive: f.alive, executeFile: f.executeFile,
    list: async (pid, platform, timeout) => { listTimeouts.push(timeout); return f.list(); },
    terminate: async (targets, { timeout }) => {
      terminateTimeouts.push(timeout);
      for (const target of targets) f.live.delete(target.pid);
      return new Map(targets.map(target => [target.pid, 'killed']));
    },
  });
  assert.ok(listTimeouts[0] <= KILL_TREE_TIMEOUT_MS && listTimeouts[0] > KILL_TREE_TIMEOUT_MS - 2000, `首次查询拿到约 30 秒（${listTimeouts[0]}）`);
  assert.ok(terminateTimeouts.length > 0 && terminateTimeouts.every(timeout => timeout <= KILL_TREE_TIMEOUT_MS), '句柄方式不超过 killProcessTree 剩余的时间');
});

test('进程查询超时：中文原因，原始错误放进 cause，不含 PowerShell 命令', async () => {
  // execFile 因 timeout 结束子进程时的错误：killed 为真并带 signal，message 是 "Command failed: <整段命令>"。
  const raw = Object.assign(new Error('Command failed: powershell.exe -NoProfile -NonInteractive -Command $ErrorActionPreference=\'Stop\'; Get-CimInstance Win32_Process'), { killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr: '' });
  await assert.rejects(processList(undefined, 'win32', 20000, async () => { throw raw; }), error => {
    assert.equal(error.message, '进程查询超时（20 秒）：机器负载很高时可能发生，稍后再试');
    assert.equal(error.cause, raw);
    assert.ok(!error.message.includes('powershell.exe') && !error.message.includes('Command failed'));
    return true;
  });
  // 只有 signal（没有 killed）也算；非整数秒保留一位小数；POSIX 分支同样。
  await assert.rejects(processList(undefined, 'win32', 1500, async () => { throw Object.assign(new Error('x'), { signal: 'SIGKILL' }); }), /^Error: 进程查询超时（1\.5 秒）：机器负载很高时可能发生，稍后再试$/);
  await assert.rejects(processList(undefined, 'linux', 5000, async () => { throw Object.assign(new Error('Command failed: ps'), { killed: true, signal: 'SIGTERM' }); }), /进程查询超时（5 秒）/);
});

test('进程查询的普通失败：只写第一行原因，不含整段命令；超出输出上限不算超时', async () => {
  const exited = Object.assign(new Error('Command failed: powershell.exe -NoProfile -Command 很长的脚本\nGet-CimInstance : 拒绝访问\n第二行'), { code: 1, killed: false, signal: null, stderr: 'Get-CimInstance : 拒绝访问\r\n第二行\r\n' });
  await assert.rejects(processList(undefined, 'win32', 20000, async () => { throw exited; }), error => {
    assert.equal(error.message, '进程查询失败：Get-CimInstance : 拒绝访问');
    assert.equal(error.cause, exited);
    return true;
  });
  // 没有标准错误：用退出码或错误码，不带 "Command failed"。
  await assert.rejects(processList(undefined, 'win32', 20000, async () => { throw Object.assign(new Error('Command failed: powershell.exe 脚本'), { code: 3, stderr: '' }); }), /^Error: 进程查询失败：退出码 3$/);
  await assert.rejects(processList(undefined, 'win32', 20000, async () => { throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }); }), /^Error: 进程查询失败：ENOENT$/);
  // 超出 maxBuffer 时子进程也被结束（killed 为真），但不是超时。
  await assert.rejects(processList(undefined, 'win32', 20000, async () => { throw Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' }); }), /^Error: 进程查询失败：ERR_CHILD_PROCESS_STDIO_MAXBUFFER$/);
  // 成功时返回值不变。
  const rows = await processList(undefined, 'win32', 20000, async () => ({ stdout: '{"pid":5,"parent":1,"created":9,"name":"a.exe","command":null}' }));
  assert.deepEqual(rows, [{ pid: 5, parent: 1, created: 9, name: 'a.exe', command: '' }]);
});

test('非 Windows 按 pid 查询：ps 退出码 1 且没有任何输出 = 没有这个进程；其他情况照旧报错（119）', async () => {
  const exit = props => async () => { throw Object.assign(new Error('Command failed: ps -p 12345'), props); };
  assert.deepEqual(await processList(12345, 'linux', 5000, exit({ code: 1, stdout: '', stderr: '' })), []);
  // 有标准错误：照旧报失败，原因取标准错误第一行。
  await assert.rejects(processList(12345, 'linux', 5000, exit({ code: 1, stdout: '', stderr: 'ps: 出错了\n' })), /^Error: 进程查询失败：ps: 出错了$/);
  // 退出码不是 1。
  await assert.rejects(processList(12345, 'linux', 5000, exit({ code: 2, stdout: '', stderr: '' })), /^Error: 进程查询失败：退出码 2$/);
  // 不给 pid（-A）时退出码 1 不算"没有进程"。
  await assert.rejects(processList(undefined, 'linux', 5000, exit({ code: 1, stdout: '', stderr: '' })), /^Error: 进程查询失败：退出码 1$/);
  // 程序不存在、超时：照旧。
  await assert.rejects(processList(12345, 'linux', 5000, exit({ code: 'ENOENT' })), /^Error: 进程查询失败：ENOENT$/);
  await assert.rejects(processList(12345, 'linux', 5000, exit({ code: 1, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' })), /进程查询超时（5 秒）/);
});

test('killProcessTree：查询超时的原因原样传给调用方', async () => {
  const raw = Object.assign(new Error('Command failed: powershell.exe …'), { killed: true, signal: 'SIGTERM' });
  await assert.rejects(
    killProcessTree(100, { platform: 'win32', alive: () => true, list: (pid, platform, timeout) => processList(pid, platform, timeout, async () => { throw raw; }), timeout: 3000 }),
    /^Error: 进程查询超时（3 秒）：机器负载很高时可能发生，稍后再试$/,
  );
});
