import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { homeDirectory, legacyHomeDirectory, userDirectory, dryRun, noWatch, testAgent, testStartTimeout, pickName, scriptNames, installMarkers, legacyRunsDir, unsafeHome } from '../../core/lib/compat.mjs';
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

test('公共目录保护：用户目录的三种来源、末尾分隔符、大小写、根目录与子目录', () => {
  const win = path.win32;
  const userDir = win.resolve('C:\\Users\\示例');
  const otherUser = win.resolve('C:\\Users\\别处');
  const root = win.parse(process.cwd()).root;
  // USERPROFILE / HOME / os.homedir() 三种来源各一；空值来源跳过。
  const hits = [
    unsafeHome(userDir, { env: { USERPROFILE: userDir }, platform: 'win32', homedir: otherUser }),
    unsafeHome(userDir, { env: { HOME: userDir }, platform: 'win32', homedir: otherUser }),
    unsafeHome(userDir, { env: {}, platform: 'win32', homedir: userDir }),
  ];
  for (const reason of hits) {
    assert.equal(typeof reason, 'string');
    assert.match(reason, /^公共目录不能设为用户目录或磁盘根目录：/);
    assert.match(reason, /请把 AGENT_ROUTER_HOME 设为一个专用的文件夹/);
  }
  // 末尾分隔符：resolve 规范化后仍命中。
  assert.ok(unsafeHome(`${userDir}\\`, { env: { USERPROFILE: userDir }, platform: 'win32', homedir: otherUser }));
  assert.ok(unsafeHome(`${userDir}/`, { env: { USERPROFILE: userDir }, platform: 'win32', homedir: otherUser }));
  // Windows 不区分大小写；同一条路径在 linux 规则下不命中。
  assert.ok(unsafeHome(win.resolve('C:\\USERS\\示例'), { env: { USERPROFILE: userDir }, platform: 'win32', homedir: otherUser }));
  assert.equal(unsafeHome('/home/Example', { env: { HOME: '/home/example' }, platform: 'linux', homedir: '/home/other' }), null);
  // 盘符根与 UNC 共享根。
  assert.ok(unsafeHome('C:\\', { env: {}, platform: 'win32', homedir: otherUser }));
  assert.ok(unsafeHome('\\\\server\\share', { env: {}, platform: 'win32', homedir: otherUser }));
  // 只有盘符的 C: 按 resolve 结果判断（Windows 上它指向该盘当前目录，不一定是根）。
  const resolvedC = win.resolve('C:');
  assert.equal(unsafeHome('C:', { env: {}, platform: 'win32', homedir: otherUser }) !== null, win.parse(resolvedC).root === resolvedC);
  // posix 的 /。
  assert.ok(unsafeHome('/', { env: {}, platform: 'linux', homedir: '/home/example' }));
  // 用户目录的子目录、默认公共目录（%APPDATA%\agent-router）都安全。
  assert.equal(unsafeHome(win.join(userDir, 'agent-router'), { env: { USERPROFILE: userDir }, platform: 'win32', homedir: otherUser }), null);
  const appData = win.join(userDir, 'AppData', 'Roaming');
  assert.equal(unsafeHome(win.join(appData, 'agent-router'), { env: { APPDATA: appData, USERPROFILE: userDir }, platform: 'win32', homedir: otherUser }), null);
  // USERPROFILE 为空时不误判（空值跳过，不当作当前目录）。
  assert.equal(unsafeHome(userDir, { env: { USERPROFILE: '', HOME: '' }, platform: 'win32', homedir: otherUser }), null);
  assert.equal(unsafeHome(win.resolve(''), { env: { USERPROFILE: '' }, platform: 'win32', homedir: otherUser }), null);
  // 本机真实根目录也命中（不访问文件）。
  assert.ok(unsafeHome(root, { env: {}, platform: process.platform, homedir: otherUser }));
});
