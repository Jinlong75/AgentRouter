import { readFile, writeFile, rename, rm, stat, readdir, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { pollUntil, ipcSeq, waitIpcReturn } from './shots-input';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { app, nativeTheme } from 'electron';
import type { Harness } from './shots-input';
import { effects } from './effects';
import { appEnvironment } from './app-env.mjs';
import { fakeCodexModels } from './shots-agents';
import { fileDialogs } from './console.mjs';
import { ag, c, gx, p, px, ro, s6, sc } from '../shared/copy';

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
    // 112：同一服务只放一张卡片；选 Xiaomi MiMo 后表单第一行是"套餐"分段按钮，切换等于改选另一个预设。
    const wizardPresets: any[] = await evaluate(`window.dock.console('agents:presets').then(r => r.presets)`);
    const byName = (name: string) => wizardPresets.find(x => x.name === name);
    await check('UI09 第 3 步的预设卡片按服务合并：8 张（DeepSeek、Xiaomi MiMo、Claude Code、兼容后端、Codex、Qoder、DeepSeek Harness、OpenAI 兼容接口），合并卡片的标题与说明来自 presets --json 的 card，推荐标记只在 DeepSeek 上', `(() => {
        const cards = [...document.querySelectorAll(".presets .preset")], names = cards.map(c => c.dataset.wizardPreset);
        const merged = (name, c) => { const el = cards.find(x => x.dataset.wizardPreset === name); return el.dataset.card === c.id && el.querySelector("b").textContent === c.title && el.querySelector(".pk > span").textContent === c.description; };
        return names.join() === "deepseek,mimo,claude-native,compat,codex,qoder-cn,deepseek-harness,openai-compat"
            && merged("mimo", ${JSON.stringify(byName('mimo').card)}) && merged("claude-native", ${JSON.stringify(byName('claude-native').card)}) && merged("qoder-cn", ${JSON.stringify(byName('qoder-cn').card)})
            && document.querySelectorAll(".presets .preset .tag.brand").length === 1 && !!cards[0].querySelector(".tag.brand");
    })()`);
    await press('[data-wizard-preset=mimo]');
    await wait('document.querySelector(".preset.on")?.dataset.wizardPreset==="mimo" && !!document.querySelector("[data-wizard-variant]")');
    await check('UI09 选 Xiaomi MiMo 后第一行是"套餐"分段按钮：Token Plan 选中，说明是该预设的 variant.help', `(() => {
        const first = document.querySelector(".presets").nextElementSibling, buttons = [...first.querySelectorAll(".segm button")];
        return first.querySelector(".fl b").textContent === ${JSON.stringify(byName('mimo').variant.label)} && buttons.map(b => b.textContent).join() === ${JSON.stringify(byName('mimo').variant.option + ',' + byName('mimo-payg').variant.option)}
            && buttons[0].classList.contains("on") && buttons[0].getAttribute("aria-pressed") === "true" && buttons[0].dataset.wizardVariant === "mimo" && buttons[1].dataset.wizardVariant === "mimo-payg"
            && first.querySelector(".fl span").textContent === ${JSON.stringify(byName('mimo').variant.help)};
    })()`);
    await press('[data-wizard-variant=mimo-payg]');
    await wait('document.querySelector("[data-wizard-variant=mimo-payg]")?.classList.contains("on")');
    // 引导页不显示接口地址；切换真的改选了另一个预设（按钮对应的预设有不同的接口地址），说明与按钮状态一起变。
    await check('UI09 点"按量付费"：按钮状态互换、说明换成该预设的 variant.help；这个按钮对应的预设接口地址与 Token Plan 的不同', `(() => {
        const buttons = [...document.querySelectorAll("[data-wizard-variant]")], first = document.querySelector(".presets").nextElementSibling;
        return buttons[1].getAttribute("aria-pressed") === "true" && buttons[0].getAttribute("aria-pressed") === "false" && !buttons[0].classList.contains("on")
            && first.querySelector(".fl span").textContent === ${JSON.stringify(byName('mimo-payg').variant.help)}
            && ${JSON.stringify(byName('mimo-payg').env.ANTHROPIC_BASE_URL)} !== ${JSON.stringify(byName('mimo').env.ANTHROPIC_BASE_URL)} && document.querySelector(".preset.on").dataset.wizardPreset === "mimo";
    })()`);
    // 172：切换预设后，读密钥状态的结果回来时界面会重画（chooseWizardPreset 的第二次 render）；真实用户这时可能已经点进密钥框开始输入。
    // 让 secrets:status 慢 1.5 秒，把"点中并输入"稳稳放进这个窗口，断言结果回来之后焦点仍在密钥框、已输入的字还在。
    // A：结果回来时内容没变（状态仍是"未设置"）——不重画；B：结果回来时内容变了（状态变成"已设置"）——重画，但焦点、输入、光标都保住。
    const mimoSecret = Object.values(byName('mimo-payg').secrets ?? {})[0] as string;
    const secretsBefore = await readFile(secretsFile, 'utf8').catch(() => null);
    effects.consoleDelay['secrets:status'] = 1500;
    try {
        for (const [label, variant, draft, changes] of [['A 内容没变', 'mimo', 'sk-draft-a', false], ['B 内容变了', 'mimo-payg', 'sk-draft-b', true]] as const) {
            const statusFrom = ipcSeq();
            await press(`[data-wizard-variant=${variant}]`);
            await wait(`document.querySelector("[data-wizard-variant=${variant}]")?.classList.contains("on")`);
            await type('[data-wizard-secret]', draft);
            if (changes) await writeFile(secretsFile, JSON.stringify({ ...(secretsBefore ? JSON.parse(secretsBefore) : {}), [mimoSecret]: 'sk-shots-regress-172' }));
            await waitIpcReturn(`UI09 172 ${label}：secrets:status`, 'console', 'secrets:status', statusFrom, 15000);
            if (changes) await wait('document.querySelector("[data-wizard-secret-state]")?.textContent==="已设置"', '界面按新状态重画', 15000);
            else await wait('!!document.querySelector("[data-wizard-secret-state]")');
            await check(`UI09 172 ${label}：读密钥状态的结果回来、界面重画（或判定无需重画）之后，焦点仍在密钥框，已输入的字还在`, `document.activeElement === document.querySelector("[data-wizard-secret]") && document.querySelector("[data-wizard-secret]").value === ${JSON.stringify(draft)}`);
            await key('Backspace');
            await check(`UI09 172 ${label}：重画之后继续输入仍然生效（光标在末尾）`, `document.querySelector("[data-wizard-secret]").value === ${JSON.stringify(draft.slice(0, -1))}`);
            await evaluate('document.querySelector("[data-wizard-secret]").value = ""');
        }
    } finally {
        delete effects.consoleDelay['secrets:status'];
        if (secretsBefore === null) await rm(secretsFile, { force: true }); else await writeFile(secretsFile, secretsBefore);
    }
    // 回到推荐的 DeepSeek，后面按原流程导入。
    await press('[data-wizard-preset=deepseek]');
    await wait('document.querySelector(".preset.on")?.dataset.wizardPreset==="deepseek" && !document.querySelector("[data-wizard-variant]")');
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
    // Stage07c 151（T5）：连接成功的说明下面多一行"可以按你的执行者生成建议规则（路由页）"（点了跳到路由页并打开建议弹窗，见 UI08 的第三次引导）。
    await check('UI09 第 3 步连接成功的说明下面有一行 ro.suggestHint（次按钮、带路由图标），在每日上限问题之前', `(() => { const b = document.querySelector('[data-pref=wizard-suggest]'), ok = document.querySelector('[data-wizard-result=ok]'), limit = document.querySelector('[data-wizard-limit]'); return !!b && b.textContent.trim() === ${JSON.stringify(ro.suggestHint)} && !!b.querySelector('i.ri-route-line') && !b.classList.contains('primary') && !!(ok.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(b.compareDocumentPosition(limit) & Node.DOCUMENT_POSITION_FOLLOWING); })()`);
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
    await check('UI09 已有多个执行者：强执行者是下拉，默认不设，没有只说明一句', `!!document.querySelector('[data-pref=wizard-strong]') && document.querySelector('[data-pref=wizard-strong] span').textContent === ${JSON.stringify(p.wizardStrongNone)} && !document.querySelector('[data-wizard-strong-only]')`);
    await press('[data-pref=wizard-strong]'); await wait('!!document.querySelector(".ctx")');
    const strongLabels = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.ctx button')].map(b => b.textContent.trim()))`)) as string[];
    assert.equal(strongLabels[0], p.wizardStrongNone); assert.ok(strongLabels.length >= 3, `选项：${strongLabels.join()}`);
    await press('.ctx button:nth-child(2)'); await wait('!document.querySelector(".ctx")');
    await check('UI09 选了第一个执行者：下拉显示它', `document.querySelector('[data-pref=wizard-strong] span').textContent === ${JSON.stringify(strongLabels[1])}`);
    await save('wizard-3-strong-dark'); nativeTheme.themeSource = 'light'; await save('wizard-3-strong-light'); nativeTheme.themeSource = 'dark';

    // 137（D73）：测试成功后可选填"每天最多几个任务"；空着跳过、填 0 报错、填 2 才写 limits.maxTasksPerDay。
    const limitedProfile = async () => Object.entries((await readConfig()).profiles).find(([, profile]: [string, any]) => Object.values(profile.secrets ?? {}).includes('DEEPSEEK_API_KEY'))![1] as any;
    await check('UI09 第 3 步测试成功后出现"每天最多几个任务"：输入框默认空、占位"不限"，单位"个任务"', `(() => {
        const input = document.querySelector("[data-wizard-limit]");
        return !!input && input.value === "" && input.placeholder === "不限" && input.closest(".statusline").textContent.includes("每天最多") && input.closest(".statusline").textContent.includes("个任务")
            && document.querySelector("[data-wizard-limit-error]").textContent === "" && !input.classList.contains("bad");
    })()`);
    await type('[data-wizard-limit]', '0');
    await press('[data-pref=next]');
    await wait('document.querySelector("[data-wizard-limit-error]")?.textContent.length > 0', '填 0 后出现提示');
    await check('UI09 填 0 点"下一步"：显示"填 1 以上的整数…"，输入框标红，仍在第 3 步', `document.querySelector("[data-wizard-limit-error]").textContent === "填 1 以上的整数，或者空着（不限）" && document.querySelector("[data-wizard-limit]").classList.contains("bad") && !document.querySelector("[data-wizard-folder]") && document.querySelector("[data-wizard-limit]").value === "0"`);
    await verify('UI09 填 0 不写配置：这个执行者没有 limits', async () => { assert.equal((await limitedProfile()).limits, undefined); });
    await press('[data-wizard-limit]');
    await key('Backspace');
    await check('UI09 改动输入框后提示立即消失', 'document.querySelector("[data-wizard-limit]").value === "" && document.querySelector("[data-wizard-limit-error]").textContent === ""');
    await type('[data-wizard-limit]', '2');
    await press('[data-pref=next]');
    await wait('!!document.querySelector("[data-wizard-folder]")', '填 2 后进入第 4 步');
    await verify('UI09 填 2 点"下一步"：进第 4 步，config.json 里 limits.maxTasksPerDay === 2', async () => { assert.equal((await limitedProfile()).limits.maxTasksPerDay, 2); });
    await verify('UI09 点下一步：routing.strongExecutor 是所选执行者（已有的名字）', async () => { const c = await readConfig(); assert.ok(c.routing?.strongExecutor && c.profiles[c.routing.strongExecutor], JSON.stringify(c.routing)); });

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
    // 改写（144，T3：Codex 编辑改为表单式）：原来等 `.sheet [data-setting=model]`（设置式控件）→ 现在等表单里的显示名输入框与模型下拉。
    const codexEdit = async () => { await agentsPage(); await press('[data-more-agent=codex]'); await press('.ctx button:nth-child(1)'); await wait('!!document.querySelector(".sheet [data-e=label]") && !!document.querySelector(".sheet [data-sel=model]")'); };
    // 表单式的底栏是"取消 / 保存"：closeSheet 关掉框（点"取消"，没有改动时不会弹放弃确认）。
    const closeSheet = async () => { await press('.sheet-btns .btn:first-child'); await wait('!document.querySelector(".sheet")'); };
    // 下拉菜单（.optmenu）里按文字选一项：先点开下拉，再点那一项，都是真实点击。
    const optionSelector = async (label: string) => {
        const index = await evaluate(`(() => { const items = [...document.querySelectorAll('.optmenu button')]; items.forEach((b, i) => b.setAttribute('data-pick', String(i))); return items.findIndex(b => [...b.querySelectorAll('span')].find(s => !s.classList.contains('ri-sp'))?.textContent.trim() === ${JSON.stringify(label)}); })()`);
        assert.ok(index >= 0, `下拉里没有「${label}」`);
        return `.optmenu button[data-pick="${index}"]`;
    };
    const pickOption = async (selector: string, label: string) => { await press(selector); await wait('!!document.querySelector(".optmenu")'); await press(await optionSelector(label)); await wait('!document.querySelector(".optmenu")'); };
    const menuLabels = (): Promise<string[]> => evaluate(`[...document.querySelectorAll('.optmenu button')].map(b => [...b.querySelectorAll('span')].find(s => !s.classList.contains('ri-sp')).textContent.trim())`);
    nativeTheme.themeSource = 'dark';
    // 037 第 4 项（来源核实见任务汇报）：claude-code 行的版本在验收里走 AR_TEST_AGENT 的假脚本（那份脚本是为 codex 写的），
    // 会串成 codex-cli；真实安装没有这个问题（detect 跑的是真 claude --version）。这里把向导创建的 deepseek 指向假 Claude Code
    //（profile.path 优先于 AR_TEST_AGENT），行内版本与随后重测的连接结果就都是 Claude Code 风格。
    if ((await readConfig()).profiles?.deepseek?.adapter === 'claude-code') {
        const cfg = await readConfig();
        cfg.profiles.deepseek.path = path.join(home, 'fake-claude.cjs');
        await writeFile(config, JSON.stringify(cfg));
    }

    // UI06 技能：检测、更新、版本提示、较新版本保护、自改版本替换与回退。
    await press('[data-page=connect]'); await wait('!!document.querySelector("[data-host-card]") && !document.querySelector("[data-pref=detect]").disabled && !!document.querySelector("[data-agent=codex]")');
    await save('connect-normal-dark'); nativeTheme.themeSource = 'light'; await save('connect-normal-light'); nativeTheme.themeSource = 'dark';
    await check('UI06 Agent 页执行者区的 Codex 行通过假 Codex 检测版本和登录状态', 'document.querySelector("[data-agent=codex]").textContent.includes("codex-cli 0.156.1") && document.querySelector("[data-agent=codex]").textContent.includes("已登录")');
    // 037 第 4 项：claude-code 执行者（deepseek）行的版本不能是 codex-cli，必须是 Claude Code 风格；codex 行仍含 codex-cli。
    // 行内版本来自刚切换页面时的检测；再真实测一次连接，让行下的测试结果行也换成 Claude Code 版本（旧结果是向导时期记的 codex-cli）。
    await press('[data-test=deepseek]');
    await wait('!!document.querySelector("[data-agent=deepseek] .xresult") && !document.querySelector("[data-test=deepseek]").disabled', '重新测试 deepseek 连接', 60000);
    await check('UI06 Agent 页 claude-code 执行者（deepseek）行的版本是 Claude Code 风格、不含 codex-cli', 'document.querySelector("[data-agent=deepseek]").textContent.includes("2.1.302 (Claude Code)") && !document.querySelector("[data-agent=deepseek]").textContent.includes("codex-cli")');
    await check('UI06 Agent 页 Codex 行的版本含 codex-cli（claude-code 行串版本不波及它）', 'document.querySelector("[data-agent=codex]").textContent.includes("codex-cli")');
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
    // 改写（144，T3：Codex 编辑改为表单式）：原来的设置式检查（每改一项立即写进 config.json、底栏"完成"）整段换成表单式：
    // 改动只在点"保存"时一次写入，点"取消"、Esc 放弃都不写；模型与推理强度的下拉来自探针（验收环境的假 Codex 给假目录，见 fakeCodexModels）。
    const restoreModels = await fakeCodexModels(home);
    const fieldOf = (label: string) => `[...document.querySelectorAll('.sheet .fld')].find(f => f.querySelector('.fl b').textContent.replace('*', '') === ${JSON.stringify(label)})`;
    const timeText = (text: string) => new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('00:00', '\\d\\d:\\d\\d') + '$');
    await codexEdit();
    await check('UI07 编辑 Codex 是表单式：字段顺序是显示名、模型、推理强度、服务档位、沙箱、位置、可担任、可能用到的模型范围、升级到，底栏是"取消 / 保存"，没有"完成"', `[...document.querySelectorAll('.sheet .fl b')].map(b => b.textContent.replace('*', '')).join() === ${JSON.stringify([ag.label, c.model, c.effort, p.tier, c.sandbox, ag.location, ag.canDo, ag.modelRange, gx.escalate].join())} && [...document.querySelectorAll('.sheet-btns .btn')].map(b => b.textContent).join() === ${JSON.stringify([c.cancel, ag.save].join())}`);
    await wait('!!document.querySelector(".sheet [data-probe-refresh]") && !document.querySelector(".sheet [data-probe-refresh]").disabled && document.querySelector(".sheet [data-probe-note]").textContent !== ""', 'UI07 Codex 编辑：探针查完（"刷新列表"可点、说明有内容）');
    await check('UI07 Codex 编辑：模型下面写"列表来自程序 · HH:MM 更新"（探针 source 为 program），"刷新列表"在下拉右边', `${timeText(ag.probeFrom('program', '00:00')).toString()}.test(document.querySelector('.sheet [data-probe-note]').textContent) && document.querySelector('.sheet [data-probe-refresh]').textContent === ${JSON.stringify(ag.refreshList)} && document.querySelector('.sheet [data-probe-refresh]').previousElementSibling === document.querySelector('.sheet [data-sel=model]').closest('.selw')`);
    await save('connect-codex-edit-dark'); nativeTheme.themeSource = 'light'; await save('connect-codex-edit-light'); nativeTheme.themeSource = 'dark';
    await check('UI07 环境变量覆盖在对应行说明（服务档位）', `${fieldOf(p.tier)}.querySelector('.override')?.textContent.includes("环境变量 CODEX_TIER 正在覆盖这一项（priority）")`);
    await press('[data-sel=model]'); await wait('!!document.querySelector(".optmenu")');
    await verify('UI07 Codex 模型下拉：第一项"跟随 Codex（gpt-x）"，然后是探针的可选模型（不含 visibility 不是 list 的），最后是"自定义…"', async () => { assert.deepEqual(await menuLabels(), [p.follow('gpt-x'), 'test-pro', 'test-mini', gx.modelCustom]); });
    await key('Escape'); await wait('!document.querySelector(".optmenu")');
    // 换一个模型：推理强度的选项与说明跟着变（两个模型给不同的强度列表）。
    await pickOption('[data-sel=model]', 'test-pro');
    await press('[data-sel=effort]'); await wait('!!document.querySelector(".optmenu")');
    await verify('UI07 选 test-pro：推理强度下拉是探针给的 low / medium / high / max（第一项跟随 Codex，最后是自定义…）', async () => { assert.deepEqual(await menuLabels(), [p.follow('medium'), 'low', 'medium', 'high', 'max', gx.modelCustom]); });
    await check('UI07 选 test-pro：推理强度的说明是 effortSupported（这个模型支持的强度与默认值）', `document.querySelector('.sheet').textContent.includes(${JSON.stringify(ag.effortSupported('low / medium / high / max', 'medium'))})`);
    await key('Escape'); await wait('!document.querySelector(".optmenu")');
    await pickOption('[data-sel=effort]', 'max');
    await pickOption('[data-sel=model]', 'test-mini');
    await check('UI07 换成 test-mini：说明变成它支持的 low / medium；当前值 max 不在新选项里，原样保留并显示成输入框（不悄悄改掉）', `document.querySelector('.sheet [data-e=effort]')?.value === 'max' && document.querySelector('.sheet').textContent.includes(${JSON.stringify(ag.effortSupported('low / medium', 'low'))})`);
    await pickOption('[data-sel=model]', 'test-pro');
    await check('UI07 换回 test-pro：max 又在选项里，显示成下拉', 'document.querySelector(\'.sheet [data-sel=effort]\')?.textContent.trim() === "max" && !document.querySelector(\'.sheet [data-e=effort]\')');
    // 点"刷新列表"：真实点击，查询中按钮禁用并写"正在查询…"，查完恢复并重新显示结果。
    effects.consoleDelay['agents:models'] = 1500;
    try {
        await press('.sheet [data-probe-refresh]');
        await check('UI07 点"刷新列表"：查询中按钮禁用并显示"正在查询…"', `document.querySelector('.sheet [data-probe-refresh]').disabled && document.querySelector('.sheet [data-probe-refresh]').textContent === ${JSON.stringify(ag.refreshingList)}`);
        await wait('!document.querySelector(".sheet [data-probe-refresh]").disabled', 'UI07 刷新列表查完', 30000);
    } finally { delete effects.consoleDelay['agents:models']; }
    await check('UI07 刷新完成：按钮恢复"刷新列表"，说明仍是"列表来自程序"，已选的模型、推理强度不变', `document.querySelector('.sheet [data-probe-refresh]').textContent === ${JSON.stringify(ag.refreshList)} && ${timeText(ag.probeFrom('program', '00:00')).toString()}.test(document.querySelector('.sheet [data-probe-note]').textContent) && document.querySelector('.sheet [data-sel=model]').textContent.trim() === 'test-pro' && document.querySelector('.sheet [data-sel=effort]').textContent.trim() === 'max'`);
    await pickOption('[data-sel=tier]', 'flex');
    await press('[data-e-seg=sandbox][data-value=read-only]');
    await type('[data-e=label]', ' 2');
    await check('UI07 改了沙箱：只读按钮按下状态为真', `document.querySelector('.sheet [data-e-seg=sandbox][data-value=read-only]').getAttribute('aria-pressed') === 'true'`);
    await verify('UI07 改完还没点保存：config.json 没有被创建（改动只在表单里）', async () => { assert.equal(await exists(config), false, `config.json 不该存在：${await readFile(config, 'utf8').catch(() => '')}`); });
    // Esc：改过字段，先确认放弃；选"取消"回到表单，值还在。
    await key('Escape'); await wait('!!document.querySelector(".confirm-actions")');
    await check('UI07 改过字段后按 Esc：先确认放弃', 'document.querySelector(".confirm-card h2").textContent==="放弃未保存的改动？"');
    await press('.confirm-actions .btn');
    await check('UI07 在确认框里选"取消"：回到表单，填的值还在', 'document.querySelector(".sheet [data-e=label]").value === "Codex 2" && document.querySelector(".sheet [data-sel=model]").textContent.trim() === "test-pro" && document.querySelector(".sheet [data-sel=tier]").textContent.trim() === "flex"');
    await press('.sheet-btns .btn:first-child'); await wait('!document.querySelector(".sheet")');
    await verify('UI07 点"取消"：什么都没写（config.json 仍不存在）', async () => { assert.equal(await exists(config), false); });
    // 再打开，改完点"保存"：一次写入所有改动（显示名走 agents:update，其余走设置通道一次写入）。
    await codexEdit();
    await check('UI07 再次打开：回到没改过的样子（模型是"跟随 Codex"、沙箱是可写工作区、显示名 Codex）', `document.querySelector('.sheet [data-sel=model]').textContent.trim() === ${JSON.stringify(p.follow('gpt-x'))} && document.querySelector('.sheet [data-e=label]').value === "Codex" && document.querySelector('.sheet [data-e-seg=sandbox][data-value=workspace-write]').getAttribute('aria-pressed') === 'true'`);
    await wait('!document.querySelector(".sheet [data-probe-refresh]").disabled && document.querySelector(".sheet [data-probe-note]").textContent !== ""', 'UI07 再次打开：探针查完');
    await pickOption('[data-sel=model]', 'test-pro');
    await pickOption('[data-sel=effort]', 'max');
    await pickOption('[data-sel=tier]', 'flex');
    await press('[data-e-seg=sandbox][data-value=read-only]');
    await type('[data-e=label]', ' 2');
    await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
    await verify('UI07 点"保存"：config.json 的 codex 执行者里模型、推理强度、服务档位、沙箱、显示名都对', async () => {
        const profile = (await readConfig()).profiles.codex;
        assert.deepEqual([profile.model, profile.effort, profile.tier, profile.sandbox, profile.label], ['test-pro', 'max', 'flex', 'read-only', 'Codex 2']);
    });
    await wait('!!document.querySelector("[data-agent=codex]") && document.querySelector("[data-agent=codex] .x1 b")?.textContent === "Codex 2"', 'UI07 保存后列表显示新的显示名');
    // 手写的模型原样保留：选"自定义…"后在输入框里改，保存；再打开仍显示成输入框。
    await codexEdit();
    // 探针（假目录）查完才会出现模型下拉的值：codexEdit 只等到 [data-sel=model]（探针没回来时那是输入框旁的小箭头按钮），先等探针说明出现。
    await wait('!document.querySelector(".sheet [data-probe-refresh]")?.disabled && document.querySelector(".sheet [data-probe-note]")?.textContent !== ""', 'UI07 再次打开：探针查完');
    await check('UI07 再次打开：保存过的值预填（test-pro、max、flex、只读、Codex 2）', `document.querySelector('.sheet [data-sel=model]').textContent.trim() === 'test-pro' && document.querySelector('.sheet [data-sel=effort]').textContent.trim() === 'max' && document.querySelector('.sheet [data-sel=tier]').textContent.trim() === 'flex' && document.querySelector('.sheet [data-e-seg=sandbox][data-value=read-only]').getAttribute('aria-pressed') === 'true' && document.querySelector('.sheet [data-e=label]').value === 'Codex 2'`);
    await pickOption('[data-sel=model]', gx.modelCustom);
    await check('UI07 模型选"自定义…"：变成输入框并取得焦点，里面是原来的模型名', 'document.activeElement === document.querySelector(".sheet [data-e=model]") && document.querySelector(".sheet [data-e=model]").value === "test-pro"');
    await type('[data-e=model]', '-x');
    // 位置：点"指定位置…"选程序（文件对话框用桩），只记在表单里，点"保存"才写；"改回自动查找"取消这次选择。这里不保存位置（保存了会改变后面检查的 Codex 检测）。
    const fakeProgram = path.join(home, 'fake-codex.cjs');
    fileDialogs.stub = true; fileDialogs.open.length = 0; fileDialogs.open.push(fakeProgram);
    try { await press('[data-loc=choose]'); await wait(`document.querySelector(".sheet [data-loc=reset]") !== null`, 'UI07 选了位置'); } finally { fileDialogs.stub = false; }
    await check('UI07 位置：选了程序后表单里显示这个路径与"改回自动查找"；模型输入框里手写的值还在', `document.querySelector('.sheet .statusline .mono.muted').textContent === ${JSON.stringify(fakeProgram)} && document.querySelector('.sheet [data-loc=reset]').textContent === ${JSON.stringify(p.reset)} && document.querySelector('.sheet [data-e=model]').value === 'test-pro-x'`);
    await verify('UI07 位置：选了程序但还没点保存，config.json 里没有 path', async () => { assert.ok(!(await readConfig()).profiles.codex.path); });
    await press('[data-loc=reset]');
    await check('UI07 位置：点"改回自动查找"后显示"自动查找"，没有重置按钮', `document.querySelector('.sheet .statusline .mono.muted').textContent === ${JSON.stringify(p.auto)} && !document.querySelector('.sheet [data-loc=reset]')`);
    await press('[data-e-seg=sandbox][data-value=workspace-write]');
    await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
    await verify('UI07 手写的模型保存进 config.json，其余没改的项不变', async () => {
        const profile = (await readConfig()).profiles.codex;
        assert.deepEqual([profile.model, profile.effort, profile.tier, profile.sandbox], ['test-pro-x', 'max', 'flex', 'workspace-write']);
    });
    await codexEdit();
    await check('UI07 手写的模型再打开仍原样显示成输入框；推理强度 max 不在预设里也原样保留', 'document.querySelector(".sheet [data-e=model]")?.value === "test-pro-x" && document.querySelector(".sheet [data-e=effort]")?.value === "max"');
    await key('Escape'); await wait('!document.querySelector(".sheet")');
    await check('UI07 没有改动时按 Esc 直接关闭，不弹放弃确认', '!document.querySelector(".confirm-actions")');
    // 改回显示名与"跟随"：选"跟随 Codex"保存后对应项写成 null（config.json 里是 null，不是空串）。
    await codexEdit();
    await pickOption('[data-sel=model]', p.follow('gpt-x'));
    await press('.sheet [data-e=label]'); await key('End'); await key('Backspace'); await key('Backspace');
    await pickOption('[data-sel=tier]', p.follow('default'));
    await pickOption('[data-sel=effort]', p.follow('medium'));
    await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
    await verify('UI07 选"跟随 Codex"保存：model、tier、effort 写成 null，显示名改回 Codex', async () => {
        const profile = (await readConfig()).profiles.codex;
        assert.deepEqual([profile.model, profile.effort, profile.tier, profile.label], [null, null, null, 'Codex']);
    });
    // 关闭模态框后放回焦点是异步收尾（关闭动画、列表可能随配置写入重建），标准：1 秒内回到原按钮；超时会打印当前焦点。
    await within('UI07 关闭"编辑执行者"后焦点回到触发它的更多按钮', 'document.activeElement===document.querySelector("[data-more-agent=codex]")', 1000);
    // 166：改过名的 Codex 执行者（codex-pro）的编辑读写自己的配置。隔离配置里再加一个 Codex 执行者 codex-pro（模型、强度、档位、沙箱都与 codex 不同）→
    // 打开它的编辑：预填的是它自己的值 → 改模型、点"保存" → config.json 里 codex-pro 的模型变了，codex 的一个字节都没变。结束后把配置还原成这一段之前的样子。
    const beforePro = await readFile(config, 'utf8'), beforeProConfig = JSON.parse(beforePro);
    await writeFile(config, JSON.stringify({ ...beforeProConfig, profiles: { ...beforeProConfig.profiles, 'codex-pro': { adapter: 'codex', label: 'Codex Pro', enabled: true, model: 'test-mini', effort: 'low', tier: 'flex', sandbox: 'read-only' } } }));
    await agentsPage('codex-pro');
    await press('[data-more-agent=codex-pro]'); await press('.ctx button:nth-child(1)');
    await wait('!!document.querySelector(".sheet [data-e=label]") && !!document.querySelector(".sheet [data-sel=model]")', 'UI07 打开 codex-pro 的编辑');
    await wait('!document.querySelector(".sheet [data-probe-refresh]")?.disabled && document.querySelector(".sheet [data-probe-note]")?.textContent !== ""', 'UI07 codex-pro 编辑：探针查完');
    await check('UI07 codex-pro 的编辑：模型、推理强度、服务档位、沙箱、显示名预填的是它自己的值（test-mini / low / flex / 只读 / Codex Pro），不是 codex 的', `document.querySelector('.sheet [data-sel=model]').textContent.trim() === 'test-mini' && document.querySelector('.sheet [data-sel=effort]').textContent.trim() === 'low' && document.querySelector('.sheet [data-sel=tier]').textContent.trim() === 'flex' && document.querySelector('.sheet [data-e-seg=sandbox][data-value=read-only]').getAttribute('aria-pressed') === 'true' && document.querySelector('.sheet [data-e=label]').value === 'Codex Pro'`);
    await pickOption('[data-sel=model]', 'test-pro');
    await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")', 'UI07 codex-pro 保存后关闭');
    await verify('UI07 codex-pro 点"保存"：config.json 里 codex-pro 的模型变成 test-pro（其余项不变），codex 执行者与别的执行者都没变', async () => {
        const after = await readConfig(), pro = after.profiles['codex-pro'];
        assert.deepEqual([pro.model, pro.effort, pro.tier, pro.sandbox, pro.label], ['test-pro', 'low', 'flex', 'read-only', 'Codex Pro']);
        for (const name of Object.keys(beforeProConfig.profiles)) assert.deepEqual(after.profiles[name], beforeProConfig.profiles[name], `${name} 不该被改`);
    });
    await writeFile(config, beforePro);
    // 166：设置页并行一节的"机器正忙"按原因写——注入可用内存不够（经 tools/shots.mjs 给的 AR_TEST_LOAD_FILE，另认可选的 memLow 与 freeMemGb）时写内存那一句，不写 CPU。
    const loadFile = appEnv.AR_TEST_LOAD_FILE!;
    await writeFile(config, JSON.stringify({ ...beforeProConfig, concurrency: 'auto' }));
    // 173：先把负载固定成“不忙”，估算行才不取决于这台电脑当时的可用内存；下面改写成“内存不够”，finally 里移走。
    await writeFile(loadFile, JSON.stringify({ busy: false }));
    await settings();
    await wait('!!document.querySelector("[data-parallel-now]")', 'UI07 自动档出现估算行');
    await writeFile(loadFile, JSON.stringify({ busy: true, cpu: 17, memLow: true, freeMemGb: 0.9 }));
    try {
        await wait(`document.querySelector('[data-parallel-now]').textContent === ${JSON.stringify(s6.concurrencyAutoBusyMem('0.9'))}`, 'UI07 内存不够：估算行换成 concurrencyAutoBusyMem（定时刷新）', 20000);
        await check('UI07 机器正忙因为可用内存不够：写内存那一句（concurrencyAutoBusyMem），不是 CPU 那一句', `document.querySelector('[data-parallel-now]').classList.contains('tag') && document.querySelector('[data-parallel-now]').classList.contains('info') && document.querySelector('[data-parallel-now]').textContent === ${JSON.stringify(s6.concurrencyAutoBusyMem('0.9'))} && !document.querySelector('[data-parallel-now]').textContent.includes('CPU')`);
    } finally { await rm(loadFile, { force: true }); await writeFile(config, beforePro); }
    await settings();
    await press('[data-segment=watchWindow][data-value=never]');
    await verify('UI07 进度窗口分段写入 config.json', async () => { assert.equal((await readConfig()).watchWindow, 'never'); });
    await press('[data-segment=watchWindow][data-value=auto]');
    await captureProxy(h, { config });
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
    delete withoutCodex.profiles.codex; withoutCodex.profiles.example = { adapter: 'claude-code', label: '示例执行者', enabled: true, path: path.join(home, 'fake-claude.cjs') }; withoutCodex.defaultProfile = 'example';
    await writeFile(config, JSON.stringify(withoutCodex));
    await agentsPage('example');
    await check('UI07 没有 codex 执行者时执行者区没有 Codex 行', '!document.querySelector("[data-agent=codex]") && !!document.querySelector("[data-agent=example]")');
    await save('connect-no-codex-dark');
    await writeFile(config, configured);
    // 打开表单之后文件被外部破坏：点"保存"必须失败，留在框里显示原因（编辑执行者里）。
    // 改写（144，T3）：原断言"写入失败恢复原值（下拉退回改之前的服务档位 default）" → 新断言"写入失败保持用户填的值（服务档位仍是刚选的 flex）、不关弹窗、显示原因"；
    // 原因：表单式下改动是用户一次填好再点保存的，失败时把填好的值清掉用户得重填；不关弹窗才能改了再试。
    await codexEdit();
    await writeFile(config, 'invalid');
    await pickOption('[data-sel=tier]', 'flex');
    // 074：先等这次点击触发的 preferences:save 返回（上限 5000 ms），再断言界面；原来不等，写入偶尔还没返回时检查就先跑了（072）。
    const saveFrom = ipcSeq();
    await press('.sheet-btns .btn:last-child');
    const saveMs = await waitIpcReturn('UI07 写入失败这次 preferences:save', 'preferences', 'save', saveFrom, 5000);
    console.log(`用时 UI07 写入失败这次 preferences:save：${saveMs} ms（上限 5000 ms）`);
    await wait('!!document.querySelector(".sheet .banner.fail") && !document.querySelector(".sheet-btns .btn:last-child").disabled', 'UI07 写入失败后弹窗显示原因、按钮恢复');
    await check('UI07 写入失败保持用户填的值并显示原因、不关弹窗（编辑执行者）', 'document.querySelector(".sheet [data-sel=tier]").textContent.trim()==="flex" && !!document.querySelector(".sheet .banner.fail") && document.querySelector(".sheet .banner.fail").textContent.trim().length > 0');
    await verify('UI07 写入失败不篡改文件', async () => { assert.equal(await readFile(config, 'utf8'), 'invalid'); });
    await closeSheet();
    await settings(); await save('settings-invalid-top-dark');
    await h.wheel('.doc.scroll', 10000);
    await save('settings-invalid-dark');
    await check('UI07 无效配置禁用进度窗口控件并说明原因', '[...document.querySelectorAll("[data-segment=watchWindow]")].every(b=>b.disabled) && document.querySelector(".doc-in").textContent.includes("修好或删掉")');
    await codexEdit();
    // 改写（144，T3）：原断言 `.sheet [data-setting], .sheet [data-segment=sandbox]` 全部禁用 → 新断言表单里的下拉、输入框、沙箱分段、位置按钮全部禁用（至少各有一个，不是空集），"保存"也禁用；原因：控件换成了表单式的。
    await check('UI07 无效配置时"编辑执行者 · Codex"的表单控件禁用并说明原因，"保存"不可点', '(() => { const ctl = [...document.querySelectorAll(".sheet [data-sel], .sheet [data-e-seg=sandbox], .sheet [data-loc], .sheet .inp")]; return ctl.length >= 6 && ctl.every(b=>b.disabled) && document.querySelector(".sheet").textContent.includes("修好或删掉") && document.querySelector(".sheet-btns .btn:last-child").disabled && !document.querySelector(".sheet [data-probe-refresh]"); })()');
    await closeSheet();
    await restoreModels();
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
    // 137：空着"不限"再走一遍第 3 步（UI08 重新运行首次引导 → 第 2 步 → 第 3 步导入 DeepSeek 并测试）。
    // 空着点"下一步"不写 limits，已有的上限也不被清掉。此处 config.json 可能还不存在（UI07 之前重置过），所以读不到按"没有执行者"算；
    // 导入成功后用 route:limit 给这个执行者预先设上限 5（与填 2 那条路径互不相干），空着进第 4 步后它必须还是 5。
    {
        const readAll = async () => (await readFile(config, 'utf8').then(JSON.parse, () => ({ profiles: {} }))).profiles ?? {};
        const existed = await exists(config);
        const profilesBefore = Object.keys(await readAll());
        await wait('!document.querySelector("[data-pref=next]").disabled', '第 1 步检测完成', 30000);
        await press('[data-pref=next]');
        await wait('!!document.querySelector("[data-choice]")', '第 2 步');
        await press('[data-pref=next]');
        await wait('!!document.querySelector(".presets .preset.on")', '第 3 步预设加载完成', 30000);
        await press('[data-pref=wizard-agent]');
        await wait('!!document.querySelector("[data-wizard-result=ok]")', '导入并测试成功', 90000);
        await check('UI08 重新走到第 3 步：每日上限输入框默认空（不沿用上一次填的 2）', 'document.querySelector("[data-wizard-limit]")?.value === ""');
        const added = Object.keys(await readAll()).filter(name => !profilesBefore.includes(name))[0];
        assert.ok(added, '导入后配置里有新执行者');
        await evaluate(`window.dock.console('route:limit', { name: ${JSON.stringify(added)}, tasks: 5 })`);
        await press('[data-pref=next]');
        await wait('!!document.querySelector("[data-wizard-folder]")', '空着点下一步进第 4 步');
        await verify('UI08 空着点"下一步"不写 limits：预先设的上限 5 没被清掉，也没有多出别的执行者的上限', async () => {
            const after = await readAll();
            assert.equal(after[added].limits.maxTasksPerDay, 5);
            for (const [name, profile] of Object.entries(after) as [string, any][]) if (name !== added) assert.equal(profile.limits, undefined);
        });
        await evaluate(`window.dock.console('agents:remove', { name: ${JSON.stringify(added)} })`);
        if (!existed) await rm(config, { force: true });
    }
    await press('[data-pref=skip]');
    await wait('!document.querySelector(".wiz")');
    await check('UI08 跳过引导回到软件，侧栏恢复可用', '[...document.querySelectorAll("[data-page]")].every(b=>!b.disabled)');
    // Stage07c 151（T5）：第三次走到第 3 步，点"可以按你的执行者生成建议规则"：引导结束，跳到路由页并打开建议弹窗（内容与核心的建议一致）。
    {
        const readAll = async () => (await readFile(config, 'utf8').then(JSON.parse, () => ({ profiles: {} }))).profiles ?? {};
        const existed = await exists(config);
        const profilesBefore = Object.keys(await readAll());
        await press('[data-pref=wizard]');
        await wait('!!document.querySelector(".wiz")', 'UI08 再次打开引导');
        await wait('!document.querySelector("[data-pref=next]").disabled', '第 1 步检测完成', 30000);
        await press('[data-pref=next]');
        await wait('!!document.querySelector("[data-choice]")', '第 2 步');
        await press('[data-pref=next]');
        await wait('!!document.querySelector(".presets .preset.on")', '第 3 步预设加载完成', 30000);
        await press('[data-pref=wizard-agent]');
        await wait('!!document.querySelector("[data-wizard-result=ok]")', '导入并测试成功', 90000);
        await press('[data-pref=wizard-suggest]');
        await wait('!document.querySelector(".wiz") && document.querySelector("[data-page=routing]")?.getAttribute("aria-current") === "page" && !!document.querySelector(".sheet [data-ro-sug]")', 'UI08 点建议提示后：引导结束、到路由页、建议弹窗打开', 30000);
        await check('UI08 点"可以按你的执行者生成建议规则"：引导结束（侧栏可用）、停在路由页、弹出标题为 ro.suggestTitle 的建议弹窗', `[...document.querySelectorAll("[data-page]")].every(b=>!b.disabled) && document.querySelector("[data-page=routing]").getAttribute("aria-current") === "page" && document.querySelector(".sheet").getAttribute("aria-label") === ${JSON.stringify(ro.suggestTitle)}`);
        await verify('UI08 建议弹窗里的条数等于核心 ar route suggest 的结果（至少有刚导入的 DeepSeek 一条），默认全选', async () => {
            const suggested = await evaluate(`window.dock.console('route:suggest')`);
            const shown = await evaluate(`[...document.querySelectorAll('.sheet [data-ro-sug]')].map(b => b.getAttribute('aria-checked')).join()`);
            assert.ok(suggested.rules.length >= 1, JSON.stringify(suggested));
            assert.equal(shown, suggested.rules.map(() => 'true').join());
        });
        await press('.sheet [data-sheet-btn="0"]');
        await wait('!document.querySelector(".sheet")', 'UI08 取消关闭建议弹窗');
        const added = Object.keys(await readAll()).filter(name => !profilesBefore.includes(name))[0];
        assert.ok(added, '导入后配置里有新执行者');
        await evaluate(`window.dock.console('agents:remove', { name: ${JSON.stringify(added)} })`);
        if (!existed) await rm(config, { force: true });
        await press('[data-page=about]');
    }
    const fontExists = await stat(path.join(__dirname, 'fonts/MiSansVF.ttf')).then(() => true, () => false);
    if (fontExists) await check('UI08 已加载随包 MiSans', 'document.fonts.check(\'13px "AgentRouter MiSans"\') && [...document.fonts].some(f=>f.family.includes("AgentRouter MiSans") && f.status==="loaded")');
    if (await exists(path.join(__dirname, 'fonts/SpaceGrotesk.ttf'))) await check('UI08 字标已加载随包 Space Grotesk', 'document.fonts.check(\'700 13px "AgentRouter Space Grotesk"\') && [...document.fonts].some(f=>f.family.includes("AgentRouter Space Grotesk") && f.status==="loaded")');
    return fontExists;
}

// 网络代理一节（099，UI07 扩展）：真实键盘 / 鼠标输入，读 config.json 断言功能真的生效。
// 不检查"跟随系统代理"：切到它会读真实的 Windows 注册表，验收不碰（读注册表的各种情形由单元测试用注入的 reg 输出覆盖）。
// 开始前设置页已经打开，config.json 存在；结束后删掉这一节写进去的 proxy 字段，不影响后面的检查。
async function captureProxy(h: Harness, { config }: { config: string }) {
    const { evaluate, wait, check, verify, press, key, type, tabTo, save } = h;
    const readConfig = async () => JSON.parse(await readFile(config, 'utf8'));
    const field = '[data-pref=proxy-url]', manual = '[data-segment=proxy][data-value=manual]', offMode = '[data-segment=proxy][data-value=off]';
    const center = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
    const description = `document.querySelector('[data-segment=proxy]').closest('.set-r').querySelector('.l span').textContent`;
    const sections = `[...document.querySelectorAll('.sect h2')].map(h => h.textContent)`;
    const jsonStr = JSON.stringify;
    await center(manual);
    await check('UI07 网络代理一节在“并行”和“评分”之间；默认选中“不使用”，说明行是 px.offHelp，没有地址行',
        `(() => { const t = ${sections}, at = t.indexOf(${jsonStr(px.sec)}); return at > 0 && t[at - 1] === ${jsonStr(s6.parallelSec)} && t[at + 1] === ${jsonStr(sc.settingsSec)}; })() && document.querySelector('[data-segment=proxy].on')?.dataset.value === 'off' && ${description} === ${jsonStr(px.offHelp)} && !document.querySelector(${jsonStr(field)})`);
    await check('UI07 网络代理：三个选项文案来自 px.modes', `[...document.querySelectorAll('[data-segment=proxy]')].map(b => b.textContent).join() === ${jsonStr(['off', 'system', 'manual'].map(m => px.modes[m]).join())}`);
    // 1. 键盘切到“手动填写”：只显示地址行，不写配置。
    await tabTo(manual); await key('Enter');
    await wait(`!!document.querySelector(${jsonStr(field)})`, '手动填写后出现地址行');
    await check('UI07 切到“手动填写”：选中它，说明行是 px.manualHelp，出现地址输入框与保存按钮', `document.querySelector('[data-segment=proxy].on')?.dataset.value === 'manual' && ${description} === ${jsonStr(px.manualHelp)} && document.querySelector(${jsonStr(field)}).placeholder === ${jsonStr(px.urlPlaceholder)} && document.querySelector('[data-pref=proxy-save]').textContent === ${jsonStr(px.save)}`);
    await verify('UI07 只是切到“手动填写”不写 config.json', async () => { assert.equal((await readConfig()).proxy, undefined); });
    // 2. 带用户名密码的地址：拒绝保存，说明行显示 px.errCredentials，config.json 没有 proxy 字段。
    await center(field);
    await type(field, 'http://user:pass@127.0.0.1:7890');
    await press('[data-pref=proxy-save]');
    await wait(`document.querySelector('[data-proxy-error]')?.textContent === ${jsonStr(px.errCredentials)}`, '带凭据的地址显示 px.errCredentials');
    await check('UI07 带用户名密码的地址：地址行显示 px.errCredentials，输入框里仍是填写的内容', `document.querySelector('[data-proxy-error]').textContent === ${jsonStr(px.errCredentials)} && document.querySelector(${jsonStr(field)}).value === 'http://user:pass@127.0.0.1:7890'`);
    await verify('UI07 带用户名密码的地址没有写进 config.json（没有 proxy 字段，凭据不出现在文件里）', async () => {
        const text = await readFile(config, 'utf8');
        assert.equal(JSON.parse(text).proxy, undefined);
        assert.ok(!text.includes('user:pass'));
    });
    // 3. 格式不对 / 为空：对应的说明，同样不写。
    // 点击输入框会把光标放在点击处：先按 End 把光标移到末尾，再逐个退格清空。
    const clear = async () => { const length = Number(await evaluate(`document.querySelector(${jsonStr(field)}).value.length`)); await press(field); await key('End'); for (let i = 0; i < length; i++) await key('Backspace'); };
    await clear();
    await check('UI07 清空输入框', `document.querySelector(${jsonStr(field)}).value === ''`);
    await press('[data-pref=proxy-save]');
    await wait(`document.querySelector('[data-proxy-error]')?.textContent === ${jsonStr(px.errEmpty)}`, '空地址显示 px.errEmpty');
    await type(field, 'http://127.0.0.1');
    await press('[data-pref=proxy-save]');
    await wait(`document.querySelector('[data-proxy-error]')?.textContent === ${jsonStr(px.errFormat)}`, '缺端口显示 px.errFormat');
    await verify('UI07 地址为空 / 格式不对都没有写进 config.json', async () => { assert.equal((await readConfig()).proxy, undefined); });
    // 4. 合法地址（回车保存）：config.json 的 proxy 变成 { mode: 'manual', url }，说明行恢复，按钮短暂显示 px.saved。
    await clear();
    await type(field, 'http://127.0.0.1:7890');
    await key('Enter');
    await wait(`document.querySelector('[data-pref=proxy-save]')?.textContent === ${jsonStr(px.saved)}`, '保存成功后按钮显示 px.saved');
    await verify('UI07 合法地址保存后 config.json 的 proxy 是 { mode: manual, url }，其余字段保留', async () => {
        const saved = await readConfig();
        assert.deepEqual(saved.proxy, { mode: 'manual', url: 'http://127.0.0.1:7890' });
        assert.ok(saved.profiles?.codex, '其余字段原样保留');
    });
    await check('UI07 保存成功：说明行恢复为 px.manualHelp，错误提示消失，输入框是保存的地址', `${description} === ${jsonStr(px.manualHelp)} && !document.querySelector('[data-proxy-error]') && document.querySelector(${jsonStr(field)}).value === 'http://127.0.0.1:7890' && document.querySelector('[data-segment=proxy].on')?.dataset.value === 'manual'`);
    // 先等“已保存”恢复成 px.save 再截图：恢复时设置页会重新渲染，发生在截图中间会让路径遮盖与截图错开。
    await wait(`document.querySelector('[data-pref=proxy-save]')?.textContent === ${jsonStr(px.save)}`, '“已保存”短暂显示后恢复为 px.save');
    await center(manual);
    await save('settings-proxy-manual-dark');
    nativeTheme.themeSource = 'light'; await save('settings-proxy-manual-light'); nativeTheme.themeSource = 'dark';
    // 5. 切到“不使用”：config.json 的 proxy.mode 变成 off，地址行消失。
    await press(offMode);
    await wait(`!document.querySelector(${jsonStr(field)})`, '切到不使用后地址行消失');
    await verify('UI07 切到“不使用”后 config.json 的 proxy.mode 是 off', async () => { assert.equal((await readConfig()).proxy.mode, 'off'); });
    await check('UI07 切到“不使用”：选中它，说明行是 px.offHelp', `document.querySelector('[data-segment=proxy].on')?.dataset.value === 'off' && ${description} === ${jsonStr(px.offHelp)}`);
    await save('settings-proxy-off-dark');
    nativeTheme.themeSource = 'light'; await save('settings-proxy-off-light'); nativeTheme.themeSource = 'dark';
    // 恢复：config.json 回到没有 proxy 字段。
    const restored = await readConfig(); delete restored.proxy;
    await writeFile(config, JSON.stringify(restored));
    await press('[data-page=tasks]'); await press('[data-page=settings]'); await wait('!!document.querySelector("[data-pref=notifications]")');
    await check('UI07 恢复后设置页回到默认“不使用”', `document.querySelector('[data-segment=proxy].on')?.dataset.value === 'off'`);
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
        // 037 第 4 项：claude-code 执行者指向假 Claude Code（path 优先于 AR_TEST_AGENT），版本不串成 codex-cli。
        example: { adapter: 'claude-code', label: 'Example Agent', enabled: true, path: path.join(home, 'fake-claude.cjs'), env: { ANTHROPIC_BASE_URL: 'https://example.invalid/api', ANTHROPIC_MODEL: 'example-model' }, auth: 'token', secrets: { ANTHROPIC_AUTH_TOKEN: 'EXAMPLE_TEST_KEY' }, maxTurns: null },
        ok: { adapter: 'fake', label: 'Fake Ok', enabled: true, events: [{ kind: 'say', text: 'OK' }], report: 'OK\n' },
        bad: { adapter: 'fake', label: 'Fake Bad', enabled: true, events: [{ kind: 'error', text: '接口返回 401' }], report: '没有完成\n', exit: 3 },
        slow: { adapter: 'fake', label: 'Fake Slow', enabled: true, events: [{ kind: 'say', text: '慢' }, { kind: 'say', text: '还在' }], report: 'OK\n', delayMs: 60000 },
    } }));
    await writeFile(secretsFile, JSON.stringify({ EXAMPLE_TEST_KEY: 'sk-shots-example-0000' }));
    try {
        await press('[data-page=tasks]'); await press('[data-page=connect]'); await wait('!!document.querySelector("[data-agent=bad]")');
        await check('UI06 执行者区每行：标签、默认、认证状态（隔离密钥文件）', 'document.querySelector("[data-agent=ok] .x1").textContent.includes("默认") && document.querySelector("[data-agent=example] .xtag").textContent==="EX" && document.querySelector("[data-agent=example] .x2").textContent.includes("已设置") && !document.querySelector("[data-agent=codex] .x1").textContent.includes("只在指定时使用")');
        // 180（D111）：执行者区说明改成按路由分配，Codex 行不再有"只在指定时使用"标签。
        await check('UI06 执行者区说明文字是按路由分配的新文案', '[...document.querySelectorAll(".sect h2")].some(h => h.textContent === "执行者" && h.nextElementSibling.textContent === "实际执行任务的 Agent。任务按路由页的规则分配给它们；没有规则命中时派给\\"默认\\"那一个。")');
        // 037 第 4 项：claude-code 执行者（example）行版本是 Claude Code 风格、不含 codex-cli；codex 行含 codex-cli。
        await check('UI06 claude-code 执行者（example）行的版本不含 codex-cli，codex 行含', 'document.querySelector("[data-agent=example]").textContent.includes("2.1.302 (Claude Code)") && !document.querySelector("[data-agent=example]").textContent.includes("codex-cli") && document.querySelector("[data-agent=codex]").textContent.includes("codex-cli")');
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
        await press('[data-more-agent=bad]'); await press('.ctx button:nth-child(5)');
        await check('UI06 删除确认默认焦点在取消且使用危险按钮', 'document.activeElement.textContent==="取消" && !!document.querySelector(".confirm-actions .danger")');
        await press('.confirm-actions .btn');
        await verify('UI06 取消删除不改 config.json', async () => { assert.ok((await readConfig()).profiles.bad); });
        await press('[data-more-agent=bad]'); await press('.ctx button:nth-child(5)'); await press('.confirm-actions .danger'); await wait('!document.querySelector("[data-agent=bad]")');
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
        // 走查第 3 轮：MiMo 两种套餐；112 改写：同一服务只放一张卡片（Claude Code、Xiaomi MiMo、Qoder 各一张），第 2 步用分段按钮选套餐。推荐标记仍只在 DeepSeek 上。
        // 改写（112）：原断言"12 张卡片，mimo / mimo-payg / claude-native / claude-subscription / qoder-cn / qoder 各一张，MiMo 两张的标题说明各自来自预设"
        //   → 新断言"9 张卡片，data-preset 是组里默认预设，合并卡片带 data-card，标题与说明逐字等于 presets --json 的 card"；原因：卡片按服务合并。
        await press('.page-h [data-import-agent]'); await wait('!!document.querySelector(".sheet .preset.on")');
        const presetList: any[] = await evaluate(`window.dock.console('agents:presets').then(r => r.presets)`);
        const cardOf = (name: string) => presetList.find(x => x.name === name).card;
        await check('UI13 第 1 步显示 10 张卡片（8 张预设加自定义 CLI、从文件导入），MiMo、Claude Code、Qoder 各合并成一张，标题与说明来自 presets --json 的 card，推荐标记只在 DeepSeek 上', `(() => {
            const cards = [...document.querySelectorAll(".sheet .preset")];
            const names = cards.map(c => c.dataset.preset);
            const card = name => cards.find(c => c.dataset.preset === name);
            const brand = [...document.querySelectorAll(".sheet .preset .tag.brand")];
            const merged = (name, id, c) => card(name).dataset.card === id && card(name).querySelector("b").textContent === c.title && card(name).querySelector(".pk > span").textContent === c.description;
            return names.length === 10 && names.join() === "deepseek,mimo,claude-native,compat,codex,qoder-cn,deepseek-harness,openai-compat,@custom,@file"
                && cards.filter(c => c.dataset.card).map(c => c.dataset.card).join() === "mimo,claude-code,qoder"
                && merged("mimo", "mimo", ${JSON.stringify(cardOf('mimo'))}) && merged("claude-native", "claude-code", ${JSON.stringify(cardOf('claude-native'))}) && merged("qoder-cn", "qoder", ${JSON.stringify(cardOf('qoder-cn'))})
                && !card("mimo-payg") && !card("claude-subscription") && !card("qoder")
                && brand.length === 1 && brand[0].closest(".preset").dataset.preset === "deepseek";
        })()`);
        await save('connect-import-1-merged-dark');
        await press('[data-preset=mimo]');
        await wait('document.querySelector(".sheet .preset.on")?.dataset.preset==="mimo"');
        await press('[data-w-act=next]');
        await wait('!!document.querySelector(".sheet [data-w=secretVar]")');
        const mimoVariant = (name: string) => presetList.find(x => x.name === name);
        await check('UI13 选 MiMo 进入第 2 步：第一行是"套餐"分段按钮（Token Plan 选中），说明是该预设的 variant.help；密钥变量名为 MIMO_API_KEY，隔离密钥文件里未设置', `(() => {
            const first = document.querySelector(".sheet .form > .fld"), buttons = [...first.querySelectorAll(".segm button")];
            return first.querySelector(".fl b").textContent === ${JSON.stringify(mimoVariant('mimo').variant.label)} && buttons.map(b => b.textContent).join() === ${JSON.stringify(mimoVariant('mimo').variant.option + ',' + mimoVariant('mimo-payg').variant.option)}
                && buttons[0].classList.contains("on") && buttons[0].getAttribute("aria-pressed") === "true" && buttons[1].getAttribute("aria-pressed") === "false" && !buttons[1].classList.contains("on")
                && first.querySelector(".fl span").textContent === ${JSON.stringify(mimoVariant('mimo').variant.help)}
                && document.querySelector("[data-w=secretVar]").value==="MIMO_API_KEY" && document.querySelector("[data-w-status]").textContent==="未设置" && document.querySelector("[data-w=baseUrl]").value === ${JSON.stringify(mimoVariant('mimo').env.ANTHROPIC_BASE_URL)};
        })()`);
        await save('connect-import-2-mimo-dark');
        // 键盘：Tab 到"按量付费"，空格切换；整张表单按那个预设重填，焦点留在这个按钮上。
        await tabTo('[data-w-variant=mimo-payg]'); await key('Space');
        await wait(`document.querySelector("[data-w=baseUrl]")?.value === ${JSON.stringify(mimoVariant('mimo-payg').env.ANTHROPIC_BASE_URL)}`);
        await check('UI13 空格切到"按量付费"：接口地址换成该预设的、名称换成 mimo-payg 系、说明换成该预设的 variant.help、按钮状态互换，焦点留在刚按的按钮上', `(() => {
            const buttons = [...document.querySelectorAll(".sheet .segm button")], first = document.querySelector(".sheet .form > .fld");
            return buttons[1].classList.contains("on") && buttons[1].getAttribute("aria-pressed") === "true" && !buttons[0].classList.contains("on") && buttons[0].getAttribute("aria-pressed") === "false"
                && document.activeElement === buttons[1] && first.querySelector(".fl span").textContent === ${JSON.stringify(mimoVariant('mimo-payg').variant.help)}
                && document.querySelector("[data-w=name]").value.startsWith("mimo-payg") && document.querySelector("[data-w=secretVar]").value === "MIMO_API_KEY" && document.querySelector("[data-w-status]").textContent === "未设置";
        })()`);
        await save('connect-import-2-mimo-payg-dark');
        await press('[data-w-variant=mimo]');
        await wait(`document.querySelector("[data-w=baseUrl]")?.value === ${JSON.stringify(mimoVariant('mimo').env.ANTHROPIC_BASE_URL)}`);
        await check('UI13 点回"Token Plan"：接口地址、名称回到默认预设的', 'document.querySelector("[data-w=name]").value.startsWith("mimo") && !document.querySelector("[data-w=name]").value.startsWith("mimo-payg") && document.querySelector(".sheet .segm button.on").textContent === "Token Plan"');
        await key('Escape'); await wait('!!document.querySelector(".confirm-actions .danger")'); await press('.confirm-actions .danger'); await wait('!document.querySelector(".sheet")');
        // 063：config.json 无效时 Agent 页显示核心的原因（不再回退到内置默认），也不显示"还没有导入执行者"的空状态；
        // 对照：真的没有执行者（可读的空配置）时照旧显示空状态。
        await writeFile(config, JSON.stringify({ v: 2, defaultProfile: null, managed: false, watchWindow: 'never', profiles: {} }));
        await press('[data-page=tasks]'); await press('[data-page=connect]');
        await wait('!!document.querySelector("[data-agents] .empty.short")', '对照：没有执行者时的空状态');
        await check('UI06 对照：真的没有执行者时显示"还没有导入执行者"空状态', '!!document.querySelector("[data-agents] .empty.short") && document.querySelector("[data-agents] .empty.short").textContent.includes("还没有导入执行者") && !document.querySelector("[data-agents] .banner.fail")');
        await writeFile(config, 'invalid');
        await press('[data-page=tasks]'); await press('[data-page=connect]');
        await wait('!!document.querySelector("[data-agents] .banner.fail")', 'Agent 页显示配置无效的原因');
        await check('UI06 配置无效时 Agent 页显示核心的原因，不显示"还没有导入执行者"空状态', `(() => {
            const banner = document.querySelector('[data-agents] .banner.fail');
            return !!banner && banner.textContent.includes('config.json 无法读取') && banner.textContent.includes('不是有效的 JSON')
                && banner.textContent.includes('请修好这个文件') && !document.querySelector('[data-agents] .empty.short')
                && !document.body.textContent.includes('还没有导入执行者');
        })()`);
        await verify('UI06 配置无效时软件不改写坏文件', async () => { assert.equal(await readFile(config, 'utf8'), 'invalid'); });
        void evaluate;
    } finally {
        await rm(config, { force: true });
        if (secretsBefore === null) await rm(secretsFile, { force: true }); else await writeFile(secretsFile, secretsBefore);
    }
    // 后面的主题检查从设置页开始。
    await settings();
}
