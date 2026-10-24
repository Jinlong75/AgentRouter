// 工作区外写入检查（协议 12.4）：每次尝试前后各列一遍用户目录根与公共目录根的第一层，
// 结束时多出来的名字就是"工作区外的新文件"。只取名字、类型与修改时间，不读内容、不跟随符号链接、
// 不递归，更不删除或移动任何东西。零依赖。
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 公共目录根下核心与软件自己会写的名字（协议第 1 节的表）。
export const HOME_NAMES = Object.freeze([
  'runs.jsonl', 'config.json', 'projects.json', 'viewer.json', 'managed', 'agent-tests.json',
  'backups', 'staging', 'workers', 'monitor',
]);
// 并发名额目录（协议 15.5）。
export const SLOTS_NAME = 'slots';
// 整个名字都不算的条目 = 第 1 节的表 + slots。
export const EXCLUDED_NAMES = Object.freeze([...HOME_NAMES, SLOTS_NAME]);
// 原子写入时短暂存在的临时文件：名字以 .tmp 结尾，并且以这些前缀之一开头（表里的文件名与 .config-、.agent-tests-）。
export const TEMP_PREFIXES = Object.freeze([...HOME_NAMES, '.config-', '.agent-tests-']);
export const TEMP_SUFFIX = '.tmp';
// added 最多记这么多条（目录里一次多出成百上千个文件时，记录与横幅不该跟着膨胀）。
export const MAX_ADDED = 100;

const lowerIf = (value, caseInsensitive) => (caseInsensitive ? value.toLowerCase() : value);

// 公共目录根下的这个名字是不是核心与软件自己的条目（不算新文件）。Windows 上不区分大小写。
export function isExcludedHomeName(name, { caseInsensitive = process.platform === 'win32' } = {}) {
  const key = lowerIf(name, caseInsensitive);
  if (EXCLUDED_NAMES.some(item => lowerIf(item, caseInsensitive) === key)) return true;
  return key.endsWith(TEMP_SUFFIX) && TEMP_PREFIXES.some(prefix => key.startsWith(lowerIf(prefix, caseInsensitive)));
}

// 用户目录根下程序原子写入时短暂存在的临时文件：名字以 .tmp 结尾或含 .tmp.（不算新文件，只在进度里提一句）。
export function isUserTempName(name, { caseInsensitive = process.platform === 'win32' } = {}) {
  const key = lowerIf(name, caseInsensitive);
  return key.endsWith(TEMP_SUFFIX) || key.includes(`${TEMP_SUFFIX}.`);
}

const typeOf = entry => (entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other');

// 列一个目录的第一层：[{ name, type, mtimeMs }]；读不了返回 { error }（不抛出）。
// withFileTypes 不跟随符号链接（符号链接的类型是 'other'），再用 lstat 取修改时间。
function listRoot(dir) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).map(entry => {
      let mtimeMs = null;
      try { mtimeMs = lstatSync(join(dir, entry.name)).mtimeMs; } catch { /* 刚好被删掉时没有修改时间。 */ }
      return { name: entry.name, type: typeOf(entry), mtimeMs };
    });
    return { entries };
  } catch (error) {
    return { error: String(error?.code ?? error?.message ?? error) };
  }
}

// snapshotRoots({ userHome, home }) → { user, home }，每项是 { entries } 或 { error }。
export function snapshotRoots({ userHome, home }) {
  return { user: listRoot(userHome), home: listRoot(home) };
}

const ROOT_LABEL = { user: '用户目录', home: '公共目录' };

// diffRoots(before, after) → { checked, added: [{ root, name, type }], error? }。
// 只看新增的名字（已有条目的修改时间变化不算）；两边有任何一项读不了就是"没能核对"：checked 为 false、不记新文件。
export function diffRoots(before, after, { caseInsensitive = process.platform === 'win32' } = {}) {
  const problems = [];
  for (const root of ['user', 'home']) {
    for (const [phase, snapshot] of [['前', before?.[root]], ['后', after?.[root]]]) {
      if (!snapshot || snapshot.error !== undefined || !Array.isArray(snapshot.entries)) {
        problems.push(`${ROOT_LABEL[root]}${phase}读取失败（${snapshot?.error ?? '没有快照'}）`);
      }
    }
  }
  if (problems.length) return { checked: false, added: [], error: problems.join('；') };
  const added = [];
  const userTemp = [];
  for (const root of ['user', 'home']) {
    const known = new Set(before[root].entries.map(entry => lowerIf(entry.name, caseInsensitive)));
    for (const entry of after[root].entries) {
      if (known.has(lowerIf(entry.name, caseInsensitive))) continue;
      if (root === 'home' && isExcludedHomeName(entry.name, { caseInsensitive })) continue;
      if (root === 'user' && isUserTempName(entry.name, { caseInsensitive })) { userTemp.push(entry.name); continue; }
      added.push({ root, name: entry.name, type: entry.type });
    }
  }
  added.sort((a, b) => (a.root === b.root ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.root === 'user' ? -1 : 1));
  // userTemp 只在有临时文件时才有，其余情况返回值与原来一致。
  return { checked: true, added: added.slice(0, MAX_ADDED), ...(userTemp.length ? { userTemp: userTemp.sort().slice(0, MAX_ADDED) } : {}) };
}

// 进度里的一行（协议 12.4）：用户目录根的临时文件已忽略，名字最多列 5 个，多了加" 等"。
export const userTempLine = names => `用户目录根出现临时文件（已忽略）：${names.slice(0, 5).join('、')}${names.length > 5 ? ' 等' : ''}`;

// "<root>/<name>、…"：文件最多列 5 个，多了在最后加" 等"（同门禁 summary 的写法，协议 12.3）。
export function listAdded(added, limit = 5) {
  const shown = added.slice(0, limit).map(item => `${item.root}/${item.name}`).join('、');
  return `${shown}${added.length > limit ? ' 等' : ''}`;
}

// 门禁 summary 的最后一段（协议 12.4）。
export const outsideSummary = added => `工作区外出现新文件：${listAdded(added)}`;
// 进度里的一行（协议 12.4）。
export const outsideLine = added => `${outsideSummary(added)}；不再自动重试，请核对这些文件是谁写的`;
// 协议 12.4 局限：核心分不清是谁写的，进度里再补一行说明。
export const OUTSIDE_NOTE = '可能是同时进行的其他任务或其他程序写的';
// 没能核对时进度里的一行。
export const uncheckedLine = error => `工作区外写入没能核对：${error}`;

// 写进 gate.json 的值（协议 12.4）：核对了是 { checked: true, added }，没能核对是 { checked: false, error }。
export const outsideField = diff => (diff.checked === false
  ? { checked: false, error: diff.error ?? '' }
  : { checked: true, added: diff.added ?? [] });

// 要写进 attempt-end 的值：只在有新文件或没能核对时写，否则 null。
export function outsideRecord(diff) {
  if (!diff) return null;
  return diff.checked === false || diff.added?.length ? outsideField(diff) : null;
}

// 读取方校验（清单里的 outsideWrites）：{ checked: true, added: [{ root, name, type }] } 或 { checked: false, error }。
// 不合法返回 null。--json 只用 added 非空的那种。
export function readOutsideWrites(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.checked === false) return { checked: false, added: [], error: typeof value.error === 'string' ? value.error : '' };
  if (value.checked !== true || !Array.isArray(value.added)) return null;
  const added = [];
  for (const item of value.added) {
    if (!item || typeof item !== 'object' || !['user', 'home'].includes(item.root)
      || typeof item.name !== 'string' || item.name === '' || !['file', 'dir', 'other'].includes(item.type)) return null;
    added.push({ root: item.root, name: item.name, type: item.type });
  }
  return { checked: true, added };
}
