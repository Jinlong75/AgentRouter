import { join } from 'node:path';
import { locateStart, findTerminal } from './wait.mjs';
import { processInfo, taskAlive, killProcessTree, pidAlive, redactPaths } from './process.mjs';
import { registryWriter } from './records.mjs';
import { scriptNames } from './compat.mjs';
import { tracing } from './trace.mjs';

// 失败路径（以及 AR_CORE_TRACE=1 时）的逐项核对：期望值与实际值并列，最后指出哪几项不匹配。只写标准错误。
function identityCheck(name, start, { identity, queryNote, queryMs }) {
  const queried = identity !== null && identity !== undefined;
  const created = identity?.created;
  const finite = Number.isFinite(created);
  const command = identity?.command ?? '';
  const script = scriptNames.find(value => command.includes(value)) ?? null;
  const createdOk = finite && created <= start.started;
  const alive = pidAlive(start.pid);
  const mismatched = [
    !queried && '进程查询得到结果',
    queried && !finite && '创建时间是有限数',
    queried && !script && '命令行包含派发脚本名',
    queried && finite && !createdOk && '创建时间 ≤ started',
    queried && !alive && 'PID 存活',
  ].filter(Boolean);
  const queryError = queryNote === null || queryNote === undefined
    ? '未报告（查询实现没有回调）'
    : queryNote.error ? String(queryNote.error) : '无';
  const queryTime = queryNote?.ms ?? queryMs;
  return [
    `[ar-stop 核对] ${name}：进程已经不在了，逐项核对（pid=${start.pid}，started=${start.started}）`,
    `  进程查询：期望 得到结果；实际 ${queried ? '得到结果' : '没有结果'}；用时 ${queryTime}ms；错误：${redactPaths(queryError)}`,
    `  名称：期望 派发执行者的运行时（如 node.exe / electron.exe）；实际 ${identity?.name ? redactPaths(identity.name) : '（未知）'}（仅记录，不参与判断）`,
    `  命令行：期望 包含 ${scriptNames.join(' / ')} 之一；实际 ${script ? `包含 ${script}` : '不含'}；脱敏后：${redactPaths(command) || '（空）'}`,
    `  创建时间：期望 有限数且 ≤ started；实际 ${finite ? created : queried ? String(created) : '（无结果）'}；创建时间 ≤ started：${finite ? (created <= start.started ? '成立' : '不成立') : '无法比较'}`,
    `  PID 存活：期望 存活；实际 ${alive ? '存活' : '不存活'}`,
    `  不匹配：${mismatched.join('、') || '无'}`,
  ].join('\n');
}

export async function stopTask(homes, root, name, { info = processInfo, alive = taskAlive, killTree = killProcessTree, log = console.log, err = text => process.stderr.write(`${text}\n`) } = {}) {
  const found = locateStart(homes, root, name), file = found?.file, start = found?.start, home = found?.home;
  if (!start) { log(`停止：在当前仓库找不到记录 ${name}`); return 2; }
  const ended = () => { log(`停止：${name}（已经结束）`); return 0; };
  if (findTerminal(file, start.id)) return ended();
  // 同一次查询的用时用来诊断超时；查询异常由 processInfo 通过回调交给这里，不为诊断再查一次。
  const queryStarted = Date.now();
  let queryNote = null;
  const identity = await info(start.pid, undefined, note => { queryNote = note; });
  const queryMs = Date.now() - queryStarted;
  const matches = identity && Number.isFinite(identity.created) && scriptNames.some(script => identity.command.includes(script))
    && await alive(start, { created: async () => identity.created });
  if (findTerminal(file, start.id)) return ended();
  if (!matches) {
    log(`停止：${name} 的进程已经不在了`);
    err(identityCheck(name, start, { identity, queryNote, queryMs }));
    return 1;
  }
  if (tracing) err(identityCheck(name, start, { identity, queryNote, queryMs }));
  try { await killTree(start.pid, { expectedCreated: identity.created }); }
  catch (error) { log(`停止：${name} 没能停下（${error.message}）`); return 1; }
  registryWriter(home, { separate: true })({ event: 'interrupted', id: start.id, signal: 'stopped-by-command', at: Date.now() });
  log(`停止：${name} 已停止，工作区里没提交的改动还在`);
  return 0;
}
