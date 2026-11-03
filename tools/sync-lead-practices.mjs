import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function syncLeadPractices({ source = join(root, 'skills/lead-practices'), target = join(root, 'core/templates/lead-practices'), check = false } = {}) {
  const normalized = file => readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const files = {
    'checklist.md': normalized(join(source, 'SKILL.md')).replace(/^---\n[\s\S]*?\n---\n/, '').replaceAll('references/examples.md', 'examples.md').replaceAll('references/closeout.md', 'closeout.md'),
    'examples.md': normalized(join(source, 'references/examples.md')),
    'closeout.md': normalized(join(source, 'references/closeout.md')),
  };
  const different = [];
  for (const [name, content] of Object.entries(files)) {
    const file = join(target, name);
    if (check) {
      try { if (readFileSync(file, 'utf8') !== content) different.push(name); }
      catch { different.push(name); }
    } else {
      mkdirSync(target, { recursive: true });
      writeFileSync(file, content, 'utf8');
    }
  }
  return different;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv.slice(2).includes('--check');
  const different = syncLeadPractices({ check });
  if (different.length) { console.error(different.join('\n')); process.exitCode = 1; }
}
