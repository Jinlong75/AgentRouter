import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { nativeTheme } from 'electron';
import { pollUntil, type Harness } from './shots-input';
import type { Registry } from './registry';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';
import { gt, nt, rt } from '../shared/copy';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
const GATE_IDS = ['t20', 't21', 't22', 't24'];
// 验收里的 git 也只用隔离环境（GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM 见 tools/demo/preferences.mjs）。
const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, env: appEnv });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return String(r.stdout).trim();
};

// UI22：Stage04 门禁界面。演示任务 t20～t22、t24 默认写在 tasks.json 的 hidden 里（原有列表计数不变），
// 这里临时显示、检查完恢复；门禁进行中的任务（t23）用真的假派发进程造出来，避免在演示清单里放一个一直跑的任务。
// 056：t24 演示受保护路径越界与删除的文件；t21 保留旧式 gate.json（没有 protected / deleted 字段）。
export async function captureGate(h: Harness, registry: Registry, out: string, save: (name: string) => Promise<void>) {
    const { evaluate, wait, check, verify, press, key, type, tabTo, focusRing, pause, wheel, audit } = h;
    const tasksFile = path.join(registry.data, 'tasks.json');
    // 记下恢复时要加回去的 hidden 键（演示生成器写入的是 "<id>:<started>"）。
    const keysOf = async (ids: string[]) => {
        const saved = JSON.parse(await readFile(tasksFile, 'utf8').catch(() => '{"imports":[],"hidden":[]}'));
        const hidden: string[] = Array.isArray(saved.hidden) ? saved.hidden : [];
        return hidden.filter(key => ids.some(id => key.startsWith(id + ':')));
    };
    const originalKeys = await keysOf(GATE_IDS);
    const hide = async (keys: string[]) => {
        const saved = JSON.parse(await readFile(tasksFile, 'utf8').catch(() => '{"imports":[],"hidden":[]}'));
        const hidden: string[] = Array.isArray(saved.hidden) ? saved.hidden : [];
        await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: [...new Set([...hidden, ...keys])] }) + '\n');
        await registry.reloadHidden();
    };
    const reveal = async (ids: string[]) => {
        const saved = JSON.parse(await readFile(tasksFile, 'utf8').catch(() => '{"imports":[],"hidden":[]}'));
        const hidden: string[] = Array.isArray(saved.hidden) ? saved.hidden : [];
        const drop = new Set(hidden.filter(key => ids.some(id => key.startsWith(id + ':'))));
        await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: hidden.filter(key => !drop.has(key)) }) + '\n');
        await registry.reloadHidden();
    };
    // 截图前切换主题并等界面稳定；成对拍深色、浅色。
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
    // 与令牌比较颜色：只在当前主题里取一次 var(--fail)，不写死色值。
    const failColor = `(() => { const s = document.createElement('span'); s.style.color = 'var(--fail)'; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; })()`;
    let gating: ChildProcess | undefined, gatingStarted = 0;
    // 079 工作区外写入：临时仓库、假执行者与隔离的用户目录（USERPROFILE 在隔离公共目录里）。
    const outsideHome = appEnv.AGENT_ROUTER_HOME!, outsideUser = appEnv.USERPROFILE!;
    const outsideConfig = path.join(outsideHome, 'config.json'), outsideRelease = path.join(out, 'outside-release.flag');
    const outsideStray = 'stray-outside.txt';
    const originalOutsideConfig = await readFile(outsideConfig, 'utf8').catch(() => null);
    let outsideRepo = '', outsideId = '', outsideStarted = 0;
    try {
        await reveal(GATE_IDS);
        await wait('!!document.querySelector("[data-task=t21]")', 'UI22 显示门禁演示任务');
        const t20 = registry.tasks.find(t => t.id === 't20')!, t21 = registry.tasks.find(t => t.id === 't21')!;
        assert.ok(t20 && t21, '门禁演示任务应出现在快照里');
        const file21 = JSON.parse(await readFile(path.join(path.dirname(t21.progress), 'gate.json'), 'utf8'));
        const file20 = JSON.parse(await readFile(path.join(path.dirname(t20.progress), 'gate.json'), 'utf8'));
        // ---- 门禁未通过：列表徽标 → 轨道 → 门禁标签 ----
        await check('UI22 门禁未通过的列表行显示"门禁未通过"徽标并使用失败色', `(() => { const b = document.querySelector("[data-task=t21] .gbadge"); return !!b && b.classList.contains('fail') && b.textContent.trim() === ${JSON.stringify(gt.badge.fail)} && getComputedStyle(b).color === ${failColor}; })()`);
        await pair('gate-fail-list');
        await press('[data-task=t21]');
        await wait('document.querySelectorAll(".track .node").length === 3', 'UI22 门禁未通过任务的轨道');
        await check('UI22 点选门禁未通过任务后轨道有三个节点', `[...document.querySelectorAll(".track .node")].map(n => n.children[1].textContent).join('/') === '派发/执行/门禁'`);
        await check('UI22 门禁未通过任务的门禁节点为未通过状态且可点', `(() => { const n = document.querySelector(".track .node:last-of-type"); return n.classList.contains('failed') && (n.getAttribute('aria-label') || '').includes('门禁') && !n.disabled; })()`);
        await check('UI22 失败状态行写"失败 · 门禁未通过"', `document.querySelector(".dh-state")?.textContent.replace(/\\s+/g, '') === '失败·门禁未通过'`);
        await check('UI22 门禁未通过横幅用核心 summary 并提供"查看门禁"', `document.querySelector(".detail .banner.fail .rt b")?.textContent === ${JSON.stringify(gt.failTitle)} && document.querySelector(".detail .banner.fail .rt span")?.textContent === ${JSON.stringify(file21.summary)} && !!document.querySelector(".detail .banner.fail [data-tab=gate]")`);
        await check('UI22 进展末尾显示"执行者结束（exit=0）· 门禁开始"分隔行', `[...document.querySelectorAll(".gate-sep")].some(row => row.textContent.includes('执行者结束（exit=0）· 门禁开始'))`);
        await pair('gate-fail-detail');
        await press('.track .node:last-of-type');
        await wait('document.querySelector(".dtabs [data-tab=gate]")?.classList.contains("on") === true', 'UI22 点门禁节点切到门禁标签');
        await wait(`document.querySelector(".tab-body .banner.fail .rt span")?.textContent === ${JSON.stringify(file21.summary)}`, 'UI22 门禁标签读取 gate.json');
        await check('UI22 点门禁节点切到门禁标签并显示核心写的 summary', `document.querySelector(".tab-body .banner.fail .rt span")?.textContent === ${JSON.stringify(file21.summary)}`);
        // 门禁标签里已有 gateTab() 自己的横幅：详情顶部不再重复，也不出现多余的"查看门禁"按钮。
        await check('UI22 门禁标签里只有一条门禁横幅、没有"查看门禁"按钮', `(() => { const banners = [...document.querySelectorAll('.detail .banner')]; return banners.length === 1 && banners[0].parentElement?.classList.contains('tab-body') && !document.querySelector('.detail .banner-holder .banner') && !document.querySelector('.detail .banner-holder [data-tab=gate]'); })()`);
        await check('UI22 门禁标签把超出范围的文件标红并写"超出范围"', `(() => { const row = [...document.querySelectorAll(".tab-body .grow")].find(r => r.querySelector(".v.mono")?.textContent === 'src/legacy/report.ts'); return !!row && row.classList.contains('bad') && row.querySelector(".meta")?.textContent === '超出范围' && getComputedStyle(row.querySelector(".v.mono")).color === ${failColor}; })()`);
        await check('UI22 失败的验收命令行标红', `(() => { const row = document.querySelector(".tab-body .grow.bad [data-gcmd='1']")?.closest('.grow'); return !!row && getComputedStyle(row.querySelector(".cmd code")).color === ${failColor}; })()`);
        await press('[data-gcmd="1"]');
        await check('UI22 点失败的验收命令展开输出并显示截断说明', `document.querySelector('[data-gcmd="1"]').getAttribute('aria-expanded') === 'true' && !document.querySelector('[data-gout="1"]').hidden && document.querySelector('[data-gout="1"]').textContent.includes('发现越界文件') && !document.querySelector('[data-gnote="1"]').hidden && document.querySelector('[data-gnote="1"]').textContent === ${JSON.stringify(gt.truncated)}`);
        await pair('gate-tab-fail');
        // 键盘：先在进展标签，再 Tab 到门禁节点回车。切回进展时详情顶部的门禁横幅恢复，带"查看门禁"。
        await press('.dtabs [data-tab=flow]');
        await check('UI22 进展标签显示门禁失败横幅与"查看门禁"', `(() => { const banners = [...document.querySelectorAll('.detail .banner')]; return banners.length === 1 && banners[0].parentElement?.classList.contains('banner-holder') && !!document.querySelector('.detail .banner-holder .banner.fail [data-tab=gate]'); })()`);
        await tabTo('.track .node:last-of-type', 120);
        await focusRing('UI22 门禁节点');
        await key('Enter');
        await check('UI22 键盘 Tab 到门禁节点后回车切到门禁标签', `document.querySelector(".dtabs [data-tab=gate]")?.classList.contains("on") === true`);
        await audit('门禁', async () => {
            await press('[data-task=t21]');
            await press('.dtabs [data-tab=gate]');
        });

        // ---- 056：受保护的路径与删除的文件（t24）；旧式记录（t21）没有"删除的文件"一块 ----
        const t24 = registry.tasks.find(t => t.id === 't24')!;
        assert.ok(t24, '受保护路径演示任务应出现在快照里');
        const file24 = JSON.parse(await readFile(path.join(path.dirname(t24.progress), 'gate.json'), 'utf8'));
        await press('[data-task=t24]');
        await press('.dtabs [data-tab=gate]');
        await wait(`document.querySelector(".tab-body .banner.fail .rt span")?.textContent === ${JSON.stringify(file24.summary)}`, 'UI22 受保护路径演示任务的门禁标签');
        await check('UI22 受保护的路径行尾写"受保护的路径"且标红', `(() => { const row = [...document.querySelectorAll(".tab-body .grow")].find(r => r.querySelector(".v.mono")?.textContent === 'docs/specs/024-调整导出权限.md'); return !!row && row.classList.contains('bad') && row.querySelector(".meta")?.textContent === ${JSON.stringify(gt.scopeProtected)} && getComputedStyle(row.querySelector(".v.mono")).color === ${failColor}; })()`);
        await check('UI22 "删除的文件"标题、个数与文件行（delete-bin-line 图标）', `(() => { const sec = [...document.querySelectorAll(".tab-body .sec-t")].find(s => s.textContent.startsWith(${JSON.stringify(gt.deletedSec)})); const row = [...document.querySelectorAll(".tab-body .grow.info")].find(r => r.querySelector(".v.mono")?.textContent === 'tests/export/legacy-permission.test.ts'); return !!sec && sec.textContent.includes(${JSON.stringify(gt.deletedCount(1))}) && !!row && !!row.querySelector('i.ri-delete-bin-line'); })()`);
        // 截图要同框看到"受保护的路径"标注与"删除的文件"一块：先把受保护行滚到视口中间。
        await evaluate('[...document.querySelectorAll(".tab-body .grow")].find(r => r.querySelector(".v.mono")?.textContent === \'docs/specs/024-调整导出权限.md\')?.scrollIntoView({ block: "center" })');
        await pair('gate-protected-tab');
        // 旧式记录：t21 的 gate.json 没有 deleted 字段——整块不显示（而不是显示"没有"）。
        await press('[data-task=t21]');
        await press('.dtabs [data-tab=gate]');
        await check('UI22 旧式 gate.json 没有 deleted 字段时不显示"删除的文件"一块', `[...document.querySelectorAll(".tab-body .sec-t")].every(s => !s.textContent.includes(${JSON.stringify(gt.deletedSec)})) && !document.querySelector(".tab-body .grow.info")`);

        // ---- 门禁通过 ----
        await press('[data-task=t20]');
        await wait(`document.querySelector(".track .node:last-of-type .sub")?.textContent === '2/2'`, 'UI22 门禁通过任务读取 gate.json');
        await check('UI22 门禁通过任务列表徽标为通过色', `(() => { const b = document.querySelector("[data-task=t20] .gbadge"); return !!b && b.classList.contains('ok') && b.textContent.trim() === '门禁通过'; })()`);
        await press('.dtabs [data-tab=gate]');
        await wait(`document.querySelector(".tab-body .banner.ok .rt b")?.textContent === ${JSON.stringify(gt.okTitle(3, file20.commands.length, (file20.ms / 1000).toFixed(1)))}`, 'UI22 门禁通过的门禁标签横幅');
        await check('UI22 门禁通过横幅标题按 gate.json 计算且门禁节点显示 2/2', `document.querySelector(".tab-body .banner.ok .rt b")?.textContent === ${JSON.stringify(gt.okTitle(3, file20.commands.length, (file20.ms / 1000).toFixed(1)))} && document.querySelector(".track .node:last-of-type .sub")?.textContent === '2/2'`);
        // 先拍进展（轨道与门禁通过横幅在同一页），再拍门禁标签。
        await press('.dtabs [data-tab=flow]');
        await pair('gate-ok-detail');
        await press('.dtabs [data-tab=gate]');
        await pair('gate-tab-ok');

        // ---- 说明派发但没启用门禁 / 直接文字 ----
        await press('[data-task=t22]');
        await wait('!!document.querySelector(".track")', 'UI22 未启用门禁任务的轨道');
        await check('UI22 说明派发但未启用门禁的任务门禁节点为"未启用"且没有门禁标签', `document.querySelector(".track .node:last-of-type .sub")?.textContent === '未启用' && !document.querySelector(".dtabs [data-tab=gate]")`);
        await press('[data-task=t4]');
        await check('UI22 直接文字任务没有流水线轨道', `document.querySelector(".track-holder")?.children.length === 0 && !document.querySelector(".track")`);

        // ---- 执行者失败但启用门禁：执行节点异常退出，门禁未运行 ----
        await press('[data-task=t5]');
        await wait('!!document.querySelector(".track")', 'UI22 执行者失败任务的轨道');
        await check('UI22 执行者失败但启用门禁的任务执行节点为失败、门禁节点为"未运行"', `(() => { const n = document.querySelectorAll(".track .node"); return n[1].classList.contains("failed") && n[1].querySelector(".sub").textContent.includes("exit 1") && n[2].querySelector(".sub").textContent === '未运行'; })()`);

        // ---- 门禁进行中：造一条真的假派发进程 + gating 事件 ----
        const repo = path.join(appEnv.AGENT_ROUTER_HOME!, 'projects', 'reader-app');
        const name = '023-门禁进行中', dir = path.join(repo, '.agent-runs', name);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'events.jsonl'), JSON.stringify({ v: 1, seq: 1, at: Date.now(), kind: 'say', text: '先读任务说明。', offset: 0 }) + '\n');
        await writeFile(path.join(dir, 'progress.log'), `=== Codex 开始：${name} ===\n说：先读任务说明。\n`);
        const script = path.join(out, 'gate-fake', 'ar.mjs');
        await mkdir(path.dirname(script), { recursive: true });
        await writeFile(script, 'setInterval(() => { }, 1000);\n');
        // 只给这个假派发进程最少的环境变量：不是执行者，不把用户环境原样带过去。
        const minimal: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
        for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[key]) minimal[key] = process.env[key];
        gating = spawn(process.execPath, [script], { env: minimal, stdio: 'ignore', shell: false, windowsHide: true });
        await new Promise<void>((resolve, reject) => { gating!.once('spawn', () => resolve()); gating!.once('error', reject); });
        gatingStarted = Date.now();
        const events = () => path.join(dir, 'events.jsonl');
        const row = { v: 2, event: 'start', id: 't23', repo, name, dir, project: 'reader-app', profile: 'codex', adapter: 'codex', label: 'Codex', title: name, spec: 'docs/specs/023-门禁进行中.md', role: '执行者', pid: gating.pid, started: gatingStarted, progress: path.join(dir, 'progress.log'), report: path.join(dir, 'report.md'), events: events(), raw: path.join(dir, 'raw.log'), model: null, effort: null, tier: null, sandbox: 'workspace-write', managed: false, agent: 'codex', agentVersion: 'codex-cli 0.156.1', dispatcher: { host: 'claude-code', session: null }, gate: true, base: 'a1b2c3d' };
        await appendFile(registry.file, JSON.stringify(row) + '\n' + JSON.stringify({ v: 2, event: 'gating', id: 't23', at: gatingStarted + 1000 }) + '\n');
        await registry.refresh();
        await wait('document.querySelector("[data-task=t23] .gbadge.running")?.textContent.trim() === "门禁中"', 'UI22 门禁进行中的任务进列表', 15000);
        await check('UI22 门禁进行中的任务列表徽标为"门禁中"', `document.querySelector("[data-task=t23] .gbadge.running")?.textContent.trim() === '门禁中'`);
        await pair('gating-list');
        await press('[data-task=t23]');
        await wait('document.querySelector(".track .node:last-of-type .sub")?.textContent === "检查中"', 'UI22 门禁进行中任务的门禁节点');
        await check('UI22 门禁进行中任务的门禁节点为"检查中"、门禁标签可用', `document.querySelector(".track .node:last-of-type .sub")?.textContent === '检查中' && !!document.querySelector(".dtabs [data-tab=gate]")`);
        await press('.dtabs [data-tab=gate]');
        await wait(`document.querySelector(".tab-body .banner.info .rt b")?.textContent === ${JSON.stringify(gt.runningTitle)}`, 'UI22 门禁进行中的门禁标签');
        await check('UI22 门禁进行中的门禁标签显示进行中说明', `document.querySelector(".tab-body .banner.info .rt b")?.textContent === ${JSON.stringify(gt.runningTitle)} && !!document.querySelector(".tab-body .empty")`);
        await check('UI22 门禁进行中的门禁标签不重复详情顶部的门禁横幅', `!document.querySelector('.detail .banner-holder .banner') && document.querySelectorAll('.detail .tab-body .banner').length === 1`);
        await pair('gating-tab');

        // ---- 新建任务页：会跑门禁时固定提交说明，不跑门禁时可以取消 ----
        await press('[data-page=newtask]');
        await wait('!!document.querySelector("[data-nt-ready=\\"1\\"]")', 'UI22 打开新建任务页', 20000);
        await press('[data-nt-project]');
        await wait('!!document.querySelector(".ctx")', 'UI22 项目下拉');
        await press(await menuItem('reader-app'));
        await wait(`document.querySelector("[data-nt-path]")?.textContent.includes('reader-app') && !!document.querySelector('[data-nt-commit]')`, 'UI22 选中没有验收命令的演示项目', 15000);
        // 项目配置是异步读的：等 reader-app 的验收命令回填成空（上一个项目的两条命令已清掉），再按 0 条算底栏文字。
        await wait(`document.querySelector('[data-nt-f=verify]')?.value === ''`, 'UI22 读取 reader-app 的项目配置', 15000);
        // code 类型要求提交，因此即使项目没有验收命令也会跑门禁；底栏后果说明用 copy.ts 的 conseqNew + conseqGate，
        // 这里按合并后的验收命令数（reader-app 没有配置，0 条）拼出期望文字并精确比较。
        const workerText = String(await evaluate('document.querySelector("[data-nt-worker]")?.textContent ?? ""')).trim();
        const workerLabel = /^自动（默认：(.+)）$/.exec(workerText)?.[1] ?? workerText;
        assert.ok(workerLabel, 'UI22 新建任务页应已选中执行者');
        const gateNote = nt.conseqNew('NNN-标题.md', workerLabel, true) + nt.conseqGate(0);
        await check('UI22 新建任务页会跑门禁时勾选框固定勾选并禁用、说明为强制提交，底栏文字等于 conseqNew + conseqGate(0)', `(() => { const b = document.querySelector('[data-nt-commit]'); return !!b && b.getAttribute('aria-checked') === 'true' && b.disabled && b.querySelector('.ct span')?.textContent === ${JSON.stringify(nt.commitSpecForcedWhy([nt.gateWhyType('code')]))} && document.querySelector('[data-nt-note]')?.textContent === ${JSON.stringify(gateNote)}; })()`);
        await pair('newtask-gate');
        // 050：会跑门禁时"先提交任务说明"整行变灰、说明前有锁形图标；按钮已禁用，真实鼠标按下去勾选状态不变。
        // 勾选框在表单底部：先居中，截图与点击才不会只露出半行（命中测试的 block:"nearest" 会停在滚动区底边）。
        await evaluate('document.querySelector("[data-nt-commit]").scrollIntoView({block:"center"})');
        await check('UI22 会跑门禁时"先提交任务说明"整行变灰并带锁形图标', `(() => { const b = document.querySelector('[data-nt-commit]'), help = b?.querySelector('.ct span'); return !!b && b.classList.contains('off') && b.getAttribute('aria-disabled') === 'true' && parseFloat(getComputedStyle(b).opacity) < 1 && !!help?.firstElementChild && help.firstElementChild.matches('i.ri-lock-line'); })()`);
        await press('[data-nt-commit] .cb');
        await check('UI22 锁定的"先提交任务说明"点不动，勾选状态不变', `(() => { const b = document.querySelector('[data-nt-commit]'); return !!b && b.getAttribute('aria-checked') === 'true' && !!b.querySelector('.cb.on'); })()`);
        await pair('newtask-gate-locked');
        // 点击底部的勾选框时页面滚了下去，类型分段被吸顶标题挡住；用真实滚轮回到顶部再点类型。
        await wheel('.doc-scroll', -3000);
        await press('[data-nt-type="research"]');
        await wait(`document.querySelector('[data-nt-commit]')?.disabled === false`, 'UI22 改成 research 后勾选框可操作');
        await check('UI22 不跑门禁时"先提交任务说明"恢复可点、不再变灰、没有锁形图标', `(() => { const b = document.querySelector('[data-nt-commit]'), help = b?.querySelector('.ct span'); return !!b && !b.disabled && !b.classList.contains('off') && !b.hasAttribute('aria-disabled') && getComputedStyle(b).opacity === '1' && !help?.querySelector('i'); })()`);
        await press('[data-nt-commit]');
        await check('UI22 不跑门禁时可以取消勾选', `document.querySelector('[data-nt-commit]')?.getAttribute('aria-checked') === 'false'`);
        // 051：切回有 2 条验收命令的演示项目（UI22 前面切走的那个），锁定说明要逐项写出为什么会跑门禁。
        // 原因顺序：类型要求提交 → 验收命令 → 允许路径；条数与是否成立都以核心 mergeSpec 的合并结果为准，
        // "来自表单还是项目配置"只看表单那一栏解析后是否为空。
        // 刚才点了底部的勾选框，页面在底部：项目下拉会被吸顶标题挡住。只用滚轮回顶部时，点击那一刻可能还没滚到位
        // （711d0f1 最终回归在这里失败：[data-nt-project] 被 DIV.page-h sticky 遮挡），所以点之前先把它滚到视口中间（与 050 同一做法）。
        await wheel('.doc-scroll', -3000);
        await evaluate('document.querySelector("[data-nt-project]").scrollIntoView({block:"center"})');
        await press('[data-nt-project]');
        await wait('!!document.querySelector(".ctx")', 'UI22 项目下拉（051）');
        await press(await menuItem('pixel-garden'));
        await wait(`document.querySelector('[data-nt-path]')?.textContent.includes('pixel-garden') && document.querySelector('[data-nt-f=verify]')?.value === 'npm test\\nnpm run lint'`, 'UI22 切到有 2 条验收命令的演示项目（051）', 15000);
        await press('[data-nt-type="code"]');
        await check('UI22 类型 code + 表单 2 条验收命令：说明写出类型与表单里的验收命令（051）', `(() => { const b = document.querySelector('[data-nt-commit]'); return !!b && b.disabled && b.querySelector('.ct span')?.textContent === ${JSON.stringify(nt.commitSpecForcedWhy([nt.gateWhyType('code'), nt.gateWhyVerify(2)]))}; })()`);
        await press('[data-nt-type="research"]');
        await check('UI22 改成 research 后仍锁定，说明只写表单里的 2 条验收命令（051）', `(() => { const b = document.querySelector('[data-nt-commit]'), help = b?.querySelector('.ct span'); return !!b && b.disabled && b.getAttribute('aria-checked') === 'true' && help?.textContent === ${JSON.stringify(nt.commitSpecForcedWhy([nt.gateWhyVerify(2)]))}; })()`);
        // 用真实输入清空"验收命令"：合并后改用项目配置的 2 条，说明要写"项目配置有 2 条验收命令"。
        await press('[data-nt-f=verify]');
        await key('a', ['control']);
        await key('Backspace');
        await check('UI22 清空表单验收命令后按项目配置的 2 条算，仍锁定并写出原因（051）', `(() => { const b = document.querySelector('[data-nt-commit]'), help = b?.querySelector('.ct span'); return !!b && document.querySelector('[data-nt-f=verify]')?.value === '' && b.disabled && b.classList.contains('off') && b.getAttribute('aria-checked') === 'true' && !!help?.firstElementChild && help.firstElementChild.matches('i.ri-lock-line') && help.textContent === ${JSON.stringify(nt.commitSpecForcedWhy([nt.gateWhyVerifyProject(2)]))}; })()`);
        // 截图要拍到锁定说明本身：先把"先提交任务说明"一行居中（否则清空验收命令后页面还停在表单中部）。
        await evaluate('document.querySelector("[data-nt-commit]").scrollIntoView({block:"center"})');
        await pair('newtask-gate-why');
        // 在"允许改动的文件"里输入 src/**：两条原因按 验收命令 → 允许路径 的顺序用"、"连接。
        // 截图后页面停在勾选框附近，先滚回顶部，避免"允许改动的文件"被吸顶标题挡住。
        await wheel('.doc-scroll', -3000);
        await press('[data-nt-f=allowed]');
        await key('a', ['control']);
        await key('Backspace');
        await type('[data-nt-f=allowed]', 'src/**');
        await check('UI22 表单里限定允许路径后，说明再加上允许路径原因（051）', `(() => { const b = document.querySelector('[data-nt-commit]'), help = b?.querySelector('.ct span'); return !!b && b.disabled && help?.textContent === ${JSON.stringify(nt.commitSpecForcedWhy([nt.gateWhyVerifyProject(2), nt.gateWhyPaths]))}; })()`);
        // 返回任务页，后面的检查不受新建任务页影响。
        await press('[data-page=tasks]');
        await wait('!!document.querySelector("[data-task]")', 'UI22 返回任务页');

        await verify('UI22 演示门禁结果与界面显示一致（gate.json 原样）', async () => {
            assert.deepEqual(file21.scope.outside, ['src/legacy/report.ts']);
            assert.equal(file21.commands[1].truncated, true);
            assert.equal(file21.ok, false);
            assert.equal(file20.ok, true);
            assert.equal(file20.commands.length, 2);
            // 056：t21 保留旧式（没有 protected / deleted 字段）；t24 带两个新字段。
            assert.equal(Object.hasOwn(file21.scope, 'deleted'), false);
            assert.equal(Object.hasOwn(file21.scope, 'protected'), false);
            assert.deepEqual(file24.scope.protected, ['docs/specs/024-调整导出权限.md', '.agent-router/project.json']);
            assert.deepEqual(file24.scope.deleted, ['tests/export/legacy-permission.test.ts']);
            assert.equal(file24.ok, false);
        });

        // ---- 079：工作区外写入（协议 12.4）。假执行者运行期间，测试自己往隔离的用户目录根放一个新文件 ----
        assert.ok(outsideHome && path.isAbsolute(outsideHome) && outsideUser && path.isAbsolute(outsideUser), '截图验收必须在隔离公共目录与隔离用户目录里运行');
        assert.notEqual(path.resolve(outsideUser).toLowerCase(), path.resolve(outsideHome).toLowerCase(), '隔离用户目录不能等于公共目录');
        const outsideSpecRel = 'docs/specs/079-工作区外写入.md';
        const rows = async () => (await readFile(registry.file, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) as any[];
        const untilRow = async <T,>(fn: () => Promise<T | undefined | null>, label: string, timeoutMs = 30000): Promise<T> => {
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
        // 假执行者：写完成标记并提交（所以没有工作区外写入时门禁会通过），等放行文件出现才结束。
        const savedConfig = originalOutsideConfig === null ? {} : JSON.parse(originalOutsideConfig);
        await rm(outsideRelease, { force: true });
        await writeFile(outsideConfig, JSON.stringify({
            v: 2, managed: false, watchWindow: 'never', defaultProfile: 'fake', ...savedConfig,
            profiles: {
                ...(savedConfig.profiles ?? {}),
                'outside-fake': { adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'say', text: '假执行者已完成。' }], report: '假汇报\n', exit: 0, version: 'fake-agent 1.0', writes: [{ path: 'src/done.txt', content: '任务完成\n' }], commit: '假执行者：写入完成标记', releaseFile: outsideRelease, releaseTimeoutMs: 60000 },
            },
        }, null, 2) + '\n');
        outsideRepo = path.join(outsideHome, 'shots-outside', 'sample');
        await mkdir(path.join(outsideRepo, 'docs', 'specs'), { recursive: true });
        await mkdir(path.join(outsideRepo, 'src'), { recursive: true });
        git(outsideRepo, ['init', '-b', 'main']);
        git(outsideRepo, ['config', 'user.name', 'AgentRouter Shots']);
        git(outsideRepo, ['config', 'user.email', 'shots@example.invalid']);
        git(outsideRepo, ['config', 'commit.gpgsign', 'false']);
        git(outsideRepo, ['config', 'core.autocrlf', 'false']);
        await writeFile(path.join(outsideRepo, '.gitignore'), '.agent-runs/\n');
        await writeFile(path.join(outsideRepo, 'src', 'a.txt'), '初始\n');
        await writeFile(path.join(outsideRepo, outsideSpecRel), ['---', 'id: 979', 'title: 工作区外写入验收', 'type: code', 'allowed_paths:', '  - src/**', 'verify:', '  - git cat-file -e HEAD:src/done.txt', 'max_retries: 2', '---', '', '工作区外写入验收正文。', ''].join('\n'));
        git(outsideRepo, ['add', '--', '.gitignore', 'src/a.txt', outsideSpecRel]);
        git(outsideRepo, ['commit', '-m', '初始提交', '--', '.gitignore', 'src/a.txt', outsideSpecRel]);
        await core(['projects', 'add', outsideRepo]);
        const dispatched = await core(['dispatch', outsideSpecRel, '--name', 'outside-demo', '--profile', 'outside-fake', '--detach'], outsideRepo);
        outsideId = String(dispatched.id);
        assert.ok(outsideId, '派发没有返回 id');
        // 核心写 spawned 时，执行者启动之前的那次列目录已经做完；此时再放新文件，才算"任务进行中新出现的"。
        await untilRow(async () => (await rows()).find(r => r.id === outsideId && r.event === 'spawned'), '假执行者启动');
        await writeFile(path.join(outsideUser, outsideStray), '执行者之外的程序写的\n');
        await writeFile(outsideRelease, 'go\n');
        await untilRow(async () => (await rows()).find(r => r.id === outsideId && r.event === 'end'), '工作区外写入任务结束');
        outsideStarted = (await rows()).find(r => r.id === outsideId && r.event === 'start').started;
        await registry.refresh();
        const outsideAdded = [{ root: 'user', name: outsideStray, type: 'file' }];
        await verify('UI22 工作区外写入：max_retries 为 2 也只跑 1 次（清单里只有一个 attempt），门禁未通过、退出码 3，attempt-end 与 gate.json 带 outsideWrites', async () => {
            const list = (await rows()).filter(r => r.id === outsideId);
            assert.equal(list.filter(r => r.event === 'attempt').length, 1);
            assert.equal(list.find(r => r.event === 'gate').ok, false);
            assert.deepEqual(list.find(r => r.event === 'attempt-end').outsideWrites, { checked: true, added: outsideAdded });
            assert.equal(list.at(-1).event, 'end');
            assert.equal(list.at(-1).exit, 3);
            const gateJson = JSON.parse(await readFile(path.join(outsideRepo, '.agent-runs', 'outside-demo', 'gate.json'), 'utf8'));
            assert.deepEqual(gateJson.outsideWrites, { checked: true, added: outsideAdded });
            assert.equal(gateJson.scope.outside.length, 0, '工作区内没有越界，失败只因为工作区外写入');
            assert.ok(gateJson.summary.endsWith(`工作区外出现新文件：user/${outsideStray}`), gateJson.summary);
        });
        await press('[data-page=tasks]');
        await press('[data-filter=all]');
        await press('[data-project]');
        await press('.ctx button');
        await wait(`!!document.querySelector("[data-task=${outsideId}]")`, 'UI22 工作区外写入任务进列表', 15000);
        await press(`[data-task=${outsideId}]`);
        await press('.dtabs [data-tab=flow]');
        await wait('!!document.querySelector("[data-outside-writes]")', 'UI22 工作区外写入横幅出现', 15000);
        await check('UI22 工作区外写入横幅：失败横幅的结构（banner fail、role=alert），标题、说明、新文件逐行列出（目录名称 + 等宽的名字）', `(() => { const m = document.createElement('span'); m.className = 'mono'; document.body.append(m); const mono = getComputedStyle(m).fontFamily; m.remove(); const b = document.querySelector('[data-outside-writes]'); const names = [...b.querySelectorAll('[data-outside-name]')]; const roots = [...b.querySelectorAll('[data-outside-root]')]; return b.classList.contains('banner') && b.classList.contains('fail') && b.getAttribute('role') === 'alert' && b.parentElement?.classList.contains('banner-holder') && b.querySelector('.rt b').textContent === ${JSON.stringify(rt.outsideTitle)} && b.querySelector('.rt > span').textContent === ${JSON.stringify(rt.outsideHelp)} && names.map(n => n.textContent).join('|') === ${JSON.stringify(outsideStray)} && names.every(n => n.classList.contains('mono') && getComputedStyle(n).fontFamily === mono) && roots.map(r => r.textContent).join('|') === ${JSON.stringify(rt.outsideRoot.user)} && roots[0].parentElement === names[0].parentElement && b.querySelectorAll('li').length === 1; })()`);
        await check('UI22 工作区外写入横幅与门禁失败横幅同时出现，工作区外写入在上面', `(() => { const a = document.querySelector('[data-outside-writes]'); const all = [...document.querySelectorAll('.detail .banner-holder .banner.fail')]; return all.length >= 2 && all[0] === a && !all[1].hasAttribute('data-outside-writes') && all[1].querySelector('.rt b').textContent === ${JSON.stringify(gt.failTitle)}; })()`);
        await pair('outside-writes-banner');
        await press('.dtabs [data-tab=gate]');
        await wait(`!!document.querySelector("[data-outside-sec]")`, 'UI22 门禁标签里出现工作区外的新文件一项', 15000);
        await check('UI22 门禁标签：工作区外的新文件一项在"改动范围"后面、验收命令前面，条目标红并写目录名称', `(() => { const sec = document.querySelector('[data-outside-sec]'); const row = document.querySelector('[data-outside-item]'); const secs = [...document.querySelectorAll('.tab-body .sec-t')]; const at = secs.indexOf(sec); return !!sec && sec.textContent === ${JSON.stringify(rt.outsideGate)} && secs.slice(0, at).some(s => s.textContent.startsWith(${JSON.stringify(gt.scopeSec)})) && secs[at + 1]?.textContent === ${JSON.stringify(gt.commandsSec)} && !!row && row.classList.contains('bad') && row.querySelector('.v.mono')?.textContent === ${JSON.stringify(outsideStray)} && getComputedStyle(row.querySelector('.v.mono')).color === ${failColor} && row.querySelector('.meta')?.textContent === ${JSON.stringify(rt.outsideRoot.user)} && document.querySelectorAll('[data-outside-item]').length === 1; })()`);
        await check('UI22 门禁标签的失败横幅用核心 summary（末尾带工作区外出现新文件）', `document.querySelector(".tab-body .banner.fail .rt span")?.textContent.endsWith(${JSON.stringify(`工作区外出现新文件：user/${outsideStray}`)}) === true`);
        await evaluate('document.querySelector("[data-outside-sec]")?.scrollIntoView({ block: "center" })');
        await pair('outside-writes-gate-tab');
        await press(`[data-task=t20]`);
        await wait('!document.querySelector("[data-outside-writes]")', 'UI22 换到没有工作区外写入的任务后横幅消失');
        await check('UI22 换到没有工作区外写入的任务：没有横幅，门禁标签也没有这一项', `!document.querySelector('[data-outside-writes]') && !document.querySelector('[data-outside-sec]') && !document.querySelector('[data-outside-item]')`);
    }
    finally {
        // 079：放行假执行者、隐藏临时任务、移除临时项目、恢复配置，删掉测试自己放进隔离用户目录的文件。
        await writeFile(outsideRelease, 'go\n').catch(() => { });
        if (outsideId && outsideStarted) {
            const saved = JSON.parse(await readFile(tasksFile, 'utf8').catch(() => '{"imports":[],"hidden":[]}'));
            const hidden: string[] = Array.isArray(saved.hidden) ? saved.hidden : [];
            await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: [...new Set([...hidden, `${outsideId}:${outsideStarted}`])] }) + '\n').catch(() => { });
            await registry.reloadHidden().catch(() => { });
        }
        if (outsideRepo) await coreRun(['projects', 'remove', outsideRepo], { timeoutMs: 60000 }).catch(() => { });
        if (outsideRepo) await rm(path.join(outsideUser, outsideStray), { force: true }).catch(() => { });
        if (outsideRepo) {
            if (originalOutsideConfig === null) await rm(outsideConfig, { force: true }).catch(() => { });
            else await writeFile(outsideConfig, originalOutsideConfig).catch(() => { });
        }
        // 门禁进行中的假派发进程与记录：写 end、结束进程，再把任务藏起来，不影响后续检查。
        if (gating?.pid) {
            await appendFile(registry.file, JSON.stringify({ v: 1, event: 'end', id: 't23', exit: 0, at: Date.now(), minutes: 0 }) + '\n').catch(() => { });
            gating.kill();
            await new Promise(resolve => gating!.once('exit', resolve));
            await registry.refresh().catch(() => { });
            const key = `t23:${gatingStarted}`;
            const saved = JSON.parse(await readFile(tasksFile, 'utf8').catch(() => '{"imports":[],"hidden":[]}'));
            const hidden: string[] = Array.isArray(saved.hidden) ? saved.hidden : [];
            await writeFile(tasksFile, JSON.stringify({ ...saved, hidden: [...new Set([...hidden, key])] }) + '\n').catch(() => { });
            await registry.reloadHidden().catch(() => { });
        }
        // 恢复演示任务原来的 hidden 状态（验收开始时它们就是隐藏的）。
        await hide(originalKeys).catch(() => { });
        nativeTheme.themeSource = 'dark';
    }
}
