import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { homeDirectory, legacyHomeDirectory, userDirectory, dryRun, noWatch, testAgent, testStartTimeout, pickName, scriptNames, installMarkers, legacyRunsDir } from '../../core/lib/compat.mjs';
import { resolveSettings } from '../../core/lib/config.mjs';

const base = path.resolve('/示例/用户');

test('公共目录：新变量优先于旧变量，旧变量单独设置时仍有效', () => {
  const fresh = path.join(base, '新'), old = path.join(base, '旧');
  assert.equal(homeDirectory({ AGENT_ROUTER_HOME: fresh, CODEX_DISPATCH_HOME: old }, 'win32'), fresh);
  assert.equal(homeDirectory({ CODEX_DISPATCH_HOME: old }, 'win32'), old);
  assert.equal(homeDirectory({ AGENT_ROUTER_HOME: fresh }, 'linux'), fresh);
});

test('默认公共目录为 agent-router，旧目录为 codex-dispatch；显式指定时两者相同（测试隔离）', () => {
  assert.equal(homeDirectory({ APPDATA: base }, 'win32'), path.join(base, 'agent-router'));
  assert.equal(legacyHomeDirectory({ APPDATA: base }, 'win32'), path.join(base, 'codex-dispatch'));
  assert.equal(homeDirectory({ USERPROFILE: base }, 'win32'), path.join(base, 'AppData', 'Roaming', 'agent-router'));
  assert.equal(legacyHomeDirectory({ HOME: base }, 'linux'), path.join(base, '.config', 'codex-dispatch'));
  for (const key of ['AGENT_ROUTER_HOME', 'CODEX_DISPATCH_HOME']) {
    const env = { [key]: path.join(base, '隔离'), APPDATA: base };
    assert.equal(legacyHomeDirectory(env, 'win32'), homeDirectory(env, 'win32'));
  }
  assert.equal(userDirectory({ USERPROFILE: base, HOME: path.join(base, '别处') }, 'win32'), base);
});

test('预演、关窗口、测试执行者、启动超时：新旧环境变量都有效，新的优先', () => {
  for (const key of ['AR_DRY_RUN', 'CODEX_DRY_RUN']) assert.equal(dryRun({ [key]: '1' }), true);
  assert.equal(dryRun({}), false);
  for (const key of ['AR_NO_WATCH', 'CODEX_NO_WATCH']) assert.equal(noWatch({ [key]: '1' }), true);
  assert.equal(noWatch({ AR_NO_WATCH: '' }), false);
  assert.equal(testAgent({ AR_TEST_AGENT: '新.mjs', CODEX_DISPATCH_TEST_AGENT: '旧.mjs' }), '新.mjs');
  assert.equal(testAgent({ CODEX_DISPATCH_TEST_AGENT: '旧.mjs' }), '旧.mjs');
  assert.equal(testStartTimeout({ AR_TEST_START_TIMEOUT_MS: '300', CODEX_DISPATCH_TEST_START_TIMEOUT_MS: '900' }), 300);
  assert.equal(testStartTimeout({ CODEX_DISPATCH_TEST_START_TIMEOUT_MS: '900' }), 900);
  assert.equal(testStartTimeout({ AR_TEST_START_TIMEOUT_MS: '0' }), null);
  assert.equal(pickName({ CODEX_NO_WATCH: '1' }, 'AR_NO_WATCH', 'CODEX_NO_WATCH'), 'CODEX_NO_WATCH');
});

test('关窗口变量在配置来源里显示实际生效的名字', () => {
  for (const key of ['AR_NO_WATCH', 'CODEX_NO_WATCH']) {
    const { settings, sources } = resolveSettings({}, {}, { [key]: '1' });
    assert.equal(settings.watchWindow, 'never'); assert.equal(sources.watchWindow, `环境变量 ${key}`);
  }
});

test('停止核对的入口名、安装记录名、旧记录目录', () => {
  assert.deepEqual(scriptNames, ['ar.mjs', 'codex-task.mjs']);
  assert.deepEqual(installMarkers, ['.agent-router.json', '.dispatchdock.json']);
  assert.equal(legacyRunsDir(base), path.join(base, '.codex-runs'));
});
