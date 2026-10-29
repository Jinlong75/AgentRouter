import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { nativeTheme, type BrowserWindow } from 'electron';
import { sc } from '../shared/copy';
import type { Report, ReportItem } from '../shared/types';
import type { Registry } from './registry';
import type { Harness } from './shots-input';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
const SCORE_ID = 't27';
// 185：自带演示审查结果的待验收任务（tools/demo/data.mjs 的 reviews.t32）。
const DEMO_REVIEW_ID = 't32';
const jsonStr = JSON.stringify;

// UI26 任务详情"评分"标签与设置页"统计主导的 token 与用时"（Stage06 T9b）。
// 演示任务 t27（三次尝试、升级、受保护路径；默认隐藏）临时显示，检查完恢复；分数全由核心 ar report 算，这里每一步都和同一时刻核心的结果对照。
// 全部用真实输入；环境隔离：AGENT_ROUTER_HOME、CLAUDE_CONFIG_DIR 都在系统临时目录里（测试环境没有会话记录）。
export async function captureScore(h: Harness, registry: Registry, win: BrowserWindow, save: (name: string) => Promise<void>) {
    const { evaluate, wait, check, verify, press, key, tabTo, focusRing, pause } = h;
    const home = appEnv.AGENT_ROUTER_HOME!, claude = appEnv.CLAUDE_CONFIG_DIR!;
    const temp = path.resolve(os.tmpdir()).toLowerCase();
    assert.ok(home && path.isAbsolute(home) && path.resolve(home).toLowerCase().startsWith(temp), '截图验收必须在隔离公共目录里运行');
    assert.ok(claude && path.isAbsolute(claude) && path.resolve(claude).toLowerCase().startsWith(temp), 'CLAUDE_CONFIG_DIR 必须指向系统临时目录里的隔离目录（不读真实的 ~/.claude）');
    const configFile = path.join(home, 'config.json'), tasksFile = path.join(registry.data, 'tasks.json');
    const originalConfig = await readFile(configFile, 'utf8').catch(() => null);
    const original = { size: win.getContentSize(), theme: nativeTheme.themeSource };
    const keysOf = async () => {
        const saved = JSON.parse(await readFile(tasksFile, 'utf8').catch(() => '{"imports":[],"hidden":[]}'));
        return { saved, hidden: (Array.isArray(saved.hidden) ? saved.hidden : []) as string[] };
    };
    const originalHidden = (await keysOf()).hidden.filter(entry => entry.startsWith(SCORE_ID + ':'));
    const setHidden = async (keep: boolean) => {
        const { saved, hidden } = await keysOf();
        const rest = hidden.filter(entry => !entry.startsWith(SCORE_ID + ':'));
        await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: keep ? [...rest, ...originalHidden] : rest }) + '\n');
        await registry.reloadHidden();
    };
    // 另一个默认隐藏的演示任务（185 的 t32）：第一次调用时记下它原来的隐藏项，keep 为 true 时放回。
    const originalHiddenOf = new Map<string, string[]>();
    const setHiddenOf = async (id: string, keep: boolean) => {
        const { saved, hidden } = await keysOf();
        if (!originalHiddenOf.has(id)) originalHiddenOf.set(id, hidden.filter(entry => entry.startsWith(id + ':')));
        const rest = hidden.filter(entry => !entry.startsWith(id + ':'));
        await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: keep ? [...rest, ...originalHiddenOf.get(id)!] : rest }) + '\n');
        await registry.reloadHidden();
    };
    const pair = async (name: string) => {
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await pause(350); await save(`${name}-${theme}`); }
        nativeTheme.themeSource = 'dark';
        await pause(350);
    };
    const core = async (args: string[], cwd: string) => {
        const r = await coreRun(args, { timeoutMs: 60000, cwd });
        assert.equal(r.code, 0, `ar ${args.join(' ')}：${r.stderr || r.json?.error}`);
        assert.equal(r.json?.ok, true, `ar ${args.join(' ')}：${r.json?.error}`);
        return r.json as Report;
    };
    const readConfig = async () => JSON.parse(await readFile(configFile, 'utf8'));
    // 页面上两张卡片：分数、每项（键、名称、明细、扣分）、封顶、进度条宽度、性能文字、卡片头的执行者名。
    const dom = async () => JSON.parse(await evaluate(`JSON.stringify(['executor', 'lead'].map(role => { const card = document.querySelector('[data-sc-card="' + role + '"]'); return {
        role, score: card.querySelector('[data-sc-score]').textContent, label: card.querySelector('[data-sc-score]').getAttribute('aria-label'), outOf: card.querySelector('.aside > span:last-child').textContent,
        who: card.querySelector('.card-h .muted').textContent, bar: card.querySelector('.sc-bar span').style.width, tone: [...card.querySelector('[data-sc-score]').classList].find(c => ['ok', 'mid', 'bad'].includes(c)),
        rows: [...card.querySelectorAll('[data-sc-item]')].map(r => [r.dataset.scItem, r.querySelector('.k').textContent, r.querySelector('.v').textContent, r.querySelector('.p').textContent, r.classList.contains('zero')]),
        cap: card.querySelector('[data-sc-cap]')?.textContent ?? null, perf: [...card.querySelectorAll('.sc-perf > span')].map(s => s.textContent) }; }))`)) as { role: string; score: string; label: string; outOf: string; who: string; bar: string; tone: string; rows: [string, string, string, string, boolean][]; cap: string | null; perf: string[] }[];
    // 与界面无关的期望：名称、扣分、分数档位都按文案和协议 16 写。
    const nameOf = (role: string, item: ReportItem) => role === 'lead' && item.key === 'needsScope' ? sc.leadNeedsScope : sc.items[item.key];
    const pointsOf = (item: ReportItem) => item.points ? `−${Math.abs(item.points)}` : '0';
    const toneOf = (n: number) => n >= 80 ? 'ok' : n >= 60 ? 'mid' : 'bad';
    const compare = (cards: Awaited<ReturnType<typeof dom>>, report: Report) => {
        assert.deepEqual(cards.map(c => c.role), ['executor', 'lead']);
        for (const [i, role] of (['executor', 'lead'] as const).entries()) {
            const side = report[role], card = cards[i];
            assert.equal(card.score, String(side.score), `${role} 分数`);
            assert.equal(card.label, sc.scoreLabel(side.score), `${role} aria-label`);
            assert.equal(card.outOf, sc.outOf);
            assert.equal(card.bar, `${side.score}%`, `${role} 进度条宽度`);
            assert.equal(card.tone, toneOf(side.score), `${role} 分数档位`);
            assert.deepEqual(card.rows.map(r => [r[0], r[1], r[3], r[4]]), side.items.map(item => [`${role}:${item.key}`, nameOf(role, item), pointsOf(item), item.points === 0]), `${role} 每项扣分`);
        }
    };
    // 同一时刻核心算的结果：用它对照界面。
    let repo = '', name = '', dir = '';
    const t27 = () => registry.tasks.find(t => t.id === SCORE_ID)!;
    const reportNow = () => core(['report', name, '--json'], repo);
    const colorOf = (token: string) => `(() => { const s = document.createElement('span'); s.style.color = 'var(${token})'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })()`;
    const openTab = async () => {
        await press('[data-page=tasks]');
        await wait('!!document.querySelector("[data-task]")');
        await press('[data-filter=all]');
        await press('[data-project]');
        await press('.ctx button');
        await wait(`!!document.querySelector('[data-task="${SCORE_ID}"]')`, 'UI26 任务页出现评分演示任务');
        await press(`[data-task="${SCORE_ID}"]`);
        await wait('!!document.querySelector("[data-tab=score]")', 'UI26 出现评分标签');
        await press('[data-tab=score]');
        await wait('!!document.querySelector("[data-sc-card=executor]")', 'UI26 评分卡片出现');
    };
    try {
        win.setContentSize(1160, 720);
        nativeTheme.themeSource = 'dark';
        await setHidden(false);
        await pause(400);
        await press('[data-page=tasks]');
        await wait('!!document.querySelector("[data-task]")');
        await press('[data-filter=all]');
        await press('[data-project]');
        await press('.ctx button');
        await wait(`!!document.querySelector('[data-task="${SCORE_ID}"]')`, 'UI26 显示评分演示任务');
        repo = t27().repo; name = t27().name; dir = path.join(repo, '.agent-runs', name);
        assert.ok(path.resolve(repo).toLowerCase().startsWith(temp), '演示项目必须在系统临时目录里');

        // ---- 标签的出现条件：没有任务说明的任务、进行中的任务没有这个标签；评分演示任务（已结束）在“参数”前面有 ----
        await press('[data-task=t3]');
        await check('UI26 直接写文字派发的任务（t3）没有"评分"标签', `!document.querySelector('[data-tab=score]')`);
        await press('[data-task=t1]');
        await check('UI26 进行中的任务（t1）没有"评分"标签', `!document.querySelector('[data-tab=score]')`);
        await press(`[data-task="${SCORE_ID}"]`);
        await check('UI26 用任务说明派发且已结束的任务有"评分"标签，文字是 sc.tab，紧挨在"参数"前面', `(() => { const tabs = [...document.querySelectorAll('.dtabs [data-tab]')]; const i = tabs.findIndex(b => b.dataset.tab === 'score'); return i > 0 && tabs[i].textContent.trim() === ${jsonStr(sc.tab)} && tabs[i + 1]?.dataset.tab === 'params'; })()`);

        // ---- 检查 1：两张卡片的分数、每项扣分与核心一致 ----
        await press('[data-tab=score]');
        await wait('!!document.querySelector("[data-sc-card=executor]")', 'UI26 评分卡片出现');
        const base = await reportNow();
        await verify('UI26 核心 ar report 的结果符合演示数据的形状：执行者 42 分（受保护 −15、升级 −10、工具报错 −3、门禁失败两次 −30），主导 100 分', () => {
            assert.equal(base.executor.score, 42);
            assert.equal(base.lead.score, 100);
            assert.equal(base.executor.cap, null);
            assert.deepEqual(base.attempts.map(a => [a.n, a.gate, a.blame]), [[1, false, 'worker'], [2, false, 'worker'], [3, true, null]]);
        });
        await check('UI26 两张卡片上下排：执行者在上、主导在下，宽度相同', `(() => { const [a, b] = ['executor', 'lead'].map(r => document.querySelector('[data-sc-card="' + r + '"]').getBoundingClientRect()); return a.bottom <= b.top && Math.abs(a.width - b.width) < 1 && a.left === b.left; })()`);
        await verify('UI26 两张卡片的分数、aria-label、进度条宽度、分数档位，与核心 ar report --json 一致；每项扣分逐行对得上（名称与扣分，没扣分的行是次级色类 zero）', async () => { compare(await dom(), base); });
        const first = await dom();
        await verify('UI26 明细写法：次数用 sc.count、文件用 detail 原文、工具报错用 sc.files、升级用 sc.escalatedAt、没有的写 sc.none、"需要越界"后带 sc.needsScopeFree', () => {
            const row = (role: number, key: string) => first[role].rows.find(r => r[0].endsWith(':' + key))![2];
            assert.equal(row(0, 'attemptGate'), sc.count(2));
            assert.equal(row(0, 'attemptAgent'), sc.count(0));
            assert.equal(row(0, 'protectedFile'), 'docs/specs/027-快捷键冲突提示.md');
            assert.equal(row(0, 'outsideFile'), sc.none);
            assert.equal(row(0, 'escalated'), sc.escalatedAt(3));
            assert.equal(row(0, 'toolError'), sc.files(3));
            assert.equal(row(0, 'needsScope'), sc.none + sc.needsScopeFree);
            assert.equal(row(1, 'specBlame'), sc.count(0));
            assert.equal(row(0, 'envBlame'), sc.none);
            assert.equal(row(1, 'envBlame'), sc.none);
            assert.equal(row(1, 'rejected'), sc.noAcceptance);
            assert.equal(row(1, 'conflict'), sc.noAcceptance);
            assert.equal(first[1].rows.find(r => r[0] === 'lead:needsScope')![1], sc.leadNeedsScope);
        });
        await verify('UI26 综合分颜色：<60 失败色、≥80 成功色；分数下的进度条同色', async () => {
            const [bad, ok] = [await evaluate(colorOf('--fail')), await evaluate(colorOf('--ok'))];
            const colors = JSON.parse(await evaluate(`JSON.stringify(['executor', 'lead'].map(role => { const card = document.querySelector('[data-sc-card="' + role + '"]'); return [getComputedStyle(card.querySelector('[data-sc-score]')).color, getComputedStyle(card.querySelector('.sc-bar span')).backgroundColor]; }))`));
            assert.deepEqual(colors, [[bad, bad], [ok, ok]]);
        });
        await check('UI26 卡片头：角色名、执行者名（配置名换成显示名，多个用 → 连接）、右侧"综合分 / 100"', `(() => { const cards = ['executor', 'lead'].map(r => document.querySelector('[data-sc-card="' + r + '"]')); const w = cards[0].querySelector('.card-h .muted').textContent; return cards[0].querySelector('.card-h b').textContent === ${jsonStr(sc.executor)} && cards[1].querySelector('.card-h b').textContent === ${jsonStr(sc.lead)} && w.startsWith('DeepSeek V4 Pro') && w.includes(' → ') && cards[1].querySelector('.card-h .muted').textContent === 'AgentRouter（软件）' && cards.every(c => c.querySelector('.aside > span:last-child').textContent === ${jsonStr(sc.outOf)}); })()`);
        await verify('UI26 卡片底部的性能：执行者用时 / token（k 写法一位小数）/ 费用没有价格 / 工具调用；主导用时 / token 没有统计（设置里打开后统计）', () => {
            const kilo = (n: number) => `${(n / 1000).toFixed(1)}k`, minutes = (ms: number) => `${(ms / 60000).toFixed(1)} 分钟`;
            const usage = base.executor.perf.usage!;
            assert.deepEqual(first[0].perf, [`${sc.perfTime}${minutes(base.executor.perf.ms)}`, `${sc.perfToken}${sc.tokens(kilo(usage.input!), kilo(usage.output!))}`, `${sc.perfCost}${sc.noPrice}`, `${sc.perfTools}${sc.toolCalls(base.executor.perf.toolCalls)}`]);
            assert.deepEqual(first[1].perf, [`${sc.perfLeadTime}${minutes(base.lead.perf.ms!)}`, `${sc.perfToken}${sc.leadUsageOff}`]);
            assert.equal(first[0].cap, null);
        });
        await check('UI26 门禁失败归因：每次门禁未通过一行（第 1、2 次），文案是 sc.blameRow / sc.blameWhy(核心的 summary)，分段控件是 radiogroup，aria-label 是 sc.blameLabel，默认选中"执行者"', `(() => { const rows = [...document.querySelectorAll('[data-sc-fail]')]; const group = n => rows[n - 1].querySelector('[role=radiogroup]'); return rows.length === 2 && rows.map(r => r.dataset.scFail).join() === '1,2' && rows[0].children[0].textContent === ${jsonStr(sc.blameRow(1))} && rows[0].querySelector('.why').textContent === ${jsonStr(sc.blameWhy(base.attempts[0].summary ?? ''))} && rows[1].querySelector('.why').textContent === ${jsonStr(sc.blameWhy(base.attempts[1].summary ?? ''))} && group(1).getAttribute('aria-label') === ${jsonStr(sc.blameLabel(1))} && group(2).getAttribute('aria-label') === ${jsonStr(sc.blameLabel(2))} && [1, 2].every(n => { const radios = [...group(n).querySelectorAll('[role=radio]')]; return radios.map(r => r.textContent).join() === ${jsonStr([sc.blameWorker, sc.blameSpec, sc.blameEnv].join())} && radios.map(r => r.getAttribute('aria-checked')).join() === 'true,false,false' && radios.map(r => r.tabIndex).join() === '0,-1,-1'; }); })()`);
        await check('UI26 归因一节有标题 sc.blameSec 和说明 sc.blameHelp', `(() => { const t = document.querySelector('.sec-t'); return t.firstChild.textContent === ${jsonStr(sc.blameSec)} && t.querySelector('.muted').textContent === ${jsonStr(sc.blameHelp)}; })()`);
        await pair('ui26-score');

        // ---- 检查 2：用键盘把第 1 次归因切到"任务说明"，再切回 ----
        const marks = path.join(dir, 'marks.json');
        await verify('UI26 切换前 marks.json 不存在', async () => { assert.equal(await readFile(marks, 'utf8').catch(() => null), null); });
        await tabTo('[data-sc-fail="1"] [role=radio][aria-checked=true]');
        await focusRing('UI26 归因分段控件（第 1 次，执行者）的焦点环');
        await key('Right');
        await wait(`document.querySelector('[data-sc-fail="1"] [role=radio][aria-checked=true]')?.dataset.blameWho === 'spec'`, 'UI26 方向键把第 1 次归因切到任务说明');
        await wait(`document.querySelector('[data-sc-card=executor] [data-sc-score]').textContent === ${jsonStr(String(base.executor.score + 15))}`, 'UI26 执行者分数加 15');
        const blamed = await reportNow();
        await verify('UI26 marks.json 写入第 1 次 → spec；核心重算：执行者 +15、主导 −15，界面两张卡片与核心一致', async () => {
            assert.deepEqual(JSON.parse(await readFile(marks, 'utf8')), { v: 1, blame: { 1: 'spec' } });
            assert.equal(blamed.executor.score, base.executor.score + 15);
            assert.equal(blamed.lead.score, base.lead.score - 15);
            assert.equal(blamed.attempts.find(a => a.n === 1)!.blame, 'spec');
            compare(await dom(), blamed);
        });
        await check('UI26 切换后焦点仍在第 1 次的分段控件上（选中"任务说明"），第 2 次不受影响，tabindex 随选中项移动', `(() => { const r1 = [...document.querySelectorAll('[data-sc-fail="1"] [role=radio]')], r2 = [...document.querySelectorAll('[data-sc-fail="2"] [role=radio]')]; return document.activeElement === r1[1] && r1.map(r => r.getAttribute('aria-checked')).join() === 'false,true,false' && r1.map(r => r.tabIndex).join() === '-1,0,-1' && r2.map(r => r.getAttribute('aria-checked')).join() === 'true,false,false'; })()`);
        await check('UI26 主导卡片出现"门禁失败归因到任务说明 1 次 −15"，执行者"多一次尝试：门禁未通过"变成 1 次 −15', `(() => { const row = k => [...document.querySelectorAll('[data-sc-item]')].find(r => r.dataset.scItem === k); return row('lead:specBlame').querySelector('.v').textContent === ${jsonStr(sc.count(1))} && row('lead:specBlame').querySelector('.p').textContent === '−15' && row('executor:attemptGate').querySelector('.v').textContent === ${jsonStr(sc.count(1))} && row('executor:attemptGate').querySelector('.p').textContent === '−15'; })()`);
        await pair('ui26-score-blame');
        await key('Left');
        await wait(`document.querySelector('[data-sc-fail="1"] [role=radio][aria-checked=true]')?.dataset.blameWho === 'worker'`, 'UI26 方向键把第 1 次归因切回执行者');
        await wait(`document.querySelector('[data-sc-card=executor] [data-sc-score]').textContent === ${jsonStr(String(base.executor.score))}`, 'UI26 执行者分数回到原值');
        await verify('UI26 切回"执行者"后 marks.json 里这个键被删掉；分数与核心重算一致，回到切换前', async () => {
            assert.deepEqual(JSON.parse(await readFile(marks, 'utf8')), { v: 1, blame: {} });
            const again = await reportNow();
            assert.equal(again.executor.score, base.executor.score);
            assert.equal(again.lead.score, base.lead.score);
            compare(await dom(), again);
        });
        // ---- 检查 2b：把第 1 次归因切到"环境"（键盘 Right 两下），两边都不扣分，再用鼠标点回"执行者" ----
        await key('Right');
        await wait(`document.querySelector('[data-sc-fail="1"] [role=radio][aria-checked=true]')?.dataset.blameWho === 'spec'`, 'UI26 方向键先到任务说明');
        await key('Right');
        await wait(`document.querySelector('[data-sc-fail="1"] [role=radio][aria-checked=true]')?.dataset.blameWho === 'environment'`, 'UI26 方向键再到环境');
        await wait(`document.querySelector('[data-sc-card=lead] [data-sc-item="lead:envBlame"] .v')?.textContent === ${jsonStr(sc.count(1) + sc.envFree)}`, 'UI26 两张卡片出现"环境原因 1 次（不扣分）"');
        const envReport = await reportNow();
        // 148：归因到环境的尝试不计工具报错。演示数据 t27 第 1 次有 2 个工具报错，按 reportWeights 默认每个 1 分，所以执行者多 2 分。
        const envToolErrorPoints = 2 * 1;
        await verify('UI26 归因到环境：执行者比"执行者"归因时高出这一次的扣分（+15）、主导分数不变；两张卡片的"环境原因"都是"1 次（不扣分）"、扣分 0；marks.json 这一键是 environment', async () => {
            assert.deepEqual(JSON.parse(await readFile(marks, 'utf8')), { v: 1, blame: { 1: 'environment' } });
            assert.equal(envReport.attempts.find(a => a.n === 1)!.blame, 'environment');
            const cards = await dom();
            assert.equal(Number(cards[0].score), base.executor.score + 15 + envToolErrorPoints);
            assert.equal(Number(cards[1].score), base.lead.score);
            assert.equal(envReport.executor.score, base.executor.score + 15 + envToolErrorPoints);
            assert.equal(cards[0].rows.find(r => r[0] === 'executor:toolError')![2], sc.files(1), '归因到环境后执行者的工具报错只剩 1 个');
            assert.equal(envReport.lead.score, base.lead.score);
            for (const [i, role] of ['executor', 'lead'].entries()) {
                const row = cards[i].rows.find(r => r[0] === `${role}:envBlame`)!;
                assert.deepEqual([row[1], row[2], row[3], row[4]], [sc.items.envBlame, sc.count(1) + sc.envFree, '0', true], `${role} 环境原因`);
            }
            assert.equal(cards[1].rows.find(r => r[0] === 'lead:specBlame')![2], sc.count(0), '主导的任务说明归因不增加');
            compare(cards, envReport);
        });
        await check('UI26 归因到环境后：焦点仍在第 1 次的分段控件上（选中"环境"），tabindex 随选中项移动，第 2 次不受影响', `(() => { const r1 = [...document.querySelectorAll('[data-sc-fail="1"] [role=radio]')], r2 = [...document.querySelectorAll('[data-sc-fail="2"] [role=radio]')]; return document.activeElement === r1[2] && r1.map(r => r.getAttribute('aria-checked')).join() === 'false,false,true' && r1.map(r => r.tabIndex).join() === '-1,-1,0' && r2.map(r => r.getAttribute('aria-checked')).join() === 'true,false,false'; })()`);
        await pair('ui26-score-env');
        await press('[data-sc-fail="1"] [data-blame-who=worker]');
        await wait(`document.querySelector('[data-sc-fail="1"] [role=radio][aria-checked=true]')?.dataset.blameWho === 'worker'`, 'UI26 点击把第 1 次归因从环境切回执行者');
        await wait(`document.querySelector('[data-sc-card=executor] [data-sc-score]').textContent === ${jsonStr(String(base.executor.score))}`, 'UI26 执行者分数复原');
        await verify('UI26 从环境点回"执行者"：分数复原，marks.json 删掉这个键，两张卡片的"环境原因"变回"没有"', async () => {
            assert.deepEqual(JSON.parse(await readFile(marks, 'utf8')), { v: 1, blame: {} });
            const cards = await dom(), again = await reportNow();
            assert.equal(again.executor.score, base.executor.score);
            assert.equal(again.lead.score, base.lead.score);
            for (const [i, role] of ['executor', 'lead'].entries()) assert.equal(cards[i].rows.find(r => r[0] === `${role}:envBlame`)![2], sc.none);
            compare(cards, again);
        });
        // 点击也能切换（鼠标）：第 2 次归因到任务说明再切回，验证两种输入都走同一条路径。
        await press('[data-sc-fail="2"] [data-blame-who=spec]');
        await wait(`document.querySelector('[data-sc-fail="2"] [role=radio][aria-checked=true]')?.dataset.blameWho === 'spec'`, 'UI26 点击把第 2 次归因切到任务说明');
        await verify('UI26 点击第 2 次的"任务说明"：marks.json 写入第 2 次；第 3 次（reason gate）和第 2 次的受保护路径都不算执行者的，核心重算后界面一致', async () => {
            assert.deepEqual(JSON.parse(await readFile(marks, 'utf8')), { v: 1, blame: { 2: 'spec' } });
            const second = await reportNow();
            assert.equal(second.executor.score, base.executor.score + 30);
            compare(await dom(), second);
        });
        await press('[data-sc-fail="2"] [data-blame-who=worker]');
        await wait(`document.querySelector('[data-sc-fail="2"] [role=radio][aria-checked=true]')?.dataset.blameWho === 'worker'`, 'UI26 点击把第 2 次归因切回执行者');
        await verify('UI26 第 2 次切回后 marks.json 里没有键，分数回到原值', async () => {
            assert.deepEqual(JSON.parse(await readFile(marks, 'utf8')), { v: 1, blame: {} });
            compare(await dom(), await reportNow());
        });

        // ---- 归因失败：核心写不进 marks.json 时显示错误横幅，选中状态不变 ----
        await rm(marks, { force: true });
        await mkdir(marks);
        try {
            await press('[data-sc-fail="1"] [data-blame-who=spec]');
            await wait(`!!document.querySelector('[data-sc-error] .banner.fail')`, 'UI26 归因失败时出现错误横幅');
            await check('UI26 归因失败：横幅标题是 sc.blameFailed、正文是核心原文（非空），第 1 次仍选中"执行者"，分数不变', `(() => { const b = document.querySelector('[data-sc-error] .banner.fail'); return b.getAttribute('role') === 'alert' && b.querySelector('.rt b').textContent === ${jsonStr(sc.blameFailed)} && b.querySelector('.rt span').textContent.length > 0 && document.querySelector('[data-sc-fail="1"] [role=radio][aria-checked=true]').dataset.blameWho === 'worker' && document.querySelector('[data-sc-card=executor] [data-sc-score]').textContent === ${jsonStr(String(base.executor.score))}; })()`);
            await save('ui26-score-blame-failed-dark');
        }
        finally { await rm(marks, { recursive: true, force: true }); }
        await press('[data-sc-fail="1"] [data-blame-who=spec]');
        await wait(`!document.querySelector('[data-sc-error] .banner.fail') && document.querySelector('[data-sc-fail="1"] [role=radio][aria-checked=true]')?.dataset.blameWho === 'spec'`, 'UI26 失败之后再次切换成功，错误横幅消失');
        await press('[data-sc-fail="1"] [data-blame-who=worker]');
        await wait(`document.querySelector('[data-sc-fail="1"] [role=radio][aria-checked=true]')?.dataset.blameWho === 'worker'`, 'UI26 恢复第 1 次归因');
        await verify('UI26 恢复后分数与核心一致', async () => { compare(await dom(), await reportNow()); });

        // ---- 检查 3：展开"综合分怎么算"，文字精确等于 sc.howText ----
        await check('UI26 "综合分怎么算"默认收起（details），摘要文字是 sc.how', `(() => { const d = document.querySelector('[data-sc-how]'); return d.tagName === 'DETAILS' && !d.open && d.querySelector('summary').textContent.trim() === ${jsonStr(sc.how)}; })()`);
        // 先用键盘：Tab 到摘要（焦点环可见）、回车展开；再用鼠标收起、展开，两种输入都走同一个 details。
        await tabTo('[data-sc-how] summary');
        await focusRing('UI26 "综合分怎么算"摘要的焦点环');
        await key('Enter');
        await wait(`document.querySelector('[data-sc-how]').open === true`, 'UI26 回车展开综合分怎么算');
        await check('UI26 展开后的说明文字精确等于 sc.howText', `document.querySelector('[data-sc-how] p').textContent === ${jsonStr(sc.howText)}`);
        await save('ui26-score-how-dark');
        await press('[data-sc-how] summary');
        await wait(`document.querySelector('[data-sc-how]').open === false`, 'UI26 点击收起综合分怎么算');
        await press('[data-sc-how] summary');
        await wait(`document.querySelector('[data-sc-how]').open === true`, 'UI26 点击展开综合分怎么算');
        await check('UI26 点击展开后的说明文字同样精确等于 sc.howText', `document.querySelector('[data-sc-how] p').textContent === ${jsonStr(sc.howText)}`);
        await press('[data-sc-how] summary');

        // ---- 检查 3b（Stage08 T6b）：有审查的任务多一张"审查者"卡片；没有审查的任务仍是两张 ----
        // 演示数据里没有带审查的任务：往 t27 的任务目录写 review.json、往清单追加一条 review 事件（带标记，检查完只删这一行），检查完恢复。
        await check('UI159 没有审查的任务（t27）评分标签仍是两张卡片：执行者、主导，核心的报告里没有 reviewer', `[...document.querySelectorAll('[data-sc-card]')].map(c => c.dataset.scCard).join() === 'executor,lead'`);
        await verify('UI159 核心 ar report --json 在没有审查时没有 reviewer 键', async () => { assert.equal('reviewer' in await reportNow(), false); });
        const runsFile = path.join(home, 'runs.jsonl'), reviewFile = path.join(dir, 'review.json'), marker = 'selfTest159';
        const reviewIssue = (id: string, severity: string, result: string | null) => ({ id, severity, file: 'src/input/conflict.ts', line: 1, title: `问题 ${id}`, detail: '', confirmation: result ? { result, by: 'human', note: null, at: Date.now() } : null });
        const dropReviewRow = async () => {
            const text = await readFile(runsFile, 'utf8').catch(() => '');
            if (text.includes(marker)) await writeFile(runsFile, text.split('\n').filter(line => !line.includes(marker)).join('\n'));
            await rm(reviewFile, { force: true });
        };
        const reviewerDom = async () => JSON.parse(await evaluate(`JSON.stringify((() => { const card = document.querySelector('[data-sc-card="reviewer"]'); return {
            title: card.querySelector('.card-h b').textContent, who: card.querySelector('.card-h .muted').textContent, score: card.querySelector('[data-sc-score]').textContent, label: card.querySelector('[data-sc-score]').getAttribute('aria-label'),
            outOf: card.querySelector('.aside > span:last-child').textContent, bar: card.querySelector('.sc-bar span').style.width, tone: [...card.querySelector('[data-sc-score]').classList].find(c => ['ok', 'mid', 'bad'].includes(c)),
            rows: [...card.querySelectorAll('[data-sc-item]')].map(r => [r.dataset.scItem, r.querySelector('.k').textContent, r.querySelector('.v').textContent, r.querySelector('.p').textContent, r.classList.contains('zero')]),
            perf: [...card.querySelectorAll('.sc-perf > span')].map(s => s.textContent) }; })())`)) as { title: string; who: string; score: string; label: string; outOf: string; bar: string; tone: string; rows: [string, string, string, string, boolean][]; perf: string[] };
        try {
            await writeFile(reviewFile, JSON.stringify({
                v: 1, attempt: 3, at: Date.now(), reviewer: 'codex', crossed: true, base: null, head: null, verdict: 'concerns', summary: '', reviewed: [],
                issues: [reviewIssue('R3-1', 'high', 'invalid'), reviewIssue('R3-2', 'medium', 'valid'), reviewIssue('R3-3', 'low', 'invalid'), reviewIssue('R3-4', 'low', null)], warnings: [],
                tries: [{ reviewer: 'deepseek', ok: false, why: '没有结论', kind: 'parse', ms: 500 }, { reviewer: 'codex', ok: true, ms: 107500 }], ms: 108000, usage: { input: 12400, output: 900 }, raw: null,
            }, null, 2) + '\n');
            await writeFile(runsFile, (await readFile(runsFile, 'utf8')).replace(/\n*$/, '\n') + JSON.stringify({ v: 1, event: 'review', id: SCORE_ID, attempt: 3, reviewer: 'codex', crossed: true, verdict: 'concerns', issues: 4, high: 1, at: Date.now(), [marker]: true }) + '\n');
            await press('[data-task=t3]');
            await press(`[data-task="${SCORE_ID}"]`);
            await press('[data-tab=score]');
            await wait('!!document.querySelector("[data-sc-card=reviewer]")', 'UI159 有审查的任务出现"审查者"卡片');
            const reviewed = await reportNow();
            await verify('UI159 核心的报告多 reviewer：审查者 codex（交叉）75 分——没按格式 −10、不成立的低 −5、不成立的高 −10；问题 4 个（高 1 · 中 1 · 低 2）、成立 1 / 已确认 3、用时 108 秒、token 12400 / 900；执行者、主导不变', () => {
                const group = reviewed.reviewer!;
                assert.equal(group.score, 75);
                assert.equal(group.profile, 'codex');
                assert.equal(group.crossed, true);
                assert.deepEqual(group.items.map(i => [i.key, i.count, i.points]), [['reviewInvalid', 0, 0], ['reviewFormat', 1, -10], ['reviewFalse', 1, -5], ['reviewFalseHigh', 1, -10]]);
                assert.deepEqual(group.perf, { issues: { total: 4, high: 1, medium: 1, low: 2 }, confirmed: 3, valid: 1, ms: 108000, usage: { input: 12400, output: 900 } });
                assert.equal(reviewed.executor.score, base.executor.score);
                assert.equal(reviewed.lead.score, base.lead.score);
            });
            const reviewerChecks = async (report: Report) => {
                const card = await reviewerDom(), group = report.reviewer!;
                assert.equal(card.title, sc.reviewer);
                assert.ok(card.who.toLowerCase().includes('codex') && card.who.endsWith('（交叉）'), `卡片头的审查者：${card.who}`);
                assert.equal(card.score, String(group.score), '审查者分数');
                assert.equal(card.label, sc.scoreLabel(group.score));
                assert.equal(card.outOf, sc.outOf);
                assert.equal(card.bar, `${group.score}%`);
                assert.equal(card.tone, toneOf(group.score));
                assert.deepEqual(card.rows.map(r => [r[0], r[1], r[3], r[4]]), group.items.map(item => [`reviewer:${item.key}`, sc.items[item.key], pointsOf(item), item.points === 0]), '审查者每项扣分');
                assert.deepEqual(card.rows.map(r => r[2]), [sc.none, sc.count(1) + '（deepseek）', sc.files(1) + '（低）', sc.files(1)], '审查者每项明细');
                const kilo = (n: number) => `${(n / 1000).toFixed(1)}k`;
                assert.deepEqual(card.perf, [
                    `${sc.reviewPerfIssues}${sc.reviewPerfIssuesValue(4, 1, 1, 2)}`, `${sc.reviewPerfValid}${sc.reviewPerfValidValue(1, 3)}`,
                    `${sc.perfTime}${(group.perf.ms / 60000).toFixed(1)} 分钟`, `${sc.perfToken}${sc.tokens(kilo(12400), kilo(900))}`,
                ]);
            };
            await verify('UI159 第三张卡片"审查者"：标题、审查者名带"（交叉）"、分数 / aria-label / 进度条 / 档位、每项名称明细扣分、性能四项（问题、成立、用时、token），全部与核心一致', async () => { await reviewerChecks(reviewed); });
            await check('UI159 三张卡片的顺序是执行者、主导、审查者，宽度相同、上下排；其余两张的分数仍与核心一致', `(() => { const cards = [...document.querySelectorAll('[data-sc-card]')]; const r = cards.map(c => c.getBoundingClientRect()); return cards.map(c => c.dataset.scCard).join() === 'executor,lead,reviewer' && r[0].bottom <= r[1].top && r[1].bottom <= r[2].top && Math.abs(r[0].width - r[2].width) < 1 && r[0].left === r[2].left; })()`);
            await verify('UI159 执行者、主导两张卡片与核心一致（有审查时它们不变）', async () => { compare(await dom(), reviewed); });
            await pair('ui159-score-reviewer');
            // 用鼠标把第 1 次归因切到"任务说明"：重画后审查者卡片还在、内容不变，执行者 +15 / 主导 −15；再切回。
            await press('[data-sc-fail="1"] [data-blame-who=spec]');
            await wait(`document.querySelector('[data-sc-card=executor] [data-sc-score]').textContent === ${jsonStr(String(base.executor.score + 15))}`, 'UI159 归因切换后执行者分数 +15');
            await verify('UI159 切换归因后重画：审查者卡片仍在，分数与每项不变，且与核心一致', async () => {
                const again = await reportNow();
                assert.equal(again.reviewer!.score, 75);
                compare(await dom(), again);
                await reviewerChecks(again);
            });
            await press('[data-sc-fail="1"] [data-blame-who=worker]');
            await wait(`document.querySelector('[data-sc-card=executor] [data-sc-score]').textContent === ${jsonStr(String(base.executor.score))}`, 'UI159 归因切回执行者');
        }
        finally { await dropReviewRow(); }
        await press('[data-task=t3]');
        await press(`[data-task="${SCORE_ID}"]`);
        await press('[data-tab=score]');
        await wait(`!!document.querySelector("[data-sc-card=executor]") && !document.querySelector("[data-sc-card=reviewer]")`, 'UI159 去掉审查记录后审查者卡片消失');
        await check('UI159 去掉审查记录后回到两张卡片，核心的报告里没有 reviewer', `[...document.querySelectorAll('[data-sc-card]')].map(c => c.dataset.scCard).join() === 'executor,lead'`);
        await verify('UI159 恢复后核心没有 reviewer，两张卡片与核心一致', async () => { const again = await reportNow(); assert.equal('reviewer' in again, false); compare(await dom(), again); });

        // ---- 检查 3c（185，D117 演示数据补审查）：演示任务 t32（待验收）自带审查结果，评分标签直接有"审查者"一组 ----
        // t32 默认隐藏（worktree 演示任务）：临时显示、检查完恢复。期望值全部来自 data.mjs 的 reviews.t32：Codex 交叉审查，三个问题（中 2 · 低 1），R1-2 成立、R1-3 不成立（低，扣 5 分），用时 108 秒，token 12400 / 900。
        await setHiddenOf(DEMO_REVIEW_ID, false);
        await press('[data-page=tasks]');
        await wait('!!document.querySelector("[data-task]")');
        await press('[data-filter=all]');
        await press('[data-project]');
        await press('.ctx button');
        await wait(`!!document.querySelector('[data-task="${DEMO_REVIEW_ID}"]')`, 'UI185 显示带审查的演示任务 t32', 20000);
        const t32 = registry.tasks.find(t => t.id === DEMO_REVIEW_ID)!;
        await press(`[data-task="${DEMO_REVIEW_ID}"]`);
        await wait('!!document.querySelector("[data-tab=score]")', 'UI185 t32 出现评分标签');
        await press('[data-tab=score]');
        await wait('!!document.querySelector("[data-sc-card=reviewer]")', 'UI185 t32 的评分标签有"审查者"卡片');
        const demoReport = await core(['report', t32.name, '--json'], t32.repo);
        await verify('UI185 演示任务 t32 的评分：核心报告有审查者一组——codex（交叉）95 分，只扣"不成立的低"一个 −5；问题 3 个（中 2 · 低 1）、成立 1 / 已确认 2、用时 108 秒、token 12400 / 900', () => {
            const group = demoReport.reviewer!;
            assert.equal(group.score, 95);
            assert.equal(group.profile, 'codex');
            assert.equal(group.crossed, true);
            assert.deepEqual(group.items.map(i => [i.key, i.count, i.points]), [['reviewInvalid', 0, 0], ['reviewFormat', 0, 0], ['reviewFalse', 1, -5], ['reviewFalseHigh', 0, 0]]);
            assert.deepEqual(group.perf, { issues: { total: 3, high: 0, medium: 2, low: 1 }, confirmed: 2, valid: 1, ms: 108000, usage: { input: 12400, output: 900 } });
        });
        await verify('UI185 t32 评分标签三张卡片（执行者、主导、审查者）与核心一致，审查者卡片的标题、审查者名带"（交叉）"、分数、每项名称明细扣分、性能四项都对得上', async () => {
            const cards = await dom(), card = await reviewerDom(), group = demoReport.reviewer!, kilo = (n: number) => `${(n / 1000).toFixed(1)}k`;
            assert.equal(await evaluate(`[...document.querySelectorAll('[data-sc-card]')].map(c => c.dataset.scCard).join()`), 'executor,lead,reviewer');
            compare(cards, demoReport);
            assert.equal(card.title, sc.reviewer);
            assert.ok(card.who.toLowerCase().includes('codex') && card.who.endsWith('（交叉）'), `卡片头的审查者：${card.who}`);
            assert.equal(card.score, String(group.score));
            assert.equal(card.label, sc.scoreLabel(group.score));
            assert.equal(card.bar, `${group.score}%`);
            assert.equal(card.tone, toneOf(group.score));
            assert.deepEqual(card.rows.map(r => [r[0], r[1], r[3], r[4]]), group.items.map(item => [`reviewer:${item.key}`, sc.items[item.key], pointsOf(item), item.points === 0]));
            assert.deepEqual(card.rows.map(r => r[2]), [sc.none, sc.none, sc.files(1) + '（低）', sc.none]);
            assert.deepEqual(card.perf, [`${sc.reviewPerfIssues}${sc.reviewPerfIssuesValue(3, 0, 2, 1)}`, `${sc.reviewPerfValid}${sc.reviewPerfValidValue(1, 2)}`, `${sc.perfTime}${(group.perf.ms / 60000).toFixed(1)} 分钟`, `${sc.perfToken}${sc.tokens(kilo(12400), kilo(900))}`]);
        });
        await pair('ui185-score-reviewer-demo');
        await setHiddenOf(DEMO_REVIEW_ID, true);
        await openTab();

        // ---- 最小窗口 ----
        win.setContentSize(960, 600);
        await pause(500);
        await check('UI26 最小窗口 960×600：卡片不横向溢出，每项扣分的三列都在卡片里', `(() => { const sc = document.querySelector('.dbody > .scroll'); const cards = [...document.querySelectorAll('[data-sc-card]')]; return sc.scrollWidth <= sc.clientWidth && cards.every(card => [...card.querySelectorAll('.sc-r')].every(r => r.getBoundingClientRect().right <= card.getBoundingClientRect().right + 0.5)); })()`);
        await pair('ui26-score-narrow');
        win.setContentSize(original.size[0], original.size[1]);
        await pause(500);

        // ---- 检查 4：设置页打开"统计主导的 token 与用时" ----
        const before = (await readConfig().catch(() => ({}))).leadUsage === true;
        assert.equal(before, false, '测试开始时 leadUsage 应是关闭的');
        await press('[data-page=settings]');
        await wait('!!document.querySelector("[data-pref=lead-usage]")', 'UI26 设置页出现评分一节');
        await check('UI26 设置页"评分"一节：标题 sc.settingsSec、一行 sc.leadUsage 加说明 sc.leadUsageHelp、开关默认关', `(() => { const sec = [...document.querySelectorAll('.doc-in .sect')].find(s => s.querySelector('h2')?.textContent === ${jsonStr(sc.settingsSec)}); const r = sec.querySelector('.set-r'); const t = r.querySelector('[data-pref=lead-usage]'); return r.querySelector('.l').firstChild.textContent === ${jsonStr(sc.leadUsage)} && r.querySelector('.l span').textContent === ${jsonStr(sc.leadUsageHelp)} && t.getAttribute('role') === 'switch' && t.getAttribute('aria-checked') === 'false' && t.getAttribute('aria-label') === ${jsonStr(sc.leadUsage)}; })()`);
        await tabTo('[data-pref=lead-usage]');
        await focusRing('UI26 设置页"统计主导的 token 与用时"开关的焦点环');
        await save('ui26-score-settings-dark');
        await key('Enter');
        await wait(`document.querySelector('[data-pref=lead-usage]')?.getAttribute('aria-checked') === 'true'`, 'UI26 打开统计主导的 token 与用时');
        await verify('UI26 打开后 config.json 的 leadUsage 为 true（布尔），配置里的其余字段原样保留', async () => {
            const after = await readConfig();
            assert.strictEqual(after.leadUsage, true);
            assert.deepEqual({ ...after, leadUsage: undefined }, { ...(originalConfig ? JSON.parse(originalConfig) : after), leadUsage: undefined });
        });
        await openTab();
        await wait(`document.querySelector('[data-sc-card=lead] .sc-perf')?.textContent.includes(${jsonStr(sc.leadUsageUnavailable)})`, 'UI26 主导卡片的 token 变成"找不到派发会话的记录"');
        await verify('UI26 主导卡片的 token 一项是 sc.leadUsageUnavailable（测试环境没有会话记录）；与核心 usageState 一致', async () => {
            const cards = await dom(), report = await reportNow();
            assert.equal(report.lead.perf.usageState, 'unavailable');
            assert.equal(cards[1].perf.at(-1), `${sc.perfToken}${sc.leadUsageUnavailable}`);
            compare(cards, report);
        });
        await pair('ui26-score-lead-usage');
        // 核心拒绝时：配置文件读不了，ar report 拒绝，界面显示 sc.unavailable 加核心原文（检查后立刻恢复）。
        const good = await readFile(configFile, 'utf8');
        try {
            await writeFile(configFile, '{ "v": 2, ');
            await press('[data-task=t3]');
            await press(`[data-task="${SCORE_ID}"]`);
            await press('[data-tab=score]');
            await wait(`!!document.querySelector('[data-sc-unavailable]')`, 'UI26 核心拒绝时显示没有评分');
            await check('UI26 核心拒绝时：标题是 sc.unavailable，下面是核心原文（非空），不显示卡片', `(() => { const e = document.querySelector('[data-sc-unavailable]'); return e.querySelector('b').textContent === ${jsonStr(sc.unavailable)} && e.querySelector('p').textContent.length > 0 && !document.querySelector('[data-sc-card]'); })()`);
            await save('ui26-score-unavailable-dark');
        }
        finally { await writeFile(configFile, good); }
        // 恢复原值：回设置页关掉开关，再按原样写回配置文件。
        await press('[data-page=settings]');
        await wait('!!document.querySelector("[data-pref=lead-usage]")', 'UI26 回到设置页');
        await wait(`document.querySelector('[data-pref=lead-usage]')?.getAttribute('aria-checked') === 'true'`, 'UI26 设置页读到恢复后的配置');
        await press('[data-pref=lead-usage]');
        await wait(`document.querySelector('[data-pref=lead-usage]')?.getAttribute('aria-checked') === 'false'`, 'UI26 关掉统计主导的 token 与用时');
        await verify('UI26 检查后恢复原值：leadUsage 回到关闭', async () => { assert.notStrictEqual((await readConfig()).leadUsage, true); });
        await openTab();
        await wait(`document.querySelector('[data-sc-card=lead] .sc-perf')?.textContent.includes(${jsonStr(sc.leadUsageOff)})`, 'UI26 关闭后主导 token 回到"没有统计"');
    }
    finally {
        if (await evaluate('!!document.querySelector(".sheet, .confirm-overlay, .sort-pop, .ctx")').catch(() => false)) await key('Escape').catch(() => { });
        if (originalConfig === null) await rm(configFile, { force: true }).catch(() => { });
        else await writeFile(configFile, originalConfig).catch(() => { });
        await rm(path.join(dir || path.join(home, 'none'), 'marks.json'), { recursive: true, force: true }).catch(() => { });
        await rm(path.join(dir || path.join(home, 'none'), 'review.json'), { force: true }).catch(() => { });
        await readFile(path.join(home, 'runs.jsonl'), 'utf8').then(text => text.includes('selfTest159') ? writeFile(path.join(home, 'runs.jsonl'), text.split('\n').filter(line => !line.includes('selfTest159')).join('\n')) : undefined).catch(() => { });
        await setHidden(true).catch(() => { });
        await setHiddenOf(DEMO_REVIEW_ID, true).catch(() => { });
        win.setContentSize(original.size[0], original.size[1]);
        nativeTheme.themeSource = original.theme;
    }
}
