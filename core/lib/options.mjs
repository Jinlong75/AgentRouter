import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { parseSpec } from './spec.mjs';

export function parseArgs(args) {
  const opts = {}, positional = [];
  const names = ['role', 'name', 'host', 'profile', 'model', 'effort', 'tier', 'sandbox', 'watch-window'];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { positional.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) {
      if (a === '--detach') { opts.detach = true; continue; }
      if (!names.includes(a.slice(2)) || !args[k + 1] || args[k + 1].startsWith('--')) throw new Error(`参数无效或缺少值：${a}`);
      opts[a.slice(2)] = args[++k];
    } else positional.push(a);
  }
  if (!positional[0]) throw new Error('用法：ar dispatch <任务说明文件 | "任务文字"> ["补充说明"] [--profile <执行者>] [--role <角色文档名>|none] [--name <记录名>] [--host claude-code|agentrouter]');
  // 派活方取值：claude-code（技能 / 会话）、agentrouter（监控软件派发）；其他值报错不变。
  if (opts.host && !['claude-code', 'agentrouter'].includes(opts.host)) throw new Error(`无效的派活方：${opts.host}`);
  return { opts, task: positional[0], extra: positional[1] ?? '' };
}

export const clipTitle = s => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
};

export function taskDetails(root, { opts, task, extra }) {
  const target = resolve(root, task);
  const spec = existsSync(target) && statSync(target).isFile() ? task : null;
  let role = null, roleKey = null, roleDefault = false;
  const roleNone = opts.role === 'none';
  const loadRole = key => {
    const doc = /[\\/.]/.test(key) ? key : `docs/roles/${key}.md`;
    if (!existsSync(resolve(root, doc))) return null;
    const title = readFileSync(resolve(root, doc), 'utf8').split(/\r?\n/).find(l => l.startsWith('# ')) ?? '';
    return { doc, name: title.replace(/^#\s*(角色[:：]\s*)?/, '').trim() || key };
  };
  if (opts.role && !roleNone) {
    role = loadRole(opts.role);
    if (!role) throw new Error(`找不到角色文档：${resolve(root, /[\\/.]/.test(opts.role) ? opts.role : `docs/roles/${opts.role}.md`)}`);
    roleKey = opts.role;
  } else if (!opts.role) {
    // 没写 --role：任何派发（任务说明或直接写任务文字）都默认带角色，review 类任务说明默认审查者，其余默认执行者；角色文档不存在就不带角色（D63、D75）。
    let type = null;
    if (spec) {
      try { type = parseSpec(readFileSync(target, 'utf8'), spec).meta.type ?? null; } catch { /* frontmatter 有问题留给门禁报错，这里按非 review 处理 */ }
    }
    const key = type === 'review' ? 'reviewer' : 'worker';
    role = loadRole(key);
    if (role) { roleKey = key; roleDefault = true; }
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const name = opts.name ?? (spec ? basename(spec, extname(spec)) : `task-${stamp}`);
  if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error(`无效的记录名：${name}`);
  const prompt = [
    role ? `你在本项目中的角色是「${role.name}」。` : '',
    existsSync(join(root, 'AGENTS.md')) ? '请先阅读仓库根目录的 AGENTS.md（共同规则）。' : '',
    role ? `再阅读你的角色文档 ${role.doc}，严格遵守其中的职责、硬规则、完成标准和汇报格式。` : '',
    spec ? `然后完成任务说明 ${spec} 中的全部内容，按要求验证、提交，最后给出汇报。` : `任务：\n${task}`,
    extra,
  ].filter(Boolean).join('\n');
  return { spec, role, roleKey, roleDefault, roleNone, name, prompt, title: spec ?? clipTitle(task) };
}

export function dispatcher(host, env) {
  host ??= env.CLAUDECODE === '1' ? 'claude-code' : 'unknown';
  return { host, session: host === 'claude-code' ? env.CLAUDE_CODE_SESSION_ID || null : null };
}
