import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lookup, queryUserEnv, resolveSecret, secretStatus, setUserSecret, unsetUserSecret } from '../../core/lib/secrets.mjs';

// 假密钥：任何返回值、错误信息、命令行参数里都不能出现它。
const SECRET = 'sk-test-AR-SECRET-7f3a9c';
const reg = (stdout, status = 0) => () => ({ status, stdout });
const noReg = () => undefined;

test('进程环境变量优先，注册表不再查询', () => {
  let asked = 0;
  assert.equal(resolveSecret('DEEPSEEK_API_KEY', { env: { DEEPSEEK_API_KEY: ` ${SECRET} ` }, query: () => { asked++; return 'other'; } }), SECRET);
  assert.equal(asked, 0);
});

test('进程里没有时回退到 Windows 用户环境变量（注册表）', () => {
  const run = reg(`\r\nHKEY_CURRENT_USER\\Environment\r\n    DEEPSEEK_API_KEY    REG_SZ    ${SECRET}\r\n\r\n`);
  const query = name => queryUserEnv(name, { platform: 'win32', env: {}, run });
  assert.equal(resolveSecret('DEEPSEEK_API_KEY', { env: {}, platform: 'win32', query }), SECRET);
});

test('REG_EXPAND_SZ 按传入环境展开 %VAR%，未知变量原样保留', () => {
  const run = reg('    MY_TOKEN    REG_EXPAND_SZ    %BASE%\\x;%NOPE%\r\n');
  assert.equal(queryUserEnv('MY_TOKEN', { platform: 'win32', env: { base: 'D:\\k' }, run }), 'D:\\k\\x;%NOPE%');
});

test('Windows 下变量名不区分大小写；其他平台区分且不查注册表', () => {
  assert.equal(lookup({ deepseek_api_key: SECRET }, 'DEEPSEEK_API_KEY', 'win32'), SECRET);
  assert.equal(lookup({ deepseek_api_key: SECRET }, 'DEEPSEEK_API_KEY', 'linux'), undefined);
  assert.equal(queryUserEnv('DEEPSEEK_API_KEY', { platform: 'linux', run: () => assert.fail('不应查询注册表') }), undefined);
});

test('注册表查询失败、没有这一项、类型不是字符串都当作没有', () => {
  assert.equal(queryUserEnv('A', { platform: 'win32', run: reg('', 1) }), undefined);
  assert.equal(queryUserEnv('A', { platform: 'win32', run: reg('    B    REG_SZ    x\r\n') }), undefined);
  assert.equal(queryUserEnv('A', { platform: 'win32', run: reg('    A    REG_DWORD    0x1\r\n') }), undefined);
});

test('缺失时报错只含变量名；空白值算缺失', () => {
  for (const env of [{}, { DEEPSEEK_API_KEY: '   ' }]) {
    assert.throws(() => resolveSecret('DEEPSEEK_API_KEY', { env, query: noReg }), e => /未设置密钥 DEEPSEEK_API_KEY/.test(e.message));
  }
});

test('非法变量名拒绝，且不会拿去查询注册表或写入', () => {
  for (const bad of ['', '1A', 'A B', 'A;rm', 'A%PATH%', 'A\nB', null]) {
    assert.throws(() => resolveSecret(bad, { env: {}, query: () => assert.fail('不应查询') }), /变量名无效/);
    assert.throws(() => queryUserEnv(bad, { platform: 'win32', run: () => assert.fail('不应查询') }), /变量名无效/);
    assert.throws(() => setUserSecret(bad, SECRET, { platform: 'win32', run: () => assert.fail('不应写入') }), /变量名无效/);
  }
});

test('状态只报告 set / missing，结果里没有任何值', () => {
  const status = secretStatus(['DEEPSEEK_API_KEY', 'OTHER_KEY'], { env: { DEEPSEEK_API_KEY: SECRET }, query: noReg });
  assert.deepEqual(status, { DEEPSEEK_API_KEY: 'set', OTHER_KEY: 'missing' });
  assert.ok(!JSON.stringify(status).includes(SECRET));
});

test('写入用户环境变量：值只经 stdin 传给 PowerShell，不进命令行；失败信息不带 stderr', () => {
  const calls = [];
  setUserSecret('DEEPSEEK_API_KEY', `${SECRET}\n`, { platform: 'win32', run: (script, input) => { calls.push({ script, input }); return { status: 0 }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, SECRET);
  assert.ok(!calls[0].script.includes(SECRET), '脚本（命令行参数）里不能有密钥');
  assert.match(calls[0].script, /SetEnvironmentVariable\('DEEPSEEK_API_KEY',\$v,'User'\)/);
  assert.match(calls[0].script, /^\[Console\]::InputEncoding=\[Text\.UTF8Encoding\]::new\(\$false\); \$v=\[Console\]::In\.ReadToEnd\(\)/, '先把标准输入设为 UTF-8 再读');
  assert.throws(() => setUserSecret('DEEPSEEK_API_KEY', SECRET, { platform: 'win32', run: () => ({ status: 1, stderr: `回显 ${SECRET}` }) }),
    e => /写入用户环境变量 DEEPSEEK_API_KEY 失败/.test(e.message) && !e.message.includes(SECRET));
});

test('写入拒绝空值、多行值与非 Windows 平台', () => {
  const run = () => assert.fail('不应写入');
  assert.throws(() => setUserSecret('K', '  ', { platform: 'win32', run }), /不能为空/);
  assert.throws(() => setUserSecret('K', 'a\nb', { platform: 'win32', run }), /不能包含换行/);
  assert.throws(() => setUserSecret('K', SECRET, { platform: 'linux', run }), /只有 Windows/);
});

test('AR_TEST_SECRETS_FILE：读取走文件、完全跳过注册表、先看进程环境变量', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ar-secrets-'));
  const file = path.join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify({ DEEPSEEK_API_KEY: SECRET, OTHER: 123, BLANK: '' }));
  const opts = { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run: () => assert.fail('不应查询注册表') };
  try {
    assert.equal(queryUserEnv('DEEPSEEK_API_KEY', opts), SECRET);
    // Windows 下变量名不区分大小写，文件里的键也一样。
    assert.equal(queryUserEnv('deepseek_api_key', { ...opts, platform: 'win32' }), SECRET);
    // 值不是字符串、缺失都当作没有；空字符串按"存在但为空"返回（与注册表一致，resolveSecret 下游会当作缺失）。
    assert.equal(queryUserEnv('OTHER', opts), undefined);
    assert.equal(queryUserEnv('BLANK', opts), '');
    assert.equal(queryUserEnv('NOPE', opts), undefined);
    // 进程环境变量优先于文件。
    const query = n => queryUserEnv(n, { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run: () => assert.fail('不应查询注册表') });
    assert.equal(resolveSecret('DEEPSEEK_API_KEY', { env: { DEEPSEEK_API_KEY: 'FROM_PROCESS' }, query }), 'FROM_PROCESS');
    assert.equal(resolveSecret('DEEPSEEK_API_KEY', { env: {}, query }), SECRET);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AR_TEST_SECRETS_FILE：写入只写文件、原子替换、不调用 PowerShell，仍拒绝空值与多行', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ar-secrets-'));
  const file = path.join(dir, 'secrets.json');
  const run = () => assert.fail('不应调用 PowerShell');
  try {
    setUserSecret('DEEPSEEK_API_KEY', ` ${SECRET}\n`, { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { DEEPSEEK_API_KEY: SECRET });
    // 与已有内容合并，同名覆盖；目录里不留临时文件。
    setUserSecret('OTHER', 'x', { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run });
    setUserSecret('DEEPSEEK_API_KEY', 'v2', { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { DEEPSEEK_API_KEY: 'v2', OTHER: 'x' });
    assert.deepEqual(readdirSync(dir).sort(), ['secrets.json']);
    // 空值与多行仍在写入前拒绝，文件不变。
    assert.throws(() => setUserSecret('K', '  ', { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run }), /不能为空/);
    assert.throws(() => setUserSecret('K', 'a\nb', { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run }), /不能包含换行/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { DEEPSEEK_API_KEY: 'v2', OTHER: 'x' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AR_TEST_SECRETS_FILE：文件损坏或缺失时按空对象处理', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ar-secrets-'));
  const file = path.join(dir, 'secrets.json');
  const run = () => assert.fail('不应查询注册表');
  try {
    assert.equal(queryUserEnv('K', { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run }), undefined);
    writeFileSync(file, '不是 JSON');
    assert.equal(queryUserEnv('K', { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run }), undefined);
    // 写入会覆盖损坏内容，产出合法 JSON。
    setUserSecret('K', 'v', { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run: () => assert.fail('不应调用 PowerShell') });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { K: 'v' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('删除用户环境变量：脚本只含变量名、值设为 $null，失败信息不带 stderr', () => {
  const calls = [];
  unsetUserSecret('DEEPSEEK_API_KEY', { platform: 'win32', run: script => { calls.push(script); return { status: 0 }; } });
  assert.deepEqual(calls, ["[Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY',$null,'User')"]);
  assert.throws(() => unsetUserSecret('DEEPSEEK_API_KEY', { platform: 'win32', run: () => ({ status: 1, stderr: `回显 ${SECRET}` }) }),
    e => /删除用户环境变量 DEEPSEEK_API_KEY 失败/.test(e.message) && !e.message.includes(SECRET));
});

test('删除拒绝非法变量名，且不会调用 PowerShell；非 Windows 没有隔离文件时拒绝', () => {
  const run = () => assert.fail('不应调用 PowerShell');
  for (const bad of ['', '1A', 'A B', 'A;rm', 'A%PATH%', 'A\nB', null]) assert.throws(() => unsetUserSecret(bad, { platform: 'win32', run }), /变量名无效/);
  assert.throws(() => unsetUserSecret('DEEPSEEK_API_KEY', { platform: 'linux', env: {}, run }), /只有 Windows/);
});

test('AR_TEST_SECRETS_FILE：删除只改文件、变量名不区分大小写、不存在也算成功，不调用 PowerShell', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ar-secrets-'));
  const file = path.join(dir, 'secrets.json');
  const run = () => assert.fail('不应调用 PowerShell');
  try {
    writeFileSync(file, JSON.stringify({ DEEPSEEK_API_KEY: SECRET, OTHER_KEY: 'keep', APITOKEN: 'keep' }));
    unsetUserSecret('deepseek_api_key', { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { OTHER_KEY: 'keep', APITOKEN: 'keep' });
    // 不存在的变量同样成功；其他平台的键名区分大小写，不会被误删。
    unsetUserSecret('NOT_THERE', { platform: 'win32', env: { AR_TEST_SECRETS_FILE: file }, run });
    unsetUserSecret('apitoken', { platform: 'linux', env: { AR_TEST_SECRETS_FILE: file }, run });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { OTHER_KEY: 'keep', APITOKEN: 'keep' });
    assert.deepEqual(readdirSync(dir), ['secrets.json'], '不留下临时文件');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('真实注册表读取（只读）：用户的 TEMP 能读出且已展开', { skip: process.platform !== 'win32' }, () => {
  const value = queryUserEnv('TEMP');
  if (value === undefined) return; // 有的机器用户级没有 TEMP，不算失败
  assert.ok(!value.includes('%'), '已展开');
});
