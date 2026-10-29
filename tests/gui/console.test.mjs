import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createConsole, claudeLaunch, specGoal } from '../../app/src/main/console.mjs';
import { dayGroup } from '../../app/src/shared/types.ts';

// 与 app/src/shared/copy.ts 的 cx 同形的假文案（.mjs 不能直接导入 TS）。
const messages = {
  invalid: '参数无效，操作没有执行',
  noResult: '核心没有返回结果',
  unknownProject: '这个项目没有登记，先在项目页添加',
  projectGoneBlocked: '项目已从项目列表移除，先重新添加项目',
  failed: (reason) => `没有启动核心：${reason}`,
  timeout: (seconds) => `核心没有在 ${seconds} 秒内返回，操作已停止`,
};

const proj = path.resolve('demo-project');
const other = path.resolve('other-project');

// 记录调用的假 coreRun：按队列顺序返回（resolves）或拒绝（rejects）。
function fakeCore(responses = []) {
  const calls = [];
  const coreRun = async (args, opts = {}) => {
    calls.push({ args: [...args], input: opts.input, timeoutMs: opts.timeoutMs, cwd: opts.cwd });
    const next = responses.length ? responses.shift() : null;
    if (next?.reject) throw next.reject;
    return next?.resolve ?? { code: 0, json: { ok: true }, stderr: '' };
  };
  return { calls, coreRun };
}

// 已登记项目之后跟着一条目标命令的两段响应。
const registered = resolve => [{ resolve: { code: 0, json: { ok: true, projects: [{ path: proj }] }, stderr: '' } }, resolve];

test('agents:list 传 --detect，参数与超时正确', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('agents:list', { detect: true });
  assert.deepEqual(calls[0].args, ['agents', 'list', '--detect']);
  assert.equal(calls[0].timeoutMs, 60000);
  await service.call('agents:list', { detect: false });
  assert.deepEqual(calls[1].args, ['agents', 'list']);
});

test('agents:presets、agents:add 全部可选参数按序拼成参数数组', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('agents:presets', {});
  assert.deepEqual(calls[0].args, ['agents', 'presets']);
  await service.call('agents:add', { preset: 'deepseek', name: 'ds', label: 'DeepSeek', model: 'm', baseUrl: 'https://example.invalid', secretVar: 'DEEPSEEK_API_KEY', auth: 'token' });
  assert.deepEqual(calls[1].args, ['agents', 'add', '--preset', 'deepseek', '--name', 'ds', '--label', 'DeepSeek', '--model', 'm', '--base-url', 'https://example.invalid', '--secret-var', 'DEEPSEEK_API_KEY', '--auth', 'token']);
});

test('agents:update 至少一项；maxTurns 为 null 时传 -', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('agents:update', { name: 'ds', maxTurns: null });
  assert.deepEqual(calls[0].args, ['agents', 'update', 'ds', '--max-turns', '-']);
  await service.call('agents:update', { name: 'ds', label: 'DeepSeek', maxTurns: 5 });
  assert.deepEqual(calls[1].args, ['agents', 'update', 'ds', '--label', 'DeepSeek', '--max-turns', '5']);
});

test('agents:remove/enable/disable/default 只带名称', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  for (const action of ['agents:remove', 'agents:enable', 'agents:disable', 'agents:default']) await service.call(action, { name: 'ds' });
  assert.deepEqual(calls.map(c => c.args), [['agents', 'remove', 'ds'], ['agents', 'enable', 'ds'], ['agents', 'disable', 'ds'], ['agents', 'default', 'ds']]);
});

test('agents:test 传 testTimeout，超时为 testTimeout+20 秒', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('agents:test', { name: 'ds' });
  assert.deepEqual(calls[0].args, ['agents', 'test', 'ds', '--timeout', '180']);
  assert.equal(calls[0].timeoutMs, 200000);
  const short = createConsole({ coreRun, chooseFolder: async () => null, messages, testTimeout: 30 });
  await short.call('agents:test', { name: 'ds' });
  assert.deepEqual(calls[1].args, ['agents', 'test', 'ds', '--timeout', '30']);
  assert.equal(calls[1].timeoutMs, 50000);
});

test('secrets:status 带变量名列表，不带时为空', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('secrets:status', { names: ['A_B', 'C_D'] });
  assert.deepEqual(calls[0].args, ['secrets', 'status', 'A_B', 'C_D']);
  await service.call('secrets:status', {});
  assert.deepEqual(calls[1].args, ['secrets', 'status']);
});

test('secrets:set 的值只出现在 input，不进参数数组与错误信息', async () => {
  const { calls, coreRun } = fakeCore([{ resolve: { code: 0, json: { ok: true, name: 'API_KEY', status: 'set' }, stderr: '' } }]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('secrets:set', { name: 'API_KEY', value: 's3cret-value' });
  assert.deepEqual(calls[0].args, ['secrets', 'set', 'API_KEY']);
  assert.equal(calls[0].input, 's3cret-value');
  assert.ok(!calls[0].args.some(a => String(a).includes('s3cret-value')));
  // 值非法时抛出的错误里也不含值。
  await assert.rejects(service.call('secrets:set', { name: 'API_KEY', value: 'TOP-SECRET\n换行' }), err => err instanceof Error && !err.message.includes('TOP-SECRET'));
});

test('projects:list 与 projects:choose（choose 不调用核心）', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => proj, messages });
  await service.call('projects:list', {});
  assert.deepEqual(calls[0].args, ['projects', 'list']);
  assert.equal(await service.call('projects:choose', {}), proj);
  assert.equal(calls.length, 1);
});

test('projects:clear 调 projects clear，不带路径，返回 removed', async () => {
  const { calls, coreRun } = fakeCore([{ resolve: { code: 0, json: { ok: true, removed: 3 }, stderr: '' } }]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('projects:clear', {}), { ok: true, removed: 3 });
  assert.deepEqual(calls[0].args, ['projects', 'clear']);
  assert.equal(calls[0].timeoutMs, 60000);
});

test('projects:add 传绝对路径与 --allow-non-git', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('projects:add', { path: proj });
  assert.deepEqual(calls[0].args, ['projects', 'add', proj, '--allow-non-git']);
});

test('projects:remove/show/git-init/commit-init 先核对已登记项目', async () => {
  for (const [action, verb] of [['projects:remove', 'remove'], ['projects:show', 'show'], ['projects:git-init', 'git-init'], ['projects:commit-init', 'commit-init']]) {
    const { calls, coreRun } = fakeCore(registered({ resolve: { code: 0, json: { ok: true }, stderr: '' } }));
    const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
    await service.call(action, { path: proj });
    assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
    assert.deepEqual(calls[1].args, ['projects', verb, proj]);
  }
});

test('projects:purge-plan / projects:purge 不核对已登记（文件夹已不存在），参数数组正确，plan 带 worktree 总大小', async () => {
  const gone = path.resolve('gone-project');
  const dir = await mkdtemp(path.join(tmpdir(), 'ar-purge-'));
  try {
    await writeFile(path.join(dir, 'a.txt'), '12345');
    await writeFile(path.join(dir, 'b.txt'), '123');
    const { calls, coreRun } = fakeCore([
      { resolve: { code: 0, json: { ok: true, listed: true, tasks: ['t1'], worktrees: [{ dir, reason: 'repo-missing' }, { dir: path.join(dir, 'nope'), reason: 'repo-missing' }], slots: [] }, stderr: '' } },
      { resolve: { code: 0, json: { ok: true, removed: true, worktrees: 1, slots: 0, bytes: 8 }, stderr: '' } },
      { resolve: { code: 0, json: { ok: true, removed: true, worktrees: 0, slots: 0, bytes: 0 }, stderr: '' } },
    ]);
    const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
    const plan = await service.call('projects:purge-plan', { path: gone });
    assert.deepEqual(calls[0].args, ['projects', 'purge', gone, '--dry-run']);
    assert.equal(plan.bytes, 8);
    assert.equal(plan.listed, true);
    await service.call('projects:purge', { path: gone, worktrees: true });
    assert.deepEqual(calls[1].args, ['projects', 'purge', gone, '--worktrees']);
    await service.call('projects:purge', { path: gone, worktrees: false });
    assert.deepEqual(calls[2].args, ['projects', 'purge', gone]);
    assert.equal(calls.length, 3, '没有先调 projects list');
    await assert.rejects(service.call('projects:purge', { path: gone }), /参数无效/);
    await assert.rejects(service.call('projects:purge', { path: 'relative', worktrees: false }), /参数无效/);
    await assert.rejects(service.call('projects:purge-plan', { path: 'relative' }), /参数无效/);
    assert.equal(calls.length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// 125：不用命令行的提交。新通道都先核对已登记项目；表单经标准输入（JSON）传给核心，不拼命令行。
test('projects:changes 先核对已登记项目再调 projects changes', async () => {
  const { calls, coreRun } = fakeCore(registered({ resolve: { code: 0, json: { ok: true, files: [{ path: 'a.txt', kind: 'add' }] }, stderr: '' } }));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('projects:changes', { path: proj }), { ok: true, files: [{ path: 'a.txt', kind: 'add' }] });
  assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
  assert.deepEqual(calls[1].args, ['projects', 'changes', proj]);
  const bad = createConsole({ coreRun: fakeCore().coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(bad.call('projects:changes', { path: 'relative' }), /参数无效/);
  await assert.rejects(fakeUnregistered().call('projects:changes', { path: proj }), /没有登记/);
});

test('projects:commit 说明与文件经标准输入传 JSON，先核对已登记项目；参数校验', async () => {
  const { calls, coreRun } = fakeCore(registered({ resolve: { code: 0, json: { ok: true, commit: 'abc1234', files: ['a.txt', '中文 b.txt'] }, stderr: '' } }));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('projects:commit', { path: proj, message: '补充 README', files: ['a.txt', '中文 b.txt'] });
  assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
  assert.deepEqual(calls[1].args, ['projects', 'commit', proj], '路径之外的参数都不进命令行');
  assert.deepEqual(JSON.parse(calls[1].input), { message: '补充 README', files: ['a.txt', '中文 b.txt'] });
  const bad = createConsole({ coreRun: fakeCore().coreRun, chooseFolder: async () => null, messages });
  for (const payload of [
    { path: 'relative', message: 'x', files: ['a'] },
    { path: proj, message: 5, files: ['a'] },
    { path: proj, message: 'x', files: 'a' },
    { path: proj, message: 'x', files: [''] },
    { path: proj, message: 'x', files: [1] },
    { path: proj, message: 'x', files: ['a\0b'] },
  ]) await assert.rejects(bad.call('projects:commit', payload), /参数无效/);
  await assert.rejects(fakeUnregistered().call('projects:commit', { path: proj, message: 'x', files: ['a'] }), /没有登记/);
});

test('projects:commit 核心的错误码（NEED_GIT_IDENTITY）原样带给界面', async () => {
  const { coreRun } = fakeCore(registered({ resolve: { code: 2, json: { ok: false, error: '还没有设置 git 提交身份', code: 'NEED_GIT_IDENTITY' }, stderr: '' } }));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(service.call('projects:commit', { path: proj, message: 'x', files: ['a'] }), error => error instanceof Error && error.code === 'NEED_GIT_IDENTITY');
});

test('projects:commit-init 带 withExisting 时加 --with-existing，类型不对时拒绝', async () => {
  const ok = { resolve: { code: 0, json: { ok: true, commit: 'abc1234', files: [], withExisting: true }, stderr: '' } };
  const { calls, coreRun } = fakeCore([...registered(ok), ...registered(ok)]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('projects:commit-init', { path: proj, withExisting: true });
  assert.deepEqual(calls[1].args, ['projects', 'commit-init', proj, '--with-existing']);
  await service.call('projects:commit-init', { path: proj, withExisting: false });
  assert.deepEqual(calls[3].args, ['projects', 'commit-init', proj]);
  await assert.rejects(service.call('projects:commit-init', { path: proj, withExisting: 'yes' }), /参数无效/);
});

function fakeUnregistered() {
  const { coreRun } = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: other }] }, stderr: '' } }]);
  return createConsole({ coreRun, chooseFolder: async () => null, messages });
}

test('projects:config 数组用 JSON.stringify，键白名单校验', async () => {
  const { calls, coreRun } = fakeCore(registered({ resolve: { code: 0, json: { ok: true, config: {} }, stderr: '' } }));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('projects:config', { path: proj, set: { baseBranch: 'main', allowedPaths: ['src/**', 'a/b'], specsDir: 'docs/specs' } });
  assert.deepEqual(calls[1].args, ['projects', 'config', proj, 'baseBranch=main', `allowedPaths=${JSON.stringify(['src/**', 'a/b'])}`, 'specsDir=docs/specs']);
  await assert.rejects(service.call('projects:config', { path: proj, set: { unknown: 'x' } }), /参数无效/);
});

// Stage07b 132：推送三键的类型校验。字符串 / null（远程）、布尔 / null（两个开关）；null 传空串让核心删掉这个键；其他类型不调用核心。
test('projects:config 推送三键：值与 null 的写法，类型不对不调用核心', async () => {
  const { calls, coreRun } = fakeCore(registered({ resolve: { code: 0, json: { ok: true, config: {} }, stderr: '' } }));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('projects:config', { path: proj, set: { 'push.remote': ' upstream ', 'push.afterAccept': true, 'push.allowLead': false } });
  assert.deepEqual(calls[1].args, ['projects', 'config', proj, 'push.remote=upstream', 'push.afterAccept=true', 'push.allowLead=false']);
  const cleared = fakeCore(registered({ resolve: { code: 0, json: { ok: true, config: {} }, stderr: '' } }));
  await createConsole({ coreRun: cleared.coreRun, chooseFolder: async () => null, messages }).call('projects:config', { path: proj, set: { 'push.remote': null, 'push.afterAccept': null, 'push.allowLead': null } });
  assert.deepEqual(cleared.calls[1].args, ['projects', 'config', proj, 'push.remote=', 'push.afterAccept=', 'push.allowLead=']);
  const bad = fakeCore();
  const rejecting = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages });
  for (const set of [
    { 'push.remote': 3 }, { 'push.remote': '' }, { 'push.remote': '  ' }, { 'push.remote': 'a\nb' }, { 'push.remote': true },
    { 'push.afterAccept': 'true' }, { 'push.afterAccept': 1 }, { 'push.allowLead': 'false' }, { 'push.allowLead': {} },
    { 'push.other': true },
  ]) await assert.rejects(rejecting.call('projects:config', { path: proj, set }), /参数无效/, JSON.stringify(set));
  assert.equal(bad.calls.length, 0, '类型不对时不调用核心');
});

// Stage07b 126：高级四项的类型校验（范围交给核心）；null 写成"键="。
test('projects:config 高级四项：值与 null 的写法，类型不对不调用核心', async () => {
  const { calls, coreRun } = fakeCore(registered({ resolve: { code: 0, json: { ok: true, config: {} }, stderr: '' } }));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('projects:config', { path: proj, set: { maxRetries: 1, mergeMode: 'squash', verifyTimeoutMin: 30, worktree: false } });
  assert.deepEqual(calls[1].args, ['projects', 'config', proj, 'maxRetries=1', 'mergeMode=squash', 'verifyTimeoutMin=30', 'worktree=false']);
  const cleared = fakeCore(registered({ resolve: { code: 0, json: { ok: true, config: {} }, stderr: '' } }));
  await createConsole({ coreRun: cleared.coreRun, chooseFolder: async () => null, messages }).call('projects:config', { path: proj, set: { maxRetries: null, mergeMode: null, verifyTimeoutMin: null, worktree: null } });
  assert.deepEqual(cleared.calls[1].args, ['projects', 'config', proj, 'maxRetries=', 'mergeMode=', 'verifyTimeoutMin=', 'worktree=']);
  const bad = fakeCore();
  const rejecting = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages });
  for (const set of [
    { maxRetries: '1' }, { maxRetries: 1.5 }, { maxRetries: true }, { verifyTimeoutMin: '10' }, { verifyTimeoutMin: 2.5 },
    { mergeMode: 'rebase' }, { mergeMode: 1 }, { worktree: 'true' }, { worktree: 1 },
  ]) await assert.rejects(rejecting.call('projects:config', { path: proj, set }), /参数无效/, JSON.stringify(set));
  assert.equal(bad.calls.length, 0, '类型不对时不调用核心');
});

// 132：远程状态 / 推送 / 拉取。都先核对已登记项目，超时 150 秒（核心的网络操作 120 秒）；失败时核心的 code 与中文原因原样交给界面。
test('projects:remote / push / pull：参数（--dry-run、--no-fetch、--by human）、超时与已登记项目核对', async () => {
  const status = { ok: true, remote: 'origin', url: 'https://example.invalid/x.git', branch: 'main', ahead: 2, behind: 0, state: 'ahead', lastPush: null };
  const ok = json => ({ resolve: { code: 0, json, stderr: '' } });
  const { calls, coreRun } = fakeCore([...registered(ok(status)), ...registered(ok(status)), ...registered(ok(status)), ...registered(ok({ ok: true, pushed: true, from: 'a', to: 'b' })), ...registered(ok({ ok: true, pulled: false }))]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('projects:remote', { path: proj }), status);
  assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
  assert.deepEqual(calls[1].args, ['push', proj, '--dry-run', '--by', 'human']);
  await service.call('projects:remote', { path: proj, fetch: false });
  assert.deepEqual(calls[3].args, ['push', proj, '--dry-run', '--by', 'human', '--no-fetch']);
  await service.call('projects:remote', { path: proj, fetch: true });
  assert.deepEqual(calls[5].args, ['push', proj, '--dry-run', '--by', 'human']);
  assert.deepEqual(await service.call('projects:push', { path: proj }), { ok: true, pushed: true, from: 'a', to: 'b' });
  assert.deepEqual(calls[7].args, ['push', proj, '--by', 'human']);
  assert.deepEqual(await service.call('projects:pull', { path: proj }), { ok: true, pulled: false });
  assert.deepEqual(calls[9].args, ['pull', proj, '--by', 'human']);
  for (const i of [1, 3, 5, 7, 9]) assert.equal(calls[i].timeoutMs, 150000);
  // 参数无效或没有登记时不调用核心的推送命令。
  const none = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: other }] }, stderr: '' } }]);
  const unregistered = createConsole({ coreRun: none.coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(unregistered.call('projects:push', { path: proj }), /这个项目没有登记/);
  assert.equal(none.calls.length, 1);
  const bad = fakeCore();
  const rejecting = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages });
  for (const [action, payload] of [['projects:remote', {}], ['projects:remote', { path: 'relative' }], ['projects:remote', { path: proj, fetch: 'no' }], ['projects:push', { path: 'relative' }], ['projects:pull', {}]])
    await assert.rejects(rejecting.call(action, payload), /参数无效/, `${action} ${JSON.stringify(payload)}`);
  assert.equal(bad.calls.length, 0);
});

test('projects:push / pull / remote 失败：核心的 code 与中文原因原样交给界面；超时是通道错误', async () => {
  const failing = (code, error) => registered({ resolve: { code: 2, json: { ok: false, code, error }, stderr: '' } });
  for (const [action, code, error] of [['projects:push', 'NO_CREDENTIAL', 'git 没有拿到可用的登录'], ['projects:pull', 'DIVERGED', '本机和远程各有新提交'], ['projects:remote', 'FETCH_FAILED', '取远程状态失败：网络不通']]) {
    const service = createConsole({ coreRun: fakeCore(failing(code, error)).coreRun, chooseFolder: async () => null, messages });
    await assert.rejects(service.call(action, { path: proj }), e => e.message === error && e.code === code);
  }
  // 取远程状态时就没有登录：核心的 code 是 FETCH_FAILED、cause 是 NO_CREDENTIAL。主进程只把 code 转给界面，所以这时 code 换成 NO_CREDENTIAL；其他原因（网络不通）的 FETCH_FAILED 保持原样。
  const fetchFailed = createConsole({ coreRun: fakeCore(registered({ resolve: { code: 2, json: { ok: false, code: 'FETCH_FAILED', cause: 'NO_CREDENTIAL', error: '取远程状态失败：git 没有拿到可用的登录' }, stderr: '' } })).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(fetchFailed.call('projects:push', { path: proj }), e => e.code === 'NO_CREDENTIAL' && /取远程状态失败/.test(e.message));
  const netFailed = createConsole({ coreRun: fakeCore(registered({ resolve: { code: 2, json: { ok: false, code: 'FETCH_FAILED', cause: 'NETWORK', error: '取远程状态失败：连不上远程' }, stderr: '' } })).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(netFailed.call('projects:remote', { path: proj }), e => e.code === 'FETCH_FAILED');
  const timedOut = createConsole({ coreRun: fakeCore(registered({ resolve: { code: 1, json: { ok: false }, timedOut: true, stderr: '' } })).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(timedOut.call('projects:push', { path: proj }), /核心没有在 150 秒内返回/);
});

test('projects:git-identity 传 --name/--email 与 --global；先校验再查登记', async () => {
  const ok = { resolve: { code: 0, json: { ok: true, identity: { name: '甲', email: 'a@b' }, scope: 'repo' }, stderr: '' } };
  const { calls, coreRun } = fakeCore([...registered(ok), ...registered(ok)]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('projects:git-identity', { path: proj, name: ' 甲 ', email: ' a@b ' }), { ok: true, identity: { name: '甲', email: 'a@b' }, scope: 'repo' });
  assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
  assert.deepEqual(calls[1].args, ['projects', 'git-identity', proj, '--name', '甲', '--email', 'a@b']);
  await service.call('projects:git-identity', { path: proj, name: '乙', email: 'b@c', global: true });
  assert.deepEqual(calls[3].args, ['projects', 'git-identity', proj, '--name', '乙', '--email', 'b@c', '--global']);

  // 与核心相同的校验：不合法时不调用核心。
  const bad = createConsole({ coreRun: fakeCore().coreRun, chooseFolder: async () => null, messages });
  for (const payload of [
    { path: proj, name: '', email: 'a@b' },
    { path: proj, name: '名'.repeat(101), email: 'a@b' },
    { path: proj, name: '甲', email: '没有-at' },
    { path: proj, name: '甲', email: 'a b@c' },
    { path: proj, name: '甲', email: `${'x'.repeat(201)}@example.invalid` },
    { path: proj, name: '甲', email: 'a@b', global: 'yes' },
  ]) await assert.rejects(bad.call('projects:git-identity', payload), /参数无效/);
});

test('projects:init-plan / init-apply 调 init', async () => {
  const { calls, coreRun } = fakeCore([...registered({ resolve: { code: 0, json: { ok: true }, stderr: '' } }), ...registered({ resolve: { code: 0, json: { ok: true }, stderr: '' } })]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('projects:init-plan', { path: proj });
  await service.call('projects:init-apply', { path: proj });
  assert.deepEqual(calls[1].args, ['init', proj, '--dry-run']);
  assert.deepEqual(calls[3].args, ['init', proj]);
});

test('projects:upgrade-plan / upgrade-apply 调 init --upgrade；角色与字段名校验，无效时不调用核心', async () => {
  const ok = () => registered({ resolve: { code: 0, json: { ok: true }, stderr: '' } });
  const { calls, coreRun } = fakeCore([...ok(), ...ok(), ...ok()]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('projects:upgrade-plan', { path: proj });
  await service.call('projects:upgrade-apply', { path: proj });
  await service.call('projects:upgrade-apply', { path: proj, replaceRoles: ['worker', 'lead'], addFields: ['worktree', 'setup'] });
  assert.deepEqual(calls[1].args, ['init', proj, '--upgrade', '--dry-run']);
  assert.deepEqual(calls[3].args, ['init', proj, '--upgrade']);
  assert.deepEqual(calls[5].args, ['init', proj, '--upgrade', '--replace-role', 'worker,lead', '--add-field', 'worktree,setup']);
  const bad = fakeCore();
  const rejecting = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages });
  for (const payload of [{ path: 'relative' }, { path: proj, replaceRoles: ['boss'] }, { path: proj, replaceRoles: 'worker' }, { path: proj, addFields: ['Worktree'] }, { path: proj, addFields: ['a b'] }, { path: proj, addFields: ['--dry-run'] }, { path: proj, addFields: [3] }])
    await assert.rejects(rejecting.call('projects:upgrade-apply', payload), /参数无效/, JSON.stringify(payload));
  assert.equal(bad.calls.length, 0);
});

test('specs:list / specs:read 调 spec 子命令', async () => {
  const { calls, coreRun } = fakeCore([...registered({ resolve: { code: 0, json: { ok: true }, stderr: '' } }), ...registered({ resolve: { code: 0, json: { ok: true }, stderr: '' } })]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('specs:list', { project: proj });
  await service.call('specs:read', { project: proj, rel: 'docs/specs/001-demo.md' });
  assert.deepEqual(calls[1].args, ['spec', 'list', proj]);
  assert.deepEqual(calls[3].args, ['spec', 'read', proj, 'docs/specs/001-demo.md']);
});

test('specs:list 带 archived 加 --include-archived；specs:archive 先核对已登记、逐项校验路径、带 --commit', async () => {
  const ok = { resolve: { code: 0, json: { ok: true, moved: [], commit: 'abc1234' }, stderr: '' } };
  const { calls, coreRun } = fakeCore([...registered(ok), ...registered(ok), ...registered(ok)]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('specs:list', { project: proj, archived: true });
  await service.call('specs:list', { project: proj, archived: false });
  assert.deepEqual(calls[1].args, ['spec', 'list', proj, '--include-archived']);
  assert.deepEqual(calls[3].args, ['spec', 'list', proj]);
  const result = await service.call('specs:archive', { project: proj, rels: ['docs/specs/002-a.md', 'docs/specs/003-b.md'] });
  assert.equal(result.commit, 'abc1234');
  assert.deepEqual(calls[5].args, ['spec', 'archive', proj, 'docs/specs/002-a.md', 'docs/specs/003-b.md', '--commit']);
  // 参数无效：不调用核心。
  const count = calls.length;
  for (const bad of [{ project: proj }, { project: proj, rels: [] }, { project: proj, rels: ['a.txt'] }, { project: proj, rels: ['/abs/x.md'] }, { project: proj, rels: ['C:\\x.md'] }, { project: proj, rels: ['a\n.md'] }, { project: 'rel', rels: ['a.md'] }, { project: proj, rels: Array.from({ length: 201 }, (_, i) => `docs/specs/${i}.md`) }])
    await assert.rejects(service.call('specs:archive', bad), new RegExp(messages.invalid));
  assert.equal(calls.length, count);
});

test('spec:check-paths：项目要先核对已登记，路径数组作为 JSON 字符串传给核心，limit 按需；核心的错误原样抛出', async () => {
  const hit = { resolve: { code: 0, json: { ok: true, total: 1, files: ['src/a.ts'], truncated: false, patterns: [{ pattern: 'src/**', count: 1 }], all: false, fileCount: 3 }, stderr: '' } };
  const bad = { resolve: { code: 2, json: { ok: false, error: '允许改动的文件第 1 项不能带盘符：C:/x' }, stderr: '' } };
  const { calls, coreRun } = fakeCore([...registered(hit), ...registered(hit), ...registered(bad)]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  const result = await service.call('spec:check-paths', { project: proj, paths: ['src/**', '中文 空格/*.md'] });
  assert.equal(result.total, 1);
  assert.deepEqual(result.files, ['src/a.ts']);
  assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
  assert.deepEqual(calls[1].args, ['spec', 'check-paths', '--project', proj, '--paths', JSON.stringify(['src/**', '中文 空格/*.md'])]);
  await service.call('spec:check-paths', { project: proj, paths: ['**'], limit: 0 });
  assert.deepEqual(calls[3].args, ['spec', 'check-paths', '--project', proj, '--paths', '["**"]', '--limit', '0']);
  await assert.rejects(service.call('spec:check-paths', { project: proj, paths: ['C:/x'] }), /不能带盘符/);
  // 参数无效：不调用核心。
  const before = calls.length;
  for (const payload of [{}, { project: 'relative', paths: [] }, { project: proj }, { project: proj, paths: 'src/**' }, { project: proj, paths: [5] }, { project: proj, paths: ['a\nb'] },
    { project: proj, paths: Array.from({ length: 101 }, (_, i) => `d${i}/**`) }, { project: proj, paths: [], limit: -1 }, { project: proj, paths: [], limit: 1.5 }, { project: proj, paths: [], limit: '3' }])
    await assert.rejects(service.call('spec:check-paths', payload), /参数无效/, JSON.stringify(payload).slice(0, 80));
  assert.equal(calls.length, before);
  // 未登记的项目：不执行目标命令。
  const unknown = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: proj }] }, stderr: '' } }]);
  await assert.rejects(createConsole({ coreRun: unknown.coreRun, chooseFolder: async () => null, messages }).call('spec:check-paths', { project: other, paths: ['**'] }), /这个项目没有登记/);
  assert.equal(unknown.calls.length, 1);
});

test('specs:new 表单经 input 传入，--dry-run / --commit 按需', async () => {
  const { calls, coreRun } = fakeCore(registered({ resolve: { code: 0, json: { ok: true }, stderr: '' } }));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  const form = { title: '任务', goal: '目标' };
  await service.call('specs:new', { project: proj, form, dryRun: true });
  assert.deepEqual(calls[1].args, ['spec', 'new', proj, '--dry-run']);
  assert.equal(calls[1].input, JSON.stringify(form));
});

test('specs:commit 先核对已登记项目，再调 spec commit <项目> <相对路径>；参数不合法不调用核心', async () => {
  const { calls, coreRun } = fakeCore(registered({ resolve: { code: 0, json: { ok: true, commit: 'abc1234' }, stderr: '' } }));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('specs:commit', { project: proj, rel: 'docs/specs/001-demo.md' }), { ok: true, commit: 'abc1234' });
  assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
  assert.deepEqual(calls[1].args, ['spec', 'commit', proj, 'docs/specs/001-demo.md']);
  assert.equal(calls[1].timeoutMs, 60000);

  const bad = createConsole({ coreRun: fakeCore().coreRun, chooseFolder: async () => null, messages });
  for (const payload of [
    { project: 'relative/path', rel: 'docs/specs/001-demo.md' },
    { project: proj, rel: 'not-md.txt' },
    { project: proj, rel: '/abs.md' },
    { project: proj, rel: 'C:\\x.md' },
    { project: proj, rel: 'a\nb.md' },
    { project: proj },
  ]) await assert.rejects(bad.call('specs:commit', payload), /参数无效/);
});

test('tasks:dispatch spec / text 两种来源，cwd 为项目路径，带 --host agentrouter 与 --detach', async () => {
  const { calls, coreRun } = fakeCore([...registered({ resolve: { code: 0, json: { ok: true, id: '1' }, stderr: '' } }), ...registered({ resolve: { code: 0, json: { ok: true, id: '2' }, stderr: '' } })]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('tasks:dispatch', { project: proj, source: 'spec', spec: 'docs/specs/001-demo.md', profile: 'ds' });
  assert.deepEqual(calls[1].args, ['dispatch', 'docs/specs/001-demo.md', '--profile', 'ds', '--host', 'agentrouter', '--detach']);
  assert.equal(calls[1].cwd, proj);
  await service.call('tasks:dispatch', { project: proj, source: 'text', text: '多行\n任务文字' });
  assert.deepEqual(calls[3].args, ['dispatch', '多行\n任务文字', '--host', 'agentrouter', '--detach']);
  assert.equal(calls[3].cwd, proj);
});

test('tasks:redispatch 先核对已登记项目，再调 redispatch <记录名> --host agentrouter --detach，cwd 为项目路径', async () => {
  const { calls, coreRun } = fakeCore(registered({ resolve: { code: 0, json: { ok: true, id: 'x', detached: true }, stderr: '' } }));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('tasks:redispatch', { project: proj, name: '任务 一' });
  assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
  assert.deepEqual(calls[1].args, ['redispatch', '任务 一', '--host', 'agentrouter', '--detach']);
  assert.equal(calls[1].cwd, proj);
  assert.equal(calls[1].timeoutMs, 60000);
  // 不合法记录名（目录穿越、保留字符、结尾点）不调用核心。
  for (const name of ['../逃出', 'a/b', 'x.', '', 'con']) await assert.rejects(service.call('tasks:redispatch', { project: proj, name }), /参数无效/);
  assert.equal(calls.length, 2);
});

test('tasks:redispatch 对未登记项目报 projectGoneBlocked，派发命令不执行', async () => {
  const { calls, coreRun } = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: proj }] }, stderr: '' } }]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(service.call('tasks:redispatch', { project: other, name: 'ok' }), /项目已从项目列表移除/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
});

test('参数校验失败时不调用核心：未知操作、payload 非对象', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(service.call('nope', {}), /Invalid console action/);
  for (const bad of ['x', [], null, 1]) await assert.rejects(service.call('agents:list', bad), /参数无效/);
  assert.equal(calls.length, 0);
});

test('参数校验失败时不调用核心：非法名称、非法变量名、多行文字、相对路径', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(service.call('agents:remove', { name: 'has space' }), /参数无效/);
  await assert.rejects(service.call('secrets:set', { name: '1BAD', value: 'x' }), /参数无效/);
  await assert.rejects(service.call('agents:add', { preset: 'p', label: 'a\nb' }), /参数无效/);
  await assert.rejects(service.call('agents:update', { name: 'ds' }), /参数无效/);
  await assert.rejects(service.call('projects:add', { path: 'relative/path' }), /参数无效/);
  await assert.rejects(service.call('specs:read', { project: proj, rel: 'C:\\x.md' }), /参数无效/);
  await assert.rejects(service.call('specs:read', { project: proj, rel: '/abs.md' }), /参数无效/);
  await assert.rejects(service.call('specs:read', { project: proj, rel: 'not-md.txt' }), /参数无效/);
  await assert.rejects(service.call('secrets:set', { name: 'OK', value: 'x'.repeat(4097) }), /参数无效/);
  assert.equal(calls.length, 0);
});

test('未登记项目抛 unknownProject，目标命令不执行', async () => {
  const { calls, coreRun } = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: proj }] }, stderr: '' } }]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(service.call('projects:show', { path: other }), /这个项目没有登记/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
});

test('结果映射：ok:true 去 lines；ok:false 抛核心原因；拒绝抛 failed；coreRun 标出 timedOut 时抛 timeout', async () => {
  const ok = fakeCore([{ resolve: { code: 0, json: { ok: true, lines: ['a'], value: 1 }, stderr: '' } }]);
  const s1 = createConsole({ coreRun: ok.coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await s1.call('agents:list', {}), { ok: true, value: 1 });

  const fail = fakeCore([{ resolve: { code: 1, json: { ok: false, error: '核心错误', lines: [] }, stderr: '' } }]);
  const s2 = createConsole({ coreRun: fail.coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(s2.call('agents:list', {}), /核心错误/);

  // 核心带 code 时，抛出的 Error 也带同一个 code（界面据此区分"没有提交身份"）。
  const coded = fakeCore(registered({ resolve: { code: 1, json: { ok: false, error: '还没有设置 git 提交身份', code: 'NEED_GIT_IDENTITY' }, stderr: '' } }));
  const s2b = createConsole({ coreRun: coded.coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(s2b.call('projects:commit-init', { path: proj }), error => error instanceof Error && error.code === 'NEED_GIT_IDENTITY' && /提交身份/.test(error.message));

  const noError = fakeCore([{ resolve: { code: 1, json: { ok: false }, stderr: '' } }]);
  const s3 = createConsole({ coreRun: noError.coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(s3.call('agents:list', {}), /核心没有返回结果/);

  const reject = fakeCore([{ reject: Error('spawn ENOENT') }]);
  const s4 = createConsole({ coreRun: reject.coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(s4.call('agents:list', {}), /没有启动核心：spawn ENOENT/);

  // 与真实 coreRun 超时时的返回一致：兜底的 { ok:false } 加 timedOut。
  const timeout = fakeCore([{ resolve: { code: 1, json: { ok: false, error: '核心没有返回结果' }, stderr: '', timedOut: true } }]);
  const s5 = createConsole({ coreRun: timeout.coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(s5.call('agents:list', {}), /核心没有在 60 秒内返回/);
});

test('claudeLaunch：有 Windows Terminal 用 wt.exe -d，否则 cmd.exe start；参数是数组，目录含引号或不是绝对路径拒绝', () => {
  const wt = path.resolve('wt.exe');
  assert.deepEqual(claudeLaunch({ dir: proj, name: 'demo', wt }), { executable: wt, args: ['-d', proj, 'claude'] });
  assert.deepEqual(claudeLaunch({ dir: proj, name: 'demo', wt: null }), { executable: 'cmd.exe', args: ['/c', 'start', 'AgentRouter · demo', '/D', proj, 'cmd.exe', '/k', 'claude'] });
  assert.throws(() => claudeLaunch({ dir: 'relative', name: 'x' }), /Invalid path/);
  assert.throws(() => claudeLaunch({ dir: proj + '"x', name: 'x' }), /Invalid path/);
});

test('shell:open-folder / shell:open-claude：只接受已登记项目，交给注入的函数，不调用核心命令', async () => {
  const opened = [], launched = [];
  const core = fakeCore([...registered(undefined).slice(0, 1), ...registered(undefined).slice(0, 1)]);
  const s = createConsole({ coreRun: core.coreRun, chooseFolder: async () => null, messages, openFolder: async dir => { opened.push(dir); }, launch: async (exe, args, opts) => { launched.push({ exe, args, cwd: opts.cwd }); }, findWt: async () => null });
  assert.deepEqual(await s.call('shell:open-folder', { path: proj }), { ok: true });
  assert.deepEqual(opened, [proj]);
  assert.deepEqual(await s.call('shell:open-claude', { path: proj }), { ok: true, executable: 'cmd.exe' });
  assert.deepEqual(launched, [{ exe: 'cmd.exe', args: ['/c', 'start', `AgentRouter · ${path.basename(proj)}`, '/D', proj, 'cmd.exe', '/k', 'claude'], cwd: proj }]);
  // 099：打开 Claude Code 前多一条只读的 ar proxy resolve（算这一刻的代理）；除此之外只查了登记。
  assert.deepEqual(core.calls.map(c => c.args), [['projects', 'list', '--registry-only'], ['projects', 'list', '--registry-only'], ['proxy', 'resolve']], '只查了登记和代理，没有其他核心命令');
  const unregistered = fakeCore(registered(undefined).slice(0, 1));
  const s2 = createConsole({ coreRun: unregistered.coreRun, chooseFolder: async () => null, messages, launch: async () => assert.fail('不应启动') });
  await assert.rejects(s2.call('shell:open-claude', { path: other }), /这个项目没有登记/);
  await assert.rejects(s2.call('shell:open-claude', { path: 'relative' }), /参数无效/);
});

// 099：打开 Claude Code 时带代理。核心（ar proxy resolve）算出地址，终端的环境 = 软件环境 + 代理变量；不使用 / 读不到 / 核心出错都不传 env。
test('shell:open-claude：代理有地址时 launch 收到的 env 带 HTTP_PROXY / HTTPS_PROXY / NO_PROXY（覆盖继承来的值、去掉小写同名），其余变量原样', async () => {
  const launched = [];
  const resolved = { code: 0, json: { ok: true, mode: 'manual', url: 'http://127.0.0.1:7890', source: 'manual', reason: 'manual', env: { HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1' } }, stderr: '' };
  const core = fakeCore([...registered(undefined).slice(0, 1), { resolve: resolved }]);
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy, AR_TEST_MARK: process.env.AR_TEST_MARK };
  for (const key of Object.keys(saved)) delete process.env[key];
  Object.assign(process.env, { HTTPS_PROXY: 'http://inherited.invalid:1', AR_TEST_MARK: 'kept' });
  try {
    const s = createConsole({ coreRun: core.coreRun, chooseFolder: async () => null, messages, launch: async (exe, args, opts) => { launched.push({ exe, args, ...opts }); }, findWt: async () => null });
    assert.deepEqual(await s.call('shell:open-claude', { path: proj }), { ok: true, executable: 'cmd.exe' });
    assert.deepEqual(core.calls.map(c => c.args), [['projects', 'list', '--registry-only'], ['proxy', 'resolve']]);
    assert.equal(launched.length, 1);
    assert.equal(launched[0].cwd, proj);
    const { env } = launched[0];
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
    assert.equal(env.AR_TEST_MARK, 'kept', '软件环境里的其他变量原样带上');
    assert.equal(Object.keys(env).filter(key => /^https_proxy$/i.test(key)).length, 1, '没有两份同名代理变量');
  } finally {
    for (const key of ['HTTPS_PROXY', 'AR_TEST_MARK']) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
});

test('shell:open-claude：不使用代理（url 为 null）、核心出错、核心没返回地址时都不传 env，照旧打开', async () => {
  const cases = [
    ['off', { resolve: { code: 0, json: { ok: true, mode: 'off', url: null, source: null, reason: 'off', env: {} }, stderr: '' } }],
    ['system 读不到', { resolve: { code: 0, json: { ok: true, mode: 'system', url: null, source: null, reason: 'disabled', env: {} }, stderr: '' } }],
    ['核心报错', { resolve: { code: 2, json: { ok: false, error: 'config.json 的 proxy.url 代理地址里不能带用户名和密码' }, stderr: '' } }],
    ['核心没起来', { reject: new Error('spawn failed') }],
  ];
  for (const [label, response] of cases) {
    const launched = [];
    const core = fakeCore([...registered(undefined).slice(0, 1), response]);
    const s = createConsole({ coreRun: core.coreRun, chooseFolder: async () => null, messages, launch: async (exe, args, opts) => { launched.push(opts); }, findWt: async () => null });
    assert.deepEqual(await s.call('shell:open-claude', { path: proj }), { ok: true, executable: 'cmd.exe' }, label);
    assert.deepEqual(launched, [{ cwd: proj }], `${label}：只传 cwd，没有 env`);
  }
});

// 074：tasks:attempt-files 只读"任务清单里的记录目录"。用系统临时目录里的真实文件；注入的 knownRunDir 代表主进程已读到的任务。
test('tasks:attempt-files：清单里的目录照常返回；形状合法但不在清单里的目录拒绝，也不读文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ar-attempt-files-'));
  try {
    const known = path.join(root, 'repo-a', '.agent-runs', '012-示例');
    const stranger = path.join(root, 'repo-b', '.agent-runs', '013-别处');
    for (const dir of [known, stranger]) {
      await mkdir(path.join(dir, 'attempts', '1'), { recursive: true });
      await writeFile(path.join(dir, 'attempts', '1', 'report.md'), `汇报：${path.basename(dir)}`);
      await writeFile(path.join(dir, 'attempts', '1', 'gate.json'), JSON.stringify({ passed: true }));
    }
    const asked = [];
    const service = createConsole({ coreRun: fakeCore().coreRun, chooseFolder: async () => null, messages, knownRunDir: dir => { asked.push(dir); return path.resolve(dir).toLowerCase() === path.resolve(known).toLowerCase(); } });
    // ① 清单里的目录：照常返回汇报与门禁。
    assert.deepEqual(await service.call('tasks:attempt-files', { dir: known, n: 1 }), { exists: true, report: '汇报：012-示例', gate: { passed: true } });
    // ② 路径形状合法（…/.agent-runs/<名>）、文件也真实存在，但不在清单里：参数无效，不是返回内容。
    await assert.rejects(service.call('tasks:attempt-files', { dir: stranger, n: 1 }), /参数无效/);
    // ② 目录根本不存在：同样是参数无效，而不是 exists:false。
    await assert.rejects(service.call('tasks:attempt-files', { dir: path.join(root, 'repo-c', '.agent-runs', '014-不存在'), n: 1 }), /参数无效/);
    // 形状不对的参数在询问清单之前就被挡掉。
    asked.length = 0;
    await assert.rejects(service.call('tasks:attempt-files', { dir: path.join(root, 'repo-a'), n: 1 }), /参数无效/);
    await assert.rejects(service.call('tasks:attempt-files', { dir: known, n: 0 }), /参数无效/);
    assert.deepEqual(asked, []);
    // 没有注入判断函数时一律拒绝（默认不放行）。
    const bare = createConsole({ coreRun: fakeCore().coreRun, chooseFolder: async () => null, messages });
    await assert.rejects(bare.call('tasks:attempt-files', { dir: known, n: 1 }), /参数无效/);
    // 判断函数可以是异步的。
    const slow = createConsole({ coreRun: fakeCore().coreRun, chooseFolder: async () => null, messages, knownRunDir: async dir => dir === known });
    assert.equal((await slow.call('tasks:attempt-files', { dir: known, n: 1 })).exists, true);
    await assert.rejects(slow.call('tasks:attempt-files', { dir: stranger, n: 1 }), /参数无效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tasks:attempt-files：同一目录只是大小写不同（Windows）也接受，没有 attempts/ 的旧任务 exists 为 false', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ar-attempt-files-'));
  try {
    const known = path.join(root, 'repo-a', '.agent-runs', 'Old-Task');
    await mkdir(known, { recursive: true });
    const ci = process.platform === 'win32';
    const service = createConsole({ coreRun: fakeCore().coreRun, chooseFolder: async () => null, messages, knownRunDir: dir => (ci ? path.resolve(dir).toLowerCase() === path.resolve(known).toLowerCase() : dir === known) });
    const differentCase = path.join(root, 'REPO-A', '.agent-runs', 'old-task');
    if (ci) assert.deepEqual(await service.call('tasks:attempt-files', { dir: differentCase, n: 1 }), { exists: false, report: '', gate: null });
    assert.deepEqual(await service.call('tasks:attempt-files', { dir: known, n: 1 }), { exists: false, report: '', gate: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// 037 第 2 项：任务列表 / 新建任务页"今天 / 昨天"分组的纯函数（输入：任务开始时刻、"现在"）。
// 四种情形：跨午夜前后、同一天、昨天、更早；"现在"可以被 AR_DEMO_NOW 固定（验收跨午夜不串组）。
test('dayGroup：以"现在"所在那一天的本地零点为界分今天 / 昨天 / 更早', () => {
  // 用本地时间构造（分组按本地日历日），固定为 2026-10-21 15:30。
  const now = new Date(2026, 9, 21, 15, 30).getTime();
  const todayStart = new Date(2026, 9, 21, 0, 0).getTime();
  const yesterdayStart = new Date(2026, 9, 20, 0, 0).getTime();
  // 同一天。
  assert.equal(dayGroup(now, now), 'today');
  assert.equal(dayGroup(todayStart + 3600 * 1000, now), 'today');
  // 跨午夜前后：今天零点整算今天，前 1 毫秒算昨天。
  assert.equal(dayGroup(todayStart, now), 'today');
  assert.equal(dayGroup(todayStart - 1, now), 'yesterday');
  // 昨天。
  assert.equal(dayGroup(yesterdayStart + 30 * 1000, now), 'yesterday');
  // 更早。
  assert.equal(dayGroup(yesterdayStart - 1, now), 'earlier');
  assert.equal(dayGroup(0, now), 'earlier');
});

test('dayGroup："现在"固定在午夜刚过（AR_DEMO_NOW）时与演示数据同一口径', () => {
  // 验收跨午夜的场景：AR_DEMO_NOW 固定为某天 00:00:30，演示数据里"今天 23:59:30"的任务仍算今天。
  const justAfterMidnight = new Date(2026, 9, 22, 0, 0, 30).getTime();
  assert.equal(dayGroup(new Date(2026, 9, 22, 0, 0, 0).getTime(), justAfterMidnight), 'today');
  assert.equal(dayGroup(new Date(2026, 9, 21, 23, 59, 30).getTime(), justAfterMidnight), 'yesterday');
  // 同一时刻若"现在"固定在前一天 23:59:30，该任务算今天（负向验证用的就是这个口径）。
  const beforeMidnight = new Date(2026, 9, 21, 23, 59, 30).getTime();
  assert.equal(dayGroup(beforeMidnight, beforeMidnight), 'today');
  assert.equal(dayGroup(new Date(2026, 9, 20, 23, 59, 30).getTime(), beforeMidnight), 'yesterday');
});

// 087 验收通道：参数数组、cwd 为项目根、超时；校验失败不调用核心；先核对已登记项目。
test('tasks:accept 先核对已登记项目，再调 accept <记录名> --by human，cwd 为项目路径，超时 120 秒；冲突（退出码 4）不当错误，原样返回文件清单', async () => {
  const ok = { resolve: { code: 0, json: { ok: true, merge: 'abc1234', mode: 'no-ff', cleanup: true, lines: ['x'] }, stderr: '' } };
  const { calls, coreRun } = fakeCore(registered(ok));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('tasks:accept', { project: proj, name: '020-成就 弹窗' }), { ok: true, merge: 'abc1234', mode: 'no-ff', cleanup: true });
  assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
  assert.deepEqual(calls[1].args, ['accept', '020-成就 弹窗', '--by', 'human']);
  assert.equal(calls[1].cwd, proj);
  assert.equal(calls[1].timeoutMs, 120000);
  const conflict = createConsole({ coreRun: fakeCore(registered({ resolve: { code: 4, json: { ok: false, conflict: true, files: ['src/a.ts', 3, 'b.ts'] }, stderr: '' } })).coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await conflict.call('tasks:accept', { project: proj, name: 'x' }), { conflict: true, files: ['src/a.ts', 'b.ts'] });
  // 检查不通过（退出码 2）：核心的中文原因作为错误抛出。
  const blocked = createConsole({ coreRun: fakeCore(registered({ resolve: { code: 2, json: { ok: false, error: '主工作区当前在 feat/x，合并要在 main 上进行：先 git switch main' }, stderr: '' } })).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(blocked.call('tasks:accept', { project: proj, name: 'x' }), /先 git switch main/);
  // 其他命令的失败即使带 conflict 字段也仍是错误（只有 accept 把冲突当结果）。
  const retryFail = createConsole({ coreRun: fakeCore(registered({ resolve: { code: 4, json: { ok: false, conflict: true, files: [] }, stderr: '' } })).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(retryFail.call('tasks:retry', { project: proj, name: 'x' }), /核心没有返回结果/);
});

// 129 撤销合并：与 tasks:accept 同一套规则（先核对已登记项目、cwd 为项目根、超时 120 秒、冲突退出码 4 原样返回）；项目已移除报 projectGoneBlocked。
test('129 tasks:revert 先核对已登记项目，再调 revert <记录名> --by human，cwd 为项目路径，超时 120 秒；冲突不当错误；核心错误码原样带出', async () => {
  const ok = { resolve: { code: 0, json: { ok: true, commit: 'abc1234', lines: ['x'] }, stderr: '' } };
  const { calls, coreRun } = fakeCore(registered(ok));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('tasks:revert', { project: proj, name: '013-音量 滑块' }), { ok: true, commit: 'abc1234' });
  assert.deepEqual(calls[0].args, ['projects', 'list', '--registry-only']);
  assert.deepEqual(calls[1].args, ['revert', '013-音量 滑块', '--by', 'human']);
  assert.equal(calls[1].cwd, proj);
  assert.equal(calls[1].timeoutMs, 120000);
  const conflict = createConsole({ coreRun: fakeCore(registered({ resolve: { code: 4, json: { ok: false, conflict: true, files: ['src/a.ts', 3, 'b.ts'] }, stderr: '' } })).coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await conflict.call('tasks:revert', { project: proj, name: 'x' }), { conflict: true, files: ['src/a.ts', 'b.ts'] });
  // 检查不通过（退出码 2）：核心的中文原因作为错误抛出，错误码一起带出。
  const dirty = createConsole({ coreRun: fakeCore(registered({ resolve: { code: 2, json: { ok: false, error: '主工作区有未提交的改动，先提交或暂存：a.txt', code: 'DIRTY_MAIN', files: ['a.txt'] }, stderr: '' } })).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(dirty.call('tasks:revert', { project: proj, name: 'x' }), error => error instanceof Error && error.code === 'DIRTY_MAIN' && /先提交或暂存/.test(error.message));
  // 参数不合法不调用核心；项目已移除（不在登记表里）报 projectGoneBlocked，即使任务是已读到的。
  const bad = fakeCore();
  const guarded = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages, knownTask: () => true });
  for (const payload of [{ name: 'a' }, { project: proj }, { project: 'relative', name: 'a' }, { project: proj, name: 'a/b' }, { project: proj, name: '' }, { project: proj, name: 'con' }])
    await assert.rejects(guarded.call('tasks:revert', payload), /参数无效/);
  assert.equal(bad.calls.length, 0);
  const gone = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: proj }] }, stderr: '' } }]);
  await assert.rejects(createConsole({ coreRun: gone.coreRun, chooseFolder: async () => null, messages, knownTask: () => true }).call('tasks:revert', { project: other, name: 'task-a' }), /项目已从项目列表移除，先重新添加项目/);
  assert.deepEqual(gone.calls.map(call => call.args), [['projects', 'list', '--registry-only']], '只查了登记，没有调用 revert');
  // 其他命令的失败即使带 conflict 字段也仍是错误（只有 accept / revert 把冲突当结果）。
  const retryFail = createConsole({ coreRun: fakeCore(registered({ resolve: { code: 4, json: { ok: false, conflict: true, files: [] }, stderr: '' } })).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(retryFail.call('tasks:retry', { project: proj, name: 'x' }), /核心没有返回结果/);
});

// 132：批准时可选的 push 参数。不传时参数与原来完全相同（上面那条测试逐字核对）；true → --push，false → --no-push；其他类型不调用核心。
test('tasks:accept 的 push：true 传 --push，false 传 --no-push，不传时没有这两个参数；push 结果原样带回', async () => {
  const merged = { ok: true, merge: 'abc1234', mode: 'no-ff', cleanup: true };
  const ok = json => ({ resolve: { code: 0, json, stderr: '' } });
  const { calls, coreRun } = fakeCore([...registered(ok({ ...merged, push: { ok: true, pushed: true } })), ...registered(ok(merged)), ...registered(ok({ ...merged, push: { ok: false, code: 'NO_CREDENTIAL', error: '没有登录' } })), ...registered(ok(merged))]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('tasks:accept', { project: proj, name: 'x', push: true }), { ...merged, push: { ok: true, pushed: true } });
  assert.deepEqual(calls[1].args, ['accept', 'x', '--by', 'human', '--push']);
  await service.call('tasks:accept', { project: proj, name: 'x', push: false });
  assert.deepEqual(calls[3].args, ['accept', 'x', '--by', 'human', '--no-push']);
  const failedPush = await service.call('tasks:accept', { project: proj, name: 'x', push: true });
  assert.deepEqual(failedPush.push, { ok: false, code: 'NO_CREDENTIAL', error: '没有登录' });
  await service.call('tasks:accept', { project: proj, name: 'x' });
  assert.deepEqual(calls[7].args, ['accept', 'x', '--by', 'human']);
  for (const calledWith of calls.filter((_, i) => i % 2 === 1)) assert.equal(calledWith.timeoutMs, 120000);
  const bad = fakeCore();
  const rejecting = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages });
  for (const push of ['yes', 1, null, {}]) await assert.rejects(rejecting.call('tasks:accept', { project: proj, name: 'x', push }), /参数无效/);
  assert.equal(bad.calls.length, 0);
});

test('tasks:reject：原因必填，--reason 与 --keep-branch 与 --by human 按序传入；参数不合法不调用核心', async () => {
  const ok = { resolve: { code: 0, json: { ok: true, keptBranch: true, cleanup: true }, stderr: '' } };
  const { calls, coreRun } = fakeCore([...registered(ok), ...registered(ok)]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('tasks:reject', { project: proj, name: 'task-a', reason: '  方向不对\n主题跟随系统即可  ', keepBranch: true }), { ok: true, keptBranch: true, cleanup: true });
  assert.deepEqual(calls[1].args, ['reject', 'task-a', '--reason', '方向不对\n主题跟随系统即可', '--keep-branch', '--by', 'human']);
  assert.equal(calls[1].cwd, proj);
  assert.equal(calls[1].timeoutMs, 60000);
  await service.call('tasks:reject', { project: proj, name: 'task-a', reason: '不要了' });
  assert.deepEqual(calls[3].args, ['reject', 'task-a', '--reason', '不要了', '--by', 'human'], '不勾选时不带 --keep-branch');
  const bad = fakeCore();
  const guarded = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages });
  for (const payload of [{ project: proj, name: 'a' }, { project: proj, name: 'a', reason: '   ' }, { project: proj, name: 'a', reason: 3 }, { project: proj, name: 'a', reason: 'x'.repeat(2001) },
    { project: proj, name: 'a', reason: 'x', keepBranch: 'yes' }, { project: 'relative', name: 'a', reason: 'x' }, { project: proj, name: '../a', reason: 'x' }, { project: proj, name: '', reason: 'x' }])
    await assert.rejects(guarded.call('tasks:reject', payload), /参数无效/);
  assert.equal(bad.calls.length, 0);
});

test('tasks:diff 与 tasks:rebase：参数数组与超时；diff 只读 60 秒，rebase 与 tasks:retry 同写法（--host agentrouter --detach）', async () => {
  const diff = { resolve: { code: 0, json: { ok: true, base: 'a', head: 'b', files: [], totalBytes: 0, truncated: false }, stderr: '' } };
  const rebase = { resolve: { code: 0, json: { ok: true, id: 'x', detached: true }, stderr: '' } };
  const { calls, coreRun } = fakeCore([...registered(diff), ...registered(rebase)]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('tasks:diff', { project: proj, name: '任务 一' }), { ok: true, base: 'a', head: 'b', files: [], totalBytes: 0, truncated: false });
  assert.deepEqual(calls[1].args, ['diff', '任务 一']);
  assert.equal(calls[1].cwd, proj);
  assert.equal(calls[1].timeoutMs, 60000);
  await service.call('tasks:rebase', { project: proj, name: '任务 一' });
  assert.deepEqual(calls[3].args, ['retry', '任务 一', '--rebase', '--host', 'agentrouter', '--detach']);
  assert.equal(calls[3].cwd, proj);
  assert.equal(calls[3].timeoutMs, 60000);
  // 改动已不可查：核心 ok:false 的原文作为错误抛出（界面据此显示"改动已不可查"）。
  const gone = createConsole({ coreRun: fakeCore(registered({ resolve: { code: 2, json: { ok: false, error: '改动已不可查：worktree 与分支都已删除' }, stderr: '' } })).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(gone.call('tasks:diff', { project: proj, name: 'x' }), /改动已不可查/);
  const bad = fakeCore();
  const guarded = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages });
  for (const action of ['tasks:accept', 'tasks:diff', 'tasks:rebase', 'tasks:reject'])
    for (const payload of [{ name: 'a', reason: 'x' }, { project: proj, reason: 'x' }, { project: 'relative', name: 'a', reason: 'x' }, { project: proj, name: 'a/b', reason: 'x' }, { project: proj, name: 'a:b', reason: 'x' }, { project: proj, name: 'con', reason: 'x' }])
      await assert.rejects(guarded.call(action, payload), /参数无效/, action);
  assert.equal(bad.calls.length, 0, '参数不合法时一条核心命令都不调用');
  const unknown = createConsole({ coreRun: fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: other }] }, stderr: '' } }]).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(unknown.call('tasks:accept', { project: proj, name: 'a' }), /项目已从项目列表移除/);
});

// 116：项目从列表移除后，任务只"收尾"的操作（驳回、确认、读改动）不要求项目已登记，靠"任务是主进程已读到的"；
// 会往项目里写或启动执行者的（批准合并、重试、再派一次、合并主分支后重跑）仍要求登记，报 projectGoneBlocked。
test('116 项目未登记：驳回、确认、读改动能调用核心（任务是已读到的）', async () => {
  const known = [];
  const knownTask = (project, name) => { known.push([project, name]); return project === other && name === 'task-a'; };
  const core = fakeCore([
    { resolve: { code: 0, json: { ok: true, keptBranch: false, cleanup: true }, stderr: '' } },
    { resolve: { code: 0, json: { ok: true, merge: null, mode: 'confirm', cleanup: true }, stderr: '' } },
    { resolve: { code: 0, json: { ok: true, base: 'a', head: 'a', files: [], totalBytes: 0, truncated: false }, stderr: '' } },
  ]);
  const service = createConsole({ coreRun: core.coreRun, chooseFolder: async () => null, messages, knownTask });
  await service.call('tasks:reject', { project: other, name: 'task-a', reason: '不要了' });
  assert.deepEqual(await service.call('tasks:accept', { project: other, name: 'task-a', confirm: true }), { ok: true, merge: null, mode: 'confirm', cleanup: true });
  await service.call('tasks:diff', { project: other, name: 'task-a' });
  // 任务已读到就不需要再查登记表：核心只收到三条目标命令。
  assert.deepEqual(core.calls.map(call => call.args), [['reject', 'task-a', '--reason', '不要了', '--by', 'human'], ['accept', 'task-a', '--by', 'human'], ['diff', 'task-a']]);
  assert.deepEqual(core.calls.map(call => call.cwd), [other, other, other]);
  assert.ok(known.every(([project, name]) => project === other && name === 'task-a'));
});

test('116 项目未登记：批准合并、重试、再派一次、合并主分支后重跑报 projectGoneBlocked，不调用目标命令', async () => {
  const noProjects = () => [{ resolve: { code: 0, json: { ok: true, projects: [{ path: proj }] }, stderr: '' } }];
  // 即使任务是已读到的，要写项目的操作也不放开；不带 confirm 的 tasks:accept 是批准合并。
  for (const [action, payload] of [
    ['tasks:accept', { project: other, name: 'task-a' }], ['tasks:accept', { project: other, name: 'task-a', confirm: false }],
    ['tasks:retry', { project: other, name: 'task-a' }], ['tasks:redispatch', { project: other, name: 'task-a' }], ['tasks:rebase', { project: other, name: 'task-a' }],
  ]) {
    const core = fakeCore(noProjects());
    const service = createConsole({ coreRun: core.coreRun, chooseFolder: async () => null, messages, knownTask: () => true });
    await assert.rejects(service.call(action, payload), /项目已从项目列表移除，先重新添加项目/, action);
    assert.deepEqual(core.calls.map(call => call.args), [['projects', 'list', '--registry-only']], `${action} 只查了登记，没有调用目标命令`);
  }
});

test('116 项目未登记且任务不在已读到的清单里：驳回、确认、读改动仍报参数无效，不调用目标命令', async () => {
  for (const [action, payload] of [
    ['tasks:reject', { project: other, name: 'task-a', reason: 'x' }], ['tasks:accept', { project: other, name: 'task-a', confirm: true }], ['tasks:diff', { project: other, name: 'task-a' }],
  ]) {
    const core = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: proj }] }, stderr: '' } }]);
    const service = createConsole({ coreRun: core.coreRun, chooseFolder: async () => null, messages, knownTask: () => false });
    await assert.rejects(service.call(action, payload), /参数无效/, action);
    assert.ok(core.calls.every(call => call.args[0] === 'projects'), `${action} 没有调用目标命令`);
  }
  // confirm 不是布尔值也拒绝。
  const bad = fakeCore();
  await assert.rejects(createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages, knownTask: () => true }).call('tasks:accept', { project: other, name: 'task-a', confirm: 'yes' }), /参数无效/);
  assert.equal(bad.calls.length, 0);
});

test('116 tasks:repo-state：只读，任务必须是已读到的；返回是否登记与文件夹是否还在', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ar-repo-state-'));
  try {
    const registeredDir = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: dir }] }, stderr: '' } }]);
    const known = createConsole({ coreRun: registeredDir.coreRun, chooseFolder: async () => null, messages, knownTask: () => true });
    assert.deepEqual(await known.call('tasks:repo-state', { project: dir, name: 'task-a' }), { registered: true, exists: true });
    const removed = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [] }, stderr: '' } }]);
    assert.deepEqual(await createConsole({ coreRun: removed.coreRun, chooseFolder: async () => null, messages, knownTask: () => true }).call('tasks:repo-state', { project: dir, name: 'task-a' }), { registered: false, exists: true });
    const missing = path.join(dir, 'no-such-folder');
    const noFolder = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [] }, stderr: '' } }]);
    assert.deepEqual(await createConsole({ coreRun: noFolder.coreRun, chooseFolder: async () => null, messages, knownTask: () => true }).call('tasks:repo-state', { project: missing, name: 'task-a' }), { registered: false, exists: false });
    const unknownTask = fakeCore();
    await assert.rejects(createConsole({ coreRun: unknownTask.coreRun, chooseFolder: async () => null, messages }).call('tasks:repo-state', { project: dir, name: 'task-a' }), /参数无效/);
    assert.equal(unknownTask.calls.length, 0);
  }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('tasks:report 与 tasks:blame：参数数组、项目根为 cwd、超时 60 秒；参数不合法不调用核心；核心拒绝的原文原样抛出', async () => {
  const report = { ok: true, id: 't', name: '任务 一', state: 'accepted', executor: { score: 42 }, lead: { score: 100 }, attempts: [] };
  const { calls, coreRun } = fakeCore([...registered({ resolve: { code: 0, json: report, stderr: '' } }), ...registered({ resolve: { code: 0, json: { ...report, executor: { score: 57 } }, stderr: '' } }), ...registered({ resolve: { code: 0, json: report, stderr: '' } }), ...registered({ resolve: { code: 0, json: report, stderr: '' } })]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('tasks:report', { project: proj, name: '任务 一' }), report);
  assert.deepEqual(calls[1].args, ['report', '任务 一', '--json']);
  assert.equal(calls[1].cwd, proj);
  assert.equal(calls[1].timeoutMs, 60000);
  assert.equal((await service.call('tasks:blame', { project: proj, name: '任务 一', n: 1, who: 'spec' })).executor.score, 57);
  assert.deepEqual(calls[3].args, ['report', '任务 一', '--blame', '1=spec', '--json']);
  assert.equal(calls[3].cwd, proj);
  assert.equal(calls[3].timeoutMs, 60000);
  await service.call('tasks:blame', { project: proj, name: '任务 一', n: 12, who: 'worker' });
  assert.deepEqual(calls[5].args, ['report', '任务 一', '--blame', '12=worker', '--json']);
  await service.call('tasks:blame', { project: proj, name: '任务 一', n: 2, who: 'environment' });
  assert.deepEqual(calls[7].args, ['report', '任务 一', '--blame', '2=environment', '--json']);
  // 核心拒绝（任务还在进行等）：原文作为错误抛出，界面显示在"这个任务没有评分"下面。
  const refused = createConsole({ coreRun: fakeCore(registered({ resolve: { code: 2, json: { ok: false, error: '任务还在进行，结束后才有评分' }, stderr: '' } })).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(refused.call('tasks:report', { project: proj, name: 'x' }), /任务还在进行，结束后才有评分/);
  const bad = fakeCore();
  const guarded = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages });
  for (const payload of [{ name: 'a' }, { project: proj }, { project: 'relative', name: 'a' }, { project: proj, name: '../a' }, { project: proj, name: 'a/b' }, { project: proj, name: 'con' }, { project: proj, name: '' }])
    await assert.rejects(guarded.call('tasks:report', payload), /参数无效/);
  for (const payload of [{ project: proj, name: 'a' }, { project: proj, name: 'a', n: 0, who: 'spec' }, { project: proj, name: 'a', n: 1.5, who: 'spec' }, { project: proj, name: 'a', n: '1', who: 'spec' }, { project: proj, name: 'a', n: 1000, who: 'spec' },
    { project: proj, name: 'a', n: 1 }, { project: proj, name: 'a', n: 1, who: 'lead' }, { project: proj, name: 'a', n: 1, who: 'spec --json' }, { project: 'relative', name: 'a', n: 1, who: 'spec' }, { project: proj, name: 'a:b', n: 1, who: 'spec' }])
    await assert.rejects(guarded.call('tasks:blame', payload), /参数无效/);
  assert.equal(bad.calls.length, 0, '参数不合法时一条核心命令都不调用');
  const unknown = createConsole({ coreRun: fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: other }] }, stderr: '' } }]).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(unknown.call('tasks:report', { project: proj, name: 'a' }), /没有登记/);
});

test('171 tasks:overlaps：只读，参数数组是 overlaps --project <项目>，项目根为 cwd、超时 30 秒；不要求项目已登记；参数不合法不调用核心；核心拒绝的原文原样抛出', async () => {
  const groups = [{ tasks: [{ id: 'a', name: '甲', paths: ['src/**'] }, { id: 'b', name: '乙', paths: ['src/a.js'] }], order: ['a', 'b'], why: '先派发的先批准：甲 → 乙；后派发的任务会在前一个合并后自动按新基线重跑门禁' }];
  const { calls, coreRun } = fakeCore([{ resolve: { code: 0, json: { ok: true, groups }, stderr: '' } }, { resolve: { code: 0, json: { ok: true, groups: [] }, stderr: '' } }]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('tasks:overlaps', { project: proj }), { ok: true, groups });
  assert.equal(calls.length, 1, '没有先查项目登记表');
  assert.deepEqual(calls[0].args, ['overlaps', '--project', proj]);
  assert.equal(calls[0].cwd, proj);
  assert.equal(calls[0].timeoutMs, 30000);
  assert.deepEqual(await service.call('tasks:overlaps', { project: proj }), { ok: true, groups: [] });
  // 路径里有空格也只是数组里的一项，不拼命令字符串。
  const spaced = path.join(proj, '带 空格', '--x');
  const spacedCore = fakeCore([{ resolve: { code: 0, json: { ok: true, groups: [] }, stderr: '' } }]);
  await createConsole({ coreRun: spacedCore.coreRun, chooseFolder: async () => null, messages }).call('tasks:overlaps', { project: spaced });
  assert.deepEqual(spacedCore.calls[0].args, ['overlaps', '--project', spaced]);
  const refused = createConsole({ coreRun: fakeCore([{ resolve: { code: 2, json: { ok: false, error: '用法：ar overlaps [--project <路径>] [--json]' }, stderr: '' } }]).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(refused.call('tasks:overlaps', { project: proj }), /用法：ar overlaps/);
  const bad = fakeCore();
  const guarded = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages });
  for (const payload of [undefined, {}, { project: 'relative' }, { project: '' }, { project: 7 }, { project: ['x'] }, { name: 'a' }])
    await assert.rejects(guarded.call('tasks:overlaps', payload), /参数无效/);
  assert.equal(bad.calls.length, 0, '参数不合法时一条核心命令都不调用');
});

test('158 review:show / review:confirm：参数数组、项目根为 cwd、超时 60 秒；只收尾的操作不要求项目已登记；说明可选、以 -- 开头的说明前面补空格；参数不合法不调用核心；核心拒绝的原文原样抛出', async () => {
  const review = { verdict: 'concerns', reviewer: 'codex', crossed: true, issues: [{ id: 'R1-1', severity: 'high', file: 'src/a.js', line: 3, title: '问题', detail: '说明', confirmation: null }] };
  const { calls, coreRun } = fakeCore([
    { resolve: { code: 0, json: { ok: true, name: '任务 一', review }, stderr: '' } },
    { resolve: { code: 0, json: { ok: true, name: '任务 一', issue: 'R1-1', severity: 'high', result: 'valid', by: 'human', note: null }, stderr: '' } },
    { resolve: { code: 0, json: { ok: true, name: '任务 一', issue: 'R1.2-3', severity: 'low', result: 'invalid', by: 'human', note: '不对' }, stderr: '' } },
    { resolve: { code: 0, json: { ok: true }, stderr: '' } },
  ]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages, knownTask: () => true });
  assert.deepEqual(await service.call('review:show', { project: proj, name: '任务 一' }), { ok: true, name: '任务 一', review });
  assert.deepEqual(calls[0].args, ['review', 'show', '任务 一']);
  assert.equal(calls[0].cwd, proj);
  assert.equal(calls[0].timeoutMs, 60000);
  await service.call('review:confirm', { project: proj, name: '任务 一', issue: 'R1-1', result: 'valid' });
  assert.deepEqual(calls[1].args, ['review', 'confirm', '任务 一', 'R1-1', 'valid', '--by', 'human'], '软件里点的记为 human，没写说明就没有 --note');
  assert.equal(calls[1].cwd, proj);
  await service.call('review:confirm', { project: proj, name: '任务 一', issue: 'R1.2-3', result: 'invalid', note: '  不对  ' });
  assert.deepEqual(calls[2].args, ['review', 'confirm', '任务 一', 'R1.2-3', 'invalid', '--by', 'human', '--note', '不对']);
  await service.call('review:confirm', { project: proj, name: '任务 一', issue: 'R1-1', result: 'valid', note: '--json 开头的说明' });
  assert.deepEqual(calls[3].args.slice(-2), ['--note', ' --json 开头的说明'], '核心把以 -- 开头的值当缺值，前面补一个空格');
  // 项目不在列表里也能读 / 确认（knownTask 为真时不查登记表）：上面四次一共只有四次核心调用。
  assert.equal(calls.length, 4);
  // 不是主进程读到的任务、项目也没登记：参数无效（和 tasks:diff 一样）。
  const unknown = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [] }, stderr: '' } }]);
  await assert.rejects(createConsole({ coreRun: unknown.coreRun, chooseFolder: async () => null, messages }).call('review:show', { project: proj, name: 'a' }), /参数无效/);
  const refused = createConsole({ coreRun: fakeCore([{ resolve: { code: 2, json: { ok: false, error: '审查：任务 一 的审查结果里没有问题 R9-9（现有：R1-1）' }, stderr: '' } }]).coreRun, chooseFolder: async () => null, messages, knownTask: () => true });
  await assert.rejects(refused.call('review:confirm', { project: proj, name: '任务 一', issue: 'R1-1', result: 'valid' }), /没有问题 R9-9/);
  const bad = fakeCore();
  const guarded = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages, knownTask: () => true });
  for (const payload of [undefined, {}, { project: 'relative', name: 'a' }, { project: proj }, { project: proj, name: '../a' }, { project: proj, name: 'con' }])
    await assert.rejects(guarded.call('review:show', payload), /参数无效/);
  const base = { project: proj, name: 'a', issue: 'R1-1', result: 'valid' };
  for (const payload of [{ ...base, issue: undefined }, { ...base, issue: 'R1' }, { ...base, issue: 'R1-1 --by lead' }, { ...base, issue: '../R1-1' }, { ...base, issue: 'R1-' }, { ...base, result: 'maybe' }, { ...base, result: undefined }, { ...base, note: 7 }, { ...base, note: 'x'.repeat(2001) }, { ...base, name: 'a/b' }])
    await assert.rejects(guarded.call('review:confirm', payload), /参数无效/);
  assert.equal(bad.calls.length, 0, '参数不合法时一条核心命令都不调用');
});

test('158 review:rerun：有 profile 才带 --profile；要求项目已登记（移除后报 projectGoneBlocked）；超时放宽到 50 分钟；核心没有结论时的原因原样抛出', async () => {
  const done = { ok: true, name: '任务 一', attempt: 1, run: 2, review: { verdict: 'pass' } };
  const { calls, coreRun } = fakeCore([...registered({ resolve: { code: 0, json: done, stderr: '' } }), ...registered({ resolve: { code: 0, json: done, stderr: '' } })]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.equal((await service.call('review:rerun', { project: proj, name: '任务 一' })).run, 2);
  assert.deepEqual(calls[1].args, ['review', '任务 一']);
  assert.equal(calls[1].cwd, proj);
  assert.equal(calls[1].timeoutMs, 50 * 60 * 1000);
  await service.call('review:rerun', { project: proj, name: '任务 一', profile: 'rev-two' });
  assert.deepEqual(calls[3].args, ['review', '任务 一', '--profile', 'rev-two']);
  // 项目已从列表移除：不审（在 worktree 里跑审查者，同重试）。
  const gone = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: other }] }, stderr: '' } }]);
  await assert.rejects(createConsole({ coreRun: gone.coreRun, chooseFolder: async () => null, messages }).call('review:rerun', { project: proj, name: 'a' }), /项目已从项目列表移除，先重新添加项目/);
  // 核心没有结论（退出码 1、ok:false）：错误原文原样抛出。
  const failed = fakeCore(registered({ resolve: { code: 1, json: { ok: false, name: 'a', error: '审查没有完成：没有可用的审查者', review: { verdict: 'unknown' } }, stderr: '' } }));
  await assert.rejects(createConsole({ coreRun: failed.coreRun, chooseFolder: async () => null, messages }).call('review:rerun', { project: proj, name: 'a' }), /审查没有完成：没有可用的审查者/);
  const bad = fakeCore();
  const guarded = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages });
  for (const payload of [undefined, {}, { project: 'relative', name: 'a' }, { project: proj }, { project: proj, name: 'a:b' }, { project: proj, name: 'a', profile: '' }, { project: proj, name: 'a', profile: '--json' }, { project: proj, name: 'a', profile: 'a b' }, { project: proj, name: 'a', profile: 7 }])
    await assert.rejects(guarded.call('review:rerun', payload), /参数无效/);
  assert.equal(bad.calls.length, 0, '参数不合法时一条核心命令都不调用');
});

test('158 review:stats / review:config / review:config-set：参数数组；config-set 至少给一项、值的类型与范围不对不调用核心；核心拒绝的原文原样抛出', async () => {
  const stats = { ok: true, reviewers: [{ reviewer: 'codex', severities: { high: { confirmed: 2, valid: 1, accuracy: 0.5 }, medium: { confirmed: 0, valid: 0, accuracy: null }, low: { confirmed: 0, valid: 0, accuracy: null } } }] };
  const view = { ok: true, review: { default: false, block: 'none', maxReworks: 1 } };
  const { calls, coreRun } = fakeCore([{ resolve: { code: 0, json: stats, stderr: '' } }, { resolve: { code: 0, json: view, stderr: '' } }, { resolve: { code: 0, json: { ok: true, review: { default: true, block: 'high', maxReworks: 0 } }, stderr: '' } }, { resolve: { code: 0, json: view, stderr: '' } }]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('review:stats'), stats);
  assert.deepEqual(calls[0].args, ['review', 'stats']);
  assert.equal(calls[0].timeoutMs, 60000);
  assert.deepEqual(await service.call('review:config'), view);
  assert.deepEqual(calls[1].args, ['review', 'config']);
  assert.equal((await service.call('review:config-set', { default: true, block: 'high', maxReworks: 0 })).review.maxReworks, 0);
  assert.deepEqual(calls[2].args, ['review', 'config', 'set', 'default=true', 'block=high', 'maxReworks=0']);
  await service.call('review:config-set', { default: false });
  assert.deepEqual(calls[3].args, ['review', 'config', 'set', 'default=false']);
  const refused = createConsole({ coreRun: fakeCore([{ resolve: { code: 2, json: { ok: false, error: '配置无效，这次没有改动配置' }, stderr: '' } }]).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(refused.call('review:config-set', { block: 'high' }), /这次没有改动配置/);
  const bad = fakeCore();
  const guarded = createConsole({ coreRun: bad.coreRun, chooseFolder: async () => null, messages });
  for (const payload of [undefined, {}, { default: 'true' }, { default: 1 }, { block: 'low' }, { block: 'high --json' }, { maxReworks: -1 }, { maxReworks: 6 }, { maxReworks: 1.5 }, { maxReworks: '2' }])
    await assert.rejects(guarded.call('review:config-set', payload), /参数无效/);
  assert.equal(bad.calls.length, 0, '参数不合法时一条核心命令都不调用');
});

test('tasks:overview：读 dispatch.json 的 gate.merged 与任务说明的目标；目录不在清单里或路径越界拒绝；读不到的项为 null', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ar-overview-'));
  try {
    const repo = path.join(root, 'repo'), dir = path.join(repo, '.agent-runs', '020-成就弹窗');
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(repo, 'docs', 'specs'), { recursive: true });
    await writeFile(path.join(dir, 'dispatch.json'), JSON.stringify({ v: 1, gate: { enabled: true, merged: { allowed_paths: ['src/**', 'tests/**'], verify: ['npm test', 'npm run lint'] } } }));
    await writeFile(path.join(repo, 'docs', 'specs', '020-成就弹窗.md'), ['---', 'id: 020', 'title: 成就弹窗', '---', '', '# 成就弹窗', '', '## 目标', '', '解锁成就时弹出提示，', '自动收起。', '', '第二段不取。', '', '## 范围', '无'].join('\n'));
    const service = createConsole({ coreRun: fakeCore().coreRun, chooseFolder: async () => null, messages, knownRunDir: d => d === dir });
    assert.deepEqual(await service.call('tasks:overview', { dir, repo, spec: 'docs/specs/020-成就弹窗.md' }), { allowed: ['src/**', 'tests/**'], verify: ['npm test', 'npm run lint'], goal: '解锁成就时弹出提示， 自动收起。' });
    assert.deepEqual(await service.call('tasks:overview', { dir }), { allowed: ['src/**', 'tests/**'], verify: ['npm test', 'npm run lint'], goal: null });
    assert.deepEqual(await service.call('tasks:overview', { dir, repo, spec: 'docs/specs/不存在.md' }), { allowed: ['src/**', 'tests/**'], verify: ['npm test', 'npm run lint'], goal: null });
    await assert.rejects(service.call('tasks:overview', { dir: path.join(repo, '.agent-runs', '别的任务') }), /参数无效/);
    await assert.rejects(service.call('tasks:overview', { dir, repo, spec: '../outside.md' }), /参数无效/);
    await assert.rejects(service.call('tasks:overview', { dir, repo, spec: '/etc/x.md' }), /参数无效/);
    await assert.rejects(service.call('tasks:overview', { dir: repo }), /参数无效/);
    const bare = createConsole({ coreRun: fakeCore().coreRun, chooseFolder: async () => null, messages });
    await assert.rejects(bare.call('tasks:overview', { dir }), /参数无效/, '没有注入判断函数时一律拒绝');
    // dispatch.json 读不出来或结构不对：允许改动与验收命令为 null。
    await writeFile(path.join(dir, 'dispatch.json'), '{ bad');
    assert.deepEqual(await service.call('tasks:overview', { dir }), { allowed: null, verify: null, goal: null });
    await writeFile(path.join(dir, 'dispatch.json'), JSON.stringify({ v: 1, gate: { merged: { allowed_paths: 'src', verify: [1] } } }));
    assert.deepEqual(await service.call('tasks:overview', { dir }), { allowed: null, verify: null, goal: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('specGoal：取"## 目标"一节第一段；没有这一节时取第一个非标题段落；都没有为 null', () => {
  assert.equal(specGoal('---\nid: 1\n---\n\n# 标题\n\n## 目标\n\n第一段\n接着。\n\n第二段\n\n## 范围\n'), '第一段 接着。');
  assert.equal(specGoal('# 标题\n\n只有一段说明。\n\n## 范围\n内容'), '只有一段说明。');
  assert.equal(specGoal('# 标题\n## 目标\n## 范围\n内容'), null);
  assert.equal(specGoal(''), null);
  assert.equal(specGoal(`## 目标\n\n${'长'.repeat(400)}`).length, 300);
});

test('gc:check 与 gc:run：参数数组与超时（120 秒）；check 是 --dry-run 且每一项多带 size，run 不带 --dry-run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ar-gc-'));
  try {
    const dir = path.join(root, 'abc123-孤立 任务'), file = path.join(root, 'slot-1.json'), session = path.join(root, 'sessions', '项目');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(session, { recursive: true });
    await writeFile(path.join(dir, 'a.txt'), '12345');
    await writeFile(path.join(dir, 'src', 'b.txt'), '1234567');
    await writeFile(file, '{}');
    await writeFile(path.join(session, 's.jsonl'), 'x'.repeat(100));
    const check = { code: 0, json: { ok: true, worktrees: [{ dir, reason: 'accepted' }, { dir: path.join(root, '不存在'), reason: 'prunable' }], slots: [{ file, id: 'x', pid: 1 }], sessions: [{ worker: 'deepseek', dir: session, ageDays: 30 }], bytes: 4096, lines: ['x'] }, stderr: '' };
    const run = { code: 0, json: { ok: true, worktrees: [{ dir, reason: 'accepted' }], slots: [], sessions: [], bytes: 12, errors: [] }, stderr: '' };
    const { calls, coreRun } = fakeCore([{ resolve: check }, { resolve: run }]);
    const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
    const result = await service.call('gc:check');
    assert.deepEqual(calls[0].args, ['gc', '--dry-run']);
    assert.equal(calls[0].timeoutMs, 120000);
    assert.equal(calls[0].cwd, undefined);
    assert.deepEqual(result.worktrees, [{ dir, reason: 'accepted', size: 12 }, { dir: path.join(root, '不存在'), reason: 'prunable', size: 0 }]);
    assert.deepEqual(result.slots, [{ file, id: 'x', pid: 1, size: 2 }]);
    assert.deepEqual(result.sessions, [{ worker: 'deepseek', dir: session, ageDays: 30, size: 100 }]);
    assert.equal(result.bytes, 4096);
    assert.equal('lines' in result, false);
    assert.deepEqual(await service.call('gc:run'), { ok: true, worktrees: [{ dir, reason: 'accepted' }], slots: [], sessions: [], bytes: 12, errors: [] });
    assert.deepEqual(calls[1].args, ['gc']);
    assert.equal(calls[1].timeoutMs, 120000);
    // 核心拒绝（如配置无效）时原文作为错误抛出；check 不会因此去量大小。
    const refused = createConsole({ coreRun: fakeCore([{ resolve: { code: 2, json: { ok: false, error: '配置：config.json 无法读取' }, stderr: '' } }]).coreRun, chooseFolder: async () => null, messages });
    await assert.rejects(refused.call('gc:check'), /config\.json/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- 107：导入向导扩展用到的 console 操作 ----
test('agents:add 带 effort；agents:update 带 effort / escalate（空串原样传给核心）', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('agents:add', { preset: 'claude-subscription', name: 'sonnet', model: 'm', effort: 'high' });
  assert.deepEqual(calls[0].args, ['agents', 'add', '--preset', 'claude-subscription', '--name', 'sonnet', '--model', 'm', '--effort', 'high']);
  await service.call('agents:update', { name: 'sonnet', effort: '' });
  assert.deepEqual(calls[1].args, ['agents', 'update', 'sonnet', '--effort', '']);
  await service.call('agents:update', { name: 'sonnet', escalate: 'ds' });
  assert.deepEqual(calls[2].args, ['agents', 'update', 'sonnet', '--escalate', 'ds']);
  await service.call('agents:update', { name: 'sonnet', escalate: '' });
  assert.deepEqual(calls[3].args, ['agents', 'update', 'sonnet', '--escalate', '']);
  await assert.rejects(service.call('agents:add', { preset: 'deepseek', effort: '' }), /参数无效/);
  await assert.rejects(service.call('agents:update', { name: 'sonnet', escalate: 'a b' }), /参数无效/);
  await assert.rejects(service.call('agents:update', { name: 'sonnet', effort: 'a\nb' }), /参数无效/);
});

test('agents:add-generic / validate-decl / detect-decl / test-decl：声明对象转成 JSON 参数，校验参数', async () => {
  const decl = { label: 'X', executable: 'x', args: ['{prompt}'], output: { format: 'text' } };
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages, testTimeout: 30 });
  await service.call('agents:add-generic', { name: 'x', decl, label: '我的 CLI' });
  assert.deepEqual(calls[0].args, ['agents', 'add', '--generic', JSON.stringify(decl), '--name', 'x', '--label', '我的 CLI']);
  await service.call('agents:validate-decl', { decl });
  assert.deepEqual(calls[1].args, ['agents', 'validate', '--decl', JSON.stringify(decl)]);
  await service.call('agents:detect-decl', { decl });
  assert.deepEqual(calls[2].args, ['agents', 'detect', '--decl', JSON.stringify(decl)]);
  await service.call('agents:test-decl', { decl });
  assert.deepEqual(calls[3].args, ['agents', 'test', '--decl', JSON.stringify(decl), '--timeout', '60']);
  assert.equal(calls[3].timeoutMs, 80000);
  await service.call('agents:test-decl', { decl, timeout: 5 });
  assert.equal(calls[4].args.at(-1), '5');
  for (const bad of [{ name: 'x' }, { name: 'x', decl: [] }, { name: 'x', decl: 'text' }, { name: 'a b', decl }, { name: 'x', decl: { big: 'x'.repeat(30000) } }]) await assert.rejects(service.call('agents:add-generic', bad), /参数无效/);
  await assert.rejects(service.call('agents:validate-decl', {}), /参数无效/);
  await assert.rejects(service.call('agents:test-decl', { decl, timeout: 0 }), /参数无效/);
  await assert.rejects(service.call('agents:test-decl', { decl, timeout: 1.5 }), /参数无效/);
});

test('校验与预览的 ok:false 结果（带逐条错误 / 原始输出）原样交给界面，其他失败仍抛错', async () => {
  const errors = [{ path: 'generic.args[0]', message: '未知占位符 {x}' }];
  const { coreRun } = fakeCore([
    { resolve: { code: 2, json: { ok: false, errors, warnings: [] }, stderr: '' } },
    { resolve: { code: 1, json: { ok: false, exit: 1, output: [{ stream: 'stdout', text: 'a', events: [] }], unmatched: [1], error: '退出码 1' }, stderr: '' } },
    { resolve: { code: 2, json: { ok: false, error: '声明不合法，没有运行', errors }, stderr: '' } },
    { resolve: { code: 2, json: { ok: false, error: '找不到执行者：x' }, stderr: '' } },
  ]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  const decl = { label: 'X' };
  assert.deepEqual(await service.call('agents:validate-decl', { decl }), { ok: false, errors, warnings: [] });
  const preview = await service.call('agents:test-decl', { decl });
  assert.equal(preview.ok, false); assert.deepEqual(preview.unmatched, [1]); assert.equal(preview.output[0].text, 'a');
  assert.equal((await service.call('agents:test-decl', { decl })).errors.length, 1);
  await assert.rejects(service.call('agents:models', { name: 'x' }), /找不到执行者：x/);
});

test('agents:choose-program / import-file / export：文件由主进程对话框选（测试里注入），取消不调用核心，路径与扩展名校验', async () => {
  const dir = path.resolve('dialog-dir');
  const { calls, coreRun } = fakeCore();
  const opened = [path.join(dir, 'a.json'), null, path.join(dir, 'a.txt'), path.join(dir, 'prog.exe')], saved = [path.join(dir, 'out.json'), null, 'relative.json'];
  const asked = [];
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages, chooseFile: async o => { asked.push(o); return opened.shift(); }, saveFile: async o => { asked.push(o); return saved.shift(); } });
  assert.deepEqual(await service.call('agents:import-file', { name: 'imp', force: true }), { ok: true, file: path.join(dir, 'a.json') });
  assert.deepEqual(calls[0].args, ['agents', 'import', path.join(dir, 'a.json'), '--name', 'imp', '--force']);
  assert.deepEqual(asked[0].filters, [{ name: 'JSON', extensions: ['json'] }], '只允许 .json');
  assert.deepEqual(await service.call('agents:import-file', {}), { cancelled: true });
  assert.equal(calls.length, 1, '取消不调用核心');
  await assert.rejects(service.call('agents:import-file', {}), /参数无效/);
  assert.deepEqual(await service.call('agents:choose-program', {}), { file: path.join(dir, 'prog.exe') });

  assert.deepEqual(await service.call('agents:export', { name: 'ds' }), { ok: true, file: path.join(dir, 'out.json') });
  assert.deepEqual(calls[1].args, ['agents', 'export', 'ds', '--out', path.join(dir, 'out.json'), '--force']);
  assert.equal(asked.at(-1).defaultPath, 'ds.json');
  assert.deepEqual(await service.call('agents:export', { name: 'ds' }), { cancelled: true });
  await assert.rejects(service.call('agents:export', { name: 'ds' }), /参数无效/);
  assert.equal(calls.length, 2);
  await assert.rejects(service.call('agents:export', {}), /参数无效/);
});

// Stage07 T8：路由页的通道。参数先校验（不合法不调用核心），再翻译成 ar route … 命令；JSON 作为参数数组里的一项传。
test('route:config 调 route config，只读、不带参数', async () => {
  const { calls, coreRun } = fakeCore([{ resolve: { code: 0, json: { ok: true, rules: [], fallback: null, lines: ['x'] }, stderr: '' } }]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('route:config', {}), { ok: true, rules: [], fallback: null });
  assert.deepEqual(calls[0].args, ['route', 'config']);
  assert.equal(calls[0].timeoutMs, 60000);
});

test('route:rules 整体替换，规则 JSON 作为一项参数传；规则形状不对不调用核心', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  const rules = [{ types: ['research', 'review'], profile: 'qoder' }, { types: ['code'], profile: 'ds', escalate: null }, { types: ['docs'], profile: 'ds', escalate: 'qoder' }];
  await service.call('route:rules', { rules });
  assert.deepEqual(calls[0].args, ['route', 'rules', 'set', JSON.stringify(rules)]);
  await service.call('route:rules', { rules: [] });
  assert.deepEqual(calls[1].args, ['route', 'rules', 'set', '[]']);
  for (const payload of [
    {}, { rules: 'x' }, { rules: [null] }, { rules: [[]] },
    { rules: [{ types: [], profile: 'ds' }] }, { rules: [{ types: ['code', 'nope'], profile: 'ds' }] }, { rules: [{ types: 'code', profile: 'ds' }] },
    { rules: [{ types: ['code'], profile: '' }] }, { rules: [{ types: ['code'], profile: 'a b' }] }, { rules: [{ types: ['code'], profile: 'ds', escalate: 'a b' }] },
    { rules: [{ types: ['code'], profile: 'ds', extra: 1 }] }, { rules: Array.from({ length: 201 }, () => ({ types: ['code'], profile: 'ds' })) },
  ]) await assert.rejects(service.call('route:rules', payload), /参数无效/, JSON.stringify(payload).slice(0, 80));
  assert.equal(calls.length, 2);
});

// Stage07c 151：规则可带推理强度 effort（不写、null 或非空单行字符串）；route:suggest 只读，调 route suggest。
test('route:rules 规则可带 effort（不写 / null / 非空单行字符串）；effort 不合法不调用核心', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  const rules = [{ types: ['code'], profile: 'ds', effort: 'high' }, { types: ['docs'], profile: 'ds', effort: null }, { types: ['test'], profile: 'ds', escalate: 'qoder', effort: 'low' }];
  await service.call('route:rules', { rules });
  assert.deepEqual(calls[0].args, ['route', 'rules', 'set', JSON.stringify(rules)]);
  for (const effort of ['', '  ', 5, true, 'a\nb', 'x'.repeat(201)])
    await assert.rejects(service.call('route:rules', { rules: [{ types: ['code'], profile: 'ds', effort }] }), /参数无效/, JSON.stringify(effort).slice(0, 40));
  assert.equal(calls.length, 1);
});

test('route:suggest 调 route suggest，只读、不带参数，结果原样交回', async () => {
  const suggestion = { rules: [{ types: ['code'], profile: 'ds', why: '预设建议用于代码' }], skipped: [{ profile: 'cx', why: '测试连接没有通过' }], write: 'ar route rules set ...' };
  const { calls, coreRun } = fakeCore([{ resolve: { code: 0, json: { ok: true, ...suggestion, lines: ['x'] }, stderr: '' } }]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('route:suggest', {}), { ok: true, ...suggestion });
  assert.deepEqual(calls[0].args, ['route', 'suggest']);
  assert.equal(calls[0].timeoutMs, 60000);
});

test('route:fallback：名字是设置，null 是清除；其余不合法', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('route:fallback', { name: 'ds' });
  await service.call('route:fallback', { name: null });
  assert.deepEqual(calls.map(c => c.args), [['route', 'fallback', 'set', 'ds'], ['route', 'fallback', 'clear']]);
  for (const payload of [{}, { name: '' }, { name: 'a b' }, { name: 5 }, { name: undefined }]) await assert.rejects(service.call('route:fallback', payload), /参数无效/);
  assert.equal(calls.length, 2);
});

test('route:reviewer 传 { profiles, mustDiffer } 的 JSON；mustDiffer 必须是布尔', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('route:reviewer', { profiles: ['qoder', 'codex'], mustDiffer: false });
  assert.deepEqual(calls[0].args, ['route', 'reviewer', 'set', JSON.stringify({ profiles: ['qoder', 'codex'], mustDiffer: false })]);
  await service.call('route:reviewer', { profiles: [], mustDiffer: true });
  assert.deepEqual(calls[1].args, ['route', 'reviewer', 'set', JSON.stringify({ profiles: [], mustDiffer: true })]);
  for (const payload of [{}, { profiles: 'qoder', mustDiffer: true }, { profiles: ['a b'], mustDiffer: true }, { profiles: [5], mustDiffer: true }, { profiles: ['qoder'] }, { profiles: ['qoder'], mustDiffer: 'yes' }])
    await assert.rejects(service.call('route:reviewer', payload), /参数无效/);
  assert.equal(calls.length, 2);
});

test('route:limit：正整数是设置，null 传空串表示删除；至少给一项', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('route:limit', { name: 'ds', tasks: 3 });
  await service.call('route:limit', { name: 'ds', tokens: null });
  await service.call('route:limit', { name: 'ds', tasks: null, tokens: 2000000 });
  assert.deepEqual(calls.map(c => c.args), [
    ['route', 'limit', 'set', 'ds', '--tasks', '3'],
    ['route', 'limit', 'set', 'ds', '--tokens', ''],
    ['route', 'limit', 'set', 'ds', '--tasks', '', '--tokens', '2000000'],
  ]);
  for (const payload of [{}, { name: 'ds' }, { name: 'a b', tasks: 1 }, { name: 'ds', tasks: 0 }, { name: 'ds', tasks: -1 }, { name: 'ds', tasks: 1.5 }, { name: 'ds', tasks: '3' }, { name: 'ds', tokens: Number.MAX_SAFE_INTEGER + 1 }])
    await assert.rejects(service.call('route:limit', payload), /参数无效/, JSON.stringify(payload));
  assert.equal(calls.length, 3);
});

// Stage07c 150：可担任 / 模型家族、限流标记、强执行者、审查者"与主导不同"。
test('roles:list 调 ar roles；roles:set 把改过的项写成 roles= / modelFamilies=（空数组表示恢复默认 / 清除），参数先校验', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('roles:list');
  assert.deepEqual(calls[0].args, ['roles']);
  await service.call('roles:set', { name: 'ds', roles: ['reviewer'] });
  await service.call('roles:set', { name: 'ds', roles: ['executor', 'reviewer'], modelFamilies: ['gpt', 'claude'] });
  await service.call('roles:set', { name: 'ds', modelFamilies: [] });
  // 改写（D128，190）：原断言 roles: ['lead'] 被拒绝 → 新断言写成 roles=lead；原因：角色由用户决定，lead 与执行者、审查者一样可设。
  await service.call('roles:set', { name: 'ds', roles: ['lead'] });
  assert.deepEqual(calls.slice(1).map(c => c.args), [
    ['roles', 'set', 'ds', 'roles=reviewer'],
    ['roles', 'set', 'ds', 'roles=executor,reviewer', 'modelFamilies=gpt,claude'],
    ['roles', 'set', 'ds', 'modelFamilies='],
    ['roles', 'set', 'ds', 'roles=lead'],
  ]);
  for (const payload of [{}, { name: 'ds' }, { name: 'a b', roles: ['executor'] }, { name: 'ds', roles: 'executor' }, { name: 'ds', roles: ['executor', 'reviewer', 'executor'] }, { name: 'ds', roles: ['executor', 'reviewer', 'lead', 'lead'] }, { name: 'ds', modelFamilies: ['GPT'] }, { name: 'ds', modelFamilies: ['a,b'] }, { name: 'ds', modelFamilies: 'gpt' }])
    await assert.rejects(service.call('roles:set', payload), /参数无效/, JSON.stringify(payload));
  assert.equal(calls.length, 5);
});

test('route:reviewer 可带 differFromLead（布尔）；不带时 JSON 与以前相同', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('route:reviewer', { profiles: ['qoder'], mustDiffer: true, differFromLead: false });
  assert.deepEqual(calls[0].args, ['route', 'reviewer', 'set', JSON.stringify({ profiles: ['qoder'], mustDiffer: true, differFromLead: false })]);
  await service.call('route:reviewer', { profiles: ['qoder'], mustDiffer: true });
  assert.deepEqual(calls[1].args, ['route', 'reviewer', 'set', JSON.stringify({ profiles: ['qoder'], mustDiffer: true })]);
  await assert.rejects(service.call('route:reviewer', { profiles: ['qoder'], mustDiffer: true, differFromLead: 'no' }), /参数无效/);
  assert.equal(calls.length, 2);
});

test('route:reviewer 可带 differFamily（布尔，D128）；三个开关都不带时 JSON 与以前相同，非布尔不调用核心', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('route:reviewer', { profiles: ['qoder'], mustDiffer: true, differFamily: false });
  assert.deepEqual(calls[0].args, ['route', 'reviewer', 'set', JSON.stringify({ profiles: ['qoder'], mustDiffer: true, differFamily: false })]);
  await service.call('route:reviewer', { profiles: ['qoder'], mustDiffer: true, differFamily: true, differFromLead: false });
  assert.deepEqual(calls[1].args, ['route', 'reviewer', 'set', JSON.stringify({ profiles: ['qoder'], mustDiffer: true, differFamily: true, differFromLead: false })]);
  await service.call('route:reviewer', { profiles: ['qoder'], mustDiffer: true });
  assert.deepEqual(calls[2].args, ['route', 'reviewer', 'set', JSON.stringify({ profiles: ['qoder'], mustDiffer: true })]);
  await assert.rejects(service.call('route:reviewer', { profiles: ['qoder'], mustDiffer: true, differFamily: 'no' }), /参数无效/);
  await assert.rejects(service.call('route:reviewer', { profiles: ['qoder'], mustDiffer: true, differFamily: 0 }), /参数无效/);
  assert.equal(calls.length, 3);
});

test('route:limits-clear 调 route limits clear <名>；route:strong 设置 / 清除强执行者', async () => {
  const { calls, coreRun } = fakeCore();
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('route:limits-clear', { name: 'ds' });
  await service.call('route:strong', { name: 'sonnet' });
  await service.call('route:strong', { name: null });
  assert.deepEqual(calls.map(c => c.args), [['route', 'limits', 'clear', 'ds'], ['route', 'strong', 'set', 'sonnet'], ['route', 'strong', 'clear']]);
  for (const [action, payload] of [['route:limits-clear', {}], ['route:limits-clear', { name: 'a b' }], ['route:strong', {}], ['route:strong', { name: 'a b' }]])
    await assert.rejects(service.call(action, payload), /参数无效/, `${action} ${JSON.stringify(payload)}`);
  assert.equal(calls.length, 3);
});

// 改写（168，D104）：原断言 route:config 从 limits.json 给被限流的执行者补上 limited.evidence（只补核心说已被限流的、没有原文就不带；没有限流时不读文件）
// → 新断言 route:config 原样返回核心的结果（限流原文由核心给），limits.json 里有别的原文也不会被读进来，只调用一次 ar route config --json
// → 原因：D104 限流原文由核心给，主进程不再读 limits.json。
test('route:config：原样返回核心的结果（限流原文由核心给），主进程不读 limits.json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ar-limits-'));
  const saved = process.env.AGENT_ROUTER_HOME, soon = Date.now() + 3600000;
  try {
    process.env.AGENT_ROUTER_HOME = dir;
    // limits.json 里的原文和核心给的不同、还有没被核心说限流的执行者的原文：主进程不读它，哪一条都不会出现在结果里。
    await writeFile(path.join(dir, 'limits.json'), JSON.stringify({ v: 1, profiles: {
      ds: { kind: 'limit', until: soon, since: Date.now(), evidence: '文件里的原文（不应出现）' },
      other: { kind: 'limit', until: soon, since: Date.now(), evidence: '别的执行者的原文' },
      noevidence: { kind: 'unavailable', until: soon, since: Date.now(), evidence: '文件里的原文（不应出现）' },
    } }));
    const view = { ok: true, profiles: [
      { name: 'ds', limited: { kind: 'limit', until: soon, since: 1, evidence: 'rate_limit_event status rejected' } },
      { name: 'noevidence', limited: { kind: 'unavailable', until: soon, since: 1 } },
      { name: 'free' },
    ] };
    const { calls, coreRun } = fakeCore([{ resolve: { code: 0, json: { ...view, lines: [] }, stderr: '' } }]);
    const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
    assert.deepEqual(await service.call('route:config'), view);
    assert.deepEqual(calls.map(c => c.args), [['route', 'config']]);
  } finally {
    if (saved === undefined) delete process.env.AGENT_ROUTER_HOME; else process.env.AGENT_ROUTER_HOME = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('route:trial：类型、任务说明、项目都是可选的；项目要先核对已登记；失败时返回 trace 而不是抛错', async () => {
  const ok = { resolve: { code: 0, json: { ok: true, profile: 'ds', label: 'DS', rule: null, trace: ['兜底：ds'], lines: [] }, stderr: '' } };
  const { calls, coreRun } = fakeCore([ok, ...registered(ok), ...registered(ok)]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  // 不限项目：不查登记表，在系统临时目录里运行，不读任何项目自己的规则。
  assert.deepEqual(await service.call('route:trial', { type: 'docs' }), { ok: true, profile: 'ds', label: 'DS', rule: null, trace: ['兜底：ds'] });
  assert.deepEqual(calls[0].args, ['route', '--type', 'docs', '--explain']);
  assert.equal(calls[0].cwd, tmpdir());
  await service.call('route:trial', { type: 'research', project: proj });
  assert.deepEqual(calls[1].args, ['projects', 'list', '--registry-only']);
  assert.deepEqual(calls[2].args, ['route', '--type', 'research', '--project', proj, '--explain']);
  assert.equal(calls[2].cwd, proj);
  await service.call('route:trial', { spec: 'docs/specs/001-demo.md', project: proj });
  assert.deepEqual(calls[4].args, ['route', '--spec', 'docs/specs/001-demo.md', '--project', proj, '--explain']);
  for (const payload of [{ type: 'nope' }, { type: 5 }, { spec: 'a.txt', project: proj }, { spec: 'docs/a.md' }, { spec: 'docs/a.md', type: 'code', project: proj }, { project: 'relative/path' }, { project: proj, type: '' }])
    await assert.rejects(service.call('route:trial', payload), /参数无效/, JSON.stringify(payload));
  assert.equal(calls.length, 5);
  // 没有可用的执行者：核心退出码 2、json 带 code / error / trace，通道把它当结果返回。
  const failing = createConsole({ coreRun: fakeCore([{ resolve: { code: 2, json: { ok: false, code: 'NO_PROFILE', error: '没有可用的执行者处理「research」类任务', trace: ['兜底：plain：不支持只读任务，跳过'] }, stderr: '' } }]).coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await failing.call('route:trial', { type: 'research' }), { failed: true, code: 'NO_PROFILE', error: '没有可用的执行者处理「research」类任务', trace: ['兜底：plain：不支持只读任务，跳过'] });
  // 其他失败（没有 trace，如配置文件无效）仍是通道错误。
  const refused = createConsole({ coreRun: fakeCore([{ resolve: { code: 2, json: { ok: false, error: '配置：config.json 无法读取' }, stderr: '' } }]).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(refused.call('route:trial', { type: 'docs' }), /config\.json/);
});

test('路由写入通道：核心拒绝时原因原样抛出', async () => {
  const refused = createConsole({ coreRun: fakeCore([{ resolve: { code: 2, json: { ok: false, error: '第 1 条规则的执行者 ds 不存在' }, stderr: '' } }]).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(refused.call('route:rules', { rules: [{ types: ['code'], profile: 'ds' }] }), /执行者 ds 不存在/);
});

// Stage07c 144：agents:models 带 probe: true 走 ar agents models <名> --probe；查到、退回预设都是正常结果，不带 probe 的调用不变。
test('agents:models probe：参数数组、查到与退回预设都原样返回，通道出错与参数无效抛出', async () => {
  const found = { ok: true, source: 'program', models: ['m-1'], details: [{ id: 'm-1', name: 'M 1', efforts: ['low', 'high'], defaultEffort: 'low' }] };
  const fallback = { ok: false, source: 'preset', models: ['p-1'], reason: '订阅令牌不能查询模型列表' };
  const { calls, coreRun } = fakeCore([
    { resolve: { code: 0, json: { ...found, lines: ['x'] }, stderr: '' } },
    { resolve: { code: 0, json: fallback, stderr: '' } },
    { resolve: { code: 2, json: { ok: false, error: '找不到执行者：x' }, stderr: '' } },
    { resolve: { code: 0, json: { ok: true, models: ['a'], source: 'cli' }, stderr: '' } },
  ]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('agents:models', { name: 'codex', probe: true }), found);
  assert.deepEqual(calls[0].args, ['agents', 'models', 'codex', '--probe']);
  assert.deepEqual(await service.call('agents:models', { name: 'sonnet', probe: true }), fallback);
  await assert.rejects(service.call('agents:models', { name: 'x', probe: true }), /找不到执行者：x/);
  // 不带 probe：命令不变（没有 --probe）。
  assert.equal((await service.call('agents:models', { name: 'q' })).source, 'cli');
  assert.deepEqual(calls[3].args, ['agents', 'models', 'q']);
  const before = calls.length;
  for (const bad of [{ name: 'bad name', probe: true }, { name: 'ok', probe: 'yes' }, { probe: true }]) await assert.rejects(service.call('agents:models', bad), /参数无效/);
  assert.equal(calls.length, before, '参数无效时不调用核心');
  // 其他不带 reason 的 ok:false（不是退回预设）仍是错误。
  const broken = createConsole({ coreRun: fakeCore([{ resolve: { code: 1, json: { ok: false }, stderr: '' } }]).coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(broken.call('agents:models', { name: 'ds', probe: true }), /核心没有返回结果/);
});

// Stage07c 168（D102）：agents:models 带 preset 是导入之前查，走 ar agents models --preset … --probe；参数和 agents:add 同样校验。
test('agents:models preset：导入之前查的参数数组、查到与退回预设都原样返回，参数无效时不调用核心', async () => {
  const found = { ok: true, source: 'api', models: ['m-1'], details: [{ id: 'm-1' }] };
  const fallback = { ok: false, source: 'preset', models: ['p-1'], reason: '没有设置密钥环境变量 K' };
  const { calls, coreRun } = fakeCore([
    { resolve: { code: 0, json: { ...found, lines: ['x'] }, stderr: '' } },
    { resolve: { code: 0, json: fallback, stderr: '' } },
    { resolve: { code: 0, json: found, stderr: '' } },
    { resolve: { code: 2, json: { ok: false, error: '没有这个预设：nope' }, stderr: '' } },
  ]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  assert.deepEqual(await service.call('agents:models', { preset: 'deepseek', probe: true }), found);
  assert.deepEqual(calls[0].args, ['agents', 'models', '--preset', 'deepseek', '--probe']);
  assert.deepEqual(await service.call('agents:models', { preset: 'deepseek', baseUrl: 'http://127.0.0.1:1', secretVar: 'MY_KEY', model: 'm-1', auth: 'token', probe: true }), fallback);
  assert.deepEqual(calls[1].args, ['agents', 'models', '--preset', 'deepseek', '--model', 'm-1', '--base-url', 'http://127.0.0.1:1', '--secret-var', 'MY_KEY', '--auth', 'token', '--probe']);
  await service.call('agents:models', { preset: 'codex', auth: 'login', probe: true });
  assert.deepEqual(calls[2].args, ['agents', 'models', '--preset', 'codex', '--auth', 'login', '--probe']);
  await assert.rejects(service.call('agents:models', { preset: 'nope', probe: true }), /没有这个预设：nope/);
  const before = calls.length;
  const bad = [
    { preset: 'bad name', probe: true }, { preset: 5, probe: true }, { preset: '', probe: true },
    { preset: 'deepseek' }, { preset: 'deepseek', probe: false }, { preset: 'deepseek', probe: 'yes' },
    { preset: 'deepseek', name: 'ds', probe: true },
    { preset: 'deepseek', baseUrl: 'http://a\nb', probe: true }, { preset: 'deepseek', baseUrl: 'x'.repeat(201), probe: true }, { preset: 'deepseek', baseUrl: 5, probe: true },
    { preset: 'deepseek', secretVar: '1bad', probe: true }, { preset: 'deepseek', secretVar: 'a b', probe: true },
    { preset: 'deepseek', auth: 'password', probe: true }, { preset: 'deepseek', model: 'a\nb', probe: true },
  ];
  for (const payload of bad) await assert.rejects(service.call('agents:models', payload), /参数无效/, JSON.stringify(payload));
  assert.equal(calls.length, before, '参数无效时不调用核心');
});