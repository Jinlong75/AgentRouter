import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 解析 tokens.css 的两套主题；颜色只认 #rrggbb 与 rgba()。
const css = readFileSync(new URL('../../app/design/tokens.css', import.meta.url), 'utf8');
const theme = name => {
  const block = css.match(new RegExp(`\\[data-theme="${name}"\\]\\s*\\{([^}]*)\\}`))[1];
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
};
const dark = theme('dark'), light = theme('light');
const rgb = value => {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16));
  throw new Error(`不是实色：${value}`);
};
const luminance = value => {
  const [r, g, b] = rgb(value).map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// "最低对比度"列：对 --bg、--surface、--selected 三种底色取最小值（--on-brand 对 --brand-fill）。
const minimum = (tokens, name) => name === 'on-brand' ? contrast(tokens['on-brand'], tokens['brand-fill'])
  : Math.min(...['bg', 'surface', 'selected'].map(base => contrast(tokens[name], tokens[base])));

// 颜色表（令牌名、深色值、浅色值、最低对比度）：断言全部对着这份 fixture 做，公开快照里没有开发文档也能跑。
const fixture = JSON.parse(readFileSync(new URL('../fixtures/visualspec-colors.json', import.meta.url), 'utf8'));

// "最低对比度"单元格（'—' 或 '8.4 / 3.1（…）'）→ 数值对（深 / 浅）与书写文本（比较时用小数位数）。
const parseMin = raw => {
  const written = raw === '—' ? null : raw.match(/([\d.]+) \/ ([\d.]+)/).slice(1);
  return { min: written?.map(Number) ?? null, minText: written };
};
const table = fixture.map(({ name, dark: d, light: l, min }) => ({ name, dark: d, light: l, ...parseMin(min) }));

test('深浅两套令牌名完全一致', () => {
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
  assert.ok(Object.keys(dark).length >= 25);
});

// 只做书写格式归一：大小写、空格、小数的前导 0（rgba(…, 0.14) 与 rgba(…,.14) 相同）。
const same = value => value?.toLowerCase().replaceAll(' ', '').replace(/([,(])0\./g, '$1.');

test('令牌取值与颜色表逐项一致；已删除的旧令牌不再出现', () => {
  assert.equal(table.length, 25, '颜色表行数');
  for (const row of table) {
    assert.equal(same(dark[row.name]), same(row.dark), `深色 --${row.name}`);
    assert.equal(same(light[row.name]), same(row.light), `浅色 --${row.name}`);
  }
  for (const old of ['brand-ikb', 'accent', 'accent-hover', 'accent-text', 'warn', 'warn-bg', 'info', 'info-bg']) assert.ok(!css.includes(`--${old}:`), `--${old}`);
  // 品牌色的悬停色（深 #FFB52E、浅 #E89A06）
  assert.equal(dark['brand-fill-hover'], '#FFB52E'); assert.equal(light['brand-fill-hover'], '#E89A06');
});

// 表中的值按表里写的小数位数比较（多数行是四舍五入值）；WCAG 门槛按精确值比较，没有例外。
const atPlaces = (value, written) => Number(value.toFixed((String(written).split('.')[1] ?? '').length));

test('最低对比度逐项达到颜色表列出的值，文字类令牌不低于 WCAG AA 4.5，焦点环不低于 3', () => {
  const checked = table.filter(row => row.min);
  assert.equal(checked.length, 10);
  for (const row of checked) {
    for (const [index, tokens, label] of [[0, dark, '深色'], [1, light, '浅色']]) {
      const actual = minimum(tokens, row.name);
      assert.ok(atPlaces(actual, row.minText[index]) >= row.min[index], `${label} --${row.name} 对比度 ${actual.toFixed(4)} 低于 ${row.min[index]}`);
      assert.ok(actual >= (row.name === 'focus' ? 3 : 4.5), `${label} --${row.name} 对比度 ${actual.toFixed(4)} 不满足 WCAG`);
    }
  }
});

test('对比度计算与已知值一致（白对黑 21:1，自身 1:1）', () => {
  assert.equal(contrast('#FFFFFF', '#000000').toFixed(1), '21.0');
  assert.equal(contrast('#777777', '#777777'), 1);
});
