// console 通道：渲染层用 window.dock.console(action, payload) 调用主进程，
// 主进程把每个操作翻译成一条核心命令，用 coreRun 运行 core/ar.mjs … --json，结果原样或整理后交回。
// 只做参数校验与结果映射：参数一律用数组传给 coreRun（绝不拼命令字符串），
// 密钥值只经 input 传入，绝不进参数数组，也绝不写进日志或错误信息。
import path from 'node:path';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { parseJson } from '../../../core/lib/json.mjs';

// 执行者名 / 预设名：字母、数字、下划线、连字符，1～40 个字符。
const validName = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
// 环境变量名：字母或下划线开头，后续为字母、数字、下划线，共 1～64 个字符。
const validVarName = v => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v);
// 显示名、模型、地址：单行、≤200 字符。
const validSingle = v => typeof v === 'string' && v.length <= 200 && !/[\r\n]/.test(v);
// 其他单行字符串（如 baseBranch、specsDir）：只要求单行，交给核心做进一步的校验。
const validLine = v => typeof v === 'string' && !/[\r\n]/.test(v);
// 单行绝对路径。
const validAbsPath = v => typeof v === 'string' && !/[\r\n]/.test(v) && path.isAbsolute(v);
// 相对任务说明路径：单行、以 .md 结尾、不以 / 或 \ 或盘符开头（防止逃出项目）。
// 相对路径不能以 / 、\ 或盘符开头（Windows 下 \foo 会逃出项目根）。
const validSpecRel = v => typeof v === 'string' && !/[\r\n]/.test(v) && v.toLowerCase().endsWith('.md') && !/^[/\\]/.test(v) && !/^[A-Za-z]:/.test(v);
const AUTH = ['login', 'token'];
// 任务记录名：核心 taskDetails 的规则（可含中文与空格；不含 <>:"/\|?* 与控制字符；不以点或空格结尾；不是保留设备名）。
// 再派一次只读取已有记录，这里再挡一次目录穿越与非法文件名。
const validRecord = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[<>:"/\\|?*\x00-\x1f]/.test(v) && !/[. ]$/.test(v) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v);

// Windows 不区分大小写比较路径；先 resolve 去掉尾分隔符并统一分隔符与盘符大小写。
const normPath = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => normPath(a) === normPath(b);

// 验收钩子（041）：AR_SHOTS_EXPERIMENT=projects-show-delay 时，每次处理 projects:show 先等 2 秒再调用核心，
// 确定性地复现"项目页刷新期间点击被丢掉"。只在界面验收（AR_SHOTS，由 tools/shots.mjs 设置）里生效；
// 平时不设这个环境变量，行为与性能完全不变。
const PROJECTS_SHOW_DELAY_MS = process.env.AR_SHOTS && (process.env.AR_SHOTS_EXPERIMENT ?? '').split(',').includes('projects-show-delay') ? 2000 : 0;

// 在项目目录打开 Claude Code（Stage03 第 7 节）：有 Windows Terminal 时 wt.exe -d <目录> claude；
// 否则 cmd.exe /c start "<标题>" /D <目录> cmd.exe /k claude。参数用数组；目录必须是绝对路径且不含引号。
export function claudeLaunch({ dir, name, wt }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || /["\r\n]/.test(dir)) throw new Error('Invalid path');
  if (wt) return { executable: wt, args: ['-d', dir, 'claude'] };
  return { executable: 'cmd.exe', args: ['/c', 'start', `AgentRouter · ${String(name ?? '').replace(/["\r\n]/g, '')}`, '/D', dir, 'cmd.exe', '/k', 'claude'] };
}

// 任务说明里的"目标"：去掉 front matter 后，取"## 目标"一节的第一段；没有这一节时取第一个非标题段落。折成一行，最长 300 字符。
export function specGoal(text) {
  const body = String(text).replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(line => /^##\s*目标\s*$/.test(line.trim()));
  const scope = start >= 0 ? lines.slice(start + 1) : lines;
  const paragraph = [];
  for (const line of scope) {
    if (/^#{1,6}\s/.test(line)) { if (paragraph.length || start >= 0) break; continue; }
    if (!line.trim()) { if (paragraph.length) break; continue; }
    paragraph.push(line.trim());
  }
  const goal = paragraph.join(' ').replace(/\s+/g, ' ');
  return goal ? Array.from(goal).slice(0, 300).join('') : null;
}

// 一项占用的字节数：目录递归累加，不跟随符号链接；读不到的算 0。核心的 ar gc 只给总大小，确认框要逐项显示，所以这里只读地量一遍。
export async function sizeOf(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return 0;
  let info;
  try { info = await lstat(target); } catch { return 0; }
  if (!info.isDirectory()) return info.size;
  let names;
  try { names = await readdir(target); } catch { return 0; }
  return (await Promise.all(names.map(name => sizeOf(path.join(target, name))))).reduce((sum, n) => sum + n, 0);
}

export function createConsole({ coreRun, chooseFolder, messages, testTimeout = 180, openFolder = async () => {}, launch = async () => {}, findWt = async () => null, knownRunDir = () => false }) {
  const invalid = () => { throw new Error(messages.invalid); };
  // 组装参数数组并调用核心，按约定整理结果。
  const run = async (args, { input, timeoutMs, cwd, conflict = false } = {}) => {
    let result;
    try { result = await coreRun(args, { input, timeoutMs, cwd }); }
    catch (error) { throw new Error(messages.failed(error instanceof Error ? error.message : String(error))); }
    const { json, timedOut } = result;
    // coreRun 超时会结束子进程并标出 timedOut（这时 json 是兜底的 { ok:false }，不能当作核心的错误显示）。
    if (timedOut) throw new Error(messages.timeout(Math.round(timeoutMs / 1000)));
    if (json && json.ok === true) { const { lines, ...rest } = json; return rest; }
    // 合并冲突（ar accept 退出码 4，json 为 { ok:false, conflict:true, files }）不是错误：原样交给界面显示冲突。
    if (conflict && json && json.ok === false && json.conflict === true) return { conflict: true, files: Array.isArray(json.files) ? json.files.filter(f => typeof f === 'string') : [] };
    if (json && json.ok === false) {
      const error = new Error(json.error || messages.noResult);
      // 核心的错误码（如 NEED_GIT_IDENTITY）原样带给渲染层，界面据此显示对应的指引。
      if (typeof json.code === 'string' && json.code) error.code = json.code;
      throw error;
    }
    throw new Error(messages.noResult);
  };
  // "已登记项目"的判断：调用一次 projects list --registry-only（只读登记表，不对每个项目跑 git），
  // 路径按 Windows 不区分大小写匹配；不在列表里抛 unknownProject。语义与原来调用完整 projects list 相同。
  const registeredProject = async project => {
    const { projects } = await run(['projects', 'list', '--registry-only'], { timeoutMs: 60000 });
    if (!Array.isArray(projects) || !projects.some(p => typeof p?.path === 'string' && samePath(p.path, project))) throw new Error(messages.unknownProject);
  };
  const oneName = p => { if (!validName(p?.name)) invalid(); return p.name; };
  // 提交身份：校验规则与核心一致（用户名非空、单行、≤100 字符；邮箱含 @、没有空白与换行、≤200 字符）。
  const identityInput = (name, email) => {
    const user = typeof name === 'string' ? name.trim() : '';
    if (!user || user.length > 100 || /[\r\n]/.test(user)) invalid();
    const mail = typeof email === 'string' ? email.trim() : '';
    if (!mail || mail.length > 200 || !mail.includes('@') || /\s/.test(mail)) invalid();
    return { name: user, email: mail };
  };
  const actions = {
    async 'agents:list'(p) {
      const args = ['agents', 'list'];
      if (p?.detect === true) args.push('--detect');
      return run(args, { timeoutMs: 60000 });
    },
    async 'agents:presets'() { return run(['agents', 'presets'], { timeoutMs: 60000 }); },
    async 'agents:add'(p) {
      if (!validName(p?.preset)) invalid();
      const args = ['agents', 'add', '--preset', p.preset];
      if (p.name !== undefined) { if (!validName(p.name)) invalid(); args.push('--name', p.name); }
      if (p.label !== undefined) { if (!validSingle(p.label)) invalid(); args.push('--label', p.label); }
      if (p.model !== undefined) { if (!validSingle(p.model)) invalid(); args.push('--model', p.model); }
      if (p.baseUrl !== undefined) { if (!validSingle(p.baseUrl)) invalid(); args.push('--base-url', p.baseUrl); }
      if (p.secretVar !== undefined) { if (!validVarName(p.secretVar)) invalid(); args.push('--secret-var', p.secretVar); }
      if (p.auth !== undefined) { if (!AUTH.includes(p.auth)) invalid(); args.push('--auth', p.auth); }
      return run(args, { timeoutMs: 60000 });
    },
    async 'agents:update'(p) {
      if (!validName(p?.name)) invalid();
      if (!['label', 'model', 'baseUrl', 'secretVar', 'maxTurns'].some(k => p[k] !== undefined)) invalid();
      const args = ['agents', 'update', p.name];
      if (p.label !== undefined) { if (!validSingle(p.label)) invalid(); args.push('--label', p.label); }
      if (p.model !== undefined) { if (!validSingle(p.model)) invalid(); args.push('--model', p.model); }
      if (p.baseUrl !== undefined) { if (!validSingle(p.baseUrl)) invalid(); args.push('--base-url', p.baseUrl); }
      if (p.secretVar !== undefined) { if (!validVarName(p.secretVar)) invalid(); args.push('--secret-var', p.secretVar); }
      if (p.maxTurns !== undefined) {
        if (p.maxTurns !== null && !(Number.isInteger(p.maxTurns) && p.maxTurns > 0)) invalid();
        args.push('--max-turns', p.maxTurns === null ? '-' : String(p.maxTurns));
      }
      return run(args, { timeoutMs: 60000 });
    },
    async 'agents:remove'(p) { return run(['agents', 'remove', oneName(p)], { timeoutMs: 60000 }); },
    async 'agents:enable'(p) { return run(['agents', 'enable', oneName(p)], { timeoutMs: 60000 }); },
    async 'agents:disable'(p) { return run(['agents', 'disable', oneName(p)], { timeoutMs: 60000 }); },
    async 'agents:default'(p) { return run(['agents', 'default', oneName(p)], { timeoutMs: 60000 }); },
    async 'agents:test'(p) { return run(['agents', 'test', oneName(p), '--timeout', String(testTimeout)], { timeoutMs: (testTimeout + 20) * 1000 }); },
    async 'secrets:status'(p) {
      const names = p?.names ?? [];
      if (!Array.isArray(names) || names.some(n => !validVarName(n))) invalid();
      return run(['secrets', 'status', ...names], { timeoutMs: 60000 });
    },
    async 'secrets:set'(p) {
      if (!validVarName(p?.name)) invalid();
      if (typeof p?.value !== 'string' || !p.value || p.value.length > 4096 || /[\r\n]/.test(p.value)) invalid();
      // 值只经 input 传入，不进参数数组，也不出现在任何错误信息里。
      return run(['secrets', 'set', p.name], { input: p.value, timeoutMs: 60000 });
    },
    async 'projects:list'() { return run(['projects', 'list'], { timeoutMs: 60000 }); },
    // 清空项目登记表（018）：只清登记表，不碰项目文件夹；不需要先核对已登记项目。
    async 'projects:clear'() { return run(['projects', 'clear'], { timeoutMs: 60000 }); },
    async 'projects:choose'() { return chooseFolder(); },
    async 'projects:add'(p) { if (!validAbsPath(p?.path)) invalid(); return run(['projects', 'add', p.path, '--allow-non-git'], { timeoutMs: 60000 }); },
    async 'projects:remove'(p) { if (!validAbsPath(p?.path)) invalid(); await registeredProject(p.path); return run(['projects', 'remove', p.path], { timeoutMs: 60000 }); },
    async 'projects:show'(p) {
      if (!validAbsPath(p?.path)) invalid();
      await registeredProject(p.path);
      // 验收钩子：先等再调用核心（平时为 0，不等待）。
      if (PROJECTS_SHOW_DELAY_MS) await new Promise(resolve => setTimeout(resolve, PROJECTS_SHOW_DELAY_MS));
      return run(['projects', 'show', p.path], { timeoutMs: 60000 });
    },
    async 'projects:git-init'(p) { if (!validAbsPath(p?.path)) invalid(); await registeredProject(p.path); return run(['projects', 'git-init', p.path], { timeoutMs: 60000 }); },
    async 'projects:commit-init'(p) { if (!validAbsPath(p?.path)) invalid(); await registeredProject(p.path); return run(['projects', 'commit-init', p.path], { timeoutMs: 60000 }); },
    async 'projects:git-identity'(p) {
      if (!validAbsPath(p?.path)) invalid();
      const identity = identityInput(p?.name, p?.email);
      if (p.global !== undefined && typeof p.global !== 'boolean') invalid();
      const args = ['projects', 'git-identity', p.path, '--name', identity.name, '--email', identity.email];
      if (p.global === true) args.push('--global');
      await registeredProject(p.path);
      return run(args, { timeoutMs: 60000 });
    },
    async 'projects:config'(p) {
      if (!validAbsPath(p?.path)) invalid();
      const keys = ['baseBranch', 'setup', 'verify', 'allowedPaths', 'specsDir'];
      const set = p?.set;
      if (set !== undefined && (!set || typeof set !== 'object' || Array.isArray(set))) invalid();
      const args = ['projects', 'config', p.path];
      if (set) {
        for (const key of Object.keys(set)) {
          if (!keys.includes(key)) invalid();
          const value = set[key];
          if (value === undefined) continue;
          if (key === 'setup' || key === 'verify' || key === 'allowedPaths') {
            if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || /[\r\n]/.test(item))) invalid();
            args.push(`${key}=${JSON.stringify(value)}`);
          } else {
            if (!validLine(value)) invalid();
            args.push(`${key}=${value}`);
          }
        }
      }
      await registeredProject(p.path);
      return run(args, { timeoutMs: 60000 });
    },
    async 'projects:init-plan'(p) { if (!validAbsPath(p?.path)) invalid(); await registeredProject(p.path); return run(['init', p.path, '--dry-run'], { timeoutMs: 60000 }); },
    async 'projects:init-apply'(p) { if (!validAbsPath(p?.path)) invalid(); await registeredProject(p.path); return run(['init', p.path], { timeoutMs: 60000 }); },
    async 'specs:list'(p) { if (!validAbsPath(p?.project)) invalid(); await registeredProject(p.project); return run(['spec', 'list', p.project], { timeoutMs: 60000 }); },
    async 'specs:read'(p) { if (!validAbsPath(p?.project) || !validSpecRel(p?.rel)) invalid(); await registeredProject(p.project); return run(['spec', 'read', p.project, p.rel], { timeoutMs: 60000 }); },
    async 'specs:new'(p) {
      if (!validAbsPath(p?.project)) invalid();
      if (!p?.form || typeof p.form !== 'object' || Array.isArray(p.form)) invalid();
      const args = ['spec', 'new', p.project];
      if (p.dryRun === true) args.push('--dry-run');
      if (p.commit === true) args.push('--commit');
      await registeredProject(p.project);
      return run(args, { input: JSON.stringify(p.form), timeoutMs: 60000 });
    },
    // 补好提交身份后，把上次已写好但没提交的任务说明补提交（新建任务页在派发前调用）。
    async 'specs:commit'(p) {
      if (!validAbsPath(p?.project) || !validSpecRel(p?.rel)) invalid();
      await registeredProject(p.project);
      return run(['spec', 'commit', p.project, p.rel], { timeoutMs: 60000 });
    },
    // 打开文件夹 / 在此项目打开 Claude Code：只接受已登记的项目；启动交给注入的函数（验收时是记录参数的桩）。
    async 'shell:open-folder'(p) { if (!validAbsPath(p?.path)) invalid(); await registeredProject(p.path); await openFolder(p.path); return { ok: true }; },
    async 'shell:open-claude'(p) {
      if (!validAbsPath(p?.path) || /"/.test(p.path)) invalid();
      await registeredProject(p.path);
      const command = claudeLaunch({ dir: p.path, name: path.basename(p.path), wt: await findWt() });
      await launch(command.executable, command.args, { cwd: p.path });
      return { ok: true, executable: path.basename(command.executable) };
    },
    async 'tasks:dispatch'(p) {
      if (!validAbsPath(p?.project)) invalid();
      const source = p?.source, target = source === 'spec' ? p?.spec : source === 'text' ? p?.text : undefined;
      if (source === 'spec') { if (!validSpecRel(p?.spec)) invalid(); }
      else if (source === 'text') { if (typeof p?.text !== 'string' || !p.text || p.text.length > 20000) invalid(); }
      else invalid();
      const args = ['dispatch', target];
      // profile 可省略（自动）；给了就必须是非空、不含空白与换行的字符串（核心再校验它是否存在）。
      if (p.profile !== undefined) { if (typeof p.profile !== 'string' || !p.profile || /[\r\n\s]/.test(p.profile)) invalid(); args.push('--profile', p.profile); }
      // 软件发起的派发都记为 AgentRouter（软件）；托管任务保持请求里原来的派活方，不走这里。
      args.push('--host', 'agentrouter');
      args.push('--detach');
      await registeredProject(p.project);
      return run(args, { timeoutMs: 60000, cwd: p.project });
    },
    // 再派一次：按记录目录里的 dispatch.json 用同样的参数重新派发（脱离软件进程）。
    // 看板任务的仓库不在项目列表里时不做隐式登记，直接报 unknownProject，由用户先到项目页添加。
    async 'tasks:redispatch'(p) {
      if (!validAbsPath(p?.project)) invalid();
      if (!validRecord(p?.name)) invalid();
      await registeredProject(p.project);
      // 软件发起的再派一次同样记为 AgentRouter（软件）。
      return run(['redispatch', p.name, '--host', 'agentrouter', '--detach'], { timeoutMs: 60000, cwd: p.project });
    },
    // 重试（协议 14.3）：在同一工作区、同一记录里新开一次尝试。profile 省略 = 沿用原执行者；note 可选
    // （已完成的任务核心要求必填，没写时核心报错，原因原样交给界面）。写法与 tasks:redispatch 相同：参数数组、脱离、60 秒。
    async 'tasks:retry'(p) {
      if (!validAbsPath(p?.project)) invalid();
      if (!validRecord(p?.name)) invalid();
      const args = ['retry', p.name, '--host', 'agentrouter', '--detach'];
      if (p.profile !== undefined) { if (typeof p.profile !== 'string' || !p.profile || /[\r\n\s]/.test(p.profile)) invalid(); args.push('--profile', p.profile); }
      if (p.note !== undefined) {
        if (typeof p.note !== 'string' || p.note.length > 20000) invalid();
        if (p.note.trim()) args.push('--note', p.note.trim());
      }
      await registeredProject(p.project);
      return run(args, { timeoutMs: 60000, cwd: p.project });
    },
    // 批准并合并（协议 15.6）：在项目根运行 ar accept，软件发起记为 human；合并方式由核心按项目配置的 mergeMode 决定。
    // 成功返回 { merge, mode, cleanup }；冲突（退出码 4）返回 { conflict: true, files }；检查不通过时核心的中文原因作为错误抛出。合并大仓库可能较慢，超时 120 秒。
    async 'tasks:accept'(p) {
      if (!validAbsPath(p?.project)) invalid();
      if (!validRecord(p?.name)) invalid();
      await registeredProject(p.project);
      return run(['accept', p.name, '--by', 'human'], { timeoutMs: 120000, cwd: p.project, conflict: true });
    },
    // 驳回（协议 15.7）：原因必填（空白不算）；keepBranch 为 true 时保留分支。
    async 'tasks:reject'(p) {
      if (!validAbsPath(p?.project)) invalid();
      if (!validRecord(p?.name)) invalid();
      if (typeof p.reason !== 'string' || !p.reason.trim() || p.reason.length > 2000) invalid();
      if (p.keepBranch !== undefined && typeof p.keepBranch !== 'boolean') invalid();
      const args = ['reject', p.name, '--reason', p.reason.trim()];
      if (p.keepBranch === true) args.push('--keep-branch');
      args.push('--by', 'human');
      await registeredProject(p.project);
      return run(args, { timeoutMs: 60000, cwd: p.project });
    },
    // 任务改动（协议 15.9）：只读，每个文件的 patch 最多 200 KB、整体最多 2 MB，超时 60 秒。
    async 'tasks:diff'(p) {
      if (!validAbsPath(p?.project)) invalid();
      if (!validRecord(p?.name)) invalid();
      await registeredProject(p.project);
      return run(['diff', p.name], { timeoutMs: 60000, cwd: p.project });
    },
    // 链路报告（协议 16.1）：只读，分数全由核心算；任务还在进行或不是用任务说明派发的，核心拒绝，原因原样交给界面。
    async 'tasks:report'(p) {
      if (!validAbsPath(p?.project)) invalid();
      if (!validRecord(p?.name)) invalid();
      await registeredProject(p.project);
      return run(['report', p.name, '--json'], { timeoutMs: 60000, cwd: p.project });
    },
    // 门禁失败归因（协议 16.4）：第 n 次尝试的归因改成任务说明（spec）或执行者（worker），核心写 marks.json 并返回重算后的报告。
    async 'tasks:blame'(p) {
      if (!validAbsPath(p?.project)) invalid();
      if (!validRecord(p?.name)) invalid();
      if (!Number.isSafeInteger(p?.n) || p.n < 1 || p.n > 999) invalid();
      if (p.who !== 'spec' && p.who !== 'worker') invalid();
      await registeredProject(p.project);
      return run(['report', p.name, '--blame', `${p.n}=${p.who}`, '--json'], { timeoutMs: 60000, cwd: p.project });
    },
    // 冲突后继续（协议 15.8）：在原 worktree 里合并主分支，没有冲突就重新跑门禁，有冲突就让执行者解决；脱离派发，写法同 tasks:retry。
    async 'tasks:rebase'(p) {
      if (!validAbsPath(p?.project)) invalid();
      if (!validRecord(p?.name)) invalid();
      await registeredProject(p.project);
      return run(['retry', p.name, '--rebase', '--host', 'agentrouter', '--detach'], { timeoutMs: 60000, cwd: p.project });
    },
    // 验收页概览用的任务说明摘要：派发参数里的允许改动与验收命令（dispatch.json 的 gate.merged），以及任务说明里"目标"的第一段。
    // 只读文件，不调用核心；dir 必须是已读到的任务的记录目录，任务说明路径必须在项目里。读不到的项为 null。
    async 'tasks:overview'(p) {
      if (!validAbsPath(p?.dir) || p.dir.split(/[\\/]/).includes('..') || path.basename(path.dirname(p.dir)) !== '.agent-runs') invalid();
      if (!(await knownRunDir(p.dir))) invalid();
      const missing = error => { if (error?.code !== 'ENOENT') throw error; return null; };
      const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null;
      let allowed = null, verify = null;
      const dispatchText = await readFile(path.join(p.dir, 'dispatch.json'), 'utf8').catch(missing);
      if (dispatchText !== null) {
        try { const merged = parseJson(dispatchText)?.gate?.merged; allowed = strings(merged?.allowed_paths); verify = strings(merged?.verify); } catch { /* 读不出来就没有。 */ }
      }
      let goal = null;
      if (p.spec !== undefined && p.spec !== null) {
        if (!validAbsPath(p.repo) || !validSpecRel(p.spec)) invalid();
        const file = path.resolve(p.repo, p.spec), relative = path.relative(path.resolve(p.repo), file);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) invalid();
        const text = await readFile(file, 'utf8').catch(missing);
        if (text !== null) goal = specGoal(text);
      }
      return { allowed, verify, goal };
    },
    // 清理（ar gc）：check 是 ar gc --dry-run（只列出，不删），run 是 ar gc（真正删除）；都只作用于公共目录与 worktree 根，超时 120 秒。
    // check 的每一项多带一个 size（字节，量一遍目录得到），给确认框逐项显示。
    async 'gc:check'() {
      const result = await run(['gc', '--dry-run'], { timeoutMs: 120000 });
      const sized = async (items, key) => Promise.all((Array.isArray(items) ? items : []).map(async item => ({ ...item, size: await sizeOf(item?.[key]) })));
      return { ...result, worktrees: await sized(result.worktrees, 'dir'), slots: await sized(result.slots, 'file'), sessions: await sized(result.sessions, 'dir') };
    },
    async 'gc:run'() { return run(['gc'], { timeoutMs: 120000 }); },
    // 某一次尝试的汇报与门禁（attempts/<n>/report.md、gate.json，协议 14.2 第 3 条）：只读文件，不调用核心。
    // dir 是任务记录目录（<项目>/.agent-runs/<记录名>），n 是尝试序号；没有 attempts/ 目录（旧任务）时 exists 为 false。
    // dir 还必须是主进程已读到的某个任务的记录目录（knownRunDir，由 index.ts 从 Registry 注入）；不在清单里不读任何文件。
    async 'tasks:attempt-files'(p) {
      const n = p?.n;
      if (!validAbsPath(p?.dir) || p.dir.split(/[\\/]/).includes('..') || path.basename(path.dirname(p.dir)) !== '.agent-runs') invalid();
      if (!Number.isSafeInteger(n) || n < 1 || n > 999) invalid();
      if (!(await knownRunDir(p.dir))) invalid();
      const missing = error => { if (error?.code !== 'ENOENT') throw error; return null; };
      const attempts = await stat(path.join(p.dir, 'attempts')).catch(missing);
      if (!attempts?.isDirectory()) return { exists: false, report: '', gate: null };
      const folder = path.join(p.dir, 'attempts', String(n));
      const report = await readFile(path.join(folder, 'report.md'), 'utf8').catch(missing);
      const gateText = await readFile(path.join(folder, 'gate.json'), 'utf8').catch(missing);
      let gate = null;
      if (gateText !== null) {
        try {
          const parsed = parseJson(gateText);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('内容不是对象');
          gate = parsed;
        } catch (error) { gate = { error: error instanceof Error ? error.message : String(error) }; }
      }
      return { exists: true, report: report ?? '', gate };
    },
  };
  return {
    async call(action, payload) {
      if (!Object.hasOwn(actions, action)) throw new Error('Invalid console action');
      if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) throw new Error(messages.invalid);
      return actions[action](payload ?? {});
    },
  };
}
