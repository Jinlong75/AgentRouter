import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { nativeTheme, type BrowserWindow } from 'electron';
import { effects } from './effects';
import { pollUntil, type Harness } from './shots-input';
import type { Registry } from './registry';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';
import { c, gt, pj, wt as w } from '../shared/copy';
import { worktreeState, type Task, type WtState } from '../shared/types';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
const DEMO_IDS = ['t30', 't31', 't32', 't33', 't34', 't35'];
// 验收里的 git 也只用隔离环境（GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM 见 tools/demo/preferences.mjs）。
const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, env: appEnv });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return String(r.stdout).trim();
};
const sha7 = (value: string) => value.slice(0, 7);
const clockOf = (n: number) => new Date(n).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

// UI24：验收页（概览 · 改动 · 门禁、批准并合并、驳回、被拒的合并、待验收通知）与 worktree 任务在任务页上的状态；
// UI25：合并冲突与"解决冲突并重试"、并发排队与停止、准备失败。
// 演示任务 t30～t35 默认隐藏，这里临时显示、检查完恢复；真实合并用测试自己的临时 git 仓库（隔离的公共目录与 AR_WORKTREE_ROOT）、
// fake 执行者与一个会解决合并冲突的测试执行者脚本，用真实核心派发、批准、驳回、重新基线。全程不碰用户的目录与进程。
export async function captureAccept(h: Harness, registry: Registry, out: string, save: (name: string) => Promise<void>, win: BrowserWindow) {
    const { evaluate, wait, check, verify, press, key, type, tabTo, focusRing, pause, audit } = h;
    const home = appEnv.AGENT_ROUTER_HOME!, worktreeRoot = appEnv.AR_WORKTREE_ROOT!;
    assert.ok(home && path.isAbsolute(home), '截图验收必须在隔离公共目录里运行');
    assert.ok(worktreeRoot && path.resolve(worktreeRoot).toLowerCase().startsWith(path.resolve(home).toLowerCase()), 'worktree 根目录必须在隔离公共目录里');
    const tasksFile = path.join(registry.data, 'tasks.json'), configFile = path.join(home, 'config.json');
    const root = path.join(home, 'shots-accept'), repo = path.join(root, 'sample'), repo2 = path.join(root, 'setup-fail');
    const agentFile = path.join(root, 'agent.mjs'), resolveFlag = path.join(root, 'resolve-release.flag'), holdFlag = path.join(root, 'hold-release.flag');
    const jsonOf = async <T,>(file: string, fallback: T): Promise<T> => JSON.parse(await readFile(file, 'utf8').catch(() => JSON.stringify(fallback)));
    const hiddenOf = async () => { const saved = await jsonOf<{ hidden?: string[] }>(tasksFile, {}); return Array.isArray(saved.hidden) ? saved.hidden : []; };
    const writeHidden = async (hidden: string[]) => { const saved = await jsonOf<Record<string, unknown>>(tasksFile, { imports: [] }); await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: [...new Set(hidden)] }) + '\n'); await registry.reloadHidden(); };
    const originalHidden = (await hiddenOf()).filter(key => DEMO_IDS.some(id => key.startsWith(id + ':')));
    const reveal = async (ids: string[]) => writeHidden((await hiddenOf()).filter(key => !ids.some(id => key.startsWith(id + ':'))));
    const rows = async () => (await readFile(registry.file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) as any[];
    const eventsOf = async (id: string) => (await rows()).filter(r => r.id === id);
    const untilRow = async <T,>(fn: () => Promise<T | undefined | null>, label: string, timeoutMs = 90000): Promise<T> => {
        let value: T | undefined | null;
        if ((await pollUntil(async () => (value = await fn()), timeoutMs, 200)).ok) return value as T;
        throw Error(`等待超时：${label}（${timeoutMs} ms）`);
    };
    const taskOf = (id: string) => registry.tasks.find(t => t.id === id);
    const untilState = async (id: string, state: WtState, timeoutMs = 90000) => untilRow(async () => { await registry.refresh(); const t = taskOf(id); return t && worktreeState(t) === state ? t : null; }, `任务 ${id} 进入 ${state}`, timeoutMs);
    const core = async (args: string[], cwd?: string) => {
        const r = await coreRun(args, { timeoutMs: 60000, cwd });
        assert.equal(r.code, 0, `ar ${args.join(' ')}：${r.stderr || r.json?.error}`);
        assert.equal(r.json?.ok, true, `ar ${args.join(' ')}：${r.json?.error}`);
        return r.json;
    };
    // 深浅色 × 默认 / 最小窗口各一张截图。
    const shots = async (name: string) => {
        for (const [width, height, suffix] of [[1160, 720, ''], [960, 600, '-960x600']] as const) {
            win.setContentSize(width, height);
            for (const theme of ['dark', 'light'] as const) {
                nativeTheme.themeSource = theme;
                await pause(350);
                await save(`${name}-${theme}${suffix}`);
            }
        }
        win.setContentSize(1160, 720);
        nativeTheme.themeSource = 'dark';
        await pause(350);
    };
    const jsonStr = JSON.stringify;
    const goTasks = async () => { await press('[data-page=tasks]'); await wait('!!document.querySelector("[data-task]")'); await press('[data-filter=all]'); };
    const goAccept = async () => { await press('[data-page=accept]'); await wait('!!document.querySelector("[data-acc]") || !!document.querySelector(".acc-main .empty")', 'UI24 验收页出现'); };
    // 任务页选中某个任务：先回到全部项目，保证它在列表里。
    const selectTask = async (id: string) => {
        await goTasks();
        // 行要等快照把它带进列表；一直没有再去选“全部项目”。
        const row = `!!document.querySelector('[data-task="${id}"]')`;
        if (!(await pollUntil(() => evaluate(row), 8000, 200)).ok) { await press('[data-project]'); await press('.ctx button'); await wait(row, `任务页出现任务 ${id}`, 20000); }
        await press(`[data-task="${id}"]`);
        await wait(`document.querySelector('[data-task="${id}"]')?.classList.contains('on') === true`, `选中任务 ${id}`);
    };
    const selectAccept = async (id: string) => {
        await goAccept();
        await wait(`!!document.querySelector('[data-acc="${id}"]')`, `验收页出现任务 ${id}`, 20000);
        await press(`[data-acc="${id}"]`);
        await wait(`document.querySelector('.trow.on')?.dataset.acc === ${jsonStr(id)}`, `验收页选中 ${id}`);
    };

    let alive: ChildProcess | undefined, started = false;
    // 演示部分结束：t30 / t31 的假派发进程结束并补一行 interrupted（之后启动不会把它们当成运行中的任务），演示任务重新隐藏。
    const endDemo = async () => {
        if (alive?.pid) {
            alive.kill();
            await new Promise(resolve => alive!.once('exit', resolve));
            alive = undefined;
        }
        if (started) await appendFile(registry.file, ['t30', 't31'].map(id => JSON.stringify({ v: 1, event: 'interrupted', id, at: Date.now(), signal: 'stopped-by-app' })).join('\n') + '\n').catch(() => { });
        started = false;
        await registry.refresh().catch(() => { });
        await writeHidden([...(await hiddenOf()).filter(key => !DEMO_IDS.some(id => key.startsWith(id + ':'))), ...originalHidden]);
    };
    const originalConfig = await readFile(configFile, 'utf8').catch(() => null);
    const registered: string[] = [];
    const touched: { id: string; started: number }[] = [];
    try {
        // ================= 演示数据：任务页上的 worktree 状态 =================
        await reveal(DEMO_IDS);
        // t30 排队中、t31 准备中在演示里没有存活的派发进程：拉起假派发进程并追加 resume 与 queued / preparing，让它们回到"进行中"阶段（同 UI23 的 t25）。
        const script = path.join(out, 'accept-fake', 'ar.mjs');
        await mkdir(path.dirname(script), { recursive: true });
        await writeFile(script, 'setInterval(() => { }, 1000);\n');
        const minimal: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
        for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[name]) minimal[name] = process.env[name];
        alive = spawn(process.execPath, [script], { env: minimal, stdio: 'ignore', shell: false, windowsHide: true });
        await new Promise<void>((resolve, reject) => { alive!.once('spawn', () => resolve()); alive!.once('error', reject); });
        started = true;
        const now = Date.now();
        await appendFile(registry.file, [
            { v: 1, event: 'resume', id: 't30', pid: alive.pid, n: 2, at: now }, { v: 1, event: 'queued', id: 't30', at: now + 1 },
            { v: 1, event: 'resume', id: 't31', pid: alive.pid, n: 2, at: now }, { v: 1, event: 'preparing', id: 't31', at: now + 1 },
        ].map(r => JSON.stringify(r)).join('\n') + '\n');
        await registry.refresh();
        await goTasks();
        await press('[data-project]');
        await press('.ctx button');
        await wait('!!document.querySelector("[data-task=t35]") && document.querySelector("[data-task=t30] .mk")?.classList.contains("stale") === true', 'UI24 显示 worktree 演示任务', 20000);
        const demo = Object.fromEntries(DEMO_IDS.map(id => [id, taskOf(id)!])) as Record<string, Task>;
        await verify('UI24 演示数据解析出六种状态：排队中 / 准备中 / 待验收 / 冲突 / 已合并 / 已驳回', () => {
            assert.deepEqual(DEMO_IDS.map(id => worktreeState(demo[id])), ['queued', 'preparing', 'awaiting', 'conflict', 'accepted', 'rejected']);
            assert.deepEqual(demo.t33.wt?.conflictFiles, ['src/save/schema.ts', 'tests/save-migration.test.ts']);
            assert.deepEqual([demo.t32.wt?.branch, demo.t34.wt?.accepted?.by, demo.t35.wt?.rejected?.keptBranch], ['ar/5f3a9c1e2d', 'lead', false]);
        });
        // 列表标记：每种状态一个图标，待验收与冲突用品牌色。
        const marks: [string, string, string][] = [['t30', 'stale', 'time-line'], ['t31', 'run', 'loader-4-line'], ['t32', 'brand', 'git-pull-request-line'], ['t33', 'brand', 'error-warning-line'], ['t34', 'ok', 'git-merge-line'], ['t35', 'stale', 'close-circle-line']];
        await check('UI24 列表标记：每种状态各一个图标，待验收与冲突是品牌色，悬停提示是状态名', `(() => { const want = ${jsonStr(marks)}; const names = ${jsonStr(['queued', 'preparing', 'awaiting', 'conflict', 'accepted', 'rejected'].map(s => w.state[s]))}; return want.every(([id, cls, icon], i) => { const m = document.querySelector('[data-task=' + id + '] .mk'); return m.classList.contains(cls) && m.querySelector('i').classList.contains('ri-' + icon) && m.title === names[i]; }); })()`);
        const brandColor = `(() => { const s = document.createElement('span'); s.style.color = 'var(--brand)'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })()`;
        await check('UI24 待验收与冲突的标记用品牌色（令牌 --brand）', `getComputedStyle(document.querySelector('[data-task=t32] .mk')).color === ${brandColor} && getComputedStyle(document.querySelector('[data-task=t33] .mk')).color === ${brandColor} && getComputedStyle(document.querySelector('[data-task=t34] .mk')).color !== ${brandColor}`);
        // 第二行：wt.sub*。
        for (const [id, expected] of [['t30', w.subQueued(0)], ['t32', w.subAwaiting], ['t33', w.subConflict(2)], ['t34', w.subAccepted('9b3f0a2')], ['t35', w.subRejected]] as const)
            await check(`UI24 列表第二行 ${id}：「${expected}」`, `document.querySelector('[data-task=${id}] .tm > span').textContent.endsWith(${jsonStr(' · ' + expected)})`);
        await check('UI24 列表第二行：待验收与冲突的文字是品牌色（em.attn），其余不是', `document.querySelector('[data-task=t32] .tm em.attn')?.textContent === ${jsonStr(w.subAwaiting)} && document.querySelector('[data-task=t33] .tm em.attn')?.textContent === ${jsonStr(w.subConflict(2))} && !document.querySelector('[data-task=t30] .tm em.attn') && getComputedStyle(document.querySelector('[data-task=t32] .tm em.attn')).color === ${brandColor}`);
        // 分段筛选"待验收"与分组。
        await check('UI24 分段筛选多了"待验收"：位于"进行中"与"失败或中断"之间，数量 2（待验收 + 冲突），有数量时文字用品牌色', `(() => { const b = [...document.querySelectorAll('.segm [data-filter]')]; const a = document.querySelector('[data-filter=await]'); return b.map(x => x.dataset.filter).join() === 'all,run,await,issues' && a.querySelector('.n').textContent === '2' && a.textContent.startsWith(${jsonStr(w.filter)}) && a.classList.contains('attn') && getComputedStyle(a).color === ${brandColor}; })()`);
        await check('UI24 列表分组"待验收"放在"进行中"下面、按天分组上面，组里是待验收与冲突两项', `(() => { const g = [...document.querySelectorAll('.tgroup')].map(x => x.firstChild.textContent); const rows = [...document.querySelectorAll('[data-task]')].map(x => x.dataset.task); return g[0] === ${jsonStr(c.status.run)} && g[1] === ${jsonStr(w.group)} && rows.indexOf('t32') < rows.indexOf('t33') + 1 && rows.indexOf('t33') - rows.indexOf('t32') === 1 && rows.indexOf('t32') > rows.indexOf('t1') && rows.indexOf('t32') < rows.indexOf('t3'); })()`);
        await press('[data-filter=await]');
        await check('UI24 点"待验收"筛选：只剩待验收与冲突两项', `[...document.querySelectorAll('[data-task]')].map(x => x.dataset.task).sort().join() === 't32,t33' && document.querySelector('[data-filter=await]').classList.contains('on')`);
        await press('[data-filter=all]');
        await check('UI24 侧栏"验收"在"新建任务"下面，徽标是待验收与冲突的数量 2（品牌色底），悬停提示写有几个任务', `(() => { const b = [...document.querySelectorAll('.nav > button[data-page]')].map(x => x.dataset.page); const n = document.querySelector('[data-page=accept]'); const count = n.querySelector('.count'); return b.slice(0, 3).join() === 'tasks,newtask,accept' && n.textContent.startsWith(${jsonStr(w.nav)}) && count.textContent === '2' && count.classList.contains('brand') && n.dataset.tip === ${jsonStr(w.navTip(2))}; })()`);
        // 任务页详情：状态行、轨道、横幅、标题行按钮。
        await press('[data-task=t30]');
        await wait(`document.querySelector('.dh h2')?.textContent === '018-导出 Markdown'`);
        await check('UI24 排队中：状态行、横幅（并发上限与前面的任务数）、轨道执行节点，标题行只有"停止"', `(() => { const n = [...document.querySelectorAll('.track .node')]; const acts = [...document.querySelectorAll('.dh-1 .acts button')].map(b => b.dataset.stop !== undefined ? 'stop' : b.dataset.more !== undefined ? 'more' : b.textContent.trim()); return document.querySelector('.dh-state').textContent.startsWith(${jsonStr(w.lineQueued('').slice(0, 6))}) && document.querySelector('.dh-state').classList.contains('stale') && document.querySelector('.banner-holder .banner.info .rt b').textContent === ${jsonStr(w.queuedTitle)} && document.querySelector('.banner-holder .banner.info .rt span').textContent === ${jsonStr(w.queuedHelp(2, 0))} && n.length === 5 && n[1].classList.contains('todo') && n[1].querySelector('.sub').textContent === ${jsonStr(w.trackQueued)} && n[1].getAttribute('aria-label') === ${jsonStr(gt.nodeLabel(gt.track.run, w.nodeQueued(0)))} && acts.join() === 'stop,more'; })()`);
        await shots('wt-queued');
        await press('[data-task=t31]');
        await wait(`document.querySelector('.dh h2')?.textContent === '019-夜间模式'`);
        await check('UI24 准备中：状态行、横幅与"建好 worktree"一行、轨道执行节点运行中，标题行只有"停止"', `(() => { const n = [...document.querySelectorAll('.track .node')]; const row = document.querySelector('.wt-slot .tl.k-turn .c'); return document.querySelector('.dh-state').textContent === ${jsonStr(w.linePreparing)} && document.querySelector('.banner-holder .banner.info .rt b').textContent === ${jsonStr(w.preparingTitle)} && document.querySelector('.banner-holder .banner.info .rt span').textContent === ${jsonStr(w.preparingHelp('ar/3b7d5f19e0', 'main'))} && row?.textContent === ${jsonStr(w.worktreeRow('ar/3b7d5f19e0', 'main', 'a1b2c3d'))} && n[1].classList.contains('running') && n[1].querySelector('.sub').textContent === ${jsonStr(w.trackPreparing)} && !!document.querySelector('[data-stop]') && !document.querySelector('[data-retry]') && !document.querySelector('[data-redispatch]'); })()`);
        await press('[data-task=t32]');
        await wait(`document.querySelector('.dh h2')?.textContent === '020-成就弹窗'`);
        await check('UI24 待验收：状态行、轨道五段（待验收节点等你，合并节点待办）、横幅与"去验收"，标题行"去验收"主按钮与"再派一次"、没有重试', `(() => { const n = [...document.querySelectorAll('.track .node')]; const acts = [...document.querySelectorAll('.dh-1 .acts button')].map(b => b.dataset.goAccept !== undefined ? 'go' : b.dataset.redispatch !== undefined ? 'again' : b.dataset.more !== undefined ? 'more' : b.dataset.retry !== undefined ? 'retry' : b.textContent.trim()); const banner = document.querySelector('.banner-holder .banner.brand'); return document.querySelector('.dh-state').textContent.startsWith(${jsonStr(w.lineAwaiting('').slice(0, 6))}) && document.querySelector('.dh-state').classList.contains('brand') && n.length === 5 && n.map(x => x.querySelector('span:nth-child(2)').textContent).join() === ${jsonStr([gt.track.dispatch, gt.track.run, gt.track.gate, w.track.awaiting, w.track.merge].join())} && n[3].classList.contains('attn') && n[3].querySelector('.sub').textContent === ${jsonStr(w.trackWaitYou)} && n[3].getAttribute('aria-label') === ${jsonStr(gt.nodeLabel(w.track.awaiting, w.nodeAwaiting))} && n[4].classList.contains('todo') && n[4].querySelector('.sub').textContent === 'main' && n[4].getAttribute('aria-label') === ${jsonStr(gt.nodeLabel(w.track.merge, w.nodeMergePending('main')))} && n.every(x => x.tagName === 'BUTTON' && x.getAttribute('aria-label')) && banner.querySelector('.rt b').textContent === ${jsonStr(w.awaitingTitle)} && banner.querySelector('.rt span').textContent === ${jsonStr(w.awaitingHelp('main'))} && banner.querySelector('[data-go-accept]').textContent === ${jsonStr(w.goAccept)} && acts.join() === 'go,again,more' && document.querySelector('.dh-1 [data-go-accept]').classList.contains('primary'); })()`);
        await press('.dtabs [data-tab=flow]');
        await wait(`!!document.querySelector('.events-host')`);
        await check('UI24 待验收任务的进展末尾有"门禁通过 · 进入待验收"，开头有"建好 worktree"一行', `document.querySelector('.events-host').textContent.includes(${jsonStr(w.awaitingRow)}) && document.querySelector('.wt-slot .tl.k-turn .c')?.textContent === ${jsonStr(w.worktreeRow('ar/5f3a9c1e2d', 'main', 'a1b2c3d'))}`);
        await shots('wt-awaiting');
        await press('[data-task=t33]');
        await wait(`document.querySelector('.dh h2')?.textContent === '021-存档导出 JSON'`);
        await check('UI24 合并冲突：状态行、轨道（待验收节点已批准、合并节点冲突）、横幅列出冲突文件数、"去验收"与"再派一次"，没有重试', `(() => { const n = [...document.querySelectorAll('.track .node')]; const banner = document.querySelector('.banner-holder .banner.fail'); const acts = [...document.querySelectorAll('.dh-1 .acts button')].map(b => b.dataset.goAccept !== undefined ? 'go' : b.dataset.redispatch !== undefined ? 'again' : b.dataset.more !== undefined ? 'more' : b.dataset.retry !== undefined ? 'retry' : b.textContent.trim()); return document.querySelector('.dh-state').textContent === ${jsonStr(w.lineConflict(2))} && n[3].classList.contains('done') && n[3].querySelector('.sub').textContent === ${jsonStr(w.trackApproved)} && n[4].classList.contains('attn') && n[4].querySelector('.sub').textContent === ${jsonStr(w.trackConflict)} && n[4].getAttribute('aria-label') === ${jsonStr(gt.nodeLabel(w.track.merge, w.nodeConflict(['src/save/schema.ts', 'tests/save-migration.test.ts'])))} && banner.querySelector('.rt b').textContent === ${jsonStr(w.conflictTitle)} && banner.querySelector('.rt span').textContent === ${jsonStr(w.conflictHelp('main', 2))} && !!banner.querySelector('[data-go-accept]') && acts.join() === 'go,again,more' && document.querySelectorAll('.banner-holder .banner').length === 1; })()`);
        await press('[data-task=t34]');
        await wait(`document.querySelector('.dh h2')?.textContent === '013-音量滑块'`);
        await check('UI24 已合并：状态行、轨道（已批准 · 合并提交）、横幅写合并提交与撤销命令，只有"再派一次"（没有重试与去验收）', `(() => { const n = [...document.querySelectorAll('.track .node')]; const banner = document.querySelector('.banner-holder .banner.ok'); const acts = [...document.querySelectorAll('.dh-1 .acts button')].map(b => b.dataset.redispatch !== undefined ? 'again' : b.dataset.more !== undefined ? 'more' : b.dataset.retry !== undefined ? 'retry' : b.textContent.trim()); return /^已合并 · .+ 主导批准$/.test(document.querySelector('.dh-state').textContent) && document.querySelector('.dh-state').classList.contains('ok') && n[3].querySelector('.sub').textContent === ${jsonStr(w.by.lead)} && n[4].classList.contains('done') && n[4].querySelector('.sub').textContent === '9b3f0a2' && n[4].getAttribute('aria-label') === ${jsonStr(gt.nodeLabel(w.track.merge, w.nodeMerged('main', '9b3f0a2')))} && banner.querySelector('.rt b').textContent === ${jsonStr(w.acceptedTitle('main'))} && banner.querySelector('.rt span').textContent.startsWith('合并提交 9b3f0a2（') && banner.querySelector('.rt span').textContent.endsWith(${jsonStr('主导批准）；worktree 与分支已删除。撤销整个任务：git revert -m 1 9b3f0a2')}) && acts.join() === 'again,more'; })()`);
        await press('[data-task=t35]');
        await wait(`document.querySelector('.dh h2')?.textContent === '017-换肤主题'`);
        await check('UI24 已驳回：状态行、轨道（待验收节点已驳回、合并节点不合并）、横幅写驳回原因，只有"再派一次"', `(() => { const n = [...document.querySelectorAll('.track .node')]; const banner = document.querySelector('.banner-holder .banner.stale'); const acts = [...document.querySelectorAll('.dh-1 .acts button')].map(b => b.dataset.redispatch !== undefined ? 'again' : b.dataset.more !== undefined ? 'more' : b.dataset.retry !== undefined ? 'retry' : b.textContent.trim()); return /^已驳回 · .+ 你驳回$/.test(document.querySelector('.dh-state').textContent) && n[3].classList.contains('stopped') && n[3].querySelector('.sub').textContent === ${jsonStr(w.trackRejected)} && n[4].classList.contains('skip') && n[4].querySelector('.sub').textContent === ${jsonStr(w.trackNoMerge)} && banner.querySelector('.rt b').textContent === ${jsonStr(w.rejectedTitle)} && banner.querySelector('.rt span').textContent.startsWith('方向不对：主题跟随系统即可，不要加手动开关（') && banner.querySelector('.rt span').textContent.endsWith('你驳回）。worktree 已删除，分支已删除。') && acts.join() === 'again,more'; })()`);
        // 点横幅上的"去验收"：切到验收页并选中这个任务（键盘 Tab 到按钮、回车）。
        await press('[data-task=t32]');
        await wait(`!!document.querySelector('.banner-holder [data-go-accept]')`);
        await tabTo('.banner-holder [data-go-accept]', 120);
        await focusRing('UI24 横幅"去验收"');
        await key('Enter');
        await wait(`document.querySelector('.trow.on')?.dataset.acc === 't32'`, 'UI24 去验收后验收页选中 t32', 15000);
        await check('UI24 横幅"去验收"（键盘回车）：切到验收页并选中这个任务，侧栏"验收"高亮', `document.querySelector('[data-page=accept]').getAttribute('aria-current') === 'page' && document.querySelector('.detail.acc .dh h2').textContent === '020-成就弹窗'`);
        // 标题行"去验收"主按钮（鼠标）。
        await selectTask('t33');
        await press('.dh-1 [data-go-accept]');
        await wait(`document.querySelector('.trow.on')?.dataset.acc === 't33'`, 'UI24 标题行去验收选中 t33', 15000);
        await check('UI24 标题行"去验收"：切到验收页并选中冲突的 t33，它在列表里排在 t32 后面，第二行是品牌色的冲突文件数', `[...document.querySelectorAll('[data-acc]')].map(x => x.dataset.acc).join() === 't32,t33' && document.querySelector('[data-acc=t33] .tm em.attn').textContent === ${jsonStr(w.subConflict(2))} && document.querySelector('.tgroup').textContent.startsWith(${jsonStr(w.listGroup)})`);

        // ================= 演示数据：验收页 =================
        await selectAccept('t32');
        await check('UI24 验收页骨架：标题"验收"、左列表（分组 wt.listGroup 与数量）、右详情（标题、状态行、轨道、标签、底部操作栏）', `(() => { const tabs = [...document.querySelectorAll('.detail.acc .dtabs button')]; return document.querySelector('.page-h h1').textContent === ${jsonStr(w.pageTitle)} && document.querySelector('.page-h .lead').textContent === ${jsonStr(w.pageLead)} && document.querySelector('.tgroup .mono').textContent === '2' && !!document.querySelector('.detail.acc .track') && tabs.map(b => b.dataset.atab).join() === 'overview,diff,gate,review' && tabs[3].disabled === true && tabs[3].title === ${jsonStr(w.reviewLater)} && tabs[0].getAttribute('aria-pressed') === 'true' && !!document.querySelector('.detail.acc .actbar'); })()`);
        await wait(`!!document.querySelector('.detail.acc .specbox') && document.querySelector('.detail.acc .specbox p')?.textContent.length > 0 && !!document.querySelector('.detail.acc .md')`, 'UI24 概览读到任务说明与汇报', 20000);
        await check('UI24 概览：任务说明摘要（目标取任务说明"目标"的第一段、允许改动、验收命令读 dispatch.json 的 gate.merged）+ 汇报（TODO(lead) 与推断清单高亮）', `(() => { const box = document.querySelector('.specbox'); const k = [...box.querySelectorAll('.sb-k')].map(x => [x.children[0].textContent, x.children[1].textContent]); const hl = document.querySelectorAll('.detail.acc .md .hl.brand'); return box.querySelector('.sb-h b').textContent === ${jsonStr(w.specBox)} && box.querySelector('.sb-h .mono').textContent === 'docs/specs/020-成就弹窗.md' && box.querySelector('p').textContent === '解锁成就时弹出提示，自动收起；同时解锁多个时排队显示。' && JSON.stringify(k) === ${jsonStr(JSON.stringify([[w.specAllowed, 'src/** · tests/**'], [w.specVerify, 'npm test · npm run lint']]))} && hl.length === 2 && document.querySelector('.detail.acc .sum .mono').textContent === 'c2d4e61'; })()`);
        await check('UI24 验收页详情头：状态行、分支、基线→提交（wt.baseToHead）、执行者；底部操作栏三个按钮（驳回 / 重试 / 批准并合并）与后果说明', `(() => { const h = document.querySelector('.detail.acc .dh-2').textContent; const acts = [...document.querySelectorAll('.detail.acc .actbar button')].map(b => b.textContent.trim()); return h.includes('ar/5f3a9c1e2d') && h.includes(${jsonStr(w.baseToHead('main', 'a1b2c3d', 'c2d4e61'))}) && h.includes('DeepSeek V4 Pro') && acts.join() === ${jsonStr([w.reject, w.retry, w.approve].join())} && document.querySelector('.actbar .note').textContent === ${jsonStr(w.noteApprove('main'))} && document.querySelector('.actbar .btn.primary').textContent === ${jsonStr(w.approve)}; })()`);
        // 项目的 mergeMode 为 squash 时，底部说明换成 squash 的后果（改完项目配置恢复原样）。
        const projectFile = path.join(taskOf('t32')!.repo, '.agent-router', 'project.json'), projectText = await readFile(projectFile, 'utf8');
        try {
            await writeFile(projectFile, JSON.stringify({ ...JSON.parse(projectText), mergeMode: 'squash' }, null, 2) + '\n');
            await registry.refresh();
            await wait(`document.querySelector('.actbar .note')?.textContent === ${jsonStr(w.noteApproveSquash('main'))}`, 'UI24 squash 项目的底部说明', 20000);
            await check('UI24 项目 mergeMode 为 squash：底部说明是 wt.noteApproveSquash（冲突时仍是冲突的说明）', `document.querySelector('.actbar .note').textContent === ${jsonStr(w.noteApproveSquash('main'))}`);
        }
        finally { await writeFile(projectFile, projectText); await registry.refresh(); }
        await wait(`document.querySelector('.actbar .note')?.textContent === ${jsonStr(w.noteApprove('main'))}`, 'UI24 恢复后底部说明回到 --no-ff 的说法', 20000);
        await check('UI24 验收页"更多"按钮有 aria-label，菜单有"打开 worktree 文件夹""复制分支名"', `(() => { const b = document.querySelector('[data-acc-more]'); return b.getAttribute('aria-label') === ${jsonStr(w.moreTip)} && b.dataset.tip === ${jsonStr(w.moreTip)}; })()`);
        await press('[data-acc-more]');
        await wait('!!document.querySelector(".ctx")');
        await check('UI24 更多菜单：打开 worktree 文件夹、复制分支名', `[...document.querySelectorAll('.ctx button')].map(b => b.textContent).join() === ${jsonStr([w.openWorktree, w.copyBranch].join())}`);
        const copiesBefore = effects.copyLog.length;
        await press('.ctx button:nth-child(2)');
        await h.happened('UI24 复制分支名写入剪贴板', () => effects.copyLog.length > copiesBefore, 3000);
        await verify('UI24 复制分支名：剪贴板桩收到分支名', () => assert.equal(effects.copyLog.at(-1)!.text, 'ar/5f3a9c1e2d'));
        await shots('accept-overview');
        await press('[data-acc=t33]');
        await wait(`document.querySelector('.trow.on')?.dataset.acc === 't33'`);
        await check('UI24 验收页冲突：横幅（冲突文件逐个列出、解释"解决冲突并重试"），底部只有"驳回…"与主按钮"解决冲突并重试"，后果说明 wt.noteConflict', `(() => { const b = document.querySelector('.detail.acc .tab-body .banner.fail'); const acts = [...document.querySelectorAll('.detail.acc .actbar button')].map(x => x.textContent.trim()); return b.querySelector('.rt b').textContent === ${jsonStr(w.conflictTitle)} && b.querySelector('.rt span').textContent === ${jsonStr(w.conflictPageHelp('main', ['src/save/schema.ts', 'tests/save-migration.test.ts']))} && acts.join() === ${jsonStr([w.reject, w.resolve].join())} && document.querySelector('.actbar .btn.primary').textContent === ${jsonStr(w.resolve)} && document.querySelector('.actbar .note').textContent === ${jsonStr(w.noteConflict)} && document.querySelector('.dh-state').textContent === ${jsonStr(w.lineConflict(2))}; })()`);
        await shots('accept-conflict');
        // 演示任务的改动已不可查（演示仓库没有这个分支）：说明文案。
        await press('[data-atab=diff]');
        await wait(`document.querySelector('.detail.acc .tab-body .empty b')?.textContent === ${jsonStr(w.diffGone)}`, 'UI24 改动已不可查', 20000);
        await check('UI24 改动标签：worktree 与分支都不在时显示"改动已不可查"', `document.querySelector('.detail.acc .tab-body .empty b').textContent === ${jsonStr(w.diffGone)}`);
        await press('[data-atab=gate]');
        await wait(`!!document.querySelector('.detail.acc .tab-body .banner.ok')`, 'UI24 门禁标签', 15000);
        await check('UI24 门禁标签复用门禁标签组件：通过横幅、提交检查、验收命令', `!!document.querySelector('.detail.acc .tab-body .banner.ok') && [...document.querySelectorAll('.detail.acc .tab-body .sec-t')].map(x => x.firstChild.textContent).join() === ${jsonStr([gt.commitSec, gt.uncommittedSec, gt.scopeSec, gt.deletedSec, gt.commandsSec].join())}`);
        await press('[data-atab=overview]');
        await endDemo();
        console.log('验收检查进度：演示数据部分完成，开始真实任务');

        // ================= 真实合并：测试自己的临时 git 仓库 =================
        const initRepo = async (dir: string, name: string, setup: string[]) => {
            await mkdir(path.join(dir, 'src'), { recursive: true });
            await mkdir(path.join(dir, 'docs', 'specs'), { recursive: true });
            await mkdir(path.join(dir, '.agent-router'), { recursive: true });
            git(dir, ['init', '-b', 'main']);
            git(dir, ['config', 'user.name', 'AgentRouter Shots']);
            git(dir, ['config', 'user.email', 'shots@example.invalid']);
            git(dir, ['config', 'commit.gpgsign', 'false']);
            git(dir, ['config', 'core.autocrlf', 'false']);
            await writeFile(path.join(dir, '.gitignore'), '.agent-runs/\n');
            await writeFile(path.join(dir, 'src', 'a.txt'), 'alpha\nbeta\n');
            await writeFile(path.join(dir, 'src', 'shared.txt'), 'one\ntwo\nthree\n');
            await writeFile(path.join(dir, '.agent-router', 'project.json'), JSON.stringify({ v: 1, name, baseBranch: 'main', specsDir: 'docs/specs', setup, verify: [], allowedPaths: ['**'], routing: { rules: [] }, worktree: true }, null, 2) + '\n');
            git(dir, ['add', '--', '.gitignore', 'src/a.txt', 'src/shared.txt', '.agent-router/project.json']);
            git(dir, ['commit', '-m', '初始提交', '--', '.gitignore', 'src/a.txt', 'src/shared.txt', '.agent-router/project.json']);
        };
        const specs: Record<string, { title: string; file: string; verify: string }> = {
            a: { title: '验收通过任务', file: '091-验收通过', verify: 'git cat-file -e HEAD:src/ok.txt' },
            b: { title: '验收驳回任务', file: '092-验收驳回', verify: 'git cat-file -e HEAD:src/rej.txt' },
            x: { title: '冲突任务甲', file: '093-冲突甲', verify: 'git cat-file -e HEAD:src/shared.txt' },
            y: { title: '冲突任务乙', file: '094-冲突乙', verify: 'git cat-file -e HEAD:src/shared.txt' },
            q1: { title: '排队任务一', file: '095-排队一', verify: 'git cat-file -e HEAD:src/q1.txt' },
            q2: { title: '排队任务二', file: '096-排队二', verify: 'git cat-file -e HEAD:src/q2.txt' },
        };
        const specText = (id: number, s: { title: string; verify: string }) => ['---', `id: 9${id}`, `title: ${s.title}`, 'type: code', 'allowed_paths:', '  - src/**', 'verify:', `  - ${s.verify}`, 'max_retries: 0', '---', '', '## 目标', '', `${s.title}：验收页检查用的任务。`, '', '## 范围 / 不做什么', '', '只改 src 下的文件。', ''].join('\n');
        // 调研类任务（Stage07 T6）：type: research，只读运行，没有 allowed_paths 与 verify。
        const researchSpec = (id: number, title: string) => ['---', `id: 9${id}`, `title: ${title}`, 'type: research', 'max_retries: 0', '---', '', '## 目标', '', `${title}：调研类任务的检查用说明。`, '', '## 范围 / 不做什么', '', '只读，不改任何文件。', ''].join('\n');
        await initRepo(repo, 'sample', []);
        let n = 0;
        for (const s of Object.values(specs)) { n++; await writeFile(path.join(repo, 'docs', 'specs', `${s.file}.md`), specText(n, s)); }
        git(repo, ['add', '--', 'docs/specs']);
        git(repo, ['commit', '-m', '任务说明', '--', 'docs/specs']);
        await core(['projects', 'add', repo]);
        registered.push(repo);
        // 会解决合并冲突的测试执行者（codex 适配器的 path 指向它）：不在合并中时写自己的改动并提交；在合并中时等放行文件，再把双方改动合起来提交。
        await writeFile(agentFile, [
            "import { readFileSync, writeFileSync, existsSync } from 'node:fs';",
            "import { spawnSync } from 'node:child_process';",
            "const argv = process.argv.slice(2);",
            "if (argv.includes('--version')) { console.log('shots-agent 1.0'); process.exit(0); }",
            "if (argv.slice(-2).join(' ') === 'login status') { console.error('Logged in using ChatGPT'); process.exit(0); }",
            "let input = '';",
            "process.stdin.setEncoding('utf8');",
            "process.stdin.on('data', chunk => { input += chunk; });",
            "process.stdin.on('end', async () => {",
            "  const run = args => spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8', shell: false, windowsHide: true });",
            "  const mergeHead = run(['rev-parse', '--git-path', 'MERGE_HEAD']).stdout.trim();",
            "  const merging = existsSync(mergeHead);",
            "  if (merging) { while (!existsSync(" + JSON.stringify(resolveFlag) + ")) await new Promise(resolve => setTimeout(resolve, 100)); }",
            "  writeFileSync('src/shared.txt', merging ? 'one\\nTWO-X TWO-Y\\nthree\\n' : 'one\\nTWO-Y\\nthree\\n');",
            "  const added = run(['add', 'src/shared.txt']);",
            "  const committed = run(['commit', '-m', merging ? '解决冲突：合并双方的改动' : '乙改第二行']);",
            "  if (added.status !== 0 || committed.status !== 0) { process.stderr.write(added.stderr + committed.stderr); process.exit(1); }",
            "  writeFileSync(argv[argv.indexOf('-o') + 1], merging ? '# 完成了什么\\n\\n已解决合并冲突。\\n' : '# 完成了什么\\n\\n乙已改 shared.txt。\\n');",
            "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: merging ? '已解决冲突' : '乙完成' } }));",
            "});",
            '',
        ].join('\n'));
        const profile = (label: string, extra: Record<string, unknown> = {}) => ({ adapter: 'fake', label, enabled: true, events: [{ kind: 'say', text: `${label}：假执行者已完成。` }], report: '# 完成了什么\n\n假汇报。\n', exit: 0, version: 'fake-agent 1.0', ...extra });
        const aReport = '# 完成了什么\n\n验收通过任务：改了 a.txt，新增 ok.txt 与 note.txt。\n\n## TODO(lead) 1 条\n\n1. 文案是占位。\n\n## 推断清单 1 条\n\n1. 推断一项。\n';
        const writeConfig = async (concurrency: number) => writeFile(configFile, JSON.stringify({
            v: 2, defaultProfile: 'a', managed: false, watchWindow: 'never', concurrency, profiles: {
                a: profile('甲执行者', { report: aReport, writes: [{ path: 'src/a.txt', content: 'alpha\nbeta changed\ngamma\n' }, { path: 'src/ok.txt', content: 'ok 1\nok 2\nok 3\n' }, { path: 'src/note.txt', content: 'note\n' }], commit: '甲：验收通过任务' }),
                b: profile('乙执行者', { writes: [{ path: 'src/rej.txt', content: 'rej\n' }], commit: '乙：驳回任务' }),
                x: profile('丙执行者', { writes: [{ path: 'src/shared.txt', content: 'one\nTWO-X\nthree\n' }], commit: '丙：甲改第二行' }),
                y: { adapter: 'codex', label: '丁执行者', enabled: true, path: agentFile },
                hold: profile('戊执行者', { releaseFile: holdFlag, releaseTimeoutMs: 120000, writes: [{ path: 'src/q1.txt', content: 'q1\n' }], commit: '戊：排队任务' }),
                plain: profile('己执行者', {}),
                research: profile('调研执行者', {}),
                sneak: profile('偷改执行者', { writes: [{ path: 'src/a.txt', content: 'sneaky\n' }] }),
            },
        }, null, 2) + '\n');
        await writeConfig(2);
        const noticesBefore = effects.notices.length;
        const dispatchTask = async (rel: string, name: string, profileName: string, cwd = repo) => {
            const r = await core(['dispatch', `docs/specs/${rel}.md`, '--name', name, '--profile', profileName, '--host', 'agentrouter', '--detach'], cwd);
            const id = String(r.id);
            assert.ok(id, '派发没有返回 id');
            await untilRow(async () => (await rows()).find(x => x.id === id && x.event === 'start'), `任务 ${name} 的 start`, 30000);
            const start = (await rows()).find(x => x.id === id && x.event === 'start');
            touched.push({ id, started: start.started });
            return { id, name, start };
        };
        const A = await dispatchTask(specs.a.file, 'accept-a', 'a');
        const B = await dispatchTask(specs.b.file, 'accept-b', 'b');
        const X = await dispatchTask(specs.x.file, 'accept-x', 'x');
        const Y = await dispatchTask(specs.y.file, 'accept-y', 'y');
        for (const task of [A, B, X, Y]) await untilState(task.id, 'awaiting', 150000);
        console.log('验收检查进度：四个真实任务都进入待验收');
        const wtOf = async (id: string) => (await eventsOf(id)).findLast(r => r.event === 'worktree');
        const wA = await wtOf(A.id), wB = await wtOf(B.id), wX = await wtOf(X.id), wY = await wtOf(Y.id);
        await verify('UI24 真实任务都进入待验收：end.exit 为 0，worktree 目录与分支都在，主工作区干净且在 main 上', async () => {
            for (const wt of [wA, wB, wX, wY]) { assert.ok(wt && existsSync(wt.dir), 'worktree 目录应存在'); assert.ok(git(repo, ['branch', '--list', wt.branch]).length > 0, 'worktree 分支应存在'); assert.ok(path.resolve(wt.dir).toLowerCase().startsWith(path.resolve(worktreeRoot).toLowerCase()), 'worktree 在隔离的 AR_WORKTREE_ROOT 下'); }
            assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
            assert.equal(git(repo, ['status', '--porcelain']), '');
        });
        const tA = taskOf(A.id)!, tB = taskOf(B.id)!, tX = taskOf(X.id)!, tY = taskOf(Y.id)!;
        // ---- 通知：进入待验收时发 wt.notifyTitle，点开到验收页并选中 ----
        await verify('UI24 进入待验收时通知桩收到"待验收：<任务名>"，正文是项目名 · 门禁通过，等你批准合并或驳回', () => {
            const notice = effects.notices.slice(noticesBefore).find(x => x.title === w.notifyTitle(tA.title));
            assert.ok(notice, `没有收到待验收通知：${JSON.stringify(effects.notices.slice(noticesBefore).map(x => x.title))}`);
            assert.equal(notice.body, w.notifyBody('sample'));
            assert.ok(!effects.notices.slice(noticesBefore).some(x => x.title.startsWith(`${c.status.done}：`)), '待验收通知取代"已完成"那条');
        });
        await goTasks();
        const notice = effects.notices.slice(noticesBefore).find(x => x.title === w.notifyTitle(tA.title))!;
        // 点通知的回调会显示并聚焦窗口：验收窗口是不显示的（显示过再隐藏，截图会一直等不到画面），点击期间把 show / focus 换成空操作，其余照真实回调走。
        const windowMethods = win as unknown as Record<string, unknown>;
        windowMethods.show = () => { };
        windowMethods.focus = () => { };
        try { notice.click(); }
        finally { delete windowMethods.show; delete windowMethods.focus; }
        await wait(`document.querySelector('[data-page=accept]')?.getAttribute('aria-current') === 'page' && document.querySelector('.trow.on')?.dataset.acc === ${jsonStr(A.id)}`, 'UI24 点通知后到验收页并选中任务', 15000);
        await check('UI24 点通知：到验收页并选中这个任务（详情标题是任务名）', `document.querySelector('.detail.acc .dh h2').textContent === ${jsonStr(tA.title)}`);
        // ---- 概览、门禁、改动 ----
        await wait(`document.querySelector('.detail.acc .specbox p')?.textContent.length > 0 && !!document.querySelector('.detail.acc .md')`, 'UI24 概览读到真实任务的说明与汇报', 20000);
        await check('UI24 真实任务概览：目标 = 任务说明"目标"第一段，允许改动与验收命令来自 dispatch.json 的 gate.merged，汇报高亮 TODO(lead) 与推断清单', `(() => { const box = document.querySelector('.specbox'); const k = [...box.querySelectorAll('.sb-k')].map(x => x.children[1].textContent); return box.querySelector('p').textContent === ${jsonStr(specs.a.title + '：验收页检查用的任务。')} && k.join('|') === ${jsonStr('src/**|' + specs.a.verify)} && document.querySelectorAll('.detail.acc .md .hl.brand').length === 2 && box.querySelector('.sb-h .mono').textContent === ${jsonStr(`docs/specs/${specs.a.file}.md`)}; })()`);
        await check('UI24 验收页状态：待验收、侧栏徽标是待验收数量（4）', `document.querySelector('.detail.acc .dh-state').textContent.startsWith(${jsonStr(w.lineAwaiting('').slice(0, 6))}) && document.querySelector('[data-page=accept] .count').textContent === '4'`);
        await shots('accept-real-overview');
        await press('[data-atab=gate]');
        await wait(`!!document.querySelector('.detail.acc .tab-body .banner.ok')`, 'UI24 真实任务的门禁标签', 15000);
        await check('UI24 真实任务的门禁标签：门禁通过横幅、验收命令列出', `document.querySelector('.detail.acc .tab-body .banner.ok .rt b').textContent.startsWith('门禁通过') && [...document.querySelectorAll('.detail.acc .tab-body code')].some(x => x.textContent === ${jsonStr(specs.a.verify)})`);
        // 改动：与 ar diff --json 逐个一致。
        const diffRun = await coreRun(['diff', A.name], { timeoutMs: 60000, cwd: repo });
        assert.equal(diffRun.json.ok, true, JSON.stringify(diffRun.json));
        const diff = diffRun.json as { base: string; head: string; files: { path: string; status: string; additions: number; deletions: number; binary: boolean }[] };
        assert.equal(diff.files.length, 3);
        await press('[data-atab=diff]');
        await wait(`document.querySelectorAll('.detail.acc .df').length === ${diff.files.length}`, 'UI24 改动标签读到 ar diff 的结果', 30000);
        await check('UI24 改动标签：文件数、每个文件的路径 / 状态 / 增删数与 ar diff --json 逐个一致，头部汇总文字一致', `(() => { const want = ${jsonStr(diff.files)}; const names = ${jsonStr(w.diffStatus)}; const boxes = [...document.querySelectorAll('.detail.acc .df')]; const add = want.reduce((s, f) => s + f.additions, 0), del = want.reduce((s, f) => s + f.deletions, 0); return boxes.length === want.length && boxes.every((box, i) => box.querySelector('.p').textContent === want[i].path && box.querySelector('.tag').textContent === names[want[i].status] && box.querySelector('.cnt .a').textContent === '+' + want[i].additions && box.querySelector('.cnt .d').textContent === '−' + want[i].deletions) && document.querySelector('.detail.acc .tab-body .sec-t').textContent.startsWith(${jsonStr(w.diffHead(diff.files.length, diff.files.reduce((s, f) => s + f.additions, 0), diff.files.reduce((s, f) => s + f.deletions, 0)))}) && document.querySelector('.detail.acc .tab-body .sec-t .mono').textContent === ${jsonStr(w.baseToHead('main', sha7(diff.base), sha7(diff.head)))} && document.querySelector('[data-diff-all-truncated]') === null; })()`);
        await check('UI24 改动标签：默认展开前两个文件，第三个折叠；展开的文件里 + / − 行数与统计一致，增删行用成功 / 失败浅底', `(() => { const boxes = [...document.querySelectorAll('.detail.acc .df')]; const want = ${jsonStr(diff.files)}; const open = boxes.map(b => b.querySelector('.df-h').getAttribute('aria-expanded')); const first = boxes[0]; const soft = (v) => { const s = document.createElement('span'); s.style.backgroundColor = 'var(' + v + ')'; document.body.append(s); const c = getComputedStyle(s).backgroundColor; s.remove(); return c; }; const add = first.querySelector('.dl.add'); return open.join() === 'true,true,false' && !!boxes[1].querySelector('.df-b') && !boxes[2].querySelector('.df-b') && first.querySelectorAll('.dl.add').length === want[0].additions && first.querySelectorAll('.dl.del').length === want[0].deletions && getComputedStyle(add).backgroundColor === soft('--ok-soft') && (!first.querySelector('.dl.del') || getComputedStyle(first.querySelector('.dl.del')).backgroundColor === soft('--fail-bg')); })()`);
        await check('UI24 改动标签："在 worktree 打开"按钮在头部', `document.querySelector('.detail.acc .tab-body [data-acc-open=worktree]').textContent.trim() === ${jsonStr(w.diffOpen)}`);
        const opensBefore = effects.openLog.length;
        await press('[data-acc-open=worktree]');
        await h.happened('UI24 在 worktree 打开调用打开通道', () => effects.openLog.length > opensBefore, 3000);
        await verify('UI24 在 worktree 打开：打开通道收到这个任务的 worktree 目录', () => assert.equal(path.resolve(effects.openLog.at(-1)!.path).toLowerCase(), path.resolve(wA.dir).toLowerCase()));
        await shots('accept-diff');
        // 键盘折叠 / 展开。
        await tabTo('[data-df="0"]', 120);
        await focusRing('UI24 改动文件标题');
        await key('Enter');
        await check('UI24 键盘 Enter 折叠第一个文件：aria-expanded 为 false，内容移除，焦点仍在标题上', `(() => { const h = document.querySelector('[data-df="0"]'); return h.getAttribute('aria-expanded') === 'false' && !h.parentElement.querySelector('.df-b') && document.activeElement === h; })()`);
        await key('Space');
        await check('UI24 键盘空格展开：aria-expanded 为 true，内容回来', `(() => { const h = document.querySelector('[data-df="0"]'); return h.getAttribute('aria-expanded') === 'true' && !!h.parentElement.querySelector('.df-b') && document.activeElement === h; })()`);
        await tabTo('[data-df="2"]', 120);
        await key('Enter');
        await check('UI24 键盘展开第三个文件：行数与统计一致', `(() => { const b = document.querySelector('[data-df-box="2"]'); const want = ${jsonStr(diff.files[2])}; return b.querySelector('.df-h').getAttribute('aria-expanded') === 'true' && b.querySelectorAll('.dl.add').length === want.additions && b.querySelectorAll('.dl.del').length === want.deletions; })()`);
        await press('[data-atab=overview]');
        await audit('验收页', async () => { await press('[data-page=accept]'); await wait('!!document.querySelector("[data-acc]")'); await press(`[data-acc="${A.id}"]`); await press('[data-atab=diff]'); await wait('document.querySelectorAll(".detail.acc .df").length > 0'); });
        await press('[data-atab=overview]');

        // ---- 任务页上的真实待验收任务 ----
        await selectTask(A.id);
        await check('UI24 真实待验收任务在任务页：品牌色标记、第二行"等你验收"、状态行"待验收 · 已等"、轨道门禁节点按真实门禁结果、横幅与"去验收"', `(() => { const n = [...document.querySelectorAll('.track .node')]; return document.querySelector('[data-task="${A.id}"] .mk').classList.contains('brand') && document.querySelector('[data-task="${A.id}"] .tm em.attn').textContent === ${jsonStr(w.subAwaiting)} && /^待验收 · 已等 /.test(document.querySelector('.dh-state').textContent) && n.length === 5 && n[2].classList.contains('done') && n[3].classList.contains('attn') && !!document.querySelector('.banner-holder .banner.brand [data-go-accept]'); })()`);

        // ---- 主工作区不在 baseBranch 时批准：核心拒绝，什么都没改 ----
        git(repo, ['switch', '-c', 'feat/other']);
        const mainBeforeBlocked = git(repo, ['rev-parse', 'main']), headBeforeBlocked = git(repo, ['rev-parse', 'HEAD']);
        const indexBefore = git(repo, ['ls-files', '-s']);
        await selectAccept(A.id);
        await press('[data-acc-approve]');
        await wait('!!document.querySelector(".confirm-card")', 'UI24 批准确认框');
        await check('UI24 批准确认框：标题、说明（合并方式与删除 worktree 的提示）、默认焦点在取消，主按钮"批准并合并"', `(() => { const card = document.querySelector('.confirm-card'); const b = [...card.querySelectorAll('button')]; return card.querySelector('h2').textContent === ${jsonStr(w.approveTitle(tA.title, 'main'))} && card.querySelector('p').textContent === ${jsonStr(w.approveBody('no-ff', wA.branch))} && b.map(x => x.textContent).join() === ${jsonStr([c.cancel, w.approve].join())} && document.activeElement === b[0] && b[1].classList.contains('primary'); })()`);
        await shots('accept-approve-confirm');
        await press('.confirm-actions .btn.primary');
        await wait(`!!document.querySelector('.detail.acc .tab-body .banner.fail')`, 'UI24 被拒的合并显示失败横幅', 60000);
        const blockedReason = `主工作区当前在 feat/other，合并要在 main 上进行：先 git switch main`;
        await check('UI24 主工作区不在 main：失败横幅标题 wt.blockedTitle，正文是核心原文 + "什么都没有改动"，带"复制命令"', `(() => { const b = document.querySelector('.detail.acc .tab-body .banner.fail'); return b.querySelector('.rt b').textContent === ${jsonStr(w.blockedTitle)} && b.querySelector('.rt span').textContent === ${jsonStr(w.blockedHelp(blockedReason))} && b.getAttribute('role') === 'alert' && b.querySelector('[data-acc-copy]').textContent === ${jsonStr(w.copyCommand)}; })()`);
        await verify('UI24 被拒之后主分支、主工作区都没变：main 的提交、HEAD、暂存区、git status 与批准前相同，任务仍是待验收', async () => {
            assert.equal(git(repo, ['rev-parse', 'main']), mainBeforeBlocked);
            assert.equal(git(repo, ['rev-parse', 'HEAD']), headBeforeBlocked);
            assert.equal(git(repo, ['ls-files', '-s']), indexBefore);
            assert.equal(git(repo, ['status', '--porcelain']), '');
            assert.equal(worktreeState(taskOf(A.id)!), 'awaiting');
            assert.ok(!(await eventsOf(A.id)).some(r => r.event === 'accepted' || r.event === 'conflict'));
        });
        await shots('accept-blocked');
        const copiesBlocked = effects.copyLog.length;
        await press('[data-acc-copy]');
        await h.happened('UI24 复制命令写入剪贴板', () => effects.copyLog.length > copiesBlocked, 3000);
        await verify('UI24 复制命令：剪贴板桩收到 git switch main', () => assert.equal(effects.copyLog.at(-1)!.text, 'git switch main'));
        git(repo, ['switch', 'main']);

        // ---- 批准并合并 ----
        console.log('验收检查进度：被拒的合并检查完成，开始批准并合并');
        const mainBefore = git(repo, ['rev-parse', 'main']);
        await press('[data-acc-approve]');
        await wait('!!document.querySelector(".confirm-card")');
        await press('.confirm-actions .btn.primary');
        await wait(`!document.querySelector('[data-acc="${A.id}"]') && !!document.querySelector('.toast')`, 'UI24 批准成功：列表移除这一项并出现 toast', 90000);
        const mergeEvent = await untilRow(async () => (await rows()).find(r => r.id === A.id && r.event === 'accepted'), 'accepted 事件', 15000);
        await verify('UI24 批准成功：main 上恰好多一个合并提交（信息为协议原文），worktree 目录与 ar/ 分支都已删除，清单 accepted 的 by 是 human', async () => {
            const after = git(repo, ['rev-parse', 'main']);
            assert.notEqual(after, mainBefore);
            assert.equal(git(repo, ['rev-list', '--count', '--merges', `${mainBefore}..main`]), '1', '恰好一个合并提交');
            assert.equal(git(repo, ['log', '-1', '--format=%s', 'main']), `[执行] 合并 ${A.name}：${specs.a.title}`);
            assert.equal(git(repo, ['rev-list', '--parents', '-1', 'main']).split(' ').length, 3, 'main 最新一个提交是合并提交（两个父提交）');
            assert.equal(mergeEvent.merge, after);
            assert.equal(mergeEvent.by, 'human');
            assert.equal(mergeEvent.mode, 'no-ff');
            assert.ok(!existsSync(wA.dir), 'worktree 目录应已删除');
            assert.equal(git(repo, ['branch', '--list', wA.branch]), '', 'ar/ 分支应已删除');
            assert.ok(!(await eventsOf(A.id)).some(r => r.event === 'cleanup'), '清理成功没有 cleanup 失败事件');
            assert.equal(await readFile(path.join(repo, 'src', 'ok.txt'), 'utf8'), 'ok 1\nok 2\nok 3\n');
        });
        const mergeSha = String(mergeEvent.merge);
        await check('UI24 批准成功的 toast：已合并「任务名」到 main：提交 → 合并提交，带"撤销说明"', `(() => { const t = document.querySelector('.toast'); return t.getAttribute('role') === 'status' && t.querySelector('span:not(.mk)').textContent === ${jsonStr(w.mergedToast(tA.title, 'main', sha7(String(diff.head)), sha7(mergeSha)))} && t.querySelector('[data-acc-undo]').textContent === ${jsonStr(w.undoHelp)}; })()`);
        await shots('accept-merged');
        const copiesUndo = effects.copyLog.length;
        await press('[data-acc-undo]');
        await h.happened('UI24 撤销说明写入剪贴板', () => effects.copyLog.length > copiesUndo, 3000);
        await verify('UI24 撤销说明：剪贴板桩收到 git revert -m 1 <合并提交>，且这个短哈希确实是合并提交', () => {
            const text = effects.copyLog.at(-1)!.text;
            assert.equal(text, w.undoText(sha7(mergeSha), 'no-ff'));
            assert.equal(git(repo, ['rev-parse', `${sha7(mergeSha)}^{commit}`]), mergeSha);
        });
        await check('UI24 批准之后侧栏"验收"徽标减一（剩下 B、X、Y 三个）', `document.querySelector('[data-page=accept] .count').textContent === '3'`);
        // 任务页：已合并。
        await untilState(A.id, 'accepted', 30000);
        await selectTask(A.id);
        await wait(`document.querySelector('[data-task="${A.id}"] .mk')?.classList.contains('ok') === true && document.querySelector('.dh-state')?.classList.contains('ok') === true`, 'UI24 任务页收到已合并状态', 20000);
        await check('UI24 批准后任务页：已合并标记与第二行、状态行"已合并 · 时刻 你批准"、轨道、横幅、没有重试', `(() => { const n = [...document.querySelectorAll('.track .node')]; const b = document.querySelector('.banner-holder .banner.ok'); return document.querySelector('[data-task="${A.id}"] .mk').classList.contains('ok') && document.querySelector('[data-task="${A.id}"] .tm > span').textContent.endsWith(${jsonStr(' · ' + w.subAccepted(sha7(mergeSha)))}) && document.querySelector('.dh-state').textContent.endsWith('你批准') && n[4].querySelector('.sub').textContent === ${jsonStr(sha7(mergeSha))} && b.querySelector('.rt b').textContent === ${jsonStr(w.acceptedTitle('main'))} && b.querySelector('.rt span').textContent.includes(${jsonStr(sha7(mergeSha))}) && !document.querySelector('[data-retry]') && !!document.querySelector('[data-redispatch]'); })()`);
        await shots('wt-accepted');

        // ---- 驳回（保留分支）----
        await selectAccept(B.id);
        await press(`[data-acc-reject="${B.id}"]`);
        await wait('!!document.querySelector(".sheet [data-reject-reason]")', 'UI24 驳回弹窗');
        await check('UI24 驳回弹窗：标题、原因必填（星号）、保留分支复选框默认不勾、说明文字、驳回按钮是危险样式且在原因为空时禁用，焦点在原因输入框', `(() => { const s = document.querySelector('.sheet'); const p = s.querySelector('[data-sheet-btn="1"]'); const keep = s.querySelector('[data-keep-branch]'); return s.getAttribute('aria-label') === ${jsonStr(w.rejectTitle(tB.title))} && s.querySelector('.fl em') !== null && s.querySelector('[data-reject-reason]').placeholder === ${jsonStr(w.rejectPh)} && keep.getAttribute('aria-checked') === 'false' && keep.textContent.includes(${jsonStr(w.rejectKeep(wB.branch))}) && s.querySelector('.sheet-f .note').textContent === ${jsonStr(w.rejectNote('main'))} && p.textContent.trim() === ${jsonStr(w.rejectButton)} && p.classList.contains('danger') && p.disabled === true && document.activeElement === s.querySelector('[data-reject-reason]'); })()`);
        await type('[data-reject-reason]', '   ');
        await check('UI24 原因只有空白时驳回按钮仍禁用', `document.querySelector('.sheet [data-sheet-btn="1"]').disabled === true`);
        const reason = 'wrong direction: follow the system theme';
        await type('[data-reject-reason]', reason);
        await check('UI24 写了原因后驳回按钮可用', `document.querySelector('.sheet [data-sheet-btn="1"]').disabled === false`);
        await shots('accept-reject');
        await press('[data-keep-branch]');
        await check('UI24 勾选"保留分支"：复选框点亮', `document.querySelector('[data-keep-branch]').getAttribute('aria-checked') === 'true' && !!document.querySelector('[data-keep-branch] .cb.on')`);
        const mainBeforeReject = git(repo, ['rev-parse', 'main']);
        await press('.sheet [data-sheet-btn="1"]');
        await wait(`!document.querySelector('.sheet') && !document.querySelector('[data-acc="${B.id}"]')`, 'UI24 驳回成功：弹窗关闭、列表移除这一项', 60000);
        const rejectEvent = await untilRow(async () => (await rows()).find(r => r.id === B.id && r.event === 'rejected'), 'rejected 事件', 15000);
        await verify('UI24 驳回成功：清单 rejected 的 reason 是输入原文（去掉首尾空白）、keptBranch 与勾选一致、by 是 human；worktree 已删、分支保留、main 不变', () => {
            assert.equal(rejectEvent.reason, reason);
            assert.equal(rejectEvent.keptBranch, true);
            assert.equal(rejectEvent.by, 'human');
            assert.ok(!existsSync(wB.dir));
            assert.ok(git(repo, ['branch', '--list', wB.branch]).length > 0, '勾选保留时分支还在');
            assert.equal(git(repo, ['rev-parse', 'main']), mainBeforeReject);
        });
        await untilState(B.id, 'rejected', 30000);
        await selectTask(B.id);
        await wait(`document.querySelector('[data-task="${B.id}"] .mk')?.classList.contains('stale') === true && !!document.querySelector('.banner-holder .banner.stale')`, 'UI24 任务页收到已驳回状态', 20000);
        await check('UI24 驳回后任务页：已驳回标记、状态行"已驳回 · 时刻 你驳回"、横幅写原因并说明分支保留、没有重试', `(() => { const b = document.querySelector('.banner-holder .banner.stale'); return document.querySelector('[data-task="${B.id}"] .mk').classList.contains('stale') && document.querySelector('[data-task="${B.id}"] .tm > span').textContent.endsWith(${jsonStr(' · ' + w.subRejected)}) && document.querySelector('.dh-state').textContent.endsWith('你驳回') && b.querySelector('.rt b').textContent === ${jsonStr(w.rejectedTitle)} && b.querySelector('.rt span').textContent.startsWith(${jsonStr(reason + '（')}) && b.querySelector('.rt span').textContent.endsWith(${jsonStr(`你驳回）。worktree 已删除，分支 ${wB.branch} 保留。`)}) && !document.querySelector('[data-retry]') && !!document.querySelector('[data-redispatch]'); })()`);
        await shots('wt-rejected');

        // ================= UI25 =================
        console.log('验收检查进度：UI24 完成，开始 UI25');
        // ---- 合并冲突：X 与 Y 改同一行 ----
        await selectAccept(X.id);
        await press(`[data-acc-approve="${X.id}"]`);
        await wait('!!document.querySelector(".confirm-card")');
        await press('.confirm-actions .btn.primary');
        await wait(`!document.querySelector('[data-acc="${X.id}"]') && !!document.querySelector('.toast')`, 'UI25 先批准 X 成功', 90000);
        await verify('UI25 先批准的 X 合并成功：main 上 shared.txt 是 X 的版本', async () => { assert.equal(await readFile(path.join(repo, 'src', 'shared.txt'), 'utf8'), 'one\nTWO-X\nthree\n'); });
        const mainBeforeConflict = git(repo, ['rev-parse', 'main']), indexBeforeConflict = git(repo, ['ls-files', '-s']);
        await selectAccept(Y.id);
        await press(`[data-acc-approve="${Y.id}"]`);
        await wait('!!document.querySelector(".confirm-card")');
        await press('.confirm-actions .btn.primary');
        await wait(`!!document.querySelector('.detail.acc .tab-body .banner.fail') && !!document.querySelector('[data-acc-rebase]')`, 'UI25 冲突横幅与"解决冲突并重试"', 90000);
        await untilState(Y.id, 'conflict', 30000);
        await check('UI25 冲突横幅：列出冲突文件、说明 main 没有变化；主按钮变成"解决冲突并重试"，底部只有驳回与它，状态行是冲突', `(() => { const b = document.querySelector('.detail.acc .tab-body .banner.fail'); const acts = [...document.querySelectorAll('.detail.acc .actbar button')].map(x => x.textContent.trim()); return b.querySelector('.rt b').textContent === ${jsonStr(w.conflictTitle)} && b.querySelector('.rt span').textContent === ${jsonStr(w.conflictPageHelp('main', ['src/shared.txt']))} && acts.join() === ${jsonStr([w.reject, w.resolve].join())} && document.querySelector('.actbar .btn.primary').textContent === ${jsonStr(w.resolve)} && document.querySelector('.dh-state').textContent === ${jsonStr(w.lineConflict(1))} && document.querySelector('.actbar .note').textContent === ${jsonStr(w.noteConflict)}; })()`);
        await verify('UI25 冲突之后主分支字节不变（main 的提交、暂存区、git status 与批准前相同，没有合并进行中的痕迹），清单有 conflict 事件且文件清单是 src/shared.txt', async () => {
            assert.equal(git(repo, ['rev-parse', 'main']), mainBeforeConflict);
            assert.equal(git(repo, ['ls-files', '-s']), indexBeforeConflict);
            assert.equal(git(repo, ['status', '--porcelain']), '');
            assert.ok(!existsSync(path.join(repo, '.git', 'MERGE_HEAD')));
            assert.equal(await readFile(path.join(repo, 'src', 'shared.txt'), 'utf8'), 'one\nTWO-X\nthree\n');
            const conflict = (await eventsOf(Y.id)).findLast(r => r.event === 'conflict');
            assert.deepEqual(conflict.files, ['src/shared.txt']);
            assert.ok(!(await eventsOf(Y.id)).some(r => r.event === 'accepted'));
        });
        await shots('accept-conflict-real');
        await check('UI25 冲突之后侧栏"验收"徽标是 1（只剩冲突的 Y），列表里这一项的第二行是品牌色的冲突文件数', `document.querySelector('[data-page=accept] .count').textContent === '1' && document.querySelector('[data-acc="${Y.id}"] .tm em.attn').textContent === ${jsonStr(w.subConflict(1))} && document.querySelector('[data-acc="${Y.id}"] .mk').classList.contains('brand')`);
        await audit('验收页（冲突）', async () => { await press('[data-page=accept]'); await wait('!!document.querySelector("[data-acc]")'); await press(`[data-acc="${Y.id}"]`); });
        // ---- 点"解决冲突并重试"：任务回到进行中，执行者解决冲突，再次待验收 ----
        await selectAccept(Y.id);
        const resumesBefore = (await eventsOf(Y.id)).filter(r => r.event === 'resume').length;
        await press(`[data-acc-rebase="${Y.id}"]`);
        await untilRow(async () => (await eventsOf(Y.id)).filter(r => r.event === 'resume').length > resumesBefore ? true : null, 'UI25 解决冲突写 resume', 60000);
        await untilState(Y.id, 'running', 60000);
        await wait(`!document.querySelector('[data-acc="${Y.id}"]')`, 'UI25 回到进行中后验收页不再列它', 20000);
        await goTasks();
        await wait(`document.querySelector('[data-task="${Y.id}"] .mk')?.classList.contains('run') === true`, 'UI25 任务页显示进行中', 20000);
        await verify('UI25 解决冲突并重试：核心在原 worktree 里合并 main，清单 resume 之后是 conflict 原因的新尝试，worktree 仍是同一个目录', async () => {
            const events = await eventsOf(Y.id);
            const attempt = events.findLast(r => r.event === 'attempt');
            assert.equal(attempt.reason, 'conflict');
            assert.equal(attempt.base, mainBeforeConflict);
            assert.equal((await wtOf(Y.id)).dir, wY.dir);
            assert.ok(existsSync(wY.dir));
        });
        await shots('wt-resolving');
        await writeFile(resolveFlag, 'go\n');
        await untilState(Y.id, 'awaiting', 120000);
        await verify('UI25 再次待验收：执行者提交了合并，门禁通过，清单最后是 end exit 0；main 一直没动', async () => {
            const events = await eventsOf(Y.id);
            assert.equal(events.at(-1).event, 'end');
            assert.equal(events.at(-1).exit, 0);
            assert.equal(events.findLast(r => r.event === 'gate').ok, true);
            assert.equal(git(wY.dir, ['rev-list', '--parents', '-1', 'HEAD']).split(' ').length, 3, 'worktree 最后一个提交是合并提交');
            assert.equal(git(repo, ['rev-parse', 'main']), mainBeforeConflict);
        });
        await selectAccept(Y.id);
        await check('UI25 再次待验收的任务回到验收页：没有冲突横幅，主按钮是"批准并合并"', `!document.querySelector('.detail.acc .tab-body .banner.fail') && document.querySelector('.actbar .btn.primary').textContent === ${jsonStr(w.approve)} && document.querySelector('.dh-state').textContent.startsWith(${jsonStr(w.lineAwaiting('').slice(0, 6))})`);
        await press(`[data-acc-approve="${Y.id}"]`);
        await wait('!!document.querySelector(".confirm-card")');
        await press('.confirm-actions .btn.primary');
        await wait(`!document.querySelector('[data-acc="${Y.id}"]') && !!document.querySelector('.toast')`, 'UI25 再批准成功', 90000);
        const yMerge = await untilRow(async () => (await rows()).find(r => r.id === Y.id && r.event === 'accepted'), 'Y 的 accepted 事件', 15000);
        await verify('UI25 再批准成功：main 上是解决后的内容，清单 accepted by human，worktree 与分支已删除', async () => {
            assert.equal(await readFile(path.join(repo, 'src', 'shared.txt'), 'utf8'), 'one\nTWO-X TWO-Y\nthree\n');
            assert.equal(yMerge.by, 'human');
            assert.equal(yMerge.merge, git(repo, ['rev-parse', 'main']));
            assert.ok(!existsSync(wY.dir));
            assert.equal(git(repo, ['branch', '--list', wY.branch]), '');
        });
        // 列表是界面先移除的，侧栏徽标等快照更新（核心写清单 → 监听 → 重读）：等它，再核对。
        await wait('!document.querySelector("[data-page=accept] .count")', 'UI25 侧栏验收徽标随快照消失', 15000);
        await check('UI25 验收页没有待验收的任务了：空状态 wt.emptyTitle / wt.emptyHelp，侧栏徽标消失', `document.querySelector('.acc-main .empty b').textContent === ${jsonStr(w.emptyTitle)} && document.querySelector('.acc-main .empty p').textContent === ${jsonStr(w.emptyHelp)} && !document.querySelector('[data-page=accept] .count')`);
        await shots('accept-empty');

        // ---- 并发排队：concurrency 1，第二个排队，停止它，第一个照常完成 ----
        console.log('验收检查进度：冲突检查完成，开始并发排队');
        await writeConfig(1);
        const Q1 = await dispatchTask(specs.q1.file, 'queue-1', 'hold');
        await untilRow(async () => (await eventsOf(Q1.id)).find(r => r.event === 'attempt'), 'UI25 第一个排队测试任务开始执行', 90000);
        const Q2 = await dispatchTask(specs.q2.file, 'queue-2', 'hold');
        await untilRow(async () => (await eventsOf(Q2.id)).find(r => r.event === 'queued'), 'UI25 第二个任务开始排队', 60000);
        await registry.refresh();
        await untilState(Q2.id, 'queued', 20000);
        await selectTask(Q2.id);
        await check('UI25 排队中：列表第二行 wt.subQueued、状态行"排队中 · 已等"、横幅写并发上限 1 与前面的任务数 0、标题行只有"停止"', `(() => { const acts = [...document.querySelectorAll('.dh-1 .acts button')].map(b => b.dataset.stop !== undefined ? 'stop' : b.dataset.more !== undefined ? 'more' : b.textContent.trim()); return document.querySelector('[data-task="${Q2.id}"] .tm > span').textContent.endsWith(${jsonStr(' · ' + w.subQueued(0))}) && /^排队中 · 已等 \\d+:\\d\\d$/.test(document.querySelector('.dh-state').textContent) && document.querySelector('.banner-holder .banner.info .rt span').textContent === ${jsonStr(w.queuedHelp(1, 0))} && acts.join() === 'stop,more' && !document.querySelector('[data-go-accept]'); })()`);
        await shots('wt-queued-real');
        await audit('任务页（排队中）', async () => { await press('[data-page=tasks]'); await press(`[data-task="${Q2.id}"]`); });
        await press('[data-stop]');
        await wait('!!document.querySelector(".confirm-card")');
        await press('.confirm-actions .btn.danger');
        await wait(`document.querySelector('[data-task="${Q2.id}"] .mk i')?.classList.contains('ri-stop-circle-line') === true`, 'UI25 停止排队中的任务：列表显示中断', 60000);
        // 进程消失超过宽限期时列表会先显示中断，核心确认进程退出后才写 interrupted：等它写出来再核对清单。
        await untilRow(async () => (await eventsOf(Q2.id)).find(r => r.event === 'interrupted'), 'UI25 停止后清单里的 interrupted', 30000);
        await verify('UI25 停止排队中的任务：清单有 interrupted、没有 preparing（不留任何东西）', async () => {
            const names = (await eventsOf(Q2.id)).map(r => r.event);
            assert.ok(names.includes('interrupted'), names.join());
            assert.ok(!names.includes('preparing'), names.join());
            assert.ok(!names.includes('worktree'));
            assert.equal(worktreeState(taskOf(Q2.id)!), 'stopped');
        });
        await check('UI25 列表显示中断（标记 stale），详情里不再有"停止"', `document.querySelector('[data-task="${Q2.id}"] .mk').classList.contains('stale') && !!document.querySelector('[data-task="${Q2.id}"] .mk i.ri-stop-circle-line') && !document.querySelector('[data-stop]')`);
        await verify('UI25 第一个任务这时仍在运行（占着名额），没有被停止', async () => { await registry.refresh(); assert.equal(worktreeState(taskOf(Q1.id)!), 'running'); });
        await writeFile(holdFlag, 'go\n');
        await untilState(Q1.id, 'awaiting', 120000);
        await verify('UI25 放行后第一个任务照常完成：end exit 0，进入待验收', async () => {
            const events = await eventsOf(Q1.id);
            assert.equal(events.at(-1).event, 'end');
            assert.equal(events.at(-1).exit, 0);
        });
        await goAccept();
        await check('UI25 第一个任务出现在验收页（待验收），第二个（已中断）不在', `!!document.querySelector('[data-acc="${Q1.id}"]') && !document.querySelector('[data-acc="${Q2.id}"]')`);

        // ---- 准备失败 ----
        console.log('验收检查进度：排队检查完成，开始准备失败');
        await initRepo(repo2, 'setup-fail', ['git cat-file -e HEAD:no-such-file']);
        await writeFile(path.join(repo2, 'docs', 'specs', '097-准备失败.md'), specText(7, { title: '准备失败任务', verify: 'git cat-file -e HEAD:src/a.txt' }));
        git(repo2, ['add', '--', 'docs/specs']);
        git(repo2, ['commit', '-m', '任务说明', '--', 'docs/specs']);
        // 项目要先登记：没登记的项目任务页会多一条“项目已移除”横幅（116），这里要检查的是准备失败的横幅，所以派发前就登记；检查结束时由 finally 移除。
        await core(['projects', 'add', repo2]);
        registered.push(repo2);
        await writeConfig(2);
        const F = await dispatchTask('097-准备失败', 'setup-fail', 'plain', repo2);
        const failEnd = await untilRow(async () => (await eventsOf(F.id)).find(r => r.event === 'end'), 'UI25 准备失败的 end', 90000);
        await verify('UI25 准备失败：清单 setup ok:false，end exit 1 带 reason "setup"，没有 attempt，worktree 保留', async () => {
            const events = await eventsOf(F.id);
            assert.equal(failEnd.exit, 1);
            assert.equal(failEnd.reason, 'setup');
            assert.equal(events.find(r => r.event === 'setup').ok, false);
            assert.ok(!events.some(r => r.event === 'attempt'));
            assert.ok(existsSync((await wtOf(F.id)).dir));
        });
        await untilState(F.id, 'failed', 30000);
        await selectTask(F.id);
        await check('UI25 准备失败：横幅文案 wt.setupFailTitle / wt.setupFailHelp，标题行有"重试"，没有"去验收"，也没有通用的失败横幅', `(() => { const b = document.querySelector('.banner-holder .banner.fail'); const acts = [...document.querySelectorAll('.dh-1 .acts button')].map(x => x.dataset.retry !== undefined ? 'retry' : x.dataset.redispatch !== undefined ? 'again' : x.dataset.more !== undefined ? 'more' : x.textContent.trim()); return b.querySelector('.rt b').textContent === ${jsonStr(w.setupFailTitle)} && b.querySelector('.rt span').textContent === ${jsonStr(w.setupFailHelp)} && document.querySelectorAll('.banner-holder .banner').length === 1 && !!document.querySelector('[data-retry]') && !document.querySelector('[data-go-accept]') && acts.join() === 'retry,again,more' && !document.querySelector('[data-task="${F.id}"] .tm em.attn'); })()`);
        await shots('wt-setup-failed');
        await goAccept();
        await check('UI25 准备失败的任务不在验收页列表里（没有"去验收"）', `!document.querySelector('[data-acc="${F.id}"]')`);
        await goTasks();
        await audit('任务页（准备失败）', async () => { await press('[data-page=tasks]'); await press(`[data-task="${F.id}"]`); });
        // 驳回入口：准备失败的横幅右侧的"驳回…"打开验收页同一个驳回弹窗（协议 15.7 允许驳回准备失败的任务）。
        await selectTask(F.id);
        await check('UI25 准备失败的横幅右侧有"驳回…"按钮（wt.setupFailReject）', `document.querySelector('.banner-holder .banner.fail [data-setup-reject]')?.textContent.trim() === ${jsonStr(w.setupFailReject)}`);
        const failedWt = await wtOf(F.id);
        // 项目在派发前已登记（见上）；驳回本来也不要求项目已登记（116）。
        await press('[data-setup-reject]');
        await wait('!!document.querySelector(".sheet [data-reject-reason]")', 'UI25 准备失败的驳回弹窗');
        await check('UI25 准备失败的驳回弹窗与验收页同一个：原因必填，驳回按钮是危险样式且在原因为空时禁用', `(() => { const s = document.querySelector('.sheet'); const p = s.querySelector('[data-sheet-btn="1"]'); return s.getAttribute('aria-label') === ${jsonStr(w.rejectTitle(taskOf(F.id)!.title))} && s.querySelector('.fl em') !== null && p.classList.contains('danger') && p.disabled === true; })()`);
        const failedReason = 'setup command cannot be fixed, drop this task';
        await type('[data-reject-reason]', failedReason);
        await press('.sheet [data-sheet-btn="1"]');
        await wait(`!document.querySelector('.sheet')`, 'UI25 准备失败的驳回成功：弹窗关闭', 60000);
        const failedReject = await untilRow(async () => (await eventsOf(F.id)).find(r => r.event === 'rejected'), 'UI25 准备失败的 rejected 事件', 15000);
        await untilState(F.id, 'rejected', 30000);
        await verify('UI25 准备失败的任务驳回后：清单 rejected 的 reason 是输入原文、by 是 human，worktree 目录已删除', () => {
            assert.equal(failedReject.reason, failedReason);
            assert.equal(failedReject.by, 'human');
            assert.ok(!existsSync(failedWt.dir), 'worktree 目录应已删除');
        });
        await selectTask(F.id);
        await check('UI25 准备失败的任务驳回后任务页显示已驳回（横幅是已驳回，不再有"驳回…"按钮）', `!!document.querySelector('.banner-holder .banner.stale') && !document.querySelector('[data-setup-reject]') && document.querySelector('[data-task="${F.id}"] .mk').classList.contains('stale')`);

        // ================= UI24 扩展（Stage07 T6）：调研类任务只读运行，门禁通过后“确认”（不合并，只删 worktree 与分支）=================
        console.log('验收检查进度：准备失败检查完成，开始调研类任务');
        await writeFile(path.join(repo, 'docs', 'specs', '098-调研只读.md'), researchSpec(98, '调研只读任务'));
        await writeFile(path.join(repo, 'docs', 'specs', '099-调研偷改.md'), researchSpec(99, '调研偷改任务'));
        git(repo, ['add', '--', 'docs/specs/098-调研只读.md', 'docs/specs/099-调研偷改.md']);
        git(repo, ['commit', '-m', '调研任务说明', '--', 'docs/specs/098-调研只读.md', 'docs/specs/099-调研偷改.md']);
        const R = await dispatchTask('098-调研只读', 'research-r', 'research');
        const S = await dispatchTask('099-调研偷改', 'research-s', 'sneak');
        await untilState(R.id, 'awaiting', 150000);
        const sEnd = await untilRow(async () => (await eventsOf(S.id)).find(r => r.event === 'end'), 'UI24 偷改文件的调研任务结束', 150000);
        await verify('UI24 调研任务只读运行：start 与 dispatch.json 记 readOnly；偷改了文件的那个门禁不通过，summary 写"只读任务改动了文件"，退出码 3', async () => {
            assert.equal(R.start.readOnly, true);
            assert.equal(S.start.readOnly, true);
            const dispatchJson = JSON.parse(await readFile(path.join(repo, '.agent-runs', 'research-r', 'dispatch.json'), 'utf8'));
            assert.equal(dispatchJson.readOnly, true);
            const gate = (await eventsOf(S.id)).findLast(r => r.event === 'gate');
            assert.equal(gate.ok, false);
            assert.match(gate.summary, /只读任务改动了文件：.*src\/a\.txt/);
            assert.equal(sEnd.exit, 3);
            assert.equal((await eventsOf(R.id)).findLast(r => r.event === 'gate').ok, true, '没有改动的调研任务门禁通过');
        });
        const tR = taskOf(R.id)!, wR = await wtOf(R.id);
        await selectAccept(R.id);
        await wait(`!!document.querySelector('.detail.acc .tab-body .banner.info')`, 'UI24 调研横幅', 20000);
        await check('UI24 调研任务的验收页：信息横幅 wt.researchTitle / wt.researchHelp，"改动"标签数量是 0，底栏说明 wt.noteConfirm，按钮是驳回 · 重试 · 确认，没有"批准并合并"', `(() => { const b = document.querySelector('.detail.acc .tab-body .banner.info'); const acts = [...document.querySelectorAll('.detail.acc .actbar button')].map(x => x.textContent.trim()); return b.querySelector('.rt b').textContent === ${jsonStr(w.researchTitle)} && b.querySelector('.rt span').textContent === ${jsonStr(w.researchHelp)} && document.querySelector('[data-atab=diff] .n').textContent === '0' && document.querySelector('.actbar .note').textContent === ${jsonStr(w.noteConfirm)} && acts.join() === ${jsonStr([w.reject, w.retry, w.confirm].join())} && document.querySelector('.actbar .btn.primary').hasAttribute('data-acc-confirm') && !document.querySelector('[data-acc-approve]'); })()`);
        await shots('accept-research');
        const mainBeforeConfirm = git(repo, ['rev-parse', 'main']), commitsBeforeConfirm = git(repo, ['rev-list', '--count', 'main']);
        await press('[data-acc-confirm]');
        await wait(`!document.querySelector('[data-acc="${R.id}"]') && !!document.querySelector('.toast')`, 'UI24 确认成功：列表移除这一项并出现 toast', 90000);
        await check('UI24 确认没有二次确认框；toast 是 wt.confirmedToast，没有"撤销说明"按钮', `!document.querySelector('.confirm-overlay') && document.querySelector('.toast span:not(.mk)').textContent === ${jsonStr(w.confirmedToast(tR.title))} && !document.querySelector('[data-acc-undo]')`);
        const confirmEvent = await untilRow(async () => (await rows()).find(r => r.id === R.id && r.event === 'accepted'), 'UI24 确认的 accepted 事件', 15000);
        await verify('UI24 确认：仓库 git log 没有新提交，git worktree list 里没有它，分支删掉，清单 accepted 为 merge: null、mode: confirm、by: human', async () => {
            assert.equal(git(repo, ['rev-parse', 'main']), mainBeforeConfirm);
            assert.equal(git(repo, ['rev-list', '--count', 'main']), commitsBeforeConfirm);
            assert.ok(!git(repo, ['worktree', 'list', '--porcelain']).replaceAll('\\', '/').toLowerCase().includes(path.basename(wR.dir).toLowerCase()), 'git worktree list 里不应再有它');
            assert.ok(!existsSync(wR.dir), 'worktree 目录应已删除');
            assert.equal(git(repo, ['branch', '--list', wR.branch]), '', '分支应已删除');
            assert.equal(confirmEvent.merge, null);
            assert.equal(confirmEvent.mode, 'confirm');
            assert.equal(confirmEvent.by, 'human');
            assert.ok(!(await eventsOf(R.id)).some(r => r.event === 'cleanup'), '清理成功没有 cleanup 失败事件');
        });
        await untilState(R.id, 'accepted', 30000);
        await selectTask(R.id);
        await wait(`document.querySelector('.dh-state')?.textContent.startsWith(${jsonStr(w.subConfirmed)}) === true`, 'UI24 任务页收到已确认状态', 20000);
        await check('UI24 确认后任务详情显示"已确认"：列表标记与第二行、状态行 wt.lineConfirmed、横幅 wt.confirmedTitle / wt.confirmedHelp、轨道合并节点 wt.nodeConfirmed，没有重试', `(() => { const n = [...document.querySelectorAll('.track .node')]; const b = document.querySelector('.banner-holder .banner.ok'); const mk = document.querySelector('[data-task="${R.id}"] .mk'); return mk.classList.contains('ok') && mk.title === ${jsonStr(w.subConfirmed)} && document.querySelector('[data-task="${R.id}"] .tm > span').textContent.endsWith(${jsonStr(' · ' + w.subConfirmed)}) && document.querySelector('.dh-state').textContent.trim() === ${jsonStr(w.lineConfirmed(clockOf(confirmEvent.at), w.by.human))} && b.querySelector('.rt b').textContent === ${jsonStr(w.confirmedTitle)} && b.querySelector('.rt span').textContent === ${jsonStr(w.confirmedHelp(clockOf(confirmEvent.at), w.by.human))} && n.length === 5 && n[4].querySelector('.sub').textContent === ${jsonStr(w.subConfirmed)} && n[4].title === ${jsonStr(w.nodeConfirmed(w.by.human))} && !document.querySelector('[data-retry]') && !!document.querySelector('[data-redispatch]'); })()`);
        await shots('wt-confirmed');
        await selectTask(S.id);
        await wait(`!!document.querySelector('.banner-holder .banner.fail')`, 'UI24 偷改文件的调研任务显示门禁失败横幅', 20000);
        await check('UI24 偷改文件的调研任务：任务页门禁失败横幅写"只读任务改动了文件"', `document.querySelector('.banner-holder .banner.fail .rt span').textContent.includes('只读任务改动了文件')`);

        // ================= T116（Stage07 116）：项目从列表移除后，它的待验收任务不卡死 =================
        // 甲项目（gone-a）有三个待验收任务：G1（驳回）、G2（重新添加项目）、G4（调研类，确认）；丙项目（gone-missing）的 G3 用来查文件夹被删的情况。
        console.log('验收检查进度：调研类任务完成，开始项目移除后的任务（116）');
        const repoG = path.join(root, 'gone-a'), repoM = path.join(root, 'gone-missing');
        const goneSpecs: Record<string, { title: string; file: string }> = {
            g1: { title: '移除后驳回任务', file: '101-移除后驳回' }, g2: { title: '移除后重新添加任务', file: '102-移除后重新添加' },
            g3: { title: '文件夹被删任务', file: '103-文件夹被删' },
        };
        const goneVerify = 'git cat-file -e HEAD:src/rej.txt';
        for (const [dir, name, keys] of [[repoG, 'gone-a', ['g1', 'g2']], [repoM, 'gone-missing', ['g3']]] as const) {
            await initRepo(dir, name, []);
            for (const key of keys) await writeFile(path.join(dir, 'docs', 'specs', `${goneSpecs[key].file}.md`), specText(Number(key.slice(1)) + 10, { title: goneSpecs[key].title, verify: goneVerify }));
            if (dir === repoG) await writeFile(path.join(dir, 'docs', 'specs', '104-移除后确认.md'), researchSpec(14, '移除后确认调研任务'));
            git(dir, ['add', '--', 'docs/specs']);
            git(dir, ['commit', '-m', '任务说明', '--', 'docs/specs']);
            await core(['projects', 'add', dir]);
            registered.push(dir);
        }
        await writeConfig(2);
        const G1 = await dispatchTask(goneSpecs.g1.file, 'gone-1', 'b', repoG);
        const G2 = await dispatchTask(goneSpecs.g2.file, 'gone-2', 'b', repoG);
        const G4 = await dispatchTask('104-移除后确认', 'gone-4', 'research', repoG);
        const G3 = await dispatchTask(goneSpecs.g3.file, 'gone-3', 'b', repoM);
        for (const task of [G1, G2, G4, G3]) await untilState(task.id, 'awaiting', 150000);
        const tG1 = taskOf(G1.id)!, tG2 = taskOf(G2.id)!, tG4 = taskOf(G4.id)!, tG3 = taskOf(G3.id)!;
        const wG1 = await wtOf(G1.id), wG3 = await wtOf(G3.id);
        const tip = jsonStr(c.projectGoneBlocked);
        // ---- 项目页移除：确认框里列出还没处理完的任务 ----
        await press('[data-page=projects]');
        await wait(`[...document.querySelectorAll('[data-pj-row]')].some(b => b.dataset.pjRow === ${jsonStr(repoG)})`, 'T116 项目页列出甲项目', 20000);
        await evaluate(`(() => { const row = [...document.querySelectorAll('[data-pj-row]')].find(b => b.dataset.pjRow === ${jsonStr(repoG)}); row.setAttribute('data-pj-pick', ''); return true; })()`);
        await press('[data-pj-row][data-pj-pick]');
        await wait('!!document.querySelector("[data-pj=more]")', 'T116 项目详情');
        await press('[data-pj=more]');
        await press('.ctx button:nth-child(2)');
        await wait('!!document.querySelector(".confirm-overlay")', 'T116 移除确认框');
        await check('T116 移除确认框：说明下面写还有 3 个任务没处理完，逐个列出任务名，再加 pj.removePendingHelp；仍然是移除（危险）按钮', `(() => { const t = document.querySelector('#confirm-body').textContent; return t.includes(${jsonStr(pj.removeBody)}) && t.includes(${jsonStr(pj.removePending(3))}) && [${jsonStr(tG1.title)}, ${jsonStr(tG2.title)}, ${jsonStr(tG4.title)}].every(x => t.includes(x)) && t.includes(${jsonStr(pj.removePendingHelp)}) && t.indexOf(${jsonStr(pj.removeBody)}) < t.indexOf(${jsonStr(pj.removePending(3))}) && !!document.querySelector('.confirm-actions .danger'); })()`);
        await shots('project-remove-pending');
        await press('.confirm-actions .danger');
        await wait(`![...document.querySelectorAll('[data-pj-row]')].some(b => b.dataset.pjRow === ${jsonStr(repoG)})`, 'T116 移除后项目页没有甲项目', 20000);
        await verify('T116 移除只从列表拿掉项目：登记表里没有它，文件夹和任务记录还在', async () => {
            const list = await core(['projects', 'list', '--registry-only']);
            assert.ok(!list.projects.some((p: { path: string }) => path.resolve(p.path).toLowerCase() === path.resolve(repoG).toLowerCase()));
            assert.ok(existsSync(repoG) && existsSync(wG1.dir));
        });
        // ---- 任务页：横幅、再派一次与重试禁用 ----
        await selectTask(G1.id);
        await wait(`!!document.querySelector('.banner-holder [data-readd-project]')`, 'T116 任务页出现项目已移除横幅', 20000);
        await check('T116 任务页横幅：标题 c.projectGoneTitle、说明 c.projectGoneHelp(仓库路径)、按钮"重新添加项目"；"再派一次"禁用且悬停提示是 c.projectGoneBlocked；"去验收"仍可用', `(() => { const b = document.querySelector('.banner-holder .banner.brand'); const r = document.querySelector('[data-redispatch]'); return b.querySelector('.rt b').textContent === ${jsonStr(c.projectGoneTitle)} && b.querySelector('.rt span').textContent === ${jsonStr(c.projectGoneHelp(tG1.repo))} && b.querySelector('[data-readd-project]').textContent.trim() === ${jsonStr(c.projectGoneReAdd)} && r.disabled === true && r.dataset.tip === ${tip} && !!document.querySelector('[data-go-accept]') && document.querySelector('[data-go-accept]').disabled !== true; })()`);
        await shots('wt-project-gone');
        // ---- 验收页：批准并合并 / 重试禁用，驳回与确认可用 ----
        await selectAccept(G1.id);
        await wait(`!!document.querySelector('.detail.acc .tab-body [data-readd-project]')`, 'T116 验收页出现项目已移除横幅', 20000);
        await check('T116 验收页：顶部横幅同任务页；"批准并合并"与"重试…"禁用并带同一句悬停提示，"驳回…"可用', `(() => { const b = document.querySelector('.detail.acc .tab-body .banner.brand'); const a = document.querySelector('[data-acc-approve]'), r = document.querySelector('[data-acc-retry]'), j = document.querySelector('[data-acc-reject]'); return b.querySelector('.rt b').textContent === ${jsonStr(c.projectGoneTitle)} && b.querySelector('.rt span').textContent === ${jsonStr(c.projectGoneHelp(tG1.repo))} && a.disabled === true && a.dataset.tip === ${tip} && r.disabled === true && r.dataset.tip === ${tip} && j.disabled === false; })()`);
        await shots('accept-project-gone');
        // ---- 驳回：真实走完 ----
        await press(`[data-acc-reject="${G1.id}"]`);
        await wait('!!document.querySelector(".sheet [data-reject-reason]")', 'T116 项目已移除后的驳回弹窗');
        const goneReason = 'project was removed, drop this task';
        await type('[data-reject-reason]', goneReason);
        await press('.sheet [data-sheet-btn="1"]');
        await wait(`!document.querySelector('.sheet') && !document.querySelector('[data-acc="${G1.id}"]')`, 'T116 项目已移除后驳回成功', 60000);
        const goneReject = await untilRow(async () => (await eventsOf(G1.id)).find(r => r.event === 'rejected'), 'T116 rejected 事件', 15000);
        await untilState(G1.id, 'rejected', 30000);
        await verify('T116 项目已移除后驳回：清单 rejected 的 reason 是输入原文、by 是 human，worktree 目录已删除，项目仍不在登记表里', async () => {
            assert.equal(goneReject.reason, goneReason);
            assert.equal(goneReject.by, 'human');
            assert.ok(!existsSync(wG1.dir), 'worktree 目录应已删除');
            const list = await core(['projects', 'list', '--registry-only']);
            assert.ok(!list.projects.some((p: { path: string }) => path.resolve(p.path).toLowerCase() === path.resolve(repoG).toLowerCase()), '驳回不隐式登记项目');
        });
        // ---- 确认（调研类任务）：不要求项目登记 ----
        await selectAccept(G4.id);
        await wait(`!!document.querySelector('.detail.acc .tab-body [data-readd-project]') && !!document.querySelector('[data-acc-confirm]')`, 'T116 调研任务的验收页', 20000);
        await check('T116 调研任务在项目已移除时："确认"可用，"重试…"禁用', `document.querySelector('[data-acc-confirm]').disabled === false && document.querySelector('[data-acc-retry]').disabled === true`);
        await press('[data-acc-confirm]');
        await wait(`!document.querySelector('[data-acc="${G4.id}"]') && !!document.querySelector('.toast')`, 'T116 项目已移除后确认成功', 90000);
        const goneConfirm = await untilRow(async () => (await rows()).find(r => r.id === G4.id && r.event === 'accepted'), 'T116 确认的 accepted 事件', 15000);
        await verify('T116 项目已移除后确认：accepted 为 merge: null、mode: confirm、by: human，主分支没有新提交', () => {
            assert.equal(goneConfirm.merge, null);
            assert.equal(goneConfirm.mode, 'confirm');
            assert.equal(goneConfirm.by, 'human');
            assert.equal(git(repoG, ['rev-list', '--count', 'main']), '2');
        });
        // ---- 重新添加项目：横幅消失，按钮恢复 ----
        await selectAccept(G2.id);
        await wait(`!!document.querySelector('.detail.acc .tab-body [data-readd-project]')`, 'T116 G2 的验收页横幅', 20000);
        await press('[data-readd-project]');
        await wait(`!document.querySelector('.detail.acc .tab-body [data-readd-project]') && document.querySelector('[data-acc-approve]')?.disabled === false`, 'T116 重新添加项目后横幅消失、"批准并合并"恢复', 30000);
        await check('T116 重新添加项目后："批准并合并"与"重试…"可用且没有悬停提示，没有项目已移除横幅', `(() => { const a = document.querySelector('[data-acc-approve]'), r = document.querySelector('[data-acc-retry]'); return a.disabled === false && !a.dataset.tip && r.disabled === false && !r.dataset.tip && !document.querySelector('.detail.acc .tab-body .banner.brand'); })()`);
        await verify('T116 重新添加项目走 projects:add：登记表里又有甲项目', async () => {
            const list = await core(['projects', 'list', '--registry-only']);
            assert.ok(list.projects.some((p: { path: string }) => path.resolve(p.path).toLowerCase() === path.resolve(repoG).toLowerCase()));
        });
        await selectTask(G2.id);
        await check('T116 重新添加项目后任务页：没有项目已移除横幅，"再派一次"可用', `!document.querySelector('.banner-holder [data-readd-project]') && document.querySelector('[data-redispatch]').disabled === false`);
        await shots('accept-project-readded');
        // ---- 项目文件夹被删：只有“从列表删除”可用 ----
        await core(['projects', 'remove', repoM]);
        await rm(repoM, { recursive: true, force: true });
        await verify('T116 丙项目的文件夹已删除（在临时目录里），任务记录还在', () => { assert.ok(!existsSync(repoM)); assert.ok(taskOf(G3.id)); });
        await selectAccept(G3.id);
        await wait(`[...document.querySelectorAll('.detail.acc .tab-body .banner.brand .rt b')].some(b => b.textContent === ${jsonStr(c.projectGoneTitle)})`, 'T116 文件夹已删除的横幅', 20000);
        await check('T116 文件夹不在了：说明换成 c.projectGoneMissing，没有"重新添加项目"；驳回、重试、批准并合并都禁用并带悬停提示', `(() => { const b = document.querySelector('.detail.acc .tab-body .banner.brand'); const all = ['[data-acc-reject]', '[data-acc-retry]', '[data-acc-approve]'].map(s => document.querySelector(s)); return b.querySelector('.rt span').textContent === ${jsonStr(c.projectGoneMissing(tG3.repo))} && !document.querySelector('[data-readd-project]') && all.every(x => x.disabled === true && x.dataset.tip === ${tip}); })()`);
        await shots('accept-project-missing');
        await selectTask(G3.id);
        await wait(`[...document.querySelectorAll('.banner-holder .banner.brand .rt b')].some(b => b.textContent === ${jsonStr(c.projectGoneTitle)})`, 'T116 任务页文件夹已删除的横幅', 20000);
        await check('T116 任务页：文件夹不在时说明是 c.projectGoneMissing，没有"重新添加项目"，"再派一次"禁用', `document.querySelector('.banner-holder .banner.brand .rt span').textContent === ${jsonStr(c.projectGoneMissing(tG3.repo))} && !document.querySelector('[data-readd-project]') && document.querySelector('[data-redispatch]').disabled === true`);
        // 从任务列表删除（多选模式，真实点击）：文件夹已删除的任务，不勾“同时删除记录文件”。
        const deleteVia = async (id: string, withFiles: boolean) => {
            await goTasks();
            await press('[data-multi=select]');
            await press(`[data-task="${id}"]`);
            await wait(`document.querySelector('[data-multi=delete]')?.disabled === false`, 'T116 多选后“删除”可用');
            await press('[data-multi=delete]');
            await wait('!!document.querySelector(".sheet [data-delete-files]")', 'T116 删除确认框');
            if (withFiles) await press('[data-delete-files]');
            await press('.sheet [data-sheet-btn="1"]');
            await wait(`!document.querySelector('.sheet') && !document.querySelector('[data-task="${id}"]')`, 'T116 删除成功：任务不在列表里', 30000);
        };
        await deleteVia(G3.id, false);
        await verify('T116 文件夹被删的任务能从列表删除：任务已隐藏（runs.jsonl 不改）', async () => { assert.ok((await hiddenOf()).some(key => key.startsWith(G3.id + ':'))); });
        // 项目已移除、文件夹还在的已驳回任务：“同时删除记录文件”照常删掉 .agent-runs 里的记录目录。
        await verify('T116 删除前 G1 的记录目录还在', () => { assert.ok(existsSync(path.join(repoG, '.agent-runs', G1.name))); });
        await core(['projects', 'remove', repoG]);
        await deleteVia(G1.id, true);
        await verify('T116 项目已移除的已驳回任务：删除并勾选“同时删除记录文件”成功，记录目录已删除，任务已隐藏', async () => {
            assert.ok(!existsSync(path.join(repoG, '.agent-runs', G1.name)));
            assert.ok((await hiddenOf()).some(key => key.startsWith(G1.id + ':')));
        });
    }
    finally {
        // 清理：弹窗与菜单、假派发进程、临时项目、放行文件；恢复配置与演示任务的隐藏状态。
        if (await evaluate('!!document.querySelector(".sheet, .confirm-overlay")').catch(() => false)) await key('Escape').catch(() => { });
        await writeFile(resolveFlag, 'go\n').catch(() => { });
        await writeFile(holdFlag, 'go\n').catch(() => { });
        await endDemo().catch(() => { });
        // 真实任务也藏起来（它们是这次检查自己建的，后面的检查不该看到）。
        const hidden = await hiddenOf().catch(() => [] as string[]);
        const extra = touched.map(item => `${item.id}:${item.started}`);
        await writeHidden([...hidden.filter(key => !DEMO_IDS.some(id => key.startsWith(id + ':'))), ...originalHidden, ...extra]).catch(() => { });
        for (const dir of registered) await coreRun(['projects', 'remove', dir], { timeoutMs: 60000 }).catch(() => { });
        if (originalConfig === null) await rm(configFile, { force: true }).catch(() => { });
        else await writeFile(configFile, originalConfig).catch(() => { });
        win.setContentSize(1160, 720);
        nativeTheme.themeSource = 'dark';
    }
}
