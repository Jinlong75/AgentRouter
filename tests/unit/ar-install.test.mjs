import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { arShadow, arStatus, installAr, uninstallAr } from '../../app/src/main/ar-install.mjs';

const markerLine = 'rem AgentRouter ar 命令';

async function fixture(t, initial = 'C:\\工具;D:\\其他', options = {}) {
  const localAppData = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-install-'));
  t.after(() => fs.rm(localAppData, { recursive: true, force: true }));
  let current = initial;
  let machinePath = options.machinePath ?? 'C:\\Windows';
  const writes = [];
  const deps = {
    fs,
    readUserPath: async () => current,
    writeUserPath: async value => { writes.push(value); current = value; },
    readMachinePath: async () => machinePath,
    // 只看夹具目录里的真实文件：测试不读真实注册表，也不碰系统目录。
    exists: async file => {
      const rel = path.relative(localAppData, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
      try { await fs.stat(file); return true; } catch { return false; }
    },
  };
  const dir = path.join(localAppData, 'AgentRouter', 'bin');
  return { localAppData, dir, target: path.join(dir, 'ar.cmd'), alias: path.join(dir, 'agr.cmd'), record: path.join(dir, 'path-before.json'), deps, writes, getPath: () => current, setPath: value => { current = value; }, setMachinePath: value => { machinePath = value; }, appExe: 'C:\\程序 目录\\AgentRouter.exe', coreEntry: 'C:\\程序 目录\\resources\\core\\ar.mjs' };
}

test('首次安装、逐字内容、重复安装和卸载保留其他顺序', async t => {
  const f = await fixture(t);
  assert.deepEqual(await arStatus(f), { installed: false, path: f.target, inPath: false, owned: false, conflict: false, shadow: null });
  assert.deepEqual(await installAr(f), { ok: true, path: f.target, pathChanged: true });
  const contents = 'rem AgentRouter ar 命令\r\n@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\程序 目录\\AgentRouter.exe" "C:\\程序 目录\\resources\\core\\ar.mjs" %*\r\n';
  assert.equal(await fs.readFile(f.target, 'utf8'), contents);
  assert.equal(await fs.readFile(f.alias, 'utf8'), contents);
  assert.equal(contents.split(/\r?\n/, 1)[0], markerLine);
  assert.deepEqual(JSON.parse(await fs.readFile(f.record, 'utf8')), { before: 'C:\\工具;D:\\其他', added: true, position: 'end' });
  assert.equal(f.getPath(), `C:\\工具;D:\\其他;${f.dir}`);
  assert.deepEqual(await arStatus(f), { installed: true, path: f.target, inPath: true, owned: true, conflict: false, shadow: { shadowed: false } });
  assert.equal((await installAr(f)).pathChanged, false);
  assert.equal(f.writes.length, 1);
  f.setPath(`X:\\前;${f.getPath()};Y:\\后`);
  assert.deepEqual(await uninstallAr(f), { ok: true, removed: [f.dir, f.target, f.alias], kept: [] });
  await assert.rejects(fs.readFile(f.target), { code: 'ENOENT' });
  await assert.rejects(fs.readFile(f.alias), { code: 'ENOENT' });
  assert.equal(f.getPath(), 'X:\\前;C:\\工具;D:\\其他;Y:\\后');
  assert.deepEqual(await uninstallAr(f), { ok: true, removed: [], kept: [] });
});

test('用户 PATH 不存在时首次安装', async t => {
  const f = await fixture(t, '');
  assert.equal((await installAr(f)).pathChanged, true);
  assert.equal(f.getPath(), f.dir);
  assert.deepEqual(JSON.parse(await fs.readFile(f.record, 'utf8')), { before: '', added: true, position: 'end' });
  await uninstallAr(f);
  assert.equal(f.getPath(), '');
  await assert.rejects(fs.readFile(f.target), { code: 'ENOENT' });
  await assert.rejects(fs.readFile(f.alias), { code: 'ENOENT' });
});

test('用户后来在前面添加相同目录时只删除末尾的原组件', async t => {
  const f = await fixture(t);
  await installAr(f);
  f.setPath(`${f.dir.toUpperCase()}\\;${f.getPath()}`);
  assert.deepEqual((await uninstallAr(f)).removed, [f.dir, f.target, f.alias]);
  assert.equal(f.getPath(), `${f.dir.toUpperCase()}\\;C:\\工具;D:\\其他`);
});

test('旧记录没有追加位置时保留 PATH 并提示', async t => {
  const f = await fixture(t);
  await installAr(f);
  await fs.writeFile(f.record, JSON.stringify({ before: 'C:\\工具;D:\\其他', added: true }));
  const previous = f.getPath();
  assert.deepEqual((await uninstallAr(f)).kept, [f.dir]);
  assert.equal(f.getPath(), previous);
});

test('已有同目录时忽略大小写与尾分隔符，卸载保留', async t => {
  const f = await fixture(t, '');
  const original = `C:\\前;${f.dir.toUpperCase()}\\;D:\\后`;
  f.setPath(original);
  assert.equal((await installAr(f)).pathChanged, false);
  assert.equal(f.writes.length, 0);
  assert.deepEqual((await uninstallAr(f)).removed, [f.target, f.alias]);
  assert.equal(f.getPath(), original);
});

test('陌生文件冲突，不覆盖或写 PATH', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.dir, { recursive: true });
  await fs.writeFile(f.target, '其他内容');
  assert.equal((await arStatus(f)).conflict, true);
  await assert.rejects(installAr(f), { message: '目标文件已存在且不属于 AgentRouter，未覆盖' });
  assert.equal(await fs.readFile(f.target, 'utf8'), '其他内容');
  assert.equal(f.writes.length, 0);
  assert.deepEqual((await uninstallAr(f)).kept, [f.target]);
});

test('别名 agr.cmd 已存在且不属于我们时冲突，ar.cmd 也不写', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.dir, { recursive: true });
  await fs.writeFile(f.alias, '其他内容');
  assert.equal((await arStatus(f)).conflict, true);
  await assert.rejects(installAr(f), { message: '目标文件已存在且不属于 AgentRouter，未覆盖' });
  assert.equal(await fs.readFile(f.alias, 'utf8'), '其他内容');
  await assert.rejects(fs.readFile(f.target), { code: 'ENOENT' });
  assert.equal(f.writes.length, 0);
  assert.equal(f.getPath(), 'C:\\工具;D:\\其他');
});

test('arShadow 按新终端的 PATH 顺序找 ar', async t => {
  const f = await fixture(t);
  const machineDir = 'C:\\msys64\\ucrt64\\bin';
  const machineAr = path.join(machineDir, 'ar.exe');
  const env = { PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows' };
  const deps = { readUserPath: async () => f.getPath(), readMachinePath: async () => machineDir, exists: async file => file.toLowerCase() === machineAr.toLowerCase(), env };
  assert.deepEqual(await arShadow({ localAppData: f.localAppData, deps }), { shadowed: true, by: machineAr });
  assert.deepEqual(await arShadow({ localAppData: f.localAppData, deps: { ...deps, readMachinePath: async () => 'C:\\Windows', exists: async () => false } }), { shadowed: false });
  const expandedAr = path.join('C:\\Windows', 'x', 'ar.exe');
  assert.deepEqual(await arShadow({ localAppData: f.localAppData, deps: { ...deps, readMachinePath: async () => '%SystemRoot%\\x', exists: async file => file.toLowerCase() === expandedAr.toLowerCase() } }), { shadowed: true, by: expandedAr });
  assert.deepEqual(await arShadow({ localAppData: f.localAppData, deps: { ...deps, readMachinePath: async () => { throw new Error('读不到注册表'); } } }), { shadowed: null });
});

test('我们的目录在用户 PATH、系统 PATH 里没有 ar 时不算遮挡', async t => {
  const f = await fixture(t);
  f.setPath(`${f.dir};C:\\工具`);
  const deps = { readUserPath: async () => f.getPath(), readMachinePath: async () => 'C:\\Windows', exists: async file => file.toLowerCase() === f.target.toLowerCase(), env: { PATHEXT: '.COM;.EXE;.BAT;.CMD' } };
  assert.deepEqual(await arShadow({ localAppData: f.localAppData, deps }), { shadowed: false });
});

test('记录缺失时保守保留 PATH 并提示', async t => {
  const f = await fixture(t);
  await installAr(f);
  await fs.rm(f.record);
  const result = await uninstallAr(f);
  assert.deepEqual(result.kept, [f.dir]);
  assert.deepEqual(result.removed, [f.target, f.alias]);
  assert.ok(f.getPath().includes(f.dir));
});

test('写 PATH 失败时还原文件和记录', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.deps.writeUserPath = async value => { if (++calls === 1) throw new Error('写入失败'); f.setPath(value); };
  await assert.rejects(installAr(f), /写入失败/);
  await assert.rejects(fs.readFile(f.target), { code: 'ENOENT' });
  await assert.rejects(fs.readFile(f.alias), { code: 'ENOENT' });
  await assert.rejects(fs.readFile(f.record), { code: 'ENOENT' });
  assert.equal(f.getPath(), 'C:\\工具;D:\\其他');
});

test('卸载失败时恢复文件、记录和 PATH', async t => {
  const f = await fixture(t);
  await installAr(f);
  const prior = f.getPath();
  const originalRm = f.deps.fs.rm;
  f.deps.fs = { ...fs, rm: async (file, ...args) => { if (file === f.target) throw new Error('删除失败'); return originalRm(file, ...args); } };
  await assert.rejects(uninstallAr(f), /删除失败/);
  assert.equal(f.getPath(), prior);
  assert.ok(await fs.readFile(f.target, 'utf8'));
  assert.ok(await fs.readFile(f.alias, 'utf8'));
  assert.ok(await fs.readFile(f.record, 'utf8'));
});
