import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 托管请求文件认领失败：仍返回 0、不做别的事，但在公共目录 managed/claim-failures.log 留一行（只记文件名）。
// 全部在隔离的公共目录里，不启动任何执行者进程。
const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));

function setup(t) {
  const base = fs.mkdtempSync(path.join(tmpdir(), '认领失败 测试 '));
  const root = path.join(base, '仓库'), home = path.join(base, '公共 配置');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^agent_router_home$|^dispatchdock_home$/i.test(key)) delete env[key];
  Object.assign(env, { AGENT_ROUTER_HOME: home, USERPROFILE: base, HOME: base, APPDATA: base });
  const rel = path.relative(path.resolve(tmpdir()), home);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  t.after(() => {
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const ar = file => spawnSync(process.execPath, [entry, '--run-request', file], { cwd: root, env, encoding: 'utf8', timeout: 15000, windowsHide: true, shell: false });
  const log = path.join(home, 'managed', 'claim-failures.log');
  const lines = () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return { base, root, home, ar, lines };
}

test('请求文件不是 .claimed.json：退出 0、日志多一行、原文件不变', t => {
  const { base, home, ar, lines } = setup(t);
  const file = path.join(base, '请求.json');
  fs.writeFileSync(file, '{"x":1}', 'utf8');
  const result = ar(file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"x":1}');
  const got = lines();
  assert.equal(got.length, 1);
  assert.match(got[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\t不是 \.claimed\.json\t请求\.json$/);
  assert.ok(!got[0].includes(home) && !got[0].includes(base), '日志里不写完整路径');
  // 再来一次是追加，不是覆盖。
  assert.equal(ar(file).status, 0);
  assert.equal(lines().length, 2);
});

test('.claimed.json 不存在：退出 0、日志里有"改名失败"和错误码、不含完整路径', t => {
  const { base, home, ar, lines } = setup(t);
  const file = path.join(base, '不存在的请求.claimed.json');
  const result = ar(file);
  assert.equal(result.status, 0, result.stderr);
  const got = lines();
  assert.equal(got.length, 1);
  assert.match(got[0], /\t改名失败：ENOENT\t不存在的请求\.claimed\.json$/);
  assert.ok(!got[0].includes(home) && !got[0].includes(base), '日志里不写完整路径');
  assert.ok(!fs.existsSync(path.join(base, '不存在的请求.running.json')));
});
