import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlan, executePlan } from '../../installer/lib/install.mjs';
import { createManaged } from '../../app/src/main/managed.mjs';
import { handoff, terminalReader, managedEnvironment, validRequest, viewerApp, managedMessage } from '../../core/lib/managed.mjs';
import { registryWriter } from '../../core/lib/records.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = home => { try { const s = fs.readFileSync(path.join(home, 'runs.jsonl'), 'utf8'); return s.slice(0, s.lastIndexOf('\n')).split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
// label 与 home 只用于诊断（PR #5 CI）：超时时写明等的是什么、此刻记录里有哪些事件；上限与判断不变。
async function until(fn, timeout = 10000, label = '', home = '') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = fn(); if (result) return result; await delay(25); }
  throw Error(`隔离测试等待超时${label ? `：${label}` : ''}${home ? `；此刻记录事件 ${rows(home).map(r => r.event + (r.exit !== undefined ? ' exit=' + r.exit : '')).join('、') || '（没有）'}` : ''}`);
}
async function fixture(t, { exit = 0, duration = 150, stderr = '', tree = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatchdock-managed-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo'), host = path.join(base, 'host');
  for (const dir of [home, repo, host]) fs.mkdirSync(dir);
  const env = { ...process.env, CODEX_DISPATCH_HOME: home, USERPROFILE: base, HOME: base, APPDATA: path.join(base, 'appdata'),
    CLAUDE_CONFIG_DIR: host, CODEX_HOME: path.join(base, 'codex'), XDG_CONFIG_HOME: path.join(base, 'xdg'), CODEX_NO_WATCH: '1' };
  for (const key of ['CODEX_DRY_RUN','CODEX_MODEL','CODEX_EFFORT','CODEX_TIER','CODEX_SANDBOX','CODEX_DISPATCH_TEST_AGENT','NODE_OPTIONS','ELECTRON_RUN_AS_NODE']) delete env[key];
  const agent = path.join(base, 'fake-agent.cjs');
  if (tree) fs.writeFileSync(path.join(base, 'descendant.cjs'), `require('node:fs').writeFileSync(require('node:path').join(__dirname,'descendant.json'),JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
  fs.writeFileSync(path.join(base, 'agent.json'), JSON.stringify({ exit, duration, stderr }));
  fs.writeFileSync(agent, `const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('codex-cli fake-managed');process.exit(0);}
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{
const settings=JSON.parse(fs.readFileSync(path.join(__dirname,'agent.json'),'utf8'));
${tree ? "require('node:child_process').spawn(process.execPath,[path.join(__dirname,'descendant.cjs')],{stdio:'ignore',windowsHide:true,shell:false});" : ''}
fs.writeFileSync(path.join(__dirname,'echo.json'),JSON.stringify({pid:process.pid,args:process.argv.slice(2),prompt,home:process.env.CODEX_HOME,key:process.env.OPENAI_API_KEY}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'隔离任务正在执行'}}));
setTimeout(()=>{fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'隔离汇报');if(settings.stderr)process.stderr.write(settings.stderr+'\\n');process.exitCode=settings.exit;},settings.duration);
});`);
  const configFile = path.join(home, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ v: 1, managed: true, watchWindow: 'never', agents: { codex: { path: agent } } }));
  fs.writeFileSync(path.join(home, 'viewer.json'), JSON.stringify({ pid: process.pid, acceptsManaged: true, suppressWatchWindow: true }));
  executePlan(createPlan({ env, host: 'claude-code', skill: 'agent-router' }), { env });
  const script = path.join(host, 'skills/agent-router/core/ar.mjs');
  const children = new Set(), services = [];
  function launch(file = script, args = ['隔离任务', '--name', 'managed-test'], overrides = {}) {
    const child = spawn(process.execPath, [file, ...args], { cwd: repo, env: { ...env, ...overrides }, stdio: ['ignore','pipe','pipe','ipc'], windowsHide: true, shell: false });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); });
    return child;
  }
  async function service() { const errors = [], warnings = []; const s = await createManaged(root, env, e => errors.push(e), w => warnings.push(w)); s.start(); services.push(s); return { s, errors, warnings }; }
  t.after(async () => {
    services.forEach(s => s.close());
    for (const child of children) if (child.exitCode === null && child.signalCode === null && alive(child.pid)) child.kill();
    // 只清理本 fixture 启动并记录的执行者，绝不按进程名终止。
    for (const r of rows(home).filter(r => r.event === 'start' && r.managed)) if (alive(r.pid)) {
      if (process.platform === 'win32') await execute('taskkill.exe', ['/PID', String(r.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
      else process.kill(r.pid);
    }
    assert.ok(path.relative(os.tmpdir(), base).startsWith('dispatchdock-managed-'));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { base, home, repo, env, script, agent, configFile, launch, service };
}

test('托管完整流程：退出码、唯一清单、执行者 PID、预计算配置、进度和清理', async t => {
  const f = await fixture(t, { exit: 7, stderr: 'Not inside a trusted directory' }); const { errors } = await f.service();
  const waiter = f.launch(f.script, ['隔离任务','补充说明','--name','managed-test','--model','explicit-model'], { CODEX_EFFORT: 'high' });
  const result = await waiter.done;
  assert.equal(result.code, 7, result.stderr);
  assert.match(result.stdout, /^记录名：managed-test\r?\n进度：/);
  assert.match(result.stdout, /托管：任务已交给 AgentRouter/);
  // 托管时出错原因也要回到等待者的输出里。
  assert.match(result.stdout, /出错：Not inside a trusted directory\r?\n出错：当前目录不是 git 仓库[^\n]*\r?\nexit=7 /);
  const records = rows(f.home); assert.deepEqual(records.map(r => r.event), ['start','spawned','end']);
  const [start, spawned, end] = records;
  assert.equal(start.managed, true); assert.notEqual(start.pid, waiter.pid); assert.equal(end.exit, 7);
  assert.equal(start.model, 'explicit-model'); assert.equal(start.effort, 'high');
  const echo = json(path.join(f.base, 'echo.json')); assert.equal(spawned.agentPid, echo.pid); assert.equal(echo.prompt, '任务：\n隔离任务\n补充说明'); assert.equal(echo.home, f.env.CODEX_HOME);
  const progress = fs.readFileSync(start.progress, 'utf8'); assert.equal((progress.match(/托管：任务已交给/g) || []).length, 1); assert.match(progress.trimEnd(), /=== Codex 结束：exit=7.*===$/);
  await until(() => fs.readdirSync(path.join(f.home, 'managed')).length === 0); assert.deepEqual(errors, []);
});

for (const kind of ['outside','modified','node']) test(`托管拒绝 ${kind}：等待者立即回退且只运行一次`, async t => {
  const f = await fixture(t);
  let script = f.script;
  if (kind === 'outside') script = path.join(root, 'core/ar.mjs');
  if (kind === 'modified') fs.appendFileSync(path.join(path.dirname(script), 'lib/progress.mjs'), '\n// 隔离测试修改\n');
  const waiter = f.launch(script);
  await until(() => fs.existsSync(path.join(f.home, 'managed')) && fs.readdirSync(path.join(f.home, 'managed')).some(s => s.endsWith('.request.json')));
  if (kind === 'node') {
    const requestFile = path.join(f.home, 'managed', fs.readdirSync(path.join(f.home, 'managed')).find(s => s.endsWith('.request.json')));
    fs.writeFileSync(requestFile, JSON.stringify({ ...json(requestFile), node: path.join(f.base, 'missing/node.exe') }));
  }
  const before = Date.now(); await f.service();
  const result = await waiter.done;
  assert.equal(result.code, 0, result.stderr); assert.ok(Date.now() - before < 4000);
  assert.match(result.stdout, kind === 'node' ? /没有接手（node 路径无效）/ : /没有接手（派发脚本不是由 AgentRouter 安装的，或者被改过）/);
  const all = rows(f.home); assert.deepEqual(all.map(r => r.event), ['start','spawned','end']); assert.equal(all[0].managed, undefined); assert.equal(all[0].pid, waiter.pid);
  assert.match(fs.readFileSync(all[0].progress, 'utf8'), /改为直接运行/);
});

test('五秒超时：收回请求并直接运行', async t => {
  const f = await fixture(t), before = Date.now(), waiter = f.launch();
  const result = await waiter.done;
  assert.equal(result.code, 0, result.stderr); assert.ok(Date.now() - before >= 5000); assert.ok(Date.now() - before < 9000);
  assert.match(result.stdout, /没有接手（超时）/); assert.equal(rows(f.home)[0].pid, waiter.pid);
  assert.ok(fs.readdirSync(path.join(f.home, 'managed')).some(s => s.endsWith('.withdrawn.json')));
  await f.service(); await until(() => !fs.readdirSync(path.join(f.home, 'managed')).length);
});

test('认领后执行者启动失败写 rejected，等待者立即回退且只运行一份', async t => {
  const f = await fixture(t), waiter = f.launch();
  const requestFile = await until(() => {
    const dir = path.join(f.home, 'managed');
    if (!fs.existsSync(dir)) return null;
    const name = fs.readdirSync(dir).find(s => s.endsWith('.request.json')); return name && path.join(dir, name);
  });
  const invalidNode = path.join(f.base, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.writeFileSync(invalidNode, '本文件不是可执行程序');
  fs.writeFileSync(requestFile, JSON.stringify({ ...json(requestFile), node: invalidNode }));
  const before = Date.now();
  await f.service();
  const rejected = requestFile.replace('.request.json', '.rejected.json');
  assert.match(json(rejected).reason, /启动 Codex 失败/);
  const result = await waiter.done;
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /没有接手（启动 Codex 失败/);
  assert.ok(Date.now() - before < 4000);
  assert.deepEqual(rows(f.home).map(r => r.event), ['start','spawned','end']); assert.equal(rows(f.home)[0].pid, waiter.pid);
  assert.equal(rows(f.home)[0].managed, undefined);
});

async function requestFrom(f) {
  return until(() => {
    const dir = path.join(f.home, 'managed');
    if (!fs.existsSync(dir)) return null;
    const name = fs.readdirSync(dir).find(s => s.endsWith('.request.json'));
    return name && path.join(dir, name);
  });
}

for (const [label, app, expected] of [
  ['默认名字', 'AgentRouter', 'AgentRouter'],
  ['其他名字', '  示例监控器  ', '示例监控器'],
  ['空', ' \t ', 'AgentRouter'],
  ['缺失', undefined, 'AgentRouter'],
  ['超长', '监控🚀'.repeat(20), '监控🚀'.repeat(13) + '监'],
  ['非法类型', 123, 'AgentRouter'],
]) for (const accepted of [true, false]) test(`托管软件名 ${label}：${accepted ? '接手成功' : '拒绝回退'}且输出与进度一致`, async t => {
  const f = await fixture(t), viewer = path.join(f.home, 'viewer.json');
  fs.writeFileSync(viewer, JSON.stringify({ ...json(viewer), app }));
  const waiter = f.launch(), file = await requestFrom(f);
  const request = json(file);
  assert.equal(request.app, expected);
  assert.equal(validRequest(request), true);
  // 请求发出后更换软件名，两端仍使用请求中的快照。
  fs.writeFileSync(viewer, JSON.stringify({ ...json(viewer), app: '后来启动的监控器' }));
  if (accepted) await f.service();
  else {
    fs.writeFileSync(file, JSON.stringify({ ...request, reason: '隔离测试拒绝' }));
    fs.renameSync(file, file.replace('.request.json', '.rejected.json'));
  }
  const result = await waiter.done;
  assert.equal(result.code, 0, result.stderr);
  const message = accepted
    ? `托管：任务已交给 ${expected}，关掉当前会话也不会中断。`
    : `托管：${expected} 没有接手（隔离测试拒绝），改为直接运行`;
  assert.deepEqual(result.stdout.split(/\r?\n/).filter(line => line.startsWith('托管：')), [message]);
  const start = rows(f.home)[0];
  assert.equal(start.managed, accepted ? true : undefined);
  const progress = fs.readFileSync(start.progress, 'utf8').split(/\r?\n/).filter(line => line.includes('托管：'));
  assert.equal(progress.length, 1);
  assert.equal(progress[0].replace(/^\[[^\]]+\] /, ''), message);
});

test('旧请求没有 app：执行者使用默认名字，不读取当前 viewer 名字', async t => {
  const f = await fixture(t), waiter = f.launch(), file = await requestFrom(f);
  const request = json(file); delete request.app;
  fs.writeFileSync(file, JSON.stringify(request));
  fs.writeFileSync(path.join(f.home, 'viewer.json'), JSON.stringify({ pid: process.pid, acceptsManaged: true, app: '另一个监控器' }));
  await f.service();
  const result = await waiter.done;
  assert.equal(result.code, 0, result.stderr);
  const message = managedMessage();
  assert.ok(result.stdout.includes(message));
  assert.ok(fs.readFileSync(rows(f.home)[0].progress, 'utf8').includes(message));
});

test('viewer 无法读取或内容无效时软件名回退', async t => {
  const f = await fixture(t), viewer = path.join(f.home, 'viewer.json');
  fs.unlinkSync(viewer);
  assert.equal(viewerApp(f.home), 'AgentRouter');
  for (const content of ['{', 'null', '[]', '{"app":false}']) {
    fs.writeFileSync(viewer, content);
    assert.equal(viewerApp(f.home), 'AgentRouter');
  }
});

test('请求不写密钥；执行者环境是白名单：软件环境里的密钥不传给执行者，请求覆盖普通环境', async t => {
  const f = await fixture(t);
  f.env.OPENAI_API_KEY = 'fake-monitor-key';
  const waiter = f.launch(f.script, ['隔离任务'], { OPENAI_API_KEY: 'fake-waiter-key', CODEX_HOME: path.join(f.base, 'request-codex') });
  const file = await requestFrom(f), text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /OPENAI_API_KEY|fake-monitor-key|fake-waiter-key/);
  assert.equal(validRequest({ ...json(file), env: { ...json(file).env, OPENAI_API_KEY: 'fake' } }), false);
  await f.service(); assert.equal((await waiter.done).code, 0);
  const echo = json(path.join(f.base, 'echo.json'));
  assert.equal(echo.key, undefined, '没有在 profile 里声明的密钥不传'); assert.equal(echo.home, path.join(f.base, 'request-codex'));
});

test('托管：profile 声明的 secrets 由托管执行者从软件环境解析后注入，不用派发方环境里的值', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.configFile, JSON.stringify({ v: 2, managed: true, watchWindow: 'never', defaultProfile: 'codex', profiles: { codex: { adapter: 'codex', path: f.agent, secrets: { OPENAI_API_KEY: 'TEST_CODEX_KEY_SOURCE' } } } }));
  f.env.TEST_CODEX_KEY_SOURCE = 'fake-monitor-key';
  const waiter = f.launch(f.script, ['隔离任务'], { TEST_CODEX_KEY_SOURCE: 'fake-waiter-key' });
  const file = await requestFrom(f);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /fake-monitor-key|fake-waiter-key/);
  await f.service(); assert.equal((await waiter.done).code, 0);
  assert.equal(json(path.join(f.base, 'echo.json')).key, 'fake-monitor-key');
});

test('认领后未启动：超时收回直接运行，迟到执行者不写任何记录', async t => {
  const f = await fixture(t), waiter = f.launch(f.script, ['隔离任务'], { CODEX_DISPATCH_TEST_START_TIMEOUT_MS: '150' });
  const file = await requestFrom(f), claimed = file.replace('.request.json', '.claimed.json');
  fs.renameSync(file, claimed);
  const before = Date.now(), result = await waiter.done;
  assert.equal(result.code, 0, result.stderr); assert.ok(Date.now() - before >= 150);
  assert.match(result.stdout, /没有接手（软件没有启动任务）/);
  assert.ok(fs.existsSync(claimed.replace('.claimed.json', '.withdrawn.json')));
  const records = fs.readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8');
  const runs = path.join(f.repo, '.agent-runs');
  const files = fs.readdirSync(runs, { recursive: true }).filter(name => fs.statSync(path.join(runs, name)).isFile()).map(name => [name, fs.readFileSync(path.join(runs, name), 'utf8')]);
  const late = await f.launch(f.script, ['--run-request', claimed]).done;
  assert.equal(late.code, 0); assert.equal(late.stdout, ''); assert.equal(late.stderr, '');
  assert.equal(fs.readFileSync(path.join(f.home, 'runs.jsonl'), 'utf8'), records);
  for (const [name, value] of files) assert.equal(fs.readFileSync(path.join(runs, name), 'utf8'), value);
  assert.deepEqual(rows(f.home).map(r => r.event), ['start','spawned','end']);
});

for (const executorFirst of [true, false]) test(`执行者与收回竞争：执行者先取得运行权=${executorFirst}`, async t => {
  const f = await fixture(t, { duration: 300 });
  const waiter = f.launch(f.script, ['隔离任务'], { CODEX_DISPATCH_TEST_START_TIMEOUT_MS: executorFirst ? '1500' : '100' });
  const file = await requestFrom(f), claimed = file.replace('.request.json', '.claimed.json');
  fs.renameSync(file, claimed);
  if (!executorFirst) await until(() => fs.existsSync(claimed.replace('.claimed.json', '.withdrawn.json')));
  const executor = f.launch(f.script, ['--run-request', claimed]);
  const [a, b] = await Promise.all([waiter.done, executor.done]);
  assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
  assert.deepEqual(rows(f.home).map(r => r.event), ['start','spawned','end']);
  assert.equal(rows(f.home)[0].pid, executorFirst ? executor.pid : waiter.pid);
  assert.equal(fs.existsSync(claimed.replace('.claimed.json', '.running.json')), executorFirst);
});

test('认领后收到拒绝立即回退，不等启动兜底期限', async t => {
  const f = await fixture(t), waiter = f.launch();
  const file = await requestFrom(f), claimed = file.replace('.request.json', '.claimed.json');
  fs.renameSync(file, claimed); await delay(150);
  const rejected = claimed.replace('.claimed.json', '.rejected.json');
  fs.renameSync(claimed, rejected);
  fs.writeFileSync(rejected + '.tmp', JSON.stringify({ ...json(rejected), reason: '隔离测试拒绝' }));
  fs.renameSync(rejected + '.tmp', rejected);
  const before = Date.now(), result = await waiter.done;
  assert.equal(result.code, 0); assert.ok(Date.now() - before < 4000);
  assert.match(result.stdout, /任务已交给 AgentRouter/); assert.match(result.stdout, /没有接手（隔离测试拒绝）/);
  assert.equal(rows(f.home).filter(r => r.event === 'start').length, 1);
});

test('收回与执行者改名并发发生，始终只运行一份', async t => {
  const f = await fixture(t);
  const gate = path.join(f.base, 'executor-gate.mjs');
  fs.writeFileSync(gate, `import {run} from ${JSON.stringify(new URL('../../core/lib/run.mjs', import.meta.url).href)};
import {codex} from ${JSON.stringify(new URL('../../core/adapters/codex.mjs', import.meta.url).href)};
process.send('ready');process.once('message',async file=>{process.disconnect();process.exitCode=await run({adapter:codex,scriptPath:${JSON.stringify(f.script)},args:['--run-request',file]});});`);
  for (let i = 0; i < 3; i++) {
    const executor = f.launch(gate, []);
    await new Promise(resolve => executor.once('message', resolve));
    const waiter = f.launch(f.script, ['隔离任务','--name',`concurrent-${i}`], { CODEX_DISPATCH_TEST_START_TIMEOUT_MS: '100' });
    const file = await requestFrom(f), request = json(file), claimed = file.replace('.request.json', '.claimed.json');
    fs.renameSync(file, claimed);
    await delay(100); executor.send(claimed);
    const [a, b] = await Promise.all([waiter.done, executor.done]);
    assert.equal(a.code, 0, a.stderr); assert.equal(b.code, 0, b.stderr);
    const records = rows(f.home).filter(r => r.id === request.id);
    assert.deepEqual(records.map(r => r.event), ['start','spawned','end']);
    assert.ok([executor.pid,waiter.pid].includes(records[0].pid));
  }
});

test('执行者使用请求快照：认领前更改默认配置，不影响本次参数与指定 agent', async t => {
  const f = await fixture(t), waiter = f.launch(f.script, ['隔离任务','--model','snapshot-model']);
  await until(() => fs.existsSync(path.join(f.home, 'managed')) && fs.readdirSync(path.join(f.home, 'managed')).some(s => s.endsWith('.request.json')));
  fs.writeFileSync(f.configFile, JSON.stringify({v:1,managed:false,agents:{codex:{path:path.join(f.base,'missing-agent.exe'),model:'changed-model',sandbox:'read-only'}}}));
  await f.service(); assert.equal((await waiter.done).code,0);
  const start = rows(f.home)[0]; assert.equal(start.model,'snapshot-model'); assert.equal(start.sandbox,'workspace-write'); assert.equal(start.managed,true);
});

test('角色文件消失时拒绝请求，不产生托管执行记录', async t => {
  const f = await fixture(t), role = path.join(f.repo, 'role.md'); fs.writeFileSync(role, '# 角色：测试角色');
  const waiter = f.launch(f.script, ['隔离任务','--role','role.md']);
  await until(() => fs.existsSync(path.join(f.home, 'managed')) && fs.readdirSync(path.join(f.home, 'managed')).some(s => s.endsWith('.request.json')));
  fs.unlinkSync(role); await f.service();
  const result = await waiter.done; assert.equal(result.code,0); assert.match(result.stdout,/没有接手（请求文件无效）/);
  assert.equal(rows(f.home)[0].managed,undefined);
});

test('认领和收回竞争：两种获胜顺序都只有一个执行所有者', async t => {
  const f = await fixture(t);
  for (const claimFirst of [true, false]) {
    const id = 'race-' + claimFirst, name = id, dir = path.join(f.home, 'managed'); fs.mkdirSync(dir, { recursive: true });
    const r = { v:1,id,at:Date.now(),script:f.script,node:process.execPath,repo:f.repo,name,args:{task:'隔离任务',extra:'',role:null,spec:null},settings:{model:null,effort:null,tier:null,sandbox:'workspace-write',path:f.agent},dispatcher:{host:'unknown',session:null},env:managedEnvironment(f.env) };
    let owners = 0;
    const pending = handoff(f.home, r, () => {}, { timeout: claimFirst ? 100 : 0, interval: 5 });
    const claim = () => { try { fs.renameSync(path.join(dir,id+'.request.json'),path.join(dir,id+'.claimed.json')); owners++; registryWriter(f.home)({event:'end',id,exit:0,at:Date.now(),minutes:0}); } catch(e) { assert.equal(e.code,'ENOENT'); } };
    claim(); const outcome = await pending; if ('reason' in outcome) owners++;
    assert.equal(owners,1); assert.equal('exit' in outcome,claimFirst);
  }
});

for (const mode of ['off','dead','legacy','dry']) test(`不满足托管条件 ${mode}：没有请求或托管输出`, async t => {
  const f = await fixture(t);
  if (mode === 'off') fs.writeFileSync(f.configFile, JSON.stringify({ ...json(f.configFile), managed:false }));
  if (mode === 'dead') fs.writeFileSync(path.join(f.home,'viewer.json'),JSON.stringify({pid:2147483647,acceptsManaged:true}));
  if (mode === 'legacy') fs.writeFileSync(path.join(f.home,'viewer.json'),JSON.stringify({pid:process.pid}));
  const result = await f.launch(f.script, ['隔离任务'], mode === 'dry' ? {CODEX_DRY_RUN:'1'} : {}).done;
  assert.equal(result.code,0,result.stderr); assert.doesNotMatch(result.stdout,/托管：/); assert.equal(fs.existsSync(path.join(f.home,'managed')),false);
  assert.equal(rows(f.home).length,mode==='dry'?0:3);
});

test('请求校验、环境白名单、完整行读取和启动清理', async t => {
  const f=await fixture(t),dir=path.join(f.home,'managed');fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'old.tmp'),'old');fs.utimesSync(path.join(dir,'old.tmp'),new Date(0),new Date(0));
  fs.writeFileSync(path.join(dir,'bad.request.json'),'{}');
  await f.service();
  assert.equal(fs.existsSync(path.join(dir,'old.tmp')),false);assert.equal(json(path.join(dir,'bad.rejected.json')).reason,'请求文件无效');
  assert.equal(validRequest({v:1}),false);
  assert.deepEqual(managedEnvironment({Path:'fake',NODE_OPTIONS:'injected',ELECTRON_RUN_AS_NODE:'1',UNRELATED:'no'}),{PATH:'fake'});
  const file=path.join(f.home,'runs.jsonl'),read=terminalReader(f.home,'half');
  fs.writeFileSync(file,'{"v":1,"event":"end","id":"half","exit":0}');assert.equal(read(),null);fs.appendFileSync(file,'\n');assert.equal(read().exit,0);
});

// 016：派活方取值只多 agentrouter 一个，结构不变——agentrouter 请求合法，其他未知取值仍然无效。
test('请求校验的派活方取值：claude-code / unknown / agentrouter 合法，其他无效', () => {
  const base = {
    v: 1, id: 'host-check', at: Date.now(), script: path.resolve('core/ar.mjs'), node: process.execPath,
    repo: path.resolve('.'), name: '隔离任务',
    args: { task: '隔离任务', extra: '', role: null, spec: null },
    settings: { model: null, effort: null, tier: null, sandbox: 'workspace-write', path: null },
    dispatcher: { host: 'unknown', session: null }, env: managedEnvironment({ PATH: 'fake' }),
  };
  for (const host of ['claude-code', 'unknown', 'agentrouter'])
    assert.equal(validRequest({ ...base, dispatcher: { host, session: null } }), true, host);
  // claude-code 时会话可以是字符串，其余取值会话为 null。
  assert.equal(validRequest({ ...base, dispatcher: { host: 'claude-code', session: 'fake-session' } }), true);
  for (const host of ['other', 'AgentRouter', '', null, undefined])
    assert.equal(validRequest({ ...base, dispatcher: { host, session: null } }), false, String(host));
});

test('Windows 实测：终止假派活方整棵进程树，执行者和假 agent 继续到 end', { skip:process.platform!=='win32' }, async t => {
  const f=await fixture(t,{duration:2500});await f.service();
  const hostFile=path.join(f.base,'fake-host.mjs');
  fs.writeFileSync(hostFile,`import {spawn} from 'node:child_process';const child=spawn(process.execPath,[${JSON.stringify(f.script)},'隔离任务'],{stdio:'inherit',windowsHide:true,shell:false});child.on('close',code=>process.exit(code));`);
  const host=f.launch(hostFile,[]);
  const started=await until(()=>rows(f.home).find(r=>r.event==='spawned'),10000,'执行者启动假 agent（spawned）',f.home);
  await until(()=>fs.existsSync(path.join(f.base,'echo.json')),10000,'假 agent 写出 echo.json',f.home);
  const executor=rows(f.home)[0];
  await execute('taskkill.exe',['/PID',String(host.pid),'/T','/F'],{windowsHide:true});
  assert.equal(alive(host.pid),false);assert.equal(alive(executor.pid),true);assert.equal(alive(started.agentPid),true);
  const end=await until(()=>rows(f.home).find(r=>r.event==='end'),10000,`结束派活方后任务写出 end（执行者 ${executor.pid} ${alive(executor.pid)?'存活':'不在'}，假 agent ${started.agentPid} ${alive(started.agentPid)?'存活':'不在'}）`,f.home);assert.equal(end.exit,0);
  t.diagnostic('taskkill.exe /PID <本测试假派活方 PID> /T /F：派活方与等待者退出；执行者、假 agent 存活；唯一 end.exit=0。');
});

test('Windows 实测：关闭软件认领进程，托管任务仍正常完成', { skip:process.platform!=='win32' }, async t => {
  const f=await fixture(t,{duration:1800}),monitorFile=path.join(f.base,'fake-monitor.mjs');
  fs.writeFileSync(monitorFile,`import {createManaged} from ${JSON.stringify(new URL('../../app/src/main/managed.mjs',import.meta.url).href)};import fs from 'node:fs';const service=await createManaged(${JSON.stringify(root)});service.start();fs.writeFileSync(${JSON.stringify(path.join(f.home,'viewer.json'))},JSON.stringify({pid:process.pid,acceptsManaged:true,suppressWatchWindow:true}));process.send('ready');process.on('message',()=>{service.close();fs.unlinkSync(${JSON.stringify(path.join(f.home,'viewer.json'))});process.disconnect();});`);
  const monitor=f.launch(monitorFile,[]);await new Promise(resolve=>monitor.once('message',resolve));
  const waiter=f.launch();await until(()=>fs.existsSync(path.join(f.base,'echo.json')));
  const [executor,agent]=rows(f.home);monitor.send('close');assert.equal((await monitor.done).code,0);
  assert.equal(alive(executor.pid),true);assert.equal(alive(agent.agentPid),true);
  assert.equal((await waiter.done).code,0);assert.equal(rows(f.home).at(-1).exit,0);
  t.diagnostic('向独立假监控进程发送 close，关闭认领服务并正常退出：执行者与假 agent 存活，等待者 exit=0，唯一 end.exit=0。');
});

for (const managed of [false, true]) test(`停止命令结束多层假进程，托管=${managed}`, async t => {
  const f = await fixture(t, { duration: 60000, tree: true });
  if (managed) await f.service();
  else fs.writeFileSync(f.configFile, JSON.stringify({ ...json(f.configFile), managed: false }));
  const name = '停止 中文 任务';
  const waiter = f.launch(f.script, ['隔离任务', '--name', name]);
  await until(() => fs.existsSync(path.join(f.base, 'descendant.json')));
  const [start, spawned] = rows(f.home), descendant = json(path.join(f.base, 'descendant.json')).pid;
  t.after(() => { for (const pid of [spawned.agentPid, descendant]) if (alive(pid)) process.kill(pid); });
  const result = await f.launch(f.script, ['--stop', name]).done;
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), `停止：${name} 已停止，工作区里没提交的改动还在`);
  for (const pid of [start.pid, spawned.agentPid, descendant]) assert.equal(alive(pid), false, `假进程 ${pid} 已退出`);
  const finished = await waiter.done;
  if (managed) assert.equal(finished.code, 1);
  assert.deepEqual(rows(f.home).map(r => r.event), ['start','spawned','interrupted']);
  assert.equal(rows(f.home).at(-1).signal, 'stopped-by-command');
  const again = await f.launch(f.script, ['--stop', name]).done;
  assert.equal(again.code, 0); assert.equal(again.stdout.trim(), `停止：${name}（已经结束）`);
});

for (const signal of ['SIGINT','SIGTERM','SIGBREAK','SIGHUP']) test(`信号 ${signal} 结束假 agent 及子孙进程`, async t => {
  const f = await fixture(t, { duration: 60000, tree: true });
  fs.writeFileSync(f.configFile, JSON.stringify({ ...json(f.configFile), managed: false }));
  // Windows 不支持从另一进程投递这些 POSIX 信号，用 IPC 在派发进程内触发同一处理器。
  const wrapper = path.join(f.base, 'signal-entry.mjs');
  fs.writeFileSync(wrapper, `process.on('message',s=>process.emit(s));await import(${JSON.stringify(pathToFileURL(f.script).href)});`);
  const child = f.launch(wrapper, ['隔离任务']);
  await until(() => fs.existsSync(path.join(f.base, 'descendant.json')));
  const spawned = rows(f.home).find(r => r.event === 'spawned'), descendant = json(path.join(f.base, 'descendant.json')).pid;
  t.after(() => { for (const pid of [spawned.agentPid, descendant]) if (alive(pid)) process.kill(pid); });
  child.send(signal);
  assert.equal((await child.done).code, 1);
  assert.equal(alive(spawned.agentPid), false); assert.equal(alive(descendant), false);
  assert.deepEqual(rows(f.home).map(r => r.event), ['start','spawned','interrupted']);
  assert.equal(rows(f.home).at(-1).signal, signal);
});

// 托管目录的三种情况：初始化失败、运行中目录消失、退出后清理。
test('初始化失败：托管目录建不出来时 start 直接抛出带路径的原因，不进入轮询', async t => {
  const f = await fixture(t), errors = [];
  fs.writeFileSync(path.join(f.home, 'managed'), '不是目录');
  const s = await createManaged(root, f.env, e => errors.push(e));
  assert.throws(() => s.start(), e => /托管请求目录初始化失败/.test(e.message) && e.message.includes(path.join(f.home, 'managed')));
  s.close();
  await delay(450);
  assert.deepEqual(errors, []);
});
test('运行中托管目录被删除：只警告一次（已自动恢复，不算错误），重建 managed 并继续接收请求', async t => {
  const f = await fixture(t), dir = path.join(f.home, 'managed');
  const { errors, warnings } = await f.service();
  fs.rmSync(dir, { recursive: true, force: true });
  await until(() => warnings.length > 0 && fs.existsSync(dir));
  await delay(600);
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /^警告：托管请求目录在运行中被删除.*已(重新创建|被派活方重建)，继续监听/);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(dir, 'bad.request.json'), '{}');
  await until(() => fs.existsSync(path.join(dir, 'bad.rejected.json')));
  assert.equal(json(path.join(dir, 'bad.rejected.json')).reason, '请求文件无效');
  assert.equal(warnings.length, 1);
});
test('运行中公共目录整个消失：报告一次、不重建整条路径；公共目录回来后恢复', async t => {
  const f = await fixture(t), dir = path.join(f.home, 'managed');
  const { errors, warnings } = await f.service();
  fs.rmSync(f.home, { recursive: true, force: true });
  await until(() => errors.length > 0);
  await delay(600);
  assert.equal(fs.existsSync(f.home), false, '不能自动重建公共目录');
  assert.equal(errors.length, 1, errors.map(e => e.message).join('\n'));
  assert.match(errors[0].message, /公共目录都不存在，暂停接收托管请求/);
  fs.mkdirSync(f.home);
  await until(() => fs.existsSync(dir) && warnings.length === 1);
  assert.match(warnings[0], /^警告：托管请求目录在运行中被删除.*已重新创建，继续监听/);
  assert.equal(errors.length, 1);
  fs.writeFileSync(path.join(dir, 'bad.request.json'), '{}');
  await until(() => fs.existsSync(path.join(dir, 'bad.rejected.json')));
});
test('退出后清理：close 之后删除目录不报告、不重建', async t => {
  const f = await fixture(t), dir = path.join(f.home, 'managed');
  const { s, errors, warnings } = await f.service();
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
  await delay(600);
  s.scan();
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
test('其他错误不吞掉：托管目录被换成文件时报告原因，同一错误不重复刷屏', async t => {
  const f = await fixture(t), dir = path.join(f.home, 'managed');
  const { errors } = await f.service();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, '不是目录');
  await until(() => errors.some(e => e.code && e.code !== 'ENOENT'));
  await delay(600);
  const other = errors.filter(e => e.code && e.code !== 'ENOENT');
  assert.equal(other.length, 1, errors.map(e => `${e.code} ${e.message}`).join('\n'));
  assert.equal(fs.statSync(dir).isFile(), true, '不能删掉别人放的文件');
});
