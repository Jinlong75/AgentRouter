import { app, nativeTheme, type BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { coreRun } from './core';
import { appEnvironment } from './app-env.mjs';

const appEnv = appEnvironment(process.env);

export async function capturePackaged(win: BrowserWindow, out: string) {
    assert.ok(app.isPackaged, '必须使用打包程序验收');
    const home = appEnv.AGENT_ROUTER_HOME!;
    for (const key of ['USERPROFILE', 'HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME']) {
        assert.ok(appEnv[key], `${key} 必须隔离`);
        const relative = path.relative(home, appEnv[key]!);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    }
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
    await wait('document.querySelectorAll("[data-choice][aria-checked=true]").length === 2');
    await click('[data-pref=next]');
    // 第 3 步导入 Agent 需要真实密钥；打包验收不导入，按引导允许的方式跳过后继续原有检查。
    await wait('!!document.querySelector(".presets .preset.on")');
    await click('[data-pref=skip]');
    await wait('!!document.querySelector("[data-task=t1]")');
    assert.equal(await evaluate('document.querySelectorAll("[data-task]").length'), 16);
    await click('[data-page=connect]');
    await wait('!!document.querySelector("[data-operation=reinstall][data-host=claude-code]")');
    await click('[data-operation=reinstall][data-host=claude-code]');
    await wait('document.querySelector("[data-host-card=claude-code] .note").textContent.includes("已安装 2 个")');
    const hosts = [path.join(appEnv.CLAUDE_CONFIG_DIR!, 'skills')];
    const installed = [];
    for (const host of hosts) for (const skill of ['agent-router', 'lead-workflow']) {
        const record = JSON.parse(await readFile(path.join(host, skill, '.agent-router.json'), 'utf8'));
        assert.equal(record.version, app.getVersion());
        assert.ok((await readFile(path.join(host, skill, 'SKILL.md'), 'utf8')).length > 0);
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
    const evidence = { packaged: app.isPackaged, version: app.getVersion(), tasks: 16, wizardInstall: true, connectionReinstall: true, installed, fonts, fontHash, coreNode: core.json.node, coreElectron: core.json.electron };
    await writeFile(path.join(out, 'packaged.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
}
