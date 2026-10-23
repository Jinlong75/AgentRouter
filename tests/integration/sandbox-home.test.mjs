import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPreset } from '../../core/lib/agents.mjs';
import { sandboxHome } from '../../core/lib/env.mjs';

// 064：执行者进程的用户目录指向沙箱。走真实派发链路（假的 Claude Code），执行者按事故写法往用户目录写文件，
// 断言文件都落进沙箱、"真实用户目录"（系统临时目录里的假目录，与公共目录并列）没有任何变化。
const entry = fileURLToPath(new URL('../../core/ar.mjs', import.meta.url));
const fixture = name => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const snapshot = dir => {
  const out = [];
  const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n), s = fs.statSync(p); out.push(`${path.relative(dir, p)}|${s.isDirectory() ? 'd' : s.size}|${s.mtimeMs}`); if (s.isDirectory()) walk(p); } };
  walk(dir);
  return out.sort();
};

test('执行者写用户目录（os.homedir()、PowerShell 的 $home 误用）都落进沙箱，真实用户目录不变', { timeout: 120000 }, t => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'ar 沙箱 派发 '));
  t.after(() => { assert.equal(path.dirname(base), path.resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const real = path.join(base, '真实用户'), home = path.join(base, '公共目录'), root = path.join(base, '仓库');
  for (const d of [real, home, root]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(real, '已有文件.txt'), '不能被改');
  fs.writeFileSync(path.join(real, '.gitconfig'), '[user]\n\tname = 测试\n\temail = test@example.invalid\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ v: 2, defaultProfile: 'mimo', profiles: { mimo: loadPreset('mimo').profile }, managed: false }));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CODEX_|ANTHROPIC_|CLAUDE|AR_|AGENT_ROUTER_HOME$|GIT_CONFIG)/i.test(k)) delete env[k];
  Object.assign(env, {
    AGENT_ROUTER_HOME: home, AR_NO_WATCH: '1', USERPROFILE: real, HOME: real,
    AR_TEST_AGENT: fixture('fake-claude-code-home-probe.mjs'), AR_TEST_ENV_REPORT: path.join(base, 'env.json'), MIMO_API_KEY: 'sk-test-sandbox-064',
  });
  const before = snapshot(real);
  const result = spawnSync(process.execPath, [entry, 'dispatch', '写探针', '--name', '沙箱'], { cwd: root, env, encoding: 'utf8', timeout: 90000, windowsHide: true, shell: false });
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const sandbox = sandboxHome(home, 'mimo');
  assert.equal(fs.readFileSync(path.join(sandbox, 'probe-node.txt'), 'utf8'), 'node\n', 'os.homedir() 写进了沙箱');
  if (process.platform === 'win32') assert.equal(fs.readFileSync(path.join(sandbox, 'probe-ps.txt'), 'utf8').trim(), 'ps', 'PowerShell 的 $home 误用写进了沙箱');
  if (process.platform === 'win32') {
    // 058 第 4 次派发：沙箱缺 AppData\Local 时 GetFolderPath 返回空串，PowerShell 缓存写进了仓库根。
    const local = fs.readFileSync(path.join(sandbox, 'probe-localappdata.txt'), 'utf16le').replace(/^﻿/, '').trim();
    assert.equal(local, `[${path.join(sandbox, 'AppData', 'Local')}]`, 'PowerShell 的本机应用数据目录在沙箱里');
  }
  assert.deepEqual(snapshot(real), before, '真实用户目录没有任何新增、删除或修改');
  // 执行者环境（只记变量名与路径）：用户目录是沙箱，git 的全局配置仍指向真实的 ~/.gitconfig。
  const report = JSON.parse(fs.readFileSync(path.join(base, 'env.json'), 'utf8'));
  assert.ok(report.allNames.includes('GIT_CONFIG_GLOBAL'), '执行者拿到 GIT_CONFIG_GLOBAL');
});
