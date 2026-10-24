// ar 子命令：dispatch · redispatch · retry · wait · stop · accept · reject · diff · status · report · gc · config · agents · secrets · version（init/projects 见 project.mjs，agents/secrets 见 agents.mjs，accept/reject 见 accept.mjs，diff 见 diff.mjs，status 见 status.mjs，report 见 report.mjs，gc 见 gc.mjs）。
// 所有面向软件的命令支持 --json：标准输出只有一个 JSON 对象；出错时 { ok:false, error } 且退出码非 0。
import { trace, tracing } from './trace.mjs';
import { dirname, join } from 'node:path';
import { run } from './run.mjs';
import { homeDirectory, legacyHomeDirectory, homeEnv, unsafeHome } from './compat.mjs';
import { configCommand, readConfig } from './config.mjs';
import { waitForTask, locateStart, findTerminal, reverseRows } from './wait.mjs';
import { readNeedsScope } from './needs-scope.mjs';
import { readOutsideWrites } from './outside-writes.mjs';
import { stopTask } from './stop.mjs';
import { accept, reject } from './accept.mjs';
import { diffTask } from './diff.mjs';
import { buildReport, reportLines, setBlame } from './report.mjs';
import { gc, gcLines } from './gc.mjs';
import { statusLines, taskStatus } from './status.mjs';
import { agentsCommand, secretsCommand, listAgents } from './agents.mjs';
import { unsetUserSecret } from './secrets.mjs';
import { initCommand, projectsCommand } from './project.mjs';
import { specCommand, readSpecForm } from './spec-new.mjs';
import { readDispatch, optionArgs } from './records.mjs';
import { readJson } from './json.mjs';

export const commands = ['dispatch', 'redispatch', 'retry', 'wait', 'stop', 'accept', 'reject', 'diff', 'status', 'report', 'gc', 'config', 'init', 'projects', 'agents', 'secrets', 'spec', 'version', '--run-request'];
export { listAgents };
const legacy = { '--wait': 'wait', '--stop': 'stop', '--config': 'config' };
export const usage = [
  '用法：',
  '  ar dispatch <任务说明 | "任务文字"> [补充说明] [--profile <名>] [--role <角色>] [--name <记录名>] [--host claude-code|agentrouter] [--sandbox …] [--watch-window …] [--detach] [--no-worktree]',
  '  ar redispatch <记录名> [--detach] [--host claude-code|agentrouter]（按记录里保存的参数再派发一次，记录名自动去重）',
  '  ar retry <记录名> [--profile <名>] [--note "<补充说明>"] [--rebase] [--detach] [--host claude-code|agentrouter]（同一工作区手动重试下一次尝试，协议 14.3；--rebase 用于合并冲突的 worktree 任务，协议 15.8）',
  '  ar accept <记录名> [--squash] [--by human]　　ar reject <记录名> --reason "<原因>" [--keep-branch] [--by human]　　ar diff <记录名>（worktree 任务的验收合并、驳回与改动，协议 15.6～15.9）',
  '  ar status <记录名>（任务当前状态，不等待，协议 15.11）　　ar gc [--dry-run]（清理孤立的 worktree、并发名额与过期的执行者会话记录，协议 15.10）',
  '  ar report <记录名> [--blame <n>=spec|worker]（任务结束后的链路报告与评分：执行者、主导各一组指标；--blame 把第 n 次门禁失败归因到任务说明或执行者，协议第 16 节）',
  '  ar wait [记录名]　　ar stop <记录名>　　ar config [键=值 … | init]',
  '  ar init [项目路径] [--dry-run]　　ar projects list [--registry-only]|add <路径> [--allow-non-git]|remove <路径>|clear|show [路径]|config <路径> [键=值 …]|git-init <路径>|commit-init <路径>|git-identity <路径> --name <用户名> --email <邮箱> [--global]　　ar version',
  '  ar agents list [--detect]|presets|add --preset <预设> [--name <名>] [--label …] [--model …] [--base-url …] [--secret-var …] [--auth login|token]|update <名> […|--max-turns <正整数>|-]|default <名>|remove <名>|enable <名>|disable <名>|test <名> [--timeout <秒>]',
  '  ar secrets status [变量名 …]|set <变量名>（值从标准输入读入，不回显）|unset <变量名>（删除 Windows 用户环境变量）',
  '  ar spec list <项目路径>|read <项目路径> <相对路径>|new <项目路径> [--dry-run] [--commit]（表单从标准输入读入）|commit <项目路径> <相对路径>',
  '  加 --json 时只输出一个 JSON 对象（供软件调用）',
].join('\n');

// 旧写法转成子命令：ar <任务> → dispatch；--wait/--stop/--config → wait/stop/config。--json 可出现在任意位置。
export function normalizeArgs(argv) {
  const json = argv.includes('--json');
  let args = argv.filter(a => a !== '--json');
  if (legacy[args[0]]) args = [legacy[args[0]], ...args.slice(1)];
  else if (!args.length || !commands.includes(args[0])) args = ['dispatch', ...args];
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
  const { command, rest, json } = normalizeArgs(argv);
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
    if (command !== 'version') assertSafeHome(env);
    switch (command) {
      case 'dispatch': case 'redispatch': case '--run-request': {
        let detach = null, gate = null;
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
          runArgs = [saved.task, ...(saved.extra ? [saved.extra] : []), '--name', saved.name, '--profile', saved.profile,
            ...(saved.role ? ['--role', saved.role] : []), ...optionArgs(saved.options), ...(saved.noWorktree ? ['--no-worktree'] : []), ...(detachFlag ? ['--detach'] : []), ...(host ? ['--host', host] : [])];
        } else runArgs = command === 'dispatch' ? rest : ['--run-request', ...rest];
        const code = await capture(() => run({ scriptPath, env, root: cwd, args: runArgs, onDetach: id => { detach = id; }, onGate: value => { gate = value; } }));
        const name = lines.find(l => l.startsWith('记录名：'))?.slice(4), progress = lines.find(l => l.startsWith('进度：'))?.slice(3);
        const needsScope = json && name && !detach ? scopeOf(name) : null;
        const outsideWrites = json && name && !detach ? outsideOf(name) : null;
        emit({ ok: code === 0, exit: code, name: name ?? null, progress: progress ?? null, ...(detach ? { id: detach, detached: true } : {}), ...(gate ? { gate } : {}), ...(needsScope ? { needsScope } : {}), ...(outsideWrites ? { outsideWrites } : {}), lines, ...(code === 0 ? {} : { error: lines.findLast(l => l.startsWith('出错：'))?.slice(3) ?? lines.at(-1) ?? '派发失败' }) });
        return code;
      }
      case 'retry': {
        // 手动重试（协议 14.3，任务 059）：记录名允许中文、空格等（同 redispatch），只校验个数与开关取值。
        // 参数错误的用法文字保持原样（已有测试逐字核对）；--rebase 写在上面的总用法里。
        const usageText = '用法：ar retry <记录名> [--profile <名>] [--note "<补充说明>"] [--detach] [--host claude-code|agentrouter]';
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
        const { name, options } = taskArgs(rest, { booleans: ['--squash'], values: ['--by'] }, '用法：ar accept <记录名> [--squash] [--by human] [--json]');
        const result = accept({ homes, root: cwd, name, squash: options['--squash'] === true, by: options['--by'] ?? null, env });
        if (result.conflict) {
          if (json) emit({ ok: false, conflict: true, files: result.files });
          else {
            out(`合并冲突：${result.files.join('、')}`);
            out(`主分支已恢复原样。在原 worktree 里合并主分支并解决冲突：ar retry ${name} --rebase`);
          }
          return 4;
        }
        if (json) emit({ ok: true, merge: result.merge, mode: result.mode, cleanup: result.cleanup });
        else {
          out(`已合并：${name}（${result.mode === 'squash' ? '压成一个提交' : '合并提交'} ${result.merge.slice(0, 7)}）`);
          if (!result.cleanup) out('worktree 或分支没能清理干净，合并结果不受影响；稍后用 ar gc 清理');
        }
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
      // 链路报告：只读；--blame 先写归因标记，再按新归因出报告。记录名允许中文、空格等。
      case 'report': {
        const reportUsage = '用法：ar report <记录名> [--blame <n>=spec|worker] [--json]';
        const { name, options } = taskArgs(rest, { values: ['--blame'] }, reportUsage);
        if (options['--blame'] !== undefined) {
          const blame = /^([1-9]\d*)=(spec|worker)$/.exec(options['--blame']);
          if (!blame) throw new Error(reportUsage);
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
        const { result, text, code = 0 } = await capture(() => command === 'agents' ? agentsCommand(rest, { home: homes[0], env, scriptPath }) : secretsCommand(rest, { home: homes[0], env, readValue: readSecret, ...(setSecret ? { setSecret } : {}) }));
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
        const result = await (command === 'init' ? initCommand : projectsCommand)(rest, { home: homes[0], cwd, json });
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
    if (json) { out(JSON.stringify({ ok: false, error: error.message, ...(error.arCode ? { code: error.arCode } : {}) })); return 2; }
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
