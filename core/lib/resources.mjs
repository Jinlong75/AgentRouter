import os from 'node:os';
import { appendFileSync, readFileSync, renameSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { memLowThreshold } from './schedule.mjs';
import { setTimeout as delay } from 'node:timers/promises';
export function cpuTimes(cpus = os.cpus) {
  let idle = 0, total = 0;
  for (const cpu of cpus()) { for (const value of Object.values(cpu.times)) total += value; idle += cpu.times.idle; }
  return { idle, total };
}
export function cpuPercent(first, second) {
  const total = second.total - first.total;
  return total > 0 ? Math.round(Math.min(100, Math.max(0, (1 - (second.idle - first.idle) / total) * 100))) : 0;
}
export async function sampleResources({ intervalMs = 500 } = {}) {
  const first = cpuTimes();
  await new Promise(resolve => setTimeout(resolve, intervalMs));
  return { cpu: cpuPercent(first, cpuTimes()), freeGb: Number((os.freemem() / 1024 ** 3).toFixed(1)) };
}
export function startSample() {
  return { at: Date.now(), times: cpuTimes() };
}
export async function finishSample(mark, { minMs = 500, signal } = {}) {
  mark ??= startSample();
  const remaining = minMs - (Date.now() - mark.at);
  if (remaining > 0) await delay(remaining, undefined, { signal });
  return { cpu: cpuPercent(mark.times, cpuTimes()), freeGb: os.freemem() / 1024 ** 3 };
}
export async function recordEndSample({ home, id, name, mark, minMs, signal, env = process.env }) {
  try {
    let sample = await finishSample(mark, { minMs, signal });
    if (env?.AR_TEST_LOAD_FILE) {
      try {
        const injected = JSON.parse(readFileSync(env.AR_TEST_LOAD_FILE, 'utf8'));
        if (Number.isFinite(injected.freeGb) && Number.isFinite(injected.cpu)) sample = { freeGb: injected.freeGb, cpu: injected.cpu };
      } catch { /* 测试采样不可用时使用真实采样。 */ }
    }
    let slots = {}, config = { reason: true };
    try {
      const [{ liveHolders }, { readConfig, slotLimits }] = await Promise.all([import('./slots.mjs'), import('./config.mjs')]);
      config = readConfig(home);
      // 统计使用近似值：只检查 PID 是否存活，不启动子进程查询创建时间；PID 复用时可能多计。
      if (!config.reason) {
        const info = slotLimits(config.config);
        slots = { running: await liveHolders({ home, kind: 'task', createdOf: async () => null }), limit: info.mode === 'auto' ? concurrencyState(home, info).limit : info.limits.concurrency };
      }
    } catch { /* 名额不可用时省略。 */ }
    if (!signal?.aborted) {
      const row = { event: 'end', sampleId: randomUUID(), id, name, ...sample, ...slots, at: Date.now() };
      recordSample(home, row);
      if (!config.reason) await adjustConcurrency(home, config.config, row, { signal });
    }
  } catch { /* 采样失败不影响任务结果。 */ }
}
export function recordSample(home, row) {
  try {
    mkdirSync(home, { recursive: true });
    const file = join(home, 'resources.jsonl');
    appendFileSync(file, JSON.stringify({ v: 1, at: Date.now(), ...row }) + '\n');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 2000) {
      const temp = join(home, `resources.${randomUUID()}.tmp`);
      writeFileSync(temp, lines.slice(-1000).join('\n') + '\n');
      renameSync(temp, file);
    }
  } catch { }
}
export function recentSamples(home, n) {
  try { return readFileSync(join(home, 'resources.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-n).map(line => JSON.parse(line)); } catch { return []; }
}

// 状态和采样消费在锁内完成；锁竞争不影响任务结果。
export function concurrencyState(home, info) {
  const file = join(home, 'concurrency-state.json');
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(state.limit) || state.limit < 1 || (state.consumed !== undefined && (!Array.isArray(state.consumed) || state.consumed.some(x => typeof x !== 'string'))) || !Array.isArray(state.window) || state.window.some(x => typeof x !== 'boolean')) throw new Error('invalid');
    return { ...state, consumed: state.consumed ?? [], limit: Math.min(info.max, state.limit), warning: typeof state.warning === 'string' ? state.warning : null };
  } catch (error) {
    return { limit: info.estimate, consumed: [], window: [], event: null, warning: error.code === 'ENOENT' ? null : '并发状态损坏，已按估算值恢复' };
  }
}
export function effectiveConcurrency(home, info, { consumeWarning = false } = {}) {
  if (info.mode !== 'auto') return { ...info, concurrencyAdjust: null };
  let state = concurrencyState(home, info);
  if (state.warning && consumeWarning) {
    const lock = join(home, 'concurrency-state.json.lock');
    let owned = false;
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      owned = true;
      state = concurrencyState(home, info);
      if (state.warning) {
        const temp = join(home, `concurrency-state.${randomUUID()}.tmp`);
        writeFileSync(temp, JSON.stringify({ ...state, warning: null }));
        renameSync(temp, join(home, 'concurrency-state.json'));
      }
    } catch { /* 无法恢复时保留警告。 */ }
    finally { if (owned) try { unlinkSync(lock); } catch {} }
  }
  return { ...info, adjusted: true, limits: { ...info.limits, concurrency: state.limit }, warnings: [...info.warnings, ...(state.warning ? [state.warning] : [])], concurrencyAdjust: state.event ?? null };
}
export async function adjustConcurrency(home, config, sample, options = {}) {
  const { slotLimits } = await import('./config.mjs');
  const info = slotLimits(config, options.probe);
  if (info.mode !== 'auto' || sample.event !== 'end' || !Number.isFinite(sample.at) || !Number.isFinite(sample.freeGb) || sample.freeGb < 0) return null;
  const file = join(home, 'concurrency-state.json'), lock = file + '.lock';
  let owned = false;
  try {
    mkdirSync(home, { recursive: true });
    const deadline = Date.now() + 900;
    do {
      try { writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' }); owned = true; break; }
      catch (error) {
        if (error.code !== 'EEXIST') return null;
        try { if (Date.now() - statSync(lock).mtimeMs > 10000) { unlinkSync(lock); continue; } } catch {}
        if (Date.now() >= deadline) return null;
        await delay(20);
      }
    } while (true);
    if (options.signal?.aborted) return null;
    const state = concurrencyState(home, info);
    const sampleKey = sample.sampleId ?? JSON.stringify([sample.id ?? null, sample.name ?? null, sample.at]);
    if (state.consumed.includes(sampleKey)) return null;
    const threshold = memLowThreshold(options.totalBytes ?? os.totalmem(), info.memLowPercent) / 1024 ** 3;
    const old = state.limit;
    const good = sample.freeGb > threshold + info.autoAdjustMemoryMarginGb && Number.isFinite(sample.cpu) && sample.cpu >= 0 && sample.cpu < info.autoAdjustCpuPercent;
    state.consumed = [...state.consumed, sampleKey].slice(-50);
    state.window.push(good);
    state.window = state.window.slice(-info.autoAdjustSamples);
    let reason = null;
    if (sample.freeGb < threshold && old > 1) { state.limit--; reason = '内存不足'; }
    else if (state.window.length === info.autoAdjustSamples && state.window.every(Boolean) && old < info.max) { state.limit++; reason = '资源充足'; }
    let event = null;
    if (reason) { event = { event: 'concurrency-adjust', old, new: state.limit, reason, at: sample.at, task: sample.name ?? null, taskId: sample.id ?? null }; state.window = []; state.event = event; }
    const temp = file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, JSON.stringify(state)); renameSync(temp, file);
    if (event) appendFileSync(join(home, 'runs.jsonl'), JSON.stringify({ v: 1, ...event }) + '\n');
    return event;
  } catch { return null; } finally { if (owned) try { unlinkSync(lock); } catch {} }
}
export const concurrencyAdjustLine = event => event ? `并发上限 ${event.old}→${event.new}（${event.reason}）` : null;
