import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { effects } from './effects';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { nativeTheme } from 'electron';
import { pollUntil, type Harness } from './shots-input';
import type { Registry } from './registry';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';
import { gt, rt } from '../shared/copy';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
const RETRY_IDS = ['t25', 't26'];
// 验收里的 git 也只用隔离环境（GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM 见 tools/demo/preferences.mjs）。
const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, env: appEnv });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return String(r.stdout).trim();
};
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
// 汇报正文去掉标题的 # 与全部空白后比较：界面把 Markdown 排成标题 + 段落，文字内容与文件一致。
const flat = (text: string) => text.replace(/^#+\s*/gm, '').replace(/\s+/g, '');

// UI23：Stage05 多次尝试界面（061）。演示任务 t25（自动重试进行中）、t26（升级后第 3 次完成）默认隐藏在 tasks.json 的 hidden 里，
// 这里临时显示、检查完恢复；t25 在演示里没有存活的派发进程，检查时拉起一个假派发进程并追加 resume 让它回到进行中。
// 真实重试：临时仓库 + 假执行者派发一个门禁会失败的任务（max_retries: 0），在软件里点"重试"换另一个执行者并写补充说明，
// 断言清单、attempts/<n>/prompt.md 与界面。全程只用系统临时目录里的隔离公共目录和 fake 执行者。
export async function captureRetry(h: Harness, registry: Registry, out: string, save: (name: string) => Promise<void>) {
    const { evaluate, wait, check, verify, press, key, type, tabTo, focusRing, pause, audit } = h;
    const home = appEnv.AGENT_ROUTER_HOME!;
    assert.ok(home && path.isAbsolute(home), '截图验收必须在隔离公共目录里运行');
    const tasksFile = path.join(registry.data, 'tasks.json');
    const configFile = path.join(home, 'config.json'), releaseFile = path.join(out, 'retry-release.flag');
    const keysOf = async (ids: string[]) => {
        const saved = JSON.parse(await readFile(tasksFile, 'utf8').catch(() => '{"imports":[],"hidden":[]}'));
        const hidden: string[] = Array.isArray(saved.hidden) ? saved.hidden : [];
        return hidden.filter(entry => ids.some(id => entry.startsWith(id + ':')));
    };
    const originalKeys = await keysOf(RETRY_IDS);
    const hide = async (keys: string[]) => {
        const saved = JSON.parse(await readFile(tasksFile, 'utf8').catch(() => '{"imports":[],"hidden":[]}'));
        const hidden: string[] = Array.isArray(saved.hidden) ? saved.hidden : [];
        await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: [...new Set([...hidden, ...keys])] }) + '\n');
        await registry.reloadHidden();
    };
    const reveal = async (ids: string[]) => {
        const saved = JSON.parse(await readFile(tasksFile, 'utf8').catch(() => '{"imports":[],"hidden":[]}'));
        const hidden: string[] = Array.isArray(saved.hidden) ? saved.hidden : [];
        const drop = new Set(hidden.filter(entry => ids.some(id => entry.startsWith(id + ':'))));
        await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: hidden.filter(entry => !drop.has(entry)) }) + '\n');
        await registry.reloadHidden();
    };
    const pair = async (name: string) => {
        for (const theme of ['dark', 'light'] as const) {
            nativeTheme.themeSource = theme;
            await pause(350);
            await save(`${name}-${theme}`);
        }
        nativeTheme.themeSource = 'dark';
        await pause(350);
    };
    const menuItem = async (label: string) => {
        const index = await evaluate(`(() => { const items = [...document.querySelectorAll('.ctx button')]; items.forEach((b, i) => b.setAttribute('data-menu-index', String(i))); return items.findIndex(b => b.textContent.trim() === ${JSON.stringify(label)}); })()`);
        assert.ok(index >= 0, `菜单里没有「${label}」`);
        return `.ctx button[data-menu-index="${index}"]`;
    };
    const rows = async () => (await readFile(registry.file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) as any[];
    const untilRow = async <T,>(fn: () => Promise<T | undefined | null>, label: string, timeoutMs = 20000): Promise<T> => {
        let value: T | undefined | null;
        if ((await pollUntil(async () => (value = await fn()), timeoutMs)).ok) return value as T;
        throw Error(`等待超时：${label}（${timeoutMs} ms）`);
    };
    const core = async (args: string[], cwd?: string) => {
        const r = await coreRun(args, { timeoutMs: 60000, cwd });
        assert.equal(r.code, 0, `ar ${args.join(' ')}：${r.stderr || r.json?.error}`);
        assert.equal(r.json?.ok, true, `ar ${args.join(' ')}：${r.json?.error}`);
        return r.json;
    };
    // 同一条 JS 表达式里取令牌里的失败色，不写死色值。
    const failColor = `(() => { const s = document.createElement('span'); s.style.color = 'var(--fail)'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })()`;
    const text = (selector: string) => `document.querySelector(${JSON.stringify(selector)})?.textContent`;
    // 执行者配置：只有 fake 适配器（派发与"原执行者 / 换执行者"都不碰任何真实服务）。
    // fake 是原执行者（不写文件，门禁失败）；strong 是升级目标（写完成标记并提交，门禁通过，等放行文件才结束，好观察"进行中"）；
    // codex / deepseek / claude-native 是演示任务记录里出现过的配置名（codex 让 t3 的重试走到核心的"旧版本派发"拒绝）。
    const profile = (label: string, extra: Record<string, unknown> = {}) => ({ adapter: 'fake', label, enabled: true, events: [{ kind: 'say', text: `${label}：假执行者已完成。` }], report: '假汇报\n', exit: 0, version: 'fake-agent 1.0', ...extra });
    const config = {
        v: 2, defaultProfile: 'fake', managed: false, watchWindow: 'never', profiles: {
            fake: profile('假执行者'),
            strong: profile('强执行者', { events: [{ kind: 'say', text: '强执行者完成' }], report: '强汇报\n', writes: [{ path: 'src/done.txt', content: '任务完成\n' }], commit: '假执行者：写入完成标记', releaseFile, releaseTimeoutMs: 60000 }),
            codex: profile('Codex'),
            deepseek: profile('DeepSeek V4 Pro'),
            'claude-native': profile('Claude Sonnet 5.5'),
        },
    };
    const originalConfig = await readFile(configFile, 'utf8').catch(() => null);
    let alive: ChildProcess | undefined, retryName = '', retryStarted = 0, retryId = '', repo = '', scopeStarted = 0, scopeId = '';
    try {
        await writeFile(configFile, JSON.stringify(config, null, 2) + '\n');
        await reveal(RETRY_IDS);
        // 看板筛选恢复到全部项目、全部状态，演示任务和临时任务才一定可见。
        await press('[data-page=tasks]');
        await wait('!!document.querySelector("[data-task]")');
        await press('[data-filter=all]');
        await press('[data-project]');
        await press('.ctx button');
        await wait('!!document.querySelector("[data-task=t26]")', 'UI23 显示多次尝试演示任务');
        const t25 = registry.tasks.find(t => t.id === 't25')!, t26 = registry.tasks.find(t => t.id === 't26')!;
        assert.ok(t25 && t26, '多次尝试演示任务应出现在快照里');
        const dir25 = path.dirname(t25.progress), dir26 = path.dirname(t26.progress);
        const attemptFile = (dir: string, n: number, name: string) => path.join(dir, 'attempts', String(n), name);
        const report1 = await readFile(attemptFile(dir26, 1, 'report.md'), 'utf8'), report3 = await readFile(attemptFile(dir26, 3, 'report.md'), 'utf8');
        const gate26 = await Promise.all([1, 2, 3].map(n => readJson(attemptFile(dir26, n, 'gate.json'))));
        await verify('UI23 演示数据：t26 有 3 次尝试，每次都有 prompt.md / report.md / gate.json，门禁依次为 未通过 / 未通过 / 通过', async () => {
            assert.deepEqual(t26.attempts!.map(a => [a.n, a.total, a.profile, a.reason, a.ok]), [[1, 3, 'deepseek', 'first', false], [2, 3, 'deepseek', 'gate', false], [3, 3, 'claude-native', 'gate', true]]);
            for (const n of [1, 2, 3]) await readFile(attemptFile(dir26, n, 'prompt.md'), 'utf8');
            assert.deepEqual(gate26.map(g => [g.attempt, g.ok]), [[1, false], [2, false], [3, true]]);
            assert.deepEqual(t25.attempts!.map(a => [a.n, a.total, a.reason, a.ok]), [[1, 3, 'first', false], [2, 3, 'gate', undefined]]);
            assert.equal((await readJson(path.join(dir25, 'gate.json'))).attempt, 1, '顶层 gate.json 是最新写出的那一次');
        });

        // ---- t25：自动重试进行中。拉起假派发进程 + resume，回到"进行中" ----
        const script = path.join(out, 'retry-fake', 'ar.mjs');
        await mkdir(path.dirname(script), { recursive: true });
        await writeFile(script, 'setInterval(() => { }, 1000);\n');
        const minimal: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
        for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[name]) minimal[name] = process.env[name];
        alive = spawn(process.execPath, [script], { env: minimal, stdio: 'ignore', shell: false, windowsHide: true });
        await new Promise<void>((resolve, reject) => { alive!.once('spawn', () => resolve()); alive!.once('error', reject); });
        await appendFile(registry.file, JSON.stringify({ v: 1, event: 'resume', id: 't25', pid: alive.pid, n: 2, at: Date.now() }) + '\n');
        await registry.refresh();
        await wait('document.querySelector("[data-task=t25] .mk")?.classList.contains("run") === true', 'UI23 自动重试中的 t25 回到进行中', 15000);
        await check('UI23 列表第二行在执行者标签后显示"尝试 2/3"，悬停说明写明共允许 3 次', `(() => { const a = document.querySelector('[data-task=t25] .att'); return !!a && a.textContent === ${JSON.stringify(rt.tag(2, 3))} && a.title === ${JSON.stringify(rt.tagTip(2, 3))} && a.previousElementSibling?.classList.contains('xtag') === true; })()`);
        await check('UI23 没有多次尝试的任务列表行没有"尝试 n/N"', '!document.querySelector("[data-task=t3] .att") && !document.querySelector("[data-task=t1] .att")');
        await press('[data-task=t25]');
        await wait('!!document.querySelector(".track .node")', 'UI23 t25 的流水线轨道');
        await check('UI23 轨道执行节点运行中写"第 2/3 次"，aria-label 说清第几次尝试与共允许几次，门禁节点为等待', `(() => { const n = document.querySelectorAll('.track .node'); return n.length === 3 && n[1].querySelector('.sub').textContent === ${JSON.stringify(rt.trackRun(2, 3))} && n[1].getAttribute('aria-label') === ${JSON.stringify(gt.nodeLabel(gt.track.run, rt.nodeRun(2, 3)))} && n[2].querySelector('.sub').textContent === ${JSON.stringify(gt.trackGateWait)}; })()`);
        await check('UI23 进行中的任务只有"停止"，没有"重试"按钮', '!document.querySelector("[data-retry]") && !!document.querySelector("[data-stop]")');

        // ---- 进展：尝试切换条与分隔行 ----
        await wait(`document.querySelectorAll('.tl.k-att').length === 2`, 'UI23 进展里每次尝试一行分隔', 15000);
        const bar = `[...document.querySelectorAll('.att-bar .segm button')]`;
        await check('UI23 进展顶部是尝试切换条：全部 / 第 1 次 / 第 2 次，"全部"选中，分段的 aria-label 为"按尝试查看"', `(() => { const g = document.querySelector('.att-bar .segm.sm'); return g?.getAttribute('aria-label') === ${JSON.stringify(rt.barLabel)} && ${bar}.map(b => b.textContent).join('/') === ${JSON.stringify([rt.all, rt.nth(1), rt.nth(2)].join('/'))} && ${bar}.map(b => b.getAttribute('aria-pressed')).join() === 'true,false,false'; })()`);
        await check('UI23 "全部"时每次尝试开头一行分隔：第 n 次尝试 · 执行者 · 原因', `(() => { const s = [...document.querySelectorAll('.tl.k-att')]; return s.length === 2 && s[0].querySelector('b').textContent === ${JSON.stringify(rt.sep(1))} && s[0].querySelector('.c > span').textContent === ${JSON.stringify(rt.sepMeta('DeepSeek V4 Pro', rt.reason.first))} && s[1].querySelector('b').textContent === ${JSON.stringify(rt.sep(2))} && s[1].querySelector('.c > span').textContent === ${JSON.stringify(rt.sepMeta('DeepSeek V4 Pro', rt.reason.gate))}; })()`);
        await check('UI23 "全部"时两次尝试的事件按次序排在各自的分隔行后', `(() => { const t = document.querySelector('.events-host').textContent; const a = t.indexOf('先读任务说明和现有的导出模块。'), s = t.indexOf(${JSON.stringify(rt.sep(2))}), b = t.indexOf('上一次 tests/export 有 1 条没过'); return a >= 0 && s > a && b > s; })()`);
        await pair('attempt-switch');
        await press('[data-att="1"]');
        await wait(`document.querySelectorAll('.tl.k-att').length === 0`, 'UI23 切到第 1 次');
        await check('UI23 切到"第 1 次"：时间线只剩第 1 次的事件、第 1 次不画分隔行、切换条选中第 1 次', `(() => { const t = document.querySelector('.events-host').textContent; return t.includes('先读任务说明和现有的导出模块。') && t.includes('已提交，汇报写好了。') && !t.includes('上一次 tests/export 有 1 条没过') && !document.querySelector('.tl.k-att') && ${bar}.map(b => b.getAttribute('aria-pressed')).join() === 'false,true,false' && ${bar}[1].classList.contains('on'); })()`);
        await pair('attempt-switch-one');
        await press('[data-att="2"]');
        await wait(`document.querySelectorAll('.tl.k-att').length === 1`, 'UI23 切到第 2 次');
        await check('UI23 切到"第 2 次"：只显示第 2 次的事件，开头有第 2 次的分隔行', `(() => { const t = document.querySelector('.events-host').textContent; const s = document.querySelectorAll('.tl.k-att'); return t.includes('上一次 tests/export 有 1 条没过') && !t.includes('先读任务说明和现有的导出模块。') && s.length === 1 && s[0].querySelector('b').textContent === ${JSON.stringify(rt.sep(2))} && ${bar}.map(b => b.getAttribute('aria-pressed')).join() === 'false,false,true'; })()`);
        await press('[data-att="all"]');
        await wait(`document.querySelectorAll('.tl.k-att').length === 2`, 'UI23 切回全部');
        await check('UI23 切回"全部"：两条分隔行、两次的事件都在', `(() => { const t = document.querySelector('.events-host').textContent; return document.querySelectorAll('.tl.k-att').length === 2 && t.includes('先读任务说明和现有的导出模块。') && t.includes('上一次 tests/export 有 1 条没过') && ${bar}[0].classList.contains('on'); })()`);
        // 键盘：Tab 到"第 1 次"，焦点环可见，回车选中，焦点留在按钮上。
        await tabTo('[data-att="1"]', 120);
        await focusRing('UI23 尝试切换条');
        await key('Enter');
        await wait(`document.querySelectorAll('.tl.k-att').length === 0`, 'UI23 键盘切到第 1 次');
        await check('UI23 键盘 Tab 到"第 1 次"回车后选中它，焦点仍在这个按钮上', `document.activeElement === document.querySelector('[data-att="1"]') && document.querySelector('[data-att="1"]').getAttribute('aria-pressed') === 'true'`);
        await press('[data-att="all"]');
        await wait(`document.querySelectorAll('.tl.k-att').length === 2`, 'UI23 再切回全部');
        await audit('尝试切换', async () => { await press('[data-task=t25]'); await press('.dtabs [data-tab=flow]'); });

        // ---- t26：已完成，升级后第 3 次 ----
        await press('[data-task=t26]');
        await wait(`document.querySelector('.att-pick .sel span')?.textContent === ${JSON.stringify(rt.pickOption(3, true, 'Claude Sonnet 5.5'))}`, 'UI23 汇报标签默认最新一次（读到执行者显示名）', 20000);
        await check('UI23 已完成多次尝试的任务：列表显示"尝试 3/3"，标题行有"重试"按钮（在"再派一次"前）', `(() => { const a = document.querySelector('[data-task=t26] .att'); const r = document.querySelector('[data-retry]'); return a?.textContent === ${JSON.stringify(rt.tag(3, 3))} && r?.title === ${JSON.stringify(rt.buttonTip)} && r.textContent.trim() === ${JSON.stringify(rt.button)} && r.nextElementSibling?.hasAttribute('data-redispatch') === true; })()`);
        await check('UI23 轨道执行节点完成且不是第 1 次，写"第 3 次完成"，aria-label 写明前 2 次没有通过', `(() => { const n = document.querySelectorAll('.track .node')[1]; return n.querySelector('.sub').textContent === ${JSON.stringify(rt.trackDone(3))} && n.getAttribute('aria-label') === ${JSON.stringify(gt.nodeLabel(gt.track.run, rt.nodeDone(3)))}; })()`);
        await check('UI23 汇报标签顶部有尝试下拉（默认最新，标注"最新"），汇报是第 3 次的 report.md', `document.querySelector('.att-pick .muted')?.textContent === ${JSON.stringify(rt.pick)} && document.querySelector('.att-pick .sel').getAttribute('aria-haspopup') === 'listbox' && ${JSON.stringify(flat(report3))} === document.querySelector('.tab-body .md').textContent.replace(/\\s+/g, '')`);
        await press('[data-att-pick]');
        await wait('!!document.querySelector(".ctx")', 'UI23 尝试下拉');
        await check('UI23 尝试下拉列出每一次：第 n 次（最新）· 执行者', `[...document.querySelectorAll('.ctx button')].map(b => b.textContent).join('|') === ${JSON.stringify([rt.pickOption(1, false, 'DeepSeek V4 Pro'), rt.pickOption(2, false, 'DeepSeek V4 Pro'), rt.pickOption(3, true, 'Claude Sonnet 5.5')].join('|'))}`);
        await press(await menuItem(rt.pickOption(1, false, 'DeepSeek V4 Pro')));
        await wait(`document.querySelector('.att-pick .sel span')?.textContent === ${JSON.stringify(rt.pickOption(1, false, 'DeepSeek V4 Pro'))}`, 'UI23 选第 1 次');
        await wait(`document.querySelector('.tab-body .md')?.textContent.replace(/\\s+/g, '') === ${JSON.stringify(flat(report1))}`, 'UI23 汇报换成第 1 次的');
        await check('UI23 下拉选第 1 次后汇报正文换成 attempts/1/report.md 的内容（与演示文件精确比较）', `document.querySelector('.tab-body .md').textContent.replace(/\\s+/g, '') === ${JSON.stringify(flat(report1))} && ${JSON.stringify(flat(report1))} !== ${JSON.stringify(flat(report3))}`);
        await pair('attempt-report');
        await press('.dtabs [data-tab=gate]');
        await wait(`document.querySelector('.tab-body .banner.fail .rt span')?.textContent === ${JSON.stringify(gate26[0].summary)}`, 'UI23 门禁标签读第 1 次的 gate.json', 15000);
        await check('UI23 门禁标签保持所选的第 1 次：下拉写第 1 次，横幅与失败命令是第 1 次 gate.json 的内容', `(() => { const row = [...document.querySelectorAll('.tab-body .grow.bad')].find(r => r.querySelector('code')?.textContent === ${JSON.stringify(gate26[0].commands[0].line)}); return document.querySelector('.att-pick .sel span').textContent === ${JSON.stringify(rt.pickOption(1, false, 'DeepSeek V4 Pro'))} && document.querySelector('.tab-body .banner.fail .rt span').textContent === ${JSON.stringify(gate26[0].summary)} && !!row && row.querySelector('.meta').textContent.includes('exit=1'); })()`);
        await press('[data-att-pick]');
        await press(await menuItem(rt.pickOption(2, false, 'DeepSeek V4 Pro')));
        await wait(`document.querySelector('.tab-body .banner.fail .rt span')?.textContent === ${JSON.stringify(gate26[1].summary)}`, 'UI23 门禁标签换成第 2 次');
        await check('UI23 选第 2 次：门禁是第 2 次的（超出范围的受保护文件标红并注明）', `(() => { const row = [...document.querySelectorAll('.tab-body .grow')].find(r => r.querySelector('.v.mono')?.textContent === 'docs/specs/026-快捷键设置.md'); return !!row && row.classList.contains('bad') && row.querySelector('.meta').textContent === ${JSON.stringify(gt.scopeProtected)} && getComputedStyle(row.querySelector('.v.mono')).color === ${failColor}; })()`);
        await pair('attempt-gate');
        await press('[data-att-pick]');
        await press(await menuItem(rt.pickOption(3, true, 'Claude Sonnet 5.5')));
        await wait(`document.querySelector('.tab-body .banner.ok .rt b')?.textContent === ${JSON.stringify(gt.okTitle(3, gate26[2].commands.length, (gate26[2].ms / 1000).toFixed(1)))}`, 'UI23 门禁标签换回最新一次');
        await check('UI23 选回最新一次：门禁通过横幅按第 3 次 gate.json 计算', `document.querySelector('.tab-body .banner.ok .rt b').textContent === ${JSON.stringify(gt.okTitle(3, gate26[2].commands.length, (gate26[2].ms / 1000).toFixed(1)))} && document.querySelector('.att-pick .sel span').textContent === ${JSON.stringify(rt.pickOption(3, true, 'Claude Sonnet 5.5'))}`);

        // ---- 重试历史 ----
        await check('UI23 "重试"标签在"改动"之后、"参数"之前，右边的数字是尝试次数 3', `(() => { const keys = [...document.querySelectorAll('.dtabs [data-tab]')].map(b => b.dataset.tab); return keys.join() === 'flow,report,gate,files,retry,score,params' && document.querySelector('.dtabs [data-tab=retry]').textContent.replace(/\\s+/g, '') === ${JSON.stringify(rt.tab + '3')}; })()`);
        await press('.dtabs [data-tab=retry]');
        await wait(`document.querySelectorAll('.ahist-r').length === 3 && document.querySelectorAll('.ahist-r .res')[0]?.textContent.startsWith('门禁未通过：')`, 'UI23 重试历史读到各次门禁', 15000);
        const histRow = (n: number, label: string, why: string, res: string, meta: string[]) => ({ nth: rt.nth(n), label, why: `原因：${why}`, res, meta: meta.join('|'), aria: rt.rowLabel(n, res) });
        const histExpect = [
            histRow(1, 'DeepSeek V4 Pro', rt.reason.first, rt.resultGateFail(gate26[0].summary), ['9.4 分钟', rt.tokens('41.2k', '6.8k')]),
            histRow(2, 'DeepSeek V4 Pro', rt.reason.gate, rt.resultGateFail(gate26[1].summary), ['8.7 分钟', rt.tokens('29.5k', '4.1k')]),
            histRow(3, 'Claude Sonnet 5.5', rt.reason.gate + rt.escalated, rt.resultGateOk, ['13.4 分钟', rt.tokens('52.0k', '9.3k')]),
        ];
        await check('UI23 重试历史标题行与提示：共 3 次尝试，自动最多 3 次', `document.querySelector('.tab-body .sec-t').textContent.startsWith(${JSON.stringify(rt.histHead(3, 3))}) && document.querySelector('.tab-body .sec-t').textContent.endsWith(${JSON.stringify(rt.histHint)})`);
        await check('UI23 重试历史 3 行，每行两层：第 n 次 · 执行者 · 原因 / 结果，右侧用时与 token，aria-label 为第 n 次尝试：结果，查看进展', `(() => { const rows = [...document.querySelectorAll('.ahist-r')]; const want = ${JSON.stringify(histExpect)}; return rows.length === 3 && rows.every((r, i) => r.querySelector('.l1 b').textContent === want[i].nth && r.querySelector('.ex').textContent === want[i].label && r.querySelector('.why').textContent === want[i].why && r.querySelector('.res').textContent === want[i].res && [...r.querySelectorAll('.meta span')].map(s => s.textContent).join('|') === want[i].meta && r.querySelector('.xtag') !== null && r.getAttribute('aria-label') === want[i].aria); })()`);
        await check('UI23 重试历史：失败的行结果用失败色，通过的行不用', `(() => { const rows = [...document.querySelectorAll('.ahist-r')]; const fail = ${failColor}; return rows[0].classList.contains('bad') && rows[1].classList.contains('bad') && !rows[2].classList.contains('bad') && getComputedStyle(rows[0].querySelector('.res')).color === fail && getComputedStyle(rows[2].querySelector('.res')).color !== fail; })()`);
        await pair('retry-history');
        await audit('重试历史', async () => { await press('[data-task=t26]'); await press('.dtabs [data-tab=retry]'); });
        // 点第 2 行：切到"进展"并选中第 2 次。
        await press('.ahist-r[data-att-row="2"]');
        await wait(`document.querySelector('.dtabs [data-tab=flow]')?.classList.contains('on') === true && document.querySelectorAll('.tl.k-att').length === 1`, 'UI23 点第 2 行切到进展');
        await check('UI23 点重试历史第 2 行：切到"进展"标签、切换条选中第 2 次、只显示第 2 次的事件', `(() => { const t = document.querySelector('.events-host').textContent; const g = [...document.querySelectorAll('.att-bar .segm button')]; return g.map(b => b.getAttribute('aria-pressed')).join() === 'false,false,true,false' && t.includes('顺手把任务说明里的验收命令改短了') && !t.includes('恢复了任务说明') && document.querySelector('.tl.k-att b').textContent === ${JSON.stringify(rt.sep(2))}; })()`);
        await press('[data-att="3"]');
        await wait(`document.querySelector('.tl.k-att .c > span')?.textContent === ${JSON.stringify(rt.sepMeta('Claude Sonnet 5.5', rt.reason.gate + rt.escalated))}`, 'UI23 第 3 次的分隔行写升级执行者');
        await check('UI23 第 3 次的分隔行写显示名与"门禁未通过 · 升级执行者"', `document.querySelector('.tl.k-att .c > span').textContent === ${JSON.stringify(rt.sepMeta('Claude Sonnet 5.5', rt.reason.gate + rt.escalated))}`);
        // 键盘到历史行：Tab 到第 1 行，回车跳到进展并选中第 1 次。
        await press('.dtabs [data-tab=retry]');
        await wait('document.querySelectorAll(".ahist-r").length === 3');
        await tabTo('.ahist-r[data-att-row="1"]', 120);
        await focusRing('UI23 重试历史行');
        await key('Enter');
        await wait(`document.querySelector('.dtabs [data-tab=flow]')?.classList.contains('on') === true && document.querySelector('[data-att="1"]')?.getAttribute('aria-pressed') === 'true'`, 'UI23 键盘选重试历史第 1 行');
        await check('UI23 键盘 Tab 到重试历史第 1 行回车：切到进展并选中第 1 次', `document.querySelector('[data-att="1"]').getAttribute('aria-pressed') === 'true' && !document.querySelector('.tl.k-att')`);

        // ---- 重试弹窗：已完成的任务，补充说明必填 ----
        await press('[data-retry]');
        await wait('!!document.querySelector(".sheet [data-retry-note]")', 'UI23 重试弹窗（已完成）');
        await check('UI23 已完成任务的重试弹窗：标题、没有"上一次失败"提示、执行者默认原执行者、补充说明必填、主按钮禁用', `(() => { const s = document.querySelector('.sheet'); const primary = s.querySelector('[data-sheet-btn="1"]'); return s.getAttribute('aria-label') === ${JSON.stringify(rt.title(t26.title))} && !s.querySelector('.retry-last') && s.querySelector('[data-retry-worker]').textContent.trim() === ${JSON.stringify(rt.workerOrig('DeepSeek V4 Pro'))} && s.textContent.includes(${JSON.stringify(rt.noteHelpRequired)}) && s.querySelector('.fl em') !== null && s.querySelector('[data-retry-note]').placeholder === ${JSON.stringify(rt.notePh)} && s.querySelector('.sheet-f .note').textContent === ${JSON.stringify(rt.consequence(true))} && primary.textContent.trim() === ${JSON.stringify(rt.start(4))} && !!primary.querySelector('i.ri-arrow-go-forward-line') && primary.disabled === true; })()`);
        await check('UI23 重试弹窗打开时焦点在补充说明输入框', `document.activeElement === document.querySelector('[data-retry-note]')`);
        await pair('retry-sheet-done');
        await type('[data-retry-note]', 'tighten the keymap tests');
        await check('UI23 补充说明写了内容后主按钮可用', `document.querySelector('.sheet [data-sheet-btn="1"]').disabled === false`);
        await key('a', ['control']);
        await key('Backspace');
        await check('UI23 补充说明清空后主按钮又禁用', `document.querySelector('[data-retry-note]').value === '' && document.querySelector('.sheet [data-sheet-btn="1"]').disabled === true`);
        const resumesBefore = (await rows()).filter(r => r.event === 'resume').length;
        await key('Escape');
        await check('UI23 Esc 关闭重试弹窗，焦点回到"重试"按钮，没有发出重试', `!document.querySelector('.sheet') && document.activeElement === document.querySelector('[data-retry]')`);
        await verify('UI23 取消重试没有写 resume', async () => { assert.equal((await rows()).filter(r => r.event === 'resume').length, resumesBefore); });
        await audit('重试弹窗', async () => {
            if (!await evaluate('!!document.querySelector(".sheet")')) { await press('[data-task=t26]'); await press('[data-retry]'); }
        });
        await press('.sheet [data-sheet-btn="0"]');
        await check('UI23 点"取消"关闭重试弹窗', '!document.querySelector(".sheet")');

        // ---- 旧任务重试失败：核心拒绝，弹窗里显示横幅，弹窗不关 ----
        await press('[data-task=t3]');
        await wait('!!document.querySelector("[data-retry]")', 'UI23 已完成的旧任务有重试按钮');
        await press('[data-retry]');
        await wait('!!document.querySelector(".sheet [data-retry-note]")', 'UI23 旧任务的重试弹窗');
        await type('[data-retry-note]', 'please redo');
        const startsBefore = (await rows()).filter(r => r.event === 'start' || r.event === 'resume').length;
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!!document.querySelector(".sheet .sheet-fail")', 'UI23 旧任务重试失败横幅', 20000);
        await check('UI23 重试失败：弹窗里的错误横幅标题"没有开始重试"、正文为核心返回的原因，弹窗不关、按钮恢复', `(() => { const b = document.querySelector('.sheet .sheet-fail'); const p = document.querySelector('.sheet [data-sheet-btn="1"]'); return b.querySelector('.rt b').textContent === ${JSON.stringify(rt.failed)} && b.querySelector('.rt span').textContent === '这个任务是旧版本派发的，没有保存派发参数，不能再派一次' && b.getAttribute('role') === 'alert' && p.disabled === false && p.textContent.trim() === ${JSON.stringify(rt.start(2))} && document.querySelector('[data-sheet-btn="0"]').disabled === false; })()`);
        await verify('UI23 重试失败不写任何新记录', async () => { assert.equal((await rows()).filter(r => r.event === 'start' || r.event === 'resume').length, startsBefore); });
        await pair('retry-sheet-error');
        await press('.sheet [data-sheet-btn="0"]');

        // ---- 真实重试：假执行者派发一个门禁会失败的任务（max_retries: 0），在软件里换执行者重试 ----
        repo = path.join(home, 'shots-retry', 'sample');
        const specRel = 'docs/specs/071-重试验收.md';
        await mkdir(path.join(repo, 'docs', 'specs'), { recursive: true });
        git(repo, ['init', '-b', 'main']);
        git(repo, ['config', 'user.name', 'AgentRouter Shots']);
        git(repo, ['config', 'user.email', 'shots@example.invalid']);
        git(repo, ['config', 'commit.gpgsign', 'false']);
        git(repo, ['config', 'core.autocrlf', 'false']);
        await writeFile(path.join(repo, '.gitignore'), '.agent-runs/\n');
        await mkdir(path.join(repo, 'src'), { recursive: true });
        await writeFile(path.join(repo, 'src', 'a.txt'), '初始\n');
        await writeFile(path.join(repo, specRel), ['---', 'id: 971', 'title: 重试验收', 'type: code', 'allowed_paths:', '  - src/**', 'verify:', '  - git cat-file -e HEAD:src/done.txt', 'max_retries: 0', '---', '', '重试验收正文。', ''].join('\n'));
        git(repo, ['add', '--', '.gitignore', 'src/a.txt', specRel]);
        git(repo, ['commit', '-m', '初始提交', '--', '.gitignore', 'src/a.txt', specRel]);
        await core(['projects', 'add', repo]);
        retryName = 'retry-demo';
        const dispatched = await core(['dispatch', specRel, '--name', retryName, '--profile', 'fake', '--detach'], repo);
        retryId = String(dispatched.id);
        assert.ok(retryId, '派发没有返回 id');
        const gateRow = await untilRow(async () => (await rows()).find(r => r.id === retryId && r.event === 'gate'), '第一次尝试的门禁结果', 30000);
        await untilRow(async () => (await rows()).find(r => r.id === retryId && r.event === 'end'), '第一次尝试结束', 30000);
        retryStarted = (await rows()).find(r => r.id === retryId && r.event === 'start').started;
        await registry.refresh();
        await verify('UI23 真实重试的起点：门禁未通过（max_retries 0 只跑 1 次），清单里只有 1 个 attempt', async () => {
            assert.equal(gateRow.ok, false);
            const list = (await rows()).filter(r => r.id === retryId);
            assert.deepEqual(list.filter(r => r.event === 'attempt').map(r => [r.n, r.total, r.reason, r.profile]), [[1, 1, 'first', 'fake']]);
            assert.equal(list.at(-1).event, 'end');
            assert.equal(list.at(-1).exit, 3);
        });
        await press('[data-page=tasks]');
        await wait(`!!document.querySelector("[data-task=${retryId}]")`, 'UI23 临时任务进列表', 15000);
        await press(`[data-task=${retryId}]`);
        await wait('!!document.querySelector("[data-retry]")', 'UI23 失败的临时任务有重试按钮');
        await check('UI23 门禁失败的单次尝试任务：列表没有"尝试 n/N"（total 为 1），没有重试标签', `!document.querySelector("[data-task=${retryId}] .att") && !document.querySelector('.dtabs [data-tab=retry]')`);
        await press('[data-retry]');
        await wait('!!document.querySelector(".sheet [data-retry-note]")', 'UI23 重试弹窗（失败）');
        await check('UI23 失败任务的重试弹窗：顶部"会附上上一次的失败原因"+ 门禁 summary，补充说明可选，主按钮可用，写"开始第 2 次尝试"', `(() => { const s = document.querySelector('.sheet'); const last = s.querySelector('.retry-last'); const p = s.querySelector('[data-sheet-btn="1"]'); return !!last && last.querySelector('b').textContent === ${JSON.stringify(rt.lastFail)} && last.textContent.endsWith(${JSON.stringify(gateRow.summary)}) && s.textContent.includes(${JSON.stringify(rt.noteHelp)}) && !s.textContent.includes(${JSON.stringify(rt.noteHelpRequired)}) && p.disabled === false && p.textContent.trim() === ${JSON.stringify(rt.start(2))} && s.querySelector('[data-retry-worker]').textContent.trim() === ${JSON.stringify(rt.workerOrig('假执行者'))}; })()`);
        await press('[data-retry-worker]');
        await wait('!!document.querySelector(".ctx")', 'UI23 执行者下拉');
        await check('UI23 执行者下拉第一项是"原执行者"，其后是其他启用的执行者（不重复原执行者）', `(() => { const items = [...document.querySelectorAll('.ctx button')].map(b => b.textContent.trim()); return items[0] === ${JSON.stringify(rt.workerOrig('假执行者'))} && items.includes('强执行者') && items.filter(i => i.includes('假执行者')).length === 1; })()`);
        await key('Escape');
        await check('UI23 Esc 只关执行者下拉，重试弹窗仍在', `!document.querySelector('.ctx') && !!document.querySelector('.sheet')`);
        await press('[data-retry-worker]');
        await press(await menuItem('强执行者'));
        await check('UI23 选了"强执行者"后下拉显示它', `document.querySelector('[data-retry-worker]').textContent.trim() === '强执行者'`);
        const note = 'add the done marker to src/done.txt';
        await type('[data-retry-note]', note);
        await pair('retry-sheet-fail');
        await press('.sheet [data-sheet-btn="1"]');
        await wait('!document.querySelector(".sheet")', 'UI23 重试成功后弹窗关闭', 30000);
        // 没等到 resume 时打印这个任务的清单事件、托管目录里的请求文件和进度尾部，区分"没派出去"和"派出去的进程没写"。
        const resume = await untilRow(async () => (await rows()).find(r => r.id === retryId && r.event === 'resume'), '重试的 resume 记录', 30000).catch(async error => {
            const events = (await rows()).filter(r => r.id === retryId).map(r => `${r.event}${r.n ? '#' + r.n : ''}${r.exit !== undefined ? ' exit=' + r.exit : ''}`).join('、');
            const managed = await readdir(path.join(home, 'managed')).catch(() => ['（读不到）']);
            const progressTail = await readFile(path.join(repo, '.agent-runs', retryName, 'progress.log'), 'utf8').then(t => t.trimEnd().split('\n').slice(-6).join(' | '), () => '（读不到）');
            const calls = effects.ipcLog.filter(e => e.name === 'tasks:retry').map(e => `${e.ok ? '成功' : '失败：' + String(e.error).slice(0, 120)}`).join('；') || '没有收到';
            const recordDir = path.join(repo, '.agent-runs', retryName);
            const files = await readdir(recordDir, { recursive: true }).catch(() => ['（读不到）']);
            const rawTail = await readFile(path.join(recordDir, 'raw.log'), 'utf8').then(t => t.trimEnd().split('\n').slice(-4).join(' | '), () => '（读不到）');
            const lines = (await readFile(registry.file, 'utf8')).split('\n').filter(Boolean).length;
            console.log(`UI23 重试没有 resume：清单事件 ${events}（共 ${lines} 行）；managed 目录 ${managed.join(',')}；记录目录 ${files.join(',')}；raw.log 尾部 ${rawTail}；进度尾部 ${progressTail}；主进程 tasks:retry ${calls}`.replaceAll(os.tmpdir(), '<TEMP>'));
            throw error;
        });
        await registry.refresh();
        await wait(`document.querySelector("[data-task=${retryId}] .mk")?.classList.contains("run") === true`, 'UI23 重试后任务回到进行中', 20000);
        await verify('UI23 点主按钮后清单出现 resume 与 attempt（reason: manual，profile 是所选的 strong），n 为 2', async () => {
            const list = (await rows()).filter(r => r.id === retryId);
            const attempts = list.filter(r => r.event === 'attempt');
            assert.deepEqual(attempts.map(r => [r.n, r.reason, r.profile]), [[1, 'first', 'fake'], [2, 'manual', 'strong']]);
            assert.equal(resume.n, 2);
            assert.ok(Number.isSafeInteger(resume.pid));
            assert.ok(list.findIndex(r => r === resume) < list.findIndex(r => r.event === 'attempt' && r.n === 2), 'resume 在第 2 个 attempt 之前');
        });
        await verify('UI23 attempts/2/prompt.md 含补充说明原文（主导补充说明段落）与上一次的失败信息', async () => {
            const prompt = await readFile(path.join(repo, '.agent-runs', retryName, 'attempts', '2', 'prompt.md'), 'utf8');
            assert.ok(prompt.includes(`## 主导补充说明\n\n${note}`), prompt.slice(-400));
            assert.ok(prompt.includes('上一次尝试没有通过验收'), '带上一次的失败段落');
        });
        await check('UI23 重试进行中：状态行"进行中"、"停止"按钮出现、"重试"按钮消失，轨道执行节点为运行中', `document.querySelector('.dh-state')?.textContent.includes('进行中') && !!document.querySelector('[data-stop]') && !document.querySelector('[data-retry]') && document.querySelectorAll('.track .node')[1].classList.contains('running')`);
        // 放行假执行者：它写完成标记并提交，门禁通过，任务结束。
        await writeFile(releaseFile, 'go\n');
        await wait(`document.querySelector("[data-task=${retryId}] .mk")?.classList.contains("ok") === true`, 'UI23 重试后任务最终完成', 45000);
        await verify('UI23 重试最终完成：end 带 attempts: 2，exit 0；attempt-end 记两次，第 2 次门禁通过', async () => {
            const list = (await rows()).filter(r => r.id === retryId);
            const end = list.at(-1);
            assert.equal(end.event, 'end');
            assert.equal(end.exit, 0);
            assert.equal(end.attempts, 2);
            assert.deepEqual(list.filter(r => r.event === 'attempt-end').map(r => [r.n, r.ok, r.gate]), [[1, false, false], [2, true, true]]);
        });
        await check('UI23 重试完成后：轨道执行节点写"第 2 次完成"，"重试"标签出现且数字为 2，手动重试没有"尝试 n/N"', `document.querySelectorAll('.track .node')[1].querySelector('.sub').textContent === ${JSON.stringify(rt.trackDone(2))} && document.querySelector('.dtabs [data-tab=retry]').textContent.replace(/\\s+/g, '') === ${JSON.stringify(rt.tab + '2')} && !document.querySelector("[data-task=${retryId}] .att")`);
        await press('.dtabs [data-tab=retry]');
        await wait(`document.querySelectorAll('.ahist-r').length === 2 && document.querySelectorAll('.ahist-r .res')[1]?.textContent === ${JSON.stringify(rt.resultGateOk)}`, 'UI23 重试历史（真实重试）', 15000);
        await check('UI23 真实重试的历史：第 1 次门禁未通过（核心 summary），第 2 次是手动重试、换了执行者、门禁通过', `(() => { const r = [...document.querySelectorAll('.ahist-r')]; return r[0].querySelector('.res').textContent === ${JSON.stringify(rt.resultGateFail(gateRow.summary))} && r[0].querySelector('.ex').textContent === '假执行者' && r[1].querySelector('.why').textContent === ${JSON.stringify(`原因：${rt.reason.manual}`)} && r[1].querySelector('.ex').textContent === '强执行者'; })()`);
        await check('UI23 真实重试的历史标题行：共 2 次尝试，自动最多 1 次（派发时 max_retries 为 0）',`document.querySelector('.tab-body .sec-t').textContent.startsWith(${JSON.stringify(rt.histHead(2, 1))})`);
        await check('UI23 没有"需要越界"的任务详情没有越界横幅', '!document.querySelector("[data-needs-scope]")');

        // ---- 执行者需要越界：假执行者的汇报带"## 需要越界"（2 个路径）且门禁失败；max_retries 为 2 也只跑 1 次 ----
        const scopeSpecRel = 'docs/specs/072-越界验收.md';
        const scopeReport = ['# 汇报', '', '做到一半。', '', '## 需要越界', '- `core/lib/gate.mjs`：要在这里加一个参数，否则测试没法注入', '- tests/unit/gate.test.mjs', ''].join('\n');
        const scopePaths = ['core/lib/gate.mjs', 'tests/unit/gate.test.mjs'];
        await writeFile(configFile, JSON.stringify({ ...config, profiles: { ...config.profiles, scope: profile('越界执行者', { events: [{ kind: 'say', text: '越界执行者：需要改清单以外的文件。' }], report: scopeReport }) } }, null, 2) + '\n');
        await writeFile(path.join(repo, scopeSpecRel), ['---', 'id: 972', 'title: 越界验收', 'type: code', 'allowed_paths:', '  - src/**', 'verify:', '  - git cat-file -e HEAD:src/never.txt', 'max_retries: 2', '---', '', '越界验收正文。', ''].join('\n'));
        git(repo, ['add', '--', scopeSpecRel]);
        git(repo, ['commit', '-m', '越界验收任务说明', '--', scopeSpecRel]);
        const scopeDispatched = await core(['dispatch', scopeSpecRel, '--name', 'scope-demo', '--profile', 'scope', '--detach'], repo);
        scopeId = String(scopeDispatched.id);
        assert.ok(scopeId, '派发没有返回 id');
        await untilRow(async () => (await rows()).find(r => r.id === scopeId && r.event === 'end'), '越界任务结束', 30000);
        scopeStarted = (await rows()).find(r => r.id === scopeId && r.event === 'start').started;
        await registry.refresh();
        await verify('UI23 需要越界：max_retries 为 2 也只跑 1 次（清单里只有一个 attempt），attempt-end 与 end 带 needsScope，退出码 3', async () => {
            const list = (await rows()).filter(r => r.id === scopeId);
            assert.equal(list.filter(r => r.event === 'attempt').length, 1);
            const expected = [{ path: scopePaths[0], reason: '要在这里加一个参数，否则测试没法注入' }, { path: scopePaths[1], reason: null }];
            assert.deepEqual(list.find(r => r.event === 'attempt-end').needsScope, expected);
            assert.equal(list.at(-1).event, 'end');
            assert.equal(list.at(-1).exit, 3);
            assert.deepEqual(list.at(-1).needsScope, expected);
        });
        await press('[data-page=tasks]');
        await wait(`!!document.querySelector("[data-task=${scopeId}]")`, 'UI23 越界任务进列表', 15000);
        await press(`[data-task=${scopeId}]`);
        await press('.dtabs [data-tab=flow]');
        await wait('!!document.querySelector("[data-needs-scope]")', 'UI23 越界横幅出现', 15000);
        await check('UI23 越界横幅：失败横幅的结构（banner fail、role=alert），标题、说明（2 个路径）、两条路径逐行列出且是等宽字体，原因跟在路径后面', `(() => { const m = document.createElement('span'); m.className = 'mono'; document.body.append(m); const mono = getComputedStyle(m).fontFamily; m.remove(); const b = document.querySelector('[data-needs-scope]'); const paths = [...b.querySelectorAll('[data-scope-path]')]; const reasons = [...b.querySelectorAll('[data-scope-reason]')]; return b.classList.contains('banner') && b.classList.contains('fail') && b.getAttribute('role') === 'alert' && b.querySelector('.rt b').textContent === ${JSON.stringify(rt.needsScopeTitle)} && b.querySelector('.rt > span').textContent === ${JSON.stringify(rt.needsScopeHelp(2))} && paths.map(p => p.textContent).join('|') === ${JSON.stringify(scopePaths.join('|'))} && paths.every(p => p.classList.contains('mono') && getComputedStyle(p).fontFamily === mono) && reasons.length === 1 && reasons[0].textContent === '要在这里加一个参数，否则测试没法注入' && reasons[0].parentElement === paths[0].parentElement && b.querySelectorAll('li').length === 2; })()`);
        await check('UI23 越界横幅与门禁失败横幅同时出现，越界横幅在上面', `(() => { const a = document.querySelector('[data-needs-scope]'); const all = [...document.querySelectorAll('.detail .banner-holder .banner.fail')]; return all.length >= 2 && all[0] === a && !all[1].hasAttribute('data-needs-scope'); })()`);
        await pair('needs-scope');
        await press(`[data-task=${retryId}]`);
        await wait('!document.querySelector("[data-needs-scope]")', 'UI23 换到没有越界的任务后横幅消失');
        await check('UI23 换到没有越界的任务，越界横幅消失', '!document.querySelector("[data-needs-scope]")');
    }
    finally {
        // 清理：弹窗、假派发进程、临时项目与临时任务；恢复配置与演示任务的隐藏状态。
        if (await evaluate('!!document.querySelector(".sheet")').catch(() => false))
            await key('Escape').catch(() => { });
        await writeFile(releaseFile, 'go\n').catch(() => { });
        if (alive?.pid) {
            alive.kill();
            await new Promise(resolve => alive!.once('exit', resolve));
        }
        // t25 的假派发进程已结束：补一行 interrupted，清单里它不再是"进行中"（否则之后的启动会把它当成运行中的任务）。
        if (alive?.pid) await appendFile(registry.file, JSON.stringify({ v: 1, event: 'interrupted', id: 't25', at: Date.now(), signal: 'stopped-by-app' }) + '\n').catch(() => { });
        await registry.refresh().catch(() => { });
        if (retryId && retryStarted) {
            const saved = JSON.parse(await readFile(tasksFile, 'utf8').catch(() => '{"imports":[],"hidden":[]}'));
            const hidden: string[] = Array.isArray(saved.hidden) ? saved.hidden : [];
            await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: [...new Set([...hidden, `${retryId}:${retryStarted}`])] }) + '\n').catch(() => { });
            await registry.reloadHidden().catch(() => { });
        }
        if (scopeId && scopeStarted) {
            const saved = JSON.parse(await readFile(tasksFile, 'utf8').catch(() => '{"imports":[],"hidden":[]}'));
            const hidden: string[] = Array.isArray(saved.hidden) ? saved.hidden : [];
            await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: [...new Set([...hidden, `${scopeId}:${scopeStarted}`])] }) + '\n').catch(() => { });
            await registry.reloadHidden().catch(() => { });
        }
        if (repo) await coreRun(['projects', 'remove', repo], { timeoutMs: 60000 }).catch(() => { });
        await hide(originalKeys).catch(() => { });
        if (originalConfig === null) await rm(configFile, { force: true }).catch(() => { });
        else await writeFile(configFile, originalConfig).catch(() => { });
        nativeTheme.themeSource = 'dark';
    }
}
