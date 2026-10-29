import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { nativeTheme, type BrowserWindow } from 'electron';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ag, gx, ro } from '../shared/copy';
import type { Harness } from './shots-input';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';
import { fileDialogs } from './console.mjs';
import { effects } from './effects';
// 演示的执行者 B 与限流数据和 npm run demo 同源（tools/demo/data.mjs 的 demoExecutorB、demoLimits）。
// @ts-ignore —— 演示数据是零依赖 .mjs，没有类型声明；打包时由 esbuild 一并打包。
import { demoExecutorB, demoLimits } from '../../../tools/demo/data.mjs';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, env: appEnv });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return String(r.stdout).trim();
};

// 探针用的假目录（Stage07c 144）：验收环境的假 Codex（AR_TEST_AGENT 指向的脚本）原来只认 --version / login status / exec，其余以 2 退出；
// 这里在脚本最前面加一段"debug models 打印和真实输出同样结构的 JSON（模型是编造的）"，探针（ar agents models <名> --probe）就能查到：
// test-pro 支持 low / medium / high / max（默认 medium），test-mini 只支持 low / medium（默认 low），test-hidden 不是 list 可见，探针要去掉。
// 返回恢复函数（写回原脚本）。不联网、不用真实 Codex。
export async function fakeCodexModels(home: string) {
    const script = path.join(home, 'fake-codex.cjs');
    assert.ok(path.relative(home, script) === 'fake-codex.cjs', '假 Codex 必须在隔离目录里');
    const original = await readFile(script, 'utf8');
    const level = (effort: string) => ({ effort, description: effort });
    const output = { models: [
        { slug: 'test-pro', display_name: 'Test Pro', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'max'].map(level) },
        { slug: 'test-mini', display_name: 'Test Mini', visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'medium'].map(level) },
        { slug: 'test-hidden', display_name: 'Test Hidden', visibility: 'hide', default_reasoning_level: 'low', supported_reasoning_levels: [level('low')] },
    ] };
    await writeFile(script, `if(process.argv.slice(2).join(' ')==='debug models'){process.stdout.write(${JSON.stringify(JSON.stringify(output))});process.exit(0);}\n${original}`);
    return async () => { await writeFile(script, original); };
}

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
    // 限流标记（limits.json）：测试里会写一条，结束时恢复原样。
    const limitsFile = path.join(home, 'limits.json'), limitsBefore = await readFile(limitsFile, 'utf8').catch(() => null);
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
    // 探针说明里的时间每次不同：把文案里的 00:00 换成 \d\d:\d\d 得到匹配用的正则。
    const timeRegex = (text: string) => new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('00:00', '\\d\\d:\\d\\d') + '$');
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
    fileDialogs.stub = true; fileDialogs.open.length = 0; fileDialogs.save.length = 0; fileDialogs.openRequests.length = 0; fileDialogs.saveRequests.length = 0;
    try {
        await agentsPage();

        // ---- 导入第 1 步：新增的卡片 ----
        await openWizard();
        await check('UI28 第 1 步：预设卡片后面固定两张——自定义 CLI、从文件导入，文案来自 gx', `(() => { const cards = [...document.querySelectorAll('.sheet .preset')], names = cards.map(c => c.dataset.preset); const last2 = cards.slice(-2); return names.slice(-2).join() === '@custom,@file' && last2[0].querySelector('b').textContent === ${jsonStr(gx.custom)} && last2[0].querySelector('.pk > span').textContent === ${jsonStr(gx.customDesc)} && last2[1].querySelector('b').textContent === ${jsonStr(gx.fromFile)} && last2[1].querySelector('.pk > span').textContent === ${jsonStr(gx.fromFileDesc)} && names.includes('openai-compat') && names.includes('qoder-cn'); })()`);
        // 改写（112）：原断言 names 里同时有 qoder-cn 和 qoder → 新断言只有 qoder-cn（Qoder 合并成一张，默认预设 qoder-cn），qoder 不再单独成卡；原因：同一服务只放一张卡片。
        const presetList: any[] = await evaluate(`window.dock.console('agents:presets').then(r => r.presets)`);
        const presetOf = (name: string) => presetList.find(x => x.name === name);
        await check('UI28 第 1 步：10 张卡片（顺序按 order），Xiaomi MiMo / Claude Code / Qoder 各合并成一张，data-card 与 data-preset（组里默认预设）正确，标题与说明逐字等于 presets --json 的 card', `(() => {
            const cards = [...document.querySelectorAll('.sheet .preset')], names = cards.map(c => c.dataset.preset);
            const merged = (name, c) => { const el = cards.find(x => x.dataset.preset === name); return !!el && el.dataset.card === c.id && el.querySelector('b').textContent === c.title && el.querySelector('.pk > span').textContent === c.description; };
            return names.length === 10 && names.join() === 'deepseek,mimo,claude-native,compat,codex,qoder-cn,deepseek-harness,openai-compat,@custom,@file'
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
        // ---- 181：模型查询还没回来就切换版本，旧查询回来不能把表单改回旧版本（D101 全量 shots 发现）----
        // 做法：先保存国内版的密钥（假值），触发一次被拖慢 1.5 秒的模型查询；查询进行中把 secrets:status 也拖慢，点"国际版"，
        // 让旧查询恰好落在切换后"重新检测密钥"的等待里。等一切结束后，名称、显示名、密钥变量都应是国际版的，再切回国内版同样。
        const versionValues = `(() => { const name = document.querySelector('[data-w=name]').value, on = document.querySelector('.sheet .segm button.on').textContent; return JSON.stringify([name, document.querySelector('[data-w=label]').value, document.querySelector('[data-w=secretVar]').value, on]); })()`;
        effects.consoleDelay['agents:models'] = 1500;
        try {
            await type('[data-w=secret]', 'sk-ui181-fake-0001'); await press('[data-w-act=save-secret]');
            await wait(`document.querySelector('[data-w-status]')?.textContent === ${jsonStr(ag.keySet)} && document.querySelector('.sheet [data-probe-refresh]')?.disabled && document.querySelector('.sheet [data-probe-refresh]').textContent === ${jsonStr(ag.refreshingList)}`, 'UI28 181 国内版模型查询进行中');
            effects.consoleDelay['secrets:status'] = 6000;
            await press('[data-w-variant=qoder]');
            // 等过 secrets:status 的延迟（6 秒）：旧查询（最多还剩 1.5 秒加核心耗时）和重新检测密钥都已结束。
            await pause(8000);
            delete effects.consoleDelay['secrets:status'];
            const intlValues = await evaluate(versionValues) as string;
            await check('UI28 181 模型查询进行中点"国际版"：等旧查询回来后，名称（qoder 系）、显示名、密钥变量都是国际版的，分段按钮是国际版', `(() => { const [name, label, secretVar, on] = JSON.parse(${jsonStr(intlValues)}); return name.startsWith('qoder') && !name.startsWith('qoder-cn') && label === ${jsonStr(intlPreset.label)} && secretVar === ${jsonStr(Object.values(intlPreset.secrets)[0])} && on === ${jsonStr(intlPreset.variant.option)}; })()`);
            await press('[data-w-variant=qoder-cn]');
            await wait(`document.querySelector('[data-w-status]')?.textContent === ${jsonStr(ag.keySet)} && !document.querySelector('.sheet [data-probe-refresh]').disabled`, 'UI28 181 切回国内版后查询结束', 30000);
            const cnValues = await evaluate(versionValues) as string;
            await check('UI28 181 再切回国内版：名称（qoder-cn）、显示名、密钥变量都是国内版的，分段按钮是国内版', `(() => { const [name, label, secretVar, on] = JSON.parse(${jsonStr(cnValues)}); return name.startsWith('qoder-cn') && label === ${jsonStr(cnPreset.label)} && secretVar === ${jsonStr(Object.values(cnPreset.secrets)[0])} && on === ${jsonStr(cnPreset.variant.option)}; })()`);
            // ---- 189：下拉菜单打开期间模型查询返回、向导重画把下拉按钮换成新元素，Esc 后焦点要落在页面上现在的下拉按钮上 ----
            await press('.sheet [data-probe-refresh]');
            await wait(`document.querySelector('.sheet [data-probe-refresh]')?.disabled`, 'UI28 189 查询进行中');
            await press('[data-sel=model]'); await wait('!!document.querySelector(".optmenu")');
            const oldModelButton = `window.__ui189Old = document.querySelector('[data-sel=model]'), true`;
            await evaluate(oldModelButton);
            await wait(`!document.querySelector('.sheet [data-probe-refresh]')?.disabled && document.querySelector('[data-sel=model]') !== window.__ui189Old`, 'UI28 189 查询返回、下拉按钮被重画换掉', 30000);
            await key('Escape');
            await check('UI28 189 下拉菜单打开期间查询返回重画后按 Esc：菜单关了、模态框还在，焦点在页面上现在的模型下拉按钮上（不是已被换掉的旧按钮，也不是 body）', `!document.querySelector('.optmenu') && !!document.querySelector('.sheet') && !window.__ui189Old.isConnected && document.activeElement === document.querySelector('[data-sel=model]') && document.activeElement !== document.body`);
        } finally { delete effects.consoleDelay['agents:models']; delete effects.consoleDelay['secrets:status']; }

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
        // 事件映射的框（155 W5）：新加一行空行，两个框空着时按 → 填入灰色示例（占位文字），再按不变，退格清空后又为空；检查完删掉这一行。
        await press('[data-map-add]'); await wait('document.querySelectorAll(".map-row").length === 3');
        await press('[data-m=when][data-i="2"]');
        await check('UI28 示例：事件映射新行的两个框都是空的，占位文字是示例', `(() => { const w = document.querySelector('[data-m=when][data-i="2"]'), f = document.querySelector('[data-m=fields][data-i="2"]'); return w.value === '' && f.value === '' && w.placeholder === 'type = message' && f.placeholder === 'text ← content'; })()`);
        await check('UI28 示例：事件映射一节的说明末尾也是「 · 」加 gx.exampleHint', `document.querySelector('[data-m=when][data-i="2"]').closest('.fld').querySelector('.fl span').textContent === ${jsonStr(`${gx.mappingHelp} · ${gx.exampleHint}`)}`);
        await key('Right');
        await check('UI28 示例：事件映射空的「条件」框按 → 填入 type = message，光标在末尾，焦点还在这个框，并触发更新（保存暂时禁用等重新校验）', `(() => { const i = document.querySelector('[data-m=when][data-i="2"]'); return i.value === 'type = message' && i.value === i.placeholder && i.selectionStart === i.value.length && i.selectionEnd === i.value.length && document.activeElement === i && document.querySelector('[data-c-act=save]').disabled; })()`);
        await key('Right');
        await check('UI28 示例：事件映射的框不为空时再按 → 不再改变', `document.querySelector('[data-m=when][data-i="2"]').value === 'type = message'`);
        await press('[data-m=fields][data-i="2"]');
        await key('Right');
        await check('UI28 示例：事件映射空的「字段」框按 → 填入 text ← content，光标在末尾', `(() => { const i = document.querySelector('[data-m=fields][data-i="2"]'); return i.value === 'text ← content' && i.selectionStart === i.value.length && document.activeElement === i; })()`);
        for (let i = 0; i < 'text ← content'.length; i++) await key('Backspace');
        await check('UI28 示例：退格清空事件映射的字段框后又为空', `document.querySelector('[data-m=fields][data-i="2"]').value === ''`);
        await press('[data-map-del="2"]'); await wait('document.querySelectorAll(".map-row").length === 2');
        await wait('!document.querySelector("[data-c-act=save]").disabled', 'UI28 事件映射示例检查完成后重新校验通过');
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
        // 探针（144）：第 2 步密钥还没设置时不查，模型下面写 probeFallback('还没有设置密钥')。
        // 改写（168，D102）：原断言"没有'刷新列表'（导入前没有可查询的执行者）" → 新断言"有'刷新列表'但禁用（密钥未设置不查询）" → 原因：导入前就能按预设查（ar agents models --preset … --probe）。
        await check('UI28 导入第 2 步（Claude Code · API Key，密钥未设置）：不查询，模型说明是 probeFallback("还没有设置密钥")，"刷新列表"禁用', `document.querySelector('[data-w-status]').textContent === '未设置' && document.querySelector('.sheet [data-probe-note]').textContent === ${jsonStr(ag.probeFallback('还没有设置密钥'))} && document.querySelector('.sheet [data-probe-refresh]')?.disabled === true`);
        await press('[data-w-variant=claude-subscription]'); await wait('document.querySelector("[data-w=secretVar]")?.value === "CLAUDE_CODE_OAUTH_TOKEN"');
        // 改写（168，D102）：原断言"还没有可查询的执行者，模型说明沿用常用值的说明（gx.modelHelpPreset），没有'刷新列表'" → 新断言"进入第 2 步就查了：订阅令牌不能查询，说明是 probeFallback(订阅令牌不能查询模型列表)，'刷新列表'可点" → 原因：同上。
        await wait(`document.querySelector('.sheet [data-probe-note]')?.textContent === ${jsonStr(ag.probeFallback('订阅令牌不能查询模型列表'))}`, 'UI28 导入第 2 步（订阅令牌）：导入前的查询结果');
        await check('UI28 导入第 2 步（订阅令牌，密钥已设置、还没导入）：已按预设查过，说明是 probeFallback(订阅令牌不能查询模型列表)，"刷新列表"可点', `!document.querySelector('.sheet [data-probe-refresh]').disabled && document.querySelector('.sheet [data-probe-refresh]').textContent === ${jsonStr(ag.refreshList)}`);
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
        // 探针（144）：这个 Claude 类执行者用订阅令牌，核心查不了模型列表：说明是 probeFallback(原因)，模型仍是输入框（值不动），"刷新列表"可点。
        await wait('document.querySelector(".sheet [data-probe-note]").textContent !== "" && !document.querySelector(".sheet [data-probe-refresh]").disabled', 'UI28 Claude 编辑：探针查完');
        await check('UI28 编辑 Claude 类执行者（订阅令牌）：说明是 probeFallback(订阅令牌不能查询模型列表)，模型输入框里是 claude-sonnet-5-5，右边有"刷新列表"', `document.querySelector('.sheet [data-probe-note]').textContent === ${jsonStr(ag.probeFallback('订阅令牌不能查询模型列表'))} && document.querySelector('.sheet [data-e=model]').value === 'claude-sonnet-5-5' && document.querySelector('.sheet [data-probe-refresh]').textContent === ${jsonStr(ag.refreshList)}`);
        effects.consoleDelay['agents:models'] = 1500;
        try {
            await press('.sheet [data-probe-refresh]');
            await check('UI28 编辑里点"刷新列表"：查询中按钮禁用并显示"正在查询…"，输入框里的值不丢', `document.querySelector('.sheet [data-probe-refresh]').disabled && document.querySelector('.sheet [data-probe-refresh]').textContent === ${jsonStr(ag.refreshingList)} && document.querySelector('.sheet [data-e=model]').value === 'claude-sonnet-5-5'`);
            await wait('!document.querySelector(".sheet [data-probe-refresh]").disabled', 'UI28 刷新列表查完', 30000);
        } finally { delete effects.consoleDelay['agents:models']; }
        await check('UI28 刷新完成：按钮恢复"刷新列表"，说明仍是 probeFallback，焦点回到按钮', `document.querySelector('.sheet [data-probe-refresh]').textContent === ${jsonStr(ag.refreshList)} && document.querySelector('.sheet [data-probe-note]').textContent === ${jsonStr(ag.probeFallback('订阅令牌不能查询模型列表'))} && document.activeElement === document.querySelector('.sheet [data-probe-refresh]')`);
        await shots('edit-claude-probe');
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
        // 改写（150，T4）：原断言 表单行逐项等于 显示名、模型、推理强度、升级到 → 新断言 逐项等于 显示名、模型、推理强度、可担任、可能用到的模型范围、升级到（原来的四项顺序不变，中间多两项）；原因：编辑里新增"可担任"和"可能用到的模型范围"。
        await check('UI28 编辑通用适配器执行者（Qoder）：显示名、模型、推理强度、可担任、可能用到的模型范围、升级到六项，没有接口地址和密钥项；当前值选中', `[...document.querySelectorAll('.sheet .fl b')].map(b => b.textContent.replace('*', '')).join() === ${jsonStr(['显示名', '模型', '推理强度', ag.canDo, ag.modelRange, '升级到'].join())} && document.querySelector('[data-sel=model]').textContent.trim() === 'DeepSeek-Flash' && document.querySelector('[data-sel=effort]').textContent.trim() === 'ultracode'`);
        await pick('[data-sel=model]', gx.modelCustom);
        await check('UI28 编辑：模型选"自定义…"后变成输入框并取得焦点', 'document.activeElement===document.querySelector("[data-e=model]") && document.querySelector("[data-e=model]").value==="DeepSeek-Flash"');
        await type('[data-e=model]', '-x');
        await pick('[data-sel=effort]', 'high');
        await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
        await verify('UI28 编辑 Qoder：model、effort 写进执行者配置，声明不动', async () => { const c = await readConfig(); assert.equal(c.profiles['qoder-cn'].model, 'DeepSeek-Flash-x'); assert.equal(c.profiles['qoder-cn'].effort, 'high'); assert.equal(c.generics['qoder-cn'].executable, 'qoderclicn'); });

        // ---- 4b. Codex 的编辑（表单式，Stage07c T3）里也有"升级到"（假 Codex 由验收环境的 AR_TEST_AGENT 提供，探针用假目录 fakeCodexModels；检查完把这个执行者去掉）----
        // 改写（144，T3）：原来选完"升级到"马上写进 config.json（设置式，底栏"完成"）→ 现在选完还没点"保存"时 config.json 不变，点"保存"才写入；原因：Codex 的编辑改成表单式。
        const restoreModels = await fakeCodexModels(home);
        const withCodex = await readConfig();
        withCodex.profiles.codex = { adapter: 'codex', label: 'Codex 测试', enabled: true, auth: 'login' };
        await writeFile(config, jsonStr(withCodex));
        await agentsPage(); await wait('!!document.querySelector("[data-agent=codex]")', 'UI28 Codex 执行者行出现');
        const codexEdit = async () => { await press('[data-more-agent=codex]'); await press(await ctxItem('编辑')); await wait('!!document.querySelector(".sheet [data-e=label]") && !!document.querySelector(".sheet [data-sel=escalate]")'); };
        await codexEdit();
        await check('UI28 编辑 Codex：表单里有"升级到"，默认是不升级；底栏是取消 / 保存', `document.querySelector('.sheet [data-sel=escalate]').textContent.trim() === ${jsonStr(gx.escalateNone)} && document.querySelector('.sheet').textContent.includes(${jsonStr(gx.escalateHelp)}) && [...document.querySelectorAll('.sheet-btns .btn')].map(b => b.textContent.trim()).join() === ${jsonStr(['取消', '保存'].join())}`);
        await press('[data-sel=escalate]'); await wait('!!document.querySelector(".optmenu")');
        await assertMenuVisible('UI28 Codex 升级到下拉');
        await check('UI28 Codex 的升级到下拉：不升级加其他已启用的执行者，不含自己', `(() => { const labels = [...document.querySelectorAll('.optmenu button')].map(b => [...b.querySelectorAll('span')].find(s => !s.classList.contains('ri-sp')).textContent.trim()); return labels[0] === ${jsonStr(gx.escalateNone)} && labels.includes('Fake Ok') && !labels.includes('Codex 测试'); })()`);
        await press(await option('Fake Ok')); await wait('!document.querySelector(".optmenu")');
        await check('UI28 Codex 升级到选中后下拉显示所选执行者，焦点回到下拉', `document.querySelector('[data-sel=escalate]').textContent.trim() === 'Fake Ok' && document.activeElement === document.querySelector('[data-sel=escalate]')`);
        await verify('UI28 Codex 升级到选完还没点保存：config.json 的 codex 没有 escalate', async () => { assert.ok(!('escalate' in (await readConfig()).profiles.codex)); });
        await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
        await verify('UI28 Codex 点保存：escalate 写进 config.json', async () => { assert.equal((await readConfig()).profiles.codex.escalate, 'ok'); });
        await agentsPage(); await codexEdit();
        await check('UI28 再次编辑 Codex：升级到显示上次选的执行者', 'document.querySelector("[data-sel=escalate]").textContent.trim()==="Fake Ok"');
        await pick('[data-sel=escalate]', gx.escalateNone);
        await verify('UI28 Codex 改回"不升级"、还没点保存：escalate 仍在 config.json 里', async () => { assert.equal((await readConfig()).profiles.codex.escalate, 'ok'); });
        await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
        await verify('UI28 Codex 点保存后 escalate 消失', async () => { assert.ok(!('escalate' in (await readConfig()).profiles.codex)); });
        // 探针（假目录）：模型下拉里是假目录的 test-pro / test-mini，说明来自程序；换模型推理强度的选项跟着变；"刷新列表"重新查。
        await agentsPage(); await codexEdit();
        await wait('!document.querySelector(".sheet [data-probe-refresh]").disabled && document.querySelector(".sheet [data-probe-note]").textContent !== ""', 'UI28 Codex 编辑：探针查完');
        await check('UI28 Codex 编辑：说明是 probeFrom("program", HH:MM)，模型下拉带"刷新列表"', `${timeRegex(ag.probeFrom('program', '00:00'))}.test(document.querySelector('.sheet [data-probe-note]').textContent) && document.querySelector('.sheet [data-probe-refresh]').textContent === ${jsonStr(ag.refreshList)}`);
        await press('[data-sel=model]'); await wait('!!document.querySelector(".optmenu")');
        await check('UI28 Codex 模型下拉：假目录里 visibility 为 list 的两个模型，test-hidden 被去掉', `(() => { const labels = [...document.querySelectorAll('.optmenu button')].map(b => [...b.querySelectorAll('span')].find(s => !s.classList.contains('ri-sp')).textContent.trim()); return labels.includes('test-pro') && labels.includes('test-mini') && !labels.includes('test-hidden') && labels.at(-1) === ${jsonStr(gx.modelCustom)}; })()`);
        await press(await option('test-mini')); await wait('!document.querySelector(".optmenu")');
        await check('UI28 选 test-mini：推理强度说明是 effortSupported(low / medium，默认 low)', `document.querySelector('.sheet').textContent.includes(${jsonStr(ag.effortSupported('low / medium', 'low'))})`);
        await pick('[data-sel=model]', 'test-pro');
        await check('UI28 换成 test-pro：推理强度说明换成 effortSupported(low / medium / high / max，默认 medium)', `document.querySelector('.sheet').textContent.includes(${jsonStr(ag.effortSupported('low / medium / high / max', 'medium'))}) && !document.querySelector('.sheet').textContent.includes(${jsonStr(ag.effortSupported('low / medium', 'low'))})`);
        await shots('edit-codex');
        await press('.sheet-btns .btn:first-child'); await wait('!document.querySelector(".sheet")');
        await restoreModels();
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
        // ---- 5b. 导入向导第 2 步导入之前就查模型列表（168，D102）----
        // 假接口在本机（127.0.0.1，随机端口，测完关闭）：/fake/models 返回两个模型（预设里的 deepseek-v4-pro 带推理强度 low / high，另一个是预设里没有的），别的路径 404。
        // 查询走 agents:models（payload 带 preset 与 probe: true）→ ar agents models --preset deepseek --base-url … --probe；不访问任何真实接口。
        const asked: { url: string; auth: string }[] = [];
        const fakeApi = http.createServer((request, response) => {
            asked.push({ url: request.url ?? '', auth: String(request.headers.authorization ?? '') });
            if ((request.url ?? '').startsWith('/fake/models')) {
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify({ data: [{ id: 'deepseek-v4-pro', display_name: 'Fake Pro', effort: { supported_levels: ['low', 'high'], default_level: 'low' } }, { id: 'deepseek-fake-b' }] }));
            } else { response.statusCode = 404; response.end('{}'); }
        });
        await new Promise<void>(resolve => fakeApi.listen(0, '127.0.0.1', resolve));
        try {
            const fakeBase = `http://127.0.0.1:${(fakeApi.address() as AddressInfo).port}/fake`, fakeKey = 'sk-ui168-fake-0001';
            const dsPreset = presetOf('deepseek');
            assert.ok(dsPreset.modelOptions?.length >= 2, 'deepseek 预设要有模型可选值');
            // 当前打开的下拉里的选项（去掉最后一项"自定义…"），看完按 Esc 关掉。
            const menuLabels = async (selector: string) => {
                await press(selector); await wait('!!document.querySelector(".optmenu")');
                const labels: string[] = await evaluate(`[...document.querySelectorAll('.optmenu button')].map(b => [...b.querySelectorAll('span')].find(s => !s.classList.contains('ri-sp')).textContent.trim())`);
                await key('Escape'); await wait('!document.querySelector(".optmenu")');
                return labels.filter(label => label !== gx.modelCustom);
            };
            // 把输入框里的内容换成别的：点进去、移到末尾、删光，再敲新的。
            const retype = async (selector: string, value: string) => {
                await press(selector); await key('End');
                const length = Number(await evaluate(`document.querySelector(${jsonStr(selector)}).value.length`));
                for (let i = 0; i < length; i++) await key('Backspace');
                await type(selector, value);
            };
            await agentsPage(); await openWizard();
            await press('[data-preset=deepseek]'); await press('[data-w-act=next]'); await wait('!!document.querySelector(".sheet [data-w=baseUrl]")');
            await check('UI28 导入第 2 步（DeepSeek，密钥未设置）：不查询，说明是 probeFallback("还没有设置密钥")，"刷新列表"在模型下拉右边但禁用，下拉是预设的可选值', `document.querySelector('[data-w-status]').textContent === '未设置' && document.querySelector('.sheet [data-probe-note]').textContent === ${jsonStr(ag.probeFallback('还没有设置密钥'))} && document.querySelector('.sheet [data-probe-refresh]').disabled && document.querySelector('.sheet [data-probe-refresh]').previousElementSibling === document.querySelector('.sheet [data-sel=model]').closest('.selw')`);
            assert.deepEqual(await menuLabels('.sheet [data-sel=model]'), dsPreset.modelOptions);
            // 接口地址改成假接口，设置密钥：保存密钥后查一次，下拉换成假接口给的，说明是"列表来自接口 · HH:MM 更新"。
            await retype('[data-w=baseUrl]', fakeBase);
            await type('[data-w=secret]', fakeKey); await press('[data-w-act=save-secret]');
            await wait(`${timeRegex(ag.probeFrom('api', '00:00')).toString()}.test(document.querySelector('.sheet [data-probe-note]')?.textContent ?? '')`, 'UI28 导入第 2 步：假接口查到的说明', 30000);
            await check('UI28 导入第 2 步：说明是 probeFrom("api", HH:MM)，"刷新列表"可点，密码框已清空', `${timeRegex(ag.probeFrom('api', '00:00')).toString()}.test(document.querySelector('.sheet [data-probe-note]').textContent) && !document.querySelector('.sheet [data-probe-refresh]').disabled && document.querySelector('.sheet [data-probe-refresh]').textContent === ${jsonStr(ag.refreshList)} && document.querySelector('[data-w=secret]').value === ''`);
            assert.deepEqual(await menuLabels('.sheet [data-sel=model]'), ['deepseek-v4-pro', 'deepseek-fake-b']);
            await verify('UI28 假接口收到了请求：地址 /fake/models，带导入向导里保存的密钥（Bearer）', () => { assert.ok(asked.some(r => r.url === '/fake/models' && r.auth === `Bearer ${fakeKey}`), `假接口收到的请求：${asked.map(r => r.url).join()}`); });
            await verify('UI28 导入之前查不写配置：config.json 里还没有 deepseek 执行者', async () => { assert.ok(!Object.keys((await readConfig()).profiles).some(name => name.startsWith('deepseek'))); });
            const found = asked.length;
            // 当前模型（预设的 deepseek-v4-pro）在接口给的列表里，推理强度的说明与下拉换成接口给的这个模型支持的。
            const effortText = `[...document.querySelectorAll('.sheet .fld')].find(f => f.querySelector('.fl b')?.textContent === ${jsonStr(gx.effort)}).querySelector('.fl span').textContent`;
            await check('UI28 查到后：推理强度说明是 effortSupported("low / high", "low")（来自接口）', `${effortText} === ${jsonStr(ag.effortSupported('low / high', 'low'))}`);
            const effortFound = await menuLabels('.sheet [data-sel=effort]');
            assert.ok(effortFound.includes('high') && !effortFound.includes('medium'), `推理强度下拉：${effortFound.join()}`);
            // 改接口地址（写完离开输入框）：旧结果作废，下拉退回预设值，说明提示点"刷新列表"重查，没有自动再查。
            await retype('[data-w=baseUrl]', `${fakeBase}-other`); await key('Tab');
            await wait(`!${timeRegex(ag.probeFrom('api', '00:00')).toString()}.test(document.querySelector('.sheet [data-probe-note]')?.textContent ?? '')`, 'UI28 改接口地址后说明变化');
            await check('UI28 改接口地址后：说明提示点"刷新列表"重查（不再是 probeFrom），"刷新列表"可点', `document.querySelector('.sheet [data-probe-note]').textContent.includes(${jsonStr(ag.refreshList)}) && !document.querySelector('.sheet [data-probe-refresh]').disabled && document.querySelector('.sheet [data-probe-refresh]').textContent === ${jsonStr(ag.refreshList)}`);
            assert.deepEqual(await menuLabels('.sheet [data-sel=model]'), dsPreset.modelOptions);
            assert.ok((await menuLabels('.sheet [data-sel=effort]')).includes('medium'), '推理强度下拉退回预设的可选值');
            assert.equal(asked.length, found, '改地址不会自动重查（假接口没有收到新请求）');
            // 再改回假接口，点"刷新列表"：又是查到的结果。
            await retype('[data-w=baseUrl]', fakeBase);
            await press('.sheet [data-probe-refresh]');
            await wait(`${timeRegex(ag.probeFrom('api', '00:00')).toString()}.test(document.querySelector('.sheet [data-probe-note]')?.textContent ?? '') && !document.querySelector('.sheet [data-probe-refresh]').disabled`, 'UI28 点"刷新列表"后又是查到的结果', 30000);
            await check('UI28 点"刷新列表"：说明又是 probeFrom("api", HH:MM)，焦点回到按钮，输入过的地址还在', `document.activeElement === document.querySelector('.sheet [data-probe-refresh]') && document.querySelector('[data-w=baseUrl]').value === ${jsonStr(fakeBase)}`);
            assert.deepEqual(await menuLabels('.sheet [data-sel=model]'), ['deepseek-v4-pro', 'deepseek-fake-b']);
            await verify('UI28 点"刷新列表"重查了一次：假接口又收到 /fake/models', () => { assert.ok(asked.length > found && asked.at(-1)!.url === '/fake/models'); });
            await shots('wizard-2-probe');
            // 退出向导（输入过的内容丢弃）。
            await key('Escape'); await wait('!!document.querySelector(".confirm-actions .danger")'); await press('.confirm-actions .danger'); await wait('!document.querySelector(".sheet")');
            await verify('UI28 退出向导后 config.json 没有变化（导入前的查询不写配置）', async () => { assert.ok(!Object.keys((await readConfig()).profiles).some(name => name.startsWith('deepseek'))); });

            // 不支持推理强度的预设（DeepSeek Harness，supportsEffort: false，D87）：第 2 步没有"推理强度"这一行。
            await openWizard();
            await press('[data-preset=deepseek-harness]'); await press('[data-w-act=next]'); await wait('!!document.querySelector(".sheet [data-w=secretVar]")');
            await check('UI28 导入第 2 步（DeepSeek Harness，不支持推理强度）：没有"推理强度"这一行，也没有"已忽略"', `![...document.querySelectorAll('.sheet .fl b')].some(b => b.textContent.includes(${jsonStr(gx.effort)})) && !document.querySelector('.sheet [data-sel=effort]') && !document.querySelector('.sheet [data-effort-ignored]') && [...document.querySelectorAll('.sheet .fl b')].some(b => b.textContent.includes(${jsonStr(ag.model)}))`);
            await closeSheet();
            // 编辑里同样：导入一个，没写推理强度时整行隐藏；配置里已经写了的，原位置显示"这个执行者不支持推理强度，已忽略"，保存不动它。
            const added = await coreRun(['agents', 'add', '--preset', 'deepseek-harness', '--name', 'deepseek-harness'], { timeoutMs: 60000 });
            assert.equal(added.code, 0, added.stderr || added.json?.error);
            await agentsPage(); await wait('!!document.querySelector("[data-agent=deepseek-harness]")', 'UI28 dsh 行出现');
            await press('[data-more-agent=deepseek-harness]'); await press(await ctxItem('编辑')); await wait('!!document.querySelector(".sheet [data-role]")', 'UI28 编辑 dsh');
            await check('UI28 编辑 DeepSeek Harness（不支持推理强度，没写）：没有"推理强度"这一行', `![...document.querySelectorAll('.sheet .fl b')].some(b => b.textContent.includes(${jsonStr(gx.effort)})) && !document.querySelector('.sheet [data-sel=effort]') && !document.querySelector('.sheet [data-effort-ignored]')`);
            await closeSheet();
            const withEffort = await readConfig(); withEffort.profiles['deepseek-harness'].effort = 'high';
            await writeFile(config, jsonStr(withEffort));
            await agentsPage(); await wait('!!document.querySelector("[data-agent=deepseek-harness]")', 'UI28 dsh 行出现（写了推理强度）');
            await press('[data-more-agent=deepseek-harness]'); await press(await ctxItem('编辑')); await wait('!!document.querySelector(".sheet [data-role]")', 'UI28 编辑 dsh（写了推理强度）');
            await check('UI28 编辑 DeepSeek Harness（配置里已写 effort）：原位置是 effortUnsupported，没有推理强度下拉', `(() => { const f = [...document.querySelectorAll('.sheet .fld')].find(x => x.querySelector('.fl b')?.textContent === ${jsonStr(gx.effort)}); return !!f && f.querySelector('[data-effort-ignored]').textContent === ${jsonStr(ro.effortUnsupported)} && !document.querySelector('.sheet [data-sel=effort]'); })()`);
            await press('.sheet [data-role=reviewer]'); await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")');
            await verify('UI28 保存后推理强度原样保留（界面没有动它），roles 写进去了', async () => { const p = (await readConfig()).profiles['deepseek-harness']; assert.equal(p.effort, 'high'); assert.deepEqual(p.roles, ['executor']); });
            const withoutDsh = await readConfig(); delete withoutDsh.profiles['deepseek-harness']; if (withoutDsh.generics) delete withoutDsh.generics['deepseek-harness'];
            await writeFile(config, jsonStr(withoutDsh));
            await agentsPage(); await wait('!document.querySelector("[data-agent=deepseek-harness]")');
        } finally { await new Promise<void>(resolve => fakeApi.close(() => resolve())); }

        // ---- 6. 可担任 · 模型家族 · 限流标记（Stage07c 150，T4 / T7，D85、D83）----
        // 行里的数据来自 ar roles --json（可担任、家族）与 ar route config --json（限流，原文由核心给，D104）；
        // 编辑里改的"可担任""模型范围"点"保存"才写入（ar roles set）；"已恢复"走 ar route limits clear。限流标记是在隔离目录的 limits.json 里写一条。
        const clockOf = (ms: number) => { const d = new Date(ms), t = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); return d.toDateString() === new Date().toDateString() ? t : `${d.getMonth() + 1}月${d.getDate()}日 ${t}`; };
        const until = Date.now() + 20 * 60000, evidence = 'rate_limit_event status rejected';
        const rolesNow = async () => { const r = await coreRun(['roles'], { timeoutMs: 60000 }); assert.equal(r.code, 0, r.stderr || r.json?.error); return r.json as { families: string[]; lead: { profiles: string[]; families: string[]; source: string }; profiles: { name: string; roles: string[]; modelFamilies: string[]; families: string[]; familiesUnknown: boolean; familiesSource: string }[] }; };
        const both = ['executor', 'reviewer'].map(r => ag.roleNames[r]).join(' · ');
        const pageShots = async (name: string) => {
            for (const [w, ht, tag] of [[1160, 720, 'default'], [960, 600, 'min']] as const) for (const theme of ['dark', 'light'] as const) {
                win.setContentSize(w, ht); nativeTheme.themeSource = theme; await pause(350);
                await check(`UI28 ${name}（${theme}，${w}×${ht}）页面没有横向溢出，每个执行者行完整显示在窗口里`, `document.scrollingElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.xrow')].every(r => r.getBoundingClientRect().right <= innerWidth)`);
                await save(`agents-${name}-${theme}-${tag}`);
            }
            win.setContentSize(original.size[0], original.size[1]); nativeTheme.themeSource = 'dark'; await pause(350);
        };
        const withDs = await readConfig();
        withDs.profiles.ds = { adapter: 'claude-code', label: 'DS 测试', enabled: true, path: path.join(home, 'fake-claude.cjs'), env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_MODEL: 'deepseek-v4-pro' }, auth: 'token', secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_CODE_OAUTH_TOKEN' }, maxTurns: null };
        await writeFile(config, jsonStr(withDs));
        await writeFile(limitsFile, jsonStr({ v: 1, profiles: { ds: { kind: 'limit', until, since: Date.now(), evidence } } }));
        await agentsPage(); await wait('!!document.querySelector("[data-agent=ds] [data-limited]")', 'UI28 被限流的执行者行出现限流标签');
        await check('UI28 每个已启用的执行者行第二行末尾都有"可担任 …"和"家族 …"（家族未知时写 familyUnknown）', `(() => { const rows = [...document.querySelectorAll('[data-agent]')].filter(r => !r.querySelector('.x1').textContent.includes(${jsonStr(ag.disabled)})); return rows.length >= 4 && rows.every(r => { const x2 = r.querySelector('.x2'), a = r.querySelector('[data-roles]'), f = r.querySelector('[data-family-row]'); return a && f && x2.lastElementChild === f && x2.contains(a) && a.textContent.startsWith(${jsonStr(ag.canDoRow(''))}) && (f.textContent === ${jsonStr(ag.familyUnknown)} || f.textContent.startsWith(${jsonStr(ag.familyRow(''))})); }); })()`);
        await check('UI28 行里的值与核心一致：sonnet 可担任 执行者 · 审查者、家族 claude；ds 家族 deepseek；fake 执行者家族未知', `(() => { const t = (n, s) => document.querySelector('[data-agent=' + n + '] ' + s).textContent; return t('sonnet', '[data-roles]') === ${jsonStr(ag.canDoRow(both))} && t('sonnet', '[data-family-row]') === ${jsonStr(ag.familyRow('claude'))} && t('ds', '[data-family-row]') === ${jsonStr(ag.familyRow('deepseek'))} && t('ok', '[data-family-row]') === ${jsonStr(ag.familyUnknown)}; })()`);
        await verify('UI28 行里的家族和 ar roles --json 一致（界面不自己判断）', async () => { const view = await rolesNow(); const sonnet = view.profiles.find(x => x.name === 'sonnet')!, ds = view.profiles.find(x => x.name === 'ds')!; assert.deepEqual(sonnet.families, ['claude']); assert.deepEqual(ds.families, ['deepseek']); assert.equal(view.profiles.find(x => x.name === 'ok')!.familiesUnknown, true); });
        await check('UI28 被限流的执行者：info 标签带 time-line 图标，文字是 limitedUntil(恢复时间)，悬停提示是 limitedEvidence(原文)；只有这一个执行者有', `(() => { const tags = [...document.querySelectorAll('[data-limited]')], t = document.querySelector('[data-agent=ds] [data-limited]'); return tags.length === 1 && t.classList.contains('tag') && t.classList.contains('info') && !!t.querySelector('.ri-time-line') && t.textContent === ${jsonStr(ag.limitedUntil(clockOf(until)))} && t.getAttribute('title') === ${jsonStr(ag.limitedEvidence(evidence))} && t.closest('.x1') === document.querySelector('[data-agent=ds] .x1'); })()`);
        await check('UI28 限流标签旁有次按钮"已恢复"，悬停提示是 limitedClearHelp', `(() => { const b = document.querySelector('[data-agent=ds] [data-limited-clear=ds]'); return !!b && b.classList.contains('quiet') && b.textContent === ${jsonStr(ag.limitedClear)} && b.getAttribute('title') === ${jsonStr(ag.limitedClearHelp)} && document.querySelectorAll('[data-limited-clear]').length === 1; })()`);
        // 截图前把被限流的行滚到可见（真实滚动位置）。
        await evaluate('document.querySelector("[data-agent=ds]").scrollIntoView({ block: "end" }); true');
        await pageShots('roles-limited');
        // 点"已恢复"失败：配置读不了时核心拒绝，标签保留，横幅写 limitedClearFail(原因)。
        const goodConfig = await readFile(config, 'utf8');
        await writeFile(config, '{');
        try {
            await press('[data-limited-clear=ds]');
            await wait(`!![...document.querySelectorAll('[data-agents] .banner.fail')].find(b => b.textContent.includes(${jsonStr(ag.limitedClearFail(''))}))`, 'UI28 "已恢复"失败后的横幅');
            await check('UI28 "已恢复"失败：标签和按钮都还在，按钮可以再点', `!!document.querySelector('[data-agent=ds] [data-limited]') && !!document.querySelector('[data-limited-clear=ds]') && !document.querySelector('[data-limited-clear=ds]').disabled`);
        } finally { await writeFile(config, goodConfig); }
        await verify('UI28 "已恢复"失败：limits.json 里还有 ds', async () => { assert.ok((JSON.parse(await readFile(limitsFile, 'utf8')) as any).profiles.ds); });
        await agentsPage(); await wait('!!document.querySelector("[data-agent=ds] [data-limited]") && ![...document.querySelectorAll("[data-agents] .banner.fail")].length', 'UI28 配置恢复后重新进入页面');
        await press('[data-limited-clear=ds]');
        await wait('!document.querySelector("[data-limited]") && !document.querySelector("[data-limited-clear]")', 'UI28 点"已恢复"后标签消失');
        await verify('UI28 "已恢复"：limits.json 里没有 ds（ar route limits clear 清掉了）', async () => { assert.ok(!('ds' in (JSON.parse(await readFile(limitsFile, 'utf8')) as any).profiles)); });
        await check('UI28 "已恢复"成功后没有错误横幅，ds 行还在', '!document.querySelector("[data-agents] .banner.fail") && !!document.querySelector("[data-agent=ds]")');
        // 188（D125，原断言：185 的演示限流在 Codex 行；新断言：在"演示执行者 B"行，Codex 行没有；原因：演示里 Codex 要保持可用，新建任务走默认路由不能被限流跳过）：
        // npm run demo 写进公共目录的 config.json / limits.json（demoExecutorB、demoLimits）：演示执行者 B 行显示"额度到 HH:MM 恢复"，悬停是限流原文，旁边有"已恢复"；Codex 行没有。
        {
            const demoLimit = demoLimits(Date.now()), demoEntry = demoLimit.profiles[demoExecutorB.name] as { until: number; evidence: string };
            const configNow = await readFile(config, 'utf8'), withDemo = JSON.parse(configNow);
            withDemo.profiles.codex = { adapter: 'codex', label: 'Codex 测试', enabled: true, auth: 'login' };
            withDemo.profiles[demoExecutorB.name] = demoExecutorB.profile;
            try {
                await writeFile(config, jsonStr(withDemo));
                await writeFile(limitsFile, jsonStr(demoLimit));
                await agentsPage(); await wait(`!!document.querySelector("[data-agent=${demoExecutorB.name}] [data-limited]")`, 'UI188 演示的限流标签出现在演示执行者 B 行');
                await check('UI188 演示数据的限流：演示执行者 B 行的 info 标签写 limitedUntil(恢复时间)、悬停是 limitedEvidence(限流原文)，旁边有"已恢复"；Codex 行存在、没有限流标签；只有这一个执行者被限流', `(() => { const row = document.querySelector('[data-agent=${demoExecutorB.name}]'), t = row.querySelector('[data-limited]'); const codex = document.querySelector('[data-agent=codex]'); return row.textContent.includes(${jsonStr(demoExecutorB.profile.label)}) && document.querySelectorAll('[data-limited]').length === 1 && t.classList.contains('info') && t.textContent === ${jsonStr(ag.limitedUntil(clockOf(demoEntry.until)))} && t.getAttribute('title') === ${jsonStr(ag.limitedEvidence(demoEntry.evidence))} && !!row.querySelector('[data-limited-clear=${demoExecutorB.name}]') && !!codex && !codex.querySelector('[data-limited]') && !codex.querySelector('[data-limited-clear]'); })()`);
                // 截图前把被限流的行滚到可见（同上面 ds 那一次）。
                await evaluate(`document.querySelector("[data-agent=${demoExecutorB.name}]").scrollIntoView({ block: "end" }); true`);
                await save('agents-demo-limited-dark');
            } finally { await writeFile(config, configNow); }
            await agentsPage(); await wait(`!document.querySelector("[data-agent=codex]") && !document.querySelector("[data-agent=${demoExecutorB.name}]") && !!document.querySelector("[data-agent=ds]")`, 'UI188 配置恢复后 Codex 与演示执行者 B 行消失');
        }
        if (limitsBefore === null) await rm(limitsFile, { force: true }); else await writeFile(limitsFile, limitsBefore);

        // 编辑 Claude 类执行者：可担任（三个切换按钮，至少保留一个）、可能用到的模型范围（自动识别结果 + "修改…"展开家族多选）。
        const editOf = async (name: string) => { await press(`[data-more-agent=${name}]`); await press(await ctxItem('编辑')); await wait('!!document.querySelector(".sheet [data-role]") && !!document.querySelector(".sheet [data-family-open]")', `UI28 编辑 ${name}`); };
        const saveSheet = async () => { await press('.sheet-btns .btn:last-child'); await wait('!document.querySelector(".sheet")'); };
        await editOf('sonnet');
        // 改写（D128）：原断言 可担任是两个切换按钮"执行者 / 审查者"（都按下）→ 新断言 三个切换按钮"主导 / 执行者 / 审查者"（主导没按下，执行者与审查者按下）；原因：角色由用户决定，可担任加"主导"。
        await check('UI28 编辑 Claude 类：可担任是三个切换按钮"主导 / 执行者 / 审查者"（主导没按下，执行者与审查者按下），说明是 canDoHelp；模型范围显示 modelRangeAutoBy(claude, adapter)（没有模型名也没有接口地址：按适配器默认，走查 U5），"修改…"按钮没展开',`(() => { const roles = [...document.querySelectorAll('.sheet [data-role]')]; const labels = [...document.querySelectorAll('.sheet .fl b')].map(b => b.textContent); const help = [...document.querySelectorAll('.sheet .fl')].find(l => l.querySelector('b').textContent === ${jsonStr(ag.canDo)}).querySelector('span').textContent; return roles.map(b => b.textContent).join() === ${jsonStr([ag.roleNames.lead, ag.roleNames.executor, ag.roleNames.reviewer].join())} && roles.map(b => b.getAttribute('aria-pressed')).join() === 'false,true,true' && !roles[0].classList.contains('on') && roles.slice(1).every(b => b.classList.contains('on')) && help === ${jsonStr(ag.canDoHelp)} && labels.includes(${jsonStr(ag.modelRange)}) && document.querySelector('.sheet [data-model-range]').textContent === ${jsonStr(ag.modelRangeAutoBy('claude', 'adapter'))} && document.querySelector('.sheet [data-family-open]').getAttribute('aria-expanded') === 'false' && document.querySelector('.sheet [data-family-open]').textContent === ${jsonStr(ag.modelRangeChange)} && !document.querySelector('.sheet [data-family]'); })()`);
        await press('.sheet [data-role=executor]');
        await check('UI28 点"执行者"：它不再按下，焦点还在它上面，"保存"可用', `(() => { const b = document.querySelector('.sheet [data-role=executor]'); return b.getAttribute('aria-pressed') === 'false' && !b.classList.contains('on') && document.activeElement === b && !document.querySelector('.sheet-btns .btn:last-child').disabled; })()`);
        await verify('UI28 还没点保存：config.json 的 sonnet 没有 roles', async () => { assert.ok(!('roles' in (await readConfig()).profiles.sonnet)); });
        await saveSheet();
        await verify('UI28 取消"执行者"后保存：config.json 的 roles 是 ["reviewer"]，ar roles --json 与它一致', async () => { assert.deepEqual((await readConfig()).profiles.sonnet.roles, ['reviewer']); const p = (await rolesNow()).profiles.find(x => x.name === 'sonnet')!; assert.deepEqual(p.roles, ['reviewer']); });
        await wait(`document.querySelector('[data-agent=sonnet] [data-roles]').textContent === ${jsonStr(ag.canDoRow(ag.roleNames.reviewer))}`, 'UI28 保存后行里的可担任更新');
        await editOf('sonnet');
        await check('UI28 再次编辑：只有"审查者"按下', `(() => { const [a, b, c] = [...document.querySelectorAll('.sheet [data-role]')]; return a.getAttribute('aria-pressed') === 'false' && b.getAttribute('aria-pressed') === 'false' && c.getAttribute('aria-pressed') === 'true'; })()`);
        await press('.sheet [data-role=reviewer]');
        await check('UI28 三个都取消：保存禁用，帮助行换成说明（role=alert），切换按钮仍可点', `(() => { const save = document.querySelector('.sheet-btns .btn:last-child'); const hint = document.querySelector('.sheet [data-roles-hint]'); return save.disabled && !!hint && hint.getAttribute('role') === 'alert' && hint.textContent === ${jsonStr(ag.canDoNeedOne)} && [...document.querySelectorAll('.sheet [data-role]')].every(b => b.getAttribute('aria-pressed') === 'false' && !b.disabled); })()`);
        await verify('UI28 三个都取消时点不了保存：config.json 不变', async () => { assert.deepEqual((await readConfig()).profiles.sonnet.roles, ['reviewer']); });
        await press('.sheet [data-role=reviewer]'); await press('.sheet [data-role=executor]');
        await check('UI28 再选回执行者与审查者：保存可用，说明消失', `!document.querySelector('.sheet-btns .btn:last-child').disabled && !document.querySelector('.sheet [data-roles-hint]')`);
        // D128（191）：把 Claude 类设为可担任"主导"后保存，ar roles --json 的 lead.source 是 set；再取消，回到 default。
        await press('.sheet [data-role=lead]');
        await check('UI28 点"主导"：它按下，焦点还在它上面，"保存"可用，说明仍是 canDoHelp', `(() => { const b = document.querySelector('.sheet [data-role=lead]'); return b.getAttribute('aria-pressed') === 'true' && b.classList.contains('on') && document.activeElement === b && !document.querySelector('.sheet-btns .btn:last-child').disabled && !document.querySelector('.sheet [data-roles-hint]'); })()`);
        await saveSheet();
        await verify('UI28 保存"主导"：roles 含 lead，ar roles --json 的主导是 sonnet、source 为 set、家族 claude', async () => {
            const p = (await readConfig()).profiles.sonnet;
            assert.ok(p.roles.includes('lead')); assert.ok(p.roles.includes('executor') && p.roles.includes('reviewer'));
            const view = await rolesNow(), me = view.profiles.find(x => x.name === 'sonnet')!;
            assert.ok(me.roles.includes('lead')); assert.deepEqual(view.lead, { profiles: ['sonnet'], families: ['claude'], source: 'set' });
        });
        await wait(`document.querySelector('[data-agent=sonnet] [data-roles]').textContent === ${jsonStr(ag.canDoRow(['executor', 'reviewer', 'lead'].map(r => ag.roleNames[r]).join(' · ')))}`, 'UI28 行里的可担任含"主导"');
        await editOf('sonnet');
        await check('UI28 再次编辑：三个都按下', `[...document.querySelectorAll('.sheet [data-role]')].every(b => b.getAttribute('aria-pressed') === 'true' && b.classList.contains('on'))`);
        await press('.sheet [data-role=lead]');
        await saveSheet();
        await verify('UI28 取消"主导"后保存：roles 回到 [executor, reviewer]，ar roles --json 的 lead.source 回到 default（按 Claude Code）', async () => {
            assert.deepEqual((await readConfig()).profiles.sonnet.roles, ['executor', 'reviewer']);
            const view = await rolesNow();
            assert.deepEqual(view.lead, { profiles: [], families: ['claude'], source: 'default' });
        });
        await editOf('sonnet');
        await press('.sheet [data-family-open]');
        await check('UI28 点"修改…"：展开家族多选，选项和 ar roles --json 的 families 一致，按钮 aria-expanded 为 true，焦点还在按钮上', `(() => { const b = document.querySelector('.sheet [data-family-open]'); return b.getAttribute('aria-expanded') === 'true' && document.activeElement === b && [...document.querySelectorAll('.sheet [data-family]')].map(x => x.dataset.family).join() === ${jsonStr((await rolesNow()).families.join())} && [...document.querySelectorAll('.sheet [data-family]')].every(x => x.getAttribute('aria-pressed') === 'false'); })()`);
        await press('.sheet [data-family=gpt]'); await press('.sheet [data-family=qwen]');
        await check('UI28 选 gpt、qwen：两个按下，模型范围一行显示所选家族', `document.querySelector('.sheet [data-family=gpt]').getAttribute('aria-pressed') === 'true' && document.querySelector('.sheet [data-family=qwen]').getAttribute('aria-pressed') === 'true' && document.querySelector('.sheet [data-model-range]').textContent === 'gpt、qwen'`);
        await shots('edit-roles');
        await saveSheet();
        await verify('UI28 保存：roles 是 [executor, reviewer]，modelFamilies 是 [gpt, qwen]，ar roles --json 一致，其余字段不变', async () => {
            const p = (await readConfig()).profiles.sonnet;
            assert.deepEqual(p.roles, ['executor', 'reviewer']); assert.deepEqual(p.modelFamilies, ['gpt', 'qwen']); assert.equal(p.env.ANTHROPIC_MODEL, 'claude-sonnet-5-5');
            const r = (await rolesNow()).profiles.find(x => x.name === 'sonnet')!; assert.deepEqual(r.roles, ['executor', 'reviewer']); assert.deepEqual(r.modelFamilies, ['gpt', 'qwen']);
        });
        await editOf('sonnet');
        await check('UI28 再次编辑：模型范围显示已声明的 gpt、qwen（不再是自动识别的写法）', `document.querySelector('.sheet [data-model-range]').textContent === 'gpt、qwen'`);
        await press('.sheet [data-family-open]'); await press('.sheet [data-family=gpt]'); await press('.sheet [data-family=qwen]');
        await check('UI28 声明的家族全部取消：回到自动识别的结果', `document.querySelector('.sheet [data-model-range]').textContent === ${jsonStr(ag.familyUnknown)} || document.querySelector('.sheet [data-model-range]').textContent === ${jsonStr(ag.modelRangeAutoBy('claude', 'adapter'))}`);
        await saveSheet();
        await verify('UI28 声明清空后保存：modelFamilies 从 config.json 里消失', async () => { assert.ok(!('modelFamilies' in (await readConfig()).profiles.sonnet)); assert.deepEqual((await rolesNow()).profiles.find(x => x.name === 'sonnet')!.modelFamilies, []); });
        // 走查 U5：自动识别写明实际依据——只有接口地址认得出家族（没有模型名）时写"按接口地址自动识别"，与 ar roles 的 familiesSource 一致。
        const withHost = await readConfig();
        withHost.profiles.hostonly = { adapter: 'claude-code', label: '只有地址', enabled: true, path: path.join(home, 'fake-claude.cjs'), env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, auth: 'token', secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_CODE_OAUTH_TOKEN' }, maxTurns: null };
        await writeFile(config, jsonStr(withHost));
        await agentsPage(); await wait('!!document.querySelector("[data-agent=hostonly]")', 'UI28 hostonly 行出现');
        await editOf('hostonly');
        await check('UI28 编辑只有接口地址的执行者：模型范围是 modelRangeAutoBy("deepseek", "host")，即"deepseek（按接口地址自动识别）"', `document.querySelector('.sheet [data-model-range]').textContent === ${jsonStr(ag.modelRangeAutoBy('deepseek', 'host'))} && document.querySelector('.sheet [data-model-range]').textContent === 'deepseek（按接口地址自动识别）'`);
        await verify('UI28 核心的 familiesSource 是 host，家族 deepseek', async () => { const p = (await rolesNow()).profiles.find(x => x.name === 'hostonly')!; assert.equal(p.familiesSource, 'host'); assert.deepEqual(p.families, ['deepseek']); });
        await closeSheet();
        const withoutHost = await readConfig(); delete withoutHost.profiles.hostonly;
        await writeFile(config, jsonStr(withoutHost));
        await agentsPage(); await wait('!document.querySelector("[data-agent=hostonly]")');
        // 通用适配器（自定义 CLI）的编辑里也有这两项。
        await editOf('custom');
        // 改写（D128）：原断言 可担任是 2 个切换按钮 → 新断言 3 个（主导 / 执行者 / 审查者）；原因：角色由用户决定。
        await check('UI28 编辑通用适配器执行者：也有可担任（三个按钮）和模型范围（认不出家族：familyUnknown）', `document.querySelectorAll('.sheet [data-role]').length === 3 && [...document.querySelectorAll('.sheet [data-role]')].map(b => b.textContent).join() === ${jsonStr([ag.roleNames.lead, ag.roleNames.executor, ag.roleNames.reviewer].join())} && document.querySelector('.sheet [data-model-range]').textContent === ${jsonStr(ag.familyUnknown)}`);
        await press('.sheet [data-role=executor]'); await press('.sheet [data-family-open]'); await press('.sheet [data-family=qwen]');
        await saveSheet();
        await verify('UI28 通用适配器的编辑保存：roles [reviewer]、modelFamilies [qwen]，声明不动', async () => { const c = await readConfig(); assert.deepEqual(c.profiles.custom.roles, ['reviewer']); assert.deepEqual(c.profiles.custom.modelFamilies, ['qwen']); assert.equal(c.generics.custom.output.map.length, 2); });
        await wait(`document.querySelector('[data-agent=custom] [data-family-row]').textContent === ${jsonStr(ag.familyRow('qwen'))}`, 'UI28 行里的家族变成 qwen');
        // Codex 的编辑（表单式，144）里也有。
        const withCodex6 = await readConfig();
        withCodex6.profiles.codex = { adapter: 'codex', label: 'Codex 测试', enabled: true, auth: 'login' };
        await writeFile(config, jsonStr(withCodex6));
        await agentsPage(); await wait('!!document.querySelector("[data-agent=codex]")', 'UI28 Codex 执行者行出现（角色）');
        await check('UI28 Codex 行也有"可担任"和"家族 gpt"', `document.querySelector('[data-agent=codex] [data-roles]').textContent === ${jsonStr(ag.canDoRow(both))} && document.querySelector('[data-agent=codex] [data-family-row]').textContent === ${jsonStr(ag.familyRow('gpt'))}`);
        await press('[data-more-agent=codex]'); await press(await ctxItem('编辑'));
        await wait('!!document.querySelector(".sheet [data-e=label]") && !!document.querySelector(".sheet [data-role]")', 'UI28 编辑 Codex（角色）');
        await check('UI28 编辑 Codex：可担任在"位置"之后、"升级到"之前，模型范围显示 modelRangeAutoBy(gpt, adapter)',`(() => { const labels = [...document.querySelectorAll('.sheet .fl b')].map(b => b.textContent.replace('*', '')); const at = n => labels.indexOf(n); return at(${jsonStr(ag.canDo)}) > at(${jsonStr(ag.location)}) && at(${jsonStr(ag.canDo)}) < at(${jsonStr(gx.escalate)}) && at(${jsonStr(ag.modelRange)}) === at(${jsonStr(ag.canDo)}) + 1 && document.querySelector('.sheet [data-model-range]').textContent === ${jsonStr(ag.modelRangeAutoBy('gpt', 'adapter'))}; })()`);
        await press('.sheet [data-role=reviewer]');
        await verify('UI28 Codex 编辑：还没点保存时 config.json 不变', async () => { assert.ok(!('roles' in (await readConfig()).profiles.codex)); });
        await saveSheet();
        await verify('UI28 Codex 取消"审查者"后保存：roles 是 ["executor"]，ar roles --json 一致', async () => { assert.deepEqual((await readConfig()).profiles.codex.roles, ['executor']); assert.deepEqual((await rolesNow()).profiles.find(x => x.name === 'codex')!.roles, ['executor']); });
        const withoutCodex6 = await readConfig(); delete withoutCodex6.profiles.codex;
        await writeFile(config, jsonStr(withoutCodex6));
        await agentsPage(); await wait('!document.querySelector("[data-agent=codex]")');
        await check('UI28 页面上没有任何密钥值', '!document.body.innerHTML.includes("sk-ui28")');
    } finally {
        if (limitsBefore === null) await rm(limitsFile, { force: true }); else await writeFile(limitsFile, limitsBefore);
        fileDialogs.stub = false;
        win.setContentSize(original.size[0], original.size[1]); nativeTheme.themeSource = original.theme;
        if (configBefore === null) await rm(config, { force: true }); else await writeFile(config, configBefore);
        if (secretsBefore === null) await rm(secretsFile, { force: true }); else await writeFile(secretsFile, secretsBefore);
    }
    // 后面的检查从设置页开始（与 capturePreferences 的结尾一致）。
    await press('[data-page=tasks]'); await press('[data-page=settings]'); await wait('!!document.querySelector("[data-pref=notifications]")');
}
