import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createConsole, claudeLaunch } from '../../app/src/main/console.mjs';

// 与 app/src/shared/copy.ts 的 cx 同形的假文案（.mjs 不能直接导入 TS）。
const messages = {
  invalid: '参数无效，操作没有执行',
  noResult: '核心没有返回结果',
  unknownProject: '这个项目没有登记，先在项目页添加',
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

test('projects:config 数组用 JSON.stringify，键白名单校验', async () => {
  const { calls, coreRun } = fakeCore(registered({ resolve: { code: 0, json: { ok: true, config: {} }, stderr: '' } }));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('projects:config', { path: proj, set: { baseBranch: 'main', allowedPaths: ['src/**', 'a/b'], specsDir: 'docs/specs' } });
  assert.deepEqual(calls[1].args, ['projects', 'config', proj, 'baseBranch=main', `allowedPaths=${JSON.stringify(['src/**', 'a/b'])}`, 'specsDir=docs/specs']);
  await assert.rejects(service.call('projects:config', { path: proj, set: { unknown: 'x' } }), /参数无效/);
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

test('specs:list / specs:read 调 spec 子命令', async () => {
  const { calls, coreRun } = fakeCore([...registered({ resolve: { code: 0, json: { ok: true }, stderr: '' } }), ...registered({ resolve: { code: 0, json: { ok: true }, stderr: '' } })]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await service.call('specs:list', { project: proj });
  await service.call('specs:read', { project: proj, rel: 'docs/specs/001-demo.md' });
  assert.deepEqual(calls[1].args, ['spec', 'list', proj]);
  assert.deepEqual(calls[3].args, ['spec', 'read', proj, 'docs/specs/001-demo.md']);
});

test('specs:new 表单经 input 传入，--dry-run / --commit 按需', async () => {
  const { calls, coreRun } = fakeCore(registered({ resolve: { code: 0, json: { ok: true }, stderr: '' } }));
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  const form = { title: '任务', goal: '目标' };
  await service.call('specs:new', { project: proj, form, dryRun: true });
  assert.deepEqual(calls[1].args, ['spec', 'new', proj, '--dry-run']);
  assert.equal(calls[1].input, JSON.stringify(form));
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

test('tasks:redispatch 对未登记项目报 unknownProject，派发命令不执行', async () => {
  const { calls, coreRun } = fakeCore([{ resolve: { code: 0, json: { ok: true, projects: [{ path: proj }] }, stderr: '' } }]);
  const service = createConsole({ coreRun, chooseFolder: async () => null, messages });
  await assert.rejects(service.call('tasks:redispatch', { project: other, name: 'ok' }), /这个项目没有登记/);
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
  assert.deepEqual(core.calls.map(c => c.args), [['projects', 'list', '--registry-only'], ['projects', 'list', '--registry-only']], '只查了登记，没有其他核心命令');
  const unregistered = fakeCore(registered(undefined).slice(0, 1));
  const s2 = createConsole({ coreRun: unregistered.coreRun, chooseFolder: async () => null, messages, launch: async () => assert.fail('不应启动') });
  await assert.rejects(s2.call('shell:open-claude', { path: other }), /这个项目没有登记/);
  await assert.rejects(s2.call('shell:open-claude', { path: 'relative' }), /参数无效/);
});
