import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { nativeTheme } from 'electron';
import type { Harness } from './shots-input';
import type { Registry } from './registry';
import { appEnvironment } from './app-env.mjs';
import { gt, nt } from '../shared/copy';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
const GATE_IDS = ['t20', 't21', 't22', 't24'];

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
    }
    finally {
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
