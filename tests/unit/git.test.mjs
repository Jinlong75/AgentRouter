import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deletedFromEntries, gitTooOldMessage, gitVersion, parseGitVersion, parseNameStatusEntriesZ, requireModernGit } from '../../core/lib/git.mjs';

// 095：git 版本解析与 ≥ 2.40 判断（D41）。AR_TEST_GIT_VERSION 是只给测试用的钩子：有值时不运行 git。
function withGitVersion(value, fn) {
  const saved = process.env.AR_TEST_GIT_VERSION;
  if (value === undefined) delete process.env.AR_TEST_GIT_VERSION; else process.env.AR_TEST_GIT_VERSION = value;
  try { return fn(); } finally { if (saved === undefined) delete process.env.AR_TEST_GIT_VERSION; else process.env.AR_TEST_GIT_VERSION = saved; }
}

test('parseGitVersion：四种常见写法', () => {
  assert.deepEqual(parseGitVersion('git version 2.39.1.windows.1'), { major: 2, minor: 39, patch: 1, raw: 'git version 2.39.1.windows.1' });
  assert.deepEqual(parseGitVersion('git version 2.40.0\n'), { major: 2, minor: 40, patch: 0, raw: 'git version 2.40.0' });
  assert.deepEqual(parseGitVersion('git version 2.55.0.windows.5'), { major: 2, minor: 55, patch: 0, raw: 'git version 2.55.0.windows.5' });
  assert.deepEqual(parseGitVersion('git version 2.45.2 (Apple Git-152)'), { major: 2, minor: 45, patch: 2, raw: 'git version 2.45.2 (Apple Git-152)' });
});

test('parseGitVersion：空串、乱码、非字符串返回 null', () => {
  assert.equal(parseGitVersion(''), null);
  assert.equal(parseGitVersion('这不是 git 的输出'), null);
  assert.equal(parseGitVersion('git version abc'), null);
  assert.equal(parseGitVersion(undefined), null);
  assert.equal(parseGitVersion(null), null);
});

test('gitVersion：ok 的判断——2.39.9 为 false，2.40.0 为 true，3.0.0 为 true，未知为 null', () => {
  assert.deepEqual(withGitVersion('git version 2.39.9', gitVersion), { version: '2.39.9', ok: false });
  assert.deepEqual(withGitVersion('git version 2.40.0', gitVersion), { version: '2.40.0', ok: true });
  assert.deepEqual(withGitVersion('git version 3.0.0', gitVersion), { version: '3.0.0', ok: true });
  assert.deepEqual(withGitVersion('git version 1.99.0', gitVersion), { version: '1.99.0', ok: false });
  assert.deepEqual(withGitVersion('git version 2.39.1.windows.1', gitVersion), { version: '2.39.1', ok: false });
  assert.deepEqual(withGitVersion('乱码', gitVersion), { version: null, ok: null });
});

test('gitVersion：没有测试钩子时运行真实 git，结果形状正确且同一进程内稳定', () => {
  const first = withGitVersion(undefined, gitVersion);
  assert.ok(first.ok === true || first.ok === false || first.ok === null);
  assert.ok(first.version === null || /^\d+\.\d+\.\d+$/.test(first.version));
  assert.equal(withGitVersion(undefined, gitVersion), first, '缓存：同一个对象');
});

test('requireModernGit / gitTooOldMessage：旧版本抛 GIT_TOO_OLD，说明里有当前版本；够新或未知不拦', () => {
  const error = withGitVersion('git version 2.39.1.windows.1', () => { try { requireModernGit('worktree'); } catch (e) { return e; } return null; });
  assert.equal(error.arCode, 'GIT_TOO_OLD');
  assert.match(error.message, /当前 2\.39\.1，worktree 模式需要 2\.40 或更新/);
  assert.match(error.message, /--no-worktree/);
  const init = withGitVersion('git version 2.39.1', () => gitTooOldMessage('init'));
  assert.match(init, /当前 2\.39\.1，ar init 需要 2\.40 或更新/);
  assert.ok(!init.includes('--no-worktree'), 'ar init 的说明不提 --no-worktree');
  assert.equal(withGitVersion('git version 2.40.0', () => gitTooOldMessage('worktree')), null);
  assert.equal(withGitVersion('乱码', () => gitTooOldMessage('worktree')), null);
  withGitVersion('乱码', () => requireModernGit('init'));
});

// 056：带状态的 name-status 解析（协议 12.1 第 4 步：受保护路径与删除的文件）。

test('parseNameStatusEntriesZ：D、R100、M 混合；重命名给旧、新两个路径', () => {
  const text = 'M\0src/a.js\0D\0docs/specs/旧.md\0R100\0src/旧 名.js\0lib/新 名.js\0A\0README.md\0';
  assert.deepEqual(parseNameStatusEntriesZ(text), [
    { status: 'M', paths: ['src/a.js'] },
    { status: 'D', paths: ['docs/specs/旧.md'] },
    { status: 'R100', paths: ['src/旧 名.js', 'lib/新 名.js'] },
    { status: 'A', paths: ['README.md'] },
  ]);
});

test('parseNameStatusEntriesZ：复制项同样给旧、新两个路径；状态保留原始写法（含相似度）', () => {
  const text = 'C075\0src/c.js\0lib/c.js\0';
  assert.deepEqual(parseNameStatusEntriesZ(text), [{ status: 'C075', paths: ['src/c.js', 'lib/c.js'] }]);
});

test('deletedFromEntries：只取状态 D 的路径，重命名不算删除', () => {
  const entries = parseNameStatusEntriesZ('M\0src/a.js\0D\0tests/old.test.js\0R100\0tests/a.test.js\0tests/b.test.js\0D\0docs/旧.md\0');
  assert.deepEqual(deletedFromEntries(entries), ['tests/old.test.js', 'docs/旧.md']);
});

test('parseNameStatusEntriesZ：空输入返回空数组', () => {
  assert.deepEqual(parseNameStatusEntriesZ(''), []);
  assert.deepEqual(deletedFromEntries(parseNameStatusEntriesZ('')), []);
});
