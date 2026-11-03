import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { locateStart, findTerminal } from './wait.mjs';
import { parseNeedsScope, readNeedsScope } from './needs-scope.mjs';
import { parseSpec, validateSpec, checkAllowedPath, mergeSpec } from './spec.mjs';
import { git } from './git.mjs';
import { run, readProjectConfig } from './run.mjs';
import { readDispatch, writeDispatch, taskPaths, attemptPaths } from './records.mjs';

const usage = '用法：ar scope approve <记录名> [--paths <路径…>] [--dry-run] [--detach] [--json]';
const fail = message => { throw new Error(message); };
export const quoteRetryNames = name => ({
  posix: `'${name.replaceAll("'", "'\\''")}'`,
  powershell: `'${name.replaceAll("'", "''")}'`,
});
const checked = (root, args) => {
  const result = git(root, args);
  if (result.status !== 0) fail(`git ${args[0]} 失败：${result.stderr.trim() || result.stdout.trim() || result.status}`);
  return result.stdout;
};
function safePath(value) {
  if (typeof value !== 'string' || /[*?\[\]{}]/.test(value) || /[\x00-\x1f\x7f]/.test(value) || /^[A-Za-z]:/.test(value)) fail(`非法路径：${value}`);
  checkAllowedPath(value, 0, (_key, reason) => fail(`非法路径 ${value}：${reason}`));
}
function editSpec(text, additions, specPath, project) {
  if (text.charCodeAt(0) === 0xfeff || /\r(?!\n)/.test(text) || (text.includes('\r\n') && /(?<!\r)\n/.test(text))) fail('说明换行或编码无法安全保留');
  const parsed = parseSpec(text, specPath);
  validateSpec(parsed, specPath);
  if (!parsed.lines.allowed_paths || !Array.isArray(parsed.meta.allowed_paths)) fail('说明必须包含块列表或空列表 allowed_paths');
  const lines = text.split(/\r?\n/), index = parsed.lines.allowed_paths - 1;
  const original = lines[index];
  const field = /^(allowed_paths:)(\s*)(\[\])?(\s*(?:#.*)?)$/.exec(original);
  if (!field) fail('allowed_paths 格式无法安全保留，请改成块列表后重试');
  const effective = mergeSpec(validateSpec(parsed, specPath), project).allowed_paths;
  const missing = [...new Set([...effective, ...additions])].filter(p => !parsed.meta.allowed_paths.includes(p));
  if (!missing.length) fail('申请路径已全部在允许范围内，无法创建说明提交');
  if (field[3]) lines[index] = original.replace('[]', '');
  let at = index + 1;
  while (at < lines.length && (/^  - /.test(lines[at]) || /^\s*(?:#.*)?$/.test(lines[at]))) at++;
  lines.splice(at, 0, ...missing.map(p => `  - ${JSON.stringify(p)}`));
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
}
export async function approveScope(args, { root, homes, scriptPath, env, log, capture, lines }) {
  if (args[0] !== 'approve' || !args[1] || args[1].startsWith('--')) fail(usage);
  const name = args[1]; let paths = null, dryRun = false, detach = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--dry-run' && !dryRun) { dryRun = true; continue; }
    if (args[i] === '--detach' && !detach) { detach = true; continue; }
    if (args[i] === '--paths' && paths === null) {
      paths = [];
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) paths.push(args[++i]);
      if (!paths.length) fail(usage);
      continue;
    }
    fail(usage);
  }
  const found = locateStart(homes, root, name);
  if (!found) fail('当前项目找不到记录');
  const { start, file } = found;
  const end = findTerminal(file, start.id);
  if (end?.event !== 'end' || !Number.isSafeInteger(end.attempts) || end.attempts < 1) fail('最新一次尝试没有汇报');
  let report;
  try { report = readFileSync(attemptPaths(taskPaths(root, start.name), end.attempts).report, 'utf8'); }
  catch { fail('最新一次尝试没有汇报'); }
  const requested = readNeedsScope(parseNeedsScope(report));
  if (!requested) fail('最新一次尝试的汇报没有越界申请');
  paths = [...new Set(paths ?? requested.map(item => item.path))];
  for (const p of paths) { safePath(p); if (!requested.some(item => item.path === p)) fail(`路径不属于申请：${p}`); }
  if (typeof start.spec !== 'string' || !start.spec) fail('记录没有任务说明');
  const absolute = resolve(root, start.spec), spec = relative(root, absolute).replaceAll('\\', '/');
  if (!spec || isAbsolute(spec) || spec === '..' || spec.startsWith('../')) fail('任务说明不在项目中');
  safePath(spec);
  try { const real = relative(realpathSync(root), realpathSync(absolute)); if (real === '..' || real.startsWith(`..${sep}`) || isAbsolute(real)) fail('任务说明不在项目中'); } catch (error) { fail(`找不到说明：${error.message}`); }
  checked(root, ['ls-files', '--error-unmatch', '--', spec]);
  if (checked(root, ['status', '--porcelain', '--untracked-files=no', '--', spec]).trim()) fail('任务说明有未提交的改动');
  const text = readFileSync(absolute, 'utf8');
  const updated = editSpec(text, [...new Set([...paths, ...(start.worktree === true ? [] : [spec])])], spec, readProjectConfig(root));
  const parsed = parseSpec(text, spec), id = String(parsed.meta.id ?? '');
  if (!id) fail('任务说明缺少编号');
  const message = `[文档] ${id}批准越界：${paths.join('、')}`;
  const noteFor = hash => `主导批准越界：${paths.join('、')}（说明提交 ${hash}，读取命令 git show ${hash}:${spec}）；只改汇报里申请的那几处`;
  if (dryRun) return { ok: true, exit: 0, dryRun, paths, spec, commit: null, note: noteFor('<hash>'), messages: [`将批准：${paths.join('、')}`, `将修改：${spec}`, `将提交：${message}`, `重试说明：${noteFor('<hash>')}`] };
  const saved = readDispatch(root, start.name);
  if (!saved) fail('无法读取派发记录保存说明来源');
  writeFileSync(absolute, updated, 'utf8');
  checked(root, ['add', '--', spec]);
  checked(root, ['commit', '-m', message, '--', spec]);
  const commit = checked(root, ['rev-parse', 'HEAD']).trim(), note = noteFor(commit);
  try { writeDispatch(taskPaths(root, start.name), { ...saved, scopeCommit: commit }); }
  catch (error) { fail(`说明提交 ${commit} 已创建，但保存说明来源失败：${error.message}；请手动处理`); }
  log(`已批准越界：${paths.join('、')}（说明提交 ${commit}）`);
  let code, error;
  const retryLines = [];
  try { code = await capture(async () => {
    const original = console.log;
    console.log = (...parts) => { retryLines.push(...parts.join(' ').split('\n')); original(...parts); };
    try { return await run({ scriptPath, env, root, retry: { name, note, scopeCommit: commit, ...(detach ? { detach: true } : {}) } }); }
    finally { console.log = original; }
  }); }
  catch (err) { code = 2; error = err.message; }
  if (code === 0 && detach) log(`重试已在后台开始：用 ar wait ${name} 等结果`);
  if (code !== 0) {
    error ??= retryLines.findLast(line => line.startsWith('出错：'))?.slice(3)
      ?? retryLines.findLast(line => line.startsWith('门禁未通过：')) ?? retryLines.at(-1) ?? '重试失败';
    const quoted = quoteRetryNames(name);
    log(`说明提交 ${commit}；重试失败：${error}。请手动重试（PowerShell）：ar retry ${quoted.powershell}；POSIX shell：ar retry ${quoted.posix}`);
  }
  return { ok: code === 0, exit: code, dryRun, paths, spec, commit, note, ...(code === 0 && detach ? { detached: true } : {}), ...(error ? { error } : {}), lines, messages: [] };
}
