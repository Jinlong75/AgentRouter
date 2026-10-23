import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parseJson, readJson } from '../../core/lib/json.mjs';
import { readConfig, loadConfig } from '../../core/lib/config.mjs';

// 062：核心读取的 JSON 文件开头的 UTF-8 BOM 一律忽略（协议第 4 节"编码（Stage05 起）"）。
const BOM = '\uFEFF';
const dirs = (t, label) => {
  const base = fs.mkdtempSync(path.join(tmpdir(), label));
  t.after(() => { assert.equal(path.dirname(base), path.resolve(tmpdir())); fs.rmSync(base, { recursive: true, force: true }); });
  return base;
};

test('带 BOM 与不带 BOM 的同一份内容解析结果相同', () => {
  const text = '{"v":2,"列表":[1,2],"中文":"值","嵌套":{"a":null,"b":true}}';
  assert.deepEqual(parseJson(BOM + text), JSON.parse(text));
  assert.deepEqual(parseJson(text), JSON.parse(text));
  // 只忽略开头一个 BOM；内容里的 U+FEFF 是字符串内容，不额外去掉。
  assert.deepEqual(parseJson(BOM + '{"s":"\uFEFF"}'), { s: '\uFEFF' });
  // 开头一个之后的 BOM 算内容：按无效 JSON 处理（与 parseSpec 一样只去掉开头一个）。
  assert.throws(() => parseJson(BOM + BOM + '{"a":1}'), SyntaxError);
});

test('只有 BOM 的文件、BOM 后面是无效 JSON：仍按原来的"无效"处理', () => {
  assert.throws(() => parseJson(BOM), SyntaxError);
  assert.throws(() => parseJson(BOM + '{'), SyntaxError);
  assert.throws(() => parseJson(BOM + '不是 JSON'), SyntaxError);
  assert.throws(() => parseJson(BOM + 'null null'), SyntaxError);
  // 没有 BOM 的无效内容行为不变。
  assert.throws(() => parseJson('{'), SyntaxError);
});

test('readJson：读文件同样忽略开头 BOM；读取失败的错误原样抛出', t => {
  const base = dirs(t, 'json bom 单元 ');
  const file = path.join(base, '带 bom.json');
  fs.writeFileSync(file, BOM + '{"a":1,"b":[2]}\n', 'utf8');
  assert.deepEqual(readJson(file), { a: 1, b: [2] });
  const only = path.join(base, '只有 bom.json');
  fs.writeFileSync(only, BOM, 'utf8');
  assert.throws(() => readJson(only), SyntaxError);
  assert.throws(() => readJson(path.join(base, '没有这个文件.json')), error => error.code === 'ENOENT');
});

test('config.json 带 BOM：读出的配置与不带 BOM 相同；只有 BOM / BOM 加坏内容仍算无效', t => {
  const base = dirs(t, 'config bom 单元 ');
  const value = { v: 2, defaultProfile: 'fake', managed: true, profiles: { fake: { adapter: 'fake', label: '假执行者', enabled: true } } };
  const plain = path.join(base, '无 BOM'), bom = path.join(base, '有 BOM');
  fs.mkdirSync(plain); fs.mkdirSync(bom);
  fs.writeFileSync(path.join(plain, 'config.json'), JSON.stringify(value), 'utf8');
  fs.writeFileSync(path.join(bom, 'config.json'), BOM + JSON.stringify(value), 'utf8');
  const a = readConfig(plain), b = readConfig(bom);
  assert.equal(a.reason, null); assert.equal(b.reason, null);
  assert.deepEqual(b.config, a.config);
  assert.equal(loadConfig(bom, {}, {}).profileName, 'fake');
  assert.equal(loadConfig(bom, {}, {}).warning, null);
  fs.writeFileSync(path.join(bom, 'config.json'), BOM, 'utf8');
  assert.equal(readConfig(bom).reason, '不是有效的 JSON');
  fs.writeFileSync(path.join(bom, 'config.json'), BOM + '{', 'utf8');
  assert.equal(readConfig(bom).reason, '不是有效的 JSON');
});
