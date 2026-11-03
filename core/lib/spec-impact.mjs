import { readFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { parseSpec, validateSpec } from './spec.mjs';
import { matchesAny } from './glob.mjs';
import { git } from './git.mjs';
import { readJson } from './json.mjs';

const defaults = ['tests/**', 'test/**', '**/__tests__/**', 'checks/**', '**/*.test.*', '**/*.spec.*'];

// 只读工作区文件；Git 负责限定已跟踪的搜索范围。
export function specImpact({ root, specFile, project, limit = 200, docs = false }) {
  root = resolve(root);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('--limit 必须是非负整数');
  const file = isAbsolute(specFile) ? specFile : resolve(root, specFile);
  let content;
  try { content = readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`找不到文件：${specFile}`);
    throw error;
  }
  const parsed = parseSpec(content, specFile);
  const spec = validateSpec(parsed, specFile);
  const found = new Map();
  const add = (text, from) => {
    if (!text || /[\r\n\0]/.test(text)) return;
    if (!found.has(text)) found.set(text, []);
    if (!found.get(text).includes(from)) found.get(text).push(from);
  };
  for (const path of docs ? [] : spec.allowed_paths ?? []) {
    if (/[*?]/.test(path)) continue;
    const name = basename(path);
    add(name, `allowed_paths:${path}`);
    add(name.slice(0, name.length - extname(name).length), `allowed_paths:${path}`);
    try {
      const source = readFileSync(join(root, path), 'utf8');
      for (const match of source.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|class)\s+([\w$]+)/g)) add(match[1], `export:${path}`);
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error; }
  }
  for (const match of parsed.body.matchAll(/`([^`\r\n]{3,80})`/g)) {
    const value = match[1].trim();
    if (value.length >= 3 && (docs || !/^--[\w-]+$/.test(value)) && !/^\d+$/.test(value)) add(value, '正文:反引号');
  }
  for (const match of parsed.body.matchAll(/“([^”\r\n]{2,40})”|「([^」\r\n]{2,40})」|"([^"\r\n]{2,40})"/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (/[\u3400-\u9fff]/.test(value)) add(value, '正文:引号');
  }
  const clues = [...found].map(([text, from]) => ({ text, from }));
  if (project === undefined) {
    try { project = readJson(join(root, '.agent-router', 'project.json')); } catch { project = {}; }
  }
  const key = docs ? 'impactDocPaths' : 'impactPaths';
  const extra = docs && project?.[key] !== undefined ? project[key] : project?.[key] ?? [];
  if (!Array.isArray(extra) || extra.some(x => typeof x !== 'string')) throw new Error(`${key} 必须是字符串数组`);
  const patterns = [...(docs ? ['**/*.md'] : defaults), ...extra];
  const hits = new Map();
  for (let i = 0; i < clues.length; i += 100) {
    const batch = clues.slice(i, i + 100);
    // 关掉用户 git 配置里会改变输出格式的项（颜色、列号），否则解析不到命中（321 审查 R4-1）。
    const result = git(root, ['-c', 'core.quotepath=false', '-c', 'color.grep=never', '-c', 'grep.column=false', 'grep','-n', '-z', '-I', '-F', ...batch.flatMap(c => ['-e', c.text]), '--', '.']);
    if (result.status !== 0 && result.status !== 1) throw new Error(`git grep 失败：${result.stderr.trim()}`);
    for (const row of result.stdout.split('\n')) {
      const match = /^(.*?)\0(\d+)\0(.*)$/.exec(row);
      if (!match) continue;
      const [, fileName, number, text] = match;
      if (!matchesAny(fileName, patterns)) continue;
      if (docs && (fileName.startsWith('docs/specs/') || fileName.startsWith('docs/autonomy/') || /(?:^|\/)CHANGELOG[^/]*$/.test(fileName) || /(?:^|\/)node_modules\//.test(fileName))) continue;
      const key = `${fileName}\0${number}`;
      if (!hits.has(key)) hits.set(key, { file: fileName, line: Number(number), text, clues: [] });
      const hit = hits.get(key);
      for (const clue of batch) if (text.includes(clue.text) && !hit.clues.includes(clue.text)) hit.clues.push(clue.text);
    }
  }
  const files = new Map();
  for (const hit of hits.values()) {
    if (!files.has(hit.file)) files.set(hit.file, []);
    files.get(hit.file).push(hit);
  }
  const groups = [];
  for (const [fileName, rows] of files) {
    if (docs) {
      groups.push({ file: fileName, hits: rows.sort((a, b) => a.line - b.line).map(hit => ({ line: hit.line, text: [...hit.text].slice(0, 160).join(''), clues: hit.clues })) });
      continue;
    }
    const lines = readFileSync(join(root, ...fileName.split('/')), 'utf8').split(/\r?\n/);
    const countPattern = /(?:length\s*===\s*\d+|===\s*\d+|新建\s*\d+|\d+\s*个)/;
    const byLine = new Map(rows.map(hit => [hit.line, { line: hit.line, text: [...hit.text].slice(0, 160).join(''), clues: hit.clues, fixedCount: countPattern.test(hit.text) }]));
    for (const hit of rows.sort((a, b) => a.line - b.line)) {
      for (let number = Math.max(1, hit.line - 3); number <= Math.min(lines.length, hit.line + 3); number++) {
        if (countPattern.test(lines[number - 1]) && !byLine.has(number)) {
          byLine.set(number, { line: number, text: [...lines[number - 1]].slice(0, 160).join(''), clues: [], fixedCount: true, nearHit: hit.line });
        }
      }
    }
    const result = [...byLine.values()].sort((a, b) => a.line - b.line);
    groups.push({ file: fileName, hits: result });
  }
  groups.sort((a, b) => new Set(b.hits.flatMap(h => h.clues)).size - new Set(a.hits.flatMap(h => h.clues)).size || a.file.localeCompare(b.file));
  const total = groups.reduce((sum, group) => sum + group.hits.length, 0);
  let left = limit;
  const limited = [];
  for (const group of groups) {
    const selected = group.hits.slice(0, left);
    if (selected.length) limited.push({ file: group.file, hits: selected });
    left -= selected.length;
  }
  return { ok: true, clues, groups: limited, truncated: total > limit, total, mode: docs ? 'docs' : 'tests' };
}
