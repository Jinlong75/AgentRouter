import { captureWizard, capturePreferences } from './shots-preferences';
import { captureProjects } from './shots-projects';
import { captureNewtask, waitNewtaskReady } from './shots-newtask';
import { clock, cpuNow, coreReport, coreSeq, ipcReport, ipcSeq, pollUntil, recentReport } from './shots-input';
import type { BrowserWindow } from 'electron';
import { app, nativeTheme } from 'electron';
import { mkdir, writeFile, readFile, appendFile, open, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { c, p, pj, nt } from '../shared/copy';
import type { Registry } from './registry';
import { dispatchMatches, windowsPlatform } from './platform';
import { coreRun, coreScript } from './core';
import { effects } from './effects';
import { createHarness, progress, type Harness } from './shots-input';
import { internal, spawnPhases, startProbe, wall, type SpawnPhases } from './shots-probe';
import { appEnvironment, isolatedEnvKey } from './app-env.mjs';
// 演示汇报正文与 npm run demo 同源（tools/demo/data.mjs）；只在验收里写入，不改演示生成器。
// @ts-ignore —— 演示数据是零依赖 .mjs，没有类型声明；打包时由 esbuild 一并打包。
import { reportRich } from '../../../tools/demo/data.mjs';

// 隔离用的路径从软件内部环境读（AR_ISOLATED_ENV，见 app-env.mjs）；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);

/*
 * 界面功能基线与检查的对应；每条检查的标签以编号开头，交接记录直接引用：
 * UI01 侧栏导航到每个已交付页面，当前页高亮，键盘可切换 ——「UI01 …」（本文件）
 * UI02 任务列表：分组、筛选、项目下拉 ——「UI02 …」（本文件）
 * UI03 选中任务显示详情；标签切换；时间线跟随最新进展 ——「UI03 …」（本文件）
 * UI04 停止任务：确认框默认焦点在取消，确认后真实停止 ——「UI04 …」（本文件：假派发进程树真的结束、清单写 interrupted、列表变中断）
 * UI05 更多菜单各项 ——「UI05 …」（本文件：打开类与复制由桩记录参数，隐藏写入 tasks.json）
 * UI06 技能安装、更新、回退、自改版本不替换 ——「UI06 …」（shots-preferences.ts：断言安装记录与备份文件）
 * UI07 设置页每一项写入、失败恢复、环境变量覆盖说明 ——「UI07 …」（shots-preferences.ts：读 config.json 断言）
 * UI08 关于页信息正确；"重新运行首次引导"可用 ——「UI08 …」（shots-preferences.ts）
 * UI09 首次引导完整走一遍 ——「UI09 …」（shots-preferences.ts：断言配置与技能真的写入）
 * UI10 主题：跟随系统 / 深色 / 浅色切换即时生效 ——「UI10 …」（shots-preferences.ts）
 * UI11 最小窗口 960×600 下所有页面无溢出、操作可达 ——「UI11 …」（每页通用检查与本文件）
 * UI12 系统通知：任务结束发一条，点开选中该任务 ——「UI12 …」（本文件；通知由桩记录，点开调用与真实通知相同的回调）
 * UI13 导入 Agent 向导 ——「UI13 …」（shots-preferences.ts）
 * UI14 测试连接成功 / 失败 / 超时 ——「UI14 …」（shots-preferences.ts）
 * UI15 项目页：添加、git init、初始化预览 / 写入 / 提交、编辑配置、移除、侧栏分组与执行者负载 ——「UI15 …」（shots-projects.ts）
 * UI16 新建任务页：三种来源、预览、派发成功 / 失败、必填校验、无项目 ——「UI16 …」（shots-newtask.ts：假执行者真实派发，读 runs.jsonl 与 git 提交）
 * UI18 在此项目打开 Claude Code / 打开文件夹 ——「UI18 …」（shots-projects.ts：调用由桩记录）
 * UI19 关闭询问与托盘（012 A）：点 × 的三种行为、记住选择、"窗口"设置、托盘状态与提示 ——「UI19 …」（本文件）
 * UI20 设置页"数据"一节（012 B）：清除缓存、重置确认框；真正的重置在隔离目录的第二次启动里执行 ——「UI20 …」（本文件、tools/shots.mjs）
 * UI21 进程查询失败（W4）：注入失败后横幅、"状态未知"、停止 / 隐藏 / 批量删除禁用且主进程拒绝、不推断结束；恢复后横幅消失、操作恢复 ——「UI21 …」（本文件）
 * 「通用 …」是每页通用检查、真实输入自测与环境检查。
 * 所有交互都用真实输入（press / key / type / tabTo / wheel，见 shots-input.ts），不再调用元素的 click() 或派发合成事件。
 */
// 运行期对照探针（AR_SHOTS_PROBE=1，见 shots-probe.ts）：默认不开；开了就在整个验收期间运行，失败退出前也打印汇总。
export async function capture(win: BrowserWindow, registry: Registry, out: string) {
    const stopProbe = startProbe();
    try { await captureAll(win, registry, out); }
    catch (error) { console.log(`本次完成的检查：${progress.checks.length} 项；最后通过的一项：${progress.checks.at(-1) ?? "（无）"}`); throw error; }
    finally { await stopProbe(); }
}
async function captureAll(win: BrowserWindow, registry: Registry, out: string) {
    // 验收窗口不显示（用户鼠标碰不到，不影响悬停与淡出截图），用普通渲染而不是离屏绘制：
    // Stage01 核实，离屏页面拿不到焦点，真实 Tab 与 :focus-visible 不生效；不显示的普通窗口获得 webContents 焦点后真实输入全部生效。
    win.webContents.setBackgroundThrottling(false);
    win.webContents.focus();
    await mkdir(out, { recursive: true });
    let screenshots = 0;
    // settle=true 时先等 300ms 让界面稳定（常规截图）；再派一次的忙碌态只有几百毫秒，用 settle=false 当场抓。
    const shoot = async (name: string, settle: boolean) => {
        if (settle)
            await h.pause();
        // 仅截图时替换隔离目录前缀，实际设置数据仍保留完整路径。
        await h.evaluate(`(() => {
            window.__shotPaths = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (node.textContent.includes(${JSON.stringify(appEnv.AGENT_ROUTER_HOME)})) {
                    window.__shotPaths.push([node, node.textContent]);
                    node.textContent = node.textContent.replaceAll(${JSON.stringify(appEnv.AGENT_ROUTER_HOME)}, '<临时目录>');
                }
            }
        })()`);
        // 隔离路径也可能包含本机用户名，截图前确认正文没有泄漏该前缀。
        assert.equal(await h.evaluate(`document.body.innerText.includes(${JSON.stringify(appEnv.AGENT_ROUTER_HOME)})`), false, '截图不能显示临时目录的本机绝对路径');
        await h.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const png = (await win.webContents.capturePage()).toPNG();
        assert.ok(png.length > 10000, `截图 ${name} 为空`);
        await writeFile(path.join(out, name + '.png'), png); screenshots++;
        await h.evaluate('window.__shotPaths.forEach(([node, text]) => node.textContent = text); delete window.__shotPaths;');
    };
    const save = (name: string) => shoot(name, true);
    const saveNow = (name: string) => shoot(name, false);
    const h = createHarness(win, save);
    const { pause, evaluate, wait, check, happened, verify, press, key, tabTo, focusRing, wheel, hits, audit, checks } = h;
    // 真实输入但不做 300ms 等待：用于抓「正在派发…」这种很短的中间态（仍然走 sendInputEvent）。
    const pressNow = async (selector: string) => {
        const box = await hits(selector);
        assert.ok(!('error' in box), `${selector}：${'error' in box ? box.error : ''}`);
        const { x, y } = box as { x: number; y: number };
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
    };
    const runs = async () => (await readFile(registry.file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    // 菜单项按文字定位：给当前菜单的按钮标上序号再点，标记只用于定位，不改变行为。
    const menuItem = async (label: string) => {
        const index = await evaluate(`(() => { const items = [...document.querySelectorAll('.ctx button')]; items.forEach((b, i) => b.setAttribute('data-menu-index', String(i))); return items.findIndex(b => b.textContent.trim() === ${JSON.stringify(label)}); })()`);
        assert.ok(index >= 0, `菜单里没有「${label}」`);
        return `.ctx button[data-menu-index="${index}"]`;
    };
    const scrollBox = '.dbody > .scroll';
    // UI05 更多菜单的"打开"与"复制"：每次点击必须恰好产生一次新的桩调用（序号大于点击前最后一条、时刻不早于点击），
    // 路径 / 内容精确相等。每项都打印诊断：点击前选中的任务与它的仓库、点击前最后一条记录、本次新调用（序号、距点击毫秒、路径），
    // 用来区分"软件打开了错目录"和"检查读到了旧记录"。round 只在单独复现（AR_SHOTS_FOCUS=UI05）时非 0。
    const masked = (text: string) => text.replaceAll(os.tmpdir(), '<TEMP>');
    const ui05Opens = async (round: number) => {
        const tag = round ? `（第 ${round} 轮）` : '';
        const t3 = registry.tasks.find(t => t.id === 't3')!;
        await press('[data-task=t3]');
        for (const [label, expected] of [['打开仓库文件夹', t3.repo], ['打开任务说明', path.resolve(t3.repo, t3.spec!)], ['打开汇报文件', t3.report], ['打开进度文件', t3.progress]] as const) {
            const selected = await evaluate('document.querySelector(".trow.on")?.dataset.task ?? null');
            const last = effects.openLog.at(-1), lastSeq = last?.seq ?? 0, ipcFrom = ipcSeq();
            // 分阶段追踪（PR #5 CI 第 14 轮"没有新调用"）：菜单展开 → 点击命中 → 渲染层点击事件 → 发出操作 → 主进程收到 → 打开记录。
            await evaluate('document.documentElement.dataset.arTrace = "1"; window.__arTrace = []');
            await press('[data-more]');
            const menuState = await evaluate('JSON.stringify({ items: document.querySelectorAll(".ctx button").length, focus: document.activeElement?.getAttribute("role") + ":" + (document.activeElement?.textContent ?? "").slice(0, 12) })');
            const item = await menuItem(label);
            const aim = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(item)}); if (!el) return '找不到菜单项'; const r = el.getBoundingClientRect(), x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2), hit = document.elementFromPoint(x, y); return '(' + x + ',' + y + ') → ' + (hit ? hit.tagName + '「' + (hit.textContent || '').slice(0, 10) + '」' : '无') + (hit === el || el.contains(hit) ? '（是目标）' : '（不是目标）'); })()`);
            // 时刻从点菜单项那一下算起（旧检查正是在这一下之后 300 ms 读"最后一条"）。
            const clickAt = Date.now(); await press(item);
            const fresh = () => effects.openLog.filter(e => e.seq > lastSeq);
            const stages = async () => {
                const events = JSON.parse(await evaluate('JSON.stringify(window.__arTrace ?? [])')) as { at: number; event: string; label?: string; error?: string }[];
                const renderer = events.filter(e => e.at >= clickAt - 50).map(e => `${e.event}${e.label ? '「' + e.label + '」' : ''}${e.error ? '：' + e.error : ''} +${e.at - clickAt}ms`).join('，') || '无';
                const main = effects.ipcLog.filter(e => e.seq > ipcFrom && e.channel === 'action').map(e => `${e.name} 收到 +${e.start - clickAt}ms${e.end === undefined ? ' 未返回' : `、${e.end - e.start} ms ${e.ok ? '成功' : '失败：' + e.error}`}`).join('，') || '没有收到';
                const opened = fresh().map(e => `#${e.seq} +${e.at - clickAt}ms ${e.path}`).join('、') || '无';
                return masked(`UI05 阶段${tag}「${label}」：点击前选中 ${selected}；点击前最后一条打开记录 #${lastSeq}；菜单展开 ${menuState}；命中 ${aim}；渲染层 ${renderer}；主进程 ${main}；打开记录 ${opened}`);
            };
            try { await happened(`UI05 菜单「${label}」调用打开${tag}`, () => fresh().length > 0, 2000); }
            catch (error) {
                // 失败后再观察 5 秒，只记录有没有迟到的调用；无论有没有都仍然算失败。
                const failedAt = Date.now();
                while (!fresh().length && Date.now() - failedAt < 5000) await pause(100);
                console.log(await stages());
                console.log(masked(`UI05 失败后观察 5 秒：${fresh().length ? '有迟到调用 ' + fresh().map(e => `#${e.seq} +${e.at - clickAt}ms`).join('、') : '没有迟到调用'}；当前提示 ${await evaluate('document.querySelector(".notice")?.textContent ?? "无"')}`));
                await save(`ui05-fail-${round}`).catch(() => {});
                throw error;
            }
            console.log(await stages());
            await verify(`UI05 菜单「${label}」真实调用打开（桩记录路径）${tag}`, () => {
                assert.equal(selected, 't3', '点击前选中的应是 t3');
                assert.equal(fresh().length, 1, '本次点击应恰好产生一次打开调用');
                assert.ok(fresh()[0].at >= clickAt, '新调用的时刻应不早于点击');
                assert.equal(fresh()[0].path, expected);
            });
        }
        const lastCopy = effects.copyLog.at(-1)?.seq ?? 0;
        await press('[data-more]'); const copyItem = await menuItem('复制记录名'); const copyAt = Date.now(); await press(copyItem);
        const copies = () => effects.copyLog.filter(e => e.seq > lastCopy);
        await happened(`UI05 菜单「复制记录名」写入剪贴板${tag}`, () => copies().length > 0, 2000);
        await verify(`UI05 菜单「复制记录名」写入剪贴板（桩记录内容）${tag}`, () => {
            assert.equal(copies().length, 1, '本次点击应恰好产生一次复制');
            assert.ok(copies()[0].at >= copyAt, '复制的时刻应不早于点击');
            assert.equal(copies()[0].text, t3.name);
        });
    };

    // 确认核心追踪确实启用（PR #5 CI）：跑一次 ar version，看主进程收到了几行进程内追踪。
    {
        const before = effects.coreLog.length;
        await coreRun(['version'], { timeoutMs: 60000 });
        const probe = effects.coreLog[before];
        console.log(`核心追踪：${probe?.trace.length ? `已启用（ar version 收到 ${probe.trace.length} 行，进程内最早标记 ${probe.trace[0].replace(/ @\d+/, '')}）` : '未启用（没有收到追踪行）'}`);
    }
    // 诊断基线（PR #5 CI）：验收开始时机器在忙什么。
    console.log('验收开始时的 CPU（1 秒采样）：' + await cpuNow());
    await captureWizard(h);
    await wait('!!document.querySelector("[data-task=t1]")');
    // UI15 / UI18：项目页在 UI01 之前准备好（UI01 的页面清单里加了"项目"），结束后回到任务页。
    await captureProjects(h);
    // 单独复现新建任务页加载（PR #5 CI）：先完整跑一次新建任务页检查，再反复离开、进入新建任务页并等待加载完成，打印每次用时与核心调用。
    if (process.env.AR_SHOTS_FOCUS === 'newtask-load') {
        const rounds = Math.max(1, Math.min(100, Number(process.env.AR_SHOTS_REPEAT) || 10));
        await captureNewtask(h);
        for (let round = 1; round <= rounds; round++) {
            await press('[data-page=tasks]'); await wait('!!document.querySelector("[data-task]")');
            const fromSeq = ipcSeq(), fromCore = coreSeq(), started = Date.now();
            await press('[data-page=newtask]');
            await waitNewtaskReady(h, `新建任务页加载完成（第 ${round} 轮）`, fromSeq, started, fromCore);
        }
        await writeFile(path.join(out, 'checks.json'), JSON.stringify({ focus: 'newtask-load', rounds, checks }, null, 2));
        console.log(`只跑新建任务页加载：${rounds} 轮全部在标准内完成。`);
        return;
    }
    if (process.env.AR_SHOTS_FOCUS === 'core-spawn') {
        const rounds = Math.max(1, Math.min(100, Number(process.env.AR_SHOTS_REPEAT) || 20));
        await captureCoreSpawn(rounds);
        await writeFile(path.join(out, 'checks.json'), JSON.stringify({ focus: 'core-spawn', rounds, checks }, null, 2));
        console.log(`核心启动对照：${rounds} 轮完成。`);
        return;
    }
    // 单独复现 UI17 失败路径（PR #5 CI）：选 t3 点"再派一次"，等这一次点击产生的失败横幅（上限 10 秒，与原检查相同），
    // 断言与原检查相同；每轮打印完整时间线。上一轮留下的横幅不算：必须看到这次点击之后的 redispatch-error。
    if (process.env.AR_SHOTS_FOCUS === 'UI17-fail') {
        const rounds = Math.max(1, Math.min(100, Number(process.env.AR_SHOTS_REPEAT) || 20));
        await press('[data-page=tasks]'); await wait('!!document.querySelector("[data-task=t3]")');
        for (let round = 1; round <= rounds; round++) {
            const tag = `（第 ${round} 轮）`;
            await press('[data-task=t5]'); await wait('document.querySelector("[data-task=t5]").classList.contains("on")');
            await press('[data-task=t3]'); await wait('!!document.querySelector("[data-redispatch]")');
            const starts = (await readRows(registry)).filter(r => r.event === 'start').length;
            const mark = await ui17Mark(h, registry);
            await press('[data-redispatch]');
            try { await wait(`(window.__arTrace ?? []).some(e => e.event === 'redispatch-error' && e.at >= ${mark.clickAt}) && !!document.querySelector(".banner.fail")`, `再派一次失败横幅${tag}`); }
            finally { console.log(masked(await ui17Timeline(h, mark, tag))); }
            await check(`UI17 再派一次失败时在页面横幅说明原因${tag}`, 'document.querySelector(".banner.fail .rt span")?.textContent.includes("这个任务是旧版本派发的，没有保存派发参数，不能再派一次")');
            await verify(`UI17 再派一次失败不产生新任务行${tag}`, async () => { assert.equal((await readRows(registry)).filter(r => r.event === 'start').length, starts); });
        }
        await writeFile(path.join(out, 'checks.json'), JSON.stringify({ focus: 'UI17-fail', rounds, checks }, null, 2));
        console.log(`只跑 UI17 失败路径：${rounds} 轮，${checks.length} 项检查全部通过。`);
        return;
    }
    // 单独复现 UI05（PR #5 CI）：紧接项目页检查（它留下的最后一条打开记录与 CI 失败时读到的旧值相同），重复跑 UI05 的打开与复制。
    if (process.env.AR_SHOTS_FOCUS === 'UI05') {
        const rounds = Math.max(1, Math.min(200, Number(process.env.AR_SHOTS_REPEAT) || 20));
        await press('[data-page=tasks]'); await wait('!!document.querySelector("[data-task=t3]")');
        for (let round = 1; round <= rounds; round++) await ui05Opens(round);
        await writeFile(path.join(out, 'checks.json'), JSON.stringify({ focus: 'UI05', rounds, checks }, null, 2));
        console.log(`只跑 UI05：${rounds} 轮，${checks.length} 项检查全部通过。`);
        return;
    }
    await press('[data-page=tasks]');
    await wait('!!document.querySelector("[data-task=t1]")');
    await verify('通用 sendInputEvent 在不显示的验收窗口中生效：首次引导全程由真实点击与键盘完成', () => { assert.ok(checks.some(label => label.startsWith('UI09'))); });
    // 当前 Electron 提供此诊断入口但未导出类型，限定在验收工具中使用。
    const contents = win.webContents as typeof win.webContents & { getLastWebPreferences(): Electron.WebPreferences };
    const prefs = contents.getLastWebPreferences();
    await verify('通用 窗口启用隔离与沙箱，关闭 Node 集成', () => { assert.equal(prefs.contextIsolation, true); assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false); });
    // 软件用自带 Node 运行核心（开发时为 electron.exe），与安装包行为一致。
    const core = await coreRun(['version']);
    await verify(`通用 软件用内置 Node 运行核心：ar version 返回 Node ${core.json.node}`, () => { assert.equal(core.code, 0, core.stderr); assert.equal(core.json.ok, true); assert.equal(core.json.node, process.versions.node); assert.equal(core.json.electron, process.versions.electron); });
    await check('通用 渲染器没有 Node 权限', 'typeof require === "undefined" && typeof process === "undefined"');
    await verify('通用 通过 Windows 进程身份检查识别两个假派发进程', () => { assert.equal(registry.tasks.filter(t => t.status === 'run').length, 2); });
    // shell.openPath 打开的外部程序继承主进程环境：不带 env 启动一个子进程，它看到的必须是用户真实环境，而不是演示的假目录。
    // 主进程用的是用户真实环境，Electron 的数据目录必须仍在临时公共目录里，不能落到安装版的 %APPDATA%\AgentRouter。
    await verify('通用 Electron 数据目录（userData、sessionData、crashDumps、logs）都在临时公共目录里', () => {
        const home = appEnv.AGENT_ROUTER_HOME!;
        for (const name of ['userData', 'sessionData', 'crashDumps', 'logs'] as const) {
            const relative = path.relative(home, app.getPath(name));
            assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${name} 不在临时公共目录里：${app.getPath(name)}`);
        }
    });
    await verify('通用 隔离环境只进软件内部：软件启动的外部程序继承用户真实 USERPROFILE / APPDATA', async () => {
        assert.ok(process.env[isolatedEnvKey], '截图验收应通过 AR_ISOLATED_ENV 传入隔离环境');
        assert.notEqual(process.env.USERPROFILE, appEnv.USERPROFILE);
        const seen = await new Promise<string>((resolve, reject) => {
            const p = spawn(process.env.AR_TEST_NODE!, ['-e', 'process.stdout.write(JSON.stringify([process.env.USERPROFILE ?? null, process.env.APPDATA ?? null]))'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false });
            let text = ''; p.stdout!.on('data', d => text += d); p.on('error', reject); p.on('close', () => resolve(text));
        });
        assert.deepEqual(JSON.parse(seen), [process.env.USERPROFILE ?? null, process.env.APPDATA ?? null]);
        assert.notEqual(JSON.parse(seen)[0], appEnv.USERPROFILE);
    });

    // 真实输入助手自测：被遮挡、不可见、已禁用、不存在的元素都必须让 press 失败。
    await press('[data-task=t1]');
    await wait('!!document.querySelector("[data-stop]")');
    await evaluate('(() => { const shield = document.createElement("div"); shield.id = "__shield"; shield.style.cssText = "position:fixed;inset:0;z-index:99999;background:transparent"; document.body.append(shield); return true; })()');
    await verify('通用 真实输入自测：盖一层透明遮罩时，press「停止」报"被遮挡"', async () => {
        await assert.rejects(press('[data-stop]'), /被遮挡/);
    });
    await evaluate('document.getElementById("__shield").remove(); true');
    await verify('通用 真实输入自测：不可见、不存在的元素报错', async () => {
        assert.match(String((await hits('[data-plan-top]') as { error?: string }).error), /不可见/);
        await assert.rejects(press('[data-no-such-element]'), /找不到元素/);
    });
    await press('[data-more]');
    await verify('通用 真实输入自测：已禁用的菜单项（进行中不能隐藏）报"已禁用"', async () => { await assert.rejects(press(await menuItem('从列表隐藏')), /已禁用/); });
    await key('Escape');
    await check('通用 真实输入自测：Esc 关闭菜单', '!document.querySelector(".ctx")');

    // UI01 侧栏导航：鼠标与键盘都能切换，当前页高亮。
    for (const [page, ready] of [['connect', '!!document.querySelector("[data-host-card]")'], ['projects', '!!document.querySelector("[data-pj-row]")'], ['newtask', '!!document.querySelector("[data-nt-project]")'], ['settings', '!!document.querySelector("[data-pref=notifications]")'], ['about', '!!document.querySelector(".about")'], ['tasks', '!!document.querySelector("[data-task=t1]")']]) {
        await press(`[data-page=${page}]`);
        await wait(ready);
        await check(`UI01 点击侧栏「${page}」切换页面并高亮当前页`, `document.querySelector("[data-page=${page}]").getAttribute("aria-current")==="page" && document.querySelectorAll("[data-page][aria-current=page]").length===1`);
    }
    await tabTo('[data-page=settings]'); await focusRing('UI01 侧栏'); await key('Enter');
    await wait('!!document.querySelector("[data-pref=notifications]")');
    await check('UI01 键盘 Tab 到侧栏「设置」后按 Enter 切换页面', 'document.querySelector("[data-page=settings]").getAttribute("aria-current")==="page"');
    await tabTo('[data-page=tasks]'); await key('Enter');
    await wait('!!document.querySelector("[data-task=t1]")');
    await check('UI01 键盘回到任务页', 'document.querySelector("[data-page=tasks]").getAttribute("aria-current")==="page"');

    // UI03 详情：每种状态深浅两主题截图。
    // 任务 011：t3 的汇报正文换成演示数据里的 reportRich（表格、粗体、引用、分隔线、嵌套列表、任务列表、代码块）。
    await writeFile(registry.tasks.find(t => t.id === 't3')!.report, reportRich);
    for (const theme of ['dark', 'light'] as const) {
        nativeTheme.themeSource = theme;
        await pause();
        for (const [scene, id] of [['running', 't1'], ['completed', 't3'], ['failed', 't5'], ['interrupted', 't6']]) {
            await press(`[data-task=${id}]`);
            await wait(scene === 'completed' ? '!!document.querySelector(".md")' : '!!document.querySelector("[data-event]")');
            await check(`UI03 选中任务 ${id} 显示其详情（${theme}）`, `document.querySelector("[data-task=${id}]").classList.contains("on") && document.querySelector(".dh h2").textContent===document.querySelector("[data-task=${id}] .tm b").textContent`);
            if (scene === 'completed')
                await check('UI03 汇报 TODO/推断清单高亮，相邻间隔 8px（' + theme + '）', '(()=>{const blocks=document.querySelectorAll(".md .hl.brand");return blocks.length===2 && blocks[1].getBoundingClientRect().top-blocks[0].getBoundingClientRect().bottom===8;})()');
            // 任务 011：汇报 Markdown 排版（表格含对齐、粗体、引用、分隔线、嵌套列表、任务列表、带语言代码块、h2）。
            if (scene === 'completed') await check('UI03 汇报排版：表格对齐与表头单元格数正确（' + theme + '）', '(()=>{const tables=[...document.querySelectorAll(".tab-body .md .md-table table")],cell=(t,i)=>getComputedStyle(t.querySelectorAll("thead th")[i]).textAlign;return tables.length===2 && tables[0].querySelectorAll("thead th").length===3 && tables[1].querySelectorAll("thead th").length===5 && cell(tables[0],0)==="left" && cell(tables[0],1)==="center" && cell(tables[0],2)==="right";})()');
            if (scene === 'completed') await check('UI03 汇报排版：粗体、引用、分隔线、嵌套列表、任务列表、代码块与 h2（' + theme + '）', '(()=>{const md=document.querySelector(".tab-body .md");return !!md.querySelector(".md strong") && !!md.querySelector("blockquote") && !!md.querySelector("hr") && !!md.querySelector("ul ul") && !!md.querySelector("li.task") && !!md.querySelector("h2") && !!md.querySelector("pre.out") && !!md.querySelector("h3") && !!md.querySelector("h4") && !!md.querySelector("li.task .md-check.on");})()');
            if (scene === 'completed') await check('UI03 汇报排版：页面没有字面的 ** 与 |---（' + theme + '）', '(()=>{const text=document.querySelector(".dbody").innerText;return !text.includes("**") && !text.includes("|---");})()');
            if (scene === 'completed') await check('UI03 汇报宽表格只在 .md-table 里横向滚动，详情滚动区不横向溢出（' + theme + '）', '(()=>{const table=document.querySelectorAll(".tab-body .md .md-table")[1],box=document.querySelector(".dbody > .scroll");return table.scrollWidth>table.clientWidth && box.scrollWidth<=box.clientWidth;})()');
            if (scene === 'running') await check('UI03 托管任务标题标签（' + theme + '）', 'document.querySelector(".dh .tag")?.textContent==="托管"');
            if (scene === 'interrupted') await check('UI03 中断横幅去设置（' + theme + '）', '!!document.querySelector(".banner [data-managed-settings]")');
            // O8：失败横幅用执行者显示名（t5 是 DeepSeek 任务），不再统称 Codex。
            // 走查第 1 轮：详情状态行显示执行者显示名（不再显示"派活方 · 角色"，它们在悬停说明里）。
            if (scene === 'failed') await check('UI03 详情状态行同时显示"派活方 <派活方>"与"执行者 <执行者显示名>"，不靠悬停（' + theme + '）', 'document.querySelector("[data-executor-line]").textContent==="执行者"+document.querySelector("[data-task=t5] .xtag").title && document.querySelector("[data-dispatcher-line]").textContent==="派活方Claude Code" && !document.querySelector("[data-executor-line]").dataset.tip');
            if (scene === 'failed') await check('UI03 失败横幅标题用执行者显示名（' + theme + '）', 'document.querySelector(".banner .rt b").textContent===document.querySelector("[data-task=t5] .xtag").title+" 异常退出（exit=1）" && !document.querySelector(".banner").textContent.includes("Codex")');
            // 任务 011：时间线「说」用 Markdown 排版（改动方案里有粗体、嵌套列表与表格）。样例放在 t5 的演示事件里，
            // 不加长 t1 的时间线——t1 的「滚到底部时保持跟随」检查按原有内容高度写。
            if (scene === 'failed') await check('UI03 时间线说消息排版：粗体、嵌套列表与表格，没有字面的 **（' + theme + '）', '(()=>{const say=[...document.querySelectorAll(".tl .say")].find(x=>x.textContent.includes("改动方案"));if(!say)return false;const md=say.querySelector(".md");return !!md.querySelector("strong") && md.querySelectorAll("li").length>=4 && !!md.querySelector("ul ul") && !!md.querySelector("table") && !!md.querySelector("td") && !say.textContent.includes("**");})()');
            await save(`${scene}-${theme}`);
        }
    }
    nativeTheme.themeSource = 'dark';
    await press('[data-task=t4]');
    await check('UI03 v1 旧任务显示"旧任务"标签', 'document.querySelector(".dh [data-legacy]")?.textContent==="旧任务"');

    // UI11 最小窗口与 UI03 计划条、滚动（真实滚轮）。
    win.setContentSize(960, 600);
    await press('[data-task=t1]');
    await save('running-960x600');
    await check('UI11 最小窗口使用 288px 列表', 'Math.round(document.querySelector(".split > .edge").getBoundingClientRect().width) === 288');
    await wheel(scrollBox, -3000);
    await check('UI03 顶部保留完整计划，隐藏单行计划条', `document.querySelector("${scrollBox}").scrollTop===0 && !!document.querySelector(".plan") && document.querySelector("[data-plan-top]").hidden && getComputedStyle(document.querySelector(".plan-slot")).position !== "sticky"`);
    await wheel(scrollBox, 200);
    await save('running-scrolled-960x600');
    await check('UI03 滚轮向下后出现 36px 计划条，贴合滚动区且没有重复分隔线', `(()=>{const bar=document.querySelector("[data-plan-top]"),box=document.querySelector("${scrollBox}"),r=bar.getBoundingClientRect(),v=box.getBoundingClientRect();return box.scrollTop>0 && !bar.hidden && r.height===36 && r.top===v.top && r.left===v.left && r.right===v.right && getComputedStyle(document.querySelector(".dbody"),"::before").display==="none" && bar.querySelector("progress").getBoundingClientRect().width<=160 && bar.textContent.includes("当前：堆叠合并与上限 99");})()`);
    await check('UI03 浮动滑块位于计划条下方', '[...document.querySelectorAll(".sc-thumb.show")].some(t=>!t.hidden && t.getBoundingClientRect().top>=document.querySelector("[data-plan-top]").getBoundingClientRect().bottom && t.getBoundingClientRect().right>document.querySelector(".dbody").getBoundingClientRect().left)');
    await press('[data-plan-top]');
    // 计划条在滚动事件里隐藏，比滚动位置晚一帧；两个条件都成立才算回到顶部。
    await wait(`document.querySelector("${scrollBox}").scrollTop===0 && document.querySelector("[data-plan-top]").hidden`, 'UI03 点击计划条回到顶部');
    await check('UI03 点击计划条回到顶部', `document.querySelector("${scrollBox}").scrollTop===0 && document.querySelector("[data-plan-top]").hidden`);
    win.webContents.debugger.attach('1.3');
    try {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await wheel(scrollBox, 200);
        await wait('!document.querySelector("[data-plan-top]").hidden');
        await press('[data-plan-top]');
        await check('UI03 减少动态效果时点击计划条立即回顶', `matchMedia("(prefers-reduced-motion: reduce)").matches && document.querySelector("${scrollBox}").scrollTop===0`);
    }
    finally {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
        win.webContents.debugger.detach();
    }
    await press('[data-task=t10]');
    await wait('!!document.querySelector("[data-event]")');
    await save('stopped-by-app');
    await check('UI03 手动停止使用专用列表说明和横幅', 'document.querySelector("[data-task=t10] .tm").textContent.includes("手动停止") && document.querySelector(".banner .rt b").textContent==="你停止了这个任务" && document.querySelector(".banner .rt span").textContent==="工作区里没提交的改动还在。要继续，点\\"再派一次\\"，或在派活方的会话里重新派发。"');
    await check('UI03 没有计划时不显示计划框和计划条', '!document.querySelector(".plan") && document.querySelector("[data-plan-top]").hidden');
    await appendFile(registry.file, '\n' + JSON.stringify({ v: 1, event: 'interrupted', id: 't10', signal: 'stopped-by-command', at: Date.now() }) + '\n');
    await registry.refresh();
    await wait('document.querySelector(".banner .rt b")?.textContent==="派活方停止了这个任务"');
    await check('UI03 命令停止使用专用列表说明和横幅且不显示去设置', 'document.querySelector("[data-task=t10] .tm").textContent.includes("派活方停止") && document.querySelector(".banner .rt span").textContent==="工作区里没提交的改动还在。要继续，点\\"再派一次\\"，或在派活方的会话里重新派发。" && !document.querySelector(".banner [data-managed-settings]")');
    await save('stopped-by-command');

    // UI03 时间线：展开命令、滚动、后台刷新保留状态、跟随最新、思考开关、标签切换。
    win.setContentSize(1160, 720);
    await press('[data-task=t1]');
    await wheel(scrollBox, -3000);
    const command = await evaluate('[...document.querySelectorAll("[data-cmd]")].find(b=>b.textContent.includes("npm test"))?.dataset.cmd');
    await press(`[data-cmd="${command}"]`);
    await check('UI03 点击命令展开输出', '!!document.querySelector(".out")');
    await wheel(scrollBox, 80);
    const wheelAt = clock();
    await save('progress-scrolled');
    // 诊断（PR #5 CI）：这条检查当下不成立时，打印从滚轮输入到检查的用时（截图也算在内；滑块停止滚动 800 ms 后淡出）、
    // 滚动位置与尺寸、计划块与滚动区的位置、每个浮动滑块的类名与可见性。只打印，判断不变。
    try { await check('UI03 完整计划随内容滚动，浮动滑块出现', `document.querySelector(".plan-slot").getBoundingClientRect().top < document.querySelector("${scrollBox}").getBoundingClientRect().top && [...document.querySelectorAll(".sc-thumb.show")].some(t=>!t.hidden)`); }
    catch (error) {
        const state = await evaluate(`JSON.stringify((() => { const v = document.querySelector("${scrollBox}"), slot = document.querySelector(".plan-slot"); return { scrollTop: v.scrollTop, scrollHeight: v.scrollHeight, clientHeight: v.clientHeight, boxTop: Math.round(v.getBoundingClientRect().top), slotTop: slot ? Math.round(slot.getBoundingClientRect().top) : null, hoverBox: v.matches(":hover"), thumbs: [...document.querySelectorAll(".sc-thumb")].map(t => t.className + (t.hidden ? " hidden" : "") + " opacity=" + getComputedStyle(t).opacity) }; })())`);
        console.log(`UI03 浮动滑块诊断：滚轮输入到检查 ${Math.round(clock() - wheelAt)} ms；${state}`);
        throw error;
    }
    await check('UI03 滚到底部时保持跟随，不显示"跳到最新"', `(()=>{const v=document.querySelector("${scrollBox}");return v.scrollHeight-v.clientHeight-v.scrollTop<32 && document.querySelector("[data-latest]").hidden;})()`);
    await wheel(scrollBox, -3000);
    await check('UI03 滚轮向上离开底部后暂停跟随，出现"跳到最新"', '!document.querySelector("[data-latest]").hidden');
    // Tab 经过时间线时浏览器会把焦点元素滚进视野，所以从键盘到达"思考"开关之后再记录滚动位置。
    await tabTo('[data-think]');
    await focusRing('UI03 思考开关');
    const position = await evaluate(`document.querySelector("${scrollBox}").scrollTop`);
    await pause(1300);
    await check('UI03 后台刷新保留焦点、展开输出与滚动位置', `document.activeElement.hasAttribute('data-think') && !!document.querySelector('.out') && Math.abs(document.querySelector('${scrollBox}').scrollTop - ${position}) < 1`);
    await wheel(scrollBox, -3000);
    await check('UI03 再次向上滚动暂停跟随', '!document.querySelector("[data-latest]").hidden');
    await press('[data-latest]');
    await check('UI03 点击"跳到最新"恢复跟随', 'document.querySelector("[data-latest]").hidden');
    await tabTo('[data-think]'); await key('Space');
    await check('UI03 键盘空格切换思考显示', '!!document.querySelector(".k-think") && document.querySelector("[data-think]").getAttribute("aria-checked")==="true"');
    await press('[data-think]');
    await check('UI03 再点一次隐藏思考（默认隐藏）', '!document.querySelector(".k-think")');
    await press('[data-tab=files]');
    await check('UI03 切到改动标签：文件汇总保留最终改动', 'document.querySelectorAll(".tab-body .r").length === 4');
    await press('[data-tab=params]');
    await check('UI03 切到参数标签：托管参数显示是', '[...document.querySelectorAll(".rows .r")].some(r=>r.querySelector(".k")?.textContent==="托管" && r.querySelector(".v")?.textContent==="是")');
    await check('UI03 参数显示统一事件与原始输出的打开按钮', '!!document.querySelector("[data-open=events]") && !!document.querySelector("[data-open=raw]")');
    await check('UI03 Codex 任务参数页：执行者 Codex，有推理强度与档位', '[...document.querySelectorAll(".rows .r")].find(r=>r.querySelector(".k")?.textContent==="执行者")?.querySelector(".v")?.textContent==="Codex（codex）" && [...document.querySelectorAll(".rows .r")].some(r=>r.querySelector(".k")?.textContent==="推理强度") && [...document.querySelectorAll(".rows .r")].some(r=>r.querySelector(".k")?.textContent==="档位")');
    // DeepSeek 任务（演示数据 t8）：参数页显示执行者名称、profile、适配器与实际模型；Codex 才有的推理强度、档位、沙箱不显示。
    await press('[data-task=t8]'); await press('[data-tab=params]');
    await check('UI03 选中 DeepSeek 任务后参数页显示执行者与模型 deepseek-v4-pro', '[...document.querySelectorAll(".rows .r")].find(r=>r.querySelector(".k")?.textContent==="执行者")?.querySelector(".v")?.textContent==="DeepSeek V4 Pro（deepseek · claude-code）" && [...document.querySelectorAll(".rows .r")].find(r=>r.querySelector(".k")?.textContent==="模型")?.querySelector(".v")?.textContent==="deepseek-v4-pro" && [...document.querySelectorAll(".rows .r")].find(r=>r.querySelector(".k")?.textContent==="干活方")?.querySelector(".v")?.textContent==="2.1.302 (Claude Code)"');
    await check('UI03 非 Codex 任务不显示推理强度、档位与沙箱', '![...document.querySelectorAll(".rows .r")].some(r=>r.querySelector(".k")?.textContent==="推理强度") && ![...document.querySelectorAll(".rows .r")].some(r=>r.querySelector(".k")?.textContent==="档位") && ![...document.querySelectorAll(".rows .r")].some(r=>r.querySelector(".k")?.textContent==="沙箱")');
    await save('params-deepseek');
    await press('[data-task=t1]');
    await press('[data-tab=flow]');

    // UI04 停止确认：默认焦点在取消，取消与 Esc 都不写入中断。焦点环只在键盘操作时出现，所以这里用键盘打开确认框。
    await tabTo('[data-stop]'); await key('Enter');
    await check('UI04 停止确认默认焦点在取消，背景不可操作', 'document.activeElement.textContent === "取消" && document.querySelector("#app").inert');
    await check('UI04 停止确认说明用执行者显示名', 'document.querySelector(".confirm-card p").textContent===document.querySelector("[data-task=t1] .xtag").title+" 会立刻结束，工作区里没提交的改动会保留。"');
    await focusRing('UI04 确认框取消按钮');
    await press('.confirm-actions .btn');
    await check('UI04 点取消不写入中断，任务仍在进行', '!!document.querySelector("[data-stop]") && !document.querySelector(".confirm-overlay")');
    await press('[data-stop]'); await key('Escape');
    await wait('!document.querySelector(".confirm-overlay")');
    await check('UI04 Esc 关闭确认框，任务仍在进行', '!!document.querySelector("[data-stop]")');

    // UI05 更多菜单：进行中不能隐藏；键盘可操作；各项真实触发。
    await press('[data-more]');
    await check('UI05 菜单打开后焦点在菜单里', '!!document.activeElement.closest(".ctx")');
    await key('ArrowDown');
    await check('UI05 方向键在菜单项之间移动', '!!document.activeElement.closest(".ctx")');
    await key('Escape');
    await check('UI05 Esc 关闭菜单', '!document.querySelector(".ctx")');
    // 进行中的任务还没有汇报文件：菜单项禁用并写明"汇报尚未生成"，点击不会触发打开。
    await press('[data-more]');
    const pending = await menuItem('打开汇报文件（汇报尚未生成）');
    await check('UI05 汇报未生成时「打开汇报文件」禁用并写明原因', `document.querySelector(${JSON.stringify(pending)}).disabled`);
    await verify('UI05 禁用的「打开汇报文件」点不动（命中测试报已禁用）', async () => {
        const opened = effects.opened.length;
        await assert.rejects(press(pending), /已禁用/);
        assert.equal(effects.opened.length, opened);
    });
    await key('Escape');
    await ui05Opens(0);
    const t3 = registry.tasks.find(t => t.id === 't3')!;
    // 菜单打开之后汇报文件被删：后端打开前再查一次，提示具体原因而不是"请重试"，也不调用打开。
    await press('[data-more]');
    const reportItem = await menuItem('打开汇报文件');
    await rename(t3.report, t3.report + '.moved');
    try {
        const opened = effects.opened.length;
        await press(reportItem);
        await wait('document.querySelector(".notice")?.textContent === "汇报尚未生成或文件已不存在"', 'UI05 汇报文件已不存在时提示具体原因');
        await verify('UI05 汇报文件已不存在时提示具体原因，不调用打开', () => { assert.equal(effects.opened.length, opened); });
    } finally { await rename(t3.report + '.moved', t3.report); }

    // UI02 列表：分组、项目下拉、筛选。
    await check('UI02 列表按进行中、今天、昨天分组，进行中在最上', '(()=>{const g=[...document.querySelectorAll(".tgroup")].map(x=>x.firstChild.textContent.trim());return g[0]==="进行中" && g.includes("今天") && g.includes("昨天");})()');
    await check('UI02 列表行显示执行者标签：DeepSeek 任务为 DS、Codex 任务为 CO，等宽 10px，悬停显示全名', '(()=>{const ds=document.querySelector("[data-task=t8] .xtag"),co=document.querySelector("[data-task=t3] .xtag");return ds?.textContent==="DS" && co?.textContent==="CO" && getComputedStyle(ds).fontSize==="10px" && ds.title==="DeepSeek V4 Pro" && document.querySelectorAll("[data-task] .xtag").length===document.querySelectorAll("[data-task]").length;})()');
    await press('[data-project]');
    await check('UI02 自制项目下拉', '!!document.querySelector("[role=listbox]") && !document.querySelector("select")');
    await press('.ctx button:nth-child(2)');
    await check('UI02 选择项目后列表只显示该项目', 'document.querySelectorAll("[data-task]").length === 5');
    await press('[data-project]');
    await press('.ctx button');
    // 015：演示数据加了软件派发的任务 t13，全量任务从 12 条变 13 条（原检查 12，见汇报"改写的检查"）。
    await check('UI02 选回全部项目', 'document.querySelectorAll("[data-task]").length === 13');
    // 任务 011：再派一次的任务（记录名 -2）在列表里带「第 N 次」标签，原任务不带。
    await check('UI03 列表再派一次带「第 2 次」标签，原任务不带，标题都是任务名', '(()=>{const again=document.querySelector("[data-task=t12] .tm b"),first=document.querySelector("[data-task=t11] .tm b");return again.querySelector(".tag")?.textContent==="第 2 次" && again.querySelector(".tag").title==="记录名：004-批量归档-2" && again.querySelector(".ttl")?.textContent==="004-批量归档" && !first.querySelector(".tag") && first.querySelector(".ttl")?.textContent==="004-批量归档";})()');
    await press('[data-task=t12]');
    await check('UI03 详情再派一次带「第 2 次」标签，标题与列表一致', '(()=>{const h=document.querySelector(".dh h2"),row=document.querySelector("[data-task=t12] .tm b");return h.textContent===row.textContent && h.querySelector(".tag")?.textContent==="第 2 次" && h.querySelector(".ttl")?.textContent==="004-批量归档";})()');
    await save('attempt-tag');
    // 015：演示数据里软件派发的任务（t13）详情状态行显示 AgentRouter（软件），与 UI03 同样的文本拼接方式。
    await press('[data-task=t13]');
    await check('UI03 软件派发的演示任务详情状态行显示"派活方AgentRouter（软件）"', 'document.querySelector("[data-dispatcher-line]").textContent==="派活方AgentRouter（软件）"');
    await press('[data-filter=issues]');
    await check('UI02 失败或中断筛选生效', 'document.querySelectorAll("[data-task]").length === 3');
    await press('[data-filter=run]');
    await check('UI02 进行中筛选生效', 'document.querySelectorAll("[data-task]").length === 2');
    await press('[data-filter=all]');

    // UI02 批量选择与删除（017）：只操作演示的临时仓库；记录目录的真实删除也在这里验收。
    const delT7 = registry.tasks.find(t => t.id === 't7')!, delT11 = registry.tasks.find(t => t.id === 't11')!, delT12 = registry.tasks.find(t => t.id === 't12')!;
    const recordDir = (t: typeof delT7) => path.join(t.repo, '.agent-runs', t.name);
    await verify('UI02 演示数据的任务记录目录在删除前存在', () => {
        for (const t of [delT7, delT11, delT12]) assert.ok(existsSync(recordDir(t)), recordDir(t));
    });
    await press('[data-multi=select]');
    await check('UI02 选择模式：每行换成复选框，进行中的行禁用并说明原因，没选时删除禁用', `(() => {
        const rows = [...document.querySelectorAll('[data-task]')], run = document.querySelector('[data-task=t1]');
        return rows.length === 13 && rows.every(r => r.getAttribute('role') === 'checkbox' && r.querySelector('.cb') && !r.querySelector('.mk'))
            && run.disabled && run.getAttribute('aria-disabled') === 'true' && run.dataset.tip === '进行中的任务不能删除'
            && rows.filter(r => !r.disabled).length === 11 && document.querySelector('[data-multi=delete]').disabled;
    })()`);
    await verify('UI02 进行中的复选框真实点击报“已禁用”', async () => { await assert.rejects(press('[data-task=t1]'), /已禁用/); });
    await tabTo('[data-task=t7]'); await focusRing('UI02 选择模式复选框'); await key('Space');
    await check('UI02 键盘空格勾选：复选框、计数与删除按钮同步', `document.activeElement.dataset.task === 't7'
        && document.querySelector('[data-task=t7]').getAttribute('aria-checked') === 'true' && !!document.querySelector('[data-task=t7] .cb.on')
        && document.querySelector('.page-h h1').textContent === '已选 1 个' && !document.querySelector('[data-multi=delete]').disabled`);
    await press('[data-task=t11]');
    await check('UI02 鼠标点行勾选第二条，计数照实，不切换详情', `document.querySelector('[data-task=t11]').getAttribute('aria-checked') === 'true'
        && document.querySelector('.page-h h1').textContent === '已选 2 个' && document.querySelector('.detail .empty b')?.textContent === '选择一个任务'`);
    nativeTheme.themeSource = 'dark'; await save('multi-select-dark');
    nativeTheme.themeSource = 'light'; await save('multi-select-light'); nativeTheme.themeSource = 'dark';
    await press('[data-multi=all]');
    await check('UI02 全选已结束的：只勾当前筛选下可见的已结束任务，按钮变取消全选', `(() => {
        const rows = [...document.querySelectorAll('[data-task]')];
        return rows.filter(r => !r.disabled).every(r => r.getAttribute('aria-checked') === 'true')
            && rows.filter(r => r.disabled).every(r => r.getAttribute('aria-checked') === 'false')
            && document.querySelector('[data-multi=all]').textContent === '取消全选' && document.querySelector('.page-h h1').textContent === '已选 11 个';
    })()`);
    await press('[data-multi=all]');
    await check('UI02 再按一次取消全选', `document.querySelector('.page-h h1').textContent === '已选 0 个'
        && [...document.querySelectorAll('[data-task]')].every(r => r.getAttribute('aria-checked') === 'false')
        && document.querySelector('[data-multi=all]').textContent === '全选已结束的' && document.querySelector('[data-multi=delete]').disabled`);
    await key('Escape');
    await check('UI02 Esc 退出选择模式，行恢复状态标记', 'document.querySelector(".page-h h1").textContent === "任务" && !!document.querySelector("[data-multi=select]") && !document.querySelector(".trow[role=checkbox]") && !!document.querySelector("[data-task=t7] .mk")');

    // 不勾删除记录文件：任务从列表消失，临时仓库里的记录目录都还在。
    await press('[data-multi=select]');
    await press('[data-task=t7]'); await press('[data-task=t11]');
    await press('[data-multi=delete]');
    await check('UI02 删除确认框：标题数量、复选项默认不勾、删除危险样式、默认焦点在取消', `document.querySelector('.sheet-h > b').textContent === '删除 2 个任务？'
        && document.querySelector('[data-delete-files]').getAttribute('aria-checked') === 'false'
        && document.querySelector('.sheet-btns .btn.danger').textContent === '删除'
        && document.activeElement.textContent === '取消' && document.querySelector('#app').inert`);
    nativeTheme.themeSource = 'dark'; await save('delete-confirm-dark');
    nativeTheme.themeSource = 'light'; await save('delete-confirm-light'); nativeTheme.themeSource = 'dark';
    await press('.sheet-btns .btn.danger');
    await wait('!document.querySelector("[data-task=t7]") && !document.querySelector("[data-task=t11]")', 'UI02 不删文件时两条任务从列表消失');
    await wait('document.querySelector(".notice")?.textContent === "已删除 2 个任务"', 'UI02 删除成功提示');
    await check('UI02 删除成功后退出选择模式并回到普通标题行', 'document.querySelector(".page-h h1").textContent === "任务" && !!document.querySelector("[data-multi=select]") && !document.querySelector("[data-multi=done]")');
    await verify('UI02 不勾删除记录文件时目录都还在，tasks.json 写入 hidden，runs.jsonl 不改', async () => {
        for (const t of [delT7, delT11]) assert.ok(existsSync(recordDir(t)), recordDir(t));
        const saved = JSON.parse(await readFile(path.join(registry.data, 'tasks.json'), 'utf8'));
        assert.ok(saved.hidden.some((k: string) => k.startsWith('t7:')) && saved.hidden.some((k: string) => k.startsWith('t11:')));
        assert.ok((await runs()).some(r => r.id === 't7' && r.event === 'start') && (await runs()).some(r => r.id === 't11' && r.event === 'start'), 'runs.jsonl 不改');
    });

    // 勾上删除记录文件：只删这条任务的目录；先选中它，删除后详情回到空状态。
    await press('[data-task=t12]');
    await press('[data-multi=select]');
    await press('[data-task=t12]');
    await press('[data-multi=delete]');
    await press('[data-delete-files]');
    await check('UI02 勾选“同时删除任务记录文件”后复选项点亮', 'document.querySelector("[data-delete-files]").getAttribute("aria-checked")==="true" && !!document.querySelector("[data-delete-files] .cb.on")');
    await press('.sheet-btns .btn.danger');
    await wait('!document.querySelector("[data-task=t12]")', 'UI02 勾选删除文件后任务从列表消失');
    await wait('document.querySelector(".notice")?.textContent === "已删除 1 个任务"', 'UI02 删除一条的提示');
    await verify('UI02 勾选删除记录文件时只删该任务的目录，同仓库其他目录与仓库文件还在', async () => {
        assert.equal(existsSync(recordDir(delT12)), false, '目标任务目录应已删除');
        assert.ok(existsSync(path.join(delT12.repo, '.agent-runs')), '.agent-runs 本身不能删');
        assert.ok(existsSync(recordDir(delT11)), '同仓库其他任务的目录还在');
        assert.ok(existsSync(delT12.repo), '仓库目录还在');
    });
    await check('UI02 删除当前选中的任务后详情回到空状态', 'document.querySelector(".detail .empty b")?.textContent === "选择一个任务"');

    // UI05 从列表隐藏（已结束的任务）：真实写入 tasks.json。
    await press('[data-task=t9]'); await press('[data-more]'); await press(await menuItem('从列表隐藏'));
    await wait('!document.querySelector("[data-task=t9]")');
    await verify('UI05 菜单「从列表隐藏」：任务从列表消失并写入 tasks.json', async () => {
        const saved = JSON.parse(await readFile(path.join(registry.data, 'tasks.json'), 'utf8'));
        assert.ok(saved.hidden.some((k: string) => k.startsWith('t9:')));
    });

    // UI04 确认后真实停止：假派发进程树结束、清单写 interrupted、列表变中断。
    const t2 = registry.tasks.find(t => t.id === 't2')!;
    await press('[data-task=t2]'); await press('[data-stop]');
    const stopStarted = Date.now();
    await press('.confirm-actions .danger');
    // 停止要先用 PowerShell 核对进程再结束进程树，冷启动的 CI 机器上可能超过 10 秒，这里单独给 30 秒并打印实际用时。
    await wait('document.querySelector("[data-task=t2] .mk")?.classList.contains("stale")', 'UI04 停止后列表标记变为中断', 30000);
    console.log(`UI04 停止用时：${Date.now() - stopStarted}ms`);
    await verify('UI04 确认停止后进程树真的结束，清单写入 interrupted（stopped-by-app）', async () => {
        assert.deepEqual(await registry.platform.processes([t2.pid]), []);
        assert.ok((await runs()).some(r => r.id === 't2' && r.event === 'interrupted' && r.signal === 'stopped-by-app'));
    });
    await check('UI04 停止后列表与详情显示中断', 'document.querySelector("[data-task=t2] .mk").classList.contains("stale") && !document.querySelector("[data-stop]") && document.querySelector(".banner .rt b").textContent==="你停止了这个任务"');

    // UI21（W4）：t1 仍在进行（真实的假派发进程），在这里注入进程查询失败再恢复；结束后 t1 状态不变，后面的检查照常使用。
    await captureProcessUnknown(h, registry, save, menuItem, runs);
    const fontLoaded = await capturePreferences(h);
    // UI19：关闭询问、托盘与"窗口"设置。此时 t1 还在进行，正好检查重置在有任务时禁用确认。
    await captureCloseAndTray(h, win, save);
    // UI16 新建任务页放在设置验收之后：要临时改 config.json 的执行者配置（假执行者），避免影响设置页断言。
    await captureNewtask(h);
    // UI17 再派一次沿用新建任务页留下的临时仓库与假执行者配置。
    await captureRedispatch(h, saveNow, pressNow, registry, win);

    // 每页通用检查与 UI11：深浅两主题 × 1160×720 / 960×600。
    await audit('任务页', async () => { await press('[data-page=tasks]'); await press('[data-task=t3]'); });
    // 项目页加载：从点侧栏"项目"之前算起（含点击后固定 300 ms），到列表行与详情标题都出现；上限 10 秒，即原验收标准（默认等待上限）。
    // b5f2e71 曾放宽到 30 秒，按"原验收标准保持不变"恢复；用时按单调时钟计。
    // 每次都打印这段时间里的核心调用与核心进程各阶段，慢的那次能看出卡在哪个调用、哪个进程的哪一步。
    await audit('项目页', async () => { const started = clock(), ipcFrom = ipcSeq(), coreFrom = coreSeq(); await press('[data-page=projects]'); await wait('!!document.querySelector("[data-pj-row]") && !!document.querySelector("[data-pj-detail] .dh")', '项目页列表与详情'); console.log(`项目页加载用时：${Math.round(clock() - started)}ms；核心调用：${ipcReport(ipcFrom)}；核心进程：${coreReport(coreFrom)}`); });
    await audit('Agent 页', async () => { await press('[data-page=connect]'); await wait('!!document.querySelector("[data-host-card]") && !document.querySelector("[data-pref=detect]").disabled'); });
    await audit('设置页', async () => { await press('[data-page=settings]'); await wait('!!document.querySelector("[data-pref=notifications]")'); });
    await audit('关于页', async () => { await press('[data-page=about]'); await wait('!!document.querySelector(".about")'); });

    // UI03 大量事件：虚拟列表与计划。
    await press('[data-page=tasks]');
    await press('[data-task=t1]');
    const eventFile = registry.tasks.find(t => t.id === 't1')!.events!, originalEvents = await readFile(eventFile);
    try {
        await appendFile(eventFile, Array.from({ length: 650 }, (_, i) => JSON.stringify({ v: 1, seq: 1000 + i, at: Date.now() + i, kind: 'say', text: `演示进展 ${i}` })).join('\n') + '\n');
        await wait('document.querySelector(".events-host").textContent.includes("演示进展 649")');
        await check('UI03 超过 500 条事件启用虚拟列表', 'document.querySelectorAll("[data-event]").length < 300');
        await wheel(scrollBox, -100000);
        await wait('document.querySelector(".events-host").textContent.includes("AGENTS.md")', 'UI03 虚拟列表滚回较早事件');
        await check('UI03 虚拟列表可用滚轮回到较早事件', 'document.querySelector(".events-host").textContent.includes("AGENTS.md")');
        await appendFile(eventFile, JSON.stringify({ v: 1, seq: 1650, at: Date.now(), kind: 'plan', items: [{ text: '全部完成', done: true }] }) + '\n');
        await wait('document.querySelector(".plan-h .mono")?.textContent==="1/1"');
        await wheel(scrollBox, 200);
        await wait('!document.querySelector("[data-plan-top]").hidden');
        await check('UI03 计划全部完成时没有当前项', '!document.querySelector("[data-plan-top] .plan-now") && document.querySelector("[data-plan-top] .mono").textContent==="1/1"');
    }
    finally {
        await writeFile(eventFile, originalEvents);
    }
    // UI12 系统通知（t1 在这里结束，所以放在需要 t1 进行中的检查之后）：任务结束发一条，点开后选中该任务。
    await press('[data-page=tasks]');
    await press('[data-task=t3]');
    const before = effects.notices.length;
    await appendFile(registry.file, '\n' + JSON.stringify({ v: 1, event: 'end', id: 't1', exit: 0, at: Date.now(), minutes: 1 }) + '\n');
    await registry.refresh();
    await verify('UI12 任务结束发一条系统通知（标题为状态与名称）', () => {
        assert.equal(effects.notices.length, before + 1);
        assert.equal(effects.notices.at(-1)!.title, '已完成：012-背包拖拽与堆叠');
    });
    effects.notices.at(-1)!.click();
    await wait('document.querySelector("[data-task=t1]")?.classList.contains("on")', 'UI12 点开通知选中该任务');
    await check('UI12 点开通知选中该任务并显示其详情', 'document.querySelector(".dh h2").textContent==="012-背包拖拽与堆叠"');

    // UI20：设置页"数据"一节、清除缓存；重置的确认框在无任务时完整显示（真正的重置在第二次启动时执行）。
    await captureDataAndReset(h, win, save);
    // 设置页验收结束时停在设置页；后面的 UI02 空状态检查针对任务页，先回到任务页（保持 012 之前的页面状态）。
    await press('[data-page=tasks]');
    await wait('!!document.querySelector("[data-task]")');

    // UI02 空状态：由隔离清单驱动，结束演示后恢复文件供复用。
    const original = await readFile(registry.file);
    await writeFile(registry.file, '');
    await registry.refresh();
    await wait('!document.querySelector("[data-task]")');
    await check('UI02 空状态使用列表图标和均衡换行', '!!document.querySelector(".detail .ri-file-list-3-line") && [...document.querySelectorAll(".empty p")].length===2 && [...document.querySelectorAll(".empty p")].every(p=>getComputedStyle(p).textWrap==="balance" && getComputedStyle(p).maxWidth==="280px")');
    try {
        for (const theme of ['dark', 'light'] as const) {
            nativeTheme.themeSource = theme;
            await save('empty-' + theme);
        }
    }
    finally {
        await writeFile(registry.file, original);
    }
    // UI20 设置页"列表"一节（018）：清空任务列表与清空项目列表。清空是真删列表状态，
    // 检查完把夹具恢复回去（见 captureLists 尾部），后面的退出检查继续用演示数据。
    await captureLists(h, registry, save);
    await verify('通用 全程渲染进程没有控制台错误', () => { assert.deepEqual(h.consoleErrors, []); });
    await writeFile(path.join(out, 'checks.json'), JSON.stringify({ screenshots, fontLoaded, checks }, null, 2));
    const ui = [...new Set(checks.map(c => c.match(/^UI\d\d/)?.[0]).filter(Boolean))].sort();
    // UI19 = 关闭询问与托盘（012 A），UI20 = 设置页"数据"一节与清除缓存 / 重置确认框（012 B）。
    // 原 UI10 / UI11 已分别是"主题"与"最小窗口"，所以新增要求改用 UI19、UI20（见汇报）。
    assert.deepEqual(ui, ['UI01', 'UI02', 'UI03', 'UI04', 'UI05', 'UI06', 'UI07', 'UI08', 'UI09', 'UI10', 'UI11', 'UI12', 'UI13', 'UI14', 'UI15', 'UI16', 'UI17', 'UI18', 'UI19', 'UI20', 'UI21'], '界面功能基线 UI01～UI21 都要有检查');
    console.log(`Generated ${screenshots} screenshots; ${checks.length} UI checks passed（${ui.join(' ')}）.`);
    // 退出前准备两个任务：先准备技能派发、由本进程认领的托管任务（认领之后配置不再影响它），
    // 再准备「再派一次」派出的脱离任务，所以两者需要的 config.json 可以先后写入、互不干扰。
    // 外部启动器在 Electron 退出后分别核对两个任务继续运行并正常结束。
    const exitTasks = [await prepareManagedExit(registry), await prepareRedispatchExit(h, registry)];
    const pendingAt = Date.now();
    await writeFile(path.join(out, 'exit-pending.json'), JSON.stringify(exitTasks.map(t => ({ ...t, pendingAt }))));
    // 确定性专项验证（AR_SHOTS_EXPERIMENT=exit-delay；不是正式回归）：写出待查后延迟一段时间再退出，
    // 验证托管任务与脱离任务（024 起两者的假执行者都等放行才结束）在软件退出后仍存活；旧实现约 5 / 8 秒就自己结束。
    // 延迟默认 4000 ms，可用 AR_SHOTS_EXIT_DELAY_MS 指定（例如 9000 ms：超过脱离任务原来约 8 秒的寿命）。
    if ((process.env.AR_SHOTS_EXPERIMENT ?? '').split(',').includes('exit-delay')) {
        const exitDelayMs = Number(process.env.AR_SHOTS_EXIT_DELAY_MS) > 0 ? Number(process.env.AR_SHOTS_EXIT_DELAY_MS) : 4000;
        console.log(`实验 exit-delay：写出待查后延迟 ${exitDelayMs} ms 再退出`);
        await new Promise(resolve => setTimeout(resolve, exitDelayMs));
    }
}

// 再派一次用的临时仓库由新建任务页准备；源任务与记录名固定，便于退出前再派一次。
const redispatchRepo = () => path.join(appEnv.AGENT_ROUTER_HOME!, 'shots-newtask', 'sample');
const REDISPATCH_SOURCE = 'redispatch-source';
// 假执行者配置：delayMs 是每条事件的间隔，也是任务持续时间的来源。
// releaseFile（只用于退出前再派一次的检查）让假执行者回放完事件后等放行文件，不会在软件退出前自己结束。
function redispatchConfig(delayMs: number, releaseFile?: string) {
    return {
        v: 2, defaultProfile: 'fake', managed: false, watchWindow: 'never', profiles: {
            fake: {
                adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'say', text: '再派一次：假执行者正在运行。' }],
                report: '再派一次完成\n', exit: 0, delayMs, version: 'fake-agent 1.0',
                ...(releaseFile ? { releaseFile } : {}),
            },
        },
    };
}
const readRows = async (registry: Registry) => (await readFile(registry.file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
async function untilRow<T>(fn: () => Promise<T | undefined | null>, label: string, timeoutMs = 20000): Promise<T> {
    let value: T | undefined | null;
    if ((await pollUntil(async () => (value = await fn()), timeoutMs)).ok) return value as T;
    throw Error(`等待超时：${label}（${timeoutMs} ms）`);
}

// UI17：已结束任务显示次要按钮「再派一次」，点击后按 dispatch.json 的参数派发并选中新任务；
// 用实时按键抓忙碌态截图，成功后也验证新记录的 start 与 dispatch.json。
// UI17"再派一次失败"的完整时间线（PR #5 CI）：点击前选中的任务与预期失败原因、渲染层事件（点击 / 发出 / 错误 / 横幅渲染）、
// 主进程收到的 tasks:redispatch、核心进程各阶段，以及此刻失败横幅是否存在、是否可见。时刻都相对点击那一下。
type Ui17Mark = { clickAt: number; ipcFrom: number; coreFrom: number; task: string; project: string; executor: string };
async function ui17Mark(h: Harness, registry: Registry): Promise<Ui17Mark> {
    const id = await h.evaluate('document.querySelector(".trow.on")?.dataset.task ?? null') as string;
    const t = registry.tasks.find(x => x.id === id);
    await h.evaluate('document.documentElement.dataset.arTrace = "1"; window.__arTrace = []');
    return { clickAt: Date.now(), ipcFrom: ipcSeq(), coreFrom: coreSeq(), task: id, project: t ? path.basename(t.repo) : '（找不到）', executor: t ? String(t.label ?? t.adapter ?? t.profile ?? '未知') : '未知' };
}
async function ui17Timeline(h: Harness, m: Ui17Mark, tag = '') {
    const events = JSON.parse(await h.evaluate('JSON.stringify(window.__arTrace ?? [])')) as { at: number; event: string; [k: string]: unknown }[];
    const renderer = events.filter(e => e.at >= m.clickAt - 50 && (String(e.event).startsWith('redispatch') || e.event === 'header'))
        .map(e => `${e.event}${e.error ? '：' + String(e.error).slice(0, 30) : ''}${e.banner !== undefined ? ' banner=' + e.banner : ''}${e.busy !== undefined ? ' busy=' + e.busy : ''}${e.willRender !== undefined ? ' willRender=' + e.willRender : ''} +${e.at - m.clickAt}ms`).join('，') || '无';
    const main = effects.ipcLog.filter(e => e.seq > m.ipcFrom && e.name === 'tasks:redispatch')
        .map(e => `收到 +${e.start - m.clickAt}ms，${e.end === undefined ? '未返回' : `返回 +${e.end - m.clickAt}ms ${e.ok ? '成功' : '失败：' + String(e.error).slice(0, 30)}`}`).join('；') || '没有收到';
    const core = coreReport(m.coreFrom);
    const banner = await h.evaluate(`JSON.stringify([...document.querySelectorAll('.banner.fail')].map(b => { const r = b.getBoundingClientRect(); return (b.textContent || '').trim().slice(0, 30) + '（' + Math.round(r.width) + '×' + Math.round(r.height) + '，display=' + getComputedStyle(b).display + '）'; }))`);
    const button = await h.evaluate(`(() => { const b = document.querySelector('[data-redispatch]'); return b ? (b.disabled ? '禁用' : '可用') + '「' + (b.textContent || '').trim() + '」' : '没有按钮'; })()`);
    return `UI17 时间线${tag}：点击前选中 ${m.task}（项目 ${m.project}，执行者 ${m.executor}；演示任务没有 dispatch.json，预期核心返回"旧版本派发、不能再派一次"）；渲染层 ${renderer}；主进程 tasks:redispatch ${main}；核心进程 ${core}；此刻失败横幅 ${banner}；再派一次按钮 ${button}`;
}

// ---- 诊断：Electron-as-Node 与 node.exe 对照（PR #5 CI，AR_SHOTS_FOCUS=core-spawn）----
// 同一条核心命令交替用两种运行时启动，各自打开核心追踪；每次拆成三段：启动（请求 → 子进程内最早标记，墙上时钟对齐）、
// 业务（最早标记 → 命令结束）、退出（写出标准输出 → exit 事件）。另记子进程自己计时的"启动到追踪模块加载"。
async function captureCoreSpawn(rounds: number) {
    const args = ['projects', 'list', '--registry-only'];
    const all: SpawnPhases[] = [];
    for (let round = 1; round <= rounds; round++)
        for (const runtime of (round % 2 ? ['electron', 'node'] : ['node', 'electron']) as ('electron' | 'node')[]) {
            const p = await spawnPhases(runtime, args);
            all.push(p);
            const first = wall(p), done = wall(p, '命令结束'), out = wall(p, '写出标准输出');
            console.log(`核心启动对照（第 ${round} 轮，${runtime}）：父进程观察 spawn +${(p.spawned ?? NaN) - p.requested}ms，首次输出 +${(p.firstOut ?? NaN) - p.requested}ms，exit +${(p.exitAt ?? NaN) - p.requested}ms，close +${(p.closeAt ?? NaN) - p.requested}ms code=${p.code}；子进程自计 启动到追踪模块加载 ${internal(p) ?? '—'}ms；三段 启动 ${first ? first - p.requested : '—'}ms / 业务 ${first && done ? done - first : '—'}ms / 退出 ${out && p.exitAt ? p.exitAt - out : '—'}ms`);
        }
    const stats = (runtime: string, pick: (p: SpawnPhases) => number | undefined) => {
        const values = all.filter(p => p.runtime === runtime).map(pick).filter((v): v is number => Number.isFinite(v)).sort((a, b) => a - b);
        return values.length ? `最小 ${values[0]} / 中位 ${values[Math.floor((values.length - 1) / 2)]} / 最大 ${values.at(-1)} ms（${values.length} 次）` : '无数据';
    };
    for (const runtime of ['electron', 'node']) {
        console.log(`核心启动对照汇总（${runtime}）：启动 ${stats(runtime, p => { const f = wall(p); return f && f - p.requested; })}；业务 ${stats(runtime, p => { const f = wall(p), d = wall(p, '命令结束'); return f && d ? d - f : undefined; })}；退出 ${stats(runtime, p => { const o = wall(p, '写出标准输出'); return o && p.exitAt ? p.exitAt - o : undefined; })}；子进程自计启动 ${stats(runtime, internal)}`);
    }
}

async function captureRedispatch(h: Harness, saveNow: (name: string) => Promise<void>, pressNow: (selector: string) => Promise<void>, registry: Registry, win: BrowserWindow) {
    const { evaluate, wait, check, verify, press } = h;
    const home = appEnv.AGENT_ROUTER_HOME!, repo = redispatchRepo(), configFile = path.join(home, 'config.json');
    const specRel = 'docs/specs/001-已有说明.md';
    assert.ok(await readFile(path.join(repo, specRel), 'utf8').then(() => true, () => false), '再派一次需要新建任务页留下的临时仓库');
    const originalConfig = await readFile(configFile, 'utf8').catch(() => null);
    const rows = () => readRows(registry);
    const writeConfig = (delayMs: number) => writeFile(configFile, JSON.stringify(redispatchConfig(delayMs), null, 2) + '\n');
    const dispatch = async (name: string) => {
        const result = await coreRun(['dispatch', specRel, '--name', name, '--profile', 'fake', '--detach', '--json'], { cwd: repo, timeoutMs: 60000 });
        assert.equal(result.code, 0, `派发 ${name}：${result.stderr || result.json?.error}`);
        assert.equal(result.json?.ok, true, `派发 ${name}：${result.json?.error}`);
        assert.ok(result.json.id, `派发 ${name} 没有返回 id`);
        return String(result.json.id);
    };
    // 看板筛选恢复到全部项目、全部状态，临时任务才一定可见。
    const showAll = async () => {
        await press('[data-page=tasks]');
        await wait('!!document.querySelector("[data-task]")');
        await press('[data-filter=all]');
        await press('[data-project]');
        await press('.ctx button');
    };
    try {
        // 进行中的任务不该出现「再派一次」：派一个持续几秒的假任务，趁它还在跑时检查。
        await writeConfig(5000);
        const liveId = await dispatch('redispatch-live');
        await untilRow(async () => (await rows()).find(r => r.event === 'start' && r.id === liveId), '进行中的临时任务 start');
        await registry.refresh();
        await showAll();
        await wait(`!!document.querySelector("[data-task=${liveId}]")`, '进行中的临时任务行');
        await press(`[data-task=${liveId}]`);
        await wait('!!document.querySelector("[data-stop]")');
        await check('UI17 进行中的任务不显示「再派一次」', '!document.querySelector("[data-redispatch]") && !!document.querySelector("[data-stop]")');

        // 已结束的源任务：先跑完，再走界面上的「再派一次」。
        await writeConfig(150);
        const sourceId = await dispatch(REDISPATCH_SOURCE);
        try { await untilRow(async () => (await rows()).find(r => r.event === 'end' && r.id === sourceId), '源临时任务结束', 15000); }
        catch (error) {
            // 脱离任务没按时结束（PR #5 CI）：打印它的记录事件、进度尾部、派发进程与 agent 是否还在，以及最近的核心活动与 Registry 阶段。
            const events = (await rows()).filter(r => r.id === sourceId).map(r => `${r.event}${r.pid ? ' pid=' + r.pid : ''}${r.agentPid ? ' agentPid=' + r.agentPid : ''}${r.exit !== undefined ? ' exit=' + r.exit : ''}`).join('、') || '（没有任何记录）';
            const start = (await rows()).find(r => r.id === sourceId && r.event === 'start'), spawned = (await rows()).find(r => r.id === sourceId && r.event === 'spawned');
            const pids = [start?.pid, spawned?.agentPid].filter((p): p is number => Number.isInteger(p));
            const alive = pids.length ? await registry.platform.processes(pids).then(ps => ps.map(p => `${p.pid} ${p.name}`).join('、') || '都不在了', e => `查询失败：${e instanceof Error ? e.message : String(e)}`) : '（没有 pid）';
            const progress = start?.progress ? await readFile(start.progress, 'utf8').then(t => t.trimEnd().split('\n').slice(-5).join(' | '), () => '（读不到）') : '（没有进度文件）';
            console.log(`脱离任务诊断：记录事件 ${events}；进程 ${alive}；进度尾部 ${progress}\n${recentReport()}`.replaceAll(os.tmpdir(), '<TEMP>'));
            throw error;
        }
        await registry.refresh();
        await wait(`!!document.querySelector("[data-task=${sourceId}]")`, '已结束的源任务行');
        await press(`[data-task=${sourceId}]`);
        await wait('!!document.querySelector("[data-redispatch]")');
        await check('UI17 已结束任务显示次要按钮「再派一次」，悬停说明写明用途', `(() => { const b = document.querySelector("[data-redispatch]"); return b?.textContent.trim() === "再派一次" && b.dataset.tip === "用同样的任务说明、执行者和参数重新派发" && b.classList.contains("btn") && !b.classList.contains("primary"); })()`);
        const sourceStart = (await rows()).find(r => r.event === 'start' && r.id === sourceId);
        assert.ok(sourceStart, '源任务没有 start 行');

        // 失败与中断的任务同样可以再派一次（done / fail / stop 三种状态）。
        await press('[data-task=t5]');
        await wait('!!document.querySelector("[data-redispatch]")');
        await press('[data-task=t6]');
        await wait('!!document.querySelector("[data-redispatch]")');
        await check('UI17 失败与中断的任务也显示「再派一次」', 'document.querySelector("[data-task=t6]").classList.contains("on") && !!document.querySelector("[data-redispatch]")');

        // 失败路径：演示任务没有 dispatch.json，核心返回固定原因，详情页横幅原样显示。
        const startsBeforeFailure = (await rows()).filter(r => r.event === 'start').length;
        await press('[data-task=t3]');
        await wait('!!document.querySelector("[data-redispatch]")');
        const ui17 = await ui17Mark(h, registry);
        await press('[data-redispatch]');
        try { await wait('!!document.querySelector(".banner.fail")', '再派一次失败横幅'); }
        finally { console.log((await ui17Timeline(h, ui17)).replaceAll(os.tmpdir(), '<TEMP>')); }
        await check('UI17 再派一次失败时在页面横幅说明原因', 'document.querySelector(".banner.fail .rt span")?.textContent.includes("这个任务是旧版本派发的，没有保存派发参数，不能再派一次")');
        await verify('UI17 再派一次失败不产生新任务行', async () => {
            assert.equal((await rows()).filter(r => r.event === 'start').length, startsBeforeFailure);
        });
        await press(`[data-task=${sourceId}]`);
        await wait('!!document.querySelector("[data-redispatch]")');

        await writeConfig(150);
        // 预热截图管线：隐藏窗口空闲后的第一次 capturePage 可能要等约两秒，忙碌态只有几百毫秒，等不起。
        await win.webContents.capturePage();
        await pressNow('[data-redispatch]');
        await wait('document.querySelector("[data-redispatch]")?.disabled === true', '再派一次后按钮进入忙碌态', 3000);
        await check('UI17 点「再派一次」后按钮显示「正在派发…」并禁用', 'document.querySelector("[data-redispatch]")?.disabled === true && document.querySelector("[data-redispatch]")?.textContent.includes("正在派发…")');
        nativeTheme.themeSource = 'dark';
        await saveNow('redispatch-busy-dark');
        nativeTheme.themeSource = 'light';
        await saveNow('redispatch-busy-light');
        nativeTheme.themeSource = 'dark';

        await wait(`(() => { const id = document.querySelector(".trow.on")?.dataset.task; return !!id && id !== ${JSON.stringify(sourceId)}; })()`, '再派一次后选中新任务', 15000);
        const againId = String(await evaluate('document.querySelector(".trow.on")?.dataset.task'));
        await check('UI17 再派一次成功后自动选中新任务', `document.querySelector(".trow.on")?.dataset.task === ${JSON.stringify(againId)} && document.querySelector(".dh h2")?.textContent === document.querySelector("[data-task=${againId}] .tm b")?.textContent`);
        // 015：软件发起的「再派一次」记 AgentRouter（软件）；与 UI03 同样的文本拼接方式。
        await check('UI17 再派一次的任务详情状态行显示"派活方AgentRouter（软件）"', 'document.querySelector("[data-dispatcher-line]").textContent==="派活方AgentRouter（软件）"');
        // 任务 011：真实「再派一次」的新任务（记录名自动去重成 -2）在列表与详情都带「第 2 次」，源任务不带。
        await check('UI03 再派一次的新任务带「第 2 次」标签，源任务不带', `(()=>{const again=document.querySelector("[data-task=${againId}] .tm b"),src=document.querySelector("[data-task=${sourceId}] .tm b");return again.querySelector(".tag")?.textContent==="第 2 次" && document.querySelector(".dh h2 .tag")?.textContent==="第 2 次" && !src.querySelector(".tag") && document.querySelector(".dh h2 .ttl")?.textContent===again.querySelector(".ttl")?.textContent;})()`);
        const againStart = await untilRow(async () => (await rows()).find(r => r.event === 'start' && r.id === againId), '再派一次的新任务 start');
        await verify('UI17 新任务的 spec 与 profile 和源任务相同，记录名自动去重', () => {
            assert.equal(againStart.spec, sourceStart.spec);
            assert.equal(againStart.profile, sourceStart.profile);
            assert.notEqual(againStart.name, sourceStart.name);
        });
        await verify('UI17 再派一次的任务 start 行的派活方是 agentrouter', () => {
            assert.deepEqual(againStart.dispatcher, { host: 'agentrouter', session: null });
        });
        const againEnd = await untilRow(async () => (await rows()).find(r => r.event === 'end' && r.id === againId), '再派一次的新任务结束', 15000);
        await verify('UI17 再派一次的新任务正常结束（end.exit=0）', () => assert.equal(againEnd.exit, 0));
        await verify('UI17 新记录目录里的 dispatch.json 与源任务参数一致', async () => {
            const copied = JSON.parse(await readFile(path.join(repo, '.agent-runs', againStart.name, 'dispatch.json'), 'utf8'));
            assert.equal(copied.spec, sourceStart.spec);
            assert.equal(copied.profile, sourceStart.profile);
            assert.equal(copied.name, againStart.name);
        });
    }
    finally {
        if (originalConfig === null)
            await writeFile(configFile, JSON.stringify(redispatchConfig(0), null, 2) + '\n');
        else
            await writeFile(configFile, originalConfig);
        nativeTheme.themeSource = 'dark';
    }
}

// 退出前检查用的任务：外部启动器在 Electron 退出后按这些字段核对进程、清单与等待者输出。
interface ExitCheck { label: string; id: string; executor: number; agent: number; waiterLog: string; readyAt: number; processes: { pid: number; name: string; created: number }[]; pendingAt?: number; release?: string }
// 诊断（PR #5 CI 退出后实测）：就绪那一刻两个进程的身份（名字、创建时间），外部启动器据此判断事后是否同一进程、是否 PID 被复用。
const exitProcesses = async (registry: Registry, pids: number[]) => (await registry.platform.processes(pids).catch(() => [])).map(p => ({ pid: p.pid, name: p.name, created: p.created }));

// 024：退出前确认任务确实还在运行——记录里有 start、没有 end，执行者与假 agent 进程都存活，并记下它们的进程身份。
// 外部启动器在 Electron 退出后用这份身份核对"还是同一个进程"（PID 可能被复用）。
async function runningExitProcesses(registry: Registry, label: string, id: string, pids: number[]) {
    const rows = await readRows(registry);
    assert.ok(rows.some(row => row.event === 'start' && row.id === id), `${label}退出前应有 start 记录`);
    assert.ok(!rows.some(row => row.event === 'end' && row.id === id), `${label}退出前不应该已经结束`);
    const processes = await exitProcesses(registry, pids);
    assert.deepEqual(processes.map(p => p.pid).sort((a, b) => a - b), [...pids].sort((a, b) => a - b), `${label}退出前执行者与假 agent 都应在运行`);
    return processes;
}

// 退出前的最后一次「再派一次」：派一个持续几秒的假任务，把执行者与假 agent 的 pid 交给外部启动器，
// Electron 退出后它会检查两个进程仍存活、任务 end.exit=0，以及等待者打印的结束行。
// 024：假执行者也等放行文件才结束（同托管任务），"就绪 → Electron 退出"再久也不会在检查前自然结束。
async function prepareRedispatchExit(h: Harness, registry: Registry): Promise<ExitCheck> {
    const home = appEnv.AGENT_ROUTER_HOME!, repo = redispatchRepo(), configFile = path.join(home, 'config.json');
    // 放行文件放在隔离公共目录里；派发前先删掉上一次留下的。
    const release = path.join(home, 'redispatch-exit-release');
    await rm(release, { force: true });
    const originalConfig = await readFile(configFile, 'utf8').catch(() => null);
    const source = (await readRows(registry)).find(row => row.event === 'start' && row.name === REDISPATCH_SOURCE);
    assert.ok(source, '找不到再派一次用的临时任务');
    const before = new Set((await readRows(registry)).filter(row => row.event === 'start').map(row => row.id));
    await writeFile(configFile, JSON.stringify(redispatchConfig(8000, release), null, 2) + '\n');
    try {
        await h.press('[data-page=tasks]');
        await h.wait(`!!document.querySelector("[data-task=${source.id}]")`, '退出前的临时任务行', 20000);
        await h.press(`[data-task=${source.id}]`);
        await h.wait('!!document.querySelector("[data-redispatch]") && !document.querySelector("[data-redispatch]").disabled', '退出前的再派一次按钮', 20000);
        await h.press('[data-redispatch]');
        const start = await untilRow(async () => (await readRows(registry)).find(row => row.event === 'start' && !before.has(row.id) && row.repo === repo), '退出前的再派发 start', 20000);
        const spawned = await untilRow(async () => (await readRows(registry)).find(row => row.event === 'spawned' && row.id === start.id && Number.isInteger(row.agentPid)), '退出前的假执行者进程', 20000);
        assert.ok(!(await readRows(registry)).some(row => row.event === 'end' && row.id === start.id), '退出前的任务应该还在运行');
        // 写 exit-pending.json 之前确认两项都还在运行，并记下进程身份（名字 + 创建时间）。
        const processes = await runningExitProcesses(registry, '脱离任务', start.id, [start.pid, spawned.agentPid]);
        const node = process.env.AR_TEST_NODE!;
        assert.ok(path.isAbsolute(node) && /^node(?:\.exe)?$/i.test(path.basename(node)));
        const waiterLog = 'redispatch-exit-waiter.log';
        const output = await open(path.join(home, waiterLog), 'w');
        try {
            const waiter = spawn(node, [coreScript(), 'wait', start.name], { cwd: repo, env: appEnv, detached: true, stdio: ['ignore', output.fd, output.fd], shell: false, windowsHide: true });
            await new Promise<void>((resolve, reject) => { waiter.once('spawn', resolve); waiter.once('error', reject); });
            waiter.unref();
        }
        finally { await output.close(); }
        return { label: '脱离任务', id: start.id, executor: start.pid, agent: spawned.agentPid, waiterLog, readyAt: Date.now(), processes, release };
    }
    finally {
        // 请求里已经带上了执行者快照，退出前恢复配置不影响已在运行的任务。
        if (originalConfig !== null)
            await writeFile(configFile, originalConfig);
    }
}

// 技能派发、真实 Electron 认领的托管任务（功能基线 F08）：用技能目录里的 ar.mjs 派发，
// 隔离配置 managed: true，使用正在截图的真实 Electron 主进程认领；外部启动器在 app.quit 后检查任务继续运行。
// UI19（012 A）：关闭询问、托盘与"窗口"设置。检查期间临时显示窗口（隐藏窗口无法验证"Esc 后仍可见"）。
// 检查结束后让窗口保持显示（不激活）：显示过再隐藏的窗口，过一会儿 capturePage 会一直不返回（012 验收实测），
// 而后续还有截图；不激活显示不影响真实输入与截图内容。
// UI21（W4）：进程查询失败时任务页的表现与恢复。故障注入在主进程的进程查询入口（effects.processFail），
// 与 CI 上 PowerShell 查询失败走同一条 Registry 路径；核对派发进程是否真的还在，用不经注入的平台实现。
// 时间标准：注入或恢复后横幅出现 / 消失按默认 10 秒（定时刷新 2 秒一次，一次刷新最多试 3 次、间隔 0 / 300 / 1000 ms）。
async function captureProcessUnknown(h: Harness, registry: Registry, save: (name: string) => Promise<void>, menuItem: (label: string) => Promise<string>, runs: () => Promise<any[]>) {
    const { evaluate, wait, check, verify, press, key } = h;
    const real = windowsPlatform(async () => '');
    const t1 = registry.tasks.find(t => t.id === 't1')!;
    const ended = registry.tasks.find(t => t.status !== 'run' && t.pid && !t.imported);
    await verify('UI21 注入前：t1 进行中且派发进程存活，另有一条带 pid 的已结束任务可用于检查', async () => {
        assert.equal(t1.status, 'run');
        assert.ok(dispatchMatches((await real.processes([t1.pid]))[0], t1.started), 't1 的派发进程应存活');
        assert.ok(ended, '演示数据里应有带 pid 的已结束任务');
        assert.deepEqual(registry.processCheck, { ok: true, failures: 0 });
    });
    const id = ended!.id, injected = '验收注入：进程查询失败（UI21）';
    const rowsBefore = (await runs()).length, noticesBefore = effects.notices.length;
    const tasksFile = path.join(registry.data, 'tasks.json'), hiddenBefore = await readFile(tasksFile, 'utf8').catch(() => '');
    const banner = '[data-process-banner] .banner';
    await press('[data-page=tasks]'); await press('[data-task=t1]'); await wait('!!document.querySelector("[data-stop]")');
    await check('UI21 注入前：没有进程状态横幅，停止可用', `!document.querySelector(${JSON.stringify(banner)}) && !document.querySelector("[data-stop]").disabled`);
    effects.processFail = injected;
    try {
        await wait(`!!document.querySelector(${JSON.stringify(banner)})`, 'UI21 注入后出现进程状态横幅');
        await check('UI21 横幅写明无法确认、连续失败次数与原因', `(() => { const b = document.querySelector(${JSON.stringify(banner)}); return b.querySelector('.rt b')?.textContent === ${JSON.stringify(c.processUnknownTitle)}
            && /已连续失败 [1-9]\\d* 次/.test(b.querySelector('.rt span')?.textContent ?? '') && (b.querySelector('.rt span')?.textContent ?? '').includes(${JSON.stringify(injected)}); })()`);
        await check('UI21 进行中的 t1 仍在"进行中"分组，行尾标"状态未知"', `(() => { const r = document.querySelector('[data-task=t1]'); return r.classList.contains('is-running') && r.querySelector('.tm > span').textContent.includes(' · ' + ${JSON.stringify(c.processUnknownTag)}); })()`);
        await check('UI21 停止按钮禁用并说明原因', `document.querySelector("[data-stop]").disabled && document.querySelector("[data-stop]").dataset.tip === ${JSON.stringify(c.processUnknownBlocked)}`);
        await verify('UI21 真实点击停止报"已禁用"', async () => { await assert.rejects(press('[data-stop]'), /已禁用/); });
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await save(`process-unknown-${theme}`); }
        nativeTheme.themeSource = 'dark';
        const failed = registry.tasks.find(t => t.status === 'fail');
        assert.ok(failed, '演示数据里应有失败任务');
        await press(`[data-task=${failed!.id}]`); await wait('!!document.querySelector(".detail .banner-holder .banner.fail")', 'UI21 失败任务的详情横幅');
        await check('UI21 进程横幅与详情的失败横幅同时存在、各在自己的区域（详情横幅不写进任务页顶部）', `document.querySelectorAll('[data-process-banner] .banner').length === 1 && !document.querySelector('[data-process-banner] .banner.fail') && !!document.querySelector('.detail .banner-holder .banner.fail') && !document.querySelector('.detail [data-process-banner]')`);
        await press(`[data-task=${id}]`); await press('[data-more]');
        await verify('UI21 已结束任务的「从列表隐藏」禁用（命中测试报已禁用）', async () => { await assert.rejects(press(await menuItem('从列表隐藏')), /已禁用/); });
        await key('Escape');
        await press('[data-multi=select]'); await press(`[data-task=${id}]`);
        await check('UI21 选择模式勾选已结束任务后，删除仍禁用', `document.querySelector('[data-task=${id}]').getAttribute('aria-checked') === 'true' && document.querySelector('[data-multi=delete]').disabled`);
        await verify('UI21 真实点击删除报"已禁用"', async () => { await assert.rejects(press('[data-multi=delete]'), /已禁用/); });
        await key('Escape');
        // 绕过界面直接调用：主进程自己也拒绝，不结束进程、不改列表。
        const viaApi = async (expr: string) => await evaluate(`${expr}.then(() => 'ok', e => 'rejected:' + String(e?.message ?? e))`) as string;
        const stopResult = await viaApi(`window.dock.action('t1', 'stop')`);
        const hideResult = await viaApi(`window.dock.action(${JSON.stringify(id)}, 'hide')`);
        const deleteResult = await viaApi(`window.dock.deleteTasks([${JSON.stringify(id)}], false)`);
        await verify('UI21 主进程拒绝停止、隐藏与删除，派发进程仍存活，列表与 tasks.json 不变', async () => {
            assert.match(stopResult, /^rejected:/, '停止应被拒绝');
            assert.match(hideResult, /^rejected:/, '隐藏应被拒绝');
            assert.match(deleteResult, /^rejected:/, '删除应被拒绝');
            assert.ok(dispatchMatches((await real.processes([t1.pid]))[0], t1.started), 't1 的派发进程应仍存活');
            assert.ok(registry.tasks.some(t => t.id === id), '已结束任务应仍在列表里');
            assert.equal(await readFile(tasksFile, 'utf8').catch(() => ''), hiddenBefore);
        });
        // 超过 3 秒宽限、且至少连续失败 2 次之后，仍不推断结束：不写结束事件、不发结束通知。
        const since = registry.processCheck.since ?? Date.now();
        const held = await pollUntil(() => registry.processCheck.failures >= 2 && Date.now() - since >= 3500, 10000);
        await verify('UI21 查询持续失败超过宽限期：t1 仍进行中且标未知，没有新记录、没有结束通知', async () => {
            assert.ok(held.ok, `10 秒内没有达到"连续失败 ≥ 2 次且超过 3.5 秒"：failures=${registry.processCheck.failures}`);
            const t = registry.tasks.find(x => x.id === 't1')!;
            assert.equal(t.status, 'run'); assert.equal(t.processState, 'unknown');
            assert.equal((await runs()).length, rowsBefore, 'runs.jsonl 不应有新行');
            assert.equal(effects.notices.length, noticesBefore, '不应发结束通知');
            assert.equal(registry.processCheck.since, since, '首次失败时刻保留');
        });
    } finally { effects.processFail = ''; }
    await wait(`!document.querySelector(${JSON.stringify(banner)})`, 'UI21 恢复后横幅消失');
    await press('[data-task=t1]'); await wait('!!document.querySelector("[data-stop]")');
    await check('UI21 恢复后停止可用、行尾不再标"状态未知"', `!document.querySelector("[data-stop]").disabled && !document.querySelector('[data-task=t1] .tm > span').textContent.includes(${JSON.stringify(c.processUnknownTag)})`);
    await verify('UI21 恢复后 Registry 清零、t1 仍进行中且派发进程存活', async () => {
        assert.deepEqual(registry.processCheck, { ok: true, failures: 0 });
        const t = registry.tasks.find(x => x.id === 't1')!;
        assert.equal(t.status, 'run'); assert.equal(t.processState, undefined);
        assert.ok(dispatchMatches((await real.processes([t1.pid]))[0], t1.started));
    });
    await press('[data-multi=select]'); await press(`[data-task=${id}]`);
    await check('UI21 恢复后勾选已结束任务，删除可用', `!document.querySelector('[data-multi=delete]').disabled`);
    await key('Escape');
    await wait('!!document.querySelector("[data-multi=select]")');
}

async function captureCloseAndTray(h: Harness, win: BrowserWindow, save: (name: string) => Promise<void>) {
    const { evaluate, wait, check, verify, press, key, tabTo, pause } = h;
    win.showInactive();
    await pause();
    await press('[data-page=settings]');
    await wait('!!document.querySelector("[data-segment=closeAction]")');
    // 设置页"窗口"与"数据"两节：深浅各一张。
    await evaluate('document.querySelector("[data-segment=closeAction]").scrollIntoView({block:"center"})');
    for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await save(`settings-window-${theme}`); }
    await evaluate('document.querySelector("[data-pref=clear-cache]").scrollIntoView({block:"center"})');
    for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await save(`settings-data-${theme}`); }
    nativeTheme.themeSource = 'dark';
    await check('UI19 设置页"窗口"一节有三个选项，当前为"每次询问"', `(() => { const titles=[...document.querySelectorAll(".sect h2")].map(x=>x.textContent); return titles.includes("窗口") && ["ask","tray","quit"].every(v=>!!document.querySelector('[data-segment=closeAction][data-value='+v+']')) && document.querySelector("[data-segment=closeAction][data-value=ask]").classList.contains("on"); })()`);

    // t1 还在进行：重置确认框显示原因并禁用确认。
    await press('[data-pref=reset-app]');
    await wait('!!document.querySelector("[data-reset-home]")');
    await check('UI20 有进行中任务时重置确认框显示原因并禁用"重置并退出"', `(() => { const b=[...document.querySelectorAll(".sheet-btns button")].at(-1); return document.querySelector(".sheet").textContent.includes("个任务正在进行") && b.disabled; })()`);
    await check('UI20 重置确认框默认焦点在"取消"，确认按钮为危险样式', `document.activeElement.textContent==="取消" && [...document.querySelectorAll(".sheet-btns button")].at(-1).classList.contains("danger")`);
    await press('.sheet-btns .btn');
    await wait('!document.querySelector("[data-reset-home]")');

    // 关闭询问：默认焦点、背景 inert、Tab 循环。
    await tabTo('[data-pref=notifications]');
    win.close();
    await wait('!!document.querySelector(".close-sheet")', 'UI19 关闭询问');
    await check('UI19 点 × 弹出询问：标题、说明与三个按钮，默认焦点在"最小化到托盘"', `(() => { const s=document.querySelector(".close-sheet"); const labels=[...s.querySelectorAll(".sheet-btns button")].map(b=>b.textContent); return s.querySelector("#close-title").textContent==="关闭 AgentRouter" && s.querySelector("#close-body").textContent.includes("最小化到托盘") && labels.join("|")==="取消|退出|最小化到托盘" && document.activeElement.dataset.closeAction==="tray"; })()`);
    await check('UI19 关闭询问打开时背景不可操作', 'document.querySelector("#app").inert');
    await pause(6000);
    await verify('UI19 关闭询问显示 6 秒不回答，软件不会自己退出（窗口与询问都还在）', async () => {
        assert.equal(win.isDestroyed(), false);
        assert.equal(await evaluate('!!document.querySelector(".close-sheet")'), true);
    });
    const cycle: string[] = [];
    for (let i = 0; i < 4; i++) {
        await key('Tab');
        cycle.push(await evaluate('document.activeElement?.dataset.closeAction || (document.activeElement?.hasAttribute("data-close-remember") ? "remember" : "other")'));
    }
    await verify('UI19 Tab 在三个按钮与"不再询问"之间循环', () => assert.deepEqual(cycle, ['remember', 'cancel', 'quit', 'tray']));
    for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await save(`close-ask-${theme}`); }
    nativeTheme.themeSource = 'dark';
    await key('Escape');
    await wait('!document.querySelector(".close-sheet")');
    await check('UI19 Esc 关闭询问，焦点回到页面原来的位置', 'document.activeElement===document.querySelector("[data-pref=notifications]")');
    await verify('UI19 Esc 后窗口仍在且可见', () => assert.equal(win.isVisible(), true));

    // 最小化到托盘：窗口隐藏、托盘存在、第一次提示一次；托盘的"打开"恢复窗口。
    win.close();
    await wait('!!document.querySelector(".close-sheet")');
    const notices = effects.notices.length;
    await press('[data-close-action=tray]');
    await wait('!document.querySelector(".close-sheet")');
    // 渲染层先关框再通过 IPC 告诉主进程，窗口隐藏晚一拍；等它完成再查可见性与托盘状态。
    await pause(300);
    await verify('UI19 选"最小化到托盘"后窗口不可见', () => assert.equal(win.isVisible(), false));
    await verify('UI19 托盘存在，提示文案随进行中任务数变化，菜单有打开与退出', () => {
        assert.ok(effects.tray, '验收桩里应该有托盘状态');
        assert.equal(effects.tray!.destroyed, false);
        assert.deepEqual(effects.tray!.items, [p.trayOpen, p.trayQuit]);
        assert.match(effects.tray!.tip, /1 个任务进行中/);
    });
    await verify('UI19 第一次最小化到托盘时发一次系统通知', () => {
        assert.equal(effects.notices.length, notices + 1);
        assert.equal(effects.notices.at(-1)!.body, p.trayFirst);
    });
    effects.tray!.open();
    await pause();
    await verify('UI19 托盘的"打开"恢复并聚焦窗口', () => assert.equal(win.isVisible(), true));

    // 记住选择：勾选"不再询问"后选托盘，own.closeAction 存为 tray，之后再点 × 不弹框。
    win.close();
    await wait('!!document.querySelector(".close-sheet")');
    await press('[data-close-remember]');
    await check('UI19 勾选"不再询问"', 'document.querySelector("[data-close-remember]").getAttribute("aria-checked")==="true"');
    await press('[data-close-action=tray]');
    await wait('!document.querySelector(".close-sheet")');
    await wait(`window.dock.preferences('settings').then(s => s.own.closeAction === "tray")`, 'UI19 记住的选择写入 own.closeAction');
    await verify('UI19 勾选后选托盘，own.closeAction 存为 tray', async () => assert.equal(await evaluate(`window.dock.preferences('settings').then(s => s.own.closeAction)`), 'tray'));
    win.showInactive();
    await pause(300);
    const again = effects.notices.length;
    win.close();
    await pause(300);
    await check('UI19 记住后点 × 不再询问，直接隐藏', '!document.querySelector(".close-sheet")');
    await verify('UI19 记住后点 × 直接隐藏窗口', () => assert.equal(win.isVisible(), false));
    await verify('UI19 已经提示过，不再重复发托盘提示', () => assert.equal(effects.notices.length, again));

    // 设置页改回"每次询问"，点 × 又会弹框；同时确认分段即时保存。
    win.showInactive();
    await pause(100);
    await press('[data-page=settings]');
    // 设置页重新挂载时会异步刷新，等到它显示刚记住的"最小化到托盘"再检查。
    await wait('document.querySelector("[data-segment=closeAction][data-value=tray]")?.classList.contains("on")');
    await check('UI19 设置页显示当前为"最小化到托盘"', 'document.querySelector("[data-segment=closeAction][data-value=tray]").classList.contains("on")');
    await press('[data-segment=closeAction][data-value=ask]');
    await wait(`document.querySelector("[data-segment=closeAction][data-value=ask]").classList.contains("on")`);
    await wait(`window.dock.preferences('settings').then(s => s.own.closeAction === "ask")`, 'UI19 改回"每次询问"即时保存');
    await verify('UI19 "每次询问"即时写入 own.closeAction', async () => assert.equal(await evaluate(`window.dock.preferences('settings').then(s => s.own.closeAction)`), 'ask'));
    win.close();
    await wait('!!document.querySelector(".close-sheet")', 'UI19 改回询问后再次弹框');
    await press('[data-close-action=cancel]');
    await wait('!document.querySelector(".close-sheet")');
    win.showInactive();
    await pause();
    await verify('UI19 关闭询问验收结束后窗口仍显示（隐藏后截图会失去绘制表面）', () => assert.equal(win.isVisible(), true));
}

// UI20（012 B 的界面部分）：清除缓存与重置确认框。真正的重置在第二次启动（captureReset）里执行，
// 因为删除公共目录必须等软件退出之后。
async function captureDataAndReset(h: Harness, win: BrowserWindow, save: (name: string) => Promise<void>) {
    const { evaluate, wait, check, verify, press, pause } = h;
    const home = appEnv.AGENT_ROUTER_HOME!, data = path.join(home, 'monitor'), temp = appEnv.TEMP!;
    await verify('UI20 没有进行中任务时托盘提示回到 AgentRouter', () => assert.equal(effects.tray?.tip, p.trayTip(0)));
    await press('[data-page=settings]');
    await wait('!!document.querySelector("[data-pref=clear-cache]")');
    await check('UI20 设置页"数据"一节在"配置文件"之后，含清除缓存与重置', `(() => { const titles=[...document.querySelectorAll(".sect h2")].map(x=>x.textContent); return titles.at(-1)==="数据" && titles.indexOf("数据")>titles.indexOf("配置文件") && !!document.querySelector("[data-pref=clear-cache]") && !!document.querySelector("[data-pref=reset-app]"); })()`);

    // 预先放好缓存目录、会话记录、测试临时目录与一个软件文件；清除后前三个消失，后两个保留。
    // 用 Code Cache：Chromium 运行时会锁住 GPUCache / DawnGraphiteCache 等目录（Windows 上是 EPERM），
    // 按规格这些删不掉的跳过并记日志；Code Cache 同属规格列出的缓存目录，运行中可删，用来验证删除路径。
    // 014：在缓存目录与会话记录里造 20000 个小文件，清除要花几秒，正好检查清除期间主进程仍能响应。
    const cache = path.join(data, 'Code Cache'), sessions = path.join(home, 'workers', 'demo', 'claude', 'projects');
    const keep = path.join(data, 'keep-cache-test.txt'), testTemp = path.join(temp, 'ar-agent-test-shots');
    const fill = async (dir: string, groups: number, each: number) => {
        for (let g = 0; g < groups; g++) {
            const sub = path.join(dir, `g${g}`);
            await mkdir(sub, { recursive: true });
            for (let i = 0; i < each; i += 200)
                await Promise.all(Array.from({ length: Math.min(200, each - i) }, (_, k) => writeFile(path.join(sub, `f${i + k}.bin`), 'x')));
        }
    };
    await mkdir(cache, { recursive: true }); await writeFile(path.join(cache, 'blob.bin'), Buffer.alloc(2048, 1));
    await mkdir(sessions, { recursive: true }); await writeFile(path.join(sessions, 'session.jsonl'), '{"v":1}\n');
    await fill(cache, 2, 1000);
    await fill(sessions, 18, 1000);
    await mkdir(testTemp, { recursive: true }); await writeFile(path.join(testTemp, 'probe.txt'), 'probe');
    await writeFile(keep, 'keep');
    await press('[data-pref=clear-cache]');
    // 清除在子进程里进行：按钮禁用、主进程仍能在 500ms 内响应一次 IPC，任务列表仍可切换。
    await wait('document.querySelector("[data-pref=clear-cache]")?.disabled === true', 'UI20 清除进行中按钮禁用', 5000);
    await check('UI20 清除进行中按钮禁用并显示"正在后台清除…（可以继续使用软件）"', `(() => { const b=document.querySelector("[data-pref=clear-cache]"); return b.disabled && b.textContent===${JSON.stringify(p.clearingCache)}; })()`);
    const roundtrip = await evaluate(`(async () => { const started=performance.now(); await window.dock.preferences('settings'); return performance.now()-started; })()`);
    await verify('UI20 清除进行中主进程在 500 ms 内完成一次 IPC 往返', () => { assert.ok(roundtrip < 500, `IPC 往返用了 ${Math.round(roundtrip)}ms`); });
    await press('[data-page=tasks]');
    await wait('!!document.querySelector("[data-task=t3]")');
    await press('[data-task=t3]');
    await wait('document.querySelector("[data-task=t3]").classList.contains("on")', 'UI20 清除进行中点击任务切换选中');
    await check('UI20 清除进行中任务列表仍可点击切换选中', 'document.querySelector("[data-task=t3]").classList.contains("on")');
    await press('[data-page=settings]');
    await wait('!!document.querySelector("[data-pref=clear-cache]")');
    await wait(`(() => { const b=document.querySelector('[data-pref=clear-cache]'); return !!b && (b.disabled || !!document.querySelector('[data-cache-result]')); })()`, 'UI20 回到设置页仍能看到清除进行中或结果', 20000);
    await check('UI20 离开设置页再回来仍能看到进行中或结果', `(() => { const b=document.querySelector('[data-pref=clear-cache]'); const n=document.querySelector('[data-cache-result]'); return b.disabled ? b.textContent===${JSON.stringify(p.clearingCache)} : (!!n && n.textContent.startsWith("已清除 ")); })()`);
    await wait('!!document.querySelector("[data-cache-result]")', 'UI20 清除缓存完成', 30000);
    // 诊断（PR #5 CI）：清除 20000 个文件后机器在忙什么，用来核对后面核心调用卡住是否与此有关。
    console.log('UI20 清除缓存完成后的 CPU（1 秒采样）：' + await cpuNow());
    await verify('UI20 清除缓存删除缓存目录、会话记录与测试临时目录', () => {
        assert.equal(existsSync(cache), false, '缓存目录应该被删除');
        assert.equal(existsSync(sessions), false, '执行者会话记录应该被删除');
        assert.equal(existsSync(testTemp), false, '测试临时目录应该被删除');
    });
    await verify('UI20 清除缓存保留软件文件与无关文件', () => {
        assert.ok(existsSync(path.join(data, 'preferences.json')), '软件偏好应该保留');
        assert.ok(existsSync(keep), '无关文件应该保留');
    });
    await check('UI20 清除结果与大小显示在"清除缓存"这一行', 'document.querySelector("[data-cache-result]").textContent.startsWith("已清除 ")');
    await save('settings-data-cleared-dark');

    // 重置确认框：用一份临时配置验证"密钥来源变量名"出现在选项说明里，检查完恢复原配置。
    const configFile = path.join(home, 'config.json');
    const original = await readFile(configFile, 'utf8').catch(() => null);
    let base: any = {};
    try { base = original ? JSON.parse(original) : {}; } catch { base = {}; }
    await writeFile(configFile, JSON.stringify({ ...base, v: 2, profiles: { ...(base.profiles ?? {}), resetDemo: { adapter: 'claude-code', label: 'Reset Demo', enabled: false, auth: 'token', secrets: { apiKey: 'RESET_DEMO_KEY' } } } }, null, 2) + '\n');
    try {
        await press('[data-page=about]'); await wait('!!document.querySelector(".about")');
        await press('[data-page=settings]'); await wait('!!document.querySelector("[data-pref=reset-app]")');
        await press('[data-pref=reset-app]');
        await wait('!!document.querySelector("[data-reset-home]")', 'UI20 重置确认框');
        await check('UI20 无进行中任务时确认按钮可用', `![...document.querySelectorAll(".sheet-btns button")].at(-1).disabled`);
        await check('UI20 重置确认框显示要删除的公共目录完整路径', `document.querySelector("[data-reset-home]").textContent===${JSON.stringify(home)}`);
        await check('UI20 重置确认框说明不会删除项目文件夹', 'document.querySelector(".sheet").textContent.includes("不会删除：项目文件夹")');
        await check('UI20 重置确认框列出技能选项，以及配置里用到的密钥变量名', 'document.querySelector("[data-reset-check=skills]") && document.querySelector("[data-reset-check=secrets]")?.textContent.includes("RESET_DEMO_KEY")');
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await save(`reset-dialog-${theme}`); }
        nativeTheme.themeSource = 'dark';
        await press('.sheet-btns .btn');
        await wait('!document.querySelector("[data-reset-home]")');
    }
    finally {
        if (original === null) await rm(configFile, { force: true }); else await writeFile(configFile, original);
    }
}

// UI20 设置页"列表"一节（018）：清空任务列表与清空项目列表。清空是真删列表状态（hidden / projects.json），
// 所以检查完把 tasks.json、projects.json、config.json 恢复成检查前的内容（与 UI02 空状态临时改写 runs.jsonl
// 同类的夹具做法），后面的「再派一次」退出检查继续用演示数据。
// 位置在 UI02 空状态恢复之后、控制台错误核对之前：检查能进 checks.json，UI01～UI20 汇总断言不用动。
async function captureLists(h: Harness, registry: Registry, save: (name: string) => Promise<void>) {
    const { evaluate, wait, check, verify, press } = h;
    const home = appEnv.AGENT_ROUTER_HOME!, repo = redispatchRepo(), configFile = path.join(home, 'config.json');
    const tasksFile = path.join(registry.data, 'tasks.json'), projectsFile = path.join(home, 'projects.json');
    const originalTasks = await readFile(tasksFile, 'utf8').catch(() => null);
    const originalProjects = await readFile(projectsFile, 'utf8').catch(() => null);
    const originalConfig = await readFile(configFile, 'utf8').catch(() => null);
    const rows = () => readRows(registry);
    const writeConfig = (delayMs: number) => writeFile(configFile, JSON.stringify(redispatchConfig(delayMs), null, 2) + '\n');
    const dispatch = async (name: string) => {
        const result = await coreRun(['dispatch', 'docs/specs/001-已有说明.md', '--name', name, '--profile', 'fake', '--detach', '--json'], { cwd: repo, timeoutMs: 60000 });
        assert.equal(result.code, 0, `派发 ${name}：${result.stderr || result.json?.error}`);
        assert.equal(result.json?.ok, true, `派发 ${name}：${result.json?.error}`);
        assert.ok(result.json.id, `派发 ${name} 没有返回 id`);
        return String(result.json.id);
    };
    const pidsOf = async (id: string) => {
        const list = await rows();
        const start = list.find(r => r.event === 'start' && r.id === id), spawned = list.find(r => r.event === 'spawned' && r.id === id);
        return [start?.pid, spawned?.agentPid].filter((value): value is number => Number.isInteger(value) && value > 0);
    };
    // 临时任务结束后进程必须都退出，否则第二次启动删不掉临时公共目录。
    const waitDead = async (pids: number[]) => {
        if ((await pollUntil(async () => !(await registry.platform.processes(pids)).length, 10000)).ok)
            return;
        throw Error('清空列表的临时任务结束后进程仍未退出');
    };
    // UI02 空状态刚把 runs.jsonl 写回原样，先读回清单再清点数量。
    await registry.refresh();
    await press('[data-page=tasks]');
    await wait('!!document.querySelector("[data-task]")');
    let longId = '';
    const longPids: number[] = [], againPids: number[] = [];
    try {
        // 派一个持续一分钟的假任务当"进行中"：确认后任务页要只剩进行中的任务，清空第二次才显示"列表已经是空的"。
        await writeConfig(60000);
        longId = await dispatch('clear-lists-run');
        await untilRow(async () => (await rows()).find(r => r.event === 'start' && r.id === longId), '清空列表用的进行中任务 start');
        await untilRow(async () => (await rows()).find(r => r.event === 'spawned' && r.id === longId && Number.isInteger(r.agentPid)), '清空列表用的进行中任务 spawned');
        longPids.push(...await pidsOf(longId));
        await registry.refresh();

        // 列表一节在"数据"一节之前：标题、说明、两行两按钮。
        await press('[data-page=settings]');
        await wait('!!document.querySelector("[data-pref=clear-tasks]")');
        await check('UI20 设置页"列表"一节在"数据"一节之前，含清空任务列表与清空项目列表两行两按钮', `(() => {
            const titles = [...document.querySelectorAll(".sect h2")].map(x => x.textContent);
            const set = document.querySelector("[data-pref=clear-tasks]")?.closest(".set");
            return titles.includes("列表") && titles.indexOf("列表") < titles.indexOf("数据") && titles.at(-1) === "数据"
                && !!document.querySelector("[data-pref=clear-projects]")
                && set?.querySelectorAll(".set-r").length === 2
                && !!set?.querySelector("[data-pref=clear-tasks]") && !!set?.querySelector("[data-pref=clear-projects]");
        })()`);
        await evaluate('document.querySelector("[data-pref=clear-tasks]").scrollIntoView({block:"center"})');
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await save(`settings-lists-${theme}`); }
        nativeTheme.themeSource = 'dark';

        // UI12 让 t1 结束时演示的假派发进程（tools/demo 的子进程）还活着；真实任务结束时派发进程会退出。
        // hideFinished 的"派发进程仍存活的不动"会跳过它，确认框数量、结果说明与"只剩进行中"都会对不上。
        // 先把已结束任务留下的假派发进程收掉（核对身份再结束：时间对不上的 PID 复用不会被认成派发进程），
        // 恢复成正常结束的样子。只动隔离演示自己的假派发进程，不停任何真实执行者。
        const leftover = registry.tasks.filter(t => t.status !== 'run' && t.pid);
        const alive = await registry.platform.processes(leftover.map(t => t.pid));
        for (const t of leftover)
            if (dispatchMatches(alive.find(x => x.pid === t.pid), t.started))
                await registry.platform.killTree(t.pid).catch(() => { });
        // 清空任务列表：确认框数量=打开时会清掉的已结束任务数，默认焦点在取消，确认按钮是危险样式。
        const finished = registry.tasks.filter(t => t.status !== 'run');
        assert.ok(finished.length > 0, '清空任务列表需要有已结束任务');
        const records = finished.flatMap(t => [t.progress, t.report]).filter((file): file is string => typeof file === 'string' && existsSync(file));
        const runsBefore = await readFile(registry.file, 'utf8');
        await press('[data-pref=clear-tasks]');
        await wait('!!document.querySelector(".confirm-card")', 'UI20 清空任务列表确认框');
        await check('UI20 清空任务列表确认框标题与正文写明数量，默认焦点在取消，确认按钮是危险样式', `(() => {
            const buttons = [...document.querySelectorAll(".confirm-actions button")];
            return document.querySelector("#confirm-title")?.textContent === ${JSON.stringify(p.clearTasksTitle(finished.length))}
                && document.querySelector("#confirm-body")?.textContent === ${JSON.stringify(p.clearTasksBody(finished.length))}
                && document.activeElement?.textContent === "取消"
                && buttons.length === 2 && buttons[0].textContent === "取消" && buttons[1].textContent === ${JSON.stringify(p.clearConfirm)} && buttons[1].classList.contains("danger");
        })()`);
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await save(`clear-tasks-dialog-${theme}`); }
        nativeTheme.themeSource = 'dark';
        await press('.confirm-actions button:last-of-type');
        await wait(`document.querySelector("[data-tasks-note]")?.textContent === ${JSON.stringify(p.tasksCleared(finished.length))}`, 'UI20 清空任务列表结果说明');
        await check('UI20 确认清空任务列表后行内显示移除数量', `document.querySelector("[data-tasks-note]")?.textContent === ${JSON.stringify(p.tasksCleared(finished.length))}`);
        await verify('UI20 清空任务列表不删任务记录文件、不改 runs.jsonl', async () => {
            assert.equal(await readFile(registry.file, 'utf8'), runsBefore, 'runs.jsonl 不该被改动');
            for (const file of records) assert.ok(existsSync(file), `记录文件应该还在：${path.basename(file)}`);
        });
        await press('[data-page=tasks]');
        await wait(`!!document.querySelector("[data-task=${longId}]")`, 'UI20 清空后进行中的任务行');
        await press('[data-filter=all]');
        await check('UI20 确认清空任务列表后任务页只剩进行中的任务', `window.dock.snapshot().then(s => s.tasks.length > 0 && s.tasks.every(t => t.status === "run") && s.tasks.some(t => t.id === ${JSON.stringify(longId)}) && document.querySelectorAll("[data-task]").length === s.tasks.length)`);

        // 数量为 0 时不弹确认框，行内显示"列表已经是空的"。
        await press('[data-page=settings]');
        await wait('!!document.querySelector("[data-pref=clear-tasks]")');
        // 按钮在页面底部：命中测试的 scrollIntoView 会被吸顶页头挡到时先居中（同 captureDataAndReset）。
        await evaluate('document.querySelector("[data-pref=clear-tasks]").scrollIntoView({block:"center"})');
        await press('[data-pref=clear-tasks]');
        await wait(`document.querySelector("[data-tasks-note]")?.textContent === ${JSON.stringify(p.listEmpty)}`, 'UI20 清空任务列表空清单说明');
        await check('UI20 清空任务列表没有可清的任务时不弹确认框，行内显示"列表已经是空的"', `!document.querySelector(".confirm-card") && document.querySelector("[data-tasks-note]")?.textContent === ${JSON.stringify(p.listEmpty)}`);

        // 清空后新派发的任务照常出现在列表。
        await writeConfig(150);
        const againId = await dispatch('clear-lists-again');
        await untilRow(async () => (await rows()).find(r => r.event === 'start' && r.id === againId), '清空后新任务 start');
        againPids.push(...await pidsOf(againId));
        await registry.refresh();
        await press('[data-page=tasks]');
        await wait(`!!document.querySelector("[data-task=${againId}]")`, 'UI20 清空后新派发的任务行');
        await check('UI20 清空任务列表后新派发的任务照常出现在列表', `!!document.querySelector("[data-task=${againId}]")`);
        await untilRow(async () => (await rows()).find(r => r.event === 'end' && r.id === againId), '清空后新任务结束', 15000);

        // 清空项目列表：确认框数量=登记项目数，确认后项目页为空、新建任务页没有项目可选、项目文件夹还在。
        const registered = (JSON.parse(await readFile(projectsFile, 'utf8')).projects ?? []) as { path: string }[];
        const paths = registered.map(x => x.path), count = paths.length;
        assert.ok(count > 0, '清空项目列表需要有已登记项目');
        await press('[data-page=settings]');
        await wait('!!document.querySelector("[data-pref=clear-projects]")');
        await evaluate('document.querySelector("[data-pref=clear-projects]").scrollIntoView({block:"center"})');
        await press('[data-pref=clear-projects]');
        await wait('!!document.querySelector(".confirm-card")', 'UI20 清空项目列表确认框');
        await check('UI20 清空项目列表确认框标题与正文写明数量，默认焦点在取消，确认按钮是危险样式', `(() => {
            const buttons = [...document.querySelectorAll(".confirm-actions button")];
            return document.querySelector("#confirm-title")?.textContent === ${JSON.stringify(p.clearProjectsTitle(count))}
                && document.querySelector("#confirm-body")?.textContent === ${JSON.stringify(p.clearProjectsBody(count))}
                && document.activeElement?.textContent === "取消"
                && buttons.length === 2 && buttons[0].textContent === "取消" && buttons[1].textContent === ${JSON.stringify(p.clearConfirm)} && buttons[1].classList.contains("danger");
        })()`);
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await save(`clear-projects-dialog-${theme}`); }
        nativeTheme.themeSource = 'dark';
        await press('.confirm-actions button:last-of-type');
        await wait(`document.querySelector("[data-projects-note]")?.textContent === ${JSON.stringify(p.projectsCleared(count))}`, 'UI20 清空项目列表结果说明');
        await check('UI20 确认清空项目列表后行内显示取消登记数量', `document.querySelector("[data-projects-note]")?.textContent === ${JSON.stringify(p.projectsCleared(count))}`);
        await verify('UI20 清空项目列表不动项目文件夹与其中文件', () => {
            for (const dir of paths) assert.ok(existsSync(dir), '项目文件夹应该还在');
        });
        await press('[data-page=projects]');
        await wait('!!document.querySelector(".empty.tall")', 'UI20 清空项目列表后项目页空状态');
        await check('UI20 清空项目列表后项目页显示空状态和"添加第一个项目"', `document.querySelector('.empty.tall b')?.textContent === ${JSON.stringify(pj.empty)} && !!document.querySelector('.empty.tall [data-pj=add]')`);
        await press('[data-page=newtask]');
        await wait('!!document.querySelector(".empty.tall")', 'UI20 清空项目列表后新建任务页空状态');
        await check('UI20 清空项目列表后新建任务页没有项目可选', `!document.querySelector('[data-nt-project]') && document.querySelector('.empty.tall b')?.textContent === ${JSON.stringify(nt.noProject)}`);

        // 数量为 0 时不弹确认框，行内显示"列表已经是空的"。
        await press('[data-page=settings]');
        await wait('!!document.querySelector("[data-pref=clear-projects]")');
        await evaluate('document.querySelector("[data-pref=clear-projects]").scrollIntoView({block:"center"})');
        await press('[data-pref=clear-projects]');
        await wait(`document.querySelector("[data-projects-note]")?.textContent === ${JSON.stringify(p.listEmpty)}`, 'UI20 清空项目列表空清单说明');
        await check('UI20 清空项目列表没有可清的项目时不弹确认框，行内显示"列表已经是空的"', `!document.querySelector(".confirm-card") && document.querySelector("[data-projects-note]")?.textContent === ${JSON.stringify(p.listEmpty)}`);

        // 重新"添加项目"能加回来（也把后面「再派一次」需要的登记恢复回来）。
        await press('[data-page=projects]');
        await wait('!!document.querySelector(".empty.tall [data-pj=add]")', 'UI20 清空项目列表后项目页空状态按钮');
        effects.folders.push(repo);
        await press('.empty.tall [data-pj=add]');
        await wait(`[...document.querySelectorAll('[data-pj-row]')].some(x => x.dataset.pjRow === ${JSON.stringify(repo)})`, 'UI20 重新添加的项目行', 20000);
        await check('UI20 清空项目列表后重新"添加项目"能加回来', `[...document.querySelectorAll('[data-pj-row]')].some(x => x.dataset.pjRow === ${JSON.stringify(repo)})`);
    }
    finally {
        // 无论检查是否通过都收尾：临时任务的进程必须都退出，再把夹具恢复成检查前的内容。
        if (longId)
            await registry.stop(longId).catch(() => { });
        await waitDead([...longPids, ...againPids]).catch(error => console.warn(String(error)));
        if (originalTasks === null)
            await rm(tasksFile, { force: true });
        else
            await writeFile(tasksFile, originalTasks);
        await registry.reloadHidden();
        if (originalProjects === null)
            await rm(projectsFile, { force: true });
        else
            await writeFile(projectsFile, originalProjects);
        if (originalConfig === null)
            await rm(configFile, { force: true });
        else
            await writeFile(configFile, originalConfig);
        nativeTheme.themeSource = 'dark';
    }
}

// 第二次启动（AR_SHOTS_RESET=1）：走界面完成一次真实重置。配置、密钥与技能都由 tools/shots.mjs 预先放在隔离目录里；
// 确认后主进程删除前会记录证据（reset-evidence.json），本函数等它出现再返回（软件随后自己退出）。
export async function captureReset(win: BrowserWindow, _registry: Registry, out: string) {
    win.webContents.setBackgroundThrottling(false);
    win.webContents.focus();
    const h = createHarness(win, async () => {});
    const { press, wait, check, verify } = h;
    // 界面由渲染层的 preferences.init() 挂载，loadFile 返回时导航可能还没渲染出来；先等侧栏入口出现。
    await wait('!!document.querySelector("[data-page=settings]")', '重置启动：界面已挂载', 20000);
    await press('[data-page=settings]');
    await wait('!!document.querySelector("[data-pref=reset-app]")');
    await press('[data-pref=reset-app]');
    await wait('!!document.querySelector("[data-reset-home]")', 'UI20 重置确认框');
    await check('UI20 重置确认框列出密钥选项与变量名', 'document.querySelector("[data-reset-check=secrets]")?.textContent.includes("DEEPSEEK_API_KEY")');
    await verify('UI20 重置确认框默认焦点在"取消"（未确认前不删除）', async () => {
        const active = await h.evaluate('document.activeElement?.textContent');
        assert.equal(active, '取消');
        assert.equal(existsSync(path.join(out, 'reset-evidence.json')), false);
    });
    await press('[data-reset-check=secrets]');
    await check('UI20 勾选"同时删除密钥环境变量"', 'document.querySelector("[data-reset-check=secrets]").getAttribute("aria-checked")==="true"');
    await press('[data-reset-check=skills]');
    await check('UI20 勾选"同时卸载技能"', 'document.querySelector("[data-reset-check=skills]").getAttribute("aria-checked")==="true"');
    await press('.sheet-btns button:last-of-type');
    // 主进程完成删除准备（密钥、技能、标记、证据）后才退出；等证据文件出现即可确认没有半途退出。
    const written = (await pollUntil(() => existsSync(path.join(out, 'reset-evidence.json')), 30000)).ok;
    assert.ok(written, '重置没有写入 reset-evidence.json');
    console.log('UI20 已在隔离公共目录上确认重置，等待软件退出后由外部检查删除结果。');
}

async function prepareManagedExit(registry: Registry): Promise<ExitCheck> {
    const home = appEnv.AGENT_ROUTER_HOME!, node = process.env.AR_TEST_NODE!;
    assert.ok(path.isAbsolute(node) && /^node(?:\.exe)?$/i.test(path.basename(node)));
    const repo = path.join(home, 'managed-exit-repo'), agent = path.join(home, 'managed-exit-agent.cjs');
    const ready = path.join(home, 'managed-exit-agent.json');
    // 假 agent 不再定时自己结束：写完 ready 与一条消息后等外部放行文件（见 tools/shots.mjs 的退出后实测），
    // 这样"托管任务就绪 → Electron 退出"无论花多久，检查存活时它都还在；等待上限 120 秒，超时非 0 退出让 end.exit=0 如实失败。
    const release = path.join(home, 'managed-exit-release');
    await rm(release, { force: true });
    await mkdir(repo, { recursive: true });
    await writeFile(agent, `const fs=require('node:fs');if(process.argv.includes('--version')){console.log('codex-cli fake-exit');process.exit(0);}process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'正在验证软件退出后的托管任务'}}));const started=Date.now();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'隔离任务完成');process.exit(0);}else if(Date.now()-started>=120000){clearInterval(timer);process.stderr.write('托管任务的假 agent 等待放行超时（120 秒）\\n');process.exit(2);}},100);});`);
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ v: 1, managed: true, watchWindow: 'never', agents: { codex: { path: agent } } }));
    const script = path.join(appEnv.CLAUDE_CONFIG_DIR!, 'skills/agent-router/core/ar.mjs');
    const waiterLog = 'managed-exit-waiter.log';
    const output = await open(path.join(home, waiterLog), 'w');
    try {
        const waiter = spawn(node, [script, '验证软件退出', '--name', 'managed-exit'], { cwd: repo, env: appEnv, detached: true, stdio: ['ignore', output.fd, output.fd], shell: false, windowsHide: true });
        await new Promise<void>((resolve, reject) => { waiter.once('spawn', resolve); waiter.once('error', reject); });
        waiter.unref();
    } finally { await output.close(); }
    // 上限 5 秒（原来按 100 次 × 50 ms 轮询计）。
    const managedDeadline = clock() + 5000;
    while (clock() < managedDeadline) {
        await registry.refresh();
        const task = registry.tasks.find(t => t.name === 'managed-exit');
        const running = await readFile(ready, 'utf8').then(JSON.parse).catch(() => null);
        if (task?.managed && task.status === 'run' && running?.pid) {
            // 写 exit-pending.json 之前确认两项都还在运行，并记下进程身份（名字 + 创建时间）。
            return { label: '托管任务', id: task.id, executor: task.pid, agent: running.pid, waiterLog, readyAt: Date.now(), processes: await runningExitProcesses(registry, '托管任务', task.id, [task.pid, running.pid]), release };
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('真实软件未能认领隔离托管任务');
}
