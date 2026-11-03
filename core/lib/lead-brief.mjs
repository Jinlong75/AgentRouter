import { ackFiles, ackToken } from './lead-ack.mjs';
import { coreCommand } from './ar-command.mjs';
import { checkSkills, installedCoreVersion } from './skills-check.mjs';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { git } from './git.mjs';
import { nextLines, nextTasks } from './next.mjs';
import { parseJson } from './json.mjs';

const reminder = '你是本项目的主导。上面的交接文件每条都要遵守。开工先核对在跑任务（ar status、git worktree list），不要重复派发；\n每次任务结束：看 ar wait 输出的资源、待验收与可派发，先派满再验收；遇到绕路当场记成任务。\n读长日志、审查初筛、文档核对、按既定脚本出候选或打包，先用 ar dispatch "<任务文字>" --type research|chore 交给便宜的执行者，主导只读结论。\n按文件分批调研用 ar research "<问题>" --files <glob…>。';

function within(base, file) {
  try {
    const rel = relative(realpathSync(base), realpathSync(file));
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  } catch { return false; }
}

function validHandoff(root, value) {
  if (isAbsolute(value) || win32.isAbsolute(value) || /^[a-z]:/i.test(value) || value.split(/[\\/]/).includes('..')) return false;
  const file = resolve(root, value);
  // 不存在的文件仍需检查其最近的现存祖先，防止目录联接越界。
  let parent = file;
  while (!existsSync(parent)) {
    const next = resolve(parent, '..');
    if (next === parent) return false;
    parent = next;
  }
  return within(root, parent);
}

export function resolveBriefFiles(root, coreDir, project) {
  const configured = project.lead?.handoff;
  const invalid = typeof configured === 'string' && configured && !validHandoff(root, configured);
  const handoffs = typeof configured === 'string' && configured && !invalid ? [configured] : ['handoff.md', 'HANDOFF.md'];
  const handoff = handoffs.map(path => resolve(root, path)).find(file => within(root, file));
  const installedBase = resolve(coreDir, '../..');
  const practice = [[installedBase, resolve(installedBase, 'lead-practices/SKILL.md')], [root, join(root, 'skills/lead-practices/SKILL.md')], [coreDir, join(coreDir, 'templates/lead-practices/checklist.md')]].find(([base, file]) => within(base, file))?.[1];
  const candidate = join(root, 'docs/roles/lead.md');
  return { configured, invalid, handoff, handoffFallback: handoffs[0], practice, role: within(root, candidate) ? candidate : null };
}

export function briefNext(options, timeoutMs = 3000) {
  return new Promise(resolveResult => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { leadBriefNext: true, options } });
    let done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); worker.terminate(); resolveResult(result); };
    const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
    worker.once('message', finish);
    worker.once('error', error => finish({ error: error.message }));
    worker.once('exit', code => finish({ error: `工作线程退出：${code}` }));
  });
}

if (!isMainThread && workerData?.leadBriefNext) {
  nextTasks(workerData.options).then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error: String(error?.message ?? error) }));
}

function limited(text, limit, label) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return lines.length > limit ? [...lines.slice(0, limit), `（${label}共 ${lines.length} 行，只放了前 ${limit} 行，其余用 Read 读）`].join('\n') : lines.join('\n');
}

export async function leadBrief({ root, home, env = process.env, coreDir }) {
  const found = git(root, ['rev-parse', '--show-toplevel']);
  if (found.status !== 0) return { ok: true, sections: [], text: '' };
  root = found.stdout.trim();
  const configPath = join(root, '.agent-router', 'project.json');
  if (!existsSync(configPath)) return { ok: true, sections: [], text: '' };
  const project = parseJson(readFileSync(configPath, 'utf8'));
  const sections = [];
  const skills = checkSkills({ env, root, coreVersion: installedCoreVersion(coreDir) });
  if (!skills.ok) sections.push({ title: '技能版本', text: [...skills.issues.map(issue => issue.text), '更新技能：在软件 Agent 页"技能"里更新，或运行 node installer/install.mjs --yes（开发 AgentRouter 时用仓库里的安装器）'].join('\n'), path: 'ar lead brief' });
  const paths = resolveBriefFiles(root, coreDir, project);
  const { handoff, invalid, configured, practice, role } = paths;
  const files = ackFiles(root, coreDir, paths);
  const handoffText = handoff ? limited(files[0].content, 150, '交接文件') : '';
  if (handoff || invalid) sections.push({ title: '交接文件', text: [invalid ? `交接文件路径不在仓库内，已忽略：${configured}` : '', handoffText].filter(Boolean).join('\n'), path: handoff ?? 'handoff.md' });
  const practiceText = practice ? files[1].content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '') : '没有找到 lead-practices 技能：按 docs/roles/lead.md 工作';
  sections.push({ title: '主导经验清单', text: limited(practiceText, 200, '主导经验清单'), path: practice ?? 'skills/lead-practices/SKILL.md' });
  if (role) sections.push({ title: '角色文档', text: limited(files[2].content, 120, '角色文档'), path: role });
  const next = await briefNext({ root, home, env });
  sections.push({ title: '当前任务', text: next.result ? nextLines(next.result).join('\n') : next.timeout ? '超过 3 秒没取到' : `取不到：${String(next.error).split(/\r?\n/)[0]}`, path: 'ar next' });
  sections.push({ title: '固定提醒', text: reminder, path: 'docs/roles/lead.md' });
  const render = items => items.map(item => `## ${item.title}\n${item.text}`).join('\n\n');
  // 先预留每节的提示行，再按优先级替换成完整内容。
  if (render(sections).length > 24000) {
    const chosen = sections.map(item => ({ ...item, text: `（${item.title} 太长未放入，用 Read 读 ${item.path}）` }));
    for (const title of ['技能版本', '当前任务', '固定提醒', '交接文件', '角色文档', '主导经验清单']) {
      const index = sections.findIndex(item => item.title === title);
      if (index < 0) continue;
      const previous = chosen[index];
      chosen[index] = sections[index];
      if (render(chosen).length > 24000) chosen[index] = previous;
    }
    sections.splice(0, sections.length, ...chosen);
  }
  const clean = sections.map(({ title, text, path }) => ({ title, text, path }));
  const token = ackToken(files);
  // 第一行告诉主导本机该敲哪个命令：Windows 的 msys64 / binutils、macOS / Linux 的开发工具都自带同名 ar。
  // 放在读取交接文件之后，免得查找文件的 await 改变开工包的快照。
  const { command, shadowedBy } = await coreCommand({ env, coreDir });
  const commandLine = command === 'ar'
    ? '本机核心命令：ar'
    : `本机核心命令：${command}（${shadowedBy ? `这台机器上的 ar 是 ${shadowedBy}，不是 AgentRouter` : '没有装 ar 命令'}；下文和技能里写的 ar 都换成它）`;
  return { ok: true, sections: clean, ack: { token, files: files.map(file => file.path) }, text: `${commandLine}\n\n${render(clean)}\n读完后确认：ar lead ack ${token}（项目开了 leadStrict 时，派发、重试、合入前必须先确认）` };
}
