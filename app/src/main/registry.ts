import { watch, type FSWatcher } from 'node:fs';
import { open, readFile, writeFile, appendFile, mkdir, rename, unlink, readdir, stat, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DeleteResult, Task, TaskAttempt } from '../shared/types';
import { commitFrom } from '../shared/markdown';
import { c } from '../shared/copy';
import { dispatchMatches, type Platform, type ProcessInfo } from './platform';
import type { ProcessCheck } from '../shared/types';
import { legacyRunsName } from '../../../core/lib/compat.mjs';
import { parseJson } from '../../../core/lib/json.mjs';
export function mergeLine(tasks: Map<string, Task>, line: string) {
    try {
        const e = JSON.parse(line);
        if ((e.v !== 1 && e.v !== 2) || typeof e.id !== 'string')
            return;
        if (e.event === 'start') {
            if (!['repo', 'name', 'progress', 'report'].every(k => typeof e[k] === 'string') || !Number.isFinite(e.started) || !Number.isFinite(new Date(e.started).getTime()) || !path.isAbsolute(e.repo) || !path.isAbsolute(e.progress) || !path.isAbsolute(e.report))
                return;
            const t: Task = { id: e.id, repo: e.repo, name: e.name, title: typeof e.title === 'string' ? e.title : e.name, spec: typeof e.spec === 'string' ? e.spec : null, role: typeof e.role === 'string' ? e.role : null, pid: Number.isSafeInteger(e.pid) && e.pid > 0 ? e.pid : 0, started: e.started, progress: e.progress, report: e.report, model: typeof e.model === 'string' ? e.model : null, effort: typeof e.effort === 'string' ? e.effort : null, tier: typeof e.tier === 'string' ? e.tier : null, status: 'run', last: '' };
            for (const key of ['raw', 'events', 'sandbox', 'agent', 'agentVersion'] as const)
                if (typeof e[key] === 'string')
                    t[key] = e[key];
            if (e.dispatcher && typeof e.dispatcher.host === 'string')
                t.dispatcher = { host: e.dispatcher.host, session: typeof e.dispatcher.session === 'string' ? e.dispatcher.session : null };
            t.managed = e.managed === true;
            // v1 的 start 行来自 DispatchDock 时期的旧任务：界面显示"旧任务"标签，状态仍按四态。
            t.legacy = e.v === 1;
            if (typeof e.profile === 'string') t.profile = e.profile;
            if (typeof e.adapter === 'string') t.adapter = e.adapter;
            if (typeof e.label === 'string') t.label = e.label;
            // 门禁（协议第 2 节）：gate 是布尔；base 是执行者开始时的提交。
            // 老记录没有这两个字段，任务对象保持与以前一致。
            if (typeof e.gate === 'boolean') t.gate = e.gate;
            if (typeof e.base === 'string') t.base = e.base;
            tasks.set(t.id, t);
        }
        else {
            const t = tasks.get(e.id);
            if (!t)
                return;
            if (e.event === 'spawned')
                t.agentPid = e.agentPid ?? e.codexPid;
            // 手动重试（协议 14.3 / 14.4）：resume 之后任务回到"进行中"——上一次的 exit / 中断标记 /
            // 门禁结果不再算最终；停止按钮与进程身份核对改用这次 resume 的 pid 与核对时刻（pidSince = resume.at，
            // started 保持最初的派发时刻）。之后写的新 end / interrupted 照常生效。字段不合法时整条忽略（同未知事件）。
            if (e.event === 'resume') {
                if (!Number.isSafeInteger(e.pid) || e.pid <= 0 || !Number.isFinite(e.at))
                    return;
                t.status = 'run';
                t.pid = e.pid;
                // 065：开始时间保持最初的派发时刻（started），核对时刻换成这次进程的 resume.at（pidSince）。
                t.pidSince = e.at;
                t.exit = undefined;
                t.ended = undefined;
                t.minutes = undefined;
                t.signal = undefined;
                t.agentExit = undefined;
                t.gateOk = undefined;
                t.gateSummary = undefined;
                t.gatingAt = undefined;
            }
            // 尝试记录（协议 14.2 / 14.3）：attempt 记开始信息，attempt-end 补上结果字段；
            // 当前尝试 = 最后一个 attempt。旧记录没有这些事件，任务对象与以前一致。
            if (e.event === 'attempt' && Number.isSafeInteger(e.n) && e.n > 0) {
                const item: TaskAttempt = { n: e.n, total: Number.isSafeInteger(e.total) ? e.total : null, profile: typeof e.profile === 'string' ? e.profile : null, reason: typeof e.reason === 'string' ? e.reason : '', at: Number.isFinite(e.at) ? e.at : 0 };
                t.attempts = [...(t.attempts ?? []), item];
                t.attempt = item;
            }
            if (e.event === 'attempt-end' && Number.isSafeInteger(e.n)) {
                const item = (t.attempts ?? []).find(a => a.n === e.n);
                if (item) {
                    item.ok = e.ok === true;
                    if (Number.isInteger(e.exit) || e.exit === null)
                        item.exit = e.exit;
                    if (typeof e.gate === 'boolean' || e.gate === null)
                        item.gate = e.gate;
                    if (e.usage && typeof e.usage === 'object')
                        item.usage = { input: Number.isFinite(e.usage.input) ? e.usage.input : null, output: Number.isFinite(e.usage.output) ? e.usage.output : null };
                    if (Number.isFinite(e.ms))
                        item.ms = e.ms;
                }
            }
            // 门禁开始：执行者结束后核心写 gating，随后写 gate 结果，最后才写 end。
            if (e.event === 'gating' && Number.isFinite(e.at))
                t.gatingAt = e.at;
            if (e.event === 'gate') {
                t.gateOk = e.ok === true;
                if (typeof e.summary === 'string')
                    t.gateSummary = e.summary;
            }
            if (e.event === 'end') {
                t.exit = Number.isInteger(e.exit) ? e.exit : null;
                t.ended = Number.isFinite(e.at) ? e.at : undefined;
                t.minutes = Number.isFinite(e.minutes) && e.minutes >= 0 ? e.minutes : undefined;
                if (Number.isInteger(e.agentExit))
                    t.agentExit = e.agentExit;
                t.status = t.exit === 0 ? 'done' : 'fail';
            }
            if (e.event === 'interrupted' && t.exit === undefined) {
                t.ended = Number.isFinite(e.at) ? e.at : undefined;
                t.signal = typeof e.signal==='string' ? e.signal : undefined;
                t.status = 'stop';
            }
        }
    }
    catch { /* 单行损坏不影响后续记录。 */ }
}
export function parseRegistry(text: string) { const tasks = new Map<string, Task>(); for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n'))
    mergeLine(tasks, line); return [...tasks.values()]; }
// 065：进程身份核对用的时刻——resume 之后是 pidSince（这次进程的时刻），否则是最初的 started。
export function matchTime(t: Task) { return t.pidSince ?? t.started; }
export function statusOf(t: Task, ps: ProcessInfo[]): Task['status'] { return t.exit !== undefined ? (t.exit === 0 ? 'done' : 'fail') : t.status === 'stop' ? 'stop' : dispatchMatches(ps.find(p => p.pid === t.pid), matchTime(t)) ? 'run' : 'stop'; }
// 017：记录目录名只允许是 .agent-runs 下的一层名字——不能为空、不能是 . / ..、
// 不能含路径分隔符或 `..`，也不能是盘符开头的绝对路径。
export function validRecordName(name: unknown): name is string {
    return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && name !== '.agent-runs' && !name.includes('..') && !/[\\/]/.test(name) && !name.includes('\0') && !/^[A-Za-z]:/.test(name);
}
export class RegistryReader {
    rows = new Map<string, Task>();
    private offset = 0;
    private identity = '';
    async read(file: string) {
        const h = await open(file, 'r').catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT')
            throw e; return null; });
        if (!h) {
            this.rows.clear();
            this.offset = 0;
            return [];
        }
        try {
            const s = await h.stat(), identity = `${s.ino}:${s.birthtimeMs}`;
            if (identity !== this.identity || s.size < this.offset) {
                this.rows.clear();
                this.offset = 0;
                this.identity = identity;
            }
            // 每次只保留尾部未完成的偏移，不缓存已读清单文本。
            while (this.offset < s.size) {
                const b = Buffer.alloc(Math.min(2 * 1024 * 1024, s.size - this.offset));
                await h.read(b, 0, b.length, this.offset);
                const end = b.lastIndexOf(10) + 1;
                if (!end)
                    break;
                for (const line of b.subarray(0, end).toString('utf8').split('\n'))
                    mergeLine(this.rows, line);
                this.offset += end;
            }
            return [...this.rows.values()].map(t => ({ ...t }));
        }
        finally {
            await h.close();
        }
    }
}
export async function tail(file: string, first = false) { try {
    const h = await open(file, 'r');
    try {
        const size = (await h.stat()).size, start = first ? 0 : Math.max(0, size - 65536), b = Buffer.alloc(Math.min(size, 65536));
        await h.read(b, 0, b.length, start);
        const text = b.toString('utf8');
        return start ? text.slice(text.indexOf('\n') + 1) : text;
    }
    finally {
        await h.close();
    }
}
catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return '';
    throw e;
} }
export async function reportText(file: string) { try {
    return await readFile(file, 'utf8');
}
catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return '';
    throw e;
} }
export async function importTasks(folder: string): Promise<Task[]> {
    // 导入旧任务：v1 记录目录（compat.legacyRunsName）里的平铺文件。
    const repo = path.basename(folder) === legacyRunsName ? path.dirname(folder) : folder, dir = path.join(repo, legacyRunsName);
    const tasks: Task[] = [];
    for (const file of await readdir(dir)) {
        if (!file.endsWith('.progress.log'))
            continue;
        const progress = path.join(dir, file), head = (await tail(progress, true)).split('\n')[0], m = head.match(/^=== Codex 开始：(.*?)\s{2}(\d{4})\/(\d+)\/(\d+)\s+(?:(上午|下午))?(\d+):(\d+):(\d+) ===\r?$/);
        if (!m)
            continue;
        let hour = +m[6];
        if (m[5] === '下午' && hour < 12)
            hour += 12;
        if (m[5] === '上午' && hour === 12)
            hour = 0;
        const started = new Date(+m[2], +m[3] - 1, +m[4], hour, +m[7], +m[8]).getTime(), name = file.slice(0, -13), end = (await tail(progress)).trimEnd().match(/=== Codex 结束：exit=(null|-?\d+)，用时 ([\d.]+) 分钟[^\n]*===$/);
        const exit = end ? (end[1] === 'null' ? null : +end[1]) : undefined, minutes = end ? +end[2] : undefined;
        tasks.push({ id: 'import-' + createHash('sha256').update(`${repo}\0${name}\0${started}`).digest('hex').slice(0, 24), repo, name, title: m[1].replace(/（角色：.*）$/, ''), role: m[1].match(/（角色：(.*)）$/)?.[1] ?? null, spec: null, pid: 0, started, progress, report: path.join(dir, name + '.md'), model: null, effort: null, tier: null, last: '', status: end ? (exit === 0 ? 'done' : 'fail') : 'stop', exit, minutes, ended: end ? started + minutes! * 60000 : (await stat(progress)).mtimeMs, imported: true });
    }
    return tasks;
}
export class Registry {
    tasks: Task[] = [];
    private readers = new Map<string, RegistryReader>();
    private sources = new Map<string, string>();
    private imports: Task[] = [];
    private hidden = new Set<string>();
    private watchers: FSWatcher[] = [];
    private signature = '';
    private timer?: ReturnType<typeof setTimeout>;
    private fallback?: ReturnType<typeof setInterval>;
    private work?: Promise<void>;
    private again?: Promise<void>;
    private ready = false;
    private closed = false;
    private missingSince = new Map<string, number>();
    // 进程查询的结果（快照里带给界面）：失败时 ok=false，保留错误文字、首次失败时刻与连续失败次数。
    processCheck: ProcessCheck = { ok: true, failures: 0 };
    private mutations: Promise<unknown> = Promise.resolve();
    constructor(readonly home: string, readonly data: string, readonly platform: Platform, private changed: (tasks: Task[]) => void, private finished: (t: Task) => void, private error: (e: unknown) => void, readonly legacyHome = home) { }
    get file() { return path.join(this.home, 'runs.jsonl'); }
    // 新清单（AgentRouter）与旧清单（DispatchDock 的 codex-dispatch 公共目录）；测试隔离时两者相同。
    get files() { return [...new Set([this.file, path.join(this.legacyHome, 'runs.jsonl')])]; }
    // dir 是否是看板上某个任务的记录目录（progress.log 所在目录，与 detail 通道的写法一致）；
    // 比较按 Windows 不区分大小写。看板任务的仓库不一定登记过，所以不看项目登记表。
    knownRunDir(dir: string): boolean {
        const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
        const wanted = norm(dir);
        return this.tasks.some(t => norm(path.dirname(t.progress)) === wanted);
    }
    private async readAll() {
        const rows: Task[] = [];
        for (const file of this.files) {
            if (!this.readers.has(file)) this.readers.set(file, new RegistryReader());
            for (const t of await this.readers.get(file)!.read(file)) { this.sources.set(t.id, file); rows.push(t); }
        }
        return rows;
    }
    private key(t: Task) { return `${t.id}:${t.started}`; }
    async start() {
        await mkdir(this.home, { recursive: true });
        await mkdir(this.data, { recursive: true });
        const saved = await reportText(path.join(this.data, 'tasks.json'));
        if (saved) {
            const v = parseJson(saved);
            this.imports = Array.isArray(v.imports) ? v.imports.flatMap((value:Task)=>{
                if(!value?.imported||!['done','fail','stop'].includes(value.status))return [];
                const task=parseRegistry(JSON.stringify({...value,v:1,event:'start',pid:0})+'\n')[0];
                if(!task)return [];
                task.imported=true;task.status=value.status;
                task.exit=value.status==='done'?0:value.status==='fail'?(Number.isInteger(value.exit)?value.exit:null):undefined;
                task.ended=Number.isFinite(value.ended)?value.ended:undefined;
                task.minutes=Number.isFinite(value.minutes)&&value.minutes!>=0?value.minutes:undefined;
                return [task];
            }) : [];
            this.hidden = new Set(Array.isArray(v.hidden)?v.hidden.filter((key:unknown)=>typeof key==='string'):[]);
        }
        await this.refresh();
        this.ready = true;
        await this.viewer();
        this.fallback = setInterval(() => void this.refresh().catch(this.error), 2000);
    }
    // 正在读取时又有新的刷新请求：排一次后续读取，保证调用之后写入的行一定会被读到。
    refresh(): Promise<void> { if (this.work)
        return this.again ??= this.work.catch(() => {}).then(() => { this.again = undefined; return this.refresh(); }); const refreshStarted = Date.now(); this.work = this.refreshOnce().finally(() => { this.onPhase?.(`refresh ${Date.now() - refreshStarted} ms`); this.work = undefined; }); return this.work; }
    // 进程查询：一次刷新里最多试 3 次（间隔 0 / 300 / 1000 ms）；都失败就返回 null，由调用方按"未知"处理，不抛出。
    // 之后靠每 2 秒的定时刷新继续重试，没有额外的无限循环。
    private async checkProcesses(pids: number[]): Promise<ProcessInfo[] | null> {
        if (!pids.length) { this.processCheck = { ok: true, failures: 0 }; return []; }
        let last: unknown;
        for (const delay of [0, 300, 1000]) {
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
            if (this.closed) return null;
            try { const ps = await this.platform.processes(pids); this.processCheck = { ok: true, failures: 0 }; return ps; }
            catch (error) { last = error; }
        }
        const failures = this.processCheck.failures + 1;
        this.processCheck = { ok: false, error: last instanceof Error ? last.message : String(last), since: this.processCheck.since ?? Date.now(), failures };
        return null;
    }
    private async refreshOnce() {
        if (this.closed)
            return;
        const rows = await this.readAll(), ps = await this.checkProcesses(rows.filter(t => t.status === 'run' && t.pid).map(t => t.pid));
        for (const t of rows) {
            // 进程查询失败：记录里没有结束的任务保留最后已知状态（没有就算进行中）并标"未知"，不推进宽限计时、不推断结束。
            if (ps === null) {
                if (t.status === 'run') {
                    const previous = this.tasks.find(x => x.id === t.id);
                    if (previous && previous.status !== 'run') { t.status = previous.status; t.ended = previous.ended; }
                    else t.processState = 'unknown';
                }
                continue;
            }
            // 查询成功：清掉上一次留下的"未知"标记（读取到的行可能是缓存里的同一个对象）。
            delete t.processState;
            const status = statusOf(t, ps);
            if (t.status === 'run' && status === 'stop') {
                const since = this.missingSince.get(t.id) ?? Date.now();
                this.missingSince.set(t.id, since);
                // 到达宽限期后再次读取，避免平台查询期间刚写入的终止记录被遗漏。
                if (Date.now() - since >= 3000) {
                    const latest = (await this.readAll()).find(row => row.id === t.id);
                    if (latest && latest.status !== 'run') {
                        Object.assign(t, latest);
                        this.missingSince.delete(t.id);
                    } else t.status = 'stop';
                } else t.status = 'run';
            } else {
                this.missingSince.delete(t.id);
                t.status = status;
            }
            if (t.status === 'stop' && !t.ended)
                t.ended = this.tasks.find(x => x.id === t.id)?.ended ?? Date.now();
        }
        const identities = new Set(rows.map(t => `${t.repo.toLowerCase()}:${t.name}:${Math.floor(t.started / 1000)}`));
        const next = [...rows, ...this.imports.filter(t => !identities.has(`${t.repo.toLowerCase()}:${t.name}:${Math.floor(t.started / 1000)}`))].filter(t => t.status === 'run' || !this.hidden.has(this.key(t))).sort((a, b) => b.started - a.started);
        for (const t of next) {
            t.last = (await tail(t.progress)).trimEnd().split('\n').at(-1)?.replace(/^\[.*?\]\s*/, '') ?? '';
            t.commit = commitFrom(await reportText(t.report));
            t.hasReport = await stat(t.report).then(s => s.isFile(), () => false);
        }
        if (this.ready)
            for (const t of next)
                if (t.status !== 'run' && this.tasks.find(x => x.id === t.id)?.status === 'run')
                    this.finished(t);
        if (this.closed)
            return;
        const different = JSON.stringify(this.tasks) !== JSON.stringify(next);
        this.tasks = next;
        if (different)
            this.changed(next);
        const dirs = [...new Set([this.home, this.legacyHome, ...next.map(t => path.dirname(t.progress))])].sort(), signature = dirs.join('\0');
        if (signature !== this.signature) {
            this.watchers.forEach(w => w.close());
            this.watchers = [];
            this.signature = signature;
            for (const dir of dirs)
                try {
                    const w = watch(dir, () => { clearTimeout(this.timer); this.timer = setTimeout(() => void this.refresh().then(() => this.changed(this.tasks)).catch(this.error), 200); });
                    w.on('error', e => { this.signature = ''; this.error(e); });
                    this.watchers.push(w);
                }
                catch {
                    this.signature = '';
                }
        }
    }
    async viewer() { await writeFile(path.join(this.home, 'viewer.json'), JSON.stringify({ app: 'AgentRouter', pid: process.pid, suppressWatchWindow: true, acceptsManaged: true, updated: Date.now() })); }
    // 诊断钩子：验收时由主进程接上，记录串行队列与 refresh 的耗时；平时为空，不影响行为。
    onPhase?: (label: string) => void;
    private serial<T>(fn: () => Promise<T>, label = '串行操作'): Promise<T> {
        const queued = Date.now();
        this.onPhase?.(`${label} 入队`);
        const p = this.mutations.then(async () => {
            const started = Date.now();
            this.onPhase?.(`${label} 出队（排队 ${started - queued} ms）`);
            try { return await fn(); }
            finally { this.onPhase?.(`${label} 结束（执行 ${Date.now() - started} ms）`); }
        });
        this.mutations = p.catch(() => { });
        return p;
    }
    private async save() { const file = path.join(this.data, 'tasks.json'); await writeFile(file + '.tmp', JSON.stringify({ imports: this.imports, hidden: [...this.hidden] })); await rename(file + '.tmp', file); }
    import(folder: string) { return this.serial(async () => { const incoming = await importTasks(folder); this.imports = [...new Map([...this.imports, ...incoming].map(t => [t.id, t])).values()]; await this.save(); await this.refresh(); }); }
    // 用户看到的仍是"任务状态已经变了"；日志里记下操作、任务、当时状态和具体哪一项核对没通过，便于排查。
    private stateChanged(action: string, id: string, t: Task | undefined, reason: string) {
        console.warn(`任务状态已经变了：${action} ${id}（当时状态 ${t ? t.status : '不在列表'}，pid=${t?.pid ?? '无'}）：${reason}`);
        return Error(c.changed);
    }
    hide(id: string) { return this.serial(async () => { await this.refresh(); const t = this.tasks.find(t => t.id === id); if (!t || t.status === 'run')
        throw this.stateChanged('隐藏', id, t, t ? '任务仍在进行' : '找不到任务'); const ps = t.pid ? await this.platform.processes([t.pid]) : []; if (dispatchMatches(ps[0], matchTime(t)))
        throw this.stateChanged('隐藏', id, t, '派发进程仍然存活'); this.hidden.add(this.key(t)); await this.save(); await this.refresh(); }); }
    // 017：批量从列表删除（可选同时删除项目里的任务记录目录）。渲染层只传 id，
    // 路径一律从这里已读取的任务导出；runs.jsonl 不改，删除沿用 hidden。
    deleteTasks(ids: string[], files: boolean): Promise<DeleteResult> {
        return this.serial(async () => {
            await this.refresh();
            const result: DeleteResult = { deleted: 0, failed: 0, filesLeft: 0 };
            const targets: Task[] = [];
            // 与 hide() 相同的核对：仍在进行或找不到的任务跳过并计入失败。
            for (const id of new Set(ids)) {
                const t = this.tasks.find(x => x.id === id);
                if (!t || t.status === 'run') { result.failed++; continue; }
                targets.push(t);
            }
            const pids = targets.filter(t => t.pid).map(t => t.pid);
            const ps = pids.length ? await this.platform.processes(pids) : [];
            const removable = targets.filter(t => {
                if (t.pid && dispatchMatches(ps.find(p => p.pid === t.pid), matchTime(t))) { result.failed++; return false; }
                return true;
            });
            // 一次写入 hidden，不逐条保存。
            for (const t of removable) this.hidden.add(this.key(t));
            result.deleted = removable.length;
            if (removable.length) await this.save();
            if (files) for (const t of removable) {
                // 导入的旧任务没有 .agent-runs/<记录名>/ 这种目录，跳过且不算失败。
                if (t.imported) continue;
                const dir = await this.recordDir(t);
                if (dir === undefined) continue;
                if (dir === null) { result.filesLeft++; continue; }
                const removing = Date.now();
                try { await rm(dir, { recursive: true }); this.onPhase?.(`删除记录目录 ${Date.now() - removing} ms`); }
                catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') result.filesLeft++; }
            }
            await this.refresh();
            return result;
        }, 'delete');
    }
    // 记录目录校验：返回 undefined 表示没有可删的目录（不存在 / 仓库不可读），null 表示校验没通过。
    // 仓库必须是绝对路径；记录名合法；解析后必须仍在 <仓库>/.agent-runs/ 内，且不是 .agent-runs 本身。
    // .agent-runs 必须是仓库里的真实目录（不接受指向别处的链接），记录目录本身也不能是链接。
    private async recordDir(t: Task): Promise<string | null | undefined> {
        if (!path.isAbsolute(t.repo) || !validRecordName(t.name)) return null;
        const repoReal = await realpath(t.repo).catch(() => null);
        if (!repoReal) return undefined;
        const expected = path.join(repoReal, '.agent-runs');
        const baseReal = await realpath(expected).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
        if (!baseReal) return undefined;
        // 用 path.relative 判等，Windows 上不区分大小写；.agent-runs 自身是链接时这里不等。
        if (path.relative(baseReal, expected) !== '') return null;
        const dir = path.join(expected, t.name);
        const rel = path.relative(expected, dir);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || /[\\/]/.test(rel)) return null;
        const info = await lstat(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
        if (!info) return undefined;
        if (!info.isDirectory() || info.isSymbolicLink()) return null;
        const dirReal = await realpath(dir).catch(() => null);
        if (!dirReal) return undefined;
        const realRel = path.relative(baseReal, dirReal);
        if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel) || /[\\/]/.test(realRel)) return null;
        return dirReal;
    }
    // 清空任务列表（018）：一次把所有已结束任务（含旧版本导入的任务）的键加入 hidden 并只保存一次；
    // 进行中的任务与派发进程仍存活的不动。不改 runs.jsonl，不删任何文件。
    hideFinished() { return this.serial(async () => { await this.refresh(); const candidates = this.tasks.filter(t => t.status !== 'run'); const ps = await this.platform.processes(candidates.filter(t => t.pid).map(t => t.pid)); let removed = 0; for (const t of candidates) {
        if (t.pid && dispatchMatches(ps.find(p => p.pid === t.pid), matchTime(t)))
            continue;
        this.hidden.add(this.key(t));
        removed++;
    } if (removed)
        await this.save(); await this.refresh();
 return { removed }; }); }
    // 重新读取 tasks.json 里保存的 hidden（018）：验收在清空任务列表检查后把清单状态恢复成检查前的内容
    // （与 UI02 临时改写 runs.jsonl 同类的夹具做法），hidden 在 start() 之后只在内存里，恢复文件后还要对齐一次。
    async reloadHidden() {
        await this.serial(async () => {
            const saved = await reportText(path.join(this.data, 'tasks.json'));
            const v = saved ? parseJson(saved) : {};
            this.hidden = new Set(Array.isArray(v.hidden) ? v.hidden.filter((key: unknown) => typeof key === 'string') : []);
            await this.refresh();
        });
    }
    stop(id: string) {
        return this.serial(async () => {
            await this.refresh();
            const t = this.tasks.find(t => t.id === id);
            if (!t || t.imported || t.status !== 'run' || !t.pid)
                throw this.stateChanged('停止', id, t, !t ? '找不到任务' : t.imported ? '导入的旧任务' : t.status !== 'run' ? '任务已不在进行中' : '没有 pid');
            // 065（协议第 9 节）：软件的停止与 ar stop 同规则——进程查询失败（抛错，或没有结果但 PID 仍存活）
            // 间隔约 1 秒重试，最多共查 3 次；仍失败就报"无法核对进程"，不结束任何进程、不写 interrupted。
            let ps: ProcessInfo[] | null = null, lastQueryError = '';
            for (let attempt = 1; attempt <= 3; attempt++) {
                if (attempt > 1) await new Promise(resolve => setTimeout(resolve, 1000));
                try {
                    const rows = await this.platform.processes([t.pid]);
                    const found = rows.find(p => p.pid === t.pid);
                    if (found || !this.platform.alive || !this.platform.alive(t.pid)) { ps = rows; break; }
                    lastQueryError = '查询没有结果但 PID 仍然存活';
                } catch (error) { lastQueryError = error instanceof Error ? error.message : String(error); }
            }
            if (ps === null) {
                const message = `停止：${t.name} 无法核对进程（进程查询失败：${lastQueryError}），没有结束任何进程`;
                console.warn(`任务状态已经变了：停止 ${id}（当时状态 ${t.status}，pid=${t.pid}）：${message}`);
                throw new Error(message);
            }
            const pre = ps;
            if (!dispatchMatches(pre.find(p => p.pid === t.pid), matchTime(t)))
                throw this.stateChanged('停止', id, t, pre.length ? '进程身份与派发时不一致（可能 PID 被复用）' : '派发进程已经不在了');
            await this.platform.killTree(t.pid);
            // 065 B：结束进程树返回后再确认派发进程真正退出（最多等 10 秒）才写 interrupted；
            // 查询失败、或没有结果但 PID 仍存活时按"还没确认"继续等，到时限仍未确认就拒绝。
            const deadline = Date.now() + 10000;
            let lastReason = '结束进程树后派发进程仍然存活';
            for (;;) {
                let gone = false;
                try {
                    const after = await this.platform.processes([t.pid]);
                    const stillThere = after.some(p => pre.some(old => old.pid === p.pid && old.created === p.created));
                    if (stillThere) lastReason = '结束进程树后派发进程仍然存活';
                    // 同 PID 但创建时间变了（PID 被复用）按已经退出；没有结果时要本地存活也为假才算确认。
                    else if (after.some(p => p.pid === t.pid)) gone = true;
                    else if (!this.platform.alive || !this.platform.alive(t.pid)) gone = true;
                    else lastReason = '查询没有结果但 PID 仍然存活（派发进程还没退出）';
                } catch (error) { lastReason = `无法核对进程（进程查询失败：${error instanceof Error ? error.message : String(error)}）`; }
                if (gone) break;
                if (Date.now() >= deadline) throw this.stateChanged('停止', id, t, lastReason);
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            await appendFile(this.sources.get(id) ?? this.file, '\n' + JSON.stringify({ v: 1, event: 'interrupted', id, signal: 'stopped-by-app', at: Date.now() }) + '\n');
            await this.refresh();
        });
    }
    async close() { this.closed = true; clearTimeout(this.timer); clearInterval(this.fallback); this.watchers.forEach(w => w.close()); await this.work?.catch(() => { }); await this.mutations; const file = path.join(this.home, 'viewer.json'); try {
        if (parseJson(await readFile(file, 'utf8')).pid === process.pid)
            await unlink(file);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            this.error(e);
    } }
}
