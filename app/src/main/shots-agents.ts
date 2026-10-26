import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { nativeTheme, type BrowserWindow } from 'electron';
import { ag, gx } from '../shared/copy';
import type { Harness } from './shots-input';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';
import { fileDialogs } from './console.mjs';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, env: appEnv });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return String(r.stdout).trim();
};

// UI28 导入向导扩展与模型、推理强度（Stage07 T8 之二）：自定义 CLI 表单与"测试并预览"、校验、Claude 类的推理强度与"升级到"、
// OpenAI 兼容接口、Qoder 默认模型与推理强度、导出与"从文件导入"、截图。全部用真实输入（press / key / type），读 config.json 断言功能真的生效。
// 假执行者：tests/fixtures/generic/ok-cli.mjs（用自带的 Node 运行）、验收环境的假 Claude Code / 假 Codex（AR_TEST_AGENT）；文件对话框用 fileDialogs 桩；不访问任何真实接口。
export async function captureAgents(h: Harness, win: BrowserWindow) {
    const { evaluate, wait, check, verify, press, key, type, tabTo, save, pause } = h;
    const home = appEnv.AGENT_ROUTER_HOME!, secretsFile = appEnv.AR_TEST_SECRETS_FILE!;
    const temp = path.resolve(os.tmpdir()).toLowerCase();
    assert.ok(home && path.isAbsolute(home) && path.resolve(home).toLowerCase().startsWith(temp), '截图验收必须在隔离公共目录里运行');
    assert.ok(!path.relative(home, secretsFile).startsWith('..'), '密钥文件必须在隔离目录里');
    const config = path.join(home, 'config.json');
    const configBefore = await readFile(config, 'utf8').catch(() => null), secretsBefore = await readFile(secretsFile, 'utf8').catch(() => null);
    const original = { size: win.getContentSize(), theme: nativeTheme.themeSource };
    const readConfig = async () => JSON.parse(await readFile(config, 'utf8'));
    const work = path.join(home, 'shots-agents');
    await mkdir(work, { recursive: true });
    const okCli = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'generic', 'ok-cli.mjs');
    assert.ok(existsSync(okCli), `找不到假命令行执行者 ${okCli}`);
    const exported = path.join(work, 'exported.json');
    const jsonStr = JSON.stringify;
    // 当前打开的"更多"菜单 / 下拉菜单里，按文字找到的那一项。
    const ctxItem = async (label: string) => {
        const index = await evaluate(`(() => { const items = [...document.querySelectorAll('.ctx button')]; items.forEach((b, i) => b.setAttribute('data-menu-index', String(i))); return items.findIndex(b => b.textContent.trim() === ${jsonStr(label)}); })()`);
        assert.ok(index >= 0, `菜单里没有「${label}」`);
        return `.ctx button[data-menu-index="${index}"]`;
    };
    const option = async (label: string) => {
        const index = await evaluate(`(() => { const items = [...document.querySelectorAll('.optmenu button')]; items.forEach((b, i) => b.setAttribute('data-pick', String(i))); return items.findIndex(b => [...b.querySelectorAll('span')].find(s => !s.classList.contains('ri-sp'))?.textContent.trim() === ${jsonStr(label)}); })()`);
        assert.ok(index >= 0, `下拉里没有「${label}」`);
        return `.optmenu button[data-pick="${index}"]`;
    };
    // 菜单必须真的看得见：不透明、没有缩放、在窗口里、菜单中心点命中的是菜单自己（走查发现过菜单透明、命中测试照样通过的事）。
    const menuVisible = `(() => { const m = document.querySelector('.optmenu'); if (!m) return false; const s = getComputedStyle(m), r = m.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return s.opacity === '1' && (s.transform === 'none' || s.transform === 'matrix(1, 0, 0, 1, 0, 0)') && s.visibility === 'visible' && r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && !!hit && m.contains(hit); })()`;
    const assertMenuVisible = async (what: string) => assert.equal(await evaluate(menuVisible), true, `${what}：下拉菜单打开后看不见（透明、缩放或超出窗口）`);
    const pick = async (selector: string, label: string) => { await press(selector); await wait('!!document.querySelector(".optmenu")'); await assertMenuVisible(selector); await press(await option(label)); await wait('!document.querySelector(".optmenu")'); };
    const text = (selector: string) => evaluate(`document.querySelector(${jsonStr(selector)})?.textContent ?? null`);
    const agentsPage = async () => { await press('[data-page=tasks]'); await press('[data-page=connect]'); await wait('!!document.querySelector("[data-agents]") && !!document.querySelector(".page-h [data-import-agent]")'); };
    const openWizard = async () => { await press('.page-h [data-import-agent]'); await wait('!!document.querySelector(".sheet .preset.on")'); };
    const closeSheet = async () => { await key('Escape'); await wait('!document.querySelector(".sheet")'); };
    // 深浅色 × 默认 / 最小窗口各截一张（窗口大小和主题用完恢复）。
    const shots = async (name: string) => {
        for (const [w, ht, tag] of [[1160, 720, 'default'], [960, 600, 'min']] as const) for (const theme of ['dark', 'light'] as const) {
            win.setContentSize(w, ht); nativeTheme.themeSource = theme; await pause(350);
            await check(`UI28 ${name}（${theme}，${w}×${ht}）模态框完整显示在窗口里`, `(() => { const r = document.querySelector('.sheet').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.scrollingElement.scrollWidth <= innerWidth && document.querySelector('.sheet-b').scrollWidth <= document.querySelector('.sheet-b').clientWidth + 1; })()`);
            await save(`agents-${name}-${theme}-${tag}`);
        }
        win.setContentSize(original.size[0], original.size[1]); nativeTheme.themeSource = 'dark'; await pause(350);
    };



    // 专用配置：默认执行者 ok；sonnet 是 Claude 类（指向验收环境的假 Claude Code）；其他靠向导导入。
    await writeFile(config, jsonStr({ v: 2, defaultProfile: 'ok', managed: false, watchWindow: 'never', profiles: {
        ok: { adapter: 'fake', label: 'Fake Ok', enabled: true, events: [{ kind: 'say', text: 'OK' }], report: 'OK\n' },
        sonnet: { adapter: 'claude-code', label: 'Sonnet 测试', enabled: true, path: path.join(home, 'fake-claude.cjs'), env: { ANTHROPIC_MODEL: 'claude-sonnet-5-5' }, auth: 'token', secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_CODE_OAUTH_TOKEN' }, maxTurns: null },
    } }));
    await writeFile(secretsFile, jsonStr({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ui28-subscription-0001' }));
    fileDialogs.stub = true; fileDialogs.open.length = 0; fileDialogs.save.length = 0;
    try {
        await agentsPage();

        // ---- 导入第 1 步：新增的卡片 ----
        await openWizard();
        await check('UI28 第 1 步：预设卡片后面固定两张——自定义 CLI、从文件导入，文案来自 gx', `(() => { const cards = [...document.querySelectorAll('.sheet .preset')], names = cards.map(c => c.dataset.preset); const last2 = cards.slice(-2); return names.slice(-2).join() === '@custom,@file' && last2[0].querySelector('b').textContent === ${jsonStr(gx.custom)} && last2[0].querySelector('.pk > span').textContent === ${jsonStr(gx.customDesc)} && last2[1].querySelector('b').textContent === ${jsonStr(gx.fromFile)} && last2[1].querySelector('.pk > span').textContent === ${jsonStr(gx.fromFileDesc)} && names.includes('openai-compat') && names.includes('qoder-cn'); })()`);
        // 改写（112）：原断言 names 里同时有 qoder-cn 和 qoder → 新断言只有 qoder-cn（Qoder 合并成一张，默认预设 qoder-cn），qoder 不再单独成卡；原因：同一服务只放一张卡片。
        const presetList: any[] = await evaluate(`window.dock.console('agents:presets').then(r => r.presets)`);
        const presetOf = (name: string) => presetList.find(x => x.name === name);
        await check('UI28 第 1 步：9 张卡片（顺序按 order），Xiaomi MiMo / Claude Code / Qoder 各合并成一张，data-card 与 data-preset（组里默认预设）正确，标题与说明逐字等于 presets --json 的 card', `(() => {
            const cards = [...document.querySelectorAll('.sheet .preset')], names = cards.map(c => c.dataset.preset);
            const merged = (name, c) => { const el = cards.find(x => x.dataset.preset === name); return !!el && el.dataset.card === c.id && el.querySelector('b').textContent === c.title && el.querySelector('.pk > span').textContent === c.description; };
            return names.length === 9 && names.join() === 'deepseek,mimo,claude-native,compat,codex,qoder-cn,openai-compat,@custom,@file'
                && cards.filter(c => c.dataset.card).map(c => c.dataset.card).join() === 'mimo,claude-code,qoder'
                && merged('mimo', ${jsonStr(presetOf('mimo').card)}) && merged('claude-native', ${jsonStr(presetOf('claude-native').card)}) && merged('qoder-cn', ${jsonStr(presetOf('qoder-cn').card)})
                && !names.includes('mimo-payg') && !names.includes('claude-subscription') && !names.includes('qoder')
                && cards.filter(c => c.getAttribute('aria-checked') === 'true').length === 1;
        })()`);
        await shots('wizard-1');

        // ---- Qoder 国内版：默认模型与推理强度（预设的值）、令牌帮助文字 ----
        await press('[data-preset="qoder-cn"]'); await press('[data-w-act=next]'); await wait('!!document.querySelector(".sheet [data-sel=model]")');
        await check('UI28 Qoder 国内版第 2 步：模型下拉初始选中预设的 DeepSeek-Flash，推理强度选中 ultracode', 'document.querySelector("[data-sel=model]").textContent.trim()==="DeepSeek-Flash" && document.querySelector("[data-sel=effort]").textContent.trim()==="ultracode"');
        // 改写（111）：原断言"第 2 步有一个灰掉的订阅登录按钮（.segm button[disabled]）" → 新断言"没有认证方式这一行，也没有分段开关" → 原因：这个开关只有 Codex 能二选一，其他预设显示它是误导。
        // 改写（112）：111 的新断言"没有任何分段开关（.sheet .segm）" → "没有 Codex 的认证方式开关（[data-w-auth]），唯一的分段按钮是第一行的'版本'" → 原因：Qoder 两个版本合并成一张卡片，第 2 步第一行是版本分段按钮。
        await check('UI28 Qoder 国内版：令牌帮助文字写 qoder.cn 与变量名，没有"认证方式"这一行，唯一的分段按钮是第一行的"版本"', `(() => { const t = document.querySelector('.sheet').textContent; const segs = [...document.querySelectorAll('.sheet .segm')]; return t.includes(${jsonStr(gx.qoderTokenHelp('qoder.cn', 'QODERCN_PERSONAL_ACCESS_TOKEN'))}) && !document.querySelector('.sheet [data-w-auth]') && [...document.querySelectorAll('.sheet .fl b')].every(b => !b.textContent.includes(${jsonStr(ag.auth)})) && segs.length === 1 && segs[0].closest('.fld') === document.querySelector('.sheet .form > .fld') && document.querySelector('.sheet .form > .fld .fl b').textContent === ${jsonStr(presetOf('qoder-cn').variant.label)}; })()`);
        await press('[data-sel=model]'); await wait('!!document.querySelector(".optmenu")');
        await assertMenuVisible('UI28 Qoder 模型下拉');
        await check('UI28 下拉菜单不透明（走查发现的透明菜单）：opacity 为 1、没有缩放、层级盖过普通菜单、在窗口里、中心点命中菜单自己', `(() => { const m = document.querySelector('.optmenu'), s = getComputedStyle(m), r = m.getBoundingClientRect(); return m.classList.contains('menu') && s.opacity === '1' && (s.transform === 'none' || s.transform === 'matrix(1, 0, 0, 1, 0, 0)') && s.zIndex === '60' && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && m.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })()`);
        await check('UI28 模型下拉：列出预设的可选值，当前项打勾，最后一项是自定义…', `(() => { const items = [...document.querySelectorAll('.optmenu button')]; const labels = items.map(b => [...b.querySelectorAll('span')].find(s => !s.classList.contains('ri-sp')).textContent.trim()); return labels.includes('Qwen3.8-Max') && labels.at(-1) === ${jsonStr(gx.modelCustom)} && items.find(b => b.getAttribute('aria-selected') === 'true').textContent.includes('DeepSeek-Flash') && document.activeElement.closest('.optmenu') !== null; })()`);
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await pause(350); await save(`agents-wizard-2-model-menu-${theme}`); }
        nativeTheme.themeSource = 'dark';
        await key('Escape');
        await check('UI28 Esc 先关下拉菜单，不关模态框，焦点回到下拉按钮', '!document.querySelector(".optmenu") && !!document.querySelector(".sheet") && document.activeElement===document.querySelector("[data-sel=model]")');
        await press('[data-sel=effort]'); await wait('!!document.querySelector(".optmenu")');
        await assertMenuVisible('UI28 Qoder 推理强度下拉');
        await check('UI28 推理强度下拉：第一项是默认（说明不传参数），后面是预设的可选值', `(() => { const items = [...document.querySelectorAll('.optmenu button')]; return items[0].textContent.includes(${jsonStr(gx.effortDefault)}) && items[0].textContent.includes(${jsonStr(gx.effortDefaultDesc)}) && items.some(b => b.textContent.trim() === 'ultracode') && items.at(-1).textContent.trim() === ${jsonStr(gx.modelCustom)}; })()`);
        await key('Down'); await check('UI28 下拉菜单可用方向键移动焦点', 'document.activeElement.closest(".optmenu") !== null && document.activeElement.getAttribute("aria-selected") !== null');
        await key('Escape');

        // ---- Qoder 国内版 / 国际版（112）：一张卡片，第 2 步第一行"版本"分段按钮；切换后名称、密钥变量、令牌说明里的站点、默认模型与推理强度都跟着变 ----
        const cnPreset = presetOf('qoder-cn'), intlPreset = presetOf('qoder');
        await press('[data-w-variant=qoder]'); await wait(`document.querySelector('[data-w=secretVar]')?.value === ${jsonStr(Object.values(intlPreset.secrets)[0])}`);
        await check('UI28 Qoder 切到国际版：按钮状态互换，说明换成国际版的 variant.help，名称是 qoder 系（不是 qoder-cn），令牌说明写 qoder.com 与国际版变量名，模型与推理强度回到预设的（没有默认值），焦点在刚点的按钮上', `(() => {
            const buttons = [...document.querySelectorAll('.sheet .segm button')], first = document.querySelector('.sheet .form > .fld'), name = document.querySelector('[data-w=name]').value;
            return buttons.map(b => b.textContent).join() === ${jsonStr(cnPreset.variant.option + ',' + intlPreset.variant.option)} && buttons[1].classList.contains('on') && buttons[1].getAttribute('aria-pressed') === 'true' && !buttons[0].classList.contains('on') && buttons[0].getAttribute('aria-pressed') === 'false'
                && document.activeElement === buttons[1] && first.querySelector('.fl span').textContent === ${jsonStr(intlPreset.variant.help)}
                && name.startsWith('qoder') && !name.startsWith('qoder-cn') && document.querySelector('.sheet').textContent.includes(${jsonStr(gx.qoderTokenHelp('qoder.com', 'QODER_PERSONAL_ACCESS_TOKEN'))})
                && document.querySelector('[data-sel=effort]').textContent.trim() === ${jsonStr(gx.effortDefault)} && !document.querySelector('[data-sel=model]').textContent.includes('DeepSeek-Flash');
        })()`);
        // 模型下拉的列表来自预设的 modelOptions（向导第 2 步不运行程序；程序列表只在"编辑"里取，验收环境的假程序桩见导入测试）。
        await press('[data-sel=model]'); await wait('!!document.querySelector(".optmenu")');
        await check('UI28 Qoder 国际版：模型下拉的选项来自国际版预设的 modelOptions', `(() => { const labels = [...document.querySelectorAll('.optmenu button')].map(b => [...b.querySelectorAll('span')].find(s => !s.classList.contains('ri-sp')).textContent.trim()); return ${jsonStr(intlPreset.modelOptions)}.every(m => labels.includes(m)); })()`);
        await key('Escape');
        await press('[data-w-variant=qoder-cn]'); await wait(`document.querySelector('[data-w=secretVar]')?.value === ${jsonStr(Object.values(cnPreset.secrets)[0])}`);
        await check('UI28 Qoder 切回国内版：名称、令牌说明（qoder.cn）、默认模型 DeepSeek-Flash 与推理强度 ultracode 都回到国内版的', `(() => { const name = document.querySelector('[data-w=name]').value; return name.startsWith('qoder-cn') && document.querySelector('.sheet').textContent.includes(${jsonStr(gx.qoderTokenHelp('qoder.cn', 'QODERCN_PERSONAL_ACCESS_TOKEN'))}) && document.querySelector('[data-sel=model]').textContent.trim() === 'DeepSeek-Flash' && document.querySelector('[data-sel=effort]').textContent.trim() === 'ultracode' && document.querySelector('.sheet .segm button.on').textContent === ${jsonStr(cnPreset.variant.option)}; })()`);
        await shots('wizard-2-variant-qoder');

        // ---- Xiaomi MiMo（112）：套餐分段按钮；接口地址在两个套餐之间变化（取模板值），用键盘 Tab 到按钮、空格切换 ----
        const mimoPlan = presetOf('mimo'), mimoPayg = presetOf('mimo-payg');
        await press('[data-w-act=back]'); await wait('!!document.querySelector(".sheet .preset.on")'); await press('[data-preset="mimo"]'); await press('[data-w-act=next]'); await wait('!!document.querySelector(".sheet [data-w=baseUrl]")');
        await check('UI28 MiMo 第 2 步：第一行"套餐"，Token Plan 选中，说明是 variant.help，接口地址与密钥变量取预设的', `(() => {
            const first = document.querySelector('.sheet .form > .fld'), buttons = [...first.querySelectorAll('.segm button')];
            return first.querySelector('.fl b').textContent === ${jsonStr(mimoPlan.variant.label)} && buttons.map(b => b.textContent).join() === ${jsonStr(mimoPlan.variant.option + ',' + mimoPayg.variant.option)} && buttons[0].classList.contains('on') && buttons[0].getAttribute('aria-pressed') === 'true' && buttons[1].getAttribute('aria-pressed') === 'false'
                && first.querySelector('.fl span').textContent === ${jsonStr(mimoPlan.variant.help)} && document.querySelector('[data-w=baseUrl]').value === ${jsonStr(mimoPlan.env.ANTHROPIC_BASE_URL)} && document.querySelector('[data-w=secretVar]').value === ${jsonStr(Object.values(mimoPlan.secrets)[0])};
        })()`);
        await tabTo('[data-w-variant=mimo-payg]'); await key('Space');
        await wait(`document.querySelector('[data-w=baseUrl]')?.value === ${jsonStr(mimoPayg.env.ANTHROPIC_BASE_URL)}`);
        await check('UI28 MiMo 空格切到按量付费：接口地址换成按量付费预设的，名称、说明、按钮状态跟着变，焦点留在按钮上', `(() => {
            const buttons = [...document.querySelectorAll('.sheet .segm button')], first = document.querySelector('.sheet .form > .fld');
            return ${jsonStr(mimoPlan.env.ANTHROPIC_BASE_URL)} !== ${jsonStr(mimoPayg.env.ANTHROPIC_BASE_URL)} && buttons[1].classList.contains('on') && buttons[1].getAttribute('aria-pressed') === 'true' && !buttons[0].classList.contains('on') && document.activeElement === buttons[1]
                && first.querySelector('.fl span').textContent === ${jsonStr(mimoPayg.variant.help)} && document.querySelector('[data-w=name]').value.startsWith('mimo-payg') && document.querySelector('[data-w=model]').value === ${jsonStr(mimoPayg.env.ANTHROPIC_MODEL)};
        })()`);
        await shots('wizard-2-variant-mimo');
        await press('[data-w-variant=mimo]'); await wait(`document.querySelector('[data-w=baseUrl]')?.value === ${jsonStr(mimoPlan.env.ANTHROPIC_BASE_URL)}`);
        await check('UI28 MiMo 点回 Token Plan：接口地址回到 Token Plan 的，名称是 mimo 系', `document.querySelector('[data-w=name]').value.startsWith('mimo') && !document.querySelector('[data-w=name]').value.startsWith('mimo-payg') && document.querySelector('.sheet .segm button.on').textContent === ${jsonStr(mimoPlan.variant.option)}`);

        // ---- 认证方式只在真有选择时出现（111）：DeepSeek、Qoder 没有；Claude Code 的"认证方式"是合并卡片的分段按钮（112）；Codex 有，两个按钮都能真实点击切换 ----
        const noAuthRow = `!document.querySelector('.sheet .segm') && [...document.querySelectorAll('.sheet .fl b')].every(b => !b.textContent.includes(${jsonStr(ag.auth)})) && !!document.querySelector('.sheet [data-w=secretVar]')`;
        const toStep2 = async (preset: string) => { await press('[data-w-act=back]'); await wait('!!document.querySelector(".sheet .preset.on")'); await press(`[data-preset="${preset}"]`); await press('[data-w-act=next]'); await wait('!!document.querySelector(".sheet [data-w=secretVar], .sheet [data-w-auth]")'); };
        await toStep2('deepseek');
        await check('UI28 DeepSeek 第 2 步：没有"认证方式"这一行，密钥变量与设置密钥照旧', `${noAuthRow} && !!document.querySelector('.sheet [data-w=secret]')`);
        // 改写（112）：原操作 toStep2('claude-subscription')（直接点订阅卡片）+ 原断言"没有认证方式这一行、没有任何分段开关（noAuthRow）"
        //   → 新操作先点合并的 Claude Code 卡片再在第 2 步点"订阅令牌"；新断言"第一行是认证方式分段按钮（API Key 选中），没有 Codex 的 data-w-auth；点订阅令牌后名称、密钥变量、说明、按钮状态都换成订阅的"
        //   → 原因：Claude Code 两张卡片合并，认证方式成为第 2 步第一行的分段按钮（不是 Codex 那个登录 / API Key 开关）。
        const nativePreset = presetOf('claude-native'), subPreset = presetOf('claude-subscription');
        await toStep2('claude-native');
        await check('UI28 Claude Code 第 2 步：第一行"认证方式"，API Key 选中，说明是 claude-native 的 variant.help，名称 claude-native 系，密钥变量 ANTHROPIC_API_KEY，没有 Codex 的认证方式开关', `(() => {
            const first = document.querySelector('.sheet .form > .fld'), buttons = [...first.querySelectorAll('.segm button')];
            return first.querySelector('.fl b').textContent === ${jsonStr(nativePreset.variant.label)} && buttons.map(b => b.textContent).join() === ${jsonStr(nativePreset.variant.option + ',' + subPreset.variant.option)} && buttons[0].classList.contains('on') && buttons[0].getAttribute('aria-pressed') === 'true' && buttons[1].getAttribute('aria-pressed') === 'false'
                && first.querySelector('.fl span').textContent === ${jsonStr(nativePreset.variant.help)} && document.querySelector('[data-w=name]').value.startsWith('claude-native') && document.querySelector('[data-w=secretVar]').value === ${jsonStr(Object.values(nativePreset.secrets)[0])}
                && !document.querySelector('.sheet [data-w-auth]') && document.querySelector('[data-w-status]').textContent === '未设置';
        })()`);
        await press('[data-w-variant=claude-subscription]'); await wait(`document.querySelector('[data-w=secretVar]')?.value === ${jsonStr(Object.values(subPreset.secrets)[0])}`);
        await check('UI28 Claude Code 点"订阅令牌"：名称是 claude-subscription 系，密钥变量 CLAUDE_CODE_OAUTH_TOKEN 且重新检测为已设置，说明换成订阅那句，按钮状态互换，焦点在按钮上', `(() => {
            const buttons = [...document.querySelectorAll('.sheet .segm button')], first = document.querySelector('.sheet .form > .fld');
            return buttons[1].classList.contains('on') && buttons[1].getAttribute('aria-pressed') === 'true' && !buttons[0].classList.contains('on') && buttons[0].getAttribute('aria-pressed') === 'false' && document.activeElement === buttons[1]
                && first.querySelector('.fl span').textContent === ${jsonStr(subPreset.variant.help)} && document.querySelector('[data-w=name]').value.startsWith('claude-subscription') && document.querySelector('[data-w-status]').textContent === '已设置' && document.querySelector('[data-w=secret]') !== null;
        })()`);
        await shots('wizard-2-variant-claude');
        await toStep2('codex');
        await check('UI28 Codex 第 2 步：有"认证方式"一行，两个按钮都可点，默认选中订阅登录', `(() => { const b = [...document.querySelectorAll('.sheet [data-w-auth]')]; return b.length === 2 && b.every(x => !x.disabled) && [...document.querySelectorAll('.sheet .fl b')].some(x => x.textContent.includes(${jsonStr(ag.auth)})) && document.querySelector('[data-w-auth=login]').classList.contains('on') && !document.querySelector('.sheet [data-w=secretVar]'); })()`);
        await press('[data-w-auth=token]'); await wait('!!document.querySelector(".sheet [data-w=secretVar]")');
        await check('UI28 Codex 点"API Key"：该按钮选中，出现密钥变量与设置密钥', `document.querySelector('[data-w-auth=token]').classList.contains('on') && document.querySelector('[data-w-auth=token]').getAttribute('aria-pressed') === 'true' && !document.querySelector('[data-w-auth=login]').classList.contains('on') && !!document.querySelector('.sheet [data-w=secret]')`);
        await press('[data-w-auth=login]'); await wait('!document.querySelector(".sheet [data-w=secretVar]")');
        await check('UI28 Codex 点回"订阅登录"：该按钮选中，密钥项消失', `document.querySelector('[data-w-auth=login]').classList.contains('on') && document.querySelector('[data-w-auth=login]').getAttribute('aria-pressed') === 'true' && !document.querySelector('[data-w-auth=token]').classList.contains('on')`);
        // 点过认证方式，向导算有改动：Esc 会先问是否放弃。
        await key('Escape'); await wait('!!document.querySelector(".confirm-actions .danger")'); await press('.confirm-actions .danger'); await wait('!document.querySelector(".sheet")');

        // ---- 1. 自定义 CLI：表单、校验、测试并预览、保存、真实派发 ----
        await openWizard();
        await press('[data-preset="@custom"]'); await press('[data-w-act=next]'); await wait('!!document.querySelector(".sheet [data-c=program]")');
        await check('UI28 自定义 CLI：表单标题、未填程序时保存与测试并预览禁用', `document.querySelector('.sheet-h > b').textContent === ${jsonStr(gx.customTitle)} && document.querySelector('[data-c-act=save]').disabled && document.querySelector('[data-c-act=preview]').disabled`);
        await check('UI28 自定义 CLI：名称与显示名在表单开头，输出格式默认 JSONL，检测参数默认 --version', 'document.querySelector(".sheet .form").firstElementChild.nextElementSibling.querySelector("[data-c=name]") !== null && document.querySelector("[data-seg=format].on").dataset.v==="jsonl" && document.querySelector("[data-c=detectArgs]").value==="--version"');
        await type('[data-c=label]', 'UI28 CLI');
        await type('[data-c=program]', process.execPath); await key('Tab');
        await wait('!!document.querySelector("[data-prog=found]")', 'UI28 程序检测完成', 30000);
        await check('UI28 程序失去焦点后检测：显示已找到与版本', `document.querySelector("[data-prog=found]").textContent.startsWith(${jsonStr(gx.programFound('').slice(0, 4))}) && document.querySelector("[data-prog=found]").textContent.length > 6`);
        // 浏览…：主进程的文件对话框（桩给出同一个程序路径），选完后重新检测。
        fileDialogs.open.push(process.execPath);
        await press('[data-c-act=browse]');
        await wait('!!document.querySelector("[data-prog=found]")', 'UI28 浏览后检测完成', 30000);
        await verify('UI28 浏览…打开了一次文件对话框，程序一栏是选中的路径', async () => { assert.equal(fileDialogs.openRequests.length, 1); assert.equal(await evaluate('document.querySelector("[data-c=program]").value'), process.execPath); });
        // 参数模板：回车加 chip、占位符按钮、退格删除最后一个、chip 上的删除按钮。
        await type('[data-tag-in=args]', okCli); await key('Enter');
        await type('[data-tag-in=args]', 'run'); await key('Enter');
        await press('[data-tag-ph=args][data-v="{promptFile}"]');
        await check('UI28 参数模板：回车把文字加成 chip，占位符按钮在末尾插入高亮 chip', `document.querySelectorAll('.sheet .argbox')[0].querySelectorAll('.argchip').length === 3 && document.querySelectorAll('.sheet .argbox')[0].querySelectorAll('.argchip')[2].classList.contains('ph') && document.querySelectorAll('.sheet .argbox')[0].querySelectorAll('.argchip .mono')[1].textContent === 'run'`);
        await type('[data-tag-in=args]', 'tmp'); await key('Enter');
        await check('UI28 参数模板：删除按钮的 aria-label 是 gx.argRemove(参数)', `document.querySelector('[data-tag-del=args][data-i="3"]').getAttribute('aria-label') === ${jsonStr(gx.argRemove('tmp'))}`);
        await press('[data-tag-del=args][data-i="3"]');
        await check('UI28 参数模板：点 chip 的删除按钮删掉这一项', 'document.querySelectorAll(".sheet .argbox")[0].querySelectorAll(".argchip").length === 3');
        await type('[data-tag-in=args]', 'tmp'); await key('Enter'); await key('Backspace');
        await check('UI28 参数模板：输入框为空时退格删除最后一个 chip，焦点仍在输入框', 'document.querySelectorAll(".sheet .argbox")[0].querySelectorAll(".argchip").length === 3 && document.activeElement.matches("[data-tag-in=args]")');
        // 点参数框里的空白处（111）：清空参数后，点框内不在输入框上的位置（上沿的内边距），焦点进到输入框，再输入一项回车出现小方块。
        for (let i = 0; i < 3; i++) await key('Backspace');
        await check('UI28 参数模板：退格清空后没有小方块，框进入空状态', 'document.querySelectorAll(".sheet .argbox")[0].querySelectorAll(".argchip").length === 0 && document.querySelectorAll(".sheet .argbox")[0].classList.contains("empty")');
        // 115：空的参数框和普通单行输入框一样高，输入框占满整行、从左边开始。
        await check('UI28 参数模板（115）：空的参数框高度不超过 --ctl+2px，输入框左边与内容区左边对齐、宽度不小于内容宽度的 90%', `(() => { const b = document.querySelectorAll('.sheet .argbox')[0], i = b.querySelector('.arginp'), br = b.getBoundingClientRect(), ir = i.getBoundingClientRect(), cs = getComputedStyle(b); const ctl = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ctl')); const left = br.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), content = br.width - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); return br.height <= ctl + 2 && Math.abs(ir.left - left) <= 8 && ir.width >= content * 0.9; })()`);
        await shots('custom-argbox-empty');
        // 115：150 个字符的长参数回车后在小方块里折行，不超出参数框和模态框。
        const longArg = 'C:\\work\\example\\' +'long-directory-name\\'.repeat(6) + 'tests\\fixtures\\generic\\ok-cli.mjs';
        assert.ok(longArg.length >= 150, `长参数至少 150 个字符：${longArg.length}`);
        await type('[data-tag-in=args]', longArg); await key('Enter');
        await check('UI28 参数模板（115）：150 字符的长参数折行，小方块右边不超过参数框、参数框右边不超过模态框，DOM 里文字完整', `(() => { const b = document.querySelectorAll('.sheet .argbox')[0], c = b.querySelector('.argchip'), s = document.querySelector('.sheet'); return c.getBoundingClientRect().right <= b.getBoundingClientRect().right + 0.5 && b.getBoundingClientRect().right <= s.getBoundingClientRect().right && c.querySelector('.mono').textContent === ${jsonStr(longArg)} && c.getBoundingClientRect().height > 24; })()`);
        await shots('custom-argbox-long');
        await press('[data-tag-in=args]'); await key('Backspace');
        await check('UI28 参数模板（115）：退格删掉长参数后回到空状态', 'document.querySelectorAll(".sheet .argbox")[0].querySelectorAll(".argchip").length === 0');
        await press('[data-c=label]');
        const blank =await evaluate(`(() => { const b = document.querySelectorAll('.sheet .argbox')[0], r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + 2; return { x: Math.round(x), y: Math.round(y), onBox: document.elementFromPoint(x, y) === b, notInput: document.elementFromPoint(x, y) !== b.querySelector('.arginp'), focusedElsewhere: document.activeElement === document.querySelector('[data-c=label]') }; })()`) as { x: number; y: number; onBox: boolean; notInput: boolean; focusedElsewhere: boolean };
        assert.ok(blank.onBox && blank.notInput && blank.focusedElsewhere, `点击位置必须落在参数框本身（不在输入框上），且点之前焦点不在输入框：${jsonStr(blank)}`);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: blank.x, y: blank.y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x: blank.x, y: blank.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: blank.x, y: blank.y, button: 'left', clickCount: 1 });
        await pause(200);
        await check('UI28 参数模板：点参数框的空白处，焦点进到这个框的输入框', 'document.activeElement === document.querySelectorAll(".sheet .argbox")[0].querySelector(".arginp")');
        await key('x'); await key('Enter');
        await check('UI28 参数模板：点空白处后直接输入一项回车，出现小方块', 'document.querySelectorAll(".sheet .argbox")[0].querySelectorAll(".argchip").length === 1 && document.querySelectorAll(".sheet .argbox")[0].querySelector(".argchip .mono").textContent === "x"');
        await key('Backspace');
        // 把前面清掉的三项加回来，后面的检查沿用。
        await type('[data-tag-in=args]', okCli); await key('Enter');
        await type('[data-tag-in=args]', 'run'); await key('Enter');
        await press('[data-tag-ph=args][data-v="{promptFile}"]');
        // 输出格式：文本时没有事件映射；JSONL 时出现。
        await press('[data-seg=format][data-v=text]');
        await check('UI28 输出格式选文本：事件映射隐藏，汇报来源默认标准输出', '!document.querySelector("[data-map-add]") && document.querySelector("[data-seg=report].on").dataset.v==="stdout"');
        await press('[data-seg=format][data-v="stream-json"]');
        await check('UI28 输出格式选 Claude Code 风格：事件映射与汇报来源都隐藏', '!document.querySelector("[data-map-add]") && !document.querySelector("[data-seg=report]")');
        await press('[data-seg=format][data-v=jsonl]');
        await check('UI28 输出格式选 JSONL：出现事件映射（一条空行）与汇报来源，默认最后一句话', 'document.querySelectorAll(".map-row").length === 1 && document.querySelector("[data-seg=report].on").dataset.v==="lastSay"');
        // 事件映射：两条。
        await type('[data-m=when][data-i="0"]', 'type = message');
        await pick('[data-kind="0"]', gx.kinds.say);
        await type('[data-m=fields][data-i="0"]', 'text ← content');
        await press('[data-map-add]'); await wait('document.querySelectorAll(".map-row").length === 2');
        await type('[data-m=when][data-i="1"]', 'type = exec');
        await pick('[data-kind="1"]', gx.kinds.cmd);
        await check('UI28 事件映射：事件类型下拉选中后显示所选类型', `document.querySelector('[data-kind="1"]').textContent.trim() === ${jsonStr(gx.kinds.cmd)}`);
        await type('[data-m=fields][data-i="1"]', 'command ← cmd · exit ← code');
        await wait('!document.querySelector("[data-c-act=save]").disabled', 'UI28 声明校验通过后保存可用');
        await check('UI28 校验通过：保存与测试并预览可用，底部说明是 gx.customNote(名称)', `!document.querySelector('[data-c-act=preview]').disabled && document.querySelector('.sheet-f .note').textContent === ${jsonStr(gx.customNote('custom'))} && [...document.querySelectorAll('[data-err]')].every(e => !e.classList.contains('on'))`);
        // 示例填入（Stage07b T4d⑪）：标准输入、只读参数、密钥环境变量三个字段，空着时按 → 填入示例；Tab 仍只切换焦点。检查完把三个字段清回空，后面的检查沿用。
        const exampleField = (selector: string) => `document.querySelector(${jsonStr(selector)}).closest('.fld')`;
        const kbdShown = (selector: string) => `(() => { const i = document.querySelector(${jsonStr(selector)}), box = i.closest('.exw'), k = box.querySelector('.kbd'), host = box.querySelector('.inp, .argbox'), kr = k.getBoundingClientRect(), hr = host.getBoundingClientRect(); return getComputedStyle(k).display !== 'none' && k.textContent === ${jsonStr(gx.exampleKey)} && kr.left >= hr.left && kr.right <= hr.right && hr.right - kr.left <= parseFloat(getComputedStyle(host).paddingRight) + 1; })()`;
        const kbdHidden = (selector: string) => `getComputedStyle(document.querySelector(${jsonStr(selector)}).closest('.exw').querySelector('.kbd')).display === 'none'`;
        await check('UI28 示例：三个字段的说明末尾都是「 · 」加 gx.exampleHint', [['stdin', gx.stdinHelp, '[data-c=stdin]'], ['readOnly', gx.readOnlyArgsHelp, '[data-tag-in=readOnly]'], ['secretVar', gx.secretVarHelp, '[data-c=secretVar]']].map(([, help, sel]) => `${exampleField(sel)}.querySelector('.fl span').textContent === ${jsonStr(`${help} · ${gx.exampleHint}`)}`).join(' && '));
        await check('UI28 示例：没聚焦时三个字段都不显示按键提示', ['[data-c=stdin]', '[data-tag-in=readOnly]', '[data-c=secretVar]'].map(kbdHidden).join(' && '));
        await press('[data-c=stdin]');
        await check('UI28 示例：标准输入聚焦且为空时，右侧显示按键提示 gx.exampleKey，且在输入框右侧内边距里（不挡文字）', `document.querySelector('[data-c=stdin]').value === '' && ${kbdShown('[data-c=stdin]')}`);
        await key('Right');
        await check('UI28 示例：空的标准输入按 → 填入 {prompt}，光标在末尾，按键提示消失，并触发和手动输入一样的更新（保存暂时禁用等重新校验）', `(() => { const i = document.querySelector('[data-c=stdin]'); return i.value === ${jsonStr(gx.examples.stdin)} && i.value === '{prompt}' && i.selectionStart === i.value.length && i.selectionEnd === i.value.length && document.activeElement === i && ${kbdHidden('[data-c=stdin]')} && document.querySelector('[data-c-act=save]').disabled; })()`);
        await wait('!document.querySelector("[data-c-act=save]").disabled', 'UI28 示例填入后重新校验通过');
        await key('Right');
        await check('UI28 示例：标准输入不为空时再按 → 不再改变（保持默认的移动光标）', `document.querySelector('[data-c=stdin]').value === '{prompt}'`);
        await key('Tab');
        await check('UI28 示例：Tab 仍只切换焦点，到下一个控件，标准输入的值不变', `document.activeElement.matches('[data-seg=format]') && document.querySelector('[data-c=stdin]').value === '{prompt}'`);
        await press('[data-c=stdin]');
        for (let i = 0; i < '{prompt}'.length; i++) await key('Backspace');
        await check('UI28 示例：退格清空标准输入后又为空，按键提示重新出现', `document.querySelector('[data-c=stdin]').value === '' && ${kbdShown('[data-c=stdin]')}`);
        await press('[data-c=secretVar]');
        await check('UI28 示例：密钥环境变量聚焦且为空时显示按键提示', `document.querySelector('[data-c=secretVar]').value === '' && ${kbdShown('[data-c=secretVar]')}`);
        await key('Right');
        await check('UI28 示例：空的密钥环境变量按 → 填入 EXAMPLE_API_KEY，光标在末尾', `(() => { const i = document.querySelector('[data-c=secretVar]'); return i.value === ${jsonStr(gx.examples.secretVar)} && i.value === 'EXAMPLE_API_KEY' && i.selectionStart === i.value.length && ${kbdHidden('[data-c=secretVar]')}; })()`);
        for (let i = 0; i < 'EXAMPLE_API_KEY'.length; i++) await key('Backspace');
        await check('UI28 示例：清空密钥环境变量', `document.querySelector('[data-c=secretVar]').value === ''`);
        await press('[data-tag-in=readOnly]');
        await check('UI28 示例：只读参数输入框聚焦且为空时显示按键提示', `document.querySelector('[data-tag-in=readOnly]').value === '' && ${kbdShown('[data-tag-in=readOnly]')}`);
        await key('Right');
        await check('UI28 示例：空的只读参数输入框按 → 只把 --read-only 填进输入框文字，还没有小方块', `document.querySelector('[data-tag-in=readOnly]').value === ${jsonStr(gx.examples.readOnly)} && document.querySelector('[data-tag-in=readOnly]').value === '--read-only' && document.querySelectorAll('.sheet .argbox')[1].querySelectorAll('.argchip').length === 0`);
        await key('Enter');
        await check('UI28 示例：回车后 --read-only 才成为小方块', `document.querySelectorAll('.sheet .argbox')[1].querySelectorAll('.argchip').length === 1 && document.querySelectorAll('.sheet .argbox')[1].querySelector('.argchip .mono').textContent === '--read-only'`);
        await key('Backspace');
        await check('UI28 示例：退格删掉只读参数的小方块，回到空状态', `document.querySelectorAll('.sheet .argbox')[1].querySelectorAll('.argchip').length === 0 && document.querySelector('[data-tag-in=readOnly]').value === ''`);
        await wait('!document.querySelector("[data-c-act=save]").disabled', 'UI28 示例检查完成后重新校验通过');
        await shots('custom-form');
        // 2. 校验：参数模板里的 {bogus}。
        await type('[data-tag-in=args]', '{bogus}'); await key('Enter');
        await wait('document.querySelector("[data-err=args]").classList.contains("on")', 'UI28 参数模板错误显示在字段下');
        await check('UI28 校验：{bogus} 的错误显示在参数模板字段下（核心的原因），保存与测试并预览禁用，底部说明是 gx.invalid(n)', `document.querySelector('[data-err=args]').textContent.includes('{bogus}') && document.querySelector('[data-c-act=save]').disabled && document.querySelector('[data-c-act=preview]').disabled && document.querySelector('.sheet-f .note').textContent === ${jsonStr(gx.invalid(1))} && document.querySelector('.argbox').classList.contains('bad')`);
        await verify('UI28 校验不写配置：现在 config.json 里还没有 generics', async () => { assert.equal((await readConfig()).generics, undefined); });
        await shots('custom-invalid');
        await press('[data-tag-del=args][data-i="3"]');
        await wait('!document.querySelector("[data-c-act=save]").disabled', 'UI28 删掉错误参数后保存恢复可用');
        await check('UI28 校验：删掉 {bogus} 后错误消失', '!document.querySelector("[data-err=args]").classList.contains("on") && document.querySelectorAll(".sheet .argbox")[0].querySelectorAll(".argchip").length === 3');
        // 映射写法有误（本地错误）：字段没有 ← 。
        await type('[data-m=fields][data-i="1"]', ' · foo');
        await check('UI28 映射写法有误时在事件映射下提示并禁用保存', 'document.querySelector("[data-err=map]").classList.contains("on") && document.querySelector("[data-err=map]").textContent.startsWith("2：") && document.querySelector("[data-c-act=save]").disabled');
        for (let i = 0; i < 6; i++) await key('Backspace');
        await wait(`document.querySelector('[data-m=fields][data-i="1"]').value === 'command ← cmd · exit ← code' && !document.querySelector('[data-err=map]').classList.contains('on')`, 'UI28 映射文字恢复');
        await wait('!document.querySelector("[data-c-act=save]").disabled', 'UI28 映射恢复后保存可用');

        // 115：预览失败（node 找不到模块，报错行很长）：右栏和失败横幅不被挤出模态框。参数先换成不存在的模块路径，测完再还原。
        const missingModule = path.join(work, 'missing-' + 'x'.repeat(100), 'no-such-cli.mjs');
        await press('[data-tag-in=args]');
        for (let i = 0; i < 3; i++) await key('Backspace');
        await type('[data-tag-in=args]', missingModule); await key('Enter');
        await press('[data-tag-ph=args][data-v="{promptFile}"]');
        await wait('!document.querySelector("[data-c-act=preview]").disabled', 'UI28 换参数后预览可用');
        await press('[data-c-act=preview]');
        await wait('!!document.querySelector("[data-pv]")', 'UI28 失败预览结果', 60000);
        await check('UI28 测试并预览（115）：失败时右栏和失败横幅完整显示在模态框内，原始输出在左栏内折行', `(() => { const s = document.querySelector('.sheet').getBoundingClientRect(), last = document.querySelector('.pv2 > :last-child').getBoundingClientRect(), f = document.querySelector('[data-pv=fail]'), fr = f?.getBoundingClientRect(), raw = document.querySelector('[data-pv-raw]'); return !!f && last.right <= s.right && fr.right <= s.right && fr.left >= s.left && raw.scrollWidth <= raw.clientWidth + 1 && raw.textContent.includes('no-such-cli.mjs') && raw.textContent.length > 150; })()`);
        await check('UI28 测试并预览（122）：失败原因是真正的报错行（Error: Cannot find module），不是 Node 版本那一行', `(() => { const t = document.querySelector('[data-pv=fail] div span').textContent.trim(); return t.startsWith('Error: Cannot find module') && !t.startsWith('Node.js v'); })()`);
        await shots('custom-preview-fail');
        await press('[data-c-act=edit]'); await wait('!!document.querySelector("[data-c=program]")');
        await press('[data-tag-in=args]'); await key('Backspace'); await key('Backspace');
        await type('[data-tag-in=args]', okCli); await key('Enter');
        await type('[data-tag-in=args]', 'run'); await key('Enter');
        await press('[data-tag-ph=args][data-v="{promptFile}"]');
        await wait('!document.querySelector("[data-c-act=save]").disabled', 'UI28 还原参数后保存可用');

        // 4. 测试并预览：不写配置；左边原始输出，右边映射结果。
        await press('[data-c-act=preview]');
        await wait('!!document.querySelector("[data-pv]")', 'UI28 预览结果', 60000);
        await check('UI28 测试并预览：标题换成 gx.previewTitle，底栏是 返回修改 / 重新测试 / 保存', `document.querySelector('.sheet-h > b').textContent === ${jsonStr(gx.previewTitle)} && [...document.querySelectorAll('.sheet-btns .btn')].map(b => b.textContent.trim()).join() === ${jsonStr([gx.backEdit, gx.retest, '保存'].join())}`);
        await check('UI28 测试并预览：左边是原始输出四行', `document.querySelector('[data-pv-raw]').textContent.split('\\n').length === 4 && document.querySelector('[data-pv-raw]').textContent.includes('"type":"message"')`);
        await check('UI28 测试并预览：右边出现"说话：OK"和"命令：git status → exit 0"，没有符合规则的行灰色显示 gx.unmatched', `(() => { const rows = [...document.querySelectorAll('[data-pv-events] .pv-e')]; const t = rows.map(r => r.textContent.trim()); return t.includes(${jsonStr(gx.kinds.say + '：OK')}) && t.includes(${jsonStr(gx.kinds.cmd + '：git status → exit 0')}) && t.includes(${jsonStr(gx.unmatched(1))}) && rows.filter(r => r.classList.contains('skip')).length === 2 && rows.filter(r => !r.classList.contains('skip')).every(r => r.querySelector('i.ri')); })()`);
        await check('UI28 测试并预览：底部显示测试通过与 gx.previewOkHelp(退出码、用时、汇报)', `document.querySelector('[data-pv=ok]') !== null && document.querySelector('[data-pv=ok]').textContent.includes(${jsonStr(gx.previewOk)}) && /退出码 0，用时 [0-9.]+ 秒；汇报：OK$/.test(document.querySelector('[data-pv=ok] div span').textContent)`);
        await verify('UI28 测试并预览不写配置，也没有留下临时目录里的任务记录', async () => { assert.equal((await readConfig()).generics, undefined); assert.equal((await readConfig()).profiles.custom, undefined); });
        await shots('custom-preview');
        await press('[data-c-act=preview]'); await wait('!!document.querySelector("[data-pv]")', 'UI28 重新测试', 60000);
        await check('UI28 重新测试：再次得到通过结果', 'document.querySelector("[data-pv=ok]") !== null');
        await press('[data-c-act=edit]'); await wait('!!document.querySelector("[data-c=program]")');
        await check('UI28 返回修改：回到表单，填过的内容还在', `document.querySelector('[data-c=program]').value === ${jsonStr(process.execPath)} && document.querySelectorAll('.map-row').length === 2 && document.querySelector('[data-c=label]').value === 'UI28 CLI'`);
        await press('[data-c-act=preview]'); await wait('!!document.querySelector("[data-pv]")', 'UI28 预览结果', 60000);
        await press('[data-c-act=save]');
        await wait('!document.querySelector(".sheet")', 'UI28 保存后模态框关闭');
        await verify('UI28 保存：config.json 出现 generics.custom 与执行者配置，声明按表单组装', async () => {
            const c = await readConfig();
            assert.equal(c.profiles.custom.adapter, 'generic'); assert.equal(c.profiles.custom.generic, 'custom'); assert.equal(c.profiles.custom.label, 'UI28 CLI');
            const d = c.generics.custom;
            assert.equal(d.executable, process.execPath); assert.deepEqual(d.args, [okCli, 'run', '{promptFile}']);
            assert.deepEqual(d.output, { format: 'jsonl', map: [{ when: { type: 'message' }, kind: 'say', text: 'content' }, { when: { type: 'exec' }, kind: 'cmd', command: 'cmd', exit: 'code' }] });
            assert.equal(d.report, 'lastSay'); assert.equal(c.defaultProfile, 'ok', '已有非 Codex 的默认执行者时不改默认');
        });
        await wait('!!document.querySelector("[data-agent=custom]")', 'UI28 保存后执行者列表出现新行');
        await check('UI28 保存后执行者列表出现新行（显示名、generic）', 'document.querySelector("[data-agent=custom] .x1 b").textContent==="UI28 CLI" && document.querySelector("[data-agent=custom] .x2").textContent.includes("generic")');
        // 真实派发：用这个执行者在临时仓库里跑一个任务（假 CLI），任务结束，汇报是 OK。
        const repo = path.join(work, 'repo');
        await mkdir(repo, { recursive: true });
        git(repo, ['init', '-b', 'main']);
        await writeFile(path.join(repo, 'README.md'), '# ui28\n');
        git(repo, ['add', '--', 'README.md']);
        git(repo, ['-c', 'user.name=AgentRouter Shots', '-c', 'user.email=shots@example.invalid', 'commit', '-m', '初始提交', '--', 'README.md']);
        // 派发用单独的公共目录（复制当前配置）：不往隔离公共目录的 runs.jsonl 里加任务，免得影响后面按任务列表做的检查。
        const dispatchHome = path.join(work, 'dispatch-home');
        await mkdir(dispatchHome, { recursive: true });
        await writeFile(path.join(dispatchHome, 'config.json'), await readFile(config, 'utf8'));
        const dispatched = await coreRun(['dispatch', '只回复 OK，不要修改任何文件', '--name', 'ui28-custom', '--profile', 'custom'], { timeoutMs: 120000, cwd: repo, env: { ...appEnv, AGENT_ROUTER_HOME: dispatchHome } });
        await verify('UI28 用自定义 CLI 执行者真实派发：任务结束，汇报是 OK，事件由表单里的映射产生', async () => {
            assert.equal(dispatched.code, 0, `派发失败：${dispatched.stderr || dispatched.json?.error}`);
            const dir = path.join(repo, '.agent-runs', 'ui28-custom');
            assert.equal((await readFile(path.join(dir, 'report.md'), 'utf8')).trim(), 'OK');
            const events = (await readFile(path.join(dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
            assert.deepEqual(events.map(e => e.kind), ['say', 'cmd']);
            assert.equal(events[0].text, 'OK'); assert.equal(events[1].command, 'git status'); assert.equal(events[1].exit, 0);
        });

        // ---- 3. 模型与推理强度：Claude 订阅预设导入时选 high；编辑改成默认 ----
        await openWizard();
        // 改写（112）：原操作直接点 [data-preset=claude-subscription] 卡片 → 先点合并的 Claude Code 卡片，下一步后在第 2 步点"订阅令牌"；原因：两张 Claude Code 卡片合并。
        await press('[data-preset=claude-native]'); await press('[data-w-act=next]'); await wait('!!document.querySelector(".sheet [data-w-variant]")');
        await press('[data-w-variant=claude-subscription]'); await wait('document.querySelector("[data-w=secretVar]")?.value === "CLAUDE_CODE_OAUTH_TOKEN"');
        await wait('!!document.querySelector(".sheet [data-sel=effort]")');
        await check('UI28 Claude 订阅预设第 2 步：模型没有预设可选值时是输入框，推理强度是下拉、默认选中"默认"', `document.querySelector('[data-w=model]') !== null && document.querySelector('[data-sel=effort]').textContent.trim() === ${jsonStr(gx.effortDefault)} && document.querySelector('[data-w=secretVar]').value === 'CLAUDE_CODE_OAUTH_TOKEN' && document.querySelector('[data-w-status]').textContent === '已设置'`);
        await type('[data-w=model]', 'claude-sonnet-5-5');
        await pick('[data-sel=effort]', 'high');
        await check('UI28 推理强度选 high 后下拉显示 high，输入过的模型不丢', 'document.querySelector("[data-sel=effort]").textContent.trim()==="high" && document.querySelector("[data-w=model]").value==="claude-sonnet-5-5"');
        await shots('wizard-2-effort');
        await press('[data-w-act=next]'); await wait('!!document.querySelector("[data-w-result]")', 'UI28 导入测试结果', 60000);
        await verify('UI28 导入 Claude 订阅：config.json 的 effort 为 high，模型写进 env', async () => { const p = (await readConfig()).profiles['claude-subscription']; assert.equal(p.effort, 'high'); assert.equal(p.env.ANTHROPIC_MODEL, 'claude-sonnet-5-5'); });
        await verify('UI28 选"订阅令牌"走完导入：新执行者是 claude-subscription 预设的配置（订阅令牌变量），没有 card / variant 字段', async () => {
            const p = (await readConfig()).profiles['claude-subscription'];
            assert.deepEqual(p.secrets, { CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_CODE_OAUTH_TOKEN' }); assert.equal(p.adapter, 'claude-code');
            assert.ok(!('card' in p) && !('variant' in p), `配置里不该有 card / variant：${Object.keys(p).join()}`);
        });
        await press('[data-w-act=done]'); await wait('!document.querySelector(".sheet") && !!document.querySelector("[data-agent=claude-subscription]")');
        await press('[data-more-agent=claude-subscription]'); await press(await ctxItem('编辑'));
        await wait('!!document.querySelector(".sheet [data-sel=effort]")');
        await check('UI28 编辑 Claude 类执行者：推理强度下拉显示 high，有"升级到"下拉', `document.querySelector('[data-sel=effort]').textContent.trim() === 'high' && document.querySelector('[data-sel=escalate]').textContent.trim() === ${jsonStr(gx.escalateNone)}`);
        await shots('edit-claude');
        await pick('[data-sel=effort]', gx.effortDefault);
        await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
        await verify('UI28 编辑改成"默认"后 config.json 的 effort 消失，其他字段不变', async () => { const p = (await readConfig()).profiles['claude-subscription']; assert.ok(!('effort' in p)); assert.equal(p.env.ANTHROPIC_MODEL, 'claude-sonnet-5-5'); });

        // ---- 3b. 升级到 ----
        await press('[data-more-agent=sonnet]'); await press(await ctxItem('编辑')); await wait('!!document.querySelector(".sheet [data-sel=escalate]")');
        await press('[data-sel=escalate]'); await wait('!!document.querySelector(".optmenu")');
        await assertMenuVisible('UI28 升级到下拉');
        await check('UI28 升级到下拉：不升级加其他已启用的执行者，不含自己，没有自定义…', `(() => { const labels = [...document.querySelectorAll('.optmenu button')].map(b => [...b.querySelectorAll('span')].find(s => !s.classList.contains('ri-sp')).textContent.trim()); return labels[0] === ${jsonStr(gx.escalateNone)} && labels.includes('Fake Ok') && labels.includes('UI28 CLI') && !labels.includes('Sonnet 测试') && !labels.includes(${jsonStr(gx.modelCustom)}); })()`);
        await press(await option('Fake Ok')); await wait('!document.querySelector(".optmenu")');
        await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
        await verify('UI28 升级到选另一个执行者：config.json 的 escalate 是它的名字', async () => { assert.equal((await readConfig()).profiles.sonnet.escalate, 'ok'); });
        await press('[data-more-agent=sonnet]'); await press(await ctxItem('编辑')); await wait('!!document.querySelector(".sheet [data-sel=escalate]")');
        await check('UI28 再次编辑：升级到显示上次选的执行者', 'document.querySelector("[data-sel=escalate]").textContent.trim()==="Fake Ok"');
        await pick('[data-sel=escalate]', gx.escalateNone);
        await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
        await verify('UI28 改回"不升级"：escalate 消失', async () => { assert.ok(!('escalate' in (await readConfig()).profiles.sonnet)); });

        // ---- 4. OpenAI 兼容接口 ----
        await openWizard();
        await press('[data-preset=openai-compat]'); await press('[data-w-act=next]'); await wait('!!document.querySelector(".sheet [data-sel=baseUrl]")');
        await check('UI28 OpenAI 兼容接口第 2 步：没有认证方式，接口类型固定显示 Responses 与说明，底部说明是 gx.openaiNote', `!document.querySelector('.segm') && document.querySelector('.sheet').textContent.includes(${jsonStr(gx.wireApiValue)}) && document.querySelector('.sheet').textContent.includes(${jsonStr(gx.wireApiHelp)}) && document.querySelector('.sheet-f .note').textContent === ${jsonStr(gx.openaiNote)} && document.querySelector('[data-w=model]') !== null`);
        await pick('[data-sel=baseUrl]', gx.modelCustom);
        await check('UI28 接口地址选"自定义…"后变成输入框，焦点在输入框里', 'document.activeElement===document.querySelector("[data-w=baseUrl]")');
        // 切到"自定义…"时输入框里保留着刚才选的地址：先删掉再填自己的。
        const preset = String(await evaluate('document.querySelector("[data-w=baseUrl]").value'));
        await check('UI28 切到自定义后输入框里是刚才选中的常用地址', `${jsonStr(preset)}.startsWith("https://")`);
        await key('End'); for (let i = 0; i < preset.length; i++) await key('Backspace');
        await type('[data-w=baseUrl]', 'https://api.example.invalid/v1');
        await type('[data-w=model]', 'ui28-model');
        await type('[data-w=secretVar]', 'UI28_OPENAI_KEY'); await key('Tab');
        // 变量名改完会重新读一次密钥状态并重画（焦点留在 Tab 到的输入框）：等它落定再继续。
        await pause(600);
        await check('UI28 改密钥变量名后 Tab：状态重新读取，焦点仍在 Tab 到的"设置密钥"输入框', 'document.querySelector("[data-w-status]").textContent==="未设置" && document.activeElement===document.querySelector("[data-w=secret]")');
        await type('[data-w=secret]', 'sk-ui28-openai-0002'); await press('[data-w-act=save-secret]');
        await wait('document.querySelector("[data-w-status]")?.textContent==="已设置"');
        await check('UI28 OpenAI 兼容接口：保存密钥后密码框清空，输入过的地址与模型还在', 'document.querySelector("[data-w=secret]").value==="" && document.querySelector("[data-w=baseUrl]").value==="https://api.example.invalid/v1" && document.querySelector("[data-w=model]").value==="ui28-model"');
        await shots('wizard-2-openai');
        await press('[data-w-act=next]'); await wait('!!document.querySelector("[data-w-result]")', 'UI28 OpenAI 导入测试结果', 60000);
        await verify('UI28 OpenAI 兼容接口：config.json 出现 provider 字段（地址、responses）、模型、密钥变量名，没有密钥值', async () => {
            const p = (await readConfig()).profiles['openai-compat'];
            assert.deepEqual(p.provider, { baseUrl: 'https://api.example.invalid/v1', wireApi: 'responses' });
            assert.equal(p.model, 'ui28-model'); assert.deepEqual(p.secrets, { UI28_OPENAI_KEY: 'UI28_OPENAI_KEY' });
            assert.ok(!JSON.stringify(p).includes('sk-ui28-openai-0002'));
        });
        await check('UI28 OpenAI 兼容接口：测试连接用桩，通过', 'document.querySelector("[data-w-result]").dataset.wResult==="ok"');
        await press('[data-w-act=done]'); await wait('!document.querySelector(".sheet")');

        // ---- Qoder 国内版（编辑：模型列表）----
        const added = await coreRun(['agents', 'add', '--preset', 'qoder-cn'], { timeoutMs: 60000 });
        assert.equal(added.code, 0, added.stderr || added.json?.error);
        await agentsPage(); await wait('!!document.querySelector("[data-agent=qoder-cn]")', 'UI28 Qoder 执行者行出现');
        await press('[data-more-agent=qoder-cn]'); await press(await ctxItem('编辑'));
        await wait('!!document.querySelector(".sheet [data-sel=model]") && !document.querySelector(".sheet [data-sel=model]").disabled', 'UI28 模型列表读完', 60000);
        await check('UI28 编辑通用适配器执行者（Qoder）：显示名、模型、推理强度、升级到四项，没有接口地址和密钥项；当前值选中', `[...document.querySelectorAll('.sheet .fl b')].map(b => b.textContent.replace('*', '')).join() === ${jsonStr(['显示名', '模型', '推理强度', '升级到'].join())} && document.querySelector('[data-sel=model]').textContent.trim() === 'DeepSeek-Flash' && document.querySelector('[data-sel=effort]').textContent.trim() === 'ultracode'`);
        await pick('[data-sel=model]', gx.modelCustom);
        await check('UI28 编辑：模型选"自定义…"后变成输入框并取得焦点', 'document.activeElement===document.querySelector("[data-e=model]") && document.querySelector("[data-e=model]").value==="DeepSeek-Flash"');
        await type('[data-e=model]', '-x');
        await pick('[data-sel=effort]', 'high');
        await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
        await verify('UI28 编辑 Qoder：model、effort 写进执行者配置，声明不动', async () => { const c = await readConfig(); assert.equal(c.profiles['qoder-cn'].model, 'DeepSeek-Flash-x'); assert.equal(c.profiles['qoder-cn'].effort, 'high'); assert.equal(c.generics['qoder-cn'].executable, 'qoderclicn'); });

        // ---- 4b. Codex 的编辑里也有"升级到"（假 Codex 由验收环境的 AR_TEST_AGENT 提供；检查完把这个执行者去掉）----
        const withCodex = await readConfig();
        withCodex.profiles.codex = { adapter: 'codex', label: 'Codex 测试', enabled: true, auth: 'login' };
        await writeFile(config, jsonStr(withCodex));
        await agentsPage(); await wait('!!document.querySelector("[data-agent=codex]")', 'UI28 Codex 执行者行出现');
        const codexEdit = async () => { await press('[data-more-agent=codex]'); await press(await ctxItem('编辑')); await wait('!!document.querySelector(".sheet [data-setting=model]") && !!document.querySelector(".sheet [data-sel=escalate]")'); };
        await codexEdit();
        await check('UI28 编辑 Codex：设置项之外有"升级到"，默认是不升级', `document.querySelector('.sheet [data-sel=escalate]').textContent.trim() === ${jsonStr(gx.escalateNone)} && document.querySelector('.sheet').textContent.includes(${jsonStr(gx.escalateHelp)})`);
        await press('[data-sel=escalate]'); await wait('!!document.querySelector(".optmenu")');
        await assertMenuVisible('UI28 Codex 升级到下拉');
        await check('UI28 Codex 的升级到下拉：不升级加其他已启用的执行者，不含自己', `(() => { const labels = [...document.querySelectorAll('.optmenu button')].map(b => [...b.querySelectorAll('span')].find(s => !s.classList.contains('ri-sp')).textContent.trim()); return labels[0] === ${jsonStr(gx.escalateNone)} && labels.includes('Fake Ok') && !labels.includes('Codex 测试'); })()`);
        await press(await option('Fake Ok')); await wait('!document.querySelector(".optmenu")');
        await verify('UI28 Codex 升级到选另一个执行者：马上写进 config.json', async () => { for (let i = 0; i < 40 && (await readConfig()).profiles.codex.escalate !== 'ok'; i++) await pause(100); assert.equal((await readConfig()).profiles.codex.escalate, 'ok'); });
        await check('UI28 Codex 升级到选中后下拉显示所选执行者，焦点回到下拉', `document.querySelector('[data-sel=escalate]').textContent.trim() === 'Fake Ok' && document.activeElement === document.querySelector('[data-sel=escalate]')`);
        await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
        await agentsPage(); await codexEdit();
        await check('UI28 再次编辑 Codex：升级到显示上次选的执行者', 'document.querySelector("[data-sel=escalate]").textContent.trim()==="Fake Ok"');
        await pick('[data-sel=escalate]', gx.escalateNone);
        await verify('UI28 Codex 改回"不升级"：escalate 消失', async () => { for (let i = 0; i < 40 && 'escalate' in (await readConfig()).profiles.codex; i++) await pause(100); assert.ok(!('escalate' in (await readConfig()).profiles.codex)); });
        await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
        const withoutCodex = await readConfig(); delete withoutCodex.profiles.codex;
        await writeFile(config, jsonStr(withoutCodex));
        await agentsPage(); await wait('!document.querySelector("[data-agent=codex]")');

        // ---- 5. 导出与从文件导入 ----
        fileDialogs.save.push(exported);
        await press('[data-more-agent=custom]'); await press(await ctxItem('导出声明'));
        await wait(`!!document.querySelector('.notice')`, 'UI28 导出提示');
        await check('UI28 导出声明：提示 gx.exportDone(文件)', `document.querySelector('.notice').textContent === ${jsonStr(gx.exportDone(exported))}`);
        await verify('UI28 导出声明：文件是 agentrouter-agent，带声明，没有本机状态', async () => {
            const bundle = JSON.parse(await readFile(exported, 'utf8'));
            assert.equal(bundle.kind, 'agentrouter-agent'); assert.equal(bundle.name, 'custom'); assert.deepEqual(bundle.generic, (await readConfig()).generics.custom);
            assert.ok(!('enabled' in bundle.profile));
        });
        await wait('!document.querySelector(".notice")', 'UI28 导出提示自己消失', 15000);
        await press('[data-more-agent=custom]'); await press(await ctxItem('删除')); await press('.confirm-actions .danger');
        await wait('!document.querySelector("[data-agent=custom]")');
        await verify('UI28 删除后 config.json 里没有这个执行者和它的声明', async () => { const c = await readConfig(); assert.equal(c.profiles.custom, undefined); assert.equal(c.generics.custom, undefined); });
        fileDialogs.open.push(exported);
        await openWizard();
        await press('[data-preset="@file"]'); await press('[data-w-act=next]');
        await wait('!!document.querySelector("[data-w-result]")', 'UI28 从文件导入后的测试结果', 60000);
        await check('UI28 从文件导入：直接进入第 3 步测试，通过', 'document.querySelector("[data-w-result]").dataset.wResult==="ok" && document.querySelector(".wiz-steps .on").textContent.includes("测试")');
        await verify('UI28 从文件导入：执行者回来了，声明与导出前相同', async () => { const c = await readConfig(); assert.equal(c.profiles.custom.adapter, 'generic'); assert.deepEqual(c.generics.custom.args, [okCli, 'run', '{promptFile}']); assert.equal(c.generics.custom.output.map.length, 2); });
        await press('[data-w-act=done]'); await wait('!document.querySelector(".sheet") && !!document.querySelector("[data-agent=custom]")');
        // 取消文件对话框：什么都不发生；坏文件：显示原因，不写配置。
        const before = await readFile(config, 'utf8');
        await openWizard(); await press('[data-preset="@file"]'); await press('[data-w-act=next]');
        await wait('!document.querySelector("[data-w-act=next]")?.disabled && !!document.querySelector(".sheet .preset.on")');
        await check('UI28 从文件导入：取消文件对话框后仍停在第 1 步', 'document.querySelector(".wiz-steps .on").textContent.includes("选类型") && !document.querySelector(".sheet-fail")');
        const bad = path.join(work, 'bad.json');
        await writeFile(bad, jsonStr({ kind: 'agentrouter-agent', v: 1, name: 'bad', profile: { adapter: 'nope' }, generic: null }));
        fileDialogs.open.push(bad);
        await press('[data-w-act=next]'); await wait('!!document.querySelector(".sheet .banner.fail")');
        await check('UI28 从文件导入：文件不合法时显示核心的原因，仍在第 1 步', 'document.querySelector(".sheet .banner.fail").textContent.includes("profile.adapter") && document.querySelector(".wiz-steps .on").textContent.includes("选类型")');
        await verify('UI28 取消与坏文件都不改 config.json', async () => { assert.equal(await readFile(config, 'utf8'), before); });
        await closeSheet();
        await verify('UI28 文件对话框桩被用到：打开 4 次（浏览程序、导入成功、取消、坏文件）、保存 1 次（导出）', () => { assert.equal(fileDialogs.openRequests.length, 4); assert.equal(fileDialogs.saveRequests.length, 1); });
        await check('UI28 页面上没有任何密钥值', '!document.body.innerHTML.includes("sk-ui28")');
    } finally {
        fileDialogs.stub = false;
        win.setContentSize(original.size[0], original.size[1]); nativeTheme.themeSource = original.theme;
        if (configBefore === null) await rm(config, { force: true }); else await writeFile(config, configBefore);
        if (secretsBefore === null) await rm(secretsFile, { force: true }); else await writeFile(secretsFile, secretsBefore);
    }
    // 后面的检查从设置页开始（与 capturePreferences 的结尾一致）。
    await press('[data-page=tasks]'); await press('[data-page=settings]'); await wait('!!document.querySelector("[data-pref=notifications]")');
}
