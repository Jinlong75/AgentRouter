import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands, usage } from '../core/lib/cli.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const entries = dir => existsSync(path.join(root, dir))
  ? readdirSync(path.join(root, dir), { withFileTypes: true }) : [];
const skills = entries('skills').filter(e => e.isDirectory()).map(e => e.name).sort();
export const DEFAULT_FILES = [
  ...skills.flatMap(name => {
    const dir = `skills/${name}`;
    return [`${dir}/SKILL.md`, ...entries(`${dir}/references`)
      .filter(e => e.isFile() && e.name.endsWith('.md')).map(e => `${dir}/references/${e.name}`).sort()];
  }),
  ...entries('core/templates/roles').filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => `core/templates/roles/${e.name}`).sort(),
  ...['agents-block.md', 'specs-README.md', 'spec.md', 'autonomy.md'].map(f => `core/templates/${f}`),
].filter(f => existsSync(path.join(root, f)));

// 只处理代码中的命令，不解释 shell 表达式或跨行续写。
function parseCommand(text, file, line) {
  const match = text.trim().match(/^(?:cd\s+"[^"]*"\s*&&\s*)?(?:ar\s+|node\s+"[^"]*\/core\/ar\.mjs"\s+)(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const raw = text.trim();
  const args = (match[2] ?? '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return { file, line, sub: match[1], args, raw };
}

export function extractCommands(text, file) {
  const found = [];
  let fenced = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) {
      const command = parseCommand(line, file, index + 1);
      if (command) found.push(command);
    } else {
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        const command = parseCommand(match[1], file, index + 1);
        if (command) found.push(command);
      }
    }
  }
  return found;
}

export function checkCommands(found, { commands, usage }) {
  const lines = usage.split('\n');
  const options = new Map();
  let current = null;
  for (const line of lines) {
    const head = line.match(/^  ar (\S+)/);
    if (head) {
      current = head[1];
      if (!options.has(current)) options.set(current, new Set());
    } else if (!/^\s{4}/.test(line)) current = null;
    if (current) for (const option of line.match(/--[a-z][a-z0-9-]*/g) ?? []) options.get(current).add(option);
  }
  const problems = [];
  for (const { file, line, raw, sub, args } of found) {
    if (/^(?:<.*>|…|\.\.\.)$/.test(sub)) continue;
    const add = problem => problems.push({ file, line, raw, problem });
    if (!commands.includes(sub)) { add(`未知子命令：${sub}`); continue; }
    for (const arg of args) {
      if (!arg.startsWith('--')) continue;
      const option = arg.split('=', 1)[0];
      if (option !== '--json' && !options.get(sub)?.has(option)) add(`${sub} 没有选项：${option}`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  const selected = files.length ? files : DEFAULT_FILES.map(f => path.join(root, f));
  const found = selected.flatMap((file, i) => extractCommands(readFileSync(file, 'utf8'), files.length ? file : DEFAULT_FILES[i]));
  const problems = checkCommands(found, { commands, usage });
  if (problems.length) {
    for (const p of problems) console.log(`${p.file}:${p.line}  ${p.problem}  ${p.raw}`);
    console.log(`技能命令核对失败：${problems.length} 处`);
    process.exitCode = 1;
  } else console.log(`技能命令核对通过：${found.length} 条命令，${selected.length} 个文件`);
}
