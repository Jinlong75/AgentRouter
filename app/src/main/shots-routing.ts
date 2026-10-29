import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { nativeTheme, type BrowserWindow } from 'electron';
import { c, ro, rv, wt as w } from '../shared/copy';
import type { Harness } from './shots-input';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
const jsonStr = JSON.stringify;

// UI27 路由页（Stage07 T8）：规则、兜底、试算、每日上限、审查者候选。
// 全部用真实输入（press / key / type / tabTo）；每一步都读隔离公共目录里的 config.json 断言真的写进去了，
// 试算与核心的 ar route --explain 对照；用测试自己写的执行者配置（假执行者），结束时恢复配置、清单与项目登记。
export async function captureRouting(h: Harness, win: BrowserWindow) {
    const { evaluate, wait, check, verify, press, key, type, tabTo, focusRing, pause, save } = h;
    // 119：打开渲染层追踪（routing.ts 的 route-write 事件）；不清空已有事件。
    await evaluate('document.documentElement.dataset.arTrace = "1"; window.__arTrace ??= []; true');
    const home = appEnv.AGENT_ROUTER_HOME!;
    const temp = path.resolve(os.tmpdir()).toLowerCase();
    assert.ok(home && path.isAbsolute(home) && path.resolve(home).toLowerCase().startsWith(temp), '截图验收必须在隔离公共目录里运行');
    const configFile = path.join(home, 'config.json'), runsFile = path.join(home, 'runs.jsonl');
    const originalConfig = await readFile(configFile, 'utf8').catch(() => null);
    const original = { size: win.getContentSize(), theme: nativeTheme.themeSource };
    const MARK = 'ui27-limit', ROUTED = 'ui27-routed', MARK31 = 'ui31-review';
    const projectDir = path.join(home, 'shots-routing', 'rules-project');
    let registered = false;
    // 151：agent-tests.json 原来的内容（undefined 是还没动过；null 是原来没有这个文件）。
    let originalTests: string | null | undefined;

    // 执行者：假执行者两个、一个停用的、一个没有只读参数的通用执行者（不支持只读）。
    const fake = (label: string, extra: Record<string, unknown> = {}) => ({ adapter: 'fake', label, enabled: true, events: [], report: 'OK\n', exit: 0, delayMs: 0, version: 'fake-agent 1.0', ...extra });
    const base = {
        v: 2, defaultProfile: 'alpha', managed: false, watchWindow: 'never',
        profiles: { alpha: fake('Alpha 执行者'), beta: fake('Beta 阅读者'), gamma: fake('Gamma 停用', { enabled: false }), plain: { adapter: 'generic', generic: 'plain', label: 'Plain 通用', enabled: true } },
        routing: { rules: [], fallback: null, reviewer: null },
    };
    const readConfig = async () => JSON.parse(await readFile(configFile, 'utf8'));
    // 与路由无关的字段必须原样保留：把 routing 与各执行者的 limits 去掉再比。
    const rest = (cfg: any) => ({ ...cfg, routing: undefined, profiles: Object.fromEntries(Object.entries(cfg.profiles).map(([k, v]: [string, any]) => [k, { ...v, limits: undefined }])) });
    const core = async (args: string[], cwd?: string) => {
        const r = await coreRun(args, { timeoutMs: 60000, cwd });
        assert.equal(r.code, 0, `ar ${args.join(' ')}：${r.stderr || r.json?.error}`);
        assert.equal(r.json?.ok, true, `ar ${args.join(' ')}：${r.json?.error}`);
        return r.json;
    };
    // 与界面试算同一条核心命令（不限项目时在系统临时目录里运行）。
    const route = async (type: string, project?: string) => (await coreRun(['route', '--type', type, ...(project ? ['--project', project] : []), '--explain'], { timeoutMs: 60000, cwd: project ?? os.tmpdir() })).json;
    // 界面上的改动先改本地、再按顺序写核心（即时写入）：读 config.json 的断言要等写入落盘，最多等 8 秒，期间断言一直失败才算失败。
    const settled = (label: string, fn: () => Promise<void> | void) => verify(label, async () => {
        const end = Date.now() + 8000;
        for (;;) {
            try { await fn(); return; }
            catch (error) { if (Date.now() > end) throw await withDiagnosis(error); await pause(150); }
        }
    });
    // 119：最后一次断言失败时才采的现场（不改判断、不重试、不改 8 秒上限）：路由页写入队列的追踪、错误横幅、界面上此刻的规则顺序，
    // 再加最近 30 秒的核心调用（含 route:rules 的收到 / 返回 / 用时 / 结果）与核心进程。
    const withDiagnosis = async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const page = await evaluate(`JSON.stringify((() => {
            const events = (window.__arTrace ?? []).filter(e => e.event === 'route-write');
            const count = phase => events.filter(e => e.phase === phase).length;
            return {
                queue: { queued: count('queued'), call: count('call'), done: count('done'), error: count('error'), pendingNow: events.length ? events[events.length - 1].pending : null },
                writes: events.slice(-12).map(e => e.phase + ' ' + e.action + ' pending=' + e.pending + (e.error ? ' error=' + String(e.error).slice(0, 200) : '') + ' @-' + (Date.now() - e.at) + 'ms'),
                errorBanner: [...document.querySelectorAll('.banner.fail')].map(b => (b.textContent || '').trim().slice(0, 200)),
                rulesOnScreen: [...document.querySelectorAll('[data-ro-rule]')].map(r => r.querySelector('.ro-types')?.textContent ?? '?'),
            };
        })())`).catch((e: Error) => `读取路由页状态失败：${e.message}`);
        const scene = await h.scene().catch((e: Error) => `现场采集失败：${e.message}`);
        return Error(`${message}\n路由页状态：${page}\n${scene}`, { cause: error });
    };
    const menuItem = async (label: string) => {
        const index = await evaluate(`(() => { const items = [...document.querySelectorAll('.ctx button')]; items.forEach((b, i) => b.setAttribute('data-menu-index', String(i))); return items.findIndex(b => b.textContent.trim() === ${jsonStr(label)}); })()`);
        assert.ok(index >= 0, `菜单里没有「${label}」`);
        return `.ctx button[data-menu-index="${index}"]`;
    };
    const menuLabels = async () => JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.ctx button')].map(b => b.textContent.trim()))`)) as string[];
    const pick = async (opener: string, label: string) => {
        await press(opener);
        await wait('!!document.querySelector(".ctx")', `UI27 打开下拉 ${opener}`);
        await press(await menuItem(label));
        await wait('!document.querySelector(".ctx")', `UI27 选择「${label}」后下拉关闭`);
    };
    // 深浅各截一张，再切一个最小窗口（960×600）深浅各截一张，然后回到默认大小与深色。
    const shot = async (name: string, narrow = true) => {
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await pause(350); await save(`${name}-${theme}`); }
        if (narrow) {
            win.setContentSize(960, 600);
            await pause(500);
            for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await pause(350); await save(`${name}-min-${theme}`); }
            win.setContentSize(original.size[0], original.size[1]);
            await pause(500);
        }
        nativeTheme.themeSource = 'dark';
        await pause(300);
    };
    // 截图前把要看的那一节滚到页头下面（真实滚动位置，截图里才看得到）。
    const reveal = (name: string) => evaluate(`document.querySelector('[data-ro-sec="${name}"]').scrollIntoView({ block: 'start' }); true`);
    const ready = '!!document.querySelector("[data-ro-ready=\\"1\\"]")';
    // 每次进入页面都重新读取：先去任务页再回来。
    const enter = async (label = 'UI27 进入路由页') => {
        await press('[data-page=tasks]');
        await wait('!!document.querySelector("[data-task]")');
        await press('[data-page=routing]');
        await wait(ready, label);
        await wait('!!document.querySelector("[data-ro-trial-result]")', `${label}：试算结果出现`);
    };
    // 试算结果：执行者配置名、说明文字、trace 各行。
    const trialNow = async () => JSON.parse(await evaluate(`JSON.stringify((() => { const r = document.querySelector('[data-ro-trial-result]'); return { profile: r?.dataset.roTrialProfile ?? null, failed: r?.dataset.roFailed === '1', text: r?.textContent ?? '', trace: [...document.querySelectorAll('[data-ro-trace] li')].map(li => li.textContent) }; })())`)) as { profile: string | null; failed: boolean; text: string; trace: string[] };
    const waitTrial = async (profile: string, label: string) => wait(`document.querySelector('[data-ro-trial-result]')?.dataset.roTrialProfile === ${jsonStr(profile)}`, label);
    const sheetOpen = async (label: string) => wait('!!document.querySelector(".sheet [data-ro-type]")', label);

    try {
        win.setContentSize(1160, 720);
        nativeTheme.themeSource = 'dark';
        await writeFile(configFile, JSON.stringify(base, null, 2) + '\n');
        await mkdir(path.join(projectDir, '.agent-router'), { recursive: true });
        await writeFile(path.join(projectDir, '.agent-router', 'project.json'), JSON.stringify({ v: 1, name: 'rules-project', routing: { rules: [{ types: ['docs'], profile: 'alpha' }] } }, null, 2) + '\n');
        await core(['projects', 'add', projectDir, '--allow-non-git']);
        registered = true;

        // ---- 侧栏入口与空状态 ----
        await press('[data-page=routing]');
        await wait(ready, 'UI27 路由页加载完成');
        await wait('!!document.querySelector("[data-ro-trial-result]")', 'UI27 试算结果出现');
        await check('UI27 侧栏"配置"组里 Agent 下面是"路由"（文字 ro.nav，图标 route-line），点击后高亮当前页', `(() => { const b = document.querySelector('[data-page=routing]'), prev = b.previousElementSibling; return b.textContent.trim() === ${jsonStr(ro.nav)} && !!b.querySelector('i.ri-route-line') && prev?.getAttribute('data-page') === 'connect' && b.getAttribute('aria-current') === 'page' && document.querySelectorAll('[data-page][aria-current=page]').length === 1; })()`);
        await check('UI27 页面从上到下：规则 → 兜底 → 试算 → 每日上限 → 审查者候选，标题栏是 ro.title / ro.lead，没有保存按钮（设置类改动即时写入）', `(() => { const h = document.querySelector('.page-h.sticky'); const titles = [...document.querySelectorAll('[data-ro-sec] > h2')].map(e => e.textContent); return h.querySelector('h1').textContent === ${jsonStr(ro.title)} && h.querySelector('.lead').textContent === ${jsonStr(ro.lead)} && titles.join() === ${jsonStr([ro.rulesSec, ro.fallbackSec, ro.trialSec, ro.limitsSec, ro.reviewSec].join())} && !document.querySelector('.actbar, .settings-footer, .card-f'); })()`);
        await check('UI27 没有规则时是空状态：标题 ro.emptyTitle、说明 ro.emptyHelp(默认执行者)、主按钮"添加第一条规则"；标题栏没有"添加规则"', `(() => { const e = document.querySelector('[data-ro-sec=rules] .empty'); return e.querySelector('b').textContent === ${jsonStr(ro.emptyTitle)} && e.querySelector('p').textContent === ${jsonStr(ro.emptyHelp('Alpha 执行者'))} && e.querySelector('[data-ro-add-first]').classList.contains('primary') && e.querySelector('[data-ro-add-first]').textContent.trim() === ${jsonStr(ro.addFirst)} && !document.querySelector('[data-ro-add]'); })()`);
        const first = await trialNow();
        await settled('UI27 没有规则时试算 code：用默认执行者 alpha，说明是"兜底"，过程与核心 ar route --explain 一致', async () => {
            const expected = await route('code');
            assert.equal(expected.profile, 'alpha');
            assert.equal(first.profile, 'alpha');
            assert.deepEqual(first.trace, expected.trace);
            assert.ok(first.text.includes(ro.trialResult('Alpha 执行者')) && first.text.includes(`（${ro.whyFallback}）`), first.text);
        });
        await shot('ui27-routing-empty');

        // ---- 添加第一条规则：必须选类型；调研只能选支持只读的执行者 ----
        await press('[data-ro-add-first]');
        await sheetOpen('UI27 添加规则弹窗');
        await check('UI27 添加规则弹窗：标题 ro.ruleSheetAdd、底部说明 ro.ruleNote、七个任务类型切换按钮（aria-pressed 全为 false）、按钮"取消 / 添加"', `(() => { const s = document.querySelector('.sheet'); const t = [...s.querySelectorAll('[data-ro-type]')]; return s.getAttribute('aria-label') === ${jsonStr(ro.ruleSheetAdd)} && s.querySelector('.sheet-f .note').textContent === ${jsonStr(ro.ruleNote)} && t.map(b => b.dataset.roType).join() === 'code,test,fix,refactor,research,docs,review' && t.map(b => b.textContent).join() === ${jsonStr(Object.values(ro.types).join())} && t.every(b => b.getAttribute('aria-pressed') === 'false') && [...s.querySelectorAll('.sheet-btns button')].map(b => b.textContent.trim()).join() === '取消,${ro.ruleAdd}'; })()`);
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector("[data-ro-types-hint]").hidden', 'UI27 没选类型时点添加：出现提示');
        await check('UI27 没选类型就点"添加"：提示 ro.ruleTypesRequired，弹窗不关', `document.querySelector('[data-ro-types-hint]').textContent === ${jsonStr(ro.ruleTypesRequired)} && !!document.querySelector('.sheet')`);
        await pause(600);
        await settled('UI27 没选类型时不写配置：routing.rules 仍是空', async () => { assert.deepEqual((await readConfig()).routing.rules, []); });
        await save('ui27-routing-add-required-dark');
        await press('[data-ro-type=research]');
        await check('UI27 选了调研：该按钮 aria-pressed 为 true 且是选中样式，提示消失', `(() => { const b = document.querySelector('[data-ro-type=research]'); return b.getAttribute('aria-pressed') === 'true' && b.classList.contains('on') && document.querySelector('[data-ro-types-hint]').hidden; })()`);
        await press('[data-ro-sheet-profile]');
        await wait('!!document.querySelector(".ctx")', 'UI27 执行者下拉');
        await settled('UI27 选了调研后执行者下拉只列支持只读的执行者（没有停用的、没有 Plain 通用）', async () => { assert.deepEqual(await menuLabels(), ['Alpha 执行者', 'Beta 阅读者']); });
        await press(await menuItem('Beta 阅读者'));
        await check('UI27 选中 Beta 阅读者，升级到默认是"不升级"', `document.querySelector('[data-ro-sheet-profile] span').textContent === 'Beta 阅读者' && document.querySelector('[data-ro-sheet-esc] span').textContent === ${jsonStr(ro.noEsc)}`);
        await save('ui27-routing-add-dark');
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector(".sheet") && !!document.querySelector("[data-ro-rule=\\"0\\"]")', 'UI27 添加后弹窗关闭、出现第 1 条规则');
        await settled('UI27 config.json 的 routing.rules 变成这一条（调研 → beta），其余字段原样保留', async () => {
            const after = await readConfig();
            assert.deepEqual(after.routing.rules, [{ types: ['research'], profile: 'beta' }]);
            assert.deepEqual(after.routing.fallback, null);
            assert.deepEqual(rest(after), rest(base));
        });
        await enter('UI27 重新进入页面');
        await check('UI27 重新进入页面后第 1 条规则仍在：编号 1、类型"调研"、执行者 Beta 阅读者、不升级；标题栏出现"添加规则"', `(() => { const r = document.querySelector('[data-ro-rule="0"]'); return r.querySelector('.ro-n').textContent === '1' && [...r.querySelectorAll('.ro-types .tag')].map(t => t.textContent).join() === ${jsonStr(ro.types.research)} && r.querySelector('.ro-to b').textContent === 'Beta 阅读者' && r.querySelector('.ro-esc').textContent === ${jsonStr(ro.noEsc)} && !!document.querySelector('.page-h [data-ro-add]'); })()`);

        // ---- 再加规则、编辑 ----
        await press('.page-h [data-ro-add]');
        await sheetOpen('UI27 添加第 2 条规则');
        for (const t of ['code', 'test', 'fix']) await press(`[data-ro-type=${t}]`);
        await check('UI27 没选调研 / 审查时执行者默认是默认执行者 alpha', `document.querySelector('[data-ro-sheet-profile] span').textContent === 'Alpha 执行者'`);
        await pick('[data-ro-sheet-esc]', 'Beta 阅读者');
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector(".sheet") && !!document.querySelector("[data-ro-rule=\\"1\\"]")', 'UI27 第 2 条规则出现');
        await settled('UI27 第 2 条规则写入：[code, test, fix] → alpha，升级到 beta；第 1 条不变', async () => {
            assert.deepEqual((await readConfig()).routing.rules, [{ types: ['research'], profile: 'beta' }, { types: ['code', 'test', 'fix'], profile: 'alpha', escalate: 'beta' }]);
        });
        await check('UI27 第 2 条规则一行：三个类型 tag、执行者 Alpha 执行者、升级到 ro.escTo(Beta 阅读者)', `(() => { const r = document.querySelector('[data-ro-rule="1"]'); return [...r.querySelectorAll('.ro-types .tag')].map(t => t.textContent).join() === ${jsonStr([ro.types.code, ro.types.test, ro.types.fix].join())} && r.querySelector('.ro-to b').textContent === 'Alpha 执行者' && r.querySelector('.ro-esc').textContent === ${jsonStr(ro.escTo('Beta 阅读者'))}; })()`);
        // 编辑第 1 条：加上"审查"，保存；编辑弹窗预选原值。
        await press('[data-ro-act=edit][data-ro-i="0"]');
        await sheetOpen('UI27 编辑第 1 条规则');
        await check('UI27 编辑弹窗：标题 ro.ruleSheetEdit(1)、预选调研与 Beta 阅读者、主按钮"保存"、没有"加在最后"的说明', `(() => { const s = document.querySelector('.sheet'); return s.getAttribute('aria-label') === ${jsonStr(ro.ruleSheetEdit(1))} && [...s.querySelectorAll('[data-ro-type][aria-pressed=true]')].map(b => b.dataset.roType).join() === 'research' && s.querySelector('[data-ro-sheet-profile] span').textContent === 'Beta 阅读者' && s.querySelector('[data-sheet-btn="1"]').textContent.trim() === ${jsonStr(ro.ruleSave)} && s.querySelector('.sheet-f .note').textContent === ''; })()`);
        await press('[data-ro-type=review]');
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector(".sheet")', 'UI27 保存后弹窗关闭');
        await settled('UI27 编辑只替换第 1 条：类型变成 [research, review]，规则总数不变，第 2 条不变', async () => {
            assert.deepEqual((await readConfig()).routing.rules, [{ types: ['research', 'review'], profile: 'beta' }, { types: ['code', 'test', 'fix'], profile: 'alpha', escalate: 'beta' }]);
        });
        // 第 3 条：与第 2 条都含 code，顺序才有意义。
        await press('.page-h [data-ro-add]');
        await sheetOpen('UI27 添加第 3 条规则');
        for (const t of ['code', 'docs']) await press(`[data-ro-type=${t}]`);
        await pick('[data-ro-sheet-profile]', 'Beta 阅读者');
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector(".sheet") && !!document.querySelector("[data-ro-rule=\\"2\\"]")', 'UI27 第 3 条规则出现');

        // ---- 上移 / 下移：用键盘；试算跟着变 ----
        await check('UI27 第一条的上移、最后一条的下移禁用；四个按钮的 aria-label 是 ro.moveUp / moveDown / edit / remove', `(() => { const b = (a, i) => document.querySelector('[data-ro-act=' + a + '][data-ro-i="' + i + '"]'); return b('up', 0).disabled && !b('up', 1).disabled && b('down', 2).disabled && !b('down', 1).disabled && b('up', 1).getAttribute('aria-label') === ${jsonStr(ro.moveUp(2))} && b('down', 1).getAttribute('aria-label') === ${jsonStr(ro.moveDown(2))} && b('edit', 1).getAttribute('aria-label') === ${jsonStr(ro.edit(2))} && b('delete', 1).getAttribute('aria-label') === ${jsonStr(ro.remove(2))}; })()`);
        await waitTrial('alpha', 'UI27 试算 code：规则 2（alpha）');
        await settled('UI27 上移前试算 code → alpha（全局规则 2），与核心一致', async () => {
            const expected = await route('code'), now = await trialNow();
            assert.equal(expected.profile, 'alpha');
            assert.deepEqual(now.trace, expected.trace);
            assert.ok(now.text.includes(`（${ro.whyRule(ro.scopeGlobal, 2, [ro.types.code, ro.types.test, ro.types.fix].join('、'))}）`), now.text);
        });
        await shot('ui27-routing-rules');
        const before = await readConfig();
        await tabTo('[data-ro-act=up][data-ro-i="2"]');
        await focusRing('UI27 第 3 条"上移"按钮的焦点环');
        await key('Enter');
        await wait(`document.querySelector('[data-ro-rule="1"] .ro-types')?.textContent.includes(${jsonStr(ro.types.docs)})`, 'UI27 上移后第 2 条变成含文档的规则');
        await settled('UI27 键盘上移第 3 条：config.json 里规则顺序变成 [1, 3, 2]，其余字段不变', async () => {
            const after = await readConfig();
            assert.deepEqual(after.routing.rules, [before.routing.rules[0], before.routing.rules[2], before.routing.rules[1]]);
            assert.deepEqual(rest(after), rest(before));
        });
        await check('UI27 上移后焦点跟着这一条走（第 2 条的"上移"按钮）', `document.activeElement === document.querySelector('[data-ro-act=up][data-ro-i="1"]')`);
        await waitTrial('beta', 'UI27 上移后试算 code 变成 beta');
        await settled('UI27 上移后试算 code → beta（全局规则 2），与核心一致', async () => {
            const expected = await route('code'), now = await trialNow();
            assert.equal(expected.profile, 'beta');
            assert.deepEqual(now.trace, expected.trace);
        });
        // 再用鼠标下移回去，确认两个方向都写入。
        await press('[data-ro-act=down][data-ro-i="1"]');
        await waitTrial('alpha', 'UI27 下移后试算 code 回到 alpha');
        await settled('UI27 鼠标下移：顺序回到 [1, 2, 3]', async () => { assert.deepEqual((await readConfig()).routing.rules, before.routing.rules); });

        // ---- 删除：不用确认 ----
        await press('[data-ro-act=delete][data-ro-i="2"]');
        await wait('!document.querySelector("[data-ro-rule=\\"2\\"]")', 'UI27 删除后只剩两条');
        await check('UI27 删除不弹确认框', '!document.querySelector(".confirm-overlay, .sheet")');
        await settled('UI27 删除第 3 条：config.json 少一条，剩下的原样', async () => { assert.deepEqual((await readConfig()).routing.rules, before.routing.rules.slice(0, 2)); });

        // ---- 兜底 ----
        await press('[data-ro-fallback]');
        await wait('!!document.querySelector(".ctx")', 'UI27 兜底下拉');
        await settled('UI27 兜底下拉：第一项"用默认执行者"，其余是各个启用的执行者', async () => { assert.deepEqual(await menuLabels(), [ro.fallbackNone, 'Alpha 执行者', 'Beta 阅读者', 'Plain 通用']); });
        await press(await menuItem('Beta 阅读者'));
        await wait(`document.querySelector('[data-ro-fallback] span')?.textContent === 'Beta 阅读者'`, 'UI27 兜底显示 Beta 阅读者');
        await settled('UI27 选中即写入：routing.fallback 是 beta，规则不变，其余字段不变', async () => {
            const after = await readConfig();
            assert.equal(after.routing.fallback, 'beta');
            assert.deepEqual(after.routing.rules, before.routing.rules.slice(0, 2));
            assert.deepEqual(rest(after), rest(before));
        });
        await check('UI27 兜底一行：标题 ro.fallback、说明 ro.fallbackHelp(默认执行者)', `(() => { const r = document.querySelector('[data-ro-sec=fallback] .set-r'); return r.querySelector('.l').firstChild.textContent === ${jsonStr(ro.fallback)} && r.querySelector('.l span').textContent === ${jsonStr(ro.fallbackHelp('Alpha 执行者'))}; })()`);
        // 试算一个没有规则的类型：走兜底。
        await pick('[data-ro-trial-type]', ro.types.refactor);
        await waitTrial('beta', 'UI27 试算 refactor 走兜底 beta');
        await settled('UI27 试算 refactor：没有规则符合，派给兜底 beta，说明是"兜底"，过程与核心一致', async () => {
            const expected = await route('refactor'), now = await trialNow();
            assert.deepEqual(expected.trace, ['兜底：beta']);
            assert.deepEqual(now.trace, expected.trace);
            assert.ok(now.text.includes(`（${ro.whyFallback}）`), now.text);
        });
        await pick('[data-ro-fallback]', ro.fallbackNone);
        await waitTrial('alpha', 'UI27 清除兜底后试算 refactor 回到默认执行者');
        await settled('UI27 选"用默认执行者"清除兜底：routing.fallback 是 null', async () => { assert.equal((await readConfig()).routing.fallback, null); });
        await pick('[data-ro-fallback]', 'Beta 阅读者');
        await pick('[data-ro-trial-type]', ro.types.code);

        // ---- 试算按项目：项目自己的规则排在全局规则前面 ----
        await enter('UI27 重新进入页面（项目规则）');
        await check('UI27 有项目规则时规则下面显示一行 ro.projectRules(项目名, 条数)', `(() => { const n = [...document.querySelectorAll('[data-ro-project-rules]')]; return n.length === 1 && n[0].textContent === ${jsonStr(ro.projectRules('rules-project', 1))}; })()`);
        await pick('[data-ro-trial-type]', ro.types.docs);
        await waitTrial('beta', 'UI27 试算文档（不限项目）');
        await pick('[data-ro-trial-project]', 'rules-project');
        await waitTrial('alpha', 'UI27 试算文档（项目 rules-project）：项目规则先于全局规则');
        await settled('UI27 选了项目：试算 docs 命中项目规则 1，说明是 ro.whyRule(项目, 1, 文档)，过程与核心 ar route --project 一致', async () => {
            const expected = await route('docs', projectDir), now = await trialNow();
            assert.equal(expected.profile, 'alpha');
            assert.deepEqual(expected.rule, { scope: 'project', index: 1 });
            assert.deepEqual(now.trace, expected.trace);
            assert.ok(now.text.includes(`（${ro.whyRule(ro.scopeProject, 1, ro.types.docs)}）`), now.text);
        });
        await pick('[data-ro-trial-project]', ro.trialAny);
        await pick('[data-ro-trial-type]', ro.types.code);
        await waitTrial('alpha', 'UI27 试算回到 code');

        // ---- 每日上限 ----
        await check('UI27 每日上限一节：每个执行者一行（标签、名字、任务数输入、token 输入、今天已用），输入框有 aria-label，占位是 ro.limitNone', `(() => { const rows = [...document.querySelectorAll('[data-ro-lim]')]; const a = rows[0]; return rows.map(r => r.dataset.roLim).join() === 'alpha,beta,gamma,plain' && a.querySelector('b').textContent === 'Alpha 执行者' && a.querySelector('.xtag').textContent.length >= 2 && a.querySelector('[data-ro-kind=tasks]').getAttribute('aria-label') === ${jsonStr(`Alpha 执行者 ${ro.limitTasks}`)} && a.querySelector('[data-ro-kind=tokens]').placeholder === ${jsonStr(ro.limitNone)} && a.querySelector('[data-ro-used]').textContent === ${jsonStr(ro.usedTasks(0, null))}; })()`);
        await type('[data-ro-limit=alpha][data-ro-kind=tasks]', '1');
        await key('Enter');
        await wait(`document.querySelector('[data-ro-limit=alpha][data-ro-kind=tasks]').value === '1'`, 'UI27 输入框保留 1');
        await pause(600);
        await settled('UI27 输入 1 再按回车：alpha 的 limits.maxTasksPerDay 是 1（数字），其余字段不变', async () => {
            const after = await readConfig();
            assert.deepEqual(after.profiles.alpha.limits, { maxTasksPerDay: 1 });
            assert.deepEqual(rest(after), rest(before));
            assert.equal((after.profiles.beta as any).limits, undefined);
        });
        // 非法值：提示 ro.limitInvalid，不写配置。
        for (const bad of ['0', '1.5', 'abc', '-3']) {
            await press('[data-ro-limit=beta][data-ro-kind=tokens]');
            await key('a', ['control']);
            await key('Backspace');
            await type('[data-ro-limit=beta][data-ro-kind=tokens]', bad);
            await key('Enter');
            await check(`UI27 非法值「${bad}」：提示 ro.limitInvalid（可见、role=alert），输入保留`, `(() => { const e = document.querySelector('[data-ro-limit-error=beta]'); return !e.hidden && e.textContent === ${jsonStr(ro.limitInvalid)} && e.getAttribute('role') === 'alert' && document.querySelector('[data-ro-limit=beta][data-ro-kind=tokens]').value === ${jsonStr(bad)}; })()`);
            await pause(500);
            await settled(`UI27 非法值「${bad}」不写配置`, async () => { assert.equal((await readConfig()).profiles.beta.limits, undefined); });
        }
        await save('ui27-routing-limit-invalid-dark');
        // 合法值：失去焦点（Tab）时写入；留空表示删除这一项。
        await press('[data-ro-limit=beta][data-ro-kind=tokens]');
        await key('a', ['control']);
        await key('Backspace');
        await type('[data-ro-limit=beta][data-ro-kind=tokens]', '2000000');
        await key('Tab');
        await wait(`document.querySelector('[data-ro-limit-error=beta]').hidden`, 'UI27 合法值后错误提示消失');
        await pause(600);
        await settled('UI27 beta 的 token 上限 2000000：失去焦点时写入', async () => { assert.deepEqual((await readConfig()).profiles.beta.limits, { maxTokensPerDay: 2000000 }); });
        await check('UI27 今天已用的文字带上限：beta 是 ro.usedTasks(0, null) + ro.usedTokens("0", "2.0M")', `document.querySelector('[data-ro-used=beta]').textContent === ${jsonStr(ro.usedTasks(0, null) + ro.usedTokens('0', '2.0M'))}`);
        await press('[data-ro-limit=beta][data-ro-kind=tokens]');
        await key('a', ['control']);
        await key('Backspace');
        await key('Enter');
        await pause(600);
        await settled('UI27 留空并回车：beta 的 token 上限删除，limits 整个去掉', async () => { assert.equal((await readConfig()).profiles.beta.limits, undefined); });
        // 夹具：隔离公共目录的清单里写一条今天的 alpha 的 start（今天已用 1 个任务）。
        await writeFile(runsFile, (await readFile(runsFile, 'utf8').catch(() => '')) + jsonStr({ v: 1, event: 'start', id: MARK, profile: 'alpha', started: Date.now() }) + '\n');
        await enter('UI27 重新进入页面（今天已达上限）');
        await check('UI27 alpha 这一行显示"今天 1/1 个任务"和"今天已达上限"，品牌色提示（hit 类、品牌色图标）', `(() => { const u = document.querySelector('[data-ro-used=alpha]'); return u.classList.contains('hit') && u.textContent.includes(${jsonStr(ro.usedTasks(1, 1))}) && u.textContent.includes(${jsonStr(ro.stateLimited)}) && !!u.querySelector('.mk.brand') && getComputedStyle(u).color === (() => { const s = document.createElement('span'); s.style.color = 'var(--brand)'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })(); })()`);
        await check('UI27 用到 alpha 的规则那一行带"今天已达上限"tag；beta 那一行没有', `!!document.querySelector('[data-ro-rule="1"] [data-ro-state=limited]') && document.querySelector('[data-ro-rule="1"] [data-ro-state=limited]').textContent === ${jsonStr(ro.stateLimited)} && !document.querySelector('[data-ro-rule="0"] [data-ro-state]')`);
        await waitTrial('beta', 'UI27 试算 code 跳过 alpha，走兜底 beta');
        await settled('UI27 alpha 已达上限：试算 code 跳过 alpha，trace 里有"已达每日上限"，改走兜底 beta；与核心一致', async () => {
            const expected = await route('code'), now = await trialNow();
            assert.equal(expected.profile, 'beta');
            assert.ok(expected.trace[0].includes('已达每日上限'), expected.trace[0]);
            assert.deepEqual(now.trace, expected.trace);
        });
        await reveal('limits');
        await pause(300);
        await shot('ui27-routing-limit');
        await reveal('rules');

        // ---- 为什么选它 ----
        await check('UI27 "为什么选它"默认收起；展开前看不到 trace', `(() => { const d = document.querySelector('[data-ro-why]'); return d.tagName === 'DETAILS' && !d.open && d.querySelector('summary').textContent.trim() === ${jsonStr(ro.trialWhy)}; })()`);
        await tabTo('[data-ro-why-toggle]');
        await focusRing('UI27 "为什么选它"的焦点环');
        await key('Enter');
        await wait(`document.querySelector('[data-ro-why]').open === true`, 'UI27 回车展开为什么选它');
        await settled('UI27 展开后逐行显示 trace（等宽字体），内容与 ar route --explain 完全一致', async () => {
            const expected = await route('code'), now = await trialNow();
            assert.deepEqual(now.trace, expected.trace);
        });
        await check('UI27 trace 用等宽字体（mono 类，字体与编号列相同）', `(() => { const t = document.querySelector('[data-ro-trace]'); return t.classList.contains('mono') && getComputedStyle(t).fontFamily === getComputedStyle(document.querySelector('.ro-n')).fontFamily; })()`);
        await reveal('trial');
        await pause(300);
        await shot('ui27-routing-trial');
        // 键盘 / 鼠标都能收起再展开（同一个状态）。
        await press('[data-ro-why-toggle]');
        await wait(`document.querySelector('[data-ro-why]').open === false`, 'UI27 点击收起');
        await press('[data-ro-why-toggle]');
        await wait(`document.querySelector('[data-ro-why]').open === true`, 'UI27 点击展开');
        // 展开状态在改下拉后保持（只重画结果）。
        await pick('[data-ro-trial-type]', ro.types.research);
        await wait(`document.querySelector('[data-ro-trace] li')?.textContent.includes('research')`, 'UI27 试算 research 的 trace 更新');
        await check('UI27 改了任务类型后"为什么选它"仍是展开的，并且 trace 已更新', `document.querySelector('[data-ro-why]').open === true && document.querySelector('[data-ro-trace] li').textContent.includes('research')`);
        await pick('[data-ro-trial-type]', ro.types.code);

        // ---- 没有可用的执行者：试算失败，显示 ro.trialFail 与 trace ----
        await pick('[data-ro-fallback]', ro.fallbackNone);
        await wait(`document.querySelector('[data-ro-trial-result]')?.dataset.roFailed === '1'`, 'UI27 兜底清除、默认执行者已达上限：试算失败');
        await settled('UI27 失败时显示 ro.trialFail 与核心给的原因，trace 逐行显示（含"已达每日上限"），与核心一致', async () => {
            const expected = await route('code'), now = await trialNow();
            assert.equal(expected.ok, false);
            assert.equal(expected.code, 'NO_PROFILE');
            assert.ok(now.failed && now.text.includes(ro.trialFail) && now.text.includes(expected.error), now.text);
            assert.deepEqual(now.trace, expected.trace);
            assert.ok(now.trace.some(line => line.includes('已达每日上限')));
        });
        await reveal('trial');
        await pause(300);
        await shot('ui27-routing-trial-fail', false);
        await pick('[data-ro-fallback]', 'Beta 阅读者');
        await waitTrial('beta', 'UI27 恢复兜底后试算成功');

        // ---- 停用 / 不支持只读 / 项目规则的状态 tag（用核心命令准备规则，因为界面不会让你选到它们） ----
        const goodRules = (await readConfig()).routing.rules;
        await core(['route', 'rules', 'set', jsonStr([{ types: ['docs'], profile: 'gamma' }, { types: ['research'], profile: 'plain' }])]);
        await enter('UI27 重新进入页面（状态 tag）');
        await check('UI27 规则里的执行者已停用、不支持只读时，那一行带 tag：ro.stateDisabled、ro.stateNoReadOnly', `document.querySelector('[data-ro-rule="0"] [data-ro-state=disabled]')?.textContent === ${jsonStr(ro.stateDisabled)} && document.querySelector('[data-ro-rule="1"] [data-ro-state=no-read-only]')?.textContent === ${jsonStr(ro.stateNoReadOnly)} && !document.querySelector('[data-ro-rule="0"] [data-ro-state=no-read-only]')`);
        await shot('ui27-routing-states', false);
        await core(['route', 'rules', 'set', jsonStr(goodRules)]);

        // ---- 审查者候选 ----
        await enter('UI27 重新进入页面（审查者候选）');
        // 改写（D128，191）：原断言 没有候选时只有"添加"按钮和"必须与执行者不同"一个勾选项 → 新断言 三个约束开关按顺序"不能是执行者本人 / 与执行者的模型家族不同 / 与主导的模型家族不同"，下面写"现在的主导"；原因：三条约束都由用户决定，可以关。
        await check('UI27 审查者候选：没有候选时只有"添加"按钮和三个约束开关（默认勾选，用 choice 组件样式），三个标题与说明逐字来自 ro，"现在的主导"写默认', `(() => { const s = document.querySelector('[data-ro-sec=reviewers]'); const items = [...s.querySelectorAll('.choice')]; const texts = items.map(b => [b.querySelector('.ct').firstChild.textContent, b.querySelector('.ct span').textContent]); return !s.querySelector('[data-ro-chip]') && s.querySelector('[data-ro-review-add]').textContent.trim() === ${jsonStr(ro.reviewAdd)} && items.length === 3 && items[0].hasAttribute('data-ro-differ') && items[1].hasAttribute('data-ro-differ-family') && items[2].hasAttribute('data-ro-differ-lead') && items.every(b => b.classList.contains('choice') && b.getAttribute('role') === 'checkbox' && b.getAttribute('aria-checked') === 'true') && JSON.stringify(texts) === ${jsonStr(JSON.stringify([[ro.reviewDiffer, ro.reviewDifferHelp], [ro.reviewDifferFamily, ro.reviewDifferFamilyHelp], [ro.reviewDifferLead, ro.reviewDifferLeadHelp]]))} && s.querySelector('[data-ro-lead-now]').textContent === ${jsonStr(ro.leadNow(ro.leadDefault, 'claude'))}; })()`);
        await press('[data-ro-review-add]');
        await wait('!!document.querySelector(".ctx")', 'UI27 添加审查者下拉');
        await settled('UI27 添加下拉只列支持只读、还没加进来的执行者（没有 Plain 通用）', async () => { assert.deepEqual(await menuLabels(), ['Alpha 执行者', 'Beta 阅读者', 'Gamma 停用']); });
        await press(await menuItem('Alpha 执行者'));
        await wait('!!document.querySelector("[data-ro-chip=alpha]")', 'UI27 出现 Alpha 候选');
        await settled('UI27 添加 alpha：reviewer 是 { profiles: [alpha], mustDiffer: true }', async () => { assert.deepEqual((await readConfig()).routing.reviewer, { profiles: ['alpha'], mustDiffer: true }); });
        await pick('[data-ro-review-add]', 'Beta 阅读者');
        await wait('!!document.querySelector("[data-ro-chip=beta]")', 'UI27 出现 Beta 候选');
        await check('UI27 候选按顺序列出：序号 1、2，名字，移除按钮的 aria-label 是 ro.reviewRemove(名字)', `(() => { const chips = [...document.querySelectorAll('[data-ro-chip]')]; return chips.map(c => c.dataset.roChip).join() === 'alpha,beta' && chips.map(c => c.querySelector('.mono').textContent).join() === '1,2' && chips[0].querySelector('button').getAttribute('aria-label') === ${jsonStr(ro.reviewRemove('Alpha 执行者'))}; })()`);
        await settled('UI27 再添加 beta：profiles 是 [alpha, beta]', async () => { assert.deepEqual((await readConfig()).routing.reviewer, { profiles: ['alpha', 'beta'], mustDiffer: true }); });
        await press('[data-ro-review-remove=alpha]');
        await wait('!document.querySelector("[data-ro-chip=alpha]")', 'UI27 移除 Alpha 候选');
        await settled('UI27 移除 alpha：profiles 是 [beta]', async () => { assert.deepEqual((await readConfig()).routing.reviewer, { profiles: ['beta'], mustDiffer: true }); });
        await tabTo('[data-ro-differ]');
        await focusRing('UI27 "必须与执行者不同"的焦点环');
        await key('Enter');
        await wait(`document.querySelector('[data-ro-differ]').getAttribute('aria-checked') === 'false'`, 'UI27 取消必须与执行者不同');
        await settled('UI27 取消勾选：mustDiffer 是 false，profiles 不变，其余字段不变', async () => {
            const after = await readConfig();
            assert.deepEqual(after.routing.reviewer, { profiles: ['beta'], mustDiffer: false });
            assert.deepEqual(rest(after), rest(before));
        });
        await reveal('reviewers');
        await pause(300);
        await shot('ui27-routing-reviewers');
        await press('[data-ro-differ]');
        await wait(`document.querySelector('[data-ro-differ]').getAttribute('aria-checked') === 'true'`, 'UI27 再勾选');
        await settled('UI27 再勾选：mustDiffer 回到 true', async () => { assert.deepEqual((await readConfig()).routing.reviewer, { profiles: ['beta'], mustDiffer: true }); });
        await enter('UI27 重新进入页面（所有改动仍在）');
        await settled('UI27 重新进入页面后读到的就是刚写的配置：规则 2 条、兜底 beta、alpha 上限 1、审查者 [beta]', async () => {
            const after = await readConfig();
            assert.equal(after.routing.rules.length, 2);
            assert.equal(after.routing.fallback, 'beta');
            assert.deepEqual(after.profiles.alpha.limits, { maxTasksPerDay: 1 });
            assert.deepEqual(after.routing.reviewer, { profiles: ['beta'], mustDiffer: true });
            const dom = JSON.parse(await evaluate(`JSON.stringify({ rules: document.querySelectorAll('[data-ro-rule]').length, fallback: document.querySelector('[data-ro-fallback] span').textContent, tasks: document.querySelector('[data-ro-limit=alpha][data-ro-kind=tasks]').value, chips: [...document.querySelectorAll('[data-ro-chip]')].map(c => c.dataset.roChip) })`));
            assert.deepEqual(dom, { rules: 2, fallback: 'Beta 阅读者', tasks: '1', chips: ['beta'] });
        });

        // ---- 审查者候选：默认也与主导的模型家族不同（Stage07c 150，D85）----
        // 放在上面的最终核对之后：点它会在 config.json 的 routing.reviewer 里写 differFromLead（上面的核对是 { profiles, mustDiffer } 整体相等）。
        // 改写（D128，191）：原断言 勾选项共 2 个（第 2 个是与主导不同）→ 新断言 共 3 个，中间是"与执行者的模型家族不同"，最后是与主导不同；原因：审查约束拆成三个开关。
        await check('UI27 审查者候选：三个约束开关按顺序排列，"与执行者的模型家族不同"在中间、"与主导的模型家族不同"在最后（默认勾选，choice 样式），标题与说明逐字来自 ro', `(() => { const s = document.querySelector('[data-ro-sec=reviewers]'); const l = s.querySelector('[data-ro-differ-lead]'); const m = s.querySelector('[data-ro-differ-family]'); const items = [...s.querySelectorAll('.choice')]; return items.length === 3 && items[0].hasAttribute('data-ro-differ') && items[1] === m && items[2] === l && m.getAttribute('role') === 'checkbox' && m.getAttribute('aria-checked') === 'true' && m.querySelector('.ct').firstChild.textContent === ${jsonStr(ro.reviewDifferFamily)} && m.querySelector('.ct span').textContent === ${jsonStr(ro.reviewDifferFamilyHelp)} && l.getAttribute('role') === 'checkbox' && l.getAttribute('aria-checked') === 'true' && l.querySelector('.ct').firstChild.textContent === ${jsonStr(ro.reviewDifferLead)} && l.querySelector('.ct span').textContent === ${jsonStr(ro.reviewDifferLeadHelp)}; })()`);
        await verify('UI27 没点之前 config.json 里没有 differFromLead（核心按"与主导不同"处理）', async () => { assert.ok(!('differFromLead' in (await readConfig()).routing.reviewer)); });
        await tabTo('[data-ro-differ-lead]');
        await focusRing('UI27 "默认也与主导的模型家族不同"的焦点环');
        await key('Enter');
        await wait(`document.querySelector('[data-ro-differ-lead]').getAttribute('aria-checked') === 'false'`, 'UI27 取消与主导不同');
        await settled('UI27 取消勾选：differFromLead 是 false，profiles、mustDiffer 不变', async () => { assert.deepEqual((await readConfig()).routing.reviewer, { profiles: ['beta'], mustDiffer: true, differFromLead: false }); });
        await verify('UI27 核心读到的同一个值：ar roles --json 的 differFromLead 为 false', async () => { assert.equal((await core(['roles'])).differFromLead, false); });
        // 改"必须与执行者不同"不带 differFromLead：核心保留已有的值。
        await press('[data-ro-differ]');
        await wait(`document.querySelector('[data-ro-differ]').getAttribute('aria-checked') === 'false'`, 'UI27 取消必须与执行者不同');
        await settled('UI27 改"必须与执行者不同"时 differFromLead 保持 false', async () => { assert.deepEqual((await readConfig()).routing.reviewer, { profiles: ['beta'], mustDiffer: false, differFromLead: false }); });
        await check('UI27 重画后"与主导不同"仍是未勾选', `document.querySelector('[data-ro-differ-lead]').getAttribute('aria-checked') === 'false' && document.querySelector('[data-ro-differ]').getAttribute('aria-checked') === 'false'`);
        await reveal('reviewers');
        await pause(300);
        await shot('ui27-routing-reviewers-lead');
        await press('[data-ro-differ]');
        await press('[data-ro-differ-lead]');
        await wait(`document.querySelector('[data-ro-differ-lead]').getAttribute('aria-checked') === 'true' && document.querySelector('[data-ro-differ]').getAttribute('aria-checked') === 'true'`, 'UI27 再勾选两项');
        await settled('UI27 再勾选：differFromLead 回到 true', async () => { assert.deepEqual((await readConfig()).routing.reviewer, { profiles: ['beta'], mustDiffer: true, differFromLead: true }); });
        await enter('UI27 重新进入页面（与主导不同）');
        await check('UI27 重新进入页面后读到的是 true', `document.querySelector('[data-ro-differ-lead]').getAttribute('aria-checked') === 'true'`);

        // ---- 与执行者的模型家族不同（D128，191 新增的 differFamily）：点掉再点回，config.json 跟着变 ----
        await tabTo('[data-ro-differ-family]');
        await focusRing('UI27 "与执行者的模型家族不同"的焦点环');
        await key('Enter');
        await wait(`document.querySelector('[data-ro-differ-family]').getAttribute('aria-checked') === 'false'`, 'UI27 取消与执行者不同家族');
        await settled('UI27 取消勾选：differFamily 是 false，profiles、mustDiffer、differFromLead 不变', async () => { assert.deepEqual((await readConfig()).routing.reviewer, { profiles: ['beta'], mustDiffer: true, differFromLead: true, differFamily: false }); });
        await verify('UI27 核心读到的同一个值：ar roles --json 的 differFamily 为 false', async () => { assert.equal((await core(['roles'])).differFamily, false); });
        await press('[data-ro-differ-family]');
        await wait(`document.querySelector('[data-ro-differ-family]').getAttribute('aria-checked') === 'true'`, 'UI27 再勾选与执行者不同家族');
        await settled('UI27 再勾选：differFamily 回到 true，其余不变', async () => { assert.deepEqual((await readConfig()).routing.reviewer, { profiles: ['beta'], mustDiffer: true, differFromLead: true, differFamily: true }); });
        await check('UI27 重画后三个开关都是勾选状态', `['data-ro-differ', 'data-ro-differ-family', 'data-ro-differ-lead'].every(a => document.querySelector('[' + a + ']').getAttribute('aria-checked') === 'true')`);

        // ---- 现在的主导（D128）：设一个可担任主导的 Agent 后，路由页写它的显示名与家族；恢复后写默认 ----
        const alphaBefore = (await readConfig()).profiles.alpha;
        await core(['roles', 'set', 'alpha', 'roles=executor,reviewer,lead', 'modelFamilies=claude']);
        await enter('UI27 重新进入页面（设了主导）');
        await check('UI27 "与主导的模型家族不同"下面一行写 ro.leadNow(显示名, 家族)：设了主导时是它的显示名与家族', `document.querySelector('[data-ro-lead-now]').textContent === ${jsonStr(ro.leadNow('Alpha 执行者', 'claude'))}`);
        await reveal('reviewers');
        await pause(300);
        await shot('ui27-routing-lead-set');
        const back = await readConfig();
        back.profiles.alpha = alphaBefore;
        await writeFile(configFile, JSON.stringify(back, null, 2) + '\n');
        await enter('UI27 重新进入页面（主导恢复未设置）');
        await check('UI27 没设主导时写 ro.leadNow(ro.leadDefault, "claude")', `document.querySelector('[data-ro-lead-now]').textContent === ${jsonStr(ro.leadNow(ro.leadDefault, 'claude'))}`);

        // ---- 按路由派发的任务（111）：进展里有"路由：…"分隔行，参数标签有"路由"一行，文字与 progress.log 里那一行一致 ----
        // 用真实派发（假执行者 beta，规则「调研 → beta」）；任务记在隔离公共目录里，结束时去掉。
        const routedRepo = path.join(home, 'shots-routing', 'routed-repo');
        await mkdir(path.join(routedRepo, 'specs'), { recursive: true });
        const git = (args: string[]) => { const r = spawnSync('git', args, { cwd: routedRepo, encoding: 'utf8', shell: false, windowsHide: true, env: appEnv }); assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`); };
        await writeFile(path.join(routedRepo, '.gitignore'), '.agent-runs/\n');
        await writeFile(path.join(routedRepo, 'specs', 'routed.md'), '---\ntype: research\n---\n\n只回复 OK。\n');
        git(['init', '-q', '-b', 'main']);
        git(['add', '--', '.gitignore', 'specs/routed.md']);
        git(['-c', 'user.name=AgentRouter Shots', '-c', 'user.email=shots@example.invalid', 'commit', '-q', '-m', '初始提交', '--', '.gitignore', 'specs/routed.md']);
        const dispatched = await coreRun(['dispatch', 'specs/routed.md', '--name', ROUTED], { timeoutMs: 120000, cwd: routedRepo });
        assert.equal(dispatched.code, 0, `派发失败：${dispatched.stderr || dispatched.json?.error}`);
        const startRow = (await readFile(runsFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).find(row => row.event === 'start' && row.name === ROUTED);
        assert.ok(startRow, '清单里有这个任务的 start 记录');
        const routeText = String(startRow.route);
        assert.equal(startRow.profile, 'beta');
        assert.ok(routeText.includes('[research, review] → beta'), `start.route 是路由器的说明：${routeText}`);
        const progressLine = (await readFile(path.join(routedRepo, '.agent-runs', ROUTED, 'progress.log'), 'utf8')).split('\n').find(line => line.includes('路由：')) ?? '';
        assert.ok(progressLine.endsWith(w.routeRow(routeText)), `progress.log 里的路由行与 start.route 一致：${progressLine}`);
        await press('[data-page=tasks]');
        await wait(`!!document.querySelector("[data-task=${startRow.id}]")`, 'UI27 任务列表里出现按路由派发的任务');
        await press(`[data-task=${startRow.id}]`);
        await press('[data-tab=flow]');
        await wait(`document.querySelector('.wt-slot')?.textContent.includes(${jsonStr(w.routeRow(routeText))})`, 'UI27 进展里出现路由行');
        await check('UI27 进展里有"路由：…"分隔行（样式同建好 worktree 那一行：.tl.k-turn），文字与 progress.log 里那一行一致，时间是任务开始时间', `(() => { const rows = [...document.querySelectorAll('.wt-slot .tl.k-turn')]; return rows.length === 1 && rows[0].querySelector('.c').textContent === ${jsonStr(w.routeRow(routeText))} && ${jsonStr(progressLine)}.endsWith(rows[0].querySelector('.c').textContent) && rows[0].querySelector('.t').textContent.trim() !== ''; })()`);
        await press('[data-tab=params]');
        await check('UI27 参数标签有"路由"一行（在"执行者"后面），值与 start.route 一致；非 Codex 任务有"推理强度"一行（没有值显示"默认（不传参数）"），没有档位与沙箱', `(() => { const rows = [...document.querySelectorAll('.rows .r')], keys = rows.map(r => r.querySelector('.k').textContent), val = k => rows.find(r => r.querySelector('.k').textContent === k)?.querySelector('.v').textContent; return val(${jsonStr(c.route)}) === ${jsonStr(routeText)} && keys.indexOf(${jsonStr(c.route)}) === keys.indexOf(${jsonStr(c.executor)}) + 1 && val(${jsonStr(c.effort)}) === ${jsonStr(c.effortDefault)} && !keys.includes(${jsonStr(c.tier)}) && !keys.includes(${jsonStr(c.sandbox)}); })()`);
        await save('ui27-routed-task-params-dark');
        await press('[data-tab=flow]');
        await save('ui27-routed-task-flow-dark');

        // ---- Stage07c 151（T5 建议规则、T6 规则的推理强度、T8 强执行者） ----
        // 配置换成：假执行者 alpha / beta / plain，再由核心 ar agents add 按预设加入三个执行者（Claude 订阅、DeepSeek，以及预设声明不支持推理强度的 DeepSeek Harness）；
        // agent-tests.json 写两个"测试通过"的记录，规则清空，从空状态开始。结束时配置和测试记录都还原。
        const testsFile = path.join(home, 'agent-tests.json');
        originalTests = await readFile(testsFile, 'utf8').catch(() => null);
        await writeFile(configFile, JSON.stringify(base, null, 2) + '\n');
        // DeepSeek 的密钥变量改成一个肯定没设置的名字：规则弹窗查探针时核心因为"没有密钥"直接退回预设，不会拿真实密钥去连真实接口。
        for (const [preset, label, extra] of [['claude-subscription', 'Claude 测试', []], ['deepseek', 'DeepSeek 测试', ['--secret-var', 'AR_SHOTS_NO_SUCH_KEY']], ['deepseek-harness', 'Harness 测试', []]] as [string, string, string[]][]) await core(['agents', 'add', '--preset', preset, '--label', label, ...extra]);
        const passed = { at: Date.now(), ok: true, seconds: 1, version: 'shots', error: null };
        await writeFile(testsFile, JSON.stringify({ 'claude-subscription': passed, deepseek: passed, 'deepseek-harness': { ...passed, ok: false, error: '测试用：未通过' } }, null, 2) + '\n');
        const presetEfforts: string[] = (await core(['agents', 'presets'])).presets.find((x: any) => x.name === 'claude-subscription').effortOptions;
        assert.ok(presetEfforts.length >= 2, `预设有推理强度的选项：${presetEfforts}`);
        const typeName = (type: string) => ro.types[type] ?? type;
        const labelOf = async (name: string) => (await readConfig()).profiles[name]?.label ?? name;
        // 建议弹窗此刻的内容（从界面读）与核心 ar route suggest 的结果对照。
        const suggestNow = async () => JSON.parse(await evaluate(`JSON.stringify((() => { const s = document.querySelector('.sheet'); return { title: s.getAttribute('aria-label'), note: s.querySelector('.sheet-f .note').textContent, lead: s.querySelector('.sheet-b p.muted').textContent, items: [...s.querySelectorAll('[data-ro-sug]')].map(b => ({ on: b.getAttribute('aria-checked') === 'true', cb: b.querySelector('.cb').classList.contains('on'), types: b.querySelector('.ro-sug-t b').textContent, to: b.querySelector('.ro-sug-t').textContent, why: b.querySelector('.ct > span:last-child').textContent })), skipped: s.querySelector('[data-ro-suggest-skipped]')?.textContent ?? null, none: s.querySelector('[data-ro-suggest-none]')?.textContent ?? null, buttons: [...s.querySelectorAll('.sheet-btns button')].map(b => ({ text: b.textContent.trim(), disabled: b.disabled })) }; })())`)) as { title: string; note: string; lead: string; items: { on: boolean; cb: boolean; types: string; to: string; why: string }[]; skipped: string | null; none: string | null; buttons: { text: string; disabled: boolean }[] };
        const sameAsCore = async (label: string, adoptCount: number) => settled(label, async () => {
            const now = await suggestNow(), expected = await core(['route', 'suggest']);
            assert.equal(now.title, ro.suggestTitle);
            assert.equal(now.note, ro.suggestNote);
            assert.equal(now.lead, ro.suggestLead);
            assert.equal(now.items.length, expected.rules.length, JSON.stringify(now.items));
            for (const [i, rule] of expected.rules.entries()) {
                assert.equal(now.items[i].types, rule.types.map(typeName).join('、'));
                assert.ok(now.items[i].to.startsWith(`${now.items[i].types} → `) && now.items[i].to.endsWith(await labelOf(rule.profile)), now.items[i].to);
                assert.equal(now.items[i].why, rule.why);
            }
            const skipped = (await Promise.all(expected.skipped.map(async (item: any) => `${item.profile ? await labelOf(item.profile) : item.types.map(typeName).join('、')}${item.profile && item.types?.length ? `（${item.types.map(typeName).join('、')}）` : ''}：${item.why}`))).join('；');
            assert.equal(now.skipped, skipped ? ro.suggestSkipped(skipped) : null);
            assert.deepEqual(now.buttons, [{ text: '取消', disabled: false }, { text: ro.suggestAdopt(adoptCount), disabled: adoptCount === 0 }]);
        });

        // 空状态：次按钮"按我的执行者生成建议规则"在"添加第一条规则"前面。
        await enter('UI27c 重新进入页面（建议规则）');
        await check('UI27c 没有规则的空状态：次按钮 ro.suggest（带路由图标、不是主按钮）在"添加第一条规则"前面', `(() => { const e = document.querySelector('[data-ro-sec=rules] .empty'), s = e.querySelector('[data-ro-suggest]'), a = e.querySelector('[data-ro-add-first]'); return s.textContent.trim() === ${jsonStr(ro.suggest)} && !!s.querySelector('i.ri-route-line') && !s.classList.contains('primary') && a.classList.contains('primary') && !!(s.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) && e.querySelectorAll('[data-ro-suggest]').length === 1; })()`);
        await press('[data-ro-suggest]');
        await wait('!!document.querySelector(".sheet [data-ro-sug]")', 'UI27c 建议弹窗打开');
        await sameAsCore('UI27c 建议弹窗的内容等于 ar route suggest --json：标题、底部说明、每条"类型 → 执行者"与 why、没有列出的执行者与原因，底栏"取消 / 采用 2 条"', 2);
        await check('UI27c 建议弹窗里每条默认勾选（勾选框是选中样式），共 2 条：Claude 订阅 → 代码、修复、重构，DeepSeek → 测试、文档', `(() => { const items = [...document.querySelectorAll('.sheet [data-ro-sug]')]; return items.length === 2 && items.every(b => b.getAttribute('role') === 'checkbox' && b.getAttribute('aria-checked') === 'true' && b.querySelector('.cb').classList.contains('on')); })()`);
        await verify('UI27c 核心给的建议就是这两条', async () => { const expected = await core(['route', 'suggest']); assert.deepEqual(expected.rules.map((r: any) => [r.profile, r.types]), [['claude-subscription', ['code', 'fix', 'refactor']], ['deepseek', ['test', 'docs']]]); });
        await shot('ui27c-routing-suggest', false);
        // 勾选：取消一条后"采用"的数量跟着变；都取消后"采用"禁用；再勾回一条。
        await press('.sheet [data-ro-sug="1"]');
        await check('UI27c 取消第 2 条：它 aria-checked 为 false、勾选框空，底栏变成 ro.suggestAdopt(1)', `(() => { const b = document.querySelector('.sheet [data-ro-sug="1"]'); return b.getAttribute('aria-checked') === 'false' && !b.querySelector('.cb').classList.contains('on') && document.querySelector('.sheet [data-sheet-btn="1"]').textContent.trim() === ${jsonStr(ro.suggestAdopt(1))} && !document.querySelector('.sheet [data-sheet-btn="1"]').disabled; })()`);
        await press('.sheet [data-ro-sug="0"]');
        await check('UI27c 都取消后"采用"禁用，文字是 ro.suggestAdopt(0)', `(() => { const b = document.querySelector('.sheet [data-sheet-btn="1"]'); return b.disabled && b.textContent.trim() === ${jsonStr(ro.suggestAdopt(0))}; })()`);
        await press('.sheet [data-ro-sug="0"]');
        await check('UI27c 勾回第 1 条：只勾选它，"采用 1 条"可点', `(() => { const items = [...document.querySelectorAll('.sheet [data-ro-sug]')].map(b => b.getAttribute('aria-checked')); const b = document.querySelector('.sheet [data-sheet-btn="1"]'); return items.join() === 'true,false' && !b.disabled && b.textContent.trim() === ${jsonStr(ro.suggestAdopt(1))}; })()`);
        await verify('UI27c 点"采用"之前 config.json 的 routing.rules 还是空', async () => { assert.deepEqual((await readConfig()).routing.rules, []); });
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector(".sheet") && !!document.querySelector("[data-ro-rule=\\"0\\"]")', 'UI27c 采用后弹窗关闭、出现第 1 条规则');
        await settled('UI27c 采用：routing.rules 是已有规则（空）加上勾选的那一条 [代码、修复、重构] → claude-subscription，没勾选的 DeepSeek 没写', async () => {
            assert.deepEqual((await readConfig()).routing.rules, [{ types: ['code', 'fix', 'refactor'], profile: 'claude-subscription' }]);
        });
        await check('UI27c 采用后提示 ro.suggestAdopted(1)，规则列表出现这条（Claude 测试），列表下面有"生成建议规则"入口、空状态没有了', `(() => { const r = document.querySelector('[data-ro-rule="0"]'); return document.querySelector('.notice')?.textContent === ${jsonStr(ro.suggestAdopted(1))} && r.querySelector('.ro-to b').textContent === 'Claude 测试' && [...r.querySelectorAll('.ro-types .tag')].map(t => t.textContent).join() === ${jsonStr(['code', 'fix', 'refactor'].map(typeName).join())} && !document.querySelector('[data-ro-sec=rules] .empty') && document.querySelectorAll('[data-ro-suggest]').length === 1 && document.querySelector('[data-ro-rules]').nextElementSibling.contains(document.querySelector('[data-ro-suggest]')); })()`);
        // 已有规则时：入口在列表下面；弹窗里只剩没被已有规则覆盖的那一条。
        await press('[data-ro-suggest]');
        await wait('!!document.querySelector(".sheet [data-ro-sug]")', 'UI27c 已有规则时再打开建议弹窗');
        await sameAsCore('UI27c 已有规则时建议弹窗等于核心的结果：只剩 DeepSeek → 测试、文档，被已有规则覆盖的类型写在"没有列出"里', 1);
        await check('UI27c 已有规则时建议弹窗只有 1 条（DeepSeek），默认勾选', `document.querySelectorAll('.sheet [data-ro-sug]').length === 1 && document.querySelector('.sheet [data-ro-sug="0"]').getAttribute('aria-checked') === 'true' && document.querySelector('.sheet [data-ro-sug="0"] .ro-sug-t b').textContent === ${jsonStr(['test', 'docs'].map(typeName).join('、'))}`);
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector(".sheet") && !!document.querySelector("[data-ro-rule=\\"1\\"]")', 'UI27c 第 2 条规则出现');
        await settled('UI27c 再采用：routing.rules 是已有的那一条加上新勾选的 [测试、文档] → deepseek，顺序不变', async () => {
            assert.deepEqual((await readConfig()).routing.rules, [{ types: ['code', 'fix', 'refactor'], profile: 'claude-subscription' }, { types: ['test', 'docs'], profile: 'deepseek' }]);
        });
        // 没有可建议的：显示 ro.suggestNone，"采用"禁用。
        await press('[data-ro-suggest]');
        await wait('!!document.querySelector(".sheet [data-ro-suggest-none]")', 'UI27c 没有可建议的规则');
        await check('UI27c 没有可建议的规则：弹窗里写 ro.suggestNone，没有勾选项，"采用 0 条"禁用，"取消"可用', `(() => { const s = document.querySelector('.sheet'); const [cancel, adopt] = [...s.querySelectorAll('.sheet-btns button')]; return s.querySelector('[data-ro-suggest-none]').textContent === ${jsonStr(ro.suggestNone)} && !s.querySelector('[data-ro-sug]') && adopt.disabled && adopt.textContent.trim() === ${jsonStr(ro.suggestAdopt(0))} && !cancel.disabled; })()`);
        await press('.sheet [data-sheet-btn="0"]');
        await wait('!document.querySelector(".sheet")', 'UI27c 取消关闭弹窗');
        await settled('UI27c 取消不写配置：routing.rules 仍是 2 条', async () => { assert.equal((await readConfig()).routing.rules.length, 2); });

        // 规则弹窗的推理强度：在"执行者"和"升级到"之间；选项来自所选执行者。
        await press('.page-h [data-ro-add]');
        await sheetOpen('UI27c 添加规则弹窗（推理强度）');
        await wait('!!document.querySelector(".sheet [data-ro-sheet-effort]")', 'UI27c 推理强度一行出现');
        await check('UI27c 规则弹窗的字段顺序：任务类型 → 执行者 → 推理强度（说明 ro.ruleEffortHelp，默认"不指定"）→ 升级到', `(() => { const s = document.querySelector('.sheet'); const labels = [...s.querySelectorAll('.fld .fl b')].map(b => b.firstChild.textContent); const e = s.querySelector('[data-ro-sheet-effort]'); return labels.join() === ${jsonStr([ro.ruleTypes, ro.ruleTo, ro.ruleEffort, ro.ruleEsc].join())} && e.textContent.trim() === ${jsonStr(ro.ruleEffortNone)} && e.closest('.fld').querySelector('.fl span').textContent === ${jsonStr(ro.ruleEffortHelp)} && e.getAttribute('aria-label') === ${jsonStr(ro.ruleEffort)}; })()`);
        // Tab 顺序（原来是 执行者 → 升级到，T6 之后中间多了推理强度）。
        await tabTo('[data-ro-sheet-profile]');
        await key('Tab');
        await check('UI27c Tab 顺序：执行者之后是推理强度', `document.activeElement === document.querySelector('[data-ro-sheet-effort]')`);
        await focusRing('UI27c 推理强度下拉的焦点环');
        await key('Tab');
        await check('UI27c Tab 顺序：推理强度之后是升级到', `document.activeElement === document.querySelector('[data-ro-sheet-esc]')`);
        await press('[data-ro-type=code]');
        await pick('[data-ro-sheet-profile]', 'Claude 测试');
        await press('[data-ro-sheet-effort]');
        await wait('!!document.querySelector(".ctx")', 'UI27c 推理强度下拉');
        await settled('UI27c 选了 Claude 测试后推理强度下拉：第一项"不指定"，其余是它预设的选项', async () => { assert.deepEqual(await menuLabels(), [ro.ruleEffortNone, ...presetEfforts]); });
        await press(await menuItem('low'));
        await wait('!document.querySelector(".ctx")', 'UI27c 选 low');
        await check('UI27c 选了 low：下拉显示 low', `document.querySelector('[data-ro-sheet-effort] span').textContent === 'low'`);
        await shot('ui27c-routing-add-effort', false);
        // 换成没有预设选项的执行者：low 不在它的选项里，换成"不指定"并提示一句；换回再选，换到选项相同的执行者时保留。
        await pick('[data-ro-sheet-profile]', 'Beta 阅读者');
        await check('UI27c 换成 Beta 阅读者（没有推理强度的选项）：low 不在选项里，下拉换成"不指定"并出现提示', `(() => { const n = document.querySelector('[data-ro-effort-note]'); return document.querySelector('[data-ro-sheet-effort] span').textContent === ${jsonStr(ro.ruleEffortNone)} && !!n && n.textContent.includes('low') && n.getAttribute('role') === 'status'; })()`);
        await pick('[data-ro-sheet-profile]', 'Claude 测试');
        await pick('[data-ro-sheet-effort]', 'low');
        await check('UI27c 换回 Claude 测试再选 low：提示消失', `document.querySelector('[data-ro-sheet-effort] span').textContent === 'low' && !document.querySelector('[data-ro-effort-note]')`);
        await pick('[data-ro-sheet-profile]', 'DeepSeek 测试');
        await check('UI27c 换成选项相同的 DeepSeek 测试：low 保留，没有提示', `document.querySelector('[data-ro-sheet-effort] span').textContent === 'low' && !document.querySelector('[data-ro-effort-note]')`);
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector(".sheet") && !!document.querySelector("[data-ro-rule=\\"2\\"]")', 'UI27c 第 3 条规则出现');
        await settled('UI27c 添加：新规则有 effort: low（code → deepseek），前两条不变', async () => {
            const rules = (await readConfig()).routing.rules;
            assert.deepEqual(rules.slice(0, 2), [{ types: ['code', 'fix', 'refactor'], profile: 'claude-subscription' }, { types: ['test', 'docs'], profile: 'deepseek' }]);
            assert.deepEqual(rules[2], { types: ['code'], profile: 'deepseek', effort: 'low' });
        });
        await check('UI27c 规则列表里第 3 条显示它的推理强度 low（执行者名后面的 tag），前两条没有', `(() => { const t = document.querySelector('[data-ro-rule="2"] [data-ro-effort]'); return !!t && t.textContent === 'low' && t.getAttribute('title') === ${jsonStr(ro.ruleEffort)} && !document.querySelector('[data-ro-rule="0"] [data-ro-effort], [data-ro-rule="1"] [data-ro-effort]') && document.querySelector('[data-ro-rule="2"] .ro-to b').textContent === 'DeepSeek 测试'; })()`);
        await verify('UI27c 核心读到的是同一条：ar route config 里第 3 条规则 effort 为 low', async () => { assert.equal((await core(['route', 'config'])).rules[2].effort, 'low'); });
        await shot('ui27c-routing-rules-effort', false);
        // 编辑：预选原来的强度；改成 high 保存；再改回"不指定"，effort 字段去掉。
        await press('[data-ro-act=edit][data-ro-i="2"]');
        await sheetOpen('UI27c 编辑第 3 条规则');
        await check('UI27c 编辑弹窗预选原来的推理强度 low', `document.querySelector('.sheet [data-ro-sheet-effort] span').textContent === 'low' && document.querySelector('.sheet [data-ro-sheet-profile] span').textContent === 'DeepSeek 测试'`);
        await pick('[data-ro-sheet-effort]', 'high');
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector(".sheet") && document.querySelector(\'[data-ro-rule="2"] [data-ro-effort]\')?.textContent === "high"', 'UI27c 保存后第 3 条显示 high');
        await settled('UI27c 编辑：第 3 条的 effort 变成 high，其余不变', async () => { assert.deepEqual((await readConfig()).routing.rules[2], { types: ['code'], profile: 'deepseek', effort: 'high' }); });
        await press('[data-ro-act=edit][data-ro-i="2"]');
        await sheetOpen('UI27c 再编辑第 3 条规则');
        await pick('[data-ro-sheet-effort]', ro.ruleEffortNone);
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector(".sheet") && !document.querySelector(\'[data-ro-rule="2"] [data-ro-effort]\')', 'UI27c 保存后第 3 条不再显示推理强度');
        await settled('UI27c 改回"不指定"：第 3 条没有 effort 字段', async () => { assert.deepEqual((await readConfig()).routing.rules[2], { types: ['code'], profile: 'deepseek' }); });
        // 不支持推理强度的执行者（预设声明 supportsEffort: false）：这一行隐藏；已经选了强度再换成它时，原位置显示一句"已忽略"，保存时不写 effort。
        await press('.page-h [data-ro-add]');
        await sheetOpen('UI27c 添加规则弹窗（不支持推理强度）');
        await press('[data-ro-type=docs]');
        await pick('[data-ro-sheet-profile]', 'Harness 测试');
        await check('UI27c 选了不支持推理强度的 Harness 测试：推理强度一行隐藏（不是禁用），字段只有 任务类型 / 执行者 / 升级到', `(() => { const s = document.querySelector('.sheet'); return !s.querySelector('[data-ro-sheet-effort]') && !s.querySelector('[data-ro-effort-ignored]') && [...s.querySelectorAll('.fld .fl b')].map(b => b.firstChild.textContent).join() === ${jsonStr([ro.ruleTypes, ro.ruleTo, ro.ruleEsc].join())}; })()`);
        await pick('[data-ro-sheet-profile]', 'Claude 测试');
        await pick('[data-ro-sheet-effort]', 'high');
        await pick('[data-ro-sheet-profile]', 'Harness 测试');
        await check('UI27c 已选 high 再换成 Harness 测试：原位置显示 ro.effortUnsupported（推理强度一行的标签还在，没有下拉）', `(() => { const s = document.querySelector('.sheet'); const t = s.querySelector('[data-ro-effort-ignored]'); return !!t && t.textContent === ${jsonStr(ro.effortUnsupported)} && !s.querySelector('[data-ro-sheet-effort]') && [...s.querySelectorAll('.fld .fl b')].map(b => b.firstChild.textContent).join() === ${jsonStr([ro.ruleTypes, ro.ruleTo, ro.ruleEffort, ro.ruleEsc].join())}; })()`);
        await shot('ui27c-routing-add-effort-ignored', false);
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector(".sheet") && !!document.querySelector("[data-ro-rule=\\"3\\"]")', 'UI27c 第 4 条规则出现');
        await settled('UI27c 保存：Harness 测试的规则没有 effort（已忽略，不写）', async () => { assert.deepEqual((await readConfig()).routing.rules[3], { types: ['docs'], profile: 'deepseek-harness' }); });

        // 强执行者：兜底一节多一行，第一项"不设"，其余是启用的执行者；选中即写入 routing.strongExecutor。
        await enter('UI27c 重新进入页面（强执行者）');
        await check('UI27c 兜底一节两行：兜底执行者、强执行者（标题 ro.strong、说明 ro.strongHelp、默认"不设"）', `(() => { const rows = [...document.querySelectorAll('[data-ro-sec=fallback] .set-r')]; const s = rows[1]; return rows.length === 2 && s.querySelector('.l').firstChild.textContent === ${jsonStr(ro.strong)} && s.querySelector('.l span').textContent === ${jsonStr(ro.strongHelp)} && s.querySelector('[data-ro-strong] span').textContent === ${jsonStr(ro.strongNone)} && s.querySelector('[data-ro-strong]').getAttribute('aria-label') === ${jsonStr(`${ro.strong}：${ro.strongNone}`)}; })()`);
        await press('[data-ro-strong]');
        await wait('!!document.querySelector(".ctx")', 'UI27c 强执行者下拉');
        await settled('UI27c 强执行者下拉：第一项"不设"，其余是各个启用的执行者（没有停用的 Gamma）', async () => { assert.deepEqual(await menuLabels(), [ro.strongNone, 'Alpha 执行者', 'Beta 阅读者', 'Plain 通用', 'Claude 测试', 'DeepSeek 测试', 'Harness 测试']); });
        await press(await menuItem('Claude 测试'));
        await wait(`document.querySelector('[data-ro-strong] span')?.textContent === 'Claude 测试'`, 'UI27c 强执行者显示 Claude 测试');
        await settled('UI27c 选中即写入：routing.strongExecutor 是 claude-subscription，规则、兜底不变', async () => {
            const routing = (await readConfig()).routing;
            assert.equal(routing.strongExecutor, 'claude-subscription');
            assert.equal(routing.rules.length, 4);
            assert.equal(routing.fallback ?? null, null);
        });
        await verify('UI27c 核心读到的是同一个值：ar route config 的 strongExecutor', async () => { assert.equal((await core(['route', 'config'])).strongExecutor, 'claude-subscription'); });
        await shot('ui27c-routing-strong', false);
        await enter('UI27c 重新进入页面（强执行者已设）');
        await check('UI27c 重新进入页面后强执行者仍显示 Claude 测试', `document.querySelector('[data-ro-strong] span').textContent === 'Claude 测试'`);
        await pick('[data-ro-strong]', ro.strongNone);
        await wait(`document.querySelector('[data-ro-strong] span')?.textContent === ${jsonStr(ro.strongNone)}`, 'UI27c 选"不设"');
        await settled('UI27c 选"不设"：routing.strongExecutor 清除（null）', async () => { assert.equal((await readConfig()).routing.strongExecutor, null); });
        await verify('UI27c 核心读到的是清除后的值', async () => { assert.equal((await core(['route', 'config'])).strongExecutor, null); });

        // ---- UI31 审查设置与准确率（Stage08 158）：审查者候选下面的三行设置（开关、分段、下拉）即时写入 ar review config set；准确率一行一个审查者，和 ar review stats 一致 ----
        const reviewConfigNow = async () => (await readConfig()).review;
        const statsNow = async () => (await core(['review', 'stats'])).reviewers as { reviewer: string; severities: Record<string, { confirmed: number; valid: number }>; suggestBlock?: boolean }[];
        const labelsOf: Record<string, string> = { alpha: 'Alpha 执行者', beta: 'Beta 阅读者' };
        // 界面上的准确率行与核心的 stats 逐行一致：审查者、已确认 / 成立条数文字、百分比（各严重度加起来）。
        const accuracyMatches = async (label: string) => {
            const stats = await statsNow();
            const expected = stats.map(item => { const all = Object.values(item.severities).reduce((n, cell) => n + cell.confirmed, 0), ok = Object.values(item.severities).reduce((n, cell) => n + cell.valid, 0); return [item.reviewer, labelsOf[item.reviewer] ?? item.reviewer, rv.accuracyRow(all, ok), `${Math.round(ok / all * 100)}%`]; });
            await wait(`JSON.stringify([...document.querySelectorAll('[data-ro-rv-acc]')].map(r => [r.dataset.roRvAcc, r.querySelector('b').textContent, r.querySelector('[data-ro-rv-acc-count]').textContent, r.querySelector('[data-ro-rv-acc-pct]').textContent])) === ${jsonStr(jsonStr(expected))}`, label);
            return stats;
        };
        await enter('UI31 重新进入页面（审查设置）');
        // 改写（D128，191）：原断言 set.previousElementSibling 是与主导不同 → 新断言 中间多了"现在的主导"一行，它在三个开关与审查设置之间；原因：新增一行显示现在的主导。
        await check('UI31 审查者候选下面是审查设置三行（开关 / 分段 / 下拉），标题与说明逐字来自 rv；默认：开关关、分段"只建议"、下拉写 1 且不可用', `(() => { const s = document.querySelector('[data-ro-sec=reviewers]'); const set = s.querySelector('[data-ro-rv-set]'); const rows = [...set.querySelectorAll('.set-r')]; const t = set.querySelector('[data-ro-rv-default]'); const seg = [...set.querySelectorAll('[data-ro-rv-block]')]; const m = set.querySelector('[data-ro-rv-max]'); const p = s.querySelector('[data-ro-lead-now]'); return rows.length === 3 && rows.map(r => r.querySelector('.l').firstChild.textContent).join('|') === ${jsonStr([rv.defaultAll, rv.block, rv.maxReworks].join('|'))} && rows.map(r => r.querySelector('.l span').textContent).join('|') === ${jsonStr([rv.defaultAllHelp, rv.blockHelp, rv.maxReworksHelp].join('|'))} && t.getAttribute('role') === 'switch' && t.getAttribute('aria-checked') === 'false' && seg.map(b => b.textContent.trim()).join('|') === ${jsonStr([rv.blockModes.none, rv.blockModes.high].join('|'))} && seg[0].getAttribute('aria-pressed') === 'true' && seg[1].getAttribute('aria-pressed') === 'false' && m.disabled === true && m.querySelector('span').textContent === '1' && set.previousElementSibling === p && p.previousElementSibling === document.querySelector('[data-ro-differ-lead]') && s.querySelector('h2').textContent === ${jsonStr(ro.reviewSec)}; })()`);
        await verify('UI31 没写过审查设置时 config.json 没有 review，核心读到的是默认值 { default: false, block: none, maxReworks: 1 }', async () => { assert.equal((await readConfig()).review, undefined); assert.deepEqual((await core(['review', 'config'])).review, { default: false, block: 'none', maxReworks: 1 }); });
        await press('[data-ro-rv-default]');
        await wait(`document.querySelector('[data-ro-rv-default]').getAttribute('aria-checked') === 'true'`, 'UI31 打开"默认审查所有任务"');
        await settled('UI31 点开关：config.json 的 review 是 { default: true }，别的字段不变', async () => { assert.deepEqual(await reviewConfigNow(), { default: true }); });
        await press('[data-ro-rv-block=high]');
        await wait(`document.querySelector('[data-ro-rv-block=high]').getAttribute('aria-pressed') === 'true' && document.querySelector('[data-ro-rv-max]').disabled === false`, 'UI31 选"高严重度拦截"后下拉可用');
        await settled('UI31 点分段：review.block 是 high，default 保持 true', async () => { assert.deepEqual(await reviewConfigNow(), { default: true, block: 'high' }); });
        await pick('[data-ro-rv-max]', '3');
        await wait(`document.querySelector('[data-ro-rv-max] span').textContent === '3'`, 'UI31 下拉选 3');
        await settled('UI31 下拉选 3：review 是 { default: true, block: high, maxReworks: 3 }', async () => { assert.deepEqual(await reviewConfigNow(), { default: true, block: 'high', maxReworks: 3 }); });
        await verify('UI31 核心读到的是同一份：ar review config', async () => { assert.deepEqual((await core(['review', 'config'])).review, { default: true, block: 'high', maxReworks: 3 }); });
        await shot('ui31-routing-review-settings', false);
        // 写入失败：把 config.json 弄坏，点开关；核心拒绝，页面显示它给的原因，开关恢复成原来的值（开）；config.json 恢复后再点能写进去。
        const goodConfig = await readFile(configFile, 'utf8');
        await writeFile(configFile, '{ 坏掉的配置');
        await press('[data-ro-rv-default]');
        await wait(`!!document.querySelector('[data-ro-error] .banner.fail') && document.querySelector('[data-ro-rv-default]').getAttribute('aria-checked') === 'true'`, 'UI31 写入失败后显示原因、开关恢复');
        await check('UI31 写入失败：错误横幅有核心给的原因（非空），开关、分段、下拉都恢复成写之前的值', `(() => { const banner = document.querySelector('[data-ro-error] .banner.fail'); return banner.textContent.trim().length > 0 && document.querySelector('[data-ro-rv-default]').getAttribute('aria-checked') === 'true' && document.querySelector('[data-ro-rv-block=high]').getAttribute('aria-pressed') === 'true' && document.querySelector('[data-ro-rv-max] span').textContent === '3'; })()`);
        await verify('UI31 失败时核心什么都没写：config.json 仍是弄坏之后的样子', async () => { assert.equal(await readFile(configFile, 'utf8'), '{ 坏掉的配置'); });
        await writeFile(configFile, goodConfig);
        await press('[data-ro-rv-block=none]');
        await wait(`document.querySelector('[data-ro-rv-block=none]').getAttribute('aria-pressed') === 'true' && document.querySelector('[data-ro-rv-max]').disabled === true`, 'UI31 改回"只建议"后下拉不可用');
        await settled('UI31 config.json 恢复后再点：review.block 是 none，maxReworks 保持 3', async () => { assert.deepEqual(await reviewConfigNow(), { default: true, block: 'none', maxReworks: 3 }); });
        // 准确率：没有确认过的审查问题时写 rv.accuracyNone；往清单追加 review-confirm 事件后，每个审查者一行，与 ar review stats 一致；高严重度 20 条以上且准确率 80% 以上时多一句 rv.suggestBlock。
        const confirmRow = (id: string, issue: string, severity: string, result: string, reviewer: string) => JSON.stringify({ v: 1, event: 'review-confirm', id, issue, severity, result, by: 'human', reviewer, at: Date.now(), [MARK31]: true });
        await enter('UI31 重新进入页面（准确率）');
        if ((await statsNow()).length === 0) await check('UI31 还没有确认过的审查问题：写 rv.accuracyNone，没有审查者行', `document.querySelector('[data-ro-rv-acc-none]')?.textContent === ${jsonStr(rv.accuracyNone)} && document.querySelectorAll('[data-ro-rv-acc]').length === 0 && document.querySelectorAll('[data-ro-rv-suggest]').length === 0`);
        await writeFile(runsFile, ((await readFile(runsFile, 'utf8').catch(() => '')).replace(/\n*$/, '\n')) + [
            confirmRow('t-31a', 'R1-1', 'medium', 'valid', 'alpha'), confirmRow('t-31a', 'R1-2', 'low', 'valid', 'alpha'), confirmRow('t-31a', 'R1-3', 'high', 'invalid', 'alpha'),
            // 同一条问题确认两次，以最后一次为准（核心的统计规则）。
            confirmRow('t-31b', 'R1-1', 'medium', 'invalid', 'beta'), confirmRow('t-31b', 'R1-1', 'medium', 'valid', 'beta'), confirmRow('t-31b', 'R1-2', 'high', 'invalid', 'beta'),
        ].join('\n') + '\n');
        await enter('UI31 重新进入页面（有确认记录）');
        const stats = await accuracyMatches('UI31 准确率行出现');
        await verify('UI31 核心的 stats：alpha 已确认 3、成立 2；beta 已确认 2、成立 1（同一问题取最后一次）；都还没到提示拦截的条数', () => {
            const sum = (name: string) => { const item = stats.find(x => x.reviewer === name)!; return [Object.values(item.severities).reduce((n, cell) => n + cell.confirmed, 0), Object.values(item.severities).reduce((n, cell) => n + cell.valid, 0)]; };
            assert.deepEqual([sum('alpha'), sum('beta')], [[3, 2], [2, 1]]);
            assert.ok(!stats.some(item => item.suggestBlock));
        });
        await check('UI31 准确率：卡片标题 rv.accuracy，每个审查者一行（显示名、"已确认 N 条 · 成立 M 条"、百分比），没有 rv.suggestBlock 提示，底部一直有 rv.suggestBlockHelp', `(() => { const card = document.querySelector('[data-ro-rv-acc-list]'); const rows = [...card.querySelectorAll('[data-ro-rv-acc]')]; return card.querySelector('.ro-acc-h').textContent === ${jsonStr(rv.accuracy)} && rows.length === 2 && rows[0].querySelector('[data-ro-rv-acc-pct]').textContent === '67%' && rows[1].querySelector('[data-ro-rv-acc-pct]').textContent === '50%' && !document.querySelector('[data-ro-rv-suggest]') && [...document.querySelectorAll('[data-ro-sec=reviewers] .ro-note')].some(p => p.textContent === ${jsonStr(rv.suggestBlockHelp)}); })()`);
        await writeFile(runsFile, (await readFile(runsFile, 'utf8')).replace(/\n*$/, '\n') + Array.from({ length: 20 }, (_, i) => confirmRow('t-31c', `R1-${i + 1}`, 'high', 'valid', 'alpha')).join('\n') + '\n');
        await enter('UI31 重新进入页面（高严重度 20 条）');
        await accuracyMatches('UI31 准确率行更新');
        await verify('UI31 核心的 stats：alpha 的 high 已确认 21 条、成立 20 条，suggestBlock 为真；beta 没有', async () => { const now = await statsNow(); assert.equal(now.find(x => x.reviewer === 'alpha')!.suggestBlock, true); assert.ok(!now.find(x => x.reviewer === 'beta')!.suggestBlock); });
        await check('UI31 有 suggestBlock 的审查者多一句 rv.suggestBlock(显示名)，只有 alpha 一句', `(() => { const items = [...document.querySelectorAll('[data-ro-rv-suggest]')]; return items.length === 1 && items[0].dataset.roRvSuggest === 'alpha' && items[0].textContent === ${jsonStr(rv.suggestBlock('Alpha 执行者'))}; })()`);
        await reveal('reviewers');
        await pause(300);
        await shot('ui31-routing-review-accuracy');

        // ---- 每页通用检查：深浅两主题 × 默认 / 最小窗口 ----
        await h.audit('路由页', async () => { await press('[data-page=routing]'); await wait(ready, 'UI27 路由页（通用检查）'); await wait('!!document.querySelector("[data-ro-trial-result]")'); });
    }
    finally {
        if (await evaluate('!!document.querySelector(".sheet, .confirm-overlay, .ctx")').catch(() => false)) await key('Escape').catch(() => { });
        if (originalConfig === null) await rm(configFile, { force: true }).catch(() => { });
        else await writeFile(configFile, originalConfig).catch(() => { });
        if (originalTests === null) await rm(path.join(home, 'agent-tests.json'), { force: true }).catch(() => { });
        else if (originalTests !== undefined) await writeFile(path.join(home, 'agent-tests.json'), originalTests).catch(() => { });
        // 只去掉本检查写的那一行清单，不动别的。
        const runs = await readFile(runsFile, 'utf8').catch(() => null);
        if (runs !== null && runs.includes(MARK)) await writeFile(runsFile, runs.split('\n').filter(line => !line.includes(MARK)).join('\n')).catch(() => { });
        // UI31 写的 review-confirm 事件（带 ui31-review 标记）也只去掉自己的。
        const confirmRuns = await readFile(runsFile, 'utf8').catch(() => null);
        if (confirmRuns !== null && confirmRuns.includes(MARK31)) await writeFile(runsFile, confirmRuns.split('\n').filter(line => !line.includes(MARK31)).join('\n')).catch(() => { });
        // 按路由派发的任务（111）：按 id 去掉它所有的记录行（start / spawned / end 等）。
        const routedRuns = await readFile(runsFile, 'utf8').catch(() => null);
        if (routedRuns !== null && routedRuns.includes(ROUTED)) {
            const lines = routedRuns.split('\n');
            const ids = new Set(lines.map(line => { try { const row = JSON.parse(line); return row.event === 'start' && row.name === ROUTED ? row.id : null; } catch { return null; } }).filter(Boolean));
            await writeFile(runsFile, lines.filter(line => { try { return !ids.has(JSON.parse(line).id); } catch { return true; } }).join('\n')).catch(() => { });
        }
        if (registered) await coreRun(['projects', 'remove', projectDir], { timeoutMs: 60000 }).catch(() => { });
        await rm(path.join(home, 'shots-routing'), { recursive: true, force: true }).catch(() => { });
        win.setContentSize(original.size[0], original.size[1]);
        nativeTheme.themeSource = original.theme;
        await press('[data-page=tasks]').catch(() => { });
    }
}
