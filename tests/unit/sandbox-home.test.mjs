import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEnv, sandboxHome, ensureSandboxHome } from '../../core/lib/env.mjs';
import { codex } from '../../core/adapters/codex.mjs';
import { claudeCode } from '../../core/adapters/claude-code.mjs';

// 064：执行者进程的用户目录指向沙箱 <公共目录>/workers/<profile>/home（协议第 7 节）。全部在系统临时目录里做。
function dirs(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ar 沙箱 用户目录 '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const real = path.join(base, '真实用户'), home = path.join(base, '公共目录');
  fs.mkdirSync(real); fs.mkdirSync(home);
  return { base, real, home };
}

test('USERPROFILE / HOME（Windows 另有 HOMEDRIVE / HOMEPATH）指向沙箱；profile.env 与适配器改不掉', t => {
  const { real, home } = dirs(t);
  const adapter = { isolate: () => ({ set: { USERPROFILE: 'D:\\适配器想改' } }) };
  const env = buildEnv({ base: { USERPROFILE: real, HOME: real, HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\x', PATH: 'p' }, adapter, home, profileName: 'mimo',
    profile: { env: { HOME: 'D:\\配置想改' } } });
  const sandbox = sandboxHome(home, 'mimo');
  assert.equal(sandbox, path.join(home, 'workers', 'mimo', 'home'));
  assert.equal(env.USERPROFILE, sandbox);
  assert.equal(env.HOME, sandbox);
  if (process.platform === 'win32') assert.equal(env.HOMEDRIVE + env.HOMEPATH, sandbox);
  assert.ok(!fs.existsSync(sandbox), 'buildEnv 只算环境、不建目录');
});

test('GIT_CONFIG_GLOBAL：调用方设了就沿用；否则指向真实的 ~/.gitconfig，再否则 ~/.config/git/config；都没有就不设', t => {
  const { real, home } = dirs(t);
  const build = base => buildEnv({ base, adapter: {}, home, profileName: 'p' });
  assert.equal(build({ USERPROFILE: real }).GIT_CONFIG_GLOBAL, undefined, '都没有就不设');
  fs.mkdirSync(path.join(real, '.config', 'git'), { recursive: true });
  fs.writeFileSync(path.join(real, '.config', 'git', 'config'), '[user]\n');
  assert.equal(build({ USERPROFILE: real }).GIT_CONFIG_GLOBAL, path.join(real, '.config', 'git', 'config'));
  fs.writeFileSync(path.join(real, '.gitconfig'), '[user]\n');
  assert.equal(build({ USERPROFILE: real }).GIT_CONFIG_GLOBAL, path.join(real, '.gitconfig'), '优先 ~/.gitconfig');
  assert.equal(build({ USERPROFILE: real, GIT_CONFIG_GLOBAL: 'D:\\自定义\\gitconfig' }).GIT_CONFIG_GLOBAL, 'D:\\自定义\\gitconfig');
  assert.equal(build({ HOME: real }).GIT_CONFIG_GLOBAL, path.join(real, '.gitconfig'), '没有 USERPROFILE 时按 HOME 找');
});

test('codex：没设 CODEX_HOME 时指向真实的 ~/.codex（用户自己的登录）；设了就沿用；claude-code 不加 CODEX_HOME', t => {
  const { real, home } = dirs(t);
  const codexEnv = base => buildEnv({ base, profile: { adapter: 'codex' }, adapter: codex, home, profileName: 'codex' });
  assert.equal(codexEnv({ USERPROFILE: real }).CODEX_HOME, path.join(real, '.codex'));
  assert.equal(codexEnv({ USERPROFILE: real, CODEX_HOME: 'D:\\别处\\codex' }).CODEX_HOME, 'D:\\别处\\codex');
  assert.equal(codexEnv({ USERPROFILE: real }).USERPROFILE, sandboxHome(home, 'codex'), 'codex 执行者的用户目录同样是沙箱');
  const claudeEnv = buildEnv({ base: { USERPROFILE: real }, profile: { adapter: 'claude-code' }, adapter: claudeCode, home, profileName: 'mimo' });
  assert.ok(!Object.keys(claudeEnv).some(k => k.toLowerCase() === 'codex_home'));
});

test('没有公共目录或执行者名时不改用户目录（检测等只读用法）', t => {
  const { real } = dirs(t);
  const env = buildEnv({ base: { USERPROFILE: real }, adapter: {} });
  assert.equal(env.USERPROFILE, real);
});

test('ensureSandboxHome：建好沙箱目录；公共目录建不了时改用系统临时目录里的一次性目录，绝不回落到真实用户目录', t => {
  const { base, real, home } = dirs(t);
  const env = buildEnv({ base: { USERPROFILE: real }, adapter: {}, home, profileName: 'mimo' });
  assert.equal(ensureSandboxHome(env, { home, profileName: 'mimo' }), sandboxHome(home, 'mimo'));
  assert.ok(fs.statSync(sandboxHome(home, 'mimo')).isDirectory());

  const blocked = path.join(base, '是个文件');
  fs.writeFileSync(blocked, '占位');
  const env2 = buildEnv({ base: { USERPROFILE: real }, adapter: {}, home: blocked, profileName: 'mimo' });
  const used = ensureSandboxHome(env2, { home: blocked, profileName: 'mimo' });
  t.after(() => fs.rmSync(used, { recursive: true, force: true }));
  assert.notEqual(used, real);
  assert.equal(path.dirname(used), path.resolve(os.tmpdir()));
  assert.equal(env2.USERPROFILE, used);
  assert.equal(env2.HOME, used);
  assert.ok(fs.statSync(used).isDirectory());
});

test('ensureSandboxHome（Windows）：沙箱里建好 AppData\\Local 与 AppData\\Roaming，临时目录兜底时也建', { skip: process.platform !== 'win32' }, t => {
  const { base, real, home } = dirs(t);
  const env = buildEnv({ base: { USERPROFILE: real }, adapter: {}, home, profileName: 'mimo' });
  const used = ensureSandboxHome(env, { home, profileName: 'mimo' });
  for (const sub of ['Local', 'Roaming']) assert.ok(fs.statSync(path.join(used, 'AppData', sub)).isDirectory(), `沙箱缺 AppData\\${sub}`);

  const blocked = path.join(base, '是个文件');
  fs.writeFileSync(blocked, '占位');
  const env2 = buildEnv({ base: { USERPROFILE: real }, adapter: {}, home: blocked, profileName: 'mimo' });
  const fallback = ensureSandboxHome(env2, { home: blocked, profileName: 'mimo' });
  t.after(() => fs.rmSync(fallback, { recursive: true, force: true }));
  for (const sub of ['Local', 'Roaming']) assert.ok(fs.statSync(path.join(fallback, 'AppData', sub)).isDirectory(), `兜底目录缺 AppData\\${sub}`);
  assert.ok(!fs.existsSync(path.join(real, 'AppData')), '真实用户目录没有被建任何东西');
});
