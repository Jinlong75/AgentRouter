// 界面检查收尾（377）：把"挪目录 + 遇 EPERM/EBUSY 诊断并重试"和进程身份判定抽出来，
// 便于注入故障单独测试。零依赖；rename、诊断、计时、日志都可注入。
import { rename as fsRename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const RETRYABLE = new Set(['EPERM', 'EBUSY']);

function withDiagnosis(error, diagnosis) {
  error.message += `；移出目录进程诊断：${diagnosis}`;
  return error;
}

async function defaultDiagnose() {
  return process.platform === 'win32' ? '未提供进程诊断' : '非 Windows，未查询进程';
}

// 进程身份判定（R2-1）：只有查询成功且确实没有该 PID 才算已退出；查询失败是"状态未知"。
// query 为 { ok:true, process:null }（查询成功、没有该 PID）、{ ok:true, process:{name,created} }，
// 或 { ok:false, error }（查询失败）；before 为就绪时记录的身份 {name,created}，可能为空。
// 返回 exited（已退出）、same（同一个进程）、reused（PID 被复用，原进程已退出）、
// present（进程存在但就绪时没记录，无法比对）、unknown（查询失败，状态未知）。
export function judgeProcessIdentity(query, before) {
  if (!query || !query.ok) return 'unknown';
  if (!query.process) return 'exited';
  if (!before) return 'present';
  return query.process.name === before.name && query.process.created === before.created ? 'same' : 'reused';
}

// 挪目录：可以重试的错误按上限重试，每次失败都带进程诊断；上限到了抛出第一次遇到的错误（附加诊断）。
export async function renameWithRetry(source, destination, options = {}) {
  const {
    rename = fsRename,
    diagnose = defaultDiagnose,
    label = path.basename(source),
    timeoutMs = 10000,
    maxAttempts = 4,
    retryDelayMs = 500,
    now = () => performance.now(),
    wait = ms => delay(ms),
    log = line => console.log(line),
  } = options;
  const until = now() + timeoutMs;
  let firstError, lastDiagnosis;
  for (let attempt = 1; ; attempt++) {
    if (firstError && now() >= until) throw withDiagnosis(firstError, lastDiagnosis);
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!RETRYABLE.has(error.code)) throw error;
      firstError ??= error;
      const remaining = until - now();
      let diagnosis;
      if (remaining <= 0) diagnosis = '重试时限已到，未查询进程';
      else {
        // 诊断函数自身失败时仍然抛出原来的改名错误，诊断只用于附加说明。
        try { diagnosis = await diagnose(source, error, { remaining }); }
        catch (failure) { diagnosis = `查询失败：${failure.code ?? failure.message}`; }
      }
      lastDiagnosis = diagnosis;
      log(`移出目录失败（${label}，第 ${attempt} 次，${error.code}）：进程诊断 ${diagnosis}`);
      const left = until - now();
      if (attempt >= maxAttempts || left <= 0) throw withDiagnosis(firstError, diagnosis);
      await wait(Math.min(retryDelayMs, left));
    }
  }
}
