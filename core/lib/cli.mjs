// ar 子命令：dispatch · redispatch · retry · wait · stop · config · agents · secrets · version（init/projects 见 project.mjs，agents/secrets 见 agents.mjs）。
// 所有面向软件的命令支持 --json：标准输出只有一个 JSON 对象；出错时 { ok:false, error } 且退出码非 0。
import { trace, tracing } from './trace.mjs';
import { dirname, join } from 'node:path';
import { run } from './run.mjs';
import { homeDirectory, legacyHomeDirectory, homeEnv, unsafeHome } from './compat.mjs';
import { configCommand, readConfig } from './config.mjs';
import { waitForTask } from './wait.mjs';
import { stopTask } from './stop.mjs';
import { agentsCommand, secretsCommand, listAgents } from './agents.mjs';
import { unsetUserSecret } from './secrets.mjs';
import { initCommand, projectsCommand } from './project.mjs';
import { specCommand, readSpecForm } from './spec-new.mjs';
import { readDispatch, optionArgs } from './records.mjs';
import { readJson } from './json.mjs';

export const commands = ['dispatch', 'redispatch', 'retry', 'wait', 'stop', 'config', 'init', 'projects', 'agents', 'secrets', 'spec', 'version', '--run-request'];
export { listAgents };
const legacy = { '--wait': 'wait', '--stop': 'stop', '--config': 'config' };
export const usage = [
  '用法：',
  '  ar dispatch <任务说明 | "任务文字"> [补充说明] [--profile <名>] [--role <角色>] [--name <记录名>] [--host claude-code|agentrouter] [--sandbox …] [--watch-window …] [--detach]',
  '  ar redispatch <记录名> [--detach] [--host claude-code|agentrouter]（按记录里保存的参数再派发一次，记录名自动去重）',
  '  ar retry <记录名> [--profile <名>] [--note "<补充说明>"] [--detach] [--host claude-code|agentrouter]（同一工作区手动重试下一次尝试，协议 14.3）',
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
            ...(saved.role ? ['--role', saved.role] : []), ...optionArgs(saved.options), ...(detachFlag ? ['--detach'] : []), ...(host ? ['--host', host] : [])];
        } else runArgs = command === 'dispatch' ? rest : ['--run-request', ...rest];
        const code = await capture(() => run({ scriptPath, env, root: cwd, args: runArgs, onDetach: id => { detach = id; }, onGate: value => { gate = value; } }));
        const name = lines.find(l => l.startsWith('记录名：'))?.slice(4), progress = lines.find(l => l.startsWith('进度：'))?.slice(3);
        emit({ ok: code === 0, exit: code, name: name ?? null, progress: progress ?? null, ...(detach ? { id: detach, detached: true } : {}), ...(gate ? { gate } : {}), lines, ...(code === 0 ? {} : { error: lines.findLast(l => l.startsWith('出错：'))?.slice(3) ?? lines.at(-1) ?? '派发失败' }) });
        return code;
      }
      case 'retry': {
        // 手动重试（协议 14.3，任务 059）：记录名允许中文、空格等（同 redispatch），只校验个数与开关取值。
        const usageText = '用法：ar retry <记录名> [--profile <名>] [--note "<补充说明>"] [--detach] [--host claude-code|agentrouter]';
        let profile = null, note = null, host = null;
        const names = [];
        for (let i = 0; i < rest.length; i++) {
          const a = rest[i];
          if (a === '--detach') continue;
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
        const code = await capture(() => run({ scriptPath, env, root: cwd, retry: { name: names[0], profile, note, detach: rest.includes('--detach'), host },
          onRetry: value => { retried = value; }, onDetach: id => { detached = id; }, onGate: value => { gate = value; } }));
        const recordName = lines.find(l => l.startsWith('记录名：'))?.slice(4) ?? null;
        const progress = lines.find(l => l.startsWith('进度：'))?.slice(3) ?? null;
        emit({ ok: code === 0, exit: code, id: retried?.id ?? detached ?? null, name: recordName, n: retried?.n ?? null, progress,
          ...(detached ? { detached: true } : {}), ...(gate ? { gate } : {}), lines,
          ...(code === 0 ? {} : { error: lines.findLast(l => l.startsWith('出错：'))?.slice(3) ?? lines.at(-1) ?? '重试失败' }) });
        return code;
      }
      case 'wait': {
        arity(rest, 1, 'ar wait [记录名]');
        let gate = null;
        const code = await waitForTask(homes, cwd, rest[0], { log, onGate: value => { gate = value; } });
        if (code === 2 && lines[0]?.startsWith('等待：在当前仓库找不到记录')) { emit({ ok: false, error: lines[0], lines }); return 2; }
        emit({ ok: true, exit: code, report: lines.findLast(l => l.startsWith('exit='))?.replace(/^exit=\S+ report=/, '') ?? null, ...(gate ? { gate } : {}), lines });
        return code;
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
