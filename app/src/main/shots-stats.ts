import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { nativeTheme, type BrowserWindow } from 'electron';
import type { Harness } from './shots-input';
import { appEnvironment } from './app-env.mjs';
import { effects } from './effects';

// 使用隔离目录中的假执行者与匿名事件，检查实际落盘与统计重算。
export async function captureStats(h: Harness, win: BrowserWindow) {
    const { press, key, type, tabTo, wait, check, verify, pause, evaluate, save } = h;
    const home = appEnvironment(process.env).AGENT_ROUTER_HOME!;
    assert.ok(home && path.isAbsolute(home) && path.resolve(home).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()));
    const config = path.join(home, 'config.json'), runs = path.join(home, 'runs.jsonl'), fixture = path.join(home, 'shots-stats');
    const oldConfig = await readFile(config, 'utf8').catch(() => null), oldRuns = await readFile(runs, 'utf8').catch(() => null);
    const previous = { size: win.getContentSize(), theme: nativeTheme.themeSource };
    const cfg = { v: 2, defaultProfile: 'alpha', managed: false, watchWindow: 'never', profiles: { alpha: { adapter: 'fake', label: 'Alpha', enabled: true } } };
    const readConfig = async () => JSON.parse(await readFile(config, 'utf8'));
    try {
        await mkdir(fixture, { recursive: true });
        await writeFile(config, JSON.stringify(cfg));
        const now = Date.now(), day = 86400000, rows: unknown[] = [];
        for (const [i, age] of [1, 12].entries()) {
            const id = `stats-${i}`, dir = path.join(fixture, id), at = now - age * day;
            await mkdir(path.join(dir, 'attempts', '1'), { recursive: true });
            rows.push({ event: 'start', v: 2, id, repo: path.join(fixture, `project-${i}`), dir, started: at, profile: 'alpha', worktree: true },
                { event: 'attempt', v: 1, id, n: 1, profile: 'alpha', at: at + 100 },
                { event: 'attempt-end', v: 1, id, n: 1, gate: true, usage: { input: 1000000, output: 1000000 } },
                { event: 'end', v: 1, id, exit: 0, at: at + 200 },
                { event: 'accepted', v: 1, id, merge: 'a'.repeat(40), at: at + 300 });
        }
        await writeFile(runs, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
        await press('[data-page=stats]');
        await wait('document.querySelectorAll(".stat-tbl tbody tr").length > 0 && !!document.querySelector("[data-price-edit]")');
        await check('UI32 最近一周和审查者空状态', 'document.querySelector(".kpi .v").textContent === "1" && document.querySelector(".kpi .sub").textContent === "最近一周" && !!document.querySelector(".stat-review-empty") && !document.querySelector(".stat-review-empty").closest(".card")');
        await check('UI32 默认七天的任务数', 'document.querySelectorAll(".tr-bar").length === 1 && parseInt(document.querySelector(".stat-tbl tbody tr td:nth-child(4)").textContent) === 1');
        await press('[data-stat-range="30d"]');
        await wait('document.querySelectorAll(".tr-bar").length === 2');
        await check('UI32 切换范围更新数字', 'document.querySelectorAll(".tr-bar").length === 2 && document.querySelector("[data-stat-range=\\"30d\\"]").classList.contains("on") && parseInt(document.querySelector(".stat-tbl tbody tr td:nth-child(4)").textContent) === 2');
        await press('[data-stat-range="all"]');
        await wait('document.querySelector("[data-stat-range=all]").classList.contains("on") && parseInt(document.querySelector(".stat-tbl tbody tr td:nth-child(4)").textContent) === 2');
        await check('UI32 全部范围任务数', 'parseInt(document.querySelector(".stat-tbl tbody tr td:nth-child(4)").textContent) === 2');
        await press('[data-stat-project]'); await key('Home'); await key('Down'); await key('Enter');
        await wait('document.querySelector("[data-stat-project]").value && parseInt(document.querySelector(".stat-tbl tbody tr td:nth-child(4)").textContent) === 1');
        await check('UI32 项目统计与样本一致', 'document.querySelector("[data-stat-project]").value.endsWith("project-0") && parseInt(document.querySelector(".stat-tbl tbody tr td:nth-child(4)").textContent) === 1');
        await press('[data-stat-project]'); await key('Home'); await key('Enter');
        await wait('!document.querySelector("[data-stat-project]").value && parseInt(document.querySelector(".stat-tbl tbody tr td:nth-child(4)").textContent) === 2');
        const start = effects.ipcLog.length;
        effects.consoleDelay['stats:get'] = 10000;
        await press('[data-stat-range="7d"]');
        const oldRequest = effects.ipcLog.slice(start).find(x => x.name === 'stats:get' && !x.end);
        assert.ok(oldRequest, '旧请求未进入延迟桩');
        delete effects.consoleDelay['stats:get'];
        await press('[data-stat-range="all"]');
        const newDeadline = Date.now() + 15000;
        while (!effects.ipcLog.slice(start).some(x => x.name === 'stats:get' && x.seq > oldRequest.seq && x.end) && Date.now() < newDeadline) await pause(100);
        assert.ok(effects.ipcLog.slice(start).some(x => x.name === 'stats:get' && x.seq > oldRequest.seq && x.end && !oldRequest.end), '新请求没有先于旧请求完成');
        await wait('document.querySelector("[data-stat-range=all]").classList.contains("on") && parseInt(document.querySelector(".stat-tbl tbody tr td:nth-child(4)").textContent) === 2');
        const deadline = Date.now() + 15000;
        while (!oldRequest.end && Date.now() < deadline) await pause(100);
        assert.ok(oldRequest.end, '旧请求未完成');
        await pause(300);
        await check('UI32 旧请求晚到不覆盖新选择', 'document.querySelector("[data-stat-range=all]").classList.contains("on") && parseInt(document.querySelector(".stat-tbl tbody tr td:nth-child(4)").textContent) === 2');
        const point = await evaluate(`(async () => {
            const el = document.querySelector('.tr-bar');
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            const ancestors = []; for (let p = el.parentElement; p; p = p.parentElement) ancestors.push(p);
            const positions = () => [scrollX, scrollY, ...ancestors.flatMap(p => [p.scrollLeft, p.scrollTop])].join(',');
            let last = positions(), stable = 0, start = performance.now();
            while (stable < 2) {
                await new Promise(requestAnimationFrame);
                const current = positions(); stable = current === last ? stable + 1 : 0; last = current;
                if (performance.now() - start > 5000) throw Error('图表滚动未停止');
            }
            const r = el.getBoundingClientRect(), x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
            const hit = document.elementFromPoint(x, y);
            return { x, y, hit: hit === el || el.contains(hit) };
        })()`);
        assert.ok(point.hit, '趋势柱中心未命中');
        win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
        await wait('!!document.querySelector(".tip")');
        await check('UI32 趋势悬停日期与数值', '/\\d{4}-\\d{2}-\\d{2}.*任务 1.*通过 1/.test(document.querySelector(".tip").textContent)');
        const missingPoint = await evaluate(`(async () => {
            const el = document.querySelector('.kpi .v[data-tip]');
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            const ancestors = []; for (let p = el.parentElement; p; p = p.parentElement) ancestors.push(p);
            const positions = () => [scrollX, scrollY, ...ancestors.flatMap(p => [p.scrollLeft, p.scrollTop])].join(',');
            let last = positions(), stable = 0, start = performance.now();
            while (stable < 2) { await new Promise(requestAnimationFrame); const current = positions(); stable = current === last ? stable + 1 : 0; last = current; if (performance.now() - start > 5000) throw Error('滚动未停止'); }
            const r = el.getBoundingClientRect(), x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
            return { x, y, hit: document.elementFromPoint(x, y) === el };
        })()`);
        assert.ok(missingPoint.hit, '缺失值中心未命中');
        win.webContents.sendInputEvent({ type: 'mouseMove', x: missingPoint.x, y: missingPoint.y });
        await wait('document.querySelector(".tip")?.textContent === "缺单价或用量，算不出费用"');
        await check('UI32 缺失值悬停原因', 'document.querySelector(".tip")?.textContent === "缺单价或用量，算不出费用"');
        await press('[data-price-edit]');
        await type('[data-price-input]', '2'); await type('[data-price-output]', '8');
        await press('[data-price-save]');
        await wait('!document.querySelector("[data-price-save]")');
        await verify('UI32 保存价格与重算费用', async () => { assert.deepEqual((await readConfig()).prices.alpha, { input: 2, output: 8, currency: 'CNY' }); await wait('document.querySelector(".kpis").textContent.includes("CNY 20")'); });
        const savedPrices = (await readConfig()).prices;
        await press('[data-price-edit]'); await type('[data-price-input]', '9'); await press('[data-price-cancel]');
        await verify('UI32 点击取消不写价格', async () => assert.deepEqual((await readConfig()).prices, savedPrices));
        await press('[data-price-edit]'); await tabTo('[data-price-cancel]'); await key('Escape');
        await verify('UI32 Esc 取消不写', async () => assert.equal((await readConfig()).prices.alpha.input, 2));
        await press('[data-price-edit]'); await press('[data-price-input]'); await key('a', ['control']); await key('Backspace');
        await check('UI32 输入单价前已清空', 'document.querySelector("[data-price-input]").value === ""'); await type('[data-price-input]', '0.005'); await press('[data-price-save]');
        await wait('!document.querySelector("[data-price-save]") && document.querySelector(".px-vals").textContent.includes("0.005")');
        await verify('UI32 单价保留原始精度', async () => assert.equal((await readConfig()).prices.alpha.input, 0.005));
        await press('[data-price-edit]'); await press('[data-price-clear]');
        await wait('!document.querySelector("[data-price-clear]")');
        await verify('UI32 清除价格', async () => assert.equal((await readConfig()).prices.alpha, undefined));
        await press('[data-price-edit]'); await type('[data-price-input]', '9'.repeat(310)); await type('[data-price-output]', '1'); await press('[data-price-save]');
        await wait('!!document.querySelector("[data-price-row] [role=alert]")');
        await check('UI32 失败保留草稿和原因', 'document.querySelector("[data-price-input]").value.length === 310 && document.querySelector("[data-price-row] [role=alert]").textContent.length > 0');
        await press('[data-price-cancel]');
        for (const size of [[1160, 720], [960, 600]]) for (const theme of ['dark', 'light'] as const) {
            win.setContentSize(size[0], size[1]); nativeTheme.themeSource = theme; await pause(350); await save(`ui32-stats-${size[0]}-${theme}`);
        }
        // 427：列头说明、方向箭头、"怎么看这张表"与一格两个数。
        const firstPassHelp = '第一次尝试就通过门禁和审查的比例，越高越好。后面的小字是 95% 置信区间：样本越少区间越宽，例如 4 个任务全过是 51–100%，意思是真实通过率大概在这个范围里';
        const howText = '每一行是一个执行者在某类任务、某个推理强度下的表现。先看"样本"够不够（至少 5 个）；再比"一次通过"（越高越好）和"平均尝试"（越低越好），判断谁更靠谱；同样靠谱时比"每个合并任务 token"和"费用"，选更省的。路由页可以按这些结果调整谁做哪类任务。';
        await check('UI33 执行者列头 11 个都有说明', 'document.querySelectorAll(".stat-tbl")[0].querySelectorAll("thead th .stat-help").length === 11 && [...document.querySelectorAll(".stat-tbl")[0].querySelectorAll("thead th .stat-help")].every(b => b.getClientRects().length > 0 && b.tabIndex >= 0)');
        await tabTo('.stat-tbl thead th:nth-child(5) .stat-help');
        await check('UI33 一次通过的说明原文与 aria-describedby', `(() => { const b = document.activeElement; const id = b && b.getAttribute && b.getAttribute('aria-describedby'); return !!id && b.classList.contains('stat-help') && document.getElementById(id)?.textContent === ${JSON.stringify(firstPassHelp)}; })()`);
        await check('UI33 一次通过越高越好、平均尝试越低越好', 'document.querySelector(".stat-tbl thead th:nth-child(5) .stat-dir")?.getAttribute("aria-label") === "越高越好" && document.querySelector(".stat-tbl thead th:nth-child(6) .stat-dir")?.getAttribute("aria-label") === "越低越好"');
        await check('UI33 比例区间有悬停说明', '/^95% 置信区间 \\d+–\\d+$/.test(document.querySelector(".stat-tbl tbody tr td:nth-child(5) .ci")?.title ?? "")');
        await press('[data-stat-how] summary');
        await check('UI33 怎么看这张表展开原文', `document.querySelector("[data-stat-how]").open === true && document.querySelector("[data-stat-how] p")?.textContent === ${JSON.stringify(howText)}`);
        await check('UI33 token 一格两个数', 'document.querySelector(".stat-tbl tbody tr td:nth-child(10)")?.textContent.startsWith("输入 ") === true');
        const leadHelp = [
            '主导用的工具与模型（启动主导时记下的）；没记录到的显示未记录',
            '门禁失败里，归因为任务说明本身的问题（漏列文件、验收命令写错、要求矛盾）的比例，越低越好：说明写得越清楚越低',
            '主导重试时补充说明的次数，越少越好（说明一次写清楚）；目前还没有统计，显示 —',
            '从派发到合并的时间，取中间值，越短越好',
        ];
        const leadTable = JSON.stringify('主导统计');
        const leadTableExpr = `[...document.querySelectorAll(".stat-tbl")].find(x => x.getAttribute("aria-label") === ${leadTable})`;
        await check('UI33 主导表四个列头说明原文', `(() => { const t = ${leadTableExpr}; if (!t) return false; const helps = [...t.querySelectorAll("thead th .stat-help")]; const ids = helps.map(b => document.getElementById(b.getAttribute("aria-describedby"))?.textContent); return helps.length === 4 && JSON.stringify(ids) === JSON.stringify(${JSON.stringify(leadHelp)}); })()`);
        await check('UI33 主导表越低越好箭头', `(() => { const t = ${leadTableExpr}; if (!t) return false; const dirs = [...t.querySelectorAll("thead th .stat-dir")]; return dirs.length === 3 && dirs.every(d => d.getAttribute("aria-label") === "越低越好"); })()`);

        // 427：额外数据目录（只读）。追加一个目录后统计页出现来源行，点"在设置里管理"跳到设置页对应一节。
        const extra = path.join(fixture, 'extra'), added = path.join(fixture, 'extra-2');
        await mkdir(extra, { recursive: true });
        const extraNow = Date.now();
        await writeFile(path.join(extra, 'runs.jsonl'), [
            { event: 'start', v: 2, id: 'stats-extra', repo: path.join(fixture, 'project-extra'), dir: path.join(extra, 'stats-extra'), started: extraNow, profile: 'alpha', worktree: true },
            { event: 'attempt', v: 1, id: 'stats-extra', n: 1, profile: 'alpha', at: extraNow + 100 },
            { event: 'attempt-end', v: 1, id: 'stats-extra', n: 1, gate: true, usage: { input: 1000000, output: 1000000 } },
            { event: 'end', v: 1, id: 'stats-extra', exit: 0, at: extraNow + 200 },
            { event: 'accepted', v: 1, id: 'stats-extra', merge: 'b'.repeat(40), at: extraNow + 300 },
        ].map(row => JSON.stringify(row)).join('\n') + '\n');
        await writeFile(config, JSON.stringify({ ...cfg, statsSources: [extra] }));
        await press('[data-stat-range="7d"]');
        await wait('!!document.querySelector(".stat-source") && parseInt(document.querySelector(".stat-tbl tbody tr td:nth-child(4)").textContent) === 2');
        await check('UI33 额外来源提示', `document.querySelector(".stat-source")?.textContent.trim() === ${JSON.stringify('统计包含 1 个额外的数据目录（只读）· 在设置里管理')}`);
        await press('[data-stat-sources-manage]');
        await wait(`!!document.querySelector("#stats-sources-section") && document.querySelector("#stats-sources-section").textContent.includes(${JSON.stringify(extra)})`);
        await check('UI33 在设置里管理跳到对应一节', '(() => { const s = document.querySelector("#stats-sources-section"); if (!s) return false; const r = s.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; })()');
        await mkdir(added, { recursive: true });
        await writeFile(path.join(added, 'runs.jsonl'), JSON.stringify({ event: 'start', v: 2, id: 'stats-added', repo: path.join(fixture, 'project-added'), started: Date.now(), profile: 'alpha', worktree: true }) + '\n');
        effects.folders.push(added);
        await press('[data-pref="stats-source-add"]');
        await wait(`document.querySelector("#stats-sources-section")?.textContent.includes(${JSON.stringify(added)})`);
        await check('UI33 设置里添加目录', 'document.querySelectorAll("#stats-sources-section .set .set-r [data-pref=stats-source-remove]").length === 2');
        await press('#stats-sources-section .set .set-r:nth-last-child(2) [data-pref="stats-source-remove"]');
        await wait(`!document.querySelector("#stats-sources-section")?.textContent.includes(${JSON.stringify(added)})`);
        await verify('UI33 设置里移除目录', async () => assert.deepEqual((await readConfig()).statsSources, [extra]));
        // 427：额外目录存在但读不到 runs.jsonl 时，来源行提示已跳过。
        const unreadable = path.join(fixture, 'unreadable');
        await mkdir(unreadable, { recursive: true });
        await writeFile(config, JSON.stringify({ ...cfg, statsSources: [extra, unreadable] }));
        await press('[data-page=stats]');
        await press('[data-stat-range="all"]');
        await wait('document.querySelector(".stat-source")?.textContent.includes("已跳过")');
        await check('UI33 来源行提示跳过的目录', 'document.querySelector(".stat-source")?.textContent.includes("1 个额外的数据目录") === true && document.querySelector(".stat-source")?.textContent.includes("已跳过") === true');
        await writeFile(config, JSON.stringify({ ...cfg, statsSources: [extra] }));
        await press('[data-stat-range="7d"]');
        await wait('!!document.querySelector(".stat-source") && !document.querySelector(".stat-source").textContent.includes("已跳过")');

        // 427：深浅两主题的统计页说明与设置页本节截图。
        win.setContentSize(1160, 720);
        await press('[data-page=stats]');
        await wait('!!document.querySelector(".stat-source") && !!document.querySelector("[data-stat-how]")');
        await press('[data-stat-how] summary');
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await pause(350); await save(`stats-help-${theme}`); }
        await press('[data-page=settings]');
        await wait('!!document.querySelector("#stats-sources-section")');
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await pause(350); await save(`prefs-stats-sources-${theme}`); }
    } finally {
        delete effects.consoleDelay['stats:get'];
        if (oldConfig === null) await rm(config, { force: true }); else await writeFile(config, oldConfig);
        // 还原清单先删除再写入，让文件身份（inode / 创建时间）变化：否则检查写过的清单被换回旧内容时，
        // RegistryReader 会把同长度、末字节仍是换行的文件当成没变过，继续用新内容的已读位置续读（295）。
        await rm(runs, { force: true });
        if (oldRuns !== null) await writeFile(runs, oldRuns);
        await rm(fixture, { recursive: true, force: true });
        win.setContentSize(previous.size[0], previous.size[1]); nativeTheme.themeSource = previous.theme;
    }
}
