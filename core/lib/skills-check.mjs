import { statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userDirectory } from './config.mjs';

// 与 cli.mjs 的 coreVersion 相同：开发包、安装记录、软件包依次查找。
export function installedCoreVersion(coreDir = fileURLToPath(new URL('..', import.meta.url))) {
  for (const file of [join(coreDir, '..', 'package.json'), join(coreDir, '..', '.agent-router.json'), join(coreDir, 'package.json')]) {
    try { const version = JSON.parse(readFileSync(file, 'utf8')).version; if (typeof version === 'string') return version; } catch { /* 尝试下一个位置。 */ }
  }
  return 'unknown';
}

const versionParts = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
const older = (a, b) => { const x = versionParts(a), y = versionParts(b); if (!x || !y) return false; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };

export function checkSkills({ env = process.env, root, coreVersion }) {
  const empty = { ok: true, issues: [] };
  try {
    // 与 installer/lib/install.mjs 的 detectHosts 一致，核心不依赖安装器。
    const claude = env.CLAUDE_CONFIG_DIR || join(userDirectory(env), '.claude');
    try { if (!statSync(claude).isDirectory()) return empty; } catch (error) { if (error.code === 'ENOENT') return empty; throw error; }
    try { if (!statSync(join(claude, 'skills')).isDirectory()) return empty; } catch (error) { if (error.code === 'ENOENT') return empty; throw error; }
    const issues = [];
    for (const skill of ['agent-router', 'lead-workflow', 'lead-practices']) {
      const dir = resolve(claude, 'skills', skill);
      try { if (!statSync(dir).isDirectory()) throw Object.assign(new Error(), { code: 'ENOENT' }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; issues.push({ skill, kind: 'missing', text: `没有安装技能 ${skill}` }); continue; }
      let marker;
      try { marker = JSON.parse(readFileSync(join(dir, '.agent-router.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (marker && older(marker.version, coreVersion)) issues.push({ skill, kind: 'old', text: `技能 ${skill} 是 ${marker.version}，核心是 ${coreVersion}` });
      const source = join(root, 'skills', skill, 'SKILL.md');
      let sourceBytes;
      try { sourceBytes = readFileSync(source); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (sourceBytes && sourceBytes.toString('utf8').replace(/\r\n?/g, '\n').replace(/^[ \t]*<!-- \/?host:[^\r\n]* -->[ \t]*(?:\n|$)/gm, '') !== readFileSync(join(dir, 'SKILL.md'), 'utf8').replace(/\r\n?/g, '\n')) issues.push({ skill, kind: 'differs', text: `已安装的技能 ${skill} 和仓库里的不一致` });
    }
    return { ok: issues.length === 0, issues };
  } catch { return empty; }
}
