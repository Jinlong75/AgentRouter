import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { resolveBriefFiles } from './lead-brief.mjs';
import { parseJson } from './json.mjs';
import { dispatcher } from './options.mjs';
import { git } from './git.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => value.replace(/\r\n?/g, '\n');
const recordPath = root => join(root, '.agent-runs', 'lead-ack.json');
const readRecord = root => { try { return JSON.parse(readFileSync(recordPath(root), 'utf8')); } catch { return null; } };
export function ackRoot(root) {
  const found = git(root, ['rev-parse', '--show-toplevel']);
  return found.status === 0 ? found.stdout.trim() : root;
}
export function ackFiles(root, coreDir, resolvedPaths) {
  let paths = resolvedPaths;
  if (!paths) {
    let project = {};
    try { project = parseJson(readFileSync(join(root, '.agent-router/project.json'), 'utf8')); } catch { /* 缺失配置按默认路径处理。 */ }
    paths = resolveBriefFiles(root, coreDir, project ?? {});
  }
  const candidates = [paths.handoff ?? resolve(root, paths.handoffFallback), paths.practice ?? resolve(root, 'skills/lead-practices/SKILL.md'), paths.role ?? resolve(root, 'docs/roles/lead.md')];
  return candidates.map((file, index) => {
    let content = '';
    if ([paths.handoff, paths.practice, paths.role][index]) content = readFileSync(file, 'utf8');
    return { path: relative(root, file).replace(/\\/g, '/'), content: normalized(content) };
  });
}
export function ackToken(files) {
  const digest = createHash('sha256');
  for (const file of files) digest.update(file.path).update('\0').update(normalized(file.content));
  return digest.digest('hex').slice(0, 12);
}
const hashes = files => Object.fromEntries(files.map(file => [file.path, hash(normalized(file.content))]));
function changes(files, record) {
  const current = hashes(files), old = record?.files;
  if (!old || typeof old !== 'object' || Array.isArray(old)) return [];
  return [...new Set([...Object.keys(old), ...Object.keys(current)])].filter(path => old[path] !== current[path]);
}
export function checkAck(root, coreDir, { env = process.env, hours = 12, now = Date.now() } = {}) {
  const record = readRecord(root);
  if (!record || record.v !== 1 || typeof record.token !== 'string' || !record.files || typeof record.files !== 'object' || !Number.isFinite(record.at)) return '没有确认记录';
  const files = ackFiles(root, coreDir);
  if (record.token !== ackToken(files)) return `文件已改：${changes(files, record).join('、') || '已改动'}`;
  const session = dispatcher(undefined, env).session;
  if (session && record.session) return session === record.session ? null : '会话已换';
  if (now - record.at > hours * 3600000 || record.at > now) return `确认已超过 ${hours} 小时`;
  return null;
}
export function confirmAck(cwd, coreDir, token, env = process.env) {
  const root = ackRoot(cwd), files = ackFiles(root, coreDir), current = ackToken(files);
  if (token !== current) {
    const text = '确认码不对：文件在你读过之后改过（已改动），重新运行 ar lead brief 再确认';
    return { result: { error: text }, text, code: 2 };
  }
  mkdirSync(join(root, '.agent-runs'), { recursive: true });
  writeFileSync(recordPath(root), `${JSON.stringify({ v: 1, token, files: hashes(files), session: dispatcher(undefined, env).session, at: Date.now() }, null, 2)}\n`);
  const text = `已确认：${token}（交接文件、经验清单、主导角色文档）`;
  return { result: { token }, text };
}
