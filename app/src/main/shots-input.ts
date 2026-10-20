import type { BrowserWindow } from 'electron';
import { nativeTheme } from 'electron';
import assert from 'node:assert/strict';
import { effects } from './effects';
import { performance } from 'node:perf_hooks';

// 等待一律按单调时钟的真实截止时刻判断（PR #5：原来按轮询次数计时，每次检查本身的耗时会把实际等待拉长，曾出现实际 11.7 秒仍通过 10 秒的等待）。
// 条件必须在截止前被观察到成立：某次检查本身很慢、返回"成立"时已过截止，也算超时。上限数值与原来相同。
export const clock = () => performance.now();
export async function pollUntil(test: () => unknown, timeoutMs: number, intervalMs = 100): Promise<{ ok: boolean; elapsed: number }> {
    const start = clock(), deadline = start + timeoutMs;
    while (true) {
        const value = await test(), at = clock();
        if (value && at <= deadline) return { ok: true, elapsed: at - start };
        if (at >= deadline) return { ok: false, elapsed: at - start };
        await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - at))));
    }
}
import { spawn } from 'node:child_process';

// 主进程记下的核心调用与任务操作（effects.ipcLog），从某个序号之后逐条列出：名称、用时、成败；还没返回的标"未返回（已等多久）"。
export function ipcReport(afterSeq: number, now = Date.now(), withStart = false) {
    const rows = effects.ipcLog.filter(e => e.seq > afterSeq);
    if (!rows.length) return '（这段时间主进程没有收到核心调用或任务操作）';
    return rows.map(e => `#${e.seq} ${e.channel}:${e.name}${withStart ? ` @-${now - e.start}ms` : ''} ${e.end === undefined ? `未返回（已等 ${now - e.start} ms）` : `${e.end - e.start} ms ${e.ok ? '成功' : '失败：' + e.error}`}`).join('；');
}
export const ipcSeq = () => effects.ipcLog.length;
// 瞬时 CPU：隔约 1 秒对每个进程各读两次累计 CPU 时间，每次读数各自计时；差值 ÷ 该进程自己的时间窗 ÷ 核数 = 这段时间里它占全部 CPU 的百分比。
// （早先用两次枚举之间的总间隔做分母，枚举本身慢时会把占用放大，合计超过 100%；已改。）各进程合计不应超过 100%，读不到的受保护进程计入 unreadable。
// 前几名里：svchost 列出它承载的系统服务名；electron 从命令行分出软件主进程（没有 --type）、渲染 / GPU / 工具进程、核心进程（ar.mjs）。
// 用异步子进程执行，不阻塞主进程；结果里带诊断本身的用时。只在诊断时调用。
const CPU_SCRIPT = [
    '$cores=[Environment]::ProcessorCount',
    '$sw=[Diagnostics.Stopwatch]::StartNew()',
    '$a=@{}; foreach($p in [Diagnostics.Process]::GetProcesses()){ try { $a[$p.Id]=@($p.TotalProcessorTime.TotalMilliseconds,$sw.Elapsed.TotalMilliseconds,$p.ProcessName) } catch {} }',
    '$enum1=$sw.Elapsed.TotalMilliseconds; Start-Sleep -Milliseconds 1000',
    '$rows=@(); foreach($p in [Diagnostics.Process]::GetProcesses()){ if($a.ContainsKey($p.Id)){ try { $c=$p.TotalProcessorTime.TotalMilliseconds; $t=$sw.Elapsed.TotalMilliseconds; $o=$a[$p.Id]; $dt=$t-$o[1]; if($dt -gt 0){ $rows+=[pscustomobject]@{N=$o[2];I=$p.Id;P=[math]::Round(($c-$o[0])/$dt/$cores*100,1);W=[math]::Round($dt)} } } catch {} } }',
    '$enum2=$sw.Elapsed.TotalMilliseconds-1000-$enum1; $sum=($rows | Measure-Object -Property P -Sum).Sum',
    '"cores={0} sum={1:N1}% (each process over its own window) enum1={2:N0}ms enum2={3:N0}ms unreadable={4}" -f $cores,$sum,$enum1,$enum2,($a.Count-$rows.Count)',
    '$rows | Sort-Object P -Descending | Select-Object -First 10 | ForEach-Object { $role=""; if ($_.N -eq "svchost") { $role=" services=" + ((Get-CimInstance Win32_Service -Filter ("ProcessId=" + $_.I) | ForEach-Object Name) -join ",") } elseif ($_.N -eq "electron") { $cl=(Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_.I)).CommandLine; if ($cl -match "ar\\.mjs") { $role=" role=core" } elseif ($cl -match "--type=(\\S+)") { $role=" role=" + $Matches[1] } else { $role=" role=main" } }; "{0}#{1} {2}% window={3}ms{4}" -f $_.N,$_.I,$_.P,$_.W,$role }',
].join('; ');
export function cpuNow(): Promise<string> {
    if (process.platform !== 'win32') return Promise.resolve('（非 Windows，跳过）');
    const started = Date.now();
    return new Promise(resolve => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CPU_SCRIPT], { windowsHide: true, shell: false });
        let out = '', err = '';
        const timer = setTimeout(() => child.kill(), 20000);
        child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
        child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
        child.on('error', error => { clearTimeout(timer); resolve(`采样失败：${error.message}（诊断本身用时 ${Date.now() - started} ms）`); });
        child.on('close', () => { clearTimeout(timer); resolve(`${(out || err).trim().split(/\r?\n/).join('；')}（诊断本身用时 ${Date.now() - started} ms，异步执行、不阻塞主进程）`); });
    });
}
export const coreSeq = () => effects.coreLog.length;
// 其他诊断模块（运行期探针）登记的附加报告：等待超时时一并打印。
export const extraReports: ((windowMs: number) => string)[] = [];
// 最近一段时间（默认 30 秒）里开始的核心调用与核心进程，用在任何等待超时的诊断里。
export function recentReport(windowMs = 30000, now = Date.now()) {
    const ipcFrom = (effects.ipcLog.find(e => e.start >= now - windowMs)?.seq ?? effects.ipcLog.length + 1) - 1;
    const coreFrom = (effects.coreLog.find(e => e.requested >= now - windowMs)?.seq ?? effects.coreLog.length + 1) - 1;
    const registry = effects.registryLog.filter(e => e.at >= now - windowMs && !/^refresh \d+ ms$/.test(e.label) || e.at >= now - windowMs && /^refresh (\d+) ms$/.test(e.label) && Number(e.label.match(/\d+/)![0]) > 200)
        .map(e => `${e.label} @-${now - e.at}ms`).join('；') || '（无）';
    return `最近 ${windowMs / 1000} 秒的核心调用（@ 为开始时刻距现在）：${ipcReport(ipcFrom, now, true)}\n最近 ${windowMs / 1000} 秒的核心进程：${coreReport(coreFrom, now)}\n最近 ${windowMs / 1000} 秒的 Registry 阶段（refresh 只列超过 200 ms 的）：${registry}${extraReports.map(r => '\n' + r(windowMs)).join('')}`;
}
// 核心进程的阶段：启动用了多久（请求 → spawn）、运行到第一次输出、到退出；还没退出的标出已等多久。
export function coreReport(afterSeq: number, now = Date.now()) {
    const rows = effects.coreLog.filter(e => e.seq > afterSeq);
    if (!rows.length) return '（这段时间没有启动核心进程）';
    // 慢（超过 2 秒）或还没退出的进程，附上核心内部的完整追踪（AR_CORE_TRACE），时刻分三类：
    // 父进程观察：主进程看到的 spawn / 收到最早追踪标记 / stdout / stderr / exit / close，都相对请求；
    // 子进程内部：追踪行的 +ms（子进程自己的 performance 时间原点），时钟起点用"最早标记的墙上时刻 − 它的 +ms"对齐到请求；
    // 输出传输：追踪行写出的 @墙上时刻 → 主进程收到这一行；"写出标准输出"标记 → 主进程收到第一块 stdout。
    // 一行追踪都没收到时只能说"最早可观测追踪标记未收到"：子进程可能没执行到、也可能写了但还没送到主进程。
    type Row = typeof rows[number];
    const rel = (at?: number, e?: Row) => at === undefined || !e ? '—' : `+${at - e.requested}ms`;
    const wallOf = (l?: string) => { const at = l?.match(/@(\d+)/)?.[1]; return at ? Number(at) : undefined; };
    const selfOf = (l?: string) => { const at = l?.match(/^\+(\d+)ms/)?.[1]; return at ? Number(at) : undefined; };
    const slow = (e: Row) => e.exited === undefined || e.exited - e.requested > 2000;
    const observed = (e: Row) => `父进程观察（相对请求）spawn ${rel(e.spawned, e)}，收到最早追踪标记 ${rel(e.traceAt?.[0], e)}，stdout 首 / 末 / 结束 ${rel(e.firstOutput, e)} / ${rel(e.lastOutput, e)} / ${rel(e.stdoutEnd, e)}，stderr 首 ${rel(e.firstStderr, e)}，exit ${rel(e.exitEvent, e)}，close ${e.exited === undefined ? `未 close（已等 ${now - e.requested} ms）` : rel(e.exited, e) + ' code=' + e.code}`;
    const detail = (e: Row) => {
        const tr = e.trace ?? [], got = e.traceAt ?? [];
        if (!tr.length) return `${observed(e)}；最早可观测追踪标记未收到（${e.exited === undefined ? `已等 ${now - e.requested} ms` : '进程已结束'}，${e.firstStderr === undefined ? '标准错误没有收到任何数据' : '标准错误有数据但没有追踪行'}）`;
        const w0 = wallOf(tr[0]), s0 = selfOf(tr[0]), end = tr.find(l => l.includes('命令结束')), out = tr.find(l => l.includes('写出标准输出'));
        const lags = tr.map((l, i) => (got[i] ?? NaN) - (wallOf(l) ?? NaN));
        const worst = lags.reduce((m, v, i) => v > lags[m] ? i : m, 0);
        const shown = tr.map((l, i) => `${l.replace(/ @\d+/, '')}${lags[i] > 50 ? `（收到晚 ${lags[i]}ms）` : ''}`);
        const full = shown.length > 200 ? [...shown.slice(0, 100), `……中间省略 ${shown.length - 200} 行……`, ...shown.slice(-100)] : shown;
        const inner = `子进程内部（子进程自己的时钟）：时钟起点相对请求 ${w0 !== undefined && s0 !== undefined ? `+${w0 - s0 - e.requested}ms` : '—'}，起点到最早标记 ${s0 ?? '—'}ms，最早标记到命令结束 ${end && s0 !== undefined ? `${selfOf(end)! - s0}ms` : '未到'}`;
        const transfer = `输出传输：追踪行 写出→收到 最大 ${Number.isFinite(lags[worst]) ? lags[worst] : '—'}ms（第 ${worst + 1} 行），标准输出 写出→收到首块 ${wallOf(out) !== undefined && e.firstOutput !== undefined ? `${e.firstOutput - wallOf(out)!}ms` : '—'}、→结束 ${wallOf(out) !== undefined && e.stdoutEnd !== undefined ? `${e.stdoutEnd - wallOf(out)!}ms` : '—'}`;
        const exit = `退出：命令结束（子进程墙上）→ 父进程 exit ${wallOf(end) !== undefined && e.exitEvent !== undefined ? `${e.exitEvent - wallOf(end)!}ms` : '—'}（含子进程退出清理与系统通知，不能再细分）`;
        return `${observed(e)}；${inner}；${transfer}；${exit}；完整追踪 ${tr.length} 行：${full.join(' → ')}`;
    };
    return rows.map(e => slow(e)
        ? `#${e.seq} ar ${e.args}：${detail(e)}`
        : `#${e.seq} ar ${e.args}：${(e.exited ?? now) - e.requested} ms code=${e.code}`).join('；');
}

// 界面验收的真实输入助手：先做命中测试，再用 webContents.sendInputEvent 发系统级鼠标/键盘事件，
// 与人手操作走同一条路。被遮挡、不可见、已禁用、键盘到不了的控件都会让检查失败。
export interface Harness {
    pause: (ms?: number) => Promise<void>;
    evaluate: (expression: string) => Promise<any>;
    wait: (expression: string, label?: string, timeoutMs?: number) => Promise<void>;
    check: (label: string, expression: string) => Promise<void>;
    within: (label: string, expression: string, limitMs: number) => Promise<number>;
    happened: (label: string, fn: () => boolean, limitMs: number) => Promise<number>;
    verify: (label: string, fn: () => Promise<void> | void) => Promise<void>;
    press: (selector: string) => Promise<void>;
    key: (keyCode: string, modifiers?: Electron.InputEvent['modifiers']) => Promise<void>;
    type: (selector: string, text: string) => Promise<void>;
    tabTo: (selector: string, max?: number) => Promise<void>;
    focusRing: (label: string) => Promise<void>;
    wheel: (selector: string, deltaY: number) => Promise<void>;
    hits: (selector: string) => Promise<{ x: number; y: number } | { error: string }>;
    save: (name: string) => Promise<void>;
    audit: (page: string, prepare: () => Promise<void>) => Promise<void>;
    checks: string[];
    consoleErrors: string[];
}

// 当前这次验收已经通过的检查（失败时由 capture 打印完成范围，PR #5 CI 环境实验要比较各组实际跑到哪里）。
export const progress = { checks: [] as string[] };
export function createHarness(win: BrowserWindow, save: (name: string) => Promise<void>): Harness {
    const checks: string[] = [], consoleErrors: string[] = [];
    progress.checks = checks;
    win.webContents.on('console-message', event => { if (event.level === 'error') consoleErrors.push(event.message); });
    const pause = (ms = 300) => new Promise<void>(resolve => setTimeout(resolve, ms));
    // 最近一次真实输入（鼠标或键盘）的时刻：within 的用时与时间标准都从这里算起（press 之后固定停的 300 ms 也计入）。
    let lastInput = clock();
    const evaluate = async (expression: string) => {
        try { return await win.webContents.executeJavaScript(expression); }
        catch (error) { throw Error(`验收表达式失败：${expression}（${error instanceof Error ? error.message : String(error)}）`, { cause: error }); }
    };
    // 默认最多等约 10 秒；个别跨进程操作（如停止要先用 PowerShell 核对进程）可以单独给更长的上限。
    const wait = async (expression: string, label = expression, timeoutMs = 10000) => {
        if ((await pollUntil(() => evaluate(expression), timeoutMs)).ok) return;
        // busy 只是禁用按钮的个数，不能说明是哪个操作卡住：同时列出每个禁用按钮的 data 属性与文字。
        // busy 只是禁用按钮的个数，不能说明是哪个操作卡住：列出每个禁用按钮的 data 属性与文字；另看失败横幅在不在、看不看得见，以及渲染层追踪的最后 30 条事件。
        const state = await evaluate(`JSON.stringify({
            text: document.body.innerText.slice(0, 300), active: document.activeElement?.outerHTML.slice(0, 120),
            selected: document.querySelector('.trow.on')?.dataset.task ?? null,
            disabledButtons: [...document.querySelectorAll('button[disabled]')].map(b => Object.keys(b.dataset).join(',') + '「' + (b.textContent || '').trim().slice(0, 20) + '」'),
            failBanners: [...document.querySelectorAll('.banner.fail')].map(b => { const r = b.getBoundingClientRect(); return (b.textContent || '').trim().slice(0, 40) + '（' + Math.round(r.width) + '×' + Math.round(r.height) + '，display=' + getComputedStyle(b).display + '）'; }),
            bannerHolder: (document.querySelector('.detail .banner-holder')?.innerHTML ?? '（没有详情横幅区）').slice(0, 160),
            processBanner: (document.querySelector('[data-process-banner]')?.innerHTML ?? '（没有进程横幅区）').slice(0, 160),
            trace: (window.__arTrace ?? []).slice(-30).map(e => [e.event, ...Object.entries(e).filter(([k]) => k !== 'event' && k !== 'at').map(([k, v]) => k + '=' + String(v).slice(0, 200))].join(' ') + ' @' + e.at) })`);
        throw Error(`界面等待超时：${label}（${timeoutMs} ms）
当前界面：${state}
${recentReport(Math.max(30000, timeoutMs + 5000))}
此刻的 CPU（1 秒采样）：${await cpuNow()}`);
    };
    // check：当下就必须成立（不重试）。"某状态不应出现"一类的负向检查一律用它，不给短暂出现的错误留余地。
    // 失败现场：最近 30 秒的核心调用与核心进程、此刻的 CPU（只在失败时采，不影响通过的检查）。
    const scene = async () => `${recentReport()}\n此刻的 CPU（1 秒采样）：${await cpuNow()}`;
    const check = async (label: string, expression: string) => {
        const value = await evaluate(expression);
        if (value !== true) console.log(`检查不成立：${label}（实际 ${JSON.stringify(value)}）\n${await scene()}`);
        assert.equal(value, true, label);
        checks.push(label);
    };
    // within：设计上是异步的结果（跨进程回应、关闭后放回焦点等），必须在明确的时间标准内成立。
    // 从调用时起每 50 ms 查一次；每次都打印实际用时，超时时打印当前焦点与界面，便于区分"慢"和"错"。
    const within = async (label: string, expression: string, limitMs: number) => {
        const started = lastInput;
        while (true) {
            // 成立且仍在标准内才算通过；成立时已超过标准，按超时处理。
            if (await evaluate(expression) === true && clock() - started <= limitMs) break;
            if (clock() - started >= limitMs) {
                const state = await evaluate('JSON.stringify({ active: document.activeElement?.outerHTML.slice(0, 160), theme: document.documentElement.dataset.theme, text: document.body.innerText.slice(0, 200) })');
                throw Error(`${label}：${limitMs} ms 内没有成立
当前界面：${state}`);
            }
            await pause(50);
        }
        const elapsed = Math.round(clock() - started);
        console.log(`用时 ${label}：${elapsed} ms 以内（从输入算起，标准 ≤ ${limitMs} ms）`);
        checks.push(label);
        return elapsed;
    };
    // happened：主进程一侧的副作用（桩记录"打开文件"、"复制"等）要经 IPC 异步发生，必须在时间标准内出现；
    // 只负责等到它发生并打印用时，发生了几次、内容对不对由调用方紧接着精确断言。
    const happened = async (label: string, fn: () => boolean, limitMs: number) => {
        const started = lastInput;
        while (!(fn() && clock() - started <= limitMs)) {
            if (clock() - started >= limitMs) throw Error(`${label}：${limitMs} ms 内没有发生`);
            await pause(50);
        }
        const elapsed = Math.round(clock() - started);
        console.log(`用时 ${label}：${elapsed} ms 以内（从输入算起，标准 ≤ ${limitMs} ms）`);
        return elapsed;
    };
    const verify = async (label: string, fn: () => Promise<void> | void) => {
        try { await fn(); }
        catch (error) { throw Error(`${label}：${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
        checks.push(label);
    };
    // 命中测试：滚到可见 → 元素中心点 → elementFromPoint 必须是它自己或它的子元素 → 不能禁用。
    const hits = (selector: string) => evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: '找不到元素' };
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') return { error: '不可见' };
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { error: '在窗口外' };
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(hit === el || el.contains(hit))) return { error: '被遮挡：' + (hit ? hit.tagName + '.' + hit.className : '窗口外') };
        if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]')) return { error: '已禁用' };
        return { x: Math.round(x), y: Math.round(y) };
    })()`);
    const press = async (selector: string) => {
        const box = await hits(selector);
        // 有的检查本就预期点不了（已禁用等），这里只记一行，不做 CPU 采样。
        if ('error' in box) console.log(`点击前命中测试失败：${selector}：${box.error}`);
        assert.ok(!('error' in box), `${selector}：${'error' in box ? box.error : ''}`);
        const { x, y } = box as { x: number; y: number };
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        lastInput = clock();
        await pause();
    };
    const key = async (keyCode: string, modifiers: Electron.InputEvent['modifiers'] = []) => {
        // 验收窗口不显示，键盘事件前确保 webContents 有输入焦点，否则按键不按键盘导航处理（:focus-visible 不生效）。
        if (!win.webContents.isFocused()) win.webContents.focus();
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
        // 与真实键盘一样补发字符事件：Enter 的字符是回车（按钮靠它激活），单字符键是它本身。
        const char = keyCode === 'Enter' ? '\r' : keyCode.length === 1 ? keyCode : null;
        if (char) win.webContents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
        lastInput = clock();
        await pause(80);
    };
    const type = async (selector: string, text: string) => {
        await press(selector);
        const focusedNow = await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`);
        if (focusedNow !== true) console.log(`点击后没有获得焦点：${selector}；此刻焦点 ${await evaluate('document.activeElement?.outerHTML.slice(0, 120) ?? null')}；窗口有输入焦点 ${win.webContents.isFocused()}\n${await scene()}`);
        assert.equal(focusedNow, true, `${selector}：点击后没有获得焦点`);
        for (const ch of text) { win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); await pause(15); }
        await pause(80);
    };
    const tabTo = async (selector: string, max = 60) => {
        for (let i = 0; i < max; i++) {
            if (await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`)) return;
            await key('Tab');
        }
        assert.fail(`${selector}：按 ${max} 次 Tab 仍无法到达`);
    };
    const focusRing = async (label: string) => {
        const ring = await evaluate(`(() => { const el = document.activeElement, s = getComputedStyle(el); const ok = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none'); return ok ? true : el.outerHTML.slice(0, 120) + ' outline=' + s.outlineStyle + ' ' + s.outlineWidth + ' focusVisible=' + el.matches(':focus-visible'); })()`);
        assert.equal(ring, true, `${label}：焦点环不可见（${ring}）`);
    };
    const wheel = async (selector: string, deltaY: number) => {
        const box = await hits(selector);
        assert.ok(!('error' in box), `${selector}：${'error' in box ? box.error : ''}`);
        const { x, y } = box as { x: number; y: number };
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        // Electron 的 mouseWheel：deltaY 为负向下滚。按每次 100 像素分步发送。
        for (let left = Math.abs(deltaY); left > 0; left -= 100) {
            win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: Math.sign(deltaY) * -Math.min(100, left), canScroll: true } as Electron.MouseWheelInputEvent);
            await pause(30);
        }
        await pause(250);
    };

    // 每页通用检查：深浅两种主题 × 1160×720 与 960×600。
    // ① 所有可操作元素都能用 Tab 到达且焦点环可见 ② 没有横向溢出 ③ 显示出来的图标按钮都有 aria-label ④ 没有控制台错误 ⑤ 减少动态效果时没有动画
    const audit = async (page: string, prepare: () => Promise<void>) => {
        for (const [width, height] of [[1160, 720], [960, 600]]) for (const theme of ['dark', 'light'] as const) {
            win.setContentSize(width, height); nativeTheme.themeSource = theme;
            await pause(); await prepare(); await pause();
            const where = `${page}（${theme}，${width}×${height}）`, prefix = width === 960 ? 'UI11 ' : '通用 ';
            const errorsBefore = consoleErrors.length;
            const count = await evaluate(`(() => {
                const all = [...document.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
                const usable = all.filter(el => !el.disabled && !el.closest('[inert],[hidden]') && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
                document.querySelectorAll('[data-audit]').forEach(el => el.removeAttribute('data-audit'));
                usable.forEach((el, i) => el.setAttribute('data-audit', String(i)));
                document.activeElement?.blur();
                return usable.length;
            })()`);
            const seen = new Set<string>();
            for (let i = 0; i < count * 2 + 6 && seen.size < count; i++) {
                await key('Tab');
                const id = await evaluate('document.activeElement?.getAttribute("data-audit")');
                if (id !== null && id !== undefined) { seen.add(id); await focusRing(`${where} 第 ${id} 个可操作元素`); }
            }
            const missing = await evaluate(`[...document.querySelectorAll('[data-audit]')].filter(el => !${JSON.stringify([...seen])}.includes(el.getAttribute('data-audit'))).map(el => el.outerHTML.slice(0, 80))`);
            assert.deepEqual(missing, [], `${where}：Tab 到不了的元素`);
            checks.push(`${prefix}${where}：${count} 个可操作元素都能用 Tab 到达，焦点环可见`);
            await check(`${prefix}${where}：没有横向溢出`, 'document.scrollingElement.scrollWidth <= innerWidth && [...document.querySelectorAll(".scroll, .doc, .tlist")].every(el => el.scrollWidth <= el.clientWidth + 1)');
            await verify(`通用 ${where}：图标按钮都有 aria-label`, async () => assert.deepEqual(await evaluate('[...document.querySelectorAll("button")].filter(b => b.getClientRects().length > 0 && !b.textContent.trim() && !(b.getAttribute("aria-label") || "").trim()).map(b => b.outerHTML.slice(0, 160))'), []));
            assert.deepEqual(consoleErrors.slice(errorsBefore), [], `${where}：渲染进程控制台错误`);
            checks.push(`通用 ${where}：没有控制台错误`);
        }
        win.setContentSize(1160, 720); nativeTheme.themeSource = 'dark';
        win.webContents.debugger.attach('1.3');
        try {
            await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
            await pause();
            await check(`通用 ${page}：减少动态效果时没有动画`, 'matchMedia("(prefers-reduced-motion: reduce)").matches && document.getAnimations().length === 0');
        } finally {
            await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
            win.webContents.debugger.detach();
        }
        await evaluate('document.querySelectorAll("[data-audit]").forEach(el => el.removeAttribute("data-audit")); document.activeElement?.blur(); true');
    };
    return { pause, evaluate, wait, check, within, happened, verify, press, key, type, tabTo, focusRing, wheel, hits, save, audit, checks, consoleErrors };
}
