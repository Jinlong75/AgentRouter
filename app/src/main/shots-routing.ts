import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { nativeTheme, type BrowserWindow } from 'electron';
import { c, ro, wt as w } from '../shared/copy';
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
    const home = appEnv.AGENT_ROUTER_HOME!;
    const temp = path.resolve(os.tmpdir()).toLowerCase();
    assert.ok(home && path.isAbsolute(home) && path.resolve(home).toLowerCase().startsWith(temp), '截图验收必须在隔离公共目录里运行');
    const configFile = path.join(home, 'config.json'), runsFile = path.join(home, 'runs.jsonl');
    const originalConfig = await readFile(configFile, 'utf8').catch(() => null);
    const original = { size: win.getContentSize(), theme: nativeTheme.themeSource };
    const MARK = 'ui27-limit', ROUTED = 'ui27-routed';
    const projectDir = path.join(home, 'shots-routing', 'rules-project');
    let registered = false;

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
            catch (error) { if (Date.now() > end) throw error; await pause(150); }
        }
    });
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
        await check('UI27 审查者候选：没有候选时只有"添加"按钮和"必须与执行者不同"（默认勾选，用 choice 组件样式）', `(() => { const s = document.querySelector('[data-ro-sec=reviewers]'); const d = s.querySelector('[data-ro-differ]'); return !s.querySelector('[data-ro-chip]') && s.querySelector('[data-ro-review-add]').textContent.trim() === ${jsonStr(ro.reviewAdd)} && d.classList.contains('choice') && d.getAttribute('role') === 'checkbox' && d.getAttribute('aria-checked') === 'true' && d.querySelector('.ct').firstChild.textContent === ${jsonStr(ro.reviewDiffer)} && d.querySelector('.ct span').textContent === ${jsonStr(ro.reviewDifferHelp)}; })()`);
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

        // ---- 每页通用检查：深浅两主题 × 默认 / 最小窗口 ----
        await h.audit('路由页', async () => { await press('[data-page=routing]'); await wait(ready, 'UI27 路由页（通用检查）'); await wait('!!document.querySelector("[data-ro-trial-result]")'); });
    }
    finally {
        if (await evaluate('!!document.querySelector(".sheet, .confirm-overlay, .ctx")').catch(() => false)) await key('Escape').catch(() => { });
        if (originalConfig === null) await rm(configFile, { force: true }).catch(() => { });
        else await writeFile(configFile, originalConfig).catch(() => { });
        // 只去掉本检查写的那一行清单，不动别的。
        const runs = await readFile(runsFile, 'utf8').catch(() => null);
        if (runs !== null && runs.includes(MARK)) await writeFile(runsFile, runs.split('\n').filter(line => !line.includes(MARK)).join('\n')).catch(() => { });
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
