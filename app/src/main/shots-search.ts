import { appendFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { nativeTheme, type BrowserWindow } from 'electron';
import { c, p, s6 } from '../shared/copy';
import { worktreeState, type Task } from '../shared/types';
import type { Registry } from './registry';
import { pollUntil, type Harness } from './shots-input';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
const DAY = 24 * 60 * 60 * 1000;
const base = (file: string) => file.split(/[\\/]/).filter(Boolean).at(-1) ?? file;
const projectOf = (t: Task) => base(t.repo);
// 与界面同一口径的大小写法（KB / MB / GB，一位小数）。
const sizeText = (bytes: number) => { const kb = bytes / 1024; return kb < 1024 ? `${kb.toFixed(1)} KB` : kb < 1024 * 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${(kb / 1024 / 1024).toFixed(1)} GB`; };
const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, env: appEnv });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return String(r.stdout).trim();
};

// UI02 任务页搜索与排序、UI15 项目页搜索与排序、UI07 设置页“并行”与“清理”、侧栏底部（Stage06 T8b）。
// 全部用真实输入；清理用测试自己的临时仓库、隔离的公共目录与 AR_WORKTREE_ROOT；不碰用户的目录与进程。
// 放在项目页验收之后、其余检查之前：演示数据是原样的（两个进行中任务、13 条任务），检查结束时把偏好、配置、窗口大小与主题都恢复。
export async function captureSearch(h: Harness, registry: Registry, win: BrowserWindow) {
    const { evaluate, wait, check, verify, press, key, type, tabTo, focusRing, pause, save } = h;
    const home = appEnv.AGENT_ROUTER_HOME!, worktreeRoot = appEnv.AR_WORKTREE_ROOT!;
    assert.ok(home && path.isAbsolute(home), '截图验收必须在隔离公共目录里运行');
    assert.ok(worktreeRoot && path.resolve(worktreeRoot).toLowerCase().startsWith(path.resolve(home).toLowerCase()), 'worktree 根目录必须在隔离公共目录里');
    const configFile = path.join(home, 'config.json'), projectsFile = path.join(home, 'projects.json'), prefsFile = path.join(registry.data, 'preferences.json');
    const jsonOf = async <T,>(file: string) => JSON.parse(await readFile(file, 'utf8')) as T;
    const jsonStr = JSON.stringify;
    const taskIds = async () => JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-task]')].map(r => r.dataset.task))`)) as string[];
    const rowsAre = (ids: string[]) => `JSON.stringify([...document.querySelectorAll('[data-task]')].map(r => r.dataset.task)) === ${jsonStr(jsonStr(ids))}`;
    const idsOf = (tasks: Task[]) => tasks.map(t => t.id);
    const shots = async (name: string) => {
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await pause(350); await save(`${name}-${theme}`); }
        nativeTheme.themeSource = 'dark';
        await pause(350);
    };
    const goTasks = async () => { await press('[data-page=tasks]'); await wait('!!document.querySelector("[data-task=t1]")', 'UI02 任务页出现'); await press('[data-filter=all]'); };
    // 菜单项按文字定位（项目下拉）：给当前菜单的按钮标上序号再点。
    const menuItem = async (label: string) => {
        const index = await evaluate(`(() => { const items = [...document.querySelectorAll('.ctx button')]; items.forEach((b, i) => b.setAttribute('data-menu-index', String(i))); return items.findIndex(b => b.textContent.trim() === ${jsonStr(label)}); })()`);
        assert.ok(index >= 0, `菜单里没有「${label}」`);
        return `.ctx button[data-menu-index="${index}"]`;
    };
    // 与界面无关的期望顺序：按时间 = 进行中、待验收与冲突、其余，组内开始时间倒序；按状态 = 待验收与冲突、进行中、失败或中断、其余。
    const byStart = (a: Task, b: Task) => b.started - a.started;
    const awaiting = (t: Task) => ['awaiting', 'conflict'].includes(worktreeState(t) ?? '');
    const timeOrder = (tasks: Task[]) => [...tasks].sort((a, b) => (Number(a.status !== 'run') + Number(a.status !== 'run' && !awaiting(a))) - (Number(b.status !== 'run') + Number(b.status !== 'run' && !awaiting(b))) || byStart(a, b));
    const stateRank = (t: Task) => awaiting(t) ? 0 : t.status === 'run' ? 1 : ['fail', 'stop'].includes(t.status) ? 2 : 3;
    const stateOrder = (tasks: Task[]) => [...tasks].sort((a, b) => stateRank(a) - stateRank(b) || byStart(a, b));
    const original = { size: win.getContentSize(), theme: nativeTheme.themeSource };
    // 任务页标题栏的版面检查（真实窗口的实际矩形）：窗口宽 ≥ 1280 一行；更窄分两行（第一行标题、筛选、选择、导入、新建任务，第二行搜索、项目下拉、排序）。
    // 所有控件互不重叠、都在窗口内、没有横向溢出；项目下拉与排序的文字不被截断（scrollWidth ≤ clientWidth）；筛选的数量都显示。diagnose 为 true 时返回各控件的矩形（检查失败时打印）。
    const layoutExpr = (narrow: boolean, diagnose = false) => `(() => {
        const h = document.querySelector('.tasks-h'), hr = h.getBoundingClientRect();
        const all = [...h.querySelectorAll('h1, [data-filter], .search, [data-project], [data-sort], [data-multi], [data-import], [data-page=newtask]')];
        const boxes = all.map(e => ({ e, name: (e.dataset.filter ?? e.dataset.multi ?? e.dataset.sort ?? e.dataset.project ?? e.dataset.import ?? e.dataset.page ?? e.className ?? e.tagName) + '', r: e.getBoundingClientRect() }));
        const inside = boxes.filter(b => !(b.r.width > 0 && b.r.height > 0 && b.r.left >= hr.left - 0.5 && b.r.right <= hr.right + 0.5 && b.r.top >= hr.top - 0.5 && b.r.bottom <= hr.bottom + 0.5 && b.r.right <= innerWidth + 0.5)).map(b => b.name);
        const overlap = [];
        boxes.forEach((a, i) => boxes.forEach((b, j) => { if (j > i && a.r.left < b.r.right - 0.5 && b.r.left < a.r.right - 0.5 && a.r.top < b.r.bottom - 0.5 && b.r.top < a.r.bottom - 0.5) overlap.push(a.name + '×' + b.name); }));
        const proj = h.querySelector('[data-project] .ph'), sortSpan = h.querySelector('[data-sort] span');
        const full = proj.scrollWidth <= proj.clientWidth && sortSpan.scrollWidth <= sortSpan.clientWidth && getComputedStyle(sortSpan).display !== 'none' && [...h.querySelectorAll('[data-filter] .n')].every(n => getComputedStyle(n).display !== 'none');
        const center = e => { const r = e.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
        const title = h.querySelector('h1'), search = h.querySelector('.search'), create = h.querySelector('[data-page=newtask]') ?? h.querySelector('[data-multi=done]');
        const rows = ${narrow} ? search.getBoundingClientRect().top >= create.getBoundingClientRect().bottom - 0.5 && center(h.querySelector('[data-project]')) > create.getBoundingClientRect().bottom && center(h.querySelector('[data-sort]')) > create.getBoundingClientRect().bottom
            : [search, h.querySelector('[data-project]'), h.querySelector('[data-sort]'), create].every(e => Math.abs(center(e) - center(title)) < 4);
        const ok = h.scrollWidth <= h.clientWidth && inside.length === 0 && overlap.length === 0 && full && rows;
        return ${diagnose ? 'JSON.stringify({ narrow: ' + String(narrow) + ', win: [innerWidth, innerHeight], header: [hr.left, hr.top, hr.right, hr.bottom].map(Math.round), scroll: [h.scrollWidth, h.clientWidth], outside: inside, overlap, full, rows, project: [proj.scrollWidth, proj.clientWidth], boxes: boxes.map(b => b.name + \':\' + [b.r.left, b.r.top, b.r.right, b.r.bottom].map(Math.round).join(\',\')) })' : 'ok'};
    })()`;

    // ---------------- UI02 任务页：搜索 ----------------
    await goTasks();
    const tasks = [...registry.tasks];
    assert.equal(tasks.length, 13, '演示数据应是 13 条任务');
    await check('UI02 搜索框在分段筛选后面、项目下拉前面，有占位文字和无障碍名称', `(() => { const h = document.querySelector('.tasks-h'), seg = h.querySelector('.segm'), search = h.querySelector('.search'), input = search?.querySelector('input'), project = h.querySelector('[data-project]'); return !!input && input.placeholder === ${jsonStr(s6.taskSearch)} && input.getAttribute('aria-label') === ${jsonStr(s6.taskSearch)} && (seg.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && (search.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; })()`);
    await check('UI02 没有搜索关键字时列表原样：按时间排序，没有“N 个任务包含”一行', `${rowsAre(idsOf(timeOrder(tasks)))} && !document.querySelector('[data-found]') && document.querySelector('[data-sort]').textContent.includes(${jsonStr(s6.taskSorts.time[0])})`);
    const q = 'NOTES', hits = tasks.filter(t => [t.name, t.title, projectOf(t)].some(x => x.toLowerCase().includes(q.toLowerCase())));
    assert.ok(hits.length > 0 && hits.length < tasks.length, '演示数据里应有一部分任务属于 notes-web');
    await type('.tasks-h .search input', q);
    await check('UI02 输入关键字（不区分大小写）后列表只剩匹配项', `JSON.stringify([...document.querySelectorAll('[data-task]')].map(r => r.dataset.task).sort()) === ${jsonStr(jsonStr(idsOf(hits).sort()))}`);
    await check('UI02 列表顶部的数量文字精确等于“N 个任务包含…”', `document.querySelector('[data-found] span')?.textContent === ${jsonStr(s6.taskFound(hits.length, q))}`);
    await check('UI02 命中处用 <mark> 包住，包住的正是关键字（忽略大小写），浅底是 --brand-soft', `(() => { const marks = [...document.querySelectorAll('[data-task] mark.hit')]; const p = document.createElement('i'); p.style.background = 'var(--brand-soft)'; document.body.append(p); const want = getComputedStyle(p).backgroundColor; p.remove(); return marks.length >= ${hits.length} && marks.every(m => m.textContent.toLowerCase() === ${jsonStr(q.toLowerCase())} && getComputedStyle(m).backgroundColor === want); })()`);
    await check('UI02 搜索框里有内容时出现清除按钮', `!document.querySelector('.search [data-search-clear]').hidden`);
    await save('ui02-search-dark');
    // 与分段筛选同时生效：只看失败，剩下匹配又失败或中断的。
    await press('[data-filter=issues]');
    const bad = hits.filter(t => ['fail', 'stop'].includes(t.status));
    await check('UI02 搜索与分段筛选同时生效', bad.length ? `JSON.stringify([...document.querySelectorAll('[data-task]')].map(r => r.dataset.task).sort()) === ${jsonStr(jsonStr(idsOf(bad).sort()))} && document.querySelector('[data-found] span').textContent === ${jsonStr(s6.taskFound(bad.length, q))}` : `!document.querySelector('[data-task]') && document.querySelector('[data-found] span').textContent === ${jsonStr(s6.taskNone(q))}`);
    await press('[data-filter=all]');
    // 与项目下拉同时生效：notes-web 之外的项目里没有任务包含 NOTES。
    await press('[data-project]');
    await press(await menuItem('pixel-garden'));
    const inGarden = hits.filter(t => projectOf(t) === 'pixel-garden');
    await check('UI02 搜索与项目下拉同时生效：没有结果时显示“没有任务包含…”', inGarden.length ? `document.querySelectorAll('[data-task]').length === ${inGarden.length}` : `!document.querySelector('[data-task]') && document.querySelector('[data-found] span').textContent === ${jsonStr(s6.taskNone(q))}`);
    await press('[data-project]');
    await press('.ctx button');
    await check('UI02 项目下拉选回全部项目后搜索结果恢复', `document.querySelectorAll('[data-task]').length === ${hits.length}`);
    // 清除：恢复原列表，焦点回到搜索框。
    await press('[data-found-clear]');
    await check('UI02 点“清除”后恢复原列表，搜索框清空且获得焦点，数量一行消失', `${rowsAre(idsOf(timeOrder(tasks)))} && document.querySelector('.tasks-h .search input').value === '' && document.activeElement === document.querySelector('.tasks-h .search input') && !document.querySelector('[data-found]') && document.querySelector('.search [data-search-clear]').hidden`);
    // Esc 清空搜索框。
    await type('.tasks-h .search input', '导出');
    const exported = tasks.filter(t => [t.name, t.title, projectOf(t)].some(x => x.includes('导出')));
    await check('UI02 搜索任务名里的中文关键字', `JSON.stringify([...document.querySelectorAll('[data-task]')].map(r => r.dataset.task).sort()) === ${jsonStr(jsonStr(idsOf(exported).sort()))}`);
    await key('Escape');
    await check('UI02 在搜索框里按 Esc 清空搜索框并恢复原列表', `${rowsAre(idsOf(timeOrder(tasks)))} && document.querySelector('.tasks-h .search input').value === '' && !document.querySelector('[data-found]')`);

    // ---------------- UI02 任务页：排序菜单（键盘） ----------------
    await tabTo('[data-sort]');
    await focusRing('UI02 排序按钮');
    await check('UI02 排序按钮：弹出菜单、默认“按时间”，title 与无障碍名称是“排序：按时间”', `(() => { const b = document.querySelector('[data-sort]'); return b.getAttribute('aria-haspopup') === 'menu' && b.getAttribute('aria-expanded') === 'false' && b.title === ${jsonStr(s6.sortTip(s6.taskSorts.time[0]))} && b.getAttribute('aria-label') === b.title; })()`);
    await key('Enter');
    await check('UI02 回车打开排序菜单：role=menu，三项都是 menuitemradio，默认选中“按时间”，焦点在选中项', `(() => { const m = document.querySelector('.sort-pop'), items = [...m.querySelectorAll('[role=menuitemradio]')]; return m.getAttribute('role') === 'menu' && items.length === 3 && items.map(i => i.dataset.sortKey).join() === 'time,state,project' && items.map(i => i.getAttribute('aria-checked')).join() === 'true,false,false' && items[0].textContent.includes(${jsonStr(s6.taskSorts.time[0])}) && items[0].textContent.includes(${jsonStr(s6.taskSorts.time[1])}) && items[1].textContent.includes(${jsonStr(s6.taskSorts.state[0])}) && items[2].textContent.includes(${jsonStr(s6.taskSorts.project[0])}) && document.activeElement === items[0] && document.querySelector('[data-sort]').getAttribute('aria-expanded') === 'true'; })()`);
    await save('ui02-sort-menu-dark');
    await key('Escape');
    await check('UI02 Esc 关闭排序菜单，焦点回到排序按钮，排序不变', `!document.querySelector('.sort-pop') && document.activeElement === document.querySelector('[data-sort]') && document.querySelector('[data-sort]').getAttribute('aria-expanded') === 'false' && ${rowsAre(idsOf(timeOrder(tasks)))}`);
    await key('Enter');
    await key('Down');
    await check('UI02 方向键向下选到“按状态”', `document.activeElement?.dataset.sortKey === 'state'`);
    await key('Enter');
    const byState = idsOf(stateOrder(tasks));
    await check('UI02 回车选中“按状态”：菜单收起，焦点回到排序按钮，按钮显示“按状态”', `!document.querySelector('.sort-pop') && document.activeElement === document.querySelector('[data-sort]') && document.querySelector('[data-sort]').textContent.includes(${jsonStr(s6.taskSorts.state[0])}) && document.querySelector('[data-sort]').title === ${jsonStr(s6.sortTip(s6.taskSorts.state[0]))}`);
    await check('UI02 按状态排序：待验收与冲突 → 进行中 → 失败或中断 → 其余，逐个核对演示任务的顺序', rowsAre(byState));
    await verify('UI02 按状态排序的顺序里：进行中在最前、失败或中断紧随其后（演示数据里没有待验收）', () => {
        const run = tasks.filter(t => t.status === 'run').length, issues = tasks.filter(t => ['fail', 'stop'].includes(t.status)).length;
        assert.deepEqual(byState.slice(0, run).sort(), idsOf(tasks.filter(t => t.status === 'run')).sort());
        assert.deepEqual(byState.slice(run, run + issues).sort(), idsOf(tasks.filter(t => ['fail', 'stop'].includes(t.status))).sort());
    });
    await verify('UI02 选择记进软件偏好（preferences.json 的 taskSort）', async () => {
        assert.ok((await pollUntil(async () => (await jsonOf<{ taskSort?: string }>(prefsFile).catch(() => ({} as { taskSort?: string }))).taskSort === 'state', 5000, 100)).ok, 'preferences.json 里应有 taskSort: state');
    });
    // 按项目：同一项目放在一起，项目按名称排。
    await press('[data-sort]');
    await press('[data-sort-key=project]');
    const names = [...new Set(tasks.map(projectOf))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const byProject = names.flatMap(name => tasks.filter(t => projectOf(t) === name).sort(byStart));
    await check('UI02 按项目排序：同一项目放在一起，项目按名称排，每个项目一个分组标题', `${rowsAre(idsOf(byProject))} && JSON.stringify([...document.querySelectorAll('.tgroup')].map(g => g.firstChild.textContent.trim())) === ${jsonStr(jsonStr(names))}`);
    await press('[data-sort]');
    await press('[data-sort-key=state]');
    await check('UI02 切回按状态', rowsAre(byState));

    // ---------------- UI02 最窄窗口 ----------------
    win.setContentSize(960, 600);
    await pause(400);
    const counts = { all: tasks.length, run: tasks.filter(t => t.status === 'run').length, await: tasks.filter(awaiting).length, issues: tasks.filter(t => ['fail', 'stop'].includes(t.status)).length };
    // 窄窗口（宽 < 1280）标题栏分两行：什么都不截断、不收起——排序文字、筛选数量、项目名都完整显示（原来的“最窄窗口按顺序收缩”改写成下面几条）。
    await check('UI02 最窄窗口：排序按钮的文字完整显示（不再只剩图标），title 是“排序：按状态”', `(() => { const b = document.querySelector('.tasks-h [data-sort]'), span = b.querySelector('span'); return getComputedStyle(span).display !== 'none' && span.textContent === ${jsonStr(s6.taskSorts.state[0])} && span.scrollWidth <= span.clientWidth && b.title === ${jsonStr(s6.sortTip(s6.taskSorts.state[0]))}; })()`);
    await check('UI02 最窄窗口：标题栏分两行、没有横向溢出，所有控件互不重叠且都在窗口内', layoutExpr(true), async () => evaluate(layoutExpr(true, true)));
    await check('UI02 最窄窗口：筛选照常显示数量，title 里也有数量（“失败”写全称）', `(() => { const bs = [...document.querySelectorAll('.tasks-h [data-filter]')]; const want = ${jsonStr({ all: s6.filterTip(c.all, counts.all), run: s6.filterTip(c.status.run, counts.run), await: s6.filterTip('待验收', counts.await), issues: s6.filterTip(s6.failTip, counts.issues) })}; return bs.length === 4 && bs.every(b => getComputedStyle(b.querySelector('.n')).display !== 'none' && b.querySelector('.n').textContent === String(({ all: ${counts.all}, run: ${counts.run}, await: ${counts.await}, issues: ${counts.issues} })[b.dataset.filter]) && b.title === want[b.dataset.filter]); })()`);
    await check('UI02 最窄窗口：搜索框在第二行，最宽 360px，仍可见可用', `(() => { const r = document.querySelector('.tasks-h .search').getBoundingClientRect(), n = document.querySelector('.tasks-h [data-page=newtask]').getBoundingClientRect(); return r.top >= n.bottom - 0.5 && r.width > 200 && r.width <= 360.5; })()`);
    // 两行时排序菜单从排序按钮左边对齐展开。
    await press('[data-sort]');
    // 菜单与窗口右边至少留 8px（贴边时整体左移），所以期望的左边是 min(按钮左边, 窗口宽 − 菜单宽 − 8)；
    // 打开动画里菜单有 scale(0.98)，实际矩形比 CSS 版面小一圈，所以容差给 4px（右边对齐的话差在 100px 以上）。
    await check('UI02 最窄窗口：排序菜单从排序按钮左边对齐展开（贴近窗口右边时只向左让出 8px 边距）', `(() => { const m = document.querySelector('.sort-pop').getBoundingClientRect(), b = document.querySelector('[data-sort]').getBoundingClientRect(); return Math.abs(m.left - Math.min(b.left, innerWidth - m.width - 8)) <= 4 && m.left > b.right - m.width + 20 && m.right <= innerWidth; })()`, async () => evaluate(`JSON.stringify({ menu: document.querySelector('.sort-pop').getBoundingClientRect().toJSON(), button: document.querySelector('[data-sort]').getBoundingClientRect().toJSON(), innerWidth })`));
    await key('Escape');
    await shots('ui02-search-narrow');
    // 同样窄的窗口里有搜索结果时标题栏也不溢出。
    await type('.tasks-h .search input', q);
    await check('UI02 最窄窗口里搜索：标题栏不溢出，结果数量文字不变', `document.querySelector('.tasks-h').scrollWidth <= document.querySelector('.tasks-h').clientWidth && document.querySelector('[data-found] span')?.textContent === ${jsonStr(s6.taskFound(hits.length, q))}`);
    await save('ui02-search-narrow-result-dark');
    nativeTheme.themeSource = 'light'; await pause(350); await save('ui02-search-narrow-result-light'); nativeTheme.themeSource = 'dark'; await pause(350);
    // 窄窗口下的搜索框（真实输入）：框里有内容时，标题栏仍是两行、不溢出，控件互不重叠。
    await check('UI02 最窄窗口里搜索：标题栏仍是两行，控件互不重叠且都在窗口内', layoutExpr(true), async () => evaluate(layoutExpr(true, true)));
    await key('Escape');
    // 选择模式下第二行照常显示：搜索、项目下拉、排序都在，也都能用（不再收起搜索与排序）。
    await press('[data-multi=select]');
    await check('UI02 最窄窗口的选择模式：标题栏不溢出，第二行的搜索框、项目下拉、排序按钮都还在，控件互不重叠', `${layoutExpr(true)} && getComputedStyle(document.querySelector('.tasks-h .search')).display !== 'none' && getComputedStyle(document.querySelector('.tasks-h [data-sort]')).display !== 'none' && !!document.querySelector('.tasks-h [data-project]')`);
    await type('.tasks-h .search input', q);
    await check('UI02 选择模式下搜索照常工作：列表只剩匹配项', `JSON.stringify([...document.querySelectorAll('[data-task]')].map(r => r.dataset.task).sort()) === ${jsonStr(jsonStr(idsOf(hits).sort()))}`);
    await key('Escape');
    await check('UI02 选择模式下按 Esc 先清空搜索框（仍在选择模式）', `document.querySelector('.tasks-h .search input').value === '' && !!document.querySelector('[data-multi=done]')`);
    await press('[data-multi=done]');
    // 宽度 ≥ 1280 一行；1160 仍是两行。检查与截图都带着搜索关键字（搜索场景）：深色 × 三种尺寸（960 的在上面）。
    for (const [width, height, narrow, shot] of [[1160, 720, true, 'ui02-search-default-dark'], [1440, 900, false, 'ui02-search-wide-dark']] as const) {
        win.setContentSize(width, height);
        await pause(500);
        await type('.tasks-h .search input', q);
        await check(`UI02 ${width}×${height}：标题栏${narrow ? '分两行，搜索框在第二行' : '一行，搜索框、项目下拉、排序与标题在同一行'}，筛选数量、项目名、排序文字完整显示，控件互不重叠且都在窗口内`, layoutExpr(narrow), async () => evaluate(layoutExpr(narrow, true)));
        if (!narrow) {
            await press('[data-sort]');
            await check('UI02 1440×900：排序菜单仍从排序按钮右边对齐向左展开', `(() => { const m = document.querySelector('.sort-pop').getBoundingClientRect(), b = document.querySelector('[data-sort]').getBoundingClientRect(); return Math.abs(m.right - b.right) <= 4; })()`);
            await key('Escape');
        }
        await save(shot);
        await press('.tasks-h .search [data-search-clear]');
        await check(`UI02 ${width}×${height}：点搜索框里的清除按钮后搜索框清空`, `document.querySelector('.tasks-h .search input').value === ''`);
    }
    win.setContentSize(original.size[0], original.size[1]);
    await pause(400);

    // ---------------- UI15 项目页：搜索与排序 ----------------
    await press('[data-page=projects]');
    await wait('!!document.querySelector("[data-pj-row]") && !!document.querySelector("[data-pj-detail] .dh")', 'UI15 项目页出现');
    const projects = (await jsonOf<{ projects: { path: string; name: string; addedAt: number }[] }>(projectsFile)).projects;
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const lastStart = (p: { path: string }) => Math.max(0, ...tasks.filter(t => norm(t.repo) === norm(p.path)).map(t => t.started));
    const recent = [...projects].sort((a, b) => lastStart(b) - lastStart(a) || b.addedAt - a.addedAt).map(p => p.path);
    const rowPaths = async () => JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-pj-row]')].map(r => r.dataset.pjRow))`)) as string[];
    await check('UI15 项目页标题栏：搜索框、排序按钮（默认“最近使用”）、添加项目', `(() => { const h = document.querySelector('.page-h'); return !!h.querySelector('.search input') && h.querySelector('.search input').placeholder === ${jsonStr(s6.projectSearch)} && h.querySelector('[data-pj=sort]').textContent.includes(${jsonStr(s6.projectSorts.recent[0])}) && !!h.querySelector('[data-pj=add]'); })()`);
    assert.deepEqual(await rowPaths(), recent, '默认顺序应是“最近使用”：有任务的项目按最近一次派发的时间在前，没派过任务的按添加时间在后');
    await check('UI15 默认按“最近使用”排：最近派过任务的在上，没派过的按添加时间排在后面', `JSON.stringify([...document.querySelectorAll('[data-pj-row]')].map(r => r.dataset.pjRow)) === ${jsonStr(jsonStr(recent))}`);
    const sample = projects.find(p => norm(p.path).includes('/shots-projects/')) ?? projects.at(-1)!;
    const fragment = `${path.basename(path.dirname(sample.path))}${path.sep}${path.basename(sample.path)}`;
    const wanted = projects.filter(p => p.path.toLowerCase().includes(fragment.toLowerCase())).map(p => p.path);
    assert.ok(wanted.length >= 1 && wanted.length < projects.length, '路径片段应只匹配一部分项目');
    await type('.page-h .search input', fragment);
    await check('UI15 搜索路径片段：列表只剩匹配的项目，数量文字精确', `JSON.stringify([...document.querySelectorAll('[data-pj-row]')].map(r => r.dataset.pjRow).sort()) === ${jsonStr(jsonStr([...wanted].sort()))} && document.querySelector('[data-found] span')?.textContent === ${jsonStr(s6.projectFound(wanted.length, fragment))}`);
    await check('UI15 路径里的命中处用 <mark> 包住', `(() => { const marks = [...document.querySelectorAll('[data-pj-row] .mono mark.hit')]; return marks.length >= ${wanted.length} && marks.every(m => m.textContent.toLowerCase() === ${jsonStr(fragment.toLowerCase())}); })()`);
    await save('ui15-search-dark');
    await press('[data-pj=search-clear]');
    await check('UI15 点“清除”后恢复全部项目', `document.querySelectorAll('[data-pj-row]').length === ${projects.length} && !document.querySelector('[data-found]') && document.querySelector('.page-h .search input').value === ''`);
    await type('.page-h .search input', 'zzz-没有这个项目');
    await check('UI15 没有结果时显示“没有项目包含…”', `!document.querySelector('[data-pj-row]') && document.querySelector('[data-found] span')?.textContent === ${jsonStr(s6.projectNone('zzz-没有这个项目'))}`);
    await key('Escape');
    await check('UI15 Esc 清空搜索框并恢复列表', `document.querySelectorAll('[data-pj-row]').length === ${projects.length} && document.querySelector('.page-h .search input').value === ''`);
    await press('[data-pj=sort]');
    await check('UI15 排序菜单：role=menu，三项 menuitemradio（最近使用 / 名称 / 添加时间），默认选中“最近使用”', `(() => { const items = [...document.querySelectorAll('.sort-pop [role=menuitemradio]')]; return document.querySelector('.sort-pop').getAttribute('role') === 'menu' && items.map(i => i.dataset.sortKey).join() === 'recent,name,added' && items.map(i => i.getAttribute('aria-checked')).join() === 'true,false,false'; })()`);
    await press('[data-sort-key=name]');
    const byName = [...projects].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map(p => p.path);
    await check('UI15 切到“名称”排序：顺序按名称', `JSON.stringify([...document.querySelectorAll('[data-pj-row]')].map(r => r.dataset.pjRow)) === ${jsonStr(jsonStr(byName))} && document.querySelector('[data-pj=sort]').textContent.includes(${jsonStr(s6.projectSorts.name[0])})`);
    await press('[data-pj=sort]');
    await press('[data-sort-key=added]');
    const byAdded = [...projects].sort((a, b) => b.addedAt - a.addedAt).map(p => p.path);
    await check('UI15 切到“添加时间”排序：新添加的在上', `JSON.stringify([...document.querySelectorAll('[data-pj-row]')].map(r => r.dataset.pjRow)) === ${jsonStr(jsonStr(byAdded))}`);
    await press('[data-pj=sort]');
    await press('[data-sort-key=recent]');
    await check('UI15 切回“最近使用”', `JSON.stringify([...document.querySelectorAll('[data-pj-row]')].map(r => r.dataset.pjRow)) === ${jsonStr(jsonStr(recent))}`);

    // ---------------- 侧栏底部 ----------------
    await goTasks();
    const config = () => jsonOf<{ concurrency?: number; managed?: boolean; profiles?: Record<string, { adapter?: string; label?: string; enabled?: boolean }> }>(configFile);
    // 期望的侧栏行：配置里每个启用的执行者，显示名 + 正在运行（运行、门禁、准备，不含排队）的任务数/上限。
    const sidebarRows = async (limit: number) => {
        const rows: { text: string; tip: string }[] = [];
        for (const [name, profile] of Object.entries((await config()).profiles ?? {})) {
            if (profile.enabled === false) continue;
            const label = profile.label || ({ codex: 'Codex', 'claude-code': 'Claude Code' } as Record<string, string>)[profile.adapter ?? ''] || profile.adapter || name;
            const n = registry.tasks.filter(t => t.status === 'run' && worktreeState(t) !== 'queued' && (t.attempt?.profile ?? t.profile) === name).length;
            rows.push({ text: `${label}${s6.loadRow(n, limit)}`, tip: s6.loadTip(label, n, limit) });
        }
        return rows;
    };
    const limit0 = (await config()).concurrency ?? 2;
    const rows0 = await sidebarRows(limit0);
    assert.ok(rows0.some(r => r.text === `Codex${s6.loadRow(2, limit0)}`), `侧栏应有 Codex 一行，两个进行中的演示任务：${rows0.map(r => r.text).join('、')}`);
    await check('UI15 侧栏底部：每个启用的执行者一行，文字精确等于“显示名 + 运行数/上限”', `JSON.stringify([...document.querySelectorAll('.nav-foot .load-l')].map(r => r.textContent)) === ${jsonStr(jsonStr(rows0.map(r => r.text)))}`);
    await check('UI15 侧栏底部：悬停提示是“某某 正在运行 n 个任务；同时最多运行 m 个”，上方有分隔线', `JSON.stringify([...document.querySelectorAll('.nav-foot .load-l')].map(r => r.title)) === ${jsonStr(jsonStr(rows0.map(r => r.tip)))} && parseFloat(getComputedStyle(document.querySelector('.nav-foot')).borderTopWidth) > 0 && getComputedStyle(document.querySelector('.nav-foot')).borderTopStyle === 'solid'`);
    await check('UI15 侧栏底部最后一行是托管状态，前面有圆点；原来的单行“某某 n”不再出现', `(() => { const f = document.querySelector('.nav-foot'), last = f.lastElementChild; return last.matches('[data-managed-settings]') && !!last.querySelector('.dot') && last.textContent.trim() === ${jsonStr((await config()).managed ? c.managedOn : c.managedOff)} && ![...f.querySelectorAll('[title]')].some(e => e.title === ${jsonStr(c.loadHelp)}); })()`);
    await save('sidebar-load-dark');

    // 托管开关：打开后最后一行变“托管已开启”（圆点变绿），关掉后变“托管未开启”。
    await press('[data-managed-settings]');
    await wait('!!document.querySelector("[data-pref=managed]")', 'UI07 设置页出现托管开关');
    const wasManaged = (await config()).managed === true;
    if (!wasManaged) { await press('[data-pref=managed]'); await wait(`document.querySelector('.nav-foot .mg').textContent.trim() === ${jsonStr(c.managedOn)}`, 'UI07 开启托管后侧栏变“托管已开启”'); }
    await check('UI07 托管开启时侧栏最后一行是“托管已开启”，圆点是绿色', `(() => { const mg = document.querySelector('.nav-foot').lastElementChild; return mg.textContent.trim() === ${jsonStr(c.managedOn)} && mg.querySelector('.dot').classList.contains('ok'); })()`);
    await press('[data-pref=managed]');
    await wait(`document.querySelector('.nav-foot .mg').textContent.trim() === ${jsonStr(c.managedOff)}`, 'UI07 关掉托管后侧栏变“托管未开启”');
    await check('UI07 关掉托管后侧栏最后一行是“托管未开启”，圆点不是绿色', `(() => { const mg = document.querySelector('.nav-foot').lastElementChild; return mg.textContent.trim() === ${jsonStr(c.managedOff)} && !mg.querySelector('.dot').classList.contains('ok'); })()`);
    if (wasManaged) { await press('[data-pref=managed]'); await wait(`document.querySelector('.nav-foot .mg').textContent.trim() === ${jsonStr(c.managedOn)}`, '恢复托管开启'); }

    // ---------------- UI07 设置页：并行 ----------------
    await check('UI07 设置页“托管”后面是“并行”一节：标题、说明、“同时运行的任务”与 1～4 分段控件', `(() => { const secs = [...document.querySelectorAll('.doc-in .sect')], i = secs.findIndex(s => s.querySelector('h2')?.textContent === ${jsonStr(s6.parallelSec)}); const sec = secs[i]; return i > 0 && secs[i - 1].parentElement.id === 'managed-section' && sec.querySelector('p')?.textContent === ${jsonStr(s6.parallelLead)} && sec.querySelector('.l')?.firstChild.textContent === ${jsonStr(s6.concurrency)} && [...sec.querySelectorAll('[data-segment=concurrency]')].map(b => b.dataset.value).join() === '1,2,3,4'; })()`);
    await check(`UI07 并行：当前值 ${limit0} 被选中，其余不选`, `[...document.querySelectorAll('[data-segment=concurrency]')].filter(b => b.classList.contains('on')).map(b => b.dataset.value).join() === ${jsonStr(String(limit0))}`);
    await press('[data-segment=concurrency][data-value="3"]');
    await verify('UI07 点“3”后 config.json 的 concurrency 为 3，其余字段保留', async () => {
        assert.ok((await pollUntil(async () => (await config()).concurrency === 3, 8000, 100)).ok, 'concurrency 应为 3');
        const after = await config();
        assert.ok(after.profiles && Object.keys(after.profiles).length >= 1, '执行者配置不能丢');
    });
    await wait(`[...document.querySelectorAll('.nav-foot .load-l .mono:last-child')].length > 0 && [...document.querySelectorAll('.nav-foot .load-l .mono:last-child')].every(e => e.textContent.endsWith('/3'))`, 'UI07 侧栏底部上限立刻变成 /3', 8000);
    await check('UI07 改成 3 后：分段控件选中“3”，侧栏每行都是“n/3”', `document.querySelector('[data-segment=concurrency].on')?.dataset.value === '3' && JSON.stringify([...document.querySelectorAll('.nav-foot .load-l')].map(r => r.textContent)) === ${jsonStr(jsonStr((await sidebarRows(3)).map(r => r.text)))}`);
    await save('ui07-parallel-dark');
    // 手写的越界值：分段控件不选任何一项，显示当前值；侧栏上限跟着配置。
    await press('[data-page=tasks]');
    const handwritten = await config();
    await writeFile(configFile, JSON.stringify({ ...handwritten, concurrency: 7 }, null, 2) + '\n');
    await press('[data-page=settings]');
    await wait('!!document.querySelector("[data-concurrency-value]")', 'UI07 越界值显示在控件前面');
    await check('UI07 配置里手写的 concurrency: 7（超出 1～4）：分段控件不选任何一项，并显示当前值 7', `document.querySelectorAll('[data-segment=concurrency].on').length === 0 && document.querySelector('[data-concurrency-value]').textContent === '7' && [...document.querySelectorAll('[data-segment=concurrency]')].every(b => b.getAttribute('aria-pressed') === 'false')`);
    await wait(`[...document.querySelectorAll('.nav-foot .load-l .mono:last-child')].every(e => e.textContent.endsWith('/7'))`, 'UI07 侧栏上限跟着手写的值变成 /7', 15000);
    await press(`[data-segment=concurrency][data-value="${limit0}"]`);
    await verify(`UI07 恢复原值 ${limit0}`, async () => { assert.ok((await pollUntil(async () => (await config()).concurrency === limit0, 8000, 100)).ok); });
    await wait(`[...document.querySelectorAll('.nav-foot .load-l .mono:last-child')].every(e => e.textContent.endsWith('/${limit0}'))`, 'UI07 侧栏上限恢复', 8000);
    await check('UI07 恢复后越界值的提示消失，原值被选中', `!document.querySelector('[data-concurrency-value]') && document.querySelector('[data-segment=concurrency].on')?.dataset.value === ${jsonStr(String(limit0))}`);

    // ---------------- UI07 设置页：清理（ar gc） ----------------
    const fixtureRoot = path.join(home, 'shots-search'), repo = path.join(fixtureRoot, 'gc-repo');
    const acceptedDir = path.join(worktreeRoot, 'a1b2c3-gc-accepted'), awaitingDir = path.join(worktreeRoot, 'd4e5f6-gc-awaiting');
    const sessionDir = path.join(home, 'workers', 'deepseek', 'claude', 'projects', 'gc-old-session');
    const manifest = path.join(home, 'runs.jsonl');
    const rowsText = (id: string, dir: string, branch: string, events: Record<string, unknown>[]) => [
        { v: 2, event: 'start', id, repo, name: id, spec: null, title: id, role: null, pid: process.pid, started: Date.now() - 600000, profile: 'codex', adapter: 'fake', worktree: true, base: 'b'.repeat(40), at: Date.now() },
        { v: 1, event: 'worktree', id, dir, branch, base: 'b'.repeat(40), at: Date.now() },
        ...events.map(e => ({ v: 1, id, at: Date.now(), ...e })),
    ].map(row => JSON.stringify(row) + '\n').join('');
    const gcCore = async (args: string[]) => { const r = await coreRun(args, { timeoutMs: 120000, cwd: fixtureRoot }); assert.equal(r.json?.ok, true, `ar ${args.join(' ')}：${r.stderr || r.json?.error}`); return r.json; };
    await mkdir(fixtureRoot, { recursive: true });
    const baseline = await gcCore(['gc', '--dry-run']);
    assert.equal(baseline.worktrees.length + baseline.slots.length + baseline.sessions.length, 0, `清理的基线应为空：${JSON.stringify(baseline)}`);
    let manifestBefore = '';
    try {
        await mkdir(repo, { recursive: true });
        git(repo, ['init', '-q', '-b', 'main']);
        await writeFile(path.join(repo, 'README.md'), '# 清理检查用的临时仓库\n');
        git(repo, ['add', '--', 'README.md']);
        git(repo, ['-c', 'user.name=AgentRouter Shots', '-c', 'user.email=shots@example.invalid', 'commit', '-q', '-m', '初始提交', '--', 'README.md']);
        await mkdir(worktreeRoot, { recursive: true });
        git(repo, ['worktree', 'add', '-q', '-b', 'ar/gc-accepted', acceptedDir, 'main']);
        git(repo, ['worktree', 'add', '-q', '-b', 'ar/gc-awaiting', awaitingDir, 'main']);
        await writeFile(path.join(acceptedDir, 'big.txt'), 'x'.repeat(50000));
        await mkdir(sessionDir, { recursive: true });
        await writeFile(path.join(sessionDir, 'session.jsonl'), 'y'.repeat(30000));
        const old = new Date(Date.now() - 30 * DAY);
        await utimes(sessionDir, old, old);
        // 任务清单里：一个已合并但没清掉 worktree 的任务，和一个门禁通过、正在待验收的任务（它的 worktree 不能动）。没有 progress / report 字段，软件的任务列表不会显示它们。
        manifestBefore = await readFile(manifest, 'utf8');
        await appendFile(manifest, rowsText('shots-gc-accepted', acceptedDir, 'ar/gc-accepted', [{ event: 'end', exit: 0, attempts: 1 }, { event: 'accepted', merge: 'c'.repeat(40), mode: 'no-ff', by: 'human' }]));
        await appendFile(manifest, rowsText('shots-gc-awaiting', awaitingDir, 'ar/gc-awaiting', [{ event: 'end', exit: 0, attempts: 1 }]));
        const dry = await gcCore(['gc', '--dry-run']);
        assert.deepEqual(dry.worktrees.map((w: { dir: string }) => path.resolve(w.dir).toLowerCase()), [path.resolve(acceptedDir).toLowerCase()], '核心只会列出已合并的那个 worktree');
        assert.equal(dry.sessions.length, 1);
        assert.equal(dry.slots.length, 0);

        // 关掉窗口再打开（重新加载界面）：排序沿用，软件启动时在后台检查一次清理。
        const loaded = new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()));
        win.webContents.reload();
        await loaded;
        win.webContents.focus();
        const settled = async (expression: string, label: string) => {
            const ok = (await pollUntil(async () => { try { return await evaluate(expression); } catch { return false; } }, 30000, 150)).ok;
            assert.ok(ok, `界面等待超时：${label}`);
        };
        await settled('!!document.querySelector("[data-task=t1]") && !!document.querySelector("[data-sort]")', '重新加载后任务页出现');
        await check('UI02 重开窗口后排序沿用：按钮显示“按状态”，顺序仍按状态', `document.querySelector('[data-sort]').textContent.includes(${jsonStr(s6.taskSorts.state[0])}) && ${rowsAre(byState)}`);
        await press('[data-sort]');
        await press('[data-sort-key=time]');
        await check('UI02 改回“按时间”，顺序恢复', rowsAre(idsOf(timeOrder(tasks))));
        await verify('UI02 偏好里的排序恢复为 time', async () => { assert.ok((await pollUntil(async () => (await jsonOf<{ taskSort?: string }>(prefsFile)).taskSort === 'time', 5000, 100)).ok); });

        const dryText = (n: number) => s6.gcFound(n, sizeText(dry.bytes));
        await press('[data-page=settings]');
        await wait('!!document.querySelector("[data-gc-row]")', 'UI07 设置页“清理”一行出现');
        await wait(`!!document.querySelector('[data-gc-found]')`, 'UI07 启动时的检查发现可清理项', 30000);
        await check('UI07 清理一行在“数据”一节最上面，标题和说明用 s6 文案', `(() => { const sec = [...document.querySelectorAll('.doc-in .sect')].find(s => s.querySelector('h2')?.textContent === ${jsonStr(p.data)}); const first = sec.querySelector('.set-r'); return first === document.querySelector('[data-gc-row]') && first.querySelector('.l').firstChild.textContent === ${jsonStr(s6.gc)} && first.textContent.includes(${jsonStr(s6.gcHelp(14))}); })()`);
        await check('UI07 启动后这一行显示“发现 2 项可以清理，约 …”（品牌色），按钮是“清理…”', `(() => { const f = document.querySelector('[data-gc-found]'), btn = document.querySelector('[data-gc-row] [data-pref=gc]'); const probe = document.createElement('i'); probe.style.color = 'var(--brand)'; document.body.append(probe); const want = getComputedStyle(probe).color; probe.remove(); return f.textContent === ${jsonStr(dryText(2))} && getComputedStyle(f).color === want && btn?.textContent === ${jsonStr(s6.gcButton)}; })()`);
        await evaluate('document.querySelector("[data-gc-row]").scrollIntoView({ block: "center" })');
        await save('ui07-gc-found-dark');
        await press('[data-pref=gc]');
        await wait('!!document.querySelector(".sheet [data-gc-item]")', 'UI07 清理确认框出现');
        const ageDays = dry.sessions[0].ageDays as number, now = Number(process.env.AR_DEMO_NOW) || Date.now();
        const expectedItems = [
            [s6.gcReason.accepted, base(acceptedDir)],
            [s6.gcSessionReason(14), s6.gcSession('deepseek', new Date(now - ageDays * DAY).toLocaleDateString('en-CA'))],
        ];
        await check('UI07 清理确认框：标题“清理 2 项？”，说明里有总大小，列出两项（原因、名字；worktree 写目录名不写完整路径），默认焦点在取消，“清理”是危险按钮', `(() => { const s = document.querySelector('.sheet'), items = [...s.querySelectorAll('[data-gc-item]')]; return s.querySelector('.sheet-h b').textContent === ${jsonStr(s6.gcTitle(2))} && s.querySelector('.sheet-lead').textContent === ${jsonStr(s6.gcLead(sizeText(dry.bytes)))} && items.length === 2 && JSON.stringify(items.map(i => [i.querySelector('.lb').textContent, i.querySelector('.val').textContent])) === ${jsonStr(jsonStr(expectedItems))} && items.every(i => /^\\d+\\.\\d KB$/.test(i.lastElementChild.textContent) || /^\\d+\\.\\d MB$/.test(i.lastElementChild.textContent)) && !s.textContent.includes(${jsonStr(worktreeRoot)}) && !s.textContent.includes('gc-awaiting') && document.activeElement === s.querySelectorAll('.sheet-btns button')[0] && s.querySelector('.sheet-btns button:last-of-type').classList.contains('danger') && s.querySelector('.sheet-btns button:last-of-type').textContent === ${jsonStr(s6.gcConfirm)}; })()`);
        await save('ui07-gc-confirm-dark');
        nativeTheme.themeSource = 'light'; await pause(350); await save('ui07-gc-confirm-light'); nativeTheme.themeSource = 'dark'; await pause(350);
        // 取消不删任何东西。
        await key('Escape');
        await wait('!document.querySelector(".sheet")', 'UI07 Esc 关闭清理确认框');
        await verify('UI07 取消（Esc）不删：两样都还在', () => { assert.ok(existsSync(acceptedDir) && existsSync(sessionDir) && existsSync(awaitingDir)); });
        await press('[data-pref=gc]');
        await wait('!!document.querySelector(".sheet [data-gc-item]")', 'UI07 再次打开清理确认框');
        await press('.sheet-btns button:last-of-type');
        await wait('!!document.querySelector("[data-gc-done]")', 'UI07 清理完成后这一行显示完成说明', 90000);
        await verify('UI07 点“清理”后：孤立的 worktree 与过期会话目录都已删除，待验收任务的 worktree 没动', () => {
            assert.equal(existsSync(acceptedDir), false, '孤立 worktree 应已删除');
            assert.equal(existsSync(sessionDir), false, '过期会话目录应已删除');
            assert.ok(existsSync(awaitingDir), '待验收任务的 worktree 不能删');
            assert.match(git(repo, ['worktree', 'list', '--porcelain']), /gc-awaiting/);
            assert.doesNotMatch(git(repo, ['worktree', 'list', '--porcelain']), /gc-accepted/);
            assert.equal(git(repo, ['branch', '--list', 'ar/gc-accepted']), '', '已合并任务的分支随 worktree 一起删除');
            assert.ok(git(repo, ['branch', '--list', 'ar/gc-awaiting']).includes('ar/gc-awaiting'));
        });
        await check('UI07 清理完成后这一行显示“已清理 2 项，约 …”', `document.querySelector('[data-gc-done]').textContent.startsWith(${jsonStr(s6.gcDone(2, ''))}) && !document.querySelector('[data-gc-done]').textContent.includes('没删掉')`);
        await wait(`document.querySelector('[data-gc-row]').textContent.includes(${jsonStr(s6.gcIdle)})`, 'UI07 自动重新检查后显示“没有可清理的内容”', 60000);
        await check('UI07 重新检查后显示 s6.gcIdle，按钮是“重新检查”，已清理的说明仍在', `(() => { const r = document.querySelector('[data-gc-row]'); return r.textContent.includes(${jsonStr(s6.gcIdle)}) && !r.querySelector('[data-gc-found]') && r.querySelector('[data-pref=gc-recheck]')?.textContent === ${jsonStr(s6.gcRecheck)} && !!r.querySelector('[data-gc-done]'); })()`);
        await evaluate('document.querySelector("[data-gc-row]").scrollIntoView({ block: "center" })');
        await save('ui07-gc-done-dark');
        await press('[data-pref=gc-recheck]');
        await wait(`document.querySelector('[data-gc-row]').textContent.includes(${jsonStr(s6.gcIdle)}) && !document.querySelector('[data-gc-done]')`, 'UI07 手动重新检查后清掉上次的完成说明');
        await verify('UI07 待验收任务的 worktree 仍不在可清理列表里', async () => {
            const again = await gcCore(['gc', '--dry-run']);
            assert.equal(again.worktrees.length + again.slots.length + again.sessions.length, 0);
            assert.ok(existsSync(awaitingDir));
        });
    } finally {
        // 收尾：撤掉清单里补的行（只去掉自己加的），删临时仓库与 worktree。
        const current = await readFile(manifest, 'utf8').catch(() => '');
        if (manifestBefore || current.includes('shots-gc-')) await writeFile(manifest, current.split('\n').filter(line => !line.includes('"shots-gc-')).join('\n'));
        if (existsSync(repo)) git(repo, ['worktree', 'prune']);
        await rm(awaitingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => null);
        await rm(acceptedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => null);
        await rm(sessionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => null);
        await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => null);
        win.setContentSize(original.size[0], original.size[1]);
        nativeTheme.themeSource = original.theme;
    }
    await goTasks();
    void focusRing;
}
