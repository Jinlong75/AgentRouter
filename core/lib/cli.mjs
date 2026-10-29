// ar 子命令：dispatch · redispatch · retry · wait · stop · accept · reject · push · pull · revert · diff · status · overlaps · report · gc · config · agents · secrets · version（init/projects 见 project.mjs，agents/secrets 见 agents.mjs，accept/reject 见 accept.mjs，diff 见 diff.mjs，status 见 status.mjs，report 见 report.mjs，gc 见 gc.mjs）。
// 所有面向软件的命令支持 --json：标准输出只有一个 JSON 对象；出错时 { ok:false, error } 且退出码非 0。
import { trace, tracing } from './trace.mjs';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { run, readProjectConfig } from './run.mjs';
import { route, routeConfigCommand } from './router.mjs';
import { rolesCommand } from './roles.mjs';
import { reviewCommand } from './review.mjs';
import { parseSpec, validateSpec, SPEC_TYPES } from './spec.mjs';
import { adapters } from '../adapters/index.mjs';
import { homeDirectory, legacyHomeDirectory, homeEnv, unsafeHome } from './compat.mjs';
import { configCommand, readConfig, readEffectiveConfig } from './config.mjs';
import { waitForTask, locateStart, findTerminal, reverseRows } from './wait.mjs';
import { readNeedsScope } from './needs-scope.mjs';
import { readOutsideWrites } from './outside-writes.mjs';
import { stopTask } from './stop.mjs';
import { accept, reject } from './accept.mjs';
import { revertMerge } from './revert.mjs';
import { BYS, pullBranch, pullLines, pushBranch, pushLines } from './push.mjs';
import { diffTask } from './diff.mjs';
import { buildReport, reportLines, setBlame } from './report.mjs';
import { gc, gcLines } from './gc.mjs';
import { statusLines, taskStatus } from './status.mjs';
import { overlapGroups } from './schedule.mjs';
import { agentsCommand, secretsCommand, listAgents } from './agents.mjs';
import { unsetUserSecret } from './secrets.mjs';
import { initCommand, projectsCommand } from './project.mjs';
import { specCommand, readSpecForm } from './spec-new.mjs';
import { readDispatch, optionArgs } from './records.mjs';
import { readJson } from './json.mjs';
import { withProxy } from './env.mjs';
import { proxyText, readSystemProxy, resolveProxy } from './proxy.mjs';

export const commands = ['dispatch', 'redispatch', 'retry', 'wait', 'stop', 'accept', 'reject', 'push', 'pull', 'revert', 'diff', 'status', 'overlaps', 'report', 'gc', 'config', 'init', 'projects', 'agents', 'secrets', 'spec', 'route', 'roles', 'review', 'proxy', 'version', 'help', '--run-request'];
const helpWords = ['help', '--help', '-h'];
export { listAgents };
const legacy = { '--wait': 'wait', '--stop': 'stop', '--config': 'config' };
export const usage = [
  '用法：ar <子命令> [参数]（加 --json 时只输出一个 JSON 对象，供软件调用）',
  '',
  '【派发与查看】',
  '  ar dispatch <任务说明 | "任务文字"> [补充说明] [--profile <名>] [--role <角色>|none] [--name <记录名>]',
  '      [--host claude-code|agentrouter] [--sandbox …] [--watch-window …] [--detach]',
  '      [--model <模型>] [--effort <级别>] [--tier <档位>] [--base <分支>] [--no-worktree]',
  '      派发一个任务给执行者',
  '  ar redispatch <记录名> [--detach] [--host claude-code|agentrouter]',
  '      按记录里保存的参数再派发一次，记录名自动去重',
  '  ar retry <记录名> [--profile <名>] [--note "<补充说明>"] [--rebase] [--detach]',
  '      [--host claude-code|agentrouter]',
  '      同一工作区手动重试下一次尝试（协议 14.3）；--rebase 用于合并冲突、门禁失败或已中断的 worktree 任务：',
  '      在原 worktree 合并主分支后重跑门禁（协议 15.8）',
  '  ar wait [记录名]',
  '      等任务结束并输出结果',
  '  ar stop <记录名>',
  '      停止任务',
  '  ar status <记录名>',
  '      任务当前状态，不等待（协议 15.11）',
  '  ar report <记录名> [--blame <n>=spec|worker|environment]',
  '      任务结束后的链路报告与评分；--blame 把第 n 次门禁失败归因到任务说明、执行者或环境（协议第 16 节）',
  '  ar overlaps [--project <路径>]',
  '      同项目里改动范围互相重叠的待验收任务分组与建议的批准顺序，只读',
  '  ar gc [--dry-run]',
  '      清理孤立的 worktree、并发名额与过期的执行者会话记录（协议 15.10）',
  '',
  '【验收与 git】',
  '  ar accept <记录名> [--squash] [--push|--no-push] [--by human]',
  '      验收 worktree 任务并合并（协议 15.6～15.9）；--push 合并后接着推送主分支',
  '  ar reject <记录名> --reason "<原因>" [--keep-branch] [--by human]',
  '      驳回 worktree 任务',
  '  ar diff <记录名>',
  '      看 worktree 任务的改动',
  '  ar revert <记录名> [--by human]',
  '      撤销已合并任务的合并：git revert，只追加一个反向提交，不改历史、不推送',
  '  ar push <项目路径> [--by human|lead|cli] [--dry-run] [--no-fetch]',
  '      把主分支普通推送到项目配置的远程，不强制、不推标签；--dry-run 只报告领先落后',
  '  ar pull <项目路径> [--by human|lead|cli]',
  '      只快进，分叉时不拉取',
  '',
  '【执行者与路由】',
  '  ar agents list [--detect] | presets | default <名> | remove <名> | enable <名> | disable <名>',
  '      查看、设默认、删除、启用、停用执行者',
  '  ar agents add --preset <预设> [--name <名>] [--label …] [--model …] [--effort …] [--base-url …]',
  '      [--secret-var …] [--auth login|token]',
  '  ar agents add --generic <声明JSON> --name <名> [--label …]',
  '      添加执行者（预设或自定义命令行声明）',
  '  ar agents update <名> […|--effort <级别>|""|--max-turns <正整数>|-|--escalate <名>|""]',
  '      修改执行者的设置',
  '  ar agents test <名> [--timeout <秒>]',
  '      试运行一次执行者',
  '  ar agents models <名> [--probe]',
  '      可选的模型',
  '  ar agents models --preset <预设> [--base-url …] [--secret-var …] [--auth login|token] [--model …]',
  '      导入之前查（按导入后会得到的配置，不读不写已有的执行者）；可加 --probe',
  '  ar agents validate <文件> | export <名> [--out <文件>] [--force] | import <文件> [--name <名>] [--force]',
  '      校验、导出、导入执行者声明（单独的声明导入时必须加 --name）；validate 只读',
  '  ar agents validate --decl <声明JSON> | detect --decl <声明JSON> | test --decl <声明JSON> [--timeout <秒>]',
  '      只用声明，不读不写配置；软件的自定义 CLI 表单用',
  '  ar secrets status [变量名 …] | set <变量名> | unset <变量名>',
  '      密钥环境变量：set 的值从标准输入读入，不回显；unset 删除 Windows 用户环境变量',
  '  ar route [--spec <任务说明>] [--type <类型>] [--project <路径>] [--profile <名>] [--explain]',
  '      只计算会派给谁和为什么，不派发、不写文件',
  '  ar route config | ar route rules set \'<JSON 数组>\' | ar route fallback set <名>|clear',
  '  ar route strong set <名>|clear | ar route reviewer set \'<JSON>\' | ar route limits clear <名>',
  '  ar route limit set <名> [--tasks <n>|""] [--tokens <n>|""]',
  '      路由配置的读取与写入；limits clear 手动清除限流标记',
  '      reviewer set 的 JSON 可写三个开关：mustDiffer、differFamily、differFromLead',
  '  ar route suggest [--json]',
  '      按你的执行者生成建议规则，只显示不写入',
  '  ar roles [--review-for <执行者名> [--model <模型>]]',
  '  ar roles set <执行者名> [roles=executor,reviewer,lead] [modelFamilies=<家族,…>]',
  '      每个执行者可担任的角色（含主导）与模型家族；审查者的三个约束与主导见 ar roles 输出',
  '  ar roles family set <模型名前缀> <家族> | clear <模型名前缀> | list [--json]',
  '      补充或覆盖模型到家族的对应，存在 config.json 的 familyRules',
  '',
  '【审查】',
  '  ar review <记录名> [--profile <审查者>]',
  '      对待验收的 worktree 任务再审一次，不改任务状态',
  '  ar review confirm <记录名> <问题编号> valid|invalid [--note "<说明>"] [--by human|lead]',
  '      确认审查问题成立与否',
  '  ar review show <记录名> | stats',
  '      看审查结论；stats 是每个审查者的准确率',
  '  ar review config [set [default=true|false] [block=none|high] [maxReworks=<0～5>]]',
  '      全局的审查设置：是否默认审查、是否拦截、最多返工几次',
  '',
  '【项目与任务说明】',
  '  ar init [项目路径] [--dry-run]',
  '  ar init --upgrade [项目路径] [--dry-run] [--replace-role <角色,…>] [--add-field <键,…>]',
  '      初始化或升级项目的 .agent-router 配置',
  '  ar projects list [--registry-only] | add <路径> [--allow-non-git] | remove <路径> | clear | show [路径]',
  '      查看、登记、移除项目',
  '  ar projects purge <路径> [--dry-run] [--worktrees] | config <路径> [键=值 …] | git-init <路径>',
  '  ar projects commit-init <路径> [--with-existing] | changes <路径>',
  '  ar projects git-identity <路径> --name <用户名> --email <邮箱> [--global]',
  '  ar projects commit <路径> [--message <说明> --files <路径…>]',
  '      项目的清理、配置、git 初始化与提交（commit 的表单也可从标准输入读 JSON）',
  '  ar spec list <项目路径> [--include-archived] | read <项目路径> <相对路径>',
  '      列出、读取任务说明',
  '  ar spec archive <项目路径> <相对路径…> [--commit]',
  '      把顶层任务说明 git mv 到 archive/，不删除；已归档的跳过',
  '  ar spec new <项目路径> [--dry-run] [--commit] | commit <项目路径> <相对路径>',
  '      新建任务说明（表单从标准输入读入）、提交任务说明',
  '  ar spec check-paths --project <路径> --paths \'<JSON 字符串数组>\' [--limit <n>]',
  '      允许路径会匹配到哪些现有文件，只读',
  '',
  '【其他】',
  '  ar config [键=值 … | init]',
  '      查看或修改全局配置',
  '  ar proxy resolve',
  '      这一刻的网络代理：config.json 的 proxy 模式、读到的地址与要给执行者设置的变量，只读',
  '  ar version | ar help',
  '      版本号、本帮助',
].join('\n');

// 旧写法转成子命令：ar <任务> → dispatch；--wait/--stop/--config → wait/stop/config。--json 可出现在任意位置。
// 第一个参数长得像子命令（小写字母开头，只含小写字母、数字、连字符）、不是已知子命令、也不是存在的文件时，
// 多半是敲错或不存在的子命令：不派发，command 为 'unknown'，rest 只有这个词。
const commandLike = /^[a-z][a-z0-9-]*$/;
const isFile = (cwd, word) => { try { return statSync(resolvePath(cwd, word)).isFile(); } catch { return false; } };
export function normalizeArgs(argv, cwd = process.cwd()) {
  const json = argv.includes('--json');
  let args = argv.filter(a => a !== '--json');
  // 第一个参数正好是 help / --help / -h 才算帮助（后面的参数不管）；任务文字里含 help 不受影响。
  if (helpWords.includes(args[0])) args = ['help'];
  else if (legacy[args[0]]) args = [legacy[args[0]], ...args.slice(1)];
  else if (!args.length || !commands.includes(args[0])) {
    if (args.length && commandLike.test(args[0]) && !isFile(cwd, args[0])) return { command: 'unknown', rest: [args[0]], json };
    args = ['dispatch', ...args];
  }
  return { command: args[0], rest: args.slice(1), json };
}

export function coreVersion(scriptPath) {
  // 开发：core/../package.json；软件：resources/app/package.json；技能：技能目录/package.json。
  // 安装后的技能没有 package.json，版本在技能目录的安装记录 .agent-router.json 里。
  for (const file of [join(dirname(scriptPath), '..', 'package.json'), join(dirname(scriptPath), '..', '.agent-router.json'), join(dirname(scriptPath), 'package.json')]) {
    try { const version = readJson(file).version; if (typeof version === 'string') return version; } catch { /* 换下一个位置。 */ }
  }
  return 'unknown';
}

function arity(rest, max, text) {
  if (rest.length > max || rest.some(a => !a || a.startsWith('--'))) throw new Error(`用法：${text}`);
}

// accept / reject / diff 的参数：记录名一个（允许中文、空格），其余是开关；flags 里的布尔开关与带值开关由调用方列出。
// --by 只接受 human（协议 15.6）。出错抛出用法文字。
function taskArgs(rest, { booleans = [], values = [] }, usageText) {
  const options = {};
  const names = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (booleans.includes(a)) { options[a] = true; continue; }
    if (values.includes(a)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(usageText);
      options[a] = value;
      continue;
    }
    names.push(a);
  }
  if (names.length !== 1 || !names[0] || names[0].startsWith('--')) throw new Error(usageText);
  if (options['--by'] !== undefined && options['--by'] !== 'human') throw new Error(`--by 只接受 human：${options['--by']}`);
  return { name: names[0], options };
}

// 公共目录保护（协议第 1 节）：只检查显式设置的新名 / 旧名环境变量，默认公共目录不检查。
// 不安全时不读写任何文件、不启动进程：--json 由调用方输出 JSON，否则由 ar.mjs 打到标准错误，退出码 2。
function assertSafeHome(env) {
  if (!homeEnv.some(key => env[key])) return;
  const reason = unsafeHome(homeDirectory(env), { env });
  if (reason) throw Object.assign(new Error(reason), { arCode: 'UNSAFE_HOME' });
}

export async function main(argv, { scriptPath, env = process.env, cwd = process.cwd(), out = console.log, readSecret = readSecretValue, setSecret, unsetSecret = unsetUserSecret, readForm = readSpecForm } = {}) {
  const { command, rest, json } = normalizeArgs(argv, cwd);
  // 不认识的子命令：只提示，不碰任何文件、不派发。
  if (command === 'unknown') {
    const text = `不认识的子命令：${rest[0]}。可用的子命令见 ar help；要把这段文字当任务派发，写成 ar dispatch "${rest[0]}"`;
    if (!json) throw new Error(text);
    out(JSON.stringify({ ok: false, code: 'UNKNOWN_COMMAND', error: text, command: rest[0] }));
    return 2;
  }
  const homes = [homeDirectory(env), legacyHomeDirectory(env)];
  const lines = [];
  // --json 时收集普通输出，最后只打印一个 JSON 对象。
  const log = json ? text => lines.push(...String(text).split('\n')) : out;
  // 追踪：标出写出标准输出的时刻（只在 AR_CORE_TRACE=1 时有输出）。
  if (tracing) { const write = out; out = text => { trace('写出标准输出'); write(text); }; }
  const emit = value => { if (json) out(JSON.stringify(value)); };
  const capture = async action => {
    if (!json) return action();
    const original = console.log;
    console.log = (...parts) => log(parts.join(' '));
    try { return await action(); } finally { console.log = original; }
  };
  // 安排合并后的自动重跑门禁时 run() 会打印"记录名 / 进度"，这些不属于 accept 的输出，吞掉。
  const silenced = async action => {
    const original = console.log;
    console.log = () => {};
    try { return await action(); } finally { console.log = original; }
  };
  // 任务最后一次尝试汇报里的"需要越界"（协议 14.5）：从清单的 end 事件读，托管、前台、脱离派发都走这一条路径；
  // 任务没结束或没有这一节时为 null。
  const scopeOf = name => {
    try {
      const found = locateStart(homes, cwd, name);
      const end = found ? findTerminal(found.file, found.start.id) : null;
      return end?.event === 'end' ? readNeedsScope(end.needsScope) : null;
    } catch { return null; }
  };
  // 最后一次尝试的工作区外新文件（协议 12.4）：读最后一个 attempt-end 的 outsideWrites；只有 added 非空才带。
  const outsideOf = name => {
    try {
      const found = locateStart(homes, cwd, name);
      if (!found) return null;
      for (const row of reverseRows(found.file)) {
        if (row.id !== found.start.id) continue;
        if (row.event === 'attempt-end') {
          const value = readOutsideWrites(row.outsideWrites);
          return value?.added.length ? { added: value.added } : null;
        }
        if (row.event === 'start' || row.event === 'resume') break;
      }
      return null;
    } catch { return null; }
  };
  try {
    // ar version 与用法帮助不碰公共目录，可以不检查（任务 047）。
    if (command !== 'version' && command !== 'help') assertSafeHome(env);
    switch (command) {
      case 'help': {
        if (json) emit({ ok: true, usage }); else out(usage);
        return 0;
      }
      case 'dispatch': case 'redispatch': case '--run-request': {
        let detach = null, gate = null, inheritRoute = null;
        let runArgs;
        if (command === 'redispatch') {
          // 记录名允许中文、空格等，所以只校验个数与开关，不套用 dispatch 的记录名校验。
          // 可选 --host：给了就覆盖派活方（由 parseArgs 校验取值），不给时沿用原来的环境判断。
          const detachFlag = rest.includes('--detach');
          const names = [];
          let host = null;
          for (let i = 0; i < rest.length; i++) {
            const a = rest[i];
            if (a === '--detach') continue;
            if (a === '--host') {
              host = rest[++i];
              if (!host || host.startsWith('--')) throw new Error('用法：ar redispatch <记录名> [--detach] [--host <派活方>]');
              continue;
            }
            names.push(a);
          }
          if (names.length !== 1 || !names[0] || names[0].startsWith('--')) throw new Error('用法：ar redispatch <记录名> [--detach] [--host <派活方>]');
          const saved = readDispatch(cwd, names[0]);
          if (!saved) throw new Error('这个任务是旧版本派发的，没有保存派发参数，不能再派一次');
          inheritRoute = saved.route ?? null;
          runArgs = [saved.task, ...(saved.extra ? [saved.extra] : []), '--name', saved.name, '--profile', saved.profile,
            ...(saved.role && !saved.roleDefault ? ['--role', saved.role] : []), ...optionArgs(saved.options), ...(typeof saved.baseBranch === 'string' && saved.baseBranch ? ['--base', saved.baseBranch] : []), ...(saved.noWorktree ? ['--no-worktree'] : []), ...(detachFlag ? ['--detach'] : []), ...(host ? ['--host', host] : [])];
        } else runArgs = command === 'dispatch' ? rest : ['--run-request', ...rest];
        const code = await capture(() => run({ scriptPath, env, root: cwd, args: runArgs, inheritRoute, onDetach: id => { detach = id; }, onGate: value => { gate = value; } }));
        const name = lines.find(l => l.startsWith('记录名：'))?.slice(4), progress = lines.find(l => l.startsWith('进度：'))?.slice(3);
        const needsScope = json && name && !detach ? scopeOf(name) : null;
        const outsideWrites = json && name && !detach ? outsideOf(name) : null;
        emit({ ok: code === 0, exit: code, name: name ?? null, progress: progress ?? null, ...(detach ? { id: detach, detached: true } : {}), ...(gate ? { gate } : {}), ...(needsScope ? { needsScope } : {}), ...(outsideWrites ? { outsideWrites } : {}), lines, ...(code === 0 ? {} : { error: lines.findLast(l => l.startsWith('出错：'))?.slice(3) ?? lines.at(-1) ?? '派发失败' }) });
        return code;
      }
      case 'retry': {
        // 手动重试（协议 14.3，任务 059）：记录名允许中文、空格等（同 redispatch），只校验个数与开关取值。
        const usageText = '用法：ar retry <记录名> [--profile <名>] [--note "<补充说明>"] [--rebase] [--detach] [--host claude-code|agentrouter]';
        let profile = null, note = null, host = null;
        const names = [];
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i];
          if (a === '--detach' || a === '--rebase') continue;
          if (a === '--profile' || a === '--note' || a === '--host') {
            const value = rest[++i];
            if (value === undefined || value.startsWith('--')) throw new Error(usageText);
            if (a === '--profile') profile = value; else if (a === '--note') note = value; else host = value;
            continue;
          }
          names.push(a);
        }
        if (names.length !== 1 || !names[0] || names[0].startsWith('--')) throw new Error(usageText);
        // 派活方取值同 dispatch：claude-code（技能 / 会话）、agentrouter（监控软件），其他值报错。
        if (host && !['claude-code', 'agentrouter'].includes(host)) throw new Error(`无效的派活方：${host}`);
        let retried = null, detached = null, gate = null;
        const code = await capture(() => run({ scriptPath, env, root: cwd, retry: { name: names[0], profile, note, detach: rest.includes('--detach'), host, rebase: rest.includes('--rebase') },
          onRetry: value => { retried = value; }, onDetach: id => { detached = id; }, onGate: value => { gate = value; } }));
        const recordName = lines.find(l => l.startsWith('记录名：'))?.slice(4) ?? null;
        const progress = lines.find(l => l.startsWith('进度：'))?.slice(3) ?? null;
        const needsScope = json && recordName && !detached ? scopeOf(recordName) : null;
        const outsideWrites = json && recordName && !detached ? outsideOf(recordName) : null;
        emit({ ok: code === 0, exit: code, id: retried?.id ?? detached ?? null, name: recordName, n: retried?.n ?? null, progress,
          ...(detached ? { detached: true } : {}), ...(gate ? { gate } : {}), ...(needsScope ? { needsScope } : {}), ...(outsideWrites ? { outsideWrites } : {}), lines,
          ...(code === 0 ? {} : { error: lines.findLast(l => l.startsWith('出错：'))?.slice(3) ?? lines.at(-1) ?? '重试失败' }) });
        return code;
      }
      // worktree 任务的验收合并、驳回与改动（协议 15.6～15.9）。记录名允许中文、空格等。
      case 'accept': {
        const acceptUsage = '用法：ar accept <记录名> [--squash] [--push|--no-push] [--by human] [--json]';
        const { name, options } = taskArgs(rest, { booleans: ['--squash', '--push', '--no-push'], values: ['--by'] }, acceptUsage);
        if (options['--push'] && options['--no-push']) throw new Error(acceptUsage);
        const result = accept({ homes, root: cwd, name, squash: options['--squash'] === true, push: options['--push'] ? true : options['--no-push'] ? false : null, by: options['--by'] ?? null, env });
        if (result.conflict) {
          if (json) emit({ ok: false, conflict: true, files: result.files });
          else {
            out(`合并冲突：${result.files.join('、')}`);
            out(`主分支已恢复原样。在原 worktree 里合并主分支并解决冲突：ar retry ${name} --rebase`);
          }
          return 4;
        }
        // 合并后与它改动范围重叠、仍待验收的任务：脱离进程自动按新基线重跑门禁（Stage07c 154，D86），accept 不等它们，也不受它们影响。
        const rebased = [], failed = [];
        for (const target of result.rerun?.targets ?? []) {
          try {
            await silenced(() => run({ scriptPath, env, root: cwd, retry: { name: target.name, rebase: true, detach: true, host: null, afterMerge: result.rerun.after } }));
            rebased.push(target);
          } catch (error) { failed.push({ ...target, error: error.message }); }
        }
        if (json) emit({ ok: true, merge: result.merge, mode: result.mode, cleanup: result.cleanup, ...(result.push ? { push: result.push } : {}), ...(rebased.length ? { rebased: rebased.map(item => item.id) } : {}) });
        else {
          if (result.mode === 'confirm') out(`已确认：${name}（没有改动，worktree 已删除）`);
          else out(`已合并：${name}（${result.mode === 'squash' ? '压成一个提交' : '合并提交'} ${result.merge.slice(0, 7)}）`);
          if (!result.cleanup) out('worktree 或分支没能清理干净，合并结果不受影响；稍后用 ar gc 清理');
          if (result.push?.skipped) out(`已合并，没有推送：${result.push.reason}`);
          else if (result.push) out(result.push.ok ? (result.push.pushed === false ? '没有需要推送的提交' : '已推送到远程') : `已合并，推送失败：${result.push.error}（合并结果不受影响，可以稍后用 ar push 重试）`);
          if (rebased.length) out(`已安排重跑门禁：${rebased.map(item => item.name).join('、')}（与 ${name} 的改动范围重叠，按合并后的新基线重跑，不启动执行者）`);
          for (const item of failed) out(`没能安排重跑门禁：${item.name}（${item.error}）`);
        }
        return 0;
      }
      // 推送与快进拉取（Stage07b 128）：项目路径一个，其余是开关。预期内的失败（落后、没有凭据等）带 code，退出码 2。
      case 'push': case 'pull': {
        const isPush = command === 'push';
        const usageText = isPush ? '用法：ar push <项目路径> [--by human|lead|cli] [--dry-run] [--no-fetch] [--json]' : '用法：ar pull <项目路径> [--by human|lead|cli] [--json]';
        let by = null;
        const paths = [];
        const flags = new Set();
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i];
          if (a === '--by') {
            by = rest[++i];
            if (by === undefined || !BYS.includes(by)) throw new Error(usageText);
          } else if (isPush && (a === '--dry-run' || a === '--no-fetch')) flags.add(a);
          else if (a.startsWith('--')) throw new Error(usageText);
          else paths.push(a);
        }
        if (paths.length !== 1 || !paths[0]) throw new Error(usageText);
        const root = resolvePath(cwd, paths[0]);
        const result = isPush
          ? pushBranch({ root, home: homes[0], by, dryRun: flags.has('--dry-run'), noFetch: flags.has('--no-fetch'), env })
          : pullBranch({ root, home: homes[0], by, env });
        if (!result.ok) {
          if (json) { emit(result); return 2; }
          throw new Error(result.error);
        }
        if (json) emit(result); else for (const line of isPush ? pushLines(result) : pullLines(result)) out(line);
        return 0;
      }
      case 'reject': {
        const { name, options } = taskArgs(rest, { booleans: ['--keep-branch'], values: ['--reason', '--by'] }, '用法：ar reject <记录名> --reason "<原因>" [--keep-branch] [--by human] [--json]');
        const result = reject({ homes, root: cwd, name, reason: options['--reason'], keepBranch: options['--keep-branch'] === true, by: options['--by'] ?? null, env });
        if (json) emit({ ok: true, keptBranch: result.keptBranch, cleanup: result.cleanup });
        else {
          out(`已驳回：${name}${result.keptBranch ? '（保留分支）' : ''}`);
          if (!result.cleanup) out('worktree 或分支没能清理干净；稍后用 ar gc 清理');
        }
        return 0;
      }
      // 撤销合并（Stage07b 129）：冲突时退出码 4，主分支恢复原样。
      case 'revert': {
        const { name, options } = taskArgs(rest, { values: ['--by'] }, '用法：ar revert <记录名> [--by human] [--json]');
        const result = revertMerge({ homes, root: cwd, name, by: options['--by'] ?? null, env });
        if (result.conflict) {
          if (json) emit({ ok: false, conflict: true, files: result.files });
          else {
            out(`撤销冲突：${result.files.join('、')}`);
            out('已放弃这次撤销，主分支没有变化。需要在终端里手动处理（git revert，解决冲突后提交）');
          }
          return 4;
        }
        if (json) emit({ ok: true, commit: result.commit.slice(0, 7) });
        else out(`已撤销：${name}（反向提交 ${result.commit.slice(0, 7)}）`);
        return 0;
      }
      case 'diff': {
        const { name } = taskArgs(rest, {}, '用法：ar diff <记录名> [--json]');
        const result = diffTask({ homes, root: cwd, name });
        if (json) { emit(result); return result.ok ? 0 : 2; }
        if (!result.ok) throw new Error(result.error);
        for (const item of result.files) out(`${item.status}\t${item.oldPath ? `${item.oldPath} → ` : ''}${item.path}\t${item.binary ? '二进制' : `+${item.additions} -${item.deletions}`}${item.truncated ? '（已截断）' : ''}`);
        out(`共 ${result.files.length} 个文件（${result.base.slice(0, 7)}..${result.head.slice(0, 7)}）${result.truncated ? '，内容超过上限已截断' : ''}`);
        return 0;
      }
      case 'wait': {
        arity(rest, 1, 'ar wait [记录名]');
        let gate = null, state = null;
        const code = await waitForTask(homes, cwd, rest[0], { log, onGate: value => { gate = value; }, onState: value => { state = value; } });
        if (code === 2 && lines[0]?.startsWith('等待：在当前仓库找不到记录')) { emit({ ok: false, error: lines[0], lines }); return 2; }
        const needsScope = json ? scopeOf(rest[0]) : null;
        const outsideWrites = json ? outsideOf(rest[0]) : null;
        emit({ ok: true, exit: code, ...(state ? { state } : {}), report: lines.findLast(l => l.startsWith('exit='))?.replace(/^exit=\S+ report=/, '') ?? null, ...(gate ? { gate } : {}), ...(needsScope ? { needsScope } : {}), ...(outsideWrites ? { outsideWrites } : {}), lines });
        return code;
      }
      // 任务当前状态（协议 15.11）：不等待。记录名允许中文、空格等。
      case 'status': {
        const { name } = taskArgs(rest, {}, '用法：ar status <记录名> [--json]');
        const result = taskStatus({ homes, root: cwd, name });
        if (json) emit(result); else for (const line of statusLines(result)) out(line);
        return 0;
      }
      // 互相重叠的待验收任务组与建议的批准顺序（Stage07c 154，D86）：只读。
      case 'overlaps': {
        const overlapsUsage = '用法：ar overlaps [--project <路径>] [--json]';
        let project = '.';
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] !== '--project' || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new Error(overlapsUsage);
          project = rest[++i];
        }
        const groups = overlapGroups({ homes: [...new Set(homes)], root: resolvePath(cwd, project) });
        if (json) { emit({ ok: true, groups }); return 0; }
        if (!groups.length) out('没有互相重叠的待验收任务');
        for (const group of groups) {
          out(`重叠的待验收任务：${group.tasks.map(task => task.name).join('、')}`);
          for (const task of group.tasks) out(`  ${task.name}：${task.paths.join('、')}`);
          out(`  ${group.why}`);
        }
        return 0;
      }
      // 链路报告：只读；--blame 先写归因标记，再按新归因出报告。记录名允许中文、空格等。
      case 'report': {
        const reportUsage = '用法：ar report <记录名> [--blame <n>=spec|worker|environment] [--json]';
        const { name, options } = taskArgs(rest, { values: ['--blame'] }, reportUsage);
        if (options['--blame'] !== undefined) {
          const blame = /^([1-9]\d*)=(spec|worker|environment)$/.exec(options['--blame']);
          if (!blame) throw new Error(`${reportUsage}（归因只能是 spec、worker 或 environment 三种之一）`);
          setBlame({ home: homes, root: cwd, name, n: Number(blame[1]), blame: blame[2] });
        }
        const report = buildReport({ home: homes, root: cwd, name, env });
        if (json) emit(report); else for (const line of reportLines(report)) out(line);
        return 0;
      }
      // 清理（协议 15.10）：与项目无关，处理公共目录与 worktree 根目录里的东西。
      case 'gc': {
        if (rest.some(a => a !== '--dry-run')) throw new Error('用法：ar gc [--dry-run] [--json]');
        const dryRun = rest.includes('--dry-run');
        const result = await gc({ homes, env, dryRun });
        if (json) emit(result); else for (const line of gcLines(result, { dryRun })) out(line);
        return 0;
      }
      case 'stop': {
        if (rest.length !== 1 || !rest[0] || rest[0].startsWith('--')) throw new Error('用法：ar stop <记录名>');
        const code = await stopTask(homes, cwd, rest[0], { log });
        emit(code === 0 ? { ok: true, lines } : { ok: false, error: lines.at(-1), lines });
        return code;
      }
      case 'config': {
        const text = configCommand(rest, env);
        if (!json) { out(text); return 0; }
        const state = readConfig(homes[0]);
        emit({ ok: true, file: state.file, exists: state.exists, config: state.config, lines: text.split('\n') });
        return 0;
      }
      case 'agents': case 'secrets': {
        // unset 在核心命令层单独处理：agents.mjs 只负责 status / set（见任务 012）。
        if (command === 'secrets' && rest[0] === 'unset') {
          if (rest.length !== 2 || !rest[1] || rest[1].startsWith('--')) throw new Error('用法：ar secrets unset <变量名>');
          await capture(() => unsetSecret(rest[1], { env }));
          if (json) emit({ ok: true, name: rest[1] }); else out(`已删除用户环境变量 ${rest[1]}`);
          return 0;
        }
        // test 会真实派发一次：派发过程的普通输出在 --json 时收集起来，只打印最后一个 JSON 对象。
        // 测试连接与列出模型会启动执行者（test 在临时公共目录里派发，读不到全局配置的 proxy），所以代理变量在这里先加进环境（099）。
        const agentEnv = command === 'agents' && ['test', 'models'].includes(rest[0]) ? withProxy(env, homes[0]).base : env;
        const { result, text, code = 0 } = await capture(() => command === 'agents' ? agentsCommand(rest, { home: homes[0], env: agentEnv, scriptPath, cwd }) : secretsCommand(rest, { home: homes[0], env, readValue: readSecret, ...(setSecret ? { setSecret } : {}) }));
        if (json) emit(result); else out(text);
        return code;
      }
      // 网络代理（Stage07 099）：只读。按全局 config.json 的 proxy 算出这一刻的结果；system 模式会读一次 Windows 系统代理。
      case 'proxy': {
        if (rest.length !== 1 || rest[0] !== 'resolve') throw new Error('用法：ar proxy resolve [--json]');
        const resolved = resolveProxy(readEffectiveConfig(homes[0]), { readSystem: () => readSystemProxy({ env }) });
        if (json) emit({ ok: true, ...resolved }); else out(`proxy  ${proxyText(resolved)}`);
        return 0;
      }
      // 路由试算（Stage07 T4）：只计算，不派发、不写任何文件。
      case 'route': {
        // 路由配置的读写：ar route config / rules set / fallback set|clear / reviewer set / limit set。
        if (['config', 'rules', 'fallback', 'reviewer', 'limit', 'limits', 'suggest', 'strong'].includes(rest[0])) {
          const { result, text } = routeConfigCommand(rest, { home: homes[0] });
          if (json) emit({ ok: true, ...result }); else out(text);
          return 0;
        }
        const routeUsage ='用法：ar route [--spec <任务说明>] [--type <类型>] [--project <路径>] [--profile <名>] [--explain] [--json]';
        const given = {};
        let explain = false;
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i];
          if (a === '--explain') { explain = true; continue; }
          if (!['--spec', '--type', '--project', '--profile'].includes(a) || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw new Error(routeUsage);
          given[a] = rest[++i];
        }
        if (given['--type'] !== undefined && !SPEC_TYPES.includes(given['--type'])) throw new Error(`--type 只能是 ${SPEC_TYPES.join('、')}（当前：${given['--type']}）`);
        const root = resolvePath(cwd, given['--project'] ?? '.');
        let spec = null;
        if (given['--spec'] !== undefined) {
          let source;
          try { source = readFileSync(resolvePath(root, given['--spec']), 'utf8'); }
          catch (error) { throw new Error(`读不到任务说明 ${given['--spec']}：${error.message}`); }
          const { type, worker, read_only } = validateSpec(parseSpec(source, given['--spec']), given['--spec']);
          spec = { type, worker, read_only };
        }
        if (given['--type'] !== undefined) spec = { ...spec, type: given['--type'] };
        const config = readEffectiveConfig(homes[0]);
        let result;
        try {
          result = route({ spec, projectConfig: readProjectConfig(root), config, explicit: given['--profile'] ?? (env.AR_PROFILE || undefined), home: homes[0] });
        } catch (error) {
          if (!error.code || !Array.isArray(error.trace)) throw error;
          if (json) { emit({ ok: false, code: error.code, error: error.message, trace: error.trace }); return 2; }
          throw new Error([error.message, '路由过程：', ...error.trace.map(line => `  ${line}`)].join('\n'));
        }
        const chosen = config.profiles[result.profile];
        const label = chosen.label ?? adapters[chosen.adapter]?.label ?? result.profile;
        if (json) { emit({ ok: true, ...result, label }); return 0; }
        out(`将派给 ${label}（${result.trace.at(-1)}）`);
        if (explain) { out('路由过程：'); for (const line of result.trace) out(`  ${line}`); }
        return 0;
      }
      // 角色设置（Stage07c T4）：每个执行者可担任的角色、模型家族、按家族挑审查者；set 子命令写 config.json。
      case 'roles': {
        const { result, text } = rolesCommand(rest, { home: homes[0] });
        if (json) emit({ ok: true, ...result }); else out(text);
        return 0;
      }
      // 审查（Stage08 T3、T4）：再审、确认问题、查看、统计准确率、全局审查设置。
      case 'review': {
        const { result, text, code = 0 } = await reviewCommand(rest, { homes, root: cwd, env });
        if (json) emit(result); else out(text);
        return code;
      }
      case 'version': {
        arity(rest, 0, 'ar version');
        const info = { version: coreVersion(scriptPath), node: process.versions.node, electron: process.versions.electron ?? null };
        if (json) emit({ ok: true, ...info });
        else out(`AgentRouter 核心 ${info.version}（Node ${info.node}${info.electron ? `，Electron ${info.electron} 内置` : ''}）`);
        return 0;
      }
      case 'init': case 'projects': {
        const result = await (command === 'init' ? initCommand : projectsCommand)(rest, { home: homes[0], homes, env, cwd, json, readForm });
        if (json) emit(result); else out(result);
        return 0;
      }
      case 'spec': {
        const { result, text, code = 0 } = await specCommand(rest, { home: homes[0], cwd, json, readForm });
        if (json) emit(result); else out(text);
        return code;
      }
      default: throw new Error(usage);
    }
  } catch (error) {
    if (json) { out(JSON.stringify({ ok: false, error: error.message, ...(error.arCode ? { code: error.arCode } : {}), ...(Array.isArray(error.files) ? { files: error.files } : {}) })); return 2; }
    throw error;
  }
}

// 从标准输入读密钥：终端里不回显；管道输入时读到结尾。值不经过命令行参数。
export async function readSecretValue(name, { input = process.stdin, output = process.stderr } = {}) {
  if (input.isTTY) {
    output.write(`输入 ${name}（不显示，回车结束）：`);
    input.setRawMode(true); input.resume(); input.setEncoding('utf8');
    return await new Promise((resolve, reject) => {
      let value = '';
      const done = result => { input.setRawMode(false); input.pause(); input.off('data', onData); output.write('\n'); result instanceof Error ? reject(result) : resolve(result); };
      const onData = chunk => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') return done(value);
          if (ch === '\u0003') return done(new Error('已取消'));
          if (ch === '\u0008' || ch === '\u007f') value = value.slice(0, -1); else value += ch;
        }
      };
      input.on('data', onData);
    });
  }
  let value = '';
  input.setEncoding('utf8');
  for await (const chunk of input) value += chunk;
  return value.replace(/\r?\n$/, '');
}
