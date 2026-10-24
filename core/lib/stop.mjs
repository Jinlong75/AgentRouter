import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { locateStartWaiting, findTerminal } from './wait.mjs';
import { processInfo, taskAlive, killProcessTree, pidAlive, redactPaths, identityAlive } from './process.mjs';
import { registryWriter } from './records.mjs';
import { releaseAllFor } from './slots.mjs';
import { scriptNames } from './compat.mjs';
import { tracing } from './trace.mjs';

// 协议第 9 节：进程查询本身失败不算"核对不过"——查询失败（超时、出错，或没有结果但 PID 仍存活）
// 间隔约 1 秒重试，最多共查 3 次；3 次都失败返回 { ok: false }，由调用方报"无法核对进程"。
// 查询成功时返回 { ok: true, identity, note, ms }；identity 为 null 表示"查询成功、进程确实不在"。
async function queryIdentity(info, start, { retryDelayMs, attempts }) {
  for (let n = 1; n <= 3; n++) {
    if (n > 1 && retryDelayMs) await delay(retryDelayMs);
    const queryStarted = Date.now();
    let note = null, identity = null, thrown = null;
    try { identity = await info(start.pid, undefined, value => { note = value; }); }
    catch (error) { thrown = error; }
    const ms = note?.ms ?? (Date.now() - queryStarted);
    // 同一次查询的回调（observe）与返回值优先；没有回调时按返回值判断。
    if (identity) { attempts.push({ n, ms, ok: true, error: '' }); return { ok: true, identity, note, ms }; }
    if (thrown) {
      const error = thrown.message || String(thrown);
      attempts.push({ n, ms, ok: false, error });
      continue;
    }
    if (note?.ok === false) {
      const error = note.error ? String(note.error) : '（查询实现没有给出原因）';
      attempts.push({ n, ms, ok: false, error });
      continue;
    }
    // 没有结果：PID 不存活才算"查询成功、进程确实还在不在"；两者对不上按查询失败重试（065 A）。
    if (!pidAlive(start.pid)) { attempts.push({ n, ms, ok: true, error: '' }); return { ok: true, identity: null, note, ms }; }
    attempts.push({ n, ms, ok: false, error: '查询没有结果但 PID 仍然存活' });
  }
  return { ok: false };
}

// 065 失败路径的核对明细里附带的查询次数记录（有重试时才写）。
function attemptLines(attempts) {
  if (!attempts.some(a => !a.ok)) return [];
  return attempts.map(a => `  查询第 ${a.n} 次：${a.ok ? '成功' : '失败'}，用时 ${a.ms}ms${a.error ? `，错误：${redactPaths(a.error)}` : ''}`);
}

// 失败路径（以及 AR_CORE_TRACE=1 时）的逐项核对：期望值与实际值并列，最后指出哪几项不匹配。只写标准错误。
function identityCheck(name, start, { identity, queryNote, queryMs, kind = '进程已经不在了' }) {
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
    `[ar-stop 核对] ${name}：${kind}，逐项核对（pid=${start.pid}，started=${start.started}）`,
    `  进程查询：期望 得到结果；实际 ${queried ? '得到结果' : '没有结果'}；用时 ${queryTime}ms；错误：${redactPaths(queryError)}`,
    `  名称：期望 派发执行者的运行时（如 node.exe / electron.exe）；实际 ${identity?.name ? redactPaths(identity.name) : '（未知）'}（仅记录，不参与判断）`,
    `  命令行：期望 包含 ${scriptNames.join(' / ')} 之一；实际 ${script ? `包含 ${script}` : '不含'}；脱敏后：${redactPaths(command) || '（空）'}`,
    `  创建时间：期望 有限数且 ≤ started；实际 ${finite ? created : queried ? String(created) : '（无结果）'}；创建时间 ≤ started：${finite ? (created <= start.started ? '成立' : '不成立') : '无法比较'}`,
    `  PID 存活：期望 存活；实际 ${alive ? '存活' : '不存活'}`,
    `  不匹配：${mismatched.join('、') || '无'}`,
  ].join('\n');
}

export async function stopTask(homes, root, name, { info = processInfo, alive = taskAlive, killTree = killProcessTree, retryDelayMs = 1000, log = console.log, err = text => process.stderr.write(`${text}\n`) } = {}) {
  // 托管请求文件已在而清单还没有 start / resume 时同样等待（协议 14.4 与开工前第 8 条），
  // 否则脱离派发 / 脱离重试的空档里会拿旧 end、旧 pid 判断状态。
  const found = await locateStartWaiting(homes, root, name), file = found?.file, start = found?.start, home = found?.home;
  if (!start) { log(`停止：在当前仓库找不到记录 ${name}`); return 2; }
  const ended = () => { log(`停止：${name}（已经结束）`); return 0; };
  if (findTerminal(file, start.id)) return ended();
  // 065 A（协议第 9 节）：进程查询失败间隔约 1 秒重试、最多共查 3 次；3 次都失败不结束任何进程。
  const attempts = [];
  const query = await queryIdentity(info, start, { retryDelayMs, attempts });
  if (findTerminal(file, start.id)) return ended();
  if (!query.ok) {
    const last = attempts.at(-1);
    log(`停止：${name} 无法核对进程（进程查询失败：${last.error}），没有结束任何进程`);
    err([
      identityCheck(name, start, { identity: null, queryNote: { ok: false, ms: last.ms, error: last.error }, queryMs: last.ms, kind: '无法核对进程' }),
      ...attemptLines(attempts),
    ].join('\n'));
    return 1;
  }
  const { identity, note, ms } = query;
  const matches = identity && Number.isFinite(identity.created) && scriptNames.some(script => identity.command.includes(script))
    && await alive(start, { created: async () => identity.created });
  if (findTerminal(file, start.id)) return ended();
  if (!matches) {
    log(`停止：${name} 的进程已经不在了`);
    err([
      identityCheck(name, start, { identity, queryNote: note, queryMs: ms }),
      ...attemptLines(attempts),
    ].join('\n'));
    return 1;
  }
  if (tracing) err([
    identityCheck(name, start, { identity, queryNote: note, queryMs: ms }),
    ...attemptLines(attempts),
  ].join('\n'));
  try { await killTree(start.pid, { expectedCreated: identity.created }); }
  catch (error) {
    log(`停止：${name} 没能停下（${error.message}）`);
    // 065 C：这条失败路径以前不写任何标准错误（现场里标准错误为空）；现在补上诊断（失败路径才写，正常输出不变）。
    err(`[ar-stop 核对] ${name}：没能停下（结束进程树出错），pid=${start.pid}，错误：${redactPaths(error.message)}`);
    return 1;
  }
  // 065 B（协议第 9 节）：全部退出后（最多等 10 秒）才追加 interrupted——
  // 结束进程树返回后再确认派发进程本身（start.pid）真的退出了。069：退出按身份（PID + 创建时间）认定——
  // pidAlive 为真时查一次进程，同一个创建时间才算还在，PID 被别的进程复用按已退出处理。
  // 复核固定用真实的 processInfo（不走注入的 info）：核对的是系统真实状态。
  const deadline = Date.now() + 10000, waitStart = Date.now();
  let note2 = null, after = null, thrown = null, identityGone = false;
  for (;;) {
    if (!pidAlive(start.pid)) { identityGone = true; break; }
    // 刚结束时先只看 PID（进程通常几十毫秒内就退出了），超过 500 毫秒仍存活才付进程查询的代价。
    if (Date.now() - waitStart >= 500 || Date.now() >= deadline) {
      note2 = null; after = null; thrown = null;
      try { after = await processInfo(start.pid, undefined, value => { note2 = value; }); }
      catch (error) { thrown = error; }
      // 确认"已经退出"的两种情形：身份已经变化（PID 被复用），或查询成功没有结果且 pidAlive 已为假。
      identityGone = after
        ? !identityAlive([after], { pid: start.pid, created: identity.created })
        : !thrown && note2?.ok !== false && !pidAlive(start.pid);
      if (identityGone) break;
    }
    if (Date.now() >= deadline) break;
    await delay(50);
  }
  if (!identityGone) {
    const reason = thrown ? `无法核对进程（${thrown.message}）`
      : after ? '派发进程在 10 秒内没有退出'
      : note2?.ok === false ? `无法核对进程（进程查询失败：${note2.error ?? '（没有原因）'}）`
      : '派发进程在 10 秒内没有退出';
    log(`停止：${name} 没能停下（${reason}）`);
    err(`[ar-stop 核对] ${name}：没能停下（等待退出超时），pid=${start.pid}，10 秒后派发进程${after ? `仍存活（created=${after.created}）` : '仍存活'}`);
    return 1;
  }
  registryWriter(home, { separate: true })({ event: 'interrupted', id: start.id, signal: 'stopped-by-command', at: Date.now() });
  // 进程是被直接结束的，它的信号处理器没有机会释放并发名额（协议 15.5）：任务名额与门禁名额一起清掉。
  releaseAllFor({ home, id: start.id });
  log(`停止：${name} 已停止，工作区里没提交的改动还在`);
  return 0;
}
