import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createConsole, claudeLaunch } from '../../app/src/main/console.mjs';
import { dayGroup } from '../../app/src/shared/types.ts';

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
