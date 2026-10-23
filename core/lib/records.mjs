import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './json.mjs';

export function registryWriter(home, { separate = false } = {}) {
  return record => {
    try {
      mkdirSync(home, { recursive: true });
      appendFileSync(join(home, 'runs.jsonl'), `${separate ? '\n' : ''}${JSON.stringify({ v: 1, ...record })}\n`);
    } catch { /* 协议规定：清单写入失败不影响任务。 */ }
  };
}

// 协议 v2：每个任务一个目录 <项目>/.agent-runs/<名>/。
export function taskPaths(root, name) {
  const dir = join(root, '.agent-runs', name);
  return { name, dir, progress: join(dir, 'progress.log'), report: join(dir, 'report.md'), raw: join(dir, 'raw.log'), events: join(dir, 'events.jsonl') };
}

// 每次尝试的目录 <任务目录>/attempts/<n>/（协议 14.2 第 3 条）：
// prompt.md（这次的完整指令）、raw.log（这次的原始输出）、report.md（这次的汇报）、gate.json（这次的门禁）。
export function attemptPaths(paths, n) {
  const dir = join(paths.dir, 'attempts', String(n));
  return { dir, prompt: join(dir, 'prompt.md'), raw: join(dir, 'raw.log'), report: join(dir, 'report.md'), gate: join(dir, 'gate.json') };
}

export function dispatchPath(root, name) {
  return join(taskPaths(root, name).dir, 'dispatch.json');
}

// 派发参数快照：再派一次按同样的参数重新派发。字段只有用户输入与执行者名，不含任何密钥值。
// 先写临时文件再改名，读到的要么是完整文件，要么什么都没有。
export function writeDispatch(paths, fields) {
  const file = join(paths.dir, 'dispatch.json');
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ v: 1, ...fields }), { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return file;
}

// dispatch.json 的 options（协议第 3 节，067）：命令行明确给出的派发选项，键名 → 命令行开关。
export const DISPATCH_OPTIONS = { model: 'model', effort: 'effort', tier: 'tier', sandbox: 'sandbox', watchWindow: 'watch-window' };

// 从 parseArgs 的 opts 里挑出明确给出的派发选项；一个都没有返回 null（此时不写 options 字段）。
export function explicitOptions(opts) {
  const picked = {};
  for (const [key, flag] of Object.entries(DISPATCH_OPTIONS)) if (typeof opts[flag] === 'string' && opts[flag] !== '') picked[key] = opts[flag];
  return Object.keys(picked).length ? picked : null;
}

// 读回时的容错：options 不是对象、键不认识、值不是非空字符串都只忽略那一项；剩下为空返回 null。
function cleanOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const picked = {};
  for (const key of Object.keys(DISPATCH_OPTIONS)) if (typeof raw[key] === 'string' && raw[key] !== '') picked[key] = raw[key];
  return Object.keys(picked).length ? picked : null;
}

// ar retry 沿用的选项：同一执行者配置沿用全部；换了配置只沿用 sandbox / watchWindow（model / effort / tier 是上一个配置的）。
export const SHARED_OPTIONS = ['sandbox', 'watchWindow'];
export function retryOptions(options, switched) {
  return Object.fromEntries(Object.entries(options ?? {}).filter(([key]) => !switched || SHARED_OPTIONS.includes(key)));
}

// options 转回命令行开关（redispatch 把它们当作写在命令行上）。
export function optionArgs(options) {
  return Object.entries(options ?? {}).flatMap(([key, value]) => [`--${DISPATCH_OPTIONS[key]}`, value]);
}

// 读回派发参数。文件不存在或格式不对都当作旧任务（返回 null），由调用方报同一句话。
// options 经过清理：返回值里要么是只含认识的键、非空字符串值的对象，要么没有这个字段。
export function readDispatch(root, name) {
  let value;
  try { value = readJson(dispatchPath(root, name)); } catch { return null; }
  const valid = value && value.v === 1 && typeof value.task === 'string' && value.task !== ''
    && typeof value.extra === 'string' && (value.role === null || typeof value.role === 'string')
    && (value.spec === null || typeof value.spec === 'string') && typeof value.profile === 'string' && value.profile !== ''
    && typeof value.name === 'string' && value.name !== '';
  if (!valid) return null;
  const { options, ...rest } = value;
  const cleaned = cleanOptions(options);
  return cleaned ? { ...rest, options: cleaned } : rest;
}

export function recordPaths(root, requested, header, dryRun = false) {
  for (let n = 1; ; n++) {
    const paths = taskPaths(root, n === 1 ? requested : `${requested}-${n}`);
    if (dryRun) { if (existsSync(paths.progress)) continue; }
    else {
      mkdirSync(paths.dir, { recursive: true });
      // 独占创建 progress.log 占名，并发派发也不会占用同一个记录名。
      try { writeFileSync(paths.progress, header, { flag: 'wx' }); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    }
    return paths;
  }
}
