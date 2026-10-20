import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appEnvironment, isolationOverrides, isolatedEnvKey } from '../../app/src/main/app-env.mjs';

test('没有 AR_ISOLATED_ENV 时软件内部环境与进程环境相同', () => {
  const base = { PATH: 'p', USERPROFILE: 'D:\\profiles\\real' };
  assert.deepEqual(appEnvironment(base, 'win32'), base);
});

test('隔离覆盖只进软件内部环境：改值、新增、null 删除；原环境对象不变', () => {
  const real = { PATH: 'p', USERPROFILE: 'D:\\profiles\\real', APPDATA: 'D:\\profiles\\real\\AppData\\Roaming', CODEX_MODEL: 'x' };
  const isolated = { PATH: 'p', USERPROFILE: 'T:\\demo\\user', APPDATA: 'T:\\demo\\user\\AppData\\Roaming', AGENT_ROUTER_HOME: 'T:\\demo' };
  const overrides = isolationOverrides(real, isolated, 'win32');
  assert.deepEqual(overrides, { USERPROFILE: 'T:\\demo\\user', APPDATA: 'T:\\demo\\user\\AppData\\Roaming', AGENT_ROUTER_HOME: 'T:\\demo', CODEX_MODEL: null });
  const base = { ...real, [isolatedEnvKey]: JSON.stringify(overrides) };
  const snapshot = { ...base };
  assert.deepEqual(appEnvironment(base, 'win32'), isolated);
  assert.deepEqual(base, snapshot, '不修改传入的环境（主进程 process.env 保持用户原样）');
});

test('Windows 下变量名不区分大小写：覆盖替换同名不同大小写的旧值', () => {
  const env = appEnvironment({ Path: 'old', UserProfile: 'D:\\profiles\\real', [isolatedEnvKey]: JSON.stringify({ USERPROFILE: 'T:\\u', PATH: null }) }, 'win32');
  assert.deepEqual(env, { USERPROFILE: 'T:\\u' });
});

test('AR_ISOLATED_ENV 无效时报出原因，不静默忽略', () => {
  assert.throws(() => appEnvironment({ [isolatedEnvKey]: '{bad' }, 'win32'), /不是有效的 JSON/);
  assert.throws(() => appEnvironment({ [isolatedEnvKey]: '[]' }, 'win32'), /必须是对象/);
  assert.throws(() => appEnvironment({ [isolatedEnvKey]: '{"A":1}' }, 'win32'), /字符串或 null/);
});
