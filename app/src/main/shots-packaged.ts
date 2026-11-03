import { app, nativeTheme, type BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';
import { createHarness } from './shots-input';
import { effects } from './effects';
import { fileDialogs } from './console.mjs';

const appEnv = appEnvironment(process.env);

export async function capturePackaged(win: BrowserWindow, out: string) {
    assert.ok(app.isPackaged, '必须使用打包程序验收');
    const home = appEnv.AGENT_ROUTER_HOME!;
    for (const key of ['USERPROFILE', 'HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME']) {
        assert.ok(appEnv[key], `${key} 必须隔离`);
        const relative = path.relative(home, appEnv[key]!);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    }
    if (process.env.AR_PACKAGED_VERIFY === 'ui34') { await captureUi34(win, out, home); return; }
    const evaluate = (code: string) => win.webContents.executeJavaScript(code);
    const wait = async (code: string) => {
        // 单调时钟真实截止，上限 15 秒（原来是 150 次轮询）。
        const deadline = performance.now() + 15000;
        while (performance.now() < deadline) { if (await evaluate(code) && performance.now() <= deadline) return; await new Promise(resolve => setTimeout(resolve, 100)); }
        throw Error(`打包验收等待超时：${code}`);
    };
    const click = async (selector: string) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); };
    await wait('!!document.querySelector(".wiz") && !document.querySelector("[data-pref=next]").disabled');
    await click('[data-pref=next]');
    // 第 2 步导入 Agent 需要真实密钥；打包验收不导入，按引导允许的方式跳过（跳到第 3 步技能）。
    await wait('!!document.querySelector(".presets .preset.on")');
    await click('[data-pref=skip]');
    await wait('document.querySelectorAll("[data-choice][aria-checked=true]").length === 3');
    await click('[data-pref=next]');
    // 第 4 步 DeepSeek Harness 也不装（约 830 MB，界面验收不跑 npm），跳过到第 5 步项目。
    // 不限定确认页：没有 npm / 已经装过时这一步的版面不同，"跳过"始终可用。
    await wait('document.querySelector(".wiz-steps .on")?.textContent.includes("DeepSeek Harness")');
    await click('[data-pref=skip]');
    await wait('!!document.querySelector("[data-wizard-folder]")');
    await click('[data-pref=skip]');
    await wait('!!document.querySelector("[data-task=t1]")');
    assert.equal(await evaluate('document.querySelectorAll("[data-task]").length'), 17);
    await click('[data-page=connect]');
    await wait('!!document.querySelector("[data-operation=reinstall][data-host=claude-code]")');
    await click('[data-operation=reinstall][data-host=claude-code]');
    await wait('document.querySelector("[data-host-card=claude-code] .note").textContent.includes("已安装 3 个")');
    const hosts = [path.join(appEnv.CLAUDE_CONFIG_DIR!, 'skills')];
    const installed = [];
    for (const host of hosts) for (const skill of ['agent-router', 'lead-workflow', 'lead-practices']) {
        const record = JSON.parse(await readFile(path.join(host, skill, '.agent-router.json'), 'utf8'));
        assert.equal(record.version, app.getVersion());
        assert.ok((await readFile(path.join(host, skill, 'SKILL.md'), 'utf8')).length > 0);
        if (skill === 'lead-practices') for (const name of ['references/examples.md', 'references/closeout.md']) {
            const bytes: Buffer = await readFile(path.join(host, skill, name));
            assert.ok(bytes.length > 0); assert.equal(createHash('sha256').update(bytes).digest('hex'), record.files[name]);
        }
        installed.push({ host: 'claude-code', skill, version: record.version });
    }
    assert.deepEqual(await readFile(path.join(hosts[0], 'agent-router', 'core', 'ar.mjs')), await readFile(path.join(__dirname, 'core', 'ar.mjs')));
    await click('[data-page=tasks]'); await click('[data-task=t1]');
    nativeTheme.themeSource = 'dark';
    await evaluate('document.fonts.ready');
    assert.equal(await evaluate('document.fonts.check(\'13px "AgentRouter MiSans"\') && [...document.fonts].some(f=>f.family.includes("AgentRouter MiSans") && f.status==="loaded")'), true);
    // 查询实际绘制所用字体，避免只检查 CSS 声明而漏掉系统字体回退。
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('DOM.enable');
    await win.webContents.debugger.sendCommand('CSS.enable');
    const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-task=t1] .tm b' });
    const { fonts } = await win.webContents.debugger.sendCommand('CSS.getPlatformFontsForNode', { nodeId });
    assert.ok(fonts.some((font: any) => /MiSans/i.test(font.familyName) && font.isCustomFont && font.glyphCount > 0));
    win.webContents.debugger.detach();
    assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(home)})`), false);
    await mkdir(out, { recursive: true });
    await new Promise(resolve => setTimeout(resolve, 400));
    await writeFile(path.join(out, 'packaged.png'), (await win.webContents.capturePage()).toPNG());
    const fontHash = createHash('sha256').update(await readFile(path.join(__dirname, 'fonts/MiSansVF.ttf'))).digest('hex');
    // 软件用内置 Node 运行核心：返回的 Node / Electron 版本必须与软件自身一致。
    const core = await coreRun(['version']);
    assert.equal(core.code, 0, core.stderr); assert.equal(core.json.ok, true);
    assert.equal(core.json.node, process.versions.node); assert.equal(core.json.electron, process.versions.electron); assert.equal(core.json.version, app.getVersion());
    const evidence = { packaged: app.isPackaged, version: app.getVersion(), tasks: 17, wizardInstall: true, connectionReinstall: true, installed, fonts, fontHash, coreNode: core.json.node, coreElectron: core.json.electron };
    await writeFile(path.join(out, 'packaged.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
}

// 使用安装后的程序和隔离项目检查完整流程。
async function captureUi34(win: BrowserWindow, out: string, home: string) {
    const repo = path.join(home, 'ui34-project');
    const save = async (name: string) => { await mkdir(out, { recursive: true }); await writeFile(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
    const { press, wait, evaluate } = createHarness(win, save);
    fileDialogs.stub = true;
    await wait('!!document.querySelector(".wiz") && !document.querySelector("[data-pref=next]").disabled');
    await press('[data-pref=next]');
    await wait('!!document.querySelector(".presets .preset.on")'); await press('[data-pref=skip]');
    await wait('document.querySelectorAll("[data-choice][aria-checked=true]").length === 3'); await press('[data-pref=next]');
    await wait('document.querySelector(".wiz-steps .on")?.textContent.includes("DeepSeek Harness")'); await press('[data-pref=skip]');
    await wait('!!document.querySelector("[data-wizard-folder]")'); await press('[data-pref=skip]');
    await wait('!document.querySelector(".wiz")');
    await press('[data-page=connect]'); await wait('!!document.querySelector(".page-h [data-import-agent]")');
    fileDialogs.open.push(path.join(home, 'ui34-agent.json'));
    await press('.page-h [data-import-agent]'); await wait('!!document.querySelector(".sheet .preset.on")');
    await press('[data-preset="@file"]'); await press('[data-w-act=next]');
    await wait('!!document.querySelector("[data-w-result]")', '导入假执行者测试结果', 60000);
    assert.equal(await evaluate('document.querySelector("[data-w-result]").dataset.wResult'), 'ok');
    await press('[data-w-act=done]'); await wait('!document.querySelector(".sheet") && !!document.querySelector("[data-agent=fake]")');
    effects.folders.push(repo);
    await press('[data-page=projects]'); await wait('!!document.querySelector(".page-h [data-pj=add]")');
    await press('.page-h [data-pj=add]');
    await wait(`document.querySelector('[data-pj-row].on')?.dataset.pjRow === ${JSON.stringify(repo)}`, '添加隔离项目', 30000);
    await press('[data-page=newtask]'); await wait(`!!document.querySelector('[data-nt-ready="1"]')`, '新建任务页', 30000);
    await press('[data-nt-project]'); await wait('!!document.querySelector(".ctx button")');
    await press('.ctx button');
    await press('[data-nt-worker]'); await wait('!!document.querySelector(".ctx button")');
    const fakeIndex = await evaluate(`[...document.querySelectorAll('.ctx button')].findIndex(b => b.textContent.trim() === '假执行者')`);
    assert.ok(fakeIndex >= 0, '执行者菜单没有假执行者');
    await press(`.ctx button:nth-child(${fakeIndex + 1})`);
    await wait('!!document.querySelector("[data-nt-source=existing]")'); await press('[data-nt-source=existing]');
    await wait('!!document.querySelector("[data-nt-spec]")', '任务说明加载', 30000);
    await press('[data-nt-spec]'); await press('[data-nt-dispatch]');
    await wait('document.querySelector("[data-page=tasks]")?.getAttribute("aria-current") === "page" && !!document.querySelector(".trow.on")', '任务派发', 30000);
    await save('ui34-tasks');
    await wait('!!document.querySelector("[data-page=accept] .count")', '任务进入待验收', 120000);
    await press('[data-page=accept]'); await wait('!!document.querySelector("[data-acc]")', '验收页', 30000);
    await press('[data-acc]'); await wait('!!document.querySelector("[data-acc-approve]")'); await save('ui34-accept');
    await press('[data-acc-approve]'); await wait('!!document.querySelector(".confirm-card")'); await press('.confirm-actions .btn.primary');
    await wait('!document.querySelector("[data-acc]") && !!document.querySelector(".toast")', '合并完成', 90000);
    assert.equal(await readFile(path.join(repo, 'result.txt'), 'utf8'), '已完成\n');
    const events = (await readFile(path.join(home, 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(e => e.event === 'start').length, 1);
    assert.equal(events.find(e => e.event === 'start')?.profile, 'fake');
    assert.equal(events.filter(e => e.event === 'accepted').length, 1);
    await press('[data-page=stats]');
    await wait('document.querySelector(".kpi .v")?.textContent === "1" && parseInt(document.querySelector(".stat-tbl tbody tr td:nth-child(4)")?.textContent) === 1', '统计显示一个任务', 30000);
    await save('ui34-stats');
    await writeFile(path.join(out, 'ui34.json'), JSON.stringify({ tasks: 1, accepted: true }, null, 2));
}
