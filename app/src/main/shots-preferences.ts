import { readFile, writeFile, rename, rm, stat, readdir, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { pollUntil } from './shots-input';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { app, nativeTheme } from 'electron';
import type { Harness } from './shots-input';
import { effects } from './effects';
import { appEnvironment } from './app-env.mjs';

// 隔离用的路径从软件内部环境读（演示与截图把隔离覆盖放在 AR_ISOLATED_ENV 里，主进程 process.env 是用户原样）。
const appEnv = appEnvironment(process.env);

// 偏好相关页面的界面验收：UI06 技能、UI07 设置、UI08 关于、UI09 首次引导、UI10 主题。
// 全部用真实输入操作（见 shots-input.ts），并读文件断言功能真的生效。
const exists = (file: string) => stat(file).then(() => true, () => false);

export async function captureWizard(h: Harness) {
    const { evaluate, wait, check, verify, press, key, type, tabTo, save, audit } = h;
    const home = appEnv.AGENT_ROUTER_HOME!, skills = path.join(appEnv.CLAUDE_CONFIG_DIR!, 'skills');
    const configFile = path.join(home, 'config.json'), projectsFile = path.join(home, 'projects.json');
    const secretsFile = appEnv.AR_TEST_SECRETS_FILE!;
    assert.ok(path.isAbsolute(secretsFile) && !path.relative(home, secretsFile).startsWith('..'), '密钥文件必须在隔离目录里');
    const readConfig = async () => JSON.parse(await readFile(configFile, 'utf8'));
    // 第 4 步用桩选择这个临时 git 仓库；只登记，不写仓库文件。
    const projectDir = path.join(home, 'shots-wizard', 'first-project');
    await mkdir(projectDir, { recursive: true });
    const git = spawnSync('git', ['init', '-b', 'main'], { cwd: projectDir, encoding: 'utf8', shell: false, windowsHide: true });
    assert.equal(git.status, 0, `git init：${git.stderr}`);
    await writeFile(path.join(projectDir, 'README.md'), '# 首次引导添加的项目\n');
    // 仓库里的文件名清单（不算 .git），完成后必须一模一样。
    const repoFiles = async (dir: string, base = dir): Promise<string[]> => {
        const entries = await readdir(dir, { withFileTypes: true }), files: string[] = [];
        for (const entry of entries) {
            if (entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) files.push(...await repoFiles(full, base));
            else files.push(path.relative(base, full).replaceAll('\\', '/'));
        }
        return files.sort();
    };
    const filesBefore = await repoFiles(projectDir);

    await wait('!!document.querySelector(".wiz") && !document.querySelector("[data-pref=next]").disabled');
    await evaluate('document.fonts.ready');
    nativeTheme.themeSource = 'dark';
    await check('UI09 首次引导期间侧栏不可点击', '[...document.querySelectorAll("[data-page]")].every(b=>b.disabled)');
    await audit('首次引导第 1 步', async () => { await wait('!!document.querySelector(".wiz")'); });
    await save('wizard-1-dark');
    await press('[data-pref=next]');

    // 第 2 步：安装技能 + 托管开关。
    await check('UI09 第 2 步只默认勾选未安装或可更新的技能', `document.querySelectorAll('[data-choice][aria-checked=true]').length===1 && document.querySelector('[data-choice="claude-code/lead-workflow"]').getAttribute('aria-checked')==='true'`);
    await tabTo('[data-choice="claude-code/agent-router"]'); await key('Space');
    await check('UI09 键盘空格勾选技能', `document.querySelector('[data-choice="claude-code/agent-router"]').getAttribute('aria-checked')==='true'`);
    await key('Space');
    await check('UI09 再按空格取消勾选', `document.querySelector('[data-choice="claude-code/agent-router"]').getAttribute('aria-checked')==='false'`);
    await check('UI09 第 2 步同时提供托管开关，默认关闭', 'document.querySelector("[data-pref=managed]").getAttribute("aria-checked")==="false"');
    await press('[data-pref=managed]');
    await wait('document.querySelector("[data-pref=managed]").getAttribute("aria-checked")==="true"');
    await verify('UI09 第 2 步的托管开关写入 config.json 并保持引导界面', async () => {
        assert.equal((await readConfig()).managed, true);
        assert.equal(await evaluate('!!document.querySelector(".wiz") && !document.querySelector(".banner.fail")'), true);
    });
    // 验收后续的看板检查按"托管未开启"运行（中断横幅要显示"去设置"），这里再点回默认关闭。
    await press('[data-pref=managed]');
    await wait('document.querySelector("[data-pref=managed]").getAttribute("aria-checked")==="false"');
    await verify('UI09 第 2 步的托管开关可以再关掉，config.json 同步恢复', async () => {
        assert.equal((await readConfig()).managed, false);
    });
    await save('wizard-2-dark');
    await audit('首次引导第 2 步', async () => { await wait('!!document.querySelector("[data-choice]")'); });
    await press('[data-pref=next]');
    await wait('!!document.querySelector(".presets .preset.on")', '第 3 步预设加载完成', 30000);
    await verify('UI09 第 2 步"安装并继续"真的装上勾选的技能（安装记录存在）', async () => {
        const record = JSON.parse(await readFile(path.join(skills, 'lead-workflow', '.agent-router.json'), 'utf8'));
        assert.equal(record.skill, 'lead-workflow'); assert.equal(record.version, app.getVersion());
    });

    // 第 3 步：导入第一个 Agent（推荐预设 + API Key + 自动测试连接）。
    await check('UI09 第 3 步默认选中推荐预设，API Key 用密码框', 'document.querySelector(".preset.on").getAttribute("aria-checked")==="true" && document.querySelector(".preset.on .tag.brand")?.textContent==="推荐" && document.querySelector("[data-wizard-secret]").type==="password"');
    const secretValue = 'sk-shots-wizard-7291';
    await type('[data-wizard-secret]', secretValue);
    await press('[data-pref=wizard-secret]');
    await wait('document.querySelector("[data-wizard-secret-state]")?.textContent==="已设置"', '保存 API Key', 30000);
    await check('UI09 保存密钥后密码框立即清空、状态变为已设置', 'document.querySelector("[data-wizard-secret]").value===""');
    await verify('UI09 密钥写进隔离密钥文件，config.json 与界面里都没有密钥值', async () => {
        const stored = JSON.parse(await readFile(secretsFile, 'utf8'));
        assert.equal(stored.DEEPSEEK_API_KEY, secretValue);
        assert.ok(!(await readFile(configFile, 'utf8').catch(() => '')).includes(secretValue));
        assert.equal(await evaluate(`document.body.innerHTML.includes(${JSON.stringify(secretValue)})`), false);
    });
    await press('[data-pref=wizard-agent]');
    await wait('!!document.querySelector("[data-wizard-result=ok]")', '导入并测试连接成功', 90000);
    await check('UI09 第 3 步导入后自动测试连接并显示成功', 'document.querySelector("[data-wizard-result=ok]").textContent.includes("连接成功")');
    await verify('UI09 config.json 新增执行者（预设、适配器、密钥变量名），没有密钥值', async () => {
        const config = await readConfig();
        const added = Object.entries(config.profiles).find(([, profile]: [string, any]) => Object.values(profile.secrets ?? {}).includes('DEEPSEEK_API_KEY'));
        assert.ok(added, '配置里没有新导入的执行者');
        assert.equal((added![1] as any).adapter, 'claude-code');
        assert.ok(!JSON.stringify(config).includes(secretValue));
    });
    await save('wizard-3-dark');
    nativeTheme.themeSource = 'light';
    await save('wizard-3-light');
    nativeTheme.themeSource = 'dark';
    await audit('首次引导第 3 步', async () => { await wait('!!document.querySelector("[data-wizard-result=ok]")'); });
    await press('[data-pref=next]');

    // 第 4 步：选择并登记第一个项目，不往仓库里写任何文件。
    await wait('!!document.querySelector("[data-wizard-folder]")', '第 4 步项目选择');
    await check('UI09 第 4 步默认勾选"添加后打开初始化预览"', 'document.querySelector("[data-pref=wizard-open-init]").getAttribute("aria-checked")==="true"');
    effects.folders.push(projectDir);
    await press('[data-pref=wizard-choose-folder]');
    await wait(`document.querySelector("[data-wizard-folder]")?.textContent === ${JSON.stringify(projectDir)}`, '桩选中临时 git 仓库', 30000);
    await check('UI09 第 4 步显示所选项目文件夹', `document.querySelector("[data-wizard-folder]").textContent === ${JSON.stringify(projectDir)}`);
    await save('wizard-4-dark');
    nativeTheme.themeSource = 'light';
    await save('wizard-4-light');
    nativeTheme.themeSource = 'dark';
    await audit('首次引导第 4 步', async () => { await wait('!!document.querySelector("[data-wizard-folder]")'); });
    // 慢加载（PR #5 CI）：项目列表与详情各人为慢 6 秒（超过原来 5 秒的轮询期限），检查条件与上限不变。
    effects.consoleDelay['projects:list'] = 6000;
    effects.consoleDelay['projects:show'] = 6000;
    await press('[data-pref=wizard-finish]');
    try {
        await wait(`document.querySelector("[data-page=projects]")?.getAttribute("aria-current")==="page" && document.querySelector("[data-pj-row].on")?.dataset.pjRow === ${JSON.stringify(projectDir)} && document.querySelector("[data-pj-detail] .dh h2")?.textContent === "first-project"`, '完成后停在项目页并选中新项目并显示详情', 30000);
        await check('UI09 完成引导后停在项目页并选中刚添加的项目', `document.querySelector("[data-page=projects]").getAttribute("aria-current")==="page" && document.querySelector("[data-pj-row].on")?.dataset.pjRow === ${JSON.stringify(projectDir)} && document.querySelector("[data-pj-detail] .dh h2")?.textContent === "first-project"`);
    }
    finally { delete effects.consoleDelay['projects:list']; delete effects.consoleDelay['projects:show']; }
    await verify('UI09 第 4 步完成时把项目登记进 projects.json', async () => {
        const projects = JSON.parse(await readFile(projectsFile, 'utf8')).projects as { path: string }[];
        assert.ok(projects.some(project => project.path === projectDir));
    });
    await verify('UI09 首次引导没有往仓库里写任何文件', async () => {
        assert.deepEqual(await repoFiles(projectDir), filesBefore);
    });
    await verify('UI09 完成引导：配置存在、记录已完成引导', async () => {
        const settings = await evaluate('window.dock.preferences("settings")');
        assert.equal(settings.exists, true); assert.equal(settings.own.wizardDone, true);
        // 第 2 步验证过写入 true，随后点回默认关闭；完成时保留用户最后看到的值。
        assert.equal((await readConfig()).managed, false);
    });
    await press('[data-page=tasks]');
    await wait('!!document.querySelector("[data-task=t1]")');
}

export async function capturePreferences(h: Harness) {
    const { evaluate, wait, check, within, happened, verify, press, key, type, tabTo, save } = h;
    const home = appEnv.AGENT_ROUTER_HOME!, user = appEnv.USERPROFILE!, claude = appEnv.CLAUDE_CONFIG_DIR!, appdata = appEnv.APPDATA!;
    // 截图工具只允许使用启动器创建的隔离树。
    for (const dir of [user, claude, appdata]) { const rel = path.relative(home, dir); assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel)); }
    const skill = path.join(claude, 'skills', 'agent-router'), marker = path.join(skill, '.agent-router.json');
    const originalMarker = await readFile(marker, 'utf8');
    const agent = path.join(home, 'fake-codex.json'), config = path.join(home, 'config.json'), backups = path.join(home, 'backups');
    const readConfig = async () => JSON.parse(await readFile(config, 'utf8'));
    const ownFile = path.join(home, 'monitor', 'preferences.json');
    await verify('UI07 设置页显示完整配置路径（临时公共目录）', async () => { assert.equal((await evaluate('window.dock.preferences("settings")')).file, config); });
    const refresh = async () => { await press('[data-pref=detect]'); await wait('!document.querySelector("[data-pref=detect]").disabled'); };
    const settings = async () => { await press('[data-page=tasks]'); await press('[data-page=settings]'); await wait('!!document.querySelector("[data-pref=notifications]")'); };
    // Codex 的派发参数从 Stage03 起在 Agent 页"编辑执行者 · Codex"里（任务 004）。
    const agentsPage = async (name = 'codex') => { await press('[data-page=tasks]'); await press('[data-page=connect]'); await wait(`!!document.querySelector('[data-agent="${name}"]')`); };
    const codexEdit = async () => { await agentsPage(); await press('[data-more-agent=codex]'); await press('.ctx button:nth-child(1)'); await wait('!!document.querySelector(".sheet [data-setting=model]")'); };
    const closeSheet = async () => { await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")'); };
    nativeTheme.themeSource = 'dark';

    // UI06 技能：检测、更新、版本提示、较新版本保护、自改版本替换与回退。
    await press('[data-page=connect]'); await wait('!!document.querySelector("[data-host-card]") && !document.querySelector("[data-pref=detect]").disabled && !!document.querySelector("[data-agent=codex]")');
    await save('connect-normal-dark'); nativeTheme.themeSource = 'light'; await save('connect-normal-light'); nativeTheme.themeSource = 'dark';
    await check('UI06 Agent 页执行者区的 Codex 行通过假 Codex 检测版本和登录状态', 'document.querySelector("[data-agent=codex]").textContent.includes("codex-cli 0.156.1") && document.querySelector("[data-agent=codex]").textContent.includes("已登录")');
    await writeFile(marker, JSON.stringify({ ...JSON.parse(originalMarker), version: '0.0.0' }));
    await writeFile(agent, JSON.stringify({ version: 'codex-cli 0.157.0', loggedIn: true }));
    await refresh(); await wait('!!document.querySelector("[data-agent=codex] [data-agent-ack]")'); await save('connect-update-dark');
    await check('UI06 点"重新检测"后显示可更新与执行者版本变更提示（Codex 行）', '!!document.querySelector("[data-operation=update]") && !!document.querySelector("[data-agent=codex] [data-agent-ack]")');
    await press('[data-agent-ack]'); await refresh(); await wait('!!document.querySelector("[data-agent=codex]")');
    await check('UI06 点"知道了"以后重新检测不重复提示', '!document.querySelector("[data-agent-ack]")');
    await press('[data-operation=update][data-host=claude-code]'); await wait('!!document.querySelector("[data-operation=reinstall][data-host=claude-code]")');
    await check('UI06 点"更新"完成后显示数量', 'document.querySelector("[data-host-card=claude-code] .note").textContent.includes("已安装 1 个")');
    await verify('UI06 更新真的写入新版本：安装记录版本等于软件版本，并留下备份', async () => {
        assert.equal(JSON.parse(await readFile(marker, 'utf8')).version, app.getVersion());
        assert.ok((await readdir(backups)).length > 0);
    });
    await wait('!document.querySelector("[data-host-card=claude-code] .note").textContent.includes("已安装")');
    await check('UI06 安装结果三秒后恢复上次安装时间', 'document.querySelector("[data-host-card=claude-code] .note").textContent.startsWith("上次安装 ")');
    await writeFile(marker, JSON.stringify({ ...JSON.parse(originalMarker), version: '9.0.0' })); await refresh();
    await check('UI06 较新版本用中性标签且禁止更新和重装', 'document.querySelector("[data-host-card=claude-code]").textContent.includes("比软件自带的新") && !document.querySelector("[data-host=claude-code][data-operation=update]") && !document.querySelector("[data-host=claude-code][data-operation=reinstall]") && [...document.querySelectorAll("[data-host-card=claude-code] .tag")].some(t=>t.textContent==="比软件自带的新" && t.className.trim()==="tag")');
    await save('connect-newer-dark');
    await rm(marker); await refresh(); await save('connect-custom-dark');
    await check('UI06 自改版本静态说明', 'document.querySelector("[data-host-card=claude-code] .note").textContent==="替换前会备份"');
    await press('[data-operation=replace]');
    await check('UI06 替换技能默认焦点在取消且使用危险按钮', 'document.activeElement.textContent==="取消" && !!document.querySelector(".confirm-actions .danger")');
    await press('.confirm-actions .btn');
    await verify('UI06 取消替换：自改版本原样保留（没有安装记录）', async () => { assert.equal(await exists(marker), false); });
    await press('[data-page=about]'); await press('[data-pref=wizard]'); await wait('!!document.querySelector(".wiz") && !document.querySelector("[data-pref=next]").disabled'); await press('[data-pref=next]');
    await check('UI06 自己改过的版本在引导里默认不勾选', `document.querySelector('[data-choice="claude-code/agent-router"]').getAttribute('aria-checked')==='false'`);
    await check('UI06 引导第二步显示最新、自改状态与备份说明', `document.querySelector('[data-choice="claude-code/agent-router"]').textContent.includes("已有自己改过的版本，勾选后会先备份再替换") && document.querySelector('[data-choice="claude-code/agent-router"] .tag').textContent==="自己改过的版本" && [...document.querySelectorAll("[data-choice] .tag")].some(t=>t.textContent==="已是最新")`);
    await save('wizard-2-custom-dark');
    await press('[data-pref=skip]'); await wait('!document.querySelector(".wiz")'); await press('[data-page=connect]'); await wait('!!document.querySelector("[data-operation=replace]")');
    await press('[data-operation=replace]'); await press('.confirm-actions .danger'); await wait('!!document.querySelector("[data-operation=reinstall][data-host=claude-code]")');
    await verify('UI06 确认替换：先备份自改版本再装上新版本（安装记录恢复）', async () => { assert.equal(JSON.parse(await readFile(marker, 'utf8')).version, app.getVersion()); });
    // UI06 检测在途时完成技能操作（020 B）：先让一次"重新检测"在途——主进程先算出结果（回退前的状态），
    // 再延迟 4 秒返回；期间完成一次回退。旧实现把操作结束后的刷新直接丢掉，界面会停在旧状态；
    // 修复后在默认等待上限（10 秒）内必须出现回退后才有的"替换"按钮。
    await evaluate('document.documentElement.dataset.arTrace = "1"; window.__arTrace = []');
    const rollbackTrace: number = await evaluate('(window.__arTrace ?? []).length');
    effects.preferencesDelayAfter.detect = 4000;
    let rollbackShown: { ok: boolean; elapsed: number } = { ok: false, elapsed: 0 };
    try {
        await press('[data-pref=detect]');
        await press('[data-operation=rollback][data-host=claude-code]'); await press('.confirm-actions .primary');
        rollbackShown = await pollUntil(async () => await evaluate('!!document.querySelector("[data-operation=replace]")'), 10000);
    }
    finally { delete effects.preferencesDelayAfter.detect; }
    const detectEvents: string[] = JSON.parse(await evaluate(`JSON.stringify((window.__arTrace ?? []).slice(${rollbackTrace}).filter(e => /^(detect|host-op)/.test(e.event)).map(e => e.event + (e.operation ? ' ' + e.operation : '') + (e.reason ? ' ' + e.reason : '')))`));
    console.log(`UI06 检测在途时回退：10 秒内"替换"按钮${rollbackShown.ok ? `出现（${Math.round(rollbackShown.elapsed)} ms）` : '没有出现'}；渲染层事件 ${detectEvents.join(' → ') || '无'}`);
    await verify('UI06 检测在途时完成回退，界面在默认等待上限内显示回退后的状态（"替换"按钮出现）', () => {
        assert.ok(rollbackShown.ok, `${Math.round(rollbackShown.elapsed)} ms 内没有出现"替换"按钮；渲染层事件 ${detectEvents.join(' → ') || '无'}`);
        // 确认这次确实构造出了竞态（回退完成时检测在途、结束后补做），否则这条检查等于没测。
        assert.ok(detectEvents.some(e => e.startsWith('detect-skip')) && detectEvents.some(e => e.startsWith('detect-again')), `没有构造出"检测在途时完成回退"的竞态：${detectEvents.join(' → ') || '无'}`);
    });
    await check('UI06 回退还原自用版，不在该批次的技能保持最新', 'document.querySelectorAll("[data-host-card=claude-code] .tag.ok").length===1 && document.querySelectorAll("[data-host-card=claude-code] .tag.brand").length===1');
    await verify('UI06 回退真的还原自用版（安装记录又不存在）', async () => { assert.equal(await exists(marker), false); });
    await writeFile(marker, originalMarker);
    await rename(claude, claude + '-hidden');
    try {
        await writeFile(agent, JSON.stringify({ missing: true })); await refresh(); await wait('!!document.querySelector(".xrow.is-fail[data-agent=codex]")'); await save('connect-nocodex-dark');
        await check('UI06 缺少 Codex（执行者行失败样式）和未检测到宿主的样式', '!!document.querySelector(".xrow.is-fail[data-agent=codex]") && document.querySelector("[data-agent=codex]").textContent.includes("找不到 Codex CLI") && !!document.querySelector("[data-host-card=claude-code].is-off")');
    } finally { await rename(claude + '-hidden', claude); await writeFile(agent, JSON.stringify({ version: 'codex-cli 0.157.0', loggedIn: true })); }

    // UI07 设置：每一项写入 config.json，失败恢复，环境变量覆盖说明。
    await rm(config, { force: true }); await settings(); await save('settings-unconfigured-dark');
    await codexEdit(); await save('connect-codex-edit-dark'); nativeTheme.themeSource = 'light'; await save('connect-codex-edit-light'); nativeTheme.themeSource = 'dark';
    await press('[data-setting=model]'); await press('.ctx button:nth-child(2)');
    await wait('!!document.querySelector(".model-input")');
    await type('.model-input', 'gpt-x-large'); await key('Enter');
    await wait('document.querySelector("[data-setting=model]")?.textContent.includes("gpt-x-large")');
    await verify('UI07 自定义模型（编辑执行者）：键盘输入后回车写入 config.json', async () => { assert.equal((await readConfig()).profiles.codex.model, 'gpt-x-large'); });
    await check('UI07 自定义模型隐藏跟随配置说明', '!document.querySelector("[data-setting=model]").closest(".set-r").textContent.includes("括号里")');
    await press('[data-setting=effort]'); await press('.ctx button:nth-child(5)');
    await verify('UI07 推理强度写入 config.json', async () => { assert.equal((await readConfig()).profiles.codex.effort, 'high'); });
    await press('[data-setting=tier]'); await press('.ctx button:nth-child(2)');
    await verify('UI07 服务档位写入 config.json', async () => { assert.equal((await readConfig()).profiles.codex.tier, 'default'); });
    await check('UI07 环境变量覆盖在对应行说明', 'document.querySelector("[data-setting=tier]").closest(".set-r").textContent.includes("环境变量 CODEX_TIER 正在覆盖这一项（priority）")');
    await press('[data-segment=sandbox][data-value=read-only]');
    await verify('UI07 沙箱分段写入 config.json', async () => { assert.equal((await readConfig()).profiles.codex.sandbox, 'read-only'); });
    await press('[data-segment=sandbox][data-value=workspace-write]');
    await closeSheet();
    // 关闭模态框后放回焦点是异步收尾（关闭动画、列表可能随配置写入重建），标准：1 秒内回到原按钮；超时会打印当前焦点。
    await within('UI07 关闭"编辑执行者"后焦点回到触发它的更多按钮', 'document.activeElement===document.querySelector("[data-more-agent=codex]")', 1000);
    await settings();
    await press('[data-segment=watchWindow][data-value=never]');
    await verify('UI07 进度窗口分段写入 config.json', async () => { assert.equal((await readConfig()).watchWindow, 'never'); });
    await press('[data-segment=watchWindow][data-value=auto]');
    await save('settings-configured-dark'); nativeTheme.themeSource = 'light'; await save('settings-configured-light'); nativeTheme.themeSource = 'dark';
    await press('[data-managed-settings]');
    await check('UI07 侧栏托管入口滚动到托管设置', 'document.querySelector("#managed-section").getBoundingClientRect().top>=document.querySelector(".page-h").getBoundingClientRect().bottom-1');
    await save('settings-managed-off-dark');
    await press('[data-pref=managed]');
    await wait('document.querySelector("[data-pref=managed]").getAttribute("aria-checked")==="true"');
    await verify('UI07 托管开关写入 config.json', async () => { assert.equal((await readConfig()).managed, true); });
    await check('UI07 托管开关立即更新侧栏', 'document.querySelector(".nav-foot").textContent.includes("托管已开启")');
    await save('settings-managed-on-dark');
    await press('[data-page=tasks]'); await press('[data-task=t6]');
    await check('UI07 托管开启后中断横幅不再显示设置按钮', '!document.querySelector(".banner [data-managed-settings]")');
    await press('[data-managed-settings]'); await press('[data-pref=managed]');
    await wait('document.querySelector("[data-pref=managed]").getAttribute("aria-checked")==="false"');
    await verify('UI07 再次点击托管开关写回关闭', async () => { assert.equal((await readConfig()).managed, false); });
    await press('[data-page=tasks]'); await press('[data-task=t6]');
    await check('UI07 非手动中断提供去设置按钮', 'document.querySelector(".banner [data-managed-settings]")?.textContent==="去设置"');
    await press('.banner [data-managed-settings]');
    await check('UI07 中断横幅入口定位托管设置', '!!document.querySelector("#managed-section") && document.querySelector("#managed-section").getBoundingClientRect().top>=document.querySelector(".page-h").getBoundingClientRect().bottom-1');
    await h.wheel('.doc.scroll', 10000);
    await save('settings-configured-bottom-dark');
    await check('UI07 设置页底部包含主题、通知与配置路径', '!!document.querySelector("[data-segment=theme]") && !!document.querySelector("[data-pref=notifications]") && !!document.querySelector("[data-pref=folder]") && !!document.querySelector("[data-pref=managed]")');
    const openedBefore = effects.opened.length;
    await press('[data-pref=folder]');
    await happened('UI07 "打开所在文件夹"调用打开', () => effects.opened.length > openedBefore, 2000);
    await verify('UI07 "打开所在文件夹"真实调用打开公共目录（桩记录路径）', () => { assert.equal(effects.opened.length, openedBefore + 1); assert.equal(effects.opened.at(-1), home); });
    await h.wheel('.doc.scroll', -10000);
    // Stage03：Codex 的参数移到 Agent 页"编辑执行者"，设置页不再有 Codex 一节。
    await check('UI07 设置页不再有 Codex 一节（参数在 Agent 页"编辑执行者"里）', '![...document.querySelectorAll(".sect h2")].some(h=>h.textContent.startsWith("Codex")) && !document.querySelector("[data-setting=model]")');
    const configured = await readFile(config, 'utf8');
    const withoutCodex = JSON.parse(configured);
    delete withoutCodex.profiles.codex; withoutCodex.profiles.example = { adapter: 'claude-code', label: '示例执行者', enabled: true }; withoutCodex.defaultProfile = 'example';
    await writeFile(config, JSON.stringify(withoutCodex));
    await agentsPage('example');
    await check('UI07 没有 codex 执行者时执行者区没有 Codex 行', '!document.querySelector("[data-agent=codex]") && !!document.querySelector("[data-agent=example]")');
    await save('connect-no-codex-dark');
    await writeFile(config, configured);
    // 打开控件之后文件被外部破坏：写入必须失败并恢复界面原值（编辑执行者里）。
    await codexEdit();
    await writeFile(config, 'invalid'); await press('[data-setting=tier]'); await press('.ctx button:nth-child(3)');
    await check('UI07 写入失败恢复原值并显示原因（编辑执行者）', 'document.querySelector(".sheet [data-setting=tier]").textContent.trim()==="default" && !!document.querySelector(".sheet .banner.fail")');
    await verify('UI07 写入失败不篡改文件', async () => { assert.equal(await readFile(config, 'utf8'), 'invalid'); });
    await closeSheet();
    await settings(); await save('settings-invalid-top-dark');
    await h.wheel('.doc.scroll', 10000);
    await save('settings-invalid-dark');
    await check('UI07 无效配置禁用进度窗口控件并说明原因', '[...document.querySelectorAll("[data-segment=watchWindow]")].every(b=>b.disabled) && document.querySelector(".doc-in").textContent.includes("修好或删掉")');
    await codexEdit();
    await check('UI07 无效配置时"编辑执行者 · Codex"的派发参数控件禁用并说明原因', '[...document.querySelectorAll(".sheet [data-setting], .sheet [data-segment=sandbox]")].every(b=>b.disabled) && document.querySelector(".sheet").textContent.includes("修好或删掉")');
    await closeSheet();
    await rm(config); await settings();
    await h.wheel('.doc.scroll', 10000);
    // 018 加了"列表"一节后设置页更高：滚到底再点靠上的开关时，命中测试里的
    // scrollIntoView({block:"nearest"}) 会把它停在吸顶页头下面（被遮挡），先居中再点。
    await evaluate('document.querySelector("[data-pref=notifications]").scrollIntoView({block:"center"})');
    await press('[data-pref=notifications]');
    await wait('document.querySelector("[data-pref=notifications]").getAttribute("aria-checked")==="false"');
    await verify('UI07 通知开关单独保存到软件偏好，不创建 config.json', async () => {
        assert.equal(JSON.parse(await readFile(ownFile, 'utf8')).notifications, false); assert.equal(await exists(config), false);
    });
    await tabTo('[data-pref=notifications]'); await key('Space');
    await wait('document.querySelector("[data-pref=notifications]").getAttribute("aria-checked")==="true"');
    await verify('UI07 键盘空格重新打开通知并保存', async () => { assert.equal(JSON.parse(await readFile(ownFile, 'utf8')).notifications, true); });
    await captureExecutors(h, { config, home, settings });

    // UI10 主题：浅色 / 深色 / 跟随系统即时生效并保存。
    await press('[data-segment=theme][data-value=light]');
    // 主题要经主进程（nativeTheme）再推回界面，标准：点击后 1 秒内生效（实测用时打印在日志里）。
    await within('UI10 选浅色后界面立即变浅', 'document.documentElement.dataset.theme==="light"', 1000);
    // d6a0ceb 起主题先生效再写偏好文件，写入晚于界面变化，不能在界面变浅的同一刻读文件（PR #5 CI：读到旧值 system）。
    // 标准沿用原来的"点击后 1 秒内"（原来界面要等写完才变化，1 秒标准实际同时约束了写入）；断言内容不变。
    await happened('UI10 主题选择写入软件偏好', () => { try { return JSON.parse(readFileSync(ownFile, 'utf8')).theme === 'light'; } catch { return false; } }, 1000);
    await verify('UI10 主题选择保存到软件偏好', async () => { assert.equal(JSON.parse(await readFile(ownFile, 'utf8')).theme, 'light'); });
    await press('[data-segment=theme][data-value=dark]');
    await within('UI10 选深色后界面立即变深', 'document.documentElement.dataset.theme==="dark"', 1000);
    await press('[data-segment=theme][data-value=system]');
    await check('UI10 跟随系统时与系统配色一致', 'document.documentElement.dataset.theme===(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")');
    await verify('UI10 跟随系统写入软件偏好', async () => { assert.equal(JSON.parse(await readFile(ownFile, 'utf8')).theme, 'system'); });
    await press('[data-segment=theme][data-value=dark]');

    // UI08 关于页。
    await press('[data-page=about]'); await save('about-dark');
    await check('UI08 关于页品牌标记 48px、字标、版本与协议版本', `document.querySelector(".about-mark").getBoundingClientRect().width===48 && document.querySelector(".about .wordmark").textContent==="AgentRouter" && getComputedStyle(document.querySelector(".about .wordmark")).textTransform==="uppercase" && document.querySelector(".about").textContent.includes(${JSON.stringify(app.getVersion())}) && document.querySelector(".about").textContent.includes("文件协议 v2")`);
    await press('[data-pref=wizard]');
    await wait('!!document.querySelector(".wiz")');
    await check('UI08 "重新运行首次引导"打开引导第 1 步', '!!document.querySelector(".wiz") && [...document.querySelectorAll("[data-page]")].every(b=>b.disabled)');
    await press('[data-pref=skip]');
    await wait('!document.querySelector(".wiz")');
    await check('UI08 跳过引导回到软件，侧栏恢复可用', '[...document.querySelectorAll("[data-page]")].every(b=>!b.disabled)');
    const fontExists = await stat(path.join(__dirname, 'fonts/MiSansVF.ttf')).then(() => true, () => false);
    if (fontExists) await check('UI08 已加载随包 MiSans', 'document.fonts.check(\'13px "AgentRouter MiSans"\') && [...document.fonts].some(f=>f.family.includes("AgentRouter MiSans") && f.status==="loaded")');
    if (await exists(path.join(__dirname, 'fonts/SpaceGrotesk.ttf'))) await check('UI08 字标已加载随包 Space Grotesk', 'document.fonts.check(\'700 13px "AgentRouter Space Grotesk"\') && [...document.fonts].some(f=>f.family.includes("AgentRouter Space Grotesk") && f.status==="loaded")');
    return fontExists;
}

// 执行者区（任务 004）：标签与认证状态、测试连接成功 / 失败、设为默认、停用 / 启用、删除、编辑 claude-code、模态框焦点。
// 开始前写入专用的 config.json 与隔离密钥，结束后恢复成"没有 config.json"、密钥文件原样。
async function captureExecutors(h: Harness, { config, home, settings }: { config: string; home: string; settings: () => Promise<void> }) {
    const { wait, check, verify, press, key, type, save, evaluate, tabTo } = h;
    const secretsFile = appEnv.AR_TEST_SECRETS_FILE!;
    assert.ok(!path.relative(home, secretsFile).startsWith('..'), '密钥文件必须在隔离目录里');
    const secretsBefore = await readFile(secretsFile, 'utf8').catch(() => null);
    const readConfig = async () => JSON.parse(await readFile(config, 'utf8'));
    await writeFile(config, JSON.stringify({ v: 2, defaultProfile: 'ok', managed: false, watchWindow: 'never', profiles: {
        codex: { adapter: 'codex', label: 'Codex', enabled: true, model: null, effort: null, tier: null, sandbox: 'workspace-write' },
        example: { adapter: 'claude-code', label: 'Example Agent', enabled: true, env: { ANTHROPIC_BASE_URL: 'https://example.invalid/api', ANTHROPIC_MODEL: 'example-model' }, auth: 'token', secrets: { ANTHROPIC_AUTH_TOKEN: 'EXAMPLE_TEST_KEY' }, maxTurns: null },
        ok: { adapter: 'fake', label: 'Fake Ok', enabled: true, events: [{ kind: 'say', text: 'OK' }], report: 'OK\n' },
        bad: { adapter: 'fake', label: 'Fake Bad', enabled: true, events: [{ kind: 'error', text: '接口返回 401' }], report: '没有完成\n', exit: 3 },
        slow: { adapter: 'fake', label: 'Fake Slow', enabled: true, events: [{ kind: 'say', text: '慢' }, { kind: 'say', text: '还在' }], report: 'OK\n', delayMs: 60000 },
    } }));
    await writeFile(secretsFile, JSON.stringify({ EXAMPLE_TEST_KEY: 'sk-shots-example-0000' }));
    try {
        await press('[data-page=tasks]'); await press('[data-page=connect]'); await wait('!!document.querySelector("[data-agent=bad]")');
        await check('UI06 执行者区每行：标签、默认、认证状态（隔离密钥文件）', 'document.querySelector("[data-agent=ok] .x1").textContent.includes("默认") && document.querySelector("[data-agent=example] .xtag").textContent==="EX" && document.querySelector("[data-agent=example] .x2").textContent.includes("已设置") && document.querySelector("[data-agent=codex] .x1").textContent.includes("只在指定时使用")');
        await save('connect-executors-dark'); nativeTheme.themeSource = 'light'; await save('connect-executors-light'); nativeTheme.themeSource = 'dark';
        await press('[data-test=ok]');
        await check('UI06 测试连接中按钮忙碌并禁用', 'document.querySelector("[data-test=ok]").disabled');
        const testStarted = Date.now();
        await wait('!!document.querySelector("[data-agent=ok] .xresult") && !document.querySelector("[data-test=ok]").disabled', '测试连接结果', 60000);
        console.log('测试连接用时：' + (Date.now() - testStarted) + 'ms');
        await check('UI06 测试连接成功：行下显示成功结果', '!document.querySelector("[data-agent=ok] .xresult").classList.contains("fail") && document.querySelector("[data-agent=ok] .xresult").textContent.includes("连接成功")');
        await verify('UI06 测试连接结果写入 agent-tests.json', async () => { assert.equal(JSON.parse(await readFile(path.join(home, 'agent-tests.json'), 'utf8')).ok.ok, true); });
        await press('[data-test=bad]'); await wait('!!document.querySelector("[data-agent=bad] .xresult.fail") && !document.querySelector("[data-test=bad]").disabled');
        await check('UI06 测试连接失败：行下显示核心给的原因', 'document.querySelector("[data-agent=bad] .xresult.fail").textContent.includes("401")');
        await save('connect-testfail-dark');
        // UI14 测试连接三种结果：成功、失败、超时（验收环境把测试上限设成几秒，见 tools/shots.mjs）。
        await press('[data-test=ok]'); await check('UI14 测试连接：测试中按钮忙碌', 'document.querySelector("[data-test=ok]").disabled');
        await wait('!!document.querySelector("[data-agent=ok] .xresult") && !document.querySelector("[data-test=ok]").disabled', 'UI14 成功结果', 60000);
        await check('UI14 测试连接成功：显示连接成功与版本，按钮恢复', 'document.querySelector("[data-agent=ok] .xresult").textContent.includes("连接成功") && document.querySelector("[data-agent=ok] .xresult").textContent.includes("fake-agent 1.0") && !document.querySelector("[data-test=ok]").disabled');
        await press('[data-test=bad]'); await check('UI14 测试连接失败：测试中按钮忙碌', 'document.querySelector("[data-test=bad]").disabled');
        await wait('!!document.querySelector("[data-agent=bad] .xresult.fail") && !document.querySelector("[data-test=bad]").disabled', 'UI14 失败结果', 60000);
        await check('UI14 测试连接失败：显示核心给的原因，按钮恢复', 'document.querySelector("[data-agent=bad] .xresult.fail").textContent.includes("401")');
        await press('[data-test=slow]'); await check('UI14 测试连接超时：测试中按钮忙碌', 'document.querySelector("[data-test=slow]").disabled');
        await wait('!!document.querySelector("[data-agent=slow] .xresult.fail") && !document.querySelector("[data-test=slow]").disabled', 'UI14 超时结果', 90000);
        await check('UI14 测试连接超时：显示超时原因，按钮恢复', 'document.querySelector("[data-agent=slow] .xresult.fail").textContent.includes("超过")');
        await verify('UI14 超时也记入 agent-tests.json（ok:false）', async () => { const r = JSON.parse(await readFile(path.join(home, 'agent-tests.json'), 'utf8')); assert.equal(r.slow.ok, false); assert.match(r.slow.error, /超过/); });
        await press('[data-more-agent=example]'); await press('.ctx button:nth-child(2)'); await wait('document.querySelector("[data-agent=example] .x1").textContent.includes("默认")');
        await verify('UI06 设为默认写入 config.json', async () => { assert.equal((await readConfig()).defaultProfile, 'example'); });
        await press('[data-more-agent=bad]'); await press('.ctx button:nth-child(3)'); await wait('document.querySelector("[data-agent=bad] .x1").textContent.includes("已停用")');
        await verify('UI06 停用写入 config.json', async () => { assert.equal((await readConfig()).profiles.bad.enabled, false); });
        await press('[data-more-agent=bad]'); await press('.ctx button:nth-child(3)'); await wait('!document.querySelector("[data-agent=bad] .x1").textContent.includes("已停用")');
        await verify('UI06 启用写入 config.json', async () => { assert.equal((await readConfig()).profiles.bad.enabled, true); });
        await press('[data-more-agent=bad]'); await press('.ctx button:nth-child(4)');
        await check('UI06 删除确认默认焦点在取消且使用危险按钮', 'document.activeElement.textContent==="取消" && !!document.querySelector(".confirm-actions .danger")');
        await press('.confirm-actions .btn');
        await verify('UI06 取消删除不改 config.json', async () => { assert.ok((await readConfig()).profiles.bad); });
        await press('[data-more-agent=bad]'); await press('.ctx button:nth-child(4)'); await press('.confirm-actions .danger'); await wait('!document.querySelector("[data-agent=bad]")');
        await verify('UI06 确认删除后 config.json 里没有这个执行者', async () => { assert.equal((await readConfig()).profiles.bad, undefined); });
        // 编辑 claude-code 执行者：模态框焦点、保存、失败横幅、放弃确认。
        await press('[data-more-agent=example]'); await press('.ctx button:nth-child(1)'); await wait('!!document.querySelector(".sheet [data-e=model]")');
        await check('UI06 编辑执行者：打开后焦点在模态框内', '!!document.activeElement.closest(".sheet")');
        for (let i = 0; i < 12; i++) await key('Tab');
        await check('UI06 编辑执行者：Tab 不会跑出模态框', '!!document.activeElement.closest(".sheet")');
        await h.focusRing('UI06 编辑执行者模态框里的控件');
        await key('Escape'); await wait('!document.querySelector(".sheet")');
        await check('UI06 编辑执行者：Esc 关闭后焦点回到触发它的更多按钮', 'document.activeElement===document.querySelector("[data-more-agent=example]")');
        await press('[data-more-agent=example]'); await press('.ctx button:nth-child(1)'); await wait('!!document.querySelector(".sheet [data-e=model]")');
        await save('connect-claude-edit-dark');
        await type('[data-e=model]', '-2'); await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
        await verify('UI06 编辑执行者保存后 config.json 的模型改变', async () => { assert.equal((await readConfig()).profiles.example.env.ANTHROPIC_MODEL, 'example-model-2'); });
        const before = await readFile(config, 'utf8');
        await press('[data-more-agent=example]'); await press('.ctx button:nth-child(1)'); await wait('!!document.querySelector(".sheet [data-e=maxTurns]")');
        await type('[data-e=maxTurns]', '0'); await press('.sheet-btns .btn:last-child'); await wait('!!document.querySelector(".sheet .banner.fail")');
        await check('UI06 编辑执行者保存失败：模态框里显示原因、仍然打开', '!!document.querySelector(".sheet .banner.fail") && !!document.querySelector(".sheet")');
        await verify('UI06 编辑执行者保存失败不改 config.json', async () => { assert.equal(await readFile(config, 'utf8'), before); });
        await key('Escape'); await wait('!!document.querySelector(".confirm-actions")');
        await check('UI06 有未保存改动时关闭先确认放弃', 'document.querySelector(".confirm-card h2").textContent==="放弃未保存的改动？"');
        await press('.confirm-actions .danger'); await wait('!document.querySelector(".sheet")');
        await check('UI06 执行者区没有密钥值（DOM 里）', `!document.body.innerHTML.includes("sk-shots-example-0000")`);
        // UI13 导入向导三步（任务 005）：推荐预设 → 设置密钥（隔离密钥文件）→ 自动测试连接（验收环境的假 Claude Code 回 OK）。
        const secretValue = 'sk-shots-import-4821';
        await tabTo('.page-h [data-import-agent]'); await key('Enter'); await wait('!!document.querySelector(".sheet .preset.on")');
        await check('UI13 导入向导：标题行按钮键盘可打开，推荐预设默认选中', 'document.querySelector(".sheet .preset.on").getAttribute("aria-checked")==="true" && document.querySelector(".sheet .preset.on .tag.brand")?.textContent==="推荐" && !!document.activeElement.closest(".sheet")');
        const recommended: string = await evaluate('document.querySelector(".sheet .preset.on").dataset.preset');
        await save('connect-import-1-dark'); nativeTheme.themeSource = 'light'; await save('connect-import-1-light'); nativeTheme.themeSource = 'dark';
        await key('Down'); await wait(`document.querySelector('.sheet .preset.on')?.dataset.preset!==${JSON.stringify(recommended)}`);
        await check('UI13 导入向导：方向键换选择', `document.querySelector(".sheet .preset.on").dataset.preset!==${JSON.stringify(recommended)} && document.activeElement===document.querySelector(".sheet .preset.on")`);
        await key('Up'); await wait(`document.querySelector('.sheet .preset.on')?.dataset.preset===${JSON.stringify(recommended)}`);
        await check('UI13 导入向导：方向键回到推荐预设', `document.querySelector(".sheet .preset.on").dataset.preset===${JSON.stringify(recommended)}`);
        await press('[data-w-act=next]'); await wait('!!document.querySelector(".sheet [data-w=secret]") && !!document.querySelector("[data-w-status]")');
        await check('UI13 第 2 步：密钥未设置时"下一步"禁用并有说明', 'document.querySelector("[data-w-act=next]").disabled && !!document.querySelector("[data-w-act=next]").title && document.querySelector("[data-w-status]").textContent==="未设置" && document.querySelector("[data-w=secret]").type==="password"');
        await save('connect-import-2-dark'); nativeTheme.themeSource = 'light'; await save('connect-import-2-light'); nativeTheme.themeSource = 'dark';
        await type('[data-w=secret]', secretValue); await press('[data-w-act=save-secret]');
        await wait('document.querySelector("[data-w-status]")?.textContent==="已设置"');
        await check('UI13 保存密钥后密码框已清空、状态变"已设置"', 'document.querySelector("[data-w=secret]").value==="" && !document.querySelector("[data-w-act=next]").disabled');
        await verify('UI13 密钥写进隔离密钥文件，公共目录其他文件与界面里都没有它', async () => {
            const secrets = JSON.parse(await readFile(secretsFile, 'utf8'));
            assert.equal(Object.values(secrets).filter(v => v === secretValue).length, 1);
            const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))).flat();
            for (const file of await walk(home)) {
                if (file === secretsFile || /\.(png|ttf|exe|dll|pak|bin|dat|ldb|log)$/i.test(file) || file.includes(`${path.sep}monitor${path.sep}`)) continue;
                assert.ok(!(await readFile(file, 'utf8').catch(() => '')).includes(secretValue), `密钥出现在 ${file}`);
            }
            assert.equal(await evaluate(`document.body.innerHTML.includes(${JSON.stringify(secretValue)})`), false);
        });
        await press('[data-w-act=next]'); await wait('!!document.querySelector("[data-w-result]")', 'UI13 测试结果', 60000);
        await check('UI13 第 3 步：自动测试连接并显示连接成功', 'document.querySelector("[data-w-result]").dataset.wResult==="ok" && document.querySelector(".sheet").textContent.includes("连接成功")');
        await verify('UI13 config.json 出现新执行者（适配器、显示名、密钥变量名），没有密钥值', async () => { const prof = (await readConfig()).profiles[recommended]; assert.equal(prof.adapter, 'claude-code'); assert.ok(prof.label); assert.equal(Object.keys(prof.secrets).length, 1); assert.ok(!JSON.stringify(prof).includes(secretValue)); });
        await save('connect-import-3-dark'); nativeTheme.themeSource = 'light'; await save('connect-import-3-light'); nativeTheme.themeSource = 'dark';
        await press('[data-w-act=done]'); await wait(`!document.querySelector(".sheet") && !!document.querySelector('[data-agent=${JSON.stringify(recommended)}]')`);
        await check('UI13 完成后执行者区出现新的一行', `!!document.querySelector('[data-agent=${JSON.stringify(recommended)}]')`);
        await press('.page-h [data-import-agent]'); await wait('!!document.querySelector(".sheet .preset.on")'); await press('[data-w-act=next]'); await wait('!!document.querySelector(".sheet [data-w=label]")');
        await check('UI13 名称已被占用时自动加序号', `document.querySelector("[data-w=name]").value===${JSON.stringify(recommended + '-2')}`);
        await type('[data-w=label]', ' 2'); await key('Escape'); await wait('!!document.querySelector(".confirm-actions")');
        await check('UI13 第 2 步改过字段后按 Esc 先确认放弃', 'document.querySelector(".confirm-card h2").textContent==="放弃未保存的改动？"');
        await press('.confirm-actions .btn'); await wait('!document.querySelector(".confirm-actions")');
        await check('UI13 取消放弃后仍在第 2 步', '!!document.querySelector(".sheet [data-w=label]")');
        await key('Escape'); await wait('!!document.querySelector(".confirm-actions")'); await press('.confirm-actions .danger'); await wait('!document.querySelector(".sheet")');
        await check('UI13 放弃后向导关闭、DOM 里没有密码框', '!document.querySelector("[data-w=secret]")');
        // 走查第 3 轮：新增 MiMo 两张预设卡（Token Plan / 按量付费）；推荐标记仍只在 DeepSeek 上。
        await press('.page-h [data-import-agent]'); await wait('!!document.querySelector(".sheet .preset.on")');
        await check('UI13 第 1 步按新清单显示 7 张卡片，两张 MiMo 紧跟 DeepSeek，标题与说明来自预设，推荐标记只在 DeepSeek 上', `(() => {
            const cards = [...document.querySelectorAll(".sheet .preset")];
            const names = cards.map(c => c.dataset.preset);
            const card = name => cards.find(c => c.dataset.preset === name);
            const brand = [...document.querySelectorAll(".sheet .preset .tag.brand")];
            return names.length === 7 && names[0] === "deepseek" && names[1] === "mimo" && names[2] === "mimo-payg" && names[3] === "claude-native" && names[4] === "claude-subscription" && names[5] === "compat" && names[6] === "codex"
                && card("mimo").querySelector("b").textContent === "Xiaomi MiMo（Token Plan）" && card("mimo").querySelector(".pk > span").textContent === "经 Claude Code 外壳运行，用 Token Plan 的 API Key（tp- 开头）"
                && card("mimo-payg").querySelector("b").textContent === "Xiaomi MiMo（按量付费）" && card("mimo-payg").querySelector(".pk > span").textContent === "经 Claude Code 外壳运行，按量付费，用 sk- 开头的 API Key"
                && brand.length === 1 && brand[0].closest(".preset").dataset.preset === "deepseek";
        })()`);
        await save('connect-import-1-mimo-dark');
        await press('[data-preset=mimo]');
        await wait('document.querySelector(".sheet .preset.on")?.dataset.preset==="mimo"');
        await press('[data-w-act=next]');
        await wait('!!document.querySelector(".sheet [data-w=secretVar]")');
        await check('UI13 选 MiMo（Token Plan）进入第 2 步：密钥变量名为 MIMO_API_KEY，隔离密钥文件里未设置', 'document.querySelector("[data-w=secretVar]").value==="MIMO_API_KEY" && document.querySelector("[data-w-status]").textContent==="未设置"');
        await save('connect-import-2-mimo-dark');
        await key('Escape'); await wait('!document.querySelector(".sheet")');
        void evaluate;
    } finally {
        await rm(config, { force: true });
        if (secretsBefore === null) await rm(secretsFile, { force: true }); else await writeFile(secretsFile, secretsBefore);
    }
    // 后面的主题检查从设置页开始。
    await settings();
}
