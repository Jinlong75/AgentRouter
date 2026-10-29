import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { nativeTheme } from 'electron';
import { clock, pollUntil, cpuNow, coreReport, coreSeq, ipcReport, ipcSeq, type Harness } from './shots-input';
import { coreRun } from './core';
import { gx, nt, ro } from '../shared/copy';
import { appEnvironment } from './app-env.mjs';

// 隔离用的路径从软件内部环境读；主进程 process.env 是用户原样。
const appEnv = appEnvironment(process.env);
// 验收里的 git 也只用隔离环境（GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM 见 tools/demo/preferences.mjs）。
const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, env: appEnv });
    assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
    return String(r.stdout).trim();
};
// 用一次性的 -c 身份提交：不写进任何 git 配置（给"没有提交身份"的临时仓库做初始提交）。
const commitAs = (cwd: string, message: string, files: string[]) =>
    git(cwd, ['-c', 'user.name=AgentRouter Shots', '-c', 'user.email=shots@example.invalid', 'commit', '-m', message, '--', ...files]);
// 用自带 Node 运行核心，和软件里的调用走同一条路。
const core = async (args: string[], cwd?: string) => {
    const r = await coreRun(args, { timeoutMs: 60000, cwd });
    assert.equal(r.code, 0, `ar ${args.join(' ')}：${r.stderr || r.json?.error}`);
    assert.equal(r.json?.ok, true, `ar ${args.join(' ')}：${r.json?.error}`);
    return r.json;
};

// 在隔离公共目录里准备新建任务页用的临时仓库：已初始化、有一个任务说明、项目配置里有允许路径与验收命令。
export async function fixtures() {
    const home = appEnv.AGENT_ROUTER_HOME!;
    assert.ok(home && path.isAbsolute(home), '截图验收必须在隔离公共目录里运行');
    const repo = path.join(home, 'shots-newtask', 'sample'), specs = path.join(repo, 'docs', 'specs');
    await mkdir(specs, { recursive: true });
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'AgentRouter Shots']);
    git(repo, ['config', 'user.email', 'shots@example.invalid']);
    await writeFile(path.join(repo, 'README.md'), '# sample\n\n安装：npm install\n');
    await writeFile(path.join(specs, '001-已有说明.md'), [
        '---', 'id: 001', 'title: 已有说明：检查安装步骤', 'type: docs', 'worker: auto', 'allowed_paths: []', 'verify: []', '---', '',
        '## 目标', '', '照着 README 的安装步骤跑一遍，记下不一致的地方。', '',
    ].join('\n'));
    git(repo, ['add', '--', 'README.md', 'docs/specs/001-已有说明.md']);
    git(repo, ['commit', '-m', '初始提交', '--', 'README.md', 'docs/specs/001-已有说明.md']);
    // 初始化会写模板文件；之后换成固定的项目配置，新建说明页默认值才有可断言的来源。
    const init = await core(['init', repo]);
    await writeFile(path.join(repo, '.agent-router', 'project.json'), JSON.stringify({
        v: 1, name: 'sample', baseBranch: 'main', specsDir: 'docs/specs', setup: [],
        verify: ['node --version'], allowedPaths: ['README.md'], routing: { rules: [] }, worktree: true,
    }, null, 2) + '\n');
    // 门禁要求派发时工作区干净（文件协议 11.4）：初始化写出的文件和改过的项目配置一起提交。
    const initFiles = [...new Set([...init.changes.map((c: { path: string }) => c.path), '.agent-router/project.json'])];
    git(repo, ['add', '--', ...initFiles]);
    git(repo, ['commit', '-m', '初始化项目配置', '--', ...initFiles]);
    await core(['projects', 'add', repo]);
    // 没有提交身份的项目：初始提交用一次性的 -c 身份，不写任何 git 配置。
    const noid = path.join(home, 'shots-newtask', 'noidentity'), noidSpecs = path.join(noid, 'docs', 'specs');
    await mkdir(noidSpecs, { recursive: true });
    await writeFile(path.join(noid, 'README.md'), '# no identity\n');
    git(noid, ['init', '-b', 'main']);
    git(noid, ['add', '--', 'README.md']);
    commitAs(noid, '初始提交', ['README.md']);
    await core(['projects', 'add', noid]);
    return { repo, specs, noid, noidSpecs };
}

// 新建任务页加载完成：页面在"列出项目、列出执行者 → 项目详情、任务说明列表"都返回后才标 data-nt-ready="1"。上限 20 秒（不变）。
// 成功时打印总用时与这段时间每次核心调用的用时；超时时打印每个子条件的实际值与仍未返回的调用，便于判断是慢、报错还是卡住。
export async function waitNewtaskReady(h: Harness, label = '新建任务页加载完成', fromSeq = ipcSeq(), started = Date.now(), fromCore = coreSeq()) {
    const state = () => h.evaluate(`JSON.stringify({
        ready: document.querySelector('[data-nt-ready]')?.dataset.ntReady ?? '（没有容器）',
        page: document.querySelector('[data-page=newtask]')?.getAttribute('aria-current') ?? null,
        project: document.querySelector('[data-nt-project]')?.textContent.trim().slice(0, 40) ?? null,
        form: !!document.querySelector('[data-nt-f=title]') || !!document.querySelector('[data-nt-source]'),
        error: document.querySelector('.doc-in .banner.fail, .page-h + .banner.fail')?.textContent.trim().slice(0, 120) ?? null,
        busy: [...document.querySelectorAll('button[disabled]')].length })`);
    const readyDeadline = clock() + 20000;
    while (clock() < readyDeadline) {
        if (await h.evaluate('document.querySelector("[data-nt-ready=\\"1\\"]") !== null') && clock() <= readyDeadline) {
            console.log(`${label}用时：${Date.now() - started} ms（标准 ≤ 20000 ms）；核心调用：${ipcReport(fromSeq)}；核心进程：${coreReport(fromCore)}`);
            return;
        }
        await h.pause(100);
    }
    throw Error(`界面等待超时：${label}（20000 ms）
子条件：${await state()}
这段时间的核心调用：${ipcReport(fromSeq)}
核心进程各阶段：${coreReport(fromCore)}
此刻的 CPU（1 秒采样）：${await cpuNow()}`);
}

export async function captureNewtask(h: Harness) {
    const { evaluate, wait, check, verify, press, key, type, tabTo, focusRing, pause } = h;
    const home = appEnv.AGENT_ROUTER_HOME!, { repo, specs, noid, noidSpecs } = await fixtures();
    const configFile = path.join(home, 'config.json'), projectsFile = path.join(home, 'projects.json'), runsFile = path.join(home, 'runs.jsonl');
    const specRel = 'docs/specs/001-已有说明.md';
    const runs = async () => (await readFile(runsFile, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) as any[];
    const specFiles = async () => (await readdir(specs)).filter(f => /^\d{3}-.*\.md$/.test(f)).sort();
    const specFilesIn = async (dir: string) => (await readdir(dir)).filter(f => /^\d{3}-.*\.md$/.test(f)).sort();
    const until = async (fn: () => boolean | Promise<boolean>, label: string, timeoutMs = 20000) => {
        if ((await pollUntil(fn, timeoutMs)).ok) return;
        assert.fail(`等待超时：${label}`);
    };
    // 深浅各截一张，然后回到深色。
    const shot = async (name: string) => {
        for (const theme of ['dark', 'light'] as const) { nativeTheme.themeSource = theme; await h.save(`${name}-${theme}`); }
        nativeTheme.themeSource = 'dark';
        await pause(100);
    };
    // 菜单项按文字定位：给当前菜单的按钮标上序号再点。
    const menuItem = async (label: string) => {
        const index = await evaluate(`(() => { const items = [...document.querySelectorAll('.ctx button')]; items.forEach((b, i) => b.setAttribute('data-menu-index', String(i))); return items.findIndex(b => b.textContent.trim() === ${JSON.stringify(label)}); })()`);
        assert.ok(index >= 0, `菜单里没有「${label}」`);
        return `.ctx button[data-menu-index="${index}"]`;
    };
    // 真实鼠标点输入框偶发不获得焦点（窗口没在前台时第一次点击会被吞掉）：失败时先按一下 Shift 确保有输入焦点再点一次。
    const focusField = async (selector: string) => {
        const focused = () => evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`);
        await press(selector);
        if (await focused()) return;
        await key('Shift');
        await press(selector);
        assert.equal(await focused(), true, `${selector}：点击后没有获得焦点`);
    };
    const typeIn = async (selector: string, text: string) => {
        await focusField(selector);
        for (const ch of text) await key(ch);
    };
    // 页面加载完成（含项目、执行者、任务说明）才继续；切页面回来时状态缓存在视图里。
    const ready = 'document.querySelector("[data-nt-ready=\\"1\\"]") !== null';
    const goto = async (source?: 'existing' | 'new' | 'text') => {
        const onPage = await evaluate(`document.querySelector('[data-page=newtask]')?.getAttribute('aria-current') === 'page'`);
        const fromSeq = ipcSeq(), fromCore = coreSeq(), started = Date.now();
        if (!onPage) await press('[data-page=newtask]');
        await waitNewtaskReady(h, '新建任务页加载完成', fromSeq, started, fromCore);
        if (source) {
            const current = await evaluate(`document.querySelector('[data-nt-seg=source] [aria-pressed=true]')?.dataset.ntSource`);
            if (current !== source) await press(`[data-nt-source=${source}]`);
            const field = source === 'existing' ? '[data-nt-spec]' : source === 'text' ? '[data-nt-f=text]' : '[data-nt-f=title]';
            await wait(`document.querySelector('${field}') !== null`, `切到来源 ${source}`);
        }
    };
    const selectedId = async () => {
        const id = await evaluate('document.querySelector(".trow.on")?.dataset.task');
        assert.ok(id, '任务页没有选中新任务');
        return String(id);
    };

    // 执行者配置：只留一个 enabled 的假执行者，派发不碰任何真实服务。
    const fake = {
        v: 2, defaultProfile: 'fake', managed: false, watchWindow: 'never', profiles: {
            fake: { adapter: 'fake', label: '假执行者', enabled: true, events: [{ kind: 'say', text: '假执行者已完成。' }], report: 'OK\n', exit: 0, delayMs: 0, version: 'fake-agent 1.0' },
        },
    };
    const fakeText = JSON.stringify(fake, null, 2) + '\n';
    const disabledText = JSON.stringify({ ...fake, profiles: { fake: { ...fake.profiles.fake, enabled: false } } }, null, 2) + '\n';
    const originalConfig = await readFile(configFile, 'utf8').catch(() => null);
    await writeFile(configFile, fakeText);

    try {
        // 任务页标题行：导入旧任务的图标按钮保留在"新建任务"主按钮左边。
        await press('[data-page=tasks]');
        await wait('!!document.querySelector("[data-task=t1]")');
        await check('UI16 任务页标题行有"新建任务"主按钮，导入旧任务在它左边', `(() => { const create = document.querySelector('.page-h [data-page=newtask]'), importButton = document.querySelector('.page-h [data-import]'); return !!create && create.classList.contains('primary') && !!importButton && (importButton.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; })()`);
        await press('.page-h [data-page=newtask]');
        await wait(ready, '从任务页标题行打开新建任务页', 20000);
        await check('UI16 点标题行"新建任务"切到新建任务页并高亮侧栏', `document.querySelector('[data-page=newtask]').getAttribute('aria-current') === 'page' && document.querySelector('.doc.with-bar') !== null`);

        // 选择临时项目；返回页面时要记住它。
        await press('[data-nt-project]');
        await wait('!!document.querySelector(".ctx")', '项目下拉');
        await press(await menuItem('sample'));
        await wait(`document.querySelector('[data-nt-path]')?.textContent.includes('· main')`, '项目分支显示', 20000);
        await check('UI16 选项目后显示目录与基础分支', `document.querySelector('[data-nt-path]')?.textContent.includes(${JSON.stringify(repo)}) && document.querySelector('[data-nt-project]')?.textContent.includes('sample')`);
        await press('[data-nt-worker]');
        await wait('!!document.querySelector(".ctx")', '执行者下拉');
        await check('UI16 执行者下拉第一项是自动（默认执行者显示名）', `document.querySelector('.ctx button')?.textContent.trim() === '自动（默认：假执行者）'`);
        await key('Escape');
        await check('UI16 Esc 关闭执行者下拉', '!document.querySelector(".ctx")');

        // 侧栏入口（键盘 Tab + Enter）也打开页面，并保持刚才选的项目。
        await press('[data-page=tasks]');
        await wait('!!document.querySelector("[data-task=t1]")');
        await tabTo('[data-page=newtask]');
        await focusRing('UI16 侧栏「新建任务」');
        await key('Enter');
        await wait(ready, '键盘打开新建任务页', 20000);
        await wait(`document.querySelector('[data-nt-path]')?.textContent.includes('· main')`, '返回后项目仍是上次选的');
        await check('UI16 侧栏「新建任务」Tab + Enter 打开页面并记住上次项目', `document.querySelector('[data-page=newtask]').getAttribute('aria-current') === 'page' && document.querySelector('[data-nt-project]')?.textContent.includes('sample')`);

        // 已有任务说明：列表、默认选中、说明栏，然后派发。
        await goto('existing');
        await wait('!!document.querySelector("[data-nt-spec]")');
        await check('UI16 已有说明列出文件名、标题与派发次数', `(() => { const row = document.querySelector('[data-nt-spec]'); return row?.dataset.ntSpec === ${JSON.stringify(specRel)} && row.querySelector('.pk b')?.textContent === '001-已有说明.md' && row.querySelector('.pk > span')?.textContent === '已有说明：检查安装步骤 · 未派发'; })()`);
        await check('UI16 已有说明默认选中最新一条并显示派发说明', `document.querySelector('[data-nt-spec].on')?.getAttribute('aria-checked') === 'true' && document.querySelector('[data-nt-note]')?.textContent === ${JSON.stringify(`派发 ${specRel} 给 假执行者`)}`);
        await shot('newtask-existing');

        await press('[data-nt-dispatch]');
        await wait('document.querySelector("[data-page=tasks]")?.getAttribute("aria-current") === "page" && !!document.querySelector(".trow.on")', '已有说明派发后切回任务页并选中', 20000);
        const existingId = await selectedId();
        await check('UI16 已有说明派发后切回任务页并选中新任务', `document.querySelector('[data-page=tasks]').getAttribute('aria-current') === 'page' && document.querySelector('.trow.on')?.dataset.task === ${JSON.stringify(existingId)}`);
        // 015：软件发起的派发记 AgentRouter（软件）；与 UI03 同样的文本拼接方式。
        await check('UI16 已有说明派发后详情状态行显示"派活方AgentRouter（软件）"', 'document.querySelector("[data-dispatcher-line]").textContent==="派活方AgentRouter（软件）"');
        await verify('UI16 已有说明派发：start 行的 spec 是所选说明，profile=fake', async () => {
            const start = (await runs()).find(r => r.event === 'start' && r.id === existingId);
            assert.ok(start, `runs.jsonl 里没有 ${existingId} 的 start 行`);
            assert.equal(start.spec, specRel);
            assert.equal(start.profile, 'fake');
        });
        await verify('UI16 已有说明派发：start 行的派活方是 agentrouter', async () => {
            const start = (await runs()).find(r => r.event === 'start' && r.id === existingId);
            assert.deepEqual(start.dispatcher, { host: 'agentrouter', session: null });
        });
        await until(async () => (await runs()).some(r => r.event === 'end' && r.id === existingId), '假执行者结束');
        await verify('UI16 假执行者结束的 exit 与配置一致（0）', async () => {
            const end = (await runs()).find(r => r.event === 'end' && r.id === existingId);
            assert.equal(end.exit, 0);
        });

        // 新建任务说明：默认值来自项目配置；真实输入标题与目标，预览，再派发。
        await goto('new');
        await check('UI16 新建说明默认取项目配置的允许路径与验收命令', `document.querySelector('[data-nt-f=allowed]')?.value === 'README.md' && document.querySelector('[data-nt-f=verify]')?.value === 'node --version'`);
        await check('UI16 新建说明默认勾选"先提交任务说明"，有预览按钮', `document.querySelector('[data-nt-commit]')?.getAttribute('aria-checked') === 'true' && !!document.querySelector('[data-nt-preview]')`);
        await type('[data-nt-f=title]', 'README usage notes');
        await type('[data-nt-f=goal]', 'Add an install section to README.');
        await press('[data-nt-type=docs]');
        await check('UI16 点类型分段切换选中态', `document.querySelector('[data-nt-type=docs]').classList.contains('on') && document.querySelector('[data-nt-type=docs]').getAttribute('aria-pressed') === 'true'`);
        await wait(`/docs\\/specs\\/\\d{3}-README-usage-notes\\.md/.test(document.querySelector('[data-nt-note]')?.textContent ?? '')`, '文件名预览跟上输入', 15000);
        const previewRel = await evaluate(`(() => { const m = /写入 (docs\\/specs\\/[^，]+)，/.exec(document.querySelector('[data-nt-note]').textContent); return m ? m[1] : ''; })()`);
        assert.match(previewRel, /^docs\/specs\/\d{3}-README-usage-notes\.md$/, '说明栏里的文件名不对');
        await shot('newtask-new');

        await press('[data-nt-preview]');
        await wait('!!document.querySelector(".sheet.wide .mdsrc.selectable")', '预览模态框', 15000);
        await check('UI16 预览显示将写入的 Markdown 与文件名', `(() => { const sheet = document.querySelector('.sheet.wide'); const src = sheet?.querySelector('.mdsrc.selectable')?.textContent ?? ''; return src.includes('title: README usage notes') && src.includes('## 目标') && sheet.querySelector('.sheet-f .note')?.textContent === ${JSON.stringify(previewRel)}; })()`);
        // 任务 011：预览默认「排版」视图，可键盘切到「源码」，源码与核心给的原文一致。
        await check('UI16 预览默认排版视图：分段选中排版，正文渲染出 h2', '(() => { const sheet = document.querySelector(".sheet.wide"); const rendered = sheet?.querySelector(".md.selectable"); return !!rendered && !rendered.hidden && sheet.querySelector(".mdsrc").hidden && sheet.querySelector("[data-nt-view=rendered]")?.getAttribute("aria-pressed") === "true" && sheet.querySelector("[data-nt-view=source]")?.getAttribute("aria-pressed") === "false" && (rendered.querySelector("h2") || rendered.querySelector("h3")) !== null; })()');
        await tabTo('.sheet.wide [data-nt-view=source]');
        await key('Enter');
        await check('UI16 键盘切到源码视图：源码可见、排版隐藏、焦点留在分段', '(() => { const sheet = document.querySelector(".sheet.wide"); return !sheet.querySelector(".mdsrc").hidden && sheet.querySelector(".md").hidden && sheet.querySelector("[data-nt-view=source]").getAttribute("aria-pressed") === "true" && document.activeElement === sheet.querySelector("[data-nt-view=source]"); })()');
        await verify('UI16 源码视图内容与核心给的原文一致（对照 ar spec new --dry-run）', async () => {
            const shown = await evaluate(`document.querySelector('.sheet.wide .mdsrc.selectable').textContent`);
            const form = {
                title: 'README usage notes', goal: 'Add an install section to README.', type: 'docs',
                allowedPaths: ['README.md'], verify: ['node --version'],
                nonGoals: '', refs: '', acceptance: '', questions: '', worker: 'auto',
            };
            // 与界面走的 specs:new 同一条核心命令：coreRun 自己补 --json，表单经标准输入传入。
            const expected = await coreRun(['spec', 'new', repo, '--dry-run'], { input: JSON.stringify(form), timeoutMs: 60000 });
            assert.equal(expected.json?.ok, true, `ar spec new --dry-run：${expected.stderr || expected.json?.error}`);
            assert.equal(shown, expected.json?.content, '预览源码与核心输出不一致');
        });
        await key('Escape');
        await wait('!document.querySelector(".sheet.wide")', '预览模态框关闭');
        await check('UI16 Esc 关闭预览后焦点回到预览按钮', 'document.activeElement === document.querySelector("[data-nt-preview]")');
        await press('[data-nt-preview]');
        await wait('!!document.querySelector(".sheet.wide .mdsrc.selectable")', '重新打开预览模态框', 15000);
        await shot('newtask-preview');
        await press('.sheet-btns .btn:last-of-type');
        await wait('document.querySelector("[data-page=tasks]")?.getAttribute("aria-current") === "page" && !!document.querySelector(".trow.on")', '新建说明派发后切回任务页并选中', 20000);
        const newId = await selectedId();
        await check('UI16 新建说明派发后切回任务页并选中新任务', `document.querySelector('.trow.on')?.dataset.task === ${JSON.stringify(newId)}`);
        const createdFile = (await specFiles()).find(f => f !== '001-已有说明.md');
        assert.ok(createdFile, '临时仓库里没有生成新的任务说明');
        assert.equal(`docs/specs/${createdFile}`, previewRel, '实际生成的文件名与预览不一致');
        await verify('UI16 新建说明：生成的文件内容包含标题与目标', async () => {
            const content = await readFile(path.join(specs, createdFile!), 'utf8');
            assert.ok(content.includes('title: README usage notes') && content.includes('Add an install section to README.'));
        });
        await verify('UI16 新建说明：最近一次提交只包含这个说明文件', async () => {
            const files = git(repo, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
            assert.deepEqual(files, [`docs/specs/${createdFile}`]);
        });
        await verify('UI16 新建说明派发：start 行的 spec 是刚写入的说明，profile=fake', async () => {
            const start = (await runs()).find(r => r.event === 'start' && r.id === newId);
            assert.ok(start, `runs.jsonl 里没有 ${newId} 的 start 行`);
            assert.equal(start.spec, previewRel);
            assert.equal(start.profile, 'fake');
        });
        await verify('UI16 新建说明派发：start 行的派活方是 agentrouter', async () => {
            const start = (await runs()).find(r => r.event === 'start' && r.id === newId);
            assert.deepEqual(start.dispatcher, { host: 'agentrouter', session: null });
        });
        await until(async () => (await runs()).some(r => r.event === 'end' && r.id === newId), '假执行者结束');

        // 015：派发成功后表单回到初始状态——文本字段清空、类型与来源回默认、已有说明选择与草稿标记清掉；
        // 保留项目与执行者；允许改动的文件 / 验收命令的初始状态是项目配置默认值，下次进入时重新取。
        await goto('new');
        await check('UI16 派发成功后回到新建任务页是空白表单（项目保留、来源回默认）', `(() => { const v = f => document.querySelector('[data-nt-f=' + f + ']')?.value ?? ''; return v('title') === '' && v('goal') === '' && v('nonGoals') === '' && v('refs') === '' && v('questions') === '' && v('text') === '' && document.querySelector('[data-nt-type=code]')?.classList.contains('on') && document.querySelector('[data-nt-source=new]')?.classList.contains('on') && document.querySelector('[data-nt-project]')?.textContent.includes('sample') && document.querySelector('[data-nt-commit]')?.getAttribute('aria-checked') === 'true' && v('allowed') === 'README.md' && v('verify') === 'node --version'; })()`);

        // 直接写任务文字：不生成文件、不提交，start 行的 spec 为空。
        await goto('text');
        await check('UI16 直接写文字时隐藏"先提交任务说明"', `!document.querySelector('[data-nt-commit]') && !!document.querySelector('[data-nt-f=text]')`);
        await type('[data-nt-f=text]', 'Update the README title only.');
        await check('UI16 直接写文字时说明栏写文字与执行者，并说明直接改、不跑门禁、不进验收页', `document.querySelector('[data-nt-note]')?.textContent === ${JSON.stringify('直接把这段文字派给 假执行者：在项目里直接改，不跑门禁，也不进验收页')}`);
        await shot('newtask-text');
        await press('[data-nt-dispatch]');
        await wait('document.querySelector("[data-page=tasks]")?.getAttribute("aria-current") === "page" && !!document.querySelector(".trow.on")', '直接写文字派发后切回任务页并选中', 20000);
        const textId = await selectedId();
        await check('UI16 直接写文字派发后切回任务页并选中新任务', `document.querySelector('.trow.on')?.dataset.task === ${JSON.stringify(textId)}`);
        await verify('UI16 直接写文字派发：start 行的 spec 为 null，profile=fake', async () => {
            const start = (await runs()).find(r => r.event === 'start' && r.id === textId);
            assert.ok(start, `runs.jsonl 里没有 ${textId} 的 start 行`);
            assert.equal(start.spec, null);
            assert.equal(start.profile, 'fake');
        });
        await until(async () => (await runs()).some(r => r.event === 'end' && r.id === textId), '假执行者结束');

        // 提交身份：选没有身份的项目时出现警告横幅；先提交任务说明失败后补身份，再派发不重复编号。
        await goto('new');
        await press('[data-nt-project]');
        await wait('!!document.querySelector(".ctx")', '项目下拉');
        await press(await menuItem('noidentity'));
        await wait(`document.querySelector('[data-nt-path]')?.textContent.includes('noidentity') && !!document.querySelector('[data-nt-identity]')`, '选到没有提交身份的项目', 20000);
        await check('UI16 没有提交身份的项目：表单上方显示警告横幅与"设置提交身份…"按钮', `document.querySelector('.doc-in.narrow > .banner.brand')?.textContent.includes('还没有设置 git 提交身份') && !!document.querySelector('.doc-in.narrow > .banner.brand [data-nt-identity]') && !document.querySelector('[data-nt-dispatch]').disabled`);
        await shot('newtask-identity');
        await press('[data-nt-f=title]');
        await key('a', ['control']);
        await key('Backspace');
        await type('[data-nt-f=title]', 'Identity retry task');
        await press('[data-nt-f=goal]');
        await key('a', ['control']);
        await key('Backspace');
        await type('[data-nt-f=goal]', 'Create a spec without a git identity first.');
        const noidHead = git(noid, ['rev-parse', 'HEAD']);
        await press('[data-nt-dispatch]');
        await wait('!!document.querySelector(".banner.fail [data-nt-identity]")', '缺少提交身份时的失败横幅', 30000);
        await check('UI16 先提交任务说明失败："派发没有完成"横幅带设置按钮与核心说明', `document.querySelector('.banner.fail .rt b')?.textContent === '派发没有完成' && document.querySelector('.banner.fail').textContent.includes('还没有设置 git 提交身份') && !!document.querySelector('.banner.fail [data-nt-identity]')`);
        await verify('UI16 没有身份时不产生提交，但任务说明文件已经写好', async () => {
            assert.equal(git(noid, ['rev-parse', 'HEAD']), noidHead);
            assert.equal((await specFilesIn(noidSpecs)).length, 1);
        });
        await press('.banner.fail [data-nt-identity]');
        await wait('!!document.querySelector(".sheet [data-id-f=name]")', '设置提交身份模态框');
        await typeIn('[data-id-f=name]', 'Retry Identity');
        await typeIn('[data-id-f=email]', 'retry@example.invalid');
        await press('.sheet-btns .btn:last-child');
        await wait('!document.querySelector(".sheet") && !document.querySelector("[data-nt-identity]") && !document.querySelector(".banner.fail")', '设置身份后警告与失败横幅消失', 20000);
        await check('UI16 设置身份后警告横幅消失，表单内容保留', `document.querySelector('[data-nt-f=title]')?.value === 'Identity retry task' && !document.querySelector('.doc-in.narrow > .banner.brand')`);
        await press('[data-nt-dispatch]');
        await wait('document.querySelector("[data-page=tasks]")?.getAttribute("aria-current") === "page" && !!document.querySelector(".trow.on")', '补好身份后派发成功', 20000);
        const retryId = await selectedId();
        await verify('UI16 补好身份后再派发：沿用已写好的任务说明，不重复编号', async () => {
            const files = await specFilesIn(noidSpecs);
            assert.equal(files.length, 1, `任务说明数量不对：${files.join('、')}`);
            const start = (await runs()).find(r => r.event === 'start' && r.id === retryId);
            assert.ok(start, `runs.jsonl 里没有 ${retryId} 的 start 行`);
            assert.equal(start.spec, `docs/specs/${files[0]}`);
        });
        // 043：补好身份后派发前先补提交；说明文件在最近一次提交里，派发记录也存在。
        await verify('UI16 补好身份后再派发：说明文件已在最近一次提交里，派发记录存在', async () => {
            const files = await specFilesIn(noidSpecs);
            const committed = git(noid, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
            assert.deepEqual(committed, [`docs/specs/${files[0]}`]);
            assert.ok((await runs()).some(r => r.event === 'start' && r.id === retryId), `runs.jsonl 里没有 ${retryId} 的 start 行`);
        });
        await until(async () => (await runs()).some(r => r.event === 'end' && r.id === retryId), '假执行者结束');
        // 切回原来的项目，后面的检查仍按 sample 的默认值走。
        await goto('new');
        await press('[data-nt-project]');
        await wait('!!document.querySelector(".ctx")', '项目下拉');
        await press(await menuItem('sample'));
        await wait(`document.querySelector('[data-nt-path]')?.textContent.includes('· main')`, '切回 sample', 20000);

        // 必填项为空：不发请求、不生成文件、不新增任务行；提示出现且焦点回到该字段。
        await goto('new');
        await press('[data-nt-f=title]');
        await key('a', ['control']);
        await key('Backspace');
        await check('UI16 清空必填标题', `document.querySelector('[data-nt-f=title]').value === ''`);
        const beforeEmpty = { runs: (await runs()).length, files: await specFiles() };
        await press('[data-nt-dispatch]');
        await wait('!!document.querySelector("[data-nt-required]")', '必填提示');
        await check('UI16 必填项为空：提示"请填写标题"且焦点在标题框', `document.querySelector('[data-nt-required]')?.textContent === '请填写标题' && document.activeElement === document.querySelector('[data-nt-f=title]')`);
        await pause(1200);
        await verify('UI16 必填项为空不发派发请求，也不生成文件或任务行', async () => {
            assert.equal((await runs()).length, beforeEmpty.runs);
            assert.deepEqual(await specFiles(), beforeEmpty.files);
        });
        await check('UI16 必填项为空时仍停留在新建任务页', `document.querySelector('[data-page=newtask]').getAttribute('aria-current') === 'page' && !document.querySelector('.banner.fail')`);

        // 失败：执行者在缓存里还是可用的，停用后核心拒绝派发；界面显示顶部横幅并恢复表单。
        await goto('existing');
        await wait('!!document.querySelector("[data-nt-spec].on")');
        // 前面新建过一份说明，按修改时间排序后默认选中的已不是 001；记下当前选中项再比较"内容保留"。
        const failSpec = await evaluate('document.querySelector("[data-nt-spec].on")?.dataset.ntSpec');
        const beforeFail = (await runs()).length;
        await writeFile(configFile, disabledText);
        try {
            await press('[data-nt-dispatch]');
            await wait('!!document.querySelector(".banner.fail .rt b")', '派发失败横幅', 20000);
            await check('UI16 派发失败：顶部横幅写明"派发没有完成"和核心原因', `document.querySelector('.banner.fail .rt b')?.textContent === '派发没有完成' && document.querySelector('.banner.fail .rt span')?.textContent.includes('已停用')`);
            await check('UI16 派发失败后按钮恢复、内容保留', `!document.querySelector('[data-nt-dispatch]').disabled && document.querySelector('[data-nt-spec].on')?.dataset.ntSpec === ${JSON.stringify(failSpec)} && document.querySelector('[data-nt-source=existing]')?.classList.contains('on')`);
            await shot('newtask-fail');
            await pause(1000);
            await verify('UI16 派发失败不写入新的任务行', async () => { assert.equal((await runs()).length, beforeFail); });
        }
        finally { await writeFile(configFile, fakeText); }

        // ---- UI29（Stage07）：执行者选"自动"时按路由规则实时显示会派给谁、为什么 ----
        // 用测试自己写的执行者配置：一条 research → 阅读执行者 的全局规则；其余类型走默认执行者（兜底）。
        const researchRel = 'docs/specs/002-调研说明.md', researchFile = path.join(specs, '002-调研说明.md');
        const routeCore = async (args: string[]) => (await coreRun(['route', ...args, '--explain'], { timeoutMs: 60000, cwd: repo })).json;
        const reader = { ...fake.profiles.fake, label: '阅读执行者' };
        const routedText = JSON.stringify({ ...fake, profiles: { fake: fake.profiles.fake, reader }, routing: { rules: [{ types: ['research'], profile: 'reader' }], fallback: null, reviewer: null } }, null, 2) + '\n';
        const hintNow = async () => JSON.parse(await evaluate(`JSON.stringify((() => { const h = document.querySelector('[data-nt-route]'); return { text: h?.querySelector('span')?.textContent ?? null, profile: h?.dataset.ntRouteProfile ?? null, failed: h?.dataset.ntRouteFailed === '1', trace: [...document.querySelectorAll('[data-nt-route-trace] li')].map(li => li.textContent), expanded: h?.querySelector('[data-nt-route-why]')?.getAttribute('aria-expanded') ?? null }; })())`)) as { text: string | null; profile: string | null; failed: boolean; trace: string[]; expanded: string | null };
        const waitHint = (profile: string, label: string) => wait(`document.querySelector('[data-nt-route]')?.dataset.ntRouteProfile === ${JSON.stringify(profile)}`, label);
        const reenter = async (source: 'existing' | 'new' | 'text') => { await press('[data-page=tasks]'); await wait('!!document.querySelector("[data-task=t1]")'); await goto(source); };
        await writeFile(researchFile, [
            '---', 'id: 002', 'title: 调研说明：看看 README', 'type: research', 'worker: auto', 'allowed_paths: []', 'verify: []', '---', '',
            '## 目标', '', '读一遍 README，写出你觉得缺的说明。', '',
        ].join('\n'));
        await writeFile(configFile, routedText);
        try {
            await reenter('new');
            await wait('!!document.querySelector("[data-nt-route]")', 'UI29 "自动"下面出现路由提示');
            await check('UI29 执行者下拉显示 ro.autoByRule，下面一行 route-hint（图标、文字、"为什么"按钮）', `document.querySelector('[data-nt-worker] span').textContent === ${JSON.stringify(ro.autoByRule)} && !!document.querySelector('.route-hint > i.ri-route-line') && document.querySelector('[data-nt-route-why]').textContent.trim() === ${JSON.stringify(ro.hintWhy)} && document.querySelector('[data-nt-route-why]').getAttribute('aria-expanded') === 'false'`);
            await press('[data-nt-worker]');
            await wait('!!document.querySelector(".ctx")', 'UI29 执行者下拉');
            await check('UI29 执行者下拉第一项是 ro.autoByRule，其余是各个执行者', `[...document.querySelectorAll('.ctx button')].map(b => b.textContent.trim()).join() === ${JSON.stringify([ro.autoByRule, '假执行者', '阅读执行者'].join())}`);
            await key('Escape');
            // 类型是 code：没有规则符合，走默认执行者（兜底）。
            await waitHint('fake', 'UI29 类型 code 的提示是兜底 → 假执行者');
            await verify('UI29 类型 code：提示是 ro.hint(假执行者, 兜底)，底部说明里"派给"的是 假执行者', async () => {
                const hint = await hintNow();
                assert.equal(hint.text, ro.hint('假执行者', ro.whyFallback));
                assert.equal(await evaluate(`document.querySelector('[data-nt-note]').textContent.includes('假执行者')`), true);
            });
            // 点类型：code → research，提示里的执行者随之变成阅读执行者。
            await press('[data-nt-type=research]');
            await waitHint('reader', 'UI29 类型点到 research：提示变成 阅读执行者');
            await verify('UI29 类型点到 research：提示是 ro.hint(阅读执行者, 全局规则 1：调研)，底部说明里"派给"的是 阅读执行者，并与核心 ar route 一致', async () => {
                const hint = await hintNow(), expected = await routeCore(['--type', 'research', '--project', repo]);
                assert.equal(expected.profile, 'reader');
                assert.equal(hint.text, ro.hint('阅读执行者', ro.whyRule(ro.scopeGlobal, 1, ro.types.research)));
                assert.equal(await evaluate(`document.querySelector('[data-nt-note]').textContent.includes('阅读执行者')`), true, '底部说明用路由结果的显示名');
            });
            await check('UI29 展开前 trace 不显示', '!document.querySelector("[data-nt-route-trace]")');
            await press('[data-nt-route-why]');
            await wait('!!document.querySelector("[data-nt-route-trace] li")', 'UI29 展开"为什么"');
            await verify('UI29 展开"为什么"：逐行显示 trace（等宽字体），与核心 ar route --explain 一致；按钮 aria-expanded 为 true', async () => {
                const hint = await hintNow(), expected = await routeCore(['--type', 'research', '--project', repo]);
                assert.deepEqual(hint.trace, expected.trace);
                assert.equal(hint.expanded, 'true');
                assert.equal(await evaluate(`document.querySelector('[data-nt-route-trace]').classList.contains('mono')`), true);
            });
            await evaluate('document.querySelector("[data-nt-route-box]").scrollIntoView({ block: "center" })');
            await pause(300);
            await shot('newtask-route');
            // 键盘：在类型分段上用方向键连续切换，最后停在 research；旧请求返回晚了不能盖掉新的。
            await tabTo('[data-nt-type=research]');
            await key('Right');
            await key('Left');
            await key('Right');
            await key('Left');
            await wait(`document.querySelector('[data-nt-type=research]').classList.contains('on')`, 'UI29 方向键回到 research');
            await pause(1200);
            await verify('UI29 连续切换类型后，提示是最后一次输入（research）的结果，没有被旧请求盖掉', async () => {
                const hint = await hintNow();
                assert.equal(hint.profile, 'reader');
                assert.equal(hint.text, ro.hint('阅读执行者', ro.whyRule(ro.scopeGlobal, 1, ro.types.research)));
            });
            await key('Right');
            await waitHint('fake', 'UI29 方向键到 docs：提示回到兜底');
            await verify('UI29 方向键切到 docs：提示回到 假执行者（兜底）', async () => { assert.equal((await hintNow()).text, ro.hint('假执行者', ro.whyFallback)); });

            // 选择已有任务说明：选中的说明改变时用 --spec；新写的 002 类型是 research。
            await reenter('existing');
            await wait('!!document.querySelector("[data-nt-spec]")');
            await press(`[data-nt-spec="${researchRel}"]`);
            await waitHint('reader', 'UI29 已有说明（选中 002，type: research）→ 阅读执行者');
            await verify('UI29 已有说明：提示按选中的说明算（--spec），与核心 ar route --spec 一致', async () => {
                const hint = await hintNow(), expected = await routeCore(['--spec', researchRel, '--project', repo]);
                assert.equal(expected.profile, 'reader');
                assert.equal(await evaluate('document.querySelector("[data-nt-spec].on")?.dataset.ntSpec'), researchRel);
                assert.equal(hint.text, ro.hint('阅读执行者', ro.whyRule(ro.scopeGlobal, 1, ro.types.research)));
            });
            await press(`[data-nt-spec="${specRel}"]`);
            await waitHint('fake', 'UI29 选中 001（type: docs）：提示变成 假执行者（兜底）');
            await verify('UI29 换选 001：提示随之改变，与核心 ar route --spec 一致', async () => {
                const hint = await hintNow(), expected = await routeCore(['--spec', specRel, '--project', repo]);
                assert.equal(expected.profile, 'fake');
                assert.equal(hint.text, ro.hint('假执行者', ro.whyFallback));
                assert.equal(await evaluate(`document.querySelector('[data-nt-note]').textContent.includes(${JSON.stringify(specRel)}) && document.querySelector('[data-nt-note]').textContent.includes('假执行者')`), true);
            });

            // 直接写任务文字：没有类型，显示兜底的结果。
            await goto('text');
            await waitHint('fake', 'UI29 直接写文字：提示是兜底');
            await verify('UI29 直接写文字：没有类型，提示是兜底（假执行者），与核心 ar route（不带类型）一致', async () => {
                const hint = await hintNow(), expected = await routeCore(['--project', repo]);
                assert.deepEqual(expected.trace, ['兜底：fake']);
                assert.equal(hint.text, ro.hint('假执行者', ro.whyFallback));
            });

            // 选了具体执行者：不显示路由提示，底部说明用它；再选回"自动"提示又出现。
            await press('[data-nt-worker]');
            await wait('!!document.querySelector(".ctx")', 'UI29 执行者下拉');
            await press(await menuItem('阅读执行者'));
            await wait('!document.querySelector("[data-nt-route]")', 'UI29 选了具体执行者：路由提示消失');
            await check('UI29 选了具体执行者：执行者下拉显示它，不显示路由提示，底部说明写 阅读执行者', `document.querySelector('[data-nt-worker] span').textContent === '阅读执行者' && !document.querySelector('[data-nt-route]') && document.querySelector('[data-nt-note]').textContent === ${JSON.stringify(nt.conseqText('阅读执行者'))}`);
            await press('[data-nt-worker]');
            await wait('!!document.querySelector(".ctx")', 'UI29 执行者下拉（选回自动）');
            await press(await menuItem(ro.autoByRule));
            await waitHint('fake', 'UI29 选回自动：路由提示回来');

            // 没有可用的执行者：显示原因，派发按钮照常可点，真点下去由核心给出同样的原因。
            const failText = JSON.stringify({ ...fake, profiles: { fake: { ...fake.profiles.fake, limits: { maxTasksPerDay: 1 } } }, routing: { rules: [{ types: ['research'], profile: 'fake' }], fallback: null, reviewer: null } }, null, 2) + '\n';
            await writeFile(configFile, failText);
            const todays = (await runs()).filter(r => r.event === 'start' && r.profile === 'fake' && new Date(r.started).toDateString() === new Date().toDateString()).length;
            let fixture = '';
            if (todays < 1) { fixture = JSON.stringify({ v: 1, event: 'start', id: 'ui29-limit', profile: 'fake', started: Date.now() }) + '\n'; await writeFile(runsFile, (await readFile(runsFile, 'utf8').catch(() => '')) + fixture); }
            try {
                await reenter('existing');
                await wait('!!document.querySelector("[data-nt-route][data-nt-route-failed]")', 'UI29 路由失败的提示');
                await verify('UI29 没有可用的执行者：提示是 ro.hintFail(核心原因)，"为什么"可展开 trace（含"已达每日上限"），与核心 ar route 一致', async () => {
                    const expected = await routeCore(['--spec', await evaluate('document.querySelector("[data-nt-spec].on").dataset.ntSpec'), '--project', repo]);
                    assert.equal(expected.ok, false);
                    assert.equal(expected.code, 'NO_PROFILE');
                    assert.equal((await hintNow()).text, ro.hintFail(expected.error));
                    // 展开状态是页面记住的（前面已经展开过一次）：没展开才点。
                    if ((await hintNow()).expanded !== 'true') await press('[data-nt-route-why]');
                    await wait('!!document.querySelector("[data-nt-route-trace] li")', 'UI29 展开失败原因');
                    const hint = await hintNow();
                    assert.deepEqual(hint.trace, expected.trace);
                    assert.ok(hint.trace.some(line => line.includes('已达每日上限')));
                });
                await check('UI29 路由失败时派发按钮照常可点（不额外拦截）', `!document.querySelector('[data-nt-dispatch]').disabled`);
                await evaluate('document.querySelector("[data-nt-route-box]").scrollIntoView({ block: "center" })');
                await pause(300);
                await shot('newtask-route-fail');
                const startsBefore = (await runs()).length;
                await press('[data-nt-dispatch]');
                await wait('!!document.querySelector(".banner.fail .rt b")', 'UI29 派发失败横幅', 20000);
                await check('UI29 真点派发：核心用同样的原因拒绝（没有可用的执行者、已达每日上限），横幅是"派发没有完成"', `document.querySelector('.banner.fail .rt b')?.textContent === '派发没有完成' && document.querySelector('.banner.fail .rt span')?.textContent.includes('没有可用的执行者') && document.querySelector('.banner.fail .rt span')?.textContent.includes('已达每日上限')`);
                await verify('UI29 被拒绝的派发不写任何任务行', async () => { assert.equal((await runs()).length, startsBefore); });
            }
            finally {
                if (fixture) await writeFile(runsFile, (await readFile(runsFile, 'utf8')).split('\n').filter(line => !line.includes('ui29-limit')).join('\n')).catch(() => { });
            }
        }
        finally {
            await writeFile(configFile, fakeText);
            await rm(researchFile, { force: true });
            // 回到没有规则的状态：重新进入页面，后面的通用检查与以前一样。
            await reenter('existing').catch(() => { });
        }

        // ---- UI16（Stage07c 151，T6）：新建任务说明里的推理强度 ----
        // 配置 = 假执行者 + 由核心 ar agents add 按预设加入的 Claude（订阅令牌）和 DeepSeek Harness（预设声明不支持推理强度）；不派发，
        // 生成的任务说明用"预览"看（和派发时同一份 ar spec new 的结果）。结束时配置还原。
        const effortSpecRel = (src: string) => /^effort: (.+)$/m.exec(src)?.[1] ?? null;
        const previewSource = async () => {
            await press('[data-nt-preview]');
            await wait('!!document.querySelector(".sheet.wide .mdsrc.selectable")', 'UI16c 预览模态框', 15000);
            const src = String(await evaluate(`document.querySelector('.sheet.wide .mdsrc').textContent`));
            await press('.sheet.wide [data-sheet-btn="0"]');
            await wait('!document.querySelector(".sheet")', 'UI16c 关闭预览');
            return src;
        };
        const effortMenu = async () => JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.ctx button')].map(b => b.textContent.trim()))`)) as string[];
        const chooseWorker = async (label: string) => {
            await press('[data-nt-worker]');
            await wait('!!document.querySelector(".ctx")', `UI16c 执行者下拉（选 ${label}）`);
            await press(await menuItem(label));
            await wait('!document.querySelector(".ctx")', `UI16c 选了 ${label}`);
        };
        const chooseEffort = async (label: string) => {
            await press('[data-nt-effort]');
            await wait('!!document.querySelector(".ctx")', `UI16c 推理强度下拉（选 ${label}）`);
            await press(await menuItem(label));
            await wait('!document.querySelector(".ctx")', `UI16c 选了 ${label}`);
        };
        await writeFile(configFile, fakeText);
        await core(['agents', 'add', '--preset', 'claude-subscription', '--label', 'Claude 测试']);
        await core(['agents', 'add', '--preset', 'deepseek-harness', '--label', 'Harness 测试']);
        const presetEfforts: string[] = (await core(['agents', 'presets'])).presets.find((x: any) => x.name === 'claude-subscription').effortOptions;
        assert.ok(presetEfforts.length >= 2 && !(await core(['agents', 'presets'])).presets.find((x: any) => x.name === 'deepseek-harness').supportsEffort, '预设：Claude 有推理强度选项，DeepSeek Harness 不支持');
        const effortFixtureConfig = await readFile(configFile, 'utf8');
        try {
            await reenter('new');
            // 标题和目标是预览的前提；本段自己填的，结束时清掉（不影响后面的检查）。
            const filled: string[] = [];
            for (const [field, text] of [['title', 'Effort notes'], ['goal', 'Check the effort field.']]) {
                if (await evaluate(`document.querySelector("[data-nt-f=${field}]").value`)) continue;
                await type(`[data-nt-f=${field}]`, text);
                filled.push(field);
            }
            await wait('!!document.querySelector("[data-nt-effort]")', 'UI16c 推理强度一行出现');
            await check('UI16c 新建任务说明：执行者下面多一行推理强度（标签 gx.effort，默认"默认"），说明文案是占位', `(() => { const box = document.querySelector('[data-nt-effort-box]'), b = box.querySelector('[data-nt-effort]'); return box.previousElementSibling.querySelector('[data-nt-worker]') !== null && box.querySelector('.fl b').textContent === ${JSON.stringify(gx.effort)} && b.textContent.trim() === ${JSON.stringify(gx.effortDefault)} && b.getAttribute('aria-label') === ${JSON.stringify(gx.effort)} && box.querySelector('.fl span').textContent.length > 0; })()`);
            await verify('UI16c 默认执行者（假执行者，没有推理强度的选项）：推理强度下拉只有"默认"', async () => {
                await press('[data-nt-effort]');
                await wait('!!document.querySelector(".ctx")', 'UI16c 推理强度下拉');
                assert.deepEqual(await effortMenu(), [gx.effortDefault]);
                await key('Escape');
            });
            await chooseWorker('Claude 测试');
            await press('[data-nt-effort]');
            await wait('!!document.querySelector(".ctx")', 'UI16c Claude 的推理强度下拉');
            await verify('UI16c 选了 Claude 测试：推理强度下拉第一项"默认"，其余是它预设的选项', async () => { assert.deepEqual(await effortMenu(), [gx.effortDefault, ...presetEfforts]); });
            await key('Escape');
            await chooseEffort('high');
            await check('UI16c 选了 high：下拉显示 high', `document.querySelector('[data-nt-effort] span').textContent === 'high'`);
            await evaluate('document.querySelector("[data-nt-effort-box]").scrollIntoView({ block: "center" })');
            await pause(300);
            await shot('newtask-effort');
            await verify('UI16c 预览：生成的任务说明 frontmatter 有 effort: high，worker 是 claude-subscription', async () => {
                const src = await previewSource();
                assert.equal(effortSpecRel(src), 'high', src);
                assert.match(src, /^worker: claude-subscription$/m);
            });
            await chooseEffort(gx.effortDefault);
            await verify('UI16c 选"默认"：生成的任务说明没有 effort 行', async () => { const src = await previewSource(); assert.equal(effortSpecRel(src), null, src); });
            // 换执行者：当前强度不在新执行者的选项里时换成"默认"并提示一句。
            await chooseEffort('high');
            await chooseWorker('假执行者');
            await check('UI16c 换成假执行者（没有 high 这个选项）：推理强度换成"默认"，出现提示（含 high）', `(() => { const n = document.querySelector('[data-nt-effort-note]'); return document.querySelector('[data-nt-effort] span').textContent === ${JSON.stringify(gx.effortDefault)} && !!n && n.textContent.includes('high'); })()`);
            await verify('UI16c 换成假执行者后生成的任务说明没有 effort 行', async () => { const src = await previewSource(); assert.equal(effortSpecRel(src), null, src); });
            // 不支持推理强度的执行者：这一行隐藏；已选了强度再换成它时，原位置显示一句"已忽略"，生成的任务说明不写 effort。
            await chooseWorker('Harness 测试');
            await check('UI16c 选了不支持推理强度的 Harness 测试：推理强度一行隐藏（不是禁用）', `!!document.querySelector('[data-nt-effort-box]') && document.querySelector('[data-nt-effort-box]').children.length === 0 && !document.querySelector('[data-nt-effort]')`);
            await chooseWorker('Claude 测试');
            await chooseEffort('high');
            await chooseWorker('Harness 测试');
            await check('UI16c 已选 high 再换成 Harness 测试：原位置显示 ro.effortUnsupported，没有下拉', `(() => { const t = document.querySelector('[data-nt-effort-ignored]'); return !!t && t.textContent === ${JSON.stringify(ro.effortUnsupported)} && !document.querySelector('[data-nt-effort]') && t.closest('.fld').querySelector('.fl b').textContent === ${JSON.stringify(gx.effort)}; })()`);
            await shot('newtask-effort-ignored');
            await verify('UI16c 不支持的执行者：生成的任务说明不写 effort', async () => { const src = await previewSource(); assert.equal(effortSpecRel(src), null, src); assert.match(src, /^worker: deepseek-harness$/m); });
            // 执行者选"自动"且按路由规则时，选项来自路由结果的执行者。
            await writeFile(configFile, JSON.stringify({ ...JSON.parse(effortFixtureConfig), routing: { rules: [{ types: ['code', 'test', 'fix', 'refactor', 'research', 'docs', 'review'], profile: 'claude-subscription' }], fallback: null, reviewer: null } }, null, 2) + '\n');
            await reenter('new');
            await chooseWorker(ro.autoByRule);
            await wait('!!document.querySelector("[data-nt-route]")', 'UI16c 路由提示');
            await waitHint('claude-subscription', 'UI16c 自动按规则派给 Claude 测试');
            await check('UI16c 执行者是"自动（按路由规则）"，推理强度一行仍在', `document.querySelector('[data-nt-worker] span').textContent === ${JSON.stringify(ro.autoByRule)} && !!document.querySelector('[data-nt-effort]')`);
            await press('[data-nt-effort]');
            await wait('!!document.querySelector(".ctx")', 'UI16c 自动时的推理强度下拉');
            await verify('UI16c 自动：推理强度的选项来自路由结果的执行者（Claude 测试）', async () => { assert.deepEqual(await effortMenu(), [gx.effortDefault, ...presetEfforts]); });
            await key('Escape');
            // 后面的检查不带强度、不带标题和目标：选回"默认"，清掉本段填的字段。
            await chooseEffort(gx.effortDefault);
            for (const field of filled) { await focusField(`[data-nt-f=${field}]`); await key('a', ['control']); await key('Backspace'); }
        }
        finally {
            await writeFile(configFile, fakeText);
            await reenter('existing').catch(() => { });
        }

        // ---- UI16（Stage07 T8b）：新建说明里"允许改动的文件"下面实时显示会匹配到的现有文件 ----
        // 用测试自己的临时仓库（src/a.ts、src/b.ts、README.md），检查结束后取消登记。
        const pathsRepo = path.join(home, 'shots-newtask', 'paths');
        await mkdir(path.join(pathsRepo, 'src'), { recursive: true });
        await writeFile(path.join(pathsRepo, 'src', 'a.ts'), 'export const a = 1;\n');
        await writeFile(path.join(pathsRepo, 'src', 'b.ts'), 'export const b = 2;\n');
        await writeFile(path.join(pathsRepo, 'README.md'), '# paths\n');
        git(pathsRepo, ['init', '-b', 'main']);
        git(pathsRepo, ['config', 'user.name', 'AgentRouter Shots']);
        git(pathsRepo, ['config', 'user.email', 'shots@example.invalid']);
        git(pathsRepo, ['add', '--', 'README.md', 'src/a.ts', 'src/b.ts']);
        git(pathsRepo, ['commit', '-m', '初始提交', '--', 'README.md', 'src/a.ts', 'src/b.ts']);
        await core(['projects', 'add', pathsRepo]);
        const pathsBox = async () => JSON.parse(await evaluate(`JSON.stringify((() => {
            const box = document.querySelector('[data-nt-paths-box]'), q = s => box?.querySelector(s);
            return { kind: q('[data-nt-paths]')?.dataset.ntPaths ?? null, text: q('[data-nt-paths]')?.textContent ?? null,
                files: [...(box?.querySelectorAll('[data-nt-paths=matched] .mono') ?? [])].map(e => e.textContent),
                none: [...(box?.querySelectorAll('[data-nt-paths-none]') ?? [])].map(e => ({ pattern: e.dataset.ntPathsNone, text: e.textContent, icon: !!e.querySelector('.mk.brand > i') })),
                allowed: document.querySelector('[data-nt-f=allowed]')?.value ?? null, below: !!box && box.previousElementSibling?.matches('[data-nt-f=allowed]') };
        })())`)) as { kind: string | null; text: string | null; files: string[]; none: { pattern: string; text: string; icon: boolean }[]; allowed: string | null; below: boolean };
        const clearAllowed = async () => { await focusField('[data-nt-f=allowed]'); await key('a', ['control']); await key('Backspace'); };
        try {
            await reenter('new');
            await press('[data-nt-project]');
            await wait('!!document.querySelector(".ctx")', 'UI16 项目下拉');
            await press(await menuItem('paths'));
            await wait(`document.querySelector('[data-nt-path]')?.textContent.includes('paths') && document.querySelector('[data-nt-path]')?.textContent.includes('· main')`, 'UI16 选到 paths 项目', 20000);
            await check('UI16 允许路径预览：输入框为空时不显示预览', `document.querySelector('[data-nt-f=allowed]').value === '' && !document.querySelector('[data-nt-paths]') && !document.querySelector('[data-nt-paths-none]')`);

            // 1. 输入 src/**：匹配到 2 个现有文件，列出文件名。
            await type('[data-nt-f=allowed]', 'src/**');
            await wait(`document.querySelector('[data-nt-paths=matched]') !== null`, 'UI16 输入 src/** 后出现匹配预览', 15000);
            await verify('UI16 允许路径预览：src/** → nt.pathsMatched(2) 和两个文件名（等宽、用"、"连接），在输入框正下方', async () => {
                const box = await pathsBox();
                assert.equal(box.below, true, '预览应紧跟在输入框下面');
                assert.deepEqual(box.files, ['src/a.ts', 'src/b.ts']);
                assert.equal(box.text, `${nt.pathsMatched(2)}src/a.ts、src/b.ts`);
                assert.deepEqual(box.none, []);
            });
            await verify('UI16 允许路径预览：显示的数字与核心 ar spec check-paths 一致', async () => {
                const expected = await core(['spec', 'check-paths', '--project', pathsRepo, '--paths', JSON.stringify(['src/**'])]);
                assert.equal(expected.total, 2);
                assert.deepEqual(expected.files, (await pathsBox()).files);
            });

            // 2. 再加一行 docs/new.md：多一行"没有匹配到现有文件"的提示，上面的匹配结果不变。
            await focusField('[data-nt-f=allowed]');
            await key('End', ['control']);
            await key('Enter');
            for (const ch of 'docs/new.md') await key(ch);
            await wait(`document.querySelector('[data-nt-paths-none]') !== null`, 'UI16 加一行 docs/new.md 后出现"没有匹配到"的提示', 15000);
            await verify('UI16 允许路径预览：docs/new.md → 一行 nt.pathsNone("docs/new.md")（品牌色提示图标），匹配到的 2 个文件不变', async () => {
                const box = await pathsBox();
                assert.equal(box.allowed, 'src/**\ndocs/new.md');
                assert.deepEqual(box.files, ['src/a.ts', 'src/b.ts']);
                assert.deepEqual(box.none, [{ pattern: 'docs/new.md', text: nt.pathsNone('docs/new.md'), icon: true }]);
            });
            await check('UI16 允许路径预览：没有匹配时只是提示，不拦派发（派发按钮可点）', `document.querySelector('[data-nt-dispatch]') !== null && !document.querySelector('[data-nt-dispatch]').disabled`);
            await evaluate('document.querySelector("[data-nt-paths-box]").scrollIntoView({ block: "center" })');
            await pause(300);
            await shot('newtask-paths');

            // 3. 改成 **：显示匹配项目里全部 3 个文件。
            await clearAllowed();
            await check('UI16 允许路径预览：清空输入框后预览消失', `document.querySelector('[data-nt-f=allowed]').value === '' && !document.querySelector('[data-nt-paths]')`);
            await typeIn('[data-nt-f=allowed]', '**');
            await wait(`document.querySelector('[data-nt-paths=all]') !== null`, 'UI16 输入 ** 后显示全部文件', 15000);
            await verify('UI16 允许路径预览：** → 只写 nt.pathsAll(3)，不列文件名', async () => {
                const box = await pathsBox();
                assert.equal(box.text, nt.pathsAll(3));
                assert.deepEqual(box.files, []);
                assert.deepEqual(box.none, []);
                const expected = await core(['spec', 'check-paths', '--project', pathsRepo, '--paths', JSON.stringify(['**'])]);
                assert.deepEqual([expected.all, expected.fileCount], [true, 3]);
            });
            await evaluate('document.querySelector("[data-nt-paths-box]").scrollIntoView({ block: "center" })');
            await pause(300);
            await shot('newtask-paths-all');

            // 写法不合法：显示 nt.pathsFailed(核心的原因)，派发按钮不被拦。
            await clearAllowed();
            await typeIn('[data-nt-f=allowed]', '../x');
            await wait(`document.querySelector('[data-nt-paths=failed]') !== null`, 'UI16 写法不合法时显示失败原因', 15000);
            await verify('UI16 允许路径预览：../x → nt.pathsFailed(原因) 并写明是哪一项', async () => {
                const box = await pathsBox();
                assert.ok(box.text?.startsWith(nt.pathsFailed('')), box.text ?? '');
                assert.ok(box.text?.includes('第 1 项') && box.text.includes('../x'), box.text ?? '');
            });

            // 只在"新建任务说明"来源下显示；切回来重新检查。
            await clearAllowed();
            await typeIn('[data-nt-f=allowed]', 'src/*.ts');
            await wait(`document.querySelector('[data-nt-paths=matched]') !== null`, 'UI16 输入 src/*.ts');
            await press('[data-nt-source=existing]');
            // paths 项目里没有任务说明：已有说明来源显示"还没有任务说明"。
            await wait(`document.querySelector('[data-nt-specs-empty]') !== null`, 'UI16 切到已有说明');
            await check('UI16 允许路径预览：已有说明来源下不显示', `!document.querySelector('[data-nt-paths-box]') && !document.querySelector('[data-nt-paths]')`);
            await press('[data-nt-source=new]');
            await wait(`document.querySelector('[data-nt-paths=matched]') !== null`, 'UI16 切回新建说明后重新检查', 15000);
            await verify('UI16 允许路径预览：切回新建说明后仍是 src/*.ts 的结果（2 个文件）', async () => {
                const box = await pathsBox();
                assert.equal(box.allowed, 'src/*.ts');
                assert.deepEqual(box.files, ['src/a.ts', 'src/b.ts']);
            });
        }
        finally {
            // 回到 sample 项目、取消 paths 项目的登记，后面的检查与以前一样。
            try {
                await reenter('new');
                await press('[data-nt-project]');
                await wait('!!document.querySelector(".ctx")', 'UI16 项目下拉（回到 sample）');
                await press(await menuItem('sample'));
                await wait(`document.querySelector('[data-nt-path]')?.textContent.includes('· main') && document.querySelector('[data-nt-project]')?.textContent.includes('sample')`, 'UI16 回到 sample', 20000);
            }
            catch (error) { console.log(`UI16 允许路径预览：没能回到 sample 项目：${(error as Error).message}`); }
            await coreRun(['projects', 'remove', pathsRepo], { timeoutMs: 60000 }).catch(() => { });
        }

        // ---- UI16（Stage07b T4m）：已归档的任务说明——列表默认不含，展开后带"已归档"标签，选中照样能派发 ----
        // 在 sample 项目里新建一份说明、用核心归档并提交（和软件走同一条命令），再看界面。
        {
            const archivedRel = 'docs/specs/archive/003-归档演示.md';
            await writeFile(path.join(specs, '003-归档演示.md'), [
                '---', 'id: 003', 'title: 归档演示：检查 README 标题', 'type: docs', 'worker: auto', 'allowed_paths: []', 'verify: []', '---', '',
                '## 目标', '', '看一眼 README 的标题。', '',
            ].join('\n'));
            git(repo, ['add', '--', 'docs/specs/003-归档演示.md']);
            commitAs(repo, '演示：提交归档用的说明', ['docs/specs/003-归档演示.md']);
            await core(['spec', 'archive', repo, 'docs/specs/003-归档演示.md', '--commit']);
            await reenter('existing');
            await wait('!!document.querySelector("[data-nt-spec]")');
            await check('UI16 有归档时列表下面出现"显示已归档的 1 份"，默认列表不含已归档', `(() => { const more = document.querySelector('[data-nt-archived]'); return !!more && more.textContent === '显示已归档的 1 份' && !document.querySelector('[data-nt-spec*="archive/"]') && more.classList.contains('quiet'); })()`);
            await press('[data-nt-archived]');
            await wait(`!!document.querySelector('[data-nt-spec="${archivedRel}"]')`, 'UI16 展开已归档的');
            await check('UI16 展开后已归档的项带"已归档"标签、排在未归档的后面，按钮变"收起已归档的"', `(() => { const rows = [...document.querySelectorAll('[data-nt-spec]')], last = rows.at(-1); return last?.dataset.ntSpec === ${JSON.stringify(archivedRel)} && last.querySelector('.xtag')?.textContent === '已归档' && rows.slice(0, -1).every(r => !r.querySelector('.xtag')) && document.querySelector('[data-nt-archived]')?.textContent === '收起已归档的'; })()`);
            await shot('newtask-archived');
            await press(`[data-nt-spec="${archivedRel}"]`);
            await check('UI16 选中已归档的说明后派发说明栏照常', `document.querySelector('[data-nt-spec].on')?.dataset.ntSpec === ${JSON.stringify(archivedRel)} && document.querySelector('[data-nt-note]')?.textContent === ${JSON.stringify(`派发 ${archivedRel} 给 假执行者`)} && !document.querySelector('[data-nt-dispatch]').disabled`);
            await press('[data-nt-dispatch]');
            await wait('document.querySelector("[data-page=tasks]")?.getAttribute("aria-current") === "page" && !!document.querySelector(".trow.on")', '已归档说明派发后切回任务页并选中', 20000);
            const archivedId = await selectedId();
            await verify('UI16 派发已归档的说明：start 行的 spec 是 archive/ 下的路径', async () => {
                const start = (await runs()).find(r => r.event === 'start' && r.id === archivedId);
                assert.ok(start, `runs.jsonl 里没有 ${archivedId} 的 start 行`);
                assert.equal(start.spec, archivedRel);
            });
            await until(async () => (await runs()).some(r => r.event === 'end' && r.id === archivedId), '已归档说明派发的假执行者结束');
            // 再进页面：展开状态缓存在视图里，点"收起已归档的"后列表回到只有未归档的。
            await reenter('existing');
            await wait(`document.querySelector('[data-nt-archived]')?.textContent === '收起已归档的'`, 'UI16 重新进入后仍是展开状态');
            await press('[data-nt-archived]');
            await wait(`!document.querySelector('[data-nt-spec*="archive/"]')`, 'UI16 收起已归档的');
            await check('UI16 收起后按钮变回"显示已归档的 1 份"', `document.querySelector('[data-nt-archived]')?.textContent === '显示已归档的 1 份'`);
        }

        // 每页通用检查：三种来源各走一遍（沿用缓存，不重新加载，避免打断 Tab 检查）。
        await goto('existing');
        await h.audit('新建任务页（已有说明）', async () => { await goto('existing'); });
        await h.audit('新建任务页（新建说明）', async () => { await goto('new'); });
        await h.audit('新建任务页（直接文字）', async () => { await goto('text'); });

        // 没有项目：临时清空 projects.json，截完恢复。
        await press('[data-page=tasks]');
        const projectsBefore = await readFile(projectsFile, 'utf8');
        await writeFile(projectsFile, JSON.stringify({ v: 1, projects: [] }, null, 2) + '\n');
        try {
            await press('[data-page=newtask]');
            await wait('!!document.querySelector(".empty.tall") && !!document.querySelector("[data-nt-ready=\\"1\\"]")', '没有项目时的空状态', 20000);
            await check('UI16 没有项目时显示说明与"添加项目"主按钮', `document.querySelector('.empty.tall b')?.textContent === '先添加一个项目' && document.querySelector('.empty.tall [data-page=projects]')?.classList.contains('primary')`);
            await shot('newtask-noproject');
            await press('.empty.tall [data-page=projects]');
            await wait('document.querySelector("[data-page=projects]").getAttribute("aria-current") === "page"');
            await check('UI16 空状态的"添加项目"打开项目页', 'document.querySelector("[data-page=projects]").getAttribute("aria-current") === "page"');
        }
        finally {
            await writeFile(projectsFile, projectsBefore);
            await press('[data-page=tasks]');
            await wait('!!document.querySelector("[data-task=t1]")');
        }
        nativeTheme.themeSource = 'dark';
    }
    finally {
        try { await press('[data-page=tasks]'); } catch { /* 失败时也尽量回到任务页，别掩盖原始错误。 */ }
        if (originalConfig === null) await rm(configFile, { force: true });
        else await writeFile(configFile, originalConfig);
        nativeTheme.themeSource = 'dark';
    }
}
