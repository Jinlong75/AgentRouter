import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManaged, rejectManaged } from '../../app/src/main/managed.mjs';
import { createPlan, executePlan } from '../../installer/lib/install.mjs';
import { validRequest } from '../../core/lib/managed.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const root = fileURLToPath(new URL('../../', import.meta.url));

function fixture(t) {
  const base = fs.mkdtempSync(join(tmpdir(), 'ar-rejection-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home'), repo = join(base, 'repo'), host = join(base, 'host');
  for (const dir of [home, repo, host]) fs.mkdirSync(dir);
  const env = { AGENT_ROUTER_HOME: home, CLAUDE_CONFIG_DIR: host, HOME: base, USERPROFILE: base, APPDATA: join(base, 'appdata') };
  executePlan(createPlan({ env, host: 'claude-code', skill: 'agent-router' }), { env });
  const script = join(host, 'skills', 'agent-router', 'core', 'ar.mjs');
  const dir = join(home, 'managed'); fs.mkdirSync(dir);
  function request(id) {
    const progressDir = join(repo, '.agent-runs', id); fs.mkdirSync(progressDir, { recursive: true });
    fs.writeFileSync(join(progressDir, 'progress.log'), '');
    const r = { v: 1, id, at: Date.now(), script, node: process.execPath, repo, name: id,
      args: { task: '隔离任务', extra: '', role: null, spec: null },
      settings: { model: null, effort: null, tier: null, sandbox: 'workspace-write', path: null },
      dispatcher: { host: 'unknown', session: null }, env: {} };
    assert.equal(validRequest(r), true);
    fs.writeFileSync(join(dir, `${id}.request.json`), JSON.stringify(r));
    return r;
  }
  return { home, dir, request };
}

for (const state of ['request', 'claimed']) test(`publication failure preserves ${state} fallback`, t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ar-rejection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, `test.${state}.json`), target = join(dir, 'test.rejected.json');
  fs.writeFileSync(source, JSON.stringify({ id: 'test' }));
  const failure = Object.assign(new Error('injected publication failure'), { code: 'EACCES' });
  const errors = [];
  const io = { ...fs, renameSync(from, to) {
    if (from === target + '.tmp' && to === target) throw failure;
    fs.renameSync(from, to);
  } };
  rejectManaged(source, 'test reason', readJson, e => errors.push(e), io);
  assert.deepEqual({ source: fs.existsSync(source), receipt: fs.existsSync(target) ? readJson(target).reason : null },
    { source: true, receipt: null }, 'failure preserves the source and never exposes an incomplete receipt');
  assert.deepEqual(errors, [failure]);
  fs.renameSync(source, join(dir, 'test.withdrawn.json'));
  assert.equal(readJson(join(dir, 'test.withdrawn.json')).id, 'test');
});

for (const state of ['request', 'claimed']) test(`complete receipt is visible before ${state} is removed`, t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ar-rejection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, `test.${state}.json`), target = join(dir, 'test.rejected.json');
  fs.writeFileSync(source, JSON.stringify({ id: 'test', retry: { n: 2 } }));
  const errors = [], events = [];
  const io = { ...fs, renameSync(from, to) {
    assert.equal(fs.existsSync(source), true);
    assert.equal(fs.existsSync(target), false);
    fs.renameSync(from, to);
    events.push('published');
    assert.deepEqual(readJson(target), { id: 'test', retry: { n: 2 }, reason: 'test reason' });
  }, unlinkSync(file) {
    assert.deepEqual(readJson(target), { id: 'test', retry: { n: 2 }, reason: 'test reason' });
    events.push('removed');
    fs.unlinkSync(file);
  } };
  rejectManaged(source, 'test reason', readJson, e => errors.push(e), io);
  assert.deepEqual(events, ['published', 'removed']);
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(errors, []);
});

for (const state of ['request', 'claimed']) test(`cleanup failure preserves complete ${state} receipt on retry`, t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ar-rejection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, `test.${state}.json`), target = join(dir, 'test.rejected.json');
  fs.writeFileSync(source, JSON.stringify({ id: 'test' }));
  const failure = Object.assign(new Error('injected cleanup failure'), { code: 'EPERM' });
  const errors = [];
  const io = { ...fs, unlinkSync() { throw failure; } };
  rejectManaged(source, 'original reason', readJson, e => errors.push(e), io);
  assert.equal(fs.existsSync(source), true);
  assert.deepEqual(readJson(target), { id: 'test', reason: 'original reason' });
  rejectManaged(source, 'different reason', readJson, e => errors.push(e), io);
  assert.deepEqual(readJson(target), { id: 'test', reason: 'original reason' });
  assert.deepEqual(errors, [failure, failure]);
  rejectManaged(source, 'different reason', readJson, e => errors.push(e));
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(readJson(target), { id: 'test', reason: 'original reason' });
  assert.deepEqual(errors, [failure, failure]);
});

for (const state of ['request', 'claimed']) test(`missing ${state} source is not reported`, t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ar-rejection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, `test.${state}.json`), target = join(dir, 'test.rejected.json');
  const errors = [];
  rejectManaged(source, 'test reason', readJson, e => errors.push(e));
  assert.deepEqual(errors, []);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(target + '.tmp'), false);
});

test('source withdrawn before cleanup leaves complete receipt without reporting ENOENT', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ar-rejection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'test.request.json'), target = join(dir, 'test.rejected.json');
  fs.writeFileSync(source, JSON.stringify({ id: 'test' }));
  const errors = [];
  const io = { ...fs, unlinkSync(file) { fs.renameSync(file, join(dir, 'test.withdrawn.json')); fs.unlinkSync(file); } };
  rejectManaged(source, 'test reason', readJson, e => errors.push(e), io);
  assert.deepEqual(errors, []);
  assert.deepEqual(readJson(target), { id: 'test', reason: 'test reason' });
  assert.equal(fs.existsSync(join(dir, 'test.withdrawn.json')), true);
});

for (const operation of ['writeFileSync', 'renameSync']) test(`publication ${operation} ENOENT is reported`, t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ar-rejection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'test.request.json'); fs.writeFileSync(source, JSON.stringify({ id: 'test' }));
  const failure = Object.assign(new Error('injected publication failure'), { code: 'ENOENT' });
  const errors = [], io = { ...fs, [operation]() { throw failure; } };
  rejectManaged(source, 'test reason', readJson, e => errors.push(e), io);
  assert.deepEqual(errors, [failure]);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(join(dir, 'test.rejected.json')), false);
});

test('repeated scans preserve an existing complete receipt and do not launch', async t => {
  const { home, dir, request } = fixture(t);
  const source = join(dir, 'test.request.json'), target = join(dir, 'test.rejected.json');
  request('test');
  fs.writeFileSync(target, JSON.stringify({ id: 'test', reason: 'original reason' }));
  const errors = []; let launches = 0;
  const service = await createManaged(root,
    { AGENT_ROUTER_HOME: home }, e => errors.push(e), () => {}, () => { launches++; });
  t.after(() => service.close());
  service.scan(); service.scan();
  assert.equal(launches, 0);
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(readJson(target), { id: 'test', reason: 'original reason' });
  assert.deepEqual(errors, []);
});

test('corrupt receipt skips its request and does not interrupt other requests', async t => {
  const { home, dir, request } = fixture(t);
  request('a-broken'); request('b-valid');
  const broken = join(dir, 'a-broken.rejected.json'); fs.writeFileSync(broken, '{');
  const errors = []; let launches = 0;
  const service = await createManaged(root, { AGENT_ROUTER_HOME: home }, e => errors.push(e), () => {},
    () => { launches++; return { on() {}, unref() {} }; });
  t.after(() => service.close());
  service.scan(); service.scan();
  assert.equal(launches, 1);
  assert.equal(fs.existsSync(join(dir, 'a-broken.request.json')), true);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{');
  assert.equal(fs.existsSync(join(dir, 'b-valid.claimed.json')), true);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof SyntaxError);
});


test('claimed cleanup retries after launch failure without changing receipt', async t => {
  const { home, dir, request } = fixture(t);
  request('test');
  const source = join(dir, 'test.claimed.json'), target = join(dir, 'test.rejected.json');
  const failure = Object.assign(new Error('cleanup blocked'), { code: 'EPERM' });
  const errors = []; let launches = 0, blocked = true;
  const io = { ...fs, unlinkSync(file) { if (file === source && blocked) throw failure; fs.unlinkSync(file); } };
  const service = await createManaged(root, { AGENT_ROUTER_HOME: home }, e => errors.push(e), () => {},
    () => { launches++; throw Error('launch failed'); }, io);
  t.after(() => service.close());
  service.scan();
  assert.equal(launches, 1);
  assert.equal(fs.existsSync(source), true);
  const receipt = fs.readFileSync(target, 'utf8');
  blocked = false; service.scan();
  assert.equal(fs.existsSync(source), false);
  assert.equal(launches, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), receipt);
  assert.deepEqual(errors, [failure]);
});

test('corrupt claimed receipt is reported once and other requests continue', async t => {
  const { home, dir, request } = fixture(t);
  request('a-broken'); request('b-valid');
  fs.renameSync(join(dir, 'a-broken.request.json'), join(dir, 'a-broken.claimed.json'));
  fs.writeFileSync(join(dir, 'a-broken.rejected.json'), '{');
  const errors = []; let launches = 0;
  const service = await createManaged(root, { AGENT_ROUTER_HOME: home }, e => errors.push(e), () => {},
    () => { launches++; return { on() {}, unref() {} }; });
  t.after(() => service.close());
  service.scan(); service.scan();
  assert.equal(launches, 1);
  assert.equal(fs.existsSync(join(dir, 'a-broken.claimed.json')), true);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof SyntaxError);
});

for (const operation of ['publication', 'rename', 'cleanup']) test(`scan deduplicates ${operation} errors and resets`, async t => {
  const { home, dir, request } = fixture(t);
  const source = join(dir, 'test.request.json'), target = join(dir, 'test.rejected.json');
  const first = Object.assign(new Error('blocked'), { code: 'EPERM' });
  const changed = Object.assign(new Error('changed'), { code: 'EPERM' });
  const changedCode = Object.assign(new Error('changed'), { code: 'EACCES' });
  let failure = first;
  const io = { ...fs,
    writeFileSync(file, ...args) { if (operation === 'publication' && file === target + '.tmp' && failure) throw failure; fs.writeFileSync(file, ...args); },
    renameSync(from, to) { if (operation === 'rename' && from === target + '.tmp' && failure) throw failure; fs.renameSync(from, to); },
    unlinkSync(file) { if (operation === 'cleanup' && file === source && failure) throw failure; fs.unlinkSync(file); }
  };
  const errors = [];
  const service = await createManaged(root, { AGENT_ROUTER_HOME: home }, e => errors.push(e), () => {}, () => {}, io);
  t.after(() => service.close());
  function makeSource() { fs.writeFileSync(source, '{'); }
  makeSource();
  service.scan(); service.scan(); service.scan();
  assert.deepEqual(errors, [first]);
  failure = changed; service.scan();
  assert.deepEqual(errors, [first, changed]);
  failure = changedCode; service.scan();
  assert.deepEqual(errors, [first, changed, changedCode]);
  failure = null; service.scan();
  assert.equal(fs.existsSync(source), false);
  fs.rmSync(target, { force: true }); makeSource(); failure = first; service.scan();
  assert.deepEqual(errors, [first, changed, changedCode, first]);
  fs.unlinkSync(source); service.scan();
  fs.rmSync(target, { force: true }); makeSource(); service.scan();
  assert.deepEqual(errors, [first, changed, changedCode, first, first]);
});
